import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  agents,
  agentApiKeys,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  profitFlywheelLeases,
  profitFlywheelMigrationRuns,
  profitFlywheelStageRuns,
  routineTriggers,
  routines,
  runDatabaseBackup,
  type Db,
} from "@paperclipai/db";
import type { ProfitFlywheelCapabilityAlias } from "@paperclipai/shared";
import {
  loadProviderPolicyV2,
  type ProviderPolicyV2,
} from "../services/provider-policy.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { nextCronTickInTimeZone } from "../services/routines.js";

const MIGRATION_VERSION = "paperclip.profit_flywheel_v2_migration.v2";
const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/flywheel-repair/runs";
const LIVE_FLEET_AUDIT_PATH = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/flywheel-repair/runs/20260711T232404Z-live-fleet-audit.json";
const LIVE_FLEET_AUDIT_SHA256 = "e9322c70726847304a7a55c6756be3b82b5beee785ec73de0d2b715d974976eb";
const POS_ROUTINES_CONFIG_PATH = "/Users/mnm/Documents/Github/portfolio-os/config/paperclip_routines.json";
const POS_ROUTINES_CONFIG_SHA256 = "49b9e42eae6ae531da2bf5b50cde82c152237d7b64527b67e3e738ec572fabbd";
const SENSITIVE_ENV_KEY = /(?:api[_-]?key(?:_file)?|access[_-]?token|refresh[_-]?token|authorization|(?:^|[_-])auth(?:$|[_-])|client[_-]?secret|secret|password|credential|cookie|jwt|private[_-]?key|connectionstring|recovery[_-]?(?:code|codes)|verification[_-]?(?:code|token)|phone(?:[_-]?number)?|mfa|otp)/i;
const CREDENTIAL_VALUE = /(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|(?:api[_-]?key|auth|token|secret|password|cookie|recovery[_-]?code|verification[_-]?code|phone[_-]?number|mfa|otp)\s*[=:]\s*\S{6,})/i;
const COMPROMISED_PROVIDER_KEY = /(?:MINIMAX|OPENROUTER)/i;
const CANONICAL_INTAKE_CRON = "30 8,17 * * *";
const CANONICAL_INTAKE_TIME_ZONE = "America/New_York";
const RETURN_PLANE_EXECUTOR_NAME = /^portfolio os orchestrator$/i;
const RETURN_PLANE_EXECUTOR_CANONICAL_NAME = "Portfolio OS Orchestrator";
const RETURN_PLANE_API_KEY_NAME = "profit-flywheel-runtime-v2";
const RUNTIME_PLANE_SECRET_NAMES = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY",
  "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY",
  "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY",
] as const;

type JsonRecord = Record<string, unknown>;

async function loadRuntimePlaneContract() {
  const bytes = await readFile(POS_ROUTINES_CONFIG_PATH);
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (observedSha256 !== POS_ROUTINES_CONFIG_SHA256) {
    throw new Error("Portfolio OS paperclip_routines.json differs from the pinned migration authority");
  }
  const config = JSON.parse(bytes.toString("utf8")) as JsonRecord;
  const validatePlane = (name: "return_plane" | "research_plane" | "stage_plane", expectedRefs: string[]) => {
    const plane = asRecord(config[name]);
    const runtimeSecretEnvRefs = Array.isArray(plane.runtime_secret_env_refs)
      ? plane.runtime_secret_env_refs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (stableJson(runtimeSecretEnvRefs) !== stableJson(expectedRefs) ||
        plane.mode !== "paperclip_db_outbox_http_ack" || plane.trigger_mode !== "completion_event" ||
        plane.journal_key_min_chars !== 32 || plane.journal_key_must_differ_from_api_token !== true ||
        plane.company_scoped_journals !== true || plane.prepared_ack_replay_first !== true ||
        plane.fixed_clock_polling !== false || plane.success_requires_ack_response !== true) {
      throw new Error(`Portfolio OS ${name.replace("_", "-")} runtime secret/journal contract is incomplete or unsafe`);
    }
    return { runtimeSecretEnvRefs };
  };
  const returnPlane = validatePlane("return_plane", ["PAPERCLIP_API_KEY", "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY"]);
  const researchPlane = validatePlane("research_plane", ["PAPERCLIP_API_KEY", "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY"]);
  const stagePlane = validatePlane("stage_plane", ["PAPERCLIP_API_KEY", "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY"]);
  const researchConfig = asRecord(config.research_plane);
  if (stableJson(researchConfig.fetch_stages) !== stableJson(["research_intake"]) ||
      researchConfig.zero_record_success_forbidden !== true || researchConfig.unsupported_stages_remain_pending !== true ||
      researchConfig.source_registry !== "config/research_sources.yaml") {
    throw new Error("Portfolio OS research-plane stage/source acknowledgement contract is incomplete or unsafe");
  }
  const stageConfig = asRecord(config.stage_plane);
  if (stableJson(stageConfig.fetch_stages) !== stableJson([
    "evidence_normalization",
    "commercial_validation",
    "council_decision",
    "dispatch",
  ]) || stageConfig.poisoned_event_isolation !== true ||
      stageConfig.hard_floor_compensation_forbidden !== true ||
      stageConfig.dispatch_authorizer !== "portfolio_os" ||
      stageConfig.issue_authority !== "paperclip") {
    throw new Error("Portfolio OS stage-plane ownership, hard-floor, or poison-isolation contract is incomplete or unsafe");
  }
  const runtimeSecretEnvRefs = [
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY",
    "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY",
    "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY",
  ];
  if (new Set(runtimeSecretEnvRefs).size !== runtimeSecretEnvRefs.length) {
    throw new Error("Portfolio OS runtime secret names must be pairwise distinct");
  }
  return {
    path: POS_ROUTINES_CONFIG_PATH,
    sha256: observedSha256,
    runtimeSecretEnvRefs,
    returnPlane,
    researchPlane,
    stagePlane,
  };
}

export type ProfitFlywheelMigrationAgent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  adapterConfig: JsonRecord;
  runtimeConfig: JsonRecord;
  updatedAt?: Date | string;
};

type SecretReference = { id: string; name: string; companyId?: string; active?: boolean; valueSha256?: string };

export type AgentMigrationPlan = {
  agentId: string;
  companyId: string;
  agentName: string;
  status: string;
  capabilityAlias: ProfitFlywheelCapabilityAlias;
  budgetClass: string;
  beforeAdapterConfigSha256: string;
  afterAdapterConfigSha256: string;
  beforeRuntimeConfigSha256: string;
  afterRuntimeConfigSha256: string;
  changed: boolean;
  removedLegacyFields: string[];
  secretRefs: string[];
  secretsToCreate: string[];
  quarantinedSecretNames: string[];
  nextAdapterConfig: JsonRecord;
  nextRuntimeConfig: JsonRecord;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as JsonRecord)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function migrationFleetConfigSha256(rows: Array<Pick<ProfitFlywheelMigrationAgent, "id" | "adapterConfig" | "runtimeConfig">>) {
  const projection = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((agent) => ({ id: agent.id, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig }));
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function migrationFleetCanonicalSha256(rows: Array<Pick<ProfitFlywheelMigrationAgent, "id" | "adapterConfig" | "runtimeConfig">>) {
  const projection = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((agent) => ({ id: agent.id, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig }));
  return createHash("sha256").update(stableJson(projection)).digest("hex");
}

function countFleetValues(rows: ProfitFlywheelMigrationAgent[], field: "adapterType" | "status") {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => counts.set(row[field], (counts.get(row[field]) ?? 0) + 1), new Map<string, number>())]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateFleetAuditSnapshot(auditBytes: Buffer, rows: ProfitFlywheelMigrationAgent[]) {
  let audit: JsonRecord;
  try {
    audit = asRecord(JSON.parse(auditBytes.toString("utf8")));
  } catch {
    throw new Error("Live fleet audit is not valid JSON");
  }
  const fleet = asRecord(audit.fleet);
  const acceptance = rows.filter((agent) => agent.status !== "terminated");
  const retired = rows.filter((agent) => agent.status === "terminated");
  const observedFleetConfigSha256 = migrationFleetConfigSha256(acceptance);
  const expectedAdapterTypes = countFleetValues(acceptance, "adapterType");
  if (audit.schema_version !== "paperclip.profit_flywheel_fleet_audit.v2" || audit.read_only !== true ||
      fleet.all_agent_rows !== rows.length || fleet.terminated_rows !== retired.length ||
      fleet.live_agent_rows !== acceptance.length || stableJson(fleet.live_adapter_types) !== stableJson(expectedAdapterTypes) ||
      fleet.fleet_hash_method !== "sha256(JSON.stringify([{id,adapterConfig,runtimeConfig} sorted by id]))" ||
      fleet.fleet_config_sha256 !== observedFleetConfigSha256) {
    throw new Error("Live fleet audit counts, adapter membership, or exact config hash differ from the current database snapshot");
  }
  return {
    schemaVersion: String(audit.schema_version),
    observedAt: String(audit.observed_at ?? ""),
    allAgentRows: rows.length,
    terminatedRows: retired.length,
    liveAgentRows: acceptance.length,
    liveAdapterTypes: expectedAdapterTypes,
    fleetConfigSha256: observedFleetConfigSha256,
    fleetHashMethod: String(fleet.fleet_hash_method),
  };
}

function capabilityAliasForAgent(agent: Pick<ProfitFlywheelMigrationAgent, "role" | "name">): ProfitFlywheelCapabilityAlias {
  const role = `${agent.role} ${agent.name}`.toLowerCase();
  if (/qa|quality|design|visual|review/.test(role)) return "multimodal_qa";
  if (/engineer|developer|architect|implement|security|integration/.test(role)) return "code_deep";
  if (/research|market|signal|council|strategy|ceo|founder|product|commercial|sales/.test(role)) return "research_deep";
  if (/support|summary|scribe|document|maintenance|operator|ops/.test(role)) return "summarization";
  return "code_fast";
}

export function providerPolicyRuntimeAuthorityForAgentAdapter(policy: ProviderPolicyV2, agentAdapterType: string) {
  const policyAdapterType = agentAdapterType === "codex_local"
    ? "codex_cli"
    : agentAdapterType === "hermes_local"
      ? "hermes_local"
      : null;
  if (!policyAdapterType) {
    throw new Error(`profit_flywheel_runtime_adapter_unsupported: ${agentAdapterType}`);
  }
  const candidates = Object.entries(policy.routes)
    .filter(([, route]) => route.runtimeBinding.adapterType === policyAdapterType)
    .sort(([left], [right]) => left.localeCompare(right));
  if (candidates.length === 0) {
    throw new Error(`profit_flywheel_runtime_authority_missing: ${policyAdapterType}`);
  }
  const projected = candidates.map(([routeId, route]) => ({
    routeId,
    commandRealpath: route.runtimeBinding.commandRealpath,
    commandSha256: route.runtimeBinding.commandSha256,
    expectedVersion: route.runtimeBinding.expectedVersion,
    versionArgs: route.runtimeBinding.versionArgs,
    repoRoot: route.runtimeBinding.repoRoot ?? null,
    gitRevision: route.runtimeBinding.gitRevision ?? null,
    gitTree: route.runtimeBinding.gitTree ?? null,
    criticalModules: route.runtimeBinding.criticalModules ?? [],
    criticalModulesSha256: route.runtimeBinding.criticalModulesSha256 ?? null,
    requireCleanTree: route.runtimeBinding.requireCleanTree === true,
  }));
  const authorityBodies = new Set(projected.map(({ routeId: _routeId, ...authority }) => stableJson(authority)));
  if (authorityBodies.size !== 1) {
    throw new Error(`profit_flywheel_runtime_authority_disagreement: adapter=${policyAdapterType}; routes=${projected.map((row) => row.routeId).join(",")}`);
  }
  const { routeId: _routeId, ...authority } = projected[0]!;
  return {
    policyAdapterType,
    routeIds: projected.map((row) => row.routeId),
    ...authority,
    authoritySha256: sha256(authority),
  };
}

function plainEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const binding = asRecord(value);
  return binding.type === "plain" && typeof binding.value === "string" ? binding.value : null;
}

function isSecretRef(value: unknown) {
  const binding = asRecord(value);
  return binding.type === "secret_ref" && typeof binding.secretId === "string" && binding.secretId.length > 0;
}

function validatedSecretReference(input: {
  raw: unknown;
  envKey: string;
  agent: Pick<ProfitFlywheelMigrationAgent, "id" | "companyId">;
  knownSecretIds?: Map<string, SecretReference>;
}) {
  const binding = asRecord(input.raw);
  const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
  const secret = input.knownSecretIds?.get(secretId);
  if (!secret || secret.companyId !== input.agent.companyId || secret.name !== input.envKey || secret.active !== true ||
      COMPROMISED_PROVIDER_KEY.test(secret.name)) {
    throw new Error(
      `profit_flywheel_secret_ref_invalid: agent=${input.agent.id} env=${input.envKey}; reference must bind the same company/name and an unrevoked latest version`,
    );
  }
  return { type: "secret_ref", secretId: secret.id, version: "latest" };
}

function scanForCredentialLiterals(value: unknown, pathParts: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => scanForCredentialLiterals(entry, [...pathParts, String(index)]));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && CREDENTIAL_VALUE.test(value) ? [pathParts.join(".")] : [];
  }
  const record = value as JsonRecord;
  if (record.type === "secret_ref" && typeof record.secretId === "string") return [];
  if (record.type === "pending_secret_ref" && typeof record.secretName === "string") return [];
  if (record.type === "plain" && typeof record.value === "string" && SENSITIVE_ENV_KEY.test(pathParts.at(-1) ?? "")) {
    return [pathParts.join(".")];
  }
  return Object.entries(record).flatMap(([key, entry]) => {
    const fieldPath = [...pathParts, key];
    if (SENSITIVE_ENV_KEY.test(key) && typeof entry === "string" && entry.trim()) return [fieldPath.join(".")];
    return scanForCredentialLiterals(entry, fieldPath);
  });
}

function scanForRetiredPolling(value: unknown, pathParts: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => scanForRetiredPolling(entry, [...pathParts, String(index)]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as JsonRecord).flatMap(([key, entry]) => {
    const fieldPath = [...pathParts, key];
    if (key === "intervalSec" && entry === 300) return [fieldPath.join(".")];
    if (key === "maxConcurrentRuns" && typeof entry === "number" && entry > 1) return [fieldPath.join(".")];
    return scanForRetiredPolling(entry, fieldPath);
  });
}

export function classifyProfitFlywheelRoutineTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  if (normalized === "signal desk :: market sweep" || normalized === "signal desk :: voc sweep") {
    return "twice_daily_market_voc_intake" as const;
  }
  if (new Set([
    "profit flywheel :: evidence normalization",
    "profit flywheel :: commercial validation",
    "profit flywheel :: council decision",
    "profit flywheel :: dispatch authorization",
    "profit flywheel :: governed implementation",
    "profit flywheel :: independent qa",
    "profit flywheel :: artifact release",
    "profit flywheel :: commercial observation",
    "profit flywheel :: learning feedback",
    "signal desk :: evidence intake gate",
    "council chamber :: existing venture gate",
    "council chamber :: council triage",
    "asset composition lab :: venture composition",
    "venture graduation :: route or graduate",
    "truth boundary :: canonical guard",
  ]).has(normalized)) {
    return "retired_downstream_fixed_clock" as const;
  }
  return null;
}

export function planProfitFlywheelV2Agent(input: {
  agent: ProfitFlywheelMigrationAgent;
  policy: ProviderPolicyV2;
  policyPath: string;
  policySha256: string;
  policySchemaPath: string;
  policySchemaSha256: string;
  knownSecrets?: Map<string, SecretReference>;
  knownSecretIds?: Map<string, SecretReference>;
  returnPlaneSecretEnvRefs?: string[];
}) : AgentMigrationPlan {
  const { agent, policy } = input;
  const capabilityAlias = capabilityAliasForAgent(agent);
  const budgetClass = policy.aliases[capabilityAlias].budgetClass;
  const nextAdapterConfig = { ...asRecord(agent.adapterConfig) };
  const removedLegacyFields: string[] = [];
  for (const field of [
    "tieredExecution", "executionRouting", "tokenomics", "requestShaping", "fallbackModel", "fallbackModels",
    "contextMaxChars", "outputMaxChars", "outputMaxSentences", "maxTurnsPerRun", "maxTotalTokens", "maxEscalations",
  ]) {
    if (field in nextAdapterConfig) {
      delete nextAdapterConfig[field];
      removedLegacyFields.push(field);
    }
  }
  delete nextAdapterConfig.provider;
  delete nextAdapterConfig.model;
  delete nextAdapterConfig.quotaMode;
  nextAdapterConfig.disableFallbackModel = true;
  const runtime = providerPolicyRuntimeAuthorityForAgentAdapter(policy, agent.adapterType);
  nextAdapterConfig.command = runtime.commandRealpath;
  if (agent.adapterType === "hermes_local") nextAdapterConfig.hermesCommand = runtime.commandRealpath;
  nextAdapterConfig.providerPolicy = {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    revision: policy.revision,
    path: input.policyPath,
    sha256: input.policySha256,
    schemaPath: input.policySchemaPath,
    schemaSha256: input.policySchemaSha256,
    capabilityAlias,
    budgetClass,
    commandRealpath: runtime.commandRealpath,
    commandSha256: runtime.commandSha256,
    expectedVersion: runtime.expectedVersion,
    runtimeAuthority: runtime,
    hiddenFallbackDisabled: true,
  };

  const secretRefs: string[] = [];
  const secretsToCreate: string[] = [];
  const quarantinedSecretNames: string[] = [];
  const nextEnv: JsonRecord = {};
  for (const [key, raw] of Object.entries(asRecord(nextAdapterConfig.env))) {
    if (COMPROMISED_PROVIDER_KEY.test(key)) {
      quarantinedSecretNames.push(key);
      continue;
    }
    if (isSecretRef(raw)) {
      nextEnv[key] = input.knownSecretIds
        ? validatedSecretReference({ raw, envKey: key, agent, knownSecretIds: input.knownSecretIds })
        : raw;
      secretRefs.push(key);
      continue;
    }
    const plain = plainEnvValue(raw);
    if (!SENSITIVE_ENV_KEY.test(key) || plain === null || !plain.trim()) {
      nextEnv[key] = raw;
      continue;
    }
    const existing = input.knownSecrets?.get(`${agent.companyId}:${key}`);
    nextEnv[key] = existing
      ? { type: "secret_ref", secretId: existing.id, version: "latest" }
      : { type: "pending_secret_ref", secretName: key };
    secretRefs.push(key);
    if (!existing) secretsToCreate.push(key);
  }
  if (RETURN_PLANE_EXECUTOR_NAME.test(agent.name.trim())) {
    for (const secretName of input.returnPlaneSecretEnvRefs ?? []) {
      if (secretName in nextEnv) continue;
      const existing = input.knownSecrets?.get(`${agent.companyId}:${secretName}`);
      nextEnv[secretName] = existing
        ? { type: "secret_ref", secretId: existing.id, version: "latest" }
        : { type: "pending_secret_ref", secretName };
      secretRefs.push(secretName);
      if (!existing) secretsToCreate.push(secretName);
    }
  }
  if (Object.keys(nextEnv).length > 0) nextAdapterConfig.env = nextEnv;
  else delete nextAdapterConfig.env;

  const currentRuntime = asRecord(agent.runtimeConfig);
  const heartbeat = asRecord(currentRuntime.heartbeat);
  const autonomyRecovery = { ...asRecord(currentRuntime.autonomyRecovery) };
  if ("previousHeartbeat" in autonomyRecovery) removedLegacyFields.push("runtimeConfig.autonomyRecovery.previousHeartbeat");
  delete autonomyRecovery.previousHeartbeat;
  const nextRuntimeConfig: JsonRecord = {
    ...currentRuntime,
    heartbeat: {
      ...heartbeat,
      enabled: false,
      intervalSec: 0,
      maxConcurrentRuns: 1,
      wakeOnDemand: heartbeat.wakeOnDemand !== false,
      wakeOnAssignment: heartbeat.wakeOnAssignment !== false,
      triggerMode: "event_only",
    },
    autonomyRecovery,
    factoryLoop: {
      ...asRecord(currentRuntime.factoryLoop),
      orchestrationVersion: MIGRATION_VERSION,
      triggerMode: "event_only",
      providerPolicySha256: input.policySha256,
      providerPolicySchemaSha256: input.policySchemaSha256,
    },
  };
  const leaked = [...scanForCredentialLiterals(nextAdapterConfig), ...scanForCredentialLiterals(nextRuntimeConfig)];
  if (leaked.length > 0) throw new Error(`Credential-shaped values remain after migration for ${agent.id}: ${leaked.join(",")}`);
  const retiredPolling = [...scanForRetiredPolling(nextAdapterConfig), ...scanForRetiredPolling(nextRuntimeConfig)];
  if (retiredPolling.length > 0) throw new Error(`Retired 300s polling or concurrency >1 remains for ${agent.id}: ${retiredPolling.join(",")}`);
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    agentName: agent.name,
    status: agent.status,
    capabilityAlias,
    budgetClass,
    beforeAdapterConfigSha256: sha256(agent.adapterConfig),
    afterAdapterConfigSha256: sha256(nextAdapterConfig),
    beforeRuntimeConfigSha256: sha256(agent.runtimeConfig),
    afterRuntimeConfigSha256: sha256(nextRuntimeConfig),
    changed: stableJson(agent.adapterConfig) !== stableJson(nextAdapterConfig) || stableJson(agent.runtimeConfig) !== stableJson(nextRuntimeConfig),
    removedLegacyFields,
    secretRefs,
    secretsToCreate,
    quarantinedSecretNames,
    nextAdapterConfig,
    nextRuntimeConfig,
  };
}

function publicAgentPlan(plan: AgentMigrationPlan) {
  const { nextAdapterConfig: _adapter, nextRuntimeConfig: _runtime, ...safe } = plan;
  return safe;
}

type MigrationTriggerPlan = {
  triggerId: string;
  routineId: string;
  before: { enabled: boolean; cronExpression: string | null; timezone: string | null; nextRunAt: string | null; updatedAt: string };
  after: { enabled: boolean; cronExpression: string | null; timezone: string | null; nextRunAt: string | null };
  classification: "twice_daily_market_voc_intake" | "retired_downstream_fixed_clock";
};

type MigrationRoutinePlan = {
  routineId: string;
  beforeStatus: string;
  afterStatus: "active";
};

type MigrationRollbackSnapshot = {
  schemaVersion: "paperclip.profit_flywheel_v2_rollback_snapshot.v1";
  agents: Array<{
    id: string;
    rollbackAdapterConfig: JsonRecord;
    rollbackRuntimeConfig: JsonRecord;
    rollbackAdapterConfigSha256: string;
    rollbackRuntimeConfigSha256: string;
    afterAdapterConfigSha256: string;
    afterRuntimeConfigSha256: string;
  }>;
  routineTriggers: Array<{
    id: string;
    beforeEnabled: boolean;
    beforeCronExpression: string | null;
    beforeTimezone: string | null;
    beforeNextRunAt: string | null;
    afterEnabled: boolean;
    afterCronExpression: string | null;
    afterTimezone: string | null;
    afterNextRunAt: string | null;
  }>;
  routines: Array<{ id: string; beforeStatus: string; afterStatus: "active" }>;
  nonCompensableSecurityRevocations: Array<{
    id: string;
    secretId: string;
    beforeRevokedAt: null;
    rollbackBehavior: "remain_revoked_pending_secure_replacement";
  }>;
};

