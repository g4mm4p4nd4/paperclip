import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";

const SCHEMA_VERSION = "paperclip.provider_session_credential_remediation.v1";
const ENVELOPE_SCHEMA_VERSION = "paperclip.provider_session_credential_rollback_envelope.v1";
const MAINTENANCE_ACK = "I_HAVE_STOPPED_PAPERCLIP_WRITERS";
const DECODABLE_JWT_SOURCE = "eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}";
const SAME_LENGTH_MARKER = "[REDACTED_JWT]";
const MAX_LOG_FILE_BYTES = 256 * 1024 * 1024;
const MAX_KEY_FILE_BYTES = 4096;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type JsonRecord = Record<string, unknown>;
type RootKind = "active" | "legacy";
type DurabilityPoint = "lock_create" | "run_directory_create" | "lock_delete" | "primary_lock_delete";
type Phase =
  | "scanned"
  | "backup_prepared"
  | "staged"
  | "files_installed"
  | "db_committed"
  | "source_deduped"
  | "verified"
  | "roll_forward_required";

export class CredentialRemediationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rollForwardRequired = false,
  ) {
    super(message);
    this.name = "CredentialRemediationError";
  }
}

const REMEDIATION_APPLICATION_NAME = "paperclip-provider-session-credential-remediation";

/**
 * Build the dedicated maintenance connection used by the CLI entrypoint.
 *
 * Live Paperclip databases may enforce a short statement_timeout for normal
 * request traffic. The remediation intentionally scans the complete
 * historical heartbeat corpus, so every connection opened by its postgres-js
 * pool must opt out at startup rather than relying on a SET issued to one
 * arbitrarily selected pooled connection.
 */
export function providerSessionCredentialRemediationConnectionString(connectionString: string) {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new CredentialRemediationError("invalid_database_url", "DATABASE_URL is not a valid PostgreSQL connection URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new CredentialRemediationError("invalid_database_url", "DATABASE_URL must use the postgres or postgresql protocol");
  }
  const existingOptions = parsed.searchParams.get("options")?.trim();
  parsed.searchParams.set(
    "options",
    [existingOptions, "-c statement_timeout=0"].filter(Boolean).join(" "),
  );
  parsed.searchParams.set("application_name", REMEDIATION_APPLICATION_NAME);
  return parsed.toString();
}

export type HeartbeatRunRemediationRow = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  logStore: string | null;
  logRef: string | null;
  logBytes: string | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  resultJson: JsonRecord | null;
};

export type HeartbeatEventRemediationRow = {
  id: string;
  message: string | null;
  payload: JsonRecord | null;
};

type ScannedFile = {
  rootKind: RootKind;
  root: string;
  relativePath: string;
  absolutePath: string;
  mode: number;
  bytes: number;
  sha256: string;
  compressed: boolean;
  occurrences: number;
  validNdjson: boolean;
};

type FileMutation = {
  rootKind: RootKind;
  relativePath: string;
  sourcePath: string;
  mode: number;
  compressed: boolean;
  occurrences: number;
  oldBytes: number;
  oldSha256: string;
  newBytes: number;
  newSha256: string;
  mappedRunId: string | null;
  migrateToActive: boolean;
  replaceSource: boolean;
  dedupeLegacyAfterCommit: boolean;
};

type RunState = Pick<HeartbeatRunRemediationRow,
  "logStore" | "logRef" | "logBytes" | "logSha256" | "logCompressed" |
  "stdoutExcerpt" | "stderrExcerpt" | "resultJson">;

type EventState = Pick<HeartbeatEventRemediationRow, "message" | "payload">;

export type RunMutationDescriptor = {
  id: string;
  oldFingerprint: string;
  nextFingerprint: string;
  surfaceOccurrences: { stdout: number; stderr: number; result: number };
};

export type EventMutationDescriptor = {
  id: string;
  oldFingerprint: string;
  nextFingerprint: string;
  surfaceOccurrences: { message: number; payload: number };
};

export type RemediationCounts = {
  dbLogRefs: number;
  activeFiles: number;
  legacyFiles: number;
  liveOnlyRefs: number;
  legacyOnlyRefs: number;
  duplicateRootRefs: number;
  unresolvedMissingRefs: number;
  unresolvedMissingRefsSha256: string;
  affectedActiveFiles: number;
  affectedLegacyFiles: number;
  affectedOrphanFiles: number;
  fileOccurrences: number;
  mappedFilesToMigrate: number;
  runRowsToUpdate: number;
  eventRowsToUpdate: number;
  stdoutRows: number;
  stdoutOccurrences: number;
  stderrRows: number;
  stderrOccurrences: number;
  resultRows: number;
  resultOccurrences: number;
  eventMessageRows: number;
  eventMessageOccurrences: number;
  eventPayloadRows: number;
  eventPayloadOccurrences: number;
  logMetadataRowsToUpdate: number;
  nullLogMetadataRowsToBackfill: number;
};

export type RemediationPlan = {
  schemaVersion: typeof SCHEMA_VERSION;
  remediationId: string;
  activeRoot: string;
  legacyRoot: string;
  receiptRoot: string;
  resume: boolean;
  files: FileMutation[];
  runs: RunMutationDescriptor[];
  events: EventMutationDescriptor[];
  counts: RemediationCounts;
  planSha256: string;
};

export type EncryptedEnvelopeMetadata = {
  path: string;
  bytes: number;
  sha256: string;
  algorithm: "aes-256-gcm";
  ivHex: string;
  authTagHex: string;
  keyReferenceSha256: string;
  planSha256: string;
  verified: boolean;
  entries: { files: number; runs: number; events: number };
};

export type ProviderSessionCredentialRemediationOptions = {
  apply?: boolean;
  remediationId?: string;
  resumeId?: string;
  activeRoot: string;
  legacyRoot: string;
  receiptRoot: string;
  keyFile: string;
  maintenanceConfirmed: boolean;
  expectedPlanSha256?: string;
  now?: Date;
  testHooks?: {
    allowOtherDatabaseClients?: boolean;
    afterLockAcquired?: () => Promise<void> | void;
    afterFilesInstalled?: () => Promise<void> | void;
    beforeDatabaseCommit?: () => Promise<void> | void;
    beforePhaseReceiptInstall?: (phase: Phase, sequence: number) => Promise<void> | void;
    beforePostVerify?: () => Promise<void> | void;
    beforeRollbackEnvelope?: (plan: RemediationPlan) => Promise<void> | void;
    beforeDurabilityFsync?: (point: DurabilityPoint) => Promise<void> | void;
    afterDurabilityFsync?: (point: DurabilityPoint) => Promise<void> | void;
  };
};

type DatabaseEvidence = {
  txid: string;
  pre_commit_lsn: string;
  post_commit_lsn: string;
};

type CleanupEvidence = {
  legacy_sources_expected: number;
  legacy_sources_removed_this_attempt: number;
  legacy_sources_removed_total: number;
};

type PostcheckEvidence = {
  active_referenced_files: number;
  expected_active_referenced_files: number;
  legacy_mapped_files: number;
  unresolved_missing_refs: number;
  unresolved_missing_refs_sha256: string;
  metadata_matched_rows: number;
  file_predicate_occurrences: number;
  database_predicate_rows: number;
};

type RemediationRootIdentity = {
  active_sha256: string;
  legacy_sha256: string;
  receipt_sha256: string;
  same_device: boolean;
};

type EnvelopeFileEntry = {
    rootKind: RootKind;
    relativePath: string;
    mappedRunId: string | null;
    oldBytes: number;
    oldSha256: string;
    newBytes: number;
    newSha256: string;
    migrateToActive: boolean;
    replaceSource: boolean;
    dedupeLegacyAfterCommit: boolean;
};

type EnvelopeInventory = {
  remediationId: string;
  planSha256: string;
  fileEntries: Map<string, EnvelopeFileEntry>;
  runEntries: Map<string, { oldFingerprint: string; nextFingerprint: string }>;
  eventEntries: Map<string, { oldFingerprint: string; nextFingerprint: string }>;
  expectedLegacyRemovals: number;
};

type PhaseReceipt = {
  schema_version: typeof SCHEMA_VERSION;
  remediation_id: string;
  sequence: number;
  phase: Phase;
  created_at: string;
  apply: boolean;
  resume: boolean;
  immutable: true;
  aggregate_only: true;
  plan_sha256: string;
  approved_plan_sha256: string;
  previous_receipt_sha256: string | null;
  roots: RemediationRootIdentity;
  counts: RemediationCounts;
  backup: null | Omit<EncryptedEnvelopeMetadata, "ivHex" | "authTagHex"> & {
    iv_hex: string;
    auth_tag_hex: string;
  };
  database: DatabaseEvidence | null;
  cleanup: CleanupEvidence | null;
  postcheck: PostcheckEvidence | null;
  status: "ok" | "roll_forward_required";
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : [];
}

