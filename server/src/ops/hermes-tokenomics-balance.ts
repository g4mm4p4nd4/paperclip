import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  type Db,
} from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/provider-tokenomics/runs";
const BALANCE_VERSION = "hermes-tokenomics-balance.v3";
export const PONYTAIL_SKILL_KEY = "paperclipai/paperclip/ponytail";
const PRIOR_RUN_VALUE_QUESTION = "Does this session's prior runs provide any value to this current run?";
const REQUEST_SHAPING_POLICY = {
  enabled: true,
  priorRunValueQuestion: PRIOR_RUN_VALUE_QUESTION,
  noIssueContextMaxChars: 8_000,
  noIssueOutputMaxChars: 1_200,
  noIssueOutputMaxSentences: 6,
  noIssueMaxTurnsPerRun: 4,
};

type JsonRecord = Record<string, unknown>;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type TokenomicsProfileName = "factory_build" | "research_synthesis" | "maintenance_light";

type TokenomicsProfile = {
  name: TokenomicsProfileName;
  contextMaxChars: number;
  outputMaxChars: number;
  outputMaxSentences: number;
  timeoutSec: number;
  maxTurnsPerRun: number;
  claudeMaxTurnsPerRun: number;
  sessionCompaction: {
    maxSessionRuns: number;
    maxRawInputTokens: number;
    maxSessionAgeHours: number;
  };
};

type HermesAgentRow = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  adapterConfig: JsonRecord;
  runtimeConfig: JsonRecord;
};

type BalanceOptions = {
  dryRun?: boolean;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  agentIds?: string[];
  now?: Date;
};

type PlannedAgentBalance = {
  agentId: string;
  companyId: string;
  companyName: string;
  agentName: string;
  role: string;
  status: string;
  profile: TokenomicsProfileName;
  previousAdapterConfig: JsonRecord;
  previousRuntimeConfig: JsonRecord;
  nextAdapterConfig: JsonRecord;
  nextRuntimeConfig: JsonRecord;
  changed: boolean;
  ponytailAttached: boolean;
};

type BalanceReceipt = {
  version: string;
  status: "dry_run" | "applied";
  startedAt: string;
  finishedAt: string;
  connectionSource: string;
  counts: {
    candidates: number;
    changed: number;
    applied: number;
    ponytailAttached: number;
    factoryBuildProfiles: number;
    researchSynthesisProfiles: number;
    maintenanceLightProfiles: number;
  };
  policy: {
    objective: string;
    preservedFactoryLoop: {
      upstreamTruthPlane: string;
      controlPlane: string;
      executionPlane: string;
      evidenceTools: string[];
    };
    idleTimerPreflight: string;
    requestShaping: typeof REQUEST_SHAPING_POLICY;
    ponytailSkillKey: string;
  };
  planned: PlannedAgentBalance[];
  receiptPath: string | null;
};

const PROFILES: Record<TokenomicsProfileName, TokenomicsProfile> = {
  factory_build: {
    name: "factory_build",
    contextMaxChars: 24_000,
    outputMaxChars: 3_200,
    outputMaxSentences: 12,
    timeoutSec: 1_800,
    maxTurnsPerRun: 12,
    claudeMaxTurnsPerRun: 25,
    sessionCompaction: {
      maxSessionRuns: 12,
      maxRawInputTokens: 250_000,
      maxSessionAgeHours: 8,
    },
  },
  research_synthesis: {
    name: "research_synthesis",
    contextMaxChars: 28_000,
    outputMaxChars: 4_000,
    outputMaxSentences: 14,
    timeoutSec: 1_800,
    maxTurnsPerRun: 14,
    claudeMaxTurnsPerRun: 25,
    sessionCompaction: {
      maxSessionRuns: 10,
      maxRawInputTokens: 350_000,
      maxSessionAgeHours: 8,
    },
  },
  maintenance_light: {
    name: "maintenance_light",
    contextMaxChars: 12_000,
    outputMaxChars: 1_400,
    outputMaxSentences: 7,
    timeoutSec: 900,
    maxTurnsPerRun: 8,
    claudeMaxTurnsPerRun: 12,
    sessionCompaction: {
      maxSessionRuns: 8,
      maxRawInputTokens: 120_000,
      maxSessionAgeHours: 6,
    },
  },
};

