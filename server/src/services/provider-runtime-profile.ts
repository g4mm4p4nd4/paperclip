import { constants } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import os from "node:os";
import path from "node:path";
import type { ProviderPolicyRoute } from "./provider-policy.js";
import { isPidAlive, isProcessGroupAlive } from "./local-service-supervisor.js";

const SAFE_COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_ADAPTER_TYPES = new Set<ProviderPolicyRoute["runtimeBinding"]["adapterType"]>([
  "hermes_local",
  "codex_cli",
  "claude_cli",
  "gemini_cli",
  "direct_api",
]);
const CLEANUP_QUARANTINE_RE = /^\.cleanup-([A-Za-z0-9][A-Za-z0-9_-]{0,127})-([0-9a-f]{16})$/;
const MAX_CREDENTIAL_JSON_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_JSON_DEPTH = 16;
const MAX_CREDENTIAL_JSON_LEAVES = 4096;
const MIN_EXACT_REDACTION_VALUE_LENGTH = 8;
const DEFAULT_CLEANUP_QUARANTINE_STALE_MS = 5 * 60 * 1000;
const EXTERNAL_METADATA_BASENAME = ".DS_Store";
const MAX_EXTERNAL_METADATA_BYTES = 1024 * 1024;
const ACTIVE_HEARTBEAT_RUN_STATUSES = new Set(["queued", "running"]);
const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const CLEANUP_RECEIPT_SCHEMA_VERSION = "paperclip.provider_runtime_profile_cleanup.v1" as const;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export type PreparedProviderRuntimeProfile = {
  env: Record<string, string>;
  exactRedactionValues: ReadonlySet<string>;
};

export type ProviderRuntimeProfileRunAuthority = {
  status: string;
  processPid: number | null;
  processGroupId: number | null;
};

export type ProviderRuntimeProfileCleanupFailureCode =
  | "unsafe_managed_root"
  | "unsafe_managed_entry"
  | "run_authority_lookup_failed"
  | "run_authority_invalid"
  | "process_owner_check_failed"
  | "profile_cleanup_failed"
  | "quarantine_cleanup_failed"
  | "cleanup_receipt_failed";

export type ProviderRuntimeProfileCleanupFailure = {
  blockerCode: "provider_runtime_profile_cleanup_failed";
  failureCode: ProviderRuntimeProfileCleanupFailureCode;
  phase: "scan" | "run_authority" | "process_owner" | "profile_remove" | "quarantine_remove" | "receipt";
  count: number;
  nextOwner: "paperclip_runtime_owner";
  resumeCondition: "Repair the managed profile root, rerun startup cleanup, and verify its immutable aggregate receipt before resuming provider work";
};

export type ProviderRuntimeProfileCleanupCounts = {
  companiesScanned: number;
  adapterRootsScanned: number;
  profilesScanned: number;
  profilesRemoved: number;
  missingRunProfilesRemoved: number;
  terminalRunProfilesRemoved: number;
  activeProfilesPreserved: number;
  pidOwnedProfilesPreserved: number;
  quarantinesRemoved: number;
  freshQuarantinesPreserved: number;
  externalMetadataEntriesPreserved: number;
  unsafeEntriesPreserved: number;
  failures: number;
};

export type ProviderRuntimeProfileCleanupResult = {
  schemaVersion: typeof CLEANUP_RECEIPT_SCHEMA_VERSION;
  status: "clean" | "cleaned" | "partial_failure";
  counts: ProviderRuntimeProfileCleanupCounts;
  failures: ProviderRuntimeProfileCleanupFailure[];
  receiptPath: string;
  receiptSha256: string;
};

export class ProviderRuntimeProfileCleanupError extends Error {
  readonly failure: ProviderRuntimeProfileCleanupFailure;

