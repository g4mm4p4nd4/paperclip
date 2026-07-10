import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  formatDatabaseBackupResult,
  issues,
  routineTriggers,
  routines,
  runDatabaseBackup,
  type Db,
} from "@paperclipai/db";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/agent-autonomy-recovery/runs";
const RECOVERY_VERSION = "agent-autonomy-recovery.v1";
const NON_INVOCABLE_STATUSES = new Set(["terminated", "pending_approval"]);
const SYNTHETIC_AGENT_NAME_RE = /(^|[-_\s])test($|[-_\s])/i;

type JsonRecord = Record<string, unknown>;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
    backup?: {
      dir?: string;
      retentionDays?: number;
    };
  };
};

export type RecoveryAgentInput = {
  id: string;
  companyId: string;
  issuePrefix: string;
  companyName: string;
  name: string;
  role: string;
  status: string;
  runtimeConfig: Record<string, unknown>;
  activeRoutineCount: number;
  actionableAssignedOpenIssueCount: number;
};

export type PlannedAgentRecovery = {
  agentId: string;
  companyId: string;
  issuePrefix: string;
  companyName: string;
  agentName: string;
  role: string;
  previousStatus: string;
  nextStatus: string;
  previousHeartbeat: Record<string, unknown>;
  nextHeartbeat: Record<string, unknown>;
  reasons: string[];
  changed: boolean;
};

type RecoveryOptions = {
  dryRun: boolean;
  backup?: boolean;
  includePaused?: boolean;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
};