function sha256Bytes(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function base64AlphabetValue(code: number) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

export function validateRollbackEnvelopeOriginalFile(value: {
  oldBytes: unknown;
  oldSha256: unknown;
  originalBytesBase64: unknown;
}) {
  if (!Number.isSafeInteger(value.oldBytes) || Number(value.oldBytes) < 0 || Number(value.oldBytes) > MAX_LOG_FILE_BYTES ||
      typeof value.oldSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.oldSha256) ||
      typeof value.originalBytesBase64 !== "string") {
    throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry has invalid bounded metadata");
  }
  const expectedBytes = Number(value.oldBytes);
  const encoded = value.originalBytesBase64;
  const expectedEncodedLength = Math.ceil(expectedBytes / 3) * 4;
  const padding = expectedBytes === 0 ? 0 : (3 - (expectedBytes % 3)) % 3;
  if (encoded.length !== expectedEncodedLength) {
    throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry has a non-canonical encoded length");
  }
  const dataLength = encoded.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (base64AlphabetValue(encoded.charCodeAt(index)) < 0) {
      throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry is not canonical base64");
    }
  }
  for (let index = dataLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) {
      throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry has invalid base64 padding");
    }
  }
  if ((padding === 2 && (base64AlphabetValue(encoded.charCodeAt(dataLength - 1)) & 0x0f) !== 0) ||
      (padding === 1 && (base64AlphabetValue(encoded.charCodeAt(dataLength - 1)) & 0x03) !== 0)) {
    throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry has non-canonical base64 tail bits");
  }
  const decoded = Buffer.from(encoded, "base64");
  try {
    if (decoded.length !== expectedBytes || sha256Bytes(decoded) !== value.oldSha256) {
      throw new CredentialRemediationError("rollback_envelope_file_invalid", "Encrypted rollback file entry does not match its scanned original identity");
    }
  } finally {
    decoded.fill(0);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as JsonRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function countDecodableJwtShapes(value: string | null | undefined): number {
  if (!value) return 0;
  const expression = new RegExp(DECODABLE_JWT_SOURCE, "g");
  let count = 0;
  while (expression.exec(value) !== null) count += 1;
  return count;
}

export function redactDecodableJwtShapesSameLength(value: string): string {
  return value.replace(new RegExp(DECODABLE_JWT_SOURCE, "g"), (match) => {
    if (match.length < SAME_LENGTH_MARKER.length) {
      throw new CredentialRemediationError("credential_match_too_short", "Credential match is shorter than the fixed redaction marker");
    }
    return `${SAME_LENGTH_MARKER}${"X".repeat(match.length - SAME_LENGTH_MARKER.length)}`;
  });
}

function sanitizeJson(value: JsonRecord | null): JsonRecord | null {
  if (value === null) return null;
  const raw = JSON.stringify(value);
  const sanitized = redactDecodableJwtShapesSameLength(raw);
  return JSON.parse(sanitized) as JsonRecord;
}

function jsonOccurrences(value: JsonRecord | null): number {
  return value === null ? 0 : countDecodableJwtShapes(JSON.stringify(value));
}

function runStateFromRow(row: HeartbeatRunRemediationRow): RunState {
  return {
    logStore: row.logStore,
    logRef: row.logRef,
    logBytes: row.logBytes,
    logSha256: row.logSha256,
    logCompressed: row.logCompressed,
    stdoutExcerpt: row.stdoutExcerpt,
    stderrExcerpt: row.stderrExcerpt,
    resultJson: row.resultJson,
  };
}

function eventStateFromRow(row: HeartbeatEventRemediationRow): EventState {
  return { message: row.message, payload: row.payload };
}

function stateFingerprint(state: RunState | EventState) {
  return sha256Bytes(stableJson(state));
}

function nextRunState(row: HeartbeatRunRemediationRow, file: FileMutation | null): RunState {
  return {
    logStore: row.logStore,
    logRef: row.logRef,
    logBytes: file ? String(file.newBytes) : row.logBytes,
    logSha256: file ? file.newSha256 : row.logSha256,
    logCompressed: row.logCompressed,
    stdoutExcerpt: row.stdoutExcerpt === null ? null : redactDecodableJwtShapesSameLength(row.stdoutExcerpt),
    stderrExcerpt: row.stderrExcerpt === null ? null : redactDecodableJwtShapesSameLength(row.stderrExcerpt),
    resultJson: sanitizeJson(row.resultJson),
  };
}

function nextEventState(row: HeartbeatEventRemediationRow): EventState {
  return {
    message: row.message === null ? null : redactDecodableJwtShapesSameLength(row.message),
    payload: sanitizeJson(row.payload),
  };
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRelativeLogRef(value: string) {
  if (!value || path.isAbsolute(value) || value.includes("\0")) {
    throw new CredentialRemediationError("unsafe_log_ref", "Run-log reference is not a safe relative path");
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith(`..${path.sep}`) ||
      (!value.endsWith(".ndjson") && !value.endsWith(".ndjson.gz"))) {
    throw new CredentialRemediationError("unsafe_log_ref", "Run-log reference violates the canonical relative-path contract");
  }
}

async function optionalLstat(target: string) {
  return lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function sameFileIdentity(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalSecureDirectory(input: string, label: string) {
  const resolved = path.resolve(input);
  const observed = await optionalLstat(resolved);
  if (!observed?.isDirectory() || observed.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new CredentialRemediationError("unsafe_directory", `${label} must be a canonical non-symlink directory`);
  }
  return { path: resolved, stat: observed };
}

async function fsyncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

type DurabilityHooks = Pick<NonNullable<ProviderSessionCredentialRemediationOptions["testHooks"]>,
  "beforeDurabilityFsync" | "afterDurabilityFsync">;

async function fsyncDurabilityPoint(directory: string, point: DurabilityPoint, hooks?: DurabilityHooks) {
  await hooks?.beforeDurabilityFsync?.(point);
  await fsyncDirectory(directory);
  await hooks?.afterDurabilityFsync?.(point);
}

async function ensureSecureDirectoryTree(root: string, target: string) {
  if (!isWithin(root, target)) throw new CredentialRemediationError("unsafe_directory", "Directory creation escaped its managed root");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const observed = await optionalLstat(current);
    if (!observed) {
      await mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
      continue;
    }
    if (!observed.isDirectory() || observed.isSymbolicLink() || await realpath(current) !== current) {
      throw new CredentialRemediationError("unsafe_directory", "Managed directory tree contains a symlink or non-directory entry");
    }
  }
}

async function readSecureFile(filePath: string, maxBytes: number): Promise<{ bytes: Buffer; mode: number }> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new CredentialRemediationError("unsafe_file", "Remediation input is not a bounded regular file");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > maxBytes) {
      throw new CredentialRemediationError("file_changed", "Remediation input changed during secure open");
    }
    const bytes = await handle.readFile();
    const after = await lstat(filePath);
    if (!sameFileIdentity(opened, after) || after.size !== bytes.length) {
      throw new CredentialRemediationError("file_changed", "Remediation input changed while it was read");
    }
    return { bytes, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function decodeLogBytes(raw: Buffer, compressed: boolean) {
  try {
    return compressed ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  } catch {
    throw new CredentialRemediationError("invalid_gzip", "Compressed run log could not be decoded");
  }
}

function encodeSanitizedLog(raw: Buffer, compressed: boolean) {
  const decoded = decodeLogBytes(raw, compressed);
  const sanitized = redactDecodableJwtShapesSameLength(decoded);
  return compressed ? gzipSync(Buffer.from(sanitized, "utf8"), { level: 6 }) : Buffer.from(sanitized, "utf8");
}

function validateNdjson(text: string) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch {
      throw new CredentialRemediationError("invalid_ndjson", "Run-log file is not valid NDJSON");
    }
  }
}

async function scanRoot(rootKind: RootKind, root: string): Promise<Map<string, ScannedFile>> {
  const discovered = new Map<string, ScannedFile>();
  async function visit(directory: string) {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new CredentialRemediationError("unsafe_directory", "Run-log tree contains an unsafe directory entry");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const after = await lstat(directory);
    if (!sameFileIdentity(before, after)) throw new CredentialRemediationError("file_changed", "Run-log directory changed during scan");
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new CredentialRemediationError("unsafe_file", "Run-log tree contains a symlink");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new CredentialRemediationError("unsafe_file", "Run-log tree contains a non-file entry");
      const relativePath = path.relative(root, absolutePath);
      assertSafeRelativeLogRef(relativePath);
      const { bytes, mode } = await readSecureFile(absolutePath, MAX_LOG_FILE_BYTES);
      const compressed = relativePath.endsWith(".gz");
      const text = decodeLogBytes(bytes, compressed);
      validateNdjson(text);
      discovered.set(relativePath, {
        rootKind,
        root,
        relativePath,
        absolutePath,
        mode,
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
        compressed,
        occurrences: countDecodableJwtShapes(text),
        validNdjson: true,
      });
    }
  }
  await visit(root);
  return discovered;
}

async function loadRunLogRows(db: Db): Promise<HeartbeatRunRemediationRow[]> {
  return rows<HeartbeatRunRemediationRow>(await db.execute(sql`
    select id::text as "id", company_id::text as "companyId", agent_id::text as "agentId", status,
           log_store as "logStore", log_ref as "logRef", log_bytes::text as "logBytes",
           log_sha256 as "logSha256", log_compressed as "logCompressed",
           null::text as "stdoutExcerpt", null::text as "stderrExcerpt", null::jsonb as "resultJson"
    from heartbeat_runs
    where log_ref is not null
  `));
}

async function loadAffectedRunIds(db: Db): Promise<string[]> {
  return rows<{ id: string }>(await db.execute(sql`
    select id::text as id
    from heartbeat_runs
    where coalesce(stdout_excerpt, '') ~ ${DECODABLE_JWT_SOURCE}
       or coalesce(stderr_excerpt, '') ~ ${DECODABLE_JWT_SOURCE}
       or coalesce(result_json::text, '') ~ ${DECODABLE_JWT_SOURCE}
    order by id
  `)).map((row) => row.id);
}

async function loadCompleteRunRowById(db: Db, runId: string): Promise<HeartbeatRunRemediationRow | null> {
  return rows<HeartbeatRunRemediationRow>(await db.execute(sql`
    select id::text as "id", company_id::text as "companyId", agent_id::text as "agentId", status,
           log_store as "logStore", log_ref as "logRef", log_bytes::text as "logBytes",
           log_sha256 as "logSha256", log_compressed as "logCompressed",
           stdout_excerpt as "stdoutExcerpt", stderr_excerpt as "stderrExcerpt", result_json as "resultJson"
    from heartbeat_runs
    where id = ${runId}::uuid
  `))[0] ?? null;
}

async function loadAffectedEventIds(db: Db): Promise<string[]> {
  return rows<{ id: string }>(await db.execute(sql`
    select id::text as id from heartbeat_run_events
    where coalesce(message, '') ~ ${DECODABLE_JWT_SOURCE}
       or coalesce(payload::text, '') ~ ${DECODABLE_JWT_SOURCE}
    order by id
  `)).map((row) => row.id);
}

async function loadCompleteEventRowById(db: Db, eventId: string): Promise<HeartbeatEventRemediationRow | null> {
  return rows<HeartbeatEventRemediationRow>(await db.execute(sql`
    select id::text as id, message, payload
    from heartbeat_run_events
    where id = ${eventId}::bigint
  `))[0] ?? null;
}

function filePathContract(row: HeartbeatRunRemediationRow) {
  return path.join(row.companyId, row.agentId, `${row.id}.ndjson`);
}

function rootHash(root: string) {
  return sha256Bytes(root);
}

function remediationRootIdentity(activeRoot: string, legacyRoot: string, receiptRoot: string): RemediationRootIdentity {
  return {
    active_sha256: rootHash(activeRoot),
    legacy_sha256: rootHash(legacyRoot),
    receipt_sha256: rootHash(receiptRoot),
    same_device: true,
  };
}

function emptyCounts(): RemediationCounts {
  return {
    dbLogRefs: 0,
    activeFiles: 0,
    legacyFiles: 0,
    liveOnlyRefs: 0,
    legacyOnlyRefs: 0,
    duplicateRootRefs: 0,
    unresolvedMissingRefs: 0,
    unresolvedMissingRefsSha256: sha256Bytes(""),
    affectedActiveFiles: 0,
    affectedLegacyFiles: 0,
    affectedOrphanFiles: 0,
    fileOccurrences: 0,
    mappedFilesToMigrate: 0,
    runRowsToUpdate: 0,
    eventRowsToUpdate: 0,
    stdoutRows: 0,
    stdoutOccurrences: 0,
    stderrRows: 0,
    stderrOccurrences: 0,
    resultRows: 0,
    resultOccurrences: 0,
    eventMessageRows: 0,
    eventMessageOccurrences: 0,
    eventPayloadRows: 0,
    eventPayloadOccurrences: 0,
    logMetadataRowsToUpdate: 0,
    nullLogMetadataRowsToBackfill: 0,
  };
}

