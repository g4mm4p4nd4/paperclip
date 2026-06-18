import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  contextLedgerEntries,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.js";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/provider-tokenomics/runs";
const CANARY_VERSION = "timer-budget-exhausted-canary.v1";
const CANARY_ADAPTER_TYPE = "timer_budget_exhausted_canary";

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type CanaryOptions = {
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  cleanup?: boolean;
};

type CleanupSummary = {
  attempted: boolean;
  completed: boolean;
  error: string | null;
};

export type TimerBudgetExhaustedCanaryReceipt = {
  version: string;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  connectionSource: string;
  fixture: {
    companyId: string;
    agentId: string;
    issueId: string;
    issueIdentifier: string;
    issuePrefix: string;
  };
  expectation: {
    reason: "heartbeat.timer_budget_exhausted_requires_handoff";
    detectorVersion: "paperclip-timer-budget-exhausted.v1";
  };
  observed: {
    runReturned: boolean;
    runId: string | null;
    adapterCalled: boolean;
    wakeupStatus: string | null;
    wakeupReason: string | null;
    wakeupPayload: Record<string, unknown> | null;
    issueStatus: string | null;
    completedAt: string | null;
    activeRunsAfter: number;
  };
  cleanup: CleanupSummary;
  receiptPath: string | null;
  error: string | null;
};

