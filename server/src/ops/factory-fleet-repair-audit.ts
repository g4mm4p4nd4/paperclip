import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  agentWakeupRequests,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  issues,
  profitFlywheelLeases,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  routineRuns,
  routines,
  routineTriggers,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  configureProfitFlywheelCliRuntimeEnvironment,
  resolveProfitFlywheelCliConnection,
} from "./profit-flywheel-v2-migration.js";
import { prepareTrustedReceiptDirectory } from "./trusted-receipt-directory.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";

const SCHEMA_VERSION = "paperclip.factory_fleet_repair_audit.v1";
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const ACTIVE_HEARTBEAT_STATUSES = ["queued", "running"];
const ACTIVE_WAKEUP_STATUSES = ["queued", "claimed"];
const ACTIVE_ROUTINE_RUN_STATUSES = ["received", "queued", "running"];
const ACTIVE_WORKFLOW_STATES = ["pending", "running", "retry", "blocked", "degraded"];
const ACTIVE_STAGE_STATES = ["pending", "running", "retry", "blocked", "degraded"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const LEADFORGE_RE = /(?:^|::\s*)glitch-cipher-syndicate\/leadforge\s*$/i;
const SENSITIVE_TEXT_RE =
  /(?:sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}|(?:api[_-]?key|token|secret|password|cookie|mfa|otp)\s*[=:]\s*\S+)/gi;

type JsonRecord = Record<string, unknown>;