export async function buildProviderSessionCredentialRemediationPlan(input: {
  db: Db;
  remediationId: string;
  activeRoot: string;
  legacyRoot: string;
  receiptRoot: string;
  resume?: boolean;
}): Promise<RemediationPlan> {
  const [active, legacy] = await Promise.all([
    scanRoot("active", input.activeRoot),
    scanRoot("legacy", input.legacyRoot),
  ]);
  // Keep database reads sequential. The live maintenance gate intentionally
  // rejects every other client backend; concurrent reads through the
  // postgres-js pool would create a second connection owned by this same
  // remediation process and then correctly trip its own writer fence.
  //
  // The complete result_json/event payload corpus can be many GiB. Keep only
  // lightweight log-reference rows plus affected ids resident; every complete
  // payload row is fetched, fingerprinted, counted, and released individually.
  // This bounds planning memory to one database row rather than the affected
  // corpus (which exceeded 1.5 GiB in the live repair).
  const runRowsById = new Map<string, HeartbeatRunRemediationRow>();
  for (const row of await loadRunLogRows(input.db)) runRowsById.set(row.id, row);
  const affectedRunIds = await loadAffectedRunIds(input.db);
  const affectedEventIds = await loadAffectedEventIds(input.db);
  const runByRef = new Map<string, HeartbeatRunRemediationRow>();
  for (const row of runRowsById.values()) {
    if (!row.logRef) continue;
    assertSafeRelativeLogRef(row.logRef);
    if (runByRef.has(row.logRef)) throw new CredentialRemediationError("duplicate_log_ref", "Multiple heartbeat rows share one log reference");
    runByRef.set(row.logRef, row);
  }

  const counts = emptyCounts();
  counts.dbLogRefs = runByRef.size;
  counts.activeFiles = active.size;
  counts.legacyFiles = legacy.size;
  const missingRefs: string[] = [];
  const files: FileMutation[] = [];
  const fileByRunId = new Map<string, FileMutation>();
  const metadataMutationRunIds = new Set<string>();

  for (const [relativePath, row] of runByRef) {
    const activeFile = active.get(relativePath) ?? null;
    const legacyFile = legacy.get(relativePath) ?? null;
    if (activeFile && legacyFile) {
      counts.duplicateRootRefs += 1;
      if (!input.resume || activeFile.sha256 !== legacyFile.sha256 || activeFile.bytes !== legacyFile.bytes) {
        throw new CredentialRemediationError("root_collision", "The active and legacy roots contain a conflicting log reference");
      }
    } else if (activeFile) counts.liveOnlyRefs += 1;
    else if (legacyFile) counts.legacyOnlyRefs += 1;
    else {
      missingRefs.push(relativePath);
      continue;
    }
    const authority = activeFile ?? legacyFile!;
    if (row.logStore !== "local_file" || row.logRef !== filePathContract(row) || row.logCompressed !== authority.compressed) {
      throw new CredentialRemediationError("log_contract_mismatch", "A database-bound run log violates its store/path/compression contract");
    }
    const metadataPairNull = row.logBytes === null && row.logSha256 === null;
    const metadataPairPresent = row.logBytes !== null && row.logSha256 !== null;
    if (!metadataPairNull && !metadataPairPresent) {
      throw new CredentialRemediationError("partial_log_metadata", "A run log has partially populated integrity metadata");
    }
    const metadataMatches = metadataPairPresent && Number(row.logBytes) === authority.bytes && row.logSha256 === authority.sha256;
    if (metadataPairPresent && !metadataMatches && !input.resume) {
      throw new CredentialRemediationError("log_metadata_mismatch", "Run-log integrity metadata differs from the authoritative file");
    }
    const migrateToActive = !activeFile && Boolean(legacyFile);
    const dedupeLegacyAfterCommit = Boolean(legacyFile && activeFile);
    const affected = authority.occurrences > 0;
    const needsFilePlan = migrateToActive || dedupeLegacyAfterCommit || affected || metadataPairNull || !metadataMatches;
    if (!needsFilePlan) continue;
    const raw = (await readSecureFile(authority.absolutePath, MAX_LOG_FILE_BYTES)).bytes;
    const nextBytes = affected ? encodeSanitizedLog(raw, authority.compressed) : raw;
    validateNdjson(decodeLogBytes(nextBytes, authority.compressed));
    if (countDecodableJwtShapes(decodeLogBytes(nextBytes, authority.compressed)) !== 0) {
      throw new CredentialRemediationError("redaction_incomplete", "A staged run log still contains the credential predicate");
    }
    const mutation: FileMutation = {
      rootKind: authority.rootKind,
      relativePath,
      sourcePath: authority.absolutePath,
      mode: authority.mode,
      compressed: authority.compressed,
      occurrences: authority.occurrences,
      oldBytes: authority.bytes,
      oldSha256: authority.sha256,
      newBytes: nextBytes.length,
      newSha256: sha256Bytes(nextBytes),
      mappedRunId: row.id,
      migrateToActive,
      replaceSource: affected,
      dedupeLegacyAfterCommit,
    };
    files.push(mutation);
    fileByRunId.set(row.id, mutation);
    if (String(mutation.newBytes) !== row.logBytes || mutation.newSha256 !== row.logSha256) {
      metadataMutationRunIds.add(row.id);
    }
    if (migrateToActive) counts.mappedFilesToMigrate += 1;
    if (metadataPairNull) counts.nullLogMetadataRowsToBackfill += 1;
  }

  for (const file of [...active.values(), ...legacy.values()]) {
    if (runByRef.has(file.relativePath) || file.occurrences === 0) continue;
    const raw = (await readSecureFile(file.absolutePath, MAX_LOG_FILE_BYTES)).bytes;
    const nextBytes = encodeSanitizedLog(raw, file.compressed);
    files.push({
      rootKind: file.rootKind,
      relativePath: file.relativePath,
      sourcePath: file.absolutePath,
      mode: file.mode,
      compressed: file.compressed,
      occurrences: file.occurrences,
      oldBytes: file.bytes,
      oldSha256: file.sha256,
      newBytes: nextBytes.length,
      newSha256: sha256Bytes(nextBytes),
      mappedRunId: null,
      migrateToActive: false,
      replaceSource: true,
      dedupeLegacyAfterCommit: false,
    });
    counts.affectedOrphanFiles += 1;
  }

  counts.unresolvedMissingRefs = missingRefs.length;
  counts.unresolvedMissingRefsSha256 = sha256Bytes([...missingRefs].sort().join("\n"));
  counts.affectedActiveFiles = [...active.values()].filter((file) => file.occurrences > 0).length;
  counts.affectedLegacyFiles = [...legacy.values()].filter((file) => file.occurrences > 0).length;
  counts.fileOccurrences = [...active.values(), ...legacy.values()].reduce((total, file) => total + file.occurrences, 0);

  const runMutations: RunMutationDescriptor[] = [];
  const candidateRunIds = [...new Set([...affectedRunIds, ...metadataMutationRunIds])].sort();
  for (const runId of candidateRunIds) {
    const row = await loadCompleteRunRowById(input.db, runId);
    if (!row) throw new CredentialRemediationError("run_snapshot_incomplete", "A remediation candidate disappeared during the frozen scan");
    const stdout = countDecodableJwtShapes(row.stdoutExcerpt);
    const stderr = countDecodableJwtShapes(row.stderrExcerpt);
    const result = jsonOccurrences(row.resultJson);
    const file = fileByRunId.get(row.id) ?? null;
    const nextLogBytes = file ? String(file.newBytes) : row.logBytes;
    const nextLogSha256 = file ? file.newSha256 : row.logSha256;
    const surfaceChanged = stdout + stderr + result > 0;
    const metadataChanged = nextLogBytes !== row.logBytes || nextLogSha256 !== row.logSha256;
    if (!surfaceChanged && !metadataChanged) continue;
    if (stdout > 0) { counts.stdoutRows += 1; counts.stdoutOccurrences += stdout; }
    if (stderr > 0) { counts.stderrRows += 1; counts.stderrOccurrences += stderr; }
    if (result > 0) { counts.resultRows += 1; counts.resultOccurrences += result; }
    if (metadataChanged) counts.logMetadataRowsToUpdate += 1;
    const oldState = runStateFromRow(row);
    const nextState = nextRunState(row, file);
    runMutations.push({
      id: row.id,
      oldFingerprint: stateFingerprint(oldState),
      nextFingerprint: stateFingerprint(nextState),
      surfaceOccurrences: { stdout, stderr, result },
    });
  }

  const eventMutations: EventMutationDescriptor[] = [];
  for (const eventId of affectedEventIds) {
    const event = await loadCompleteEventRowById(input.db, eventId);
    if (!event) throw new CredentialRemediationError("event_snapshot_incomplete", "A remediation event disappeared during the frozen scan");
    const message = countDecodableJwtShapes(event.message);
    const payload = jsonOccurrences(event.payload);
    if (message + payload === 0) continue;
    if (message > 0) { counts.eventMessageRows += 1; counts.eventMessageOccurrences += message; }
    if (payload > 0) { counts.eventPayloadRows += 1; counts.eventPayloadOccurrences += payload; }
    const oldState = eventStateFromRow(event);
    const nextState = nextEventState(event);
    eventMutations.push({
      id: event.id,
      oldFingerprint: stateFingerprint(oldState),
      nextFingerprint: stateFingerprint(nextState),
      surfaceOccurrences: { message, payload },
    });
  }
  counts.runRowsToUpdate = runMutations.length;
  counts.eventRowsToUpdate = eventMutations.length;

  const fingerprint = {
    schemaVersion: SCHEMA_VERSION,
    remediationId: input.remediationId,
    resume: Boolean(input.resume),
    roots: remediationRootIdentity(input.activeRoot, input.legacyRoot, input.receiptRoot),
    counts,
    files: files.map((file) => ({
      rootKind: file.rootKind,
      relativePath: file.relativePath,
      oldBytes: file.oldBytes,
      oldSha256: file.oldSha256,
      newBytes: file.newBytes,
      newSha256: file.newSha256,
      mappedRunId: file.mappedRunId,
      migrateToActive: file.migrateToActive,
      replaceSource: file.replaceSource,
      dedupeLegacyAfterCommit: file.dedupeLegacyAfterCommit,
    })).sort((left, right) => `${left.rootKind}:${left.relativePath}`.localeCompare(`${right.rootKind}:${right.relativePath}`)),
    runs: runMutations.map((row) => ({
      id: row.id,
      oldFingerprint: row.oldFingerprint,
      nextFingerprint: row.nextFingerprint,
      surfaceOccurrences: row.surfaceOccurrences,
    })),
    events: eventMutations.map((row) => ({
      id: row.id,
      oldFingerprint: row.oldFingerprint,
      nextFingerprint: row.nextFingerprint,
      surfaceOccurrences: row.surfaceOccurrences,
    })),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    remediationId: input.remediationId,
    activeRoot: input.activeRoot,
    legacyRoot: input.legacyRoot,
    receiptRoot: input.receiptRoot,
    resume: Boolean(input.resume),
    files,
    runs: runMutations,
    events: eventMutations,
    counts,
    planSha256: sha256Bytes(stableJson(fingerprint)),
  };
}

async function readEncryptionKey(keyFile: string) {
  const resolved = path.resolve(keyFile);
  if (isWithin(REPO_ROOT, resolved)) {
    throw new CredentialRemediationError("key_inside_repository", "Encryption key reference must be outside the repository");
  }
  const observed = await lstat(resolved);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size > MAX_KEY_FILE_BYTES || (observed.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && observed.uid !== process.geteuid()) || await realpath(resolved) !== resolved) {
    throw new CredentialRemediationError("unsafe_key_reference", "Encryption key reference must be an owner-only canonical regular file outside the repository");
  }
  const { bytes } = await readSecureFile(resolved, MAX_KEY_FILE_BYTES);
  const trimmed = bytes.toString("utf8").trim();
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) key = Buffer.from(trimmed, "base64");
  else if (bytes.length === 32) key = Buffer.from(bytes);
  else throw new CredentialRemediationError("invalid_encryption_key", "Encryption key must contain exactly 32 raw bytes, 64 hex characters, or 32-byte base64");
  if (key.length !== 32) throw new CredentialRemediationError("invalid_encryption_key", "Encryption key must decode to 32 bytes");
  return { key, keyReferenceSha256: sha256Bytes(resolved) };
}

