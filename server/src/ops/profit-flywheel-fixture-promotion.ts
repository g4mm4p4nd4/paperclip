import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  companySecrets,
  companySecretVersions,
  createDb,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { sanitizeSecretText } from "../redaction.js";
import {
  resolveLocalEncryptedVersionFromKey,
} from "../secrets/local-encrypted-provider.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { createRunScopedPaperclipApiBroker } from "../services/run-scoped-paperclip-api-broker.js";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  requireTrustedDirectory,
} from "./trusted-receipt-directory.js";

const SCHEMA_VERSION = "paperclip.profit_flywheel_fixture_promotion.v1";
const API_SECRET_NAME = "PAPERCLIP_API_KEY";
const DEFAULT_PAPERCLIP_API_URL = "http://127.0.0.1:3100";
const SUPPORTED_CANARY_RECEIPT_SCHEMAS = new Set([
  "pos.profit_flywheel_canary.v2",
  "pos.profit_flywheel_canary.v3",
]);
const DEFAULT_WAIT_SECONDS = 120;
const DEFAULT_POLL_SECONDS = 2;
const CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CHILD_SHUTDOWN_GRACE_MS = 2_000;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

export type FixturePromotionBlocker = {
  blocker_code: string;
  blocker_detail: string;
  next_owner: string;
  resume_condition: string;
};

export class FixturePromotionError extends Error {
  constructor(readonly blocker: FixturePromotionBlocker) {
    super(`${blocker.blocker_code}: ${blocker.blocker_detail}`);
    this.name = "FixturePromotionError";
  }
}

export type ResolvedProfitCanaryCredential = {
  value: string;
  binding: {
    secret_id: string;
    version: number;
    value_sha256: string;
    provider: "local_encrypted";
  };
};

export type ProfitCanaryChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  spawnErrorCode: string | null;
};

export type SecureProfitCanaryPromotionOptions = {
  companyId: string;
  portfolioOsRoot: string;
  canaryReceiptPath: string;
  outboxDir: string;
  promotionReceiptDir: string;
  aggregateReceiptDir: string;
  paperclipApiUrl?: string;
  waitSeconds?: number;
  pollSeconds?: number;
};

type RunScopedBroker = Awaited<ReturnType<typeof createRunScopedPaperclipApiBroker>>;

export type SecureProfitCanaryPromotionDependencies = {
  resolveCredential?: (db: Db, companyId: string) => Promise<ResolvedProfitCanaryCredential>;
  createBroker?: typeof createRunScopedPaperclipApiBroker;
  runChild?: (input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<ProfitCanaryChildResult>;
  verifyPersistedWorkflow?: (
    db: Db,
    input: PersistedProfitCanaryWorkflowBinding,
  ) => Promise<PersistedProfitCanaryWorkflowBinding>;
  now?: () => Date;
  randomId?: () => string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type PersistedProfitCanaryWorkflowBinding = {
  id: string;
  companyId: string;
  projectId: string;
  runId: string;
  correlationId: string;
  sourceDispatchPath: string;
  sourceDispatchHash: string;
  targetRepo: string;
  targetWorkspaceRoot: string;
};

function promotionError(
  blockerCode: string,
  blockerDetail: string,
  nextOwner: string,
  resumeCondition: string,
): FixturePromotionError {
  return new FixturePromotionError({
    blocker_code: blockerCode,
    blocker_detail: blockerDetail,
    next_owner: nextOwner,
    resume_condition: resumeCondition,
  });
}

function sha256Bytes(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(normalized)) {
    throw promotionError(
      `profit_canary_${label}_invalid`,
      `${label} must be a canonical UUID`,
      "paperclip_board_operator",
      `Supply the canonical ${label} and replay the same canary identity`,
    );
  }
  return normalized;
}

function canonicalObservedWorkflowId(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(candidate)) {
    throw promotionError(
      "profit_canary_workflow_id_invalid",
      "The observed Paperclip workflow id is not a canonical UUID",
      "paperclip_control_plane_owner",
      "Repair workflow observation identity, then replay the same immutable canary",
    );
  }
  return candidate;
}

function safeRunId(value: unknown) {
  const runId = typeof value === "string" ? value.trim() : "";
  if (!SAFE_RUN_ID.test(runId) || runId.includes("..")) {
    throw promotionError(
      "profit_canary_run_id_invalid",
      "The canary receipt run_id is not a bounded traversal-free component",
      "portfolio_os_canary_owner",
      "Regenerate the fixture with a safe run_id and replay promotion",
    );
  }
  return runId;
}

function boundedDuration(value: number, label: "wait_seconds" | "poll_seconds") {
  const minimum = label === "wait_seconds" ? 0 : 0.05;
  const maximum = label === "wait_seconds" ? 900 : 60;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw promotionError(
      `profit_canary_${label}_invalid`,
      `${label} must be finite and between ${minimum} and ${maximum}`,
      "paperclip_board_operator",
      `Supply a bounded ${label} value and replay promotion`,
    );
  }
  return value;
}

function assertLexicallySafeAbsolutePath(value: string, label: string) {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw promotionError(
      `profit_canary_${label}_unsafe`,
      `${label} must be an absolute normalized path without control characters`,
      "paperclip_board_operator",
      `Supply a normalized absolute ${label} and replay promotion`,
    );
  }
}

async function requireSafeDirectory(value: string, label: string) {
  try {
    return await requireTrustedDirectory(value, `profit_canary_${label}`);
  } catch {
    throw promotionError(
      `profit_canary_${label}_unsafe`,
      `${label} must have a canonical current-owner-controlled non-writable hierarchy`,
      "paperclip_board_operator",
      `Repair ownership, permissions, and canonical path for ${label}, then replay promotion`,
    );
  }
}

async function readSafeFile(
  value: string,
  label: string,
  options: { immutable?: boolean; maxBytes?: number } = {},
) {
  try {
    return await readTrustedFile(value, `profit_canary_${label}`, {
      maxBytes: options.maxBytes ?? 20 * 1024 * 1024,
      requireReadOnly: options.immutable ?? false,
      requireCurrentOwner: true,
    });
  } catch {
    throw promotionError(
      `profit_canary_${label}_unsafe`,
      `${label} must be one bounded current-owner file in a trusted canonical hierarchy`,
      "portfolio_os_canary_owner",
      `Restore the exact trusted ${label} bytes and replay promotion`,
    );
  }
}