  constructor(failure: ProviderRuntimeProfileCleanupFailure) {
    super(failure.blockerCode);
    this.name = "ProviderRuntimeProfileCleanupError";
    this.failure = failure;
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function cleanupFailure(
  failureCode: ProviderRuntimeProfileCleanupFailureCode,
  phase: ProviderRuntimeProfileCleanupFailure["phase"],
  count = 1,
): ProviderRuntimeProfileCleanupFailure {
  return {
    blockerCode: "provider_runtime_profile_cleanup_failed",
    failureCode,
    phase,
    count,
    nextOwner: "paperclip_runtime_owner",
    resumeCondition: "Repair the managed profile root, rerun startup cleanup, and verify its immutable aggregate receipt before resuming provider work",
  };
}

export function providerRuntimeProfileCleanupFailureFromUnknown(
  error: unknown,
): ProviderRuntimeProfileCleanupFailure {
  return error instanceof ProviderRuntimeProfileCleanupError
    ? error.failure
    : cleanupFailure("unsafe_managed_root", "scan");
}

async function resolveSecureInstanceRoot(instanceRoot: string) {
  const resolved = path.resolve(instanceRoot);
  const observed = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!observed?.isDirectory() || observed.isSymbolicLink()) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  return canonical;
}

async function optionalLstat(target: string) {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isOwnedByCurrentUser(observed: { uid: number }) {
  return typeof process.geteuid !== "function" || observed.uid === process.geteuid();
}

type ProviderRuntimeExternalMetadataStat = {
  dev: number | bigint;
  uid: number;
  nlink: number;
  mode: number;
  size: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
};

/** @internal Exported for focused predicate coverage; cleanup callers use the no-follow scanner. */
export function isQualifyingProviderRuntimeExternalMetadata(input: {
  basename: string;
  parentDevice: number | bigint;
  currentUserId: number | null;
  observed: ProviderRuntimeExternalMetadataStat;
}) {
  return input.basename === EXTERNAL_METADATA_BASENAME &&
    input.currentUserId !== null &&
    input.observed.isFile() &&
    !input.observed.isSymbolicLink() &&
    input.observed.uid === input.currentUserId &&
    input.observed.dev === input.parentDevice &&
    input.observed.nlink === 1 &&
    (input.observed.mode & 0o111) === 0 &&
    input.observed.size >= 0 &&
    input.observed.size <= MAX_EXTERNAL_METADATA_BYTES;
}

function currentUserId() {
  if (typeof process.geteuid === "function") return process.geteuid();
  const uid = os.userInfo().uid;
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

async function assertSecureDirectory(instanceRoot: string, directory: string) {
  const resolved = path.resolve(directory);
  if (!isWithin(instanceRoot, resolved)) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  const observed = await lstat(resolved);
  if (!observed.isDirectory() || observed.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_entry", "scan"));
  }
  return observed;
}

async function readDirectoryNoFollow(instanceRoot: string, directory: string) {
  const before = await assertSecureDirectory(instanceRoot, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const after = await assertSecureDirectory(instanceRoot, directory);
  if (!sameFileIdentity(before, after)) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_entry", "scan"));
  }
  return entries;
}

type ExternalMetadataDisposition = "not_candidate" | "missing" | "preserved" | "unsafe";

async function classifyProviderRuntimeExternalMetadata(
  instanceRoot: string,
  parent: string,
  basename: string,
): Promise<ExternalMetadataDisposition> {
  if (basename !== EXTERNAL_METADATA_BASENAME) return "not_candidate";
  try {
    const parentBefore = await assertSecureDirectory(instanceRoot, parent);
    const observed = await optionalLstat(path.join(parent, EXTERNAL_METADATA_BASENAME));
    const parentAfter = await assertSecureDirectory(instanceRoot, parent);
    if (!sameFileIdentity(parentBefore, parentAfter)) return "unsafe";
    if (!observed) return "missing";
    return isQualifyingProviderRuntimeExternalMetadata({
      basename,
      parentDevice: parentBefore.dev,
      currentUserId: currentUserId(),
      observed,
    }) ? "preserved" : "unsafe";
  } catch {
    return "unsafe";
  }
}

async function assertSecureAncestors(instanceRoot: string, directory: string) {
  const target = path.resolve(directory);
  if (!isWithin(instanceRoot, target)) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  let current = instanceRoot;
  for (const segment of path.relative(instanceRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertSecureDirectory(instanceRoot, current);
  }
}

async function fsyncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedCredentialJson(source: string) {
  const basename = path.basename(source);
  const before = await optionalLstat(source);
  if (!before) throw new Error(`Runtime auth reference is unavailable: ${basename}`);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CREDENTIAL_JSON_BYTES ||
      !isOwnedByCurrentUser(before)) {
    throw new Error(`Runtime auth reference is not a bounded regular JSON file: ${basename}`);
  }
  if ((before.mode & 0o077) !== 0) {
    throw new Error(`Runtime auth reference permissions are broader than owner-only: ${basename}`);
  }
  const canonicalSource = await realpath(source);
  if (canonicalSource !== path.resolve(source)) {
    throw new Error(`Runtime auth reference must not traverse a symlink: ${basename}`);
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened) || (opened.mode & 0o077) !== 0 ||
        !isOwnedByCurrentUser(opened)) {
      throw new Error(`Runtime auth reference changed during secure open: ${basename}`);
    }
    const buffer = Buffer.alloc(MAX_CREDENTIAL_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const chunk = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    if (offset > MAX_CREDENTIAL_JSON_BYTES) {
      throw new Error(`Runtime auth reference exceeds its byte limit: ${basename}`);
    }
    const verificationBuffer = Buffer.alloc(offset + 1);
    let verificationOffset = 0;
    while (verificationOffset < verificationBuffer.length) {
      const chunk = await handle.read(
        verificationBuffer,
        verificationOffset,
        verificationBuffer.length - verificationOffset,
        verificationOffset,
      );
      if (chunk.bytesRead === 0) break;
      verificationOffset += chunk.bytesRead;
    }
    if (verificationOffset !== offset || !buffer.subarray(0, offset).equals(verificationBuffer.subarray(0, offset))) {
      throw new Error(`Runtime auth reference changed during bounded read: ${basename}`);
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(source);
    if (!sameFileIdentity(before, afterHandle) || !sameFileIdentity(before, afterPath) ||
        afterHandle.size !== before.size || afterPath.size !== before.size || afterPath.isSymbolicLink() ||
        afterHandle.mtimeMs !== before.mtimeMs || afterPath.mtimeMs !== before.mtimeMs ||
        afterHandle.ctimeMs !== before.ctimeMs || afterPath.ctimeMs !== before.ctimeMs ||
        (afterHandle.mode & 0o077) !== 0 || (afterPath.mode & 0o077) !== 0 ||
        !isOwnedByCurrentUser(afterHandle) || !isOwnedByCurrentUser(afterPath)) {
      throw new Error(`Runtime auth reference changed during bounded read: ${basename}`);
    }
    const value = parseCredentialJson(buffer.subarray(0, offset), basename);
    buffer.fill(0);
    verificationBuffer.fill(0);
    return { canonicalSource, value };
  } finally {
    await handle.close();
  }
}

function parseCredentialJson(buffer: Uint8Array, basename: string) {
  if (buffer.byteLength > MAX_CREDENTIAL_JSON_BYTES) {
    throw new Error(`Runtime auth reference exceeds its byte limit: ${basename}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Runtime auth reference is not valid UTF-8 JSON: ${basename}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Runtime auth reference is not valid JSON: ${basename}`);
  }
}

function collectCredentialStringLeaves(value: unknown, basename: string) {
  const exactRedactionValues = new Set<string>();
  let leaves = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_CREDENTIAL_JSON_DEPTH) {
      throw new Error(`Runtime auth reference exceeds its JSON depth limit: ${basename}`);
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const item of Object.values(candidate as Record<string, unknown>)) visit(item, depth + 1);
      return;
    }
    leaves += 1;
    if (leaves > MAX_CREDENTIAL_JSON_LEAVES) {
      throw new Error(`Runtime auth reference exceeds its JSON leaf limit: ${basename}`);
    }
    if (typeof candidate === "number" && !Number.isFinite(candidate)) {
      throw new Error(`Runtime auth reference contains a non-finite JSON number: ${basename}`);
    }
    if (typeof candidate !== "string") return;
    if (candidate.length > MAX_CREDENTIAL_JSON_BYTES) {
      throw new Error(`Runtime auth reference contains an oversized string leaf: ${basename}`);
    }
    if (candidate.length >= MIN_EXACT_REDACTION_VALUE_LENGTH) exactRedactionValues.add(candidate);
    const trimmed = candidate.trim();
    if (trimmed.length >= MIN_EXACT_REDACTION_VALUE_LENGTH) exactRedactionValues.add(trimmed);
  };
  visit(value, 0);
  return exactRedactionValues;
}