async function* rollbackEnvelopeLines(plan: RemediationPlan, db: Db): AsyncGenerator<string> {
  yield `${JSON.stringify({
    type: "header",
    schema_version: ENVELOPE_SCHEMA_VERSION,
    remediation_id: plan.remediationId,
    plan_sha256: plan.planSha256,
  })}\n`;
  const fileByRunId = new Map(plan.files.filter((file) => file.mappedRunId).map((file) => [file.mappedRunId!, file]));
  for (const descriptor of plan.runs) {
    const row = await loadCompleteRunRowById(db, descriptor.id);
    if (!row) throw new CredentialRemediationError("rollback_run_missing", "A planned run disappeared before encrypted backup");
    const oldState = runStateFromRow(row);
    const nextState = nextRunState(row, fileByRunId.get(row.id) ?? null);
    if (stateFingerprint(oldState) !== descriptor.oldFingerprint || stateFingerprint(nextState) !== descriptor.nextFingerprint) {
      throw new CredentialRemediationError("rollback_run_cas_failed", "A planned run changed before encrypted backup");
    }
    yield `${JSON.stringify({ type: "run", value: { ...descriptor, old: oldState, next: nextState } })}\n`;
  }
  for (const descriptor of plan.events) {
    const row = await loadCompleteEventRowById(db, descriptor.id);
    if (!row) throw new CredentialRemediationError("rollback_event_missing", "A planned event disappeared before encrypted backup");
    const oldState = eventStateFromRow(row);
    const nextState = nextEventState(row);
    if (stateFingerprint(oldState) !== descriptor.oldFingerprint || stateFingerprint(nextState) !== descriptor.nextFingerprint) {
      throw new CredentialRemediationError("rollback_event_cas_failed", "A planned event changed before encrypted backup");
    }
    yield `${JSON.stringify({ type: "event", value: { ...descriptor, old: oldState, next: nextState } })}\n`;
  }
  for (const file of plan.files) {
    const { bytes } = await readSecureFile(file.sourcePath, MAX_LOG_FILE_BYTES);
    if (bytes.length !== file.oldBytes || sha256Bytes(bytes) !== file.oldSha256) {
      throw new CredentialRemediationError("rollback_file_cas_failed", "Run log no longer matches the scanned original before encrypted backup");
    }
    yield `${JSON.stringify({
      type: "file",
      value: {
        ...file,
        sourcePath: undefined,
        originalBytesBase64: bytes.toString("base64"),
      },
    })}\n`;
  }
}

async function verifyEncryptedEnvelope(input: {
  metadata: Omit<EncryptedEnvelopeMetadata, "verified">;
  key: Buffer;
}) {
  let buffered = "";
  let header = 0;
  let files = 0;
  let runs = 0;
  let events = 0;
  let remediationId: string | null = null;
  let planSha256: string | null = null;
  const fileEntries = new Map<string, EnvelopeFileEntry>();
  const runEntries = new Map<string, { oldFingerprint: string; nextFingerprint: string }>();
  const eventEntries = new Map<string, { oldFingerprint: string; nextFingerprint: string }>();
  let expectedLegacyRemovals = 0;
  const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(input.metadata.ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(input.metadata.authTagHex, "hex"));
  // The ciphertext reader can split one UTF-8 code point across chunks. Decode
  // on the readable side with Node's stateful StringDecoder rather than calling
  // Buffer#toString independently in the sink, which would silently inject
  // replacement characters and invalidate an otherwise exact row fingerprint.
  decipher.setEncoding("utf8");
  const sink = new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      try {
        buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const parsed = JSON.parse(line) as {
            type?: string;
            schema_version?: string;
            remediation_id?: string;
            plan_sha256?: string;
            value?: Record<string, unknown>;
          };
          if (parsed.type === "header" && parsed.schema_version === ENVELOPE_SCHEMA_VERSION) {
            header += 1;
            remediationId = typeof parsed.remediation_id === "string" ? parsed.remediation_id : null;
            planSha256 = typeof parsed.plan_sha256 === "string" ? parsed.plan_sha256 : null;
          } else if (parsed.type === "file" && parsed.value) {
            files += 1;
            const value = parsed.value;
            const relativePath = typeof value.relativePath === "string" ? value.relativePath : "";
            const mappedRunId = typeof value.mappedRunId === "string" ? value.mappedRunId : null;
            const rootKind = value.rootKind === "active" || value.rootKind === "legacy" ? value.rootKind : null;
            const oldBytes = Number.isSafeInteger(value.oldBytes) ? Number(value.oldBytes) : -1;
            const newBytes = Number.isSafeInteger(value.newBytes) ? Number(value.newBytes) : -1;
            const oldSha256 = typeof value.oldSha256 === "string" ? value.oldSha256 : "";
            const newSha256 = typeof value.newSha256 === "string" ? value.newSha256 : "";
            if (!rootKind || oldBytes < 0 || newBytes < 0 || oldBytes > MAX_LOG_FILE_BYTES || newBytes > MAX_LOG_FILE_BYTES ||
                !/^[a-f0-9]{64}$/.test(oldSha256) || !/^[a-f0-9]{64}$/.test(newSha256)) {
              throw new Error("invalid envelope file identity");
            }
            validateRollbackEnvelopeOriginalFile({
              oldBytes: value.oldBytes,
              oldSha256,
              originalBytesBase64: value.originalBytesBase64,
            });
            assertSafeRelativeLogRef(relativePath);
            const key = envelopeFileKey(relativePath, mappedRunId, rootKind);
            if (fileEntries.has(key)) throw new Error("duplicate envelope file identity");
            const entry: EnvelopeFileEntry = {
              rootKind,
              relativePath,
              mappedRunId,
              oldBytes,
              oldSha256,
              newBytes,
              newSha256,
              migrateToActive: value.migrateToActive === true,
              replaceSource: value.replaceSource === true,
              dedupeLegacyAfterCommit: value.dedupeLegacyAfterCommit === true,
            };
            fileEntries.set(key, entry);
            if (entry.migrateToActive || entry.dedupeLegacyAfterCommit) expectedLegacyRemovals += 1;
          } else if (parsed.type === "run" && parsed.value && typeof parsed.value.id === "string") {
            runs += 1;
            if (runEntries.has(parsed.value.id) || typeof parsed.value.old !== "object" || typeof parsed.value.next !== "object") {
              throw new Error("invalid or duplicate envelope run identity");
            }
            const oldFingerprint = sha256Bytes(stableJson(parsed.value.old));
            const nextFingerprint = sha256Bytes(stableJson(parsed.value.next));
            if ((parsed.value.oldFingerprint !== undefined && parsed.value.oldFingerprint !== oldFingerprint) ||
                (parsed.value.nextFingerprint !== undefined && parsed.value.nextFingerprint !== nextFingerprint)) {
              throw new Error("envelope run descriptor does not match its payload");
            }
            runEntries.set(parsed.value.id, {
              oldFingerprint,
              nextFingerprint,
            });
          } else if (parsed.type === "event" && parsed.value && typeof parsed.value.id === "string") {
            events += 1;
            if (eventEntries.has(parsed.value.id) || typeof parsed.value.old !== "object" || typeof parsed.value.next !== "object") {
              throw new Error("invalid or duplicate envelope event identity");
            }
            const oldFingerprint = sha256Bytes(stableJson(parsed.value.old));
            const nextFingerprint = sha256Bytes(stableJson(parsed.value.next));
            if ((parsed.value.oldFingerprint !== undefined && parsed.value.oldFingerprint !== oldFingerprint) ||
                (parsed.value.nextFingerprint !== undefined && parsed.value.nextFingerprint !== nextFingerprint)) {
              throw new Error("envelope event descriptor does not match its payload");
            }
            eventEntries.set(parsed.value.id, {
              oldFingerprint,
              nextFingerprint,
            });
          } else throw new Error("invalid envelope entry");
        }
        callback();
      } catch (error) { callback(error as Error); }
    },
    final(callback) {
      if (buffered.trim().length > 0) callback(new Error("incomplete envelope line"));
      else callback();
    },
  });
  await pipeline(createReadStream(input.metadata.path), decipher, sink);
  if (header !== 1 || files !== input.metadata.entries.files || runs !== input.metadata.entries.runs || events !== input.metadata.entries.events) {
    throw new CredentialRemediationError("rollback_envelope_verification_failed", "Encrypted rollback envelope entry counts do not match the plan");
  }
  if (remediationId === null || planSha256 === null || planSha256 !== input.metadata.planSha256) {
    throw new CredentialRemediationError("rollback_envelope_identity_failed", "Encrypted rollback envelope identity does not match its immutable metadata");
  }
  return { remediationId, planSha256, fileEntries, runEntries, eventEntries, expectedLegacyRemovals } satisfies EnvelopeInventory;
}