function validateLoopbackApiUrl(rawValue: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw promotionError(
      "profit_canary_api_origin_invalid",
      "Paperclip API origin is not a valid URL",
      "paperclip_board_operator",
      "Use the loopback Paperclip origin http://127.0.0.1:<port> and replay promotion",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !Number.isInteger(Number(parsed.port || "80")) ||
    Number(parsed.port || "80") < 1 ||
    Number(parsed.port || "80") > 65_535
  ) {
    throw promotionError(
      "profit_canary_api_origin_not_loopback",
      "Paperclip API origin must be credential-free HTTP on 127.0.0.1 with no path/query/fragment",
      "paperclip_board_operator",
      "Use the loopback Paperclip origin http://127.0.0.1:<port> and replay promotion",
    );
  }
  return parsed.origin;
}

/**
 * Exact network surface used by Portfolio OS `promote_profit_canary`: its
 * project preflight and correlation-bound workflow observation are the only
 * HTTP requests in `pos.profit_canary run-live`. Publishing itself is the
 * immutable outbox file write passed separately on argv.
 */
export function profitCanaryBrokerAllowedRequests(input: {
  companyId: string;
  projectId: string;
  runId: string;
}) {
  return [
    { method: "GET" as const, pathname: `/api/projects/${input.projectId}`, search: "" },
    {
      method: "GET" as const,
      pathname: `/api/companies/${input.companyId}/profit-flywheel/workflows`,
      search: `?correlation_id=profit-canary%3A${input.runId}&limit=10`,
    },
  ];
}

export async function verifyPersistedProfitCanaryWorkflow(
  db: Db,
  input: PersistedProfitCanaryWorkflowBinding,
): Promise<PersistedProfitCanaryWorkflowBinding> {
  let rows: PersistedProfitCanaryWorkflowBinding[];
  try {
    rows = await db
      .select({
        id: profitFlywheelWorkflows.id,
        companyId: profitFlywheelWorkflows.companyId,
        projectId: profitFlywheelWorkflows.projectId,
        runId: profitFlywheelWorkflows.runId,
        correlationId: profitFlywheelWorkflows.correlationId,
        sourceDispatchPath: profitFlywheelWorkflows.sourceDispatchPath,
        sourceDispatchHash: profitFlywheelWorkflows.sourceDispatchHash,
        targetRepo: profitFlywheelWorkflows.targetRepo,
        targetWorkspaceRoot: profitFlywheelWorkflows.targetWorkspaceRoot,
      })
      .from(profitFlywheelWorkflows)
      .where(and(
        eq(profitFlywheelWorkflows.id, input.id),
        eq(profitFlywheelWorkflows.companyId, input.companyId),
        eq(profitFlywheelWorkflows.projectId, input.projectId),
        eq(profitFlywheelWorkflows.runId, input.runId),
        eq(profitFlywheelWorkflows.correlationId, input.correlationId),
        eq(profitFlywheelWorkflows.sourceDispatchPath, input.sourceDispatchPath),
        eq(profitFlywheelWorkflows.sourceDispatchHash, input.sourceDispatchHash),
        eq(profitFlywheelWorkflows.targetRepo, input.targetRepo),
        eq(profitFlywheelWorkflows.targetWorkspaceRoot, input.targetWorkspaceRoot),
      ));
  } catch {
    throw promotionError(
      "profit_canary_workflow_db_verification_failed",
      "The operator could not independently verify the observed workflow in Paperclip storage",
      "paperclip_control_plane_owner",
      "Repair database access, then replay the same immutable canary identity",
    );
  }
  if (rows.length !== 1) {
    throw promotionError(
      "profit_canary_workflow_db_binding_missing",
      "Paperclip storage does not contain exactly one workflow matching the attested UUID/company/project/run/correlation/source artifact",
      "paperclip_control_plane_owner",
      "Repair dispatch ingestion or workflow identity, then replay the same immutable canary identity",
    );
  }
  return rows[0]!;
}