async function inspectCredentialJson(source: string) {
  const { canonicalSource, value } = await readBoundedCredentialJson(source);
  return {
    canonicalSource,
    exactRedactionValues: collectCredentialStringLeaves(value, path.basename(source)),
  };
}

function mergeExactRedactionValues(target: Set<string>, source: ReadonlySet<string>) {
  for (const value of source) target.add(value);
}

function assertManagedAdapterType(adapterType: string) {
  if (!MANAGED_ADAPTER_TYPES.has(adapterType as ProviderPolicyRoute["runtimeBinding"]["adapterType"])) {
    throw new Error("Provider policy selected an unsupported managed adapter type");
  }
}

async function ensurePrivateDirectory(root: string, directory: string) {
  const canonicalRoot = path.resolve(root);
  const target = path.resolve(directory);
  if (!isWithin(canonicalRoot, target)) {
    throw new Error(`Managed provider profile path escapes its instance root: ${directory}`);
  }
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Managed provider instance root is not a real directory: ${canonicalRoot}`);
  }
  let current = canonicalRoot;
  const relative = path.relative(canonicalRoot, target);
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    let observed = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!observed) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      observed = await lstat(current);
    }
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw new Error(`Managed provider profile path contains a non-directory or symlink: ${current}`);
    }
    const canonicalCurrent = await realpath(current);
    if (canonicalCurrent !== current || !isWithin(canonicalRoot, canonicalCurrent)) {
      throw new Error(`Managed provider profile path traverses a symlink: ${current}`);
    }
    await chmod(current, 0o700);
  }
}

async function enforceEmptyHermesDotenv(dotenv: string) {
  const existing = await lstat(dotenv).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("Managed Hermes profile .env is not a regular file");
  }
  const handle = await open(
    dotenv,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const observed = await handle.stat();
    if (!observed.isFile()) throw new Error("Managed Hermes profile .env is not a regular file");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function linkCredential(root: string, source: string, target: string, required: boolean) {
  const sourceStat = await optionalLstat(source);
  if (!sourceStat) {
    if (required) throw new Error(`Runtime auth reference is unavailable: ${path.basename(source)}`);
    return new Set<string>();
  }
  const { canonicalSource, exactRedactionValues } = await inspectCredentialJson(source);
  await ensurePrivateDirectory(root, path.dirname(target));
  const existing = await optionalLstat(target);
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error("Managed runtime auth target is not a symlink");
    const current = await readlink(target);
    if (path.resolve(path.dirname(target), current) === canonicalSource) return exactRedactionValues;
    await unlink(target);
  }
  await symlink(canonicalSource, target);
  const linked = await lstat(target);
  if (!linked.isSymbolicLink() || await realpath(target) !== canonicalSource) {
    throw new Error("Managed runtime auth target failed secure link verification");
  }
  const finalInspection = await inspectCredentialJson(canonicalSource);
  if (finalInspection.canonicalSource !== canonicalSource) {
    throw new Error("Managed runtime auth target changed during final verification");
  }
  return finalInspection.exactRedactionValues;
}

async function readMacosGenericPassword(service: string, account: string) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "buffer", maxBuffer: MAX_CREDENTIAL_JSON_BYTES + 1 },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) {
          reject(new Error(`Runtime auth reference is unavailable from macOS Keychain: ${service}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function materializeCredentialJson(
  root: string,
  target: string,
  credential: Buffer,
) {
  const basename = path.basename(target);
  const value = parseCredentialJson(credential, basename);
  const exactRedactionValues = collectCredentialStringLeaves(value, basename);
  await ensurePrivateDirectory(root, path.dirname(target));
  const existing = await optionalLstat(target);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || !isOwnedByCurrentUser(existing) ||
      (existing.mode & 0o077) !== 0)) {
    throw new Error("Managed runtime auth target is not an owned regular file");
  }
  const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(credential);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await fsyncDirectory(path.dirname(target));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const inspection = await inspectCredentialJson(target);
  mergeExactRedactionValues(exactRedactionValues, inspection.exactRedactionValues);
  return exactRedactionValues;
}

