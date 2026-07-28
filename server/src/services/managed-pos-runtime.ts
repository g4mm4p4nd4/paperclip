import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, opendir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import {
  readTrustedFile,
  readTrustedJsonFile,
  requireTrustedDirectory,
} from "../ops/trusted-receipt-directory.js";
import { verifyProviderPolicyAuthorityDescriptor } from "./provider-policy-authority.js";

const execFile = promisify(execFileCallback);
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const GIT_OBJECT_RE = /^[0-9a-f]{40}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CLOSURE_FILE_BYTES = 32 * 1024 * 1024;
const TOOLCHAIN_TIMEOUT_MS = 15_000;

const ENTRYPOINT_PATHS = ["bin/pos"] as const;
const DEPENDENCY_LOCK_PATHS = ["uv.lock"] as const;
const SOURCE_REGISTRY_PATH = "config/research_sources.yaml";
const DEPENDENCY_DISTRIBUTIONS = ["jsonschema", "PyYAML", "referencing"] as const;
/**
 * V1 packages predate the D7 authority binding. They can be verified only so
 * an operator can inspect or migrate a retained closure; they cannot power a
 * new POS consumer launch.
 */
const LEGACY_RUNTIME_CONTRACT_PATHS = [
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json",
  "contracts/paperclip.research_continuation.v1.schema.json",
  "contracts/paperclip.research_plan.v2.schema.json",
  "contracts/paperclip.research_plan.v3.schema.json",
  "contracts/pos.learning_receipt.v2.schema.json",
  "contracts/pos.learning_receipt.v3.schema.json",
  "contracts/pos.managed_runtime_package.v1.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json",
  "contracts/pos.managed_runtime_rollback.v1.schema.json",
  "contracts/pos.managed_runtime_selector.v1.schema.json",
  "contracts/pos.managed_runtime_transition.v1.schema.json",
  "contracts/pos.next_research_authorization.v1.schema.json",
  "contracts/pos.next_research_authorization.v2.schema.json",
  "contracts/pos.paperclip_consumer_crash_journal.v1.schema.json",
  "contracts/pos.paperclip_consumer_envelope.v1.schema.json",
  "contracts/profit-flywheel.v2.json",
  "contracts/profit-flywheel.v2.schema.json",
] as const;

const RUNTIME_CONTRACT_PATHS = [
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json",
  "contracts/paperclip.factory_runtime_manifest.v2.schema.json",
  "contracts/paperclip.research_continuation.v1.schema.json",
  "contracts/paperclip.research_plan.v2.schema.json",
  "contracts/paperclip.research_plan.v3.schema.json",
  "contracts/pos.learning_receipt.v2.schema.json",
  "contracts/pos.learning_receipt.v3.schema.json",
  "contracts/pos.managed_runtime_package.v1.schema.json",
  "contracts/pos.managed_runtime_package.v2.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v2.schema.json",
  "contracts/pos.managed_runtime_rollback.v1.schema.json",
  "contracts/pos.managed_runtime_rollback.v2.schema.json",
  "contracts/pos.managed_runtime_selector.v1.schema.json",
  "contracts/pos.managed_runtime_selector.v2.schema.json",
  "contracts/pos.managed_runtime_transition.v1.schema.json",
  "contracts/pos.managed_runtime_transition.v2.schema.json",
  "contracts/pos.next_research_authorization.v1.schema.json",
  "contracts/pos.next_research_authorization.v2.schema.json",
  "contracts/pos.paperclip_consumer_crash_journal.v1.schema.json",
  "contracts/pos.paperclip_consumer_envelope.v1.schema.json",
  "contracts/pos.research_portfolio.v1.schema.json",
  "contracts/pos.paperclip_provider_policy_authority.v1.schema.json",
  "contracts/pos.paperclip_provider_policy_authority.v2.schema.json",
  "contracts/profit-flywheel.v2.json",
  "contracts/profit-flywheel.v2.schema.json",
] as const;

const LEGACY_MANAGED_CONTRACT_SHA256 = {
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json":
    "dc0ea3a2c69103f7c889fc0b93f93bef6c4b28fd7d13cc44cd891953c429ddce",
  "contracts/pos.managed_runtime_package.v1.schema.json":
    "9d448c3105aaca60adc5c51772fdef0bbd343be06449d71c0d6910fc3baf6628",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json":
    "19fe3f09d8d70d4ac873f31ab3fe63048df800303d4a36435ae86cbb13bd3691",
  "contracts/pos.managed_runtime_rollback.v1.schema.json":
    "ba3f172708f0a3bcf9fb1fc7f9cbd0159fa682fbe8f3e00d680710b8a328e30e",
  "contracts/pos.managed_runtime_selector.v1.schema.json":
    "266d708a72cc4371995f6e8650b500822952068098920a0f51d663681864a718",
  "contracts/pos.managed_runtime_transition.v1.schema.json":
    "f5be589d60157a04ca3d7b3a09c4ebd331d6063b4551e0451c3834873cbf43cd",
} as const;

