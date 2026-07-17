import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedJsonFile,
} from "./trusted-receipt-directory.js";
import {
  factoryCanonicalJsonSha256,
  factoryCanonicalJsonValue,
} from "./factory-canonical-json.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const DEFAULT_ZSTD = "/opt/homebrew/bin/zstd";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface FactoryArchiveInput {
  sourcePath: string;
  allowedSourceRoots: readonly string[];
  archiveRoot: string;
  factoryOwnershipToken: string;
  receiptReferences?: readonly string[];
  zstdExecutable?: string;
  now?: Date;
}

export interface FactoryRetentionCandidate {
  path: string;
  allowedRoot: string;
  archiveRoot: string;
  factoryOwnershipToken: string | null;
  leaseExpiresAt: string | null;
  workflowActive: boolean;
  workflowBlocked: boolean;
  rollbackEligible: boolean;
  onlyReferencedCopy: boolean;
  retentionEligibleAfter: string | null;
  archiveManifestPath: string | null;
}

function hashBytes(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function requireAbsolute(value: string, code: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) throw new Error(`${code}_invalid`);
  return value;
}

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function currentUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

async function requireOwnedRegularFile(filePath: string, allowedRoots: readonly string[], code: string) {
  requireAbsolute(filePath, `${code}_path`);
  const canonical = await realpath(filePath).catch(() => "");
  if (!canonical || canonical !== filePath) throw new Error(`${code}_path_not_canonical`);
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    requireAbsolute(root, `${code}_root`);
    return realpath(root);
  }));
  if (!roots.some((root) => inside(root, canonical))) throw new Error(`${code}_outside_allowed_roots`);
  const metadata = await lstat(canonical);
  const uid = currentUid();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
      (uid !== null && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0) {
    throw new Error(`${code}_source_invalid`);
  }
  return { canonical, metadata };
}

async function trustedExecutable(executablePath: string) {
  requireAbsolute(executablePath, "factory_archive_zstd");
  const canonical = await realpath(executablePath).catch(() => "");
  const metadata = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || !metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o111) === 0 || ![0, currentUid()].includes(metadata.uid)) {
    throw new Error("factory_archive_zstd_untrusted");
  }
  return canonical;
}

