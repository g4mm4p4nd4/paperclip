import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  createDb,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/sonnet-service-window/runs";
const SERVICE_WINDOW_VERSION = "approved-sonnet-service-window.v1";
const NON_INVOCABLE_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

type JsonRecord = Record<string, unknown>;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type ServiceWindowOptions = {
  action: "run";
  durationMinutes: number;
  tickSeconds: number;
  drainTimeoutMinutes: number;
  drainPollSeconds: number;
  recoverLookbackMinutes: number;
  model: string;
  maxTurnsPerRun: number;
  command: string;
  geminiCommand: string;
  dryRun: boolean;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  agentIds?: string[];
};

type RestoreReceiptOptions = {
  action: "restore_receipt";
  receiptPath: string;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  markFailedReason?: string;
};

type CliOptions = ServiceWindowOptions | RestoreReceiptOptions;

type CandidateAgent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  adapterConfig: JsonRecord;
  runtimeConfig: JsonRecord;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
};

type PlannedOverlay = {
  agentId: string;
  companyId: string;
  agentName: string;
  role: string;
  previousAdapterConfig: JsonRecord;
  nextAdapterConfig: JsonRecord;
  changed: boolean;
  intervalSec: number;
  elapsedSecAtStart: number;
  dueAtStart: boolean;
  dueWithinWindow: boolean;
};

type TickReceipt = {
  iteration: number;
  at: string;
  activeRunsBefore: number;
  activeRunsAfter: number;
  tick: Awaited<ReturnType<ReturnType<typeof heartbeatService>["tickTimers"]>>;
  recoveries: RecoveryReceipt[];
};

type RecoveryReceipt = {
  at: string;
  failedRunId: string;
  agentId: string;
  agentName: string;
  queuedRunId: string | null;
  status: string | null;
  skippedReason?: string;
};

type ActiveWindowRunSnapshot = {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  processPid: number | null;
  processGroupId: number | null;
  createdAt: string;
  startedAt: string | null;
  lastOutputAt: string | null;
  lane: string | null;
  model: string | null;
};

type DrainReceipt = {
  status: "not_started" | "running" | "completed" | "cancelling" | "cancelled" | "timed_out";
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  timeoutMinutes: number;
  pollSeconds: number;
  trackedRunIds?: string[];
  checks: Array<{
    at: string;
    activeRuns: number;
    runs: ActiveWindowRunSnapshot[];
    ignoredRuns?: ActiveWindowRunSnapshot[];
  }>;
  remaining: ActiveWindowRunSnapshot[];
  cancelled: Array<{ runId: string; ok: boolean; error?: string }>;
};

type ServiceWindowReceipt = {
  version: string;
  status: "dry_run" | "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  connectionSource: string;
  options: {
    durationMinutes: number;
    tickSeconds: number;
    drainTimeoutMinutes: number;
    drainPollSeconds: number;
    recoverLookbackMinutes: number;
    model: string;
    maxTurnsPerRun: number;
    command: string;
    geminiCommand: string;
    agentIds: string[] | null;
  };
  counts: {
    candidates: number;
    overlaysChanged: number;
    dueAtStart: number;
    dueWithinWindow: number;
    restoreAttempts: number;
    restoreSucceeded: number;
    restoreFailed: number;
  };
  planned: PlannedOverlay[];
  ticks: TickReceipt[];
  drain: DrainReceipt;
  recentRuns: Array<Record<string, unknown>>;
  recoveries: RecoveryReceipt[];
  restored: Array<{ agentId: string; ok: boolean; error?: string }>;
  receiptPath: string | null;
  error?: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonRecord) }
    : {};
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function expandHome(input: string) {
  if (!input.startsWith("~")) return input;
  return path.join(process.env.HOME ?? "", input.slice(1));
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

export async function loadInstanceEnvFile(homeDir: string, instanceId: string) {
  const envPath = path.join(homeDir, "instances", instanceId, ".env");
  let contents: string;
  try {
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: envPath, loaded: false, loadedKeys: [] as string[] };
    }
    throw error;
  }

  const parsed = parseEnvFileContents(contents);
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    process.env[key] = value;
    loadedKeys.push(key);
  }

  return { path: envPath, loaded: true, loadedKeys };
}

