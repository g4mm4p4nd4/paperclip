import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { writeImmutableJsonReceipt, writeImmutableReceiptBytes } from "../ops/immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  readTrustedJsonFile,
  requireTrustedDirectory,
} from "../ops/trusted-receipt-directory.js";
import { verifyProviderPolicyAuthority } from "./provider-policy-authority.js";

const gzip = promisify(gzipCallback);
const execFile = promisify(execFileCallback);
const SHA256_RE = /^[0-9a-f]{64}$/;
const INLINE_STREAM_BYTES = 16 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const LAUNCHER_ENV_NAMES = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "NO_COLOR", "GIT_TERMINAL_PROMPT",
  "PAPERCLIP_API_URL",
] as const;
const PINNED_ENVELOPE_SCHEMA_SHA256 = "6574b139a90815e386ac0195373090c8e59afb1cd90730c87980711d33490c08";
const PINNED_CRASH_JOURNAL_SCHEMA_SHA256 = "16a6dfcdabff47a436d37de582e82f647016d560e78ebf57c2cbf4db80a0a027";
const ENVELOPE_SCHEMA_PATH = fileURLToPath(new URL(
  "../../../contracts/profit-flywheel/pos.paperclip_consumer_envelope.v1.schema.json",
  import.meta.url,
));
const CRASH_JOURNAL_SCHEMA_PATH = fileURLToPath(new URL(
  "../../../contracts/profit-flywheel/pos.paperclip_consumer_crash_journal.v1.schema.json",
  import.meta.url,
));
const envelopeSchemaBytes = readFileSync(ENVELOPE_SCHEMA_PATH);
if (createHash("sha256").update(envelopeSchemaBytes).digest("hex") !== PINNED_ENVELOPE_SCHEMA_SHA256) {
  throw new Error("pos_consumer_envelope_schema_pin_mismatch");
}
const crashJournalSchemaBytes = readFileSync(CRASH_JOURNAL_SCHEMA_PATH);
if (createHash("sha256").update(crashJournalSchemaBytes).digest("hex") !== PINNED_CRASH_JOURNAL_SCHEMA_SHA256) {
  throw new Error("pos_consumer_crash_journal_schema_pin_mismatch");
}
const ExactEnvelopeAjvConstructor = (Ajv2020 as any).default ?? Ajv2020;
const exactEnvelopeAjv = new ExactEnvelopeAjvConstructor({ allErrors: true, strict: false });
const applyExactEnvelopeFormats = (addFormats as any).default ?? addFormats;
applyExactEnvelopeFormats(exactEnvelopeAjv);
const validateExactEnvelope = exactEnvelopeAjv.compile(JSON.parse(envelopeSchemaBytes.toString("utf8")));
const exactCrashJournalAjv = new ExactEnvelopeAjvConstructor({ allErrors: true, strict: false });
applyExactEnvelopeFormats(exactCrashJournalAjv);
const validateExactCrashJournal = exactCrashJournalAjv.compile(JSON.parse(crashJournalSchemaBytes.toString("utf8")));

const SECRET_PATTERNS = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+\-/=]{6,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie|session)\s*[:=]\s*[^\s,;]{4,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export type PosConsumerPlane = "research" | "stage" | "return";
export type PosConsumerClassificationCode =
  | "succeeded"
  | "pos_consumer_launch_failed"
  | "pos_consumer_timeout"
  | "pos_consumer_protocol_invalid"
  | "pos_consumer_ack_failed"
  | "pos_consumer_source_blocked"
  | "pos_consumer_source_failed"
  | "pos_consumer_credential_unavailable"
  | "pos_consumer_runtime_provenance_mismatch";

const artifactBindingSchema = z.object({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(SHA256_RE),
}).strict();

const fileBindingSchema = artifactBindingSchema;
const runtimeManifestSchema = z.object({
  schema_version: z.literal("paperclip.factory_runtime_manifest.v2"),
  runtime_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/),
  runtime_kind: z.literal("portfolio_os"),
  source: z.object({
    repository: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    tree_sha256: z.string().regex(SHA256_RE),
    clean: z.literal(true),
  }).strict(),
  executable: fileBindingSchema,
  interpreter: z.object({
    path: z.string().startsWith("/"),
    version: z.string().min(1),
    identity_sha256: z.string().regex(SHA256_RE),
  }).strict(),
  dependency_lock: fileBindingSchema,
  contracts: z.array(fileBindingSchema).min(1).max(256),
  provider_policy_authority: artifactBindingSchema,
  source_registry: fileBindingSchema,
  writable_roots: z.array(z.string().startsWith("/")).min(1).max(32),
  built_at: z.string().datetime({ offset: true }),
}).strict();

const acknowledgementSchema = z.object({
  event_id: z.string().min(1),
  stage_run_id: z.string().min(1),
  state: z.enum(["succeeded", "blocked", "degraded", "failed", "superseded"]),
  prepared_ack: artifactBindingSchema,
  ack_response: artifactBindingSchema.nullable(),
}).strict();

const consumerRuntimeBindingSchema = z.object({
  mode: z.enum(["managed", "development"]),
  verified: z.boolean(),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  manifest: artifactBindingSchema.nullable(),
  provider_policy_authority: artifactBindingSchema.nullable(),
}).strict();

function authorityRequiredForEnvelope(value: {
  protocol_state: "succeeded" | "blocked" | "degraded" | "failed" | "superseded" | "launcher_precondition_failed";
  runtime: z.infer<typeof consumerRuntimeBindingSchema>;
}) {
  return (value.runtime.mode === "managed" && value.runtime.verified) ||
    ["succeeded", "blocked", "degraded", "failed", "superseded"].includes(value.protocol_state);
}