async function resolveProvisionedProfitCanaryApiKeyWithResolver(
  db: Db,
  companyIdValue: string,
  resolveMaterial: (
    material: Record<string, unknown>,
    externalRef: string | null,
  ) => Promise<string> | string,
): Promise<ResolvedProfitCanaryCredential> {
  const companyId = canonicalUuid(companyIdValue, "company_id");
  const secret = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, API_SECRET_NAME)))
    .then((rows) => rows[0] ?? null);
  if (!secret) {
    throw promotionError(
      "profit_canary_api_key_missing",
      `The provisioned ${API_SECRET_NAME} company secret is missing`,
      "paperclip_board_operator",
      "Run the Profit Flywheel runtime provisioning apply for this company, then replay promotion",
    );
  }
  if (secret.provider !== "local_encrypted") {
    throw promotionError(
      "profit_canary_api_key_provider_invalid",
      `The provisioned ${API_SECRET_NAME} must use local_encrypted`,
      "paperclip_security_owner",
      "Re-provision the company runtime secret with local_encrypted, then replay promotion",
    );
  }
  const version = await db
    .select()
    .from(companySecretVersions)
    .where(and(
      eq(companySecretVersions.secretId, secret.id),
      eq(companySecretVersions.version, secret.latestVersion),
      isNull(companySecretVersions.revokedAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (!version || !SAFE_SHA256.test(version.valueSha256)) {
    throw promotionError(
      "profit_canary_api_key_inactive",
      `The latest ${API_SECRET_NAME} version is missing, revoked, or lacks a valid value fingerprint`,
      "paperclip_security_owner",
      "Rotate or re-provision the active company API secret, then replay promotion",
    );
  }
  let value: string;
  try {
    value = await resolveMaterial(version.material, secret.externalRef);
  } catch {
    throw promotionError(
      "profit_canary_api_key_decryption_failed",
      `The active ${API_SECRET_NAME} could not be resolved through local_encrypted`,
      "paperclip_security_owner",
      "Restore the instance secret master key or rotate the company API secret, then replay promotion",
    );
  }
  if (
    !value ||
    value.length > 4_096 ||
    /[\r\n\0]/.test(value) ||
    sha256Bytes(value) !== version.valueSha256
  ) {
    throw promotionError(
      "profit_canary_api_key_integrity_failed",
      `The resolved ${API_SECRET_NAME} failed its stored fingerprint or bounded-token contract`,
      "paperclip_security_owner",
      "Rotate or re-provision the company API secret, then replay promotion",
    );
  }
  return {
    value,
    binding: {
      secret_id: secret.id,
      version: version.version,
      value_sha256: version.valueSha256,
      provider: "local_encrypted",
    },
  };
}

export async function resolveProvisionedProfitCanaryApiKey(
  db: Db,
  companyIdValue: string,
) {
  return resolveProvisionedProfitCanaryApiKeyWithResolver(
    db,
    companyIdValue,
    (material, externalRef) => getSecretProvider("local_encrypted").resolveVersion({
      material,
      externalRef,
    }),
  );
}

function decodeLocalMasterKey(raw: string) {
  const trimmed = raw.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export async function requireExistingConfiguredMasterKey(configuredPath: string) {
  assertLexicallySafeAbsolutePath(configuredPath, "secrets_master_key_file");
  let metadata;
  try {
    metadata = await lstat(configuredPath);
  } catch {
    throw promotionError(
      "profit_canary_master_key_missing",
      "The configured local-encrypted master key file does not exist; the operator will not create it",
      "paperclip_security_owner",
      "Restore the configured instance master key file with owner-only permissions, then replay promotion",
    );
  }
  const permissions = metadata.mode & 0o777;
  const wrongOwner = typeof process.geteuid === "function" && metadata.uid !== process.geteuid();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    wrongOwner ||
    (permissions & 0o077) !== 0 ||
    (permissions & 0o400) === 0 ||
    (permissions & 0o111) !== 0 ||
    metadata.size < 1 ||
    metadata.size > 1_024
  ) {
    throw promotionError(
      "profit_canary_master_key_permissions_unsafe",
      "The configured local-encrypted master key must be an owner-read, owner-only, non-executable regular file",
      "paperclip_security_owner",
      "Repair master-key ownership and mode to 0400 or 0600, then replay promotion",
    );
  }
  const keyPath = await realpath(configuredPath);
  if (keyPath !== configuredPath) {
    throw promotionError(
      "profit_canary_master_key_permissions_unsafe",
      "The configured local-encrypted master key path traverses a symlink",
      "paperclip_security_owner",
      "Use the canonical owner-controlled master-key path, then replay promotion",
    );
  }
  const handle = await open(
    configuredPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) {
    throw promotionError(
      "profit_canary_master_key_unreadable",
      "The configured local-encrypted master key could not be opened without following links",
      "paperclip_security_owner",
      "Restore the canonical owner-controlled master key, then replay promotion",
    );
  }
  let raw: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino ||
        opened.uid !== metadata.uid || opened.mode !== metadata.mode || opened.size !== metadata.size ||
        opened.mtimeMs !== metadata.mtimeMs) {
      throw new Error("master_key_identity_changed");
    }
    raw = await handle.readFile("utf8");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(configuredPath)]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() ||
        afterHandle.dev !== metadata.dev || afterHandle.ino !== metadata.ino ||
        afterPath.dev !== metadata.dev || afterPath.ino !== metadata.ino ||
        afterHandle.uid !== metadata.uid || afterPath.uid !== metadata.uid ||
        afterHandle.mode !== metadata.mode || afterPath.mode !== metadata.mode ||
        afterHandle.size !== metadata.size || afterPath.size !== metadata.size ||
        afterHandle.mtimeMs !== metadata.mtimeMs || afterPath.mtimeMs !== metadata.mtimeMs) {
      throw new Error("master_key_changed_during_read");
    }
  } catch {
    throw promotionError(
      "profit_canary_master_key_unreadable",
      "The configured local-encrypted master key changed or could not be read safely",
      "paperclip_security_owner",
      "Restore owner read access to the configured master key, then replay promotion",
    );
  } finally {
    await handle.close();
  }
  const key = decodeLocalMasterKey(raw);
  if (!key) {
    throw promotionError(
      "profit_canary_master_key_invalid",
      "The configured local-encrypted master key is not valid 32-byte key material",
      "paperclip_security_owner",
      "Restore the exact instance master key; do not generate a replacement for existing ciphertext",
    );
  }
  return key;
}

export async function resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey(
  db: Db,
  companyId: string,
  configuredKeyPath: string,
  dependencies: { afterMasterKeyRead?: () => Promise<void> } = {},
) {
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim()) {
    throw promotionError(
      "profit_canary_inline_master_key_forbidden",
      "This operator requires the configured master-key file and will not use inline master-key material",
      "paperclip_security_owner",
      "Remove PAPERCLIP_SECRETS_MASTER_KEY and restore the configured key file, then replay promotion",
    );
  }
  const masterKey = await requireExistingConfiguredMasterKey(configuredKeyPath);
  try {
    await dependencies.afterMasterKeyRead?.();
    return await resolveProvisionedProfitCanaryApiKeyWithResolver(
      db,
      companyId,
      (material) => resolveLocalEncryptedVersionFromKey(masterKey, material),
    );
  } finally {
    masterKey.fill(0);
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }) {
  const remaining = CHILD_OUTPUT_LIMIT_BYTES - state.bytes;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  state.bytes += chunk.length;
  return state.bytes > CHILD_OUTPUT_LIMIT_BYTES;
}

export async function spawnProfitCanaryChild(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProfitCanaryChildResult> {
  if (input.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
      outputLimitExceeded: false,
      spawnErrorCode: null,
    };
  }
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let spawnErrorCode: string | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: ownsProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const signalProcessTree = (signal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, signal);
        else if (signal !== 0) child.kill(signal);
        else process.kill(child.pid, 0);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code !== "ESRCH";
      }
    };
    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalProcessTree("SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          signalProcessTree("SIGKILL");
        }, CHILD_SHUTDOWN_GRACE_MS);
        forceKillTimer.unref();
      }
    };
    const ensureProcessGroupStopped = async () => {
      if (!ownsProcessGroup || !signalProcessTree(0)) return;
      signalProcessTree("SIGTERM");
      const deadline = Date.now() + CHILD_SHUTDOWN_GRACE_MS;
      while (Date.now() < deadline) {
        await new Promise((wake) => setTimeout(wake, 25));
        if (!signalProcessTree(0)) return;
      }
      signalProcessTree("SIGKILL");
      for (let attempt = 0; attempt < 20 && signalProcessTree(0); attempt += 1) {
        await new Promise((wake) => setTimeout(wake, 25));
      }
    };
    const abortListener = () => {
      aborted = true;
      stopChild();
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, input.timeoutMs);
    timeout.unref();
    child.stdout.on("data", (raw: Buffer) => {
      if (appendBounded(stdoutChunks, Buffer.from(raw), stdoutState)) {
        outputLimitExceeded = true;
        stopChild();
      }
    });
    child.stderr.on("data", (raw: Buffer) => {
      if (appendBounded(stderrChunks, Buffer.from(raw), stderrState)) {
        outputLimitExceeded = true;
        stopChild();
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? "spawn_error";
    });
    child.once("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", abortListener);
      await ensureProcessGroupStopped();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        aborted,
        outputLimitExceeded,
        spawnErrorCode,
      });
    });
  });
}

