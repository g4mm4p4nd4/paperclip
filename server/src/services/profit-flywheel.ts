import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, link, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  companies,
  contextLedgerEntries,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import {
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES,
  PROFIT_FLYWHEEL_STAGES,
  parsePortfolioOsProfitFlywheelContractV2,
  profitFlywheelReceiptSchema,
  type PortfolioOsProfitFlywheelContractV2,
  type ProfitFlywheelCapabilityAlias,
  type ProfitFlywheelStage,
  type ProfitFlywheelReceiptInput,
} from "@paperclipai/shared";
import {
  loadProfitFlywheelContract,
  PINNED_POS_DISPATCH_SCHEMA_SHA256,
  PINNED_POS_LEARNING_SCHEMA_SHA256,
  PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256,
  PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256,
  type LoadedProfitFlywheelContract,
} from "./profit-flywheel-contract.js";
import {
  buildResolvedProviderRoute,
  loadProviderPolicyV2,
  type ProviderPolicyV2,
} from "./provider-policy.js";
import {
  completionCanaryRouteSha256,
  providerPolicyRouteCoreSha256,
} from "./provider-route-hash.js";
import { providerCanaryService } from "./provider-canaries.js";
import { issueService } from "./issues.js";
import { notifyProfitFlywheelReconciliation } from "./profit-flywheel-reconcile-signal.js";
import { revalidateProfitFlywheelWorkspaceSnapshot } from "./profit-flywheel-workspace-state.js";

type CanonicalRunState =
  | "pending"
  | "running"
  | "retry"
  | "blocked"
  | "degraded"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "safely_skipped";

type Blocker = {
  blockerCode: string;
  blockerDetail: string;
  nextOwner: string;
  resumeCondition: string;
};

type ExpectedLease = {
  leaseOwner: string | null;
  actorType: "agent" | "board" | "system" | null;
  actorId: string | null;
};

const ALLOWED_DOSSIER_GATE_STATUSES = new Set(["APPROVED_DISTINCT_RESKIN", "APPROVED_NO_CONFLICT"]);
const DEFAULT_PORTFOLIO_OS_AUTHORITY_ROOT = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_TARGET_REPOSITORY_ROOT = "/Users/mnm/Documents/Github";
const DEFAULT_POS_DISPATCH_SCHEMA_PATH = "/Users/mnm/Documents/Github/portfolio-os/contracts/pos.dispatch.v2.schema.json";
const DEFAULT_POS_RESEARCH_REGISTRY_PATH = "/Users/mnm/Documents/Github/portfolio-os/config/research_sources.yaml";
const DEFAULT_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/flywheel-execution";
export const PINNED_POS_RESEARCH_REGISTRY_SHA256 = "9a9f7868977c3d273f2fa18721953dd90e4a7b25f1c723d37b4c4591453d7915";
export { PINNED_POS_DISPATCH_SCHEMA_SHA256 } from "./profit-flywheel-contract.js";
const execFile = promisify(execFileCallback);

const PROFIT_FLYWHEEL_EXECUTION_SCHEMA_ROOT = fileURLToPath(new URL("../../../contracts/profit-flywheel/", import.meta.url));
const PAPERCLIP_REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES = {
  independentReviewResult: {
    schemaVersion: "paperclip.independent_review_result.v1",
    path: path.join(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_ROOT, "independent-review-result.v1.schema.json"),
    sha256: "d90769477297810c8536624068fc3af1864d059a6b6d658e9648a0ae53c941af",
  },
  stageWorkResult: {
    schemaVersion: "paperclip.profit_flywheel_stage_work_result.v1",
    path: path.join(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_ROOT, "stage-work-result.v1.schema.json"),
    sha256: "beff2e8e4d31413329a73e6891d1c9104e004a2a4e621192d39845ff08019fba",
  },
  stageExecution: {
    schemaVersion: "paperclip.profit_flywheel_stage_execution.v2",
    path: path.join(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_ROOT, "stage-execution.v2.schema.json"),
    sha256: "fb080707e7d65bb17664e494dea765fa4c7018c42a9317d188da8da6be03b6b2",
  },
  testExecutionResult: {
    schemaVersion: "paperclip.test_execution_result.v1",
    path: path.join(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_ROOT, "test-execution-result.v1.schema.json"),
    sha256: "3896d169ef45baae7c19dba9cfb0bc1d2fee18cbc2018d3c734ef23815f896d2",
  },
} as const;

type JsonSchemaValidator = ((value: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; keyword: string; message?: string }> | null;
};

function loadPinnedExecutionSchema(authority: { path: string; sha256: string }) {
  const bytes = readFileSync(authority.path);
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== authority.sha256) {
    throw new Error(`Pinned Profit Flywheel execution schema hash mismatch: ${authority.path}`);
  }
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

const executionSchemaAjv = new (Ajv2020 as unknown as new (options: Record<string, unknown>) => {
  addSchema(schema: Record<string, unknown>): void;
  compile(schema: Record<string, unknown>): JsonSchemaValidator;
})({ allErrors: true, strict: true, strictRequired: false });
(addFormats as unknown as (instance: typeof executionSchemaAjv) => void)(executionSchemaAjv);
const independentReviewResultSchema = loadPinnedExecutionSchema(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES.independentReviewResult);
const stageWorkResultSchema = loadPinnedExecutionSchema(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES.stageWorkResult);
const stageExecutionSchema = loadPinnedExecutionSchema(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES.stageExecution);
const testExecutionResultSchema = loadPinnedExecutionSchema(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES.testExecutionResult);
const validateIndependentReviewResultSchema = executionSchemaAjv.compile(independentReviewResultSchema);
const validateStageWorkResultSchema = executionSchemaAjv.compile(stageWorkResultSchema);
const validateStageExecutionSchema = executionSchemaAjv.compile(stageExecutionSchema);
const validateTestExecutionResultSchema = executionSchemaAjv.compile(testExecutionResultSchema);

function assertExecutionSchema(validator: JsonSchemaValidator, value: unknown, label: string) {
  if (!validator(value)) {
    throw new ProfitFlywheelError("profit_flywheel_execution_receipt_schema_invalid", `${label} does not satisfy its pinned JSON Schema`, {
      errors: (validator.errors ?? []).slice(0, 25),
    });
  }
}

export function validateProfitFlywheelStageWorkResult(value: unknown) {
  sanitizeReceiptValue(value);
  assertExecutionSchema(validateStageWorkResultSchema, value, "stage work result");
  return asRecord(value);
}

export function validateProfitFlywheelStageExecutionEnvelope(value: unknown) {
  sanitizeReceiptValue(value);
  assertExecutionSchema(validateStageExecutionSchema, value, "server-authored stage execution envelope");
  return asRecord(value);
}

export function validateProfitFlywheelTestExecutionResult(value: unknown) {
  sanitizeReceiptValue(value);
  assertExecutionSchema(validateTestExecutionResultSchema, value, "server-observed test execution result");
  return asRecord(value);
}

function profitFlywheelHttpStatus(code: string): number {
  if (/(?:missing|not_found)$/.test(code)) return 404;
  if (/(?:principal_required|unauthorized|forbidden)$/.test(code)) return 403;
  if (/(?:stale_attempt|conflict|replay_conflict|race|retry_not_due|attempts_exhausted|retry_exhausted)$/.test(code)) return 409;
  return 422;
}

export class ProfitFlywheelError extends HttpError {
  readonly code: string;
  readonly internalDetails: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(profitFlywheelHttpStatus(code), message, { code });
    this.name = "ProfitFlywheelError";
    this.code = code;
    this.internalDetails = details;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => {
    const canonicalKey = JSON.stringify(key).replace(/[\u007f-\uffff]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `${canonicalKey}:${stableJson(entry)}`;
  }).join(",")}}`;
}

export function buildProfitFlywheelServerObservationProof(
  executionEvidenceNonce: string,
  artifactKind: "adjudication" | "workspace" | "checkpoint",
  value: Record<string, unknown>,
) {
  if (!/^[a-f0-9]{64}$/.test(executionEvidenceNonce)) {
    throw new ProfitFlywheelError("profit_flywheel_observation_intent_invalid", "Server observation intent must remain a 256-bit database-only secret");
  }
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "server_observation_proof"));
  return createHmac("sha256", executionEvidenceNonce)
    .update(`${artifactKind}\0${stableJson(body)}`, "utf8")
    .digest("hex");
}

export async function loadPortfolioOsResearchRegistryAuthority() {
  const registryPath = path.resolve(process.env.PAPERCLIP_POS_RESEARCH_REGISTRY_PATH ?? DEFAULT_POS_RESEARCH_REGISTRY_PATH);
  const bytes = await readFile(registryPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== PINNED_POS_RESEARCH_REGISTRY_SHA256) {
    throw new ProfitFlywheelError(
      "profit_flywheel_research_registry_hash_mismatch",
      "Portfolio OS research source registry bytes differ from the pinned authority",
      { registryPath, expected: PINNED_POS_RESEARCH_REGISTRY_SHA256, observed: sha256 },
    );
  }
  return {
    schema_version: "paperclip.research_registry_authority.v1",
    registry: { path: registryPath, sha256, schema_version: "pos.research_sources.v2" },
  };
}

export async function validatePinnedResearchArtifactSchema(input: {
  value?: Record<string, unknown>;
  schemaPath: string;
  expectedSha256: string;
  label: string;
}) {
  const schemaPath = path.resolve(input.schemaPath);
  const bytes = await readFile(schemaPath).catch((error) => {
    throw new ProfitFlywheelError("profit_flywheel_research_schema_missing", `${input.label} schema is unavailable`, {
      schemaPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  });
  const schemaSha256 = createHash("sha256").update(bytes).digest("hex");
  if (schemaSha256 !== input.expectedSha256) {
    throw new ProfitFlywheelError("profit_flywheel_research_schema_hash_mismatch", `${input.label} schema differs from the frozen POS authority`, {
      schemaPath,
      expected: input.expectedSha256,
      observed: schemaSha256,
    });
  }
  const schema = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const AjvConstructor = Ajv2020 as unknown as new (options: Record<string, unknown>) => {
    compile(schema: Record<string, unknown>): ((value: unknown) => boolean) & { errors?: Array<{ instancePath: string; keyword: string; message?: string }> | null };
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: true });
  (addFormats as unknown as (instance: typeof ajv) => void)(ajv);
  const validate = ajv.compile(schema);
  if (input.value !== undefined && !validate(input.value)) {
    throw new ProfitFlywheelError("profit_flywheel_research_schema_invalid", `${input.label} does not satisfy its exact frozen JSON Schema`, {
      errors: (validate.errors ?? []).slice(0, 25),
    });
  }
  return { path: await realpath(schemaPath), sha256: schemaSha256 };
}

async function validatePosDispatchV2Schema(dispatch: Record<string, unknown>) {
  const schemaPath = path.resolve(process.env.PAPERCLIP_POS_DISPATCH_SCHEMA_PATH ?? DEFAULT_POS_DISPATCH_SCHEMA_PATH);
  const bytes = await readFile(schemaPath).catch((error) => {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_schema_missing", "Pinned pos.dispatch.v2 schema is unavailable", { schemaPath, cause: error instanceof Error ? error.message : String(error) });
  });
  const schemaHash = createHash("sha256").update(bytes).digest("hex");
  if (schemaHash !== PINNED_POS_DISPATCH_SCHEMA_SHA256) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_schema_hash_mismatch", "pos.dispatch.v2 schema bytes differ from the pinned hash", { schemaPath, expected: PINNED_POS_DISPATCH_SCHEMA_SHA256, observed: schemaHash });
  }
  const schema = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const AjvConstructor = Ajv2020 as unknown as new (options: Record<string, unknown>) => {
    compile(schema: Record<string, unknown>): ((value: unknown) => boolean) & { errors?: Array<{ instancePath: string; keyword: string; message?: string }> | null };
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: true });
  (addFormats as unknown as (instance: typeof ajv) => void)(ajv);
  const validate = ajv.compile(schema);
  if (!validate(dispatch)) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_schema_invalid", "Dispatch does not satisfy exact pos.dispatch.v2 schema", {
      errors: (validate.errors ?? []).slice(0, 25).map((error: { instancePath: string; keyword: string; message?: string }) => ({ instancePath: error.instancePath, keyword: error.keyword, message: error.message })),
    });
  }
  return { schemaPath, schemaHash };
}

function assertExactObjectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedSet = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (extras.length > 0 || missing.length > 0) {
    throw new ProfitFlywheelError("profit_flywheel_execution_receipt_schema_invalid", `${label} has missing or extra fields`, { label, missing, extras });
  }
}

async function readJsonArtifactStrict(filePath: string, label: string, allowedRoot: string) {
  if (!path.isAbsolute(filePath)) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_path_invalid", `${label} path must be absolute`);
  }
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(filePath), realpath(allowedRoot)]).catch((error) => {
    throw new ProfitFlywheelError("profit_flywheel_artifact_missing", `${label} artifact or authority root is unavailable`, { filePath, allowedRoot, cause: error instanceof Error ? error.message : String(error) });
  });
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_path_escape", `${label} artifact escapes the Portfolio OS authority root`, { resolvedPath, resolvedRoot });
  }
  const immutable = await readImmutableFileStrict(resolvedPath, label, 20 * 1024 * 1024);
  const raw = immutable.bytes.toString("utf8");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
    return {
      path: resolvedPath,
      raw,
      value: value as Record<string, unknown>,
      byteHash: createHash("sha256").update(raw).digest("hex"),
      stableHash: hashProfitFlywheelValue(value),
    };
  } catch (error) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_invalid_json", `${label} is not a valid JSON object`, { resolvedPath, cause: error instanceof Error ? error.message : String(error) });
  }
}

export async function readImmutableFileStrict(filePath: string, label: string, maxBytes: number) {
  if (!path.isAbsolute(filePath) || filePath.includes("\0") || path.resolve(filePath) !== filePath) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_path_invalid", `${label} must use a canonical absolute path`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    throw new ProfitFlywheelError("profit_flywheel_artifact_open_failed", `${label} cannot be opened without following symlinks`, { cause: error instanceof Error ? error.message : String(error) });
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes || (before.mode & 0o222) !== 0) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_immutable_invalid", `${label} must be a non-empty read-only regular file no larger than ${maxBytes} bytes`, { size: before.size, mode: before.mode & 0o777 });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_toctou", `${label} changed while being verified`);
    }
    const resolved = await realpath(filePath);
    if (resolved !== filePath) throw new ProfitFlywheelError("profit_flywheel_artifact_symlink", `${label} must not be a symlink or traversal path`);
    return { bytes, stat: before, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

async function writeImmutableJsonArtifactBeside(input: {
  sourcePath: string;
  fileName: string;
  value: Record<string, unknown>;
  label: string;
}) {
  const sourceRealpath = await realpath(input.sourcePath);
  const artifactPath = path.join(path.dirname(sourceRealpath), input.fileName);
  return writeImmutableJsonArtifactAtomically({ artifactPath, value: input.value, label: input.label });
}

async function fsyncDirectory(directory: string) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImmutableJsonArtifactAtomically(input: {
  artifactPath: string;
  value: Record<string, unknown>;
  label: string;
}) {
  const artifactPath = path.resolve(input.artifactPath);
  const directory = path.dirname(artifactPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${stableJson(input.value)}\n`, "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const temporaryPath = path.join(directory, `.${path.basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o444);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, artifactPath);
      await fsyncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readImmutableFileStrict(artifactPath, input.label, 1024 * 1024);
    if ((existing.stat.mode & 0o777) !== 0o444 || existing.sha256 !== expectedSha256 || !existing.bytes.equals(bytes)) {
      throw new ProfitFlywheelError("profit_flywheel_immutable_artifact_conflict", `${input.label} already exists with different immutable bytes or mode`);
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
      await fsyncDirectory(directory).catch(() => undefined);
    }
  }
  return { path: await realpath(artifactPath), sha256: expectedSha256 };
}

async function writeImmutableJsonArtifactAt(input: {
  artifactPath: string;
  value: Record<string, unknown>;
  label: string;
}) {
  return writeImmutableJsonArtifactAtomically(input);
}

async function runOrReuseServerObservedTest(input: {
  stageRunId: string;
  attempt: number;
  commandIndex: number;
  command: string;
  cwd: string;
  receiptDirectory: string;
  observationNonce: string;
  trustedReceiptSha256?: string | null;
  trustedObservationOutcome?: "passed" | "failed" | null;
  trustedFailureClass?: string | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  await mkdir(input.receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(input.receiptDirectory, 0o700);
  const artifactPath = path.join(
    input.receiptDirectory,
    `${input.observationNonce}-server-test.json`,
  );
  const currentHead = async () => execFile("git", ["-C", input.cwd, "rev-parse", "HEAD"], { timeout: 15_000 })
    .then(({ stdout }) => stdout.trim());
  const statusProof = async () => {
    const { stdout } = await execFile("git", [
      "-C", input.cwd, "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).paperclip/**",
    ], { timeout: 15_000 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    return {
      clean: lines.length === 0,
      sha256: createHash("sha256").update(stdout).digest("hex"),
      unexpectedCount: lines.length,
    };
  };
  const headBefore = await currentHead();
  const cleanBefore = await statusProof();
  const existing = await readImmutableFileStrict(artifactPath, "server-observed test execution result", 1024 * 1024).catch(() => null);
  if (!existing && input.trustedReceiptSha256) {
    throw new ProfitFlywheelError("profit_flywheel_test_receipt_missing", "Completed server-test journal points to a missing immutable receipt");
  }
  if (existing) {
    if ((existing.stat.mode & 0o777) !== 0o444) {
      throw new ProfitFlywheelError("profit_flywheel_test_receipt_mode_invalid", "Existing server test receipt is not exactly mode 0444");
    }
    let value: Record<string, unknown>;
    try { value = asRecord(JSON.parse(existing.bytes.toString("utf8"))); } catch { value = {}; }
    validateProfitFlywheelTestExecutionResult(value);
    if (value.observation_nonce !== input.observationNonce || value.stage_run_id !== input.stageRunId || value.attempt !== input.attempt ||
        value.command_index !== input.commandIndex || value.command !== input.command || value.cwd !== input.cwd ||
        value.target_git_object_before !== headBefore || value.target_git_object_after !== headBefore ||
        value.git_status_sha256_before !== cleanBefore.sha256 || value.git_status_sha256_after !== cleanBefore.sha256 ||
        (input.trustedReceiptSha256 && input.trustedReceiptSha256 !== existing.sha256)) {
      throw new ProfitFlywheelError("profit_flywheel_test_receipt_replay_conflict", "Existing server test receipt does not bind the exact stage attempt, command, cwd, and current git object");
    }
    if (input.trustedObservationOutcome && value.outcome !== input.trustedObservationOutcome) {
      throw new ProfitFlywheelError("profit_flywheel_test_receipt_replay_conflict", "Completed server-test journal outcome does not match its immutable receipt");
    }
    if (input.trustedObservationOutcome === "passed" && value.failure_class !== null) {
      throw new ProfitFlywheelError("profit_flywheel_test_receipt_replay_conflict", "Completed passing server-test journal points to a failure receipt");
    }
    if (input.trustedObservationOutcome === "failed" && value.failure_class !== input.trustedFailureClass) {
      throw new ProfitFlywheelError("profit_flywheel_test_receipt_replay_conflict", "Completed failed server-test journal class does not match its immutable receipt");
    }
    if (value.outcome !== "passed") {
      throw new ProfitFlywheelError(String(value.failure_class), String(value.failure_detail), {
        testReceiptPath: artifactPath,
        testReceiptSha256: existing.sha256,
        failureClass: value.failure_class,
      });
    }
    return {
      command: input.command,
      exit_code: 0,
      artifact_ref: artifactPath,
      artifact_hash: existing.sha256,
    };
  }

  const maxOutputBytes = Math.min(16 * 1024 * 1024, Math.max(1024, input.maxOutputBytes ?? 16 * 1024 * 1024));
  const timeoutMs = Math.min(5 * 60 * 1000, Math.max(25, input.timeoutMs ?? 5 * 60 * 1000));
  const safeHome = path.join(input.cwd, ".paperclip", "test-home");
  await mkdir(safeHome, { recursive: true, mode: 0o700 });
  const startedAt = new Date();
  const emptyHash = createHash("sha256").update("").digest("hex");
  const persistResult = async (receipt: Record<string, unknown>) => {
    validateProfitFlywheelTestExecutionResult(receipt);
    return writeImmutableJsonArtifactAt({
      artifactPath,
      value: receipt,
      label: "server-observed test execution result",
    });
  };
  if (!cleanBefore.clean) {
    const endedAt = new Date();
    const receipt = {
      schema_version: "paperclip.test_execution_result.v1",
      authority: "paperclip_server_observed",
      observation_nonce: input.observationNonce,
      stage_run_id: input.stageRunId,
      attempt: input.attempt,
      command_index: input.commandIndex,
      command: input.command,
      cwd: input.cwd,
      target_git_object_before: headBefore,
      target_git_object_after: headBefore,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      outcome: "failed",
      exit_code: null,
      signal: null,
      timed_out: false,
      output_overflow: false,
      stdout_sha256: emptyHash,
      stdout_bytes: 0,
      stderr_sha256: emptyHash,
      stderr_bytes: 0,
      noninteractive: true,
      clean_tree_before: false,
      clean_tree_after: false,
      git_status_sha256_before: cleanBefore.sha256,
      git_status_sha256_after: cleanBefore.sha256,
      unexpected_dirty_path_count_before: cleanBefore.unexpectedCount,
      unexpected_dirty_path_count_after: cleanBefore.unexpectedCount,
      allowed_dirty_prefixes: [".paperclip/"],
      failure_class: "workspace_dirty",
      failure_detail: "unexpected_non_paperclip_paths_before_test",
    };
    const binding = await persistResult(receipt);
    throw new ProfitFlywheelError("workspace_dirty", "Target workspace contains changes outside server-owned .paperclip artifacts", {
      testReceiptPath: binding.path,
      testReceiptSha256: binding.sha256,
      unexpectedDirtyPathCount: cleanBefore.unexpectedCount,
    });
  }
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  let timedOut = false;
  let spawnFailure: Error | null = null;
  const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: safeHome,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const capture = (chunks: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
    if (stream === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > maxOutputBytes) {
      outputOverflow = true;
      terminate();
      return;
    }
    chunks.push(Buffer.from(chunk));
  };
  child.stdout.on("data", capture(stdoutChunks, "stdout"));
  child.stderr.on("data", capture(stderrChunks, "stderr"));
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      spawnFailure = error;
      resolve({ exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timer));
  const endedAt = new Date();
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  const secretLikeOutput = SECRET_VALUE_PATTERN.test(stdout.toString("utf8")) || SECRET_VALUE_PATTERN.test(stderr.toString("utf8"));
  const headAfter = await currentHead();
  const cleanAfter = await statusProof();
  const failureClass = spawnFailure ? "process_spawn_failed"
    : timedOut ? "target_test_timeout"
      : outputOverflow || secretLikeOutput ? "unsafe_test_output"
        : result.exitCode !== 0 ? "target_test_failure"
          : headAfter !== headBefore ? "test_mutated_git_head"
            : !cleanAfter.clean ? "workspace_dirty"
              : null;
  const failureDetail = spawnFailure ? "test_process_spawn_failed"
    : timedOut ? "command_timed_out"
      : outputOverflow ? "output_limit_exceeded"
        : secretLikeOutput ? "secret_like_output_detected"
          : result.exitCode !== 0 ? "nonzero_exit"
            : headAfter !== headBefore ? "git_head_changed_during_test"
              : !cleanAfter.clean ? "unexpected_non_paperclip_paths_after_test"
                : null;
  const receipt = {
    schema_version: "paperclip.test_execution_result.v1",
    authority: "paperclip_server_observed",
    observation_nonce: input.observationNonce,
    stage_run_id: input.stageRunId,
    attempt: input.attempt,
    command_index: input.commandIndex,
    command: input.command,
    cwd: input.cwd,
    target_git_object_before: headBefore,
    target_git_object_after: headAfter,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    outcome: failureClass ? "failed" : "passed",
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: timedOut,
    output_overflow: outputOverflow,
    stdout_sha256: createHash("sha256").update(stdout).digest("hex"),
    stdout_bytes: stdout.length,
    stderr_sha256: createHash("sha256").update(stderr).digest("hex"),
    stderr_bytes: stderr.length,
    noninteractive: true,
    clean_tree_before: cleanBefore.clean,
    clean_tree_after: cleanAfter.clean,
    git_status_sha256_before: cleanBefore.sha256,
    git_status_sha256_after: cleanAfter.sha256,
    unexpected_dirty_path_count_before: cleanBefore.unexpectedCount,
    unexpected_dirty_path_count_after: cleanAfter.unexpectedCount,
    allowed_dirty_prefixes: [".paperclip/"],
    failure_class: failureClass,
    failure_detail: failureDetail,
  };
  const binding = await persistResult(receipt);
  if (failureClass) {
    throw new ProfitFlywheelError(failureClass, failureDetail ?? "server_observed_test_failed", {
      testReceiptPath: binding.path,
      testReceiptSha256: binding.sha256,
      command: input.command,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      outputOverflow,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      unexpectedDirtyPathCountBefore: cleanBefore.unexpectedCount,
      unexpectedDirtyPathCountAfter: cleanAfter.unexpectedCount,
    });
  }
  return {
    command: input.command,
    exit_code: 0,
    artifact_ref: binding.path,
    artifact_hash: binding.sha256,
  };
}

export async function validateDispatchEvidence(input: {
  sourceDispatchPath: string;
  dispatchHash: string;
  selectionSnapshotHash: string;
  runId: string;
  correlationId: string;
  sourceSchemaVersion: string;
  targetRepo?: string | null;
  targetRepoUrl: string;
  targetWorkspaceRoot: string;
  contract: PortfolioOsProfitFlywheelContractV2;
}) {
  const dispatchRaw = (await readImmutableFileStrict(input.sourceDispatchPath, "dispatch artifact", 20 * 1024 * 1024)).bytes.toString("utf8");
  const observedDispatchHash = createHash("sha256").update(dispatchRaw).digest("hex");
  if (observedDispatchHash !== input.dispatchHash) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_hash_mismatch", "Dispatch bytes do not match the declared immutable hash", { expected: input.dispatchHash, observed: observedDispatchHash });
  }
  let dispatch: Record<string, unknown>;
  try {
    dispatch = JSON.parse(dispatchRaw) as Record<string, unknown>;
  } catch (error) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_invalid_json", "Dispatch artifact is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
  const verifiedDispatchSchema = await validatePosDispatchV2Schema(dispatch);
  const dispatchSchemaBinding = asRecord(dispatch.dispatch_schema);
  const boundDispatchSchemaPath = typeof dispatchSchemaBinding.path === "string"
    ? await realpath(dispatchSchemaBinding.path).catch(() => "")
    : "";
  if (dispatchSchemaBinding.schema_version !== "pos.dispatch.v2" ||
      dispatchSchemaBinding.sha256 !== verifiedDispatchSchema.schemaHash ||
      boundDispatchSchemaPath !== await realpath(verifiedDispatchSchema.schemaPath)) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_schema_binding_mismatch", "Dispatch does not bind the exact pinned pos.dispatch.v2 schema bytes");
  }
  if (dispatch.schema_version !== input.sourceSchemaVersion || dispatch.run_id !== input.runId || dispatch.correlation_id !== input.correlationId || dispatch.immutable !== true) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_contract_mismatch", "Dispatch schema/run/immutable fields do not match the requested workflow", {
      schemaVersion: dispatch.schema_version,
      runId: dispatch.run_id,
      correlationId: dispatch.correlation_id,
      immutable: dispatch.immutable,
    });
  }
  if (dispatch.selection_snapshot_hash !== input.selectionSnapshotHash) {
    throw new ProfitFlywheelError("profit_flywheel_selection_hash_mismatch", "Dispatch selection snapshot hash differs from the requested workflow hash");
  }
  const authorityRoot = path.resolve(process.env.PAPERCLIP_PORTFOLIO_OS_AUTHORITY_ROOT ?? DEFAULT_PORTFOLIO_OS_AUTHORITY_ROOT);
  const artifactReceipts = asRecord(dispatch.receipts);
  const selectionReceipt = asRecord(artifactReceipts.selection_snapshot);
  const selectionPath = typeof selectionReceipt.path === "string" ? selectionReceipt.path : "";
  const selection = await readJsonArtifactStrict(selectionPath, "selection snapshot", authorityRoot);
  if (selection.byteHash !== selectionReceipt.sha256 || dispatch.selection_snapshot_path !== selection.path) {
    throw new ProfitFlywheelError("profit_flywheel_selection_file_hash_mismatch", "Selection snapshot bytes do not match the immutable receipt", {
      expected: selectionReceipt.sha256,
      observed: selection.byteHash,
    });
  }
  if (selection.stableHash !== input.selectionSnapshotHash) {
    throw new ProfitFlywheelError("profit_flywheel_selection_hash_mismatch", "Selection snapshot content does not match selection_snapshot_hash", {
      expected: input.selectionSnapshotHash,
      observed: selection.stableHash,
    });
  }
  if (dispatch.selection_snapshot && stableJson(dispatch.selection_snapshot) !== stableJson(selection.value)) {
    throw new ProfitFlywheelError("profit_flywheel_inline_selection_drift", "Inline and file-backed selection snapshots differ");
  }
  const authorization = asRecord(dispatch.commercial_authorization);
  const commercialGateHash = typeof authorization.commercial_gate_hash === "string" ? authorization.commercial_gate_hash : "";
  assertSha256(commercialGateHash, "commercial_authorization.commercial_gate_hash");
  if (authorization.status !== "authorized" || authorization.authorizer !== "portfolio_os") {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_unauthorized", "Only an explicit Portfolio OS commercial authorization may enter dispatch");
  }
  const launchTarget = asRecord(asRecord(dispatch.selection_snapshot).launch_target);
  const minimums: Array<[string, number]> = [
    ["commercialization_confidence", input.contract.commercial_policy.minimum_commercialization_confidence],
    ["current_market_signal_count", input.contract.commercial_policy.minimum_current_market_signals],
    ["independent_voc_count", input.contract.commercial_policy.minimum_independent_voc_observations],
    ["pricing_evidence_count", input.contract.commercial_policy.minimum_pricing_signals],
    ["competitive_evidence_count", input.contract.commercial_policy.minimum_competitive_or_differentiation_signals],
    ["authority_evidence_count", input.contract.commercial_policy.minimum_authority_signals],
  ];
  for (const [field, floor] of minimums) {
    const value = Number(launchTarget[field] ?? authorization[field]);
    if (!Number.isFinite(value) || value < floor) {
      throw new ProfitFlywheelError("profit_flywheel_commercial_floor_failed", `Dispatch commercial floor ${field}=${String(value)} is below ${floor}`, { field, value, floor });
    }
  }
  for (const field of ["identified_buyer", "identified_approver", "commercial_recommendation", "cheapest_validation_step"]) {
    const value = launchTarget[field] ?? authorization[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ProfitFlywheelError("profit_flywheel_commercial_identity_missing", `Dispatch is missing required commercial field ${field}`, { field });
    }
  }
  const readiness = String(launchTarget.internet_pipes_readiness ?? "");
  const missingStations = Array.isArray(launchTarget.internet_pipes_missing_stations)
    ? launchTarget.internet_pipes_missing_stations.filter(Boolean)
    : [];
  if (!input.contract.commercial_policy.allowed_internet_pipes_readiness.includes(readiness) || missingStations.length > 0) {
    throw new ProfitFlywheelError("profit_flywheel_internet_pipes_incomplete", "Internet Pipes must be alpha_ready/factory_ready with no missing stations", { readiness, missingStations });
  }
  if (input.targetRepo && String(launchTarget.repo ?? dispatch.target_repo_full_name) !== input.targetRepo) {
    throw new ProfitFlywheelError("profit_flywheel_target_repo_mismatch", "Dispatch target repo does not match the authorized launch target");
  }
  const dispatchRepoTarget = asRecord(asRecord(dispatch.execution_manifest).repo_target);
  const dispatchRepoUrl = dispatchRepoTarget.repo_url;
  if (typeof dispatchRepoUrl !== "string" || dispatchRepoUrl !== input.targetRepoUrl) {
    throw new ProfitFlywheelError("profit_flywheel_target_repo_url_mismatch", "Dispatch repository origin URL does not match the bound project workspace origin");
  }
  const target = asRecord(dispatch.target);
  const declaredHint = typeof dispatch.target_repo_clone_path_hint === "string" ? dispatch.target_repo_clone_path_hint : null;
  const workspaceRoot = await realpath(input.targetWorkspaceRoot).catch(() => "");
  if (!workspaceRoot || workspaceRoot !== path.resolve(input.targetWorkspaceRoot)) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_invalid", "Execution workspace is unavailable or traverses a symlink");
  }
  if (declaredHint) {
    const sourceRoot = await realpath(declaredHint).catch(() => "");
    if (!sourceRoot) throw new ProfitFlywheelError("profit_flywheel_workspace_hint_invalid", "Dispatch clone-path hint is unavailable");
    const [sourceCommon, workspaceCommon] = await Promise.all([
      execFile("git", ["-C", sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 15_000 }).then(({ stdout }) => stdout.trim()).catch(() => ""),
      execFile("git", ["-C", workspaceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 15_000 }).then(({ stdout }) => stdout.trim()).catch(() => ""),
    ]);
    if (!sourceCommon || !workspaceCommon || sourceCommon !== workspaceCommon) {
      throw new ProfitFlywheelError("profit_flywheel_workspace_binding_mismatch", "Execution workspace is not an isolated worktree of the authorized clone-path hint");
    }
  }
  const declaredBase = typeof target.base_sha === "string" ? target.base_sha : "";
  const declaredBaseBranch = typeof dispatchRepoTarget.target_repo_branch === "string"
    ? dispatchRepoTarget.target_repo_branch
    : typeof dispatch.target_repo_branch === "string" ? dispatch.target_repo_branch : "";
  await verifyAuthorizedGitWorkspace({
    workspaceRoot,
    expectedOriginUrl: input.targetRepoUrl,
    baseBranch: declaredBaseBranch,
    baseSha: declaredBase,
  });
  const expectedWorkspaceFingerprint = hashProfitFlywheelValue({
    target_repo: input.targetRepo ?? dispatch.target_repo_full_name,
    target_branch: target.branch,
    target_base_sha: target.base_sha,
    dirty_work_policy: target.dirty_work_policy,
    selection_snapshot_hash: input.selectionSnapshotHash,
  });
  if (target.workspace_fingerprint !== expectedWorkspaceFingerprint) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_fingerprint_mismatch", "Dispatch workspace fingerprint does not match canonical target/base/policy inputs");
  }
  const dossierContract = asRecord(dispatch.dossier_contract);
  if (dossierContract.pending_semantic_review === true) {
    throw new ProfitFlywheelError("profit_flywheel_dossier_stale", "Selected repo dossier is pending semantic review");
  }
  const gateStatuses = asRecord(dossierContract.gate_statuses);
  const freshnessStatuses = asRecord(dossierContract.freshness_statuses);
  const targetRepo = input.targetRepo ?? String(dispatch.target_repo_full_name ?? "");
  if (!ALLOWED_DOSSIER_GATE_STATUSES.has(String(gateStatuses[targetRepo] ?? ""))) {
    throw new ProfitFlywheelError("profit_flywheel_dossier_gate_missing", "Selected repo dossier lacks an explicit allowed gate status");
  }
  if (String(freshnessStatuses[targetRepo] ?? "").toLowerCase() !== "fresh") {
    throw new ProfitFlywheelError("profit_flywheel_dossier_stale", "Selected repo dossier freshness is not fresh");
  }
  const dossierReceipt = asRecord(artifactReceipts.selected_repo_dossier);
  const dossierPath = typeof dossierReceipt.path === "string" ? dossierReceipt.path : "";
  const dossier = await readJsonArtifactStrict(dossierPath, "selected repo dossier", authorityRoot);
  const dossierHash = typeof dossierReceipt.sha256 === "string" ? dossierReceipt.sha256 : "";
  assertSha256(dossierHash, "selected_repo_dossier_hash");
  if (dossier.byteHash !== dossierHash || dispatch.selected_repo_dossier_hash !== dossierHash || dispatch.selected_repo_dossier_path !== dossier.path) {
    throw new ProfitFlywheelError("profit_flywheel_dossier_hash_mismatch", "Selected repo dossier bytes/path do not match its immutable receipt");
  }
  const commercialReceipt = asRecord(artifactReceipts.commercial_gate);
  const commercialPath = typeof commercialReceipt.path === "string" ? commercialReceipt.path : "";
  const commercial = await readJsonArtifactStrict(commercialPath, "commercial gate", authorityRoot);
  if (commercial.byteHash !== commercialReceipt.sha256 || stableJson(authorization.receipt) !== stableJson(commercial.value)) {
    throw new ProfitFlywheelError("profit_flywheel_commercial_gate_receipt_mismatch", "Commercial gate bytes or inline receipt do not match the immutable binding");
  }
  const { gate_hash: _gateHash, ...commercialPayload } = commercial.value;
  if (hashProfitFlywheelValue(commercialPayload) !== commercialGateHash) {
    throw new ProfitFlywheelError("profit_flywheel_commercial_gate_hash_mismatch", "Commercial gate semantic hash does not match its signed receipt");
  }
  const commercialSummary = asRecord(commercial.value.summary);
  const dispatchSourceHashes = asRecord(dispatch.source_hashes) as Record<string, string>;
  const artifactProvenanceHashes = asRecord(dispatch.artifact_provenance_hashes);
  const dispatchStageInput = buildProfitFlywheelStageInput({ contract: input.contract, stage: "dispatch", sourceHashes: dispatchSourceHashes });
  if (dispatch.input_hash !== dispatchStageInput.inputHash || dispatch.selection_snapshot_hash !== dispatchSourceHashes.selection_hash ||
      dispatchSourceHashes.commercial_gate_hash !== commercialGateHash ||
      artifactProvenanceHashes.dispatch_schema_sha256 !== verifiedDispatchSchema.schemaHash) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_source_hash_mismatch", "Dispatch stage source_hashes/input_hash or artifact provenance differ from verified authority");
  }
  const councilDecisionValue = asRecord(dispatch.artifacts).council_decision;
  const councilDecisionPath = typeof councilDecisionValue === "string"
    ? councilDecisionValue
    : typeof asRecord(councilDecisionValue).path === "string"
      ? String(asRecord(councilDecisionValue).path)
      : selectionPath;
  const councilDecision = await readJsonArtifactStrict(councilDecisionPath, "council decision", authorityRoot);
  if (councilDecision.byteHash !== dispatchSourceHashes.decision_artifact_hash) {
    throw new ProfitFlywheelError("profit_flywheel_dispatch_decision_hash_mismatch", "Council decision bytes do not match dispatch source_hashes.decision_artifact_hash");
  }
  const commercialCounts: Record<string, number> = {
    current_market_signal_count: Array.isArray(commercialSummary.current_market_signal_ids) ? commercialSummary.current_market_signal_ids.length : -1,
    independent_voc_count: Array.isArray(commercialSummary.independent_voc_ids) ? commercialSummary.independent_voc_ids.length : -1,
    pricing_evidence_count: Array.isArray(commercialSummary.pricing_signal_ids) ? commercialSummary.pricing_signal_ids.length : -1,
    competitive_evidence_count: Array.isArray(commercialSummary.competitive_signal_ids) ? commercialSummary.competitive_signal_ids.length : -1,
    authority_evidence_count: Array.isArray(commercialSummary.authority_signal_ids) ? commercialSummary.authority_signal_ids.length : -1,
    recommendation_evidence_count: Array.isArray(commercialSummary.recommendation_signal_ids) ? commercialSummary.recommendation_signal_ids.length : -1,
  };
  const crossPlaneComparisons: Array<[string, unknown, unknown]> = [
    ["repo", commercial.value.repo, input.targetRepo ?? dispatch.target_repo_full_name],
    ["authorized", commercial.value.authorized, true],
    ["status", commercial.value.status, "authorized"],
    ["blocking_reasons", commercial.value.reasons, []],
    ["commercialization_confidence", commercial.value.commercialization_confidence, launchTarget.commercialization_confidence],
    ["authorization_confidence", authorization.commercialization_confidence, commercial.value.commercialization_confidence],
    ["identified_buyer", commercialSummary.buyer, launchTarget.identified_buyer],
    ["authorization_buyer", authorization.identified_buyer, commercialSummary.buyer],
    ["identified_approver", commercialSummary.approver, launchTarget.identified_approver],
    ["authorization_approver", authorization.identified_approver, commercialSummary.approver],
    ["commercial_recommendation", commercialSummary.recommendation, launchTarget.commercial_recommendation],
    ["cheapest_validation_step", commercialSummary.cheapest_validation_step, launchTarget.cheapest_validation_step],
    ["internet_pipes_readiness", commercialSummary.internet_pipes_readiness, launchTarget.internet_pipes_readiness],
    ["internet_pipes_missing_stations", commercialSummary.internet_pipes_missing_stations, launchTarget.internet_pipes_missing_stations],
    ["evidence_set_hash", commercial.value.evidence_set_hash, artifactProvenanceHashes.evidence_set_sha256],
    ["source_registry_set_hash", commercial.value.source_registry_set_hash, artifactProvenanceHashes.source_registry_set_sha256],
    ...Object.entries(commercialCounts).map(([field, value]) => [field, value, launchTarget[field]] as [string, unknown, unknown]),
  ];
  const drift = crossPlaneComparisons.filter(([, left, right]) => stableJson({ value: left }) !== stableJson({ value: right }));
  if (drift.length > 0) {
    throw new ProfitFlywheelError("profit_flywheel_commercial_gate_summary_drift", "Dispatch launch target/authorization claims differ from the file-backed commercial gate summary", {
      drift: drift.map(([field, authoritative, claimed]) => ({ field, authoritative, claimed })),
    });
  }
  const commercialFloors: Array<[string, number]> = [
    ["commercialization_confidence", input.contract.commercial_policy.minimum_commercialization_confidence],
    ["current_market_signal_count", input.contract.commercial_policy.minimum_current_market_signals],
    ["independent_voc_count", input.contract.commercial_policy.minimum_independent_voc_observations],
    ["pricing_evidence_count", input.contract.commercial_policy.minimum_pricing_signals],
    ["competitive_evidence_count", input.contract.commercial_policy.minimum_competitive_or_differentiation_signals],
    ["authority_evidence_count", input.contract.commercial_policy.minimum_authority_signals],
  ];
  for (const [field, floor] of commercialFloors) {
    const value = field === "commercialization_confidence"
      ? Number(commercial.value.commercialization_confidence)
      : commercialCounts[field]!;
    if (!Number.isFinite(value) || value < floor) {
      throw new ProfitFlywheelError("profit_flywheel_commercial_floor_failed", `File-backed commercial gate ${field}=${String(value)} is below ${floor}`, { field, value, floor });
    }
  }
  return { dispatch, selection, dossier, commercial, commercialGateHash, authorityRoot };
}

export function hashProfitFlywheelValue(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

const PROFIT_FLYWHEEL_DISPATCH_ISSUE_ORIGIN_KIND = "profit_flywheel_dispatch";

function dispatchIssueIdentity(input: {
  companyId: string;
  workflowId: string;
  stageRunId: string;
  inputHash: string;
}) {
  const originId = hashProfitFlywheelValue({
    schema_version: "paperclip.profit_flywheel_dispatch_issue_identity.v1",
    company_id: input.companyId,
    workflow_id: input.workflowId,
    stage_run_id: input.stageRunId,
    input_hash: input.inputHash,
  });
  return {
    schema_version: "paperclip.profit_flywheel_dispatch_issue_identity.v1",
    origin_kind: PROFIT_FLYWHEEL_DISPATCH_ISSUE_ORIGIN_KIND,
    origin_id: originId,
    description_marker: `[paperclip-profit-flywheel-dispatch:${originId}]`,
  } as const;
}

export function canonicalProfitFlywheelReceiptHash(input: Omit<ProfitFlywheelReceiptInput, "contentHash">) {
  return hashProfitFlywheelValue(input);
}

const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|authorization|auth|client[_-]?secret|token|secret|session|password|credential|cookie|jwt|private[_-]?key|recovery[_-]?(?:code|codes)|verification[_-]?(?:code|token)|phone[_-]?number|mfa|otp)(?:$|[_-])/i;
const SECRET_VALUE_PATTERN = /(?:\b(?:bearer|basic)\s+[a-z0-9._~+\-/=]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth|token|secret|password|cookie|recovery[_-]?code|verification[_-]?code|phone[_-]?number|mfa|otp)\s*[=:]\s*[^\s,;]{6,}|\bsk-[a-z0-9_-]{16,}\b|\b(?:ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b)/i;

function isSecretReceiptKey(key: string) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SECRET_KEY_PATTERN.test(normalized);
}

function sanitizeReceiptValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new ProfitFlywheelError("profit_flywheel_receipt_too_deep", "Receipt attributes exceed maximum nesting depth");
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProfitFlywheelError("profit_flywheel_receipt_invalid_number", "Receipt numbers must be finite");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 10_000) throw new ProfitFlywheelError("profit_flywheel_receipt_value_too_large", "Receipt string exceeds 10,000 characters");
    if (SECRET_VALUE_PATTERN.test(value)) throw new ProfitFlywheelError("profit_flywheel_receipt_secret_rejected", "Receipt contains secret-like material");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new ProfitFlywheelError("profit_flywheel_receipt_array_too_large", "Receipt array exceeds 1,000 items");
    return value.map((entry) => sanitizeReceiptValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretReceiptKey(key)) throw new ProfitFlywheelError("profit_flywheel_receipt_secret_key_rejected", `Receipt key ${key} is forbidden`);
      output[key] = sanitizeReceiptValue(entry, depth + 1);
    }
    return output;
  }
  throw new ProfitFlywheelError("profit_flywheel_receipt_invalid_value", "Receipt attributes must be JSON-compatible");
}

export function validateIndependentReviewResult(
  value: unknown,
  expected: {
    qaStageRunId: string;
    implementationStageRunId: string;
    implementationGitObject: string;
    implementationArtifactHash: string;
    builderProviderFamily: string;
    reviewerProviderFamily: string;
    reviewerModel: string;
    reviewerVersion: string;
    providerPolicySha256: string;
    providerPolicySchemaSha256: string;
  },
) {
  sanitizeReceiptValue(value);
  assertExecutionSchema(validateIndependentReviewResultSchema, value, "independent review result");
  const result = asRecord(value);
  assertExactObjectKeys(result, [
    "schema_version", "state", "final_disposition", "qa_stage_run_id",
    "implementation_stage_run_id", "implementation_git_object", "implementation_artifact_hash",
    "reviewer_provider_family", "reviewer_model", "reviewer_version",
    "provider_policy_sha256", "provider_policy_schema_sha256", "summary", "findings",
  ], "independent review result");
  const findings = Array.isArray(result.findings) ? result.findings : null;
  if (result.schema_version !== "paperclip.independent_review_result.v1" || result.state !== "succeeded" ||
      result.final_disposition !== "passed" || typeof result.summary !== "string" || !result.summary.trim() || !findings) {
    throw new ProfitFlywheelError(
      "profit_flywheel_independent_review_failed",
      "Independent review artifact must explicitly record state=succeeded and final_disposition=passed",
    );
  }
  if (!expected.builderProviderFamily || expected.reviewerProviderFamily === expected.builderProviderFamily) {
    throw new ProfitFlywheelError(
      "profit_flywheel_review_not_independent",
      "Independent review provider family must differ from the exact implementation builder family",
    );
  }
  const comparisons: Array<[string, unknown, unknown]> = [
    ["qa_stage_run_id", result.qa_stage_run_id, expected.qaStageRunId],
    ["implementation_stage_run_id", result.implementation_stage_run_id, expected.implementationStageRunId],
    ["implementation_git_object", result.implementation_git_object, expected.implementationGitObject],
    ["implementation_artifact_hash", result.implementation_artifact_hash, expected.implementationArtifactHash],
    ["reviewer_provider_family", result.reviewer_provider_family, expected.reviewerProviderFamily],
    ["reviewer_model", result.reviewer_model, expected.reviewerModel],
    ["reviewer_version", result.reviewer_version, expected.reviewerVersion],
    ["provider_policy_sha256", result.provider_policy_sha256, expected.providerPolicySha256],
    ["provider_policy_schema_sha256", result.provider_policy_schema_sha256, expected.providerPolicySchemaSha256],
  ];
  const drift = comparisons.filter(([, observed, required]) => observed !== required);
  if (drift.length > 0) {
    throw new ProfitFlywheelError(
      "profit_flywheel_independent_review_lineage_invalid",
      "Independent review artifact does not bind the exact QA route and implementation artifact",
      { drift: drift.map(([field, observed, required]) => ({ field, observed, required })) },
    );
  }
  const normalizedFindings = findings.map((finding, index) => {
    const row = asRecord(finding);
    assertExactObjectKeys(row, ["id", "severity", "status", "summary", "release_blocking"], `independent review findings[${index}]`);
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const severity = typeof row.severity === "string" ? row.severity.toLowerCase() : "";
    const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
    const summary = typeof row.summary === "string" ? row.summary.trim() : "";
    if (!id || !summary || !["info", "low", "medium", "high", "critical"].includes(severity) ||
        !["open", "resolved", "accepted_risk"].includes(status) || typeof row.release_blocking !== "boolean") {
      throw new ProfitFlywheelError("profit_flywheel_independent_review_schema_invalid", `Independent review finding ${index} is malformed`);
    }
    if (row.release_blocking || (["high", "critical"].includes(severity) && status !== "resolved")) {
      throw new ProfitFlywheelError(
        "profit_flywheel_independent_review_failed",
        `Independent review cannot pass with unresolved ${severity} or release-blocking finding ${id}`,
      );
    }
    return { id, severity, status, summary, release_blocking: row.release_blocking };
  });
  return {
    state: "succeeded" as const,
    finalDisposition: "passed" as const,
    summary: result.summary.trim(),
    findings: normalizedFindings,
  };
}

export function canonicalDbReceiptProof(
  receipt: typeof profitFlywheelReceipts.$inferSelect,
  now = new Date(),
) {
  if (receipt.status !== "valid" || (receipt.expiresAt && receipt.expiresAt.getTime() <= now.getTime())) {
    throw new ProfitFlywheelError(
      "profit_flywheel_outbox_receipt_expired",
      `Receipt ${receipt.receiptType}/${receipt.id} is not currently valid`,
    );
  }
  const base: Omit<ProfitFlywheelReceiptInput, "contentHash"> = {
    type: receipt.receiptType,
    schemaVersion: receipt.schemaVersion,
    artifactRef: receipt.artifactRef,
    observedAt: receipt.observedAt.toISOString(),
    expiresAt: receipt.expiresAt?.toISOString() ?? null,
    attributes: sanitizeReceiptValue(receipt.attributes) as Record<string, unknown>,
  };
  const observedHash = canonicalProfitFlywheelReceiptHash(base);
  if (observedHash !== receipt.contentHash) {
    throw new ProfitFlywheelError(
      "profit_flywheel_outbox_receipt_hash_mismatch",
      `Receipt ${receipt.receiptType}/${receipt.id} content hash does not match its canonical database body`,
      { expected: receipt.contentHash, observed: observedHash },
    );
  }
  return {
    type: base.type,
    schemaVersion: base.schemaVersion,
    contentHash: receipt.contentHash,
    artifactRef: base.artifactRef,
    observedAt: base.observedAt,
    expiresAt: base.expiresAt,
    attributes: base.attributes,
  };
}

export async function verifyArtifactReference(
  artifactRef: string,
  declaredHash: unknown,
  allowedRoots: string[],
  targetRepoRoot?: string | null,
) {
  assertSha256(String(declaredHash ?? ""), "artifact_hash");
  if (/^git:(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(artifactRef)) {
    const objectId = artifactRef.slice(4).toLowerCase();
    if (!targetRepoRoot) throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Git artifacts require the pinned target repository root");
    const repoRoot = await realpath(targetRepoRoot).catch(() => "");
    if (!repoRoot) throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Target repository root is unavailable");
    const rawObjectEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const objectType = await execFile("git", ["-C", repoRoot, "cat-file", "-t", objectId], {
      timeout: 15_000,
      env: rawObjectEnv,
    })
      .then(({ stdout }) => stdout.trim())
      .catch(() => {
        throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Git artifact id is not an object in the pinned target repository");
      });
    if (!new Set(["blob", "tree", "commit", "tag"]).has(objectType)) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", `Unsupported git object type ${objectType}`);
    }
    const objectBytes = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["-C", repoRoot, "cat-file", objectType, objectId], {
        stdio: ["ignore", "pipe", "pipe"],
        env: rawObjectEnv,
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || size > 100 * 1024 * 1024) {
          reject(new Error(Buffer.concat(errors).toString("utf8").slice(0, 500) || "git cat-file failed or exceeded 100 MiB"));
        } else resolve(Buffer.concat(chunks));
      });
    }).catch((error) => {
      throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Git artifact hash is not an object in the pinned target repository");
    });
    const canonicalObject = Buffer.concat([
      Buffer.from(`${objectType} ${objectBytes.length}\0`, "utf8"),
      objectBytes,
    ]);
    const observedHash = createHash("sha256").update(canonicalObject).digest("hex");
    if (observedHash !== String(declaredHash).toLowerCase()) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_hash_mismatch", "Git artifact canonical bytes do not match artifact_hash", {
        objectId,
        objectType,
        expected: declaredHash,
        observed: observedHash,
      });
    }
    return;
  }
  if (!path.isAbsolute(artifactRef) || artifactRef.includes("\0")) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Artifact ref must be an absolute local path or immutable git:<hash> reference");
  }
  const lexicalArtifactPath = path.resolve(artifactRef);
  const rootBindings = (await Promise.all(allowedRoots.map(async (root) => {
    const lexicalRoot = path.resolve(root);
    const canonicalRoot = await realpath(lexicalRoot).catch(() => "");
    return canonicalRoot ? { lexicalRoot, canonicalRoot } : null;
  }))).filter((binding): binding is { lexicalRoot: string; canonicalRoot: string } => Boolean(binding));
  const expectedRealpaths = rootBindings.flatMap(({ lexicalRoot, canonicalRoot }) => {
    const lexicalRelative = path.relative(lexicalRoot, lexicalArtifactPath);
    const canonicalRelative = path.relative(canonicalRoot, lexicalArtifactPath);
    const expected: string[] = [];
    if (!lexicalRelative.startsWith("..") && !path.isAbsolute(lexicalRelative)) {
      expected.push(path.resolve(canonicalRoot, lexicalRelative));
    }
    if (!canonicalRelative.startsWith("..") && !path.isAbsolute(canonicalRelative)) {
      expected.push(lexicalArtifactPath);
    }
    return expected;
  });
  if (expectedRealpaths.length === 0) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Artifact ref is outside the target repository and allowlisted immutable roots");
  }
  const resolved = await realpath(lexicalArtifactPath).catch(() => "");
  if (!resolved || !expectedRealpaths.includes(resolved)) {
    throw new ProfitFlywheelError("profit_flywheel_artifact_ref_invalid", "Artifact ref must not traverse a symlink below an allowlisted root");
  }
  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 100 * 1024 * 1024 || (before.mode & 0o222) !== 0) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_invalid", "Artifact must be a non-empty read-only regular file no larger than 100 MiB");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_toctou", "Artifact changed while its immutable hash was verified");
    }
    const observed = createHash("sha256").update(bytes).digest("hex");
    if (observed !== String(declaredHash).toLowerCase()) {
      throw new ProfitFlywheelError("profit_flywheel_artifact_hash_mismatch", "Artifact bytes do not match artifact_hash", { expected: declaredHash, observed });
    }
  } finally {
    await handle.close();
  }
}

export function workflowArtifactRoots(workflow: typeof profitFlywheelWorkflows.$inferSelect) {
  const targetRepoRoot = workflow.targetWorkspaceRoot;
  const feedbackServerRoot = asRecord(workflow.feedback).server_artifact_root;
  const serverArtifactRoot = path.resolve(
    typeof feedbackServerRoot === "string" && path.isAbsolute(feedbackServerRoot)
      ? feedbackServerRoot
      : process.env.PAPERCLIP_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT ?? DEFAULT_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT,
  );
  const configured = (process.env.PAPERCLIP_PROFIT_FLYWHEEL_ARTIFACT_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    targetRepoRoot,
    allowedArtifactRoots: [
      path.resolve(process.env.PAPERCLIP_PORTFOLIO_OS_AUTHORITY_ROOT ?? DEFAULT_PORTFOLIO_OS_AUTHORITY_ROOT),
      ...(targetRepoRoot ? [targetRepoRoot] : []),
      serverArtifactRoot,
      ...configured.map((value) => path.resolve(value)),
    ],
  };
}

function safeProfitFlywheelArtifactSegment(value: string, label: string) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value) || value === "." || value === "..") {
    throw new ProfitFlywheelError(
      "profit_flywheel_artifact_path_invalid",
      `Profit Flywheel ${label} is not a safe artifact path segment`,
    );
  }
  return value;
}

function profitFlywheelAttemptArtifactDirectory(
  workflow: typeof profitFlywheelWorkflows.$inferSelect,
  stageRun: typeof profitFlywheelStageRuns.$inferSelect,
  artifactKind: "adjudications" | "checkpoints",
) {
  const feedbackServerRoot = asRecord(workflow.feedback).server_artifact_root;
  const serverArtifactRoot = path.resolve(
    typeof feedbackServerRoot === "string" && path.isAbsolute(feedbackServerRoot)
      ? feedbackServerRoot
      : process.env.PAPERCLIP_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT ?? DEFAULT_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT,
  );
  return path.join(
    serverArtifactRoot,
    safeProfitFlywheelArtifactSegment(stageRun.companyId, "company id"),
    safeProfitFlywheelArtifactSegment(stageRun.workflowId, "workflow id"),
    safeProfitFlywheelArtifactSegment(stageRun.id, "stage run id"),
    `attempt-${stageRun.attemptCount}`,
    artifactKind,
  );
}

export function buildProfitFlywheelIdempotencyKey(input: {
  companyId: string;
  runId: string;
  stage: ProfitFlywheelStage;
  inputHash: string;
}) {
  return `${input.companyId}+${input.runId}+${input.stage}+${input.inputHash}`;
}

function traceId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function spanId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function assertSha256(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ProfitFlywheelError("profit_flywheel_invalid_hash", `${field} must be a SHA-256 hex digest`, { field });
  }
}

export function buildProfitFlywheelStageInput(input: {
  contract: PortfolioOsProfitFlywheelContractV2;
  stage: ProfitFlywheelStage;
  sourceHashes: Record<string, string>;
}) {
  const expectedFields = input.contract.stages[input.stage].input_hash_fields;
  const observedFields = Object.keys(input.sourceHashes).sort();
  if (stableJson([...expectedFields].sort()) !== stableJson(observedFields)) {
    throw new ProfitFlywheelError("profit_flywheel_source_hash_fields_invalid", `${input.stage} source_hashes do not exactly match the frozen contract`, {
      expectedFields,
      observedFields,
    });
  }
  const sourceHashes = Object.fromEntries(expectedFields.map((field) => {
    const value = input.sourceHashes[field]?.toLowerCase();
    if (!value || !/^[a-f0-9]{64}$/.test(value)) {
      throw new ProfitFlywheelError("profit_flywheel_source_hash_invalid", `${input.stage}.source_hashes.${field} must be lowercase SHA-256`);
    }
    return [field, value];
  }));
  return { sourceHashes, inputHash: hashProfitFlywheelValue(sourceHashes) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stageDefinition(contract: PortfolioOsProfitFlywheelContractV2, stage: ProfitFlywheelStage) {
  return contract.stages[stage];
}

function assertTransition(
  contract: PortfolioOsProfitFlywheelContractV2,
  stage: ProfitFlywheelStage,
  from: CanonicalRunState,
  to: CanonicalRunState,
) {
  if (from === to) return;
  const allowed = contract.stages[stage].run_state_transitions[from];
  if (!allowed.includes(to as never)) {
    throw new ProfitFlywheelError(
      "profit_flywheel_illegal_transition",
      `Illegal ${stage} transition ${from} -> ${to}`,
      { stage, from, to, allowed },
    );
  }
}

function requireBlocker(input: Partial<Blocker>): Blocker {
  const fields: Array<keyof Blocker> = ["blockerCode", "blockerDetail", "nextOwner", "resumeCondition"];
  for (const field of fields) {
    if (typeof input[field] !== "string" || !input[field]!.trim()) {
      throw new ProfitFlywheelError("profit_flywheel_incomplete_blocker", `Blocked state requires ${field}`, { field });
    }
  }
  const blockerCode = input.blockerCode!.trim();
  const nextOwner = input.nextOwner!.trim();
  if (blockerCode.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(blockerCode) || SECRET_VALUE_PATTERN.test(blockerCode)) {
    throw new ProfitFlywheelError("profit_flywheel_invalid_blocker_code", "blockerCode must be a bounded non-secret machine identifier");
  }
  if (nextOwner.length > 200 || /[\u0000-\u001f\u007f]/.test(nextOwner) || SECRET_VALUE_PATTERN.test(nextOwner)) {
    throw new ProfitFlywheelError("profit_flywheel_invalid_next_owner", "nextOwner must be bounded and contain no secret-like material");
  }
  const safeNarrative = (value: string, field: string) => {
    const normalized = value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    if (SECRET_VALUE_PATTERN.test(normalized)) return `[REDACTED: secret-like ${field} rejected]`;
    return normalized.slice(0, 2000);
  };
  return {
    blockerCode,
    blockerDetail: safeNarrative(input.blockerDetail!, "blocker detail"),
    nextOwner,
    resumeCondition: safeNarrative(input.resumeCondition!, "resume condition"),
  };
}

function safeOperationalError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (SECRET_VALUE_PATTERN.test(raw)) return "[REDACTED: secret-like error detail rejected]";
  return raw.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 2000) || "Unspecified operational failure";
}

function canonicalPublicRepoOrigin(raw: string) {
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE_PATTERN.test(value) || /[?#]/.test(value)) {
    throw new ProfitFlywheelError("profit_flywheel_repo_origin_unsafe", "Repository origin must be a bounded public URL without controls, query, fragment, or secret-like material");
  }
  const scp = value.match(/^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/);
  if (scp) return `git@${scp[1]!.toLowerCase()}:${scp[2]!.replace(/^\/+/, "")}`;
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new ProfitFlywheelError("profit_flywheel_repo_origin_unsafe", "Repository origin must be an absolute https, ssh, or file URL");
  }
  if (!new Set(["https:", "ssh:", "file:"]).has(parsed.protocol) || parsed.password || parsed.search || parsed.hash ||
      (parsed.username && !(parsed.protocol === "ssh:" && parsed.username === "git"))) {
    throw new ProfitFlywheelError("profit_flywheel_repo_origin_unsafe", "Repository origin contains credentials or unsupported URL components");
  }
  if (parsed.protocol === "file:" && (parsed.username || parsed.password || parsed.host || !path.isAbsolute(parsed.pathname))) {
    throw new ProfitFlywheelError("profit_flywheel_repo_origin_unsafe", "File repository origin must be a credential-free absolute local URL");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.href;
}

function canonicalRepositoryRemote(raw: string) {
  const canonical = canonicalPublicRepoOrigin(raw);
  const scp = canonical.match(/^git@([A-Za-z0-9.-]+):(.+)$/);
  if (scp) {
    const repositoryPath = scp[2]!.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `ssh://git@${scp[1]!.toLowerCase()}/${repositoryPath}`;
  }
  const parsed = new URL(canonical);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  return parsed.href.replace(/\/$/, "");
}

/**
 * Proves that a prepared workspace is backed by the exact authorized remote
 * branch and immutable base object. This is deliberately read-only: dispatch
 * ingestion must never fetch, checkout, reset, or otherwise rewrite a user's
 * repository while establishing authority.
 */
export async function verifyAuthorizedGitWorkspace(input: {
  workspaceRoot: string;
  expectedOriginUrl: string;
  baseBranch: string;
  baseSha: string;
}) {
  const workspaceRoot = await realpath(input.workspaceRoot).catch(() => "");
  if (!workspaceRoot || workspaceRoot !== path.resolve(input.workspaceRoot)) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_invalid", "Authorized Git workspace must be an existing canonical non-symlink directory");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.baseSha)) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_base_invalid", "Authorized Git base object must be a full 40- or 64-character object id");
  }
  await execFile("git", ["check-ref-format", "--branch", input.baseBranch], {
    cwd: workspaceRoot,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }).catch(() => {
    throw new ProfitFlywheelError("profit_flywheel_workspace_base_branch_invalid", "Authorized Git base branch is not a valid branch name");
  });
  const actualOrigins = await execFile("git", ["-C", workspaceRoot, "remote", "get-url", "--all", "origin"], {
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }).then(({ stdout }) => stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)).catch(() => [] as string[]);
  const expectedFetchUrl = canonicalPublicRepoOrigin(input.expectedOriginUrl);
  const expectedOrigin = canonicalRepositoryRemote(expectedFetchUrl);
  if (actualOrigins.length === 0 || actualOrigins.some((origin) => canonicalRepositoryRemote(origin) !== expectedOrigin)) {
    throw new ProfitFlywheelError(
      "profit_flywheel_workspace_origin_mismatch",
      "Workspace origin does not match the repository origin authorized by the bound project and dispatch",
    );
  }
  const remoteRef = `refs/heads/${input.baseBranch}`;
  const remoteLine = await execFile("git", ["-C", workspaceRoot, "ls-remote", "--heads", "--exit-code", expectedFetchUrl, remoteRef], {
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }).then(({ stdout }) => stdout.trim()).catch(() => "");
  const remoteMatches = remoteLine.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === remoteRef);
  if (remoteMatches.length !== 1 || !/^[a-f0-9]{40,64}$/i.test(remoteMatches[0]![0]!)) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_remote_base_unavailable", "Authorized remote base branch could not be resolved exactly and non-interactively");
  }
  const remoteBase = remoteMatches[0]![0]!.toLowerCase();
  const declaredBase = input.baseSha.toLowerCase();
  if (remoteBase !== declaredBase) {
    throw new ProfitFlywheelError(
      "profit_flywheel_workspace_remote_base_drift",
      "Authorized remote base branch no longer resolves to the dispatch base object",
      { declaredBase, remoteBase },
    );
  }
  const workspaceHead = await execFile("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], { timeout: 15_000 })
    .then(({ stdout }) => stdout.trim().toLowerCase()).catch(() => "");
  if (!workspaceHead || workspaceHead !== declaredBase) {
    throw new ProfitFlywheelError(
      "profit_flywheel_workspace_base_drift",
      "Execution workspace HEAD does not match the authorized dispatch base object",
      { declaredBase, workspaceHead },
    );
  }
  const finalOrigins = await execFile("git", ["-C", workspaceRoot, "remote", "get-url", "--all", "origin"], {
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  }).then(({ stdout }) => stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)).catch(() => [] as string[]);
  if (finalOrigins.length === 0 || finalOrigins.some((origin) => canonicalRepositoryRemote(origin) !== expectedOrigin)) {
    throw new ProfitFlywheelError("profit_flywheel_workspace_origin_race", "Workspace origin changed while its captured remote URL and base object were being verified");
  }
  return { workspaceRoot, origin: expectedOrigin, baseBranch: input.baseBranch, baseObject: workspaceHead, remoteBaseObject: remoteBase };
}

function assertExpectedLease(stageRun: typeof profitFlywheelStageRuns.$inferSelect, expected: ExpectedLease) {
  if (
    stageRun.leaseOwner !== expected.leaseOwner ||
    stageRun.leaseActorType !== expected.actorType ||
    stageRun.leaseActorId !== expected.actorId
  ) {
    throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage lease owner or persisted actor changed before mutation");
  }
}

function expectedLeaseConditions(expected: ExpectedLease) {
  return [
    expected.leaseOwner === null ? isNull(profitFlywheelStageRuns.leaseOwner) : eq(profitFlywheelStageRuns.leaseOwner, expected.leaseOwner),
    expected.actorType === null ? isNull(profitFlywheelStageRuns.leaseActorType) : eq(profitFlywheelStageRuns.leaseActorType, expected.actorType),
    expected.actorId === null ? isNull(profitFlywheelStageRuns.leaseActorId) : eq(profitFlywheelStageRuns.leaseActorId, expected.actorId),
  ];
}

async function lockProfitFlywheelStageRun(tx: Db, stageRunId: string) {
  await tx.select({ id: profitFlywheelStageRuns.id })
    .from(profitFlywheelStageRuns)
    .where(eq(profitFlywheelStageRuns.id, stageRunId))
    .for("update");
}

async function lockProfitFlywheelEvent(tx: Db, eventId: string) {
  await tx.select({ id: profitFlywheelEvents.id })
    .from(profitFlywheelEvents)
    .where(eq(profitFlywheelEvents.id, eventId))
    .for("update");
}

function stageCapabilityAlias(value: string): ProfitFlywheelCapabilityAlias | null {
  return (PROFIT_FLYWHEEL_CAPABILITY_ALIASES as readonly string[]).includes(value)
    ? value as ProfitFlywheelCapabilityAlias
    : null;
}

function assertContractBudgetsMatchProviderPolicy(
  contract: PortfolioOsProfitFlywheelContractV2,
  policy: ProviderPolicyV2,
) {
  for (const stage of PROFIT_FLYWHEEL_STAGES) {
    const definition = contract.stages[stage];
    const alias = stageCapabilityAlias(definition.provider_capability_class);
    if (!alias) continue;
    const aliasPolicy = policy.aliases[alias];
    const budget = policy.budgetClasses[aliasPolicy.budgetClass];
    const expected = {
      turns: budget.maxTurns,
      context_chars: budget.maxContextChars,
      output_chars: budget.maxOutputChars,
      token_limit: budget.maxTotalTokens,
      tool_output_bytes: budget.toolOutput.maxBytes,
      tool_output_lines: budget.toolOutput.maxLines,
      tool_output_line_chars: budget.toolOutput.maxLineLength,
      max_escalations: budget.maxEscalations,
    };
    if (hashProfitFlywheelValue(definition.budgets) !== hashProfitFlywheelValue(expected)) {
      throw new ProfitFlywheelError(
        "profit_flywheel_budget_authority_mismatch",
        `Stage ${stage} budgets conflict with provider-policy alias ${alias}/${aliasPolicy.budgetClass}`,
        { stage, alias, budgetClass: aliasPolicy.budgetClass, expected, observed: definition.budgets },
      );
    }
  }
}

function isTerminalState(state: string) {
  return ["succeeded", "failed", "cancelled", "safely_skipped"].includes(state);
}

function hasValue(records: Record<string, unknown>[], key: string) {
  return records.some((record) => {
    const value = record[key];
    if (value === true) return true;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value as object).length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    return false;
  });
}

function requiredReceiptAttributes(
  receipts: Array<typeof profitFlywheelReceipts.$inferSelect>,
  receiptType: string,
) {
  const receipt = receipts.find((candidate) => candidate.receiptType === receiptType);
  if (!receipt) {
    throw new ProfitFlywheelError("profit_flywheel_missing_required_receipt", `Missing ${receiptType}`);
  }
  return { receipt, attributes: asRecord(receipt.attributes) };
}

function requireStringField(attributes: Record<string, unknown>, field: string, receiptType: string) {
  const value = attributes[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", `${receiptType}.${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireShaField(attributes: Record<string, unknown>, field: string, receiptType: string) {
  const value = requireStringField(attributes, field, receiptType);
  assertSha256(value.replace(/^sha256:/, ""), `${receiptType}.${field}`);
  return value;
}

function requireGitOrSha256Field(attributes: Record<string, unknown>, field: string, receiptType: string) {
  const value = requireStringField(attributes, field, receiptType).replace(/^(?:sha256|git):/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw new ProfitFlywheelError("profit_flywheel_invalid_hash", `${receiptType}.${field} must be a Git object id or SHA-256`);
  }
  return value;
}

function testResultsPassed(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => {
    const record = asRecord(entry);
    return typeof record.command === "string" && record.command.trim().length > 0 &&
      record.exit_code === 0 && record.status === "passed" &&
      typeof record.artifact_ref === "string" && record.artifact_ref.length > 0 &&
      typeof record.artifact_hash === "string" && /^[a-f0-9]{64}$/.test(record.artifact_hash);
  });
}

const RECEIPT_EVIDENCE_OWNERS: Record<string, string[]> = {
  changed_files: ["implementation_receipt"],
  target_commit_or_patch_hash: ["implementation_receipt"],
  final_response: ["implementation_receipt"],
  test_commands: ["qa_receipt"],
  test_results: ["implementation_receipt", "qa_receipt"],
  review_provider_family: ["independent_review_receipt"],
  release_status: ["release_receipt"],
  metric_name: ["commercial_observation_receipt"],
  baseline: ["commercial_observation_receipt"],
  observed_value: ["commercial_observation_receipt"],
  measurement_window: ["commercial_observation_receipt"],
  measured_external_or_operational_evidence: ["learning_receipt"],
  validation_outcome_hash: ["learning_receipt"],
  learning_receipt_hash: ["learning_receipt"],
  next_research_authority_sha256: ["learning_receipt"],
};

const ATTEMPT_SCOPED_EXECUTION_RECEIPTS = new Set([
  "issue_receipt",
  "provider_run_receipt",
  "implementation_receipt",
  "qa_receipt",
  "qa_failure_receipt",
  "independent_review_receipt",
  "release_receipt",
  "measured_source_receipt",
]);

export function validateReceiptTypeAttributes(receiptType: string, attributes: Record<string, unknown>, artifactRef: string | null) {
  for (const [field, owners] of Object.entries(RECEIPT_EVIDENCE_OWNERS)) {
    if (field in attributes && !owners.includes(receiptType)) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_evidence_misplaced", `${field} belongs on ${owners.join(" or ")}, not ${receiptType}`);
    }
  }
  if (receiptType === "implementation_receipt") {
    if (!Array.isArray(attributes.changed_files) || attributes.changed_files.length === 0) throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "implementation_receipt.changed_files is required");
    requireGitOrSha256Field(attributes, "target_commit_or_patch_hash", receiptType);
    requireShaField(attributes, "artifact_hash", receiptType);
    if (!artifactRef) throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "implementation_receipt requires an immutable artifactRef");
    requireStringField(attributes, "final_response", receiptType);
    if (!testResultsPassed(attributes.test_results)) throw new ProfitFlywheelError("profit_flywheel_tests_not_passing", "Implementation tests must explicitly pass");
  } else if (receiptType === "provider_run_receipt") {
    for (const field of ["provider_route_id", "provider_route_core_sha256", "provider_route_sha256", "provider_family", "model", "provider_version", "provider_policy_sha256", "provider_policy_schema_sha256", "final_response_sha256", "artifact_hash"]) {
      requireStringField(attributes, field, receiptType);
    }
    requireShaField(attributes, "provider_policy_sha256", receiptType);
    requireShaField(attributes, "provider_policy_schema_sha256", receiptType);
    requireShaField(attributes, "provider_route_core_sha256", receiptType);
    requireShaField(attributes, "provider_route_sha256", receiptType);
    requireShaField(attributes, "final_response_sha256", receiptType);
    requireShaField(attributes, "artifact_hash", receiptType);
    const usage = asRecord(attributes.usage);
    if (Number(usage.input_tokens) <= 0 || Number(usage.output_tokens) <= 0) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "provider_run_receipt requires nonzero normalized input/output usage");
    }
  } else if (receiptType === "qa_receipt") {
    if (!Array.isArray(attributes.test_commands) || attributes.test_commands.length === 0 || !testResultsPassed(attributes.test_results)) {
      throw new ProfitFlywheelError("profit_flywheel_tests_not_passing", "QA receipt requires commands and explicit passing results");
    }
    for (const field of [
      "implementation_stage_run_id", "implementation_git_object", "implementation_artifact_hash",
      "builder_provider_family", "reviewer_provider_family", "reviewer_model", "reviewer_version",
      "reviewer_policy_sha256", "reviewer_policy_schema_sha256", "independent_review_artifact_ref",
      "independent_review_artifact_hash", "independent_review_final_disposition",
    ]) requireStringField(attributes, field, receiptType);
    if (attributes.builder_provider_family === attributes.reviewer_provider_family || attributes.independent_review_final_disposition !== "passed") {
      throw new ProfitFlywheelError("profit_flywheel_review_not_independent", "QA receipt requires a passed review from a different provider family");
    }
    for (const field of ["implementation_artifact_hash", "reviewer_policy_sha256", "reviewer_policy_schema_sha256", "independent_review_artifact_hash"]) {
      requireShaField(attributes, field, receiptType);
    }
  } else if (receiptType === "qa_failure_receipt") {
    if (attributes.failure_class !== "product_test_failure") {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "qa_failure_receipt.failure_class must be product_test_failure");
    }
    requireShaField(attributes, "qa_failure_hash", receiptType);
    requireShaField(attributes, "artifact_hash", receiptType);
    if (!artifactRef || !Array.isArray(attributes.failed_test_commands) || attributes.failed_test_commands.length === 0) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "QA product failure requires an immutable failed-test artifact and commands");
    }
    const results = Array.isArray(attributes.failed_test_results) ? attributes.failed_test_results : [];
    if (results.length === 0 || !results.some((value) => {
      const row = asRecord(value);
      return row.passed === false || ["failed", "failure", "error"].includes(String(row.status ?? "").toLowerCase());
    })) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "qa_failure_receipt must contain an explicit product test failure result");
    }
  } else if (receiptType === "independent_review_receipt") {
    requireStringField(attributes, "review_provider_family", receiptType);
    for (const field of [
      "review_model", "review_version", "review_policy_sha256", "review_policy_schema_sha256",
      "builder_provider_family", "implementation_stage_run_id", "implementation_git_object",
      "implementation_artifact_hash", "artifact_hash", "review_status", "final_disposition", "review_summary",
    ]) requireStringField(attributes, field, receiptType);
    if (attributes.review_provider_family === attributes.builder_provider_family || attributes.review_status !== "succeeded" || attributes.final_disposition !== "passed") {
      throw new ProfitFlywheelError("profit_flywheel_review_not_independent", "Independent review receipt is not an explicit cross-family passing result");
    }
    for (const field of ["review_policy_sha256", "review_policy_schema_sha256", "implementation_artifact_hash", "artifact_hash"]) {
      requireShaField(attributes, field, receiptType);
    }
  } else if (receiptType === "release_receipt") {
    requireShaField(attributes, "artifact_hash", receiptType);
    const status = requireStringField(attributes, "release_status", receiptType).toLowerCase();
    if (!artifactRef || !["passed", "released", "deployed", "published", "verified"].includes(status)) {
      throw new ProfitFlywheelError("profit_flywheel_release_not_artifact_backed", "Release receipt requires an immutable artifact and passing status");
    }
    for (const field of [
      "qa_stage_run_id", "qa_receipt_hash", "qa_execution_receipt_ref", "qa_execution_receipt_hash",
      "implementation_stage_run_id", "implementation_git_object", "implementation_artifact_hash",
      "builder_provider_family", "reviewer_provider_family", "independent_review_artifact_ref",
      "independent_review_artifact_hash", "remote_origin_url", "remote_ref", "remote_object",
      "remote_attestation_method", "verified_at",
    ]) requireStringField(attributes, field, receiptType);
    for (const field of [
      "qa_receipt_hash", "qa_execution_receipt_hash", "implementation_artifact_hash", "independent_review_artifact_hash",
    ]) requireShaField(attributes, field, receiptType);
    if (attributes.builder_provider_family === attributes.reviewer_provider_family ||
        attributes.remote_attestation_method !== "git ls-remote --exit-code origin <authorized-ref>" ||
        !Number.isFinite(Date.parse(String(attributes.verified_at)))) {
      throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Release receipt lacks cross-family QA lineage or remote ls-remote attestation");
    }
  } else if (receiptType === "commercial_observation_receipt") {
    for (const field of ["metric_name", "baseline", "observed_value", "measurement_window"]) {
      if (!hasValue([attributes], field)) throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", `commercial_observation_receipt.${field} is required`);
    }
    requireShaField(attributes, "source_artifact_hash", receiptType);
    requireShaField(attributes, "artifact_hash", receiptType);
    if (!artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "commercial_observation_receipt requires an immutable artifactRef");
    }
  } else if (receiptType === "execution_adjudication_receipt") {
    assertExactObjectKeys(attributes, [
      "stage_run_id", "attempt", "input_hash", "heartbeat_run_id", "provider_route_id",
      "observed_outcome", "process_exit_code", "final_response_complete", "false_success",
      "adjudication_source", "artifact_hash",
    ], receiptType);
    for (const field of ["stage_run_id", "input_hash", "heartbeat_run_id", "provider_route_id", "observed_outcome"]) {
      requireStringField(attributes, field, receiptType);
    }
    requireShaField(attributes, "input_hash", receiptType);
    requireShaField(attributes, "artifact_hash", receiptType);
    if (!Number.isInteger(attributes.attempt) || Number(attributes.attempt) < 1 ||
        !(attributes.process_exit_code === null || Number.isInteger(attributes.process_exit_code)) ||
        typeof attributes.final_response_complete !== "boolean" || typeof attributes.false_success !== "boolean" ||
        attributes.adjudication_source !== "paperclip_server_observed_heartbeat" ||
        attributes.false_success !== (attributes.process_exit_code === 0 && attributes.final_response_complete === false) || !artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "execution_adjudication_receipt has invalid attempt, exit/final, source, or artifact evidence");
    }
  } else if (receiptType === "measured_source_receipt") {
    requireShaField(attributes, "artifact_hash", receiptType);
    requireShaField(attributes, "source_execution_receipt_sha256", receiptType);
    for (const field of ["workflow_id", "stage_run_id", "linked_issue_id", "release_artifact_ref", "release_artifact_hash"]) {
      requireStringField(attributes, field, receiptType);
    }
    requireShaField(attributes, "release_artifact_hash", receiptType);
    if (!artifactRef) throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "measured_source_receipt requires an immutable artifactRef");
    const measurement = asRecord(attributes.measurement);
    for (const field of ["metric_name", "metric_unit", "measurement_window_start", "measurement_window_end"]) {
      requireStringField(measurement, field, `${receiptType}.measurement`);
    }
    if (!Number.isFinite(Number(measurement.baseline_value)) || !Number.isFinite(Number(measurement.observed_value))) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "measured_source_receipt measurement values must be finite numbers");
    }
    const windowStart = new Date(String(measurement.measurement_window_start));
    const windowEnd = new Date(String(measurement.measurement_window_end));
    if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowEnd < windowStart) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "measured_source_receipt measurement window is invalid");
    }
  } else if (receiptType === "learning_receipt") {
    if (attributes.measured_external_or_operational_evidence !== true || !artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_learning_not_measured", "Learning receipt requires measured evidence and immutable source artifact");
    }
    const artifactHash = requireShaField(attributes, "artifact_hash", receiptType);
    requireShaField(attributes, "source_artifact_hash", receiptType);
    requireShaField(attributes, "validation_outcome_hash", receiptType);
    if (requireShaField(attributes, "learning_receipt_hash", receiptType) !== artifactHash) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "learning_receipt_hash must equal the immutable learning artifact hash");
    }
    requireStringField(attributes, "next_research_authority_ref", receiptType);
    requireShaField(attributes, "next_research_authority_sha256", receiptType);
    requireShaField(attributes, "next_research_payload_sha256", receiptType);
    for (const field of ["next_research_not_before", "next_research_expires_at"]) {
      if (!Number.isFinite(Date.parse(requireStringField(attributes, field, receiptType)))) {
        throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", `learning_receipt.${field} must be a valid date-time`);
      }
    }
  }
}

export async function assertCompletionEvidence(input: {
  executor: Db;
  workflow: typeof profitFlywheelWorkflows.$inferSelect;
  contract: PortfolioOsProfitFlywheelContractV2;
  stage: ProfitFlywheelStage;
  stageRun: typeof profitFlywheelStageRuns.$inferSelect;
  receipts: Array<typeof profitFlywheelReceipts.$inferSelect>;
  now: Date;
  builderProviderFamily?: string | null;
  allowedArtifactRoots: string[];
  targetRepoRoot?: string | null;
}) {
  const definition = stageDefinition(input.contract, input.stage);
  const validReceipts = input.receipts.filter((receipt) =>
    receipt.status === "valid" &&
    (!ATTEMPT_SCOPED_EXECUTION_RECEIPTS.has(receipt.receiptType) || asRecord(receipt.attributes).attempt === input.stageRun.attemptCount) &&
    (!receipt.expiresAt || receipt.expiresAt > input.now) &&
    receipt.observedAt <= new Date(input.now.getTime() + input.contract.commercial_policy.future_evidence_tolerance_seconds * 1000) &&
    receipt.observedAt >= new Date(input.now.getTime() - definition.freshness_limit_seconds * 1000));
  for (const receipt of validReceipts) canonicalDbReceiptProof(receipt, input.now);
  const missingReceipts = definition.required_receipts.filter((receiptType) =>
    !validReceipts.some((receipt) => receipt.receiptType === receiptType));
  if (missingReceipts.length > 0) {
    throw new ProfitFlywheelError(
      "profit_flywheel_missing_required_receipt",
      `${input.stage} is incomplete: missing fresh valid receipts ${missingReceipts.join(", ")}`,
      { stage: input.stage, missingReceipts, nextOwner: definition.owner_plane },
    );
  }

  if (input.stage === "dispatch") {
    const dispatchReceipt = validReceipts.find((receipt) => receipt.receiptType === "immutable_dispatch_artifact") ?? null;
    const authorizationReceipt = validReceipts.find((receipt) => receipt.receiptType === "portfolio_os_dispatch_authorization") ?? null;
    const attributes = asRecord(dispatchReceipt?.attributes);
    const dispatchHash = String(attributes.dispatch_hash ?? "").toLowerCase();
    const artifactHash = String(attributes.artifact_hash ?? "").toLowerCase();
    const authoringInputs = asRecord(attributes.authoring_inputs);
    if (!dispatchReceipt?.artifactRef || !authorizationReceipt?.artifactRef ||
        dispatchReceipt.artifactRef !== authorizationReceipt.artifactRef ||
        !/^[a-f0-9]{64}$/.test(dispatchHash) || artifactHash !== dispatchHash ||
        attributes.workflow_id !== input.workflow.id || attributes.stage_run_id !== input.stageRun.id ||
        attributes.input_hash !== input.stageRun.inputHash ||
        stableJson(authoringInputs) !== stableJson(input.stageRun.sourceHashes) ||
        (input.stageRun.linkedIssueId && attributes.issue_id !== input.stageRun.linkedIssueId)) {
      throw new ProfitFlywheelError(
        "profit_flywheel_dispatch_iteration_binding_invalid",
        "Dispatch receipts must bind the exact stage/input authoring vector, issue, and one newly authored immutable dispatch artifact",
      );
    }
    await verifyArtifactReference(
      dispatchReceipt.artifactRef,
      dispatchHash,
      input.allowedArtifactRoots,
      input.targetRepoRoot,
    );
  }

  if (["implementation", "qa", "release"].includes(input.stage)) {
    const { receipt: providerReceipt, attributes } = requiredReceiptAttributes(validReceipts, "provider_run_receipt");
    const policy = await loadProviderPolicyV2();
    const usage = asRecord(attributes.usage);
    const routeSnapshot = asRecord(input.stageRun.providerRouteSnapshot);
    if (!providerReceipt.artifactRef || attributes.provider_route_id !== input.stageRun.providerRouteId ||
        attributes.provider_route_core_sha256 !== input.stageRun.providerRouteCoreSha256 ||
        attributes.provider_route_sha256 !== input.stageRun.providerRouteSha256 ||
        providerPolicyRouteCoreSha256(routeSnapshot) !== input.stageRun.providerRouteCoreSha256 ||
        completionCanaryRouteSha256(routeSnapshot) !== input.stageRun.providerRouteSha256 ||
        attributes.provider_family !== input.stageRun.providerFamily || attributes.model !== input.stageRun.providerModel ||
        attributes.provider_version !== input.stageRun.providerModelVersion ||
        attributes.provider_policy_sha256 !== policy.sha256 || attributes.provider_policy_schema_sha256 !== policy.schemaSha256 ||
        input.stageRun.providerPolicySha256 !== policy.sha256 || Number(usage.input_tokens) <= 0 || Number(usage.output_tokens) <= 0) {
      throw new ProfitFlywheelError("profit_flywheel_provider_receipt_mismatch", "Provider run receipt does not match the selected exact route/model/version/policy and nonzero server-observed usage");
    }
    requireShaField(attributes, "final_response_sha256", "provider_run_receipt");
    await verifyArtifactReference(providerReceipt.artifactRef, requireShaField(attributes, "artifact_hash", "provider_run_receipt"), input.allowedArtifactRoots, input.targetRepoRoot);
  }

  if (input.stage === "implementation") {
    if (!input.stageRun.linkedIssueId) {
      throw new ProfitFlywheelError("profit_flywheel_issue_required", "Implementation cannot complete without a linked issue");
    }
    const { receipt: implementationReceipt, attributes } = requiredReceiptAttributes(validReceipts, "implementation_receipt");
    if (!Array.isArray(attributes.changed_files) || attributes.changed_files.length === 0 || !attributes.changed_files.every((value) => typeof value === "string" && value.trim())) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "implementation_receipt.changed_files must list changed paths");
    }
    requireGitOrSha256Field(attributes, "target_commit_or_patch_hash", "implementation_receipt");
    const finalResponse = requireStringField(attributes, "final_response", "implementation_receipt");
    if (!finalResponse?.trim() || /^<[^>]*tool_calls>[^]*<\/[^>]*tool_calls>\s*$/i.test(finalResponse.trim())) {
      throw new ProfitFlywheelError("profit_flywheel_incomplete_final_response", "Tool-call-only or missing assistant output is not final");
    }
    if (!testResultsPassed(attributes.test_results)) {
      throw new ProfitFlywheelError("profit_flywheel_tests_not_passing", "implementation_receipt.test_results must contain only explicit passing results");
    }
    if (!implementationReceipt.artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_implementation_artifact_invalid", "Implementation requires an immutable mutation artifact reference");
    }
    await verifyArtifactReference(
      implementationReceipt.artifactRef,
      requireShaField(attributes, "artifact_hash", "implementation_receipt"),
      input.allowedArtifactRoots,
      input.targetRepoRoot,
    );
  }
  if (input.stage === "qa") {
    const { receipt: qaReceipt, attributes: qa } = requiredReceiptAttributes(validReceipts, "qa_receipt");
    const { receipt: reviewReceipt, attributes: review } = requiredReceiptAttributes(validReceipts, "independent_review_receipt");
    if (!Array.isArray(qa.test_commands) || qa.test_commands.length === 0 || !qa.test_commands.every((value) => typeof value === "string" && value.trim())) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_schema_invalid", "qa_receipt.test_commands must list executed commands");
    }
    if (!testResultsPassed(qa.test_results)) {
      throw new ProfitFlywheelError("profit_flywheel_tests_not_passing", "qa_receipt.test_results must contain only explicit passing results");
    }
    const reviewerFamily = requireStringField(review, "review_provider_family", "independent_review_receipt");
    if (!input.builderProviderFamily || !reviewerFamily || reviewerFamily === input.builderProviderFamily) {
      throw new ProfitFlywheelError("profit_flywheel_review_not_independent", "QA reviewer provider family must be persisted and differ from the implementation builder family", {
        builderProviderFamily: input.builderProviderFamily ?? null,
        reviewerFamily: reviewerFamily ?? null,
      });
    }
    const implementationStageRunId = requireStringField(qa, "implementation_stage_run_id", "qa_receipt");
    const implementationGitObject = requireStringField(qa, "implementation_git_object", "qa_receipt");
    const implementationArtifactHash = requireShaField(qa, "implementation_artifact_hash", "qa_receipt");
    const reviewArtifactRef = requireStringField(qa, "independent_review_artifact_ref", "qa_receipt");
    const reviewArtifactHash = requireShaField(qa, "independent_review_artifact_hash", "qa_receipt");
    const builderStage = await input.executor.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.id, implementationStageRunId),
      eq(profitFlywheelStageRuns.workflowId, input.stageRun.workflowId),
      eq(profitFlywheelStageRuns.stage, "implementation"),
      eq(profitFlywheelStageRuns.state, "succeeded"),
    )).then((rows) => rows[0] ?? null);
    if (!builderStage || builderStage.providerFamily !== input.builderProviderFamily ||
        reviewReceipt.artifactRef !== reviewArtifactRef || review.artifact_hash !== reviewArtifactHash ||
        review.implementation_stage_run_id !== implementationStageRunId || review.implementation_git_object !== implementationGitObject ||
        review.implementation_artifact_hash !== implementationArtifactHash || review.builder_provider_family !== input.builderProviderFamily ||
        review.review_provider_family !== qa.reviewer_provider_family || review.review_model !== qa.reviewer_model ||
        review.review_version !== qa.reviewer_version || review.review_policy_sha256 !== qa.reviewer_policy_sha256 ||
        review.review_policy_schema_sha256 !== qa.reviewer_policy_schema_sha256 ||
        qa.reviewer_provider_family !== input.stageRun.providerFamily || qa.reviewer_model !== input.stageRun.providerModel ||
        qa.reviewer_version !== input.stageRun.providerModelVersion || qa.reviewer_policy_sha256 !== input.stageRun.providerPolicySha256 ||
        qaReceipt.artifactRef == null) {
      throw new ProfitFlywheelError("profit_flywheel_qa_lineage_invalid", "QA and independent-review receipts do not bind the exact builder, reviewer route, and immutable review artifact");
    }
    await Promise.all([
      verifyArtifactReference(qaReceipt.artifactRef, requireShaField(qa, "artifact_hash", "qa_receipt"), input.allowedArtifactRoots, input.targetRepoRoot),
      verifyArtifactReference(reviewArtifactRef, reviewArtifactHash, input.allowedArtifactRoots, input.targetRepoRoot),
      verifyArtifactReference(`git:${implementationGitObject}`, implementationArtifactHash, input.allowedArtifactRoots, input.targetRepoRoot),
    ]);
    const reviewFile = await readImmutableFileStrict(reviewArtifactRef, "independent review result at QA completion", 1024 * 1024);
    let reviewValue: unknown;
    try { reviewValue = JSON.parse(reviewFile.bytes.toString("utf8")); } catch { reviewValue = null; }
    validateIndependentReviewResult(reviewValue, {
      qaStageRunId: input.stageRun.id,
      implementationStageRunId,
      implementationGitObject,
      implementationArtifactHash,
      builderProviderFamily: input.builderProviderFamily,
      reviewerProviderFamily: reviewerFamily,
      reviewerModel: requireStringField(qa, "reviewer_model", "qa_receipt"),
      reviewerVersion: requireStringField(qa, "reviewer_version", "qa_receipt"),
      providerPolicySha256: requireShaField(qa, "reviewer_policy_sha256", "qa_receipt"),
      providerPolicySchemaSha256: requireShaField(qa, "reviewer_policy_schema_sha256", "qa_receipt"),
    });
  }
  if (input.stage === "release") {
    const { receipt: artifactReceipt, attributes } = requiredReceiptAttributes(validReceipts, "release_receipt");
    const releaseStatus = requireStringField(attributes, "release_status", "release_receipt").toLowerCase();
    if (!artifactReceipt.artifactRef || !["passed", "released", "deployed", "published", "verified"].includes(releaseStatus)) {
      throw new ProfitFlywheelError("profit_flywheel_release_not_artifact_backed", "Release requires a hashed artifact reference and release status");
    }
    await verifyArtifactReference(artifactReceipt.artifactRef, requireShaField(attributes, "artifact_hash", "release_receipt"), input.allowedArtifactRoots, input.targetRepoRoot);
    const qaStageRunId = requireStringField(attributes, "qa_stage_run_id", "release_receipt");
    const qaReceiptHash = requireShaField(attributes, "qa_receipt_hash", "release_receipt");
    const qaStage = await input.executor.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.id, qaStageRunId),
      eq(profitFlywheelStageRuns.workflowId, input.stageRun.workflowId),
      eq(profitFlywheelStageRuns.stage, "qa"),
      eq(profitFlywheelStageRuns.state, "succeeded"),
    )).then((rows) => rows[0] ?? null);
    const qaReceipt = qaStage ? await input.executor.select().from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.stageRunId, qaStage.id),
      eq(profitFlywheelReceipts.receiptType, "qa_receipt"),
      eq(profitFlywheelReceipts.contentHash, qaReceiptHash),
      eq(profitFlywheelReceipts.status, "valid"),
    )).then((rows) => rows[0] ?? null) : null;
    const qaAttributes = asRecord(qaReceipt?.attributes);
    const reviewReceipt = qaStage ? await input.executor.select().from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.stageRunId, qaStage.id),
      eq(profitFlywheelReceipts.receiptType, "independent_review_receipt"),
      eq(profitFlywheelReceipts.status, "valid"),
    )).then((rows) => rows[0] ?? null) : null;
    if (!qaStage || !qaReceipt || !reviewReceipt || !qaReceipt.artifactRef || !reviewReceipt.artifactRef ||
        attributes.qa_execution_receipt_ref !== qaReceipt.artifactRef || attributes.qa_execution_receipt_hash !== qaAttributes.artifact_hash ||
        attributes.implementation_stage_run_id !== qaAttributes.implementation_stage_run_id ||
        attributes.implementation_git_object !== qaAttributes.implementation_git_object ||
        attributes.implementation_artifact_hash !== qaAttributes.implementation_artifact_hash ||
        attributes.builder_provider_family !== qaAttributes.builder_provider_family ||
        attributes.reviewer_provider_family !== qaAttributes.reviewer_provider_family ||
        attributes.independent_review_artifact_ref !== qaAttributes.independent_review_artifact_ref ||
        attributes.independent_review_artifact_hash !== qaAttributes.independent_review_artifact_hash ||
        reviewReceipt.artifactRef !== qaAttributes.independent_review_artifact_ref ||
        asRecord(reviewReceipt.attributes).artifact_hash !== qaAttributes.independent_review_artifact_hash) {
      throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Release does not bind the exact fresh QA execution, builder artifact, and independent-review receipt chain");
    }
    canonicalDbReceiptProof(qaReceipt, input.now);
    canonicalDbReceiptProof(reviewReceipt, input.now);
    await Promise.all([
      verifyArtifactReference(qaReceipt.artifactRef, requireShaField(qaAttributes, "artifact_hash", "qa_receipt"), input.allowedArtifactRoots, input.targetRepoRoot),
      verifyArtifactReference(reviewReceipt.artifactRef, requireShaField(asRecord(reviewReceipt.attributes), "artifact_hash", "independent_review_receipt"), input.allowedArtifactRoots, input.targetRepoRoot),
      verifyArtifactReference(`git:${requireStringField(qaAttributes, "implementation_git_object", "qa_receipt")}`, requireShaField(qaAttributes, "implementation_artifact_hash", "qa_receipt"), input.allowedArtifactRoots, input.targetRepoRoot),
    ]);
    const reviewFile = await readImmutableFileStrict(reviewReceipt.artifactRef, "independent review result at release completion", 1024 * 1024);
    let reviewValue: unknown;
    try { reviewValue = JSON.parse(reviewFile.bytes.toString("utf8")); } catch { reviewValue = null; }
    validateIndependentReviewResult(reviewValue, {
      qaStageRunId: qaStage.id,
      implementationStageRunId: requireStringField(qaAttributes, "implementation_stage_run_id", "qa_receipt"),
      implementationGitObject: requireStringField(qaAttributes, "implementation_git_object", "qa_receipt"),
      implementationArtifactHash: requireShaField(qaAttributes, "implementation_artifact_hash", "qa_receipt"),
      builderProviderFamily: requireStringField(qaAttributes, "builder_provider_family", "qa_receipt"),
      reviewerProviderFamily: requireStringField(qaAttributes, "reviewer_provider_family", "qa_receipt"),
      reviewerModel: requireStringField(qaAttributes, "reviewer_model", "qa_receipt"),
      reviewerVersion: requireStringField(qaAttributes, "reviewer_version", "qa_receipt"),
      providerPolicySha256: requireShaField(qaAttributes, "reviewer_policy_sha256", "qa_receipt"),
      providerPolicySchemaSha256: requireShaField(qaAttributes, "reviewer_policy_schema_sha256", "qa_receipt"),
    });
    if (!input.targetRepoRoot) throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Release completion requires the pinned target repository root");
    const remoteOrigin = canonicalPublicRepoOrigin(requireStringField(attributes, "remote_origin_url", "release_receipt"));
    const remoteRef = requireStringField(attributes, "remote_ref", "release_receipt");
    const remoteObject = requireStringField(attributes, "remote_object", "release_receipt");
    const releaseGitEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const observedOrigin = await execFile("git", ["-C", input.targetRepoRoot, "config", "--local", "--no-includes", "--get", "remote.origin.url"], {
      timeout: 15_000,
      env: releaseGitEnv,
    })
      .then(({ stdout }) => stdout.trim()).catch(() => "");
    const observedRemoteObject = await execFile("git", ["ls-remote", "--exit-code", remoteOrigin, remoteRef], {
      timeout: 30_000,
      cwd: path.parse(input.targetRepoRoot).root,
      env: { ...releaseGitEnv, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    }).then(({ stdout }) => stdout.trim().split(/\s+/)[0] ?? "").catch(() => "");
    const finalObservedOrigin = await execFile("git", ["-C", input.targetRepoRoot, "config", "--local", "--no-includes", "--get", "remote.origin.url"], {
      timeout: 15_000,
      env: releaseGitEnv,
    })
      .then(({ stdout }) => stdout.trim()).catch(() => "");
    if (!observedOrigin || !finalObservedOrigin ||
        canonicalRepositoryRemote(observedOrigin) !== canonicalRepositoryRemote(remoteOrigin) ||
        canonicalRepositoryRemote(finalObservedOrigin) !== canonicalRepositoryRemote(remoteOrigin) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(remoteObject) || observedRemoteObject !== remoteObject) {
      throw new ProfitFlywheelError("profit_flywheel_release_not_published", "Release origin/ref no longer resolves to the exact QA-lineage object at completion");
    }
  }
  if (input.stage === "commercial_observation") {
    const { receipt: observationReceipt, attributes } = requiredReceiptAttributes(validReceipts, "commercial_observation_receipt");
    for (const evidence of ["metric_name", "baseline", "observed_value", "measurement_window", "source_artifact_hash"]) {
      if (!hasValue([attributes], evidence)) {
        throw new ProfitFlywheelError("profit_flywheel_completion_evidence_missing", `Commercial observation is missing ${evidence}`, { evidence });
      }
    }
    requireShaField(attributes, "source_artifact_hash", "commercial_observation_receipt");
    if (!observationReceipt.artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_completion_evidence_missing", "Commercial observation requires an immutable artifact reference");
    }
    await verifyArtifactReference(
      observationReceipt.artifactRef,
      requireShaField(attributes, "artifact_hash", "commercial_observation_receipt"),
      input.allowedArtifactRoots,
      input.targetRepoRoot,
    );
  }
  if (input.stage === "learning") {
    const { receipt: sourceReceipt, attributes } = requiredReceiptAttributes(validReceipts, "learning_receipt");
    for (const evidence of ["measured_external_or_operational_evidence", "validation_outcome_hash", "learning_receipt_hash", "next_research_authority_sha256"]) {
      if (!hasValue([attributes], evidence)) {
        throw new ProfitFlywheelError("profit_flywheel_learning_not_measured", `Learning requires ${evidence}`, { evidence });
      }
    }
    if (attributes.measured_external_or_operational_evidence !== true || !sourceReceipt.artifactRef) {
      throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", "Learning requires a measured source artifact ref and hash");
    }
    requireShaField(attributes, "validation_outcome_hash", "learning_receipt");
    const learningArtifactHash = requireShaField(attributes, "learning_receipt_hash", "learning_receipt");
    const sourceArtifactHash = requireShaField(attributes, "source_artifact_hash", "learning_receipt");
    if (learningArtifactHash !== requireShaField(attributes, "artifact_hash", "learning_receipt")) {
      throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", "Learning receipt artifact hash differs from learning_receipt_hash");
    }
    await verifyArtifactReference(sourceReceipt.artifactRef, learningArtifactHash, input.allowedArtifactRoots, input.targetRepoRoot);
    const learningFile = await readImmutableFileStrict(sourceReceipt.artifactRef, "POS learning receipt at completion", 2 * 1024 * 1024);
    let learningPayload: Record<string, unknown>;
    try { learningPayload = asRecord(JSON.parse(learningFile.bytes.toString("utf8"))); } catch { learningPayload = {}; }
    await validatePinnedResearchArtifactSchema({
      value: learningPayload,
      schemaPath: path.join(path.dirname(input.workflow.contractPath), "pos.learning_receipt.v2.schema.json"),
      expectedSha256: PINNED_POS_LEARNING_SCHEMA_SHA256,
      label: "POS learning receipt",
    });
    const artifactReceipts = asRecord(learningPayload.artifact_receipts);
    const observationBinding = asRecord(artifactReceipts.commercial_observation);
    const authorityArtifactBinding = asRecord(artifactReceipts.next_research_authority);
    const nextAuthority = asRecord(learningPayload.next_research_authority);
    const learningSourceHashes = asRecord(learningPayload.source_hashes);
    if (learningPayload.workflow_id !== input.workflow.id || learningPayload.company !== input.stageRun.companyId ||
        learningPayload.run_id !== input.workflow.runId || learningPayload.correlation_id !== input.workflow.correlationId ||
        learningPayload.trace_id !== input.workflow.traceId ||
        learningPayload.linked_issue_id !== input.stageRun.linkedIssueId || learningPayload.target_repo !== input.workflow.targetRepo ||
        learningPayload.input_hash !== input.stageRun.inputHash || learningSourceHashes.observation_sha256 !== sourceArtifactHash ||
        observationBinding.sha256 !== sourceArtifactHash || nextAuthority.artifact_ref !== attributes.next_research_authority_ref ||
        nextAuthority.artifact_sha256 !== attributes.next_research_authority_sha256 ||
        nextAuthority.payload_sha256 !== attributes.next_research_payload_sha256 ||
        authorityArtifactBinding.path !== attributes.next_research_authority_ref ||
        authorityArtifactBinding.sha256 !== attributes.next_research_authority_sha256 ||
        learningSourceHashes.next_research_authority_sha256 !== attributes.next_research_authority_sha256 ||
        nextAuthority.not_before !== attributes.next_research_not_before || nextAuthority.expires_at !== attributes.next_research_expires_at) {
      throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", "Learning artifact does not bind the exact stage, observation, and next-research authorization receipt attributes");
    }
    const observationStage = input.stageRun.transitionSourceStageRunId
      ? await input.executor.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.id, input.stageRun.transitionSourceStageRunId),
          eq(profitFlywheelStageRuns.workflowId, input.workflow.id),
          eq(profitFlywheelStageRuns.stage, "commercial_observation"),
          eq(profitFlywheelStageRuns.state, "succeeded"),
        )).then((rows) => rows[0] ?? null)
      : null;
    const releaseStage = observationStage?.transitionSourceStageRunId
      ? await input.executor.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.id, observationStage.transitionSourceStageRunId),
          eq(profitFlywheelStageRuns.workflowId, input.workflow.id),
          eq(profitFlywheelStageRuns.stage, "release"),
          eq(profitFlywheelStageRuns.state, "succeeded"),
        )).then((rows) => rows[0] ?? null)
      : null;
    const qaStage = releaseStage?.transitionSourceStageRunId
      ? await input.executor.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.id, releaseStage.transitionSourceStageRunId),
          eq(profitFlywheelStageRuns.workflowId, input.workflow.id),
          eq(profitFlywheelStageRuns.stage, "qa"),
          eq(profitFlywheelStageRuns.state, "succeeded"),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (!observationStage || !releaseStage || !qaStage ||
        [observationStage, releaseStage, qaStage].some((stage) =>
          stage.companyId !== input.stageRun.companyId || stage.linkedIssueId !== input.stageRun.linkedIssueId ||
          stage.correlationId !== input.workflow.correlationId || stage.traceId !== input.workflow.traceId)) {
      throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", "Learning artifact lacks the exact issue/correlation-bound QA, release, and observation stage chain");
    }
    const exactStageExecutionBinding = async (
      stage: typeof profitFlywheelStageRuns.$inferSelect,
      receiptType: "qa_receipt" | "release_receipt",
    ) => {
      const stageReceipts = await input.executor.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, stage.id),
        eq(profitFlywheelReceipts.status, "valid"),
      ));
      const typed = stageReceipts.find((receipt) => receipt.receiptType === receiptType) ?? null;
      const provider = stageReceipts.find((receipt) => receipt.receiptType === "provider_run_receipt") ?? null;
      const feedback = asRecord(stage.feedback);
      const executionPath = String(feedback.execution_receipt_path ?? "");
      const executionSha256 = String(feedback.execution_receipt_sha256 ?? "");
      if (!typed || !provider || !path.isAbsolute(executionPath) || !/^[a-f0-9]{64}$/.test(executionSha256) ||
          provider.artifactRef !== executionPath || asRecord(provider.attributes).artifact_hash !== executionSha256 ||
          asRecord(typed.attributes).execution_receipt_sha256 !== executionSha256) {
        throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", `${receiptType} lacks its exact server execution binding`);
      }
      canonicalDbReceiptProof(typed, input.now);
      canonicalDbReceiptProof(provider, input.now);
      return { path: executionPath, sha256: executionSha256 };
    };
    const [qaExecutionBinding, releaseExecutionBinding, observationReceipt] = await Promise.all([
      exactStageExecutionBinding(qaStage, "qa_receipt"),
      exactStageExecutionBinding(releaseStage, "release_receipt"),
      input.executor.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, observationStage.id),
        eq(profitFlywheelReceipts.receiptType, "commercial_observation_receipt"),
        eq(profitFlywheelReceipts.status, "valid"),
      )).then((rows) => rows[0] ?? null),
    ]);
    const observationAttributes = asRecord(observationReceipt?.attributes);
    if (!observationReceipt?.artifactRef || observationReceipt.artifactRef !== observationBinding.path ||
        observationAttributes.artifact_hash !== observationBinding.sha256 ||
        stableJson(asRecord(artifactReceipts.qa)) !== stableJson(qaExecutionBinding) ||
        stableJson(asRecord(artifactReceipts.release)) !== stableJson(releaseExecutionBinding)) {
      throw new ProfitFlywheelError("profit_flywheel_learning_source_missing", "Learning artifact file bindings differ from the canonical QA, release, or observation receipts");
    }
    canonicalDbReceiptProof(observationReceipt, input.now);
    for (const key of ["qa", "release", "commercial_observation"] as const) {
      const binding = asRecord(artifactReceipts[key]);
      await verifyArtifactReference(
        requireStringField(binding, "path", `learning_receipt.artifact_receipts.${key}`),
        requireShaField(binding, "sha256", `learning_receipt.artifact_receipts.${key}`),
        input.allowedArtifactRoots,
        input.targetRepoRoot,
      );
    }
    await verifyArtifactReference(
      requireStringField(attributes, "next_research_authority_ref", "learning_receipt"),
      requireShaField(attributes, "next_research_authority_sha256", "learning_receipt"),
      input.allowedArtifactRoots,
      input.targetRepoRoot,
    );
  }
  return validReceipts;
}

export function profitFlywheelService(db: Db, deps: {
  dispatchWakeup?: (
    agentId: string,
    input: {
      source: "assignment";
      triggerDetail: "system";
      reason: "issue_assigned";
      idempotencyKey: string;
      contextSnapshot: Record<string, unknown>;
      requestedByActorType: "system";
      requestedByActorId: string;
    },
  ) => Promise<{ id: string } | null>;
  serverTestLimits?: { timeoutMs?: number; maxOutputBytes?: number };
  serverArtifactRoot?: string;
  dispatchEvidenceValidator?: typeof validateDispatchEvidence;
  researchRegistryAuthorityLoader?: typeof loadPortfolioOsResearchRegistryAuthority;
  terminalOutboxReconciliationBeforeAppend?: () => Promise<void> | void;
  providerBlockedStageRouteAvailable?: (input: {
    companyId: string;
    alias: ProfitFlywheelCapabilityAlias;
    excludedProviderFamily: string | null;
    release: boolean;
  }) => Promise<boolean>;
} = {}) {
  async function assertPortfolioOsExecutorPrincipal(
    workflow: typeof profitFlywheelWorkflows.$inferSelect,
    actorId: string,
  ) {
    if (!workflow.portfolioOsExecutorAgentId || workflow.portfolioOsExecutorAgentId !== actorId) {
      throw new ProfitFlywheelError(
        "profit_flywheel_pos_principal_required",
        "Portfolio OS mutation requires the workflow-pinned executor agent id",
      );
    }
    const principal = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status }).from(agents)
      .where(eq(agents.id, actorId)).then((rows) => rows[0] ?? null);
    if (!principal || principal.companyId !== workflow.companyId || ["terminated", "paused", "pending_approval"].includes(principal.status)) {
      throw new ProfitFlywheelError(
        "profit_flywheel_pos_principal_required",
        "Workflow-pinned Portfolio OS executor is absent, cross-tenant, or non-invokable",
      );
    }
    return principal;
  }

  async function exactQaBuilderStage(tx: Db, qaStage: typeof profitFlywheelStageRuns.$inferSelect) {
    if (qaStage.stage !== "qa") return null;
    const feedback = asRecord(qaStage.feedback);
    const sourceStageRunId = typeof feedback.transition_source_stage_run_id === "string" ? feedback.transition_source_stage_run_id : "";
    const sourceOutputHash = typeof feedback.transition_source_output_hash === "string" ? feedback.transition_source_output_hash : "";
    if (!sourceStageRunId || !sourceOutputHash) {
      throw new ProfitFlywheelError("profit_flywheel_qa_lineage_missing", "QA stage lacks exact implementation transition lineage");
    }
    const implementation = await tx.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.id, sourceStageRunId),
      eq(profitFlywheelStageRuns.workflowId, qaStage.workflowId),
      eq(profitFlywheelStageRuns.stage, "implementation"),
      eq(profitFlywheelStageRuns.state, "succeeded"),
    )).then((rows) => rows[0] ?? null);
    if (!implementation || asRecord(implementation.feedback).output_hash !== sourceOutputHash || !implementation.providerFamily) {
      throw new ProfitFlywheelError("profit_flywheel_qa_lineage_invalid", "QA source implementation is missing, unsucceeded, or has a different immutable output hash");
    }
    return implementation;
  }

  async function buildExecutionManifest(input: { stageRunId: string }) {
    const stageRun = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, input.stageRunId))
      .then((rows) => rows[0] ?? null);
    if (!stageRun || !["implementation", "qa", "release"].includes(stageRun.stage) ||
        stageRun.ownerPlane !== "paperclip" || stageRun.state !== "running" || !stageRun.linkedIssueId) {
      throw new ProfitFlywheelError(
        "profit_flywheel_execution_manifest_stage_invalid",
        "Execution manifests require a running issue-backed Paperclip implementation/QA/release stage",
      );
    }
    const workflow = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, stageRun.workflowId))
      .then((rows) => rows[0] ?? null);
    if (!workflow || workflow.companyId !== stageRun.companyId || !workflow.targetWorkspaceRoot) {
      throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Execution manifest workflow or target workspace is missing");
    }
    if (!stageRun.providerRouteId || !stageRun.providerRouteCoreSha256 || !stageRun.providerRouteSha256 ||
        !stageRun.providerFamily || !stageRun.providerModel || !stageRun.providerModelVersion || !stageRun.providerPolicySha256) {
      throw new ProfitFlywheelError("profit_flywheel_execution_manifest_provider_missing", "Claimed stage lacks exact resolved provider authority");
    }
    const loadedPolicy = await loadProviderPolicyV2();
    if (stageRun.providerPolicySha256 !== loadedPolicy.sha256) {
      throw new ProfitFlywheelError("profit_flywheel_provider_policy_binding_mismatch", "Claimed stage policy differs from the pinned provider policy");
    }
    const iterationDispatch = asRecord(asRecord(stageRun.feedback).iteration_dispatch_binding);
    const dispatchStageRunId = String(iterationDispatch.dispatch_stage_run_id ?? "");
    const dispatchPath = String(iterationDispatch.dispatch_artifact_ref ?? "");
    const dispatchHash = String(iterationDispatch.dispatch_artifact_hash ?? "").toLowerCase();
    const dispatchReceiptHash = String(iterationDispatch.dispatch_receipt_hash ?? "").toLowerCase();
    const dispatchStage = dispatchStageRunId
      ? await db.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.id, dispatchStageRunId),
          eq(profitFlywheelStageRuns.workflowId, workflow.id),
          eq(profitFlywheelStageRuns.stage, "dispatch"),
          eq(profitFlywheelStageRuns.state, "succeeded"),
        )).then((rows) => rows[0] ?? null)
      : null;
    const dispatchReceipt = dispatchStage
      ? await db.select().from(profitFlywheelReceipts).where(and(
          eq(profitFlywheelReceipts.stageRunId, dispatchStage.id),
          eq(profitFlywheelReceipts.receiptType, "immutable_dispatch_artifact"),
          eq(profitFlywheelReceipts.contentHash, dispatchReceiptHash),
          eq(profitFlywheelReceipts.status, "valid"),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (!dispatchStage || !dispatchReceipt || dispatchReceipt.artifactRef !== dispatchPath ||
        asRecord(dispatchReceipt.attributes).dispatch_hash !== dispatchHash ||
        (stageRun.stage === "implementation" && asRecord(stageRun.sourceHashes).dispatch_hash !== dispatchHash) ||
        iterationDispatch.dispatch_input_hash !== dispatchStage.inputHash ||
        stableJson(asRecord(iterationDispatch.authoring_inputs)) !== stableJson(dispatchStage.sourceHashes) ||
        !path.isAbsolute(dispatchPath) || !/^[a-f0-9]{64}$/.test(dispatchHash)) {
      throw new ProfitFlywheelError("profit_flywheel_dispatch_iteration_binding_invalid", "Execution stage lacks its exact immutable iteration dispatch lineage");
    }
    const dispatchBytes = await readImmutableFileStrict(dispatchPath, "iteration dispatch", 20 * 1024 * 1024);
    if (dispatchBytes.sha256 !== dispatchHash) {
      throw new ProfitFlywheelError("profit_flywheel_dispatch_hash_mismatch", "Iteration dispatch bytes changed before execution manifest generation");
    }
    let dispatch: Record<string, unknown>;
    try {
      dispatch = asRecord(JSON.parse(dispatchBytes.bytes.toString("utf8")));
    } catch {
      throw new ProfitFlywheelError("profit_flywheel_dispatch_schema_invalid", "Source dispatch is no longer valid JSON");
    }
    const sourceExecutionManifest = asRecord(dispatch.execution_manifest);
    const repoTarget = asRecord(sourceExecutionManifest.repo_target);
    const stageAcceptance = asRecord(sourceExecutionManifest.stage_acceptance);
    const acceptanceKey = stageRun.stage === "release" ? "release" : "qa";
    const acceptance = asRecord(stageAcceptance[acceptanceKey]);
    const requiredTestCommands = Array.isArray(acceptance.commands)
      ? acceptance.commands.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (requiredTestCommands.length === 0) {
      throw new ProfitFlywheelError("profit_flywheel_execution_manifest_tests_missing", `Dispatch lacks required ${acceptanceKey} test commands`);
    }
    const targetBase = String(asRecord(workflow.feedback).target_base_sha ?? "");
    const targetOrigin = String(asRecord(workflow.feedback).target_origin_url ?? "");
    const targetBranch = String(repoTarget.target_repo_branch ?? "");
    const runBranch = String(repoTarget.suggested_branch_name ?? "");
    if (!/^[a-f0-9]{40,64}$/i.test(targetBase) || !targetOrigin || !targetBranch || !runBranch) {
      throw new ProfitFlywheelError("profit_flywheel_execution_manifest_workspace_invalid", "Dispatch lacks exact base/origin/branch execution authority");
    }
    const roots = workflowArtifactRoots(workflow);
    let verifiedPriorCheckpoint: Record<string, unknown> | null = null;
    if (stageRun.artifactCheckpoint) {
      const persisted = asRecord(stageRun.artifactCheckpoint);
      const checkpointReceipt = asRecord(persisted.checkpoint_receipt);
      const checkpointValue = Object.fromEntries(Object.entries(persisted).filter(([key]) => key !== "checkpoint_receipt"));
      const receiptPath = typeof checkpointReceipt.path === "string" ? checkpointReceipt.path : "";
      const receiptSha256 = typeof checkpointReceipt.sha256 === "string" ? checkpointReceipt.sha256.toLowerCase() : "";
      const workspaceEvidence = asRecord(persisted.workspace_evidence);
      const workspaceEvidencePath = typeof workspaceEvidence.path === "string" ? workspaceEvidence.path : "";
      const workspaceEvidenceSha256 = typeof workspaceEvidence.sha256 === "string" ? workspaceEvidence.sha256.toLowerCase() : "";
      const priorAttempt = Number(persisted.attempt);
      const priorRouteId = String(persisted.provider_route_id ?? "");
      if (!Number.isInteger(priorAttempt) || priorAttempt < 1 || priorAttempt >= stageRun.attemptCount || !priorRouteId ||
          !path.isAbsolute(receiptPath) || !/^[a-f0-9]{64}$/.test(receiptSha256) ||
          !path.isAbsolute(workspaceEvidencePath) || !/^[a-f0-9]{64}$/.test(workspaceEvidenceSha256)) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_not_prior", "Retry manifest requires an immutable checkpoint from a strictly prior attempt");
      }
      const routeFailure = /provider|quota|rate|capability|malformed|review_provider|test_infrastructure/i.test(stageRun.blockerCode ?? "");
      if (routeFailure && priorRouteId === stageRun.providerRouteId) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_route_not_escalated", "Provider-failure retry must consume its checkpoint under a different healthy route");
      }
      await Promise.all([
        verifyArtifactReference(receiptPath, receiptSha256, roots.allowedArtifactRoots, roots.targetRepoRoot),
        verifyArtifactReference(workspaceEvidencePath, workspaceEvidenceSha256, roots.allowedArtifactRoots, roots.targetRepoRoot),
      ]);
      const checkpointFile = await readImmutableFileStrict(receiptPath, "prior-attempt checkpoint receipt", 2 * 1024 * 1024);
      let checkpointFileValue: unknown;
      try { checkpointFileValue = JSON.parse(checkpointFile.bytes.toString("utf8")); } catch { checkpointFileValue = null; }
      const [persistedWorkspaceRoot, workflowWorkspaceRoot] = await Promise.all([
        realpath(String(persisted.workspace_root)).catch(() => ""),
        realpath(workflow.targetWorkspaceRoot).catch(() => ""),
      ]);
      if ((checkpointFile.stat.mode & 0o777) !== 0o444 || checkpointFile.sha256 !== receiptSha256 ||
          stableJson(checkpointFileValue) !== stableJson(checkpointValue) ||
          persisted.company_id !== stageRun.companyId || persisted.workflow_id !== workflow.id || persisted.stage_run_id !== stageRun.id ||
          persisted.issue_id !== stageRun.linkedIssueId || persisted.input_hash !== stageRun.inputHash ||
          !persistedWorkspaceRoot || persistedWorkspaceRoot !== workflowWorkspaceRoot) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Prior checkpoint file, database body, workflow, issue, input, or workspace binding drifted");
      }
      try {
        await revalidateProfitFlywheelWorkspaceSnapshot({
          workspaceRoot: String(persisted.workspace_root),
          headGitObject: String(persisted.head_git_object),
          branch: String(persisted.branch),
          trackedDiffSha256: String(persisted.tracked_diff_sha256),
          indexDiffSha256: String(persisted.index_diff_sha256),
          statusSha256: String(persisted.status_sha256),
          untracked: Array.isArray(persisted.untracked)
            ? persisted.untracked.map((value) => {
                const entry = asRecord(value);
                return { path: String(entry.path), sha256: String(entry.sha256), bytes: Number(entry.bytes) };
              })
            : [],
          observedAt: String(persisted.observed_at),
        });
      } catch (error) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_workspace_drift", "Workspace state changed after checkpoint publication", {
          cause: safeOperationalError(error),
        });
      }
      verifiedPriorCheckpoint = {
        schema_version: "paperclip.profit_flywheel_verified_prior_checkpoint.v1",
        prior_attempt: priorAttempt,
        prior_provider_route_id: priorRouteId,
        checkpoint_receipt: { path: receiptPath, sha256: receiptSha256 },
        workspace_evidence: { path: workspaceEvidencePath, sha256: workspaceEvidenceSha256 },
        observed_at: persisted.observed_at,
        transcript_epoch: `attempt-${stageRun.attemptCount}-fresh`,
      };
    }
    const receiptOutputPath = path.join(
      workflow.targetWorkspaceRoot,
      ".paperclip",
      "receipts",
      `${stageRun.id}-attempt-${stageRun.attemptCount}-work-result.json`,
    );
    let lineage: Record<string, unknown>;
    if (stageRun.stage === "implementation") {
      lineage = {
        dispatch_stage_run_id: stageRun.transitionSourceStageRunId,
        dispatch_artifact_ref: dispatchPath,
        dispatch_artifact_hash: dispatchHash,
        dispatch_receipt_hash: dispatchReceiptHash,
        base_git_object: targetBase,
      };
    } else if (stageRun.stage === "qa") {
      const implementation = await exactQaBuilderStage(db, stageRun);
      const receipt = implementation
        ? await db.select().from(profitFlywheelReceipts).where(and(
            eq(profitFlywheelReceipts.stageRunId, implementation.id),
            eq(profitFlywheelReceipts.receiptType, "implementation_receipt"),
            eq(profitFlywheelReceipts.status, "valid"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const attributes = asRecord(receipt?.attributes);
      if (!implementation || !receipt || !implementation.providerFamily || !receipt.artifactRef || !attributes.artifact_hash) {
        throw new ProfitFlywheelError("profit_flywheel_qa_lineage_missing", "QA execution manifest lacks exact implementation receipt lineage");
      }
      lineage = {
        implementation_stage_run_id: implementation.id,
        implementation_git_object: receipt.artifactRef.replace(/^git:/, ""),
        implementation_artifact_hash: attributes.artifact_hash,
        builder_provider_family: implementation.providerFamily,
        reviewer_provider_family: stageRun.providerFamily,
      };
    } else {
      const qaStageId = asRecord(stageRun.feedback).transition_source_stage_run_id;
      const qaStage = typeof qaStageId === "string"
        ? await db.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, qaStageId),
            eq(profitFlywheelStageRuns.workflowId, workflow.id),
            eq(profitFlywheelStageRuns.stage, "qa"),
            eq(profitFlywheelStageRuns.state, "succeeded"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const qaReceipt = qaStage
        ? await db.select().from(profitFlywheelReceipts).where(and(
            eq(profitFlywheelReceipts.stageRunId, qaStage.id),
            eq(profitFlywheelReceipts.receiptType, "qa_receipt"),
            eq(profitFlywheelReceipts.status, "valid"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const attributes = asRecord(qaReceipt?.attributes);
      if (!qaStage || !qaReceipt || !attributes.implementation_stage_run_id || !attributes.implementation_git_object || !attributes.implementation_artifact_hash) {
        throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Release execution manifest lacks exact QA-tested implementation lineage");
      }
      lineage = {
        qa_stage_run_id: qaStage.id,
        qa_receipt_hash: qaReceipt.contentHash,
        implementation_stage_run_id: attributes.implementation_stage_run_id,
        implementation_git_object: attributes.implementation_git_object,
        implementation_artifact_hash: attributes.implementation_artifact_hash,
      };
    }
    const manifestWithoutHash = {
      schema_version: "paperclip.profit_flywheel_execution_manifest.v1",
      identity: {
        company_id: stageRun.companyId,
        workflow_id: workflow.id,
        stage_run_id: stageRun.id,
        issue_id: stageRun.linkedIssueId,
        stage: stageRun.stage,
        attempt: stageRun.attemptCount,
        input_hash: stageRun.inputHash,
        correlation_id: workflow.correlationId,
        trace_id: workflow.traceId,
      },
      workspace: {
        root: workflow.targetWorkspaceRoot,
        base_git_object: targetBase,
        run_branch: runBranch,
        authorized_origin: targetOrigin,
        authorized_ref: `refs/heads/${targetBranch}`,
        allowed_artifact_roots: roots.allowedArtifactRoots,
      },
      provider: {
        route_id: stageRun.providerRouteId,
        route_core_sha256: stageRun.providerRouteCoreSha256,
        route_sha256: stageRun.providerRouteSha256,
        provider_family: stageRun.providerFamily,
        model: stageRun.providerModel,
        version: stageRun.providerModelVersion,
        policy_sha256: loadedPolicy.sha256,
        policy_schema_sha256: loadedPolicy.schemaSha256,
      },
      receipt_output_path: receiptOutputPath,
      iteration_dispatch_authority: iterationDispatch,
      schema_authorities: PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES,
      work_result_contract: {
        schema_version: "paperclip.profit_flywheel_stage_work_result.v1",
        required_top_level_fields: [
          "schema_version", "execution_manifest_sha256", "execution_manifest_file_sha256", "company_id",
          "workflow_id", "stage_run_id", "issue_id", "correlation_id", "trace_id", "stage", "attempt", "input_hash", "tests",
        ],
        stage_specific_fields: stageRun.stage === "implementation"
          ? ["workspace"]
          : stageRun.stage === "qa"
            ? ["implementation_lineage", "independent_review"]
            : ["qa_lineage", "release"],
      },
      implementation_completion_requirements: stageRun.stage === "implementation"
        ? {
            target_git_object_type: "commit",
            target_git_object_must_equal_branch_head: true,
            branch_must_equal: runBranch,
            worktree_must_be_clean_outside_paperclip: true,
            changed_files_authority: "git diff --name-only <base_git_object> <target_git_object>",
            required_sequence: [
              "implement_and_test",
              "create_commit_on_authorized_run_branch",
              "verify_clean_worktree_outside_.paperclip",
              "compute_target_artifact_hash_from_commit",
              "write_read_only_work_result",
            ],
          }
        : null,
      target_artifact_hash_authority: stageRun.stage === "implementation"
        ? {
            algorithm: "sha256",
            canonical_bytes: "<git-object-type> <body-byte-length>\\0<body>",
            byte_length_unit: "bytes",
            body_source: "git cat-file <git-object-type> <full-target-git-object>",
            helper: {
              command: "/usr/bin/env",
              argv: [
                "TMPDIR=/tmp",
                "pnpm",
                "--silent", "--dir", PAPERCLIP_REPOSITORY_ROOT,
                "ops:git-object-sha256", "--",
                "--repo", workflow.targetWorkspaceRoot,
                "--object", "<target_git_object>",
              ],
              working_directory: workflow.targetWorkspaceRoot,
              cwd_independent: true,
              bounded_tmpdir: "/tmp",
              replacement_required: {
                placeholder: "<target_git_object>",
                value: "workspace.target_git_object from the completed implementation commit",
              },
              stdout_schema: {
                object: "full git object id",
                type: "blob|tree|commit|tag",
                byte_length: "non-negative integer",
                canonical_header: "<type> <byte-length>\\0",
                sha256: "workspace.target_artifact_hash",
              },
            },
            prohibition: "Do not use the Git object id itself, git show text, a patch hash, or SHA-256(body-only).",
          }
        : null,
      server_execution_envelope: {
        schema_version: "paperclip.profit_flywheel_stage_execution.v2",
        authority: "paperclip_server_after_adapter_completion",
        agent_must_not_supply: ["heartbeat_run_id", "context_ledger_entry_id", "provider_result", "final_response_sha256", "input_tokens", "output_tokens"],
      },
      required_test_commands: requiredTestCommands,
      verified_prior_checkpoint: verifiedPriorCheckpoint,
      lineage,
      completion_protocol: {
        mode: "0444",
        max_bytes: 1048576,
        final_response_marker: `Receipt path: ${receiptOutputPath}`,
        exit_zero_insufficient: true,
        immutable_before_final_response: true,
      },
    };
    const manifestSha256 = hashProfitFlywheelValue(manifestWithoutHash);
    const manifest = { ...manifestWithoutHash, manifest_sha256: manifestSha256 };
    const manifestArtifactPath = path.join(
      workflow.targetWorkspaceRoot,
      ".paperclip",
      "manifests",
      `${stageRun.id}-attempt-${stageRun.attemptCount}.json`,
    );
    const manifestFile = await writeImmutableJsonArtifactAt({
      artifactPath: manifestArtifactPath,
      value: manifest,
      label: "Profit Flywheel execution manifest",
    });
    const manifestBinding = {
      schema_version: "paperclip.profit_flywheel_execution_manifest_binding.v1",
      path: manifestFile.path,
      file_sha256: manifestFile.sha256,
      manifest_sha256: manifestSha256,
      stage_run_id: stageRun.id,
      attempt: stageRun.attemptCount,
      receipt_output_path: receiptOutputPath,
      required_test_commands: requiredTestCommands,
    };
    const existingFeedback = asRecord(stageRun.feedback);
    const previousBinding = asRecord(existingFeedback.execution_manifest_binding);
    const previousAttempt = Number(previousBinding.attempt);
    if (previousAttempt === stageRun.attemptCount && previousBinding.manifest_sha256 && previousBinding.manifest_sha256 !== manifestSha256) {
      throw new ProfitFlywheelError("profit_flywheel_execution_manifest_drift", "A different immutable execution manifest is already bound to this stage attempt");
    }
    const manifestHistory = Array.isArray(existingFeedback.execution_manifest_history)
      ? existingFeedback.execution_manifest_history.filter((entry) => entry && typeof entry === "object")
      : [];
    if (previousAttempt > 0 && previousAttempt !== stageRun.attemptCount && previousBinding.manifest_sha256) {
      manifestHistory.push({ ...previousBinding });
    }
    await db.update(profitFlywheelStageRuns).set({
      feedback: {
        ...existingFeedback,
        execution_manifest_binding: manifestBinding,
        execution_manifest_history: manifestHistory,
      },
      updatedAt: new Date(),
    }).where(and(
      eq(profitFlywheelStageRuns.id, stageRun.id),
      eq(profitFlywheelStageRuns.state, "running"),
      eq(profitFlywheelStageRuns.providerRouteSha256, stageRun.providerRouteSha256),
    ));
    return { manifestBinding, manifestSha256, receiptOutputPath };
  }

  async function dispatchPendingStages(input: { workflowId?: string; limit?: number; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const dispatchableState = or(
      eq(profitFlywheelStageRuns.state, "pending"),
      and(eq(profitFlywheelStageRuns.state, "retry"), lte(profitFlywheelStageRuns.retryAt, now)),
    )!;
    const conditions = [
      dispatchableState,
      eq(profitFlywheelStageRuns.ownerPlane, "paperclip"),
    ];
    if (input.workflowId) conditions.push(eq(profitFlywheelStageRuns.workflowId, input.workflowId));
    const pendingStages = await db.select().from(profitFlywheelStageRuns)
      .where(and(...conditions))
      .orderBy(asc(profitFlywheelStageRuns.createdAt))
      .limit(input.limit ?? 100);
    const dispatched = [];
    for (const stageRun of pendingStages) {
      try {
        const workflow = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0] ?? null);
        if (!workflow) continue;
        const candidates = await db.select().from(agents).where(eq(agents.companyId, workflow.companyId));
        const invokable = candidates.filter((agent) => !["terminated", "paused", "pending_approval"].includes(agent.status));
        const rolePreferred = stageRun.stage === "qa"
          ? invokable.find((agent) => /qa|quality|review|design/i.test(`${agent.role} ${agent.name}`))
          : stageRun.stage === "release"
            ? invokable.find((agent) => /release|ship|engineer|developer|orchestrator/i.test(`${agent.role} ${agent.name}`))
            : invokable.find((agent) => /engineer|developer|orchestrator/i.test(`${agent.role} ${agent.name}`));
        const authoritativeIssue = stageRun.linkedIssueId
          ? await db.select().from(issues).where(and(
              eq(issues.id, stageRun.linkedIssueId),
              eq(issues.companyId, workflow.companyId),
            )).then((rows) => rows[0] ?? null)
          : null;
        // A linked issue is the assignment authority for Paperclip-owned work.
        // Never wake a role-based fallback for an unassigned linked issue: the
        // resulting heartbeat cannot claim the stage because claimStage binds
        // the actor to the persisted issue assignee.
        const preferred = authoritativeIssue
          ? authoritativeIssue.assigneeAgentId
            ? invokable.find((agent) => agent.id === authoritativeIssue.assigneeAgentId)
            : undefined
          : rolePreferred;
      if (stageRun.linkedIssueId && !authoritativeIssue) {
        await blockStage({
          stageRunId: stageRun.id,
          expectedLease: { leaseOwner: null, actorType: null, actorId: null },
          blocker: {
            blockerCode: "profit_flywheel_linked_issue_missing",
            blockerDetail: `The authoritative linked issue ${stageRun.linkedIssueId} is missing or belongs to another company`,
            nextOwner: "paperclip_board_operator",
            resumeCondition: "Restore the exact linked issue and assignment; do not create a replacement issue for this stage",
          },
        });
        continue;
      }
      if (!preferred) {
        await blockStage({
          stageRunId: stageRun.id,
          expectedLease: { leaseOwner: null, actorType: null, actorId: null },
          blocker: {
            blockerCode: "profit_flywheel_stage_agent_missing",
            blockerDetail: authoritativeIssue
              ? `The authoritative linked issue ${authoritativeIssue.id} has no invokable assigned agent`
              : `No invokable agent is available for Paperclip stage ${stageRun.stage}`,
            nextOwner: "paperclip_board_operator",
            resumeCondition: "Assign an invokable stage-appropriate agent, then explicitly resume the same pending stage",
          },
        });
        continue;
      }
      const claimId = randomUUID();
      const claimNow = now;
      const retryDispatch = stageRun.state === "retry";
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      const staleBefore = new Date(claimNow.getTime() - contract.recovery.orphan_timeout_seconds * 1000);
      const claimed = await db.update(profitFlywheelStageRuns).set({
        ...(retryDispatch ? { state: "pending", retryAt: null } : {}),
        dispatchClaimId: claimId,
        dispatchClaimedAt: claimNow,
        updatedAt: claimNow,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        dispatchableState,
        eq(profitFlywheelStageRuns.ownerPlane, "paperclip"),
        or(isNull(profitFlywheelStageRuns.dispatchClaimId), lte(profitFlywheelStageRuns.dispatchClaimedAt, staleBefore)),
      )).returning().then((rows) => rows[0] ?? null);
      if (!claimed) continue;
      const releaseDispatchClaim = async () => {
        const released = await db.update(profitFlywheelStageRuns).set({
          ...(retryDispatch ? { state: "retry", retryAt: stageRun.retryAt } : {}),
          dispatchClaimId: null,
          dispatchClaimedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(profitFlywheelStageRuns.id, stageRun.id),
          eq(profitFlywheelStageRuns.state, "pending"),
          eq(profitFlywheelStageRuns.dispatchClaimId, claimId),
        )).returning({ id: profitFlywheelStageRuns.id });
        if (retryDispatch && released.length === 1) {
          if (stageRun.linkedIssueId) {
            await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(and(
              eq(issues.id, stageRun.linkedIssueId),
              eq(issues.companyId, workflow.companyId),
            ));
          }
          await db.update(profitFlywheelWorkflows).set({ state: "degraded", updatedAt: new Date() })
            .where(eq(profitFlywheelWorkflows.id, workflow.id));
        }
      };
      try {
        const title = `[Profit Flywheel ${workflow.runId}] ${stageRun.stage}`;
        const issueSvc = issueService(db);
        const existing = authoritativeIssue ?? (await issueSvc.list(workflow.companyId, { q: title, limit: 50 })).find((issue) => issue.title === title) ?? null;
        const issue = existing ?? await issueSvc.create(workflow.companyId, {
          title,
          description: [
            `Durable Profit Flywheel stage: ${stageRun.stage}`,
            `Workflow: ${workflow.id}`,
            `Stage run: ${stageRun.id}`,
            `Input hash: ${stageRun.inputHash}`,
            "Completion must be artifact/receipt backed; a successful process exit without a complete final response is failure.",
          ].join("\n"),
          status: "todo",
          priority: stageRun.stage === "release" ? "critical" : "high",
          projectId: workflow.projectId,
          assigneeAgentId: preferred.id,
        });
        if (!stageRun.linkedIssueId) {
          const bound = await db.update(profitFlywheelStageRuns).set({ linkedIssueId: issue.id, updatedAt: new Date() })
            .where(and(
              eq(profitFlywheelStageRuns.id, stageRun.id),
              eq(profitFlywheelStageRuns.state, "pending"),
              eq(profitFlywheelStageRuns.dispatchClaimId, claimId),
              isNull(profitFlywheelStageRuns.linkedIssueId),
            ))
            .returning().then((rows) => rows[0] ?? null);
          if (!bound || bound.linkedIssueId !== issue.id) {
            await releaseDispatchClaim();
            continue;
          }
        }
        if (retryDispatch) {
          await db.update(issues).set({ status: "todo", updatedAt: claimNow }).where(and(
            eq(issues.id, issue.id),
            eq(issues.companyId, workflow.companyId),
          ));
          await db.update(profitFlywheelWorkflows).set({
            state: "running",
            currentStage: stageRun.stage,
            completedAt: null,
            blockerCode: null,
            blockerDetail: null,
            nextOwner: null,
            resumeCondition: null,
            updatedAt: claimNow,
          }).where(eq(profitFlywheelWorkflows.id, workflow.id));
        }
        const wakeInput = {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          idempotencyKey: `profit-flywheel-stage:${stageRun.id}:attempt-${stageRun.attemptCount + 1}`,
          contextSnapshot: {
            issueId: issue.id,
            projectId: workflow.projectId,
            profitFlywheelStageRunId: stageRun.id,
            profitFlywheelWorkflowId: workflow.id,
            forceFreshSession: true,
            wakeReason: "issue_assigned",
          },
          requestedByActorType: "system",
          requestedByActorId: `profit-flywheel:${stageRun.id}`,
        } as const;
        const wake = deps.dispatchWakeup
          ? await deps.dispatchWakeup(preferred.id, wakeInput)
          : await (await import("./heartbeat.js")).heartbeatService(db).wakeup(preferred.id, wakeInput);
        if (!wake) {
          await releaseDispatchClaim();
          continue;
        }
        await db.update(profitFlywheelStageRuns).set({
          feedback: {
            ...asRecord(claimed.feedback),
            dispatch_claim_id: claimId,
            heartbeat_run_id: wake.id,
            dispatched_at: new Date().toISOString(),
          },
          updatedAt: new Date(),
        }).where(and(
          eq(profitFlywheelStageRuns.id, stageRun.id),
          eq(profitFlywheelStageRuns.dispatchClaimId, claimId),
        ));
        if (retryDispatch) {
          await db.transaction(async (rawTx) => appendEvent(rawTx as unknown as Db, {
            workflow,
            stageRunId: stageRun.id,
            eventType: "stage_retry_dispatched",
            dedupeKey: `stage-retry-dispatched:${stageRun.id}:${stageRun.attemptCount + 1}`,
            fromState: "retry",
            toState: "pending",
            spanId: stageRun.spanId,
            payload: {
              stage: stageRun.stage,
              input_hash: stageRun.inputHash,
              prior_attempt: stageRun.attemptCount,
              next_attempt: stageRun.attemptCount + 1,
              heartbeat_run_id: wake.id,
            },
            processedAt: claimNow,
          }));
        }
        dispatched.push({ stageRunId: stageRun.id, stage: stageRun.stage, issueId: issue.id, agentId: preferred.id, heartbeatRunId: wake.id });
        } catch (error) {
          await releaseDispatchClaim();
          throw error;
        }
      } catch (error) {
        logger.error({
          stageRunId: stageRun.id,
          workflowId: stageRun.workflowId,
          stage: stageRun.stage,
          error: safeOperationalError(error),
        }, "Profit Flywheel stage dispatch item failed without starving later stages");
      }
    }
    return dispatched;
  }

  async function releaseDispatchClaimAfterHeartbeatSetupFailure(input: {
    stageRunId: string;
    heartbeatRunId: string;
    failureClass: string;
    failureCode?: string;
    detail: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const stageRun = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId))
        .then((rows) => rows[0] ?? null);
      if (!stageRun || stageRun.state !== "pending" || !stageRun.dispatchClaimId) return false;
      const feedback = asRecord(stageRun.feedback);
      if (feedback.heartbeat_run_id !== input.heartbeatRunId || feedback.dispatch_claim_id !== stageRun.dispatchClaimId) return false;
      const setupFailure = {
        heartbeat_run_id: input.heartbeatRunId,
        failure_class: input.failureClass,
        failure_code: input.failureCode ?? null,
        detail: input.detail,
        observed_at: now.toISOString(),
      };
      if (input.failureCode === "provider_policy_no_capable_route") {
        const workflow = await tx.select().from(profitFlywheelWorkflows)
          .where(eq(profitFlywheelWorkflows.id, stageRun.workflowId))
          .then((rows) => rows[0] ?? null);
        if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Workflow not found");
        const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
        assertTransition(contract, stageRun.stage as ProfitFlywheelStage, "pending", "blocked");
        const blocker = requireBlocker({
          blockerCode: "provider_policy_no_capable_route",
          blockerDetail: `${input.detail}; capability_alias=${stageRun.providerCapabilityClass}`,
          nextOwner: "paperclip_provider_operator",
          resumeCondition: `Restore a fresh healthy policy-valid route for ${stageRun.providerCapabilityClass}; provider-canary reconciliation will resume this exact stage automatically`,
        });
        const blocked = await tx.update(profitFlywheelStageRuns).set({
          state: "blocked",
          dispatchClaimId: null,
          dispatchClaimedAt: null,
          blockerCode: blocker.blockerCode,
          blockerDetail: blocker.blockerDetail,
          nextOwner: blocker.nextOwner,
          resumeCondition: blocker.resumeCondition,
          feedback: { ...feedback, dispatch_setup_failure: setupFailure },
          updatedAt: now,
        }).where(and(
          eq(profitFlywheelStageRuns.id, stageRun.id),
          eq(profitFlywheelStageRuns.state, "pending"),
          eq(profitFlywheelStageRuns.dispatchClaimId, stageRun.dispatchClaimId),
        )).returning().then((rows) => rows[0] ?? null);
        if (!blocked) return false;
        if (stageRun.linkedIssueId) {
          await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
            eq(issues.id, stageRun.linkedIssueId),
            eq(issues.companyId, stageRun.companyId),
          ));
        }
        await tx.update(profitFlywheelWorkflows).set({ state: "blocked", ...blocker, updatedAt: now })
          .where(eq(profitFlywheelWorkflows.id, workflow.id));
        await appendEvent(tx, {
          workflow,
          stageRunId: stageRun.id,
          eventType: "stage_blocked",
          dedupeKey: `provider-route-blocked:${stageRun.id}:${stageRun.attemptCount}:${hashProfitFlywheelValue(blocker)}`,
          fromState: "pending",
          toState: "blocked",
          spanId: stageRun.spanId,
          payload: { stage: stageRun.stage, input_hash: stageRun.inputHash, heartbeat_run_id: input.heartbeatRunId, ...blocker },
          processedAt: now,
        });
        return true;
      }
      const released = await tx.update(profitFlywheelStageRuns).set({
        dispatchClaimId: null,
        dispatchClaimedAt: null,
        feedback: { ...feedback, dispatch_setup_failure: setupFailure },
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, "pending"),
        eq(profitFlywheelStageRuns.dispatchClaimId, stageRun.dispatchClaimId),
      )).returning({ id: profitFlywheelStageRuns.id });
      return released.length === 1;
    });
  }

  async function recoverProviderBlockedStages(input: { now?: Date; limit?: number } = {}) {
    const now = input.now ?? new Date();
    const blockedStages = await db.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.state, "blocked"),
      eq(profitFlywheelStageRuns.ownerPlane, "paperclip"),
      eq(profitFlywheelStageRuns.blockerCode, "provider_policy_no_capable_route"),
    )).orderBy(asc(profitFlywheelStageRuns.updatedAt)).limit(input.limit ?? 100);
    if (blockedStages.length === 0) return [];
    const loadedPolicy = await loadProviderPolicyV2();
    const recovered: Array<{ stageRunId: string; workflowId: string; stage: string }> = [];
    for (const stageRun of blockedStages) {
      const alias = stageCapabilityAlias(stageRun.providerCapabilityClass);
      if (!alias) continue;
      const builderProviderFamily = stageRun.stage === "qa"
        ? (await exactQaBuilderStage(db, stageRun))?.providerFamily ?? null
        : null;
      try {
        const available = deps.providerBlockedStageRouteAvailable
          ? await deps.providerBlockedStageRouteAvailable({
              companyId: stageRun.companyId,
              alias,
              excludedProviderFamily: builderProviderFamily,
              release: stageRun.stage === "release",
            })
          : Boolean(await providerCanaryService(db).resolveHealthyAlias({
              companyId: stageRun.companyId,
              policy: loadedPolicy.policy,
              policySha256: loadedPolicy.sha256,
              policySchemaSha256: loadedPolicy.schemaSha256,
              alias,
              excludedProviderFamily: builderProviderFamily,
              release: stageRun.stage === "release",
              now,
            }));
        if (!available) continue;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "provider_policy_no_capable_route") continue;
        logger.error({ stageRunId: stageRun.id, workflowId: stageRun.workflowId, error: safeOperationalError(error) },
          "Profit Flywheel provider-blocked stage recovery failed without starving later stages");
        continue;
      }
      const result = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockProfitFlywheelStageRun(tx, stageRun.id);
        const current = await tx.select().from(profitFlywheelStageRuns)
          .where(eq(profitFlywheelStageRuns.id, stageRun.id))
          .then((rows) => rows[0] ?? null);
        if (!current || current.state !== "blocked" || current.blockerCode !== "provider_policy_no_capable_route") return null;
        const workflow = await tx.select().from(profitFlywheelWorkflows)
          .where(eq(profitFlywheelWorkflows.id, current.workflowId))
          .then((rows) => rows[0] ?? null);
        if (!workflow) return null;
        const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
        assertTransition(contract, current.stage as ProfitFlywheelStage, "blocked", "pending");
        const updated = await tx.update(profitFlywheelStageRuns).set({
          state: "pending",
          blockerCode: null,
          blockerDetail: null,
          nextOwner: null,
          resumeCondition: null,
          retryAt: null,
          feedback: {
            ...asRecord(current.feedback),
            provider_route_recovered: {
              prior_blocker_code: "provider_policy_no_capable_route",
              recovered_at: now.toISOString(),
              trigger: "fresh_healthy_provider_canary",
            },
          },
          updatedAt: now,
        }).where(and(
          eq(profitFlywheelStageRuns.id, current.id),
          eq(profitFlywheelStageRuns.state, "blocked"),
          eq(profitFlywheelStageRuns.blockerCode, "provider_policy_no_capable_route"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (current.linkedIssueId) {
          await tx.update(issues).set({ status: "todo", updatedAt: now }).where(and(
            eq(issues.id, current.linkedIssueId),
            eq(issues.companyId, current.companyId),
          ));
        }
        await tx.update(profitFlywheelWorkflows).set({
          state: "running",
          currentStage: current.stage,
          blockerCode: null,
          blockerDetail: null,
          nextOwner: null,
          resumeCondition: null,
          completedAt: null,
          updatedAt: now,
        }).where(eq(profitFlywheelWorkflows.id, workflow.id));
        await appendEvent(tx, {
          workflow,
          stageRunId: current.id,
          eventType: "stage_resumed",
          dedupeKey: `provider-route-recovered:${current.id}:${current.attemptCount}:${now.toISOString()}`,
          fromState: "blocked",
          toState: "pending",
          spanId: current.spanId,
          payload: {
            stage: current.stage,
            input_hash: current.inputHash,
            prior_blocker_code: "provider_policy_no_capable_route",
            trigger: "fresh_healthy_provider_canary",
          },
          processedAt: now,
        });
        return { stageRunId: current.id, workflowId: workflow.id, stage: current.stage };
      });
      if (result) recovered.push(result);
    }
    return recovered;
  }

  async function loadWorkflowDetail(workflowId: string) {
    const workflow = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, workflowId))
      .then((rows) => rows[0] ?? null);
    if (!workflow) return null;
    const [stages, receipts, events] = await Promise.all([
      db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.workflowId, workflowId)).orderBy(asc(profitFlywheelStageRuns.createdAt)),
      db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.workflowId, workflowId)).orderBy(asc(profitFlywheelReceipts.createdAt)),
      db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.workflowId, workflowId)).orderBy(asc(profitFlywheelEvents.createdAt)),
    ]);
    return { workflow, stages, receipts, events };
  }

  function redactApiSecretFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactApiSecretFields);
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["claim_nonce", "execution_evidence_nonce", "server_observation_nonce"].includes(key)) continue;
      redacted[key] = redactApiSecretFields(entry);
    }
    return redacted;
  }

  async function loadWorkflowApiDetail(workflowId: string) {
    const detail = await loadWorkflowDetail(workflowId);
    if (!detail) return null;
    return {
      workflow: { ...detail.workflow, feedback: redactApiSecretFields(detail.workflow.feedback) },
      stages: detail.stages.map((stage) => ({
        ...stage,
        feedback: redactApiSecretFields(stage.feedback),
        providerRouteSnapshot: redactApiSecretFields(stage.providerRouteSnapshot),
      })),
      receipts: detail.receipts.map((receipt) => ({ ...receipt, attributes: redactApiSecretFields(receipt.attributes) })),
      events: detail.events.map((event) => ({ ...event, payload: redactApiSecretFields(event.payload) })),
    };
  }

  async function appendEvent(tx: Db, input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    stageRunId?: string | null;
    eventType: string;
    dedupeKey: string;
    fromState?: string | null;
    toState?: string | null;
    spanId?: string | null;
    payload: Record<string, unknown>;
    processedAt?: Date | null;
    nextAttemptAt?: Date;
  }) {
    return tx.insert(profitFlywheelEvents).values({
      companyId: input.workflow.companyId,
      workflowId: input.workflow.id,
      stageRunId: input.stageRunId ?? null,
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      correlationId: input.workflow.correlationId,
      traceId: input.workflow.traceId,
      spanId: input.spanId ?? null,
      payload: {
        schema_version: "paperclip.profit_flywheel_event.v2",
        company_id: input.workflow.companyId,
        run_id: input.workflow.runId,
        workflow_id: input.workflow.id,
        correlation_id: input.workflow.correlationId,
        trace_id: input.workflow.traceId,
        contract_sha256: input.workflow.contractSha256,
        occurred_at: new Date().toISOString(),
        ...input.payload,
      },
      processedAt: input.processedAt ?? null,
      nextAttemptAt: input.nextAttemptAt ?? new Date(),
    }).onConflictDoNothing({
      target: [profitFlywheelEvents.workflowId, profitFlywheelEvents.dedupeKey],
    }).returning().then((rows) => rows[0] ?? null);
  }

  async function ensureWorkflowBlockerIssue(
    tx: Db,
    workflow: typeof profitFlywheelWorkflows.$inferSelect,
    blocker: Blocker,
    kind: "transition" | "outbox_infrastructure" = "transition",
  ) {
    const title = kind === "transition"
      ? `[profit-flywheel:${workflow.runId}] Durable transition blocker`
      : `Profit Flywheel ${blocker.blockerCode} :: ${workflow.runId}`;
    const originKind = kind === "transition"
      ? "profit_flywheel_transition_blocker"
      : "profit_flywheel_outbox_blocker";
    const originId = kind === "transition"
      ? workflow.id
      : `${workflow.id}:${blocker.blockerCode}`;
    const existing = await tx.select().from(issues).where(and(
      eq(issues.companyId, workflow.companyId),
      or(
        and(eq(issues.originKind, originKind), eq(issues.originId, originId)),
        eq(issues.title, title),
      ),
    )).for("update").then((rows) => rows[0] ?? null);
    const description = [
      kind === "transition"
        ? "The durable Profit Flywheel could not safely advance a completion event."
        : "The durable Portfolio OS outbox consumer exhausted or permanently blocked this exact event.",
      "",
      "```json",
      JSON.stringify({
        schema_version: "paperclip.profit_flywheel_blocker.v2",
        workflow_id: workflow.id,
        run_id: workflow.runId,
        correlation_id: workflow.correlationId,
        blocker_code: blocker.blockerCode,
        blocker_detail: blocker.blockerDetail,
        next_owner: blocker.nextOwner,
        resume_condition: blocker.resumeCondition,
      }, null, 2),
      "```",
    ].join("\n");
    if (existing) {
      return tx.update(issues).set({
        projectId: workflow.projectId,
        status: "blocked",
        priority: "critical",
        description,
        originKind,
        originId,
        updatedAt: new Date(),
      }).where(and(eq(issues.id, existing.id), eq(issues.companyId, workflow.companyId)))
        .returning().then((rows) => rows[0] ?? existing);
    }
    const currentMax = await tx.select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
      .from(issues).where(eq(issues.companyId, workflow.companyId))
      .then((rows) => rows[0]?.maxNum ?? 0);
    const company = await tx.update(companies).set({
      issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
    }).where(eq(companies.id, workflow.companyId))
      .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix })
      .then((rows) => rows[0] ?? null);
    if (!company) throw new ProfitFlywheelError("profit_flywheel_company_missing", "Cannot create a workflow blocker for a missing company");
    return tx.insert(issues).values({
      companyId: workflow.companyId,
      projectId: workflow.projectId,
      title,
      description,
      status: "blocked",
      priority: "critical",
      originKind,
      originId,
      issueNumber: company.issueCounter,
      identifier: `${company.issuePrefix}-${company.issueCounter}`,
    }).returning().then((rows) => rows[0]!);
  }

  async function createStageRun(tx: Db, input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    contract: PortfolioOsProfitFlywheelContractV2;
    stage: ProfitFlywheelStage;
    inputHash: string;
    sourceHashes: Record<string, string>;
    linkedIssueId?: string | null;
  }) {
    assertSha256(input.inputHash, "inputHash");
    const canonicalInput = buildProfitFlywheelStageInput({ contract: input.contract, stage: input.stage, sourceHashes: input.sourceHashes });
    if (canonicalInput.inputHash !== input.inputHash) {
      throw new ProfitFlywheelError("profit_flywheel_input_hash_mismatch", `${input.stage} input_hash does not match exact contract source_hashes`, {
        expected: canonicalInput.inputHash,
        observed: input.inputHash,
      });
    }
    const definition = stageDefinition(input.contract, input.stage);
    const idempotencyKey = buildProfitFlywheelIdempotencyKey({
      companyId: input.workflow.companyId,
      runId: input.workflow.runId,
      stage: input.stage,
      inputHash: input.inputHash,
    });
    const inserted = await tx.insert(profitFlywheelStageRuns).values({
      workflowId: input.workflow.id,
      companyId: input.workflow.companyId,
      stage: input.stage,
      state: "pending",
      ownerPlane: definition.owner_plane,
      inputSchemaVersion: definition.input_schema,
      inputHash: input.inputHash,
      sourceHashes: canonicalInput.sourceHashes,
      idempotencyKey,
      maxAttempts: Math.max(1, definition.retry.limit + 1),
      linkedIssueId: input.linkedIssueId ?? null,
      providerCapabilityClass: definition.provider_capability_class,
      concurrencyKey: definition.concurrency_key,
      concurrencyLimit: definition.concurrency_limit,
      requiredReceipts: definition.required_receipts,
      completionEvidence: definition.completion_evidence,
      correlationId: input.workflow.correlationId,
      traceId: input.workflow.traceId,
      spanId: spanId(`${input.workflow.traceId}:${input.stage}:${input.inputHash}`),
    }).onConflictDoNothing({
      target: [profitFlywheelStageRuns.companyId, profitFlywheelStageRuns.idempotencyKey],
    }).returning().then((rows) => rows[0] ?? null);
    if (inserted) return inserted;
    const existing = await tx.select().from(profitFlywheelStageRuns)
      .where(and(
        eq(profitFlywheelStageRuns.companyId, input.workflow.companyId),
        eq(profitFlywheelStageRuns.idempotencyKey, idempotencyKey),
      )).then((rows) => rows[0] ?? null);
    if (existing && stableJson(existing.sourceHashes) !== stableJson(canonicalInput.sourceHashes)) {
      throw new ProfitFlywheelError("profit_flywheel_idempotency_source_drift", "Existing idempotency key has different source_hashes");
    }
    return existing;
  }

  async function startFromDispatch(input: {
    companyId: string;
    projectId: string;
    runId: string;
    correlationId: string;
    sourceSchemaVersion: string;
    sourceDispatchPath: string;
    dispatchHash: string;
    selectionSnapshotHash: string;
    targetRepo: string;
    targetRepoUrl: string;
    targetWorkspaceRoot: string;
    implementationIssueId: string;
    stageIssueBindings?: { qa?: string; release?: string };
    inputHash?: string;
    providerPolicy?: { path: string; sha256: string; schemaVersion: "provider-policy.v2"; schemaPath: string; schemaSha256: string } | null;
    contract?: LoadedProfitFlywheelContract;
    policy?: Awaited<ReturnType<typeof loadProviderPolicyV2>>;
  }) {
    assertSha256(input.dispatchHash, "dispatchHash");
    assertSha256(input.selectionSnapshotHash, "selectionSnapshotHash");
    if (input.correlationId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input.correlationId)) {
      throw new ProfitFlywheelError("profit_flywheel_correlation_id_invalid", "Dispatch correlation_id is missing or unsafe");
    }
    const targetRepoUrl = canonicalPublicRepoOrigin(input.targetRepoUrl);
    const loadedContract = input.contract ?? await loadProfitFlywheelContract();
    const loadedPolicy = input.policy ?? await loadProviderPolicyV2();
    const researchRegistryAuthority = await (deps.researchRegistryAuthorityLoader ?? loadPortfolioOsResearchRegistryAuthority)();
    const contract = loadedContract.contract;
    assertContractBudgetsMatchProviderPolicy(contract, loadedPolicy.policy);
    if (contract.stages.implementation.input_schema !== "pos.dispatch.v2" || input.sourceSchemaVersion !== "pos.dispatch.v2") {
      throw new ProfitFlywheelError(
        "profit_flywheel_source_schema_rejected",
        `Live execution requires exact pos.dispatch.v2 authority; ${input.sourceSchemaVersion} is validation/migration-reader only`,
      );
    }
    if (input.targetRepo && contract.exclusions.repos.some((repo) => repo.toLowerCase() === input.targetRepo!.toLowerCase())) {
      throw new ProfitFlywheelError("profit_flywheel_repo_excluded", `Repository ${input.targetRepo} is excluded from the flywheel`, { nextOwner: "portfolio_os_selection_owner" });
    }
    if (!input.implementationIssueId) {
      throw new ProfitFlywheelError("profit_flywheel_issue_required", "Dispatch cannot advance to implementation without an issue");
    }
    const targetWorkspaceRoot = await realpath(input.targetWorkspaceRoot).catch(() => "");
    if (!targetWorkspaceRoot || targetWorkspaceRoot !== path.resolve(input.targetWorkspaceRoot)) {
      throw new ProfitFlywheelError("profit_flywheel_workspace_invalid", "Target workspace must be an existing canonical non-symlink directory");
    }
    const evidence = await (deps.dispatchEvidenceValidator ?? validateDispatchEvidence)({
      sourceDispatchPath: input.sourceDispatchPath,
      dispatchHash: input.dispatchHash,
      selectionSnapshotHash: input.selectionSnapshotHash,
      runId: input.runId,
      correlationId: input.correlationId,
      sourceSchemaVersion: input.sourceSchemaVersion,
      targetRepo: input.targetRepo,
      targetRepoUrl,
      targetWorkspaceRoot,
      contract,
    });
    const dispatchContract = asRecord(evidence.dispatch.contract);
    const dispatchSourceHashes = asRecord(evidence.dispatch.source_hashes) as Record<string, string>;
    const artifactProvenanceHashes = asRecord(evidence.dispatch.artifact_provenance_hashes);
    if (evidence.dispatch.company !== input.companyId || asRecord(evidence.dispatch.paperclip).company_id !== input.companyId || asRecord(evidence.dispatch.paperclip).project_id !== input.projectId) {
      throw new ProfitFlywheelError("profit_flywheel_company_project_binding_mismatch", "Dispatch company/project identity does not match the explicit Paperclip binding");
    }
    const declaredInputHash = typeof evidence.dispatch.input_hash === "string" ? evidence.dispatch.input_hash : "";
    const expectedDispatchInputHash = buildProfitFlywheelStageInput({
      contract,
      stage: "dispatch",
      sourceHashes: dispatchSourceHashes,
    }).inputHash;
    const expectedDispatchIdempotencyKey = `${input.companyId}+${input.runId}+dispatch+${expectedDispatchInputHash}`;
    if (declaredInputHash !== expectedDispatchInputHash || evidence.dispatch.idempotency_key !== expectedDispatchIdempotencyKey || (input.inputHash && input.inputHash !== declaredInputHash)) {
      throw new ProfitFlywheelError("profit_flywheel_dispatch_idempotency_mismatch", "POS dispatch input_hash/idempotency_key does not match the canonical cross-plane vector", {
        declaredInputHash,
        expectedDispatchInputHash,
        declaredIdempotencyKey: evidence.dispatch.idempotency_key,
        expectedDispatchIdempotencyKey,
      });
    }
    const [dispatchContractPath, dispatchContractSchemaPath, canonicalContractPath, canonicalContractSchemaPath] = await Promise.all([
      typeof dispatchContract.path === "string" ? realpath(dispatchContract.path).catch(() => "") : Promise.resolve(""),
      typeof dispatchContract.schema_path === "string" ? realpath(dispatchContract.schema_path).catch(() => "") : Promise.resolve(""),
      realpath(loadedContract.path),
      realpath(loadedContract.schemaPath),
    ]);
    if (
      dispatchContractPath !== canonicalContractPath ||
      dispatchContractSchemaPath !== canonicalContractSchemaPath ||
      dispatchContract.sha256 !== loadedContract.sha256 ||
      dispatchContract.schema_sha256 !== loadedContract.schemaSha256 ||
      dispatchContract.schema_version !== contract.schema_version ||
      artifactProvenanceHashes.contract_sha256 !== loadedContract.sha256 ||
      artifactProvenanceHashes.contract_schema_sha256 !== loadedContract.schemaSha256 ||
      artifactProvenanceHashes.selection_snapshot_sha256 !== evidence.selection.byteHash ||
      artifactProvenanceHashes.commercial_gate_sha256 !== evidence.commercialGateHash
    ) {
      throw new ProfitFlywheelError("profit_flywheel_contract_or_source_binding_mismatch", "Dispatch contract/schema/source hashes do not match canonical immutable bytes");
    }
    if (!input.providerPolicy) {
      throw new ProfitFlywheelError(
        "profit_flywheel_provider_policy_binding_missing",
        "Dispatch cannot enter v2 execution without the canonical provider_policy path/hash/schema manifest",
        { nextOwner: "portfolio_os_dispatch_owner" },
      );
    }
    const providerBinding = input.providerPolicy;
    const dispatchProviderBinding = asRecord(evidence.dispatch.provider_policy);
    const [bindingPolicyPath, bindingSchemaPath] = await Promise.all([
      realpath(providerBinding.path).catch(() => ""),
      realpath(providerBinding.schemaPath).catch(() => ""),
    ]);
    if (
      providerBinding.schemaVersion !== "provider-policy.v2" ||
      providerBinding.sha256 !== loadedPolicy.sha256 ||
      providerBinding.schemaSha256 !== loadedPolicy.schemaSha256 ||
      bindingPolicyPath !== await realpath(loadedPolicy.path) ||
      bindingSchemaPath !== await realpath(loadedPolicy.schemaPath) ||
      dispatchProviderBinding.path !== providerBinding.path ||
      dispatchProviderBinding.sha256 !== providerBinding.sha256 ||
      dispatchProviderBinding.schema_version !== providerBinding.schemaVersion ||
      dispatchProviderBinding.schema_path !== providerBinding.schemaPath ||
      dispatchProviderBinding.schema_sha256 !== providerBinding.schemaSha256 ||
      artifactProvenanceHashes.provider_policy_sha256 !== loadedPolicy.sha256 ||
      artifactProvenanceHashes.provider_policy_schema_sha256 !== loadedPolicy.schemaSha256
    ) {
      throw new ProfitFlywheelError("profit_flywheel_provider_policy_binding_mismatch", "Dispatch provider policy binding does not match the canonical pinned policy", {
        expectedPolicySha256: loadedPolicy.sha256,
        observedPolicySha256: providerBinding.sha256,
        expectedSchemaSha256: loadedPolicy.schemaSha256,
        observedSchemaSha256: providerBinding.schemaSha256 ?? null,
        nextOwner: "portfolio_os_dispatch_owner",
      });
    }
    const inputHash = declaredInputHash;
    assertSha256(inputHash, "inputHash");
    const correlationId = input.correlationId;
    const executorCandidates = await db.select({ id: agents.id, status: agents.status }).from(agents).where(and(
      eq(agents.companyId, input.companyId),
      eq(agents.name, "Portfolio OS Orchestrator"),
    )).then((rows) => rows.filter((row) => !["terminated", "paused", "pending_approval"].includes(row.status)));
    if (executorCandidates.length !== 1) {
      throw new ProfitFlywheelError(
        "profit_flywheel_pos_executor_authority_invalid",
        "Dispatch requires exactly one provisioned Portfolio OS Orchestrator executor before workflow authority can be frozen",
        { candidateCount: executorCandidates.length, nextOwner: "paperclip_security_owner" },
      );
    }
    const portfolioOsExecutorAgentId = executorCandidates[0]!.id;
    const workflowFeedback = {
      provider_policy: {
        path: providerBinding.path,
        sha256: loadedPolicy.sha256,
        schema_version: "provider-policy.v2",
        schema_path: loadedPolicy.schemaPath,
        schema_sha256: loadedPolicy.schemaSha256,
      },
      selection_snapshot_hash: input.selectionSnapshotHash,
      stage_issue_bindings: input.stageIssueBindings ?? {},
      target_origin_url: targetRepoUrl,
      target_base_sha: asRecord(evidence.dispatch.target).base_sha,
      workspace_fingerprint: asRecord(evidence.dispatch.target).workspace_fingerprint,
      server_artifact_root: path.resolve(
        process.env.PAPERCLIP_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT ?? DEFAULT_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT,
      ),
      commercial_gate_summary: evidence.commercial.value.summary,
      commercial_source_registry_hash: evidence.commercial.value.source_registry_set_hash,
      research_registry_authority: researchRegistryAuthority,
    };
    const assertExactWorkflowReplay = (existing: typeof profitFlywheelWorkflows.$inferSelect) => {
      const existingFeedback = asRecord(existing.feedback);
      const immutableFeedback = Object.fromEntries(Object.keys(workflowFeedback).map((key) => [key, existingFeedback[key]]));
      if (existing.projectId !== input.projectId || existing.sourceSchemaVersion !== input.sourceSchemaVersion ||
          existing.sourceDispatchPath !== input.sourceDispatchPath || existing.sourceDispatchHash !== input.dispatchHash ||
          existing.contractPath !== loadedContract.path || existing.contractSha256 !== loadedContract.sha256 ||
          existing.portfolioOsExecutorAgentId !== portfolioOsExecutorAgentId ||
          existing.correlationId !== input.correlationId || existing.targetRepo !== input.targetRepo ||
          existing.targetWorkspaceRoot !== targetWorkspaceRoot || stableJson(immutableFeedback) !== stableJson(workflowFeedback)) {
        throw new ProfitFlywheelError("profit_flywheel_run_contract_drift", "Existing run_id has different immutable dispatch, project, repository, workspace, policy, or contract authority", {
          runId: input.runId,
          existingDispatchHash: existing.sourceDispatchHash,
          observedDispatchHash: input.dispatchHash,
          existingContractSha256: existing.contractSha256,
          observedContractSha256: loadedContract.sha256,
          existingCorrelationId: existing.correlationId,
          observedCorrelationId: input.correlationId,
        });
      }
      return existing;
    };
    const workflow = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const existing = await tx.select().from(profitFlywheelWorkflows)
        .where(and(eq(profitFlywheelWorkflows.companyId, input.companyId), eq(profitFlywheelWorkflows.runId, input.runId)))
        .then((rows) => rows[0] ?? null);
      if (existing) return assertExactWorkflowReplay(existing);
      const primaryWorkspace = input.projectId
        ? await tx.select().from(projectWorkspaces).where(and(
            eq(projectWorkspaces.projectId, input.projectId),
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.isPrimary, true),
          )).then((rows) => rows[0] ?? null)
        : null;
      const primaryWorkspaceRoot = primaryWorkspace?.cwd ? await realpath(primaryWorkspace.cwd).catch(() => "") : "";
      if (!primaryWorkspace || primaryWorkspaceRoot !== targetWorkspaceRoot) {
        throw new ProfitFlywheelError("profit_flywheel_workspace_binding_mismatch", "Target workspace does not match the company project's primary workspace");
      }
      const created = await tx.insert(profitFlywheelWorkflows).values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: input.runId,
        state: "running",
        currentStage: "implementation",
        sourceSchemaVersion: input.sourceSchemaVersion,
        sourceDispatchPath: input.sourceDispatchPath,
        sourceDispatchHash: input.dispatchHash,
        targetRepo: input.targetRepo,
        targetWorkspaceRoot,
        contractPath: loadedContract.path,
        contractSha256: loadedContract.sha256,
        contractSnapshot: contract as unknown as Record<string, unknown>,
        correlationId,
        traceId: traceId(correlationId),
        portfolioOsExecutorAgentId,
        feedback: workflowFeedback,
      }).onConflictDoNothing({
        target: [profitFlywheelWorkflows.companyId, profitFlywheelWorkflows.runId],
      }).returning().then((rows) => rows[0] ?? null);
      if (!created) {
        const raced = await tx.select().from(profitFlywheelWorkflows)
          .where(and(eq(profitFlywheelWorkflows.companyId, input.companyId), eq(profitFlywheelWorkflows.runId, input.runId)))
          .then((rows) => rows[0] ?? null);
        if (!raced) throw new ProfitFlywheelError("profit_flywheel_run_create_race", "Concurrent workflow creation did not expose the committed canonical run");
        return assertExactWorkflowReplay(raced);
      }
      const dispatchStage = await createStageRun(tx, {
        workflow: created,
        contract,
        stage: "dispatch",
        inputHash,
        sourceHashes: dispatchSourceHashes,
        linkedIssueId: input.implementationIssueId,
      });
      if (!dispatchStage) throw new ProfitFlywheelError("profit_flywheel_stage_create_failed", "Unable to create dispatch stage");
      const issueIdentity = dispatchIssueIdentity({
        companyId: input.companyId,
        workflowId: created.id,
        stageRunId: dispatchStage.id,
        inputHash: dispatchStage.inputHash,
      });
      const importedIssue = await tx.select().from(issues).where(and(
        eq(issues.id, input.implementationIssueId),
        eq(issues.companyId, input.companyId),
        eq(issues.projectId, input.projectId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!importedIssue || importedIssue.hiddenAt || !["backlog", "todo", "in_progress", "in_review", "blocked"].includes(importedIssue.status) ||
          !(["manual", issueIdentity.origin_kind].includes(importedIssue.originKind)) ||
          (importedIssue.originId && importedIssue.originId !== issueIdentity.origin_id)) {
        throw new ProfitFlywheelError("profit_flywheel_issue_binding_invalid", "Imported dispatch issue is missing, terminal, hidden, or already bound to another origin");
      }
      const importedOriginConflict = await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, issueIdentity.origin_kind),
        eq(issues.originId, issueIdentity.origin_id),
      )).then((rows) => rows.find((row) => row.id !== importedIssue.id) ?? null);
      if (importedOriginConflict) {
        throw new ProfitFlywheelError("profit_flywheel_issue_binding_conflict", "Dispatch issue origin is already bound to another issue");
      }
      await tx.update(issues).set({
        originKind: issueIdentity.origin_kind,
        originId: issueIdentity.origin_id,
        originRunId: input.runId,
        updatedAt: new Date(),
      }).where(and(eq(issues.id, importedIssue.id), eq(issues.companyId, input.companyId)));
      const now = new Date();
      await tx.update(profitFlywheelStageRuns).set({
        state: "succeeded",
        attemptCount: 1,
        startedAt: now,
        completedAt: now,
        providerPolicySha256: loadedPolicy.sha256,
        feedback: { imported_authoritative_completion: true, output_hash: input.dispatchHash },
        updatedAt: now,
      }).where(eq(profitFlywheelStageRuns.id, dispatchStage.id));
      const dispatchReceipts = [
        { type: "portfolio_os_dispatch_authorization", artifactRef: input.sourceDispatchPath },
        { type: "immutable_dispatch_artifact", artifactRef: input.sourceDispatchPath },
      ];
      for (const receipt of dispatchReceipts) {
        const attributes = {
          portfolio_os_authorized: true,
          artifact_hash: input.dispatchHash,
          dispatch_hash: input.dispatchHash,
          selection_snapshot_hash: input.selectionSnapshotHash,
          issue_id: input.implementationIssueId,
          issue_origin_id: issueIdentity.origin_id,
          workflow_id: created.id,
          stage_run_id: dispatchStage.id,
          input_hash: dispatchStage.inputHash,
          authoring_inputs: dispatchStage.sourceHashes,
          provider_policy_sha256: loadedPolicy.sha256,
        };
        const receiptBody = {
          type: receipt.type,
          schemaVersion: input.sourceSchemaVersion,
          artifactRef: receipt.artifactRef,
          observedAt: now.toISOString(),
          expiresAt: null,
          attributes,
        };
        await tx.insert(profitFlywheelReceipts).values({
          companyId: input.companyId,
          workflowId: created.id,
          stageRunId: dispatchStage.id,
          receiptType: receipt.type,
          schemaVersion: input.sourceSchemaVersion,
          contentHash: canonicalProfitFlywheelReceiptHash(receiptBody),
          artifactRef: receipt.artifactRef,
          status: "valid",
          observedAt: now,
          attributes,
          correlationId: created.correlationId,
          traceId: created.traceId,
          spanId: dispatchStage.spanId,
        }).onConflictDoNothing();
      }
      await appendEvent(tx, {
        workflow: created,
        stageRunId: dispatchStage.id,
        eventType: "stage_succeeded",
        dedupeKey: `dispatch-succeeded:${dispatchStage.id}`,
        fromState: "running",
        toState: "succeeded",
        spanId: dispatchStage.spanId,
        payload: {
          stage: "dispatch",
          input_hash: inputHash,
          output_hash: input.dispatchHash,
          trigger: "issue_created",
          guard: "issue_backed_and_dispatch_hash_matches",
          linked_issue_id: input.implementationIssueId,
          receipt_refs: dispatchReceipts.map((receipt) => receipt.type),
        },
      });
      return created;
    });
    await processPendingEvents({ workflowId: workflow.id, limit: 20 });
    return loadWorkflowDetail(workflow.id);
  }

  async function processPendingEvents(input: { workflowId?: string; limit?: number; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const conditions = [
      isNull(profitFlywheelEvents.processedAt),
      lte(profitFlywheelEvents.nextAttemptAt, now),
      eq(profitFlywheelEvents.eventType, "stage_succeeded"),
    ];
    if (input.workflowId) conditions.push(eq(profitFlywheelEvents.workflowId, input.workflowId));
    const pending = await db.select().from(profitFlywheelEvents)
      .where(and(...conditions))
      .orderBy(asc(profitFlywheelEvents.createdAt))
      .limit(input.limit ?? 100);
    const results = [];
    for (const event of pending) {
      try {
        const result = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          const currentQuery = tx.select().from(profitFlywheelEvents)
            .where(and(
              eq(profitFlywheelEvents.id, event.id),
              isNull(profitFlywheelEvents.processedAt),
              eq(profitFlywheelEvents.attemptCount, event.attemptCount),
              lte(profitFlywheelEvents.nextAttemptAt, now),
            ));
          // A workflow-scoped caller is synchronously waiting for this exact
          // transition. Let it wait behind the current owner so its subsequent
          // workflow detail cannot be a pre-transition snapshot. Unscoped
          // background scans still skip locked rows to preserve queue fan-out.
          const current = await (input.workflowId
            ? currentQuery.for("update")
            : currentQuery.for("update", { skipLocked: true }))
            .then((rows) => rows[0] ?? null);
          if (!current) return null;
          const workflow = await tx.select().from(profitFlywheelWorkflows)
            .where(eq(profitFlywheelWorkflows.id, current.workflowId))
            .then((rows) => rows[0] ?? null);
          if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Event workflow no longer exists");
          if (current.eventType !== "stage_succeeded") {
            await tx.update(profitFlywheelEvents).set({ processedAt: now, updatedAt: now }).where(eq(profitFlywheelEvents.id, current.id));
            return { eventId: current.id, action: "acknowledged" };
          }
          const payload = asRecord(current.payload);
          const fromStage = payload.stage as ProfitFlywheelStage;
          if (!(PROFIT_FLYWHEEL_STAGES as readonly string[]).includes(fromStage)) {
            throw new ProfitFlywheelError("profit_flywheel_event_invalid_stage", "Completion event has an invalid stage");
          }
          const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
          const sourceStage = current.stageRunId
            ? await tx.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, current.stageRunId)).then((rows) => rows[0] ?? null)
            : null;
          if (!sourceStage || sourceStage.workflowId !== workflow.id || sourceStage.stage !== fromStage || sourceStage.state !== "succeeded") {
            throw new ProfitFlywheelError("profit_flywheel_event_source_invalid", "Completion event is not bound to a succeeded source stage");
          }
          const sourceReceipts = await tx.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, sourceStage.id));
          const builderProviderFamily = fromStage === "qa"
            ? (await exactQaBuilderStage(tx, sourceStage))?.providerFamily ?? null
            : null;
          const artifactPolicy = workflowArtifactRoots(workflow);
          const validSourceReceipts = await assertCompletionEvidence({
            executor: tx,
            workflow,
            contract,
            stage: fromStage,
            stageRun: sourceStage,
            receipts: sourceReceipts,
            now,
            builderProviderFamily,
            ...artifactPolicy,
          });
          const trigger = typeof payload.trigger === "string" ? payload.trigger : "validated_artifact_completion";
          const transition = contract.transitions.find((candidate) => candidate.from === fromStage && candidate.trigger === trigger);
          if (!transition && fromStage === "learning" && trigger === "observation_hash_unchanged") {
            await tx.update(profitFlywheelEvents).set({ processedAt: now, updatedAt: now }).where(eq(profitFlywheelEvents.id, current.id));
            return { eventId: current.id, action: "terminal_or_external" };
          }
          if (!transition) {
            throw new ProfitFlywheelError(
              "profit_flywheel_transition_missing",
              `No contract transition exists for ${fromStage} with trigger ${trigger}`,
              { fromStage, trigger },
            );
          }
          const nextStage = transition.to;
          const outputHash = typeof payload.output_hash === "string" ? payload.output_hash : null;
          if (!outputHash || !/^[a-f0-9]{64}$/i.test(outputHash)) {
            throw new ProfitFlywheelError("profit_flywheel_event_missing_output_hash", "Completion event cannot advance without an immutable output hash");
          }
          if (asRecord(sourceStage.feedback).output_hash !== outputHash) {
            throw new ProfitFlywheelError("profit_flywheel_event_output_hash_mismatch", "Completion event output hash differs from the persisted source-stage receipt hash");
          }
          let completedDispatchBinding: Record<string, unknown> | null = null;
          if (transition.guard === "issue_backed_and_dispatch_hash_matches") {
            const dispatchReceipt = validSourceReceipts.find((receipt) =>
              receipt.receiptType === "immutable_dispatch_artifact",
            );
            const linkedIssueId = typeof payload.linked_issue_id === "string" ? payload.linked_issue_id : "";
            const issueIdentity = dispatchIssueIdentity({
              companyId: sourceStage.companyId,
              workflowId: workflow.id,
              stageRunId: sourceStage.id,
              inputHash: sourceStage.inputHash,
            });
            const dispatchAttributes = asRecord(dispatchReceipt?.attributes);
            const iterationDispatchHash = String(dispatchAttributes.dispatch_hash ?? "").toLowerCase();
            if (!linkedIssueId || !dispatchReceipt?.artifactRef || dispatchAttributes.issue_id !== linkedIssueId ||
                dispatchAttributes.issue_origin_id !== issueIdentity.origin_id ||
                dispatchAttributes.workflow_id !== workflow.id || dispatchAttributes.stage_run_id !== sourceStage.id ||
                dispatchAttributes.input_hash !== sourceStage.inputHash ||
                stableJson(asRecord(dispatchAttributes.authoring_inputs)) !== stableJson(sourceStage.sourceHashes) ||
                dispatchAttributes.artifact_hash !== iterationDispatchHash || !/^[a-f0-9]{64}$/.test(iterationDispatchHash)) {
              throw new ProfitFlywheelError("profit_flywheel_transition_guard_failed", "Dispatch transition requires a linked issue and matching immutable dispatch receipt");
            }
            await verifyArtifactReference(
              dispatchReceipt.artifactRef,
              iterationDispatchHash,
              workflowArtifactRoots(workflow).allowedArtifactRoots,
              workflow.targetWorkspaceRoot,
            );
            completedDispatchBinding = {
              schema_version: "paperclip.profit_flywheel_iteration_dispatch_binding.v1",
              dispatch_stage_run_id: sourceStage.id,
              dispatch_input_hash: sourceStage.inputHash,
              dispatch_artifact_ref: dispatchReceipt.artifactRef,
              dispatch_artifact_hash: iterationDispatchHash,
              dispatch_receipt_hash: dispatchReceipt.contentHash,
              authoring_inputs: sourceStage.sourceHashes,
            };
          }
          const receiptAttributes = (receiptType: string) => asRecord(
            validSourceReceipts.find((receipt) => receipt.receiptType === receiptType)?.attributes,
          );
          const receiptHashField = (receiptType: string, field: string) => {
            const value = String(receiptAttributes(receiptType)[field] ?? "").toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(value)) {
              throw new ProfitFlywheelError(
                "profit_flywheel_transition_source_missing",
                `${fromStage}->${nextStage} requires ${receiptType}.${field} as lowercase SHA-256`,
              );
            }
            return value;
          };
          let nextSourceHashes: Record<string, string>;
          let transitionContext: Record<string, unknown> = {};
          if (nextStage === "evidence_normalization") {
            const rawEvidenceHash = receiptHashField("raw_evidence_manifest", "raw_evidence_hash");
            const sourceRegistryHash = receiptHashField("source_run_receipt", "source_registry_hash");
            const normalizerVersion = receiptHashField("source_run_receipt", "normalizer_version_hash");
            const pinnedRegistryHash = String(asRecord(sourceStage.sourceHashes).source_registry_hash ?? "").toLowerCase();
            if (sourceRegistryHash !== pinnedRegistryHash) {
              throw new ProfitFlywheelError("profit_flywheel_research_registry_binding_drift", "Research receipt source_registry_hash differs from the requested registry authority");
            }
            nextSourceHashes = {
              raw_evidence_hash: rawEvidenceHash,
              source_registry_hash: sourceRegistryHash,
              normalizer_version: normalizerVersion,
            };
            transitionContext = { raw_evidence_hash: rawEvidenceHash, source_registry_hash: sourceRegistryHash };
          } else if (nextStage === "commercial_validation") {
            const ledgerHash = receiptHashField("evidence_ledger_manifest", "ledger_hash");
            const commercialPolicyHash = receiptHashField("normalization_receipt", "commercial_policy_hash");
            nextSourceHashes = {
              ledger_hash: ledgerHash,
              commercial_policy_hash: commercialPolicyHash,
              target_repo: hashProfitFlywheelValue(workflow.targetRepo),
            };
            transitionContext = { ledger_hash: ledgerHash, target_repo: workflow.targetRepo };
          } else if (nextStage === "council_decision") {
            const commercialGateHash = receiptHashField("commercial_gate_receipt", "commercial_gate_hash");
            const councilPolicyHash = receiptHashField("commercial_gate_receipt", "council_policy_hash");
            nextSourceHashes = {
              commercial_gate_hash: commercialGateHash,
              council_policy_hash: councilPolicyHash,
              target_repo: hashProfitFlywheelValue(workflow.targetRepo),
            };
            transitionContext = { commercial_gate_hash: commercialGateHash, target_repo: workflow.targetRepo };
          } else if (nextStage === "dispatch") {
            const commercialGateHash = receiptHashField("council_decision_receipt", "commercial_gate_hash");
            const decisionArtifactHash = receiptHashField("council_decision_receipt", "decision_artifact_hash");
            const selectionHash = receiptHashField("council_decision_receipt", "selection_hash");
            nextSourceHashes = {
              commercial_gate_hash: commercialGateHash,
              decision_artifact_hash: decisionArtifactHash,
              selection_hash: selectionHash,
            };
            transitionContext = { commercial_gate_hash: commercialGateHash, decision_artifact_hash: decisionArtifactHash, selection_hash: selectionHash };
          } else if (nextStage === "implementation") {
            const linkedIssueId = typeof payload.linked_issue_id === "string" ? payload.linked_issue_id : "";
            const iterationDispatchHash = String(completedDispatchBinding?.dispatch_artifact_hash ?? "").toLowerCase();
            const targetBaseSha = String(asRecord(workflow.feedback).target_base_sha ?? "");
            const workspaceFingerprint = String(asRecord(workflow.feedback).workspace_fingerprint ?? "").toLowerCase();
            if (!linkedIssueId || !workflow.targetRepo || !targetBaseSha || !/^[a-f0-9]{64}$/.test(workspaceFingerprint) ||
                !/^[a-f0-9]{64}$/.test(iterationDispatchHash)) {
              throw new ProfitFlywheelError("profit_flywheel_transition_source_missing", "Implementation transition lacks issue/repo/base/workspace authority");
            }
            nextSourceHashes = {
              dispatch_hash: iterationDispatchHash,
              issue_id: hashProfitFlywheelValue(linkedIssueId),
              target_repo: hashProfitFlywheelValue(workflow.targetRepo),
              target_base_sha: hashProfitFlywheelValue(targetBaseSha),
              workspace_fingerprint: workspaceFingerprint,
            };
            transitionContext = {
              linked_issue_id: linkedIssueId,
              target_repo: workflow.targetRepo,
              target_base_sha: targetBaseSha,
              workspace_fingerprint: workspaceFingerprint,
              iteration_dispatch_binding: completedDispatchBinding,
            };
          } else if (nextStage === "qa") {
            const implementation = receiptAttributes("implementation_receipt");
            const targetCommitHash = String(implementation.artifact_hash ?? "").toLowerCase();
            nextSourceHashes = {
              implementation_hash: outputHash.toLowerCase(),
              target_commit: targetCommitHash,
              qa_plan_hash: hashProfitFlywheelValue(stageDefinition(contract, "qa")),
            };
            transitionContext = { target_commit_or_patch_hash: implementation.target_commit_or_patch_hash ?? null, target_commit_hash: targetCommitHash };
          } else if (nextStage === "release") {
            const qa = receiptAttributes("qa_receipt");
            const targetCommitHash = String(qa.implementation_artifact_hash ?? "").toLowerCase();
            nextSourceHashes = {
              qa_hash: outputHash.toLowerCase(),
              target_commit: targetCommitHash,
              release_plan_hash: hashProfitFlywheelValue({ definition: stageDefinition(contract, "release"), target_origin_url: asRecord(workflow.feedback).target_origin_url }),
            };
            transitionContext = { implementation_git_object: qa.implementation_git_object ?? null, target_commit_hash: targetCommitHash, target_origin_url: asRecord(workflow.feedback).target_origin_url ?? null };
          } else if (nextStage === "commercial_observation") {
            const release = receiptAttributes("release_receipt");
            const releaseHash = String(release.artifact_hash ?? "").toLowerCase();
            assertSha256(releaseHash, "release_receipt.artifact_hash");
            const measuredSourceReceipt = validSourceReceipts.find((receipt) => receipt.receiptType === "measured_source_receipt") ?? null;
            const measuredSourceAttributes = asRecord(measuredSourceReceipt?.attributes);
            const measuredSourceArtifactHash = typeof measuredSourceAttributes.artifact_hash === "string"
              ? measuredSourceAttributes.artifact_hash.toLowerCase()
              : "";
            let measuredSourceBinding: Record<string, unknown> | null = null;
            if (measuredSourceReceipt?.artifactRef) {
              assertSha256(measuredSourceArtifactHash, "measured_source_receipt.artifact_hash");
              const releaseReceipt = validSourceReceipts.find((receipt) => receipt.receiptType === "release_receipt") ?? null;
              const releaseAttributes = asRecord(releaseReceipt?.attributes);
              if (measuredSourceAttributes.workflow_id !== workflow.id || measuredSourceAttributes.stage_run_id !== sourceStage.id ||
                  measuredSourceAttributes.linked_issue_id !== sourceStage.linkedIssueId ||
                  measuredSourceAttributes.release_artifact_ref !== releaseReceipt?.artifactRef ||
                  measuredSourceAttributes.release_artifact_hash !== releaseAttributes.artifact_hash ||
                  measuredSourceAttributes.source_execution_receipt_sha256 !== asRecord(sourceStage.feedback).execution_receipt_sha256) {
                throw new ProfitFlywheelError("profit_flywheel_measured_source_lineage_invalid", "Measured source does not bind the exact release workflow, issue, artifact, and execution receipt");
              }
              await verifyArtifactReference(
                measuredSourceReceipt.artifactRef,
                measuredSourceArtifactHash,
                workflowArtifactRoots(workflow).allowedArtifactRoots,
                workflow.targetWorkspaceRoot,
              );
              measuredSourceBinding = {
                path: await realpath(measuredSourceReceipt.artifactRef),
                sha256: measuredSourceArtifactHash,
                artifact_ref: measuredSourceReceipt.artifactRef,
                artifact_hash: measuredSourceArtifactHash,
                receipt_hash: measuredSourceReceipt.contentHash,
                stage_run_id: sourceStage.id,
                receipt_type: measuredSourceReceipt.receiptType,
              };
            }
            const commercialSummary = asRecord(asRecord(workflow.feedback).commercial_gate_summary);
            const measurement = asRecord(measuredSourceAttributes.measurement);
            const windowSeconds = stageDefinition(contract, "commercial_observation").freshness_limit_seconds;
            const releasedAt = sourceStage.completedAt ?? now;
            const immediateOperational = measuredSourceBinding !== null;
            const notBefore = immediateOperational ? releasedAt : new Date(releasedAt.getTime() + windowSeconds * 1000);
            const windowStart = immediateOperational && typeof measurement.measurement_window_start === "string"
              ? new Date(measurement.measurement_window_start)
              : releasedAt;
            const windowEnd = immediateOperational && typeof measurement.measurement_window_end === "string"
              ? new Date(measurement.measurement_window_end)
              : notBefore;
            if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime()) || windowEnd < windowStart) {
              throw new ProfitFlywheelError("profit_flywheel_measurement_window_invalid", "Verified measurement source has an invalid or reversed window");
            }
            const observationWindow = {
              start: windowStart.toISOString(),
              end: windowEnd.toISOString(),
              not_before: notBefore.toISOString(),
            };
            const validationQuery = typeof commercialSummary.cheapest_validation_step === "string" && commercialSummary.cheapest_validation_step.trim()
              ? commercialSummary.cheapest_validation_step.trim()
              : "registered commercial validation outcome for the released artifact";
            const registryClaim = asRecord(workflow.feedback).commercial_source_registry_hash;
            const registryHash = typeof registryClaim === "string" && /^[a-f0-9]{64}$/.test(registryClaim)
              ? registryClaim
              : hashProfitFlywheelValue(commercialSummary);
            const measurementPlan = {
              schema_version: "paperclip.commercial_measurement_plan.v3",
              target_repo: workflow.targetRepo,
              release_hash: releaseHash,
              metric: {
                kind: immediateOperational ? "operational" : "commercial",
                name: immediateOperational ? String(measurement.metric_name ?? "artifact_backed_release_verified") : "cheapest_validation_step_outcome",
                unit: immediateOperational ? String(measurement.metric_unit ?? "verified_release") : "validated_signal",
                baseline_value: immediateOperational ? Number(measurement.baseline_value ?? 0) : 0,
              },
              source: {
                mode: immediateOperational ? "immediate_operational" : "registered_commercial",
                authority: immediateOperational ? "paperclip_verified_release_execution" : "portfolio_os_source_registry",
                query: validationQuery,
                registry_hash: registryHash,
                binding: measuredSourceBinding,
              },
              maturity: {
                released_at: releasedAt.toISOString(),
                not_before: notBefore.toISOString(),
                window_start: windowStart.toISOString(),
                window_end: windowEnd.toISOString(),
                status: measuredSourceBinding && now >= notBefore ? "ready" : "waiting",
              },
              commercial_gate_summary: commercialSummary,
            };
            nextSourceHashes = {
              release_hash: releaseHash,
              measurement_plan_hash: hashProfitFlywheelValue(measurementPlan),
              observation_window: hashProfitFlywheelValue(observationWindow),
            };
            transitionContext = {
              measurement_plan: measurementPlan,
              observation_window: observationWindow,
              measured_source_binding: measuredSourceBinding,
              release_artifact_ref: validSourceReceipts.find((receipt) => receipt.receiptType === "release_receipt")?.artifactRef ?? null,
            };
          } else if (nextStage === "learning") {
            const observation = receiptAttributes("commercial_observation_receipt");
            const releaseStage = await tx.select().from(profitFlywheelStageRuns).where(and(
              eq(profitFlywheelStageRuns.workflowId, workflow.id), eq(profitFlywheelStageRuns.stage, "release"), eq(profitFlywheelStageRuns.state, "succeeded"),
            )).orderBy(asc(profitFlywheelStageRuns.createdAt)).then((rows) => rows.at(-1) ?? null);
            const releaseReceipt = releaseStage ? await tx.select().from(profitFlywheelReceipts).where(and(
              eq(profitFlywheelReceipts.stageRunId, releaseStage.id), eq(profitFlywheelReceipts.receiptType, "release_receipt"), eq(profitFlywheelReceipts.status, "valid"),
            )).then((rows) => rows[0] ?? null) : null;
            const releaseHash = String(asRecord(releaseReceipt?.attributes).artifact_hash ?? "").toLowerCase();
            nextSourceHashes = {
              observation_hash: outputHash.toLowerCase(),
              release_hash: releaseHash,
              target_repo: hashProfitFlywheelValue(workflow.targetRepo),
            };
            transitionContext = { observation_artifact_ref: validSourceReceipts.find((receipt) => receipt.receiptType === "commercial_observation_receipt")?.artifactRef ?? null, source_artifact_hash: observation.source_artifact_hash ?? null, release_hash: releaseHash, target_repo: workflow.targetRepo };
          } else {
            const learning = receiptAttributes("learning_receipt");
            const persistedRegistry = asRecord(asRecord(workflow.feedback).research_registry_authority);
            const currentRegistry = await loadPortfolioOsResearchRegistryAuthority();
            if (stableJson(persistedRegistry) !== stableJson(currentRegistry)) {
              throw new ProfitFlywheelError(
                "profit_flywheel_research_registry_binding_drift",
                "Learning cannot start another research iteration because its kickoff-pinned source registry differs from current canonical bytes",
              );
            }
            const authorityRef = requireStringField(learning, "next_research_authority_ref", "learning_receipt");
            const authoritySha256 = requireShaField(learning, "next_research_authority_sha256", "learning_receipt");
            const authorityPayloadSha256 = requireShaField(learning, "next_research_payload_sha256", "learning_receipt");
            await verifyArtifactReference(
              authorityRef,
              authoritySha256,
              workflowArtifactRoots(workflow).allowedArtifactRoots,
              workflow.targetWorkspaceRoot,
            );
            const authorityFile = await readImmutableFileStrict(path.resolve(authorityRef), "POS next-research authorization", 1024 * 1024);
            let authorization: Record<string, unknown>;
            try { authorization = asRecord(JSON.parse(authorityFile.bytes.toString("utf8"))); } catch { authorization = {}; }
            const contractDirectory = path.dirname(workflow.contractPath);
            const nextAuthoritySchema = await validatePinnedResearchArtifactSchema({
              value: authorization,
              schemaPath: path.join(contractDirectory, "pos.next_research_authorization.v1.schema.json"),
              expectedSha256: PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256,
              label: "POS next-research authorization",
            });
            if (authorityFile.sha256 !== authoritySha256 || hashProfitFlywheelValue(authorization) !== authorityPayloadSha256 ||
                authorization.target_repo !== workflow.targetRepo ||
                stableJson(authorization.source_registry) !== stableJson(currentRegistry.registry) ||
                authorization.source_plan_hash !== hashProfitFlywheelValue(authorization.source_requests)) {
              throw new ProfitFlywheelError("profit_flywheel_research_authority_binding_invalid", "POS next-research authorization bytes, target, registry, or source-plan hash differ from the learning receipt authority");
            }
            const governance = asRecord(authorization.governance);
            const windowPolicy = asRecord(governance.collection_window_policy);
            const notBefore = new Date(String(windowPolicy.not_before ?? ""));
            const expiresAt = new Date(String(governance.expires_at ?? ""));
            const authorizedAt = new Date(String(governance.authorized_at ?? ""));
            const maxDurationSeconds = Number(windowPolicy.max_duration_seconds);
            if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(authorizedAt.getTime()) ||
                !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 60 ||
                authorizedAt > notBefore || notBefore >= expiresAt ||
                new Date(requireStringField(learning, "next_research_not_before", "learning_receipt")).getTime() !== notBefore.getTime() ||
                new Date(requireStringField(learning, "next_research_expires_at", "learning_receipt")).getTime() !== expiresAt.getTime()) {
              throw new ProfitFlywheelError("profit_flywheel_research_authority_window_invalid", "Learning receipt and POS authorization disagree on the bounded next-research window");
            }
            const collectionTo = new Date(Math.min(expiresAt.getTime(), notBefore.getTime() + maxDurationSeconds * 1000));
            if (collectionTo <= notBefore) {
              throw new ProfitFlywheelError("profit_flywheel_research_authority_window_invalid", "POS authorization provides no usable bounded collection window");
            }
            const researchSchema = await validatePinnedResearchArtifactSchema({
              schemaPath: path.join(contractDirectory, "paperclip.research_plan.v2.schema.json"),
              expectedSha256: PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256,
              label: "Paperclip research plan v2",
            });
            const authorityBinding = {
              artifact_ref: authorityRef,
              artifact_sha256: authoritySha256,
              payload_sha256: authorityPayloadSha256,
            };
            const researchPlanBody = {
              schema_version: "paperclip.research_plan.v2",
              schema: researchSchema,
              authority: authorityBinding,
              target_repo: authorization.target_repo,
              source_registry: authorization.source_registry,
              evidence_families: authorization.evidence_families,
              query_families: authorization.query_families,
              query: authorization.query,
              source_requests: authorization.source_requests,
              collection_window: { from: notBefore.toISOString(), to: collectionTo.toISOString() },
              source_plan_hash: authorization.source_plan_hash,
              immutable: true,
            };
            const researchPlan = { ...researchPlanBody, plan_hash: hashProfitFlywheelValue(researchPlanBody) };
            await validatePinnedResearchArtifactSchema({
              value: researchPlan,
              schemaPath: researchSchema.path,
              expectedSha256: researchSchema.sha256,
              label: "Paperclip research plan v2",
            });
            nextSourceHashes = {
              source_registry_hash: String(asRecord(authorization.source_registry).sha256),
              selection_hash: outputHash.toLowerCase(),
              research_plan_hash: researchPlan.plan_hash,
            };
            transitionContext = {
              research_plan: researchPlan,
              research_authority_snapshot: authorization,
              research_authority_binding: authorityBinding,
            };
          }
          const nextInput = buildProfitFlywheelStageInput({ contract, stage: nextStage, sourceHashes: nextSourceHashes });
          const nextInputHash = nextInput.inputHash;
          const configuredIssueId = typeof asRecord(asRecord(workflow.feedback).stage_issue_bindings)[nextStage] === "string"
            ? String(asRecord(asRecord(workflow.feedback).stage_issue_bindings)[nextStage])
            : null;
          const linkedIssueId = nextStage === "implementation" && typeof payload.linked_issue_id === "string"
            ? payload.linked_issue_id
            : (["qa", "release", "commercial_observation", "learning"] as ProfitFlywheelStage[]).includes(nextStage)
              ? sourceStage.linkedIssueId
              : configuredIssueId;
          if (["implementation", "qa", "release", "commercial_observation", "learning"].includes(nextStage) && !linkedIssueId) {
            throw new ProfitFlywheelError(
              "profit_flywheel_issue_lineage_missing",
              `${nextStage} must remain bound to the authoritative execution issue`,
              { sourceStageRunId: sourceStage.id, sourceStage: sourceStage.stage },
            );
          }
          const stageRun = await createStageRun(tx, {
            workflow,
            contract,
            stage: nextStage,
            inputHash: nextInputHash,
            sourceHashes: nextInput.sourceHashes,
            linkedIssueId,
          });
          if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_create_failed", `Unable to create ${nextStage} stage`);
          const inheritedDispatchBinding = asRecord(asRecord(sourceStage.feedback).iteration_dispatch_binding);
          const nextDispatchBinding = nextStage === "implementation"
            ? asRecord(transitionContext.iteration_dispatch_binding)
            : inheritedDispatchBinding;
          await tx.update(profitFlywheelStageRuns).set({
            transitionSourceStageRunId: sourceStage.id,
            transitionSourceOutputHash: outputHash,
            feedback: {
              ...asRecord(stageRun.feedback),
              transition_source_stage_run_id: sourceStage.id,
              transition_source_output_hash: outputHash,
              ...(Object.keys(nextDispatchBinding).length > 0 ? { iteration_dispatch_binding: nextDispatchBinding } : {}),
              ...(nextStage === "research_intake" ? {
                research_plan: transitionContext.research_plan,
                research_authority_snapshot: transitionContext.research_authority_snapshot,
                research_authority_binding: transitionContext.research_authority_binding,
              } : {}),
            },
            updatedAt: now,
          }).where(eq(profitFlywheelStageRuns.id, stageRun.id));
          await tx.update(profitFlywheelWorkflows).set({ currentStage: nextStage, state: "running", updatedAt: now })
            .where(eq(profitFlywheelWorkflows.id, workflow.id));
          await appendEvent(tx, {
            workflow,
            stageRunId: stageRun.id,
            eventType: stageRun.ownerPlane === "paperclip" ? "stage_transition_requested" : "portfolio_os_stage_requested",
            dedupeKey: `stage-requested:${stageRun.id}`,
            toState: "pending",
            spanId: stageRun.spanId,
            payload: {
              stage: nextStage,
              input_hash: nextInputHash,
              trigger: transition.trigger,
              guard: transition.guard,
              from_stage: fromStage,
              to_stage: nextStage,
              linked_issue_id: stageRun.linkedIssueId,
              source_hashes: nextInput.sourceHashes,
              transition_context: transitionContext,
            },
            nextAttemptAt: nextStage === "research_intake"
              ? new Date(String(asRecord(asRecord(transitionContext.research_plan).collection_window).from))
              : undefined,
            processedAt: stageRun.ownerPlane === "paperclip" ? now : null,
          });
          await tx.update(profitFlywheelEvents).set({ processedAt: now, updatedAt: now, lastError: null })
            .where(eq(profitFlywheelEvents.id, current.id));
          return { eventId: current.id, action: "advanced", stageRunId: stageRun.id, stage: nextStage };
        });
        if (result) {
          results.push(result);
          if (result.action === "advanced" && result.stageRunId) {
            await dispatchPendingStages({ workflowId: event.workflowId, limit: 20 });
          }
        }
      } catch (error) {
        const errorDetail = safeOperationalError(error);
        const failure = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          const current = await tx.select().from(profitFlywheelEvents).where(and(
            eq(profitFlywheelEvents.id, event.id),
            isNull(profitFlywheelEvents.processedAt),
            eq(profitFlywheelEvents.attemptCount, event.attemptCount),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!current) return null;
          const attempts = current.attemptCount + 1;
          const terminal = attempts >= 5;
          const nextAttemptAt = terminal
            ? now
            : new Date(now.getTime() + Math.min(3600, 2 ** attempts * 5) * 1000);
          if (!terminal) {
            await tx.update(profitFlywheelEvents).set({
              attemptCount: attempts,
              nextAttemptAt,
              processedAt: null,
              lastError: errorDetail,
              updatedAt: now,
            }).where(and(
              eq(profitFlywheelEvents.id, current.id),
              isNull(profitFlywheelEvents.processedAt),
              eq(profitFlywheelEvents.attemptCount, current.attemptCount),
            ));
            return { eventId: current.id, action: "retry" as const, error: errorDetail };
          }
          const workflow = await tx.select().from(profitFlywheelWorkflows)
            .where(eq(profitFlywheelWorkflows.id, current.workflowId)).for("update")
            .then((rows) => rows[0] ?? null);
          if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Terminal event exhaustion workflow no longer exists");
          const blocker = requireBlocker({
            blockerCode: "profit_flywheel_event_retry_exhausted",
            blockerDetail: errorDetail,
            nextOwner: "paperclip_orchestrator",
            resumeCondition: "Repair the event/source receipt mismatch, then explicitly resume the same immutable event and dedupe key",
          });
          await tx.update(profitFlywheelEvents).set({
            attemptCount: attempts,
            nextAttemptAt,
            processedAt: now,
            lastError: errorDetail,
            updatedAt: now,
          }).where(and(
            eq(profitFlywheelEvents.id, current.id),
            isNull(profitFlywheelEvents.processedAt),
            eq(profitFlywheelEvents.attemptCount, current.attemptCount),
          ));
          await tx.update(profitFlywheelWorkflows).set({ state: "blocked", ...blocker, updatedAt: now })
            .where(eq(profitFlywheelWorkflows.id, workflow.id));
          await ensureWorkflowBlockerIssue(tx, workflow, blocker, "transition");
          await deps.terminalOutboxReconciliationBeforeAppend?.();
          await appendEvent(tx, {
            workflow,
            stageRunId: current.stageRunId,
            eventType: "event_retry_exhausted",
            dedupeKey: `event-retry-exhausted:${current.id}`,
            fromState: workflow.state,
            toState: "blocked",
            spanId: current.spanId,
            payload: {
              source_event_id: current.id,
              source_event_type: current.eventType,
              attempt_count: attempts,
              blocker_code: blocker.blockerCode,
              blocker_detail: blocker.blockerDetail,
              next_owner: blocker.nextOwner,
              resume_condition: blocker.resumeCondition,
            },
            processedAt: now,
          });
          return { eventId: current.id, action: "failed" as const, error: errorDetail };
        });
        if (failure) results.push(failure);
      }
    }
    if (results.some((result) => result.action === "advanced")) notifyProfitFlywheelReconciliation();
    return results;
  }

  async function recordReceipt(input: {
    stageRunId: string;
    receipt: ProfitFlywheelReceiptInput;
    leaseOwner?: string;
    leaseActor?: { type: "agent" | "board" | "system"; id: string };
    requireActiveLease?: boolean;
    trustedExecutionSync?: boolean;
  }) {
    const receipt = profitFlywheelReceiptSchema.parse(input.receipt);
    const sanitizedAttributes = sanitizeReceiptValue(receipt.attributes) as Record<string, unknown>;
    validateReceiptTypeAttributes(receipt.type, sanitizedAttributes, receipt.artifactRef);
    const sanitizedSize = Buffer.byteLength(stableJson(sanitizedAttributes), "utf8");
    if (sanitizedSize > 128 * 1024) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_too_large", "Receipt attributes exceed 128 KiB", { bytes: sanitizedSize });
    }
    if (receipt.artifactRef) {
      if (SECRET_VALUE_PATTERN.test(receipt.artifactRef) || /[?&](?:key|token|secret|password)=/i.test(receipt.artifactRef)) {
        throw new ProfitFlywheelError("profit_flywheel_receipt_secret_rejected", "Artifact reference contains secret-like material");
      }
    }
    const canonicalHash = canonicalProfitFlywheelReceiptHash({
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      artifactRef: receipt.artifactRef,
      observedAt: receipt.observedAt,
      expiresAt: receipt.expiresAt,
      attributes: sanitizedAttributes,
    });
    if (receipt.contentHash.toLowerCase() !== canonicalHash) {
      throw new ProfitFlywheelError("profit_flywheel_receipt_hash_mismatch", "Receipt contentHash does not match its canonical stable JSON payload", {
        expected: canonicalHash,
        observed: receipt.contentHash,
      });
    }
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const stageRun = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId))
        .then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Stage run not found");
      if (stageRun.ownerPlane === "paperclip" && new Set([
        "issue_receipt", "provider_run_receipt", "implementation_receipt", "qa_receipt",
        "independent_review_receipt", "release_receipt", "measured_source_receipt", "execution_adjudication_receipt",
      ]).has(receipt.type) && input.trustedExecutionSync !== true) {
        throw new ProfitFlywheelError(
          "profit_flywheel_untrusted_completion_receipt",
          "Provider-backed Paperclip completion receipts may only be synthesized from the exact verified context-ledger execution receipt",
        );
      }
      const now = new Date();
      if (input.requireActiveLease && (
        !input.leaseOwner || !input.leaseActor ||
        stageRun.leaseOwner !== input.leaseOwner ||
        stageRun.leaseActorType !== input.leaseActor.type ||
        stageRun.leaseActorId !== input.leaseActor.id ||
        stageRun.state !== "running" ||
        !stageRun.leaseExpiresAt || stageRun.leaseExpiresAt <= now
      )) {
        throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Receipt mutation requires the matching active, unexpired stage lease actor");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows)
        .where(eq(profitFlywheelWorkflows.id, stageRun.workflowId))
        .then((rows) => rows[0] ?? null);
      if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Receipt workflow not found");
      if (receipt.artifactRef) {
        const artifactPolicy = workflowArtifactRoots(workflow);
        await verifyArtifactReference(receipt.artifactRef, sanitizedAttributes.artifact_hash, artifactPolicy.allowedArtifactRoots, artifactPolicy.targetRepoRoot);
      }
      const existingTypeReceipts = await tx.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, stageRun.id),
        eq(profitFlywheelReceipts.receiptType, receipt.type),
      )).orderBy(asc(profitFlywheelReceipts.createdAt));
      const receiptAttempt = ATTEMPT_SCOPED_EXECUTION_RECEIPTS.has(receipt.type)
        ? Number(sanitizedAttributes.attempt)
        : null;
      if (receiptAttempt !== null && (!Number.isInteger(receiptAttempt) || receiptAttempt !== stageRun.attemptCount)) {
        throw new ProfitFlywheelError("profit_flywheel_receipt_attempt_mismatch", "Execution receipt must bind the exact active stage attempt");
      }
      const existingTypeReceipt = existingTypeReceipts.find((candidate) =>
        receiptAttempt === null || asRecord(candidate.attributes).attempt === receiptAttempt,
      ) ?? null;
      if (existingTypeReceipt) {
        const existingCanonicalHash = canonicalProfitFlywheelReceiptHash({
          type: existingTypeReceipt.receiptType,
          schemaVersion: existingTypeReceipt.schemaVersion,
          artifactRef: existingTypeReceipt.artifactRef,
          observedAt: existingTypeReceipt.observedAt.toISOString(),
          expiresAt: existingTypeReceipt.expiresAt?.toISOString() ?? null,
          attributes: existingTypeReceipt.attributes,
        });
        if (existingTypeReceipt.status !== "valid" || existingCanonicalHash !== existingTypeReceipt.contentHash.toLowerCase() ||
            existingTypeReceipt.contentHash.toLowerCase() !== canonicalHash) {
          throw new ProfitFlywheelError(
            "profit_flywheel_receipt_type_conflict",
            "A stage may have only one canonical valid receipt body for each receipt type",
            { stageRunId: stageRun.id, receiptType: receipt.type },
          );
        }
        return existingTypeReceipt;
      }
      if (receiptAttempt !== null) {
        const supersededIds = existingTypeReceipts.filter((candidate) =>
          candidate.status === "valid" && asRecord(candidate.attributes).attempt !== receiptAttempt,
        ).map((candidate) => candidate.id);
        if (supersededIds.length > 0) {
          await tx.update(profitFlywheelReceipts).set({ status: "revoked" }).where(inArray(profitFlywheelReceipts.id, supersededIds));
        }
      }
      return tx.insert(profitFlywheelReceipts).values({
        companyId: stageRun.companyId,
        workflowId: stageRun.workflowId,
        stageRunId: stageRun.id,
        receiptType: receipt.type,
        schemaVersion: receipt.schemaVersion,
        contentHash: canonicalHash,
        artifactRef: receipt.artifactRef,
        status: "valid",
        observedAt: new Date(receipt.observedAt),
        expiresAt: receipt.expiresAt ? new Date(receipt.expiresAt) : null,
        attributes: sanitizedAttributes,
        correlationId: stageRun.correlationId,
        traceId: stageRun.traceId,
        spanId: stageRun.spanId,
      }).onConflictDoNothing({
        target: [profitFlywheelReceipts.stageRunId, profitFlywheelReceipts.receiptType, profitFlywheelReceipts.contentHash],
      }).returning().then(async (rows) => rows[0] ?? tx.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, stageRun.id),
        eq(profitFlywheelReceipts.receiptType, receipt.type),
        eq(profitFlywheelReceipts.contentHash, canonicalHash),
      )).then((existing) => existing[0]));
    });
  }

  async function recordExecutionAdjudication(input: {
    stageRunId: string;
    expectedLease: ExpectedLease;
    attempt: number;
    inputHash: string;
    heartbeatRunId: string;
    providerRouteId: string;
    observedOutcome: string;
    processExitCode: number | null;
    finalResponseComplete: boolean;
    falseSuccess: boolean;
    evidence: { path: string; sha256: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    assertSha256(input.inputHash, "adjudication.inputHash");
    assertSha256(input.evidence.sha256, "adjudication.evidence.sha256");
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || !input.heartbeatRunId.trim() || !input.providerRouteId.trim() ||
        !input.observedOutcome.trim() || !(input.processExitCode === null || Number.isInteger(input.processExitCode)) ||
        input.falseSuccess !== (input.processExitCode === 0 && input.finalResponseComplete === false)) {
      throw new ProfitFlywheelError("profit_flywheel_adjudication_invalid", "Execution adjudication identity and exit/final-response invariant are invalid");
    }
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const stageRun = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Execution adjudication stage is missing");
      assertExpectedLease(stageRun, input.expectedLease);
      if (stageRun.state !== "running" || !stageRun.leaseExpiresAt || stageRun.leaseExpiresAt <= now ||
          stageRun.attemptCount !== input.attempt || stageRun.inputHash !== input.inputHash ||
          stageRun.providerRouteId !== input.providerRouteId) {
        throw new ProfitFlywheelError("profit_flywheel_adjudication_lineage_invalid", "Execution adjudication does not bind the exact active leased attempt and route");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const heartbeatRun = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.heartbeatRunId)).then((rows) => rows[0] ?? null);
      const heartbeatContext = asRecord(heartbeatRun?.contextSnapshot);
      if (!heartbeatRun || !heartbeatRun.executionEvidenceNonce || !/^[a-f0-9]{64}$/.test(heartbeatRun.executionEvidenceNonce) ||
          heartbeatRun.companyId !== stageRun.companyId || heartbeatContext.profitFlywheelStageRunId !== stageRun.id ||
          heartbeatContext.issueId !== stageRun.linkedIssueId || stageRun.leaseActorType !== "system" || stageRun.leaseActorId !== heartbeatRun.id) {
        throw new ProfitFlywheelError("profit_flywheel_adjudication_heartbeat_invalid", "Execution adjudication lacks the exact server-only heartbeat observation intent");
      }
      const roots = workflowArtifactRoots(workflow);
      await verifyArtifactReference(input.evidence.path, input.evidence.sha256.toLowerCase(), roots.allowedArtifactRoots, roots.targetRepoRoot);
      const evidenceFile = await readImmutableFileStrict(input.evidence.path, "server-observed execution adjudication", 2 * 1024 * 1024);
      if ((evidenceFile.stat.mode & 0o777) !== 0o444 || evidenceFile.sha256 !== input.evidence.sha256.toLowerCase()) {
        throw new ProfitFlywheelError("profit_flywheel_adjudication_artifact_invalid", "Execution adjudication evidence must be exact immutable mode 0444 bytes");
      }
      let evidenceValue: Record<string, unknown>;
      try { evidenceValue = asRecord(JSON.parse(evidenceFile.bytes.toString("utf8"))); } catch { evidenceValue = {}; }
      sanitizeReceiptValue(evidenceValue);
      assertExactObjectKeys(evidenceValue, [
        "schema_version", "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "heartbeat_run_id",
        "provider_route_id", "provider_family", "model", "version", "provider_policy_sha256", "provider_policy_schema_sha256", "provider_route_core_sha256",
        "provider_route_sha256", "exit_code", "signal", "timed_out", "observed_outcome", "inferred_failure_code",
        "log_sha256", "final_response_complete", "false_success", "server_observation_proof", "observed_at",
      ], "execution adjudication evidence");
      for (const field of ["provider_policy_sha256", "provider_policy_schema_sha256", "provider_route_core_sha256", "provider_route_sha256", "log_sha256", "server_observation_proof"]) {
        assertSha256(String(evidenceValue[field] ?? ""), `execution adjudication evidence.${field}`);
      }
      const observedAt = new Date(String(evidenceValue.observed_at ?? ""));
      if (evidenceValue.schema_version !== "paperclip.execution_adjudication.v1" ||
          evidenceValue.company_id !== stageRun.companyId || evidenceValue.workflow_id !== stageRun.workflowId ||
          evidenceValue.stage_run_id !== stageRun.id || evidenceValue.attempt !== stageRun.attemptCount ||
          evidenceValue.input_hash !== stageRun.inputHash || evidenceValue.heartbeat_run_id !== input.heartbeatRunId ||
          evidenceValue.provider_route_id !== stageRun.providerRouteId || evidenceValue.provider_family !== stageRun.providerFamily ||
          evidenceValue.model !== stageRun.providerModel || evidenceValue.version !== stageRun.providerModelVersion ||
          evidenceValue.provider_policy_sha256 !== stageRun.providerPolicySha256 ||
          evidenceValue.provider_policy_schema_sha256 !== asRecord(stageRun.providerRouteSnapshot).providerPolicySchemaSha256 ||
          evidenceValue.provider_route_core_sha256 !== stageRun.providerRouteCoreSha256 ||
          evidenceValue.provider_route_sha256 !== stageRun.providerRouteSha256 ||
          evidenceValue.server_observation_proof !== buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "adjudication", evidenceValue) ||
          evidenceValue.exit_code !== input.processExitCode || evidenceValue.observed_outcome !== input.observedOutcome ||
          evidenceValue.final_response_complete !== input.finalResponseComplete || evidenceValue.false_success !== input.falseSuccess ||
          evidenceValue.false_success !== (evidenceValue.exit_code === 0 && evidenceValue.final_response_complete === false) ||
          typeof evidenceValue.timed_out !== "boolean" ||
          !(evidenceValue.signal === null || typeof evidenceValue.signal === "string") ||
          !(evidenceValue.inferred_failure_code === null || typeof evidenceValue.inferred_failure_code === "string") ||
          !Number.isFinite(observedAt.getTime()) || observedAt > new Date(now.getTime() + 60_000)) {
        throw new ProfitFlywheelError("profit_flywheel_adjudication_lineage_invalid", "Execution adjudication evidence differs from the exact stage, route, outcome, or server observation");
      }
      const attributes = {
        stage_run_id: stageRun.id,
        attempt: stageRun.attemptCount,
        input_hash: stageRun.inputHash,
        heartbeat_run_id: input.heartbeatRunId,
        provider_route_id: stageRun.providerRouteId!,
        observed_outcome: input.observedOutcome,
        process_exit_code: input.processExitCode,
        final_response_complete: input.finalResponseComplete,
        false_success: input.falseSuccess,
        adjudication_source: "paperclip_server_observed_heartbeat",
        artifact_hash: evidenceFile.sha256,
      };
      validateReceiptTypeAttributes("execution_adjudication_receipt", attributes, input.evidence.path);
      const base = {
        type: "execution_adjudication_receipt",
        schemaVersion: "paperclip.execution_adjudication_receipt.v1",
        artifactRef: input.evidence.path,
        observedAt: observedAt.toISOString(),
        expiresAt: null,
        attributes,
      };
      const contentHash = canonicalProfitFlywheelReceiptHash(base);
      const prior = await tx.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, stageRun.id),
        eq(profitFlywheelReceipts.receiptType, "execution_adjudication_receipt"),
      ));
      const sameAttempt = prior.find((receipt) => asRecord(receipt.attributes).attempt === stageRun.attemptCount);
      if (sameAttempt) {
        if (sameAttempt.contentHash !== contentHash) throw new ProfitFlywheelError("profit_flywheel_adjudication_replay_conflict", "Execution attempt already has a different adjudication receipt");
        return sameAttempt;
      }
      return tx.insert(profitFlywheelReceipts).values({
        companyId: stageRun.companyId,
        workflowId: stageRun.workflowId,
        stageRunId: stageRun.id,
        receiptType: base.type,
        schemaVersion: base.schemaVersion,
        contentHash,
        artifactRef: base.artifactRef,
        status: "valid",
        observedAt,
        expiresAt: null,
        attributes,
        correlationId: stageRun.correlationId,
        traceId: stageRun.traceId,
        spanId: stageRun.spanId,
      }).returning().then((rows) => rows[0]!);
    });
  }

  async function persistArtifactCheckpoint(input: {
    stageRunId: string;
    expectedLease: ExpectedLease;
    checkpoint: { value: Record<string, unknown>; receipt: { path: string; sha256: string } };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const checkpointValue = sanitizeReceiptValue(input.checkpoint.value) as Record<string, unknown>;
    const checkpointReceipt = sanitizeReceiptValue(input.checkpoint.receipt) as Record<string, unknown>;
    const expectedKeys = [
      "schema_version", "company_id", "workflow_id", "stage_run_id", "issue_id", "attempt", "input_hash",
      "provider_route_id", "workspace_root", "head_git_object", "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256",
      "untracked", "workspace_evidence", "server_observation_proof", "observed_at",
    ].sort();
    if (stableJson(Object.keys(checkpointValue).sort()) !== stableJson(expectedKeys) ||
        stableJson(Object.keys(checkpointReceipt).sort()) !== stableJson(["path", "sha256"]) ||
        checkpointValue.schema_version !== "paperclip.profit_flywheel_artifact_checkpoint.v1") {
      throw new ProfitFlywheelError("profit_flywheel_checkpoint_schema_invalid", "Artifact checkpoint must use the exact v1 server-authored schema");
    }
    const workspaceEvidence = asRecord(checkpointValue.workspace_evidence);
    const workspaceEvidencePath = typeof workspaceEvidence.path === "string" ? workspaceEvidence.path : "";
    const workspaceEvidenceSha256 = typeof workspaceEvidence.sha256 === "string" ? workspaceEvidence.sha256.toLowerCase() : "";
    const receiptPath = typeof checkpointReceipt.path === "string" ? checkpointReceipt.path : "";
    const receiptSha256 = typeof checkpointReceipt.sha256 === "string" ? checkpointReceipt.sha256.toLowerCase() : "";
    const untracked = Array.isArray(checkpointValue.untracked) ? checkpointValue.untracked : null;
    for (const field of ["company_id", "workflow_id", "stage_run_id", "input_hash", "workspace_root", "head_git_object", "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256", "server_observation_proof", "observed_at"]) {
      if (typeof checkpointValue[field] !== "string" || !String(checkpointValue[field]).trim()) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_schema_invalid", `Artifact checkpoint ${field} is required`);
      }
    }
    if (!Number.isInteger(checkpointValue.attempt) || Number(checkpointValue.attempt) < 1 || !untracked || untracked.length > 1000 ||
        !path.isAbsolute(receiptPath) || !/^[a-f0-9]{64}$/.test(receiptSha256) ||
        !path.isAbsolute(workspaceEvidencePath) || !/^[a-f0-9]{64}$/.test(workspaceEvidenceSha256)) {
      throw new ProfitFlywheelError("profit_flywheel_checkpoint_schema_invalid", "Artifact checkpoint attempt, untracked set, receipt, and workspace-evidence bindings are invalid");
    }
    for (const [field, value] of [["input_hash", checkpointValue.input_hash], ["tracked_diff_sha256", checkpointValue.tracked_diff_sha256], ["index_diff_sha256", checkpointValue.index_diff_sha256], ["status_sha256", checkpointValue.status_sha256]]) {
      assertSha256(String(value), `checkpoint.${field}`);
    }
    assertSha256(String(checkpointValue.server_observation_proof), "checkpoint.server_observation_proof");
    if (!/^[a-f0-9]{40,64}$/i.test(String(checkpointValue.head_git_object))) {
      throw new ProfitFlywheelError("profit_flywheel_checkpoint_schema_invalid", "Artifact checkpoint head_git_object must be a Git object id");
    }
    for (const row of untracked) {
      const entry = asRecord(row);
      if (typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..") ||
          typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_schema_invalid", "Artifact checkpoint untracked entries must be bounded relative path/hash/byte bindings");
      }
    }
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const stageRun = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Checkpoint stage run not found");
      assertExpectedLease(stageRun, input.expectedLease);
      if (stageRun.state !== "running" || !stageRun.leaseExpiresAt || stageRun.leaseExpiresAt <= now ||
          checkpointValue.company_id !== stageRun.companyId || checkpointValue.workflow_id !== stageRun.workflowId ||
          checkpointValue.stage_run_id !== stageRun.id || checkpointValue.issue_id !== stageRun.linkedIssueId ||
          checkpointValue.attempt !== stageRun.attemptCount || checkpointValue.input_hash !== stageRun.inputHash ||
          checkpointValue.provider_route_id !== stageRun.providerRouteId) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Artifact checkpoint does not bind the exact active leased stage attempt and provider route");
      }
      const heartbeatRun = stageRun.leaseActorType === "system" && stageRun.leaseActorId
        ? await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stageRun.leaseActorId)).then((rows) => rows[0] ?? null)
        : null;
      if (!heartbeatRun?.executionEvidenceNonce || checkpointValue.server_observation_proof !==
          buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "checkpoint", checkpointValue)) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Artifact checkpoint lacks the exact server-only heartbeat observation intent");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const workspaceRoot = await realpath(String(checkpointValue.workspace_root)).catch(() => "");
      if (workspaceRoot !== await realpath(workflow.targetWorkspaceRoot).catch(() => "")) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Artifact checkpoint workspace differs from the workflow authority");
      }
      const roots = workflowArtifactRoots(workflow);
      await verifyArtifactReference(workspaceEvidencePath, workspaceEvidenceSha256, roots.allowedArtifactRoots, roots.targetRepoRoot);
      await verifyArtifactReference(receiptPath, receiptSha256, roots.allowedArtifactRoots, roots.targetRepoRoot);
      const workspaceFile = await readImmutableFileStrict(workspaceEvidencePath, "Profit Flywheel workspace evidence", 2 * 1024 * 1024);
      let workspaceValue: Record<string, unknown>;
      try { workspaceValue = asRecord(JSON.parse(workspaceFile.bytes.toString("utf8"))); } catch { workspaceValue = {}; }
      sanitizeReceiptValue(workspaceValue);
      assertExactObjectKeys(workspaceValue, [
        "schema_version", "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "workspace_root",
        "head_git_object", "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256", "untracked",
        "server_observation_proof", "observed_at",
      ], "Profit Flywheel workspace evidence");
      const sharedWorkspaceFields = [
        "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "workspace_root", "head_git_object",
        "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256", "untracked", "observed_at",
      ];
      if (workspaceFile.sha256 !== workspaceEvidenceSha256 || (workspaceFile.stat.mode & 0o777) !== 0o444 ||
          workspaceValue.schema_version !== "paperclip.profit_flywheel_workspace_evidence.v1" ||
          workspaceValue.server_observation_proof !== buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "workspace", workspaceValue) ||
          !sharedWorkspaceFields.every((field) => stableJson(workspaceValue[field]) === stableJson(checkpointValue[field]))) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_artifact_invalid", "Workspace evidence lacks the exact server proof or differs from its checkpoint body");
      }
      const artifactFile = await readImmutableFileStrict(receiptPath, "Profit Flywheel artifact checkpoint", 2 * 1024 * 1024);
      let artifactValue: unknown;
      try { artifactValue = JSON.parse(artifactFile.bytes.toString("utf8")); } catch { artifactValue = null; }
      if (stableJson(artifactValue) !== stableJson(checkpointValue) || artifactFile.sha256 !== receiptSha256 || (artifactFile.stat.mode & 0o777) !== 0o444) {
        throw new ProfitFlywheelError("profit_flywheel_checkpoint_artifact_invalid", "Checkpoint database body, immutable file bytes, hash, or mode differ");
      }
      const persistedCheckpoint = { ...checkpointValue, checkpoint_receipt: { path: receiptPath, sha256: receiptSha256 } };
      const updated = await tx.update(profitFlywheelStageRuns).set({ artifactCheckpoint: persistedCheckpoint, updatedAt: now }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, "running"),
        eq(profitFlywheelStageRuns.attemptCount, stageRun.attemptCount),
        gt(profitFlywheelStageRuns.leaseExpiresAt, now),
        ...expectedLeaseConditions(input.expectedLease),
      )).returning({ id: profitFlywheelStageRuns.id });
      if (updated.length !== 1) throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Checkpoint persistence lost the active stage lease CAS");
      return { stageRunId: stageRun.id, attempt: stageRun.attemptCount, checkpointReceiptPath: receiptPath, checkpointReceiptSha256: receiptSha256 };
    });
  }

  async function acquireLease(tx: Db, input: {
    companyId: string;
    stageRunId: string;
    scopeType: string;
    scopeKey: string;
    limit: number;
    leaseOwner: string;
    expiresAt: Date;
  }) {
    await tx.delete(profitFlywheelLeases).where(and(
      eq(profitFlywheelLeases.scopeType, input.scopeType),
      eq(profitFlywheelLeases.scopeKey, input.scopeKey),
      lte(profitFlywheelLeases.expiresAt, new Date()),
    ));
    for (let slot = 0; slot < input.limit; slot += 1) {
      const lease = await tx.insert(profitFlywheelLeases).values({
        companyId: input.companyId,
        stageRunId: input.stageRunId,
        scopeType: input.scopeType,
        scopeKey: input.scopeKey,
        slot,
        leaseOwner: input.leaseOwner,
        expiresAt: input.expiresAt,
      }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
      if (lease) return lease;
    }
    throw new ProfitFlywheelError("profit_flywheel_concurrency_limit", `No ${input.scopeType} concurrency slot is available`, {
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      limit: input.limit,
      nextOwner: "paperclip_orchestrator",
    });
  }

  async function claimStage(input: {
    stageRunId: string;
    actorType: "agent" | "board" | "system";
    actorId: string;
    agentId?: string | null;
    portfolioOsAuthority?: boolean;
    portfolioOsClaim?: { eventId: string; attempt: number; claimNonce: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const stageRun = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, input.stageRunId))
      .then((rows) => rows[0] ?? null);
    if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Stage run not found");
    const workflow = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, stageRun.workflowId))
      .then((rows) => rows[0] ?? null);
    if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Workflow not found");
    if (stageRun.ownerPlane === "portfolio_os") {
      if (input.portfolioOsAuthority !== true) {
        throw new ProfitFlywheelError("profit_flywheel_pos_ack_required", "Portfolio OS-owned stages may only be claimed through the identity-bound outbox acknowledgement flow");
      }
      if (input.actorType === "agent") {
        await assertPortfolioOsExecutorPrincipal(workflow, input.actorId);
      } else if (input.actorType !== "system" || input.actorId !== "profit-flywheel-pos-reconciler") {
        throw new ProfitFlywheelError("profit_flywheel_pos_principal_required", "Portfolio OS stage claim requires the exact orchestrator or bounded internal reconciler");
      }
      if (input.portfolioOsClaim) {
        const claim = asRecord(stageRun.feedback).portfolio_os_claim;
        if (!claim || typeof claim !== "object" ||
            asRecord(claim).event_id !== input.portfolioOsClaim.eventId ||
            asRecord(claim).attempt !== input.portfolioOsClaim.attempt ||
            asRecord(claim).claim_nonce !== input.portfolioOsClaim.claimNonce ||
            stageRun.attemptCount !== input.portfolioOsClaim.attempt) {
          throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", "Portfolio OS claim does not bind the exact current server-issued attempt nonce");
        }
      }
    }
    const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
    const stage = stageRun.stage as ProfitFlywheelStage;
    const definition = stageDefinition(contract, stage);
    const verifiedStageInput = buildProfitFlywheelStageInput({ contract, stage, sourceHashes: stageRun.sourceHashes });
    if (stage !== "dispatch" && verifiedStageInput.inputHash !== stageRun.inputHash) {
      throw new ProfitFlywheelError("profit_flywheel_input_hash_mismatch", "Stage input_hash no longer matches its exact persisted source_hashes");
    }
    if (stageRun.state === "retry" && stageRun.retryAt && stageRun.retryAt > now) {
      throw new ProfitFlywheelError("profit_flywheel_retry_not_due", `Stage retry is not due until ${stageRun.retryAt.toISOString()}`);
    }
    const alias = stageCapabilityAlias(definition.provider_capability_class);
    const paperclipAlias = definition.owner_plane === "paperclip" ? alias : null;
    if (!(["pending", "retry"] as string[]).includes(stageRun.state)) {
      throw new ProfitFlywheelError("profit_flywheel_stage_not_claimable", `${stage} stage is ${stageRun.state}, not pending/retry`);
    }
    if (definition.owner_plane === "paperclip" && alias && !stageRun.linkedIssueId) {
      throw new ProfitFlywheelError("profit_flywheel_issue_required", `${stage} stage is not linked to an issue`);
    }
    if (definition.owner_plane === "paperclip" && alias && stageRun.linkedIssueId) {
      const linkedIssue = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
        .where(eq(issues.id, stageRun.linkedIssueId)).then((rows) => rows[0] ?? null);
      if (!linkedIssue?.assigneeAgentId || linkedIssue.assigneeAgentId !== input.agentId) {
        throw new ProfitFlywheelError("profit_flywheel_issue_assignee_mismatch", `${stage} stage agent must match the linked issue assignee`, {
          linkedIssueId: stageRun.linkedIssueId,
          expectedAgentId: linkedIssue?.assigneeAgentId ?? null,
          observedAgentId: input.agentId ?? null,
        });
      }
    }
    const loadedPolicy = await loadProviderPolicyV2();
    const workflowPolicy = asRecord(asRecord(workflow.feedback).provider_policy);
    const workflowPolicyIsCurrent = (
      workflowPolicy.sha256 !== loadedPolicy.sha256 ||
      workflowPolicy.schema_sha256 !== loadedPolicy.schemaSha256 ||
      workflowPolicy.schema_version !== "provider-policy.v2"
    ) === false;
    const workflowPolicyCanRebind = !workflowPolicyIsCurrent &&
      workflowPolicy.schema_version === "provider-policy.v2" &&
      workflowPolicy.path === loadedPolicy.path &&
      workflowPolicy.schema_path === loadedPolicy.schemaPath &&
      workflowPolicy.schema_sha256 === loadedPolicy.schemaSha256 &&
      typeof workflowPolicy.sha256 === "string" && /^[a-f0-9]{64}$/.test(workflowPolicy.sha256);
    if (!workflowPolicyIsCurrent && !workflowPolicyCanRebind) {
      throw new ProfitFlywheelError("profit_flywheel_provider_policy_binding_mismatch", "Workflow provider policy binding is stale or incomplete");
    }
    if (paperclipAlias && !input.agentId) {
      throw new ProfitFlywheelError("profit_flywheel_agent_required", "Provider-backed stage requires an agent concurrency key");
    }
    const builderProviderFamily = stage === "qa"
      ? (await exactQaBuilderStage(db, stageRun))?.providerFamily ?? null
      : null;
    const resolved = paperclipAlias
      ? await providerCanaryService(db).resolveHealthyAlias({
          companyId: workflow.companyId,
          policy: loadedPolicy.policy,
          policySha256: loadedPolicy.sha256,
          policySchemaSha256: loadedPolicy.schemaSha256,
          alias: paperclipAlias,
          excludedProviderFamily: builderProviderFamily,
          release: stage === "release",
          now,
        })
      : null;
    const resolvedRoute = resolved
      ? buildResolvedProviderRoute({
          policy: loadedPolicy.policy,
          policySha256: loadedPolicy.sha256,
          policySchemaSha256: loadedPolicy.schemaSha256,
          routeId: resolved.route.id,
          catalogEvidence: resolved.health.catalogEvidence as import("./provider-policy.js").ProviderCatalogEvidenceBinding | null,
        })
      : null;
    const expiresAt = new Date(now.getTime() + contract.recovery.orphan_timeout_seconds * 1000);
    if (!input.actorId.trim()) throw new ProfitFlywheelError("profit_flywheel_actor_required", "Stage claim requires an authenticated actor id");
    const leaseOwner = `${input.actorType}:${input.actorId}:${stageRun.id}`;
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const currentWorkflow = await tx.select().from(profitFlywheelWorkflows)
        .where(eq(profitFlywheelWorkflows.id, workflow.id)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentWorkflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Workflow not found");
      const current = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, stageRun.id))
        .then((rows) => rows[0] ?? null);
      if (!current || !["pending", "retry"].includes(current.state)) {
        throw new ProfitFlywheelError("profit_flywheel_stage_claim_race", "Stage was claimed by another worker");
      }
      if (input.portfolioOsClaim) {
        const claim = asRecord(asRecord(current.feedback).portfolio_os_claim);
        if (claim.event_id !== input.portfolioOsClaim.eventId || claim.attempt !== input.portfolioOsClaim.attempt ||
            claim.claim_nonce !== input.portfolioOsClaim.claimNonce || current.attemptCount !== input.portfolioOsClaim.attempt) {
          throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", "Portfolio OS attempt claim changed before the execution lease CAS");
        }
      }
      if (workflowPolicyCanRebind) {
        const currentFeedback = asRecord(currentWorkflow.feedback);
        const currentBinding = asRecord(currentFeedback.provider_policy);
        const bindingAlreadyCurrent = currentBinding.sha256 === loadedPolicy.sha256 &&
          currentBinding.schema_sha256 === loadedPolicy.schemaSha256 &&
          currentBinding.schema_version === "provider-policy.v2";
        const bindingUnchanged = currentBinding.path === workflowPolicy.path &&
          currentBinding.sha256 === workflowPolicy.sha256 &&
          currentBinding.schema_version === workflowPolicy.schema_version &&
          currentBinding.schema_path === workflowPolicy.schema_path &&
          currentBinding.schema_sha256 === workflowPolicy.schema_sha256;
        if (!bindingAlreadyCurrent && !bindingUnchanged) {
          throw new ProfitFlywheelError("profit_flywheel_provider_policy_binding_race", "Workflow provider policy binding changed before stage claim");
        }
        if (!bindingAlreadyCurrent) {
          const priorRebindings = Array.isArray(currentFeedback.provider_policy_rebindings)
            ? currentFeedback.provider_policy_rebindings
            : [];
          const reboundFeedback = {
            ...currentFeedback,
            provider_policy: {
              path: loadedPolicy.path,
              sha256: loadedPolicy.sha256,
              schema_version: "provider-policy.v2",
              schema_path: loadedPolicy.schemaPath,
              schema_sha256: loadedPolicy.schemaSha256,
            },
            provider_policy_rebindings: [...priorRebindings, {
              prior_sha256: workflowPolicy.sha256,
              current_sha256: loadedPolicy.sha256,
              schema_sha256: loadedPolicy.schemaSha256,
              rebound_at: now.toISOString(),
              reason: "unclaimed_stage_canonical_policy_advance",
              stage_run_id: current.id,
            }],
          };
          const rebound = await tx.update(profitFlywheelWorkflows).set({
            feedback: reboundFeedback,
            updatedAt: now,
          }).where(eq(profitFlywheelWorkflows.id, currentWorkflow.id)).returning({ id: profitFlywheelWorkflows.id });
          if (rebound.length !== 1) {
            throw new ProfitFlywheelError("profit_flywheel_provider_policy_binding_race", "Workflow provider policy rebind compare-and-set failed");
          }
          await appendEvent(tx, {
            workflow: currentWorkflow,
            stageRunId: current.id,
            eventType: "provider_policy_rebound",
            dedupeKey: `provider-policy-rebound:${current.id}:${loadedPolicy.sha256}`,
            fromState: current.state,
            toState: current.state,
            spanId: current.spanId,
            payload: {
              stage,
              prior_provider_policy_sha256: workflowPolicy.sha256,
              provider_policy_sha256: loadedPolicy.sha256,
              provider_policy_schema_sha256: loadedPolicy.schemaSha256,
              reason: "unclaimed_stage_canonical_policy_advance",
            },
            processedAt: now,
          });
        }
      }
      const scopes = [
        { type: "stage", key: `stage:${workflow.companyId}:${stage}`, limit: contract.concurrency.default_limits.stage },
        ...(workflow.targetRepo ? [{ type: "repo", key: `repo:${workflow.targetRepo}`, limit: contract.concurrency.default_limits.repo }] : []),
        ...(resolved ? [{ type: "provider", key: `provider:${resolved.route.provider}`, limit: contract.concurrency.default_limits.provider }] : []),
        ...(input.agentId ? [{ type: "agent", key: `agent:${input.agentId}`, limit: 1 }] : []),
      ];
      for (const scope of scopes) {
        await acquireLease(tx, {
          companyId: workflow.companyId,
          stageRunId: current.id,
          scopeType: scope.type,
          scopeKey: scope.key,
          limit: scope.limit,
          leaseOwner,
          expiresAt,
        });
      }
      assertTransition(contract, stage, current.state as CanonicalRunState, "running");
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: "running",
        attemptCount: input.portfolioOsClaim ? current.attemptCount : current.attemptCount + 1,
        retryAt: null,
        providerRouteId: resolved?.route.id ?? null,
        providerFamily: resolved?.route.providerFamily ?? null,
        providerModel: resolved?.route.model.kind === "exact" ? resolved.route.model.value : null,
        providerModelVersion: resolved?.route.model.version ?? null,
        providerPolicySha256: loadedPolicy.sha256,
        providerRouteCoreSha256: resolvedRoute?.policyRouteCoreSha256 ?? null,
        providerRouteSha256: resolvedRoute?.resolvedRouteSha256 ?? null,
        providerRouteSnapshot: resolvedRoute ?? null,
        leaseOwner,
        leaseActorType: input.actorType,
        leaseActorId: input.actorId,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        startedAt: current.startedAt ?? now,
        dispatchClaimId: null,
        dispatchClaimedAt: null,
        updatedAt: now,
      }).where(and(eq(profitFlywheelStageRuns.id, current.id), inArray(profitFlywheelStageRuns.state, ["pending", "retry"])))
        .returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_stage_claim_race", "Stage claim compare-and-set failed");
      await appendEvent(tx, {
        workflow,
        stageRunId: updated.id,
        eventType: "stage_started",
        dedupeKey: `stage-started:${updated.id}:${updated.attemptCount}`,
        fromState: current.state,
        toState: "running",
        spanId: updated.spanId,
        payload: {
          stage,
          input_hash: updated.inputHash,
          attempt: updated.attemptCount,
          provider_route_id: updated.providerRouteId,
          provider_family: updated.providerFamily,
          provider_model: updated.providerModel,
          provider_route_core_sha256: updated.providerRouteCoreSha256,
          provider_route_sha256: updated.providerRouteSha256,
          provider_policy_sha256: loadedPolicy.sha256,
          provider_policy_schema_sha256: loadedPolicy.schemaSha256,
        },
        processedAt: now,
      });
      return updated;
    });
  }

  async function heartbeatStage(input: { stageRunId: string; leaseOwner: string; now?: Date }) {
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const stageRun = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!stageRun || stageRun.state !== "running" || stageRun.leaseOwner !== input.leaseOwner ||
          !stageRun.leaseExpiresAt || stageRun.leaseExpiresAt <= now) {
        throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage lease is missing, expired, or owned by another worker");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      const expiresAt = new Date(now.getTime() + contract.recovery.orphan_timeout_seconds * 1000);
      const scopeLeases = await tx.select({ id: profitFlywheelLeases.id, expiresAt: profitFlywheelLeases.expiresAt }).from(profitFlywheelLeases).where(and(
        eq(profitFlywheelLeases.stageRunId, stageRun.id),
        eq(profitFlywheelLeases.leaseOwner, input.leaseOwner),
      )).for("update");
      if (scopeLeases.length === 0 || scopeLeases.some((lease) => lease.expiresAt <= now)) {
        throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage has no complete set of unexpired authoritative scope leases to refresh");
      }
      const updatedStage = await tx.update(profitFlywheelStageRuns).set({ heartbeatAt: now, leaseExpiresAt: expiresAt, updatedAt: now })
        .where(and(eq(profitFlywheelStageRuns.id, stageRun.id), eq(profitFlywheelStageRuns.leaseOwner, input.leaseOwner), eq(profitFlywheelStageRuns.state, "running"), gt(profitFlywheelStageRuns.leaseExpiresAt, now)))
        .returning({ id: profitFlywheelStageRuns.id });
      const updatedLeases = await tx.update(profitFlywheelLeases).set({ expiresAt, updatedAt: now })
        .where(and(eq(profitFlywheelLeases.stageRunId, stageRun.id), eq(profitFlywheelLeases.leaseOwner, input.leaseOwner), gt(profitFlywheelLeases.expiresAt, now)))
        .returning({ id: profitFlywheelLeases.id });
      if (updatedStage.length !== 1 || updatedLeases.length !== scopeLeases.length) {
        throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage or scope-lease heartbeat compare-and-set lost a race");
      }
      return { stageRunId: stageRun.id, expiresAt };
    });
  }

  async function completeStage(input: { stageRunId: string; expectedLease: ExpectedLease; outputHash?: string; feedback?: Record<string, unknown>; now?: Date }) {
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, input.stageRunId)).then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Stage run not found");
      assertExpectedLease(stageRun, input.expectedLease);
      if (!stageRun.leaseExpiresAt || stageRun.leaseExpiresAt <= now) throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage completion requires an unexpired lease");
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      const stage = stageRun.stage as ProfitFlywheelStage;
      assertTransition(contract, stage, stageRun.state as CanonicalRunState, "succeeded");
      const receipts = await tx.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, stageRun.id));
      const builderProviderFamily = stage === "qa"
        ? (await exactQaBuilderStage(tx, stageRun))?.providerFamily ?? null
        : null;
      const validReceipts = await assertCompletionEvidence({
        executor: tx,
        workflow,
        contract,
        stage,
        stageRun,
        receipts,
        now,
        builderProviderFamily,
        ...workflowArtifactRoots(workflow),
      });
      const receiptBindings = validReceipts.map((receipt) => ({
        type: receipt.receiptType,
        schemaVersion: receipt.schemaVersion,
        contentHash: receipt.contentHash,
        artifactRef: receipt.artifactRef,
      })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      const outputHash = hashProfitFlywheelValue({ stage, input_hash: stageRun.inputHash, receipts: receiptBindings });
      if (input.outputHash && input.outputHash.toLowerCase() !== outputHash) {
        throw new ProfitFlywheelError("profit_flywheel_output_hash_mismatch", "Caller outputHash differs from the server-derived canonical receipt output hash", {
          expected: outputHash,
        });
      }
      assertSha256(outputHash, "outputHash");
      let completionTrigger = stage === "dispatch" ? "issue_created" : "validated_artifact_completion";
      let learningObservationChanged: boolean | null = null;
      let learningObservationHash: string | null = null;
      if (stage === "learning") {
        learningObservationHash = typeof asRecord(stageRun.feedback).transition_source_output_hash === "string"
          ? String(asRecord(stageRun.feedback).transition_source_output_hash)
          : null;
        assertSha256(learningObservationHash ?? "", "learning.transition_source_output_hash");
        const priorLearning = await tx.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.workflowId, workflow.id),
          eq(profitFlywheelStageRuns.stage, "learning"),
          eq(profitFlywheelStageRuns.state, "succeeded"),
        )).orderBy(asc(profitFlywheelStageRuns.createdAt)).then((rows) => rows.at(-1) ?? null);
        const priorObservationHash = priorLearning && priorLearning.id !== stageRun.id
          ? asRecord(priorLearning.feedback).observation_hash
          : null;
        learningObservationChanged = priorObservationHash !== learningObservationHash;
        completionTrigger = learningObservationChanged
          ? "new_observation_changes_hash"
          : "observation_hash_unchanged";
      }
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: "succeeded",
        feedback: {
          ...(input.feedback ?? asRecord(stageRun.feedback)),
          ...(stage === "learning" ? {
            observation_hash: learningObservationHash,
            observation_hash_changed: learningObservationChanged,
          } : {}),
        },
        completedAt: now,
        leaseOwner: null,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        blockerCode: null,
        blockerDetail: null,
        nextOwner: null,
        resumeCondition: null,
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        inArray(profitFlywheelStageRuns.state, ["running", "degraded"]),
        ...expectedLeaseConditions(input.expectedLease),
      ))
        .returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_stage_complete_race", "Stage completion compare-and-set failed");
      if (stageRun.linkedIssueId) {
        await tx.update(issues).set({ status: stage === "learning" ? "done" : "todo", updatedAt: now }).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, stageRun.companyId),
        ));
      }
      await tx.update(profitFlywheelStageRuns).set({
        feedback: {
          ...(input.feedback ?? asRecord(stageRun.feedback)),
          output_hash: outputHash,
          ...(stage === "learning" ? {
            observation_hash: learningObservationHash,
            observation_hash_changed: learningObservationChanged,
          } : {}),
        },
      }).where(eq(profitFlywheelStageRuns.id, stageRun.id));
      await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, stageRun.id));
      await appendEvent(tx, {
        workflow,
        stageRunId: stageRun.id,
        eventType: "stage_succeeded",
        dedupeKey: `stage-succeeded:${stageRun.id}:${outputHash}`,
        fromState: stageRun.state,
        toState: "succeeded",
        spanId: stageRun.spanId,
        payload: {
          stage,
          input_hash: stageRun.inputHash,
          output_hash: outputHash,
          trigger: completionTrigger,
          receipt_refs: validReceipts.map((receipt) => ({ type: receipt.receiptType, hash: receipt.contentHash })),
          linked_issue_id: stageRun.linkedIssueId,
        },
      });
      if (stage === "learning") {
        await tx.update(profitFlywheelWorkflows).set({
          state: learningObservationChanged ? "running" : "succeeded",
          completedAt: learningObservationChanged ? null : now,
          feedback: {
            ...asRecord(workflow.feedback),
            last_learning_stage_feedback: input.feedback ?? asRecord(stageRun.feedback),
            last_learning_observation_hash: learningObservationHash,
            last_learning_observation_changed: learningObservationChanged,
          },
          updatedAt: now,
        })
          .where(eq(profitFlywheelWorkflows.id, workflow.id));
      }
      return updated;
    }).then(async (result) => {
      await processPendingEvents({ workflowId: result.workflowId, limit: 20 });
      return result;
    });
  }

  async function blockStage(input: { stageRunId: string; blocker: Partial<Blocker>; expectedLease: ExpectedLease; requireExpiredAt?: Date; now?: Date }) {
    const blocker = requireBlocker(input.blocker);
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, input.stageRunId)).then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Stage run not found");
      assertExpectedLease(stageRun, input.expectedLease);
      if (input.requireExpiredAt) {
        const orphaned = stageRun.leaseExpiresAt
          ? stageRun.leaseExpiresAt <= input.requireExpiredAt
          : stageRun.updatedAt <= new Date(input.requireExpiredAt.getTime() - 15 * 60 * 1000);
        if (!orphaned) {
          throw new ProfitFlywheelError("profit_flywheel_orphan_recovered", "Stage lease was refreshed before orphan blocking acquired its row lock");
        }
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      assertTransition(contract, stageRun.stage as ProfitFlywheelStage, stageRun.state as CanonicalRunState, "blocked");
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: "blocked",
        blockerCode: blocker.blockerCode,
        blockerDetail: blocker.blockerDetail,
        nextOwner: blocker.nextOwner,
        resumeCondition: blocker.resumeCondition,
        leaseOwner: null,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, stageRun.state),
        ...expectedLeaseConditions(input.expectedLease),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage lease changed during block mutation");
      if (stageRun.linkedIssueId) {
        await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, stageRun.companyId),
        ));
      }
      await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, stageRun.id));
      await tx.update(profitFlywheelWorkflows).set({ state: "blocked", ...blocker, updatedAt: now }).where(eq(profitFlywheelWorkflows.id, workflow.id));
      await appendEvent(tx, {
        workflow,
        stageRunId: stageRun.id,
        eventType: "stage_blocked",
        dedupeKey: `stage-blocked:${stageRun.id}:${hashProfitFlywheelValue(blocker)}`,
        fromState: stageRun.state,
        toState: "blocked",
        spanId: stageRun.spanId,
        payload: { stage: stageRun.stage, input_hash: stageRun.inputHash, ...blocker },
        processedAt: now,
      });
      return updated;
    });
  }

  async function recoverOrphanExecutionEvidence(
    tx: Db,
    stageRun: typeof profitFlywheelStageRuns.$inferSelect,
    workflow: typeof profitFlywheelWorkflows.$inferSelect,
    now: Date,
  ) {
    if (stageRun.ownerPlane !== "paperclip" || !["implementation", "qa", "release"].includes(stageRun.stage)) {
      return { artifactCheckpoint: stageRun.artifactCheckpoint ?? null };
    }
    if (stageRun.leaseActorType !== "system" || !stageRun.leaseActorId || !stageRun.linkedIssueId ||
        !stageRun.providerRouteId || !stageRun.providerFamily || !stageRun.providerModel || !stageRun.providerModelVersion ||
        !stageRun.providerPolicySha256 || !stageRun.providerRouteCoreSha256 || !stageRun.providerRouteSha256) {
      throw new ProfitFlywheelError("profit_flywheel_orphan_lineage_invalid", "Orphaned actionable stage lacks exact heartbeat, issue, or provider lineage");
    }
    const heartbeatRun = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stageRun.leaseActorId)).for("update")
      .then((rows) => rows[0] ?? null);
    const linkedIssue = await tx.select().from(issues).where(and(
      eq(issues.id, stageRun.linkedIssueId),
      eq(issues.companyId, stageRun.companyId),
    )).then((rows) => rows[0] ?? null);
    const heartbeatContext = asRecord(heartbeatRun?.contextSnapshot);
    if (!heartbeatRun || !heartbeatRun.startedAt || !heartbeatRun.executionEvidenceNonce ||
        !/^[a-f0-9]{64}$/.test(heartbeatRun.executionEvidenceNonce) || !["running", "failed"].includes(heartbeatRun.status) ||
        heartbeatRun.companyId !== stageRun.companyId || heartbeatContext.profitFlywheelStageRunId !== stageRun.id ||
        heartbeatContext.issueId !== stageRun.linkedIssueId || !linkedIssue || linkedIssue.assigneeAgentId !== heartbeatRun.agentId) {
      throw new ProfitFlywheelError("profit_flywheel_orphan_heartbeat_invalid", "Orphan recovery requires the exact claimed heartbeat, issue, assignee, and stage binding");
    }

    const adjudicationDirectory = profitFlywheelAttemptArtifactDirectory(workflow, stageRun, "adjudications");
    const heartbeatRunId = safeProfitFlywheelArtifactSegment(heartbeatRun.id, "heartbeat run id");
    const adjudicationPath = path.join(adjudicationDirectory, `${heartbeatRunId}.json`);
    const priorAdjudications = await tx.select().from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.stageRunId, stageRun.id),
      eq(profitFlywheelReceipts.receiptType, "execution_adjudication_receipt"),
    ));
    const priorAdjudication = priorAdjudications.find((receipt) => asRecord(receipt.attributes).attempt === stageRun.attemptCount) ?? null;
    if (priorAdjudication) {
      const attributes = asRecord(priorAdjudication.attributes);
      if (priorAdjudication.status !== "valid" || priorAdjudication.artifactRef !== adjudicationPath ||
          attributes.heartbeat_run_id !== heartbeatRun.id || attributes.stage_run_id !== stageRun.id ||
          attributes.input_hash !== stageRun.inputHash || attributes.provider_route_id !== stageRun.providerRouteId) {
        throw new ProfitFlywheelError("profit_flywheel_adjudication_replay_conflict", "Orphaned attempt already has a conflicting adjudication receipt");
      }
      canonicalDbReceiptProof(priorAdjudication, now);
      await verifyArtifactReference(
        adjudicationPath,
        requireShaField(attributes, "artifact_hash", "execution_adjudication_receipt"),
        workflowArtifactRoots(workflow).allowedArtifactRoots,
        workflowArtifactRoots(workflow).targetRepoRoot,
      );
    } else {
      const existingAdjudication = await stat(adjudicationPath).then(() => true).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      let evidenceValue: Record<string, unknown>;
      let adjudicationEvidence: { path: string; sha256: string };
      if (existingAdjudication) {
        const artifact = await readImmutableFileStrict(adjudicationPath, "orphan execution adjudication", 2 * 1024 * 1024);
        try { evidenceValue = asRecord(JSON.parse(artifact.bytes.toString("utf8"))); } catch { evidenceValue = {}; }
        adjudicationEvidence = { path: adjudicationPath, sha256: artifact.sha256 };
      } else {
        const routeSnapshot = asRecord(stageRun.providerRouteSnapshot);
        const observedAt = new Date(Math.max(
          heartbeatRun.startedAt.getTime(),
          stageRun.leaseExpiresAt?.getTime() ?? stageRun.updatedAt.getTime() + 15 * 60 * 1000,
        )).toISOString();
        evidenceValue = {
          schema_version: "paperclip.execution_adjudication.v1",
          company_id: stageRun.companyId,
          workflow_id: stageRun.workflowId,
          stage_run_id: stageRun.id,
          attempt: stageRun.attemptCount,
          input_hash: stageRun.inputHash,
          heartbeat_run_id: heartbeatRun.id,
          provider_route_id: stageRun.providerRouteId,
          provider_family: stageRun.providerFamily,
          model: stageRun.providerModel,
          version: stageRun.providerModelVersion,
          provider_policy_sha256: stageRun.providerPolicySha256,
          provider_policy_schema_sha256: routeSnapshot.providerPolicySchemaSha256,
          provider_route_core_sha256: stageRun.providerRouteCoreSha256,
          provider_route_sha256: stageRun.providerRouteSha256,
          exit_code: heartbeatRun.exitCode,
          signal: null,
          timed_out: false,
          observed_outcome: "process_lost",
          inferred_failure_code: "process_lost",
          log_sha256: typeof heartbeatRun.logSha256 === "string" && /^[a-f0-9]{64}$/i.test(heartbeatRun.logSha256)
            ? heartbeatRun.logSha256.toLowerCase()
            : createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          final_response_complete: false,
          false_success: heartbeatRun.exitCode === 0,
          observed_at: observedAt,
        };
        evidenceValue.server_observation_proof = buildProfitFlywheelServerObservationProof(
          heartbeatRun.executionEvidenceNonce,
          "adjudication",
          evidenceValue,
        );
        adjudicationEvidence = await writeImmutableJsonArtifactAt({
          artifactPath: adjudicationPath,
          value: evidenceValue,
          label: "orphan execution adjudication",
        });
      }
      sanitizeReceiptValue(evidenceValue);
      assertExactObjectKeys(evidenceValue, [
        "schema_version", "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "heartbeat_run_id",
        "provider_route_id", "provider_family", "model", "version", "provider_policy_sha256", "provider_policy_schema_sha256",
        "provider_route_core_sha256", "provider_route_sha256", "exit_code", "signal", "timed_out", "observed_outcome",
        "inferred_failure_code", "log_sha256", "final_response_complete", "false_success", "server_observation_proof", "observed_at",
      ], "orphan execution adjudication");
      for (const field of ["provider_policy_sha256", "provider_policy_schema_sha256", "provider_route_core_sha256", "provider_route_sha256", "log_sha256"]) {
        assertSha256(String(evidenceValue[field] ?? ""), `orphan adjudication.${field}`);
      }
      const observedAt = new Date(String(evidenceValue.observed_at ?? ""));
      const routeSnapshot = asRecord(stageRun.providerRouteSnapshot);
      if (evidenceValue.schema_version !== "paperclip.execution_adjudication.v1" ||
          evidenceValue.company_id !== stageRun.companyId || evidenceValue.workflow_id !== stageRun.workflowId ||
          evidenceValue.stage_run_id !== stageRun.id || evidenceValue.attempt !== stageRun.attemptCount ||
          evidenceValue.input_hash !== stageRun.inputHash || evidenceValue.heartbeat_run_id !== heartbeatRun.id ||
          evidenceValue.provider_route_id !== stageRun.providerRouteId || evidenceValue.provider_family !== stageRun.providerFamily ||
          evidenceValue.model !== stageRun.providerModel || evidenceValue.version !== stageRun.providerModelVersion ||
          evidenceValue.provider_policy_sha256 !== stageRun.providerPolicySha256 ||
          evidenceValue.provider_policy_schema_sha256 !== routeSnapshot.providerPolicySchemaSha256 ||
          evidenceValue.provider_route_core_sha256 !== stageRun.providerRouteCoreSha256 ||
          evidenceValue.provider_route_sha256 !== stageRun.providerRouteSha256 ||
          evidenceValue.server_observation_proof !== buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "adjudication", evidenceValue) ||
          !(evidenceValue.exit_code === null || Number.isInteger(evidenceValue.exit_code)) ||
          typeof evidenceValue.final_response_complete !== "boolean" || typeof evidenceValue.false_success !== "boolean" ||
          evidenceValue.false_success !== (evidenceValue.exit_code === 0 && evidenceValue.final_response_complete === false) ||
          typeof evidenceValue.observed_outcome !== "string" || !evidenceValue.observed_outcome ||
          typeof evidenceValue.timed_out !== "boolean" || !(evidenceValue.signal === null || typeof evidenceValue.signal === "string") ||
          !(evidenceValue.inferred_failure_code === null || typeof evidenceValue.inferred_failure_code === "string") ||
          !Number.isFinite(observedAt.getTime()) || observedAt < new Date(heartbeatRun.startedAt.getTime() - 60_000) ||
          observedAt > new Date(now.getTime() + 60_000)) {
        throw new ProfitFlywheelError("profit_flywheel_orphan_adjudication_invalid", "Orphan adjudication bytes do not bind the exact heartbeat attempt, provider route, and observed process outcome");
      }
      const attributes = {
        stage_run_id: stageRun.id,
        attempt: stageRun.attemptCount,
        input_hash: stageRun.inputHash,
        heartbeat_run_id: heartbeatRun.id,
        provider_route_id: stageRun.providerRouteId,
        observed_outcome: String(evidenceValue.observed_outcome),
        process_exit_code: evidenceValue.exit_code as number | null,
        final_response_complete: evidenceValue.final_response_complete as boolean,
        false_success: evidenceValue.false_success as boolean,
        adjudication_source: "paperclip_server_observed_heartbeat",
        artifact_hash: adjudicationEvidence.sha256,
      };
      validateReceiptTypeAttributes("execution_adjudication_receipt", attributes, adjudicationEvidence.path);
      const base = {
        type: "execution_adjudication_receipt",
        schemaVersion: "paperclip.execution_adjudication_receipt.v1",
        artifactRef: adjudicationEvidence.path,
        observedAt: observedAt.toISOString(),
        expiresAt: null,
        attributes,
      };
      await tx.insert(profitFlywheelReceipts).values({
        companyId: stageRun.companyId,
        workflowId: stageRun.workflowId,
        stageRunId: stageRun.id,
        receiptType: base.type,
        schemaVersion: base.schemaVersion,
        contentHash: canonicalProfitFlywheelReceiptHash(base),
        artifactRef: base.artifactRef,
        status: "valid",
        observedAt,
        expiresAt: null,
        attributes,
        correlationId: stageRun.correlationId,
        traceId: stageRun.traceId,
        spanId: stageRun.spanId,
      });
    }

    if (stageRun.artifactCheckpoint) return { artifactCheckpoint: stageRun.artifactCheckpoint };
    const checkpointDirectory = profitFlywheelAttemptArtifactDirectory(workflow, stageRun, "checkpoints");
    const checkpointPath = path.join(checkpointDirectory, `${heartbeatRunId}-checkpoint.json`);
    const checkpointExists = await stat(checkpointPath).then(() => true).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (!checkpointExists) return { artifactCheckpoint: null };
    const checkpointFile = await readImmutableFileStrict(checkpointPath, "orphan artifact checkpoint", 2 * 1024 * 1024);
    let checkpointValue: Record<string, unknown>;
    try { checkpointValue = asRecord(JSON.parse(checkpointFile.bytes.toString("utf8"))); } catch { checkpointValue = {}; }
    sanitizeReceiptValue(checkpointValue);
    assertExactObjectKeys(checkpointValue, [
      "schema_version", "company_id", "workflow_id", "stage_run_id", "issue_id", "attempt", "input_hash",
      "provider_route_id", "workspace_root", "head_git_object", "branch", "tracked_diff_sha256", "index_diff_sha256",
      "status_sha256", "untracked", "workspace_evidence", "server_observation_proof", "observed_at",
    ], "orphan artifact checkpoint");
    const workspaceEvidence = asRecord(checkpointValue.workspace_evidence);
    const workspacePath = path.join(checkpointDirectory, `${heartbeatRunId}-workspace.json`);
    if (workspaceEvidence.path !== workspacePath || typeof workspaceEvidence.sha256 !== "string") {
      throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Orphan checkpoint must bind its deterministic workspace evidence path and hash");
    }
    const workspaceFile = await readImmutableFileStrict(workspacePath, "orphan workspace evidence", 2 * 1024 * 1024);
    let workspaceValue: Record<string, unknown>;
    try { workspaceValue = asRecord(JSON.parse(workspaceFile.bytes.toString("utf8"))); } catch { workspaceValue = {}; }
    sanitizeReceiptValue(workspaceValue);
    assertExactObjectKeys(workspaceValue, [
      "schema_version", "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "workspace_root",
      "head_git_object", "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256", "untracked", "server_observation_proof", "observed_at",
    ], "orphan workspace evidence");
    const sharedFields = [
      "company_id", "workflow_id", "stage_run_id", "attempt", "input_hash", "workspace_root", "head_git_object",
      "branch", "tracked_diff_sha256", "index_diff_sha256", "status_sha256", "untracked", "observed_at",
    ];
    const workspaceMatchesCheckpoint = sharedFields.every((field) => stableJson(workspaceValue[field]) === stableJson(checkpointValue[field]));
    const [checkpointWorkspaceRoot, workflowWorkspaceRoot] = await Promise.all([
      realpath(String(checkpointValue.workspace_root ?? "")).catch(() => ""),
      realpath(workflow.targetWorkspaceRoot).catch(() => ""),
    ]);
    if ((checkpointFile.stat.mode & 0o777) !== 0o444 || (workspaceFile.stat.mode & 0o777) !== 0o444 ||
        workspaceEvidence.sha256.toLowerCase() !== workspaceFile.sha256 ||
        checkpointValue.schema_version !== "paperclip.profit_flywheel_artifact_checkpoint.v1" ||
        workspaceValue.schema_version !== "paperclip.profit_flywheel_workspace_evidence.v1" || !workspaceMatchesCheckpoint ||
        checkpointValue.company_id !== stageRun.companyId || checkpointValue.workflow_id !== stageRun.workflowId ||
        checkpointValue.stage_run_id !== stageRun.id || checkpointValue.issue_id !== stageRun.linkedIssueId ||
        checkpointValue.attempt !== stageRun.attemptCount || checkpointValue.input_hash !== stageRun.inputHash ||
        checkpointValue.provider_route_id !== stageRun.providerRouteId ||
        checkpointValue.server_observation_proof !== buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "checkpoint", checkpointValue) ||
        workspaceValue.server_observation_proof !== buildProfitFlywheelServerObservationProof(heartbeatRun.executionEvidenceNonce, "workspace", workspaceValue) ||
        !checkpointWorkspaceRoot || checkpointWorkspaceRoot !== workflowWorkspaceRoot) {
      throw new ProfitFlywheelError("profit_flywheel_checkpoint_lineage_invalid", "Orphan checkpoint bytes differ from the exact immutable workspace, attempt, issue, or provider lineage");
    }
    for (const field of ["input_hash", "tracked_diff_sha256", "index_diff_sha256", "status_sha256"]) {
      assertSha256(String(checkpointValue[field] ?? ""), `orphan checkpoint.${field}`);
    }
    assertSha256(String(checkpointValue.server_observation_proof ?? ""), "orphan checkpoint.server_observation_proof");
    await Promise.all([
      verifyArtifactReference(checkpointPath, checkpointFile.sha256, workflowArtifactRoots(workflow).allowedArtifactRoots, workflow.targetWorkspaceRoot),
      verifyArtifactReference(workspacePath, workspaceFile.sha256, workflowArtifactRoots(workflow).allowedArtifactRoots, workflow.targetWorkspaceRoot),
    ]);
    return {
      artifactCheckpoint: {
        ...checkpointValue,
        checkpoint_receipt: { path: checkpointPath, sha256: checkpointFile.sha256 },
      },
    };
  }

  async function failStage(input: {
    stageRunId: string;
    failureClass: string;
    detail: string;
    nextOwner?: string;
    resumeCondition?: string;
    expectedLease: ExpectedLease;
    requireExpiredAt?: Date;
    recoverOrphanEvidence?: boolean;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, input.stageRunId)).then((rows) => rows[0] ?? null);
      if (!stageRun) throw new ProfitFlywheelError("profit_flywheel_stage_missing", "Stage run not found");
      assertExpectedLease(stageRun, input.expectedLease);
      if (input.requireExpiredAt) {
        const orphaned = stageRun.leaseExpiresAt
          ? stageRun.leaseExpiresAt <= input.requireExpiredAt
          : stageRun.updatedAt <= new Date(input.requireExpiredAt.getTime() - 15 * 60 * 1000);
        if (!orphaned) {
          throw new ProfitFlywheelError("profit_flywheel_orphan_recovered", "Stage lease was refreshed before orphan recovery acquired its row lock");
        }
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0]);
      const recoveredEvidence = input.recoverOrphanEvidence
        ? await recoverOrphanExecutionEvidence(tx, stageRun, workflow, now)
        : { artifactCheckpoint: stageRun.artifactCheckpoint ?? null };
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      const definition = stageDefinition(contract, stageRun.stage as ProfitFlywheelStage);
      const retryable = definition.retry.retryable.includes(input.failureClass) && stageRun.attemptCount < stageRun.maxAttempts;
      const nextState: CanonicalRunState = retryable ? "retry" : "failed";
      assertTransition(contract, stageRun.stage as ProfitFlywheelStage, stageRun.state as CanonicalRunState, nextState);
      const retryIndex = Math.max(0, stageRun.attemptCount - 1);
      const backoffSeconds = definition.retry.backoff_seconds[Math.min(retryIndex, definition.retry.backoff_seconds.length - 1)] ?? 60;
      const blocker = requireBlocker({
        blockerCode: input.failureClass,
        blockerDetail: input.detail,
        nextOwner: input.nextOwner ?? (retryable ? "paperclip_orchestrator" : definition.owner_plane),
        resumeCondition: input.resumeCondition ?? (retryable ? `Retry after ${backoffSeconds}s from immutable artifact checkpoint` : "Owner must repair the non-retryable failure and explicitly resume"),
      });
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: nextState,
        retryAt: retryable ? new Date(now.getTime() + backoffSeconds * 1000) : null,
        blockerCode: blocker.blockerCode,
        blockerDetail: blocker.blockerDetail,
        nextOwner: blocker.nextOwner,
        resumeCondition: blocker.resumeCondition,
        leaseOwner: null,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        artifactCheckpoint: recoveredEvidence.artifactCheckpoint,
        updatedAt: now,
        ...(retryable ? {} : { completedAt: now }),
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, stageRun.state),
        ...expectedLeaseConditions(input.expectedLease),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_lease_lost", "Stage lease changed during failure mutation");
      if (stageRun.linkedIssueId) {
        await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, stageRun.companyId),
        ));
      }
      await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, stageRun.id));
      await tx.update(profitFlywheelWorkflows).set({
        state: retryable ? "degraded" : "failed",
        ...blocker,
        updatedAt: now,
        ...(retryable ? {} : { completedAt: now }),
      }).where(eq(profitFlywheelWorkflows.id, workflow.id));
      await appendEvent(tx, {
        workflow,
        stageRunId: stageRun.id,
        eventType: retryable ? "stage_retry_scheduled" : "stage_failed",
        dedupeKey: `${retryable ? "retry" : "failed"}:${stageRun.id}:${stageRun.attemptCount}:${input.failureClass}`,
        fromState: stageRun.state,
        toState: nextState,
        spanId: stageRun.spanId,
        payload: { stage: stageRun.stage, input_hash: stageRun.inputHash, retry_at: updated.retryAt?.toISOString() ?? null, ...blocker },
        processedAt: now,
      });
      return updated;
    });
  }

  /**
   * Product test failures are a receipt-backed graph transition, not a
   * successful QA completion and not an infrastructure retry of the QA run.
   */
  async function reworkQaFailure(input: {
    stageRunId: string;
    qaFailureReceiptHash: string;
    expectedLease: ExpectedLease;
    now?: Date;
  }) {
    assertSha256(input.qaFailureReceiptHash, "qaFailureReceiptHash");
    const now = input.now ?? new Date();
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const qaStage = await tx.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, input.stageRunId))
        .then((rows) => rows[0] ?? null);
      if (!qaStage || qaStage.stage !== "qa") {
        throw new ProfitFlywheelError("profit_flywheel_qa_stage_required", "Product-test rework requires the exact QA stage run");
      }
      assertExpectedLease(qaStage, input.expectedLease);
      if (!qaStage.leaseExpiresAt || qaStage.leaseExpiresAt <= now || !["running", "degraded"].includes(qaStage.state)) {
        throw new ProfitFlywheelError("profit_flywheel_lease_lost", "QA rework requires an active unexpired QA lease");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows)
        .where(eq(profitFlywheelWorkflows.id, qaStage.workflowId))
        .then((rows) => rows[0] ?? null);
      if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "QA workflow is missing");
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      const transition = contract.transitions.find((candidate) =>
        candidate.from === "qa" && candidate.to === "implementation" && candidate.trigger === "product_test_failure");
      if (!transition) throw new ProfitFlywheelError("profit_flywheel_transition_missing", "Contract lacks QA product-test rework transition");
      const receipt = await tx.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.stageRunId, qaStage.id),
        eq(profitFlywheelReceipts.receiptType, "qa_failure_receipt"),
        eq(profitFlywheelReceipts.contentHash, input.qaFailureReceiptHash),
        eq(profitFlywheelReceipts.status, "valid"),
      )).then((rows) => rows[0] ?? null);
      if (!receipt || receipt.observedAt > new Date(now.getTime() + contract.commercial_policy.future_evidence_tolerance_seconds * 1000) ||
          receipt.observedAt < new Date(now.getTime() - stageDefinition(contract, "qa").freshness_limit_seconds * 1000) ||
          (receipt.expiresAt && receipt.expiresAt <= now)) {
        throw new ProfitFlywheelError("profit_flywheel_qa_failure_receipt_missing", "QA rework requires the exact fresh valid failed-test receipt");
      }
      const attributes = asRecord(receipt.attributes);
      validateReceiptTypeAttributes("qa_failure_receipt", attributes, receipt.artifactRef);
      if (!receipt.artifactRef) throw new ProfitFlywheelError("profit_flywheel_qa_failure_artifact_missing", "QA failure receipt lacks artifact reference");
      await verifyArtifactReference(
        receipt.artifactRef,
        attributes.artifact_hash,
        workflowArtifactRoots(workflow).allowedArtifactRoots,
        workflowArtifactRoots(workflow).targetRepoRoot,
      );
      const priorReworks = await tx.select({ id: profitFlywheelEvents.id }).from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.workflowId, workflow.id),
        eq(profitFlywheelEvents.eventType, "qa_rework_requested"),
      ));
      const maxEscalations = stageDefinition(contract, "qa").budgets.max_escalations;
      if (priorReworks.length >= maxEscalations) {
        const blocker = requireBlocker({
          blockerCode: "profit_flywheel_qa_rework_budget_exhausted",
          blockerDetail: `QA product-test rework budget ${maxEscalations} is exhausted`,
          nextOwner: "paperclip_board_operator",
          resumeCondition: "Review the immutable QA failure chain and authorize a new dispatch/run rather than silently retrying",
        });
        assertTransition(contract, "qa", qaStage.state as CanonicalRunState, "failed");
        await tx.update(profitFlywheelStageRuns).set({
          state: "failed",
          completedAt: now,
          leaseOwner: null,
          leaseActorType: null,
          leaseActorId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          ...blocker,
          feedback: { ...asRecord(qaStage.feedback), qa_failure_receipt_hash: receipt.contentHash, rework_budget_exhausted: true },
          updatedAt: now,
        }).where(and(eq(profitFlywheelStageRuns.id, qaStage.id), ...expectedLeaseConditions(input.expectedLease)));
        await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, qaStage.id));
        if (qaStage.linkedIssueId) {
          await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
            eq(issues.id, qaStage.linkedIssueId),
            eq(issues.companyId, workflow.companyId),
          ));
        }
        await tx.update(profitFlywheelWorkflows).set({ state: "failed", completedAt: now, ...blocker, updatedAt: now })
          .where(eq(profitFlywheelWorkflows.id, workflow.id));
        await appendEvent(tx, {
          workflow,
          stageRunId: qaStage.id,
          eventType: "stage_failed",
          dedupeKey: `qa-rework-exhausted:${qaStage.id}:${receipt.contentHash}`,
          fromState: qaStage.state,
          toState: "failed",
          spanId: qaStage.spanId,
          payload: { stage: "qa", trigger: "product_test_failure", qa_failure_hash: attributes.qa_failure_hash, ...blocker },
          processedAt: now,
        });
        return { status: "exhausted" as const, qaStageRunId: qaStage.id, implementationStageRunId: null };
      }
      const priorImplementation = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.workflowId, workflow.id),
        eq(profitFlywheelStageRuns.stage, "implementation"),
        eq(profitFlywheelStageRuns.state, "succeeded"),
      )).orderBy(asc(profitFlywheelStageRuns.createdAt)).then((rows) => rows.at(-1) ?? null);
      if (!priorImplementation?.linkedIssueId) {
        throw new ProfitFlywheelError("profit_flywheel_rework_issue_missing", "QA rework requires the authoritative prior implementation issue");
      }
      const priorDispatchHash = String(asRecord(priorImplementation.sourceHashes).dispatch_hash ?? "").toLowerCase();
      const priorDispatchBinding = asRecord(asRecord(priorImplementation.feedback).iteration_dispatch_binding);
      if (!/^[a-f0-9]{64}$/.test(priorDispatchHash) || priorDispatchBinding.dispatch_artifact_hash !== priorDispatchHash) {
        throw new ProfitFlywheelError("profit_flywheel_dispatch_iteration_binding_invalid", "QA rework lacks the prior implementation iteration dispatch authority");
      }
      const reworkInput = buildProfitFlywheelStageInput({
        contract,
        stage: "implementation",
        sourceHashes: {
          dispatch_hash: priorDispatchHash,
          issue_id: hashProfitFlywheelValue(priorImplementation.linkedIssueId),
          target_repo: hashProfitFlywheelValue(workflow.targetRepo),
          target_base_sha: hashProfitFlywheelValue(String(asRecord(workflow.feedback).target_base_sha ?? "")),
          workspace_fingerprint: hashProfitFlywheelValue({
            prior: asRecord(workflow.feedback).workspace_fingerprint,
            qa_failure_receipt_hash: receipt.contentHash,
            qa_failure_hash: attributes.qa_failure_hash,
            rework_escalation: priorReworks.length + 1,
          }),
        },
      });
      const nextInputHash = reworkInput.inputHash;
      const implementation = await createStageRun(tx, {
        workflow,
        contract,
        stage: "implementation",
        inputHash: nextInputHash,
        sourceHashes: reworkInput.sourceHashes,
        linkedIssueId: priorImplementation.linkedIssueId,
      });
      if (!implementation) throw new ProfitFlywheelError("profit_flywheel_stage_create_failed", "Unable to create rework implementation stage");
      const qaUpdated = await tx.update(profitFlywheelStageRuns).set({
        state: "failed",
        completedAt: now,
        leaseOwner: null,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        blockerCode: "product_test_failure",
        blockerDetail: "Receipt-backed product test failure routed to a new implementation attempt",
        nextOwner: "implementation_agent",
        resumeCondition: `Complete rework stage ${implementation.id} and rerun QA from a new artifact hash`,
        feedback: {
          ...asRecord(qaStage.feedback),
          qa_failure_receipt_hash: receipt.contentHash,
          qa_failure_hash: attributes.qa_failure_hash,
          rework_implementation_stage_run_id: implementation.id,
        },
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, qaStage.id),
        inArray(profitFlywheelStageRuns.state, ["running", "degraded"]),
        ...expectedLeaseConditions(input.expectedLease),
      )).returning().then((rows) => rows[0] ?? null);
      if (!qaUpdated) throw new ProfitFlywheelError("profit_flywheel_lease_lost", "QA lease changed during product-test rework");
      await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, qaStage.id));
      if (qaStage.linkedIssueId) {
        await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
          eq(issues.id, qaStage.linkedIssueId),
          eq(issues.companyId, workflow.companyId),
        ));
      }
      await tx.update(profitFlywheelStageRuns).set({
        transitionSourceStageRunId: qaStage.id,
        transitionSourceOutputHash: receipt.contentHash,
        feedback: {
          ...asRecord(implementation.feedback),
          transition_source_stage_run_id: qaStage.id,
          transition_source_output_hash: receipt.contentHash,
          iteration_dispatch_binding: priorDispatchBinding,
          qa_failure_hash: attributes.qa_failure_hash,
          rework_escalation: priorReworks.length + 1,
        },
        updatedAt: now,
      }).where(eq(profitFlywheelStageRuns.id, implementation.id));
      await tx.update(issues).set({ status: "todo", updatedAt: now }).where(and(
        eq(issues.id, priorImplementation.linkedIssueId),
        eq(issues.companyId, workflow.companyId),
      ));
      await tx.update(profitFlywheelWorkflows).set({ currentStage: "implementation", state: "running", completedAt: null, updatedAt: now })
        .where(eq(profitFlywheelWorkflows.id, workflow.id));
      await appendEvent(tx, {
        workflow,
        stageRunId: qaStage.id,
        eventType: "qa_rework_requested",
        dedupeKey: `qa-rework:${qaStage.id}:${receipt.contentHash}`,
        fromState: qaStage.state,
        toState: "failed",
        spanId: qaStage.spanId,
        payload: {
          stage: "qa",
          from_stage: "qa",
          to_stage: "implementation",
          trigger: transition.trigger,
          guard: transition.guard,
          qa_failure_hash: attributes.qa_failure_hash,
          qa_failure_receipt_hash: receipt.contentHash,
          implementation_stage_run_id: implementation.id,
          input_hash: nextInputHash,
          linked_issue_id: implementation.linkedIssueId,
        },
        processedAt: now,
      });
      return { status: "rework_requested" as const, qaStageRunId: qaStage.id, implementationStageRunId: implementation.id };
    });
    if (result.implementationStageRunId) {
      await dispatchPendingStages({ workflowId: (await getStageRun(result.implementationStageRunId))?.workflow.id, limit: 20 });
    }
    return result;
  }

  async function recoverOrphans(input: { now?: Date; limit?: number } = {}) {
    const now = input.now ?? new Date();
    const orphans = await db.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.state, "running"),
      or(
        lte(profitFlywheelStageRuns.leaseExpiresAt, now),
        and(isNull(profitFlywheelStageRuns.leaseExpiresAt), lte(profitFlywheelStageRuns.updatedAt, new Date(now.getTime() - 15 * 60 * 1000))),
      ),
    )).orderBy(asc(profitFlywheelStageRuns.updatedAt)).limit(input.limit ?? 100);
    const results = [];
    for (const stageRun of orphans) {
      try {
        results.push(await failStage({
          stageRunId: stageRun.id,
          failureClass: "process_interrupted",
          detail: "Stage lease expired or disappeared before a terminal receipt was persisted",
          nextOwner: "paperclip_orchestrator",
          resumeCondition: "Reconcile artifact checkpoint and mutation receipts, then resume with the same idempotency key and a fresh transcript",
          expectedLease: {
            leaseOwner: stageRun.leaseOwner,
            actorType: stageRun.leaseActorType as ExpectedLease["actorType"],
            actorId: stageRun.leaseActorId,
          },
          requireExpiredAt: now,
          recoverOrphanEvidence: true,
          now,
        }));
      } catch (error) {
        if (error instanceof ProfitFlywheelError && error.code === "profit_flywheel_orphan_recovered") continue;
        const recoveryError = safeOperationalError(error);
        try {
          results.push(await blockStage({
            stageRunId: stageRun.id,
            blocker: {
              blockerCode: "profit_flywheel_orphan_evidence_recovery_failed",
              blockerDetail: `Expired execution could not safely reconcile its exact adjudication/checkpoint evidence: ${recoveryError}`,
              nextOwner: "paperclip_runtime_owner",
              resumeCondition: "Repair or attest the immutable heartbeat evidence lineage, then explicitly resume the same idempotent stage",
            },
            expectedLease: {
              leaseOwner: stageRun.leaseOwner,
              actorType: stageRun.leaseActorType as ExpectedLease["actorType"],
              actorId: stageRun.leaseActorId,
            },
            requireExpiredAt: now,
            now,
          }));
        } catch (blockError) {
          if (blockError instanceof ProfitFlywheelError && blockError.code === "profit_flywheel_orphan_recovered") continue;
          logger.error({
            stageRunId: stageRun.id,
            workflowId: stageRun.workflowId,
            stage: stageRun.stage,
            recoveryError,
            blockError: safeOperationalError(blockError),
          }, "Profit Flywheel orphan could not be durably blocked; later orphans will still reconcile");
        }
      }
    }
    return results;
  }

  async function syncContextLedgerCompletion(input: {
    contextLedgerEntryId: string;
    stageRunId: string;
    leaseOwner?: string;
    recovery?: boolean;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [entry, initialStageRun] = await Promise.all([
      db.select().from(contextLedgerEntries).where(eq(contextLedgerEntries.id, input.contextLedgerEntryId)).then((rows) => rows[0] ?? null),
      db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, input.stageRunId)).then((rows) => rows[0] ?? null),
    ]);
    if (!entry || !initialStageRun) return { status: "ignored", reason: "ledger_or_stage_missing" } as const;
    let stageRun = initialStageRun;
    const workflow = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, stageRun.workflowId)).then((rows) => rows[0] ?? null);
    if (!workflow || !entry.issueId || !entry.runId ||
        entry.companyId !== stageRun.companyId || entry.issueId !== stageRun.linkedIssueId ||
        stageRun.correlationId !== workflow.correlationId ||
        !["implementation", "qa", "release"].includes(stageRun.stage) ||
        !["running", "degraded"].includes(stageRun.state) ||
        stageRun.leaseActorType !== "system" || stageRun.leaseActorId !== entry.runId) {
      return { status: "ignored", reason: "ledger_stage_binding_mismatch" } as const;
    }
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, entry.runId)).then((rows) => rows[0] ?? null);
    const runContext = asRecord(run?.contextSnapshot);
    const recoverableRunStatus = input.recovery === true ? ["running", "failed"].includes(run?.status ?? "") : run?.status === "running";
    if (!run || run.companyId !== stageRun.companyId || run.agentId !== entry.agentId || !recoverableRunStatus ||
        runContext.profitFlywheelStageRunId !== stageRun.id || runContext.issueId !== stageRun.linkedIssueId ||
        asRecord(runContext.paperclipContextLedger).entryId !== entry.id || run.exitCode !== 0) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_run_binding_invalid",
          blocker_detail: "Context ledger, heartbeat run, issue, and exact stage/correlation binding did not match",
          next_owner: "paperclip_runtime_owner",
          resume_condition: "Reconcile the authoritative heartbeat and ledger row; never infer completion from another issue or stage",
        },
      } as const;
    }
    if (input.recovery === true && stageRun.leaseExpiresAt && stageRun.leaseExpiresAt <= now) {
      const recoveredExpiry = new Date(now.getTime() + 5 * 60 * 1000);
      const recovered = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const locked = await tx.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stageRun.id)).for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked || locked.state !== "running" || locked.leaseActorType !== "system" || locked.leaseActorId !== entry.runId ||
            locked.leaseOwner !== stageRun.leaseOwner || !locked.leaseExpiresAt || locked.leaseExpiresAt > now) return locked;
        return tx.update(profitFlywheelStageRuns).set({
          leaseExpiresAt: recoveredExpiry,
          heartbeatAt: now,
          updatedAt: now,
        }).where(and(
          eq(profitFlywheelStageRuns.id, locked.id),
          eq(profitFlywheelStageRuns.state, "running"),
          eq(profitFlywheelStageRuns.leaseOwner, locked.leaseOwner!),
          lte(profitFlywheelStageRuns.leaseExpiresAt, now),
        )).returning().then((rows) => rows[0] ?? null);
      });
      if (!recovered) return { status: "ignored", reason: "ledger_stage_recovery_race" } as const;
      stageRun = recovered;
    }
    if (entry.finalOutcome !== "pending_flywheel_sync" || !entry.finalResponseSha256 || !entry.finalResponseChars) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_incomplete_final",
          blocker_detail: `${stageRun.stage} context ledger lacks a complete pending-sync final response hash`,
          next_owner: "hermes_runtime_owner",
          resume_condition: "Persist a complete non-tool-only final response and rerun exact-stage ledger completion sync",
        },
      } as const;
    }
    const roots = workflowArtifactRoots(workflow);
    const cwd = entry.cwd ? await realpath(entry.cwd).catch(() => "") : "";
    const targetRoot = roots.targetRepoRoot ? await realpath(roots.targetRepoRoot).catch(() => "") : "";
    if (!cwd || !targetRoot || cwd !== targetRoot) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_workspace_binding_invalid",
          blocker_detail: "Stage execution cwd is not the canonical pinned target repository root",
          next_owner: "paperclip_workspace_owner",
          resume_condition: "Run the exact stage in its pinned target repository workspace",
        },
      } as const;
    }
    const candidatePaths = [...new Set(entry.receiptPaths ?? [])];
    const stageFeedback = asRecord(stageRun.feedback);
    const manifestBinding = asRecord(stageFeedback.execution_manifest_binding);
    const manifestPath = typeof manifestBinding.path === "string" ? path.resolve(manifestBinding.path) : "";
    const executionManifestSha256 = typeof manifestBinding.manifest_sha256 === "string" ? manifestBinding.manifest_sha256 : "";
    const executionManifestFileSha256 = typeof manifestBinding.file_sha256 === "string" ? manifestBinding.file_sha256 : "";
    const manifestFile = manifestPath && manifestPath.startsWith(`${targetRoot}${path.sep}.paperclip${path.sep}manifests${path.sep}`)
      ? await readImmutableFileStrict(manifestPath, "Profit Flywheel execution manifest", 1024 * 1024).catch(() => null)
      : null;
    let executionManifest: Record<string, unknown> = {};
    if (manifestFile) {
      try { executionManifest = asRecord(JSON.parse(manifestFile.bytes.toString("utf8"))); } catch { executionManifest = {}; }
    }
    const { manifest_sha256: declaredManifestSha256, ...manifestBody } = executionManifest;
    if (!manifestFile || (manifestFile.stat.mode & 0o777) !== 0o444 || manifestFile.sha256 !== executionManifestFileSha256 ||
        !/^[a-f0-9]{64}$/.test(executionManifestSha256) || !/^[a-f0-9]{64}$/.test(executionManifestFileSha256) ||
        declaredManifestSha256 !== executionManifestSha256 ||
        hashProfitFlywheelValue(manifestBody) !== executionManifestSha256 ||
        stableJson(asRecord(runContext.paperclipProfitFlywheelExecutionManifest)) !== stableJson(manifestBinding) ||
        runContext.paperclipProfitFlywheelExecutionManifestSha256 !== executionManifestSha256) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "execution_manifest_binding_invalid",
          blocker_detail: "Stage feedback, heartbeat context, and canonical execution manifest hash do not match",
          next_owner: "paperclip_runtime_owner",
          resume_condition: "Regenerate the server-authored execution manifest for the exact stage attempt before adapter spawn",
        },
      } as const;
    }
    const expectedWorkResultPath = typeof manifestBinding.receipt_output_path === "string"
      ? manifestBinding.receipt_output_path
      : "";
    if (executionManifest.receipt_output_path !== expectedWorkResultPath || manifestBinding.attempt !== stageRun.attemptCount ||
        manifestBinding.stage_run_id !== stageRun.id) {
      throw new ProfitFlywheelError("profit_flywheel_execution_manifest_drift", "Execution manifest binding no longer matches the exact stage attempt/output path");
    }
    const workResults: Array<{ path: string; sha256: string; bytes: Buffer; value: Record<string, unknown> }> = [];
    for (const candidate of candidatePaths) {
      if (typeof candidate !== "string" || !candidate.trim() || candidate.includes("\0")) continue;
      const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
      const resolved = await realpath(absolute).catch(() => "");
      if (!resolved || resolved !== absolute || !(resolved === targetRoot || resolved.startsWith(`${targetRoot}${path.sep}`))) continue;
      const immutable = await readImmutableFileStrict(resolved, "stage work result", 1024 * 1024).catch(() => null);
      if (!immutable || (immutable.stat.mode & 0o777) !== 0o444) continue;
      const bytes = immutable.bytes;
      let value: Record<string, unknown>;
      try { value = asRecord(JSON.parse(bytes.toString("utf8"))); } catch { continue; }
      if (value.schema_version !== "paperclip.profit_flywheel_stage_work_result.v1") continue;
      validateProfitFlywheelStageWorkResult(value);
      workResults.push({ path: resolved, sha256: createHash("sha256").update(bytes).digest("hex"), bytes, value });
    }
    const matches = workResults.filter(({ path: workResultPath, value }) =>
      workResultPath === expectedWorkResultPath && value.execution_manifest_sha256 === executionManifestSha256 &&
      value.execution_manifest_file_sha256 === executionManifestFileSha256 &&
      value.workflow_id === workflow.id && value.stage_run_id === stageRun.id &&
      value.company_id === stageRun.companyId && value.issue_id === stageRun.linkedIssueId &&
      value.correlation_id === workflow.correlationId && value.trace_id === workflow.traceId &&
      value.stage === stageRun.stage && value.attempt === stageRun.attemptCount && value.input_hash === stageRun.inputHash);
    if (matches.length !== 1) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_work_result_missing",
          blocker_detail: `Expected exactly one read-only exact-stage work result at the manifest path; found ${matches.length}`,
          next_owner: "implementation_agent",
          resume_condition: "Write one paperclip.profit_flywheel_stage_work_result.v1 at the exact manifest path; Paperclip will add run/final/usage evidence after completion",
        },
      } as const;
    }
    const workResult = matches[0]!;
    const evidence = workResult.value;
    const usage = asRecord(run.usageJson);
    const inputTokens = Number(usage.inputTokens ?? usage.observedInputTokens ?? usage.rawInputTokens);
    const outputTokens = Number(usage.outputTokens ?? usage.observedOutputTokens ?? usage.rawOutputTokens);
    const loadedPolicy = await loadProviderPolicyV2();
    const route = stageRun.providerRouteId ? loadedPolicy.policy.routes[stageRun.providerRouteId] : null;
    const providerObservationFailures = [
      !route ? "route_missing" : null,
      stageRun.providerPolicySha256 !== loadedPolicy.sha256 ? "policy_sha256" : null,
      providerPolicyRouteCoreSha256(asRecord(stageRun.providerRouteSnapshot)) !== stageRun.providerRouteCoreSha256 ? "route_core_sha256" : null,
      completionCanaryRouteSha256(asRecord(stageRun.providerRouteSnapshot)) !== stageRun.providerRouteSha256 ? "resolved_route_sha256" : null,
      route && route.providerFamily !== stageRun.providerFamily ? "provider_family" : null,
      route && (route.model.kind === "exact" ? route.model.value : null) !== stageRun.providerModel ? "model" : null,
      route && route.model.version !== stageRun.providerModelVersion ? "model_version" : null,
      !Number.isFinite(inputTokens) || inputTokens <= 0 ? "input_tokens" : null,
      !Number.isFinite(outputTokens) || outputTokens <= 0 ? "output_tokens" : null,
    ].filter((value): value is string => Boolean(value));
    if (providerObservationFailures.length > 0) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "provider_result_observation_invalid",
          blocker_detail: `Server-observed provider/model/version/policy/usage/final evidence is incomplete or stale: ${providerObservationFailures.join(",")}`,
          next_owner: "paperclip_runtime_owner",
          resume_condition: "Reconcile the canonical adapter/context-ledger result without accepting agent-authored provider evidence",
        },
      } as const;
    }
    const provider = {
      route_id: stageRun.providerRouteId,
      route_core_sha256: stageRun.providerRouteCoreSha256,
      route_sha256: stageRun.providerRouteSha256,
      provider_family: stageRun.providerFamily,
      model: stageRun.providerModel,
      version: stageRun.providerModelVersion,
      policy_sha256: loadedPolicy.sha256,
      policy_schema_sha256: loadedPolicy.schemaSha256,
      final_response_sha256: entry.finalResponseSha256,
      final_response_complete: true,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
    const tests = Array.isArray(evidence.tests) ? evidence.tests.map(asRecord) : [];
    if (tests.length === 0) {
      return { status: "incomplete", blocker: {
        blocker_code: "execution_test_claims_missing",
        blocker_detail: "Stage work result does not enumerate the server-pinned test commands",
        next_owner: "implementation_agent",
        resume_condition: "List every exact required command in tests[]; Paperclip will rerun and observe them independently",
      } } as const;
    }
    const requiredTestCommands = Array.isArray(executionManifest.required_test_commands)
      ? executionManifest.required_test_commands.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const observedTestCommands = tests.map((test) => typeof test.command === "string" ? test.command.trim() : "");
    if (requiredTestCommands.length === 0 || stableJson(observedTestCommands) !== stableJson(requiredTestCommands)) {
      throw new ProfitFlywheelError(
        "profit_flywheel_required_test_commands_mismatch",
        "Stage work result tests must exactly match the ordered server-pinned command list without omissions, substitutions, duplicates, or extras",
        { requiredTestCommands, observedTestCommands },
      );
    }
    const workflowServerRoot = asRecord(workflow.feedback).server_artifact_root;
    const serverArtifactRoot = path.resolve(
      deps.serverArtifactRoot ??
      (typeof workflowServerRoot === "string" ? workflowServerRoot : DEFAULT_PROFIT_FLYWHEEL_SERVER_ARTIFACT_ROOT),
    );
    if (typeof workflowServerRoot === "string" && path.resolve(workflowServerRoot) !== serverArtifactRoot) {
      throw new ProfitFlywheelError("profit_flywheel_server_artifact_root_drift", "Server artifact root differs from the workflow-pinned authority");
    }
    const serverReceiptDirectory = path.join(
      serverArtifactRoot,
      stageRun.companyId,
      workflow.id,
      stageRun.id,
      `attempt-${stageRun.attemptCount}`,
    );
    const serverTestResults = [];
    const serverTestObservationCompletedAt: string[] = [];
    for (const [commandIndex, command] of requiredTestCommands.entries()) {
      const commandSha256 = createHash("sha256").update(command).digest("hex");
      const journalDedupeKey = `server-test-observation:${stageRun.id}:${stageRun.attemptCount}:${commandIndex}`;
      let journal = await db.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.workflowId, workflow.id),
        eq(profitFlywheelEvents.dedupeKey, journalDedupeKey),
      )).then((rows) => rows[0] ?? null);
      if (!journal) {
        journal = await appendEvent(db, {
          workflow,
          stageRunId: stageRun.id,
          eventType: "server_test_observation",
          dedupeKey: journalDedupeKey,
          spanId: stageRun.spanId,
          payload: {
            stage: stageRun.stage,
            attempt: stageRun.attemptCount,
            command_index: commandIndex,
            command_sha256: commandSha256,
            observation_nonce: randomUUID(),
            observation_state: "prepared",
          },
          processedAt: now,
        });
      }
      if (!journal) {
        journal = await db.select().from(profitFlywheelEvents).where(and(
          eq(profitFlywheelEvents.workflowId, workflow.id),
          eq(profitFlywheelEvents.dedupeKey, journalDedupeKey),
        )).then((rows) => rows[0] ?? null);
      }
      let journalPayload = asRecord(journal?.payload);
      if (!journal || journalPayload.stage !== stageRun.stage || journalPayload.attempt !== stageRun.attemptCount ||
          journalPayload.command_index !== commandIndex || journalPayload.command_sha256 !== commandSha256 ||
          !["prepared", "running", "completed"].includes(String(journalPayload.observation_state))) {
        throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test observation journal does not bind the exact stage attempt and command");
      }
      let observationState = String(journalPayload.observation_state);
      if (observationState !== "completed") {
        if (observationState === "running") {
          const claimedAt = typeof journalPayload.observation_claimed_at === "string"
            ? Date.parse(journalPayload.observation_claimed_at)
            : Number.NaN;
          if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 10 * 60 * 1000) {
            return {
              status: "incomplete",
              blocker: {
                blocker_code: "server_test_observation_in_progress",
                blocker_detail: "Another reconciler owns the fresh server-test execution claim",
                next_owner: "paperclip_runtime_owner",
                resume_condition: "Wait for the bounded server test claim to complete or recover it after the ten-minute orphan timeout",
              },
            } as const;
          }
        }
        const priorClaimId = typeof journalPayload.observation_claim_id === "string" ? journalPayload.observation_claim_id : null;
        const claimId = randomUUID();
        const claimedPayload = {
          ...journalPayload,
          observation_nonce: randomUUID(),
          observation_state: "running",
          observation_claim_id: claimId,
          observation_claimed_at: new Date().toISOString(),
        };
        const claimConditions = [
          eq(profitFlywheelEvents.id, journal.id),
          sql`${profitFlywheelEvents.payload}->>'observation_state' = ${observationState}`,
          ...(observationState === "running"
            ? [sql`${profitFlywheelEvents.payload}->>'observation_claim_id' = ${priorClaimId ?? ""}`]
            : []),
        ];
        const claimedJournal = await db.update(profitFlywheelEvents).set({
          payload: claimedPayload,
          updatedAt: new Date(),
        }).where(and(...claimConditions)).returning().then((rows) => rows[0] ?? null);
        if (!claimedJournal) {
          const winner = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, journal.id)).then((rows) => rows[0] ?? null);
          const winnerPayload = asRecord(winner?.payload);
          if (winner && winnerPayload.observation_state === "completed" && typeof winnerPayload.receipt_sha256 === "string") {
            journal = winner;
            journalPayload = winnerPayload;
            observationState = "completed";
          } else {
            return {
              status: "incomplete",
              blocker: {
                blocker_code: "server_test_observation_in_progress",
                blocker_detail: "A concurrent reconciler won the server-test execution claim",
                next_owner: "paperclip_runtime_owner",
                resume_condition: "Replay completion after the winning bounded server test claim persists its immutable receipt",
              },
            } as const;
          }
        } else {
          journal = claimedJournal;
          journalPayload = claimedPayload;
          observationState = "running";
        }
      }
      const observationNonce = typeof journalPayload.observation_nonce === "string" ? journalPayload.observation_nonce : "";
      const expectedReceiptPath = path.join(serverReceiptDirectory, `${observationNonce}-server-test.json`);
      const completedOutcome = journalPayload.observation_outcome;
      const completedFailureClass = journalPayload.failure_class;
      const supportedFailureClasses = new Set([
        "target_test_failure", "target_test_timeout", "unsafe_test_output", "workspace_dirty",
        "test_mutated_git_head", "process_spawn_failed",
      ]);
      const completedBindingInvalid = observationState === "completed" && (
        !/^[0-9a-f]{64}$/.test(String(journalPayload.receipt_sha256 ?? "")) ||
        journalPayload.receipt_path !== expectedReceiptPath ||
        !["passed", "failed"].includes(String(completedOutcome)) ||
        typeof journalPayload.observation_completed_at !== "string" ||
        !Number.isFinite(Date.parse(String(journalPayload.observation_completed_at))) ||
        (completedOutcome === "passed" && completedFailureClass != null) ||
        (completedOutcome === "failed" && !supportedFailureClasses.has(String(completedFailureClass)))
      );
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observationNonce) || completedBindingInvalid) {
        throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test journal lacks its exact nonce or completed receipt binding");
      }
      try {
        const observed = await runOrReuseServerObservedTest({
          stageRunId: stageRun.id,
          attempt: stageRun.attemptCount,
          commandIndex,
          command,
          cwd: targetRoot,
          receiptDirectory: serverReceiptDirectory,
          observationNonce,
          trustedReceiptSha256: observationState === "completed" && typeof journalPayload.receipt_sha256 === "string"
            ? journalPayload.receipt_sha256
            : null,
          trustedObservationOutcome: observationState === "completed" && (completedOutcome === "passed" || completedOutcome === "failed")
            ? completedOutcome
            : null,
          trustedFailureClass: observationState === "completed" && typeof completedFailureClass === "string"
            ? completedFailureClass
            : null,
          timeoutMs: deps.serverTestLimits?.timeoutMs,
          maxOutputBytes: deps.serverTestLimits?.maxOutputBytes,
        });
        serverTestResults.push(observed);
        const observationCompletedAt = observationState === "completed"
          ? String(journalPayload.observation_completed_at)
          : now.toISOString();
        const completedJournal = await db.update(profitFlywheelEvents).set({
          payload: {
            ...journalPayload,
            observation_state: "completed",
            observation_outcome: "passed",
            observation_completed_at: observationCompletedAt,
            receipt_path: observed.artifact_ref,
            receipt_sha256: observed.artifact_hash,
          },
          updatedAt: now,
        }).where(and(
          eq(profitFlywheelEvents.id, journal.id),
          sql`${profitFlywheelEvents.payload}->>'observation_state' = ${observationState}`,
          ...(observationState === "running"
            ? [sql`${profitFlywheelEvents.payload}->>'observation_claim_id' = ${String(journalPayload.observation_claim_id ?? "")}`]
            : []),
        )).returning({ id: profitFlywheelEvents.id });
        if (completedJournal.length !== 1) {
          throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test receipt lost its database completion journal CAS");
        }
        serverTestObservationCompletedAt.push(observationCompletedAt);
      } catch (error) {
        const failure = error instanceof ProfitFlywheelError ? error : null;
        const supported = new Set([
          "target_test_failure", "target_test_timeout", "unsafe_test_output", "workspace_dirty",
          "test_mutated_git_head", "process_spawn_failed",
        ]);
        if (!failure || !supported.has(failure.code)) throw error;
        const receiptPath = typeof failure.internalDetails.testReceiptPath === "string" ? failure.internalDetails.testReceiptPath : null;
        const receiptSha256 = typeof failure.internalDetails.testReceiptSha256 === "string" ? failure.internalDetails.testReceiptSha256 : null;
        if (receiptPath && receiptSha256) {
          const observationCompletedAt = observationState === "completed" && typeof journalPayload.observation_completed_at === "string"
            ? journalPayload.observation_completed_at
            : now.toISOString();
          const completedFailureJournal = await db.update(profitFlywheelEvents).set({
            payload: {
              ...journalPayload,
              observation_state: "completed",
              observation_outcome: "failed",
              observation_completed_at: observationCompletedAt,
              failure_class: failure.code,
              receipt_path: receiptPath,
              receipt_sha256: receiptSha256,
            },
            updatedAt: now,
          }).where(and(
            eq(profitFlywheelEvents.id, journal.id),
            sql`${profitFlywheelEvents.payload}->>'observation_state' = ${observationState}`,
            ...(observationState === "running"
              ? [sql`${profitFlywheelEvents.payload}->>'observation_claim_id' = ${String(journalPayload.observation_claim_id ?? "")}`]
              : []),
          )).returning({ id: profitFlywheelEvents.id });
          if (completedFailureJournal.length !== 1) {
            throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test failure receipt lost its database completion journal CAS");
          }
        }
        const nextOwner = failure.code === "unsafe_test_output"
          ? "paperclip_security_owner"
          : stageRun.stage === "qa" ? "qa_agent" : stageRun.stage === "release" ? "release_agent" : "implementation_agent";
        const resumeCondition = failure.code === "target_test_failure"
          ? `Fix the target so the exact pinned command passes, then resume a new stage attempt: ${command}`
          : failure.code === "target_test_timeout"
            ? `Bound or optimize the exact pinned command below the five-minute server timeout, then resume: ${command}`
            : failure.code === "unsafe_test_output"
              ? "Remove secret-like or unbounded test output, rotate any exposed credential, and resume only after security review"
              : failure.code === "workspace_dirty"
                ? "Commit or remove every change outside .paperclip, prove the target HEAD is clean, then resume a new stage attempt"
                : failure.code === "test_mutated_git_head"
                  ? "Make tests non-mutating and restore the exact authorized target git object before resuming"
                  : "Restore the bounded noninteractive test process runtime, then resume the same pinned command on a new attempt";
        return {
          status: "incomplete",
          blocker: {
            blocker_code: failure.code,
            blocker_detail: `${failure.message}${receiptPath && receiptSha256 ? `; immutable_failure_receipt=${receiptPath} sha256=${receiptSha256}` : ""}`,
            next_owner: nextOwner,
            resume_condition: resumeCondition,
          },
        } as const;
      }
    }
    const [manifestAfterTests, workResultAfterTests] = await Promise.all([
      readImmutableFileStrict(manifestPath, "Profit Flywheel execution manifest after server tests", 1024 * 1024).catch(() => null),
      readImmutableFileStrict(workResult.path, "stage work result after server tests", 1024 * 1024).catch(() => null),
    ]);
    if (!manifestAfterTests || (manifestAfterTests.stat.mode & 0o777) !== 0o444 ||
        manifestAfterTests.sha256 !== manifestFile.sha256 || !manifestAfterTests.bytes.equals(manifestFile.bytes) ||
        !workResultAfterTests || (workResultAfterTests.stat.mode & 0o777) !== 0o444 ||
        workResultAfterTests.sha256 !== workResult.sha256 || !workResultAfterTests.bytes.equals(workResult.bytes)) {
      return {
        status: "incomplete",
        blocker: {
          blocker_code: "execution_authority_drift_after_tests",
          blocker_detail: "A server-pinned test deleted, replaced, chmodded, or rewrote the immutable execution manifest or agent work result",
          next_owner: "paperclip_security_owner",
          resume_condition: "Restore the exact 0444 manifest and work-result bytes, make every pinned test non-mutating for those authorities, and resume under a fresh stage attempt",
        },
      } as const;
    }
    const receiptTestResults = serverTestResults.map((result) => ({ ...result, status: "passed" }));
    const executionEnvelopeValue = {
      ...evidence,
      schema_version: "paperclip.profit_flywheel_stage_execution.v2",
      heartbeat_run_id: run.id,
      context_ledger_entry_id: entry.id,
      provider_result: provider,
      tests: serverTestResults,
      work_result: {
        path: workResult.path,
        sha256: workResult.sha256,
        schema_version: "paperclip.profit_flywheel_stage_work_result.v1",
      },
    };
    validateProfitFlywheelStageExecutionEnvelope(executionEnvelopeValue);
    const executionBinding = await writeImmutableJsonArtifactAt({
      artifactPath: path.join(serverReceiptDirectory, `${stageRun.id}-attempt-${stageRun.attemptCount}-execution.json`),
      value: executionEnvelopeValue,
      label: "server-authored stage execution envelope",
    });
    const executionReceipt = { ...executionBinding, value: executionEnvelopeValue };
    if (serverTestObservationCompletedAt.length !== requiredTestCommands.length) {
      throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test receipt set lacks one durable completion time per required command");
    }
    const receiptObservedAtMs = Math.max(...serverTestObservationCompletedAt.map((value) => Date.parse(value)));
    if (!Number.isFinite(receiptObservedAtMs)) {
      throw new ProfitFlywheelError("profit_flywheel_test_journal_conflict", "Server test completion time is not a valid durable timestamp");
    }
    const common = {
      observedAt: new Date(receiptObservedAtMs).toISOString(),
      expiresAt: new Date(receiptObservedAtMs + 24 * 60 * 60 * 1000).toISOString(),
    };
    const withHash = (receipt: Omit<ProfitFlywheelReceiptInput, "contentHash">): ProfitFlywheelReceiptInput => ({
      ...receipt,
      contentHash: canonicalProfitFlywheelReceiptHash(receipt),
    });
    const receiptIdentity = {
      workflow_id: workflow.id,
      stage_run_id: stageRun.id,
      correlation_id: workflow.correlationId,
      trace_id: workflow.traceId,
      attempt: stageRun.attemptCount,
      input_hash: stageRun.inputHash,
      execution_manifest_path: manifestPath,
      execution_manifest_sha256: executionManifestSha256,
      execution_manifest_file_sha256: executionManifestFileSha256,
      work_result_path: workResult.path,
      work_result_sha256: workResult.sha256,
      execution_receipt_path: executionReceipt.path,
      execution_receipt_sha256: executionReceipt.sha256,
    };
    const baseReceipts: Array<Omit<ProfitFlywheelReceiptInput, "contentHash">> = [
      {
        type: "provider_run_receipt",
        schemaVersion: "paperclip.provider_run_receipt.v2",
        artifactRef: executionReceipt.path,
        ...common,
        attributes: {
          ...receiptIdentity,
          provider_route_id: stageRun.providerRouteId,
          provider_route_core_sha256: stageRun.providerRouteCoreSha256,
          provider_route_sha256: stageRun.providerRouteSha256,
          provider_family: stageRun.providerFamily,
          model: stageRun.providerModel,
          provider_version: stageRun.providerModelVersion,
          provider_policy_sha256: loadedPolicy.sha256,
          provider_policy_schema_sha256: loadedPolicy.schemaSha256,
          final_response_sha256: entry.finalResponseSha256,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          artifact_hash: executionReceipt.sha256,
        },
      },
    ];
    if (stageRun.stage === "implementation") {
      const workspace = asRecord(evidence.workspace);
      assertExactObjectKeys(workspace, ["root", "changed_files", "base_git_object", "target_git_object", "target_artifact_hash"], "workspace");
      const changedFiles = Array.isArray(workspace.changed_files)
        ? workspace.changed_files.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const baseObject = typeof workspace.base_git_object === "string" ? workspace.base_git_object : "";
      const targetObject = typeof workspace.target_git_object === "string" ? workspace.target_git_object : "";
      const targetHash = typeof workspace.target_artifact_hash === "string" ? workspace.target_artifact_hash : "";
      const manifestWorkspace = asRecord(executionManifest.workspace);
      if (workspace.root !== targetRoot || workspace.root !== manifestWorkspace.root ||
          baseObject !== manifestWorkspace.base_git_object || changedFiles.length === 0 ||
          !/^[a-f0-9]{40,64}$/i.test(baseObject) || !/^[a-f0-9]{40,64}$/i.test(targetObject)) {
        throw new ProfitFlywheelError("profit_flywheel_implementation_artifact_invalid", "Implementation receipt requires canonical workspace, base/target git objects, and changed files");
      }
      await verifyArtifactReference(`git:${targetObject}`, targetHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
      const [observedBranch, observedHead] = await Promise.all([
        execFile("git", ["-C", targetRoot, "branch", "--show-current"], { timeout: 15_000 }).then(({ stdout }) => stdout.trim()),
        execFile("git", ["-C", targetRoot, "rev-parse", "HEAD"], { timeout: 15_000 }).then(({ stdout }) => stdout.trim()),
      ]);
      if (observedBranch !== manifestWorkspace.run_branch || observedHead !== targetObject) {
        throw new ProfitFlywheelError(
          "profit_flywheel_implementation_branch_mismatch",
          "Implementation target object must be the exact HEAD of the authorized run branch",
          { observedBranch, observedHead, authorizedRunBranch: manifestWorkspace.run_branch, targetObject },
        );
      }
      const observedFiles = await execFile("git", ["-C", targetRoot, "diff", "--name-only", baseObject, targetObject], { timeout: 15_000 })
        .then(({ stdout }) => stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort());
      const normalizedFiles = [...new Set(changedFiles.map((value) => value.replaceAll("\\", "/")))].sort();
      if (normalizedFiles.some((value) => path.isAbsolute(value) || value.startsWith("../")) || stableJson(observedFiles) !== stableJson(normalizedFiles)) {
        throw new ProfitFlywheelError("profit_flywheel_changed_files_mismatch", "Declared changed files do not match the exact base-to-target git diff", { observedFiles, normalizedFiles });
      }
      baseReceipts.push({
        type: "issue_receipt", schemaVersion: "paperclip.issue_receipt.v2", artifactRef: executionReceipt.path, ...common,
        attributes: { ...receiptIdentity, issue_id: entry.issueId, context_ledger_entry_id: entry.id, heartbeat_run_id: run.id, artifact_hash: executionReceipt.sha256 },
      }, {
        type: "implementation_receipt", schemaVersion: "paperclip.implementation_receipt.v2", artifactRef: `git:${targetObject}`, ...common,
        attributes: {
          ...receiptIdentity,
          changed_files: normalizedFiles,
          target_commit_or_patch_hash: `git:${targetObject}`,
          artifact_hash: targetHash,
          test_results: receiptTestResults,
          final_response: `sha256:${entry.finalResponseSha256}`,
          final_response_chars: entry.finalResponseChars,
          base_git_object: baseObject,
        },
      });
    } else if (stageRun.stage === "qa") {
      const implementationLineage = asRecord(evidence.implementation_lineage);
      assertExactObjectKeys(implementationLineage, ["stage_run_id", "git_object", "artifact_hash"], "implementation_lineage");
      const builderStage = await exactQaBuilderStage(db, stageRun);
      const builderReceipt = builderStage
        ? await db.select().from(profitFlywheelReceipts).where(and(
            eq(profitFlywheelReceipts.stageRunId, builderStage.id),
            eq(profitFlywheelReceipts.receiptType, "implementation_receipt"),
            eq(profitFlywheelReceipts.status, "valid"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const builderRef = builderReceipt?.artifactRef ?? "";
      const builderHash = asRecord(builderReceipt?.attributes).artifact_hash;
      const builderProviderFamily = String(builderStage?.providerFamily ?? "");
      if (!builderStage || implementationLineage.stage_run_id !== builderStage.id ||
          implementationLineage.git_object !== builderRef.replace(/^git:/, "") || implementationLineage.artifact_hash !== builderHash) {
        throw new ProfitFlywheelError("profit_flywheel_qa_lineage_invalid", "QA manifest does not bind the exact successful implementation git artifact");
      }
      await verifyArtifactReference(builderRef, builderHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
      const review = asRecord(evidence.independent_review);
      assertExactObjectKeys(review, ["provider_family", "model", "version", "policy_sha256", "policy_schema_sha256", "artifact_ref", "artifact_hash"], "independent_review");
      const reviewerFamily = typeof review.provider_family === "string" ? review.provider_family : "";
      const reviewRef = typeof review.artifact_ref === "string" ? review.artifact_ref : "";
      const reviewHash = typeof review.artifact_hash === "string" ? review.artifact_hash : "";
      if (!reviewerFamily || reviewerFamily !== stageRun.providerFamily || review.model !== stageRun.providerModel ||
          review.version !== stageRun.providerModelVersion || review.policy_sha256 !== loadedPolicy.sha256 ||
          review.policy_schema_sha256 !== loadedPolicy.schemaSha256 || !reviewRef || !reviewHash) {
        throw new ProfitFlywheelError("profit_flywheel_review_not_independent", "QA review receipt must bind the selected QA route/model/version/policy family");
      }
      if (reviewerFamily === builderProviderFamily) {
        throw new ProfitFlywheelError("profit_flywheel_review_not_independent", "QA reviewer provider family matches the exact implementation builder family");
      }
      await verifyArtifactReference(reviewRef, reviewHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
      if (!path.isAbsolute(reviewRef)) {
        throw new ProfitFlywheelError("profit_flywheel_independent_review_schema_invalid", "Independent review result must be a read-only absolute JSON artifact");
      }
      const resolvedReviewRef = await realpath(reviewRef).catch(() => "");
      if (!resolvedReviewRef || resolvedReviewRef !== path.resolve(reviewRef)) {
        throw new ProfitFlywheelError("profit_flywheel_independent_review_schema_invalid", "Independent review result path must be canonical and non-symlinked");
      }
      const reviewArtifact = await readImmutableFileStrict(resolvedReviewRef, "independent review result", 1024 * 1024);
      if (createHash("sha256").update(reviewArtifact.bytes).digest("hex") !== reviewHash.toLowerCase()) {
        throw new ProfitFlywheelError("profit_flywheel_artifact_hash_mismatch", "Independent review result bytes changed after verification");
      }
      let reviewResultValue: unknown;
      try {
        reviewResultValue = JSON.parse(reviewArtifact.bytes.toString("utf8"));
      } catch {
        throw new ProfitFlywheelError("profit_flywheel_independent_review_schema_invalid", "Independent review result is not valid JSON");
      }
      const reviewOutcome = validateIndependentReviewResult(reviewResultValue, {
        qaStageRunId: stageRun.id,
        implementationStageRunId: builderStage.id,
        implementationGitObject: builderRef.replace(/^git:/, ""),
        implementationArtifactHash: String(builderHash),
        builderProviderFamily,
        reviewerProviderFamily: reviewerFamily,
        reviewerModel: String(review.model),
        reviewerVersion: String(review.version),
        providerPolicySha256: loadedPolicy.sha256,
        providerPolicySchemaSha256: loadedPolicy.schemaSha256,
      });
      baseReceipts.push({
        type: "qa_receipt", schemaVersion: "paperclip.qa_receipt.v2", artifactRef: executionReceipt.path, ...common,
        attributes: {
          ...receiptIdentity,
          test_commands: serverTestResults.map((row) => row.command), test_results: receiptTestResults,
          implementation_stage_run_id: builderStage.id,
          implementation_git_object: builderRef.replace(/^git:/, ""),
          implementation_artifact_hash: builderHash,
          builder_provider_family: builderProviderFamily,
          reviewer_provider_family: reviewerFamily,
          reviewer_model: review.model,
          reviewer_version: review.version,
          reviewer_policy_sha256: loadedPolicy.sha256,
          reviewer_policy_schema_sha256: loadedPolicy.schemaSha256,
          independent_review_artifact_ref: resolvedReviewRef,
          independent_review_artifact_hash: reviewHash,
          independent_review_final_disposition: reviewOutcome.finalDisposition,
          artifact_hash: executionReceipt.sha256,
        },
      }, {
        type: "independent_review_receipt", schemaVersion: "paperclip.independent_review_receipt.v2", artifactRef: reviewRef, ...common,
        attributes: {
          ...receiptIdentity,
          review_provider_family: reviewerFamily,
          review_model: review.model,
          review_version: review.version,
          review_policy_sha256: loadedPolicy.sha256,
          review_policy_schema_sha256: loadedPolicy.schemaSha256,
          builder_provider_family: builderProviderFamily,
          implementation_stage_run_id: builderStage.id,
          implementation_git_object: builderRef.replace(/^git:/, ""),
          implementation_artifact_hash: builderHash,
          artifact_hash: reviewHash,
          review_status: reviewOutcome.state,
          final_disposition: reviewOutcome.finalDisposition,
          review_summary: reviewOutcome.summary,
        },
      });
    } else {
      const qaLineage = asRecord(evidence.qa_lineage);
      assertExactObjectKeys(qaLineage, ["stage_run_id", "implementation_stage_run_id", "git_object", "artifact_hash"], "qa_lineage");
      const sourceQaStageId = asRecord(stageRun.feedback).transition_source_stage_run_id;
      const sourceQa = typeof sourceQaStageId === "string"
        ? await db.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, sourceQaStageId),
            eq(profitFlywheelStageRuns.workflowId, workflow.id),
            eq(profitFlywheelStageRuns.stage, "qa"),
            eq(profitFlywheelStageRuns.state, "succeeded"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const qaReceipt = sourceQa
        ? await db.select().from(profitFlywheelReceipts).where(and(
            eq(profitFlywheelReceipts.stageRunId, sourceQa.id),
            eq(profitFlywheelReceipts.receiptType, "qa_receipt"),
            eq(profitFlywheelReceipts.status, "valid"),
          )).then((rows) => rows[0] ?? null)
        : null;
      const qaAttributes = asRecord(qaReceipt?.attributes);
      if (!sourceQa || qaLineage.stage_run_id !== sourceQa.id ||
          qaLineage.implementation_stage_run_id !== qaAttributes.implementation_stage_run_id ||
          qaLineage.git_object !== qaAttributes.implementation_git_object ||
          qaLineage.artifact_hash !== qaAttributes.implementation_artifact_hash) {
        throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Release manifest does not bind the exact QA-tested implementation artifact");
      }
      const release = asRecord(evidence.release);
      assertExactObjectKeys(release, ["release_type", "git_object", "git_ref", "origin_url", "artifact_ref", "artifact_hash", "status"], "release");
      const releaseRef = typeof release.artifact_ref === "string" ? release.artifact_ref : "";
      const releaseHash = typeof release.artifact_hash === "string" ? release.artifact_hash : "";
      const releaseStatus = typeof release.status === "string" ? release.status : "";
      const releaseObject = typeof release.git_object === "string" ? release.git_object : "";
      const releaseGitRef = typeof release.git_ref === "string" ? release.git_ref : "";
      const releaseOrigin = typeof release.origin_url === "string" ? release.origin_url : "";
      const manifestWorkspace = asRecord(executionManifest.workspace);
      if (release.release_type !== "git" || releaseRef !== `git:${releaseObject}` || !releaseHash || !releaseGitRef || !releaseOrigin ||
          releaseGitRef !== manifestWorkspace.authorized_ref || releaseOrigin !== manifestWorkspace.authorized_origin ||
          !["released", "deployed", "published", "verified", "passed"].includes(releaseStatus.toLowerCase())) {
        throw new ProfitFlywheelError("profit_flywheel_release_not_artifact_backed", "Release execution receipt lacks passing immutable release evidence");
      }
      await verifyArtifactReference(releaseRef, releaseHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
      const testedObject = String(qaLineage.git_object ?? "");
      await execFile("git", ["-C", targetRoot, "merge-base", "--is-ancestor", testedObject, releaseObject], { timeout: 15_000 }).catch(() => {
        throw new ProfitFlywheelError("profit_flywheel_release_lineage_invalid", "Released git object does not descend from the QA-tested object");
      });
      const observedOrigin = await execFile("git", ["-C", targetRoot, "remote", "get-url", "origin"], { timeout: 15_000 }).then(({ stdout }) => stdout.trim());
      if (observedOrigin !== releaseOrigin || observedOrigin !== asRecord(workflow.feedback).target_origin_url) {
        throw new ProfitFlywheelError("profit_flywheel_release_origin_mismatch", "Release origin does not match the authorized target repository");
      }
      const remoteRef = await execFile("git", ["-C", targetRoot, "ls-remote", "--exit-code", "origin", releaseGitRef], {
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
      })
        .then(({ stdout }) => stdout.trim().split(/\s+/)[0] ?? "").catch(() => "");
      if (remoteRef !== releaseObject) {
        throw new ProfitFlywheelError("profit_flywheel_release_not_published", "Release git object is not the exact object at the authorized origin/ref", { releaseGitRef, remoteRef, releaseObject });
      }
      baseReceipts.push({
        type: "release_receipt", schemaVersion: "paperclip.release_receipt.v2", artifactRef: releaseRef, ...common,
        attributes: {
          ...receiptIdentity,
          release_status: releaseStatus,
          artifact_hash: releaseHash,
          qa_stage_run_id: sourceQa.id,
          qa_receipt_hash: qaReceipt!.contentHash,
          qa_execution_receipt_ref: qaReceipt!.artifactRef,
          qa_execution_receipt_hash: qaAttributes.artifact_hash,
          implementation_stage_run_id: qaAttributes.implementation_stage_run_id,
          implementation_git_object: qaAttributes.implementation_git_object,
          implementation_artifact_hash: qaAttributes.implementation_artifact_hash,
          builder_provider_family: qaAttributes.builder_provider_family,
          reviewer_provider_family: qaAttributes.reviewer_provider_family,
          independent_review_artifact_ref: qaAttributes.independent_review_artifact_ref,
          independent_review_artifact_hash: qaAttributes.independent_review_artifact_hash,
          remote_origin_url: observedOrigin,
          remote_ref: releaseGitRef,
          remote_object: remoteRef,
          remote_attestation_method: "git ls-remote --exit-code origin <authorized-ref>",
          verified_at: common.observedAt,
        },
      });
    }
    if (stageRun.stage === "release" && workflow.targetRepo === "fixture/profit-canary" && stageRun.linkedIssueId) {
      const releaseReceipt = baseReceipts.find((receipt) => receipt.type === "release_receipt");
      const releaseAttributes = asRecord(releaseReceipt?.attributes);
      const windowStart = stageRun.startedAt ?? run.startedAt ?? now;
      const measuredSource = {
        schema_version: "paperclip.measured_source.v3",
        state: "measured",
        kind: "operational",
        company: workflow.companyId,
        run_id: workflow.runId,
        workflow_id: workflow.id,
        correlation_id: workflow.correlationId,
        trace_id: workflow.traceId,
        linked_issue_id: stageRun.linkedIssueId,
        target_repo: workflow.targetRepo,
        metric_name: "artifact_backed_release_verified",
        baseline_value: 0,
        observed_value: 1,
        metric_unit: "verified_release",
        measurement_window_start: windowStart.toISOString(),
        measurement_window_end: common.observedAt,
        release_artifact: {
          artifact_ref: releaseReceipt?.artifactRef ?? null,
          artifact_hash: releaseAttributes.artifact_hash ?? null,
        },
        source_receipt: { path: executionReceipt.path, sha256: executionReceipt.sha256 },
        immutable: true,
      };
      const measuredSourceBinding = await writeImmutableJsonArtifactBeside({
        sourcePath: executionReceipt.path,
        fileName: `commercial-measured-source-${stageRun.id}.json`,
        value: measuredSource,
        label: "work-canary commercial measured source",
      });
      baseReceipts.push({
        type: "measured_source_receipt",
        schemaVersion: "paperclip.measured_source.v3",
        artifactRef: measuredSourceBinding.path,
        ...common,
        attributes: {
          artifact_hash: measuredSourceBinding.sha256,
          workflow_id: workflow.id,
          stage_run_id: stageRun.id,
          linked_issue_id: stageRun.linkedIssueId,
          release_artifact_ref: releaseReceipt?.artifactRef,
          release_artifact_hash: releaseAttributes.artifact_hash,
          measurement: {
            metric_name: measuredSource.metric_name,
            baseline_value: measuredSource.baseline_value,
            observed_value: measuredSource.observed_value,
            metric_unit: measuredSource.metric_unit,
            measurement_window_start: measuredSource.measurement_window_start,
            measurement_window_end: measuredSource.measurement_window_end,
          },
          source_execution_receipt_sha256: executionReceipt.sha256,
        },
      });
    }
    for (const receipt of baseReceipts) await recordReceipt({ stageRunId: stageRun.id, receipt: withHash(receipt), trustedExecutionSync: true });
    if (!input.leaseOwner) return { status: "receipts_ready", stageRunId: stageRun.id } as const;
    const completed = await completeStage({
      stageRunId: stageRun.id,
      expectedLease: { leaseOwner: input.leaseOwner, actorType: stageRun.leaseActorType as ExpectedLease["actorType"], actorId: stageRun.leaseActorId },
      feedback: {
        ...asRecord(stageRun.feedback),
        context_ledger_entry_id: entry.id,
        context_ledger_run_id: entry.runId,
        work_result_path: workResult.path,
        work_result_sha256: workResult.sha256,
        execution_receipt_path: executionReceipt.path,
        execution_receipt_sha256: executionReceipt.sha256,
        completion_source: "server_synthesized_execution_envelope_from_verified_work_result",
      },
      now,
    });
    return { status: "complete", stageRunId: stageRun.id, completed } as const;
  }

  async function reconcilePendingContextLedgerSync(input: { limit?: number; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const entries = await db.select().from(contextLedgerEntries).where(eq(contextLedgerEntries.finalOutcome, "pending_flywheel_sync"))
      .orderBy(asc(contextLedgerEntries.updatedAt)).limit(Math.min(500, Math.max(1, input.limit ?? 100)));
    const results = [];
    for (const entry of entries) {
      if (!entry.runId) continue;
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, entry.runId)).then((rows) => rows[0] ?? null);
      const stageRunId = typeof asRecord(run?.contextSnapshot).profitFlywheelStageRunId === "string"
        ? String(asRecord(run?.contextSnapshot).profitFlywheelStageRunId)
        : "";
      if (!run || !stageRunId || run.exitCode !== 0) continue;
      const stage = await db.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, stageRunId),
        eq(profitFlywheelStageRuns.companyId, entry.companyId),
      )).then((rows) => rows[0] ?? null);
      if (!stage) continue;
      let status: "complete" | "already_complete" | "incomplete" | "ignored" = "ignored";
      if (stage.state === "succeeded" && asRecord(stage.feedback).context_ledger_entry_id === entry.id) {
        status = "already_complete";
      } else if (stage.state === "running" && stage.leaseActorType === "system" && stage.leaseActorId === entry.runId && stage.leaseOwner) {
        const sync = await syncContextLedgerCompletion({
          contextLedgerEntryId: entry.id,
          stageRunId: stage.id,
          leaseOwner: stage.leaseOwner,
          recovery: true,
          now,
        });
        status = sync.status === "complete" ? "complete" : sync.status === "incomplete" ? "incomplete" : "ignored";
      }
      if (status === "complete" || status === "already_complete") {
        await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          await tx.update(contextLedgerEntries).set({
            finalOutcome: "succeeded",
            finalBlocker: null,
            updatedAt: now,
          }).where(and(
            eq(contextLedgerEntries.id, entry.id),
            eq(contextLedgerEntries.finalOutcome, "pending_flywheel_sync"),
          ));
          await tx.update(heartbeatRuns).set({
            status: "succeeded",
            error: null,
            errorCode: null,
            finishedAt: run.finishedAt ?? now,
            updatedAt: now,
          }).where(and(
            eq(heartbeatRuns.id, run.id),
            inArray(heartbeatRuns.status, ["running", "failed"]),
          ));
        });
      }
      results.push({ contextLedgerEntryId: entry.id, stageRunId: stage.id, status });
    }
    return results;
  }

  async function verifiedWorkflowFileReceiptBinding(input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    stage: "qa" | "release";
    receiptType: "qa_receipt" | "release_receipt";
    linkedIssueId: string;
  }) {
    const stageRun = await db.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.workflowId, input.workflow.id),
      eq(profitFlywheelStageRuns.companyId, input.workflow.companyId),
      eq(profitFlywheelStageRuns.stage, input.stage),
      eq(profitFlywheelStageRuns.state, "succeeded"),
    )).orderBy(asc(profitFlywheelStageRuns.createdAt)).then((rows) => rows.at(-1) ?? null);
    if (!stageRun || stageRun.linkedIssueId !== input.linkedIssueId) {
      throw new ProfitFlywheelError(
        "profit_flywheel_outbox_lineage_missing",
        `${input.stage} outbox lineage is missing the exact succeeded execution-issue-bound stage`,
      );
    }
    const receipts = await db.select().from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.stageRunId, stageRun.id),
      eq(profitFlywheelReceipts.companyId, input.workflow.companyId),
      eq(profitFlywheelReceipts.status, "valid"),
    ));
    const receipt = receipts.find((candidate) => candidate.receiptType === input.receiptType) ?? null;
    const providerReceipt = receipts.find((candidate) => candidate.receiptType === "provider_run_receipt") ?? null;
    if (!receipt || !providerReceipt) {
      throw new ProfitFlywheelError(
        "profit_flywheel_outbox_lineage_missing",
        `${input.stage} outbox lineage lacks its validated receipt/provider receipt pair`,
      );
    }
    const feedback = asRecord(stageRun.feedback);
    const receiptAttributes = asRecord(receipt.attributes);
    const providerAttributes = asRecord(providerReceipt.attributes);
    const executionPath = typeof feedback.execution_receipt_path === "string" ? feedback.execution_receipt_path : "";
    const executionSha256 = typeof feedback.execution_receipt_sha256 === "string"
      ? feedback.execution_receipt_sha256.toLowerCase()
      : "";
    if (!path.isAbsolute(executionPath) || !/^[a-f0-9]{64}$/.test(executionSha256) ||
        providerReceipt.artifactRef !== executionPath || providerAttributes.artifact_hash !== executionSha256 ||
        providerAttributes.execution_receipt_sha256 !== executionSha256 ||
        receiptAttributes.execution_receipt_sha256 !== executionSha256) {
      throw new ProfitFlywheelError(
        "profit_flywheel_outbox_file_binding_missing",
        `${input.stage} must expose the exact validated immutable execution-receipt file, not only a git object`,
      );
    }
    const artifactPolicy = workflowArtifactRoots(input.workflow);
    await verifyArtifactReference(executionPath, executionSha256, artifactPolicy.allowedArtifactRoots, artifactPolicy.targetRepoRoot);
    return {
      binding: {
        path: await realpath(executionPath),
        sha256: executionSha256,
        artifact_ref: receipt.artifactRef,
        artifact_hash: receiptAttributes.artifact_hash ?? null,
        receipt_hash: receipt.contentHash,
        stage_run_id: stageRun.id,
        receipt_type: receipt.receiptType,
      },
      proof: canonicalDbReceiptProof(receipt),
    };
  }

  async function verifiedObservationFileReceiptBinding(input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    stageRun: typeof profitFlywheelStageRuns.$inferSelect;
    receipts: Array<typeof profitFlywheelReceipts.$inferSelect>;
    linkedIssueId: string;
  }) {
    if (input.stageRun.stage !== "commercial_observation" || input.stageRun.state !== "succeeded" ||
        input.stageRun.linkedIssueId !== input.linkedIssueId) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_lineage_missing", "Learning outbox lacks the exact succeeded observation issue lineage");
    }
    const receipt = input.receipts.find((candidate) => candidate.receiptType === "commercial_observation_receipt") ?? null;
    const attributes = asRecord(receipt?.attributes);
    const artifactRef = receipt?.artifactRef ?? "";
    const artifactHash = typeof attributes.artifact_hash === "string" ? attributes.artifact_hash.toLowerCase() : "";
    if (!receipt || !path.isAbsolute(artifactRef) || !/^[a-f0-9]{64}$/.test(artifactHash)) {
      throw new ProfitFlywheelError(
        "profit_flywheel_outbox_file_binding_missing",
        "Learning outbox requires the validated immutable commercial-observation receipt file and SHA-256",
      );
    }
    const artifactPolicy = workflowArtifactRoots(input.workflow);
    await verifyArtifactReference(artifactRef, artifactHash, artifactPolicy.allowedArtifactRoots, artifactPolicy.targetRepoRoot);
    return {
      binding: {
        path: await realpath(artifactRef),
        sha256: artifactHash,
        artifact_ref: artifactRef,
        artifact_hash: artifactHash,
        receipt_hash: receipt.contentHash,
        stage_run_id: input.stageRun.id,
        receipt_type: receipt.receiptType,
      },
      proof: canonicalDbReceiptProof(receipt),
    };
  }

  async function verifiedMeasuredSourceFileReceiptBinding(input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    stageRun: typeof profitFlywheelStageRuns.$inferSelect;
    receipts: Array<typeof profitFlywheelReceipts.$inferSelect>;
  }) {
    const receipt = input.receipts.find((candidate) => candidate.receiptType === "measured_source_receipt") ?? null;
    if (!receipt) return null;
    const attributes = asRecord(receipt.attributes);
    const artifactRef = receipt.artifactRef ?? "";
    const artifactHash = typeof attributes.artifact_hash === "string" ? attributes.artifact_hash.toLowerCase() : "";
    if (!path.isAbsolute(artifactRef) || !/^[a-f0-9]{64}$/.test(artifactHash)) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_file_binding_missing", "Measured source receipt lacks an immutable absolute file/hash binding");
    }
    await verifyArtifactReference(artifactRef, artifactHash, workflowArtifactRoots(input.workflow).allowedArtifactRoots, input.workflow.targetWorkspaceRoot);
    return {
      path: await realpath(artifactRef),
      sha256: artifactHash,
      artifact_ref: artifactRef,
      artifact_hash: artifactHash,
      receipt_hash: receipt.contentHash,
      stage_run_id: input.stageRun.id,
      receipt_type: receipt.receiptType,
    };
  }

  async function listPortfolioOsOutbox(companyId: string, input: { limit?: number; stages?: ProfitFlywheelStage[] } = {}) {
    const limit = Math.min(Math.max(1, input.limit ?? 100), 500);
    const now = new Date();
    const eventConditions = [
      eq(profitFlywheelEvents.companyId, companyId),
      eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
      isNull(profitFlywheelEvents.processedAt),
      lte(profitFlywheelEvents.nextAttemptAt, now),
    ];
    if (input.stages?.length) {
      eventConditions.push(inArray(sql<string>`${profitFlywheelEvents.payload}->>'stage'`, input.stages));
    }
    const events = await db.select().from(profitFlywheelEvents).where(and(...eventConditions))
      .orderBy(asc(profitFlywheelEvents.createdAt)).limit(limit);
    const envelopes = [];
    for (const event of events) {
      try {
      const stageRun = event.stageRunId
        ? await db.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, event.stageRunId),
            eq(profitFlywheelStageRuns.companyId, companyId),
          )).then((rows) => rows[0] ?? null)
        : null;
      if (!stageRun || stageRun.ownerPlane !== "portfolio_os") continue;
      const workflow = await db.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, stageRun.workflowId),
        eq(profitFlywheelWorkflows.companyId, companyId),
      )).then((rows) => rows[0] ?? null);
      if (!workflow) continue;
      if (["succeeded", "blocked", "failed", "cancelled", "safely_skipped"].includes(stageRun.state)) {
        await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          const lockedEvent = await tx.select().from(profitFlywheelEvents).where(and(
            eq(profitFlywheelEvents.id, event.id),
            eq(profitFlywheelEvents.companyId, companyId),
            eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!lockedEvent?.stageRunId || lockedEvent.processedAt) return;
          const lockedStage = await tx.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, lockedEvent.stageRunId),
            eq(profitFlywheelStageRuns.companyId, companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!lockedStage || lockedStage.workflowId !== lockedEvent.workflowId || lockedStage.ownerPlane !== "portfolio_os" ||
              !["succeeded", "blocked", "failed", "cancelled", "safely_skipped"].includes(lockedStage.state)) return;
          const lockedWorkflow = await tx.select().from(profitFlywheelWorkflows).where(and(
            eq(profitFlywheelWorkflows.id, lockedStage.workflowId),
            eq(profitFlywheelWorkflows.companyId, companyId),
          )).then((rows) => rows[0] ?? null);
          if (!lockedWorkflow) return;
          const reconciledAt = new Date();
          const repaired = await tx.update(profitFlywheelEvents).set({
            processedAt: reconciledAt,
            lastError: null,
            updatedAt: reconciledAt,
          }).where(and(
            eq(profitFlywheelEvents.id, lockedEvent.id),
            isNull(profitFlywheelEvents.processedAt),
          )).returning({ id: profitFlywheelEvents.id });
          if (repaired.length === 0) return;
          await deps.terminalOutboxReconciliationBeforeAppend?.();
          await appendEvent(tx, {
            workflow: lockedWorkflow,
            stageRunId: lockedStage.id,
            eventType: "outbox_terminal_reconciled",
            dedupeKey: `outbox-terminal-reconciled:${lockedEvent.id}:${lockedStage.state}:${lockedStage.attemptCount}`,
            fromState: lockedStage.state,
            toState: lockedStage.state,
            spanId: lockedStage.spanId,
            payload: {
              stage: lockedStage.stage,
              input_hash: lockedStage.inputHash,
              outbox_event_id: lockedEvent.id,
              terminal_state: lockedStage.state,
              attempt: lockedStage.attemptCount,
            },
            processedAt: reconciledAt,
          });
        });
        continue;
      }
      if (!["pending", "retry"].includes(stageRun.state)) continue;
      const sourceStage = stageRun.transitionSourceStageRunId
        ? await db.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, stageRun.transitionSourceStageRunId),
            eq(profitFlywheelStageRuns.workflowId, workflow.id),
            eq(profitFlywheelStageRuns.companyId, companyId),
          )).then((rows) => rows[0] ?? null)
        : null;
      const sourceReceipts = sourceStage
        ? await db.select().from(profitFlywheelReceipts).where(and(
            eq(profitFlywheelReceipts.stageRunId, sourceStage.id),
            eq(profitFlywheelReceipts.companyId, companyId),
            eq(profitFlywheelReceipts.status, "valid"),
          ))
        : [];
      if (!sourceStage) {
        throw new ProfitFlywheelError(
          "profit_flywheel_outbox_lineage_missing",
          `${stageRun.stage} outbox stage must retain its exact transition source stage`,
        );
      }
      const downstreamStage = stageRun.stage === "commercial_observation" || stageRun.stage === "learning";
      if (downstreamStage && (!stageRun.linkedIssueId || sourceStage.linkedIssueId !== stageRun.linkedIssueId)) {
        throw new ProfitFlywheelError(
          "profit_flywheel_outbox_lineage_missing",
          `${stageRun.stage} outbox stage must retain the authoritative execution issue`,
        );
      }
      const qaVerified = downstreamStage
        ? await verifiedWorkflowFileReceiptBinding({
            workflow,
            stage: "qa",
            receiptType: "qa_receipt",
            linkedIssueId: stageRun.linkedIssueId!,
          })
        : null;
      const releaseVerified = downstreamStage
        ? await verifiedWorkflowFileReceiptBinding({
            workflow,
            stage: "release",
            receiptType: "release_receipt",
            linkedIssueId: stageRun.linkedIssueId!,
          })
        : null;
      const commercialObservationVerified = stageRun.stage === "learning"
        ? await verifiedObservationFileReceiptBinding({
            workflow,
            stageRun: sourceStage,
            receipts: sourceReceipts,
            linkedIssueId: stageRun.linkedIssueId!,
          })
        : null;
      const qaBinding = qaVerified?.binding ?? null;
      const releaseBinding = releaseVerified?.binding ?? null;
      const commercialObservationBinding = commercialObservationVerified?.binding ?? null;
      const feedback = asRecord(workflow.feedback);
      const eventPayload = asRecord(event.payload);
      const portfolioOsClaim = asRecord(asRecord(stageRun.feedback).portfolio_os_claim);
      const activeClaim = stageRun.state === "pending" && portfolioOsClaim.event_id === event.id &&
        portfolioOsClaim.attempt === stageRun.attemptCount && typeof portfolioOsClaim.claim_nonce === "string";
      const transitionContext = asRecord(eventPayload.transition_context);
      const measuredSourceBinding = stageRun.stage === "commercial_observation"
        ? await verifiedMeasuredSourceFileReceiptBinding({ workflow, stageRun: sourceStage, receipts: sourceReceipts })
        : null;
      if (stageRun.stage === "commercial_observation" && stableJson(transitionContext.measured_source_binding ?? null) !== stableJson(measuredSourceBinding)) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_measurement_binding_drift", "Commercial observation event measured-source binding differs from the reverified durable receipt");
      }
      const stagePlane = ["evidence_normalization", "commercial_validation", "council_decision", "dispatch"].includes(stageRun.stage);
      const executor = stageRun.stage === "commercial_observation" || stageRun.stage === "learning"
        ? {
            route: "paperclip_return_plane",
            invocation: "completion_event",
            command: `./bin/pos paperclip-return-plane --company-id ${companyId}`,
            next_owner: "portfolio_os_return_plane_executor",
          }
        : stagePlane
          ? {
              route: "portfolio_os_stage_plane",
              invocation: "completion_event",
              command: `./bin/pos paperclip-stage-plane --company-id ${companyId}`,
              next_owner: "portfolio_os_stage_plane_executor",
            }
        : {
            route: "market_voc_source_pipeline",
            invocation: "event_driven",
            command: `./bin/pos paperclip-research-plane --company-id ${companyId}`,
            next_owner: "portfolio_os_market_voc_source_executor",
          };
      envelopes.push({
        schema_version: "paperclip.portfolio_os_stage_outbox.v2",
        authority: "paperclip_db_outbox",
        event_id: event.id,
        company_id: companyId,
        project_id: workflow.projectId,
        workflow_id: workflow.id,
        run_id: workflow.runId,
        correlation_id: workflow.correlationId,
        trace_id: workflow.traceId,
        stage_run_id: stageRun.id,
        stage: stageRun.stage,
        state: stageRun.state,
        attempt: activeClaim ? stageRun.attemptCount : Math.min(stageRun.maxAttempts, stageRun.attemptCount + 1),
        max_attempts: stageRun.maxAttempts,
        claim_active: activeClaim,
        input_hash: stageRun.inputHash,
        source_hashes: stageRun.sourceHashes,
        idempotency_key: stageRun.idempotencyKey,
        transition_source_stage_run_id: stageRun.transitionSourceStageRunId,
        transition_source_output_hash: stageRun.transitionSourceOutputHash,
        target_repo: workflow.targetRepo,
        target_workspace_root: workflow.targetWorkspaceRoot,
        linked_issue_id: stageRun.linkedIssueId,
        transition: eventPayload,
        executor,
        deferred_handoff: stageRun.stage === "research_intake"
          ? {
              schema_version: "paperclip.portfolio_os_executor_handoff.v1",
              state: "pending",
              next_owner: executor.next_owner,
              resume_condition: "Run the Paperclip research-plane consumer for this exact event/input/source-registry hash; do not consume it with the observation/learning return-plane client",
            }
          : null,
        qa_binding: qaBinding,
        release_binding: releaseBinding,
        measured_source_binding: measuredSourceBinding,
        commercial_observation_binding: commercialObservationBinding,
        artifact_receipts: stageRun.stage === "learning" && commercialObservationBinding && qaBinding && releaseBinding
          ? {
              qa: { path: qaBinding.path, sha256: qaBinding.sha256 },
              release: { path: releaseBinding.path, sha256: releaseBinding.sha256 },
              commercial_observation: { path: commercialObservationBinding.path, sha256: commercialObservationBinding.sha256 },
            }
          : null,
        receipt_proofs: stageRun.stage === "learning" && qaVerified && releaseVerified && commercialObservationVerified
          ? {
              qa: qaVerified.proof,
              release: releaseVerified.proof,
              commercial_observation: commercialObservationVerified.proof,
            }
          : null,
        measurement_plan: transitionContext.measurement_plan ?? null,
        observation_window: transitionContext.observation_window ?? null,
        ...(stageRun.stage === "research_intake"
          ? { research_plan: transitionContext.research_plan }
          : {}),
        source_receipts: sourceReceipts.map((receipt) => ({
          type: receipt.receiptType,
          schemaVersion: receipt.schemaVersion,
          contentHash: receipt.contentHash,
          artifactRef: receipt.artifactRef,
          observedAt: receipt.observedAt.toISOString(),
          expiresAt: receipt.expiresAt?.toISOString() ?? null,
          attributes: receipt.attributes,
        })),
        contract: {
          path: workflow.contractPath,
          sha256: workflow.contractSha256,
          schema_version: "profit-flywheel.v2",
        },
        provider_policy: feedback.provider_policy ?? null,
        artifact_roots: workflowArtifactRoots(workflow).allowedArtifactRoots,
        dispatch_issue_identity: stageRun.stage === "dispatch"
          ? dispatchIssueIdentity({
              companyId,
              workflowId: workflow.id,
              stageRunId: stageRun.id,
              inputHash: stageRun.inputHash,
            })
          : null,
        dispatch_authoring_authority: stageRun.stage === "dispatch"
          ? {
              schema_version: "paperclip.profit_flywheel_dispatch_authoring_authority.v1",
              company_id: companyId,
              workflow_id: workflow.id,
              stage_run_id: stageRun.id,
              input_hash: stageRun.inputHash,
              source_hashes: stageRun.sourceHashes,
              target_repo: workflow.targetRepo,
              target_workspace_root: workflow.targetWorkspaceRoot,
              historical_workflow_dispatch: {
                artifact_ref: workflow.sourceDispatchPath,
                artifact_hash: workflow.sourceDispatchHash,
                role: "workflow_kickoff_history_only",
              },
              required_receipt_attributes: [
                "workflow_id", "stage_run_id", "input_hash", "authoring_inputs",
                "dispatch_hash", "artifact_hash", "issue_id", "issue_origin_id", "attempt",
              ],
            }
          : null,
        ack: {
          schema_version: "paperclip.portfolio_os_stage_ack.v2",
          method: "POST",
          path: `/api/companies/${companyId}/profit-flywheel/portfolio-os-outbox/${event.id}/ack`,
          claim_path: `/api/companies/${companyId}/profit-flywheel/portfolio-os-outbox/${event.id}/claim`,
          output_hash_algorithm: "sha256(canonical_json({stage,input_hash,receipts_sorted_by_canonical_tuple}))",
          required_receipt_types: stageDefinition(parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot), stageRun.stage as ProfitFlywheelStage).required_receipts,
        },
        created_at: event.createdAt.toISOString(),
      });
      } catch (error) {
        const terminalStage = event.stageRunId
          ? await db.select({ state: profitFlywheelStageRuns.state }).from(profitFlywheelStageRuns)
              .where(eq(profitFlywheelStageRuns.id, event.stageRunId))
              .then((rows) => rows[0] ?? null)
          : null;
        if (terminalStage && ["succeeded", "blocked", "failed", "cancelled", "safely_skipped"].includes(terminalStage.state)) {
          // Terminal torn-event repair is itself an atomic reconciliation path.
          // Its append failures must remain visible so callers cannot mistake a
          // rolled-back repair for a quarantined pending envelope.
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const blocker = {
          blockerCode: "profit_flywheel_outbox_envelope_invalid",
          blockerDetail: detail.slice(0, 2_000) || "Portfolio OS outbox envelope validation failed",
          nextOwner: "portfolio_os_runtime_owner",
          resumeCondition: "Repair the exact event/workflow/stage lineage or immutable artifact binding, then explicitly resume this same outbox event and input hash",
        };
        try {
          await blockPortfolioOsOutboxInfrastructure({ companyId, eventId: event.id, blocker, now });
        } catch (blockError) {
          logger.error({
            companyId,
            eventId: event.id,
            error: blockError instanceof Error ? blockError.message : String(blockError),
            envelopeError: blocker.blockerDetail,
          }, "Profit Flywheel outbox poison could not be durably blocked; continuing with later events");
        }
      }
    }
    return { schema_version: "paperclip.portfolio_os_stage_outbox_page.v2", company_id: companyId, count: envelopes.length, events: envelopes };
  }

  async function claimPortfolioOsOutbox(input: {
    companyId: string;
    eventId: string;
    workflowId: string;
    stageRunId: string;
    stage: ProfitFlywheelStage;
    inputHash: string;
    attempt: number;
    principal: { type: "agent" | "board"; id: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    if (input.principal.type !== "agent") {
      throw new ProfitFlywheelError("profit_flywheel_pos_principal_required", "Portfolio OS outbox claim requires the workflow-pinned executor agent");
    }
    const authority = await db.select().from(profitFlywheelWorkflows).where(and(
      eq(profitFlywheelWorkflows.id, input.workflowId),
      eq(profitFlywheelWorkflows.companyId, input.companyId),
    )).then((rows) => rows[0] ?? null);
    if (!authority) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Portfolio OS claim workflow is missing");
    await assertPortfolioOsExecutorPrincipal(authority, input.principal.id);
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const event = await tx.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.id, input.eventId),
        eq(profitFlywheelEvents.companyId, input.companyId),
        eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
      )).for("update").then((rows) => rows[0] ?? null);
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, input.stageRunId),
        eq(profitFlywheelStageRuns.companyId, input.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!event || !stageRun || event.workflowId !== input.workflowId || event.stageRunId !== stageRun.id ||
          stageRun.workflowId !== input.workflowId || stageRun.stage !== input.stage || stageRun.inputHash !== input.inputHash ||
          stageRun.ownerPlane !== "portfolio_os") {
        throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Portfolio OS claim does not bind the exact pending event/workflow/stage/input");
      }
      const existingClaim = asRecord(asRecord(stageRun.feedback).portfolio_os_claim);
      const exactExistingClaim = existingClaim.event_id === event.id && existingClaim.attempt === input.attempt &&
        existingClaim.attempt === stageRun.attemptCount && typeof existingClaim.claim_nonce === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingClaim.claim_nonce) &&
        typeof existingClaim.claimed_at === "string";
      if (exactExistingClaim) {
        return {
          schema_version: "paperclip.portfolio_os_stage_claim.v2",
          event_id: event.id,
          workflow_id: stageRun.workflowId,
          stage_run_id: stageRun.id,
          stage: stageRun.stage,
          input_hash: stageRun.inputHash,
          attempt: input.attempt,
          claim_nonce: existingClaim.claim_nonce,
          claimed_at: existingClaim.claimed_at,
          max_attempts: stageRun.maxAttempts,
        };
      }
      if (event.processedAt) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", "Processed Portfolio OS event has no matching recoverable attempt claim");
      }
      if (stageRun.state === "pending" && existingClaim.event_id === event.id && existingClaim.attempt === stageRun.attemptCount) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "A different execution attempt is already active for this Portfolio OS event");
      }
      if (stageRun.state === "retry" && stageRun.retryAt && stageRun.retryAt > now) {
        throw new ProfitFlywheelError("profit_flywheel_retry_not_due", `Portfolio OS retry is not due until ${stageRun.retryAt.toISOString()}`);
      }
      if (!new Set(["pending", "retry"]).has(stageRun.state)) {
        throw new ProfitFlywheelError("profit_flywheel_stage_not_claimable", `Portfolio OS stage is ${stageRun.state}, not pending/retry`);
      }
      if (stageRun.attemptCount >= stageRun.maxAttempts) {
        throw new ProfitFlywheelError("profit_flywheel_attempts_exhausted", "Portfolio OS stage exhausted its contract-frozen maximum attempts");
      }
      const attempt = stageRun.attemptCount + 1;
      if (input.attempt !== attempt) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", `Portfolio OS claim requested attempt ${input.attempt}, but the exact next attempt is ${attempt}`);
      }
      const claimNonce = randomUUID();
      const claimNonceSha256 = createHash("sha256").update(claimNonce, "utf8").digest("hex");
      const portfolioOsClaim = {
        event_id: event.id,
        attempt,
        claim_nonce: claimNonce,
        claimed_at: now.toISOString(),
        actor_id: input.principal.id,
      };
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: "pending",
        attemptCount: attempt,
        retryAt: null,
        feedback: { ...asRecord(stageRun.feedback), portfolio_os_claim: portfolioOsClaim },
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, stageRun.state),
        eq(profitFlywheelStageRuns.attemptCount, stageRun.attemptCount),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Portfolio OS attempt claim lost its stage compare-and-set");
      // Event attempt_count is the consecutive executor-launch retry counter.
      // The stage row plus this server-issued nonce are the sole execution-attempt authority.
      await tx.update(profitFlywheelEvents).set({ lastError: null, updatedAt: now })
        .where(and(eq(profitFlywheelEvents.id, event.id), isNull(profitFlywheelEvents.processedAt)));
      await appendEvent(tx, {
        workflow: authority,
        stageRunId: stageRun.id,
        eventType: "stage_attempt_claimed",
        dedupeKey: `stage-attempt-claimed:${stageRun.id}:${attempt}:${claimNonceSha256}`,
        fromState: stageRun.state,
        toState: "pending",
        spanId: stageRun.spanId,
        payload: {
          stage: stageRun.stage,
          input_hash: stageRun.inputHash,
          attempt,
          claim_nonce_sha256: claimNonceSha256,
          outbox_event_id: event.id,
        },
        processedAt: now,
      });
      return {
        schema_version: "paperclip.portfolio_os_stage_claim.v2",
        event_id: event.id,
        workflow_id: stageRun.workflowId,
        stage_run_id: stageRun.id,
        stage: stageRun.stage,
        input_hash: stageRun.inputHash,
        attempt,
        claim_nonce: claimNonce,
        claimed_at: now.toISOString(),
        max_attempts: stageRun.maxAttempts,
      };
    });
  }

  async function blockPortfolioOsOutboxInfrastructure(input: {
    companyId: string;
    eventId: string;
    blocker: Partial<Blocker>;
    now?: Date;
  }) {
    const blocker = requireBlocker(input.blocker);
    const now = input.now ?? new Date();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const event = await tx.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.id, input.eventId),
        eq(profitFlywheelEvents.companyId, input.companyId),
        eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!event?.stageRunId) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Infrastructure blocker does not bind an exact Portfolio OS outbox stage");
      }
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, event.stageRunId),
        eq(profitFlywheelStageRuns.companyId, input.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      const workflow = stageRun
        ? await tx.select().from(profitFlywheelWorkflows).where(and(
            eq(profitFlywheelWorkflows.id, event.workflowId),
            eq(profitFlywheelWorkflows.id, stageRun.workflowId),
            eq(profitFlywheelWorkflows.companyId, input.companyId),
          )).then((rows) => rows[0] ?? null)
        : null;
      if (!stageRun || !workflow || stageRun.ownerPlane !== "portfolio_os") {
        throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Infrastructure blocker event/workflow/stage binding is invalid");
      }
      if (event.processedAt && stageRun.state === "blocked" && stageRun.blockerCode === blocker.blockerCode) {
        await ensureWorkflowBlockerIssue(tx, workflow, blocker, "outbox_infrastructure");
        return { status: "already_blocked" as const, eventId: event.id, stageRunId: stageRun.id };
      }
      if (event.processedAt || !["pending", "retry"].includes(stageRun.state)) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_infrastructure_block_conflict", "Infrastructure blocker requires an unconsumed pending or retry Portfolio OS stage");
      }
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      assertTransition(contract, stageRun.stage as ProfitFlywheelStage, stageRun.state as CanonicalRunState, "blocked");
      const updatedStage = await tx.update(profitFlywheelStageRuns).set({
        state: "blocked",
        retryAt: null,
        blockerCode: blocker.blockerCode,
        blockerDetail: blocker.blockerDetail,
        nextOwner: blocker.nextOwner,
        resumeCondition: blocker.resumeCondition,
        leaseOwner: null,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, stageRun.state),
        eq(profitFlywheelStageRuns.attemptCount, stageRun.attemptCount),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updatedStage) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_infrastructure_block_conflict", "Infrastructure blocker lost its stage compare-and-set");
      }
      await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, stageRun.id));
      await tx.update(profitFlywheelEvents).set({ processedAt: now, lastError: blocker.blockerDetail, updatedAt: now })
        .where(and(eq(profitFlywheelEvents.id, event.id), isNull(profitFlywheelEvents.processedAt)));
      await tx.update(profitFlywheelWorkflows).set({
        state: "blocked",
        blockerCode: blocker.blockerCode,
        blockerDetail: blocker.blockerDetail,
        nextOwner: blocker.nextOwner,
        resumeCondition: blocker.resumeCondition,
        updatedAt: now,
      }).where(and(eq(profitFlywheelWorkflows.id, workflow.id), eq(profitFlywheelWorkflows.companyId, input.companyId)));
      if (stageRun.linkedIssueId) {
        await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, input.companyId),
        ));
      }
      await ensureWorkflowBlockerIssue(tx, workflow, blocker, "outbox_infrastructure");
      await deps.terminalOutboxReconciliationBeforeAppend?.();
      await appendEvent(tx, {
        workflow,
        stageRunId: stageRun.id,
        eventType: "stage_blocked",
        dedupeKey: `pos-infrastructure-blocked:${stageRun.id}:${stageRun.attemptCount}:${blocker.blockerCode}`,
        fromState: stageRun.state,
        toState: "blocked",
        spanId: stageRun.spanId,
        payload: {
          stage: stageRun.stage,
          input_hash: stageRun.inputHash,
          outbox_event_id: event.id,
          attempt: stageRun.attemptCount,
          blocker_code: blocker.blockerCode,
          blocker_class: "portfolio_os_executor_infrastructure",
        },
        processedAt: now,
      });
      return { status: "blocked" as const, eventId: event.id, stageRunId: stageRun.id };
    });
  }

  async function acknowledgePortfolioOsOutbox(input: {
    companyId: string;
    eventId: string;
    workflowId: string;
    stageRunId: string;
    stage: ProfitFlywheelStage;
    inputHash: string;
    attempt: number;
    claimNonce: string;
    state: "succeeded" | "degraded" | "blocked" | "failed";
    outputHash?: string;
    receipts?: ProfitFlywheelReceiptInput[];
    linkedIssueId?: string;
    blocker?: Partial<Blocker>;
    principal: { type: "agent" | "board"; id: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    if (input.principal.type !== "agent") {
      throw new ProfitFlywheelError("profit_flywheel_pos_principal_required", "Portfolio OS outbox acknowledgement requires the dedicated Portfolio OS Orchestrator agent");
    }
    const event = await db.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.id, input.eventId),
      eq(profitFlywheelEvents.companyId, input.companyId),
      eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
    )).then((rows) => rows[0] ?? null);
    if (!event || event.workflowId !== input.workflowId || event.stageRunId !== input.stageRunId) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Portfolio OS ack does not bind the exact outbox event/workflow/stage");
    }
    const detail = await getStageRun(input.stageRunId);
    if (!detail || detail.workflow.companyId !== input.companyId || detail.stageRun.stage !== input.stage ||
        detail.stageRun.inputHash !== input.inputHash || detail.stageRun.ownerPlane !== "portfolio_os") {
      throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Portfolio OS ack stage/company/input binding is invalid");
    }
    await assertPortfolioOsExecutorPrincipal(detail.workflow, input.principal.id);
    const assertCompletionEventDelivered = async () => {
      const completionEvent = await db.select({ processedAt: profitFlywheelEvents.processedAt, lastError: profitFlywheelEvents.lastError })
        .from(profitFlywheelEvents).where(and(
          eq(profitFlywheelEvents.workflowId, input.workflowId),
          eq(profitFlywheelEvents.stageRunId, input.stageRunId),
          eq(profitFlywheelEvents.eventType, "stage_succeeded"),
        )).orderBy(asc(profitFlywheelEvents.createdAt)).then((rows) => rows.at(-1) ?? null);
      if (!completionEvent?.processedAt) {
        throw new ProfitFlywheelError(
          "profit_flywheel_transition_delivery_pending",
          "Stage completion is durable but its transition event has not been safely delivered",
          { lastError: completionEvent?.lastError ?? null },
        );
      }
    };
    const claimedAttempt = asRecord(asRecord(detail.stageRun.feedback).portfolio_os_claim);
    if (claimedAttempt.event_id !== event.id || claimedAttempt.attempt !== input.attempt ||
        claimedAttempt.claim_nonce !== input.claimNonce || detail.stageRun.attemptCount !== input.attempt) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", "Portfolio OS acknowledgement does not bind the exact current server-issued attempt nonce");
    }
    if (input.state !== "succeeded") {
      const blocker = requireBlocker(input.blocker ?? {});
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await lockProfitFlywheelEvent(tx, input.eventId);
        await lockProfitFlywheelStageRun(tx, input.stageRunId);
        const [currentEvent, currentStage, workflow] = await Promise.all([
          tx.select().from(profitFlywheelEvents).where(and(
            eq(profitFlywheelEvents.id, input.eventId),
            eq(profitFlywheelEvents.companyId, input.companyId),
            eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
          )).then((rows) => rows[0] ?? null),
          tx.select().from(profitFlywheelStageRuns).where(and(
            eq(profitFlywheelStageRuns.id, input.stageRunId),
            eq(profitFlywheelStageRuns.companyId, input.companyId),
          )).then((rows) => rows[0] ?? null),
          tx.select().from(profitFlywheelWorkflows).where(and(
            eq(profitFlywheelWorkflows.id, input.workflowId),
            eq(profitFlywheelWorkflows.companyId, input.companyId),
          )).then((rows) => rows[0] ?? null),
        ]);
        if (!currentEvent || !currentStage || !workflow || currentEvent.workflowId !== workflow.id ||
            currentEvent.stageRunId !== currentStage.id || currentStage.workflowId !== workflow.id ||
            currentStage.stage !== input.stage || currentStage.inputHash !== input.inputHash || currentStage.ownerPlane !== "portfolio_os") {
          throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Portfolio OS non-success ack lost its exact durable binding");
        }
        const currentClaim = asRecord(asRecord(currentStage.feedback).portfolio_os_claim);
        if (currentClaim.event_id !== currentEvent.id || currentClaim.attempt !== input.attempt ||
            currentClaim.claim_nonce !== input.claimNonce || currentStage.attemptCount !== input.attempt) {
          throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", "Portfolio OS non-success ack is stale for the current attempt nonce");
        }
        const blockerMatches = currentStage.blockerCode === blocker.blockerCode &&
          currentStage.blockerDetail === blocker.blockerDetail && currentStage.nextOwner === blocker.nextOwner &&
          currentStage.resumeCondition === blocker.resumeCondition;
        const deferRequested = input.state === "degraded";
        if (deferRequested && !currentEvent.processedAt && currentStage.state === "retry" && blockerMatches &&
            currentStage.retryAt && currentStage.retryAt > now) {
          return {
            status: "deferred" as const,
            state: input.state,
            persistedState: "retry" as const,
            retryNotBefore: currentStage.retryAt,
            eventId: currentEvent.id,
            stageRunId: currentStage.id,
            blocker,
          };
        }
        const replayState = deferRequested ? "blocked" : input.state;
        if (currentEvent.processedAt || currentStage.state === input.state || (deferRequested && currentStage.state === "blocked")) {
          if (currentStage.state === replayState && blockerMatches) {
            if (!currentEvent.processedAt) {
              await tx.update(profitFlywheelEvents).set({ processedAt: now, lastError: null, updatedAt: now })
                .where(and(eq(profitFlywheelEvents.id, currentEvent.id), isNull(profitFlywheelEvents.processedAt)));
            }
            return {
              status: deferRequested ? "retry_exhausted" as const : currentEvent.processedAt ? "already_acknowledged" as const : "reconciled_torn_ack" as const,
              state: input.state,
              persistedState: currentStage.state,
              eventId: currentEvent.id,
              stageRunId: currentStage.id,
              blocker,
            };
          }
          throw new ProfitFlywheelError("profit_flywheel_outbox_replay_conflict", "Outbox event was already consumed with different non-success state");
        }
        const actorType = input.principal.type;
        const actorId = input.principal.id;
        if (currentStage.state === "running" && (
          currentStage.leaseActorType !== actorType || currentStage.leaseActorId !== actorId || !currentStage.leaseOwner
        )) {
          throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Portfolio OS outbox stage is leased to a different actor");
        }
        const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
        const fromState = currentStage.state as CanonicalRunState;
        const nextAttemptCount = currentStage.attemptCount;
        const canRetry = deferRequested && nextAttemptCount < currentStage.maxAttempts;
        const targetState: CanonicalRunState = canRetry ? "retry" : deferRequested ? "blocked" : input.state;
        if (["pending", "retry"].includes(fromState) && ["retry", "degraded", "failed"].includes(targetState)) {
          assertTransition(contract, input.stage, fromState, "running");
          assertTransition(contract, input.stage, "running", targetState);
        } else {
          assertTransition(contract, input.stage, fromState, targetState);
        }
        const definition = stageDefinition(contract, input.stage);
        const retryIndex = Math.max(0, nextAttemptCount - 1);
        const backoffSeconds = definition.retry.backoff_seconds[Math.min(retryIndex, definition.retry.backoff_seconds.length - 1)] ?? 60;
        const retryAt = canRetry ? new Date(now.getTime() + backoffSeconds * 1000) : null;
        const updatedStage = await tx.update(profitFlywheelStageRuns).set({
          state: targetState,
          attemptCount: nextAttemptCount,
          retryAt,
          blockerCode: blocker.blockerCode,
          blockerDetail: blocker.blockerDetail,
          nextOwner: blocker.nextOwner,
          resumeCondition: blocker.resumeCondition,
          feedback: {
            ...asRecord(currentStage.feedback),
            outbox_event_id: currentEvent.id,
            acknowledgement_schema: "paperclip.portfolio_os_stage_ack.v2",
            acknowledgement_state: input.state,
            acknowledged_by: { actor_type: actorType, actor_id: actorId },
          },
          leaseOwner: null,
          leaseActorType: null,
          leaseActorId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: targetState === "failed" ? now : null,
          updatedAt: now,
        }).where(and(
          eq(profitFlywheelStageRuns.id, currentStage.id),
          eq(profitFlywheelStageRuns.state, currentStage.state),
        )).returning().then((rows) => rows[0] ?? null);
        if (!updatedStage) throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Portfolio OS non-success ack lost the stage compare-and-set");
        await tx.delete(profitFlywheelLeases).where(eq(profitFlywheelLeases.stageRunId, currentStage.id));
        if (currentStage.linkedIssueId) {
          await tx.update(issues).set({ status: "blocked", updatedAt: now }).where(and(
            eq(issues.id, currentStage.linkedIssueId),
            eq(issues.companyId, currentStage.companyId),
          ));
        }
        await tx.update(profitFlywheelWorkflows).set({
          state: canRetry ? "degraded" : targetState,
          blockerCode: blocker.blockerCode,
          blockerDetail: blocker.blockerDetail,
          nextOwner: blocker.nextOwner,
          resumeCondition: blocker.resumeCondition,
          completedAt: targetState === "failed" ? now : null,
          updatedAt: now,
        }).where(eq(profitFlywheelWorkflows.id, workflow.id));
        const eventType = canRetry ? "stage_retry_scheduled" : targetState === "failed" ? "stage_failed" : "stage_blocked";
        await appendEvent(tx, {
          workflow,
          stageRunId: currentStage.id,
          eventType,
          dedupeKey: `${eventType}:${currentStage.id}:${nextAttemptCount}:${hashProfitFlywheelValue(blocker)}`,
          fromState,
          toState: targetState,
          spanId: currentStage.spanId,
          payload: { stage: input.stage, input_hash: input.inputHash, ...blocker, acknowledgement_state: input.state, retry_at: retryAt?.toISOString() ?? null },
          processedAt: now,
        });
        await tx.update(profitFlywheelEvents).set(canRetry ? {
          processedAt: null,
          nextAttemptAt: retryAt!,
          lastError: blocker.blockerDetail,
          updatedAt: now,
        } : {
          processedAt: now,
          lastError: null,
          updatedAt: now,
        }).where(eq(profitFlywheelEvents.id, currentEvent.id));
        return {
          status: canRetry ? "deferred" as const : deferRequested ? "retry_exhausted" as const : "acknowledged" as const,
          state: input.state,
          persistedState: targetState,
          retryNotBefore: retryAt,
          eventId: currentEvent.id,
          stageRunId: currentStage.id,
          blocker,
        };
      });
    }
    if (!input.outputHash || !input.receipts) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_success_evidence_missing", "Succeeded Portfolio OS ack requires output_hash and receipts");
    }
    const parsedReceipts = input.receipts.map((receipt) => profitFlywheelReceiptSchema.parse(receipt));
    for (const receipt of parsedReceipts) {
      const attributes = asRecord(receipt.attributes);
      if ("claim_nonce" in attributes) {
        throw new ProfitFlywheelError("profit_flywheel_receipt_secret_forbidden", `${receipt.type} must not persist the transient claim nonce`);
      }
      if (attributes.attempt !== input.attempt) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_stale_attempt", `${receipt.type} does not bind the exact current attempt`);
      }
    }
    const receiptBindings = parsedReceipts.map((receipt) => ({
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      contentHash: receipt.contentHash.toLowerCase(),
      artifactRef: receipt.artifactRef,
    })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    const expectedOutputHash = hashProfitFlywheelValue({ stage: input.stage, input_hash: input.inputHash, receipts: receiptBindings });
    if (input.outputHash.toLowerCase() !== expectedOutputHash) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_output_hash_mismatch", "Portfolio OS ack output_hash does not match exact canonical receipt hashes", { expectedOutputHash });
    }
    const expectedDispatchIssueIdentity = input.stage === "dispatch"
      ? dispatchIssueIdentity({
          companyId: input.companyId,
          workflowId: input.workflowId,
          stageRunId: input.stageRunId,
          inputHash: input.inputHash,
        })
      : null;
    let acknowledgedDispatchBinding: Record<string, unknown> | null = null;
    if (expectedDispatchIssueIdentity) {
      const dispatchReceipt = parsedReceipts.find((receipt) => receipt.type === "immutable_dispatch_artifact") ?? null;
      const authorizationReceipt = parsedReceipts.find((receipt) => receipt.type === "portfolio_os_dispatch_authorization") ?? null;
      const attributes = asRecord(dispatchReceipt?.attributes);
      const iterationDispatchHash = String(attributes.dispatch_hash ?? "").toLowerCase();
      if (!input.linkedIssueId || !dispatchReceipt?.artifactRef || authorizationReceipt?.artifactRef !== dispatchReceipt.artifactRef ||
          attributes.issue_id !== input.linkedIssueId ||
          attributes.issue_origin_id !== expectedDispatchIssueIdentity.origin_id ||
          attributes.workflow_id !== detail.workflow.id || attributes.stage_run_id !== detail.stageRun.id ||
          attributes.input_hash !== detail.stageRun.inputHash ||
          stableJson(asRecord(attributes.authoring_inputs)) !== stableJson(detail.stageRun.sourceHashes) ||
          attributes.artifact_hash !== iterationDispatchHash || !/^[a-f0-9]{64}$/.test(iterationDispatchHash)) {
        throw new ProfitFlywheelError(
          "profit_flywheel_issue_binding_invalid",
          "Dispatch acknowledgement receipt must bind the exact server-issued issue origin, authoring vector, and newly authored immutable dispatch hash",
        );
      }
      acknowledgedDispatchBinding = {
        schema_version: "paperclip.profit_flywheel_iteration_dispatch_binding.v1",
        dispatch_stage_run_id: detail.stageRun.id,
        dispatch_input_hash: detail.stageRun.inputHash,
        dispatch_artifact_ref: dispatchReceipt.artifactRef,
        dispatch_artifact_hash: iterationDispatchHash,
        dispatch_receipt_hash: dispatchReceipt.contentHash,
        authoring_inputs: detail.stageRun.sourceHashes,
      };
    }
    const existingOutput = asRecord(detail.stageRun.feedback).output_hash;
    if (event.processedAt || detail.stageRun.state === "succeeded") {
      if (detail.stageRun.state === "succeeded" && existingOutput === expectedOutputHash) {
        await processPendingEvents({ workflowId: event.workflowId, limit: 20 });
        await assertCompletionEventDelivered();
        if (!event.processedAt) {
          await db.update(profitFlywheelEvents).set({ processedAt: now, lastError: null, updatedAt: now }).where(and(
            eq(profitFlywheelEvents.id, event.id),
            isNull(profitFlywheelEvents.processedAt),
          ));
          return { status: "reconciled_torn_ack" as const, eventId: event.id, stageRunId: detail.stageRun.id, outputHash: expectedOutputHash };
        }
        return { status: "already_acknowledged" as const, eventId: event.id, stageRunId: detail.stageRun.id, outputHash: expectedOutputHash };
      }
      throw new ProfitFlywheelError("profit_flywheel_outbox_replay_conflict", "Outbox event was already consumed with different durable state");
    }
    const actorId = input.principal.id;
    const actorType = input.principal.type;
    let claimed = detail.stageRun;
    if (["pending", "retry"].includes(claimed.state)) {
      claimed = await claimStage({
        stageRunId: claimed.id,
        actorType,
        actorId,
        portfolioOsAuthority: true,
        portfolioOsClaim: { eventId: event.id, attempt: input.attempt, claimNonce: input.claimNonce },
        now,
      });
    }
    if (claimed.state !== "running" || claimed.leaseActorType !== actorType || claimed.leaseActorId !== actorId || !claimed.leaseOwner) {
      throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Portfolio OS outbox stage is leased to a different actor");
    }
    if (input.stage === "dispatch") {
      if (!input.linkedIssueId) {
        throw new ProfitFlywheelError("profit_flywheel_issue_required", "Dispatch success requires the exact newly created Paperclip execution issue");
      }
      const issueIdentity = expectedDispatchIssueIdentity!;
      const bindingLeaseOwner = claimed.leaseOwner;
      if (!bindingLeaseOwner) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Dispatch issue binding requires the active Portfolio OS lease");
      }
      claimed = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const executionIssue = await tx.select().from(issues).where(and(
          eq(issues.id, input.linkedIssueId!),
          eq(issues.companyId, input.companyId),
          eq(issues.projectId, detail.workflow.projectId),
        )).for("update").then((rows) => rows[0] ?? null);
        const markerMatches = executionIssue?.description?.includes(issueIdentity.description_marker) === true;
        const exactExistingOrigin = executionIssue?.originKind === issueIdentity.origin_kind && executionIssue.originId === issueIdentity.origin_id;
        if (!executionIssue || executionIssue.hiddenAt || !["backlog", "todo", "in_progress", "in_review", "blocked"].includes(executionIssue.status) ||
            executionIssue.createdByAgentId !== actorId || executionIssue.createdAt < event.createdAt ||
            (!markerMatches && !exactExistingOrigin) ||
            !(["manual", issueIdentity.origin_kind].includes(executionIssue.originKind)) ||
            (executionIssue.originId && executionIssue.originId !== issueIdentity.origin_id)) {
          throw new ProfitFlywheelError(
            "profit_flywheel_issue_binding_invalid",
            "Dispatch execution issue must be newly created by the pinned orchestrator from the exact server-issued origin marker",
          );
        }
        const identityCandidates = await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, input.companyId),
          eq(issues.projectId, detail.workflow.projectId),
          or(
            and(eq(issues.originKind, issueIdentity.origin_kind), eq(issues.originId, issueIdentity.origin_id)),
            sql`position(${issueIdentity.description_marker} in coalesce(${issues.description}, '')) > 0`,
          ),
        )).for("update");
        if (identityCandidates.length !== 1 || identityCandidates[0]!.id !== executionIssue.id) {
          throw new ProfitFlywheelError(
            "profit_flywheel_issue_binding_conflict",
            "Dispatch issue origin resolves to zero, multiple, or a different execution issue",
          );
        }
        await tx.update(issues).set({
          originKind: issueIdentity.origin_kind,
          originId: issueIdentity.origin_id,
          originRunId: detail.workflow.runId,
          updatedAt: now,
        }).where(and(eq(issues.id, executionIssue.id), eq(issues.companyId, input.companyId)));
        const bound = await tx.update(profitFlywheelStageRuns).set({ linkedIssueId: executionIssue.id, updatedAt: now }).where(and(
          eq(profitFlywheelStageRuns.id, claimed.id),
          eq(profitFlywheelStageRuns.workflowId, detail.workflow.id),
          eq(profitFlywheelStageRuns.companyId, input.companyId),
          eq(profitFlywheelStageRuns.state, "running"),
          eq(profitFlywheelStageRuns.leaseOwner, bindingLeaseOwner),
          or(isNull(profitFlywheelStageRuns.linkedIssueId), eq(profitFlywheelStageRuns.linkedIssueId, executionIssue.id)),
        )).returning().then((rows) => rows[0] ?? null);
        if (!bound) throw new ProfitFlywheelError("profit_flywheel_issue_binding_conflict", "Dispatch stage was concurrently bound to another execution issue");
        return bound;
      });
    } else if (input.linkedIssueId) {
      throw new ProfitFlywheelError("profit_flywheel_issue_binding_invalid", "Only dispatch success may introduce a new execution issue");
    }
    const leaseOwner = claimed.leaseOwner;
    if (!leaseOwner) throw new ProfitFlywheelError("profit_flywheel_outbox_claim_conflict", "Portfolio OS outbox stage lost its lease before receipt persistence");
    for (const receipt of parsedReceipts) {
      await recordReceipt({
        stageRunId: claimed.id,
        receipt,
        leaseOwner,
        leaseActor: { type: actorType, id: actorId },
        requireActiveLease: true,
      });
    }
    await completeStage({
      stageRunId: claimed.id,
      expectedLease: { leaseOwner, actorType, actorId },
      outputHash: expectedOutputHash,
      feedback: {
        ...asRecord(claimed.feedback),
        outbox_event_id: event.id,
        acknowledgement_schema: "paperclip.portfolio_os_stage_ack.v2",
        acknowledged_by: { actor_type: actorType, actor_id: actorId },
        ...(acknowledgedDispatchBinding ? { iteration_dispatch_binding: acknowledgedDispatchBinding } : {}),
      },
      now,
    });
    await db.update(profitFlywheelEvents).set({ processedAt: now, lastError: null, updatedAt: now }).where(and(
      eq(profitFlywheelEvents.id, event.id),
      isNull(profitFlywheelEvents.processedAt),
    ));
    await processPendingEvents({ workflowId: event.workflowId, limit: 20 });
    await assertCompletionEventDelivered();
    return { status: "acknowledged" as const, eventId: event.id, stageRunId: claimed.id, outputHash: expectedOutputHash };
  }

  async function resumePortfolioOsOutbox(input: {
    companyId: string;
    eventId: string;
    workflowId: string;
    stageRunId: string;
    inputHash: string;
    expectedBlockerCode: string;
    principal: { type: "agent" | "board"; id: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    if (input.principal.type !== "agent") {
      throw new ProfitFlywheelError("profit_flywheel_pos_principal_required", "Portfolio OS outbox resume requires the dedicated Portfolio OS Orchestrator agent");
    }
    const resumeWorkflow = await db.select().from(profitFlywheelWorkflows).where(and(
      eq(profitFlywheelWorkflows.id, input.workflowId),
      eq(profitFlywheelWorkflows.companyId, input.companyId),
    )).then((rows) => rows[0] ?? null);
    if (!resumeWorkflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Portfolio OS resume workflow is missing");
    await assertPortfolioOsExecutorPrincipal(resumeWorkflow, input.principal.id);
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockProfitFlywheelEvent(tx, input.eventId);
      await lockProfitFlywheelStageRun(tx, input.stageRunId);
      const [event, stageRun, workflow] = await Promise.all([
        tx.select().from(profitFlywheelEvents).where(and(
          eq(profitFlywheelEvents.id, input.eventId),
          eq(profitFlywheelEvents.companyId, input.companyId),
          eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
        )).then((rows) => rows[0] ?? null),
        tx.select().from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.id, input.stageRunId),
          eq(profitFlywheelStageRuns.companyId, input.companyId),
        )).then((rows) => rows[0] ?? null),
        tx.select().from(profitFlywheelWorkflows).where(and(
          eq(profitFlywheelWorkflows.id, input.workflowId),
          eq(profitFlywheelWorkflows.companyId, input.companyId),
        )).then((rows) => rows[0] ?? null),
      ]);
      if (!event || !stageRun || !workflow || event.workflowId !== workflow.id || event.stageRunId !== stageRun.id ||
          stageRun.workflowId !== workflow.id || stageRun.inputHash !== input.inputHash || stageRun.ownerPlane !== "portfolio_os") {
        throw new ProfitFlywheelError("profit_flywheel_outbox_binding_mismatch", "Portfolio OS resume does not bind the exact event/workflow/stage/input");
      }
      const resumeFeedback = asRecord(stageRun.feedback);
      if (!event.processedAt && stageRun.state === "retry" &&
          resumeFeedback.resumed_outbox_event_id === event.id &&
          resumeFeedback.resumed_blocker_code === input.expectedBlockerCode) {
        const retryNotBefore = stageRun.retryAt ?? event.nextAttemptAt;
        return {
          status: "already_resumed" as const,
          schema_version: "paperclip.portfolio_os_stage_resume_response.v2",
          event_id: event.id,
          workflow_id: workflow.id,
          stage_run_id: stageRun.id,
          stage: stageRun.stage,
          input_hash: stageRun.inputHash,
          expected_blocker_code: input.expectedBlockerCode,
          retry_not_before: retryNotBefore.toISOString(),
        };
      }
      if (!event.processedAt || stageRun.state !== "blocked" || stageRun.blockerCode !== input.expectedBlockerCode) {
        throw new ProfitFlywheelError("profit_flywheel_outbox_resume_conflict", "Portfolio OS resume requires the exact consumed blocked event and blocker code");
      }
      if (stageRun.attemptCount >= stageRun.maxAttempts) {
        throw new ProfitFlywheelError("profit_flywheel_retry_exhausted", "Blocked stage exhausted its retry budget; a new authorized run is required");
      }
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      assertTransition(contract, stageRun.stage as ProfitFlywheelStage, "blocked", "retry");
      const updatedStage = await tx.update(profitFlywheelStageRuns).set({
        state: "retry",
        retryAt: now,
        blockerCode: null,
        blockerDetail: null,
        nextOwner: null,
        resumeCondition: null,
        feedback: {
          ...resumeFeedback,
          resumed_outbox_event_id: event.id,
          resumed_blocker_code: input.expectedBlockerCode,
          resumed_by: { actor_type: input.principal.type, actor_id: input.principal.id },
          resumed_at: now.toISOString(),
        },
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, "blocked"),
        eq(profitFlywheelStageRuns.blockerCode, input.expectedBlockerCode),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updatedStage) throw new ProfitFlywheelError("profit_flywheel_outbox_resume_conflict", "Portfolio OS resume lost its blocked-stage compare-and-set");
      await tx.update(profitFlywheelWorkflows).set({
        state: "running",
        blockerCode: null,
        blockerDetail: null,
        nextOwner: null,
        resumeCondition: null,
        completedAt: null,
        updatedAt: now,
      }).where(eq(profitFlywheelWorkflows.id, workflow.id));
      if (stageRun.linkedIssueId) {
        await tx.update(issues).set({ status: "todo", updatedAt: now }).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, stageRun.companyId),
        ));
      }
      await tx.update(profitFlywheelEvents).set({
        processedAt: null,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelEvents.id, event.id),
        eq(profitFlywheelEvents.processedAt, event.processedAt),
      ));
      await appendEvent(tx, {
        workflow,
        stageRunId: stageRun.id,
        eventType: "stage_resumed",
        dedupeKey: `stage-resumed:${stageRun.id}:${stageRun.attemptCount}:${input.expectedBlockerCode}`,
        fromState: "blocked",
        toState: "retry",
        spanId: stageRun.spanId,
        payload: {
          stage: stageRun.stage,
          input_hash: stageRun.inputHash,
          resumed_event_id: event.id,
          expected_blocker_code: input.expectedBlockerCode,
          retry_not_before: now.toISOString(),
        },
        processedAt: now,
      });
      return {
        status: "resumed" as const,
        schema_version: "paperclip.portfolio_os_stage_resume_response.v2",
        event_id: event.id,
        workflow_id: workflow.id,
        stage_run_id: stageRun.id,
        stage: stageRun.stage,
        input_hash: stageRun.inputHash,
        expected_blocker_code: input.expectedBlockerCode,
        retry_not_before: now.toISOString(),
      };
    });
  }

  async function resumePaperclipStage(input: {
    companyId: string;
    stageRunId: string;
    inputHash: string;
    expectedBlockerCode: string;
    principal: { type: "agent" | "board"; id: string };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const stageRun = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, input.stageRunId),
        eq(profitFlywheelStageRuns.companyId, input.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!stageRun || stageRun.ownerPlane !== "paperclip" || stageRun.inputHash !== input.inputHash) {
        throw new ProfitFlywheelError("profit_flywheel_resume_binding_mismatch", "Paperclip resume does not bind the exact company, stage, owner plane, and input hash");
      }
      const priorResume = asRecord(stageRun.feedback);
      const priorPrincipal = asRecord(priorResume.resumed_by);
      if (stageRun.state === "pending" && priorResume.resumed_blocker_code === input.expectedBlockerCode) {
        if (priorPrincipal.actor_type !== input.principal.type || priorPrincipal.actor_id !== input.principal.id) {
          throw new ProfitFlywheelError("profit_flywheel_resume_replay_conflict", "Paperclip stage was resumed by a different principal");
        }
        return { status: "already_resumed" as const, stageRunId: stageRun.id, workflowId: stageRun.workflowId };
      }
      if (stageRun.state !== "blocked" || stageRun.blockerCode !== input.expectedBlockerCode) {
        throw new ProfitFlywheelError("profit_flywheel_resume_cas_mismatch", "Paperclip stage is not blocked with the expected blocker code");
      }
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, stageRun.workflowId),
        eq(profitFlywheelWorkflows.companyId, input.companyId),
      )).then((rows) => rows[0] ?? null);
      if (!workflow) throw new ProfitFlywheelError("profit_flywheel_workflow_missing", "Paperclip resume workflow is missing");
      const candidates = await tx.select().from(agents).where(eq(agents.companyId, input.companyId));
      const invokable = candidates.filter((agent) => !["terminated", "paused", "pending_approval"].includes(agent.status));
      if (stageRun.linkedIssueId) {
        const issue = await tx.select().from(issues).where(and(
          eq(issues.id, stageRun.linkedIssueId),
          eq(issues.companyId, input.companyId),
        )).then((rows) => rows[0] ?? null);
        if (!issue?.assigneeAgentId || !invokable.some((agent) => agent.id === issue.assigneeAgentId)) {
          throw new ProfitFlywheelError("profit_flywheel_resume_condition_unsatisfied", "The authoritative linked issue still lacks an invokable assigned agent");
        }
      } else if (invokable.length === 0) {
        throw new ProfitFlywheelError("profit_flywheel_resume_condition_unsatisfied", "No invokable company agent exists for this Paperclip stage");
      }
      const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
      assertTransition(contract, stageRun.stage as ProfitFlywheelStage, "blocked", "pending");
      const updated = await tx.update(profitFlywheelStageRuns).set({
        state: "pending",
        retryAt: null,
        blockerCode: null,
        blockerDetail: null,
        nextOwner: null,
        resumeCondition: null,
        dispatchClaimId: null,
        dispatchClaimedAt: null,
        feedback: {
          ...asRecord(stageRun.feedback),
          resumed_by: { actor_type: input.principal.type, actor_id: input.principal.id },
          resumed_at: now.toISOString(),
          resumed_blocker_code: input.expectedBlockerCode,
        },
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stageRun.id),
        eq(profitFlywheelStageRuns.state, "blocked"),
        eq(profitFlywheelStageRuns.blockerCode, input.expectedBlockerCode),
        eq(profitFlywheelStageRuns.inputHash, input.inputHash),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) throw new ProfitFlywheelError("profit_flywheel_resume_cas_mismatch", "Paperclip stage resume lost its blocker/input CAS");
      await tx.update(profitFlywheelWorkflows).set({
        state: "running",
        currentStage: updated.stage,
        blockerCode: null,
        blockerDetail: null,
        nextOwner: null,
        resumeCondition: null,
        completedAt: null,
        updatedAt: now,
      }).where(and(eq(profitFlywheelWorkflows.id, workflow.id), eq(profitFlywheelWorkflows.companyId, input.companyId)));
      if (updated.linkedIssueId) {
        await tx.update(issues).set({ status: "todo", updatedAt: now }).where(and(
          eq(issues.id, updated.linkedIssueId),
          eq(issues.companyId, input.companyId),
        ));
      }
      await appendEvent(tx, {
        workflow,
        stageRunId: updated.id,
        eventType: "stage_resumed",
        dedupeKey: `paperclip-stage-resumed:${updated.id}:${input.expectedBlockerCode}:${updated.updatedAt.toISOString()}`,
        fromState: "blocked",
        toState: "pending",
        spanId: updated.spanId,
        payload: {
          stage: updated.stage,
          input_hash: updated.inputHash,
          expected_blocker_code: input.expectedBlockerCode,
          resumed_by: { actor_type: input.principal.type, actor_id: input.principal.id },
        },
        processedAt: now,
      });
      return { status: "resumed" as const, stageRunId: updated.id, workflowId: workflow.id };
    });
    await dispatchPendingStages({ workflowId: result.workflowId, limit: 20 });
    return result;
  }

  async function listWorkflows(companyId: string, input: { state?: string; limit?: number; correlationId?: string; linkedIssueId?: string } = {}) {
    if (input.linkedIssueId) {
      const stages = await db.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.companyId, companyId),
        eq(profitFlywheelStageRuns.linkedIssueId, input.linkedIssueId),
      ));
      if (stages.length === 0) return [];
      return db.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.companyId, companyId),
        inArray(profitFlywheelWorkflows.id, [...new Set(stages.map((stage) => stage.workflowId))]),
      )).orderBy(asc(profitFlywheelWorkflows.createdAt)).limit(input.limit ?? 100);
    }
    const conditions = [eq(profitFlywheelWorkflows.companyId, companyId)];
    if (input.state) conditions.push(eq(profitFlywheelWorkflows.state, input.state));
    if (input.correlationId) conditions.push(eq(profitFlywheelWorkflows.correlationId, input.correlationId));
    return db.select().from(profitFlywheelWorkflows).where(and(...conditions))
      .orderBy(asc(profitFlywheelWorkflows.createdAt)).limit(input.limit ?? 100);
  }

  async function getStageRun(stageRunId: string) {
    const stageRun = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, stageRunId))
      .then((rows) => rows[0] ?? null);
    if (!stageRun) return null;
    const workflow = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, stageRun.workflowId))
      .then((rows) => rows[0] ?? null);
    return workflow ? { stageRun, workflow } : null;
  }

  async function buildOpsReceipt(companyId: string, input: { since?: Date; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const since = input.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const workflows = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.companyId, companyId));
    const workflowIds = workflows.map((workflow) => workflow.id);
    const stages = workflowIds.length > 0
      ? await db.select().from(profitFlywheelStageRuns).where(inArray(profitFlywheelStageRuns.workflowId, workflowIds))
      : [];
    const receipts = workflowIds.length > 0
      ? await db.select().from(profitFlywheelReceipts).where(inArray(profitFlywheelReceipts.workflowId, workflowIds))
      : [];
    const events = workflowIds.length > 0
      ? await db.select().from(profitFlywheelEvents).where(inArray(profitFlywheelEvents.workflowId, workflowIds))
      : [];
    const recent = stages.filter((stage) => stage.updatedAt >= since);
    const completed = recent.filter((stage) => stage.state === "succeeded" && stage.startedAt && stage.completedAt);
    const latencySeconds = completed.map((stage) => (stage.completedAt!.getTime() - stage.startedAt!.getTime()) / 1000);
    const blocked = recent.filter((stage) => stage.state === "blocked");
    const measured = <T>(value: T, sampleSize: number) => ({ status: "measured" as const, value, sample_size: sampleSize });
    const insufficient = (reason: string, sampleSize = 0) => ({ status: "insufficient_data" as const, value: null, sample_size: sampleSize, reason });
    const ratio = (numerator: number, denominator: number, reason: string) => denominator > 0
      ? measured(numerator / denominator, denominator)
      : insufficient(reason);
    const targetedRatio = (numerator: number, denominator: number, reason: string, target: number, operator: ">=" | "<=") => {
      if (denominator <= 0) return { ...insufficient(reason), target: { operator, value: target }, passes_target: null };
      const value = numerator / denominator;
      return {
        ...measured(value, denominator),
        target: { operator, value: target },
        passes_target: operator === ">=" ? value >= target : value <= target,
      };
    };
    const terminalStates = new Set<CanonicalRunState>(["blocked", "succeeded", "failed", "cancelled", "safely_skipped"]);
    const actionableStages = new Set<ProfitFlywheelStage>(["implementation", "qa", "release"]);
    const decisionStages = new Set<ProfitFlywheelStage>(["commercial_validation", "council_decision", "dispatch"]);
    const receiptsByStage = receipts.reduce<Map<string, typeof receipts>>((index, row) => {
      const current = index.get(row.stageRunId) ?? [];
      current.push(row);
      index.set(row.stageRunId, current);
      return index;
    }, new Map());
    const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const verifiedWindowReceipts: typeof receipts = [];
    for (const row of receipts) {
      if (row.status !== "valid" || row.observedAt < since || row.observedAt > now || (row.expiresAt && row.expiresAt <= now)) continue;
      try {
        canonicalDbReceiptProof(row, now);
        if (row.artifactRef) {
          const stage = stageById.get(row.stageRunId);
          const workflow = stage ? workflowById.get(stage.workflowId) : null;
          if (!workflow) continue;
          const artifactHash = String(asRecord(row.attributes).artifact_hash ?? "").replace(/^sha256:/, "").toLowerCase();
          assertSha256(artifactHash, `${row.receiptType}.artifact_hash`);
          const roots = workflowArtifactRoots(workflow);
          await verifyArtifactReference(row.artifactRef, artifactHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
        }
        verifiedWindowReceipts.push(row);
      } catch {
        // Operations metrics never count stale, deleted, mutable, expired, or
        // hash-invalid evidence as a current observation.
      }
    }
    const dispatchStages = recent.filter((stage) => stage.stage === "dispatch");
    const implementationStages = recent.filter((stage) => stage.stage === "implementation" && isTerminalState(stage.state));
    const actionableCompleted = completed.filter((stage) => actionableStages.has(stage.stage as ProfitFlywheelStage));
    const providerDeliverables = actionableCompleted.filter((stage) => stage.providerRouteId).reduce<Record<string, number>>((acc, stage) => {
      const key = stage.providerRouteId!;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const providerUsage = receipts.filter((row) => row.receiptType === "provider_run_receipt" && row.status === "valid").map((row) => {
      const attributes = asRecord(row.attributes);
      const usage = asRecord(attributes.usage);
      const inputTokens = Number(usage.input_tokens ?? attributes.input_tokens);
      const outputTokens = Number(usage.output_tokens ?? attributes.output_tokens);
      const explicitTotal = Number(usage.total_tokens ?? attributes.total_tokens);
      const tokens = Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : explicitTotal;
      const cost = Number(usage.cost_usd ?? attributes.cost_usd);
      return {
        stageRunId: row.stageRunId,
        tokens: Number.isFinite(tokens) ? tokens : null,
        cost: Number.isFinite(cost) ? cost : null,
      };
    });
    const providerUsageByStage = new Map(providerUsage.map((entry) => [entry.stageRunId, entry]));
    const currentDeliverableUsage = actionableCompleted.map((stage) => providerUsageByStage.get(stage.id) ?? null);
    const tokenCompleteUsage = currentDeliverableUsage.filter((entry): entry is { stageRunId: string; tokens: number; cost: number | null } => entry?.tokens !== null && entry?.tokens !== undefined);
    const costCompleteUsage = currentDeliverableUsage.filter((entry): entry is { stageRunId: string; tokens: number | null; cost: number } => entry?.cost !== null && entry?.cost !== undefined);
    const tokenPerDeliverable = actionableCompleted.length > 0 && tokenCompleteUsage.length === actionableCompleted.length
      ? measured(tokenCompleteUsage.reduce((sum, entry) => sum + entry.tokens, 0) / actionableCompleted.length, actionableCompleted.length)
      : insufficient("every completed actionable deliverable requires normalized input_tokens + output_tokens", tokenCompleteUsage.length);
    const costPerDeliverable = actionableCompleted.length > 0 && costCompleteUsage.length === actionableCompleted.length
      ? measured(costCompleteUsage.reduce((sum, entry) => sum + entry.cost, 0) / actionableCompleted.length, actionableCompleted.length)
      : insufficient("every completed actionable deliverable requires normalized cost_usd", costCompleteUsage.length);
    const commercialDeltas = verifiedWindowReceipts.filter((row) => row.receiptType === "commercial_observation_receipt").map((row) => {
      const attributes = asRecord(row.attributes);
      const baseline = Number(attributes.baseline);
      const observed = Number(attributes.observed_value);
      return Number.isFinite(baseline) && Number.isFinite(observed) ? observed - baseline : null;
    }).filter((value): value is number => value !== null);
    const terminalDecisions = recent.filter((stage) =>
      decisionStages.has(stage.stage as ProfitFlywheelStage) && terminalStates.has(stage.state as CanonicalRunState));
    const valuableOrSafelySkipped = terminalDecisions.filter((stage) => {
      const feedback = asRecord(stage.feedback);
      return stage.state === "safely_skipped" || feedback.valuable_or_safe === true || feedback.valuable === true;
    });
    const actionableTerminal = recent.filter((stage) =>
      actionableStages.has(stage.stage as ProfitFlywheelStage) && terminalStates.has(stage.state as CanonicalRunState));
    const artifactBackedFlags = await Promise.all(actionableTerminal.map(async (stage) => {
      if (stage.state !== "succeeded" || !Array.isArray(stage.requiredReceipts) || stage.requiredReceipts.length === 0) return false;
      const workflow = workflowById.get(stage.workflowId);
      if (!workflow) return false;
      const stageReceipts = receiptsByStage.get(stage.id) ?? [];
      const roots = workflowArtifactRoots(workflow);
      for (const receiptType of stage.requiredReceipts) {
        const candidates = stageReceipts.filter((row) => row.receiptType === receiptType && row.status === "valid" &&
          (!row.expiresAt || row.expiresAt > now) && row.observedAt <= now && typeof row.artifactRef === "string" && row.artifactRef.length > 0);
        let verified = false;
        for (const row of candidates) {
          try {
            canonicalDbReceiptProof(row, now);
            const artifactHash = String(asRecord(row.attributes).artifact_hash ?? "").replace(/^sha256:/, "").toLowerCase();
            assertSha256(artifactHash, `${receiptType}.artifact_hash`);
            await verifyArtifactReference(row.artifactRef!, artifactHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
            verified = true;
            break;
          } catch {
            // A stale, deleted, mutable, or hash-invalid candidate is not
            // artifact-backed evidence. Another same-type receipt may still be.
          }
        }
        if (!verified) return false;
      }
      return true;
    }));
    const artifactBacked = actionableTerminal.filter((_stage, index) => artifactBackedFlags[index]);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const currentWindowStart = new Date(now.getTime() - sevenDaysMs);
    const priorWindowStart = new Date(now.getTime() - 2 * sevenDaysMs);
    const deliverableUsageWindow = (from: Date, to: Date, inclusiveTo: boolean) => {
      const deliverables = stages.filter((stage) => actionableStages.has(stage.stage as ProfitFlywheelStage) && stage.state === "succeeded" &&
        stage.completedAt && stage.completedAt >= from && (inclusiveTo ? stage.completedAt <= to : stage.completedAt < to));
      const sample = deliverables
        .map((stage) => providerUsageByStage.get(stage.id) ?? null)
        .filter((entry): entry is { stageRunId: string; tokens: number; cost: number | null } => entry?.tokens !== null && entry?.tokens !== undefined);
      const tokens = sample.reduce((sum, entry) => sum + entry.tokens, 0);
      const coverage = deliverables.length > 0 ? sample.length / deliverables.length : null;
      return {
        deliverables: deliverables.length,
        token_covered_deliverables: sample.length,
        token_coverage: coverage,
        tokens,
        tokensPerDeliverable: deliverables.length > 0 && sample.length === deliverables.length ? tokens / deliverables.length : null,
      };
    };
    const currentSevenDay = deliverableUsageWindow(currentWindowStart, now, true);
    const priorSevenDay = deliverableUsageWindow(priorWindowStart, currentWindowStart, false);
    const sevenDayTokenReduction = currentSevenDay.tokensPerDeliverable !== null && priorSevenDay.tokensPerDeliverable !== null && priorSevenDay.tokensPerDeliverable > 0
      ? (priorSevenDay.tokensPerDeliverable - currentSevenDay.tokensPerDeliverable) / priorSevenDay.tokensPerDeliverable
      : null;
    const windowEvents = events.filter((event) => event.createdAt >= since && event.createdAt <= now);
    const startedByStage = events.filter((event) => event.eventType === "stage_started" && event.stageRunId && event.createdAt <= now)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .reduce<Map<string, typeof events>>((index, event) => {
        const current = index.get(event.stageRunId!) ?? [];
        current.push(event);
        index.set(event.stageRunId!, current);
        return index;
      }, new Map());
    let fallbackCount = 0;
    for (const history of startedByStage.values()) {
      for (let index = 1; index < history.length; index += 1) {
        const current = history[index]!;
        if (current.createdAt < since) continue;
        const priorPayload = asRecord(history[index - 1]!.payload);
        const currentPayload = asRecord(current.payload);
        if ((currentPayload.provider_route_id && currentPayload.provider_route_id !== priorPayload.provider_route_id) ||
            (currentPayload.provider_family && currentPayload.provider_family !== priorPayload.provider_family)) fallbackCount += 1;
      }
    }
    const executionAttempts = windowEvents.filter((event) => {
      if (event.eventType !== "stage_started" || !event.stageRunId) return false;
      const stage = stages.find((candidate) => candidate.id === event.stageRunId);
      return Boolean(stage && actionableStages.has(stage.stage as ProfitFlywheelStage));
    });
    const adjudicationReceipts = receipts.filter((row) => row.receiptType === "execution_adjudication_receipt" && row.status === "valid" &&
      row.observedAt >= since && row.observedAt <= now && (!row.expiresAt || row.expiresAt > now));
    const adjudicationPairs: Array<[string, Record<string, unknown>]> = [];
    for (const row of adjudicationReceipts) {
      try {
        canonicalDbReceiptProof(row, now);
        const stage = stages.find((candidate) => candidate.id === row.stageRunId);
        const workflow = stage ? workflowById.get(stage.workflowId) : null;
        const attributes = asRecord(row.attributes);
        if (!workflow || !row.artifactRef) continue;
        await verifyArtifactReference(
          row.artifactRef,
          requireShaField(attributes, "artifact_hash", "execution_adjudication_receipt"),
          workflowArtifactRoots(workflow).allowedArtifactRoots,
          workflowArtifactRoots(workflow).targetRepoRoot,
        );
        adjudicationPairs.push([`${row.stageRunId}:${String(attributes.attempt ?? "")}`, attributes]);
      } catch {
        // Deleted, mutable, expired, or hash-invalid adjudication evidence does
        // not contribute to coverage or manufacture a zero false-success rate.
      }
    }
    const adjudicationByAttempt = new Map(adjudicationPairs);
    const adjudicatedAttempts = executionAttempts.map((event) => {
      const attempt = Number(asRecord(event.payload).attempt);
      return adjudicationByAttempt.get(`${event.stageRunId}:${attempt}`) ?? null;
    });
    const completeAdjudicationCoverage = executionAttempts.length > 0 && adjudicatedAttempts.every(Boolean);
    const falseSuccessCount = completeAdjudicationCoverage
      ? adjudicatedAttempts.filter((attributes) => attributes?.false_success === true && attributes.final_response_complete === false && attributes.process_exit_code === 0).length
      : null;
    const researchTerminal = recent.filter((stage) => stage.stage === "research_intake" && terminalStates.has(stage.state as CanonicalRunState));
    const researchFailures = researchTerminal.filter((stage) => stage.state === "failed" || stage.state === "blocked");
    const receipt = {
      schema_version: "paperclip.profit_flywheel_ops_receipt.v2",
      company_id: companyId,
      window: { from: since.toISOString(), to: now.toISOString() },
      metrics: {
        stage_throughput: completed.length,
        stage_latency_seconds: {
          average: latencySeconds.length > 0 ? latencySeconds.reduce((sum, value) => sum + value, 0) / latencySeconds.length : null,
          maximum: latencySeconds.length > 0 ? Math.max(...latencySeconds) : null,
          status: latencySeconds.length > 0 ? "measured" : "insufficient_data",
          sample_size: latencySeconds.length,
        },
        blocked_duration_seconds: blocked.reduce((sum, stage) => sum + Math.max(0, (now.getTime() - stage.updatedAt.getTime()) / 1000), 0),
        retry_count: recent.reduce((sum, stage) => sum + Math.max(0, stage.attemptCount - 1), 0),
        fallback_count: fallbackCount,
        evidence_freshness_seconds: verifiedWindowReceipts.length > 0
          ? verifiedWindowReceipts.reduce((sum, receiptRow) => sum + Math.max(0, (now.getTime() - receiptRow.observedAt.getTime()) / 1000), 0) / verifiedWindowReceipts.length
          : null,
        completed_workflows: workflows.filter((workflow) => workflow.state === "succeeded" && workflow.updatedAt >= since).length,
        failed_workflows: workflows.filter((workflow) => workflow.state === "failed" && workflow.updatedAt >= since).length,
        dispatch_ready_percentage: ratio(dispatchStages.filter((stage) => stage.state === "succeeded").length, dispatchStages.length, "no dispatch stages in window"),
        actionable_completion_percentage: ratio(implementationStages.filter((stage) => stage.state === "succeeded").length, implementationStages.length, "no terminal implementation stages in window"),
        deliverables_per_provider: Object.keys(providerDeliverables).length > 0 ? measured(providerDeliverables, actionableCompleted.length) : insufficient("no provider-attributed completed actionable deliverables"),
        tokens_per_completed_deliverable: tokenPerDeliverable,
        cost_per_completed_deliverable_usd: costPerDeliverable,
        tokens_and_cost_per_deliverable: tokenPerDeliverable.status === "measured" && costPerDeliverable.status === "measured"
          ? measured({ tokens: tokenPerDeliverable.value, cost_usd: costPerDeliverable.value }, actionableCompleted.length)
          : {
              ...insufficient("normalized token and cost coverage must both be 100% for completed actionable deliverables", actionableCompleted.length),
              token_coverage: actionableCompleted.length > 0 ? tokenCompleteUsage.length / actionableCompleted.length : null,
              cost_coverage: actionableCompleted.length > 0 ? costCompleteUsage.length / actionableCompleted.length : null,
            },
        false_success_count: falseSuccessCount !== null
          ? measured(falseSuccessCount, executionAttempts.length)
          : insufficient("every actionable stage attempt requires a canonical server-observed execution_adjudication_receipt; zero is not assumed", adjudicatedAttempts.filter(Boolean).length),
        false_success_percentage: falseSuccessCount !== null
          ? measured(falseSuccessCount / executionAttempts.length, executionAttempts.length)
          : insufficient("execution adjudication receipt coverage is incomplete", adjudicatedAttempts.filter(Boolean).length),
        source_failures: researchTerminal.length > 0 ? measured(
          {
            count: researchFailures.length,
            by_code: researchFailures.reduce<Record<string, number>>((acc, stage) => {
            const key = stage.blockerCode ?? "unknown";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
            }, {}),
          },
          researchTerminal.length,
        ) : insufficient("no terminal research_intake source attempts in window"),
        research_source_failure_rate: targetedRatio(
          researchFailures.length,
          researchTerminal.length,
          "no terminal research_intake source attempts in window",
          0.1,
          "<=",
        ),
        commercial_returns: commercialDeltas.length > 0 ? measured({
          aggregate_delta: commercialDeltas.reduce((sum, value) => sum + value, 0),
          average_delta: commercialDeltas.reduce((sum, value) => sum + value, 0) / commercialDeltas.length,
        }, commercialDeltas.length) : insufficient("no measured commercial observation receipts"),
        seven_day_work_bearing_token_reduction: sevenDayTokenReduction !== null
          ? {
              ...measured(sevenDayTokenReduction, currentSevenDay.deliverables + priorSevenDay.deliverables),
              target: { operator: ">=" as const, value: 0.5 },
              passes_target: sevenDayTokenReduction >= 0.5,
              current_window: currentSevenDay,
              prior_window: priorSevenDay,
            }
          : {
              ...insufficient("both current and prior seven-day windows require token-accounted completed actionable deliverables", currentSevenDay.deliverables + priorSevenDay.deliverables),
              target: { operator: ">=" as const, value: 0.5 },
              passes_target: null,
              current_window: currentSevenDay,
              prior_window: priorSevenDay,
            },
        valuable_safe_skip_percentage: targetedRatio(
          valuableOrSafelySkipped.length,
          terminalDecisions.length,
          "no terminal commercial-validation, council, or dispatch decisions in window",
          0.9,
          ">=",
        ),
        artifact_backed_percentage: targetedRatio(
          artifactBacked.length,
          actionableTerminal.length,
          "no terminal implementation, QA, or release stages in window",
          0.9,
          ">=",
        ),
      },
      blockers: blocked.map((stage) => ({
        stage_run_id: stage.id,
        stage: stage.stage,
        blocker_code: stage.blockerCode,
        blocker_detail: stage.blockerDetail,
        next_owner: stage.nextOwner,
        resume_condition: stage.resumeCondition,
      })),
      generated_at: now.toISOString(),
    };
    return { ...receipt, sha256: hashProfitFlywheelValue(receipt) };
  }

  return {
    startFromDispatch,
    processPendingEvents,
    dispatchPendingStages,
    releaseDispatchClaimAfterHeartbeatSetupFailure,
    recoverProviderBlockedStages,
    buildExecutionManifest,
    recordReceipt,
    recordExecutionAdjudication,
    persistArtifactCheckpoint,
    claimStage,
    heartbeatStage,
    completeStage,
    blockStage,
    failStage,
    reworkQaFailure,
    recoverOrphans,
    syncContextLedgerCompletion,
    reconcilePendingContextLedgerSync,
    listPortfolioOsOutbox,
    claimPortfolioOsOutbox,
    blockPortfolioOsOutboxInfrastructure,
    acknowledgePortfolioOsOutbox,
    resumePortfolioOsOutbox,
    resumePaperclipStage,
    listWorkflows,
    getStageRun,
    getWorkflow: loadWorkflowApiDetail,
    buildOpsReceipt,
  };
}
