import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  createDb,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  buildPortfolioExistingVentureGateDeps,
  ingestExistingVentureGateFile,
} from "../services/portfolio-dispatch.js";

const DEFAULT_HOME = "/Users/mnm/.paperclip-local/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_POS_DIR = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_GATE_PATH = `${DEFAULT_POS_DIR}/data/state/paperclip_dispatch_gate.json`;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type Options = {
  homeDir?: string;
  instanceId?: string;
  gatePath?: string;
  connectionString?: string;
  forceWake?: boolean;
};

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

async function loadInstanceEnvFile(homeDir: string, instanceId: string) {
  const envPath = path.join(homeDir, "instances", instanceId, ".env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  const parsed = parseEnvFileContents(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue;
    if (typeof value === "string" && value.trim().length > 0) process.env[key] = value;
  }
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

function parseArgs(argv: string[]): Options {
  const out: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home") out.homeDir = argv[++index];
    else if (arg === "--instance") out.instanceId = argv[++index];
    else if (arg === "--gate-path") out.gatePath = argv[++index];
    else if (arg === "--connection-string") out.connectionString = argv[++index];
    else if (arg === "--force-wake") out.forceWake = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: pnpm ops:portfolio-existing-venture-gate [options]",
        "",
        "Options:",
        "  --home <path>               Paperclip cockpit home directory",
        "  --instance <id>             Paperclip instance id",
        "  --gate-path <path>          POS paperclip_dispatch_gate.json path",
        "  --connection-string <url>   Override database connection string",
        "  --force-wake                Queue a wake even when the issue already exists unchanged",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

async function queueWakeForServerResume(input: {
  db: Db;
  agentId: string;
  issueId: string;
  projectId: string | null | undefined;
  runId: string;
}) {
  const agent = await input.db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .then((rows) => rows[0] ?? null);
  if (!agent) throw new Error(`Cannot queue existing-venture wake; agent not found: ${input.agentId}`);
  const contextSnapshot = {
    issueId: input.issueId,
    projectId: input.projectId ?? null,
    runId: input.runId,
    source: "portfolio_existing_venture_gate",
  };
  const payload = {
    issueId: input.issueId,
    projectId: input.projectId ?? null,
    runId: input.runId,
    source: "portfolio_existing_venture_gate",
  };
  const wakeup = await input.db
    .insert(agentWakeupRequests)
    .values({
      companyId: agent.companyId,
      agentId: input.agentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "portfolio_existing_venture_gate",
      payload,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "portfolio_existing_venture_gate",
    })
    .returning()
    .then((rows) => rows[0]);
  const run = await input.db
    .insert(heartbeatRuns)
    .values({
      companyId: agent.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeup.id,
      contextSnapshot,
      sessionIdBefore: null,
    })
    .returning()
    .then((rows) => rows[0]);
  await input.db
    .update(agentWakeupRequests)
    .set({
      runId: run.id,
      updatedAt: new Date(),
    })
    .where(eq(agentWakeupRequests.id, wakeup.id));
  return { wakeupRequestId: wakeup.id, heartbeatRunId: run.id };
}

export async function runPortfolioExistingVentureGate(options: Options = {}) {
  const homeDir = options.homeDir ?? DEFAULT_HOME;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const gatePath = options.gatePath ?? process.env.PAPERCLIP_POS_DISPATCH_GATE_PATH ?? DEFAULT_GATE_PATH;

  await loadInstanceEnvFile(homeDir, instanceId);
  const config = await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const db = createDb(connection.connectionString);
  try {
    const baseDeps = buildPortfolioExistingVentureGateDeps(db);
    const deps = {
      ...baseDeps,
      wakeAgent: async (agentId: string, issueId: string, projectId: string | null, runId: string) => {
        await queueWakeForServerResume({ db, agentId, issueId, projectId, runId });
      },
    };
    const result = await ingestExistingVentureGateFile(gatePath, deps);
    const forceWake = options.forceWake && result.issueId && result.assigneeAgentId
      ? await queueWakeForServerResume({
        db,
        agentId: result.assigneeAgentId,
        issueId: result.issueId,
        projectId: result.projectId ?? null,
        runId: result.gateHash,
      })
      : null;
    return {
      ...result,
      ...(forceWake ? { forceWakeQueued: true, ...forceWake } : {}),
      gatePath: path.resolve(gatePath),
      connectionSource: connection.source,
    };
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

async function main() {
  const result = await runPortfolioExistingVentureGate(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