export type FleetRepairAuditRows = {
  companies: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  agents: Array<{
    id: string;
    companyId: string;
    name: string;
    role: string;
    status: string;
    adapterType: string;
    adapterConfig: JsonRecord;
    runtimeConfig: JsonRecord;
    pauseReason: string | null;
    lastHeartbeatAt: Date | string | null;
  }>;
  secrets: Array<{
    id: string;
    companyId: string;
    name: string;
    provider: string;
    latestVersion: number;
    latestVersionId: string | null;
    latestVersionRevokedAt: Date | string | null;
  }>;
  issues: Array<{
    id: string;
    companyId: string;
    identifier: string | null;
    title: string;
    status: string;
    originKind: string;
    originId: string | null;
    executionRunId: string | null;
    updatedAt: Date | string;
  }>;
  routines: Array<{
    id: string;
    companyId: string;
    title: string;
    status: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    assigneeAgentId: string | null;
    triggerId: string | null;
    triggerKind: string | null;
    triggerEnabled: boolean | null;
    cronExpression: string | null;
    timezone: string | null;
    nextRunAt: Date | string | null;
    lastResult: string | null;
  }>;
  routineRuns: Array<{
    id: string;
    companyId: string;
    routineId: string;
    triggerId: string | null;
    status: string;
    linkedIssueId: string | null;
    coalescedIntoRunId: string | null;
    triggeredAt: Date | string;
  }>;
  heartbeats: Array<{
    id: string;
    companyId: string;
    agentId: string;
    status: string;
    wakeupRequestId: string | null;
    processPid: number | null;
    startedAt: Date | string | null;
    updatedAt: Date | string;
  }>;
  wakeups: Array<{
    id: string;
    companyId: string;
    agentId: string;
    status: string;
    runId: string | null;
    idempotencyKey: string | null;
    requestedAt: Date | string;
    updatedAt: Date | string;
  }>;
  workflows: Array<{
    id: string;
    companyId: string;
    runId: string;
    state: string;
    currentStage: string;
    targetRepo: string;
    blockerCode: string | null;
    updatedAt: Date | string;
  }>;
  stageRuns: Array<{
    id: string;
    companyId: string;
    workflowId: string;
    stage: string;
    state: string;
    attemptCount: number;
    maxAttempts: number;
    providerFamily: string | null;
    providerPolicySha256: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: Date | string | null;
    heartbeatAt: Date | string | null;
    updatedAt: Date | string;
  }>;
  leases: Array<{
    id: string;
    companyId: string;
    stageRunId: string;
    scopeType: string;
    scopeKey: string;
    slot: number;
    leaseOwner: string;
    expiresAt: Date | string;
  }>;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function iso(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function safeText(value: string | null | undefined, maxLength = 240) {
  if (!value) return null;
  return value.replace(SENSITIVE_TEXT_RE, "[REDACTED]").slice(0, maxLength);
}

function errorClass(value: string | null) {
  const normalized = value?.toLowerCase() ?? "";
  if (/credential|authentication|api key|unauthorized|login|mfa|terms/.test(normalized)) {
    return "credential_or_human_auth";
  }
  if (/provider.?policy|runtime|hash|immutable|frozen|command/.test(normalized)) {
    return "runtime_integrity";
  }
  if (/budget|quota|rate.?limit|capacity/.test(normalized)) return "provider_capacity";
  return normalized ? "other" : "unspecified";
}

function processAlive(pid: number | null) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function extractProviderPolicyBinding(agent: FleetRepairAuditRows["agents"][number]) {
  const policy = asRecord(asRecord(agent.adapterConfig).providerPolicy);
  const runtimeAuthority = asRecord(policy.runtimeAuthority);
  const revision = Number(policy.revision);
  const sha = typeof policy.sha256 === "string" ? policy.sha256 : "";
  const schemaSha = typeof policy.schemaSha256 === "string" ? policy.schemaSha256 : "";
  return {
    revision: Number.isInteger(revision) ? revision : null,
    path: typeof policy.path === "string" ? policy.path : null,
    sha256: SHA256_RE.test(sha) ? sha : null,
    schema_path: typeof policy.schemaPath === "string" ? policy.schemaPath : null,
    schema_sha256: SHA256_RE.test(schemaSha) ? schemaSha : null,
    capability_alias: typeof policy.capabilityAlias === "string" ? policy.capabilityAlias : null,
    command_realpath: typeof policy.commandRealpath === "string" ? policy.commandRealpath : null,
    command_sha256:
      typeof policy.commandSha256 === "string" && SHA256_RE.test(policy.commandSha256)
        ? policy.commandSha256
        : null,
    runtime_authority_sha256:
      typeof runtimeAuthority.authoritySha256 === "string" &&
      SHA256_RE.test(runtimeAuthority.authoritySha256)
        ? runtimeAuthority.authoritySha256
        : null,
    hidden_fallback_disabled: policy.hiddenFallbackDisabled === true,
  };
}

function groupCount<T>(rows: T[], key: (row: T) => string) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildFleetRepairAudit(
  rows: FleetRepairAuditRows,
  input: {
    observedAt: Date;
    expectedPolicy: {
      revision: number;
      path: string;
      sha256: string;
      schemaPath: string;
      schemaSha256: string;
    };
  },
) {
  const companyById = new Map(rows.companies.map((company) => [company.id, company]));
  const leadForgeCompanyIds = new Set(
    rows.companies.filter((company) => LEADFORGE_RE.test(company.name)).map((company) => company.id),
  );
  const activeCompanies = rows.companies.filter(
    (company) => company.status !== "terminated" && !leadForgeCompanyIds.has(company.id),
  );
  const liveAgents = rows.agents.filter((agent) => agent.status !== "terminated");
  const bindings = liveAgents.map((agent) => ({
    agent_id: agent.id,
    company_id: agent.companyId,
    company_name: safeText(companyById.get(agent.companyId)?.name, 120),
    agent_name: safeText(agent.name, 120),
    adapter_type: agent.adapterType,
    status: agent.status,
    binding: extractProviderPolicyBinding(agent),
  }));
  const staleBindings = bindings.filter(({ binding }) => (
    binding.revision !== input.expectedPolicy.revision ||
    binding.path !== input.expectedPolicy.path ||
    binding.sha256 !== input.expectedPolicy.sha256 ||
    binding.schema_path !== input.expectedPolicy.schemaPath ||
    binding.schema_sha256 !== input.expectedPolicy.schemaSha256 ||
    binding.hidden_fallback_disabled !== true
  ));
  const policyDistribution = groupCount(bindings, ({ binding }) =>
    `${binding.revision ?? "missing"}:${binding.sha256 ?? "missing"}:${binding.path ?? "missing"}`
  );

  const credentialsByCompany = activeCompanies.map((company) => {
    const companySecretsRows = rows.secrets
      .filter((secret) => secret.companyId === company.id)
      .map((secret) => ({
        name: safeText(secret.name, 160),
        provider: safeText(secret.provider, 80),
        latest_version: secret.latestVersion,
        latest_version_present: Boolean(secret.latestVersionId),
        latest_version_revoked: Boolean(secret.latestVersionRevokedAt),
      }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const envRefs = [...new Set(
      liveAgents
        .filter((agent) => agent.companyId === company.id)
        .flatMap((agent) => Object.entries(asRecord(asRecord(agent.adapterConfig).env)))
        .filter(([, raw]) => asRecord(raw).type === "secret_ref")
        .map(([name]) => name),
    )].sort();
    return {
      company_id: company.id,
      company_name: safeText(company.name, 120),
      secret_records: companySecretsRows,
      referenced_environment_names: envRefs,
      missing_latest_versions: companySecretsRows.filter((secret) => !secret.latest_version_present).length,
      revoked_latest_versions: companySecretsRows.filter((secret) => secret.latest_version_revoked).length,
    };
  });

  const errorAgents = liveAgents
    .filter((agent) => agent.status === "error")
    .map((agent) => ({
      agent_id: agent.id,
      company_id: agent.companyId,
      agent_name: safeText(agent.name, 120),
      adapter_type: agent.adapterType,
      error_class: errorClass(agent.pauseReason),
      last_heartbeat_at: iso(agent.lastHeartbeatAt),
      policy_sha256: extractProviderPolicyBinding(agent).sha256,
    }));

  const openIssues = rows.issues.filter((issue) => OPEN_ISSUE_STATUSES.includes(issue.status));
  const blockerIssues = openIssues
    .filter((issue) => /provider.?policy\.?v2|credential|authentication|api key|runtime integrity/i.test(issue.title))
    .map((issue) => ({
      issue_id: issue.id,
      identifier: issue.identifier,
      company_id: issue.companyId,
      title: safeText(issue.title, 240),
      status: issue.status,
      updated_at: iso(issue.updatedAt),
    }));
  const scheduleAnchors = rows.issues
    .filter((issue) => issue.identifier === "PORA-2016" || issue.identifier === "POR-2754")
    .map((issue) => ({
      issue_id: issue.id,
      identifier: issue.identifier,
      company_id: issue.companyId,
      title: safeText(issue.title, 240),
      status: issue.status,
      updated_at: iso(issue.updatedAt),
    }));
  const routineIssueGroups = new Map<string, FleetRepairAuditRows["issues"]>();
  for (const issue of openIssues.filter(
    (candidate) => candidate.originKind === "routine_execution" && candidate.originId,
  )) {
    const key = `${issue.companyId}:${issue.originId}`;
    routineIssueGroups.set(key, [...(routineIssueGroups.get(key) ?? []), issue]);
  }
  const duplicateRoutineIssues = [...routineIssueGroups.entries()]
    .filter(([, issuesInGroup]) => issuesInGroup.length > 1)
    .map(([identity, issuesInGroup]) => ({
      identity,
      count: issuesInGroup.length,
      issue_ids: issuesInGroup.map((issue) => issue.id).sort(),
      identifiers: issuesInGroup.map((issue) => issue.identifier).filter(Boolean).sort(),
    }));

  const activeHeartbeats = rows.heartbeats.filter((run) => ACTIVE_HEARTBEAT_STATUSES.includes(run.status));
  const activeWakeups = rows.wakeups.filter((wakeup) => ACTIVE_WAKEUP_STATUSES.includes(wakeup.status));
  const activeRoutineRuns = rows.routineRuns.filter((run) => ACTIVE_ROUTINE_RUN_STATUSES.includes(run.status));
  const activeWorkflows = rows.workflows.filter((workflow) => ACTIVE_WORKFLOW_STATES.includes(workflow.state));
  const activeStageRuns = rows.stageRuns.filter((stage) => ACTIVE_STAGE_STATES.includes(stage.state));
  const nowMs = input.observedAt.getTime();
  const expiredLeases = rows.leases.filter((lease) => (Date.parse(String(lease.expiresAt)) || 0) <= nowMs);
  const orphanHeartbeats = activeHeartbeats.filter(
    (run) => run.status === "running" && !processAlive(run.processPid),
  );
  const orphanWakeups = activeWakeups.filter((wakeup) =>
    wakeup.status === "claimed" &&
    !activeHeartbeats.some((run) => run.wakeupRequestId === wakeup.id)
  );

  const retryExhausted = rows.stageRuns
    .filter((stage) => stage.attemptCount >= stage.maxAttempts && !["succeeded", "cancelled", "safely_skipped"].includes(stage.state))
    .map((stage) => ({
      stage_run_id: stage.id,
      company_id: stage.companyId,
      workflow_id: stage.workflowId,
      stage: stage.stage,
      state: stage.state,
      attempt_count: stage.attemptCount,
      max_attempts: stage.maxAttempts,
      provider_family: safeText(stage.providerFamily, 80),
      provider_policy_sha256: stage.providerPolicySha256,
      updated_at: iso(stage.updatedAt),
    }));

  const schedules = rows.routines.map((routine) => ({
    routine_id: routine.id,
    trigger_id: routine.triggerId,
    company_id: routine.companyId,
    title: safeText(routine.title, 200),
    routine_status: routine.status,
    trigger_kind: routine.triggerKind,
    trigger_enabled: routine.triggerEnabled,
    concurrency_policy: routine.concurrencyPolicy,
    catch_up_policy: routine.catchUpPolicy,
    cron_expression: routine.cronExpression,
    timezone: routine.timezone,
    next_run_at: iso(routine.nextRunAt),
    last_result: safeText(routine.lastResult, 160),
    exact_exclusion_company: leadForgeCompanyIds.has(routine.companyId),
  }));
  const exclusionTriggerCandidates = schedules.filter(
    (schedule) =>
      schedule.exact_exclusion_company &&
      schedule.trigger_kind === "schedule" &&
      schedule.trigger_enabled === true,
  );

  const audit = {
    schema_version: SCHEMA_VERSION,
    observed_at: input.observedAt.toISOString(),
    expected_provider_policy: {
      schema_version: "provider-policy.v2",
      ...input.expectedPolicy,
    },
    fleet: {
      company_count: rows.companies.length,
      active_non_excluded_company_count: activeCompanies.length,
      live_agent_count: liveAgents.length,
      adapter_types: groupCount(liveAgents, (agent) => agent.adapterType),
      statuses: groupCount(liveAgents, (agent) => agent.status),
      policy_binding_distribution: policyDistribution,
      stale_policy_binding_count: staleBindings.length,
      stale_policy_bindings: staleBindings,
      policy_caused_error_agent_count: errorAgents.filter(
        (agent) => agent.error_class === "runtime_integrity",
      ).length,
      error_agents: errorAgents,
    },
    credentials: {
      value_material_included: false,
      active_non_excluded_companies: credentialsByCompany,
      missing_latest_version_count: credentialsByCompany.reduce(
        (total, company) => total + company.missing_latest_versions,
        0,
      ),
      revoked_latest_version_count: credentialsByCompany.reduce(
        (total, company) => total + company.revoked_latest_versions,
        0,
      ),
      blocker_issues: blockerIssues,
    },
    schedules: {
      rows: schedules,
      enabled_non_excluded_count: schedules.filter(
        (schedule) => !schedule.exact_exclusion_company &&
          schedule.routine_status === "active" &&
          schedule.trigger_enabled === true,
      ).length,
      non_coalescing_enabled_count: schedules.filter(
        (schedule) => !schedule.exact_exclusion_company &&
          schedule.routine_status === "active" &&
          schedule.trigger_enabled === true &&
          schedule.concurrency_policy !== "coalesce_if_active",
      ).length,
      non_skip_missed_enabled_count: schedules.filter(
        (schedule) => !schedule.exact_exclusion_company &&
          schedule.routine_status === "active" &&
          schedule.trigger_enabled === true &&
          schedule.catch_up_policy !== "skip_missed",
      ).length,
      schedule_anchors: scheduleAnchors,
      exact_duplicate_open_routine_issues: duplicateRoutineIssues,
    },
    execution: {
      active_routine_runs: activeRoutineRuns.map((run) => ({
        ...run,
        triggeredAt: iso(run.triggeredAt),
      })),
      active_wakeups: activeWakeups.map((wakeup) => ({
        ...wakeup,
        requestedAt: iso(wakeup.requestedAt),
        updatedAt: iso(wakeup.updatedAt),
      })),
      active_heartbeats: activeHeartbeats.map((run) => ({
        ...run,
        process_alive: processAlive(run.processPid),
        startedAt: iso(run.startedAt),
        updatedAt: iso(run.updatedAt),
      })),
      active_workflows: activeWorkflows.map((workflow) => ({
        ...workflow,
        blockerCode: safeText(workflow.blockerCode, 120),
        updatedAt: iso(workflow.updatedAt),
      })),
      active_stage_runs: activeStageRuns.map((stage) => ({
        ...stage,
        leaseExpiresAt: iso(stage.leaseExpiresAt),
        heartbeatAt: iso(stage.heartbeatAt),
        updatedAt: iso(stage.updatedAt),
      })),
      orphan_heartbeat_count: orphanHeartbeats.length,
      orphan_wakeup_count: orphanWakeups.length,
      expired_lease_count: expiredLeases.length,
      expired_leases: expiredLeases.map((lease) => ({
        ...lease,
        scopeKey: safeText(lease.scopeKey, 160),
        leaseOwner: safeText(lease.leaseOwner, 160),
        expiresAt: iso(lease.expiresAt),
      })),
      retry_exhausted_stage_runs: retryExhausted,
    },
    exact_exclusions: {
      repositories: [
        "Glitch-Cipher-Syndicate/LeadForge",
        "g4mm4p4nd4/octomind-platform",
      ],
      leadforge_company_ids: [...leadForgeCompanyIds].sort(),
      recurring_new_work_triggers_requiring_quarantine: exclusionTriggerCandidates,
      history_deletion_requested: false,
    },
  };
  return {
    ...audit,
    snapshot_sha256: sha256(audit),
  };
}

async function readRows(db: Db): Promise<FleetRepairAuditRows> {
  const [
    companyRows,
    agentRows,
    secretRows,
    issueRows,
    routineRows,
    routineRunRows,
    heartbeatRows,
    wakeupRows,
    workflowRows,
    stageRows,
    leaseRows,
  ] = await Promise.all([
    db.select({
      id: companies.id,
      name: companies.name,
      status: companies.status,
    }).from(companies),
    db.select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      pauseReason: agents.pauseReason,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    }).from(agents),
    db.select({
      id: companySecrets.id,
      companyId: companySecrets.companyId,
      name: companySecrets.name,
      provider: companySecrets.provider,
      latestVersion: companySecrets.latestVersion,
      latestVersionId: companySecretVersions.id,
      latestVersionRevokedAt: companySecretVersions.revokedAt,
    }).from(companySecrets).leftJoin(
      companySecretVersions,
      and(
        eq(companySecretVersions.secretId, companySecrets.id),
        eq(companySecretVersions.version, companySecrets.latestVersion),
      ),
    ),
    db.select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
      executionRunId: issues.executionRunId,
      updatedAt: issues.updatedAt,
    }).from(issues).where(inArray(issues.status, OPEN_ISSUE_STATUSES)),
    db.select({
      id: routines.id,
      companyId: routines.companyId,
      title: routines.title,
      status: routines.status,
      concurrencyPolicy: routines.concurrencyPolicy,
      catchUpPolicy: routines.catchUpPolicy,
      assigneeAgentId: routines.assigneeAgentId,
      triggerId: routineTriggers.id,
      triggerKind: routineTriggers.kind,
      triggerEnabled: routineTriggers.enabled,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      nextRunAt: routineTriggers.nextRunAt,
      lastResult: routineTriggers.lastResult,
    }).from(routines).leftJoin(routineTriggers, eq(routineTriggers.routineId, routines.id)),
    db.select({
      id: routineRuns.id,
      companyId: routineRuns.companyId,
      routineId: routineRuns.routineId,
      triggerId: routineRuns.triggerId,
      status: routineRuns.status,
      linkedIssueId: routineRuns.linkedIssueId,
      coalescedIntoRunId: routineRuns.coalescedIntoRunId,
      triggeredAt: routineRuns.triggeredAt,
    }).from(routineRuns).where(inArray(routineRuns.status, ACTIVE_ROUTINE_RUN_STATUSES)),
    db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      wakeupRequestId: heartbeatRuns.wakeupRequestId,
      processPid: heartbeatRuns.processPid,
      startedAt: heartbeatRuns.startedAt,
      updatedAt: heartbeatRuns.updatedAt,
    }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ACTIVE_HEARTBEAT_STATUSES)),
    db.select({
      id: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      agentId: agentWakeupRequests.agentId,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
      updatedAt: agentWakeupRequests.updatedAt,
    }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.status, ACTIVE_WAKEUP_STATUSES)),
    db.select({
      id: profitFlywheelWorkflows.id,
      companyId: profitFlywheelWorkflows.companyId,
      runId: profitFlywheelWorkflows.runId,
      state: profitFlywheelWorkflows.state,
      currentStage: profitFlywheelWorkflows.currentStage,
      targetRepo: profitFlywheelWorkflows.targetRepo,
      blockerCode: profitFlywheelWorkflows.blockerCode,
      updatedAt: profitFlywheelWorkflows.updatedAt,
    }).from(profitFlywheelWorkflows).where(
      inArray(profitFlywheelWorkflows.state, ACTIVE_WORKFLOW_STATES),
    ),
    db.select({
      id: profitFlywheelStageRuns.id,
      companyId: profitFlywheelStageRuns.companyId,
      workflowId: profitFlywheelStageRuns.workflowId,
      stage: profitFlywheelStageRuns.stage,
      state: profitFlywheelStageRuns.state,
      attemptCount: profitFlywheelStageRuns.attemptCount,
      maxAttempts: profitFlywheelStageRuns.maxAttempts,
      providerFamily: profitFlywheelStageRuns.providerFamily,
      providerPolicySha256: profitFlywheelStageRuns.providerPolicySha256,
      leaseOwner: profitFlywheelStageRuns.leaseOwner,
      leaseExpiresAt: profitFlywheelStageRuns.leaseExpiresAt,
      heartbeatAt: profitFlywheelStageRuns.heartbeatAt,
      updatedAt: profitFlywheelStageRuns.updatedAt,
    }).from(profitFlywheelStageRuns),
    db.select({
      id: profitFlywheelLeases.id,
      companyId: profitFlywheelLeases.companyId,
      stageRunId: profitFlywheelLeases.stageRunId,
      scopeType: profitFlywheelLeases.scopeType,
      scopeKey: profitFlywheelLeases.scopeKey,
      slot: profitFlywheelLeases.slot,
      leaseOwner: profitFlywheelLeases.leaseOwner,
      expiresAt: profitFlywheelLeases.expiresAt,
    }).from(profitFlywheelLeases),
  ]);
  return {
    companies: companyRows,
    agents: agentRows,
    secrets: secretRows,
    issues: issueRows,
    routines: routineRows,
    routineRuns: routineRunRows,
    heartbeats: heartbeatRows,
    wakeups: wakeupRows,
    workflows: workflowRows,
    stageRuns: stageRows,
    leases: leaseRows,
  };
}