export async function writeEncryptedRollbackEnvelope(plan: RemediationPlan, db: Db, keyFile: string, outputPath: string): Promise<EncryptedEnvelopeMetadata> {
  if (plan.resume) {
    throw new CredentialRemediationError("rollback_envelope_initial_only", "Rollback envelope creation is permitted only for the initial approved apply");
  }
  const { key, keyReferenceSha256 } = await readEncryptionKey(keyFile);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    await pipeline(
      Readable.from(rollbackEnvelopeLines(plan, db)),
      cipher,
      createWriteStream(outputPath, { flags: "wx", mode: 0o400 }),
    );
    await chmod(outputPath, 0o400);
    const durableEnvelope = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await durableEnvelope.sync(); } finally { await durableEnvelope.close(); }
    await fsyncDirectory(path.dirname(outputPath));
    const authTag = cipher.getAuthTag();
    const observed = await stat(outputPath);
    const metadataWithoutVerification = {
      path: outputPath,
      bytes: observed.size,
      sha256: await sha256File(outputPath),
      algorithm: "aes-256-gcm" as const,
      ivHex: iv.toString("hex"),
      authTagHex: authTag.toString("hex"),
      keyReferenceSha256,
      planSha256: plan.planSha256,
      entries: { files: plan.files.length, runs: plan.runs.length, events: plan.events.length },
    };
    await verifyEncryptedEnvelope({ metadata: metadataWithoutVerification, key });
    return { ...metadataWithoutVerification, verified: true };
  } catch (error) {
    await unlink(outputPath).catch((unlinkError: NodeJS.ErrnoException) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
    await fsyncDirectory(path.dirname(outputPath)).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function writeSecureFile(filePath: string, bytes: Buffer, mode: number) {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode & 0o700 ? mode & 0o700 : 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function materializeStage(plan: RemediationPlan, stageRoot: string) {
  await mkdir(stageRoot, { mode: 0o700 });
  const canonicalStage = await realpath(stageRoot);
  if (canonicalStage !== stageRoot) throw new CredentialRemediationError("unsafe_staging_root", "Staging root is not canonical");
  for (const file of plan.files) {
    const { bytes: current } = await readSecureFile(file.sourcePath, MAX_LOG_FILE_BYTES);
    const currentSha = sha256Bytes(current);
    if (currentSha !== file.oldSha256 && currentSha !== file.newSha256) {
      throw new CredentialRemediationError("file_changed", "Run log changed after planning");
    }
    const next = currentSha === file.newSha256 ? current : encodeSanitizedLog(current, file.compressed);
    if (sha256Bytes(next) !== file.newSha256 || next.length !== file.newBytes) {
      throw new CredentialRemediationError("staging_integrity_failed", "Staged run log does not match the plan");
    }
    validateNdjson(decodeLogBytes(next, file.compressed));
    const destinations: string[] = [];
    if (file.migrateToActive) destinations.push(path.join(stageRoot, "migrate", file.relativePath));
    if (file.replaceSource) destinations.push(path.join(stageRoot, "replace", file.rootKind, file.relativePath));
    for (const destination of destinations) {
      await ensureSecureDirectoryTree(stageRoot, path.dirname(destination));
      await writeSecureFile(destination, next, file.mode);
    }
  }
  await fsyncDirectory(stageRoot);
}

async function installStagedFiles(plan: RemediationPlan, stageRoot: string) {
  for (const file of plan.files.filter((entry) => entry.replaceSource)) {
    const staged = path.join(stageRoot, "replace", file.rootKind, file.relativePath);
    const current = await readSecureFile(file.sourcePath, MAX_LOG_FILE_BYTES);
    const currentSha = sha256Bytes(current.bytes);
    if (currentSha === file.newSha256) {
      await unlink(staged).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      continue;
    }
    if (currentSha !== file.oldSha256) throw new CredentialRemediationError("file_cas_failed", "Run-log source changed before atomic replacement", true);
    await rename(staged, file.sourcePath);
    await fsyncDirectory(path.dirname(file.sourcePath));
  }
  for (const file of plan.files.filter((entry) => entry.migrateToActive)) {
    const staged = path.join(stageRoot, "migrate", file.relativePath);
    const destination = path.join(plan.activeRoot, file.relativePath);
    await ensureSecureDirectoryTree(plan.activeRoot, path.dirname(destination));
    const existing = await optionalLstat(destination);
    if (existing) {
      const current = await readSecureFile(destination, MAX_LOG_FILE_BYTES);
      if (sha256Bytes(current.bytes) !== file.newSha256) {
        throw new CredentialRemediationError("destination_collision", "Active run-log destination appeared with different contents", true);
      }
      await unlink(staged).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      continue;
    }
    try {
      await link(staged, destination);
    } catch (error) {
      const filesystemError = error as NodeJS.ErrnoException;
      if (filesystemError.code !== "EEXIST") throw error;
      const current = await readSecureFile(destination, MAX_LOG_FILE_BYTES);
      if (sha256Bytes(current.bytes) !== file.newSha256) {
        throw new CredentialRemediationError("destination_collision", "Active run-log destination appeared with different contents", true);
      }
    }
    await unlink(staged);
    await fsyncDirectory(path.dirname(destination));
  }
}

async function applyDatabaseMutations(db: Db, plan: RemediationPlan, input: {
  allowOtherClients: boolean;
  beforeMutations: () => Promise<void>;
  beforeCommit?: () => Promise<void> | void;
}): Promise<DatabaseEvidence> {
  const fileByRunId = new Map(plan.files.filter((file) => file.mappedRunId).map((file) => [file.mappedRunId!, file]));
  const transactionEvidence = await db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
    await tx.execute(sql.raw("LOCK TABLE heartbeat_runs, heartbeat_run_events, agents IN SHARE ROW EXCLUSIVE MODE"));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"provider-session-credential-remediation"}))`);
    const active = rows<{ count: string }>(await tx.execute(sql`
      select (
        (select count(*) from heartbeat_runs where status in ('queued', 'running')) +
        (select count(*) from agents where status = 'running')
      )::text as count
    `))[0];
    if (!active || Number(active.count) !== 0) {
      throw new CredentialRemediationError("active_writers", "Execution became active after the maintenance preflight", true);
    }
    if (!input.allowOtherClients) {
      const clients = rows<{ count: string }>(await tx.execute(sql`
        select count(*)::text as count from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
      `))[0];
      if (!clients || Number(clients.count) !== 0) {
        throw new CredentialRemediationError("database_clients_present", "A database client reconnected after the maintenance preflight", true);
      }
    }
    const transactionStart = rows<{ txid: string; lsn: string }>(await tx.execute(sql`
      select txid_current()::text as txid, pg_current_wal_lsn()::text as lsn
    `))[0];
    if (!transactionStart) throw new CredentialRemediationError("database_evidence_missing", "Could not capture remediation transaction identity", true);
    // The table locks above are the durable writer fence for the first
    // production filesystem mutation through the matching database CAS commit.
    await input.beforeMutations();
    for (const descriptor of plan.runs) {
      const current = rows<HeartbeatRunRemediationRow>(await tx.execute(sql`
        select id::text as "id", company_id::text as "companyId", agent_id::text as "agentId", status,
               log_store as "logStore", log_ref as "logRef", log_bytes::text as "logBytes",
               log_sha256 as "logSha256", log_compressed as "logCompressed",
               stdout_excerpt as "stdoutExcerpt", stderr_excerpt as "stderrExcerpt", result_json as "resultJson"
        from heartbeat_runs where id = ${descriptor.id}::uuid for update
      `))[0];
      if (!current) throw new CredentialRemediationError("run_cas_missing", "Heartbeat run disappeared during remediation", true);
      const currentFingerprint = stateFingerprint(runStateFromRow(current));
      if (currentFingerprint === descriptor.nextFingerprint) continue;
      if (currentFingerprint !== descriptor.oldFingerprint) throw new CredentialRemediationError("run_cas_failed", "Heartbeat run changed after the frozen scan", true);
      const next = nextRunState(current, fileByRunId.get(current.id) ?? null);
      if (stateFingerprint(next) !== descriptor.nextFingerprint) {
        throw new CredentialRemediationError("run_successor_mismatch", "Heartbeat run successor differs from the deterministic plan", true);
      }
      const nextResult = next.resultJson === null ? null : JSON.stringify(next.resultJson);
      const updated = rows<{ id: string }>(await tx.execute(sql`
        update heartbeat_runs set
          log_store = ${next.logStore},
          log_ref = ${next.logRef},
          log_bytes = ${next.logBytes}::bigint,
          log_sha256 = ${next.logSha256},
          log_compressed = ${next.logCompressed},
          stdout_excerpt = ${next.stdoutExcerpt},
          stderr_excerpt = ${next.stderrExcerpt},
          result_json = case when ${nextResult}::text is null then null else ${nextResult}::jsonb end,
          updated_at = now()
        where id = ${descriptor.id}::uuid returning id::text as id
      `));
      if (updated.length !== 1) throw new CredentialRemediationError("run_cas_failed", "Heartbeat run update lost its row lock", true);
    }
    for (const descriptor of plan.events) {
      const current = rows<HeartbeatEventRemediationRow>(await tx.execute(sql`
        select id::text as id, message, payload from heartbeat_run_events where id = ${descriptor.id}::bigint for update
      `))[0];
      if (!current) throw new CredentialRemediationError("event_cas_missing", "Heartbeat event disappeared during remediation", true);
      const currentFingerprint = stateFingerprint(eventStateFromRow(current));
      if (currentFingerprint === descriptor.nextFingerprint) continue;
      if (currentFingerprint !== descriptor.oldFingerprint) throw new CredentialRemediationError("event_cas_failed", "Heartbeat event changed after the frozen scan", true);
      const next = nextEventState(current);
      if (stateFingerprint(next) !== descriptor.nextFingerprint) {
        throw new CredentialRemediationError("event_successor_mismatch", "Heartbeat event successor differs from the deterministic plan", true);
      }
      const nextPayload = next.payload === null ? null : JSON.stringify(next.payload);
      const updated = rows<{ id: string }>(await tx.execute(sql`
        update heartbeat_run_events set
          message = ${next.message},
          payload = case when ${nextPayload}::text is null then null else ${nextPayload}::jsonb end
        where id = ${descriptor.id}::bigint returning id::text as id
      `));
      if (updated.length !== 1) throw new CredentialRemediationError("event_cas_failed", "Heartbeat event update lost its row lock", true);
    }
    await input.beforeCommit?.();
    const remaining = rows<{ count: string }>(await tx.execute(sql`
      select (
        (select count(*) from heartbeat_runs where
          coalesce(stdout_excerpt, '') ~ ${DECODABLE_JWT_SOURCE} or
          coalesce(stderr_excerpt, '') ~ ${DECODABLE_JWT_SOURCE} or
          coalesce(result_json::text, '') ~ ${DECODABLE_JWT_SOURCE}) +
        (select count(*) from heartbeat_run_events where
          coalesce(message, '') ~ ${DECODABLE_JWT_SOURCE} or
          coalesce(payload::text, '') ~ ${DECODABLE_JWT_SOURCE})
      )::text as count
    `))[0];
    if (!remaining || Number(remaining.count) !== 0) {
      throw new CredentialRemediationError("database_redaction_incomplete", "Database credential predicate remains after transactional updates", true);
    }
    const transactionEnd = rows<{ lsn: string }>(await tx.execute(sql`select pg_current_wal_lsn()::text as lsn`))[0];
    if (!transactionEnd) throw new CredentialRemediationError("database_evidence_missing", "Could not capture remediation pre-commit WAL position", true);
    return { txid: transactionStart.txid, pre_commit_lsn: transactionEnd.lsn };
  }, { isolationLevel: "serializable", accessMode: "read write" });
  const committed = rows<{ lsn: string }>(await db.execute(sql`select pg_current_wal_lsn()::text as lsn`))[0];
  if (!committed) throw new CredentialRemediationError("database_evidence_missing", "Could not capture remediation post-commit WAL position", true);
  return { ...transactionEvidence, post_commit_lsn: committed.lsn };
}

async function dedupeLegacySources(plan: RemediationPlan) {
  let removed = 0;
  for (const file of plan.files.filter((entry) => entry.migrateToActive || entry.dedupeLegacyAfterCommit)) {
    const legacyPath = path.join(plan.legacyRoot, file.relativePath);
    const observed = await optionalLstat(legacyPath);
    if (!observed) continue;
    if (!observed.isFile() || observed.isSymbolicLink()) throw new CredentialRemediationError("unsafe_file", "Legacy duplicate became unsafe", true);
    const activePath = path.join(plan.activeRoot, file.relativePath);
    const [legacyBytes, activeBytes] = await Promise.all([
      readSecureFile(legacyPath, MAX_LOG_FILE_BYTES),
      readSecureFile(activePath, MAX_LOG_FILE_BYTES),
    ]);
    if (sha256Bytes(legacyBytes.bytes) !== sha256Bytes(activeBytes.bytes)) {
      throw new CredentialRemediationError("dedupe_integrity_failed", "Legacy and active copies differ after commit", true);
    }
    await unlink(legacyPath);
    await fsyncDirectory(path.dirname(legacyPath));
    removed += 1;
  }
  return removed;
}

async function assertMaintenance(db: Db, allowOtherClients = false) {
  const active = rows<{ count: string }>(await db.execute(sql`
    select (
      (select count(*) from heartbeat_runs where status in ('queued', 'running')) +
      (select count(*) from agents where status = 'running')
    )::text as count
  `))[0];
  if (!active || Number(active.count) !== 0) {
    throw new CredentialRemediationError("active_writers", "Remediation requires zero queued/running heartbeat work and zero running agents");
  }
  if (!allowOtherClients) {
    const clients = rows<{ count: string }>(await db.execute(sql`
      select count(*)::text as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
    `))[0];
    if (!clients || Number(clients.count) !== 0) {
      throw new CredentialRemediationError("database_clients_present", "Remediation requires Paperclip and all other database clients to be stopped");
    }
  }
}

type LockHandle = { path: string; file: Awaited<ReturnType<typeof open>>; resume: boolean };

async function acquireLock(receiptRoot: string, remediationId: string, resume: boolean, hooks?: DurabilityHooks): Promise<LockHandle> {
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(receiptRoot, resume
    ? `provider-session-credential-remediation-${remediationId}.resume.lock`
    : "provider-session-credential-remediation.lock");
  const file = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new CredentialRemediationError("remediation_locked", "Another remediation or required roll-forward owns the exclusive lock");
      throw error;
    });
  try {
    await file.writeFile(`${JSON.stringify({ schema_version: SCHEMA_VERSION, remediation_id: remediationId, resume, pid: process.pid })}\n`);
    await file.sync();
    await fsyncDurabilityPoint(receiptRoot, "lock_create", hooks);
    return { path: lockPath, file, resume };
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
    await fsyncDirectory(receiptRoot).catch(() => undefined);
    throw error;
  }
}

async function releaseLock(lock: LockHandle, remove: boolean, hooks?: DurabilityHooks) {
  await lock.file.close();
  if (remove) {
    await unlink(lock.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await fsyncDurabilityPoint(path.dirname(lock.path), "lock_delete", hooks);
  }
}

async function writePhaseReceipt(input: {
  plan: RemediationPlan;
  runDirectory: string;
  phase: Phase;
  sequence: number;
  apply: boolean;
  sameDevice: boolean;
  previousReceiptSha256: string | null;
  backup: EncryptedEnvelopeMetadata | null;
  database?: DatabaseEvidence | null;
  cleanup?: CleanupEvidence | null;
  postcheck?: PostcheckEvidence | null;
  now: Date;
  beforeInstall?: (phase: Phase, sequence: number) => Promise<void> | void;
}) {
  const receipt: PhaseReceipt = {
    schema_version: SCHEMA_VERSION,
    remediation_id: input.plan.remediationId,
    sequence: input.sequence,
    phase: input.phase,
    created_at: input.now.toISOString(),
    apply: input.apply,
    resume: input.plan.resume,
    immutable: true,
    aggregate_only: true,
    plan_sha256: input.plan.planSha256,
    approved_plan_sha256: input.backup?.planSha256 ?? input.plan.planSha256,
    previous_receipt_sha256: input.previousReceiptSha256,
    roots: {
      active_sha256: rootHash(input.plan.activeRoot),
      legacy_sha256: rootHash(input.plan.legacyRoot),
      receipt_sha256: rootHash(input.plan.receiptRoot),
      same_device: input.sameDevice,
    },
    counts: input.plan.counts,
    backup: input.backup ? {
      path: input.backup.path,
      bytes: input.backup.bytes,
      sha256: input.backup.sha256,
      algorithm: input.backup.algorithm,
      iv_hex: input.backup.ivHex,
      auth_tag_hex: input.backup.authTagHex,
      keyReferenceSha256: input.backup.keyReferenceSha256,
      planSha256: input.backup.planSha256,
      verified: input.backup.verified,
      entries: input.backup.entries,
    } : null,
    database: input.database ?? null,
    cleanup: input.cleanup ?? null,
    postcheck: input.postcheck ?? null,
    status: input.phase === "roll_forward_required" ? "roll_forward_required" : "ok",
  };
  const fileName = `${String(input.sequence).padStart(2, "0")}-${input.phase}.json`;
  const receiptPath = path.join(input.runDirectory, fileName);
  const temporaryPath = path.join(input.runDirectory, `.${fileName}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let installed = false;
  try {
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o444);
    } finally { await handle.close(); }
    await input.beforeInstall?.(input.phase, input.sequence);
    await link(temporaryPath, receiptPath);
    try {
      await fsyncDirectory(input.runDirectory);
      installed = true;
    } catch (error) {
      await unlink(receiptPath).catch(() => undefined);
      await fsyncDirectory(input.runDirectory).catch(() => undefined);
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && !installed) throw error;
    });
    if (installed) await fsyncDirectory(input.runDirectory).catch(() => undefined);
  }
  return { path: receiptPath, sha256: sha256Bytes(bytes), receipt };
}