const MANAGED_CONTRACT_SHA256 = {
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json":
    "dc0ea3a2c69103f7c889fc0b93f93bef6c4b28fd7d13cc44cd891953c429ddce",
  "contracts/paperclip.factory_runtime_manifest.v2.schema.json":
    "719d2c9eded06069f1a15dd6669c6eb2e2398f6e080c92d4f93f2596498b986c",
  "contracts/pos.managed_runtime_package.v1.schema.json":
    "9d448c3105aaca60adc5c51772fdef0bbd343be06449d71c0d6910fc3baf6628",
  "contracts/pos.managed_runtime_package.v2.schema.json":
    "2c37b0969c67585ee5bd02a509182aac54baf8eb3915bbbf500cceedaf930dce",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json":
    "19fe3f09d8d70d4ac873f31ab3fe63048df800303d4a36435ae86cbb13bd3691",
  "contracts/pos.managed_runtime_pointer_set.v2.schema.json":
    "a392e05a6c5763a7fa4fb80484bc3133899a4dd0a316d33ac889219218158239",
  "contracts/pos.managed_runtime_rollback.v1.schema.json":
    "ba3f172708f0a3bcf9fb1fc7f9cbd0159fa682fbe8f3e00d680710b8a328e30e",
  "contracts/pos.managed_runtime_rollback.v2.schema.json":
    "6b196a156fbe9d6ab220b24510db7dc2a4c5be528b1856bcace4e2c58e41765e",
  "contracts/pos.managed_runtime_selector.v1.schema.json":
    "266d708a72cc4371995f6e8650b500822952068098920a0f51d663681864a718",
  "contracts/pos.managed_runtime_selector.v2.schema.json":
    "7b226593b98f1560db26450bad857680b83af552d4f8cb56d54cdc95fde17c6f",
  "contracts/pos.managed_runtime_transition.v1.schema.json":
    "f5be589d60157a04ca3d7b3a09c4ebd331d6063b4551e0451c3834873cbf43cd",
  "contracts/pos.managed_runtime_transition.v2.schema.json":
    "8b1d951047907585dd897886c810c09713c2bd34948bbf1e3d545a341929129b",
  "contracts/pos.paperclip_provider_policy_authority.v1.schema.json":
    "bd800da956bfb3b2966c5b38326fe4b2e0e8049a1153d51c33394cb862c68541",
  "contracts/pos.paperclip_provider_policy_authority.v2.schema.json":
    "6e50583d014303664ca9fd17b9f8dd79c78fa8bf96ab316e439b280563736088",
  "contracts/pos.research_portfolio.v1.schema.json":
    "0bb4e3d75cddcb1d937b0e971f20ccadc7571852940a6bab32a734f7ab6bd804",
} as const;

const artifactBindingSchema = z.object({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(SHA256_RE),
}).strict();

const sourceFileBindingSchema = artifactBindingSchema.extend({
  relative_path: z.string().min(1),
}).strict();

const runtimeTargetSchema = z.object({
  runtime_id: z.string().regex(/^portfolio-os-[0-9a-f]{64}$/),
  closure_sha256: z.string().regex(SHA256_RE),
  package_root: z.string().startsWith("/"),
  package: artifactBindingSchema,
  runtime_manifest: artifactBindingSchema,
}).strict();

const legacySelectorSchema = z.object({
  schema_version: z.literal("pos.managed_runtime_selector.v1"),
  pointer_set: artifactBindingSchema,
}).strict();

const authoritySelectorSchema = z.object({
  schema_version: z.literal("pos.managed_runtime_selector.v2"),
  pointer_set: artifactBindingSchema,
}).strict();

const selectorSchema = z.discriminatedUnion("schema_version", [
  legacySelectorSchema,
  authoritySelectorSchema,
]);

const legacyPointerSetSchema = z.object({
  schema_version: z.literal("pos.managed_runtime_pointer_set.v1"),
  generation: z.number().int().positive(),
  current: runtimeTargetSchema,
  previous: runtimeTargetSchema.nullable(),
  activated_at: z.string().datetime({ offset: true }),
}).strict();

const authorityPointerSetSchema = z.object({
  schema_version: z.literal("pos.managed_runtime_pointer_set.v2"),
  generation: z.number().int().positive(),
  current: runtimeTargetSchema,
  previous: runtimeTargetSchema.nullable(),
  activated_at: z.string().datetime({ offset: true }),
}).strict();

const pointerSetSchema = z.discriminatedUnion("schema_version", [
  legacyPointerSetSchema,
  authorityPointerSetSchema,
]);

const dependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  files_sha256: z.string().regex(SHA256_RE),
}).strict();

const toolchainSchema = z.object({
  interpreter_path: z.string().startsWith("/"),
  version: z.string().min(1),
  implementation: z.string().min(1),
  cache_tag: z.string().min(1),
  platform: z.string().min(1),
  identity_sha256: z.string().regex(SHA256_RE),
  binary_sha256: z.string().regex(SHA256_RE),
  dependencies: z.array(dependencySchema).min(3).max(16),
}).strict();

const packageCoreSchema = z.object({
  runtime_id: z.string().regex(/^portfolio-os-[0-9a-f]{64}$/),
  closure_sha256: z.string().regex(SHA256_RE),
  package_root: z.string().startsWith("/"),
  source: z.object({
    repository: z.string().startsWith("/"),
    commit: z.string().regex(COMMIT_RE),
    tree_sha256: z.string().regex(SHA256_RE),
    tracked_files_sha256: z.string().regex(SHA256_RE),
    clean: z.literal(true),
  }).strict(),
  allowlist: z.object({
    entrypoints: z.array(sourceFileBindingSchema).min(1).max(8),
    dependency_locks: z.array(sourceFileBindingSchema).min(1).max(8),
    source_registry: sourceFileBindingSchema,
    contracts: z.array(sourceFileBindingSchema).min(1).max(256),
  }).strict(),
  toolchain: toolchainSchema,
  writable_roots: z.object({
    cache: z.string().startsWith("/"),
    output: z.string().startsWith("/"),
  }).strict(),
  runtime_manifest: artifactBindingSchema,
  built_at: z.string().datetime({ offset: true }),
  read_only: z.literal(true),
});

