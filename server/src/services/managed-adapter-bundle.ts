import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { getAdapterPluginsDir, type AdapterPluginRecord } from "./adapter-plugin-store.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import { prepareTrustedReceiptDirectory } from "../ops/trusted-receipt-directory.js";

const PACKAGE_NAME = "@henkey/hermes-paperclip-adapter";
const ADAPTER_TYPE = "hermes_local";
const RECEIPT_SCHEMA = "paperclip.hermes_adapter_install_receipt.v1";
const MANIFEST_SCHEMA = "paperclip.hermes_adapter_immutable_bundle.v1";
const MANIFEST_FILE = "immutable-adapter-manifest.json";
const ARTIFACT_ROOT_PLACEHOLDER = "${HERMES_ADAPTER_BUNDLE_ROOT}";
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_OBJECT_RE = /^[a-f0-9]{40,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type JsonRecord = Record<string, unknown>;

export interface ManagedAdapterManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  mode: "0444" | "0555";
}

export interface ManagedAdapterBundleIdentity {
  kind: "managed_immutable_bundle";
  objectRoot: string;
  packageRoot: string;
  archivePath: string;
  bundleSha256: string;
  packageName: typeof PACKAGE_NAME;
  packageVersion: string;
  manifestPath: string;
  manifestSha256: string;
  payloadTreeSha256: string;
  installReceiptPath: string;
  installReceiptSha256: string;
  sourceGitHead: string;
  sourceGitTree: string;
  files: ManagedAdapterManifestFile[];
}

export interface ManagedAdapterInstallInput {
  installReceiptPath: string;
  installReceiptSha256: string;
  managedRoot?: string;
}

function transitionIdentity(identity: ManagedAdapterBundleIdentity) {
  return {
    bundle_sha256: identity.bundleSha256,
    package_version: identity.packageVersion,
    manifest_sha256: identity.manifestSha256,
    payload_tree_sha256: identity.payloadTreeSha256,
    source_git_head: identity.sourceGitHead,
    source_git_tree: identity.sourceGitTree,
    install_receipt_sha256: identity.installReceiptSha256,
  };
}

export async function writeManagedAdapterTransitionReceipt(input: {
  current: ManagedAdapterBundleIdentity | null;
  target: ManagedAdapterBundleIdentity;
  operation: "rollback" | "install";
  currentVerification: "verified" | "failed" | "not_present";
  actor: { type: "user"; id: string };
  occurredAt: string;
}) {
  const body = {
    schema_version: "paperclip.hermes_adapter_pointer_transition.v1",
    adapter_type: ADAPTER_TYPE,
    operation: input.operation,
    occurred_at: input.occurredAt,
    actor: input.actor,
    expected_current: input.current ? transitionIdentity(input.current) : null,
    current_verification: input.currentVerification,
    target: transitionIdentity(input.target),
  };
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  const receiptSha256 = sha256(bytes);
  const root = path.resolve(getAdapterPluginsDir(), "managed-transition-receipts", "sha256", receiptSha256.slice(0, 2));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await prepareTrustedReceiptDirectory(root, "managed_adapter_transition_receipt_directory");
  const receiptPath = path.join(root, `${receiptSha256}.json`);
  const existing = await lstat(receiptPath).catch(() => null);
  if (!existing) {
    const installedSha256 = await writeImmutableJsonReceipt(receiptPath, body);
    if (installedSha256 !== receiptSha256) fail("Managed adapter transition receipt hash mismatch");
  } else {
    const artifact = await readStrictFile(receiptPath, "managed adapter transition receipt", MAX_RECEIPT_BYTES, 0o444);
    if (artifact.sha256 !== receiptSha256 || !artifact.bytes.equals(bytes)) fail("Managed adapter transition receipt collision");
  }
  return { receiptPath, receiptSha256, body };
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "managed_adapter_bundle_invalid" });
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!SHA256_RE.test(parsed)) fail(`${label} must be a lowercase SHA-256 digest`);
  return parsed;
}

function gitObject(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!GIT_OBJECT_RE.test(parsed)) fail(`${label} must be a Git object id`);
  return parsed;
}