export async function prepareProviderRuntimeProfile(input: {
  companyId: string;
  executionId: string;
  route: ProviderPolicyRoute;
  instanceRoot: string;
  userHome?: string;
  environment?: NodeJS.ProcessEnv;
  /** Test seam for platform credential stores; production callers must omit it. */
  credentialStore?: {
    platform?: NodeJS.Platform;
    account?: string;
    readMacosGenericPassword?: (service: string, account: string) => Promise<Buffer>;
  };
}): Promise<PreparedProviderRuntimeProfile> {
  if (!SAFE_COMPANY_ID.test(input.companyId)) throw new Error("Company id is not safe for a managed provider profile");
  if (!SAFE_EXECUTION_ID.test(input.executionId)) throw new Error("Execution id is not safe for a managed provider profile");
  assertManagedAdapterType(input.route.runtimeBinding.adapterType);
  const instanceRoot = await resolveSecureInstanceRoot(input.instanceRoot);
  const userHome = await realpath(path.resolve(input.userHome ?? os.homedir()));
  const profileRoot = path.join(
    instanceRoot,
    "companies",
    input.companyId,
    "provider-runtime",
    input.route.runtimeBinding.adapterType,
    input.executionId,
  );
  try {
    const home = path.join(profileRoot, "home");
    await ensurePrivateDirectory(instanceRoot, home);
    const tmp = path.join(profileRoot, "tmp");
    await ensurePrivateDirectory(instanceRoot, tmp);
    const baseEnv = { HOME: home, TMPDIR: tmp };
    const exactRedactionValues = new Set<string>();

    switch (input.route.runtimeBinding.adapterType) {
      case "hermes_local": {
        const hermesHome = path.join(home, ".hermes");
        await ensurePrivateDirectory(instanceRoot, hermesHome);
        const dotenv = path.join(hermesHome, ".env");
        await enforceEmptyHermesDotenv(dotenv);
        return {
          env: {
            ...baseEnv,
            HERMES_HOME: hermesHome,
            HERMES_MANAGED_PROFILE: "1",
            HERMES_DISABLE_PROJECT_DOTENV: "1",
            HERMES_DISABLE_FALLBACK_MODEL: "1",
          },
          exactRedactionValues,
        };
      }
      case "codex_cli": {
        const sourceRoot = path.join(userHome, ".codex");
        const targetRoot = path.join(home, ".codex");
        mergeExactRedactionValues(
          exactRedactionValues,
          await linkCredential(instanceRoot, path.join(sourceRoot, "auth.json"), path.join(targetRoot, "auth.json"), true),
        );
        return { env: { ...baseEnv, CODEX_HOME: targetRoot }, exactRedactionValues };
      }
      case "claude_cli": {
        const sourceRoot = path.resolve(input.environment?.CLAUDE_CONFIG_DIR ?? path.join(userHome, ".claude"));
        const targetRoot = path.join(home, ".claude");
        const sourceCredential = path.join(sourceRoot, ".credentials.json");
        if (await optionalLstat(sourceCredential)) {
          mergeExactRedactionValues(
            exactRedactionValues,
            await linkCredential(instanceRoot, sourceCredential, path.join(targetRoot, ".credentials.json"), true),
          );
        } else if ((input.credentialStore?.platform ?? process.platform) === "darwin") {
          const account = input.credentialStore?.account ?? os.userInfo().username;
          const reader = input.credentialStore?.readMacosGenericPassword ?? readMacosGenericPassword;
          const credential = await reader(CLAUDE_KEYCHAIN_SERVICE, account);
          try {
            mergeExactRedactionValues(
              exactRedactionValues,
              await materializeCredentialJson(instanceRoot, path.join(targetRoot, ".credentials.json"), credential),
            );
          } finally {
            credential.fill(0);
          }
        } else {
          throw new Error("Runtime auth reference is unavailable: .credentials.json");
        }
        mergeExactRedactionValues(
          exactRedactionValues,
          await linkCredential(instanceRoot, path.join(sourceRoot, "credentials.json"), path.join(targetRoot, "credentials.json"), false),
        );
        return { env: { ...baseEnv, CLAUDE_CONFIG_DIR: targetRoot }, exactRedactionValues };
      }
      case "gemini_cli": {
        const sourceRoot = path.resolve(input.environment?.GEMINI_CLI_HOME ?? path.join(userHome, ".gemini"));
        const targetRoot = path.join(home, ".gemini");
        mergeExactRedactionValues(
          exactRedactionValues,
          await linkCredential(instanceRoot, path.join(sourceRoot, "oauth_creds.json"), path.join(targetRoot, "oauth_creds.json"), true),
        );
        mergeExactRedactionValues(
          exactRedactionValues,
          await linkCredential(instanceRoot, path.join(sourceRoot, "google_accounts.json"), path.join(targetRoot, "google_accounts.json"), false),
        );
        return { env: { ...baseEnv, GEMINI_CLI_NO_RELAUNCH: "true" }, exactRedactionValues };
      }
      case "direct_api":
        return { env: baseEnv, exactRedactionValues };
    }
  } catch (error) {
    try {
      await removeProviderRuntimeProfile(input);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Provider runtime profile preparation failed and its partial profile could not be securely removed",
      );
    }
    throw error;
  }
}