export function parseFactoryFleetRepairAuditArgs(rawArgv: string[]) {
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const options: {
    help: boolean;
    homeDir?: string;
    instanceId?: string;
    receiptDir?: string;
  } = { help: false };
  const readValue = (flag: string, index: number) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--home") options.homeDir = readValue(arg, index++);
    else if (arg === "--instance-id") options.instanceId = readValue(arg, index++);
    else if (arg === "--receipt-dir") options.receiptDir = readValue(arg, index++);
    else if (arg === "--connection-string" || arg.startsWith("--connection-string=")) {
      throw new Error("factory_fleet_repair_database_url_argv_forbidden");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.receiptDir && !path.isAbsolute(options.receiptDir)) {
    throw new Error("--receipt-dir must be an absolute pre-created trusted directory");
  }
  return options;
}

export async function runFactoryFleetRepairAudit(rawArgv = process.argv.slice(2)) {
  const options = parseFactoryFleetRepairAuditArgs(rawArgv);
  if (options.help) {
    console.log(
      "Usage: pnpm ops:factory-fleet-repair-audit -- --receipt-dir <absolute-precreated-directory> [--home <path>] [--instance-id <id>]",
    );
    return null;
  }
  if (!options.receiptDir) {
    throw new Error("--receipt-dir is required");
  }
  configureProfitFlywheelCliRuntimeEnvironment(options);
  const connection = await resolveProfitFlywheelCliConnection(options);
  const db = createDb(connection.connectionString);
  try {
    const [rows, policy] = await Promise.all([readRows(db), loadProviderPolicyV2()]);
    const audit = buildFleetRepairAudit(rows, {
      observedAt: new Date(),
      expectedPolicy: {
        revision: policy.policy.revision,
        path: policy.path,
        sha256: policy.sha256,
        schemaPath: policy.schemaPath,
        schemaSha256: policy.schemaSha256,
      },
    });
    const receiptDirectory = await prepareTrustedReceiptDirectory(
      options.receiptDir,
      "factory_fleet_repair_audit_receipt_directory",
    );
    const timestamp = audit.observed_at.replace(/[-:.]/g, "");
    const receiptPath = path.join(receiptDirectory, `${timestamp}-fleet-repair-audit.json`);
    const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, audit);
    const output = {
      schema_version: "paperclip.factory_fleet_repair_audit_publish.v1",
      status: "passed",
      receipt_path: receiptPath,
      receipt_sha256: receiptSha256,
      snapshot_sha256: audit.snapshot_sha256,
      stale_policy_binding_count: audit.fleet.stale_policy_binding_count,
      policy_caused_error_agent_count: audit.fleet.policy_caused_error_agent_count,
      credential_blocker_issue_count: audit.credentials.blocker_issues.length,
      exact_duplicate_open_routine_issue_count:
        audit.schedules.exact_duplicate_open_routine_issues.length,
      orphan_heartbeat_count: audit.execution.orphan_heartbeat_count,
      orphan_wakeup_count: audit.execution.orphan_wakeup_count,
      expired_lease_count: audit.execution.expired_lease_count,
      exact_exclusion_trigger_count:
        audit.exact_exclusions.recurring_new_work_triggers_requiring_quarantine.length,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await connection.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFactoryFleetRepairAudit().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "factory_fleet_repair_audit_unknown_failure",
    }));
    process.exit(1);
  });
}