async function loadPhaseState(runDirectory: string, remediationId: string) {
  const observed = await optionalLstat(runDirectory);
  if (!observed) return {
    exists: false,
    nextSequence: 0,
    previousReceiptSha256: null as string | null,
    backup: null as EncryptedEnvelopeMetadata | null,
    latestPhase: null as Phase | null,
    database: null as DatabaseEvidence | null,
    cleanup: null as CleanupEvidence | null,
    postcheck: null as PostcheckEvidence | null,
    frozenRoots: null as RemediationRootIdentity | null,
  };
  if (!observed.isDirectory() || observed.isSymbolicLink() || await realpath(runDirectory) !== runDirectory ||
      (observed.mode & 0o077) !== 0 || (typeof process.geteuid === "function" && observed.uid !== process.geteuid())) {
    throw new CredentialRemediationError("unsafe_receipt_directory", "Existing remediation receipt directory is unsafe");
  }
  const names = (await readdir(runDirectory))
    .filter((name) => /^\d+-[a-z_]+[.]json$/.test(name))
    .sort((left, right) => Number(left.split("-", 1)[0]) - Number(right.split("-", 1)[0]));
  let previousReceiptSha256: string | null = null;
  let nextSequence = 0;
  let backup: EncryptedEnvelopeMetadata | null = null;
  let latestPhase: Phase | null = null;
  let database: DatabaseEvidence | null = null;
  let cleanup: CleanupEvidence | null = null;
  let postcheck: PostcheckEvidence | null = null;
  let rootsIdentity: string | null = null;
  let frozenRoots: RemediationRootIdentity | null = null;
  let approvedPlanSha256: string | null = null;
  let backupIdentity: string | null = null;
  let previousReceipt: PhaseReceipt | null = null;
  const validPhases = new Set<Phase>(["scanned", "backup_prepared", "staged", "files_installed", "db_committed", "source_deduped", "verified", "roll_forward_required"]);
  for (const name of names) {
    const receiptPath = path.join(runDirectory, name);
    const metadata = await lstat(receiptPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o444) {
      throw new CredentialRemediationError("mutable_phase_receipt", "Existing phase receipt is not an immutable regular file");
    }
    const bytes = await readFile(receiptPath);
    const receipt = JSON.parse(bytes.toString("utf8")) as PhaseReceipt;
    const fileSequence = Number(name.split("-", 1)[0]);
    const receiptRootsValid = Boolean(receipt.roots && receipt.roots.same_device === true &&
      /^[a-f0-9]{64}$/.test(receipt.roots.active_sha256) &&
      /^[a-f0-9]{64}$/.test(receipt.roots.legacy_sha256) &&
      /^[a-f0-9]{64}$/.test(receipt.roots.receipt_sha256));
    if (receipt.schema_version !== SCHEMA_VERSION || receipt.remediation_id !== remediationId || receipt.aggregate_only !== true || receipt.immutable !== true ||
        receipt.sequence !== fileSequence || receipt.sequence !== nextSequence ||
        receipt.previous_receipt_sha256 !== previousReceiptSha256 || !validPhases.has(receipt.phase) ||
        !/^[a-f0-9]{64}$/.test(receipt.plan_sha256) || !/^[a-f0-9]{64}$/.test(receipt.approved_plan_sha256) ||
        receipt.status !== (receipt.phase === "roll_forward_required" ? "roll_forward_required" : "ok") || !receiptRootsValid) {
      throw new CredentialRemediationError("invalid_phase_chain", "Existing remediation phase chain is invalid");
    }
    const transitionAllowed = previousReceipt === null
      ? receipt.phase === "scanned"
      : receipt.phase === "roll_forward_required"
        ? previousReceipt.backup !== null && previousReceipt.apply
        : receipt.phase === "scanned"
          ? (previousReceipt.phase === "verified" && previousReceipt.apply === false) || previousReceipt.phase === "roll_forward_required"
          : receipt.phase === "verified"
            ? previousReceipt.phase === "scanned" || previousReceipt.phase === "source_deduped"
            : receipt.phase === "backup_prepared"
              ? previousReceipt.phase === "scanned" && receipt.apply && !receipt.resume
              : receipt.phase === "staged"
                ? previousReceipt.phase === "backup_prepared" || (previousReceipt.phase === "scanned" && receipt.resume)
                : receipt.phase === "files_installed"
                  ? previousReceipt.phase === "staged"
                  : receipt.phase === "db_committed"
                    ? previousReceipt.phase === "files_installed"
                    : receipt.phase === "source_deduped" && previousReceipt.phase === "db_committed";
    if (!transitionAllowed || (receipt.resume && !receipt.apply) ||
        (["backup_prepared", "staged", "files_installed", "db_committed", "source_deduped", "roll_forward_required"] as Phase[]).includes(receipt.phase) && !receipt.apply) {
      throw new CredentialRemediationError("invalid_phase_transition", "Existing remediation phase order is invalid");
    }
    const currentRootsIdentity = stableJson(receipt.roots);
    if (rootsIdentity !== null && rootsIdentity !== currentRootsIdentity) {
      throw new CredentialRemediationError("invalid_phase_chain", "Remediation roots changed inside the immutable phase chain");
    }
    rootsIdentity = currentRootsIdentity;
    frozenRoots ??= receipt.roots;
    previousReceiptSha256 = sha256Bytes(bytes);
    nextSequence = Math.max(nextSequence, receipt.sequence + 1);
    latestPhase = receipt.phase;
    if (receipt.backup) {
      if (backupIdentity === null && (receipt.phase !== "backup_prepared" || receipt.plan_sha256 !== receipt.backup.planSha256)) {
        throw new CredentialRemediationError("invalid_phase_chain", "The first rollback-envelope receipt is not bound to the approved apply plan");
      }
      const currentBackupIdentity = stableJson(receipt.backup);
      if (backupIdentity !== null && backupIdentity !== currentBackupIdentity) {
        throw new CredentialRemediationError("invalid_phase_chain", "Rollback-envelope metadata changed inside the phase chain");
      }
      backupIdentity = currentBackupIdentity;
      backup = {
        path: receipt.backup.path,
        bytes: receipt.backup.bytes,
        sha256: receipt.backup.sha256,
        algorithm: receipt.backup.algorithm,
        ivHex: receipt.backup.iv_hex,
        authTagHex: receipt.backup.auth_tag_hex,
        keyReferenceSha256: receipt.backup.keyReferenceSha256,
        planSha256: receipt.backup.planSha256,
        verified: receipt.backup.verified,
        entries: receipt.backup.entries,
      };
      if (receipt.approved_plan_sha256 !== backup.planSha256) {
        throw new CredentialRemediationError("invalid_phase_chain", "Receipt approval identity differs from its rollback envelope");
      }
      if (approvedPlanSha256 !== null && approvedPlanSha256 !== backup.planSha256) {
        throw new CredentialRemediationError("invalid_phase_chain", "Rollback-envelope identity changed inside the phase chain");
      }
      approvedPlanSha256 = backup.planSha256;
    } else if (approvedPlanSha256 !== null) {
      throw new CredentialRemediationError("invalid_phase_chain", "A receipt after backup preparation omitted the rollback envelope identity");
    }
    if (receipt.database) database = receipt.database;
    if (receipt.cleanup) cleanup = receipt.cleanup;
    if (receipt.postcheck) postcheck = receipt.postcheck;
    previousReceipt = receipt;
  }
  return { exists: true, nextSequence, previousReceiptSha256, backup, latestPhase, database, cleanup, postcheck, frozenRoots };
}

async function verifyExistingRollbackEnvelope(backup: EncryptedEnvelopeMetadata, keyFile: string, runDirectory: string) {
  if (!backup.verified || path.dirname(path.resolve(backup.path)) !== runDirectory) {
    throw new CredentialRemediationError("unsafe_rollback_envelope", "Roll-forward receipt does not reference a verified envelope in its remediation directory");
  }
  const observed = await lstat(backup.path);
  if (!observed.isFile() || observed.isSymbolicLink() || (observed.mode & 0o777) !== 0o400 ||
      (typeof process.geteuid === "function" && observed.uid !== process.geteuid()) ||
      observed.size !== backup.bytes || await sha256File(backup.path) !== backup.sha256) {
    throw new CredentialRemediationError("rollback_envelope_changed", "Encrypted rollback envelope changed after its immutable phase receipt");
  }
  const { key, keyReferenceSha256 } = await readEncryptionKey(keyFile);
  try {
    if (keyReferenceSha256 !== backup.keyReferenceSha256) {
      throw new CredentialRemediationError("rollback_key_reference_changed", "Roll-forward key reference differs from the verified backup receipt");
    }
    const { verified: _verified, ...metadata } = backup;
    return await verifyEncryptedEnvelope({ metadata, key });
  } finally { key.fill(0); }
}