async function ensureSecureDirectoryTree(instanceRoot: string, directory: string) {
  const target = path.resolve(directory);
  if (!isWithin(instanceRoot, target)) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  let current = instanceRoot;
  for (const segment of path.relative(instanceRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const observed = await optionalLstat(current);
    if (!observed) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await assertSecureDirectory(instanceRoot, current);
  }
}

async function quarantineAndRemoveDirectory(input: {
  instanceRoot: string;
  source: string;
  executionId: string;
  failureCode: "profile_cleanup_failed" | "quarantine_cleanup_failed";
  phase: "profile_remove" | "quarantine_remove";
}) {
  const parent = path.dirname(input.source);
  await assertSecureAncestors(input.instanceRoot, parent);
  const parentBefore = await assertSecureDirectory(input.instanceRoot, parent);
  const sourceBefore = await optionalLstat(input.source);
  if (!sourceBefore) return false;
  if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink() || await realpath(input.source) !== input.source) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure(input.failureCode, input.phase));
  }
  const quarantine = path.join(parent, `.cleanup-${input.executionId}-${randomBytes(8).toString("hex")}`);
  await rename(input.source, quarantine);
  await fsyncDirectory(parent);
  const [parentAfter, quarantined] = await Promise.all([
    assertSecureDirectory(input.instanceRoot, parent),
    optionalLstat(quarantine),
  ]);
  if (!sameFileIdentity(parentBefore, parentAfter) || !quarantined ||
      !sameFileIdentity(sourceBefore, quarantined) || !quarantined.isDirectory() || quarantined.isSymbolicLink() ||
      await realpath(quarantine) !== quarantine) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure(input.failureCode, input.phase));
  }
  await rm(quarantine, { recursive: true, force: false, maxRetries: 2 });
  await fsyncDirectory(parent);
  return true;
}