function secureRollbackAdapterConfig(
  agent: Pick<ProfitFlywheelMigrationAgent, "id" | "companyId" | "name" | "adapterConfig">,
  knownSecrets: Map<string, SecretReference>,
  knownSecretIds: Map<string, SecretReference>,
  returnPlaneSecretEnvRefs: string[],
) {
  const rollbackConfig = structuredClone(asRecord(agent.adapterConfig));
  const nextEnv: JsonRecord = {};
  for (const [key, raw] of Object.entries(asRecord(rollbackConfig.env))) {
    if (COMPROMISED_PROVIDER_KEY.test(key)) continue;
    if (isSecretRef(raw)) {
      nextEnv[key] = validatedSecretReference({ raw, envKey: key, agent, knownSecretIds });
      continue;
    }
    const plain = plainEnvValue(raw);
    if (SENSITIVE_ENV_KEY.test(key) && plain !== null && plain.trim()) {
      const existing = knownSecrets.get(`${agent.companyId}:${key}`);
      if (!existing) throw new Error(`profit_flywheel_secure_secret_preseed_required: ${key}`);
      nextEnv[key] = { type: "secret_ref", secretId: existing.id, version: "latest" };
      continue;
    }
    nextEnv[key] = raw;
  }
  if (RETURN_PLANE_EXECUTOR_NAME.test(agent.name.trim())) {
    for (const secretName of returnPlaneSecretEnvRefs) {
      const existing = knownSecrets.get(`${agent.companyId}:${secretName}`);
      if (!existing) throw new Error(`profit_flywheel_secure_secret_preseed_required: ${secretName}`);
      nextEnv[secretName] = { type: "secret_ref", secretId: existing.id, version: "latest" };
    }
  }
  if (Object.keys(nextEnv).length > 0) rollbackConfig.env = nextEnv;
  else delete rollbackConfig.env;
  const leaked = scanForCredentialLiterals(rollbackConfig);
  if (leaked.length > 0) {
    throw new Error(`Rollback adapter snapshot contains credential-shaped values at ${leaked.join(",")}`);
  }
  return rollbackConfig;
}

async function writeImmutableJsonReceipt(receiptPath: string, value: unknown) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o444 });
  await chmod(receiptPath, 0o444);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeOrReuseMigrationIntent(
  receiptPath: string,
  value: { migrationRunId: string; planSha256: string } & Record<string, unknown>,
) {
  try {
    return await writeImmutableJsonReceipt(receiptPath, value);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const metadata = await lstat(receiptPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
      throw new Error(`Existing migration intent ${receiptPath} is not an immutable regular file`);
    }
    const bytes = await readFile(receiptPath);
    const existing = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const expected = { ...value, recordedAt: existing.recordedAt };
    const expectedBytes = `${JSON.stringify(expected, null, 2)}\n`;
    if (bytes.toString("utf8") !== expectedBytes) {
      throw new Error(`Existing migration intent ${receiptPath} does not exactly match the deterministic plan`);
    }
    return createHash("sha256").update(bytes).digest("hex");
  }
}

function deterministicMigrationRunId(planSha256: string) {
  const hex = planSha256.slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function waitForCommittedMigrationRun(db: Db, migrationRunId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await db.select().from(profitFlywheelMigrationRuns).where(and(
      eq(profitFlywheelMigrationRuns.id, migrationRunId),
      eq(profitFlywheelMigrationRuns.state, "applied"),
    )).then((rows) => rows[0] ?? null);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

export async function validateCommittedMigrationIntentReceipt(row: typeof profitFlywheelMigrationRuns.$inferSelect) {
  if (!path.isAbsolute(row.intentReceiptPath)) {
    throw new Error(`Applied migration ${row.id} intent receipt path is not absolute; refusing replay reconciliation`);
  }
  const metadata = await lstat(row.intentReceiptPath).catch((error) => {
    throw new Error(`Applied migration ${row.id} intent receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
    throw new Error(`Applied migration ${row.id} intent receipt is not an immutable regular file; refusing replay reconciliation`);
  }
  const intentBytes = await readFile(row.intentReceiptPath);
  const observedHash = createHash("sha256").update(intentBytes).digest("hex");
  if (observedHash !== row.intentReceiptSha256) {
    throw new Error(`Applied migration ${row.id} intent receipt hash mismatch; refusing replay reconciliation`);
  }
  let intent: JsonRecord;
  try {
    intent = asRecord(JSON.parse(intentBytes.toString("utf8")));
  } catch {
    throw new Error(`Applied migration ${row.id} intent receipt is not valid JSON; refusing replay reconciliation`);
  }
  const providerPolicy = asRecord(intent.providerPolicy);
  const sourceAudit = asRecord(intent.sourceAudit);
  const runtimePlaneContract = asRecord(intent.runtimePlaneContract);
  const credentials = asRecord(intent.credentials);
  const sourceAuditSha256 = typeof sourceAudit.sha256 === "string" ? sourceAudit.sha256 : "";
  const runtimePlaneContractSha256 = typeof runtimePlaneContract.sha256 === "string" ? runtimePlaneContract.sha256 : "";
  const expectedMigrationRunId = deterministicMigrationRunId(sha256({
    migrationVersion: row.migrationVersion,
    sourceAuditSha256,
    providerPolicySha256: row.providerPolicySha256,
    providerPolicySchemaSha256: row.providerPolicySchemaSha256,
    runtimePlaneContractSha256,
  }));
  const semanticMismatches: string[] = [];
  if (intent.schemaVersion !== "paperclip.profit_flywheel_v2_migration_intent.v1") semanticMismatches.push("schema_version");
  if (intent.migrationVersion !== row.migrationVersion) semanticMismatches.push("migration_version");
  if (intent.migrationRunId !== row.id) semanticMismatches.push("migration_run_id");
  if (expectedMigrationRunId !== row.id) semanticMismatches.push("authority_run_id");
  if (intent.state !== "intent_recorded") semanticMismatches.push("state");
  if (intent.planSha256 !== row.planSha256) semanticMismatches.push("plan_sha256");
  if (intent.rollbackSnapshotSha256 !== sha256(row.rollbackSnapshot)) semanticMismatches.push("rollback_snapshot_sha256");
  if (typeof intent.recordedAt !== "string" || !Number.isFinite(Date.parse(intent.recordedAt))) semanticMismatches.push("recorded_at");
  if (typeof sourceAudit.path !== "string" || !path.isAbsolute(sourceAudit.path)) semanticMismatches.push("source_audit_path");
  if (!/^[a-f0-9]{64}$/.test(sourceAuditSha256)) semanticMismatches.push("source_audit_sha256");
  if (typeof providerPolicy.path !== "string" || !path.isAbsolute(providerPolicy.path)) semanticMismatches.push("provider_policy_path");
  if (providerPolicy.sha256 !== row.providerPolicySha256) semanticMismatches.push("provider_policy_sha256");
  if (typeof providerPolicy.schemaPath !== "string" || !path.isAbsolute(providerPolicy.schemaPath)) semanticMismatches.push("provider_policy_schema_path");
  if (providerPolicy.schemaSha256 !== row.providerPolicySchemaSha256) semanticMismatches.push("provider_policy_schema_sha256");
  if (typeof runtimePlaneContract.path !== "string" || !path.isAbsolute(runtimePlaneContract.path)) semanticMismatches.push("runtime_plane_contract_path");
  if (!/^[a-f0-9]{64}$/.test(runtimePlaneContractSha256)) semanticMismatches.push("runtime_plane_contract_sha256");
  if (credentials.valuesRecorded !== false || credentials.secretValuesMigrated !== false) semanticMismatches.push("credential_disclosure_policy");
  if (semanticMismatches.length > 0) {
    throw new Error(`Applied migration ${row.id} intent receipt semantics do not match the committed database row (${semanticMismatches.join(",")}); refusing replay reconciliation`);
  }
  return { path: row.intentReceiptPath, sha256: observedHash, value: intent };
}

async function reconciledMigrationResult(row: typeof profitFlywheelMigrationRuns.$inferSelect) {
  await validateCommittedMigrationIntentReceipt(row);
  return {
    ...asRecord(row.result),
    migrationRunId: row.id,
    status: "OK" as const,
    state: row.state,
    idempotent: true,
    reconciled: true,
    receiptPath: row.intentReceiptPath,
    receiptSha256: row.intentReceiptSha256,
    rollback: {
      migrationRunId: row.id,
      procedure: "Run rollbackProfitFlywheelV2Migration against this migrationRunId; the database-stored snapshot is CAS protected.",
    },
  };
}

function receiptTimestamp(now: Date) {
  return now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

type RuntimeSecretBinding = {
  id: string;
  name: typeof RUNTIME_PLANE_SECRET_NAMES[number];
  version: number;
  valueSha256: string;
  provider: "local_encrypted";
};

async function loadActiveRuntimeSecret(
  db: Db,
  companyId: string,
  name: typeof RUNTIME_PLANE_SECRET_NAMES[number],
): Promise<RuntimeSecretBinding | null> {
  const secret = await db.select().from(companySecrets).where(and(
    eq(companySecrets.companyId, companyId),
    eq(companySecrets.name, name),
  )).then((rows) => rows[0] ?? null);
  if (!secret) return null;
  if (secret.provider !== "local_encrypted") {
    throw new Error(`profit_flywheel_runtime_secret_provider_invalid: ${name}; expected local_encrypted`);
  }
  const version = await db.select().from(companySecretVersions).where(and(
    eq(companySecretVersions.secretId, secret.id),
    eq(companySecretVersions.version, secret.latestVersion),
    isNull(companySecretVersions.revokedAt),
  )).then((rows) => rows[0] ?? null);
  if (!version || !/^[a-f0-9]{64}$/.test(version.valueSha256)) {
    throw new Error(`profit_flywheel_runtime_secret_inactive: ${name}`);
  }
  return {
    id: secret.id,
    name,
    version: version.version,
    valueSha256: version.valueSha256,
    provider: "local_encrypted",
  };
}

/**
 * Provision the one event-only Portfolio OS executor and its four encrypted
 * runtime-plane credentials.  This must run before the immutable fleet audit:
 * creating the executor after audit would invalidate the migration CAS input.
 * The return value and receipt deliberately expose only identifiers and hashes.
 */
export async function provisionProfitFlywheelRuntimeIdentity(db: Db, options: {
  companyId: string;
  apply?: boolean;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const companyId = options.companyId.trim();
  if (!/^[a-f0-9-]{36}$/i.test(companyId)) throw new Error("profit_flywheel_company_id_invalid");
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;

  const executorResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`profit-flywheel-runtime:${companyId}`}))`);
    const matches = await tx.select().from(agents).where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
    )).for("update").then((rows) => rows.filter((row) => RETURN_PLANE_EXECUTOR_NAME.test(row.name.trim())));
    if (matches.length > 1) {
      throw new Error(`profit_flywheel_executor_duplicate: company=${companyId}; agent_ids=${matches.map((row) => row.id).sort().join(",")}`);
    }
    if (matches[0]) return { agent: matches[0], created: false };
    if (!apply) return { agent: null, created: false };
    const created = await agentService(tx as unknown as Db).create(companyId, {
      name: RETURN_PLANE_EXECUTOR_CANONICAL_NAME,
      role: "operator",
      title: "Portfolio OS completion-event relay",
      capabilities: "Consume authorized research/stage/return outbox events and acknowledge immutable Profit Flywheel v2 receipts.",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          intervalSec: 0,
          maxConcurrentRuns: 1,
          wakeOnDemand: true,
          wakeOnAssignment: true,
          triggerMode: "event_only",
        },
      },
      budgetMonthlyCents: 0,
      permissions: { canCreateAgents: false },
      metadata: {
        managedBy: "paperclip.profit_flywheel_v2",
        runtimePurpose: "portfolio_os_research_stage_and_return_plane",
      },
    });
    return { agent: created, created: true };
  });

  const executor = executorResult.agent;
  const currentSecrets = Object.fromEntries(await Promise.all(
    RUNTIME_PLANE_SECRET_NAMES.map(async (name) => [name, await loadActiveRuntimeSecret(db, companyId, name)] as const),
  )) as Record<typeof RUNTIME_PLANE_SECRET_NAMES[number], RuntimeSecretBinding | null>;
  if (!apply) {
    return {
      schemaVersion: "paperclip.profit_flywheel_runtime_provisioning.v2",
      mode: "dry_run",
      status: executor && RUNTIME_PLANE_SECRET_NAMES.every((name) => currentSecrets[name]) ? "converged" : "changes_required",
      companyId,
      executor: executor ? { id: executor.id, created: false } : { id: null, created: false },
      secrets: RUNTIME_PLANE_SECRET_NAMES.map((name) => ({
        name,
        id: currentSecrets[name]?.id ?? null,
        version: currentSecrets[name]?.version ?? null,
        valueSha256: currentSecrets[name]?.valueSha256 ?? null,
        action: currentSecrets[name] ? "reuse" : "create_encrypted",
      })),
      plaintextValuesRecorded: false,
      observedAt: now.toISOString(),
    };
  }
  if (!executor) throw new Error("profit_flywheel_executor_creation_failed");

  const agentsSvc = agentService(db);
  const secretsSvc = secretService(db);
  let createdApiKeyId: string | null = null;
  let apiBinding = currentSecrets.PAPERCLIP_API_KEY;
  if (!apiBinding) {
    const createdKey = await agentsSvc.createApiKey(executor.id, RETURN_PLANE_API_KEY_NAME);
    createdApiKeyId = createdKey.id;
    try {
      await secretsSvc.create(companyId, {
        name: "PAPERCLIP_API_KEY",
        provider: "local_encrypted",
        value: createdKey.token,
        description: "Profit Flywheel v2 least-privilege Portfolio OS research/stage/return-plane API key",
      }, { agentId: executor.id });
    } catch (error) {
      const winner = await loadActiveRuntimeSecret(db, companyId, "PAPERCLIP_API_KEY");
      if (!winner) {
        await agentsSvc.revokeKey(createdKey.id).catch(() => undefined);
        throw error;
      }
      await agentsSvc.revokeKey(createdKey.id);
      createdApiKeyId = null;
    }
    apiBinding = await loadActiveRuntimeSecret(db, companyId, "PAPERCLIP_API_KEY");
  }
  if (!apiBinding) throw new Error("profit_flywheel_runtime_api_secret_creation_failed");

  for (const name of [
    "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY",
    "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY",
    "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY",
  ] as const) {
    if (currentSecrets[name]) continue;
    const value = randomBytes(32).toString("base64url");
    try {
      await secretsSvc.create(companyId, {
        name,
        provider: "local_encrypted",
        value,
        description: `Profit Flywheel v2 ${name === "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY"
          ? "return"
          : name === "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY" ? "research" : "stage"}-plane HMAC journal key`,
      }, { agentId: executor.id });
    } catch (error) {
      const winner = await loadActiveRuntimeSecret(db, companyId, name);
      if (!winner) throw error;
    }
    currentSecrets[name] = await loadActiveRuntimeSecret(db, companyId, name);
  }
  currentSecrets.PAPERCLIP_API_KEY = apiBinding;

  const bindings = RUNTIME_PLANE_SECRET_NAMES.map((name) => currentSecrets[name]);
  if (bindings.some((binding) => !binding)) throw new Error("profit_flywheel_runtime_secret_set_incomplete");
  const completeBindings = bindings as RuntimeSecretBinding[];
  if (new Set(completeBindings.map((binding) => binding.valueSha256)).size !== completeBindings.length) {
    throw new Error("profit_flywheel_runtime_plane_secret_reuse_forbidden: API and journal credentials must be pairwise distinct");
  }

  const apiKeys = await db.select().from(agentApiKeys).where(and(
    eq(agentApiKeys.agentId, executor.id),
    eq(agentApiKeys.name, RETURN_PLANE_API_KEY_NAME),
  ));
  const matchingActiveKeys = apiKeys.filter((key) => key.revokedAt === null && key.keyHash === apiBinding.valueSha256);
  if (matchingActiveKeys.length !== 1) {
    throw new Error(`profit_flywheel_runtime_api_key_binding_missing: agent=${executor.id}; matching_active_keys=${matchingActiveKeys.length}`);
  }
  const canonicalApiKey = matchingActiveKeys[0]!;
  const revokedSupersededApiKeyIds: string[] = [];
  for (const key of apiKeys) {
    if (key.id === canonicalApiKey.id || key.revokedAt !== null) continue;
    await agentsSvc.revokeKey(key.id);
    revokedSupersededApiKeyIds.push(key.id);
  }

  const receipt = {
    schemaVersion: "paperclip.profit_flywheel_runtime_provisioning.v2",
    mode: "apply",
    status: "OK",
    companyId,
    executor: {
      id: executor.id,
      name: executor.name,
      created: executorResult.created,
      adapterType: executor.adapterType,
      triggerMode: "event_only",
      maxConcurrentRuns: 1,
      canCreateAgents: false,
    },
    apiKey: {
      id: canonicalApiKey.id,
      createdId: createdApiKeyId,
      name: RETURN_PLANE_API_KEY_NAME,
      valueSha256: apiBinding.valueSha256,
      revokedSupersededIds: revokedSupersededApiKeyIds.sort(),
    },
    secrets: completeBindings.map((binding) => ({
      id: binding.id,
      name: binding.name,
      provider: binding.provider,
      version: binding.version,
      valueSha256: binding.valueSha256,
    })),
    plaintextValuesRecorded: false,
    observedAt: now.toISOString(),
    nextStep: "Generate a fresh read-only fleet audit after this receipt, then run the Profit Flywheel v2 migration dry-run.",
  };
  const receiptRoot = path.join(homeDir, "instances", instanceId, options.receiptDir ?? DEFAULT_RECEIPT_DIR);
  const receiptPath = path.join(receiptRoot, `${receiptTimestamp(now)}-runtime-provisioning-${companyId}.json`);
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return { ...receipt, receiptPath, receiptSha256 };
}