function envelopeFileKey(relativePath: string, mappedRunId: string | null, rootKind: RootKind) {
  return mappedRunId ? `mapped\0${relativePath}\0${mappedRunId}` : `orphan\0${rootKind}\0${relativePath}`;
}

async function currentFileIdentity(filePath: string) {
  const observed = await optionalLstat(filePath);
  if (!observed) return null;
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw new CredentialRemediationError("resume_file_state_unbacked", "Resume inventory path became unsafe", true);
  }
  const { bytes } = await readSecureFile(filePath, MAX_LOG_FILE_BYTES);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function fileIdentityMatches(identity: { bytes: number; sha256: string } | null, bytes: number, sha256: string) {
  return identity?.bytes === bytes && identity.sha256 === sha256;
}

async function assertEnvelopeFileCurrentState(plan: RemediationPlan, entry: EnvelopeFileEntry) {
  const activePath = path.join(plan.activeRoot, entry.relativePath);
  const legacyPath = path.join(plan.legacyRoot, entry.relativePath);
  if (!entry.mappedRunId) {
    const identity = await currentFileIdentity(entry.rootKind === "active" ? activePath : legacyPath);
    if (!fileIdentityMatches(identity, entry.oldBytes, entry.oldSha256) && !fileIdentityMatches(identity, entry.newBytes, entry.newSha256)) {
      throw new CredentialRemediationError("resume_file_state_unbacked", "An encrypted orphan-file original is missing or outside its old/next identities", true);
    }
    return;
  }

  const active = await currentFileIdentity(activePath);
  const legacy = await currentFileIdentity(legacyPath);
  const activeIsOld = fileIdentityMatches(active, entry.oldBytes, entry.oldSha256);
  const activeIsNext = fileIdentityMatches(active, entry.newBytes, entry.newSha256);
  const legacyIsOld = fileIdentityMatches(legacy, entry.oldBytes, entry.oldSha256);
  const legacyIsNext = fileIdentityMatches(legacy, entry.newBytes, entry.newSha256);
  const migrates = entry.migrateToActive || entry.dedupeLegacyAfterCommit;
  const allowed = migrates
    ? (active === null && (legacyIsOld || legacyIsNext)) ||
      (activeIsNext && legacyIsNext) ||
      (activeIsNext && legacy === null)
    : entry.rootKind === "active"
      ? (activeIsOld || activeIsNext) && legacy === null
      : (legacyIsOld || legacyIsNext) && active === null;
  if (!allowed) {
    throw new CredentialRemediationError("resume_file_state_unbacked", "An encrypted mapped-file original is missing or outside its permitted old/next root transition", true);
  }
}

async function assertResumePlanBacked(db: Db, plan: RemediationPlan, inventory: EnvelopeInventory) {
  if (inventory.remediationId !== plan.remediationId) {
    throw new CredentialRemediationError("resume_envelope_identity_mismatch", "Resume envelope belongs to a different remediation", true);
  }
  for (const [runId, original] of inventory.runEntries) {
    const row = await loadCompleteRunRowById(db, runId);
    if (!row) throw new CredentialRemediationError("resume_run_state_unbacked", "An encrypted run-row original is missing", true);
    const currentFingerprint = stateFingerprint(runStateFromRow(row));
    if (currentFingerprint !== original.oldFingerprint && currentFingerprint !== original.nextFingerprint) {
      throw new CredentialRemediationError("resume_run_state_unbacked", "An encrypted run row drifted outside its old/next identities", true);
    }
  }
  for (const [eventId, original] of inventory.eventEntries) {
    const row = await loadCompleteEventRowById(db, eventId);
    if (!row) throw new CredentialRemediationError("resume_event_state_unbacked", "An encrypted event-row original is missing", true);
    const currentFingerprint = stateFingerprint(eventStateFromRow(row));
    if (currentFingerprint !== original.oldFingerprint && currentFingerprint !== original.nextFingerprint) {
      throw new CredentialRemediationError("resume_event_state_unbacked", "An encrypted event row drifted outside its old/next identities", true);
    }
  }
  for (const entry of inventory.fileEntries.values()) await assertEnvelopeFileCurrentState(plan, entry);

  for (const file of plan.files) {
    const original = inventory.fileEntries.get(envelopeFileKey(file.relativePath, file.mappedRunId, file.rootKind));
    const hashes = original ? new Set([original.oldSha256, original.newSha256]) : null;
    const byteLengths = original ? new Set([original.oldBytes, original.newBytes]) : null;
    const rootTransitionSafe = Boolean(original && (
      file.rootKind === original.rootKind || (original.migrateToActive && file.rootKind === "active")
    ));
    if (!original || !hashes?.has(file.oldSha256) || !hashes.has(file.newSha256) ||
        !byteLengths?.has(file.oldBytes) || !byteLengths.has(file.newBytes) || !rootTransitionSafe ||
        (file.migrateToActive && !original.migrateToActive) ||
        (file.dedupeLegacyAfterCommit && !original.migrateToActive && !original.dedupeLegacyAfterCommit)) {
      throw new CredentialRemediationError("resume_plan_not_backed", "Resume discovered a file mutation outside the verified rollback envelope", true);
    }
  }
  for (const run of plan.runs) {
    const original = inventory.runEntries.get(run.id);
    if (!original || run.oldFingerprint !== original.oldFingerprint || run.nextFingerprint !== original.nextFingerprint) {
      throw new CredentialRemediationError("resume_plan_not_backed", "Resume discovered a run-row mutation outside the verified rollback envelope", true);
    }
  }
  for (const event of plan.events) {
    const original = inventory.eventEntries.get(event.id);
    if (!original || event.oldFingerprint !== original.oldFingerprint || event.nextFingerprint !== original.nextFingerprint) {
      throw new CredentialRemediationError("resume_plan_not_backed", "Resume discovered an event-row mutation outside the verified rollback envelope", true);
    }
  }
}

async function postVerify(db: Db, plan: RemediationPlan) {
  const [active, legacy] = await Promise.all([scanRoot("active", plan.activeRoot), scanRoot("legacy", plan.legacyRoot)]);
  const runs = await loadRunLogRows(db);
  const fileOccurrences = [...active.values(), ...legacy.values()].reduce((total, file) => total + file.occurrences, 0);
  if (fileOccurrences !== 0) throw new CredentialRemediationError("postcheck_file_predicate", "Credential predicate remains in a run-log root", true);
  const missing: string[] = [];
  let activeReferencedFiles = 0;
  let legacyMappedFiles = 0;
  let metadataMatchedRows = 0;
  for (const run of runs) {
    if (!run.logRef) continue;
    if (active.has(run.logRef) && legacy.has(run.logRef)) throw new CredentialRemediationError("postcheck_root_collision", "Database-bound log remains duplicated across roots", true);
    if (active.has(run.logRef)) activeReferencedFiles += 1;
    if (legacy.has(run.logRef)) legacyMappedFiles += 1;
    const file = active.get(run.logRef) ?? legacy.get(run.logRef) ?? null;
    if (!file) { missing.push(run.logRef); continue; }
    if (run.logBytes !== String(file.bytes) || run.logSha256 !== file.sha256 || run.logCompressed !== file.compressed) {
      throw new CredentialRemediationError("postcheck_metadata", "Database run-log metadata does not match the surviving file", true);
    }
    metadataMatchedRows += 1;
  }
  const missingSha = sha256Bytes([...missing].sort().join("\n"));
  if (missing.length !== plan.counts.unresolvedMissingRefs || missingSha !== plan.counts.unresolvedMissingRefsSha256) {
    throw new CredentialRemediationError("missing_refs_changed", "Unresolved missing run-log references changed during remediation", true);
  }
  const expectedActiveReferencedFiles = plan.counts.dbLogRefs - plan.counts.unresolvedMissingRefs;
  if (legacyMappedFiles !== 0 || activeReferencedFiles !== expectedActiveReferencedFiles || metadataMatchedRows !== expectedActiveReferencedFiles) {
    throw new CredentialRemediationError("postcheck_root_placement", "Database-bound run logs did not converge completely into the active root", true);
  }
  const dbRemaining = rows<{ count: string }>(await db.execute(sql`
    select (
      (select count(*) from heartbeat_runs where
        coalesce(stdout_excerpt, '') ~ ${DECODABLE_JWT_SOURCE} or
        coalesce(stderr_excerpt, '') ~ ${DECODABLE_JWT_SOURCE} or
        coalesce(result_json::text, '') ~ ${DECODABLE_JWT_SOURCE}) +
      (select count(*) from heartbeat_run_events where
        coalesce(message, '') ~ ${DECODABLE_JWT_SOURCE} or
        coalesce(payload::text, '') ~ ${DECODABLE_JWT_SOURCE})
    )::text as count
  `))[0];
  if (!dbRemaining || Number(dbRemaining.count) !== 0) {
    throw new CredentialRemediationError("postcheck_database_predicate", "Credential predicate remains in database surfaces", true);
  }
  return {
    active_referenced_files: activeReferencedFiles,
    expected_active_referenced_files: expectedActiveReferencedFiles,
    legacy_mapped_files: legacyMappedFiles,
    unresolved_missing_refs: missing.length,
    unresolved_missing_refs_sha256: missingSha,
    metadata_matched_rows: metadataMatchedRows,
    file_predicate_occurrences: fileOccurrences,
    database_predicate_rows: Number(dbRemaining.count),
  } satisfies PostcheckEvidence;
}