const posConsumerEnvelopeZodSchema = z.object({
  schema_version: z.literal("pos.paperclip_consumer_envelope.v1"),
  plane: z.enum(["research", "stage", "return"]),
  protocol_state: z.enum([
    "succeeded", "blocked", "degraded", "failed", "superseded", "launcher_precondition_failed",
  ]),
  company_id: z.string().min(1),
  observed_at: z.string().datetime({ offset: true }),
  runtime: consumerRuntimeBindingSchema,
  summary: z.object({
    result_schema_version: z.string().min(1).nullable(),
    fetched_count: z.number().int().nonnegative(),
    processed_count: z.number().int().nonnegative(),
    blocked_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    superseded_count: z.number().int().nonnegative(),
  }).strict(),
  acknowledgements: z.array(acknowledgementSchema).max(100),
  diagnostics: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/),
    detail: z.string().min(1).max(2000),
    next_owner: z.string().min(1),
    resume_condition: z.string().min(1).max(2000),
    crash_journal: artifactBindingSchema.nullable(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.protocol_state === "succeeded" && value.diagnostics !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diagnostics"], message: "success cannot carry diagnostics" });
  }
  if (["blocked", "degraded", "failed", "launcher_precondition_failed"].includes(value.protocol_state) && value.diagnostics === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diagnostics"], message: "failure state requires diagnostics" });
  }
  if (authorityRequiredForEnvelope(value) && value.runtime.provider_policy_authority === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime", "provider_policy_authority"], message: "authority-bound envelope requires provider policy authority" });
  }
  if (value.runtime.provider_policy_authority === null && value.runtime.mode !== "development" &&
      value.protocol_state !== "launcher_precondition_failed") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime", "provider_policy_authority"], message: "null authority is reserved for development or precondition envelopes" });
  }
});

const posConsumerCrashJournalZodSchema = z.object({
  schema_version: z.literal("pos.paperclip_consumer_crash_journal.v1"),
  plane: z.enum(["research", "stage", "return"]),
  company_id: z.string().min(1).max(200),
  observed_at: z.string().datetime({ offset: true }),
  runtime: consumerRuntimeBindingSchema,
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/),
    detail: z.string().min(1).max(2001),
    exception_type: z.string().min(1).max(512),
    traceback: z.string().min(1).max(16001),
  }).strict(),
  immutable: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.runtime.mode === "managed" && value.runtime.verified &&
      value.runtime.provider_policy_authority === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime", "provider_policy_authority"], message: "verified managed crash journal requires provider policy authority" });
  }
  if (value.runtime.provider_policy_authority === null && value.runtime.mode !== "development" &&
      value.runtime.verified !== false) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime", "provider_policy_authority"], message: "null crash authority requires development or unverified runtime" });
  }
});

export type PosConsumerEnvelope = z.infer<typeof posConsumerEnvelopeZodSchema>;
export const posConsumerEnvelopeSchema = {
  safeParse(value: unknown) {
    if (!validateExactEnvelope(value)) {
      return { success: false as const, error: validateExactEnvelope.errors };
    }
    return posConsumerEnvelopeZodSchema.safeParse(value);
  },
};
export type PosConsumerCrashJournal = z.infer<typeof posConsumerCrashJournalZodSchema>;
export const posConsumerCrashJournalSchema = {
  safeParse(value: unknown) {
    if (!validateExactCrashJournal(value)) {
      return { success: false as const, error: validateExactCrashJournal.errors };
    }
    return posConsumerCrashJournalZodSchema.safeParse(value);
  },
};
type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;
type ArtifactBinding = z.infer<typeof artifactBindingSchema>;

export interface PosConsumerSecretReference {
  name: string;
  version: string;
  fingerprint: string;
}

export interface PosConsumerEventBinding {
  eventId: string;
  workflowId: string;
  stageRunId: string;
  stage: string;
  inputHash: string;
  attempt: number;
  idempotencyKey: string;
  claimNonceSha256: string;
}

export interface PosConsumerClassification {
  code: PosConsumerClassificationCode;
  retryable: boolean;
  terminal: boolean;
  nextAttemptAt: string | null;
  nextOwner: string;
  resumeCondition: string;
}

interface ProcessObservation {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflowed: boolean;
  spawnError: string | null;
}

interface StreamCapture {
  bytes: number;
  sha256: string;
  raw: Buffer;
  redactedText: string;
  redactionCount: number;
}

export interface PosConsumerAttemptReceipt {
  schema_version: "paperclip.pos_consumer_attempt_receipt.v1";
  attempt_id: string;
  plane: PosConsumerPlane;
  company_id: string;
  event: {
    event_id: string;
    workflow_id: string;
    stage_run_id: string;
    stage: string;
    input_hash: string;
    attempt: number;
    idempotency_key: string;
    claim_nonce_sha256: string;
  };
  command: {
    executable: string;
    args: string[];
    cwd: string;
    allowlisted_environment_names: string[];
    secret_references: PosConsumerSecretReference[];
  };
  runtime: {
    manifest: ArtifactBinding;
    source_commit: string;
    source_tree_sha256: string;
    interpreter_identity_sha256: string;
    contract_sha256: string;
    provider_policy_sha256: string | null;
    provider_policy_authority: ArtifactBinding;
  };
  timing: { started_at: string; ended_at: string; duration_ms: number };
  process: {
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    stdout: { bytes: number; sha256: string; excerpt: string; artifact: ArtifactBinding | null };
    stderr: { bytes: number; sha256: string; excerpt: string; artifact: ArtifactBinding | null };
  };
  protocol: {
    state: PosConsumerEnvelope["protocol_state"] | "missing" | "invalid";
    envelope_sha256: string | null;
    result_schema_version: string | null;
    acknowledgement: ArtifactBinding | null;
    ack_response: ArtifactBinding | null;
  };
  classification: {
    code: PosConsumerClassificationCode;
    retryable: boolean;
    terminal: boolean;
    next_attempt_at: string | null;
    next_owner: string;
    resume_condition: string;
  };
  redaction: {
    version: "paperclip.redaction.v1";
    redacted: boolean;
    secret_value_count: number;
  };
  generated_at: string;
}

export interface PosConsumerAttemptResult {
  receipt: PosConsumerAttemptReceipt;
  receiptBinding: ArtifactBinding;
  envelope: PosConsumerEnvelope | null;
  classification: PosConsumerClassification;
  process: ProcessObservation;
}

interface VerifiedRuntime {
  manifest: RuntimeManifest;
  binding: ArtifactBinding;
  cwd: string;
  writableRoots: string[];
}

export interface RunPosConsumerAttemptInput {
  attemptId: string;
  plane: PosConsumerPlane;
  companyId: string;
  event: PosConsumerEventBinding;
  runtimeManifestPath: string;
  /**
   * Non-secret descriptor path selected from the verified managed runtime.
   * It is always passed as a child-process argument, never as environment.
   */
  providerPolicyAuthorityPath: string;
  /**
   * Writable root dedicated to durable POS consumer artifacts. Managed
   * runtimes pass the verified output root explicitly; single-root fixture
   * manifests may omit it and use their sole declared writable root.
   */
  artifactRoot?: string;
  receiptDirectory: string;
  contractSha256: string;
  providerPolicySha256: string | null;
  apiUrl: string;
  environment: Record<string, string>;
  secretReferences: PosConsumerSecretReference[];
  timeoutMs?: number;
  now?: () => Date;
  prelaunchFailure?: {
    code: "pos_consumer_credential_unavailable";
    detail: string;
    nextOwner: string;
    resumeCondition: string;
  };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, bytes: number) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= bytes ? value : `${buffer.subarray(0, bytes - 3).toString("utf8")}...`;
}