/**
 * Repair stale `agents.status=running` markers only when the same locked
 * company snapshot proves there is no queued/running heartbeat, active
 * flywheel stage, or lease.  The CAS prevents a newly refreshed agent marker
 * from being overwritten.  This is intentionally separate from fleet apply so
 * operators can inspect the dry-run receipt first.
 */
export async function reconcileStaleProfitFlywheelAgents(db: Db, options: {
  apply?: boolean;
  companyId?: string;
  agentId?: string;
  staleAfterMs?: number;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  now?: Date;
  testHooks?: { afterTransactionSafetyLock?: () => void | Promise<void> };
} = {}) {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const staleAfterMs = Math.max(60_000, Math.trunc(options.staleAfterMs ?? 30 * 60_000));
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const conditions = [eq(agents.status, "running"), lte(agents.updatedAt, cutoff)];
  if (options.companyId) conditions.push(eq(agents.companyId, options.companyId));
  if (options.agentId) conditions.push(eq(agents.id, options.agentId));
  const candidates = await db.select().from(agents).where(and(...conditions));
  candidates.sort((left, right) => left.id.localeCompare(right.id));

  const results: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const assess = async (tx: Db, mutate: boolean) => {
      const current = await tx.select().from(agents).where(eq(agents.id, candidate.id)).for("update")
        .then((rows) => rows[0] ?? null);
      if (!current || current.status !== "running" || current.updatedAt.getTime() !== candidate.updatedAt.getTime() || current.updatedAt > cutoff) {
        return { state: "skipped_cas_changed" as const, blockers: [] as string[] };
      }
      const [activeHeartbeats, activeStages, activeLeases] = await Promise.all([
        tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.agentId, current.id),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        )).for("update"),
        tx.select({ id: profitFlywheelStageRuns.id, state: profitFlywheelStageRuns.state }).from(profitFlywheelStageRuns).where(and(
          eq(profitFlywheelStageRuns.companyId, current.companyId),
          inArray(profitFlywheelStageRuns.state, ["running", "retry"]),
        )).for("update"),
        tx.select({ id: profitFlywheelLeases.id, stageRunId: profitFlywheelLeases.stageRunId }).from(profitFlywheelLeases)
          .where(eq(profitFlywheelLeases.companyId, current.companyId)).for("update"),
      ]);
      const blockers = [
        ...activeHeartbeats.map((row) => `heartbeat_run:${row.id}:${row.status}`),
        ...activeStages.map((row) => `flywheel_stage:${row.id}:${row.state}`),
        ...activeLeases.map((row) => `flywheel_lease:${row.id}:stage:${row.stageRunId}`),
      ].sort();
      if (blockers.length > 0) return { state: "blocked_active_work" as const, blockers };
      if (!mutate) return { state: "eligible" as const, blockers };
      const updated = await tx.update(agents).set({ status: "idle", updatedAt: now }).where(and(
        eq(agents.id, current.id),
        eq(agents.status, "running"),
        eq(agents.updatedAt, current.updatedAt),
      )).returning({ id: agents.id });
      if (updated.length !== 1) return { state: "skipped_cas_changed" as const, blockers: [] as string[] };
      return { state: "reconciled_idle" as const, blockers: [] as string[] };
    };

    const outcome = apply
      ? await db.transaction(async (tx) => {
          await tx.execute(sql.raw("LOCK TABLE agents, heartbeat_runs, profit_flywheel_stage_runs, profit_flywheel_leases IN SHARE ROW EXCLUSIVE MODE"));
          await options.testHooks?.afterTransactionSafetyLock?.();
          return assess(tx as unknown as Db, true);
        })
      : await assess(db, false);
    results.push({
      agentId: candidate.id,
      companyId: candidate.companyId,
      agentName: candidate.name,
      observedStatus: candidate.status,
      observedUpdatedAt: candidate.updatedAt.toISOString(),
      staleCutoff: cutoff.toISOString(),
      state: outcome.state,
      blockers: outcome.blockers,
    });
  }

  const receipt = {
    schemaVersion: "paperclip.profit_flywheel_stale_agent_reconciliation.v1",
    mode: apply ? "apply" : "dry_run",
    status: results.some((result) => result.state === "blocked_active_work") ? "BLOCKED" : "OK",
    filters: { companyId: options.companyId ?? null, agentId: options.agentId ?? null },
    staleAfterMs,
    staleCutoff: cutoff.toISOString(),
    candidateCount: results.length,
    reconciledCount: results.filter((result) => result.state === "reconciled_idle").length,
    results,
    safetyInvariant: "No queued/running heartbeat, active company flywheel stage, or company flywheel lease under the same table lock; agent status and updated_at CAS must still match.",
    observedAt: now.toISOString(),
  };
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const receiptRoot = path.join(homeDir, "instances", instanceId, options.receiptDir ?? DEFAULT_RECEIPT_DIR);
  const suffix = options.agentId ?? options.companyId ?? "all";
  const receiptPath = path.join(receiptRoot, `${receiptTimestamp(now)}-stale-agent-reconciliation-${suffix}.json`);
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return { ...receipt, receiptPath, receiptSha256 };
}