function childEnvironment(
  broker: RunScopedBroker,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH ?? "/usr/bin:/bin",
    LANG: environment.LANG ?? "C.UTF-8",
    ...(environment.LC_ALL ? { LC_ALL: environment.LC_ALL } : {}),
    PYTHONDONTWRITEBYTECODE: "1",
    PAPERCLIP_API_URL: broker.url,
    PAPERCLIP_API_KEY: broker.childAuthToken,
  };
}

function parseChildOutput(stdout: string) {
  const allowed = new Set([
    "canary_status",
    "published_dispatch",
    "promotion_receipt",
    "observation_receipt",
    "workflow_id",
  ]);
  const parsed: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 1) : "";
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(parsed, key) || /[\r\n\0]/.test(value)) {
      throw promotionError(
        "profit_canary_child_output_invalid",
        "Portfolio OS returned an unknown, duplicate, or unsafe result field",
        "portfolio_os_canary_owner",
        "Repair the run-live machine output contract and replay the same canary identity",
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

async function artifactBinding(value: string, expectedPath: string, label: string) {
  if (value !== expectedPath) {
    throw promotionError(
      `profit_canary_${label}_path_mismatch`,
      `${label} did not match the operator-confined path`,
      "portfolio_os_canary_owner",
      "Repair the run-live result binding and replay the same canary identity",
    );
  }
  const artifact = await readSafeFile(value, label, { immutable: true });
  if (artifact.path !== expectedPath) {
    throw promotionError(
      `profit_canary_${label}_realpath_mismatch`,
      `${label} resolved outside its operator-confined path`,
      "paperclip_security_owner",
      "Remove the path indirection and replay the same canary identity",
    );
  }
  return { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes };
}

function sanitizeDiagnostic(value: string, exactValues: string[]) {
  let sanitized = value;
  for (const exact of exactValues) {
    if (exact) sanitized = sanitized.split(exact).join("***REDACTED***");
  }
  sanitized = sanitizeSecretText(sanitized)
    .replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^@\s/]+:[^@\s]+@/gi, "$1***REDACTED***@")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= 512) return sanitized;
  // Python tracebacks put the actionable exception at the end. Preserve both
  // origin and terminal cause while keeping the immutable blocker bounded.
  return `${sanitized.slice(0, 240)} ... ${sanitized.slice(-267)}`;
}

function timestamp(value: Date) {
  return value.toISOString().replace(/[-:.]/g, "");
}

function blockerForUnexpected(error: unknown, exactValues: string[]) {
  if (error instanceof FixturePromotionError) return error.blocker;
  void exactValues;
  return {
    blocker_code: "profit_canary_operator_internal_error",
    blocker_detail: "The secure fixture-promotion operator failed before a terminal result could be safely attested",
    next_owner: "paperclip_engineering_owner",
    resume_condition: "Repair the operator failure, then replay the same immutable canary identity",
  } satisfies FixturePromotionBlocker;
}

