import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  companies,
  createDb,
  routineTriggers,
  routines,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  configureProfitFlywheelCliRuntimeEnvironment,
  resolveProfitFlywheelCliConnection,
} from "./profit-flywheel-v2-migration.js";
import { prepareTrustedReceiptDirectory } from "./trusted-receipt-directory.js";

const EXCLUDED_REPOSITORY = "Glitch-Cipher-Syndicate/LeadForge";
const RECEIPT_SCHEMA = "paperclip.factory_leadforge_trigger_quarantine.v1";
const SHA256_RE = /^[0-9a-f]{64}$/;

type TriggerState = {
  trigger_id: string;
  routine_id: string;
  company_id: string;
  company_name: string;
  routine_title: string;
  routine_status: string;
  trigger_kind: string;
  enabled: boolean;
  cron_expression: string | null;
  timezone: string | null;
  next_run_at: string | null;
};

type QuarantineReceipt = {
  schema_version: typeof RECEIPT_SCHEMA;
  operation: "dry_run" | "apply" | "rollback";
  status: "planned" | "applied" | "rolled_back";
  observed_at: string;
  exact_exclusion: {
    repository: typeof EXCLUDED_REPOSITORY;
    matching: "exact_company_suffix";
  };
  history_preserved: true;
  deleted_row_count: 0;
  company_ids: string[];
  before_state_sha256: string;
  after_state_sha256: string;
  changes: Array<{
    trigger_id: string;
    routine_id: string;
    company_id: string;
    before: { enabled: true; next_run_at: string | null };
    after: { enabled: false; next_run_at: null };
  }>;
  rollback: {
    source_receipt_path: string | null;
    source_receipt_sha256: string | null;
    triggers: Array<{
      trigger_id: string;
      routine_id: string;
      company_id: string;
      enabled: true;
      next_run_at: string | null;
    }>;
  };
  invariant: {
    enabled_schedule_trigger_count: number;
    non_schedule_trigger_count: number;
    total_trigger_count: number;
  };
  receipt_payload_sha256: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(value: Buffer | string | unknown) {
  const bytes = Buffer.isBuffer(value) || typeof value === "string"
    ? value
    : stableJson(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function iso(value: Date | string | null) {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("factory_leadforge_quarantine_invalid_timestamp");
  return date.toISOString();
}

export function isExactLeadForgeCompanyName(name: string) {
  const suffix = name.split("::").at(-1)?.trim().toLowerCase();
  return suffix === EXCLUDED_REPOSITORY.toLowerCase();
}

export function buildLeadForgeQuarantinePlan(input: {
  companies: Array<{ id: string; name: string }>;
  triggers: TriggerState[];
}) {
  const companyIds = input.companies
    .filter((company) => isExactLeadForgeCompanyName(company.name))
    .map((company) => company.id)
    .sort();
  const companyIdSet = new Set(companyIds);
  const triggerState = input.triggers
    .filter((trigger) => companyIdSet.has(trigger.company_id))
    .sort((left, right) => left.trigger_id.localeCompare(right.trigger_id));
  const candidates = triggerState.filter(
    (trigger) => trigger.trigger_kind === "schedule" && trigger.enabled,
  );
  return {
    company_ids: companyIds,
    state: triggerState,
    state_sha256: sha256(triggerState),
    candidates,
    changes: candidates.map((trigger) => ({
      trigger_id: trigger.trigger_id,
      routine_id: trigger.routine_id,
      company_id: trigger.company_id,
      before: { enabled: true as const, next_run_at: trigger.next_run_at },
      after: { enabled: false as const, next_run_at: null },
    })),
  };
}

async function readState(db: Db) {
  const companyRows = await db.select({
    id: companies.id,
    name: companies.name,
  }).from(companies);
  const excludedCompanies = companyRows.filter((company) =>
    isExactLeadForgeCompanyName(company.name)
  );
  if (excludedCompanies.length === 0) {
    throw new Error("factory_leadforge_exact_exclusion_company_missing");
  }
  const companyIds = excludedCompanies.map((company) => company.id);
  const triggerRows = await db.select({
    triggerId: routineTriggers.id,
    routineId: routineTriggers.routineId,
    companyId: routineTriggers.companyId,
    companyName: companies.name,
    routineTitle: routines.title,
    routineStatus: routines.status,
    triggerKind: routineTriggers.kind,
    enabled: routineTriggers.enabled,
    cronExpression: routineTriggers.cronExpression,
    timezone: routineTriggers.timezone,
    nextRunAt: routineTriggers.nextRunAt,
  }).from(routineTriggers)
    .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
    .innerJoin(companies, eq(companies.id, routineTriggers.companyId))
    .where(inArray(routineTriggers.companyId, companyIds));
  return buildLeadForgeQuarantinePlan({
    companies: companyRows,
    triggers: triggerRows.map((row) => ({
      trigger_id: row.triggerId,
      routine_id: row.routineId,
      company_id: row.companyId,
      company_name: row.companyName,
      routine_title: row.routineTitle,
      routine_status: row.routineStatus,
      trigger_kind: row.triggerKind,
      enabled: row.enabled,
      cron_expression: row.cronExpression,
      timezone: row.timezone,
      next_run_at: iso(row.nextRunAt),
    })),
  });
}

function receiptWithPayloadHash(
  input: Omit<QuarantineReceipt, "receipt_payload_sha256">,
): QuarantineReceipt {
  return { ...input, receipt_payload_sha256: sha256(input) };
}

function invariant(state: TriggerState[]) {
  return {
    enabled_schedule_trigger_count: state.filter(
      (trigger) => trigger.trigger_kind === "schedule" && trigger.enabled,
    ).length,
    non_schedule_trigger_count: state.filter(
      (trigger) => trigger.trigger_kind !== "schedule",
    ).length,
    total_trigger_count: state.length,
  };
}

function parseRollbackReceipt(raw: unknown): QuarantineReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("factory_leadforge_rollback_receipt_invalid");
  }
  const receipt = raw as QuarantineReceipt;
  if (
    receipt.schema_version !== RECEIPT_SCHEMA ||
    receipt.operation !== "apply" ||
    receipt.status !== "applied" ||
    receipt.exact_exclusion?.repository !== EXCLUDED_REPOSITORY ||
    receipt.history_preserved !== true ||
    receipt.deleted_row_count !== 0 ||
    !Array.isArray(receipt.rollback?.triggers) ||
    !SHA256_RE.test(receipt.receipt_payload_sha256 ?? "")
  ) {
    throw new Error("factory_leadforge_rollback_receipt_invalid");
  }
  const { receipt_payload_sha256: claimed, ...payload } = receipt;
  if (sha256(payload) !== claimed) {
    throw new Error("factory_leadforge_rollback_payload_hash_mismatch");
  }
  for (const trigger of receipt.rollback.triggers) {
    if (
      typeof trigger.trigger_id !== "string" ||
      typeof trigger.routine_id !== "string" ||
      typeof trigger.company_id !== "string" ||
      trigger.enabled !== true ||
      (trigger.next_run_at !== null && Number.isNaN(Date.parse(trigger.next_run_at)))
    ) {
      throw new Error("factory_leadforge_rollback_trigger_invalid");
    }
  }
  return receipt;
}

export function parseFactoryLeadForgeQuarantineArgs(rawArgv: string[]) {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const options: {
    help: boolean;
    apply: boolean;
    homeDir?: string;
    instanceId?: string;
    receiptDir?: string;
    rollbackReceipt?: string;
    rollbackSha256?: string;
  } = { help: false, apply: false };
  const readValue = (flag: string, index: number) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--home") options.homeDir = readValue(arg, index++);
    else if (arg === "--instance-id") options.instanceId = readValue(arg, index++);
    else if (arg === "--receipt-dir") options.receiptDir = readValue(arg, index++);
    else if (arg === "--rollback-receipt") options.rollbackReceipt = readValue(arg, index++);
    else if (arg === "--rollback-sha256") options.rollbackSha256 = readValue(arg, index++);
    else if (arg === "--connection-string" || arg.startsWith("--connection-string=")) {
      throw new Error("factory_leadforge_quarantine_database_url_argv_forbidden");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.apply && options.rollbackReceipt) {
    throw new Error("--apply and --rollback-receipt are mutually exclusive");
  }
  if (options.rollbackReceipt && !options.rollbackSha256) {
    throw new Error("--rollback-sha256 is required with --rollback-receipt");
  }
  if (options.rollbackSha256 && !SHA256_RE.test(options.rollbackSha256)) {
    throw new Error("--rollback-sha256 must be a lowercase SHA-256");
  }
  for (const [flag, value] of [
    ["--receipt-dir", options.receiptDir],
    ["--rollback-receipt", options.rollbackReceipt],
  ] as const) {
    if (value && !path.isAbsolute(value)) throw new Error(`${flag} must be absolute`);
  }
  return options;
}

async function applyQuarantine(db: Db, observedAt: Date) {
  const before = await readState(db);
  const after = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const fresh = await readState(tx);
    if (fresh.state_sha256 !== before.state_sha256) {
      throw new Error("factory_leadforge_quarantine_state_drift");
    }
    for (const trigger of fresh.candidates) {
      await tx.update(routineTriggers).set({
        enabled: false,
        nextRunAt: null,
        updatedAt: observedAt,
      }).where(and(
        eq(routineTriggers.id, trigger.trigger_id),
        eq(routineTriggers.companyId, trigger.company_id),
        eq(routineTriggers.kind, "schedule"),
        eq(routineTriggers.enabled, true),
      ));
    }
    const post = await readState(tx);
    if (post.candidates.length !== 0) {
      throw new Error("factory_leadforge_quarantine_postcondition_failed");
    }
    return post;
  });
  return { before, after };
}