export async function migrateProfitFlywheelV2(db: Db, options: {
  apply?: boolean;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  now?: Date;
  backup?: boolean;
  connectionString?: string;
  auditPath?: string;
  auditSha256?: string;
  testHooks?: {
    beforeTransactionSafetyCheck?: () => void | Promise<void>;
    afterTransactionSafetyLock?: () => void | Promise<void>;
    afterMutationsBeforeCommit?: () => void | Promise<void>;
  };
} = {}) {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const [loadedPolicy, runtimePlaneContract] = await Promise.all([
    loadProviderPolicyV2(),
    loadRuntimePlaneContract(),
  ]);
  const auditPath = options.auditPath ?? LIVE_FLEET_AUDIT_PATH;
  const auditSha256 = options.auditSha256 ?? LIVE_FLEET_AUDIT_SHA256;
  const auditBytes = await readFile(auditPath);
  if (createHash("sha256").update(auditBytes).digest("hex") !== auditSha256) {
    throw new Error("Live fleet audit bytes do not match the pinned pre-migration receipt");
  }
  const authorityMigrationRunId = deterministicMigrationRunId(sha256({
    migrationVersion: MIGRATION_VERSION,
    sourceAuditSha256: auditSha256,
    providerPolicySha256: loadedPolicy.sha256,
    providerPolicySchemaSha256: loadedPolicy.schemaSha256,
    runtimePlaneContractSha256: runtimePlaneContract.sha256,
  }));
  const [rows, secrets, scheduleRows] = await Promise.all([
    db.select().from(agents),
    db.select().from(companySecrets),
    db.select({
      id: routineTriggers.id,
      routineId: routineTriggers.routineId,
      enabled: routineTriggers.enabled,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      nextRunAt: routineTriggers.nextRunAt,
      kind: routineTriggers.kind,
      title: routines.title,
      triggerUpdatedAt: routineTriggers.updatedAt,
      routineStatus: routines.status,
      routineUpdatedAt: routines.updatedAt,
    }).from(routineTriggers).innerJoin(routines, eq(routineTriggers.routineId, routines.id)),
  ]);
  const reconcileCommittedAuthorityRun = async (row: typeof profitFlywheelMigrationRuns.$inferSelect) => {
    const snapshot = row.rollbackSnapshot as unknown as MigrationRollbackSnapshot;
    const canonicalTransition = asRecord(asRecord(asRecord(row.result).fleetHashTransition).canonical);
    const expectedAfterSha256 = typeof canonicalTransition.after === "string" ? canonicalTransition.after : "";
    const [currentAgentRows, currentScheduleRows] = await Promise.all([
      db.select().from(agents),
      db.select({
        id: routineTriggers.id,
        routineId: routineTriggers.routineId,
        enabled: routineTriggers.enabled,
        cronExpression: routineTriggers.cronExpression,
        timezone: routineTriggers.timezone,
        nextRunAt: routineTriggers.nextRunAt,
        routineStatus: routines.status,
      }).from(routineTriggers).innerJoin(routines, eq(routineTriggers.routineId, routines.id)),
    ]);
    const liveRows = currentAgentRows.filter((agent) => agent.status !== "terminated");
    const liveById = new Map(liveRows.map((agent) => [agent.id, agent]));
    const fleetConverged = /^[a-f0-9]{64}$/.test(expectedAfterSha256) &&
      liveRows.length === snapshot.agents.length && migrationFleetCanonicalSha256(liveRows) === expectedAfterSha256 &&
      snapshot.agents.every((agent) => {
        const current = liveById.get(agent.id);
        return current && sha256(current.adapterConfig) === agent.afterAdapterConfigSha256 &&
          sha256(current.runtimeConfig) === agent.afterRuntimeConfigSha256;
      });
    const scheduleById = new Map(currentScheduleRows.map((trigger) => [trigger.id, trigger]));
    const schedulesConverged = snapshot.routineTriggers.every((trigger) => {
      const current = scheduleById.get(trigger.id);
      return current && current.enabled === trigger.afterEnabled && current.cronExpression === trigger.afterCronExpression &&
        current.timezone === trigger.afterTimezone && (current.nextRunAt?.toISOString() ?? null) === trigger.afterNextRunAt;
    }) && snapshot.routines.every((routine) => currentScheduleRows.some((entry) => entry.routineId === routine.id && entry.routineStatus === routine.afterStatus));
    const revocationIds = snapshot.nonCompensableSecurityRevocations.map((entry) => entry.id);
    const revocationsConverged = revocationIds.length === 0 || await db.select({ id: companySecretVersions.id }).from(companySecretVersions).where(and(
      inArray(companySecretVersions.id, revocationIds),
      isNotNull(companySecretVersions.revokedAt),
    )).then((versions) => versions.length === revocationIds.length);
    if (!fleetConverged || !schedulesConverged || !revocationsConverged) {
      throw new Error(`Applied migration ${row.id} exists but the canonical post-migration fleet, schedules, or security revocations have drifted`);
    }
    return reconciledMigrationResult(row);
  };
  if (apply) {
    const committed = await db.select().from(profitFlywheelMigrationRuns).where(and(
      eq(profitFlywheelMigrationRuns.id, authorityMigrationRunId),
      eq(profitFlywheelMigrationRuns.state, "applied"),
      eq(profitFlywheelMigrationRuns.providerPolicySha256, loadedPolicy.sha256),
      eq(profitFlywheelMigrationRuns.providerPolicySchemaSha256, loadedPolicy.schemaSha256),
    )).then((existing) => existing[0] ?? null);
    if (committed) return reconcileCommittedAuthorityRun(committed);
  }
  let fleetAudit: ReturnType<typeof validateFleetAuditSnapshot>;
  try {
    fleetAudit = validateFleetAuditSnapshot(auditBytes, rows);
  } catch (error) {
    if (apply) {
      const winner = await waitForCommittedMigrationRun(db, authorityMigrationRunId);
      if (winner) return reconcileCommittedAuthorityRun(winner);
    }
    throw error;
  }
  const secretVersionRows = secrets.length > 0
    ? await db.select({
        id: companySecretVersions.id,
        secretId: companySecretVersions.secretId,
        version: companySecretVersions.version,
        valueSha256: companySecretVersions.valueSha256,
        revokedAt: companySecretVersions.revokedAt,
      }).from(companySecretVersions).where(inArray(companySecretVersions.secretId, secrets.map((secret) => secret.id)))
    : [];
  const latestVersionBySecretId = new Map(secretVersionRows.map((version) => [`${version.secretId}:${version.version}`, version]));
  const knownSecretIds = new Map<string, SecretReference>();
  const knownSecrets = new Map<string, SecretReference>();
  for (const secret of secrets) {
    const latest = latestVersionBySecretId.get(`${secret.id}:${secret.latestVersion}`);
    const reference = {
      id: secret.id,
      name: secret.name,
      companyId: secret.companyId,
      active: Boolean(latest && latest.revokedAt === null),
      valueSha256: latest?.valueSha256,
    };
    knownSecretIds.set(secret.id, reference);
    if (reference.active && !COMPROMISED_PROVIDER_KEY.test(secret.name)) {
      knownSecrets.set(`${secret.companyId}:${secret.name}`, reference);
    }
  }
  const acceptance = rows.filter((agent) => agent.status !== "terminated").sort((left, right) => left.id.localeCompare(right.id));
  const retired = rows.filter((agent) => agent.status === "terminated").sort((left, right) => left.id.localeCompare(right.id));
  const initialPlans = acceptance.map((agent) => planProfitFlywheelV2Agent({
    agent,
    policy: loadedPolicy.policy,
    policyPath: loadedPolicy.path,
    policySha256: loadedPolicy.sha256,
    policySchemaPath: loadedPolicy.schemaPath,
    policySchemaSha256: loadedPolicy.schemaSha256,
    knownSecrets,
    knownSecretIds,
    returnPlaneSecretEnvRefs: runtimePlaneContract.runtimeSecretEnvRefs,
  }));
  const planByAgentId = new Map(initialPlans.map((plan) => [plan.agentId, plan]));
  const preMigrationFleetCanonicalSha256 = migrationFleetCanonicalSha256(acceptance);
  const postMigrationFleetCanonicalSha256 = migrationFleetCanonicalSha256(acceptance.map((agent) => {
    const plan = planByAgentId.get(agent.id)!;
    return { ...agent, adapterConfig: plan.nextAdapterConfig, runtimeConfig: plan.nextRuntimeConfig };
  }));
  for (const agent of acceptance.filter((candidate) => RETURN_PLANE_EXECUTOR_NAME.test(candidate.name.trim()))) {
    const runtimeSecrets = runtimePlaneContract.runtimeSecretEnvRefs.map((name) => knownSecrets.get(`${agent.companyId}:${name}`));
    const valueHashes = runtimeSecrets.map((secret) => secret?.valueSha256).filter((value): value is string => typeof value === "string");
    if (valueHashes.length === runtimeSecrets.length && new Set(valueHashes).size !== valueHashes.length) {
      throw new Error(`profit_flywheel_runtime_plane_secret_reuse_forbidden: agent=${agent.id}; API and journal credentials must be pairwise distinct`);
    }
  }
  const acceptanceIds = acceptance.map((agent) => agent.id);
  const [activeHeartbeatRows, activeStageRows, activeLeaseRows] = await Promise.all([
    acceptanceIds.length > 0
      ? db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
          .from(heartbeatRuns).where(and(inArray(heartbeatRuns.agentId, acceptanceIds), inArray(heartbeatRuns.status, ["queued", "running"])))
      : [],
    db.select({ id: profitFlywheelStageRuns.id, state: profitFlywheelStageRuns.state })
      .from(profitFlywheelStageRuns).where(inArray(profitFlywheelStageRuns.state, ["running", "retry"])),
    db.select({ id: profitFlywheelLeases.id, stageRunId: profitFlywheelLeases.stageRunId })
      .from(profitFlywheelLeases),
  ]);
  const activeStatusAgents = acceptance.filter((agent) => agent.status === "running");
  const activeControlBlockers = [
    ...activeStatusAgents.map((agent) => ({ kind: "agent_status" as const, id: agent.id, agentId: agent.id, status: agent.status })),
    ...activeHeartbeatRows.map((run) => ({ kind: "heartbeat_run" as const, id: run.id, agentId: run.agentId, status: run.status })),
    ...activeStageRows.map((stage) => ({ kind: "flywheel_stage" as const, id: stage.id, agentId: null, status: stage.state })),
    ...activeLeaseRows.map((lease) => ({ kind: "flywheel_lease" as const, id: lease.id, agentId: null, status: `stage:${lease.stageRunId}` })),
  ];
  const triggerPlans: MigrationTriggerPlan[] = scheduleRows.flatMap((trigger) => {
    if (trigger.kind !== "schedule") return [];
    const classification = classifyProfitFlywheelRoutineTitle(trigger.title);
    if (!classification) return [];
    const isIntake = classification === "twice_daily_market_voc_intake";
    const intakeTimezone = trigger.timezone ?? CANONICAL_INTAKE_TIME_ZONE;
    const nextIntakeTick = isIntake ? nextCronTickInTimeZone(CANONICAL_INTAKE_CRON, intakeTimezone, now) : null;
    if (isIntake && !nextIntakeTick) throw new Error(`Unable to compute canonical intake tick for trigger ${trigger.id}`);
    const intakeNextRunAt = nextIntakeTick?.toISOString() ?? null;
    return {
      triggerId: trigger.id,
      routineId: trigger.routineId,
      before: {
        enabled: trigger.enabled,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
        updatedAt: trigger.triggerUpdatedAt.toISOString(),
      },
      after: isIntake
        ? { enabled: true, cronExpression: CANONICAL_INTAKE_CRON, timezone: intakeTimezone, nextRunAt: intakeNextRunAt }
        : { enabled: false, cronExpression: trigger.cronExpression, timezone: trigger.timezone, nextRunAt: null },
      classification,
    };
  }).sort((left, right) => left.triggerId.localeCompare(right.triggerId));
  const routinePlanById = new Map<string, MigrationRoutinePlan>();
  for (const trigger of scheduleRows) {
    if (classifyProfitFlywheelRoutineTitle(trigger.title) !== "twice_daily_market_voc_intake") continue;
    const existing = routinePlanById.get(trigger.routineId);
    if (existing && existing.beforeStatus !== trigger.routineStatus) {
      throw new Error(`Routine ${trigger.routineId} changed status during migration planning`);
    }
    routinePlanById.set(trigger.routineId, {
      routineId: trigger.routineId,
      beforeStatus: trigger.routineStatus,
      afterStatus: "active",
    });
  }
  const routinePlans = [...routinePlanById.values()].sort((left, right) => left.routineId.localeCompare(right.routineId));
  if (apply && activeControlBlockers.length > 0) {
    throw new Error(`Refusing live migration while authoritative execution is active: ${activeControlBlockers.map((blocker) => `${blocker.kind}:${blocker.id}`).join(",")}`);
  }

  const secureSecretNamesRequired = [...new Set(initialPlans.flatMap((plan) => plan.secretsToCreate))].sort();
  if (apply && secureSecretNamesRequired.length > 0) {
    throw new Error(
      `profit_flywheel_secure_secret_preseed_required: ${secureSecretNamesRequired.join(",")}; create company secret references through the encrypted secret service before apply`,
    );
  }

  let backupReceipt: unknown = null;
  const appliedPlans = initialPlans;
  const compromisedSecrets = secrets.filter((secret) => COMPROMISED_PROVIDER_KEY.test(secret.name));
  const compromisedSecretIds = compromisedSecrets.map((secret) => secret.id);
  const unrevokedCompromisedVersions = compromisedSecretIds.length > 0
    ? await db.select({
        id: companySecretVersions.id,
        secretId: companySecretVersions.secretId,
      }).from(companySecretVersions).where(and(
        inArray(companySecretVersions.secretId, compromisedSecretIds),
        isNull(companySecretVersions.revokedAt),
      ))
    : [];
  unrevokedCompromisedVersions.sort((left, right) => left.id.localeCompare(right.id));
  const rollbackSnapshot: MigrationRollbackSnapshot = {
    schemaVersion: "paperclip.profit_flywheel_v2_rollback_snapshot.v1",
    agents: appliedPlans.map((plan) => {
      const source = acceptance.find((agent) => agent.id === plan.agentId)!;
      const rollbackAdapterConfig = secureRollbackAdapterConfig(
        source,
        knownSecrets,
        knownSecretIds,
        runtimePlaneContract.runtimeSecretEnvRefs,
      );
      const rollbackRuntimeConfig = structuredClone(asRecord(source.runtimeConfig));
      const runtimeLeaks = scanForCredentialLiterals(rollbackRuntimeConfig);
      if (runtimeLeaks.length > 0) {
        throw new Error(`Rollback runtime snapshot contains credential-shaped values for ${source.id}: ${runtimeLeaks.join(",")}`);
      }
      return {
        id: plan.agentId,
        rollbackAdapterConfig,
        rollbackRuntimeConfig,
        rollbackAdapterConfigSha256: sha256(rollbackAdapterConfig),
        rollbackRuntimeConfigSha256: sha256(rollbackRuntimeConfig),
        afterAdapterConfigSha256: plan.afterAdapterConfigSha256,
        afterRuntimeConfigSha256: plan.afterRuntimeConfigSha256,
      };
    }),
    routineTriggers: triggerPlans.map((trigger) => ({
      id: trigger.triggerId,
      beforeEnabled: trigger.before.enabled,
      beforeCronExpression: trigger.before.cronExpression,
      beforeTimezone: trigger.before.timezone,
      beforeNextRunAt: trigger.before.nextRunAt,
      afterEnabled: trigger.after.enabled,
      afterCronExpression: trigger.after.cronExpression,
      afterTimezone: trigger.after.timezone,
      afterNextRunAt: trigger.after.nextRunAt,
    })),
    routines: routinePlans.map((routine) => ({
      id: routine.routineId,
      beforeStatus: routine.beforeStatus,
      afterStatus: routine.afterStatus,
    })),
    nonCompensableSecurityRevocations: unrevokedCompromisedVersions.map((version) => ({
      id: version.id,
      secretId: version.secretId,
      beforeRevokedAt: null,
      rollbackBehavior: "remain_revoked_pending_secure_replacement" as const,
    })),
  };
  const publicPlan = {
    schemaVersion: MIGRATION_VERSION,
    sourceAudit: { path: auditPath, sha256: auditSha256, ...fleetAudit },
    fleetHashTransition: {
      sourceAuditLegacy: {
        sha256: fleetAudit.fleetConfigSha256,
        method: fleetAudit.fleetHashMethod,
      },
      canonical: {
        before: preMigrationFleetCanonicalSha256,
        after: postMigrationFleetCanonicalSha256,
        method: "sha256(stable_json([{id,adapterConfig,runtimeConfig} sorted by id]))",
      },
    },
    providerPolicySha256: loadedPolicy.sha256,
    providerPolicySchemaSha256: loadedPolicy.schemaSha256,
    agents: appliedPlans.map(publicAgentPlan),
    routineTriggers: triggerPlans,
    routines: routinePlans,
    runtimePlaneContract,
    revokedCompromisedSecretVersionIds: unrevokedCompromisedVersions.map((row) => row.id).sort(),
    rollbackSnapshotSha256: sha256(rollbackSnapshot),
  };
  const planSha256 = sha256(publicPlan);
  const migrationRunId = authorityMigrationRunId;
  const receiptRoot = path.join(homeDir, "instances", instanceId, options.receiptDir ?? DEFAULT_RECEIPT_DIR);

  if (apply) {
    const exactCommittedRun = await db.select().from(profitFlywheelMigrationRuns).where(and(
      eq(profitFlywheelMigrationRuns.planSha256, planSha256),
      eq(profitFlywheelMigrationRuns.state, "applied"),
    )).then((rows) => rows[0] ?? null);
    if (exactCommittedRun) return reconciledMigrationResult(exactCommittedRun);
    const converged = appliedPlans.every((plan) => !plan.changed) &&
      triggerPlans.every((trigger) => stableJson({ ...trigger.before, updatedAt: undefined }) === stableJson(trigger.after)) &&
      routinePlans.every((routine) => routine.beforeStatus === routine.afterStatus) &&
      unrevokedCompromisedVersions.length === 0;
    if (converged) {
      const compatibleRuns = await db.select().from(profitFlywheelMigrationRuns).where(and(
        eq(profitFlywheelMigrationRuns.migrationVersion, MIGRATION_VERSION),
        eq(profitFlywheelMigrationRuns.state, "applied"),
        eq(profitFlywheelMigrationRuns.providerPolicySha256, loadedPolicy.sha256),
        eq(profitFlywheelMigrationRuns.providerPolicySchemaSha256, loadedPolicy.schemaSha256),
      ));
      const latest = compatibleRuns.sort((left, right) =>
        (right.appliedAt?.getTime() ?? 0) - (left.appliedAt?.getTime() ?? 0))[0] ?? null;
      if (latest) return reconciledMigrationResult(latest);
    }
    if (options.backup !== false) {
      if (!options.connectionString) throw new Error("Apply mode requires connectionString for the pre-migration database backup");
      backupReceipt = await runDatabaseBackup({
        connectionString: options.connectionString,
        backupDir: path.join(homeDir, "instances", instanceId, "backups"),
        retentionDays: 30,
        keepLatestBackups: 5,
        filenamePrefix: "profit-flywheel-v2-pre-migration",
        compression: "gzip",
      });
    }
    const intentReceipt = {
      schemaVersion: "paperclip.profit_flywheel_v2_migration_intent.v1",
      migrationVersion: MIGRATION_VERSION,
      migrationRunId,
      state: "intent_recorded",
      recordedAt: now.toISOString(),
      planSha256,
      rollbackSnapshotSha256: publicPlan.rollbackSnapshotSha256,
      sourceAudit: publicPlan.sourceAudit,
      providerPolicy: {
        path: loadedPolicy.path,
        sha256: loadedPolicy.sha256,
        schemaPath: loadedPolicy.schemaPath,
        schemaSha256: loadedPolicy.schemaSha256,
        policyId: loadedPolicy.policy.policyId,
        revision: loadedPolicy.policy.revision,
      },
      runtimePlaneContract: {
        path: runtimePlaneContract.path,
        sha256: runtimePlaneContract.sha256,
      },
      counts: {
        acceptanceAgents: appliedPlans.length,
        changedAgents: appliedPlans.filter((plan) => plan.changed).length,
        routineTriggers: triggerPlans.length,
        routines: routinePlans.length,
        revokedCompromisedSecretVersions: unrevokedCompromisedVersions.length,
      },
      databaseBackupRequired: options.backup !== false,
      fleetHashTransition: publicPlan.fleetHashTransition,
      credentials: { valuesRecorded: false, secretValuesMigrated: false },
    };
    const intentReceiptPath = path.join(
      receiptRoot,
      `${migrationRunId}-profit-flywheel-v2-migration-apply-intent.json`,
    );
    let intentReceiptSha256: string;
    try {
      intentReceiptSha256 = await writeOrReuseMigrationIntent(intentReceiptPath, intentReceipt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not exactly match the deterministic plan")) {
        const concurrentWinner = await waitForCommittedMigrationRun(db, migrationRunId);
        if (concurrentWinner) return reconciledMigrationResult(concurrentWinner);
      }
      throw error;
    }
    const migrationResult = {
      schemaVersion: MIGRATION_VERSION,
      mode: "apply",
      status: "OK",
      observedAt: now.toISOString(),
      planSha256,
      intentReceiptPath,
      intentReceiptSha256,
      backupCreated: backupReceipt !== null,
      databaseBackup: backupReceipt,
      changedAgentCount: appliedPlans.filter((plan) => plan.changed).length,
      triggerCount: triggerPlans.length,
      routineCount: routinePlans.length,
      revokedCompromisedSecretVersionCount: unrevokedCompromisedVersions.length,
      fleetHashTransition: publicPlan.fleetHashTransition,
    };
    await options.testHooks?.beforeTransactionSafetyCheck?.();
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(
          "LOCK TABLE agents, heartbeat_runs, profit_flywheel_stage_runs, profit_flywheel_leases, routines, routine_triggers, company_secret_versions IN SHARE ROW EXCLUSIVE MODE",
        ));
        const agentIds = appliedPlans.map((plan) => plan.agentId);
        const currentAgents = agentIds.length > 0
          ? await tx.select().from(agents).where(inArray(agents.id, agentIds)).for("update")
          : [];
        const [transactionHeartbeatRows, transactionStageRows, transactionLeaseRows] = await Promise.all([
          agentIds.length > 0
            ? tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
                .from(heartbeatRuns).where(and(
                  inArray(heartbeatRuns.agentId, agentIds),
                  inArray(heartbeatRuns.status, ["queued", "running"]),
                )).for("update")
            : [],
          tx.select({ id: profitFlywheelStageRuns.id, state: profitFlywheelStageRuns.state })
            .from(profitFlywheelStageRuns).where(inArray(profitFlywheelStageRuns.state, ["running", "retry"])).for("update"),
          tx.select({ id: profitFlywheelLeases.id, stageRunId: profitFlywheelLeases.stageRunId })
            .from(profitFlywheelLeases).for("update"),
        ]);
        const transactionBlockers = [
          ...currentAgents.filter((agent) => agent.status === "running").map((agent) => `agent_status:${agent.id}`),
          ...transactionHeartbeatRows.map((run) => `heartbeat_run:${run.id}`),
          ...transactionStageRows.map((stage) => `flywheel_stage:${stage.id}`),
          ...transactionLeaseRows.map((lease) => `flywheel_lease:${lease.id}`),
        ];
        if (transactionBlockers.length > 0) {
          throw new Error(`Refusing live migration while authoritative execution is active: ${transactionBlockers.join(",")}`);
        }
        await options.testHooks?.afterTransactionSafetyLock?.();
        const currentById = new Map(currentAgents.map((agent) => [agent.id, agent]));
        for (const plan of appliedPlans) {
          const current = currentById.get(plan.agentId);
          if (!current || sha256(current.adapterConfig) !== plan.beforeAdapterConfigSha256 || sha256(current.runtimeConfig) !== plan.beforeRuntimeConfigSha256) {
            throw new Error(`Agent ${plan.agentId} changed after migration planning; CAS aborted`);
          }
          const updated = await tx.update(agents).set({ adapterConfig: plan.nextAdapterConfig, runtimeConfig: plan.nextRuntimeConfig, updatedAt: now })
            .where(and(eq(agents.id, plan.agentId), ne(agents.status, "terminated")))
            .returning({ id: agents.id });
          if (updated.length !== 1) throw new Error(`Agent ${plan.agentId} CAS update lost a race`);
        }
        for (const routine of routinePlans) {
          const updated = await tx.update(routines).set({ status: routine.afterStatus, updatedAt: now }).where(and(
            eq(routines.id, routine.routineId),
            eq(routines.status, routine.beforeStatus),
          )).returning({ id: routines.id });
          if (updated.length !== 1) throw new Error(`Routine ${routine.routineId} CAS update lost a race`);
        }
        for (const trigger of triggerPlans) {
          const updated = await tx.update(routineTriggers).set({
            enabled: trigger.after.enabled,
            cronExpression: trigger.after.cronExpression,
            timezone: trigger.after.timezone,
            nextRunAt: trigger.after.nextRunAt ? new Date(trigger.after.nextRunAt) : null,
            updatedAt: now,
          }).where(and(
            eq(routineTriggers.id, trigger.triggerId),
            eq(routineTriggers.enabled, trigger.before.enabled),
            trigger.before.cronExpression === null
              ? isNull(routineTriggers.cronExpression)
              : eq(routineTriggers.cronExpression, trigger.before.cronExpression),
            trigger.before.timezone === null
              ? isNull(routineTriggers.timezone)
              : eq(routineTriggers.timezone, trigger.before.timezone),
            trigger.before.nextRunAt === null
              ? isNull(routineTriggers.nextRunAt)
              : eq(routineTriggers.nextRunAt, new Date(trigger.before.nextRunAt)),
          )).returning({ id: routineTriggers.id });
          if (updated.length !== 1) throw new Error(`Routine trigger ${trigger.triggerId} CAS update lost a race`);
        }
        if (unrevokedCompromisedVersions.length > 0) {
          const revoked = await tx.update(companySecretVersions).set({ revokedAt: now }).where(and(
            inArray(companySecretVersions.id, unrevokedCompromisedVersions.map((row) => row.id)),
            isNull(companySecretVersions.revokedAt),
          )).returning({ id: companySecretVersions.id });
          if (revoked.length !== unrevokedCompromisedVersions.length) {
            throw new Error("Compromised secret version revocation CAS lost a race");
          }
        }
        const postMutationRows = await tx.select().from(agents);
        const postMutationAcceptance = postMutationRows.filter((agent) => agent.status !== "terminated");
        const observedPostMigrationFleetSha256 = migrationFleetCanonicalSha256(postMutationAcceptance);
        if (postMutationAcceptance.length !== fleetAudit.liveAgentRows ||
            observedPostMigrationFleetSha256 !== postMigrationFleetCanonicalSha256) {
          throw new Error(
            `Post-migration fleet acceptance drift: expected_count=${fleetAudit.liveAgentRows} observed_count=${postMutationAcceptance.length} expected_sha256=${postMigrationFleetCanonicalSha256} observed_sha256=${observedPostMigrationFleetSha256}`,
          );
        }
        await options.testHooks?.afterMutationsBeforeCommit?.();
        await tx.insert(profitFlywheelMigrationRuns).values({
          id: migrationRunId,
          migrationVersion: MIGRATION_VERSION,
          state: "applied",
          planSha256,
          intentReceiptPath,
          intentReceiptSha256,
          providerPolicySha256: loadedPolicy.sha256,
          providerPolicySchemaSha256: loadedPolicy.schemaSha256,
          rollbackSnapshot: rollbackSnapshot as unknown as Record<string, unknown>,
          result: migrationResult,
          appliedAt: now,
          updatedAt: now,
        });
      });
    } catch (error) {
      const winner = await db.select().from(profitFlywheelMigrationRuns).where(and(
        eq(profitFlywheelMigrationRuns.planSha256, planSha256),
        eq(profitFlywheelMigrationRuns.state, "applied"),
      )).then((rows) => rows[0] ?? null);
      if (winner) return reconciledMigrationResult(winner);
      const compatibleWinners = await db.select().from(profitFlywheelMigrationRuns).where(and(
        eq(profitFlywheelMigrationRuns.migrationVersion, MIGRATION_VERSION),
        eq(profitFlywheelMigrationRuns.state, "applied"),
        eq(profitFlywheelMigrationRuns.providerPolicySha256, loadedPolicy.sha256),
        eq(profitFlywheelMigrationRuns.providerPolicySchemaSha256, loadedPolicy.schemaSha256),
      ));
      if (compatibleWinners.length > 0) {
        const [currentAgents, currentTriggers, currentRoutines] = await Promise.all([
          appliedPlans.length > 0
            ? db.select().from(agents).where(inArray(agents.id, appliedPlans.map((plan) => plan.agentId)))
            : [],
          triggerPlans.length > 0
            ? db.select().from(routineTriggers).where(inArray(routineTriggers.id, triggerPlans.map((plan) => plan.triggerId)))
            : [],
          routinePlans.length > 0
            ? db.select().from(routines).where(inArray(routines.id, routinePlans.map((plan) => plan.routineId)))
            : [],
        ]);
        const agentById = new Map(currentAgents.map((agent) => [agent.id, agent]));
        const triggerById = new Map(currentTriggers.map((trigger) => [trigger.id, trigger]));
        const routineById = new Map(currentRoutines.map((routine) => [routine.id, routine]));
        const fleetConverged = appliedPlans.every((plan) => {
          const agent = agentById.get(plan.agentId);
          return agent && sha256(agent.adapterConfig) === plan.afterAdapterConfigSha256 && sha256(agent.runtimeConfig) === plan.afterRuntimeConfigSha256;
        });
        const schedulesConverged = triggerPlans.every((plan) => {
          const trigger = triggerById.get(plan.triggerId);
          return trigger && trigger.enabled === plan.after.enabled && trigger.cronExpression === plan.after.cronExpression &&
            trigger.timezone === plan.after.timezone && (trigger.nextRunAt?.toISOString() ?? null) === plan.after.nextRunAt;
        }) && routinePlans.every((plan) => routineById.get(plan.routineId)?.status === plan.afterStatus);
        if (fleetConverged && schedulesConverged) {
          const latest = compatibleWinners.sort((left, right) =>
            (right.appliedAt?.getTime() ?? 0) - (left.appliedAt?.getTime() ?? 0))[0]!;
          return reconciledMigrationResult(latest);
        }
      }
      throw error;
    }
    return {
      ...migrationResult,
      migrationRunId,
      sourceAudit: publicPlan.sourceAudit,
      providerPolicy: intentReceipt.providerPolicy,
      receiptPath: intentReceiptPath,
      receiptSha256: intentReceiptSha256,
      rollback: {
        databaseBackup: backupReceipt,
        migrationRunId,
        procedure: "Run rollbackProfitFlywheelV2Migration against this migrationRunId; the database-stored snapshot is CAS protected. Restore the database backup only if database-level rollback cannot run.",
      },
    };
  }

  const result = {
    schemaVersion: MIGRATION_VERSION,
    mode: apply ? "apply" : "dry_run",
    status: activeControlBlockers.length > 0 ? "BLOCKED" : "OK",
    ready: activeControlBlockers.length === 0 && secureSecretNamesRequired.length === 0,
    observedAt: now.toISOString(),
    planSha256,
    sourceAudit: { path: auditPath, sha256: auditSha256, ...fleetAudit },
    providerPolicy: {
      path: loadedPolicy.path,
      sha256: loadedPolicy.sha256,
      schemaPath: loadedPolicy.schemaPath,
      schemaSha256: loadedPolicy.schemaSha256,
      policyId: loadedPolicy.policy.policyId,
      revision: loadedPolicy.policy.revision,
    },
    runtimePlaneContract,
    fleet: {
      totalRows: rows.length,
      acceptanceCount: acceptance.length,
      retiredCount: retired.length,
      sourceAuditLegacyConfigSha256: fleetAudit.fleetConfigSha256,
      canonicalBeforeConfigSha256: preMigrationFleetCanonicalSha256,
      canonicalAfterConfigSha256: postMigrationFleetCanonicalSha256,
      canonicalHashMethod: "sha256(stable_json([{id,adapterConfig,runtimeConfig} sorted by id]))",
      changedCount: appliedPlans.filter((plan) => plan.changed).length,
      activeRunBlockers: activeControlBlockers,
      agents: appliedPlans.map(publicAgentPlan),
      retiredAgents: retired.map((agent) => ({ agentId: agent.id, agentName: agent.name, reason: "status=terminated; preserved as immutable history" })),
    },
    routineTriggers: triggerPlans,
    routines: routinePlans,
    credentials: {
      secretNamesReferenced: [...new Set(appliedPlans.flatMap((plan) => plan.secretRefs))].sort(),
      secureSecretNamesRequired,
      secretNamesCreated: [],
      quarantinedSecretNames: [...new Set(appliedPlans.flatMap((plan) => plan.quarantinedSecretNames))].sort(),
      valuesRecorded: false,
      postMigrationCredentialLiteralPaths: [],
    },
    rollback: {
      databaseBackup: backupReceipt,
      agentSnapshotCount: rollbackSnapshot.agents.length,
      configValuesEmbeddedInReceipt: false,
      procedure: "Apply creates a durable migration run with a database-stored rollback snapshot. Invoke rollbackProfitFlywheelV2Migration with that run id.",
    },
  };
  const receiptPath = path.join(receiptRoot, `${receiptTimestamp(now)}-${migrationRunId}-profit-flywheel-v2-migration-dry-run.json`);
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, result);
  return { ...result, receiptPath, receiptSha256 };
}