export async function runSecureProfitCanaryPromotion(
  db: Db,
  options: SecureProfitCanaryPromotionOptions,
  dependencies: SecureProfitCanaryPromotionDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? randomUUID;
  const startedAt = now();
  const aggregateReceiptDir = await prepareTrustedReceiptDirectory(
    options.aggregateReceiptDir,
    "profit_canary_aggregate_receipt_dir",
  );
  const operatorRunId = randomId();
  if (!SAFE_RUN_ID.test(operatorRunId) || operatorRunId.includes("..")) {
    throw new Error("profit_canary_operator_run_id_generator_invalid");
  }
  let runId: string | null = null;
  let projectId: string | null = null;
  let inputBinding: { path: string; sha256: string } | null = null;
  let sourceDispatchBinding: { path: string; sha256: string } | null = null;
  let sourceDispatchBytes: Buffer | null = null;
  let credentialBinding: ResolvedProfitCanaryCredential["binding"] | null = null;
  let broker: RunScopedBroker | null = null;
  let childResult: ProfitCanaryChildResult | null = null;
  let result: Record<string, unknown> | null = null;
  let blocker: FixturePromotionBlocker | null = null;
  const exactRedactionValues: string[] = [];
  let canonicalInputs: {
    companyId: string;
    portfolioOsRoot: string;
    outboxDir: string;
    promotionReceiptDir: string;
    paperclipApiUrl: string;
    targetWorkspace: string;
    targetOrigin: string;
    waitSeconds: number;
    pollSeconds: number;
  } | null = null;

  try {
    const companyId = canonicalUuid(options.companyId, "company_id");
    const waitSeconds = boundedDuration(options.waitSeconds ?? DEFAULT_WAIT_SECONDS, "wait_seconds");
    const pollSeconds = boundedDuration(options.pollSeconds ?? DEFAULT_POLL_SECONDS, "poll_seconds");
    const paperclipApiUrl = validateLoopbackApiUrl(options.paperclipApiUrl ?? DEFAULT_PAPERCLIP_API_URL);
    const portfolioOsRoot = await requireSafeDirectory(options.portfolioOsRoot, "portfolio_os_root");
    await readSafeFile(path.join(portfolioOsRoot, "pos", "profit_canary.py"), "profit_canary_module", {
      maxBytes: 4 * 1024 * 1024,
    });
    const canaryReceipt = await readSafeFile(options.canaryReceiptPath, "canary_receipt", {
      immutable: true,
      maxBytes: 4 * 1024 * 1024,
    });
    const canaryReceiptPath = canaryReceipt.path;
    const outboxDir = await requireSafeDirectory(options.outboxDir, "outbox_dir");
    const promotionReceiptDir = await requireSafeDirectory(options.promotionReceiptDir, "promotion_receipt_dir");
    const receiptBytes = canaryReceipt.bytes;
    inputBinding = { path: canaryReceiptPath, sha256: canaryReceipt.sha256 };
    let canary: Record<string, unknown>;
    try {
      canary = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw promotionError(
        "profit_canary_receipt_invalid_json",
        "The immutable canary receipt is not valid JSON",
        "portfolio_os_canary_owner",
        "Regenerate and validate the fixture receipt, then replay promotion",
      );
    }
    if (
      typeof canary.schema_version !== "string" ||
      !SUPPORTED_CANARY_RECEIPT_SCHEMAS.has(canary.schema_version) ||
      canary.state !== "dispatch_ready" ||
      canary.mode !== "offline_fixture_only" ||
      canary.immutable !== true ||
      canary.e2e_proof !== false ||
      canary.execution_authority !== "paperclip_control_plane" ||
      canary.target_repo !== "fixture/profit-canary"
    ) {
      throw promotionError(
        "profit_canary_receipt_contract_invalid",
        "The canary receipt is not a supported immutable dispatch-ready offline fixture receipt with Paperclip execution authority and no fabricated E2E proof",
        "portfolio_os_canary_owner",
        "Regenerate and validate the current fixture receipt, then replay promotion",
      );
    }
    runId = safeRunId(canary.run_id);
    const paperclip = asRecord(canary.paperclip) ?? {};
    const receiptCompanyId = canonicalUuid(String(paperclip.company_id ?? ""), "receipt_company_id");
    projectId = canonicalUuid(String(paperclip.project_id ?? ""), "project_id");
    if (receiptCompanyId !== companyId) {
      throw promotionError(
        "profit_canary_company_binding_mismatch",
        "The operator company_id differs from the immutable canary receipt company",
        "paperclip_board_operator",
        "Use the receipt-bound company_id or generate a new correctly bound fixture",
      );
    }
    const expectedRunRoot = path.join(portfolioOsRoot, "data", "canary_runs", runId);
    const expectedTargetWorkspace = path.join(expectedRunRoot, "target", "profit-canary");
    const expectedTargetOrigin = path.join(expectedRunRoot, "target", "origin.git");
    const targetWorkspace = await requireSafeDirectory(String(canary.target_workspace ?? ""), "target_workspace");
    const targetOrigin = await requireSafeDirectory(String(canary.target_origin ?? ""), "target_origin");
    if (targetWorkspace !== expectedTargetWorkspace || targetOrigin !== expectedTargetOrigin) {
      throw promotionError(
        "profit_canary_fixture_target_outside_canonical_run",
        "The canary target workspace/origin is not the built-in local fixture under this Portfolio OS run",
        "portfolio_os_canary_owner",
        "Generate the canary under <portfolio-os>/data/canary_runs with the same run_id, then replay promotion",
      );
    }
    const correlationId = `profit-canary:${runId}`;
    if (canary.correlation_id !== correlationId) {
      throw promotionError(
        "profit_canary_correlation_binding_mismatch",
        "The immutable canary receipt correlation_id is not bound to its run_id",
        "portfolio_os_canary_owner",
        "Regenerate and validate the fixture receipt, then replay promotion",
      );
    }
    const dispatchArtifact = asRecord(asRecord(canary.artifacts)?.dispatch);
    const sourcePathValue = typeof dispatchArtifact?.path === "string" ? dispatchArtifact.path : "";
    const sourceShaValue = typeof dispatchArtifact?.sha256 === "string" ? dispatchArtifact.sha256 : "";
    if (!SAFE_SHA256.test(sourceShaValue)) {
      throw promotionError(
        "profit_canary_source_dispatch_binding_invalid",
        "The canary source dispatch binding lacks a lowercase SHA-256",
        "portfolio_os_canary_owner",
        "Regenerate and validate the fixture receipt, then replay promotion",
      );
    }
    const sourceArtifact = await readSafeFile(sourcePathValue, "source_dispatch", {
      immutable: true,
      maxBytes: 20 * 1024 * 1024,
    });
    const sourcePath = sourceArtifact.path;
    if (sourcePath !== sourcePathValue) {
      throw promotionError(
        "profit_canary_source_dispatch_realpath_mismatch",
        "The canary source dispatch path is not canonical",
        "portfolio_os_canary_owner",
        "Regenerate the fixture with a canonical source dispatch path, then replay promotion",
      );
    }
    sourceDispatchBytes = sourceArtifact.bytes;
    const sourceSha256 = sourceArtifact.sha256;
    if (sourceSha256 !== sourceShaValue) {
      throw promotionError(
        "profit_canary_source_dispatch_hash_mismatch",
        "The immutable source dispatch bytes differ from the canary receipt SHA-256",
        "portfolio_os_canary_owner",
        "Restore or regenerate the exact immutable source dispatch, then replay promotion",
      );
    }
    let sourceDispatch: Record<string, unknown>;
    try {
      sourceDispatch = JSON.parse(sourceDispatchBytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw promotionError(
        "profit_canary_source_dispatch_invalid_json",
        "The immutable source dispatch is not valid JSON",
        "portfolio_os_canary_owner",
        "Regenerate and validate the source dispatch, then replay promotion",
      );
    }
    const sourcePaperclip = asRecord(sourceDispatch.paperclip) ?? {};
    const sourceExecutionTarget = asRecord(asRecord(sourceDispatch.execution_manifest)?.repo_target);
    if (
      sourceDispatch.run_id !== runId ||
      sourceDispatch.correlation_id !== correlationId ||
      sourceDispatch.schema_version !== "pos.dispatch.v2" ||
      sourcePaperclip.company_id !== companyId ||
      sourcePaperclip.project_id !== projectId ||
      sourceDispatch.target_repo_full_name !== "fixture/profit-canary" ||
      sourceDispatch.target_repo_clone_path_hint !== targetWorkspace ||
      sourceExecutionTarget?.target_repo_full_name !== "fixture/profit-canary" ||
      sourceExecutionTarget?.target_repo_clone_path_hint !== targetWorkspace ||
      sourceExecutionTarget?.repo_url !== pathToFileURL(targetOrigin).href
    ) {
      throw promotionError(
        "profit_canary_source_dispatch_identity_mismatch",
        "The source dispatch does not bind the receipt run/company/project/correlation identity",
        "portfolio_os_canary_owner",
        "Regenerate and validate the exact fixture dispatch, then replay promotion",
      );
    }
    sourceDispatchBinding = { path: sourcePath, sha256: sourceSha256 };
    canonicalInputs = {
      companyId,
      portfolioOsRoot,
      outboxDir,
      promotionReceiptDir,
      paperclipApiUrl,
      targetWorkspace,
      targetOrigin,
      waitSeconds,
      pollSeconds,
    };
    const resolveCredential = dependencies.resolveCredential ?? resolveProvisionedProfitCanaryApiKey;
    let credential: ResolvedProfitCanaryCredential;
    try {
      credential = await resolveCredential(db, companyId);
    } catch (error) {
      if (error instanceof FixturePromotionError) throw error;
      throw promotionError(
        "profit_canary_api_key_resolution_failed",
        `The provisioned ${API_SECRET_NAME} lookup or local decryption failed`,
        "paperclip_security_owner",
        "Repair database access or the local secret provider, then replay promotion",
      );
    }
    exactRedactionValues.push(credential.value);
    credentialBinding = credential.binding;
    const createBroker = dependencies.createBroker ?? createRunScopedPaperclipApiBroker;
    const allowedRequests = profitCanaryBrokerAllowedRequests({ companyId, projectId, runId });
    broker = await createBroker({
      upstreamUrl: paperclipApiUrl,
      authToken: credential.value,
      runId: `profit-canary:${runId}`,
      allowedRequests,
    });
    exactRedactionValues.push(broker.childAuthToken);
    const args = [
      "-m",
      "pos.profit_canary",
      "run-live",
      "--receipt",
      canaryReceiptPath,
      "--outbox-dir",
      outboxDir,
      "--promotion-receipt-dir",
      promotionReceiptDir,
      "--wait-seconds",
      String(waitSeconds),
      "--poll-seconds",
      String(pollSeconds),
    ];
    const runChild = dependencies.runChild ?? spawnProfitCanaryChild;
    childResult = await runChild({
      command: "python3",
      args,
      cwd: portfolioOsRoot,
      env: childEnvironment(broker, dependencies.environment ?? process.env),
      timeoutMs: Math.ceil((waitSeconds + 60) * 1_000),
      signal: dependencies.signal,
    });
    if (childResult.aborted) {
      throw promotionError(
        "profit_canary_operator_interrupted",
        "The operator was interrupted and terminated the Portfolio OS child",
        "paperclip_board_operator",
        "Confirm no child process remains, then replay the same immutable canary identity",
      );
    }
    if (childResult.timedOut) {
      throw promotionError(
        "profit_canary_child_timeout",
        "Portfolio OS run-live exceeded the bounded operator timeout and was terminated",
        "portfolio_os_canary_owner",
        "Inspect the dispatch ingest worker, then replay the same immutable canary identity",
      );
    }
    if (childResult.outputLimitExceeded) {
      throw promotionError(
        "profit_canary_child_output_limit",
        "Portfolio OS run-live exceeded the bounded output limit and was terminated",
        "portfolio_os_canary_owner",
        "Repair noisy machine output, then replay the same immutable canary identity",
      );
    }
    if (childResult.spawnErrorCode) {
      throw promotionError(
        "profit_canary_python_spawn_failed",
        `python3 could not be started (${sanitizeDiagnostic(childResult.spawnErrorCode, exactRedactionValues)})`,
        "paperclip_host_runtime_owner",
        "Install a working python3 runtime on PATH, then replay the same immutable canary identity",
      );
    }
    if (childResult.exitCode !== 0 && childResult.exitCode !== 2) {
      const diagnostic = sanitizeDiagnostic(childResult.stderr, exactRedactionValues);
      throw promotionError(
        "profit_canary_child_failed",
        diagnostic ? `Portfolio OS run-live failed: ${diagnostic}` : "Portfolio OS run-live exited without a valid result",
        "portfolio_os_canary_owner",
        "Repair the reported run-live failure, then replay the same immutable canary identity",
      );
    }
    const output = parseChildOutput(childResult.stdout);
    const expectedPublished = path.join(outboxDir, `dispatch_${runId}.json`);
    const expectedPromotion = path.join(promotionReceiptDir, `${runId}-promotion.json`);
    const published = await artifactBinding(output.published_dispatch ?? "", expectedPublished, "published_dispatch");
    const promotion = await artifactBinding(output.promotion_receipt ?? "", expectedPromotion, "promotion_receipt");
    if (
      !sourceDispatchBinding ||
      !sourceDispatchBytes ||
      published.sha256 !== sourceDispatchBinding.sha256 ||
      !published.bytes.equals(sourceDispatchBytes)
    ) {
      throw promotionError(
        "profit_canary_published_dispatch_bytes_mismatch",
        "The published dispatch bytes differ from the immutable source dispatch bound by the canary receipt",
        "portfolio_os_canary_owner",
        "Remove the conflicting unconsumed dispatch or regenerate the exact fixture identity, then replay promotion",
      );
    }
    let promotionPayload: Record<string, unknown>;
    try {
      promotionPayload = JSON.parse(promotion.bytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw promotionError(
        "profit_canary_promotion_receipt_invalid",
        "The immutable promotion receipt is not valid JSON",
        "portfolio_os_canary_owner",
        "Repair or regenerate the exact promotion receipt, then replay promotion",
      );
    }
    const promotionCanary = asRecord(promotionPayload.canary_receipt);
    const promotionSource = asRecord(promotionPayload.source_dispatch);
    const promotionPublished = asRecord(promotionPayload.published_dispatch);
    if (
      promotionPayload.schema_version !== "pos.profit_flywheel_canary_promotion.v1" ||
      promotionPayload.state !== "published" ||
      promotionPayload.immutable !== true ||
      promotionPayload.run_id !== runId ||
      promotionPayload.company_id !== canonicalInputs.companyId ||
      promotionPayload.project_id !== projectId ||
      promotionPayload.correlation_id !== `profit-canary:${runId}` ||
      promotionPayload.published_path !== published.path ||
      promotionPayload.published_sha256 !== published.sha256 ||
      promotionCanary?.path !== inputBinding?.path ||
      promotionCanary?.sha256 !== inputBinding?.sha256 ||
      promotionSource?.path !== sourceDispatchBinding.path ||
      promotionSource?.sha256 !== sourceDispatchBinding.sha256 ||
      promotionPublished?.path !== published.path ||
      promotionPublished?.sha256 !== published.sha256
    ) {
      throw promotionError(
        "profit_canary_promotion_receipt_binding_mismatch",
        "The promotion receipt does not bind the exact canary/source/published bytes and run/company/project/correlation identity",
        "portfolio_os_canary_owner",
        "Repair or regenerate the exact immutable promotion receipt, then replay promotion",
      );
    }
    const observationValue = output.observation_receipt ?? "";
    assertLexicallySafeAbsolutePath(observationValue, "observation_receipt");
    const observationBase = path.basename(observationValue);
    const validObservationName = observationBase === `${runId}-workflow-observation.json` ||
      observationBase.startsWith(`${runId}-workflow-wait-timeout-`);
    if (path.dirname(observationValue) !== promotionReceiptDir || !validObservationName) {
      throw promotionError(
        "profit_canary_observation_receipt_path_mismatch",
        "observation_receipt escaped the operator-confined promotion directory or run identity",
        "paperclip_security_owner",
        "Repair the result binding and replay the same immutable canary identity",
      );
    }
    const observation = await artifactBinding(observationValue, observationValue, "observation_receipt");
    let observationPayload: Record<string, unknown>;
    try {
      observationPayload = JSON.parse(observation.bytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw promotionError(
        "profit_canary_observation_receipt_invalid",
        "observation_receipt is not valid JSON",
        "portfolio_os_canary_owner",
        "Repair the immutable observation receipt, then replay the same canary identity",
      );
    }
    const state = output.canary_status;
    const observedState = observationPayload.state;
    const observationPromotion = asRecord(observationPayload.promotion_receipt);
    const observationPublished = asRecord(observationPayload.published_dispatch);
    if (
      observationPayload.immutable !== true ||
      observationPayload.schema_version !== "pos.profit_flywheel_canary_workflow_observation.v1" ||
      observationPromotion?.path !== promotion.path ||
      observationPromotion?.sha256 !== promotion.sha256 ||
      observationPublished?.path !== published.path ||
      observationPublished?.sha256 !== published.sha256 ||
      (state !== "workflow_observed" && state !== "workflow_wait_timeout") ||
      observedState !== state ||
      (childResult.exitCode === 0) !== (state === "workflow_observed") ||
      (state === "workflow_observed" && !output.workflow_id) ||
      (state === "workflow_wait_timeout" && output.workflow_id)
    ) {
      throw promotionError(
        "profit_canary_terminal_result_mismatch",
        "Child exit, machine output, and immutable observation receipt disagree",
        "portfolio_os_canary_owner",
        "Repair the run-live terminal contract, then replay the same immutable canary identity",
      );
    }
    let workflowId: string | null = null;
    let persistedWorkflow: PersistedProfitCanaryWorkflowBinding | null = null;
    if (state === "workflow_observed") {
      const observationWorkflow = observationPayload.workflow &&
        typeof observationPayload.workflow === "object" &&
        !Array.isArray(observationPayload.workflow)
        ? observationPayload.workflow as Record<string, unknown>
        : null;
      workflowId = canonicalObservedWorkflowId(output.workflow_id);
      const receiptWorkflowId = canonicalObservedWorkflowId(observationWorkflow?.id);
      if (
        workflowId !== receiptWorkflowId ||
        observationWorkflow?.companyId !== canonicalInputs.companyId ||
        observationWorkflow?.projectId !== projectId ||
        observationWorkflow?.runId !== runId ||
        observationWorkflow?.correlationId !== `profit-canary:${runId}` ||
        observationWorkflow?.sourceDispatchPath !== published.path ||
        observationWorkflow?.sourceDispatchHash !== published.sha256
      ) {
        throw promotionError(
          "profit_canary_workflow_id_binding_mismatch",
          "Machine output and immutable observation payload do not bind the same workflow/company/project/run/correlation identity",
          "paperclip_control_plane_owner",
          "Repair workflow observation binding, then replay the same immutable canary",
        );
      }
      const expectedPersistedWorkflow = {
        id: workflowId,
        companyId: canonicalInputs.companyId,
        projectId,
        runId,
        correlationId: `profit-canary:${runId}`,
        sourceDispatchPath: published.path,
        sourceDispatchHash: published.sha256,
        targetRepo: "fixture/profit-canary" as const,
        targetWorkspaceRoot: canonicalInputs.targetWorkspace,
      };
      const verifyPersistedWorkflow = dependencies.verifyPersistedWorkflow ?? verifyPersistedProfitCanaryWorkflow;
      persistedWorkflow = await verifyPersistedWorkflow(db, expectedPersistedWorkflow);
      if (Object.entries(expectedPersistedWorkflow).some(
        ([key, value]) => persistedWorkflow?.[key as keyof PersistedProfitCanaryWorkflowBinding] !== value,
      )) {
        throw promotionError(
          "profit_canary_workflow_db_binding_mismatch",
          "The independent workflow verifier returned a different persisted identity",
          "paperclip_control_plane_owner",
          "Repair workflow persistence or the verifier, then replay the same immutable canary",
        );
      }
    }
    result = {
      state,
      workflow_id: workflowId,
      persisted_workflow: persistedWorkflow,
      published_dispatch: { path: published.path, sha256: published.sha256 },
      promotion_receipt: { path: promotion.path, sha256: promotion.sha256 },
      observation_receipt: { path: observation.path, sha256: observation.sha256 },
    };
    if (state === "workflow_wait_timeout") {
      blocker = {
        blocker_code: "profit_canary_workflow_wait_timeout",
        blocker_detail: "The immutable dispatch was published but its exact Paperclip workflow was not observed within the bounded wait",
        next_owner: "paperclip_control_plane_owner",
        resume_condition: "Verify the dispatch ingest worker is enabled, then replay this operator with the same receipt/run identity",
      };
    }
  } catch (error) {
    blocker = blockerForUnexpected(error, exactRedactionValues);
  } finally {
    if (broker) {
      try {
        await broker.close();
      } catch {
        blocker = {
          blocker_code: "profit_canary_broker_close_failed",
          blocker_detail: "The loopback credential broker did not confirm a clean shutdown",
          next_owner: "paperclip_security_owner",
          resume_condition: "Confirm the ephemeral loopback listener is gone before replaying promotion",
        };
      }
    }
  }

  const finishedAt = now();
  const sanitizedStdout = childResult
    ? sanitizeDiagnostic(childResult.stdout, exactRedactionValues)
    : "";
  const sanitizedStderr = childResult
    ? sanitizeDiagnostic(childResult.stderr, exactRedactionValues)
    : "";
  const receipt = {
    schema_version: SCHEMA_VERSION,
    status: blocker ? "blocked" : "succeeded",
    operator_run_id: operatorRunId,
    company_id: canonicalInputs?.companyId ?? null,
    project_id: projectId,
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    inputs: {
      canary_receipt: inputBinding,
      source_dispatch: sourceDispatchBinding,
      portfolio_os_root: canonicalInputs?.portfolioOsRoot ?? null,
      outbox_dir: canonicalInputs?.outboxDir ?? null,
      promotion_receipt_dir: canonicalInputs?.promotionReceiptDir ?? null,
      paperclip_api_origin: canonicalInputs?.paperclipApiUrl ?? null,
      target_workspace: canonicalInputs?.targetWorkspace ?? null,
      target_origin: canonicalInputs?.targetOrigin ?? null,
      wait_seconds: canonicalInputs?.waitSeconds ?? null,
      poll_seconds: canonicalInputs?.pollSeconds ?? null,
    },
    credential_binding: credentialBinding,
    broker_scope: canonicalInputs && projectId && runId ? {
      bind: "127.0.0.1",
      authentication: "per_child_random_sentinel",
      upstream_authorization: "in_process_only",
      allowed_requests: profitCanaryBrokerAllowedRequests({
        companyId: canonicalInputs.companyId,
        projectId,
        runId,
      }).map((request) => `${request.method} ${request.pathname}${request.search}`),
    } : null,
    child: childResult ? {
      command: "python3",
      module: "pos.profit_canary",
      subcommand: "run-live",
      exit_code: childResult.exitCode,
      signal: childResult.signal,
      timed_out: childResult.timedOut,
      interrupted: childResult.aborted,
      output_limit_exceeded: childResult.outputLimitExceeded,
      stdout_sha256: sha256Bytes(sanitizedStdout),
      stderr_sha256: sha256Bytes(sanitizedStderr),
    } : null,
    result,
    blocker,
    secrets_in_argv: false,
    real_paperclip_bearer_in_child_environment: false,
    broker_sentinel_in_child_environment: childResult !== null,
    real_bearer_material_recorded: false,
    immutable: true,
  };
  const receiptPath = path.join(
    aggregateReceiptDir,
    `${timestamp(finishedAt)}-${runId ?? "preflight"}-${operatorRunId}.json`,
  );
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return {
    status: blocker ? "blocked" as const : "succeeded" as const,
    runId,
    blocker,
    result,
    receiptPath,
    receiptSha256,
  };
}

export function parseSecureProfitCanaryPromotionCliArgs(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const forbiddenCredentialFlags = new Set([
    "--api-key",
    "--paperclip-api-key",
    "--auth-token",
    "--connection-string",
    "--database-url",
  ]);
  const allowed = new Set([
    "--company-id",
    "--portfolio-os-root",
    "--receipt",
    "--outbox-dir",
    "--promotion-receipt-dir",
    "--aggregate-receipt-dir",
    "--paperclip-api-url",
    "--wait-seconds",
    "--poll-seconds",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const flag = token.split("=", 1)[0]!;
    if (forbiddenCredentialFlags.has(flag)) {
      throw new Error("profit_canary_credential_argv_forbidden: credentials and DATABASE_URL are environment/in-process only");
    }
    if (token.includes("=") || !allowed.has(token)) {
      throw new Error(`profit_canary_unknown_or_inline_argument: ${flag}`);
    }
    if (values.has(token)) throw new Error(`profit_canary_duplicate_argument: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`profit_canary_missing_argument_value: ${token}`);
    values.set(token, value);
    index += 1;
  }
  const required = [
    "--company-id",
    "--portfolio-os-root",
    "--receipt",
    "--outbox-dir",
    "--promotion-receipt-dir",
    "--aggregate-receipt-dir",
  ];
  for (const flag of required) {
    if (!values.get(flag)) throw new Error(`profit_canary_required_argument_missing: ${flag}`);
  }
  const connectionString = environment.DATABASE_URL?.trim() || null;
  if (connectionString) validatePostgresConnectionString(connectionString);
  return {
    connectionString,
    options: {
      companyId: values.get("--company-id")!,
      portfolioOsRoot: values.get("--portfolio-os-root")!,
      canaryReceiptPath: values.get("--receipt")!,
      outboxDir: values.get("--outbox-dir")!,
      promotionReceiptDir: values.get("--promotion-receipt-dir")!,
      aggregateReceiptDir: values.get("--aggregate-receipt-dir")!,
      paperclipApiUrl: values.get("--paperclip-api-url") ?? DEFAULT_PAPERCLIP_API_URL,
      waitSeconds: Number(values.get("--wait-seconds") ?? DEFAULT_WAIT_SECONDS),
      pollSeconds: Number(values.get("--poll-seconds") ?? DEFAULT_POLL_SECONDS),
    } satisfies SecureProfitCanaryPromotionOptions,
  };
}

function validatePostgresConnectionString(connectionString: string) {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("profit_canary_database_url_invalid: DATABASE_URL must be a PostgreSQL URL");
  }
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("profit_canary_database_url_invalid: DATABASE_URL must use postgres or postgresql");
  }
  return connectionString;
}

export function resolveSecureProfitCanaryDatabaseConnection(
  environmentConnectionString: string | null,
  config: {
    databaseMode: "embedded-postgres" | "postgres";
    databaseUrl?: string;
    embeddedPostgresPort: number;
  },
) {
  if (environmentConnectionString) {
    return {
      connectionString: validatePostgresConnectionString(environmentConnectionString),
      source: "DATABASE_URL" as const,
    };
  }
  if (config.databaseMode === "postgres") {
    if (!config.databaseUrl?.trim()) {
      throw new Error("profit_canary_database_url_missing: live postgres config has no connection string");
    }
    return {
      connectionString: validatePostgresConnectionString(config.databaseUrl.trim()),
      source: "live_config" as const,
    };
  }
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("profit_canary_embedded_database_port_invalid");
  }
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}` as const,
  };
}

function usage() {
  return [
    "Usage: pnpm ops:profit-flywheel-fixture-promotion -- \\",
    "  --company-id <uuid> --portfolio-os-root <absolute-path> --receipt <absolute-path> \\",
    "  --outbox-dir <absolute-path> --promotion-receipt-dir <absolute-path> \\",
    "  --aggregate-receipt-dir <absolute-path> [--paperclip-api-url http://127.0.0.1:<port>] \\",
    "  [--wait-seconds 120] [--poll-seconds 2]",
    "",
    "PAPERCLIP_API_KEY is resolved from the company's local_encrypted secret in-process.",
    "Embedded DATABASE_URL is derived from the live PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID config.",
    "External DATABASE_URL may be supplied through the environment; connection-string argv flags are rejected.",
  ].join("\n");
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const parsed = parseSecureProfitCanaryPromotionCliArgs(process.argv.slice(2));
  // Import lazily so PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID (including the
  // repo-local instance env) select the same live config as the server.
  const { loadConfig } = await import("../config.js");
  const runtimeConfig = loadConfig();
  const database = resolveSecureProfitCanaryDatabaseConnection(parsed.connectionString, runtimeConfig);
  const db = createDb(database.connectionString);
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const outcome = await runSecureProfitCanaryPromotion(db, parsed.options, {
      signal: abortController.signal,
      resolveCredential: (targetDb, companyId) =>
        resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey(
          targetDb,
          companyId,
          runtimeConfig.secretsMasterKeyFilePath,
        ),
    });
    console.log(JSON.stringify({
      status: outcome.status,
      run_id: outcome.runId,
      blocker: outcome.blocker,
      receipt_path: outcome.receiptPath,
      receipt_sha256: outcome.receiptSha256,
    }));
    if (outcome.status !== "succeeded") process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "";
    const code = message.match(/^(profit_canary_[a-z0-9_]+)/)?.[1] ?? "profit_canary_operator_start_failed";
    console.error(JSON.stringify({
      status: "failed",
      blocker: {
        blocker_code: code,
        blocker_detail: "The secure fixture-promotion operator could not start or install its immutable receipt",
        next_owner: "paperclip_board_operator",
        resume_condition: "Repair the CLI, database, or receipt-root precondition, then replay the same canary identity",
      },
    }));
    process.exit(1);
  });
}