function resolveConnectionString(config: ConfigFile, explicit?: string) {
  if (explicit?.trim()) return { connectionString: explicit.trim(), source: "explicit" };
  if (process.env.DATABASE_URL?.trim()) return { connectionString: process.env.DATABASE_URL.trim(), source: "DATABASE_URL" };
  if (config.database?.connectionString?.trim()) {
    return { connectionString: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }
  const port = config.database?.embeddedPostgresPort ?? 54329;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

function receiptFilePath(homeDir: string, instanceId: string, receiptDir?: string) {
  const root = path.resolve(path.join(homeDir, "instances", instanceId), receiptDir ?? DEFAULT_RECEIPT_DIR);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return path.join(root, `${stamp}Z.json`);
}

function heartbeatPolicy(runtimeConfig: JsonRecord) {
  const heartbeat = asRecord(runtimeConfig.heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled),
    intervalSec: Math.max(0, Math.trunc(asNumber(heartbeat.intervalSec))),
  };
}

export function buildApprovedSonnetFallbackConfig(
  current: JsonRecord,
  opts: { model: string; maxTurnsPerRun: number; command: string; geminiCommand?: string },
): JsonRecord {
  const policy = asRecord(current.tieredExecution ?? current.executionRouting);
  const hermesMiniMax = asRecord(policy.hermes_minimax ?? policy.hermesLocal ?? policy.hermes_local);
  const claudeLocal = asRecord(policy.claude_local ?? policy.claude);
  const geminiLocal = asRecord(policy.gemini_local ?? policy.gemini);
  const claudeOverrideModel = asNonEmptyString(opts.model);
  const claudeFallbackConfig: JsonRecord = {
    ...claudeLocal,
    command: opts.command,
    authMode: "subscription",
    effort: asNonEmptyString(claudeLocal.effort) ?? undefined,
    maxTurnsPerRun: opts.maxTurnsPerRun,
    dangerouslySkipPermissions: true,
  };
  delete claudeFallbackConfig.model;
  if (claudeOverrideModel && claudeOverrideModel !== "role_default") {
    claudeFallbackConfig.model = claudeOverrideModel;
  }
  const nextPolicy: JsonRecord = {
    ...policy,
    enabled: true,
    minimaxPrimary: true,
    adapterOrder: ["hermes_minimax", "gemini_local", "claude_local"],
    approvePostMiniMaxFallback: true,
    approvedPostMiniMaxFallback: true,
    allowPostMiniMaxFallbacks: true,
    approvePaidSubscriptionFallback: true,
    approvedPaidSubscriptionFallback: true,
    allowPaidSubscriptionFallbacks: true,
    hermes_minimax: {
      ...hermesMiniMax,
      provider: "minimax",
      model: asNonEmptyString(hermesMiniMax.model) ?? "MiniMax-M3",
      disableFallbackModel: true,
    },
    gemini_local: {
      ...geminiLocal,
      command: asNonEmptyString(opts.geminiCommand) ?? "gemini",
      authMode: "subscription",
      sandbox: geminiLocal.sandbox === true,
    },
    claude_local: claudeFallbackConfig,
  };

  return {
    ...current,
    disableFallbackModel: true,
    tieredExecution: nextPolicy,
  };
}

export function planApprovedSonnetServiceWindowAgents(
  allAgents: CandidateAgent[],
  opts: {
    now: Date;
    durationMinutes: number;
    model: string;
    maxTurnsPerRun: number;
    command: string;
    geminiCommand?: string;
    agentIds?: string[];
  },
): PlannedOverlay[] {
  const allowIds = opts.agentIds && opts.agentIds.length > 0 ? new Set(opts.agentIds) : null;
  const durationSec = Math.max(0, opts.durationMinutes * 60);

  return allAgents
    .filter((agent) => agent.adapterType === "hermes_local")
    .filter((agent) => !NON_INVOCABLE_STATUSES.has(agent.status))
    .filter((agent) => !allowIds || allowIds.has(agent.id))
    .map((agent) => {
      const policy = heartbeatPolicy(agent.runtimeConfig);
      if (!policy.enabled || policy.intervalSec <= 0) return null;
      const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
      const elapsedSec = Math.max(0, Math.floor((opts.now.getTime() - baseline) / 1000));
      const nextAdapterConfig = buildApprovedSonnetFallbackConfig(agent.adapterConfig, opts);
      return {
        agentId: agent.id,
        companyId: agent.companyId,
        agentName: agent.name,
        role: agent.role,
        previousAdapterConfig: agent.adapterConfig,
        nextAdapterConfig,
        changed: stableJson(agent.adapterConfig) !== stableJson(nextAdapterConfig),
        intervalSec: policy.intervalSec,
        elapsedSecAtStart: elapsedSec,
        dueAtStart: elapsedSec >= policy.intervalSec,
        dueWithinWindow: elapsedSec + durationSec >= policy.intervalSec,
      };
    })
    .filter((entry): entry is PlannedOverlay => entry !== null && entry.dueWithinWindow);
}

async function collectCandidateAgents(db: Db): Promise<CandidateAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      createdAt: agents.createdAt,
    })
    .from(agents);

  return rows.map((row) => ({
    ...row,
    adapterConfig: asRecord(row.adapterConfig),
    runtimeConfig: asRecord(row.runtimeConfig),
  }));
}