export async function rollbackProfitFlywheelV2Migration(db: Db, options: {
  migrationRunId: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  now?: Date;
  testHooks?: {
    beforeTransactionSafetyCheck?: () => void | Promise<void>;
    afterTransactionSafetyLock?: () => void | Promise<void>;
    afterMutationsBeforeCommit?: () => void | Promise<void>;
  };
}) {
  const now = options.now ?? new Date();
  const row = await db.select().from(profitFlywheelMigrationRuns)
    .where(eq(profitFlywheelMigrationRuns.id, options.migrationRunId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw new Error(`Profit Flywheel migration run ${options.migrationRunId} was not found`);
  if (row.state === "rolled_back") {
    return { schemaVersion: MIGRATION_VERSION, migrationRunId: row.id, state: "rolled_back", idempotent: true, result: row.result };
  }
  const snapshot = row.rollbackSnapshot as unknown as MigrationRollbackSnapshot;
  if (snapshot.schemaVersion !== "paperclip.profit_flywheel_v2_rollback_snapshot.v1") {
    throw new Error(`Unsupported Profit Flywheel rollback snapshot for migration ${row.id}`);
  }
  const rollbackAgentIds = snapshot.agents.map((agent) => agent.id);
  const [rollbackAgents, activeHeartbeatRows, activeStageRows, activeLeaseRows] = await Promise.all([
    rollbackAgentIds.length > 0 ? db.select().from(agents).where(inArray(agents.id, rollbackAgentIds)) : [],
    rollbackAgentIds.length > 0
      ? db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
          .from(heartbeatRuns).where(and(
            inArray(heartbeatRuns.agentId, rollbackAgentIds),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          ))
      : [],
    db.select({ id: profitFlywheelStageRuns.id, state: profitFlywheelStageRuns.state })
      .from(profitFlywheelStageRuns).where(inArray(profitFlywheelStageRuns.state, ["running", "retry"])),
    db.select({ id: profitFlywheelLeases.id, stageRunId: profitFlywheelLeases.stageRunId }).from(profitFlywheelLeases),
  ]);
  const rollbackBlockers = [
    ...rollbackAgents.filter((agent) => agent.status === "running").map((agent) => `agent_status:${agent.id}`),
    ...activeHeartbeatRows.map((run) => `heartbeat_run:${run.id}`),
    ...activeStageRows.map((stage) => `flywheel_stage:${stage.id}`),
    ...activeLeaseRows.map((lease) => `flywheel_lease:${lease.id}`),
  ];
  if (rollbackBlockers.length > 0) {
    throw new Error(`Refusing Profit Flywheel rollback while authoritative execution is active: ${rollbackBlockers.join(",")}`);
  }
  const receiptRoot = path.join(
    path.resolve(options.homeDir ?? DEFAULT_HOME),
    "instances",
    options.instanceId ?? DEFAULT_INSTANCE_ID,
    options.receiptDir ?? DEFAULT_RECEIPT_DIR,
  );
  const rollbackReceipt = {
    schemaVersion: "paperclip.profit_flywheel_v2_migration_rollback_intent.v1",
    migrationVersion: row.migrationVersion,
    migrationRunId: row.id,
    planSha256: row.planSha256,
    state: "rollback_intent_recorded",
    recordedAt: now.toISOString(),
    applyPlanSha256: row.planSha256,
    applyIntentReceipt: { path: row.intentReceiptPath, sha256: row.intentReceiptSha256 },
    rollbackSnapshotSha256: sha256(snapshot),
    counts: {
      agents: snapshot.agents.length,
      routines: snapshot.routines.length,
      routineTriggers: snapshot.routineTriggers.length,
      nonCompensableSecurityRevocations: snapshot.nonCompensableSecurityRevocations.length,
    },
    credentials: { valuesRecorded: false },
  };
  const rollbackReceiptPath = path.join(
    receiptRoot,
    `${row.id}-profit-flywheel-v2-migration-rollback-intent.json`,
  );
  const rollbackReceiptSha256 = await writeOrReuseMigrationIntent(rollbackReceiptPath, rollbackReceipt);
  const rollbackResult = {
    ...asRecord(row.result),
    rollback: {
      state: "rolled_back",
      rolledBackAt: now.toISOString(),
      receiptPath: rollbackReceiptPath,
      receiptSha256: rollbackReceiptSha256,
      nonCompensableSecurityRevocations: snapshot.nonCompensableSecurityRevocations.map((version) => ({
        secretVersionId: version.id,
        state: "revoked",
        blockerCode: "profit_flywheel_compromised_credential_replacement_required",
        nextOwner: "paperclip_board_operator",
        resumeCondition: "Create and canary a new provider credential version through the encrypted company-secret service; never reactivate the compromised version",
      })),
    },
  };
  await options.testHooks?.beforeTransactionSafetyCheck?.();
  let performedRollback = false;
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(
      "LOCK TABLE agents, heartbeat_runs, profit_flywheel_stage_runs, profit_flywheel_leases, routines, routine_triggers, company_secret_versions IN SHARE ROW EXCLUSIVE MODE",
    ));
    const locked = await tx.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, row.id)).for("update")
      .then((rows) => rows[0] ?? null);
    if (!locked) throw new Error(`Profit Flywheel migration run ${row.id} disappeared during rollback`);
    if (locked.state === "rolled_back") return;
    const currentAgents = rollbackAgentIds.length > 0
      ? await tx.select().from(agents).where(inArray(agents.id, rollbackAgentIds)).for("update")
      : [];
    const [transactionHeartbeatRows, transactionStageRows, transactionLeaseRows] = await Promise.all([
      rollbackAgentIds.length > 0
        ? tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            inArray(heartbeatRuns.agentId, rollbackAgentIds),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          )).for("update")
        : [],
      tx.select({ id: profitFlywheelStageRuns.id }).from(profitFlywheelStageRuns)
        .where(inArray(profitFlywheelStageRuns.state, ["running", "retry"])).for("update"),
      tx.select({ id: profitFlywheelLeases.id }).from(profitFlywheelLeases).for("update"),
    ]);
    const transactionBlockers = [
      ...currentAgents.filter((agent) => agent.status === "running").map((agent) => `agent_status:${agent.id}`),
      ...transactionHeartbeatRows.map((run) => `heartbeat_run:${run.id}`),
      ...transactionStageRows.map((stage) => `flywheel_stage:${stage.id}`),
      ...transactionLeaseRows.map((lease) => `flywheel_lease:${lease.id}`),
    ];
    if (transactionBlockers.length > 0) {
      throw new Error(`Refusing Profit Flywheel rollback while authoritative execution is active: ${transactionBlockers.join(",")}`);
    }
    await options.testHooks?.afterTransactionSafetyLock?.();
    const currentAgentById = new Map(currentAgents.map((agent) => [agent.id, agent]));
    for (const agent of snapshot.agents) {
      const current = currentAgentById.get(agent.id) ?? null;
      if (!current || sha256(current.adapterConfig) !== agent.afterAdapterConfigSha256 || sha256(current.runtimeConfig) !== agent.afterRuntimeConfigSha256) {
        throw new Error(`Agent ${agent.id} changed after migration apply; rollback CAS aborted`);
      }
      const restored = await tx.update(agents).set({
        adapterConfig: agent.rollbackAdapterConfig,
        runtimeConfig: agent.rollbackRuntimeConfig,
        updatedAt: now,
      }).where(eq(agents.id, agent.id)).returning({ id: agents.id });
      if (restored.length !== 1) throw new Error(`Agent ${agent.id} rollback update failed`);
    }
    for (const routine of snapshot.routines) {
      const restored = await tx.update(routines).set({
        status: routine.beforeStatus,
        updatedAt: now,
      }).where(and(
        eq(routines.id, routine.id),
        eq(routines.status, routine.afterStatus),
      )).returning({ id: routines.id });
      if (restored.length !== 1) throw new Error(`Routine ${routine.id} changed after migration apply; rollback CAS aborted`);
    }
    for (const trigger of snapshot.routineTriggers) {
      const conditions = [
        eq(routineTriggers.id, trigger.id),
        eq(routineTriggers.enabled, trigger.afterEnabled),
        trigger.afterCronExpression === null
          ? isNull(routineTriggers.cronExpression)
          : eq(routineTriggers.cronExpression, trigger.afterCronExpression),
        trigger.afterTimezone === null
          ? isNull(routineTriggers.timezone)
          : eq(routineTriggers.timezone, trigger.afterTimezone),
        trigger.afterNextRunAt === null
          ? isNull(routineTriggers.nextRunAt)
          : eq(routineTriggers.nextRunAt, new Date(trigger.afterNextRunAt)),
      ];
      const restored = await tx.update(routineTriggers).set({
        enabled: trigger.beforeEnabled,
        cronExpression: trigger.beforeCronExpression,
        timezone: trigger.beforeTimezone,
        nextRunAt: trigger.beforeNextRunAt ? new Date(trigger.beforeNextRunAt) : null,
        updatedAt: now,
      }).where(and(...conditions)).returning({ id: routineTriggers.id });
      if (restored.length !== 1) throw new Error(`Routine trigger ${trigger.id} changed after migration apply; rollback CAS aborted`);
    }
    for (const version of snapshot.nonCompensableSecurityRevocations) {
      const stillRevoked = await tx.select({ id: companySecretVersions.id }).from(companySecretVersions).where(and(
        eq(companySecretVersions.id, version.id),
        isNotNull(companySecretVersions.revokedAt),
      )).for("update");
      if (stillRevoked.length !== 1) throw new Error(`Compromised secret version ${version.id} changed after migration apply; rollback CAS aborted`);
    }
    await options.testHooks?.afterMutationsBeforeCommit?.();
    const marked = await tx.update(profitFlywheelMigrationRuns).set({
      state: "rolled_back",
      result: rollbackResult,
      rolledBackAt: now,
      updatedAt: now,
    }).where(and(
      eq(profitFlywheelMigrationRuns.id, row.id),
      eq(profitFlywheelMigrationRuns.state, "applied"),
    )).returning({ id: profitFlywheelMigrationRuns.id });
    if (marked.length !== 1) throw new Error(`Profit Flywheel migration ${row.id} rollback CAS lost a race`);
    performedRollback = true;
  });
  if (!performedRollback) {
    const reconciled = await db.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, row.id)).then((rows) => rows[0] ?? null);
    const persistedRollback = asRecord(asRecord(reconciled?.result).rollback);
    return {
      schemaVersion: MIGRATION_VERSION,
      migrationRunId: row.id,
      state: "rolled_back" as const,
      idempotent: true,
      receiptPath: persistedRollback.receiptPath,
      receiptSha256: persistedRollback.receiptSha256,
    };
  }
  return {
    schemaVersion: MIGRATION_VERSION,
    migrationRunId: row.id,
    state: "rolled_back",
    idempotent: false,
    receiptPath: rollbackReceiptPath,
    receiptSha256: rollbackReceiptSha256,
  };
}