const FACTORY_REPO_HINTS = [
  "portfolio-os",
  "paperclip",
  "hermes-agent",
  "hermes-paperclip-adapter",
  "gstack",
  "gbrain",
  "scrapegraph",
  "graphify",
];

const IMPLEMENTATION_ROLES = new Set(["cto", "engineer", "integration_engineer", "devops", "qa", "pm", "general"]);
const RESEARCH_ROLES = new Set(["ceo", "chief_of_staff", "manager", "researcher", "designer"]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonRecord) } : {};
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
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

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeRole(role: string) {
  return role.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function defaultGeminiModel(profile: TokenomicsProfileName) {
  if (profile === "research_synthesis") return "gemini-3.1-pro-preview";
  if (profile === "factory_build") return "gemini-3-flash-preview";
  return "gemini-3.1-flash-lite";
}

function defaultClaudeModel(profile: TokenomicsProfileName) {
  return profile === "maintenance_light" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
}

export function classifyHermesTokenomicsProfile(input: {
  role: string;
  name?: string | null;
  adapterConfig?: JsonRecord | null;
}): TokenomicsProfileName {
  const role = normalizeRole(input.role);
  const config = asRecord(input.adapterConfig);
  const cwd = asNonEmptyString(config.cwd) ?? "";
  const haystack = `${role}\n${input.name ?? ""}\n${cwd}\n${asNonEmptyString(config.instructionsFilePath) ?? ""}`.toLowerCase();
  if (RESEARCH_ROLES.has(role)) return "research_synthesis";
  if (FACTORY_REPO_HINTS.some((hint) => haystack.includes(hint))) return "factory_build";
  if (IMPLEMENTATION_ROLES.has(role)) return "factory_build";
  return "maintenance_light";
}

function mergePonytailSkill(config: JsonRecord) {
  const sync = asRecord(config.paperclipSkillSync);
  const existing = Array.isArray(sync.desiredSkills)
    ? sync.desiredSkills.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...config,
    paperclipSkillSync: {
      ...sync,
      desiredSkills: unique([...existing, PONYTAIL_SKILL_KEY]),
    },
  };
}

function profileBudgetFields(profile: TokenomicsProfile): JsonRecord {
  return {
    contextMaxChars: profile.contextMaxChars,
    outputMaxChars: profile.outputMaxChars,
    outputMaxSentences: profile.outputMaxSentences,
    timeoutSec: profile.timeoutSec,
  };
}