export async function removeProviderRuntimeProfile(input: {
  companyId: string;
  executionId: string;
  route: ProviderPolicyRoute;
  instanceRoot: string;
}) {
  if (!SAFE_COMPANY_ID.test(input.companyId) || !SAFE_EXECUTION_ID.test(input.executionId)) {
    throw new Error("Managed provider profile cleanup identity is unsafe");
  }
  assertManagedAdapterType(input.route.runtimeBinding.adapterType);
  const instanceRoot = await resolveSecureInstanceRoot(input.instanceRoot);
  const profileRoot = path.join(
    instanceRoot,
    "companies",
    input.companyId,
    "provider-runtime",
    input.route.runtimeBinding.adapterType,
    input.executionId,
  );
  if (!isWithin(instanceRoot, profileRoot)) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "profile_remove"));
  }
  await quarantineAndRemoveDirectory({
    instanceRoot,
    source: profileRoot,
    executionId: input.executionId,
    failureCode: "profile_cleanup_failed",
    phase: "profile_remove",
  });
}

function createEmptyCleanupCounts(): ProviderRuntimeProfileCleanupCounts {
  return {
    companiesScanned: 0,
    adapterRootsScanned: 0,
    profilesScanned: 0,
    profilesRemoved: 0,
    missingRunProfilesRemoved: 0,
    terminalRunProfilesRemoved: 0,
    activeProfilesPreserved: 0,
    pidOwnedProfilesPreserved: 0,
    quarantinesRemoved: 0,
    freshQuarantinesPreserved: 0,
    externalMetadataEntriesPreserved: 0,
    unsafeEntriesPreserved: 0,
    failures: 0,
  };
}

function isValidRunAuthority(authority: unknown): authority is ProviderRuntimeProfileRunAuthority {
  if (authority === null || typeof authority !== "object" || Array.isArray(authority)) return false;
  const candidate = authority as Partial<ProviderRuntimeProfileRunAuthority>;
  const validStatus = typeof candidate.status === "string" &&
    (ACTIVE_HEARTBEAT_RUN_STATUSES.has(candidate.status) || TERMINAL_HEARTBEAT_RUN_STATUSES.has(candidate.status));
  const validPid = candidate.processPid === null ||
    (Number.isSafeInteger(candidate.processPid) && (candidate.processPid ?? 0) > 0);
  const validProcessGroup = candidate.processGroupId === null ||
    (Number.isSafeInteger(candidate.processGroupId) && (candidate.processGroupId ?? 0) > 0);
  return validStatus && validPid && validProcessGroup;
}

async function writeCleanupReceipt(input: {
  instanceRoot: string;
  startedAt: Date;
  completedAt: Date;
  status: ProviderRuntimeProfileCleanupResult["status"];
  counts: ProviderRuntimeProfileCleanupCounts;
  failures: ProviderRuntimeProfileCleanupFailure[];
}) {
  const receiptDirectory = path.join(
    input.instanceRoot,
    "data",
    "ops",
    "provider-runtime-profile-cleanup",
    "runs",
  );
  try {
    await ensureSecureDirectoryTree(input.instanceRoot, receiptDirectory);
    const filenameTimestamp = input.completedAt.toISOString().replace(/[-:.]/g, "");
    const receiptPath = path.join(receiptDirectory, `${filenameTimestamp}-${randomBytes(8).toString("hex")}.json`);
    const failureCodeCounts = Object.fromEntries(
      input.failures
        .map((failure) => [failure.failureCode, failure.count] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const instanceBasename = path.basename(input.instanceRoot);
    const receipt = {
      schemaVersion: CLEANUP_RECEIPT_SCHEMA_VERSION,
      status: input.status,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      root: {
        instanceId: SAFE_INSTANCE_ID.test(instanceBasename) ? instanceBasename : "unknown",
        instanceRootSha256: createHash("sha256").update(input.instanceRoot).digest("hex"),
      },
      counts: input.counts,
      failureCodeCounts,
      immutable: true,
    };
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const receiptSha256 = createHash("sha256").update(bytes).digest("hex");
    const handle = await open(
      receiptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    );
    const openedIdentity = await (async () => {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o444);
        return handle.stat();
      } finally {
        await handle.close();
      }
    })();
    await fsyncDirectory(receiptDirectory);
    const observed = await lstat(receiptPath);
    if (!observed.isFile() || observed.isSymbolicLink() || !sameFileIdentity(openedIdentity, observed) ||
        observed.size !== bytes.length || (observed.mode & 0o777) !== 0o444) {
      throw new Error("Cleanup receipt failed immutable file verification");
    }
    return { receiptPath, receiptSha256 };
  } catch (error) {
    if (error instanceof ProviderRuntimeProfileCleanupError && error.failure.failureCode === "cleanup_receipt_failed") {
      throw error;
    }
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("cleanup_receipt_failed", "receipt"));
  }
}