export async function runProviderSessionCredentialRemediation(db: Db, options: ProviderSessionCredentialRemediationOptions) {
  if (!options.maintenanceConfirmed) {
    throw new CredentialRemediationError("maintenance_not_confirmed", "Explicit maintenance acknowledgement is required");
  }
  const apply = options.apply === true;
  const resume = Boolean(options.resumeId);
  if (resume && !apply) throw new CredentialRemediationError("resume_requires_apply", "Roll-forward resume requires --apply");
  const remediationId = options.resumeId ?? options.remediationId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(remediationId)) throw new CredentialRemediationError("invalid_remediation_id", "Remediation id contains unsafe characters");
  const [activeRoot, legacyRoot, receiptRoot] = await Promise.all([
    canonicalSecureDirectory(options.activeRoot, "active root"),
    canonicalSecureDirectory(options.legacyRoot, "legacy root"),
    canonicalSecureDirectory(options.receiptRoot, "receipt root"),
  ]);
  if (activeRoot.stat.dev !== legacyRoot.stat.dev) throw new CredentialRemediationError("cross_device_roots", "Active and legacy run-log roots must share a filesystem device");
  if (activeRoot.stat.dev !== receiptRoot.stat.dev) throw new CredentialRemediationError("cross_device_staging", "Receipt/staging root must share the run-log filesystem device");
  if ((receiptRoot.stat.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && receiptRoot.stat.uid !== process.geteuid())) {
    throw new CredentialRemediationError("unsafe_receipt_root", "Receipt root must be owned by the remediation user and inaccessible to group/other users");
  }
  if (isWithin(activeRoot.path, receiptRoot.path) || isWithin(legacyRoot.path, receiptRoot.path) ||
      isWithin(receiptRoot.path, activeRoot.path) || isWithin(receiptRoot.path, legacyRoot.path)) {
    throw new CredentialRemediationError("unsafe_receipt_root", "Receipt root must be outside both run-log roots");
  }
  await assertMaintenance(db, options.testHooks?.allowOtherDatabaseClients === true);
  const primaryLockPath = path.join(receiptRoot.path, "provider-session-credential-remediation.lock");
  if (resume) {
    const retained = await optionalLstat(primaryLockPath);
    if (!retained?.isFile() || retained.isSymbolicLink() || (retained.mode & 0o077) !== 0 ||
        (typeof process.geteuid === "function" && retained.uid !== process.geteuid())) {
      throw new CredentialRemediationError("resume_lock_missing", "Roll-forward resume requires the retained primary remediation lock");
    }
    const retainedValue = JSON.parse((await readFile(primaryLockPath, "utf8"))) as { remediation_id?: string };
    if (retainedValue.remediation_id !== remediationId) {
      throw new CredentialRemediationError("resume_lock_mismatch", "Retained remediation lock belongs to a different run");
    }
  }
  const lock = await acquireLock(receiptRoot.path, remediationId, resume, options.testHooks);
  let mutationStarted = resume;
  let success = false;
  let sequence = 0;
  let previousReceiptSha256: string | null = null;
  let backup: EncryptedEnvelopeMetadata | null = null;
  let databaseEvidence: DatabaseEvidence | null = null;
  let cleanupEvidence: CleanupEvidence | null = null;
  let postcheckEvidence: PostcheckEvidence | null = null;
  let envelopeInventory: EnvelopeInventory | null = null;
  let receiptChainValidated = false;
  const runDirectory = path.join(receiptRoot.path, remediationId);
  const stageRoot = path.join(receiptRoot.path, `.provider-session-credential-remediation-stage-${remediationId}`);
  try {
    await options.testHooks?.afterLockAcquired?.();
    // Close the preflight-to-lock race. The later serializable table lock spans
    // the first production file mutation through the database CAS commit.
    await assertMaintenance(db, options.testHooks?.allowOtherDatabaseClients === true);
    const phaseState = await loadPhaseState(runDirectory, remediationId);
    const currentRoots = remediationRootIdentity(activeRoot.path, legacyRoot.path, receiptRoot.path);
    if (phaseState.frozenRoots && stableJson(phaseState.frozenRoots) !== stableJson(currentRoots)) {
      throw new CredentialRemediationError("root_identity_mismatch", "Current remediation roots differ from the frozen receipt chain");
    }
    receiptChainValidated = true;
    sequence = phaseState.nextSequence;
    previousReceiptSha256 = phaseState.previousReceiptSha256;
    backup = phaseState.backup;
    databaseEvidence = phaseState.database;
    cleanupEvidence = phaseState.cleanup;
    postcheckEvidence = phaseState.postcheck;
    if (resume) {
      if (!phaseState.exists || !backup || phaseState.latestPhase === "verified") {
        throw new CredentialRemediationError("resume_state_invalid", "Roll-forward resume requires an incomplete phase chain with a verified rollback envelope");
      }
      envelopeInventory = await verifyExistingRollbackEnvelope(backup, options.keyFile, runDirectory);
    } else if (apply && phaseState.latestPhase && phaseState.latestPhase !== "verified") {
      if (phaseState.latestPhase === "scanned" && !backup) {
        await unlink(path.join(runDirectory, "rollback-envelope.aes256gcm")).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        throw new CredentialRemediationError("resume_required", "An incomplete prior apply must use --resume-id");
      }
    }
    const plan = await buildProviderSessionCredentialRemediationPlan({
      db,
      remediationId,
      activeRoot: activeRoot.path,
      legacyRoot: legacyRoot.path,
      receiptRoot: receiptRoot.path,
      resume,
    });
    if (resume) await assertResumePlanBacked(db, plan, envelopeInventory!);
    if (apply && !resume && (!options.expectedPlanSha256 || options.expectedPlanSha256 !== plan.planSha256)) {
      throw new CredentialRemediationError("plan_approval_mismatch", "--apply requires the exact plan SHA from a fresh dry-run receipt");
    }
    if (!phaseState.exists) {
      await mkdir(runDirectory, { mode: 0o700 });
      try {
        await fsyncDurabilityPoint(receiptRoot.path, "run_directory_create", options.testHooks);
      } catch (error) {
        await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
        await fsyncDirectory(receiptRoot.path).catch(() => undefined);
        throw error;
      }
    }
    const appendPhase = async (phase: Phase) => {
      const written = await writePhaseReceipt({
        plan,
        runDirectory,
        phase,
        sequence,
        apply,
        sameDevice: true,
        previousReceiptSha256,
        backup,
        database: databaseEvidence,
        cleanup: cleanupEvidence,
        postcheck: postcheckEvidence,
        now: options.now ?? new Date(),
        beforeInstall: options.testHooks?.beforePhaseReceiptInstall,
      });
      sequence = written.receipt.sequence + 1;
      previousReceiptSha256 = written.sha256;
      return written;
    };
    await appendPhase("scanned");
    if (!apply) {
      const verified = await appendPhase("verified");
      success = true;
      return { schemaVersion: SCHEMA_VERSION, status: "dry_run", remediationId, planSha256: plan.planSha256, counts: plan.counts, receiptPath: verified.path, receiptSha256: verified.sha256 };
    }
    await rm(stageRoot, { recursive: true, force: true });
    if (!resume) {
      const envelopePath = path.join(runDirectory, "rollback-envelope.aes256gcm");
      await options.testHooks?.beforeRollbackEnvelope?.(plan);
      backup = await writeEncryptedRollbackEnvelope(plan, db, options.keyFile, envelopePath);
      await appendPhase("backup_prepared");
      mutationStarted = true;
      envelopeInventory = await verifyExistingRollbackEnvelope(backup, options.keyFile, runDirectory);
    }
    await materializeStage(plan, stageRoot);
    await appendPhase("staged");
    databaseEvidence = await applyDatabaseMutations(db, plan, {
      allowOtherClients: options.testHooks?.allowOtherDatabaseClients === true,
      beforeMutations: async () => {
        await installStagedFiles(plan, stageRoot);
        await appendPhase("files_installed");
        await options.testHooks?.afterFilesInstalled?.();
      },
      beforeCommit: options.testHooks?.beforeDatabaseCommit,
    });
    await appendPhase("db_committed");
    await assertMaintenance(db, options.testHooks?.allowOtherDatabaseClients === true);
    const removedThisAttempt = await dedupeLegacySources(plan);
    const expectedLegacyRemovals = envelopeInventory?.expectedLegacyRemovals ?? plan.files.filter((file) => file.migrateToActive || file.dedupeLegacyAfterCommit).length;
    cleanupEvidence = {
      legacy_sources_expected: expectedLegacyRemovals,
      legacy_sources_removed_this_attempt: removedThisAttempt,
      legacy_sources_removed_total: expectedLegacyRemovals,
    };
    await appendPhase("source_deduped");
    await assertMaintenance(db, options.testHooks?.allowOtherDatabaseClients === true);
    await options.testHooks?.beforePostVerify?.();
    postcheckEvidence = await postVerify(db, plan);
    const verified = await appendPhase("verified");
    if (!backup) throw new CredentialRemediationError("rollback_envelope_missing", "Verified apply completed without a rollback envelope", true);
    success = true;
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "verified",
      remediationId,
      planSha256: plan.planSha256,
      approvedPlanSha256: backup.planSha256,
      counts: plan.counts,
      database: databaseEvidence,
      cleanup: cleanupEvidence,
      postcheck: postcheckEvidence,
      backupPath: backup.path,
      backupSha256: backup.sha256,
      receiptPath: verified.path,
      receiptSha256: verified.sha256,
    };
  } catch (error) {
    if (mutationStarted) {
      const plan = receiptChainValidated ? await buildProviderSessionCredentialRemediationPlan({
        db,
        remediationId,
        activeRoot: activeRoot.path,
        legacyRoot: legacyRoot.path,
        receiptRoot: receiptRoot.path,
        resume: true,
      }).catch(() => null) : null;
      if (plan) {
        const latest = await loadPhaseState(runDirectory, remediationId).catch(() => null);
        if (latest) {
          await writePhaseReceipt({
            plan,
            runDirectory,
            phase: "roll_forward_required",
            sequence: latest.nextSequence,
            apply,
            sameDevice: true,
            previousReceiptSha256: latest.previousReceiptSha256,
            backup: latest.backup ?? backup,
            database: latest.database ?? databaseEvidence,
            cleanup: latest.cleanup ?? cleanupEvidence,
            postcheck: latest.postcheck ?? postcheckEvidence,
            now: options.now ?? new Date(),
            beforeInstall: options.testHooks?.beforePhaseReceiptInstall,
          }).catch(() => undefined);
        }
      }
      if (error instanceof CredentialRemediationError) throw new CredentialRemediationError(error.code, error.message, true);
      throw new CredentialRemediationError("roll_forward_required", "Remediation stopped after filesystem mutation; retain the lock and resume forward", true);
    }
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    await releaseLock(lock, lock.resume || success || !mutationStarted, options.testHooks);
    if (success && resume) {
      await unlink(primaryLockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await fsyncDurabilityPoint(receiptRoot.path, "primary_lock_delete", options.testHooks);
    }
  }
}

function parseArgs(argv: string[]) {
  const options: Partial<ProviderSessionCredentialRemediationOptions> = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--active-root") options.activeRoot = argv[++index];
    else if (arg === "--legacy-root") options.legacyRoot = argv[++index];
    else if (arg === "--receipt-root") options.receiptRoot = argv[++index];
    else if (arg === "--remediation-id") options.remediationId = argv[++index];
    else if (arg === "--resume-id") options.resumeId = argv[++index];
    else if (arg === "--expected-plan-sha256") options.expectedPlanSha256 = argv[++index];
    else if (arg === "--connection-string" || /postgres(?:ql)?:\/\//i.test(arg)) {
      throw new CredentialRemediationError("connection_string_on_argv", "Connection strings are accepted only through DATABASE_URL");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: DATABASE_URL=<redacted> PAPERCLIP_CREDENTIAL_REMEDIATION_KEY_FILE=<absolute-owner-only-path> PAPERCLIP_CREDENTIAL_REMEDIATION_MAINTENANCE=I_HAVE_STOPPED_PAPERCLIP_WRITERS pnpm --filter @paperclipai/server exec tsx src/ops/provider-session-credential-remediation.ts --dry-run|--apply --active-root <path> --legacy-root <path> --receipt-root <path> [--remediation-id <id>] [--expected-plan-sha256 <sha256>] [--resume-id <id>]");
      process.exit(0);
    } else throw new CredentialRemediationError("unknown_argument", `Unknown argument: ${arg}`);
  }
  const required = ["activeRoot", "legacyRoot", "receiptRoot"] as const;
  for (const key of required) if (!options[key]) throw new CredentialRemediationError("missing_argument", `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  const keyFile = process.env.PAPERCLIP_CREDENTIAL_REMEDIATION_KEY_FILE;
  if (!keyFile) throw new CredentialRemediationError("missing_key_reference", "PAPERCLIP_CREDENTIAL_REMEDIATION_KEY_FILE is required");
  return {
    ...options,
    keyFile,
    maintenanceConfirmed: process.env.PAPERCLIP_CREDENTIAL_REMEDIATION_MAINTENANCE === MAINTENANCE_ACK,
  } as ProviderSessionCredentialRemediationOptions;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new CredentialRemediationError("missing_database_url", "DATABASE_URL is required and is accepted only through the environment");
  const db = createDb(providerSessionCredentialRemediationConnectionString(connectionString));
  try {
    const result = await runProviderSessionCredentialRemediation(db, options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = error instanceof CredentialRemediationError
      ? { status: "error", code: error.code, roll_forward_required: error.rollForwardRequired }
      : { status: "error", code: "unexpected_error", roll_forward_required: false };
    console.error(JSON.stringify(safe));
    process.exit(1);
  });
}