export function buildBalancedHermesAgentConfig(input: {
  role: string;
  name?: string | null;
  adapterConfig: JsonRecord;
  runtimeConfig: JsonRecord;
}): {
  profile: TokenomicsProfileName;
  nextAdapterConfig: JsonRecord;
  nextRuntimeConfig: JsonRecord;
} {
  const profileName = classifyHermesTokenomicsProfile(input);
  const profile = PROFILES[profileName];
  const currentAdapter = asRecord(input.adapterConfig);
  const currentRuntime = asRecord(input.runtimeConfig);
  const existingPolicy = asRecord(currentAdapter.tieredExecution ?? currentAdapter.executionRouting);
  const hermesMiniMax = asRecord(existingPolicy.hermes_minimax ?? existingPolicy.hermesLocal ?? existingPolicy.hermes_local);
  const geminiLocal = asRecord(existingPolicy.gemini_local ?? existingPolicy.gemini);
  const claudeLocal = asRecord(existingPolicy.claude_local ?? existingPolicy.claude);
  const heartbeat = asRecord(currentRuntime.heartbeat);
  const existingIntervalSec = Math.trunc(asNumber(heartbeat.intervalSec, 0));
  const heartbeatEnabled = asBoolean(heartbeat.enabled, false);

  const tieredExecution: JsonRecord = {
    ...existingPolicy,
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
      maxTurnsPerRun: profile.maxTurnsPerRun,
      ...profileBudgetFields(profile),
    },
    gemini_local: {
      ...geminiLocal,
      command: asNonEmptyString(geminiLocal.command) ?? "gemini",
      authMode: "subscription",
      model: defaultGeminiModel(profileName),
      sandbox: geminiLocal.sandbox === true,
      ...profileBudgetFields(profile),
    },
    claude_local: {
      ...claudeLocal,
      command: asNonEmptyString(claudeLocal.command) ?? "/opt/homebrew/bin/claude",
      authMode: "subscription",
      model: defaultClaudeModel(profileName),
      maxTurnsPerRun: profile.claudeMaxTurnsPerRun,
      dangerouslySkipPermissions: claudeLocal.dangerouslySkipPermissions !== false,
      ...profileBudgetFields(profile),
    },
  };

  const nextAdapterConfig = mergePonytailSkill({
    ...currentAdapter,
    disableFallbackModel: true,
    ...profileBudgetFields(profile),
    requestShaping: {
      ...REQUEST_SHAPING_POLICY,
      ...asRecord(currentAdapter.requestShaping),
    },
    tieredExecution,
    tokenomics: {
      ...(asRecord(currentAdapter.tokenomics)),
      balanceVersion: BALANCE_VERSION,
      profile: profileName,
      objective: "preserve valuable recursive factory work while removing no-op wake and raw-context waste",
      requestShaping: {
        ...REQUEST_SHAPING_POLICY,
        ...asRecord(asRecord(currentAdapter.tokenomics).requestShaping),
      },
      subscriptionFallbackBudget: {
        contextMaxChars: profile.contextMaxChars,
        outputMaxChars: profile.outputMaxChars,
        outputMaxSentences: profile.outputMaxSentences,
        timeoutSec: profile.timeoutSec,
        maxTurnsPerRun: profile.maxTurnsPerRun,
        sessionCompaction: profile.sessionCompaction,
      },
    },
  });

  const nextRuntimeConfig: JsonRecord = {
    ...currentRuntime,
    heartbeat: {
      ...heartbeat,
      maxConcurrentRuns: 1,
      ...(heartbeatEnabled && existingIntervalSec > 0
        ? { intervalSec: Math.max(existingIntervalSec, 1_800) }
        : {}),
      idleAssignmentPreflight: true,
      sessionCompaction: profile.sessionCompaction,
    },
    factoryLoop: {
      ...(asRecord(currentRuntime.factoryLoop)),
      balanceVersion: BALANCE_VERSION,
      upstreamTruthPlane: "portfolio-os",
      controlPlane: "paperclip-cockpit",
      executionPlane: "hermes-agent via Paperclip adapter",
      evidenceTools: ["scrapegraphai", "graphify", "gstack", "gbrain", "context-packs", "repomix"],
      contextPolicy: "map-pack first, delta when dirty-tree context matters, core pack only for broad implementation review",
      emptyTimerPolicy: "skip before adapter when no explicit wake context and no open assigned work",
    },
  };

  return { profile: profileName, nextAdapterConfig, nextRuntimeConfig };
}

export function planHermesTokenomicsAgent(agent: HermesAgentRow): PlannedAgentBalance {
  const { profile, nextAdapterConfig, nextRuntimeConfig } = buildBalancedHermesAgentConfig({
    role: agent.role,
    name: agent.name,
    adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig,
  });
  const changed =
    stableJson(agent.adapterConfig) !== stableJson(nextAdapterConfig) ||
    stableJson(agent.runtimeConfig) !== stableJson(nextRuntimeConfig);
  const desired = asRecord(nextAdapterConfig.paperclipSkillSync).desiredSkills;
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    companyName: agent.companyName,
    agentName: agent.name,
    role: agent.role,
    status: agent.status,
    profile,
    previousAdapterConfig: agent.adapterConfig,
    previousRuntimeConfig: agent.runtimeConfig,
    nextAdapterConfig,
    nextRuntimeConfig,
    changed,
    ponytailAttached: Array.isArray(desired) && desired.includes(PONYTAIL_SKILL_KEY),
  };
}

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

export function receiptFilePath(
  homeDir: string,
  instanceId: string,
  receiptDir?: string,
  now = new Date(),
  pid = process.pid,
) {
  const root = path.resolve(path.join(homeDir, "instances", instanceId), receiptDir ?? DEFAULT_RECEIPT_DIR);
  const stamp = `${now.toISOString().replace(/[-:.]/g, "")}-${pid}`;
  return path.join(root, `${stamp}-hermes-tokenomics-balance.json`);
}