function journalSecretName(plane: PosConsumerPlane) {
  if (plane === "research") return "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY";
  if (plane === "stage") return "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY";
  return "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY";
}

function verifyAttemptSecretInputs(input: RunPosConsumerAttemptInput) {
  const expectedNames = input.prelaunchFailure
    ? []
    : ["PAPERCLIP_API_KEY", journalSecretName(input.plane)].sort();
  const environmentNames = Object.keys(input.environment).sort();
  if (environmentNames.length !== expectedNames.length ||
      environmentNames.some((name, index) => name !== expectedNames[index]) ||
      Object.values(input.environment).some((value) => typeof value !== "string" || value.length < 20)) {
    throw new Error("pos_consumer_secret_environment_invalid");
  }
  const references = [...input.secretReferences].sort((left, right) => left.name.localeCompare(right.name));
  if (references.length !== expectedNames.length || references.some((reference, index) =>
    reference.name !== expectedNames[index] || !reference.version.trim() ||
    !SHA256_RE.test(reference.fingerprint) ||
    reference.fingerprint !== sha256(input.environment[reference.name] ?? ""))) {
    throw new Error("pos_consumer_secret_references_invalid");
  }
}

export function redactPosConsumerText(value: string, knownSecrets: string[]) {
  let output = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  let count = 0;
  for (const secret of [...new Set(knownSecrets.filter((entry) => entry.length > 0))].sort((a, b) => b.length - a.length)) {
    if (!output.includes(secret)) continue;
    count += output.split(secret).length - 1;
    output = output.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      count += 1;
      return "[REDACTED]";
    });
  }
  return { value: output, count };
}