const legacyPackageSchema = packageCoreSchema.extend({
  schema_version: z.literal("pos.managed_runtime_package.v1"),
}).strict();

const authorityPackageSchema = packageCoreSchema.extend({
  schema_version: z.literal("pos.managed_runtime_package.v2"),
  provider_policy_authority: artifactBindingSchema,
}).strict();

const packageSchema = z.discriminatedUnion("schema_version", [
  legacyPackageSchema,
  authorityPackageSchema,
]);

const runtimeManifestCoreSchema = z.object({
  runtime_id: z.string().regex(/^portfolio-os-[0-9a-f]{64}$/),
  runtime_kind: z.literal("portfolio_os"),
  source: z.object({
    repository: z.string().startsWith("/"),
    commit: z.string().regex(COMMIT_RE),
    tree_sha256: z.string().regex(SHA256_RE),
    clean: z.literal(true),
  }).strict(),
  executable: artifactBindingSchema,
  interpreter: z.object({
    path: z.string().startsWith("/"),
    version: z.string().min(1),
    identity_sha256: z.string().regex(SHA256_RE),
  }).strict(),
  dependency_lock: artifactBindingSchema,
  contracts: z.array(artifactBindingSchema).min(1).max(256),
  source_registry: artifactBindingSchema,
  writable_roots: z.array(z.string().startsWith("/")).min(1).max(32),
  built_at: z.string().datetime({ offset: true }),
});

const legacyRuntimeManifestSchema = runtimeManifestCoreSchema.extend({
  schema_version: z.literal("paperclip.factory_runtime_manifest.v1"),
}).strict();

const authorityRuntimeManifestSchema = runtimeManifestCoreSchema.extend({
  schema_version: z.literal("paperclip.factory_runtime_manifest.v2"),
  provider_policy_authority: artifactBindingSchema,
}).strict();

const runtimeManifestSchema = z.discriminatedUnion("schema_version", [
  legacyRuntimeManifestSchema,
  authorityRuntimeManifestSchema,
]);

type ArtifactBinding = z.infer<typeof artifactBindingSchema>;
type RuntimeTarget = z.infer<typeof runtimeTargetSchema>;
type PackageDescriptor = z.infer<typeof packageSchema>;
type Toolchain = z.infer<typeof toolchainSchema>;
type RuntimeGeneration = "v1" | "v2";

export interface ManagedPosRuntimeInvocationDescriptor {
  schemaVersion: "paperclip.managed_pos_runtime_invocation.v1";
  generation: number;
  selector: ArtifactBinding;
  pointerSet: ArtifactBinding;
  /** Null only for a legacy v1 closure, which is migration/rollback-only. */
  providerPolicyAuthority: ArtifactBinding | null;
  /** Legacy v1 closures may be inspected but cannot admit new live work. */
  migrationOnly: boolean;
  current: RuntimeTarget;
  previous: RuntimeTarget | null;
  command: {
    executablePath: string;
    cwd: string;
    runtimeManifestPath: string;
    runtimeManifestArgs: ["--runtime-manifest", string];
  };
  writableRoots: {
    cache: string;
    output: string;
  };
  toolchain: Toolchain;
}

interface VerifiedPackage {
  target: RuntimeTarget;
  descriptor: PackageDescriptor;
}

function schemaGeneration(schemaVersion: string): RuntimeGeneration {
  return schemaVersion.endsWith(".v2") ? "v2" : "v1";
}

function verifyPointerPackageGenerations(input: {
  pointerGeneration: RuntimeGeneration;
  current: VerifiedPackage;
  previous: VerifiedPackage | null;
}) {
  const currentGeneration = schemaGeneration(input.current.descriptor.schema_version);
  const previousGeneration = input.previous
    ? schemaGeneration(input.previous.descriptor.schema_version)
    : null;
  if (input.pointerGeneration === "v1") {
    if (currentGeneration !== "v1") {
      throw new Error("managed_pos_runtime_pointer_current_generation_mismatch");
    }
    if (previousGeneration !== null && previousGeneration !== "v1") {
      throw new Error("managed_pos_runtime_pointer_previous_generation_mismatch");
    }
    return;
  }
  if (currentGeneration !== "v2") {
    throw new Error("managed_pos_runtime_pointer_current_generation_mismatch");
  }
  // A v2 pointer may retain either a v1 rollback closure or a v2 predecessor.
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function assertCanonicalAbsolute(value: string, code: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error(code);
  }
  return value;
}

function isInside(value: string, root: string) {
  return value === root || value.startsWith(`${root}${path.sep}`);
}

function pathsOverlap(left: string, right: string) {
  return isInside(left, right) || isInside(right, left);
}

function plainBinding(value: z.infer<typeof sourceFileBindingSchema>): ArtifactBinding {
  return { path: value.path, sha256: value.sha256 };
}