export async function sweepProviderRuntimeProfiles(input: {
  instanceRoot: string;
  resolveRunAuthority: (
    companyId: string,
    executionId: string,
  ) => Promise<ProviderRuntimeProfileRunAuthority | null>;
  now?: Date;
  quarantineStaleMs?: number;
  isPidAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (processGroupId: number) => boolean;
}): Promise<ProviderRuntimeProfileCleanupResult> {
  const startedAt = new Date();
  const now = input.now ?? new Date();
  const quarantineStaleMs = input.quarantineStaleMs ?? DEFAULT_CLEANUP_QUARANTINE_STALE_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(quarantineStaleMs) || quarantineStaleMs < 0) {
    throw new ProviderRuntimeProfileCleanupError(cleanupFailure("unsafe_managed_root", "scan"));
  }
  const instanceRoot = await resolveSecureInstanceRoot(input.instanceRoot);
  const counts = createEmptyCleanupCounts();
  const failuresByKey = new Map<string, ProviderRuntimeProfileCleanupFailure>();
  const recordFailure = (
    failureCode: ProviderRuntimeProfileCleanupFailureCode,
    phase: ProviderRuntimeProfileCleanupFailure["phase"],
  ) => {
    const key = `${failureCode}:${phase}`;
    const existing = failuresByKey.get(key);
    if (existing) existing.count += 1;
    else failuresByKey.set(key, cleanupFailure(failureCode, phase));
    counts.failures += 1;
  };
  const recordUnsafeEntry = () => {
    counts.unsafeEntriesPreserved += 1;
    recordFailure("unsafe_managed_entry", "scan");
  };
  const handleExternalMetadataEntry = async (parent: string, basename: string) => {
    const disposition = await classifyProviderRuntimeExternalMetadata(instanceRoot, parent, basename);
    if (disposition === "not_candidate") return false;
    if (disposition === "preserved") counts.externalMetadataEntriesPreserved += 1;
    else if (disposition === "unsafe") recordUnsafeEntry();
    return true;
  };
  const pidIsAlive = input.isPidAlive ?? isPidAlive;
  const processGroupIsAlive = input.isProcessGroupAlive ?? isProcessGroupAlive;
  const companiesRoot = path.join(instanceRoot, "companies");
  const companiesRootStat = await optionalLstat(companiesRoot);

  if (companiesRootStat) {
    let companyEntries: Awaited<ReturnType<typeof readDirectoryNoFollow>> = [];
    try {
      if (!companiesRootStat.isDirectory() || companiesRootStat.isSymbolicLink()) throw new Error("unsafe");
      companyEntries = await readDirectoryNoFollow(instanceRoot, companiesRoot);
    } catch {
      recordUnsafeEntry();
    }
    for (const companyEntry of companyEntries) {
      if (await handleExternalMetadataEntry(companiesRoot, companyEntry.name)) continue;
      if (!SAFE_COMPANY_ID.test(companyEntry.name)) {
        recordUnsafeEntry();
        continue;
      }
      const companyRoot = path.join(companiesRoot, companyEntry.name);
      try {
        await assertSecureDirectory(instanceRoot, companyRoot);
      } catch {
        recordUnsafeEntry();
        continue;
      }
      counts.companiesScanned += 1;
      const providerRoot = path.join(companyRoot, "provider-runtime");
      const providerRootStat = await optionalLstat(providerRoot);
      if (!providerRootStat) continue;
      let adapterEntries: Awaited<ReturnType<typeof readDirectoryNoFollow>> = [];
      try {
        if (!providerRootStat.isDirectory() || providerRootStat.isSymbolicLink()) throw new Error("unsafe");
        adapterEntries = await readDirectoryNoFollow(instanceRoot, providerRoot);
      } catch {
        recordUnsafeEntry();
        continue;
      }
      for (const adapterEntry of adapterEntries) {
        if (await handleExternalMetadataEntry(providerRoot, adapterEntry.name)) continue;
        if (!MANAGED_ADAPTER_TYPES.has(adapterEntry.name as ProviderPolicyRoute["runtimeBinding"]["adapterType"])) {
          recordUnsafeEntry();
          continue;
        }
        const adapterRoot = path.join(providerRoot, adapterEntry.name);
        let profileEntries: Awaited<ReturnType<typeof readDirectoryNoFollow>>;
        try {
          await assertSecureDirectory(instanceRoot, adapterRoot);
          profileEntries = await readDirectoryNoFollow(instanceRoot, adapterRoot);
        } catch {
          recordUnsafeEntry();
          continue;
        }
        counts.adapterRootsScanned += 1;
        for (const profileEntry of profileEntries) {
          if (await handleExternalMetadataEntry(adapterRoot, profileEntry.name)) continue;
          const profilePath = path.join(adapterRoot, profileEntry.name);
          const cleanupMatch = CLEANUP_QUARANTINE_RE.exec(profileEntry.name);
          if (cleanupMatch) {
            const executionId = cleanupMatch[1]!;
            let observed;
            try {
              observed = await assertSecureDirectory(instanceRoot, profilePath);
            } catch {
              recordUnsafeEntry();
              continue;
            }
            if (now.getTime() - observed.mtimeMs < quarantineStaleMs) {
              counts.freshQuarantinesPreserved += 1;
              continue;
            }
            try {
              if (await quarantineAndRemoveDirectory({
                instanceRoot,
                source: profilePath,
                executionId,
                failureCode: "quarantine_cleanup_failed",
                phase: "quarantine_remove",
              })) counts.quarantinesRemoved += 1;
            } catch {
              recordFailure("quarantine_cleanup_failed", "quarantine_remove");
            }
            continue;
          }
          if (!SAFE_EXECUTION_ID.test(profileEntry.name)) {
            recordUnsafeEntry();
            continue;
          }
          try {
            await assertSecureDirectory(instanceRoot, profilePath);
          } catch {
            recordUnsafeEntry();
            continue;
          }
          counts.profilesScanned += 1;
          let authority: ProviderRuntimeProfileRunAuthority | null;
          try {
            authority = await input.resolveRunAuthority(companyEntry.name, profileEntry.name);
          } catch {
            recordFailure("run_authority_lookup_failed", "run_authority");
            continue;
          }
          let removalReason: "missing" | "terminal";
          if (authority === null) {
            removalReason = "missing";
          } else {
            if (!isValidRunAuthority(authority)) {
              recordFailure("run_authority_invalid", "run_authority");
              continue;
            }
            if (ACTIVE_HEARTBEAT_RUN_STATUSES.has(authority.status)) {
              counts.activeProfilesPreserved += 1;
              continue;
            }
            try {
              const pidOwned = authority.processPid !== null && pidIsAlive(authority.processPid);
              const processGroupOwned = authority.processGroupId !== null && processGroupIsAlive(authority.processGroupId);
              if (pidOwned || processGroupOwned) {
                counts.pidOwnedProfilesPreserved += 1;
                continue;
              }
            } catch {
              recordFailure("process_owner_check_failed", "process_owner");
              continue;
            }
            removalReason = "terminal";
          }
          try {
            if (await quarantineAndRemoveDirectory({
              instanceRoot,
              source: profilePath,
              executionId: profileEntry.name,
              failureCode: "profile_cleanup_failed",
              phase: "profile_remove",
            })) {
              counts.profilesRemoved += 1;
              if (removalReason === "missing") counts.missingRunProfilesRemoved += 1;
              else counts.terminalRunProfilesRemoved += 1;
            }
          } catch {
            recordFailure("profile_cleanup_failed", "profile_remove");
          }
        }
      }
    }
  }

  const failures = [...failuresByKey.values()];
  const removed = counts.profilesRemoved + counts.quarantinesRemoved;
  const status: ProviderRuntimeProfileCleanupResult["status"] = failures.length > 0
    ? "partial_failure"
    : removed > 0
      ? "cleaned"
      : "clean";
  const completedAt = new Date();
  const receipt = await writeCleanupReceipt({
    instanceRoot,
    startedAt,
    completedAt,
    status,
    counts,
    failures,
  });
  return {
    schemaVersion: CLEANUP_RECEIPT_SCHEMA_VERSION,
    status,
    counts,
    failures,
    ...receipt,
  };
}

export type ProviderRuntimeProfileStartupRecoveryResult =
  | {
      status: "ready";
      cleanup: ProviderRuntimeProfileCleanupResult;
    }
  | {
      status: "blocked";
      cleanup: ProviderRuntimeProfileCleanupResult;
      failure: ProviderRuntimeProfileCleanupFailure;
    };

export async function runProviderRuntimeProfileStartupRecovery(input: {
  reapOrphanedRuns: () => Promise<unknown>;
  sweepProviderRuntimeProfiles: () => Promise<ProviderRuntimeProfileCleanupResult>;
  resumeQueuedRuns: () => Promise<unknown>;
}): Promise<ProviderRuntimeProfileStartupRecoveryResult> {
  await input.reapOrphanedRuns();
  const cleanup = await input.sweepProviderRuntimeProfiles();
  if (cleanup.status === "partial_failure") {
    return {
      status: "blocked",
      cleanup,
      failure: cleanup.failures[0] ?? cleanupFailure("unsafe_managed_entry", "scan"),
    };
  }
  await input.resumeQueuedRuns();
  return { status: "ready", cleanup };
}