async function verifyFileBinding(
  binding: ArtifactBinding,
  label: string,
  repository: string,
  commit: string,
) {
  const resolved = path.resolve(binding.path);
  if (resolved !== binding.path || (resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`))) {
    throw new Error(`${label}_outside_runtime_repository`);
  }
  const artifact = await readTrustedFile(resolved, label, {
    maxBytes: 32 * 1024 * 1024,
    requireReadOnly: true,
    requireCurrentOwner: false,
  });
  if (artifact.sha256 !== binding.sha256) throw new Error(`${label}_sha256_mismatch`);
  const relative = path.relative(repository, resolved).split(path.sep).join("/");
  const committed = await execFile("git", ["show", `${commit}:${relative}`], {
    cwd: repository,
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  }).catch(() => {
    throw new Error(`${label}_source_commit_unavailable`);
  });
  const committedBytes = Buffer.isBuffer(committed.stdout)
    ? committed.stdout
    : Buffer.from(committed.stdout, "utf8");
  if (sha256(committedBytes) !== artifact.sha256) {
    throw new Error(`${label}_source_commit_mismatch`);
  }
  return artifact.path;
}

async function loadPortfolioOsRuntimeManifest(manifestPath: string): Promise<VerifiedRuntime> {
  const artifact = await readTrustedJsonFile(
    path.resolve(manifestPath),
    "pos_consumer_runtime_manifest",
    { maxBytes: 2 * 1024 * 1024 },
  );
  const parsed = runtimeManifestSchema.safeParse(artifact.value);
  if (!parsed.success) throw new Error("pos_consumer_runtime_manifest_invalid");
  const manifest = parsed.data;
  const repository = path.resolve(manifest.source.repository.replace(/^file:\/\/(?:localhost)?/, ""));
  if (repository !== manifest.source.repository && !manifest.source.repository.startsWith("file://")) {
    throw new Error("pos_consumer_runtime_repository_not_canonical");
  }
  return {
    manifest,
    binding: { path: artifact.path, sha256: artifact.sha256 },
    cwd: repository,
    writableRoots: [],
  };
}

export async function verifyPortfolioOsRuntimeManifest(input: {
  manifestPath: string;
  contractSha256: string;
  plane: PosConsumerPlane;
}): Promise<VerifiedRuntime> {
  const runtime = await loadPortfolioOsRuntimeManifest(input.manifestPath);
  const { manifest, cwd: repository } = runtime;
  const [head, status, tree] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd: repository, timeout: 15_000 }),
    execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repository, timeout: 15_000 }),
    execFile("git", ["ls-tree", "-r", "--full-tree", manifest.source.commit], { cwd: repository, timeout: 15_000 }),
  ]).catch(() => {
    throw new Error("pos_consumer_runtime_source_repository_unverifiable");
  });
  if (head.stdout.trim().toLowerCase() !== manifest.source.commit || status.stdout.trim() !== "" ||
      sha256(Buffer.from(tree.stdout, "utf8")) !== manifest.source.tree_sha256) {
    throw new Error("pos_consumer_runtime_source_provenance_mismatch");
  }
  const executable = await verifyFileBinding(
    manifest.executable,
    "pos_consumer_runtime_executable",
    repository,
    manifest.source.commit,
  );
  if (executable !== path.join(repository, "bin", "pos")) {
    throw new Error("pos_consumer_runtime_executable_not_bin_pos");
  }
  await verifyFileBinding(
    manifest.dependency_lock,
    "pos_consumer_runtime_dependency_lock",
    repository,
    manifest.source.commit,
  );
  await verifyFileBinding(
    manifest.source_registry,
    "pos_consumer_runtime_source_registry",
    repository,
    manifest.source.commit,
  );
  const contractPaths = await Promise.all(manifest.contracts.map((binding, index) =>
    verifyFileBinding(
      binding,
      `pos_consumer_runtime_contract_${index}`,
      repository,
      manifest.source.commit,
    )));
  if (new Set(contractPaths).size !== contractPaths.length) {
    throw new Error("pos_consumer_runtime_contract_duplicate");
  }
  const requiredContractNames = new Set([
    "paperclip.factory_runtime_manifest.v2.schema.json",
    "pos.paperclip_consumer_envelope.v1.schema.json",
    "pos.paperclip_consumer_crash_journal.v1.schema.json",
    "pos.paperclip_provider_policy_authority.v1.schema.json",
    "profit-flywheel.v2.json",
    "profit-flywheel.v2.schema.json",
    ...(input.plane === "research" ? [
      "pos.next_research_authorization.v1.schema.json",
      "pos.next_research_authorization.v2.schema.json",
      "paperclip.research_plan.v2.schema.json",
      "paperclip.research_plan.v3.schema.json",
      "paperclip.research_continuation.v1.schema.json",
    ] : []),
    ...(input.plane === "return" ? [
      "pos.learning_receipt.v2.schema.json",
      "pos.learning_receipt.v3.schema.json",
    ] : []),
  ]);
  const observedContractNames = new Set(contractPaths.map((value) => path.basename(value)));
  if ([...requiredContractNames].some((name) => !observedContractNames.has(name))) {
    throw new Error("pos_consumer_runtime_required_contract_missing");
  }
  if (!manifest.contracts.some((binding) => binding.sha256 === input.contractSha256)) {
    throw new Error("pos_consumer_runtime_contract_mismatch");
  }
  const interpreterPath = await realpath(manifest.interpreter.path).catch(() => "");
  if (!interpreterPath || !path.isAbsolute(manifest.interpreter.path)) {
    throw new Error("pos_consumer_runtime_interpreter_unavailable");
  }
  const interpreter = await execFile(interpreterPath, [
    "-c",
    "import json,pathlib,sys;print(json.dumps({'path':pathlib.Path(sys.executable).resolve(strict=True).as_posix(),'version':sys.version.split()[0]}))",
  ], { timeout: 15_000, maxBuffer: 64 * 1024 }).catch(() => {
    throw new Error("pos_consumer_runtime_interpreter_unverifiable");
  });
  let interpreterIdentity: { path?: unknown; version?: unknown } = {};
  try {
    interpreterIdentity = JSON.parse(interpreter.stdout.trim()) as { path?: unknown; version?: unknown };
  } catch {
    throw new Error("pos_consumer_runtime_interpreter_unverifiable");
  }
  if (interpreterIdentity.path !== interpreterPath || interpreterIdentity.version !== manifest.interpreter.version ||
      sha256(`${interpreterPath}\0${manifest.interpreter.version}\n`) !== manifest.interpreter.identity_sha256) {
    throw new Error("pos_consumer_runtime_interpreter_identity_mismatch");
  }
  const writableRoots = await Promise.all(manifest.writable_roots.map(async (value) => {
    const resolved = await realpath(value).catch(() => "");
    const metadata = resolved ? await lstat(value).catch(() => null) : null;
    if (!resolved || resolved !== value || !metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("pos_consumer_runtime_writable_root_invalid");
    }
    return requireTrustedDirectory(resolved, "pos_consumer_runtime_writable_root");
  }));
  if (new Set(writableRoots).size !== writableRoots.length) {
    throw new Error("pos_consumer_runtime_writable_root_duplicate");
  }
  return { ...runtime, writableRoots };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asciiJsonString(value: string) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function stableJournalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("pos_consumer_ack_canonical_json_invalid");
    return encoded;
  }
  if (typeof value === "string") return asciiJsonString(value);
  if (Array.isArray(value)) return `[${value.map(stableJournalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${asciiJsonString(key)}:${stableJournalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("pos_consumer_ack_canonical_json_invalid");
}

function verifyJournalAuthentication(
  record: Record<string, unknown>,
  journalKey: string,
  plane: PosConsumerPlane,
) {
  const body = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "authentication_tag"));
  const prefix = plane === "stage" ? "portfolio-os-stage-plane-v1\0" : "portfolio-os-return-plane-v2\0";
  const expected = createHmac("sha256", journalKey).update(prefix + stableJournalJson(body), "utf8").digest();
  const observedHex = typeof record.authentication_tag === "string" ? record.authentication_tag.toLowerCase() : "";
  if (!SHA256_RE.test(observedHex) || !timingSafeEqual(Buffer.from(observedHex, "hex"), expected)) {
    throw new Error("pos_consumer_ack_authentication_invalid");
  }
  return body;
}

async function readBoundAckArtifact(
  binding: ArtifactBinding,
  label: string,
  writableRoots: string[],
) {
  const resolved = path.resolve(binding.path);
  if (resolved !== binding.path || !writableRoots.some((root) =>
    resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`${label}_outside_runtime_writable_roots`);
  }
  const artifact = await readTrustedJsonFile(resolved, label, {
    maxBytes: 4 * 1024 * 1024,
    requireCurrentOwner: false,
  });
  if (artifact.sha256 !== binding.sha256) throw new Error(`${label}_sha256_mismatch`);
  return artifact.value;
}

function assertAckIdentity(
  value: Record<string, unknown>,
  event: PosConsumerEventBinding,
  companyId: string,
  label: string,
) {
  if (value.company_id !== companyId || value.event_id !== event.eventId ||
      value.workflow_id !== event.workflowId || value.stage_run_id !== event.stageRunId ||
      value.stage !== event.stage || value.input_hash !== event.inputHash || value.attempt !== event.attempt ||
      value.immutable !== true) {
    throw new Error(`${label}_identity_mismatch`);
  }
}

async function verifyEnvelopeAcknowledgements(input: {
  envelope: PosConsumerEnvelope;
  runtime: VerifiedRuntime;
  event: PosConsumerEventBinding;
  companyId: string;
  environment: Record<string, string>;
}) {
  const journalKey = input.environment[journalSecretName(input.envelope.plane)];
  if (!journalKey) throw new Error("pos_consumer_ack_journal_key_missing");
  const preparedSchema = input.envelope.plane === "return"
    ? "pos.paperclip_return_plane_prepared_ack.v2"
    : input.envelope.plane === "stage"
      ? "pos.paperclip_stage_plane_prepared_ack.v1"
      : "pos.paperclip_research_plane_prepared_ack.v1";
  const responseSchema = input.envelope.plane === "return"
    ? "pos.paperclip_return_plane_ack_response.v2"
    : input.envelope.plane === "stage"
      ? "pos.paperclip_stage_plane_ack_response.v1"
      : "pos.paperclip_research_plane_ack_response.v1";
  for (const acknowledgement of input.envelope.acknowledgements) {
    if (!acknowledgement.ack_response) throw new Error("pos_consumer_ack_response_missing");
    const [preparedRecord, responseRecord] = await Promise.all([
      readBoundAckArtifact(
        acknowledgement.prepared_ack,
        "pos_consumer_prepared_ack",
        input.runtime.writableRoots,
      ),
      readBoundAckArtifact(
        acknowledgement.ack_response,
        "pos_consumer_ack_response",
        input.runtime.writableRoots,
      ),
    ]);
    const prepared = verifyJournalAuthentication(preparedRecord, journalKey, input.envelope.plane);
    const response = verifyJournalAuthentication(responseRecord, journalKey, input.envelope.plane);
    assertAckIdentity(prepared, input.event, input.companyId, "pos_consumer_prepared_ack");
    assertAckIdentity(response, input.event, input.companyId, "pos_consumer_ack_response");
    const preparedAck = asRecord(prepared.ack);
    if (prepared.schema_version !== preparedSchema || response.schema_version !== responseSchema ||
        preparedAck.event_id !== input.event.eventId || preparedAck.workflow_id !== input.event.workflowId ||
        preparedAck.stage_run_id !== input.event.stageRunId || preparedAck.stage !== input.event.stage ||
        preparedAck.input_hash !== input.event.inputHash || preparedAck.attempt !== input.event.attempt ||
        preparedAck.state !== acknowledgement.state) {
      throw new Error("pos_consumer_prepared_ack_semantics_invalid");
    }
    const responsePrepared = asRecord(response.prepared_ack);
    if (responsePrepared.path !== acknowledgement.prepared_ack.path ||
        responsePrepared.sha256 !== acknowledgement.prepared_ack.sha256) {
      throw new Error("pos_consumer_ack_response_prepared_binding_mismatch");
    }
    const paperclipResponse = asRecord(response.paperclip_response);
    if (paperclipResponse.eventId !== input.event.eventId ||
        paperclipResponse.stageRunId !== input.event.stageRunId ||
        typeof paperclipResponse.status !== "string") {
      throw new Error("pos_consumer_ack_response_semantics_invalid");
    }
    if ((acknowledgement.state === "succeeded" || acknowledgement.state === "superseded") &&
        !["acknowledged", "already_acknowledged", "reconciled_torn_ack"].includes(paperclipResponse.status)) {
      throw new Error("pos_consumer_ack_response_not_durable");
    }
    if (acknowledgement.state === "succeeded" &&
        paperclipResponse.outputHash !== preparedAck.output_hash) {
      throw new Error("pos_consumer_ack_response_output_hash_mismatch");
    }
  }
}

function bindingsMatch(left: ArtifactBinding | null, right: ArtifactBinding | null) {
  return left?.path === right?.path && left?.sha256 === right?.sha256;
}

/**
 * A crash journal is diagnostic evidence, not merely a filename emitted by the
 * child. Its exact runtime binding must agree with the final managed envelope
 * and the manifest that Paperclip independently verified before spawn.
 */
async function verifyEnvelopeCrashJournal(input: {
  envelope: PosConsumerEnvelope;
  runtime: VerifiedRuntime;
  companyId: string;
}) {
  const binding = input.envelope.diagnostics?.crash_journal;
  if (!binding) return;
  const record = await readBoundAckArtifact(
    binding,
    "pos_consumer_crash_journal",
    input.runtime.writableRoots,
  );
  const parsed = posConsumerCrashJournalSchema.safeParse(record);
  if (!parsed.success || parsed.data.plane !== input.envelope.plane ||
      parsed.data.company_id !== input.companyId ||
      parsed.data.runtime.mode !== "managed" || parsed.data.runtime.verified !== true ||
      parsed.data.runtime.source_commit !== input.runtime.manifest.source.commit ||
      !bindingsMatch(parsed.data.runtime.manifest, input.runtime.binding) ||
      !bindingsMatch(parsed.data.runtime.provider_policy_authority, input.runtime.manifest.provider_policy_authority) ||
      !bindingsMatch(parsed.data.runtime.provider_policy_authority, input.envelope.runtime.provider_policy_authority)) {
    throw new Error("pos_consumer_crash_journal_runtime_binding_mismatch");
  }
}

function envelopeFromStdout(stdout: Buffer, input: {
  plane: PosConsumerPlane;
  companyId: string;
  runtime: VerifiedRuntime;
}) {
  const raw = stdout.toString("utf8").trim();
  if (!raw) return { envelope: null, state: "missing" as const, hash: null };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { envelope: null, state: "invalid" as const, hash: sha256(Buffer.from(raw, "utf8")) };
  }
  const parsed = posConsumerEnvelopeSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.plane !== input.plane || parsed.data.company_id !== input.companyId ||
      parsed.data.runtime.mode !== "managed" || parsed.data.runtime.verified !== true ||
      parsed.data.runtime.source_commit !== input.runtime.manifest.source.commit ||
      parsed.data.runtime.manifest?.path !== input.runtime.binding.path ||
      parsed.data.runtime.manifest?.sha256 !== input.runtime.binding.sha256 ||
      parsed.data.runtime.provider_policy_authority?.path !== input.runtime.manifest.provider_policy_authority.path ||
      parsed.data.runtime.provider_policy_authority?.sha256 !== input.runtime.manifest.provider_policy_authority.sha256) {
    return { envelope: null, state: "invalid" as const, hash: sha256(Buffer.from(raw, "utf8")) };
  }
  return { envelope: parsed.data, state: parsed.data.protocol_state, hash: sha256(Buffer.from(raw, "utf8")) };
}

export function classifyPosConsumerAttempt(input: {
  process: ProcessObservation;
  envelope: PosConsumerEnvelope | null;
  protocolState: PosConsumerAttemptReceipt["protocol"]["state"];
  eventId: string;
  stageRunId: string;
  now: Date;
  attempt: number;
  ackEvidenceVerified?: boolean;
}): PosConsumerClassification {
  const retry = (code: PosConsumerClassificationCode, owner: string, condition: string) => ({
    code, retryable: true, terminal: false,
    nextAttemptAt: new Date(input.now.getTime() + Math.min(3_600_000, 5_000 * 2 ** Math.min(input.attempt, 10))).toISOString(),
    nextOwner: owner, resumeCondition: condition,
  });
  if (input.process.timedOut) return retry("pos_consumer_timeout", "portfolio_os_runtime_owner", "Repair the timed out managed consumer and replay this exact event.");
  if (input.process.spawnError || input.process.signal) return retry("pos_consumer_launch_failed", "portfolio_os_runtime_owner", "Restore the verified managed executable and replay this exact event.");
  if (input.process.overflowed || input.protocolState === "missing" || input.protocolState === "invalid" || !input.envelope) {
    return retry("pos_consumer_protocol_invalid", "portfolio_os_consumer_owner", "Correct the final-envelope protocol and replay this exact event.");
  }
  const envelope = input.envelope;
  if (envelope.protocol_state === "launcher_precondition_failed") {
    if (envelope.diagnostics?.code === "pos_consumer_credential_unavailable") {
      return {
        code: "pos_consumer_credential_unavailable", retryable: false, terminal: true,
        nextAttemptAt: null,
        nextOwner: envelope.diagnostics.next_owner,
        resumeCondition: envelope.diagnostics.resume_condition,
      };
    }
    const runtimeMismatch = envelope.diagnostics?.code === "pos_consumer_runtime_provenance_mismatch" ||
      envelope.runtime.verified !== true;
    return {
      code: runtimeMismatch ? "pos_consumer_runtime_provenance_mismatch" : "pos_consumer_launch_failed",
      retryable: false,
      terminal: true,
      nextAttemptAt: null,
      nextOwner: envelope.diagnostics?.next_owner ?? "portfolio_os_runtime_owner",
      resumeCondition: envelope.diagnostics?.resume_condition ?? "Promote a verified runtime closure before replaying this event.",
    };
  }
  if (input.process.exitCode !== 0) {
    if (envelope.protocol_state === "failed") {
      if (envelope.acknowledgements.length > 0 && input.ackEvidenceVerified !== true) {
        return retry(
          "pos_consumer_ack_failed",
          "portfolio_os_consumer_owner",
          "Restore the exact immutable acknowledgement evidence before accepting the typed nonzero failure envelope.",
        );
      }
      return {
        code: "pos_consumer_source_failed", retryable: false, terminal: true, nextAttemptAt: null,
        nextOwner: envelope.diagnostics?.next_owner ?? "portfolio_os_consumer_owner",
        resumeCondition: envelope.diagnostics?.resume_condition ?? "Repair the typed POS consumer failure before resuming.",
      };
    }
    return retry(
      "pos_consumer_protocol_invalid",
      "portfolio_os_consumer_owner",
      "Correct the contradictory nonzero process exit and final envelope before replaying this event.",
    );
  }
  const acknowledgement = envelope.acknowledgements.find((value) =>
    value.event_id === input.eventId && value.stage_run_id === input.stageRunId);
  if (envelope.protocol_state === "failed" && !acknowledgement) {
    return {
      code: "pos_consumer_source_failed", retryable: false, terminal: true, nextAttemptAt: null,
      nextOwner: envelope.diagnostics?.next_owner ?? "portfolio_os_consumer_owner",
      resumeCondition: envelope.diagnostics?.resume_condition ?? "Repair the typed POS consumer failure before resuming.",
    };
  }
  if (!acknowledgement) {
    return retry("pos_consumer_ack_failed", "portfolio_os_consumer_owner", "Produce and submit an acknowledgement for this exact event and stage binding.");
  }
  if (envelope.acknowledgements.length !== 1) {
    return retry("pos_consumer_ack_failed", "portfolio_os_consumer_owner", "Run the limit-one consumer and return only this exact event acknowledgement.");
  }
  if (input.ackEvidenceVerified !== true) {
    return retry("pos_consumer_ack_failed", "portfolio_os_consumer_owner", "Restore the exact immutable prepared and response acknowledgement evidence before replaying this event.");
  }
  if (acknowledgement.state === "succeeded" || acknowledgement.state === "superseded") {
    return { code: "succeeded", retryable: false, terminal: true, nextAttemptAt: null, nextOwner: "paperclip_reconciler", resumeCondition: "No action required." };
  }
  if (acknowledgement.state === "blocked" || acknowledgement.state === "degraded") {
    return {
      code: "pos_consumer_source_blocked", retryable: false, terminal: true, nextAttemptAt: null,
      nextOwner: envelope.diagnostics?.next_owner ?? "portfolio_os_consumer_owner",
      resumeCondition: envelope.diagnostics?.resume_condition ?? "Resolve the acknowledgement blocker before resuming.",
    };
  }
  return {
    code: "pos_consumer_source_failed", retryable: false, terminal: true, nextAttemptAt: null,
    nextOwner: envelope.diagnostics?.next_owner ?? "portfolio_os_consumer_owner",
    resumeCondition: envelope.diagnostics?.resume_condition ?? "Repair the acknowledged source failure before resuming.",
  };
}

async function captureProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  knownSecrets: string[];
}): Promise<{ process: ProcessObservation; stdout: StreamCapture; stderr: StreamCapture }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflowed = false;
  let timedOut = false;
  let child: ReturnType<typeof spawn> | null = null;
  let spawnError: string | null = null;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  await new Promise<void>((resolve) => {
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      resolve();
      return;
    }
    const collect = (chunks: Buffer[], hash: ReturnType<typeof createHash>, chunk: Buffer, stream: "stdout" | "stderr") => {
      hash.update(chunk);
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      const total = stream === "stdout" ? stdoutBytes : stderrBytes;
      const already = chunks.reduce((sum, value) => sum + value.length, 0);
      if (already < MAX_CAPTURE_BYTES) chunks.push(chunk.subarray(0, MAX_CAPTURE_BYTES - already));
      if (total > MAX_CAPTURE_BYTES && !overflowed) {
        overflowed = true;
        child?.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, stdoutHash, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, stderrHash, chunk, "stderr"));
    child.once("error", (error) => { spawnError = error.message; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, input.timeoutMs);
    timeout.unref?.();
    child.once("close", (code, observedSignal) => {
      clearTimeout(timeout);
      exitCode = code;
      signal = observedSignal;
      resolve();
    });
  });
  const stdoutRaw = Buffer.concat(stdoutChunks);
  const stderrRaw = Buffer.concat(stderrChunks);
  const stdoutRedacted = redactPosConsumerText(stdoutRaw.toString("utf8"), input.knownSecrets);
  const stderrEvidence = spawnError && stderrRaw.length === 0 ? Buffer.from(spawnError, "utf8") : stderrRaw;
  const stderrRedacted = redactPosConsumerText(stderrEvidence.toString("utf8"), input.knownSecrets);
  return {
    process: { exitCode, signal, timedOut, overflowed, spawnError },
    stdout: {
      bytes: stdoutBytes, sha256: stdoutHash.digest("hex"), raw: stdoutRaw,
      redactedText: stdoutRedacted.value, redactionCount: stdoutRedacted.count,
    },
    stderr: {
      bytes: spawnError && stderrRaw.length === 0 ? stderrEvidence.length : stderrBytes,
      sha256: spawnError && stderrRaw.length === 0 ? sha256(stderrEvidence) : stderrHash.digest("hex"),
      raw: stderrEvidence,
      redactedText: stderrRedacted.value, redactionCount: stderrRedacted.count,
    },
  };
}