async function execGitText(repository: string, args: string[]) {
  const result = await execFile("git", args, {
    cwd: repository,
    timeout: TOOLCHAIN_TIMEOUT_MS,
    maxBuffer: MAX_CLOSURE_FILE_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => {
    throw new Error("managed_pos_runtime_git_unverifiable");
  });
  return result.stdout;
}

function execGitBuffer(repository: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFileCallback("git", args, {
      cwd: repository,
      timeout: TOOLCHAIN_TIMEOUT_MS,
      maxBuffer: MAX_CLOSURE_FILE_BYTES,
      encoding: "buffer",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => {
      if (error || !Buffer.isBuffer(stdout)) {
        reject(new Error("managed_pos_runtime_git_unverifiable"));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readBoundJson<T>(input: {
  binding: ArtifactBinding;
  expectedPath: string;
  label: string;
  schema: z.ZodType<T>;
}) {
  if (input.binding.path !== input.expectedPath) {
    throw new Error(`${input.label}_path_authority_mismatch`);
  }
  const artifact = await readTrustedJsonFile(input.expectedPath, input.label, {
    maxBytes: MAX_JSON_BYTES,
  });
  if (artifact.sha256 !== input.binding.sha256) {
    throw new Error(`${input.label}_sha256_mismatch`);
  }
  const parsed = input.schema.safeParse(artifact.value);
  if (!parsed.success) throw new Error(`${input.label}_invalid`);
  if ((artifact.metadata.mode & 0o777) !== 0o444) {
    throw new Error(`${input.label}_mode_mismatch`);
  }
  if (artifact.bytes.compare(canonicalJsonBytes(parsed.data)) !== 0) {
    throw new Error(`${input.label}_canonical_json_mismatch`);
  }
  return { artifact, value: parsed.data };
}

async function validateReadOnlyTree(root: string) {
  async function visit(directory: string): Promise<void> {
    const metadata = await lstat(directory).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o555) {
      throw new Error("managed_pos_runtime_package_tree_unsafe");
    }
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        const child = path.join(directory, entry.name);
        const childMetadata = await lstat(child).catch(() => null);
        if (!childMetadata || childMetadata.isSymbolicLink()) {
          throw new Error("managed_pos_runtime_package_tree_unsafe");
        }
        if (childMetadata.isDirectory()) await visit(child);
        else if (!childMetadata.isFile() || ![0o444, 0o555].includes(childMetadata.mode & 0o777)) {
          throw new Error("managed_pos_runtime_package_tree_unsafe");
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  await visit(root);
}

async function verifyClosureFile(input: {
  packageRoot: string;
  commit: string;
  binding: z.infer<typeof sourceFileBindingSchema>;
  expectedRelativePath: string;
  requireExecutable?: boolean;
}) {
  if (input.binding.relative_path !== input.expectedRelativePath) {
    throw new Error("managed_pos_runtime_allowlist_mismatch");
  }
  const expectedPath = path.join(input.packageRoot, ...input.expectedRelativePath.split("/"));
  if (input.binding.path !== expectedPath) {
    throw new Error("managed_pos_runtime_allowlist_path_mismatch");
  }
  const artifact = await readTrustedFile(expectedPath, "managed_pos_runtime_closure_file", {
    maxBytes: MAX_CLOSURE_FILE_BYTES,
    requireReadOnly: true,
    requireCurrentOwner: false,
  });
  if (artifact.sha256 !== input.binding.sha256) {
    throw new Error("managed_pos_runtime_closure_file_sha256_mismatch");
  }
  const expectedMode = input.requireExecutable ? 0o555 : 0o444;
  if ((artifact.metadata.mode & 0o777) !== expectedMode) {
    throw new Error(input.requireExecutable
      ? "managed_pos_runtime_entrypoint_not_executable"
      : "managed_pos_runtime_closure_file_mode_mismatch");
  }
  const committed = await execGitBuffer(input.packageRoot, [
    "show",
    `${input.commit}:${input.expectedRelativePath}`,
  ]);
  if (sha256(committed) !== artifact.sha256) {
    throw new Error("managed_pos_runtime_closure_file_commit_mismatch");
  }
}

function parseNullDelimited(raw: Buffer) {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index > start) records.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start < raw.length) records.push(raw.subarray(start));
  return records;
}

function decodeUtf8(value: Buffer, errorCode: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(errorCode);
  }
}

interface GitTreeEntry {
  mode: "100644" | "100755" | "160000";
  kind: "blob" | "commit";
  path: string;
  sha256: string;
}

function parseTreeEntries(raw: Buffer): GitTreeEntry[] {
  const files: GitTreeEntry[] = [];
  const seenPaths = new Set<string>();
  for (const record of parseNullDelimited(raw)) {
    const separator = record.indexOf(0x09);
    const header = separator >= 0 ? record.subarray(0, separator).toString("ascii") : "";
    const filePath = separator >= 0
      ? decodeUtf8(record.subarray(separator + 1), "managed_pos_runtime_git_tree_invalid")
      : "";
    const [mode, kind, objectId, ...extra] = header.split(" ");
    const pathParts = filePath.split("/");
    const validPath = !path.isAbsolute(filePath) &&
      pathParts.every((part) => part !== "" && part !== "." && part !== "..");
    const validBlob = kind === "blob" && (mode === "100644" || mode === "100755");
    const validGitlink = kind === "commit" && mode === "160000";
    if ((!validBlob && !validGitlink) || !objectId || !GIT_OBJECT_RE.test(objectId) ||
        extra.length > 0 || !filePath || !validPath || seenPaths.has(filePath)) {
      throw new Error("managed_pos_runtime_git_tree_invalid");
    }
    seenPaths.add(filePath);
    files.push({
      mode: mode as GitTreeEntry["mode"],
      kind: kind as GitTreeEntry["kind"],
      path: filePath,
      sha256: objectId,
    });
  }
  return files.sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
}

async function verifyGitlinkCheckouts(packageRoot: string, entries: GitTreeEntry[]) {
  for (const entry of entries) {
    if (entry.kind !== "commit") continue;
    const gitlinkPath = path.join(packageRoot, ...entry.path.split("/"));
    const before = await lstat(gitlinkPath).catch(() => null);
    if (!before?.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o555) {
      throw new Error("managed_pos_runtime_gitlink_checkout_unsafe");
    }
    const handle = await opendir(gitlinkPath).catch(() => null);
    if (!handle) throw new Error("managed_pos_runtime_gitlink_checkout_unsafe");
    let populated = false;
    try {
      populated = (await handle.read()) !== null;
    } finally {
      await handle.close().catch(() => undefined);
    }
    const after = await lstat(gitlinkPath).catch(() => null);
    if (populated || !after?.isDirectory() || after.isSymbolicLink() ||
        (after.mode & 0o777) !== 0o555 || after.dev !== before.dev || after.ino !== before.ino ||
        after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("managed_pos_runtime_gitlink_checkout_unsafe");
    }
  }
}

async function verifyGitClosure(packageRoot: string, descriptor: PackageDescriptor) {
  const [head, status, tree, treeEntries, topLevel, gitDirectory, branch, fileMode, ignored] =
    await Promise.all([
    execGitText(packageRoot, ["rev-parse", "HEAD"]),
    execGitText(packageRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    execGitBuffer(packageRoot, ["ls-tree", "-r", "--full-tree", descriptor.source.commit]),
    execGitBuffer(packageRoot, ["ls-tree", "-rz", "--full-tree", descriptor.source.commit]),
    execGitText(packageRoot, ["rev-parse", "--show-toplevel"]),
    execGitText(packageRoot, ["rev-parse", "--absolute-git-dir"]),
    execGitText(packageRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    execGitText(packageRoot, ["config", "--bool", "core.filemode"]),
    execGitBuffer(packageRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ]);
  const parsedTreeEntries = parseTreeEntries(treeEntries);
  await verifyGitlinkCheckouts(packageRoot, parsedTreeEntries);
  if (head.trim().toLowerCase() !== descriptor.source.commit || status !== "" ||
      sha256(tree) !== descriptor.source.tree_sha256 || topLevel.trim() !== packageRoot ||
      gitDirectory.trim() !== path.join(packageRoot, ".git") || branch.trim() !== "HEAD" ||
      fileMode.trim() !== "true") {
    throw new Error("managed_pos_runtime_source_provenance_mismatch");
  }
  const ignoredPaths = parseNullDelimited(ignored).map((value) =>
    decodeUtf8(value, "managed_pos_runtime_ignored_inventory_invalid"));
  if (!isDeepStrictEqual(ignoredPaths.sort(compareUnicodeCodePoints), [
    ".runtime/package.json",
    ".runtime/runtime-manifest.json",
    ".venv/bin/python",
  ])) {
    throw new Error("managed_pos_runtime_ignored_inventory_invalid");
  }
  const trackedFilesSha256 = sha256(canonicalJsonBytes({
    files: parsedTreeEntries.map(({ mode, path: filePath, sha256: objectId }) => ({
      mode,
      path: filePath,
      sha256: objectId,
    })),
  }));
  if (trackedFilesSha256 !== descriptor.source.tracked_files_sha256) {
    throw new Error("managed_pos_runtime_tracked_files_mismatch");
  }
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readStableInterpreterBinary(value: string) {
  const before = await lstat(value).catch(() => null);
  // The interpreter lives outside the immutable package and is commonly an
  // owner-writable package-manager binary. Its bytes and complete observed
  // identity are pinned below; package files themselves remain exactly 0444/0555.
  if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o111) === 0 ||
      before.size <= 0 || before.size > 128 * 1024 * 1024) {
    throw new Error("managed_pos_runtime_interpreter_binary_unsafe");
  }
  const handle = await open(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(value);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
        afterPath.mode !== before.mode || afterPath.size !== before.size) {
      throw new Error("managed_pos_runtime_interpreter_binary_changed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

const TOOLCHAIN_SCRIPT = `
import hashlib
import importlib.metadata as metadata
import json
import platform
import sys

dependencies = []
for name in ('jsonschema', 'PyYAML', 'referencing'):
    distribution = metadata.distribution(name)
    files = []
    for item in sorted(distribution.files or (), key=lambda value: value.as_posix()):
        path = distribution.locate_file(item)
        if path.is_file():
            files.append({
                'path': item.as_posix(),
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            })
    files_sha256 = hashlib.sha256(
        json.dumps(files, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()
    dependencies.append({
        'name': name,
        'version': distribution.version,
        'files_sha256': files_sha256,
    })
print(json.dumps({
    'version': sys.version.split()[0],
    'implementation': sys.implementation.name,
    'cache_tag': sys.implementation.cache_tag,
    'platform': platform.platform(),
    'dependencies': dependencies,
}, sort_keys=True))
`;

async function verifyToolchain(packageRoot: string, toolchain: Toolchain) {
  assertCanonicalAbsolute(toolchain.interpreter_path, "managed_pos_runtime_interpreter_path_invalid");
  const interpreterBinary = await realpath(toolchain.interpreter_path).catch(() => "");
  if (!interpreterBinary || !path.isAbsolute(interpreterBinary)) {
    throw new Error("managed_pos_runtime_interpreter_unavailable");
  }
  const binaryBytes = await readStableInterpreterBinary(interpreterBinary);
  if (sha256(binaryBytes) !== toolchain.binary_sha256 ||
      sha256(`${interpreterBinary}\0${toolchain.version}\n`) !== toolchain.identity_sha256) {
    throw new Error("managed_pos_runtime_interpreter_identity_mismatch");
  }
  const observed = await execFile(toolchain.interpreter_path, ["-c", TOOLCHAIN_SCRIPT], {
    timeout: TOOLCHAIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => {
    throw new Error("managed_pos_runtime_toolchain_unverifiable");
  });
  let metadata: unknown;
  try {
    metadata = JSON.parse(observed.stdout.trim());
  } catch {
    throw new Error("managed_pos_runtime_toolchain_unverifiable");
  }
  const parsed = toolchainSchema.pick({
    version: true,
    implementation: true,
    cache_tag: true,
    platform: true,
    dependencies: true,
  }).safeParse(metadata);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, {
    version: toolchain.version,
    implementation: toolchain.implementation,
    cache_tag: toolchain.cache_tag,
    platform: toolchain.platform,
    dependencies: toolchain.dependencies,
  }) || toolchain.dependencies.map((dependency) => dependency.name).join("\0") !==
      DEPENDENCY_DISTRIBUTIONS.join("\0")) {
    throw new Error("managed_pos_runtime_toolchain_identity_mismatch");
  }
  const wrapper = path.join(packageRoot, ".venv", "bin", "python");
  const expectedWrapper = Buffer.from(
    `#!/bin/sh\nexec ${shellQuote(toolchain.interpreter_path)} "$@"\n`,
    "utf8",
  );
  const wrapperArtifact = await readTrustedFile(wrapper, "managed_pos_runtime_interpreter_wrapper", {
    maxBytes: 16 * 1024,
    requireReadOnly: true,
    requireCurrentOwner: false,
  });
  if (wrapperArtifact.metadata.isSymbolicLink() || wrapperArtifact.bytes.compare(expectedWrapper) !== 0 ||
      (wrapperArtifact.metadata.mode & 0o777) !== 0o555) {
    throw new Error("managed_pos_runtime_interpreter_wrapper_mismatch");
  }
}

async function verifyWritableRoots(packageRoot: string, descriptor: PackageDescriptor) {
  const cache = assertCanonicalAbsolute(
    descriptor.writable_roots.cache,
    "managed_pos_runtime_cache_root_invalid",
  );
  const output = assertCanonicalAbsolute(
    descriptor.writable_roots.output,
    "managed_pos_runtime_output_root_invalid",
  );
  if (pathsOverlap(cache, output) || pathsOverlap(cache, packageRoot) ||
      pathsOverlap(output, packageRoot)) {
    throw new Error("managed_pos_runtime_writable_roots_overlap");
  }
  const [verifiedCache, verifiedOutput] = await Promise.all([
    requireTrustedDirectory(cache, "managed_pos_runtime_cache_root"),
    requireTrustedDirectory(output, "managed_pos_runtime_output_root"),
  ]);
  await Promise.all([
    access(verifiedCache, constants.R_OK | constants.W_OK | constants.X_OK),
    access(verifiedOutput, constants.R_OK | constants.W_OK | constants.X_OK),
  ]).catch(() => {
    throw new Error("managed_pos_runtime_writable_root_unusable");
  });
  return { cache: verifiedCache, output: verifiedOutput };
}

async function verifyPackageTarget(input: {
  runtimeRoot: string;
  target: RuntimeTarget;
  label: "current" | "previous";
}): Promise<VerifiedPackage> {
  const packagesRoot = path.join(input.runtimeRoot, "packages");
  const expectedPackageRoot = path.join(packagesRoot, input.target.closure_sha256);
  if (input.target.package_root !== expectedPackageRoot ||
      input.target.runtime_id !== `portfolio-os-${input.target.closure_sha256}`) {
    throw new Error(`managed_pos_runtime_${input.label}_target_authority_mismatch`);
  }
  const packageRoot = await requireTrustedDirectory(
    expectedPackageRoot,
    `managed_pos_runtime_${input.label}_package_root`,
  );
  await validateReadOnlyTree(packageRoot);
  const expectedPackagePath = path.join(packageRoot, ".runtime", "package.json");
  const packageArtifact = await readBoundJson({
    binding: input.target.package,
    expectedPath: expectedPackagePath,
    label: `managed_pos_runtime_${input.label}_package`,
    schema: packageSchema,
  });
  const descriptor = packageArtifact.value;
  const authorityBound = descriptor.schema_version === "pos.managed_runtime_package.v2";
  const contractPaths = authorityBound ? RUNTIME_CONTRACT_PATHS : LEGACY_RUNTIME_CONTRACT_PATHS;
  const expectedManifestSchemaVersion = authorityBound
    ? "paperclip.factory_runtime_manifest.v2"
    : "paperclip.factory_runtime_manifest.v1";
  if (descriptor.package_root !== packageRoot || descriptor.runtime_id !== input.target.runtime_id ||
      descriptor.closure_sha256 !== input.target.closure_sha256 ||
      !isDeepStrictEqual(descriptor.runtime_manifest, input.target.runtime_manifest)) {
    throw new Error(`managed_pos_runtime_${input.label}_package_target_mismatch`);
  }
  assertCanonicalAbsolute(descriptor.source.repository, "managed_pos_runtime_source_repository_invalid");
  await verifyGitClosure(packageRoot, descriptor);

  if (descriptor.allowlist.entrypoints.map((value) => value.relative_path).join("\0") !==
      ENTRYPOINT_PATHS.join("\0") ||
      descriptor.allowlist.dependency_locks.map((value) => value.relative_path).join("\0") !==
      DEPENDENCY_LOCK_PATHS.join("\0") ||
      descriptor.allowlist.contracts.map((value) => value.relative_path).join("\0") !==
      contractPaths.join("\0") ||
      descriptor.allowlist.source_registry.relative_path !== SOURCE_REGISTRY_PATH) {
    throw new Error("managed_pos_runtime_exact_allowlist_mismatch");
  }
  await verifyClosureFile({
    packageRoot,
    commit: descriptor.source.commit,
    binding: descriptor.allowlist.entrypoints[0]!,
    expectedRelativePath: ENTRYPOINT_PATHS[0],
    requireExecutable: true,
  });
  await verifyClosureFile({
    packageRoot,
    commit: descriptor.source.commit,
    binding: descriptor.allowlist.dependency_locks[0]!,
    expectedRelativePath: DEPENDENCY_LOCK_PATHS[0],
  });
  await verifyClosureFile({
    packageRoot,
    commit: descriptor.source.commit,
    binding: descriptor.allowlist.source_registry,
    expectedRelativePath: SOURCE_REGISTRY_PATH,
  });
  await Promise.all(descriptor.allowlist.contracts.map((binding, index) =>
    verifyClosureFile({
      packageRoot,
      commit: descriptor.source.commit,
      binding,
      expectedRelativePath: contractPaths[index]!,
    })));
  const expectedContractPins = authorityBound
    ? MANAGED_CONTRACT_SHA256
    : LEGACY_MANAGED_CONTRACT_SHA256;
  for (const [relativePath, expectedSha256] of Object.entries(expectedContractPins)) {
    const binding = descriptor.allowlist.contracts.find((value) => value.relative_path === relativePath);
    if (binding?.sha256 !== expectedSha256) {
      throw new Error("managed_pos_runtime_contract_pin_mismatch");
    }
  }

  await verifyToolchain(packageRoot, descriptor.toolchain);
  const writableRoots = await verifyWritableRoots(packageRoot, descriptor);
  const relativeAllowlist = {
    entrypoints: descriptor.allowlist.entrypoints.map(({ relative_path, sha256: digest }) => ({
      relative_path,
      sha256: digest,
    })),
    dependency_locks: descriptor.allowlist.dependency_locks.map(({ relative_path, sha256: digest }) => ({
      relative_path,
      sha256: digest,
    })),
    source_registry: {
      relative_path: descriptor.allowlist.source_registry.relative_path,
      sha256: descriptor.allowlist.source_registry.sha256,
    },
    contracts: descriptor.allowlist.contracts.map(({ relative_path, sha256: digest }) => ({
      relative_path,
      sha256: digest,
    })),
  };
  let providerPolicyAuthority: ArtifactBinding | null = null;
  if (authorityBound) {
    providerPolicyAuthority = descriptor.provider_policy_authority;
    await verifyProviderPolicyAuthorityDescriptor({
      authorityPath: providerPolicyAuthority.path,
      expectedBinding: providerPolicyAuthority,
    }).catch(() => {
      throw new Error(`managed_pos_runtime_${input.label}_provider_policy_authority_invalid`);
    });
  }
  const closure = {
    schema_version: authorityBound
      ? "pos.managed_runtime_closure.v2"
      : "pos.managed_runtime_closure.v1",
    source: descriptor.source,
    allowlist: relativeAllowlist,
    toolchain: descriptor.toolchain,
    writable_roots: writableRoots,
    built_at: descriptor.built_at,
    ...(providerPolicyAuthority ? { provider_policy_authority: providerPolicyAuthority } : {}),
  };
  if (sha256(canonicalJsonBytes(closure)) !== descriptor.closure_sha256 ||
      path.basename(packageRoot) !== descriptor.closure_sha256) {
    throw new Error("managed_pos_runtime_closure_sha256_mismatch");
  }

  const expectedManifestPath = path.join(packageRoot, ".runtime", "runtime-manifest.json");
  const manifestArtifact = await readBoundJson({
    binding: input.target.runtime_manifest,
    expectedPath: expectedManifestPath,
    label: `managed_pos_runtime_${input.label}_manifest`,
    schema: runtimeManifestSchema,
  });
  if (manifestArtifact.value.schema_version !== expectedManifestSchemaVersion) {
    throw new Error(`managed_pos_runtime_${input.label}_manifest_schema_generation_mismatch`);
  }
  if (!isDeepStrictEqual(descriptor.runtime_manifest, input.target.runtime_manifest)) {
    throw new Error(`managed_pos_runtime_${input.label}_manifest_binding_mismatch`);
  }
  const expectedManifest = {
    schema_version: expectedManifestSchemaVersion,
    runtime_id: descriptor.runtime_id,
    runtime_kind: "portfolio_os",
    source: {
      repository: packageRoot,
      commit: descriptor.source.commit,
      tree_sha256: descriptor.source.tree_sha256,
      clean: true,
    },
    executable: plainBinding(descriptor.allowlist.entrypoints[0]!),
    interpreter: {
      path: descriptor.toolchain.interpreter_path,
      version: descriptor.toolchain.version,
      identity_sha256: descriptor.toolchain.identity_sha256,
    },
    dependency_lock: plainBinding(descriptor.allowlist.dependency_locks[0]!),
    contracts: descriptor.allowlist.contracts.map(plainBinding),
    source_registry: plainBinding(descriptor.allowlist.source_registry),
    writable_roots: [writableRoots.cache, writableRoots.output],
    built_at: descriptor.built_at,
    ...(providerPolicyAuthority ? { provider_policy_authority: providerPolicyAuthority } : {}),
  };
  if (!isDeepStrictEqual(manifestArtifact.value, expectedManifest)) {
    throw new Error(`managed_pos_runtime_${input.label}_manifest_drift`);
  }
  return { target: input.target, descriptor };
}

/**
 * Resolve the one atomically active POS package into an invocation descriptor.
 * The resolver validates current and previous closures in full and never
 * accepts a caller-selected manifest or executable path.
 */
export async function resolveManagedPortfolioOsRuntime(input: {
  runtimeRoot: string;
}): Promise<ManagedPosRuntimeInvocationDescriptor> {
  const requestedRoot = assertCanonicalAbsolute(
    input.runtimeRoot,
    "managed_pos_runtime_root_invalid",
  );
  const runtimeRoot = await requireTrustedDirectory(requestedRoot, "managed_pos_runtime_root");
  const selectorPath = path.join(runtimeRoot, "control", "active.json");
  const selectorArtifact = await readTrustedJsonFile(
    selectorPath,
    "managed_pos_runtime_selector",
    { maxBytes: MAX_JSON_BYTES },
  );
  const selector = selectorSchema.safeParse(selectorArtifact.value);
  if (!selector.success) throw new Error("managed_pos_runtime_selector_invalid");
  if ((selectorArtifact.metadata.mode & 0o777) !== 0o444) {
    throw new Error("managed_pos_runtime_selector_mode_mismatch");
  }
  if (selectorArtifact.bytes.compare(canonicalJsonBytes(selector.data)) !== 0) {
    throw new Error("managed_pos_runtime_selector_canonical_json_mismatch");
  }
  const expectedPointerRoot = path.join(runtimeRoot, "control", "pointer-sets");
  const expectedPointerPath = path.join(
    expectedPointerRoot,
    `${selector.data.pointer_set.sha256}.json`,
  );
  if (selector.data.pointer_set.path !== expectedPointerPath) {
    throw new Error("managed_pos_runtime_pointer_set_path_authority_mismatch");
  }
  const pointerArtifact = await readBoundJson({
    binding: selector.data.pointer_set,
    expectedPath: expectedPointerPath,
    label: "managed_pos_runtime_pointer_set",
    schema: pointerSetSchema,
  });
  const selectorGeneration = schemaGeneration(selector.data.schema_version);
  const pointerGeneration = schemaGeneration(pointerArtifact.value.schema_version);
  // POS upgrades the selector format before it can atomically roll back to a
  // retained v1 pointer set. That one-way v2-selector -> v1-pointer state is
  // deliberate migration evidence; the inverse would make a legacy selector
  // select an authority-bound package it cannot describe.
  if (selectorGeneration !== pointerGeneration &&
      !(selectorGeneration === "v2" && pointerGeneration === "v1")) {
    throw new Error("managed_pos_runtime_selector_pointer_generation_mismatch");
  }
  if (pointerArtifact.value.previous?.closure_sha256 ===
      pointerArtifact.value.current.closure_sha256) {
    throw new Error("managed_pos_runtime_previous_aliases_current");
  }
  const [current, previous] = await Promise.all([
    verifyPackageTarget({
      runtimeRoot,
      target: pointerArtifact.value.current,
      label: "current",
    }),
    pointerArtifact.value.previous
      ? verifyPackageTarget({
        runtimeRoot,
        target: pointerArtifact.value.previous,
        label: "previous",
      })
      : Promise.resolve(null),
  ]);
  verifyPointerPackageGenerations({ pointerGeneration, current, previous });
  return {
    schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
    generation: pointerArtifact.value.generation,
    selector: { path: selectorArtifact.path, sha256: selectorArtifact.sha256 },
    pointerSet: { path: pointerArtifact.artifact.path, sha256: pointerArtifact.artifact.sha256 },
    providerPolicyAuthority: current.descriptor.schema_version === "pos.managed_runtime_package.v2"
      ? current.descriptor.provider_policy_authority
      : null,
    migrationOnly: current.descriptor.schema_version === "pos.managed_runtime_package.v1",
    current: current.target,
    previous: previous?.target ?? null,
    command: {
      executablePath: current.descriptor.allowlist.entrypoints[0]!.path,
      cwd: current.descriptor.package_root,
      runtimeManifestPath: current.descriptor.runtime_manifest.path,
      runtimeManifestArgs: ["--runtime-manifest", current.descriptor.runtime_manifest.path],
    },
    writableRoots: {
      cache: current.descriptor.writable_roots.cache,
      output: current.descriptor.writable_roots.output,
    },
    toolchain: current.descriptor.toolchain,
  };
}