async function fsyncFile(filePath: string) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function digestingTransform(hash: ReturnType<typeof createHash>) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function childExit(child: ReturnType<typeof spawn>, errorCode: string) {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", () => reject(new Error(`${errorCode}_spawn_failed`)));
    child.once("close", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${errorCode}_failed:${code ?? "null"}:${signal ?? "none"}:${stderr.replace(/[\r\n]+/g, " ").slice(0, 500)}`));
    });
  });
}

async function hashFile(filePath: string) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function decompressedSha256(zstdExecutable: string, archivePath: string) {
  const child = spawn(zstdExecutable, ["-q", "-d", "-c", "--", archivePath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  const hash = createHash("sha256");
  const consume = (async () => {
    for await (const chunk of child.stdout!) hash.update(chunk as Buffer);
  })();
  await Promise.all([consume, childExit(child, "factory_archive_verify")]);
  return hash.digest("hex");
}

function sameFileSnapshot(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>) {
  return before.isFile() && after.isFile() && !after.isSymbolicLink() &&
    before.dev === after.dev && before.ino === after.ino && before.uid === after.uid &&
    before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

export async function archiveFactoryFile(input: FactoryArchiveInput) {
  const token = input.factoryOwnershipToken.trim();
  if (!token || token.length > 300 || /[\r\n\0]/.test(token)) throw new Error("factory_archive_ownership_token_invalid");
  const now = input.now ?? new Date();
  const zstdExecutable = await trustedExecutable(input.zstdExecutable ?? DEFAULT_ZSTD);
  const source = await requireOwnedRegularFile(input.sourcePath, input.allowedSourceRoots, "factory_archive");
  const archiveRoot = await realpath(requireAbsolute(input.archiveRoot, "factory_archive_root"));
  if (archiveRoot !== input.archiveRoot) throw new Error("factory_archive_root_not_canonical");
  const stagingDirectory = path.join(archiveRoot, "staging");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  await prepareTrustedReceiptDirectory(stagingDirectory, "factory_archive_staging");
  const temporaryPath = path.join(stagingDirectory, `archive-${process.pid}-${randomBytes(10).toString("hex")}.zst.tmp`);
  const outputHandle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  const sourceHandle = await open(source.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  const sourceHash = createHash("sha256");
  let sourceSha256 = "";
  try {
    const opened = await sourceHandle.stat();
    if (!sameFileSnapshot(source.metadata, opened)) throw new Error("factory_archive_source_inode_changed");
    const compressor = spawn(zstdExecutable, ["-q", "-T1", "-10", "-c"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    });
    const sourceStream = sourceHandle.createReadStream({ autoClose: true });
    const outputStream = outputHandle.createWriteStream({ autoClose: true });
    await Promise.all([
      pipeline(sourceStream, digestingTransform(sourceHash), compressor.stdin!),
      pipeline(compressor.stdout!, outputStream),
      childExit(compressor, "factory_archive_compress"),
    ]);
    sourceSha256 = sourceHash.digest("hex");
    await chmod(temporaryPath, 0o444);
    await fsyncFile(temporaryPath);
    const sourceAfterPath = await lstat(source.canonical);
    if (!sameFileSnapshot(source.metadata, sourceAfterPath)) {
      throw new Error("factory_archive_source_changed_during_archive");
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([sourceHandle.close().catch(() => undefined), outputHandle.close().catch(() => undefined)]);
  }
  const decompressedHash = await decompressedSha256(zstdExecutable, temporaryPath).catch(async (error) => {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  });
  if (decompressedHash !== sourceSha256) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("factory_archive_decompressed_hash_mismatch");
  }
  const compressedSha256 = await hashFile(temporaryPath);
  const objectDirectory = path.join(archiveRoot, "objects", "sha256", sourceSha256.slice(0, 2));
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  await chmod(objectDirectory, 0o700);
  await prepareTrustedReceiptDirectory(objectDirectory, "factory_archive_object_directory");
  const objectPath = path.join(objectDirectory, `${sourceSha256}.zst`);
  const existing = await lstat(objectPath).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o777) !== 0o444 ||
        await decompressedSha256(zstdExecutable, objectPath) !== sourceSha256) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error("factory_archive_existing_object_invalid");
    }
    await unlink(temporaryPath);
  } else {
    await rename(temporaryPath, objectPath);
    await chmod(objectPath, 0o444);
    await fsyncFile(objectPath);
    await fsyncDirectory(objectDirectory);
  }
  const objectMetadata = await stat(objectPath);
  const finalCompressedSha256 = await hashFile(objectPath);
  const manifest = {
    schema_version: "paperclip.factory_archive_manifest.v1",
    archive_id: `sha256:${sourceSha256}`,
    created_at: now.toISOString(),
    source: {
      path: source.canonical,
      size_bytes: source.metadata.size,
      sha256: sourceSha256,
      mode: source.metadata.mode & 0o777,
      modified_at: source.metadata.mtime.toISOString(),
      factory_ownership_token: token,
    },
    object: {
      path: objectPath,
      compression: "zstd" as const,
      compressed_size_bytes: objectMetadata.size,
      compressed_sha256: finalCompressedSha256,
      content_sha256: sourceSha256,
    },
    receipt_references: [...new Set(input.receiptReferences ?? [])].sort(),
    verification: {
      decompressed_sha256: decompressedHash,
      verified_at: now.toISOString(),
      source_deleted: false as const,
    },
  };
  const manifestSha256 = factoryCanonicalJsonSha256(manifest);
  const manifestDirectory = path.join(archiveRoot, "manifests", "sha256", manifestSha256.slice(0, 2));
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  await chmod(manifestDirectory, 0o700);
  await prepareTrustedReceiptDirectory(manifestDirectory, "factory_archive_manifest_directory");
  const manifestPath = path.join(manifestDirectory, `${manifestSha256}.json`);
  const manifestExisting = await lstat(manifestPath).catch(() => null);
  if (!manifestExisting) {
    if (await writeImmutableJsonReceipt(manifestPath, factoryCanonicalJsonValue(manifest)) !== manifestSha256) {
      throw new Error("factory_archive_manifest_hash_mismatch");
    }
  } else if (!manifestExisting.isFile() || manifestExisting.isSymbolicLink() ||
      (manifestExisting.mode & 0o777) !== 0o444 || hashBytes(await readFile(manifestPath)) !== manifestSha256) {
    throw new Error("factory_archive_existing_manifest_invalid");
  }
  return { manifest, manifestPath, manifestSha256, objectPath, sourceSha256, compressedSha256: finalCompressedSha256 };
}

export async function verifyFactoryArchiveManifest(
  manifestPath: string,
  expectedSourceSha256: string,
  configuredArchiveRoot: string,
  zstdExecutable = DEFAULT_ZSTD,
) {
  if (!SHA256_RE.test(expectedSourceSha256)) return { verified: false as const, reason: "source_sha256_invalid" };
  try {
    const trustedZstd = await trustedExecutable(zstdExecutable);
    const artifact = await readTrustedJsonFile(manifestPath, "factory_archive_manifest", { maxBytes: MAX_MANIFEST_BYTES });
    const archiveRoot = await realpath(requireAbsolute(configuredArchiveRoot, "factory_archive_root"));
    if (archiveRoot !== configuredArchiveRoot) return { verified: false as const, reason: "archive_root_not_canonical" };
    const expectedManifestPath = path.join(
      archiveRoot,
      "manifests",
      "sha256",
      artifact.sha256.slice(0, 2),
      `${artifact.sha256}.json`,
    );
    if (artifact.path !== expectedManifestPath) {
      return { verified: false as const, reason: "manifest_path_invalid" };
    }
    const value = artifact.value;
    const source = value.source && typeof value.source === "object" ? value.source as Record<string, unknown> : {};
    const object = value.object && typeof value.object === "object" ? value.object as Record<string, unknown> : {};
    const objectPath = typeof object.path === "string" ? object.path : "";
    const expectedObjectPath = path.join(
      archiveRoot,
      "objects",
      "sha256",
      expectedSourceSha256.slice(0, 2),
      `${expectedSourceSha256}.zst`,
    );
    if (value.schema_version !== "paperclip.factory_archive_manifest.v1" || source.sha256 !== expectedSourceSha256 ||
        object.content_sha256 !== expectedSourceSha256 || objectPath !== expectedObjectPath ||
        typeof object.compressed_sha256 !== "string" || !SHA256_RE.test(object.compressed_sha256)) {
      return { verified: false as const, reason: "manifest_binding_invalid" };
    }
    const objectMetadata = await lstat(objectPath);
    if (!objectMetadata.isFile() || objectMetadata.isSymbolicLink() || (objectMetadata.mode & 0o777) !== 0o444 ||
        await hashFile(objectPath) !== object.compressed_sha256 ||
        await decompressedSha256(trustedZstd, objectPath) !== expectedSourceSha256) {
      return { verified: false as const, reason: "archive_object_invalid" };
    }
    return { verified: true as const, manifestPath: artifact.path, manifestSha256: artifact.sha256, objectPath };
  } catch (error) {
    return { verified: false as const, reason: error instanceof Error ? error.message : "archive_verification_failed" };
  }
}

async function inspectRetentionCandidate(candidate: FactoryRetentionCandidate, now: Date, zstdExecutable: string) {
  const source = await requireOwnedRegularFile(candidate.path, [candidate.allowedRoot], "factory_retention");
  const sourceSha256 = await hashFile(source.canonical);
  const leaseExpiresMs = candidate.leaseExpiresAt ? Date.parse(candidate.leaseExpiresAt) : Number.NaN;
  const leaseActive = Number.isFinite(leaseExpiresMs) && leaseExpiresMs > now.getTime();
  const eligibleAfterMs = candidate.retentionEligibleAfter ? Date.parse(candidate.retentionEligibleAfter) : Number.NaN;
  const archive = candidate.archiveManifestPath
    ? await verifyFactoryArchiveManifest(candidate.archiveManifestPath, sourceSha256, candidate.archiveRoot, zstdExecutable)
    : { verified: false as const, reason: "archive_manifest_missing" };
  let decision: "protect" | "archive_then_review" | "eligible_after_approval";
  let reason: string;
  if (!candidate.factoryOwnershipToken?.trim()) {
    decision = "protect";
    reason = "factory_ownership_token_missing";
  } else if (leaseActive) {
    decision = "protect";
    reason = "factory_lease_active";
  } else if (candidate.workflowActive || candidate.workflowBlocked || candidate.rollbackEligible || candidate.onlyReferencedCopy) {
    decision = "protect";
    reason = candidate.workflowActive ? "active_workflow_reference"
      : candidate.workflowBlocked ? "blocked_workflow_reference"
      : candidate.rollbackEligible ? "rollback_eligible_reference"
      : "only_referenced_copy";
  } else if (Number.isFinite(eligibleAfterMs) && eligibleAfterMs > now.getTime()) {
    decision = "protect";
    reason = "retention_window_active";
  } else if (!archive.verified) {
    decision = "archive_then_review";
    reason = archive.reason;
  } else {
    decision = "eligible_after_approval";
    reason = "verified_archive_and_expired_factory_ownership";
  }
  return {
    path: source.canonical,
    size_bytes: source.metadata.size,
    sha256: sourceSha256,
    modified_at: source.metadata.mtime.toISOString(),
    ownership: { factory_owned: Boolean(candidate.factoryOwnershipToken?.trim()), token: candidate.factoryOwnershipToken?.trim() || null },
    lease: { active: leaseActive, expires_at: Number.isFinite(leaseExpiresMs) ? new Date(leaseExpiresMs).toISOString() : null },
    workflow_protection: {
      active: candidate.workflowActive,
      blocked: candidate.workflowBlocked,
      rollback_eligible: candidate.rollbackEligible,
      only_referenced_copy: candidate.onlyReferencedCopy,
    },
    archive: archive.verified ? {
      verified: true,
      manifest_path: archive.manifestPath,
      manifest_sha256: archive.manifestSha256,
      object_path: archive.objectPath,
    } : {
      verified: false,
      manifest_path: candidate.archiveManifestPath,
      manifest_sha256: null,
      object_path: null,
    },
    decision,
    reason,
  };
}

export async function buildFactoryRetentionDryRun(input: {
  candidates: readonly FactoryRetentionCandidate[];
  now?: Date;
  zstdExecutable?: string;
}) {
  const now = input.now ?? new Date();
  const zstdExecutable = input.zstdExecutable ?? DEFAULT_ZSTD;
  const uniquePaths = new Set<string>();
  for (const candidate of input.candidates) {
    if (uniquePaths.has(candidate.path)) throw new Error("factory_retention_duplicate_candidate");
    uniquePaths.add(candidate.path);
  }
  const inventory = (await Promise.all(input.candidates.map((candidate) => inspectRetentionCandidate(candidate, now, zstdExecutable))))
    .sort((left, right) => left.path.localeCompare(right.path));
  const eligible = inventory.filter((entry) => entry.decision === "eligible_after_approval");
  const candidateBytes = inventory.reduce((sum, entry) => sum + entry.size_bytes, 0);
  return {
    schema_version: "paperclip.factory_retention_dry_run.v1",
    policy_version: "zero-touch-factory-retention.v1",
    generated_at: now.toISOString(),
    approval_required: true as const,
    totals: {
      candidate_count: inventory.length,
      eligible_count: eligible.length,
      protected_count: inventory.filter((entry) => entry.decision === "protect").length,
      candidate_bytes: candidateBytes,
      eligible_bytes: eligible.reduce((sum, entry) => sum + entry.size_bytes, 0),
    },
    inventory,
  };
}

export async function installFactoryRetentionDryRun(archiveRoot: string, receipt: unknown) {
  const root = await realpath(requireAbsolute(archiveRoot, "factory_retention_archive_root"));
  if (root !== archiveRoot) throw new Error("factory_retention_archive_root_not_canonical");
  const receiptSha256 = factoryCanonicalJsonSha256(receipt);
  const directory = path.join(root, "retention", "dry-runs", "sha256", receiptSha256.slice(0, 2));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await prepareTrustedReceiptDirectory(directory, "factory_retention_receipt_directory");
  const receiptPath = path.join(directory, `${receiptSha256}.json`);
  if (!await lstat(receiptPath).catch(() => null)) {
    if (await writeImmutableJsonReceipt(receiptPath, factoryCanonicalJsonValue(receipt)) !== receiptSha256) {
      throw new Error("factory_retention_receipt_hash_mismatch");
    }
  } else {
    const existing = await readTrustedJsonFile(receiptPath, "factory_retention_existing_receipt", {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (existing.sha256 !== receiptSha256 ||
        factoryCanonicalJsonSha256(existing.value) !== receiptSha256 ||
        factoryCanonicalJsonSha256(receipt) !== receiptSha256) {
      throw new Error("factory_retention_existing_receipt_invalid");
    }
  }
  return { receiptPath, receiptSha256 };
}