export async function runPosConsumerAttempt(input: RunPosConsumerAttemptInput): Promise<PosConsumerAttemptResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.attemptId) ||
      !SHA256_RE.test(input.contractSha256) ||
      (input.providerPolicySha256 !== null && !SHA256_RE.test(input.providerPolicySha256)) ||
      !SHA256_RE.test(input.event.inputHash) || !SHA256_RE.test(input.event.claimNonceSha256)) {
    throw new Error("pos_consumer_attempt_binding_invalid");
  }
  verifyAttemptSecretInputs(input);
  await mkdir(path.resolve(input.receiptDirectory), { recursive: true, mode: 0o700 });
  await chmod(path.resolve(input.receiptDirectory), 0o700);
  const receiptDirectory = await prepareTrustedReceiptDirectory(path.resolve(input.receiptDirectory), "pos_consumer_attempt_receipt_directory");
  const runtime = await loadPortfolioOsRuntimeManifest(input.runtimeManifestPath);
  const providerPolicyAuthorityPath = typeof input.providerPolicyAuthorityPath === "string"
    ? input.providerPolicyAuthorityPath
    : "";
  const command = input.plane === "research" ? "paperclip-research-plane"
    : input.plane === "stage" ? "paperclip-stage-plane" : "paperclip-return-plane";
  const env: Record<string, string> = {
    ...input.environment,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0",
    PAPERCLIP_API_URL: input.apiUrl,
  };
  const expectedLauncherNames = [...LAUNCHER_ENV_NAMES, ...Object.keys(input.environment)].sort();
  if (Object.keys(env).sort().some((name, index) => name !== expectedLauncherNames[index])) {
    throw new Error("pos_consumer_environment_not_allowlisted");
  }
  const knownSecrets = Object.values(input.environment);
  let runtimeError: string | null = null;
  let verifiedRuntime = runtime;
  try {
    verifiedRuntime = await verifyPortfolioOsRuntimeManifest({
      manifestPath: input.runtimeManifestPath,
      contractSha256: input.contractSha256,
      plane: input.plane,
    });
    if (!providerPolicyAuthorityPath) {
      throw new Error("pos_consumer_provider_policy_authority_missing");
    }
    if (providerPolicyAuthorityPath !== verifiedRuntime.manifest.provider_policy_authority.path) {
      throw new Error("pos_consumer_provider_policy_authority_mismatch");
    }
    await verifyProviderPolicyAuthority({
      authorityPath: providerPolicyAuthorityPath,
      expectedBinding: verifiedRuntime.manifest.provider_policy_authority,
    }).catch(() => {
      throw new Error("pos_consumer_provider_policy_authority_mismatch");
    });
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  }
  const declaredArtifactRoot = input.artifactRoot ??
    (verifiedRuntime.writableRoots.length === 1 ? verifiedRuntime.writableRoots[0] : null);
  let artifactRoot = declaredArtifactRoot ? path.resolve(declaredArtifactRoot) : "";
  if (runtimeError === null) {
    if (!declaredArtifactRoot || artifactRoot !== declaredArtifactRoot ||
        !verifiedRuntime.writableRoots.some((root) =>
          artifactRoot === root || artifactRoot.startsWith(`${root}${path.sep}`))) {
      runtimeError = "pos_consumer_artifact_root_invalid";
      artifactRoot = declaredArtifactRoot ?? "<unconfigured>";
    }
  } else if (!artifactRoot) {
    artifactRoot = declaredArtifactRoot ?? "<unconfigured>";
  }
  const args = [
    command,
    "--company-id", input.companyId,
    "--limit", "1",
    "--runtime-manifest", runtime.binding.path,
    "--provider-policy-authority", providerPolicyAuthorityPath || "<unconfigured>",
    "--artifact-root", artifactRoot,
  ];
  if (args.length > MAX_ARGS || args.some((value) => Buffer.byteLength(value, "utf8") > MAX_ARG_BYTES)) {
    throw new Error("pos_consumer_command_args_invalid");
  }
  const prelaunchFailure = input.prelaunchFailure;
  const captured = runtimeError === null && !prelaunchFailure
    ? await captureProcess({
      executable: runtime.manifest.executable.path,
      args,
      cwd: runtime.cwd,
      env,
      timeoutMs: Math.max(1_000, input.timeoutMs ?? 10 * 60_000),
      knownSecrets,
    })
    : (() => {
      const prelaunchDetail = runtimeError ?? prelaunchFailure?.detail ?? "Managed launch precondition failed.";
      const safe = redactPosConsumerText(prelaunchDetail, knownSecrets);
      const raw = Buffer.from(prelaunchDetail, "utf8");
      return {
        process: { exitCode: null, signal: null, timedOut: false, overflowed: false, spawnError: null },
        stdout: { bytes: 0, sha256: sha256(Buffer.alloc(0)), raw: Buffer.alloc(0), redactedText: "", redactionCount: 0 },
        stderr: { bytes: raw.length, sha256: sha256(raw), raw, redactedText: safe.value, redactionCount: safe.count },
      } satisfies { process: ProcessObservation; stdout: StreamCapture; stderr: StreamCapture };
    })();
  let protocol = runtimeError === null && !prelaunchFailure
    ? envelopeFromStdout(captured.stdout.raw, {
        plane: input.plane,
        companyId: input.companyId,
        runtime: verifiedRuntime,
      })
    : (() => {
      const envelope: PosConsumerEnvelope = {
        schema_version: "pos.paperclip_consumer_envelope.v1",
        plane: input.plane,
        protocol_state: "launcher_precondition_failed",
        company_id: input.companyId,
        observed_at: startedAt.toISOString(),
        runtime: {
          mode: "managed", verified: runtimeError === null, source_commit: runtime.manifest.source.commit,
          manifest: runtime.binding,
          provider_policy_authority: runtime.manifest.provider_policy_authority,
        },
        summary: {
          result_schema_version: null, fetched_count: 0, processed_count: 0,
          blocked_count: 0, failed_count: 1, superseded_count: 0,
        },
        acknowledgements: [],
        diagnostics: {
          code: prelaunchFailure?.code ?? "pos_consumer_runtime_provenance_mismatch",
          detail: boundedUtf8(captured.stderr.redactedText || "Managed runtime verification failed.", 2000),
          next_owner: prelaunchFailure?.nextOwner ?? "portfolio_os_runtime_owner",
          resume_condition: prelaunchFailure?.resumeCondition ?? "Promote a complete verified runtime closure and replay this exact event.",
          crash_journal: null,
        },
      };
      const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
      return { envelope, state: envelope.protocol_state, hash: sha256(bytes) };
    })();
  if (protocol.envelope?.diagnostics?.crash_journal) {
    try {
      await verifyEnvelopeCrashJournal({
        envelope: protocol.envelope,
        runtime: verifiedRuntime,
        companyId: input.companyId,
      });
    } catch {
      protocol = {
        envelope: null,
        state: "invalid",
        hash: protocol.hash,
      };
    }
  }
  let ackEvidenceVerified = protocol.envelope?.acknowledgements.length === 0;
  if (protocol.envelope && protocol.envelope.acknowledgements.length > 0) {
    try {
      await verifyEnvelopeAcknowledgements({
        envelope: protocol.envelope,
        runtime: verifiedRuntime,
        event: input.event,
        companyId: input.companyId,
        environment: input.environment,
      });
      ackEvidenceVerified = true;
    } catch {
      ackEvidenceVerified = false;
    }
  }
  const endedAt = now();
  const classification = classifyPosConsumerAttempt({
    process: captured.process,
    envelope: protocol.envelope,
    protocolState: protocol.state,
    eventId: input.event.eventId,
    stageRunId: input.event.stageRunId,
    now: endedAt,
    attempt: input.event.attempt,
    ackEvidenceVerified,
  });
  let diagnosticArtifact: ArtifactBinding | null = null;
  if (Buffer.byteLength(captured.stdout.redactedText, "utf8") > INLINE_STREAM_BYTES ||
      Buffer.byteLength(captured.stderr.redactedText, "utf8") > INLINE_STREAM_BYTES || captured.process.overflowed) {
    const diagnosticBytes = await gzip(Buffer.from(`${JSON.stringify({
      schema_version: "paperclip.pos_consumer_redacted_diagnostics.v1",
      attempt_id: input.attemptId,
      stdout: captured.stdout.redactedText,
      stderr: captured.stderr.redactedText,
      capture_truncated: captured.process.overflowed,
    })}\n`, "utf8"), { level: 9 });
    const diagnosticPath = path.join(receiptDirectory, `${input.attemptId}.diagnostics.json.gz`);
    const digest = await writeImmutableReceiptBytes(diagnosticPath, diagnosticBytes);
    diagnosticArtifact = { path: diagnosticPath, sha256: digest };
  }
  const acknowledgement = ackEvidenceVerified
    ? (protocol.envelope?.acknowledgements.find((value) =>
      value.event_id === input.event.eventId && value.stage_run_id === input.event.stageRunId)?.prepared_ack ?? null)
    : null;
  const ackResponse = ackEvidenceVerified
    ? (protocol.envelope?.acknowledgements.find((value) =>
      value.event_id === input.event.eventId && value.stage_run_id === input.event.stageRunId)?.ack_response ?? null)
    : null;
  const redactionCount = captured.stdout.redactionCount + captured.stderr.redactionCount;
  const receipt: PosConsumerAttemptReceipt = {
    schema_version: "paperclip.pos_consumer_attempt_receipt.v1",
    attempt_id: input.attemptId,
    plane: input.plane,
    company_id: input.companyId,
    event: {
      event_id: input.event.eventId, workflow_id: input.event.workflowId,
      stage_run_id: input.event.stageRunId, stage: input.event.stage,
      input_hash: input.event.inputHash, attempt: input.event.attempt,
      idempotency_key: input.event.idempotencyKey, claim_nonce_sha256: input.event.claimNonceSha256,
    },
    command: {
      executable: runtime.manifest.executable.path, args, cwd: runtime.cwd,
      allowlisted_environment_names: Object.keys(env).sort(),
      secret_references: [...input.secretReferences].sort((a, b) => a.name.localeCompare(b.name)),
    },
    runtime: {
      manifest: runtime.binding, source_commit: runtime.manifest.source.commit,
      source_tree_sha256: runtime.manifest.source.tree_sha256,
      interpreter_identity_sha256: runtime.manifest.interpreter.identity_sha256,
      contract_sha256: input.contractSha256,
      provider_policy_sha256: input.providerPolicySha256,
      provider_policy_authority: runtime.manifest.provider_policy_authority,
    },
    timing: {
      started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    },
    process: {
      exit_code: captured.process.exitCode, signal: captured.process.signal,
      timed_out: captured.process.timedOut,
      stdout: {
        bytes: captured.stdout.bytes, sha256: captured.stdout.sha256,
        excerpt: boundedUtf8(captured.stdout.redactedText, INLINE_STREAM_BYTES), artifact: diagnosticArtifact,
      },
      stderr: {
        bytes: captured.stderr.bytes, sha256: captured.stderr.sha256,
        excerpt: boundedUtf8(captured.stderr.redactedText, INLINE_STREAM_BYTES), artifact: diagnosticArtifact,
      },
    },
    protocol: {
      state: protocol.state, envelope_sha256: protocol.hash,
      result_schema_version: protocol.envelope?.summary.result_schema_version ?? null,
      acknowledgement, ack_response: ackResponse,
    },
    classification: {
      code: classification.code, retryable: classification.retryable, terminal: classification.terminal,
      next_attempt_at: classification.nextAttemptAt, next_owner: classification.nextOwner,
      resume_condition: classification.resumeCondition,
    },
    redaction: {
      version: "paperclip.redaction.v1", redacted: redactionCount > 0,
      secret_value_count: new Set(knownSecrets.filter(Boolean)).size,
    },
    generated_at: endedAt.toISOString(),
  };
  const receiptPath = path.join(receiptDirectory, `${input.attemptId}.json`);
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return {
    receipt,
    receiptBinding: { path: receiptPath, sha256: receiptSha256 },
    envelope: protocol.envelope,
    classification,
    process: captured.process,
  };
}