async function activeRunCount(db: Db) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));
  return Number(row?.count ?? 0);
}

async function activeRunCountForAgent(db: Db, agentId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
  return Number(row?.count ?? 0);
}

async function activeWindowRunSnapshot(
  db: Db,
  plannedAgentIds: Set<string>,
  since: Date,
): Promise<ActiveWindowRunSnapshot[]> {
  const agentIds = [...plannedAgentIds];
  if (agentIds.length === 0) return [];
  const cutoffIso = since.toISOString();
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(
      and(
        inArray(heartbeatRuns.agentId, agentIds),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.createdAt} >= ${cutoffIso}::timestamptz`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(250);

  return rows.map((row) => {
    const routing = asRecord(asRecord(row.contextSnapshot).paperclipExecutionRouting);
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      status: row.status,
      processPid: row.processPid ?? null,
      processGroupId: row.processGroupId ?? null,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      lastOutputAt: row.lastOutputAt?.toISOString() ?? null,
      lane: asNonEmptyString(routing.selectedLane),
      model: asNonEmptyString(routing.model),
    };
  });
}

async function recentRunSnapshot(db: Db, since: Date) {
  const cutoffIso = since.toISOString();
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      errorCode: heartbeatRuns.errorCode,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(sql`${heartbeatRuns.createdAt} >= ${cutoffIso}::timestamptz`)
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(200);

  return rows.map((row) => ({
    ...row,
    contextSnapshot: asRecord(row.contextSnapshot),
  }));
}

async function recoverRecentMiniMaxQuotaFailures(input: {
  db: Db;
  heartbeat: ReturnType<typeof heartbeatService>;
  since: Date;
  plannedAgentIds: Set<string>;
}) {
  if (input.plannedAgentIds.size === 0) return [] as RecoveryReceipt[];

  const cutoffIso = input.since.toISOString();
  const rows = await input.db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(sql`${heartbeatRuns.createdAt} >= ${cutoffIso}::timestamptz`)
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(250);

  const recoveredRunIds = new Set<string>();
  for (const row of rows) {
    const routing = asRecord(asRecord(row.contextSnapshot).paperclipExecutionRouting);
    const recovered = asNonEmptyString(routing.recoveryOfRunId);
    if (recovered) recoveredRunIds.add(recovered);
    const topLevelRecovered = asNonEmptyString(asRecord(row.contextSnapshot).providerQuotaRecoveryOfRunId);
    if (topLevelRecovered) recoveredRunIds.add(topLevelRecovered);
  }

  const recoveries: RecoveryReceipt[] = [];
  const failedRuns = rows
    .filter((row) => input.plannedAgentIds.has(row.agentId))
    .filter((row) => row.status === "failed" && row.errorCode === "provider_quota_failure")
    .filter((row) => {
      const routing = asRecord(asRecord(row.contextSnapshot).paperclipExecutionRouting);
      return asNonEmptyString(routing.selectedLane) === "hermes_minimax";
    })
    .filter((row) => !recoveredRunIds.has(row.id))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  for (const failed of failedRuns) {
    const at = new Date().toISOString();
    const activeRuns = await activeRunCountForAgent(input.db, failed.agentId);
    if (activeRuns > 0) {
      recoveries.push({
        at,
        failedRunId: failed.id,
        agentId: failed.agentId,
        agentName: failed.agentName,
        queuedRunId: null,
        status: null,
        skippedReason: "already_active",
      });
      continue;
    }

    const run = await input.heartbeat.wakeup(failed.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "sonnet_service_window_provider_quota_recovery",
      requestedByActorType: "system",
      requestedByActorId: "codex_sonnet_service_window",
      contextSnapshot: {
        source: "sonnet_service_window",
        wakeReason: "provider_quota_recovery",
        providerQuotaRecoveryOfRunId: failed.id,
        paperclipExecutionRouting: {
          forceTieredFallback: true,
          approvePostMiniMaxFallback: true,
          approvedPostMiniMaxFallback: true,
          allowPostMiniMaxFallbacks: true,
          approvePaidSubscriptionFallback: true,
          approvedPaidSubscriptionFallback: true,
          allowPaidSubscriptionFallbacks: true,
          recoveryOfRunId: failed.id,
        },
      },
    });

    recoveries.push({
      at,
      failedRunId: failed.id,
      agentId: failed.agentId,
      agentName: failed.agentName,
      queuedRunId: run?.id ?? null,
      status: run?.status ?? null,
      ...(run ? {} : { skippedReason: "wakeup_skipped" }),
    });
  }

  return recoveries;
}

async function applyOverlays(db: Db, planned: PlannedOverlay[]) {
  for (const entry of planned) {
    if (!entry.changed) continue;
    await db
      .update(agents)
      .set({ adapterConfig: entry.nextAdapterConfig, updatedAt: new Date() })
      .where(eq(agents.id, entry.agentId));
  }
}

async function restoreOverlays(db: Db, planned: PlannedOverlay[]) {
  const results: Array<{ agentId: string; ok: boolean; error?: string }> = [];
  for (const entry of planned) {
    if (!entry.changed) continue;
    try {
      await db
        .update(agents)
        .set({ adapterConfig: entry.previousAdapterConfig, updatedAt: new Date() })
        .where(eq(agents.id, entry.agentId));
      results.push({ agentId: entry.agentId, ok: true });
    } catch (error) {
      results.push({
        agentId: entry.agentId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function writeReceipt(receipt: ServiceWindowReceipt) {
  if (!receipt.receiptPath) return;
  await mkdir(path.dirname(receipt.receiptPath), { recursive: true });
  await writeFile(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function readReceipt(receiptPath: string): Promise<ServiceWindowReceipt> {
  return JSON.parse(await readFile(receiptPath, "utf8")) as ServiceWindowReceipt;
}

export async function restoreApprovedSonnetServiceWindowFromReceipt(
  db: Db,
  receiptPath: string,
  opts: { markFailedReason?: string } = {},
) {
  const receipt = await readReceipt(receiptPath);
  receipt.receiptPath = receiptPath;
  receipt.restored = await restoreOverlays(db, receipt.planned ?? []);
  receipt.counts.restoreAttempts = receipt.restored.length;
  receipt.counts.restoreSucceeded = receipt.restored.filter((entry) => entry.ok).length;
  receipt.counts.restoreFailed = receipt.restored.filter((entry) => !entry.ok).length;
  receipt.recentRuns = await recentRunSnapshot(db, new Date(receipt.startedAt));
  receipt.finishedAt = new Date().toISOString();
  if (opts.markFailedReason) {
    receipt.status = "failed";
    receipt.error = opts.markFailedReason;
  } else if (receipt.status === "running") {
    receipt.status = receipt.counts.restoreFailed > 0 ? "failed" : "completed";
  }
  await writeReceipt(receipt);
  return receipt;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function drainServiceWindowActiveRuns(input: {
  receipt: ServiceWindowReceipt;
  snapshotActiveRuns: () => Promise<ActiveWindowRunSnapshot[]>;
  cancelRun: (runId: string, reason?: string) => Promise<unknown>;
  writeReceipt: (receipt: ServiceWindowReceipt) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  cancelGraceMs?: number;
  cancelReason: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = input.now ?? Date.now;
  const sleepFn = input.sleep ?? sleep;
  const timeoutMs = Math.max(0, input.timeoutMs);
  const pollMs = Math.max(250, input.pollMs);
  const cancelGraceMs = Math.max(0, input.cancelGraceMs ?? 60_000);
  const startedAtMs = now();
  const deadlineMs = startedAtMs + timeoutMs;
  let trackedRunIds: Set<string> | null = null;
  input.receipt.drain = {
    ...input.receipt.drain,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    deadlineAt: new Date(deadlineMs).toISOString(),
    timeoutMinutes: timeoutMs / 60_000,
    pollSeconds: pollMs / 1000,
    trackedRunIds: input.receipt.drain.trackedRunIds ?? [],
    checks: input.receipt.drain.checks ?? [],
    remaining: [],
    cancelled: input.receipt.drain.cancelled ?? [],
  };

  const snapshotTrackedRuns = async () => {
    const active = await input.snapshotActiveRuns();
    if (!trackedRunIds) {
      trackedRunIds = new Set(active.map((run) => run.id));
      input.receipt.drain.trackedRunIds = [...trackedRunIds];
      return { active, ignored: [] as ActiveWindowRunSnapshot[] };
    }
    const tracked = active.filter((run) => trackedRunIds?.has(run.id));
    const ignored = active.filter((run) => !trackedRunIds?.has(run.id));
    return { active: tracked, ignored };
  };

  const recordCheck = async (active: ActiveWindowRunSnapshot[], ignored: ActiveWindowRunSnapshot[] = []) => {
    input.receipt.drain.checks.push({
      at: new Date(now()).toISOString(),
      activeRuns: active.length,
      runs: active,
      ...(ignored.length > 0 ? { ignoredRuns: ignored } : {}),
    });
    input.receipt.drain.remaining = active;
    await input.writeReceipt(input.receipt);
  };

  while (true) {
    const { active, ignored } = await snapshotTrackedRuns();
    await recordCheck(active, ignored);
    if (active.length === 0) {
      input.receipt.drain.status = "completed";
      input.receipt.drain.finishedAt = new Date(now()).toISOString();
      input.receipt.drain.remaining = [];
      await input.writeReceipt(input.receipt);
      return { settled: true, cancelled: false, activeRuns: [] as ActiveWindowRunSnapshot[] };
    }

    if (now() >= deadlineMs) {
      input.receipt.drain.status = "cancelling";
      await input.writeReceipt(input.receipt);
      for (const run of active) {
        try {
          await input.cancelRun(run.id, input.cancelReason);
          input.receipt.drain.cancelled.push({ runId: run.id, ok: true });
        } catch (error) {
          input.receipt.drain.cancelled.push({
            runId: run.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await input.writeReceipt(input.receipt);

      const cancelDeadlineMs = now() + cancelGraceMs;
      while (true) {
        const { active: remaining, ignored: ignoredRemaining } = await snapshotTrackedRuns();
        await recordCheck(remaining, ignoredRemaining);
        if (remaining.length === 0) {
          input.receipt.drain.status = "cancelled";
          input.receipt.drain.finishedAt = new Date(now()).toISOString();
          input.receipt.drain.remaining = [];
          await input.writeReceipt(input.receipt);
          return { settled: true, cancelled: true, activeRuns: [] as ActiveWindowRunSnapshot[] };
        }
        if (now() >= cancelDeadlineMs) {
          input.receipt.drain.status = "timed_out";
          input.receipt.drain.finishedAt = new Date(now()).toISOString();
          input.receipt.drain.remaining = remaining;
          await input.writeReceipt(input.receipt);
          return { settled: false, cancelled: true, activeRuns: remaining };
        }
        await sleepFn(Math.min(pollMs, Math.max(0, cancelDeadlineMs - now())));
      }
    }

    await sleepFn(Math.min(pollMs, Math.max(0, deadlineMs - now())));
  }
}

export async function runApprovedSonnetServiceWindow(db: Db, options: ServiceWindowOptions & { connectionSource: string }) {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const deadlineMs = startedAtDate.getTime() + options.durationMinutes * 60 * 1000;
  const deadlineAt = new Date(deadlineMs).toISOString();
  const allAgents = await collectCandidateAgents(db);
  const planned = planApprovedSonnetServiceWindowAgents(allAgents, {
    now: startedAtDate,
    durationMinutes: options.durationMinutes,
    model: options.model,
    maxTurnsPerRun: options.maxTurnsPerRun,
    command: options.command,
    geminiCommand: options.geminiCommand,
    agentIds: options.agentIds,
  });

  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const receipt: ServiceWindowReceipt = {
    version: SERVICE_WINDOW_VERSION,
    status: options.dryRun ? "dry_run" : "running",
    startedAt,
    finishedAt: null,
    deadlineAt,
    connectionSource: options.connectionSource,
    options: {
      durationMinutes: options.durationMinutes,
      tickSeconds: options.tickSeconds,
      drainTimeoutMinutes: options.drainTimeoutMinutes,
      drainPollSeconds: options.drainPollSeconds,
      recoverLookbackMinutes: options.recoverLookbackMinutes,
      model: options.model,
      maxTurnsPerRun: options.maxTurnsPerRun,
      command: options.command,
      geminiCommand: options.geminiCommand,
      agentIds: options.agentIds ?? null,
    },
    counts: {
      candidates: planned.length,
      overlaysChanged: planned.filter((entry) => entry.changed).length,
      dueAtStart: planned.filter((entry) => entry.dueAtStart).length,
      dueWithinWindow: planned.filter((entry) => entry.dueWithinWindow).length,
      restoreAttempts: 0,
      restoreSucceeded: 0,
      restoreFailed: 0,
    },
    planned,
    ticks: [],
    drain: {
      status: "not_started",
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      timeoutMinutes: options.drainTimeoutMinutes,
      pollSeconds: options.drainPollSeconds,
      checks: [],
      remaining: [],
      cancelled: [],
    },
    recentRuns: [],
    recoveries: [],
    restored: [],
    receiptPath: receiptFilePath(homeDir, instanceId, options.receiptDir),
  };

  await writeReceipt(receipt);
  if (options.dryRun) {
    receipt.finishedAt = new Date().toISOString();
    await writeReceipt(receipt);
    return receipt;
  }

  const heartbeat = heartbeatService(db);
  const plannedAgentIds = new Set(planned.map((entry) => entry.agentId));
  const recoverySince = new Date(
    Math.min(startedAtDate.getTime(), Date.now() - options.recoverLookbackMinutes * 60 * 1000),
  );
  let restorePromise: Promise<void> | null = null;
  const restore = async (opts: { finalize?: boolean } = {}) => {
    restorePromise ??= (async () => {
      receipt.restored = await restoreOverlays(db, planned);
      receipt.counts.restoreAttempts = receipt.restored.length;
      receipt.counts.restoreSucceeded = receipt.restored.filter((entry) => entry.ok).length;
      receipt.counts.restoreFailed = receipt.restored.filter((entry) => !entry.ok).length;
    })();
    await restorePromise;
    receipt.recentRuns = await recentRunSnapshot(db, startedAtDate);
    if (opts.finalize !== false) receipt.finishedAt = new Date().toISOString();
    await writeReceipt(receipt);
  };

  const drainWindowRuns = (overrides: Partial<{
    timeoutMs: number;
    pollMs: number;
    cancelGraceMs: number;
    cancelReason: string;
  }> = {}) =>
    drainServiceWindowActiveRuns({
      receipt,
      snapshotActiveRuns: () => activeWindowRunSnapshot(db, plannedAgentIds, startedAtDate),
      cancelRun: (runId, reason) => heartbeat.cancelRun(runId, reason),
      writeReceipt,
      timeoutMs: overrides.timeoutMs ?? options.drainTimeoutMinutes * 60 * 1000,
      pollMs: overrides.pollMs ?? options.drainPollSeconds * 1000,
      cancelGraceMs: overrides.cancelGraceMs,
      cancelReason:
        overrides.cancelReason ??
        `Cancelled because ${SERVICE_WINDOW_VERSION} drain timed out after ${options.drainTimeoutMinutes} minutes`,
    });

  const handleSignal = (signal: NodeJS.Signals) => {
    receipt.status = "failed";
    receipt.error = `Interrupted by ${signal}; temporary overlays restored, then active service-window runs drained or cancelled.`;
    const forceExit = setTimeout(() => {
      console.error(`restore timed out after ${signal}; use --restore-receipt ${receipt.receiptPath ?? "<receipt>"}`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }, 90_000);
    restore({ finalize: false })
      .then(() =>
        drainWindowRuns({
          timeoutMs: 30_000,
          pollMs: 1_000,
          cancelGraceMs: 30_000,
          cancelReason: `Cancelled because ${SERVICE_WINDOW_VERSION} was interrupted by ${signal}`,
        }),
      )
      .catch((error) => {
        console.error(`restore/drain failed after ${signal}:`, error);
      })
      .then(() => restore())
      .catch((error) => {
        console.error(`restore failed after ${signal}:`, error);
      })
      .finally(() => {
        clearTimeout(forceExit);
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await applyOverlays(db, planned);
    await writeReceipt(receipt);

    let iteration = 0;
    while (Date.now() < deadlineMs) {
      iteration += 1;
      const at = new Date().toISOString();
      const activeRunsBefore = await activeRunCount(db);
      const tick = await heartbeat.tickTimers(new Date());
      const recoveries = await recoverRecentMiniMaxQuotaFailures({
        db,
        heartbeat,
        since: recoverySince,
        plannedAgentIds,
      });
      const activeRunsAfter = await activeRunCount(db);
      receipt.ticks.push({
        iteration,
        at,
        activeRunsBefore,
        activeRunsAfter,
        tick,
        recoveries,
      });
      receipt.recoveries.push(...recoveries);
      await writeReceipt(receipt);

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(options.tickSeconds * 1000, remainingMs));
    }

    await restore({ finalize: false });
    const drain = await drainWindowRuns();
    if (!drain.settled) {
      receipt.status = "failed";
      receipt.error = `Timed out draining ${drain.activeRuns.length} active service-window run(s); temporary overlays restored after cancellation attempt.`;
    } else if (drain.cancelled) {
      receipt.status = "failed";
      receipt.error = "Service-window drain timeout cancelled active run(s) before temporary overlays were restored.";
    } else {
      receipt.status = "completed";
    }
    await writeReceipt(receipt);
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeReceipt(receipt);
    throw error;
  } finally {
    await restore();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: ServiceWindowOptions = {
    action: "run",
    durationMinutes: 60,
    tickSeconds: 60,
    drainTimeoutMinutes: 20,
    drainPollSeconds: 5,
    recoverLookbackMinutes: 30,
    model: "role_default",
    maxTurnsPerRun: 25,
    command: "/opt/homebrew/bin/claude",
    geminiCommand: "/opt/homebrew/bin/gemini",
    dryRun: true,
  };
  let restoreReceiptPath: string | null = null;
  let markFailedReason: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.dryRun = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--duration-minutes") options.durationMinutes = asNumber(argv[++index], options.durationMinutes);
    else if (arg === "--tick-seconds") options.tickSeconds = asNumber(argv[++index], options.tickSeconds);
    else if (arg === "--drain-timeout-minutes") options.drainTimeoutMinutes = asNumber(argv[++index], options.drainTimeoutMinutes);
    else if (arg === "--drain-poll-seconds") options.drainPollSeconds = asNumber(argv[++index], options.drainPollSeconds);
    else if (arg === "--recover-lookback-minutes") options.recoverLookbackMinutes = asNumber(argv[++index], options.recoverLookbackMinutes);
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--max-turns-per-run") options.maxTurnsPerRun = Math.max(1, Math.trunc(asNumber(argv[++index], options.maxTurnsPerRun)));
    else if (arg === "--command") options.command = argv[++index];
    else if (arg === "--gemini-command") options.geminiCommand = argv[++index];
    else if (arg === "--connection-string") options.connectionString = argv[++index];
    else if (arg === "--home") options.homeDir = argv[++index];
    else if (arg === "--instance-id") options.instanceId = argv[++index];
    else if (arg === "--receipt-dir") options.receiptDir = argv[++index];
    else if (arg === "--agent-id") options.agentIds = [...(options.agentIds ?? []), argv[++index]];
    else if (arg === "--restore-receipt") restoreReceiptPath = argv[++index];
    else if (arg === "--mark-failed-reason") markFailedReason = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: tsx src/ops/approved-sonnet-service-window.ts --dry-run|--apply [options]",
        "       tsx src/ops/approved-sonnet-service-window.ts --restore-receipt <path> [--mark-failed-reason <text>]",
        "",
        "Options:",
        "  --duration-minutes <n>   Service-window duration (default: 60)",
        "  --tick-seconds <n>       Scheduler tick interval (default: 60)",
        "  --drain-timeout-minutes <n> Wait this long for service-window runs before cancelling (default: 20)",
        "  --drain-poll-seconds <n> Poll interval while draining active service-window runs (default: 5)",
        "  --recover-lookback-minutes <n> Recover recent MiniMax quota failures (default: 30)",
        "  --model <id>             Optional Claude fallback model override (default: role_default)",
        "  --max-turns-per-run <n>  Claude max turns per run (default: 25)",
        "  --command <path>         Claude command path (default: /opt/homebrew/bin/claude)",
        "  --gemini-command <path>  Gemini command path (default: /opt/homebrew/bin/gemini)",
        "  --agent-id <uuid>        Restrict to one agent; repeatable",
        "  --connection-string <url> Override database connection string",
        "  --home <path>            Paperclip home directory",
        "  --instance-id <id>       Paperclip instance id",
        "  --receipt-dir <path>     Receipt dir relative to instance root",
        "  --restore-receipt <path> Restore temporary overlays saved in an existing receipt",
        "  --mark-failed-reason <text> Mark restored receipt failed with this reason",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (restoreReceiptPath) {
    return {
      action: "restore_receipt",
      receiptPath: restoreReceiptPath,
      connectionString: options.connectionString,
      homeDir: options.homeDir,
      instanceId: options.instanceId,
      markFailedReason,
    };
  }

  if (markFailedReason) throw new Error("--mark-failed-reason requires --restore-receipt");
  options.durationMinutes = Math.max(0, options.durationMinutes);
  options.tickSeconds = Math.max(5, options.tickSeconds);
  options.drainTimeoutMinutes = Math.max(0, options.drainTimeoutMinutes);
  options.drainPollSeconds = Math.max(1, options.drainPollSeconds);
  if (!options.model.trim()) throw new Error("--model cannot be empty");
  if (!options.command.trim()) throw new Error("--command cannot be empty");
  if (!options.geminiCommand.trim()) throw new Error("--gemini-command cannot be empty");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const homeDir = path.resolve(expandHome(options.homeDir ?? DEFAULT_HOME));
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  await loadInstanceEnvFile(homeDir, instanceId);
  const config = await readConfig(homeDir, instanceId);
  const { connectionString, source } = resolveConnectionString(config, options.connectionString);
  const db = createDb(connectionString);
  try {
    const result =
      options.action === "restore_receipt"
        ? await restoreApprovedSonnetServiceWindowFromReceipt(db, path.resolve(options.receiptPath), {
            markFailedReason: options.markFailedReason,
          })
        : await runApprovedSonnetServiceWindow(db, {
            ...options,
            homeDir,
            instanceId,
            connectionSource: source,
          });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