function semver(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!SEMVER_RE.test(parsed)) fail(`${label} must be exact semantic version text`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function safeRelative(value: unknown, label: string) {
  const parsed = text(value, label).replaceAll("\\", "/");
  if (parsed.startsWith("/") || parsed.includes("\0") || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(parsed) ||
      parsed.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} is not a safe relative path`);
  return parsed;
}

function within(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (!value || typeof value !== "object") fail(`Canonical JSON rejects ${typeof value}`);
  if (seen.has(value)) fail("Canonical JSON rejects circular values");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
    return Object.fromEntries(Object.keys(value as JsonRecord).sort().map((key) => {
      const entry = (value as JsonRecord)[key];
      if (entry === undefined) fail("Canonical JSON rejects undefined fields");
      return [key, canonicalValue(entry, seen)];
    }));
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function readStrictFile(filePath: string, label: string, maxBytes: number, expectedMode?: number) {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) fail(`${label} path must be canonical and absolute`);
  const canonical = await realpath(filePath).catch(() => fail(`${label} does not exist`));
  if (canonical !== filePath) fail(`${label} path must not traverse a symlink`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (metadata.size < 1 || metadata.size > maxBytes) fail(`${label} size is outside the accepted bound`);
  if (expectedMode !== undefined && process.platform !== "win32" && (metadata.mode & 0o777) !== expectedMode) {
    fail(`${label} must have mode ${expectedMode.toString(8).padStart(4, "0")}`);
  }
  const bytes = await readFile(canonical);
  if (bytes.length !== metadata.size) fail(`${label} changed while it was read`);
  return { path: canonical, bytes, sha256: sha256(bytes), mode: metadata.mode & 0o777 };
}

function validateManifest(value: unknown) {
  const manifest = record(value, "manifest body");
  exactKeys(manifest, ["schema_version", "package", "source", "files", "payload_tree_sha256", "integration"], "manifest body");
  if (manifest.schema_version !== MANIFEST_SCHEMA) fail("Manifest schema version is unsupported");
  const packageInfo = record(manifest.package, "manifest package");
  exactKeys(packageInfo, ["name", "version", "type", "entry_point"], "manifest package");
  if (packageInfo.name !== PACKAGE_NAME || packageInfo.type !== "module" || packageInfo.entry_point !== "index.js") fail("Manifest package identity is invalid");
  const packageVersion = semver(packageInfo.version, "manifest package version");
  const source = record(manifest.source, "manifest source");
  exactKeys(source, ["git_head", "git_tree", "git_branch", "git_status_sha256", "clean"], "manifest source");
  const sourceGitHead = gitObject(source.git_head, "manifest source git_head");
  const sourceGitTree = gitObject(source.git_tree, "manifest source git_tree");
  text(source.git_branch, "manifest source git_branch");
  digest(source.git_status_sha256, "manifest source git_status_sha256");
  if (source.clean !== true) fail("Manifest source is not clean");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("Manifest files must be non-empty");
  const seen = new Set<string>();
  const files = manifest.files.map((entry, index): ManagedAdapterManifestFile => {
    const file = record(entry, `manifest files[${index}]`);
    exactKeys(file, ["path", "sha256", "bytes", "mode"], `manifest files[${index}]`);
    const relativePath = safeRelative(file.path, `manifest files[${index}].path`);
    if (relativePath === MANIFEST_FILE || seen.has(relativePath)) fail("Manifest file paths must be unique and exclude the generated manifest");
    seen.add(relativePath);
    const mode = file.mode;
    if (mode !== "0444" && mode !== "0555") fail(`Manifest file ${relativePath} has an invalid mode`);
    return { path: relativePath, sha256: digest(file.sha256, `manifest file ${relativePath} sha256`), bytes: integer(file.bytes, `manifest file ${relativePath} bytes`, 1), mode };
  });
  if (files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)) fail("Manifest file list must be sorted by path");
  const payloadTreeSha256 = digest(manifest.payload_tree_sha256, "manifest payload_tree_sha256");
  if (sha256(canonicalJson(files)) !== payloadTreeSha256) fail("Manifest payload tree hash does not match its exact file list");
  const integration = record(manifest.integration, "manifest integration");
  exactKeys(integration, ["adapter_type", "create_server_adapter", "session_codec", "ui_parser_export"], "manifest integration");
  if (integration.adapter_type !== ADAPTER_TYPE || integration.create_server_adapter !== true || integration.session_codec !== true || integration.ui_parser_export !== "./ui-parser.js") {
    fail("Manifest integration contract is invalid");
  }
  return { manifest, packageVersion, sourceGitHead, sourceGitTree, files, payloadTreeSha256 };
}

function parseTarOctal(header: Buffer, start: number, length: number, label: string) {
  const value = header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) fail(`Archive ${label} is not canonical octal`);
  return Number.parseInt(value, 8);
}

function parseArchive(bytes: Buffer) {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  } catch {
    fail("Adapter archive is not a bounded gzip stream");
  }
  const entries = new Map<string, { bytes: Buffer; mode: number }>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks > 0) fail("Archive has data after an end marker");
    const storedChecksum = parseTarOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const observedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== observedChecksum) fail("Archive header checksum mismatch");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const relativePath = safeRelative(prefix ? `${prefix}/${name}` : name, "archive entry path");
    const type = header[156];
    if (type !== 0 && type !== 0x30) fail(`Archive entry ${relativePath} is not a regular file`);
    const size = parseTarOctal(header, 124, 12, `${relativePath} size`);
    const mode = parseTarOctal(header, 100, 8, `${relativePath} mode`) & 0o777;
    if (size < 1 || size > MAX_FILE_BYTES || offset + size > tar.length) fail(`Archive entry ${relativePath} has an invalid size`);
    if (entries.has(relativePath)) fail(`Archive entry ${relativePath} is duplicated`);
    entries.set(relativePath, { bytes: Buffer.from(tar.subarray(offset, offset + size)), mode });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || offset > tar.length || tar.subarray(offset).some((byte) => byte !== 0)) fail("Archive is missing its canonical end blocks");
  return entries;
}

async function listPackageFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, relative) : root;
  const names = await fs.promises.readdir(directory);
  const output: string[] = [];
  for (const name of names.sort()) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) fail(`Package contains symlink ${childRelative}`);
    if (metadata.isDirectory()) {
      if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o555) fail(`Package directory ${childRelative} must be mode 0555`);
      output.push(...await listPackageFiles(root, childRelative));
    } else if (metadata.isFile()) {
      output.push(childRelative);
    } else {
      fail(`Package contains unsupported filesystem entry ${childRelative}`);
    }
  }
  return output;
}

async function verifyPackage(packageRoot: string, files: ManagedAdapterManifestFile[], manifestBytes: Buffer) {
  const canonicalRoot = await realpath(packageRoot).catch(() => fail("Managed adapter package does not exist"));
  if (canonicalRoot !== packageRoot) fail("Managed adapter package root must not be a symlink");
  const rootMetadata = await lstat(packageRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("Managed adapter package root must be a directory");
  if (process.platform !== "win32" && (rootMetadata.mode & 0o777) !== 0o555) fail("Managed adapter package root must be mode 0555");
  const actualFiles = await listPackageFiles(packageRoot);
  const expectedFiles = [...files.map((file) => file.path), MANIFEST_FILE].sort();
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) fail("Managed adapter package file set differs from the manifest");
  for (const file of files) {
    const absolute = path.join(packageRoot, file.path);
    if (!within(packageRoot, absolute)) fail(`Managed adapter file ${file.path} escaped package root`);
    const artifact = await readStrictFile(absolute, `managed adapter file ${file.path}`, MAX_FILE_BYTES, Number.parseInt(file.mode, 8));
    if (artifact.bytes.length !== file.bytes || artifact.sha256 !== file.sha256) fail(`Managed adapter file ${file.path} differs from the manifest`);
  }
  const manifest = await readStrictFile(path.join(packageRoot, MANIFEST_FILE), "managed adapter manifest", MAX_RECEIPT_BYTES, 0o444);
  if (!manifest.bytes.equals(manifestBytes)) fail("Managed adapter manifest bytes differ from the receipt");
}

function verifyArchive(entries: Map<string, { bytes: Buffer; mode: number }>, files: ManagedAdapterManifestFile[], manifestBytes: Buffer) {
  const expected = new Map(files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes, mode: Number.parseInt(file.mode, 8) }]));
  expected.set(MANIFEST_FILE, { sha256: sha256(manifestBytes), bytes: manifestBytes.length, mode: 0o444 });
  if (entries.size !== expected.size) fail("Adapter archive file count differs from its manifest");
  for (const [relativePath, binding] of expected) {
    const entry = entries.get(relativePath);
    if (!entry || entry.bytes.length !== binding.bytes || sha256(entry.bytes) !== binding.sha256 || entry.mode !== binding.mode) {
      fail(`Adapter archive entry ${relativePath} differs from its manifest`);
    }
  }
}

async function verifySourceReceipt(input: ManagedAdapterInstallInput) {
  const expectedReceiptSha256 = digest(input.installReceiptSha256, "install receipt SHA-256");
  const receiptFile = await readStrictFile(input.installReceiptPath, "adapter install receipt", MAX_RECEIPT_BYTES, 0o444);
  if (receiptFile.sha256 !== expectedReceiptSha256 || path.basename(receiptFile.path) !== `${expectedReceiptSha256}.json`) fail("Adapter install receipt hash or filename mismatch");
  const receiptText = receiptFile.bytes.toString("utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(receiptText); } catch { fail("Adapter install receipt is not JSON"); }
  if (canonicalJson(parsed) !== receiptText) fail("Adapter install receipt is not canonical JSON");
  const receipt = record(parsed, "adapter install receipt");
  exactKeys(receipt, ["schema_version", "adapter_type", "package_name", "package_version", "source", "manifest", "bundle", "managed_install_descriptor", "verification"], "adapter install receipt");
  if (receipt.schema_version !== RECEIPT_SCHEMA || receipt.adapter_type !== ADAPTER_TYPE || receipt.package_name !== PACKAGE_NAME) fail("Adapter install receipt identity is invalid");
  const packageVersion = semver(receipt.package_version, "adapter install receipt package_version");
  const source = record(receipt.source, "adapter install receipt source");
  exactKeys(source, ["git_head", "git_tree"], "adapter install receipt source");
  const sourceGitHead = gitObject(source.git_head, "adapter install receipt source git_head");
  const sourceGitTree = gitObject(source.git_tree, "adapter install receipt source git_tree");
  const manifestBinding = record(receipt.manifest, "adapter install receipt manifest");
  exactKeys(manifestBinding, ["relative_path", "sha256", "body"], "adapter install receipt manifest");
  const manifestRelativePath = safeRelative(manifestBinding.relative_path, "adapter install receipt manifest path");
  const manifestSha256 = digest(manifestBinding.sha256, "adapter install receipt manifest sha256");
  const validatedManifest = validateManifest(manifestBinding.body);
  const manifestBytes = Buffer.from(canonicalJson(validatedManifest.manifest), "utf8");
  if (sha256(manifestBytes) !== manifestSha256) fail("Embedded manifest body does not match its hash");
  if (validatedManifest.packageVersion !== packageVersion || validatedManifest.sourceGitHead !== sourceGitHead || validatedManifest.sourceGitTree !== sourceGitTree) fail("Receipt source/package identity differs from its embedded manifest");
  const bundle = record(receipt.bundle, "adapter install receipt bundle");
  exactKeys(bundle, ["sha256", "manifest_sha256", "payload_tree_sha256", "archive_relative_path", "archive_bytes", "package_relative_path"], "adapter install receipt bundle");
  const bundleSha256 = digest(bundle.sha256, "adapter bundle sha256");
  const archiveRelativePath = safeRelative(bundle.archive_relative_path, "adapter archive path");
  const archiveBytes = integer(bundle.archive_bytes, "adapter archive bytes", 1);
  const packageRelativePath = safeRelative(bundle.package_relative_path, "adapter package path");
  if (bundle.manifest_sha256 !== manifestSha256 || bundle.payload_tree_sha256 !== validatedManifest.payloadTreeSha256 || packageRelativePath !== `packages/${bundleSha256}` || archiveRelativePath !== `bundles/${bundleSha256}.tgz` || manifestRelativePath !== `${packageRelativePath}/${MANIFEST_FILE}`) fail("Adapter bundle paths or hashes are not content-addressed consistently");
  const descriptor = record(receipt.managed_install_descriptor, "managed install descriptor");
  exactKeys(descriptor, ["kind", "artifact_root", "adapter_type", "package_name", "package_version", "bundle_sha256", "package_relative_path", "manifest_relative_path", "manifest_sha256", "payload_tree_sha256"], "managed install descriptor");
  if (descriptor.kind !== "managed_immutable_bundle" || descriptor.artifact_root !== ARTIFACT_ROOT_PLACEHOLDER || descriptor.adapter_type !== ADAPTER_TYPE || descriptor.package_name !== PACKAGE_NAME || descriptor.package_version !== packageVersion || descriptor.bundle_sha256 !== bundleSha256 || descriptor.package_relative_path !== packageRelativePath || descriptor.manifest_relative_path !== manifestRelativePath || descriptor.manifest_sha256 !== manifestSha256 || descriptor.payload_tree_sha256 !== validatedManifest.payloadTreeSha256) fail("Managed install descriptor differs from the verified receipt");
  const verification = record(receipt.verification, "adapter install receipt verification");
  exactKeys(verification, ["source_clean", "archive_verified", "extracted_bytes_verified", "module_integration_verified", "secret_scan_passed"], "adapter install receipt verification");
  if (Object.values(verification).some((value) => value !== true)) fail("Adapter install receipt verification is incomplete");
  const artifactRoot = path.dirname(path.dirname(receiptFile.path));
  const canonicalArtifactRoot = await realpath(artifactRoot);
  if (canonicalArtifactRoot !== artifactRoot) fail("Adapter artifact root must be canonical");
  const packageRoot = path.join(artifactRoot, packageRelativePath);
  const manifestPath = path.join(artifactRoot, manifestRelativePath);
  const archivePath = path.join(artifactRoot, archiveRelativePath);
  if (![packageRoot, manifestPath, archivePath].every((candidate) => within(artifactRoot, candidate))) fail("Adapter receipt paths escape the artifact root");
  const manifestFile = await readStrictFile(manifestPath, "adapter package manifest", MAX_RECEIPT_BYTES, 0o444);
  if (manifestFile.sha256 !== manifestSha256 || !manifestFile.bytes.equals(manifestBytes)) fail("Adapter package manifest differs from the receipt");
  await verifyPackage(packageRoot, validatedManifest.files, manifestBytes);
  const archive = await readStrictFile(archivePath, "adapter bundle archive", MAX_ARCHIVE_BYTES, 0o444);
  if (archive.sha256 !== bundleSha256 || archive.bytes.length !== archiveBytes) fail("Adapter archive differs from the receipt");
  verifyArchive(parseArchive(archive.bytes), validatedManifest.files, manifestBytes);
  return { receiptFile, receipt, packageVersion, sourceGitHead, sourceGitTree, manifestBytes, manifestSha256, bundleSha256, archive, validatedManifest };
}

function defaultManagedRoot() {
  return path.resolve(getAdapterPluginsDir(), "managed-immutable-bundles");
}

async function ensureWritableDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const canonical = await realpath(directory);
  if (canonical !== directory) fail("Managed adapter root must not traverse a symlink");
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("Managed adapter root must be a regular directory");
}

async function materializePackage(sourceRoot: string, destinationRoot: string, files: ManagedAdapterManifestFile[], manifestBytes: Buffer) {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const source = path.join(sourceRoot, file.path);
    const destination = path.join(destinationRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await chmod(destination, Number.parseInt(file.mode, 8));
  }
  const manifestPath = path.join(destinationRoot, MANIFEST_FILE);
  await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o444 });
  if (process.platform !== "win32") await chmod(manifestPath, 0o444);
  const directories: string[] = [];
  async function collect(directory: string) {
    directories.push(directory);
    for (const name of await fs.promises.readdir(directory)) {
      const child = path.join(directory, name);
      if ((await lstat(child)).isDirectory()) await collect(child);
    }
  }
  await collect(destinationRoot);
  if (process.platform !== "win32") await Promise.all(directories.sort((a, b) => b.length - a.length).map((directory) => chmod(directory, 0o555)));
}

async function removeTemporaryTree(root: string) {
  if (!fs.existsSync(root)) return;
  async function makeWritable(entry: string) {
    const metadata = await lstat(entry);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await chmod(entry, 0o700).catch(() => undefined);
      for (const name of await fs.promises.readdir(entry)) await makeWritable(path.join(entry, name));
    } else {
      await chmod(entry, 0o600).catch(() => undefined);
    }
  }
  await makeWritable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function identityFromRecord(record: AdapterPluginRecord): ManagedAdapterBundleIdentity {
  if (record.installKind !== "managed_immutable_bundle" || !record.managedBundle) fail(`Adapter ${record.type} is not a managed immutable bundle`);
  return record.managedBundle;
}

export async function installManagedAdapterBundle(input: ManagedAdapterInstallInput): Promise<ManagedAdapterBundleIdentity> {
  const verified = await verifySourceReceipt(input);
  const managedRoot = path.resolve(input.managedRoot ?? defaultManagedRoot());
  await ensureWritableDirectory(managedRoot);
  const objectsRoot = path.join(managedRoot, "objects", "sha256", verified.bundleSha256.slice(0, 2));
  await ensureWritableDirectory(objectsRoot);
  const objectRoot = path.join(objectsRoot, verified.bundleSha256);
  const packageRoot = path.join(objectRoot, "package");
  const archivePath = path.join(objectRoot, `${verified.bundleSha256}.tgz`);
  const installReceiptPath = path.join(objectRoot, `${verified.receiptFile.sha256}.json`);
  const manifestPath = path.join(packageRoot, MANIFEST_FILE);
  // Materialize with the already verified source package. A failed temporary
  // copy can never publish a partially populated content address.
  if (!fs.existsSync(objectRoot)) {
    const temporaryRoot = path.join(objectsRoot, `.install-${verified.bundleSha256}-${randomUUID()}`);
    const sourcePackageRoot = path.join(path.dirname(path.dirname(verified.receiptFile.path)), "packages", verified.bundleSha256);
    try {
      await mkdir(temporaryRoot, { mode: 0o700 });
      await materializePackage(sourcePackageRoot, path.join(temporaryRoot, "package"), verified.validatedManifest.files, verified.manifestBytes);
      await copyFile(verified.archive.path, path.join(temporaryRoot, `${verified.bundleSha256}.tgz`), fs.constants.COPYFILE_EXCL);
      await copyFile(verified.receiptFile.path, path.join(temporaryRoot, `${verified.receiptFile.sha256}.json`), fs.constants.COPYFILE_EXCL);
      if (process.platform !== "win32") {
        await chmod(path.join(temporaryRoot, `${verified.bundleSha256}.tgz`), 0o444);
        await chmod(path.join(temporaryRoot, `${verified.receiptFile.sha256}.json`), 0o444);
      }
      await rename(temporaryRoot, objectRoot).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        await removeTemporaryTree(temporaryRoot);
      });
      if (process.platform !== "win32") await chmod(objectRoot, 0o555);
    } catch (error) {
      await removeTemporaryTree(temporaryRoot);
      throw error;
    }
  }
  const identity: ManagedAdapterBundleIdentity = {
    kind: "managed_immutable_bundle",
    objectRoot,
    packageRoot,
    archivePath,
    bundleSha256: verified.bundleSha256,
    packageName: PACKAGE_NAME,
    packageVersion: verified.packageVersion,
    manifestPath,
    manifestSha256: verified.manifestSha256,
    payloadTreeSha256: verified.validatedManifest.payloadTreeSha256,
    installReceiptPath,
    installReceiptSha256: verified.receiptFile.sha256,
    sourceGitHead: verified.sourceGitHead,
    sourceGitTree: verified.sourceGitTree,
    files: verified.validatedManifest.files,
  };
  await verifyManagedAdapterBundleIdentity(identity);
  return identity;
}

export async function verifyManagedAdapterBundleIdentity(identity: ManagedAdapterBundleIdentity) {
  if (identity.kind !== "managed_immutable_bundle" || identity.packageName !== PACKAGE_NAME || !SEMVER_RE.test(identity.packageVersion) || !SHA256_RE.test(identity.bundleSha256) || !SHA256_RE.test(identity.manifestSha256) || !SHA256_RE.test(identity.payloadTreeSha256) || !SHA256_RE.test(identity.installReceiptSha256) || !GIT_OBJECT_RE.test(identity.sourceGitHead) || !GIT_OBJECT_RE.test(identity.sourceGitTree)) fail("Managed adapter identity fields are invalid");
  const expectedObjectRoot = path.join(path.dirname(path.dirname(identity.objectRoot)), identity.bundleSha256.slice(0, 2), identity.bundleSha256);
  if (path.resolve(identity.objectRoot) !== path.resolve(expectedObjectRoot) || identity.packageRoot !== path.join(identity.objectRoot, "package") || identity.archivePath !== path.join(identity.objectRoot, `${identity.bundleSha256}.tgz`) || identity.manifestPath !== path.join(identity.packageRoot, MANIFEST_FILE) || identity.installReceiptPath !== path.join(identity.objectRoot, `${identity.installReceiptSha256}.json`)) fail("Managed adapter identity paths are not content addressed");
  const objectCanonical = await realpath(identity.objectRoot).catch(() => fail("Managed adapter object is missing"));
  if (objectCanonical !== identity.objectRoot) fail("Managed adapter object path traverses a symlink");
  if (process.platform !== "win32" && ((await lstat(identity.objectRoot)).mode & 0o777) !== 0o555) fail("Managed adapter object root must be mode 0555");
  const manifestArtifact = await readStrictFile(identity.manifestPath, "managed adapter manifest", MAX_RECEIPT_BYTES, 0o444);
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(manifestArtifact.bytes.toString("utf8")); } catch { fail("Managed adapter manifest is not JSON"); }
  if (canonicalJson(manifestValue) !== manifestArtifact.bytes.toString("utf8")) fail("Managed adapter manifest is not canonical JSON");
  const manifestBytes = manifestArtifact.bytes;
  const parsedManifest = validateManifest(manifestValue);
  if (parsedManifest.packageVersion !== identity.packageVersion || parsedManifest.sourceGitHead !== identity.sourceGitHead || parsedManifest.sourceGitTree !== identity.sourceGitTree || parsedManifest.payloadTreeSha256 !== identity.payloadTreeSha256 || sha256(manifestBytes) !== identity.manifestSha256 || canonicalJson(parsedManifest.files) !== canonicalJson(identity.files)) fail("Managed adapter identity differs from its manifest");
  await verifyPackage(identity.packageRoot, identity.files, manifestBytes);
  const archive = await readStrictFile(identity.archivePath, "managed adapter archive", MAX_ARCHIVE_BYTES, 0o444);
  if (archive.sha256 !== identity.bundleSha256) fail("Managed adapter archive hash mismatch");
  verifyArchive(parseArchive(archive.bytes), identity.files, manifestBytes);
  const receipt = await readStrictFile(identity.installReceiptPath, "managed adapter install receipt", MAX_RECEIPT_BYTES, 0o444);
  if (receipt.sha256 !== identity.installReceiptSha256) fail("Managed adapter install receipt hash mismatch");
  const receiptText = receipt.bytes.toString("utf8");
  let receiptValue: unknown;
  try { receiptValue = JSON.parse(receiptText); } catch { fail("Managed adapter install receipt is not JSON"); }
  if (canonicalJson(receiptValue) !== receiptText) fail("Managed adapter install receipt is not canonical JSON");
  const receiptBody = record(receiptValue, "managed adapter install receipt");
  exactKeys(receiptBody, ["schema_version", "adapter_type", "package_name", "package_version", "source", "manifest", "bundle", "managed_install_descriptor", "verification"], "managed adapter install receipt");
  if (receiptBody.schema_version !== RECEIPT_SCHEMA || receiptBody.adapter_type !== ADAPTER_TYPE ||
      receiptBody.package_name !== PACKAGE_NAME || receiptBody.package_version !== identity.packageVersion) {
    fail("Managed adapter install receipt package identity mismatch");
  }
  const receiptSource = record(receiptBody.source, "managed adapter install receipt source");
  exactKeys(receiptSource, ["git_head", "git_tree"], "managed adapter install receipt source");
  if (receiptSource.git_head !== identity.sourceGitHead || receiptSource.git_tree !== identity.sourceGitTree) {
    fail("Managed adapter install receipt source identity mismatch");
  }
  const receiptManifest = record(receiptBody.manifest, "managed adapter install receipt manifest");
  exactKeys(receiptManifest, ["relative_path", "sha256", "body"], "managed adapter install receipt manifest");
  if (receiptManifest.relative_path !== `packages/${identity.bundleSha256}/${MANIFEST_FILE}` ||
      receiptManifest.sha256 !== identity.manifestSha256 ||
      canonicalJson(receiptManifest.body) !== manifestBytes.toString("utf8")) {
    fail("Managed adapter install receipt manifest binding mismatch");
  }
  const receiptBundle = record(receiptBody.bundle, "managed adapter install receipt bundle");
  exactKeys(receiptBundle, ["sha256", "manifest_sha256", "payload_tree_sha256", "archive_relative_path", "archive_bytes", "package_relative_path"], "managed adapter install receipt bundle");
  if (receiptBundle.sha256 !== identity.bundleSha256 || receiptBundle.manifest_sha256 !== identity.manifestSha256 ||
      receiptBundle.payload_tree_sha256 !== identity.payloadTreeSha256 ||
      receiptBundle.archive_relative_path !== `bundles/${identity.bundleSha256}.tgz` ||
      receiptBundle.archive_bytes !== archive.bytes.length ||
      receiptBundle.package_relative_path !== `packages/${identity.bundleSha256}`) {
    fail("Managed adapter install receipt bundle binding mismatch");
  }
  const receiptDescriptor = record(receiptBody.managed_install_descriptor, "managed adapter install descriptor");
  exactKeys(receiptDescriptor, ["kind", "artifact_root", "adapter_type", "package_name", "package_version", "bundle_sha256", "package_relative_path", "manifest_relative_path", "manifest_sha256", "payload_tree_sha256"], "managed adapter install descriptor");
  if (receiptDescriptor.kind !== "managed_immutable_bundle" || receiptDescriptor.artifact_root !== ARTIFACT_ROOT_PLACEHOLDER ||
      receiptDescriptor.adapter_type !== ADAPTER_TYPE || receiptDescriptor.package_name !== PACKAGE_NAME ||
      receiptDescriptor.package_version !== identity.packageVersion || receiptDescriptor.bundle_sha256 !== identity.bundleSha256 ||
      receiptDescriptor.package_relative_path !== `packages/${identity.bundleSha256}` ||
      receiptDescriptor.manifest_relative_path !== `packages/${identity.bundleSha256}/${MANIFEST_FILE}` ||
      receiptDescriptor.manifest_sha256 !== identity.manifestSha256 || receiptDescriptor.payload_tree_sha256 !== identity.payloadTreeSha256) {
    fail("Managed adapter install descriptor identity mismatch");
  }
  const receiptVerification = record(receiptBody.verification, "managed adapter install receipt verification");
  exactKeys(receiptVerification, ["source_clean", "archive_verified", "extracted_bytes_verified", "module_integration_verified", "secret_scan_passed"], "managed adapter install receipt verification");
  if (Object.values(receiptVerification).some((value) => value !== true)) fail("Managed adapter install receipt verification is incomplete");
  return identity;
}

export async function verifyManagedAdapterPluginRecord(record: AdapterPluginRecord) {
  const identity = managedAdapterIdentityFromRecord(record);
  return verifyManagedAdapterBundleIdentity(identity);
}

/**
 * Validate only the immutable pointer metadata stored by Paperclip. Recovery
 * uses this to fence a corrupted active object by its exact stored digest while
 * independently verifying the rollback target's bytes.
 */
export function managedAdapterIdentityFromRecord(record: AdapterPluginRecord) {
  const identity = identityFromRecord(record);
  if (record.type !== ADAPTER_TYPE || record.packageName !== PACKAGE_NAME || record.version !== identity.packageVersion || record.localPath) fail("Managed adapter plugin-store record is inconsistent");
  return identity;
}