type RecoveryResult = {
  status: "dry_run" | "applied";
  recoveryVersion: string;
  startedAt: string;
  finishedAt: string;
  connectionSource: string;
  backup: null | {
    path: string | null;
    summary: string;
  };
  counts: {
    activeCompanies: number;
    activeRoutineCount: number;
    actionableAssignedOpenIssueCount: number;
    enabledRoutineTriggerCount: number;
    agentsExamined: number;
    agentsPlanned: number;
    agentsUpdated: number;
    errorAgentsReset: number;
    heartbeatsEnabled: number;
    timerBaselinesReset: number;
    pausedAgentsSkipped: number;
    nonInvocableAgentsSkipped: number;
    syntheticAgentsSkipped: number;
  };
  planned: PlannedAgentRecovery[];
  applied: {
    receiptPath: string | null;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
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

function expandHome(input: string) {
  if (!input.startsWith("~")) return input;
  return path.join(process.env.HOME ?? "", input.slice(1));
}

function resolveBackupDir(homeDir: string, instanceId: string, config: ConfigFile) {
  const configured = config.database?.backup?.dir?.trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(homeDir, "instances", instanceId, "data", "backups");
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

function planAgentRecovery(input: RecoveryAgentInput, opts: { includePaused?: boolean } = {}): PlannedAgentRecovery | null {
  if (!hasRecoveryWork(input)) return null;
  if (SYNTHETIC_AGENT_NAME_RE.test(input.name)) return null;
  if (NON_INVOCABLE_STATUSES.has(input.status)) return null;
  if (input.status === "paused" && !opts.includePaused) return null;

  const runtimeConfig = asRecord(input.runtimeConfig);
  const heartbeat = asRecord(runtimeConfig.heartbeat);
  const intervalSec = Math.max(0, asNumber(heartbeat.intervalSec));
  const enabled = asBoolean(heartbeat.enabled) === true;
  const reasons: string[] = [];
  let nextStatus = input.status;
  let nextHeartbeat = { ...heartbeat };

  if (input.status === "error") {
    nextStatus = "idle";
    reasons.push("stale_error_status_reset");
  }

  if (!enabled && intervalSec > 0) {
    nextHeartbeat = {
      ...nextHeartbeat,
      enabled: true,
    };
    reasons.push("timer_heartbeat_enabled");
  }

  if (intervalSec > 0 && (enabled || asBoolean(nextHeartbeat.enabled) === true)) {
    reasons.push("timer_baseline_reset");
  }

  if (reasons.length === 0) return null;

  return {
    agentId: input.id,
    companyId: input.companyId,
    issuePrefix: input.issuePrefix,
    companyName: input.companyName,
    agentName: input.name,
    role: input.role,
    previousStatus: input.status,
    nextStatus,
    previousHeartbeat: heartbeat,
    nextHeartbeat,
    reasons,
    changed: true,
  };
}

function hasRecoveryWork(input: RecoveryAgentInput) {
  return input.activeRoutineCount > 0 || input.actionableAssignedOpenIssueCount > 0;
}

export function planAgentAutonomyRecovery(
  agentsToInspect: RecoveryAgentInput[],
  opts: { includePaused?: boolean } = {},
) {
  return agentsToInspect
    .map((agent) => planAgentRecovery(agent, opts))
    .filter((entry): entry is PlannedAgentRecovery => entry !== null);
}

async function collectRecoveryInputs(db: Db): Promise<RecoveryAgentInput[]> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      issuePrefix: companies.issuePrefix,
      companyName: companies.name,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      runtimeConfig: agents.runtimeConfig,
      activeRoutineCount: sql<number>`count(distinct ${routines.id}) filter (where ${routines.status} = 'active')`,
      actionableAssignedOpenIssueCount: sql<number>`count(distinct ${issues.id}) filter (
        where ${issues.hiddenAt} is null
          and ${issues.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
          and not (
            ${issues.originKind} = 'factory_guard'
            and coalesce(${issues.executionState} -> 'paperclipFactoryGuard' ->> 'blockerOwner', '') = 'system'
            and coalesce(${issues.executionState} -> 'paperclipFactoryGuard' ->> 'reason', '')
              in ('maintenance_lane_cadence', 'upstream_artifact_unchanged')
          )
      )`,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .leftJoin(routines, eq(routines.companyId, agents.companyId))
    .leftJoin(
      issues,
      and(eq(issues.companyId, agents.companyId), eq(issues.assigneeAgentId, agents.id)),
    )
    .groupBy(
      agents.id,
      agents.companyId,
      companies.issuePrefix,
      companies.name,
      agents.name,
      agents.role,
      agents.status,
      agents.runtimeConfig,
    );

  return rows.map((row) => ({
    ...row,
    runtimeConfig: asRecord(row.runtimeConfig),
    activeRoutineCount: Number(row.activeRoutineCount ?? 0),
    actionableAssignedOpenIssueCount: Number(row.actionableAssignedOpenIssueCount ?? 0),
  }));
}

async function collectCounts(db: Db, inputs: RecoveryAgentInput[], planned: PlannedAgentRecovery[]) {
  const [{ activeRoutineCount }] = await db
    .select({ activeRoutineCount: sql<number>`count(*)` })
    .from(routines)
    .where(eq(routines.status, "active"));
  const [{ enabledRoutineTriggerCount }] = await db
    .select({ enabledRoutineTriggerCount: sql<number>`count(*)` })
    .from(routineTriggers)
    .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
    .where(and(eq(routines.status, "active"), eq(routineTriggers.enabled, true)));
  const activeCompanyIds = new Set(inputs.filter(hasRecoveryWork).map((agent) => agent.companyId));
  const actionableAssignedOpenIssueCount = inputs.reduce(
    (total, agent) => total + agent.actionableAssignedOpenIssueCount,
    0,
  );

  return {
    activeCompanies: activeCompanyIds.size,
    activeRoutineCount: Number(activeRoutineCount ?? 0),
    actionableAssignedOpenIssueCount,
    enabledRoutineTriggerCount: Number(enabledRoutineTriggerCount ?? 0),
    agentsExamined: inputs.length,
    agentsPlanned: planned.length,
    agentsUpdated: 0,
    errorAgentsReset: planned.filter((entry) => entry.reasons.includes("stale_error_status_reset")).length,
    heartbeatsEnabled: planned.filter((entry) => entry.reasons.includes("timer_heartbeat_enabled")).length,
    timerBaselinesReset: planned.length,
    pausedAgentsSkipped: inputs.filter((agent) => hasRecoveryWork(agent) && agent.status === "paused").length,
    nonInvocableAgentsSkipped: inputs.filter((agent) => hasRecoveryWork(agent) && NON_INVOCABLE_STATUSES.has(agent.status)).length,
    syntheticAgentsSkipped: inputs.filter((agent) => hasRecoveryWork(agent) && SYNTHETIC_AGENT_NAME_RE.test(agent.name)).length,
  };
}

async function applyRecoveryPlan(db: Db, planned: PlannedAgentRecovery[]) {
  for (const entry of planned) {
    const recoveredAt = new Date();
    const [row] = await db
      .select({ runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, entry.agentId));
    if (!row) continue;
    const runtimeConfig = asRecord(row.runtimeConfig);
    const metadata = asRecord(runtimeConfig.autonomyRecovery);
    await db
      .update(agents)
      .set({
        status: entry.nextStatus,
        runtimeConfig: {
          ...runtimeConfig,
          heartbeat: entry.nextHeartbeat,
          autonomyRecovery: {
            ...metadata,
            version: RECOVERY_VERSION,
            recoveredAt: recoveredAt.toISOString(),
            reasons: entry.reasons,
            previousStatus: entry.previousStatus,
            previousHeartbeat: entry.previousHeartbeat,
            timerBaselineResetAt: recoveredAt.toISOString(),
          },
        },
        lastHeartbeatAt: recoveredAt,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, entry.agentId));
  }
}

export async function recoverAgentAutonomy(db: Db, options: RecoveryOptions): Promise<RecoveryResult> {
  const startedAt = new Date().toISOString();
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const config = await readConfig(homeDir, instanceId);
  const { connectionString, source: connectionSource } = resolveConnectionString(config, options.connectionString);
  const inputs = await collectRecoveryInputs(db);
  const planned = planAgentAutonomyRecovery(inputs, { includePaused: options.includePaused });
  const counts = await collectCounts(db, inputs, planned);
  let backup: RecoveryResult["backup"] = null;

  if (!options.dryRun && options.backup !== false) {
    const backupResult = await runDatabaseBackup({
      connectionString,
      backupDir: resolveBackupDir(homeDir, instanceId, config),
      retentionDays: config.database?.backup?.retentionDays ?? 30,
      keepLatestBackups: 2,
      filenamePrefix: "paperclip-agent-autonomy-recovery-preflight",
      compression: "gzip",
      dataBatchRows: 10,
    });
    backup = {
      path: backupResult.backupFile ?? null,
      summary: formatDatabaseBackupResult(backupResult),
    };
  }

  if (!options.dryRun && planned.length > 0) {
    await applyRecoveryPlan(db, planned);
    counts.agentsUpdated = planned.length;
  }

  const result: RecoveryResult = {
    status: options.dryRun ? "dry_run" : "applied",
    recoveryVersion: RECOVERY_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    connectionSource,
    backup,
    counts,
    planned,
    applied: {
      receiptPath: null,
    },
  };

  const receiptDir = path.resolve(path.join(homeDir, "instances", instanceId), options.receiptDir ?? DEFAULT_RECEIPT_DIR);
  await mkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 16)}Z.json`);
  result.applied.receiptPath = receiptPath;
  await writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return result;
}

function parseArgs(argv: string[]) {
  const parsed: RecoveryOptions = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--apply") parsed.dryRun = false;
    else if (arg === "--include-paused") parsed.includePaused = true;
    else if (arg === "--no-backup") parsed.backup = false;
    else if (arg === "--connection-string") parsed.connectionString = argv[++index];
    else if (arg === "--home") parsed.homeDir = argv[++index];
    else if (arg === "--instance-id") parsed.instanceId = argv[++index];
    else if (arg === "--receipt-dir") parsed.receiptDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: tsx src/ops/agent-autonomy-recovery.ts --dry-run|--apply [options]",
        "",
        "Options:",
        "  --include-paused          Also recover paused agents in active companies",
        "  --connection-string <url> Override database connection string",
        "  --home <path>             Paperclip home directory",
        "  --instance-id <id>        Paperclip instance id",
        "  --receipt-dir <path>      Receipt dir relative to instance root",
        "  --no-backup               Skip pre-apply database backup",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const config = await readConfig(homeDir, instanceId);
  const { connectionString } = resolveConnectionString(config, options.connectionString);
  const db = createDb(connectionString);
  try {
    const result = await recoverAgentAutonomy(db, {
      ...options,
      homeDir,
      instanceId,
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