async function rollbackQuarantine(db: Db, receipt: QuarantineReceipt, observedAt: Date) {
  const before = await readState(db);
  const rollbackIds = receipt.rollback.triggers.map((trigger) => trigger.trigger_id).sort();
  const currentById = new Map(before.state.map((trigger) => [trigger.trigger_id, trigger]));
  for (const trigger of receipt.rollback.triggers) {
    const current = currentById.get(trigger.trigger_id);
    if (
      !current ||
      current.company_id !== trigger.company_id ||
      current.routine_id !== trigger.routine_id ||
      current.trigger_kind !== "schedule" ||
      current.enabled ||
      current.next_run_at !== null
    ) {
      throw new Error(`factory_leadforge_rollback_state_drift:${trigger.trigger_id}`);
    }
  }
  const after = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const fresh = await readState(tx);
    const freshById = new Map(fresh.state.map((trigger) => [trigger.trigger_id, trigger]));
    for (const triggerId of rollbackIds) {
      const baseline = currentById.get(triggerId);
      const current = freshById.get(triggerId);
      if (stableJson(current) !== stableJson(baseline)) {
        throw new Error(`factory_leadforge_rollback_state_drift:${triggerId}`);
      }
    }
    for (const trigger of receipt.rollback.triggers) {
      await tx.update(routineTriggers).set({
        enabled: true,
        nextRunAt: trigger.next_run_at ? new Date(trigger.next_run_at) : null,
        updatedAt: observedAt,
      }).where(and(
        eq(routineTriggers.id, trigger.trigger_id),
        eq(routineTriggers.companyId, trigger.company_id),
        eq(routineTriggers.kind, "schedule"),
        eq(routineTriggers.enabled, false),
      ));
    }
    return readState(tx);
  });
  return { before, after };
}