async function collectHermesAgents(db: Db, agentIds?: string[]): Promise<HermesAgentRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      companyName: companies.name,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(eq(agents.adapterType, "hermes_local"))
    .orderBy(sql`${companies.name}`, sql`${agents.name}`);

  const allowIds = agentIds && agentIds.length > 0 ? new Set(agentIds) : null;
  return rows
    .filter((row) => !allowIds || allowIds.has(row.id))
    .map((row) => ({
      ...row,
      adapterConfig: asRecord(row.adapterConfig),
      runtimeConfig: asRecord(row.runtimeConfig),
    }));
}

export async function balanceHermesTokenomics(options: BalanceOptions = {}): Promise<BalanceReceipt> {
  const startedAt = (options.now ?? new Date()).toISOString();
  const homeDir = options.homeDir ?? DEFAULT_HOME;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  await loadInstanceEnvFile(homeDir, instanceId);
  const config = await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const db = createDb(connection.connectionString);
  try {
    const dryRun = options.dryRun !== false;
    const agentsToPlan = await collectHermesAgents(db, options.agentIds);
    const planned = agentsToPlan.map(planHermesTokenomicsAgent);
    const changedPlans = planned.filter((plan) => plan.changed);
    let applied = 0;

    if (!dryRun) {
      const companyIds = Array.from(new Set(agentsToPlan.map((agent) => agent.companyId)));
      const skills = companySkillService(db);
      for (const companyId of companyIds) {
        await skills.listFull(companyId);
      }

      for (const plan of changedPlans) {
        await db
          .update(agents)
          .set({
            adapterConfig: plan.nextAdapterConfig,
            runtimeConfig: plan.nextRuntimeConfig,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, plan.agentId));
        applied += 1;
      }
    }

    const receipt: BalanceReceipt = {
      version: BALANCE_VERSION,
      status: dryRun ? "dry_run" : "applied",
      startedAt,
      finishedAt: new Date().toISOString(),
      connectionSource: connection.source,
      counts: {
        candidates: planned.length,
        changed: changedPlans.length,
        applied,
        ponytailAttached: planned.filter((plan) => plan.ponytailAttached).length,
        factoryBuildProfiles: planned.filter((plan) => plan.profile === "factory_build").length,
        researchSynthesisProfiles: planned.filter((plan) => plan.profile === "research_synthesis").length,
        maintenanceLightProfiles: planned.filter((plan) => plan.profile === "maintenance_light").length,
      },
      policy: {
        objective: "increase useful autonomous factory output while cutting token waste from no-op wakes, duplicate context replay, and overlong run chatter",
        preservedFactoryLoop: {
          upstreamTruthPlane: "portfolio-os",
          controlPlane: "paperclip-cockpit",
          executionPlane: "hermes-agent through Paperclip adapters",
          evidenceTools: ["scrapegraphai", "graphify", "gstack", "gbrain", "context-packs", "repomix"],
        },
        idleTimerPreflight: "server skips timer wakes before adapter launch when no explicit wake context exists and the agent has no open assigned work",
        requestShaping: REQUEST_SHAPING_POLICY,
        ponytailSkillKey: PONYTAIL_SKILL_KEY,
      },
      planned,
      receiptPath: null,
    };

    const outPath = receiptFilePath(homeDir, instanceId, options.receiptDir);
    await mkdir(path.dirname(outPath), { recursive: true });
    receipt.receiptPath = outPath;
    await writeFile(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    const client = (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } }).$client;
    await client?.end?.({ timeout: 0 });
  }
}

function parseArgs(argv: string[]): BalanceOptions {
  const out: BalanceOptions = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      out.dryRun = false;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--connection-string") {
      out.connectionString = argv[++index];
    } else if (arg === "--home") {
      out.homeDir = argv[++index];
    } else if (arg === "--instance") {
      out.instanceId = argv[++index];
    } else if (arg === "--receipt-dir") {
      out.receiptDir = argv[++index];
    } else if (arg === "--agent-id") {
      out.agentIds = [...(out.agentIds ?? []), argv[++index] ?? ""].filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx server/src/ops/hermes-tokenomics-balance.ts [--dry-run|--apply] [--agent-id <id>]");
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const result = await balanceHermesTokenomics(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    status: result.status,
    version: result.version,
    counts: result.counts,
    receiptPath: result.receiptPath,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