function parseArgs(argv: string[]) {
  const options: {
    apply?: boolean;
    homeDir?: string;
    instanceId?: string;
    receiptDir?: string;
    backup?: boolean;
    operation?: "migrate" | "provision_runtime" | "reconcile_stale_agents";
    companyId?: string;
    agentId?: string;
    staleAfterMs?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--provision-runtime") options.operation = "provision_runtime";
    else if (arg === "--reconcile-stale-agents") options.operation = "reconcile_stale_agents";
    else if (arg === "--company-id") options.companyId = argv[++index];
    else if (arg === "--agent-id") options.agentId = argv[++index];
    else if (arg === "--stale-after-minutes") options.staleAfterMs = Number(argv[++index]) * 60_000;
    else if (arg === "--home") options.homeDir = argv[++index];
    else if (arg === "--instance-id") options.instanceId = argv[++index];
    else if (arg === "--receipt-dir") options.receiptDir = argv[++index];
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: DATABASE_URL=<redacted> tsx src/ops/profit-flywheel-v2-migration.ts [--provision-runtime --company-id <uuid> | --reconcile-stale-agents [--company-id <uuid>] [--agent-id <uuid>] [--stale-after-minutes <n>]] --dry-run|--apply [--home <path>] [--instance-id <id>] [--receipt-dir <relative-path>] [--no-backup]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply === undefined) options.apply = false;
  if (options.operation === "provision_runtime" && !options.companyId) {
    throw new Error("--provision-runtime requires --company-id <uuid>");
  }
  if (options.staleAfterMs !== undefined && (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs < 60_000)) {
    throw new Error("--stale-after-minutes must be a finite number >= 1");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; connection strings are intentionally rejected on argv");
  const db = createDb(connectionString);
  try {
    const result = options.operation === "provision_runtime"
      ? await provisionProfitFlywheelRuntimeIdentity(db, {
          companyId: options.companyId!,
          apply: options.apply,
          homeDir: options.homeDir,
          instanceId: options.instanceId,
          receiptDir: options.receiptDir,
        })
      : options.operation === "reconcile_stale_agents"
        ? await reconcileStaleProfitFlywheelAgents(db, {
            apply: options.apply,
            companyId: options.companyId,
            agentId: options.agentId,
            staleAfterMs: options.staleAfterMs,
            homeDir: options.homeDir,
            instanceId: options.instanceId,
            receiptDir: options.receiptDir,
          })
      : await migrateProfitFlywheelV2(db, { ...options, connectionString });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