export async function runFactoryLeadForgeQuarantine(rawArgv = process.argv.slice(2)) {
  const options = parseFactoryLeadForgeQuarantineArgs(rawArgv);
  if (options.help) {
    console.log(
      "Usage: pnpm ops:factory-leadforge-quarantine -- --receipt-dir <absolute-dir> [--apply | --rollback-receipt <absolute-json> --rollback-sha256 <sha256>] [--home <path>] [--instance-id <id>]",
    );
    return null;
  }
  if (!options.receiptDir) throw new Error("--receipt-dir is required");
  configureProfitFlywheelCliRuntimeEnvironment(options);
  const connection = await resolveProfitFlywheelCliConnection(options);
  const db = createDb(connection.connectionString);
  try {
    const observedAt = new Date();
    const receiptDirectory = await prepareTrustedReceiptDirectory(
      options.receiptDir,
      "factory_leadforge_quarantine_receipt_directory",
    );
    let operation: QuarantineReceipt["operation"];
    let status: QuarantineReceipt["status"];
    let before: Awaited<ReturnType<typeof readState>>;
    let after: Awaited<ReturnType<typeof readState>>;
    let sourceReceiptPath: string | null = null;
    let sourceReceiptSha256: string | null = null;

    if (options.rollbackReceipt) {
      const bytes = await readFile(options.rollbackReceipt);
      const observedSha256 = sha256(bytes);
      if (observedSha256 !== options.rollbackSha256) {
        throw new Error("factory_leadforge_rollback_receipt_hash_mismatch");
      }
      const rollbackReceipt = parseRollbackReceipt(JSON.parse(bytes.toString("utf8")));
      ({ before, after } = await rollbackQuarantine(db, rollbackReceipt, observedAt));
      operation = "rollback";
      status = "rolled_back";
      sourceReceiptPath = options.rollbackReceipt;
      sourceReceiptSha256 = observedSha256;
    } else if (options.apply) {
      ({ before, after } = await applyQuarantine(db, observedAt));
      operation = "apply";
      status = "applied";
    } else {
      before = await readState(db);
      const projectedState = before.state.map((trigger) =>
        before.candidates.some((candidate) => candidate.trigger_id === trigger.trigger_id)
          ? { ...trigger, enabled: false, next_run_at: null }
          : trigger
      );
      after = {
        ...before,
        state: projectedState,
        state_sha256: sha256(projectedState),
        candidates: [],
        changes: [],
      };
      operation = "dry_run";
      status = "planned";
    }

    const changes = operation === "rollback" ? [] : before.changes;
    const rollbackTriggers = operation === "rollback"
      ? []
      : before.candidates.map((trigger) => ({
          trigger_id: trigger.trigger_id,
          routine_id: trigger.routine_id,
          company_id: trigger.company_id,
          enabled: true as const,
          next_run_at: trigger.next_run_at,
        }));
    const receipt = receiptWithPayloadHash({
      schema_version: RECEIPT_SCHEMA,
      operation,
      status,
      observed_at: observedAt.toISOString(),
      exact_exclusion: {
        repository: EXCLUDED_REPOSITORY,
        matching: "exact_company_suffix",
      },
      history_preserved: true,
      deleted_row_count: 0,
      company_ids: before.company_ids,
      before_state_sha256: before.state_sha256,
      after_state_sha256: after.state_sha256,
      changes,
      rollback: {
        source_receipt_path: sourceReceiptPath,
        source_receipt_sha256: sourceReceiptSha256,
        triggers: rollbackTriggers,
      },
      invariant: invariant(after.state),
    });
    const timestamp = receipt.observed_at.replace(/[-:.]/g, "");
    const receiptPath = path.join(
      receiptDirectory,
      `${timestamp}-leadforge-trigger-${operation}.json`,
    );
    const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
    const output = {
      schema_version: "paperclip.factory_leadforge_trigger_quarantine_publish.v1",
      status,
      operation,
      receipt_path: receiptPath,
      receipt_sha256: receiptSha256,
      changed_trigger_count: changes.length,
      enabled_schedule_trigger_count: receipt.invariant.enabled_schedule_trigger_count,
      history_preserved: true,
      deleted_row_count: 0,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await connection.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFactoryLeadForgeQuarantine().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "factory_leadforge_quarantine_unknown_failure",
    }));
    process.exit(1);
  });
}