function expandHome(input: string) {
  if (!input.startsWith("~")) return input;
  return path.join(process.env.HOME ?? "", input.slice(1));
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as ConfigFile;
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

function receiptPathFor(homeDir: string, instanceId: string, receiptDir: string, now = new Date()) {
  const root = path.resolve(path.join(homeDir, "instances", instanceId), receiptDir);
  const stamp = `${now.toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
  return path.join(root, `${stamp}-timer-budget-exhausted-canary.json`);
}

function makeCanaryAdapter(onExecute: () => void): ServerAdapterModule {
  return {
    type: CANARY_ADAPTER_TYPE,
    models: [{ id: "canary", label: "Canary" }],
    supportsLocalAgentJwt: false,
    testEnvironment: async () => ({
      adapterType: CANARY_ADAPTER_TYPE,
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
    execute: async () => {
      onExecute();
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "canary adapter should not execute",
        resultJson: {
          ok: false,
          canary: CANARY_VERSION,
          failure: "adapter_executed",
        },
      };
    },
  };
}

async function countActiveRuns(db: Db) {
  return db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]))
    .then((rows) => rows.length);
}

async function cleanupFixture(db: Db, companyId: string): Promise<CleanupSummary> {
  try {
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
    await db.delete(costEvents).where(eq(costEvents.companyId, companyId));
    await db.delete(contextLedgerEntries).where(eq(contextLedgerEntries.companyId, companyId));
    await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    return { attempted: true, completed: true, error: null };
  } catch (error) {
    return {
      attempted: true,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isPass(receipt: TimerBudgetExhaustedCanaryReceipt) {
  const skip = receipt.observed.wakeupPayload?.paperclipTimerBudgetExhaustedSkip;
  const skipRecord = skip && typeof skip === "object" && !Array.isArray(skip)
    ? skip as Record<string, unknown>
    : {};
  return (
    !receipt.observed.runReturned &&
    !receipt.observed.adapterCalled &&
    receipt.observed.wakeupStatus === "skipped" &&
    receipt.observed.wakeupReason === receipt.expectation.reason &&
    skipRecord.reason === "timer_budget_exhausted_requires_explicit_handoff" &&
    skipRecord.detectorVersion === receipt.expectation.detectorVersion &&
    receipt.observed.issueStatus === "in_progress" &&
    receipt.observed.completedAt === null &&
    receipt.observed.activeRunsAfter === 0
  );
}

export async function runTimerBudgetExhaustedCanary(options: CanaryOptions = {}) {
  const startedAt = new Date();
  const homeDir = path.resolve(expandHome(options.homeDir ?? DEFAULT_HOME));
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const receiptDir = options.receiptDir ?? DEFAULT_RECEIPT_DIR;
  const config = await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const db = createDb(connection.connectionString);
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const issuePrefix = `TB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const issueIdentifier = `${issuePrefix}-1`;
  const receiptPath = receiptPathFor(homeDir, instanceId, receiptDir, startedAt);
  let adapterCalled = false;
  let cleanup: CleanupSummary = {
    attempted: options.cleanup !== false,
    completed: false,
    error: null,
  };

  const receipt: TimerBudgetExhaustedCanaryReceipt = {
    version: CANARY_VERSION,
    status: "fail",
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    connectionSource: connection.source,
    fixture: {
      companyId,
      agentId,
      issueId,
      issueIdentifier,
      issuePrefix,
    },
    expectation: {
      reason: "heartbeat.timer_budget_exhausted_requires_handoff",
      detectorVersion: "paperclip-timer-budget-exhausted.v1",
    },
    observed: {
      runReturned: false,
      runId: null,
      adapterCalled: false,
      wakeupStatus: null,
      wakeupReason: null,
      wakeupPayload: null,
      issueStatus: null,
      completedAt: null,
      activeRunsAfter: -1,
    },
    cleanup,
    receiptPath,
    error: null,
  };

  registerServerAdapter(makeCanaryAdapter(() => {
    adapterCalled = true;
  }));

  try {
    const receiptAt = new Date(Date.now() - 10 * 60 * 1000);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Timer Budget Canary",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Budget Canary",
      role: "engineer",
      status: "idle",
      adapterType: CANARY_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Timer Budget Canary :: Exhausted Continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: issueIdentifier,
      updatedAt: receiptAt,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: [
        "Status: heartbeat-budget exhausted.",
        "",
        `${issueIdentifier} remains \`in_progress\` and the deliverable is not yet written.`,
        "Here is the working-context summary for the next run.",
      ].join("\n"),
      createdAt: receiptAt,
      updatedAt: receiptAt,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      contextSnapshot: {
        source: "timer-budget-exhausted-canary",
        reason: "interval_elapsed",
      },
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    receipt.observed = {
      runReturned: run !== null,
      runId: run?.id ?? null,
      adapterCalled,
      wakeupStatus: wakeup?.status ?? null,
      wakeupReason: wakeup?.reason ?? null,
      wakeupPayload: wakeup?.payload ?? null,
      issueStatus: issue?.status ?? null,
      completedAt: issue?.completedAt instanceof Date ? issue.completedAt.toISOString() : null,
      activeRunsAfter: await countActiveRuns(db),
    };
    receipt.status = isPass(receipt) ? "pass" : "fail";
    if (receipt.status === "fail") {
      receipt.error = "Timer budget exhausted canary did not observe the expected pre-adapter skipped wake.";
    }
  } catch (error) {
    receipt.status = "fail";
    receipt.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    unregisterServerAdapter(CANARY_ADAPTER_TYPE);
    if (options.cleanup !== false) {
      cleanup = await cleanupFixture(db, companyId);
      receipt.cleanup = cleanup;
    }
    receipt.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const client = (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } }).$client;
    await client?.end?.({ timeout: 0 });
  }

  if (receipt.status !== "pass") {
    process.exitCode = 1;
  }
  return receipt;
}

function parseArgs(argv: string[]): CanaryOptions {
  const out: CanaryOptions = { cleanup: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--connection-string") out.connectionString = argv[++index];
    else if (arg === "--home") out.homeDir = argv[++index];
    else if (arg === "--instance") out.instanceId = argv[++index];
    else if (arg === "--receipt-dir") out.receiptDir = argv[++index];
    else if (arg === "--keep-fixture") out.cleanup = false;
    else if (arg === "--help") {
      console.log([
        "Usage: tsx src/ops/timer-budget-exhausted-canary.ts [options]",
        "",
        "Options:",
        "  --connection-string <url>  Override database connection",
        "  --home <path>              Paperclip home directory",
        "  --instance <id>            Paperclip instance id",
        "  --receipt-dir <path>       Receipt dir relative to instance root",
        "  --keep-fixture             Leave synthetic rows for debugging",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTimerBudgetExhaustedCanary(parseArgs(process.argv.slice(2)))
    .then((receipt) => {
      console.log(JSON.stringify({
        status: receipt.status,
        observed: receipt.observed,
        cleanup: receipt.cleanup,
        receiptPath: receipt.receiptPath,
      }, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
