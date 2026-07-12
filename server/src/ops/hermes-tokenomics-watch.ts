import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  contextLedgerEntries,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  routines,
  routineRuns,
  type Db,
} from "@paperclipai/db";
import {
  balanceHermesTokenomics,
  buildBalancedHermesAgentConfig,
} from "./hermes-tokenomics-balance.js";
import {
  evaluateProviderCapacity,
  type ProviderCapacitySnapshot,
} from "../services/provider-capacity.js";
import {
  loadFlywheelCoverageManifest,
  type FlywheelCoverageManifest,
} from "../services/flywheel-coverage.js";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/provider-tokenomics/runs";
const WATCH_VERSION = "hermes-tokenomics-watch.v2";
const DEFAULT_HIGH_BURN_TOKENS = 250_000;
const DEFAULT_MIN_SAVINGS_RATIO = 0.5;
const DEFAULT_MIN_OPTIMIZATION_RATIO = 0.9;
const DEFAULT_MIN_OUTPUT_GAIN_RATIO = 0.9;
const DEFAULT_ESTIMATED_TOKENS_PER_IDLE_SKIP = 7_500;

type JsonRecord = Record<string, unknown>;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

export type TokenomicsCostSample = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  heartbeatRunId: string | null;
  provider: string;
  biller: string;
  billingType: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string;
};

export type TokenomicsRunSample = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  errorCode: string | null;
  usageJson: JsonRecord;
  resultJson?: JsonRecord;
  contextSnapshot: JsonRecord;
  openAssignedIssueCount?: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TokenomicsWakeupSample = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  status: string;
  payload: JsonRecord;
  runId: string | null;
  requestedAt: string;
  finishedAt: string | null;
};

export type TokenomicsIssueOutputSample = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  status: string;
  identifier: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type TokenomicsLedgerOutputSample = {
  id: string;
  companyId: string;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  responseClass: string;
  finalOutcome: string | null;
  artifactRefs: JsonRecord[];
  contextPackRefs: JsonRecord[];
  finalResponseArtifactRefs: JsonRecord[];
  receiptPaths: string[];
  metadata: JsonRecord;
  createdAt: string;
};

export type TokenomicsActiveIssueSample = {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  status: string;
  identifier: string | null;
  executionRunId: string | null;
  originRunId: string | null;
};

export type TokenomicsRoutineRunSample = {
  id: string;
  routineId: string;
  routineTitle: string | null;
  routineDescription: string | null;
  triggerPayload: JsonRecord;
};

export type ActiveRunFlywheelCoverageRun = {
  runId: string;
  status: string;
  agentName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueStatus: string | null;
  routineRunId: string | null;
  routineKey: string | null;
  stage: string | null;
  ownerPlane: string | null;
  lane: string | null;
  selectedAdapterType: string | null;
  provider: string | null;
  biller: string | null;
  model: string | null;
  contextPackProfile: string | null;
  contractPresent: boolean;
  coverageState: "pending" | "ready" | "missing_contract";
  pendingRequiredReceipts: string[];
  observedReceipts: string[];
  rawTokens: number;
};

export type ActiveRunFlywheelCoverageStage = {
  stage: string;
  ownerPlane: string | null;
  activeRuns: number;
  contractedRuns: number;
  readyRuns: number;
  pendingRuns: number;
  missingContractRuns: number;
  pendingRequiredReceipts: string[];
};

export type ActiveRunFlywheelCoverage = {
  generatedAt: string;
  manifestSchemaVersion: string | null;
  activeRuns: number;
  contractedRuns: number;
  readyRuns: number;
  pendingRuns: number;
  missingContractRuns: number;
  stages: ActiveRunFlywheelCoverageStage[];
  runs: ActiveRunFlywheelCoverageRun[];
};

export type TokenomicsProviderBreakdown = {
  provider: string;
  biller: string;
  billingType: string;
  model: string;
  events: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawTokens: number;
  costCents: number;
};

export type TokenomicsHighBurnEvent = {
  id: string;
  heartbeatRunId: string | null;
  agentId: string;
  agentName: string | null;
  provider: string;
  billingType: string;
  model: string;
  rawTokens: number;
  occurredAt: string;
};

export type TokenomicsOutputMetrics = {
  completedIssues: number;
  succeededIssueBoundRuns: number;
  artifactBackedLedgerEntries: number;
  receiptBackedLedgerEntries: number;
  successfulLedgerOutcomes: number;
  goLiveDeltaBackedLedgerEntries: number;
  valuableGoLiveDeltaUnits: number;
  verifiedOutputUnits: number;
  verifiedOutputUnitsPerDecision: number;
  finalDeliverableUnits: number;
  finalDeliverableUnitsPerDecision: number;
};

export type TokenomicsWindowMetrics = {
  windowStart: string;
  windowEnd: string;
  wakeups: {
    total: number;
    timer: number;
    skipped: number;
    idleSkipped: number;
    providerBackoffSkipped: number;
    noNewSignalSkipped: number;
    blockedIssueNoNewSignalSkipped: number;
    systemSelfHealGuardSkipped: number;
  };
  runs: {
    total: number;
    active: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    issueBound: number;
    timerNoIssueLaunches: number;
    providerQuotaFailures: number;
    providerPreflightFailures: number;
    assignmentBacklogScans: number;
  };
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
    rawTotal: number;
    uncachedTotal: number;
    costCents: number;
    rawTokensPerOpportunity: number;
  };
  optimization: {
    decisionUnits: number;
    valuableOrSafelySkippedUnits: number;
    valuableOrSafelySkippedRatio: number;
    estimatedAvoidedTokensFromIdleSkips: number;
  };
  output: TokenomicsOutputMetrics;
  providers: TokenomicsProviderBreakdown[];
  highBurnEvents: TokenomicsHighBurnEvent[];
};

export type HermesBudgetDriftSummary = {
  hermesAgents: number;
  driftedAgents: number;
  driftedAgentNames: string[];
};

export type TokenomicsWatchReport = {
  version: string;
  status: "pass" | "warn" | "fail";
  generatedAt: string;
  targets: {
    minSavingsRatio: number;
    minOptimizationRatio: number;
    minOutputGainRatio: number;
    highBurnThresholdTokens: number;
  };
  current: TokenomicsWindowMetrics;
  baseline: TokenomicsWindowMetrics | null;
  budgetDrift: HermesBudgetDriftSummary;
  providerCapacity: {
    minimax: ProviderCapacitySnapshot | null;
  };
  activeRunFlywheelCoverage: ActiveRunFlywheelCoverage;
  evaluation: {
    tokenReductionRatio: number | null;
    tokenReductionStatus: "pass" | "warn" | "fail";
    optimizationStatus: "pass" | "fail";
    valuableOutputGainRatio: number | null;
    valuableOutputStatus: "pass" | "warn" | "fail";
    highBurnStatus: "pass" | "fail";
    driftStatus: "pass" | "fail";
    providerRouteCoverage: {
      minimaxSeen: boolean;
      geminiSeen: boolean;
      claudeSeen: boolean;
    };
  };
  factoryLoop: {
    truthPlane: string;
    researchPlane: string;
    controlPlane: string;
    executionPlane: string;
    requiredOptimizerTools: string[];
    evidenceContract: string[];
  };
  recommendedActions: string[];
  selfImprovementLoop: {
    command: string;
    receiptPath: string | null;
    canApplyBalanceOnDrift: boolean;
  };
  receiptPath: string | null;
};

type WatchOptions = {
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  windowMinutes?: number;
  baselineHours?: number;
  baselineStart?: Date;
  baselineEnd?: Date;
  now?: Date;
  minSavingsRatio?: number;
  minOptimizationRatio?: number;
  minOutputGainRatio?: number;
  highBurnThresholdTokens?: number;
  estimatedTokensPerIdleSkip?: number;
  applyBalanceOnDrift?: boolean;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonRecord) } : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  const parsed = asString(value);
  return parsed.length > 0 ? parsed : null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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

function rawTokensForCost(sample: Pick<TokenomicsCostSample, "inputTokens" | "cachedInputTokens" | "outputTokens">) {
  // cachedInputTokens is a subset of canonical inputTokens. Counting it again
  // inflates cache hits and creates false high-burn events.
  return Math.max(0, sample.inputTokens) + Math.max(0, sample.outputTokens);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecordArray(value: unknown): JsonRecord[] {
  return asArray(value).filter((entry): entry is JsonRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isTimerLike(source: string | null | undefined, triggerDetail?: string | null) {
  return /timer|schedule|heartbeat|routine|cron/i.test(`${source ?? ""} ${triggerDetail ?? ""}`);
}

function runHasIssueContext(run: TokenomicsRunSample) {
  const context = run.contextSnapshot;
  if (asString(context.issueId) || asString(context.taskId) || asString(context.PAPERCLIP_TASK_ID)) return true;
  const wake = asRecord(context.paperclipWake);
  const wakeIssue = asRecord(wake.issue);
  if (asString(wakeIssue.id) || asString(wakeIssue.identifier)) return true;
  const routing = asRecord(context.paperclipExecutionRouting);
  return Boolean(asString(routing.issueId) || asString(routing.taskId));
}

function runHasAssignedBacklog(run: TokenomicsRunSample) {
  return Math.max(0, Math.trunc(run.openAssignedIssueCount ?? 0)) > 0;
}

function providerKey(sample: TokenomicsCostSample) {
  return [sample.provider, sample.biller, sample.billingType, sample.model].join("\u0000");
}

function usageTokensFromRun(run: TokenomicsRunSample) {
  const usage = run.usageJson;
  const inputTokens = asNumber(usage.inputTokens, asNumber(usage.input_tokens, 0));
  const cachedInputTokens = asNumber(
    usage.cachedInputTokens,
    asNumber(usage.cacheReadInputTokens, asNumber(usage.cache_read_input_tokens, 0)),
  );
  const outputTokens = asNumber(usage.outputTokens, asNumber(usage.output_tokens, 0));
  return { inputTokens, cachedInputTokens, outputTokens };
}

function ledgerOutcomeIsSuccessful(outcome: string | null | undefined) {
  return /^(done|success|succeeded|completed|shipped|verified|resolved)$/i.test(outcome ?? "");
}

function ledgerHasArtifactEvidence(entry: TokenomicsLedgerOutputSample) {
  return (
    entry.artifactRefs.length > 0 ||
    entry.contextPackRefs.length > 0 ||
    entry.finalResponseArtifactRefs.length > 0 ||
    entry.receiptPaths.length > 0
  );
}

function ledgerGoLiveEvaluation(entry: TokenomicsLedgerOutputSample) {
  return asRecord(entry.metadata.goLiveDeltaEvaluation);
}

function ledgerGoLiveDeltaIsValuable(entry: TokenomicsLedgerOutputSample) {
  return ledgerGoLiveEvaluation(entry).status === "valuable";
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0))]
    .sort();
}

function normalizeFlywheelToken(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/<run_id>/g, "run_id")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeEvidenceText(value: string | null | undefined) {
  return normalizeFlywheelToken(value).replace(/-/g, " ");
}

function readManifestStageOwner(manifest: FlywheelCoverageManifest | null, stage: string | null) {
  if (!manifest || !stage) return null;
  const normalizedStage = normalizeFlywheelToken(stage);
  for (const stageEntry of manifest.stages) {
    if (normalizeFlywheelToken(asString(stageEntry.stage)) !== normalizedStage) continue;
    return asString(stageEntry.owner_plane, asString(stageEntry.ownerPlane, "")) || null;
  }
  return null;
}

function readManifestRoutineContract(manifest: FlywheelCoverageManifest | null, routineKey: string | null) {
  if (!manifest || !routineKey) return null;
  const normalizedRoutineKey = normalizeFlywheelToken(routineKey);
  const entry = manifest.routine_coverage.find((candidate) =>
    normalizeFlywheelToken(asString(candidate.routine_key, asString(candidate.routineKey, ""))) === normalizedRoutineKey
  );
  if (!entry) return null;
  const stage = asString(entry.stage) || null;
  return {
    routineKey: normalizedRoutineKey,
    stage,
    ownerPlane: asString(entry.owner_plane, asString(entry.ownerPlane, "")) || readManifestStageOwner(manifest, stage),
    requiredReceipts: uniqueStrings([
      ...asStringArray(entry.required_receipts),
      ...asStringArray(entry.requiredReceipts),
    ]),
  };
}

function readManifestStageContract(manifest: FlywheelCoverageManifest | null, stage: string | null) {
  if (!manifest || !stage) return null;
  const normalizedStage = normalizeFlywheelToken(stage);
  const stageEntry = manifest.stages.find((candidate) => normalizeFlywheelToken(asString(candidate.stage)) === normalizedStage);
  if (!stageEntry) return null;
  return {
    stage: normalizedStage,
    ownerPlane: asString(stageEntry.owner_plane, asString(stageEntry.ownerPlane, "")) || null,
    requiredReceipts: uniqueStrings([
      ...asStringArray(stageEntry.receipt_paths),
      ...asStringArray(stageEntry.receiptPaths),
    ]),
  };
}

function extractRoutineKeyFromText(value: string | null | undefined) {
  if (!value) return null;
  const match =
    value.match(/routine[_\s-]*key\s*[:=]\s*`?([A-Za-z0-9_.-]+)`?/i) ??
    value.match(/routine\s*[:=]\s*`?([A-Za-z0-9_.-]+)`?/i);
  return match?.[1] ? normalizeFlywheelToken(match[1]) : null;
}

function issueIdFromRunContext(run: TokenomicsRunSample) {
  const context = run.contextSnapshot;
  const wakeIssue = asRecord(asRecord(context.paperclipWake).issue);
  const routing = asRecord(context.paperclipExecutionRouting);
  return (
    asString(context.issueId) ||
    asString(context.taskId) ||
    asString(context.PAPERCLIP_TASK_ID) ||
    asString(wakeIssue.id) ||
    asString(routing.issueId) ||
    asString(routing.taskId) ||
    null
  );
}

function providerLaneFromRun(run: TokenomicsRunSample) {
  const usageLane = asRecord(run.usageJson.providerLane);
  if (Object.keys(usageLane).length > 0) return usageLane;
  const resultLane = asRecord(asRecord(run.resultJson).providerLane);
  if (Object.keys(resultLane).length > 0) return resultLane;
  return {};
}

function flywheelStageFromLaneOrBlocker(value: string | null | undefined) {
  const normalized = normalizeFlywheelToken(value);
  if (!normalized) return null;
  if (normalized.includes("qa")) return "qa";
  if (normalized.includes("release") || normalized.includes("ship")) return "release";
  if (normalized.includes("evidence") || normalized.includes("research")) return "evidence";
  if (normalized.includes("dispatch")) return "dispatch";
  if (normalized.includes("implement") || normalized.includes("build")) return "implementation";
  if (normalized.includes("learn") || normalized.includes("memory") || normalized.includes("gbrain")) return "learning";
  return null;
}

function inferRoutineKey(input: {
  issue: TokenomicsActiveIssueSample | null;
  routineRun: TokenomicsRoutineRunSample | null;
}) {
  const triggerPayload = asRecord(input.routineRun?.triggerPayload);
  const preflight = asRecord(triggerPayload.paperclipActionabilityPreflight);
  return (
    normalizeFlywheelToken(asString(triggerPayload.routineKey)) ||
    normalizeFlywheelToken(asString(triggerPayload.routine_key)) ||
    normalizeFlywheelToken(asString(preflight.routineKey)) ||
    normalizeFlywheelToken(asString(preflight.routine_key)) ||
    extractRoutineKeyFromText(input.issue?.description) ||
    extractRoutineKeyFromText(input.routineRun?.routineDescription) ||
    extractRoutineKeyFromText(input.routineRun?.routineTitle) ||
    null
  );
}

function inferStage(input: {
  manifest: FlywheelCoverageManifest | null;
  routineKey: string | null;
  issue: TokenomicsActiveIssueSample | null;
  routineRun: TokenomicsRoutineRunSample | null;
  run: TokenomicsRunSample;
}) {
  const routineContract = readManifestRoutineContract(input.manifest, input.routineKey);
  if (routineContract?.stage) return routineContract.stage;
  const triggerPayload = asRecord(input.routineRun?.triggerPayload);
  const preflight = asRecord(triggerPayload.paperclipActionabilityPreflight);
  const providerLane = providerLaneFromRun(input.run);
  return (
    flywheelStageFromLaneOrBlocker(asString(preflight.lane)) ||
    flywheelStageFromLaneOrBlocker(asString(preflight.blockerClass)) ||
    flywheelStageFromLaneOrBlocker(asString(providerLane.lane)) ||
    flywheelStageFromLaneOrBlocker(asString(input.run.triggerDetail)) ||
    flywheelStageFromLaneOrBlocker(input.issue?.title) ||
    null
  );
}

function evidenceStringsForActiveRun(input: {
  run: TokenomicsRunSample;
  issue: TokenomicsActiveIssueSample | null;
  entries: TokenomicsLedgerOutputSample[];
}) {
  return uniqueStrings([
    input.issue?.identifier,
    input.issue?.status,
    input.issue?.title,
    input.run.status,
    input.run.resultJson ? JSON.stringify(input.run.resultJson).slice(0, 20_000) : null,
    input.run.usageJson ? JSON.stringify(input.run.usageJson).slice(0, 20_000) : null,
    ...input.entries.flatMap((entry) => [
      entry.responseClass,
      entry.finalOutcome,
      ...entry.receiptPaths,
      JSON.stringify(entry.artifactRefs).slice(0, 20_000),
      JSON.stringify(entry.contextPackRefs).slice(0, 20_000),
      JSON.stringify(entry.finalResponseArtifactRefs).slice(0, 20_000),
    ]),
  ]);
}

function compactActiveRunReferencePaths(entries: TokenomicsLedgerOutputSample[]) {
  return uniqueStrings(entries.flatMap((entry) => [
    ...entry.receiptPaths,
    ...entry.artifactRefs.flatMap((ref) => [
      asNullableString(ref.path),
      asNullableString(ref.file),
      asNullableString(ref.pointer),
      asNullableString(ref.url),
    ]),
    ...entry.contextPackRefs.flatMap((ref) => [
      asNullableString(ref.path),
      asNullableString(ref.packPath),
      asNullableString(ref.manifestPath),
    ]),
    ...entry.finalResponseArtifactRefs.flatMap((ref) => [
      asNullableString(ref.path),
      asNullableString(ref.file),
      asNullableString(ref.pointer),
      asNullableString(ref.url),
    ]),
  ])).filter((entry) => entry.length <= 500).slice(0, 20);
}

function requirementObserved(requirement: string, evidenceValues: string[], issueDone: boolean) {
  const normalizedRequirement = normalizeEvidenceText(requirement);
  const combined = normalizeEvidenceText(evidenceValues.join(" "));
  if (normalizedRequirement.includes("paperclip adapter result json")) return combined.includes("paperclip adapter result json") || combined.includes("result json");
  if (normalizedRequirement.includes("issue done")) return issueDone;
  if (normalizedRequirement.includes("screenshots")) return combined.includes("screenshot");
  if (normalizedRequirement.includes("qa report")) return combined.includes("qa report md");
  if (normalizedRequirement.includes("regression notes")) return combined.includes("regression notes md");
  if (normalizedRequirement.includes("release gate report")) return combined.includes("release gate");
  if (normalizedRequirement.includes("branch telemetry")) return combined.includes("branch telemetry");
  if (normalizedRequirement.includes("approval state")) return combined.includes("approval");
  if (normalizedRequirement.includes("evidence") && normalizedRequirement.includes("json")) return combined.includes("evidence");
  const tokens = normalizedRequirement.split(/\s+/).filter((token) => token.length >= 3 && token !== "run" && token !== "id");
  return tokens.length > 0 && tokens.every((token) => combined.includes(token));
}

function emptyActiveRunFlywheelCoverage(generatedAt: string, manifest: FlywheelCoverageManifest | null): ActiveRunFlywheelCoverage {
  return {
    generatedAt,
    manifestSchemaVersion: manifest?.schema_version ?? null,
    activeRuns: 0,
    contractedRuns: 0,
    readyRuns: 0,
    pendingRuns: 0,
    missingContractRuns: 0,
    stages: [],
    runs: [],
  };
}

function safeLoadFlywheelCoverageManifest() {
  try {
    return loadFlywheelCoverageManifest();
  } catch {
    return null;
  }
}

export function buildActiveRunFlywheelCoverage(input: {
  generatedAt: Date | string;
  manifest?: FlywheelCoverageManifest | null;
  runs: TokenomicsRunSample[];
  issues?: TokenomicsActiveIssueSample[];
  routineRuns?: TokenomicsRoutineRunSample[];
  ledgerEntries?: TokenomicsLedgerOutputSample[];
  costs?: TokenomicsCostSample[];
}): ActiveRunFlywheelCoverage {
  const generatedAt = input.generatedAt instanceof Date ? input.generatedAt.toISOString() : input.generatedAt;
  const manifest = input.manifest ?? safeLoadFlywheelCoverageManifest();
  const activeRuns = input.runs.filter((run) => run.status === "queued" || run.status === "running");
  if (activeRuns.length === 0) return emptyActiveRunFlywheelCoverage(generatedAt, manifest);

  const issuesByRunId = new Map<string, TokenomicsActiveIssueSample>();
  const issuesById = new Map<string, TokenomicsActiveIssueSample>();
  for (const issue of input.issues ?? []) {
    issuesById.set(issue.id, issue);
    if (issue.executionRunId) issuesByRunId.set(issue.executionRunId, issue);
  }
  const routineRunsById = new Map((input.routineRuns ?? []).map((routineRun) => [routineRun.id, routineRun]));
  const ledgerEntriesByRunId = new Map<string, TokenomicsLedgerOutputSample[]>();
  for (const entry of input.ledgerEntries ?? []) {
    if (!entry.runId) continue;
    const entries = ledgerEntriesByRunId.get(entry.runId) ?? [];
    entries.push(entry);
    ledgerEntriesByRunId.set(entry.runId, entries);
  }
  const rawTokensByRunId = new Map<string, number>();
  for (const sample of input.costs ?? []) {
    if (!sample.heartbeatRunId) continue;
    rawTokensByRunId.set(sample.heartbeatRunId, (rawTokensByRunId.get(sample.heartbeatRunId) ?? 0) + rawTokensForCost(sample));
  }

  const runs = activeRuns.map((run): ActiveRunFlywheelCoverageRun => {
    const contextIssueId = issueIdFromRunContext(run);
    const issue = issuesByRunId.get(run.id) ?? (contextIssueId ? issuesById.get(contextIssueId) : undefined) ?? null;
    const routineRun = issue?.originRunId ? routineRunsById.get(issue.originRunId) ?? null : null;
    const routineKey = inferRoutineKey({ issue, routineRun });
    const inferredStage = inferStage({ manifest, routineKey, issue, routineRun, run });
    const routineContract = readManifestRoutineContract(manifest, routineKey);
    const stageContract = readManifestStageContract(manifest, inferredStage);
    const contract = routineContract ?? stageContract;
    const entries = ledgerEntriesByRunId.get(run.id) ?? [];
    const evidenceValues = evidenceStringsForActiveRun({ run, issue, entries });
    const issueDone = issue?.status === "done";
    const requiredReceipts = contract?.requiredReceipts ?? [];
    const pendingRequiredReceipts = requiredReceipts.filter((requirement) =>
      !requirementObserved(requirement, evidenceValues, issueDone),
    );
    const providerLane = providerLaneFromRun(run);
    const observedReceipts = compactActiveRunReferencePaths(entries);
    const contractPresent = Boolean(contract);
    const coverageState =
      !contractPresent
        ? "missing_contract"
        : pendingRequiredReceipts.length === 0
          ? "ready"
          : "pending";
    return {
      runId: run.id,
      status: run.status,
      agentName: run.agentName,
      issueId: issue?.id ?? contextIssueId,
      issueIdentifier: issue?.identifier ?? null,
      issueStatus: issue?.status ?? null,
      routineRunId: routineRun?.id ?? issue?.originRunId ?? null,
      routineKey,
      stage: contract?.stage ?? inferredStage,
      ownerPlane: contract?.ownerPlane ?? readManifestStageOwner(manifest, inferredStage),
      lane: asNullableString(providerLane.lane) ?? flywheelStageFromLaneOrBlocker(asNullableString(providerLane.lane)),
      selectedAdapterType: asNullableString(providerLane.selectedAdapterType),
      provider: asNullableString(providerLane.provider) ?? asNullableString(run.usageJson.provider),
      biller: asNullableString(providerLane.biller) ?? asNullableString(run.usageJson.biller),
      model: asNullableString(providerLane.model) ?? asNullableString(run.usageJson.model),
      contextPackProfile: asNullableString(providerLane.contextPackProfile),
      contractPresent,
      coverageState,
      pendingRequiredReceipts,
      observedReceipts,
      rawTokens: rawTokensByRunId.get(run.id) ?? rawTokensForCost(usageTokensFromRun(run)),
    };
  });

  const stagesByName = new Map<string, ActiveRunFlywheelCoverageStage>();
  for (const run of runs) {
    const stageName = run.stage ?? "unknown";
    const previous = stagesByName.get(stageName) ?? {
      stage: stageName,
      ownerPlane: run.ownerPlane,
      activeRuns: 0,
      contractedRuns: 0,
      readyRuns: 0,
      pendingRuns: 0,
      missingContractRuns: 0,
      pendingRequiredReceipts: [],
    };
    previous.activeRuns += 1;
    if (run.contractPresent) previous.contractedRuns += 1;
    if (run.coverageState === "ready") previous.readyRuns += 1;
    if (run.coverageState === "pending") previous.pendingRuns += 1;
    if (run.coverageState === "missing_contract") previous.missingContractRuns += 1;
    previous.pendingRequiredReceipts = uniqueStrings([
      ...previous.pendingRequiredReceipts,
      ...run.pendingRequiredReceipts,
    ]);
    if (!previous.ownerPlane && run.ownerPlane) previous.ownerPlane = run.ownerPlane;
    stagesByName.set(stageName, previous);
  }

  return {
    generatedAt,
    manifestSchemaVersion: manifest?.schema_version ?? null,
    activeRuns: runs.length,
    contractedRuns: runs.filter((run) => run.contractPresent).length,
    readyRuns: runs.filter((run) => run.coverageState === "ready").length,
    pendingRuns: runs.filter((run) => run.coverageState === "pending").length,
    missingContractRuns: runs.filter((run) => run.coverageState === "missing_contract").length,
    stages: [...stagesByName.values()].sort((left, right) => left.stage.localeCompare(right.stage)),
    runs: runs.sort((left, right) => left.runId.localeCompare(right.runId)).slice(0, 100),
  };
}

function buildOutputMetrics(input: {
  runs: TokenomicsRunSample[];
  issues?: TokenomicsIssueOutputSample[];
  ledgerEntries?: TokenomicsLedgerOutputSample[];
  decisionUnits: number;
}): TokenomicsOutputMetrics {
  const issues = input.issues ?? [];
  const ledgerEntries = input.ledgerEntries ?? [];
  const completedIssues = issues.filter((issue) => issue.status === "done" || Boolean(issue.completedAt)).length;
  const succeededIssueBoundRuns = input.runs.filter((run) => run.status === "succeeded" && runHasIssueContext(run)).length;
  const artifactBackedLedgerEntries = ledgerEntries.filter(ledgerHasArtifactEvidence).length;
  const receiptBackedLedgerEntries = ledgerEntries.filter((entry) => entry.receiptPaths.length > 0).length;
  const successfulLedgerOutcomes = ledgerEntries.filter((entry) => ledgerOutcomeIsSuccessful(entry.finalOutcome)).length;
  const goLiveDeltaBackedLedgerEntries = ledgerEntries.filter(
    (entry) => Object.keys(asRecord(entry.metadata.goLiveDelta)).length > 0,
  ).length;
  const valuableGoLiveDeltaUnits = ledgerEntries.filter(ledgerGoLiveDeltaIsValuable).length;
  const outputUnits = new Set<string>();
  const deliverableUnits = new Set<string>();

  for (const issue of issues) {
    if (issue.status === "done" || issue.completedAt) {
      outputUnits.add(`issue:${issue.id}`);
      deliverableUnits.add(`issue:${issue.id}`);
    }
  }
  for (const run of input.runs) {
    if (run.status === "succeeded" && runHasIssueContext(run)) outputUnits.add(`run:${run.id}`);
  }
  for (const entry of ledgerEntries) {
    if (ledgerHasArtifactEvidence(entry)) outputUnits.add(`ledger-artifact:${entry.id}`);
    if (ledgerGoLiveDeltaIsValuable(entry)) outputUnits.add(`ledger-go-live:${entry.id}`);
    if (ledgerOutcomeIsSuccessful(entry.finalOutcome)) {
      outputUnits.add(`ledger-outcome:${entry.id}`);
      if (entry.issueId && ledgerHasArtifactEvidence(entry) && ledgerGoLiveDeltaIsValuable(entry)) {
        deliverableUnits.add(`ledger-deliverable:${entry.id}`);
      }
    }
  }

  const verifiedOutputUnits = outputUnits.size;
  const finalDeliverableUnits = deliverableUnits.size;
  return {
    completedIssues,
    succeededIssueBoundRuns,
    artifactBackedLedgerEntries,
    receiptBackedLedgerEntries,
    successfulLedgerOutcomes,
    goLiveDeltaBackedLedgerEntries,
    valuableGoLiveDeltaUnits,
    verifiedOutputUnits,
    verifiedOutputUnitsPerDecision: verifiedOutputUnits / Math.max(1, input.decisionUnits),
    finalDeliverableUnits,
    finalDeliverableUnitsPerDecision: finalDeliverableUnits / Math.max(1, input.decisionUnits),
  };
}

export function buildTokenomicsWindowMetrics(input: {
  windowStart: Date;
  windowEnd: Date;
  wakeups: TokenomicsWakeupSample[];
  runs: TokenomicsRunSample[];
  costs: TokenomicsCostSample[];
  issues?: TokenomicsIssueOutputSample[];
  ledgerEntries?: TokenomicsLedgerOutputSample[];
  highBurnThresholdTokens?: number;
  estimatedTokensPerIdleSkip?: number;
}): TokenomicsWindowMetrics {
  const highBurnThresholdTokens = input.highBurnThresholdTokens ?? DEFAULT_HIGH_BURN_TOKENS;
  const estimatedTokensPerIdleSkip = input.estimatedTokensPerIdleSkip ?? DEFAULT_ESTIMATED_TOKENS_PER_IDLE_SKIP;
  const providerBreakdown = new Map<string, TokenomicsProviderBreakdown>();
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costCents = 0;

  for (const sample of input.costs) {
    inputTokens += sample.inputTokens;
    cachedInputTokens += sample.cachedInputTokens;
    outputTokens += sample.outputTokens;
    costCents += sample.costCents;
    const key = providerKey(sample);
    const existing = providerBreakdown.get(key) ?? {
      provider: sample.provider,
      biller: sample.biller,
      billingType: sample.billingType,
      model: sample.model,
      events: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      rawTokens: 0,
      costCents: 0,
    };
    existing.events += 1;
    existing.inputTokens += sample.inputTokens;
    existing.cachedInputTokens += sample.cachedInputTokens;
    existing.outputTokens += sample.outputTokens;
    existing.rawTokens += rawTokensForCost(sample);
    existing.costCents += sample.costCents;
    providerBreakdown.set(key, existing);
  }

  const costedRunIds = new Set(input.costs.map((sample) => sample.heartbeatRunId).filter((value): value is string => Boolean(value)));
  for (const run of input.runs) {
    if (costedRunIds.has(run.id)) continue;
    const usage = usageTokensFromRun(run);
    inputTokens += usage.inputTokens;
    cachedInputTokens += usage.cachedInputTokens;
    outputTokens += usage.outputTokens;
  }

  const timerWakeups = input.wakeups.filter((wakeup) => isTimerLike(wakeup.source, wakeup.triggerDetail));
  const idleSkipped = input.wakeups.filter((wakeup) =>
    wakeup.status === "skipped" &&
    (wakeup.reason === "heartbeat.idle_no_assignment" ||
      asString(wakeup.payload.reason) === "heartbeat.idle_no_assignment" ||
      asString(wakeup.payload.kind) === "paperclipIdleTimerSkip")
  ).length;
  const providerBackoffSkipped = input.wakeups.filter((wakeup) =>
    wakeup.status === "skipped" && wakeup.reason === "provider_degraded_backoff"
  ).length;
  const noNewSignalSkipped = input.wakeups.filter((wakeup) => {
    const noNewSignalPayload = asRecord(wakeup.payload.paperclipNoNewSignalTimerSkip);
    return wakeup.status === "skipped" &&
      (wakeup.reason === "heartbeat.no_new_issue_signal" ||
        asString(wakeup.payload.reason) === "heartbeat.no_new_issue_signal" ||
        asString(noNewSignalPayload.reason) === "no_new_issue_signal");
  }).length;
  const blockedIssueNoNewSignalSkipped = input.wakeups.filter((wakeup) => {
    const blockedNoNewSignalPayload = asRecord(wakeup.payload.paperclipBlockedIssueNoNewSignalTimerSkip);
    return wakeup.status === "skipped" &&
      (wakeup.reason === "heartbeat.blocked_issue_no_new_signal" ||
        asString(wakeup.payload.reason) === "heartbeat.blocked_issue_no_new_signal" ||
        asString(blockedNoNewSignalPayload.reason) === "blocked_issue_no_new_signal");
  }).length;
  const systemSelfHealGuardSkipped = input.wakeups.filter((wakeup) => {
    const guardPayload = asRecord(wakeup.payload.paperclipSystemSelfHealGuardSkip);
    return wakeup.status === "skipped" &&
      (wakeup.reason === "heartbeat.system_self_heal_guard_no_agent_action" ||
        asString(wakeup.payload.reason) === "heartbeat.system_self_heal_guard_no_agent_action" ||
        asString(guardPayload.reason) === "system_self_heal_guard_no_agent_action");
  }).length;
  const issueBoundRuns = input.runs.filter(runHasIssueContext).length;
  const assignmentBacklogScans = input.runs.filter((run) =>
    isTimerLike(run.invocationSource, run.triggerDetail) &&
    !runHasIssueContext(run) &&
    runHasAssignedBacklog(run)
  ).length;
  const timerNoIssueLaunches = input.runs.filter((run) =>
    isTimerLike(run.invocationSource, run.triggerDetail) &&
    !runHasIssueContext(run) &&
    !runHasAssignedBacklog(run)
  ).length;
  const explicitRuns = input.runs.filter((run) => !isTimerLike(run.invocationSource, run.triggerDetail)).length;
  const decisionUnits = Math.max(input.wakeups.length, input.runs.length);
  const rateDenominator = Math.max(1, decisionUnits);
  const valuableOrSafelySkippedUnits = Math.min(
    decisionUnits,
    issueBoundRuns +
      assignmentBacklogScans +
      explicitRuns +
      idleSkipped +
      providerBackoffSkipped +
      noNewSignalSkipped +
      blockedIssueNoNewSignalSkipped +
      systemSelfHealGuardSkipped,
  );
  const rawTotal = inputTokens + outputTokens;
  const output = buildOutputMetrics({
    runs: input.runs,
    issues: input.issues,
    ledgerEntries: input.ledgerEntries,
    decisionUnits,
  });

  const highBurnEvents = input.costs
    .map((sample) => ({
      id: sample.id,
      heartbeatRunId: sample.heartbeatRunId,
      agentId: sample.agentId,
      agentName: sample.agentName,
      provider: sample.provider,
      billingType: sample.billingType,
      model: sample.model,
      rawTokens: rawTokensForCost(sample),
      occurredAt: sample.occurredAt,
    }))
    .filter((sample) => sample.rawTokens >= highBurnThresholdTokens)
    .sort((left, right) => right.rawTokens - left.rawTokens)
    .slice(0, 20);

  return {
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    wakeups: {
      total: input.wakeups.length,
      timer: timerWakeups.length,
      skipped: input.wakeups.filter((wakeup) => wakeup.status === "skipped").length,
      idleSkipped,
      providerBackoffSkipped,
      noNewSignalSkipped,
      blockedIssueNoNewSignalSkipped,
      systemSelfHealGuardSkipped,
    },
    runs: {
      total: input.runs.length,
      active: input.runs.filter((run) => run.status === "queued" || run.status === "running").length,
      succeeded: input.runs.filter((run) => run.status === "succeeded").length,
      failed: input.runs.filter((run) => run.status === "failed").length,
      timedOut: input.runs.filter((run) => run.status === "timed_out").length,
      issueBound: issueBoundRuns,
      timerNoIssueLaunches,
      providerQuotaFailures: input.runs.filter((run) => run.errorCode === "provider_quota_failure").length,
      providerPreflightFailures: input.runs.filter((run) => run.errorCode === "provider_reliability_preflight_failed").length,
      assignmentBacklogScans,
    },
    tokens: {
      input: inputTokens,
      cachedInput: cachedInputTokens,
      output: outputTokens,
      rawTotal,
      uncachedTotal: Math.max(0, inputTokens - cachedInputTokens) + outputTokens,
      costCents,
      rawTokensPerOpportunity: rawTotal / rateDenominator,
    },
    optimization: {
      decisionUnits,
      valuableOrSafelySkippedUnits,
      valuableOrSafelySkippedRatio: decisionUnits === 0 ? 1 : valuableOrSafelySkippedUnits / decisionUnits,
      estimatedAvoidedTokensFromIdleSkips: idleSkipped * estimatedTokensPerIdleSkip,
    },
    output,
    providers: Array.from(providerBreakdown.values())
      .sort((left, right) => right.rawTokens - left.rawTokens),
    highBurnEvents,
  };
}

function providerSeen(metrics: TokenomicsWindowMetrics, pattern: RegExp) {
  return metrics.providers.some((entry) => pattern.test(`${entry.provider} ${entry.biller} ${entry.model}`));
}

export function buildTokenomicsWatchReport(input: {
  current: TokenomicsWindowMetrics;
  baseline?: TokenomicsWindowMetrics | null;
  budgetDrift?: HermesBudgetDriftSummary;
  minSavingsRatio?: number;
  minOptimizationRatio?: number;
  minOutputGainRatio?: number;
  highBurnThresholdTokens?: number;
  generatedAt?: Date;
  receiptPath?: string | null;
  activeRunFlywheelCoverage?: ActiveRunFlywheelCoverage;
  providerCapacity?: {
    minimax?: ProviderCapacitySnapshot | null;
  };
}): TokenomicsWatchReport {
  const baseline = input.baseline ?? null;
  const minSavingsRatio = input.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO;
  const minOptimizationRatio = input.minOptimizationRatio ?? DEFAULT_MIN_OPTIMIZATION_RATIO;
  const minOutputGainRatio = input.minOutputGainRatio ?? DEFAULT_MIN_OUTPUT_GAIN_RATIO;
  const highBurnThresholdTokens = input.highBurnThresholdTokens ?? DEFAULT_HIGH_BURN_TOKENS;
  const budgetDrift = input.budgetDrift ?? { hermesAgents: 0, driftedAgents: 0, driftedAgentNames: [] };
  const tokenReductionRatio =
    baseline && baseline.tokens.rawTokensPerOpportunity > 0
      ? 1 - (input.current.tokens.rawTokensPerOpportunity / baseline.tokens.rawTokensPerOpportunity)
      : null;
  const tokenReductionStatus =
    tokenReductionRatio === null ? "warn" : tokenReductionRatio >= minSavingsRatio ? "pass" : "fail";
  const optimizationStatus =
    input.current.optimization.valuableOrSafelySkippedRatio >= minOptimizationRatio ? "pass" : "fail";
  const baselineOutputRate = baseline?.output.finalDeliverableUnitsPerDecision ?? 0;
  const currentOutputRate = input.current.output.finalDeliverableUnitsPerDecision;
  const valuableOutputGainRatio =
    baseline && baselineOutputRate > 0 ? currentOutputRate / baselineOutputRate - 1 : null;
  const hasCompletedCurrentWork =
    input.current.runs.failed > 0 ||
    input.current.runs.timedOut > 0 ||
    input.current.output.finalDeliverableUnits > 0 ||
    input.current.tokens.rawTotal > 0;
  const valuableOutputStatus =
    valuableOutputGainRatio !== null && valuableOutputGainRatio >= minOutputGainRatio
      ? "pass"
      : hasCompletedCurrentWork
        ? "fail"
        : "warn";
  const highBurnStatus =
    input.current.highBurnEvents.length === 0 && input.current.runs.timerNoIssueLaunches === 0 ? "pass" : "fail";
  const driftStatus = budgetDrift.driftedAgents === 0 ? "pass" : "fail";

  const recommendedActions: string[] = [];
  if (tokenReductionStatus === "warn") {
    recommendedActions.push("Collect a baseline window before claiming the 50 percent token reduction target.");
  } else if (tokenReductionStatus === "fail") {
    recommendedActions.push("Shrink live prompt/session replay further; current tokens per opportunity are not at least 50 percent below baseline.");
  }
  if (optimizationStatus === "fail") {
    recommendedActions.push("Re-check idle assignment preflight and issue-bound wake routing; fewer than 90 percent of wake decisions were valuable work or safe skips.");
  }
  if (valuableOutputStatus === "warn") {
    recommendedActions.push("Current window is too idle to prove the 90 percent valuable-output lift; keep the watch running through a work-bearing window before claiming the output target.");
  } else if (valuableOutputStatus === "fail") {
    recommendedActions.push("Increase completed issues or successful issue-tied artifact deliveries; current final-deliverable rate is not 90 percent above baseline.");
  }
  if (input.current.highBurnEvents.length > 0) {
    recommendedActions.push("Investigate high-burn cost events before allowing more subscription fallback runs.");
  }
  if (input.current.runs.timerNoIssueLaunches > 0) {
    recommendedActions.push("Timer heartbeats launched adapters without issue context; restore skip-before-adapter behavior.");
  }
  if (driftStatus === "fail") {
    recommendedActions.push("Run the tokenomics balancer or launch this watchdog with --apply-balance-on-drift.");
  }
  const activeRunFlywheelCoverage =
    input.activeRunFlywheelCoverage ?? emptyActiveRunFlywheelCoverage(
      (input.generatedAt ?? new Date()).toISOString(),
      null,
    );
  if (activeRunFlywheelCoverage.missingContractRuns > 0) {
    recommendedActions.push("Active Hermes/Paperclip runs are missing flywheel coverage contracts; attach the run to a manifest routine/stage before allowing provider-heavy work to continue.");
  }
  const minimaxCapacity = input.providerCapacity?.minimax ?? null;
  if (minimaxCapacity?.status === "exhausted") {
    const resetAt =
      minimaxCapacity.quota?.limitingWindow === "weekly"
        ? minimaxCapacity.quota.currentWeeklyEndsAt
        : minimaxCapacity.quota?.currentIntervalEndsAt;
    recommendedActions.push(
      resetAt
        ? `MiniMax Token Plan quota is exhausted; keep post-MiniMax fallbacks bounded until the ${minimaxCapacity.quota?.limitingWindow ?? "quota"} window releases around ${resetAt}.`
        : "MiniMax Token Plan quota is exhausted; keep post-MiniMax fallbacks bounded until provider capacity polling reports available quota.",
    );
  } else if (minimaxCapacity?.status === "unknown") {
    recommendedActions.push("MiniMax Token Plan usage polling is unavailable; verify the subscription key or Hermes home env before relying on reset timing.");
  }
  if (recommendedActions.length === 0) {
    recommendedActions.push("Maintain the watch loop and keep receipts as production evidence.");
  }

  const status =
    tokenReductionStatus === "fail" ||
    optimizationStatus === "fail" ||
    valuableOutputStatus === "fail" ||
    highBurnStatus === "fail" ||
    driftStatus === "fail"
      ? "fail"
      : tokenReductionStatus === "warn" || valuableOutputStatus === "warn"
        ? "warn"
        : "pass";

  return {
    version: WATCH_VERSION,
    status,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    targets: {
      minSavingsRatio,
      minOptimizationRatio,
      minOutputGainRatio,
      highBurnThresholdTokens,
    },
    current: input.current,
    baseline,
    budgetDrift,
    providerCapacity: {
      minimax: input.providerCapacity?.minimax ?? null,
    },
    activeRunFlywheelCoverage,
    evaluation: {
      tokenReductionRatio,
      tokenReductionStatus,
      optimizationStatus,
      valuableOutputGainRatio,
      valuableOutputStatus,
      highBurnStatus,
      driftStatus,
      providerRouteCoverage: {
        minimaxSeen: providerSeen(input.current, /minimax/i) || Boolean(baseline && providerSeen(baseline, /minimax/i)),
        geminiSeen: providerSeen(input.current, /google|gemini/i) || Boolean(baseline && providerSeen(baseline, /google|gemini/i)),
        claudeSeen: providerSeen(input.current, /anthropic|claude/i) || Boolean(baseline && providerSeen(baseline, /anthropic|claude/i)),
      },
    },
    factoryLoop: {
      truthPlane: "codex portfolio-os repo and dispatch/readiness artifacts",
      researchPlane: "scrapegraphai extraction receipts, graphify/GBrain semantic recall, gstack validation evidence",
      controlPlane: "paperclip cockpit routines, issues, context ledger, wakeup requests, heartbeat runs, cost events",
      executionPlane: "Hermes Agent through Paperclip adapters with MiniMax first, Gemini/Claude subscription fallbacks only when valuable",
      requiredOptimizerTools: ["scrapegraphai", "graphify", "gstack", "gbrain", "context-packs", "ponytail"],
      evidenceContract: [
        "Portfolio OS remains source of truth for research and dispatch authority.",
        "Paperclip cockpit owns prioritization, wake gating, receipts, and issue-bound execution.",
        "Hermes adapters must cap prompt/output size, rotate stale sessions, and skip no-work timer wakes before spawning CLIs.",
        "External tokenomics receipts must show 50 percent or better token reduction and 90 percent or better valuable/safely-skipped wake decisions.",
      ],
    },
    recommendedActions,
    selfImprovementLoop: {
      command: "pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-watch.ts --watch --interval-seconds 300 --apply-balance-on-drift",
      receiptPath: input.receiptPath ?? null,
      canApplyBalanceOnDrift: true,
    },
    receiptPath: input.receiptPath ?? null,
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
  return path.join(root, `${stamp}-hermes-tokenomics-watch.json`);
}

async function collectCostSamples(db: Db, start: Date, end: Date): Promise<TokenomicsCostSample[]> {
  const rows = await db
    .select({
      id: costEvents.id,
      companyId: costEvents.companyId,
      agentId: costEvents.agentId,
      agentName: agents.name,
      heartbeatRunId: costEvents.heartbeatRunId,
      provider: costEvents.provider,
      biller: costEvents.biller,
      billingType: costEvents.billingType,
      model: costEvents.model,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      outputTokens: costEvents.outputTokens,
      costCents: costEvents.costCents,
      occurredAt: costEvents.occurredAt,
    })
    .from(costEvents)
    .leftJoin(agents, eq(agents.id, costEvents.agentId))
    .where(and(gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)))
    .orderBy(desc(costEvents.occurredAt))
    .limit(5_000);

  return rows.map((row) => ({
    ...row,
    agentName: row.agentName ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

async function collectRunSamples(db: Db, start: Date, end: Date, includeRunIds: string[] = []): Promise<TokenomicsRunSample[]> {
  const includeRuns = includeRunIds.length > 0 ? inArray(heartbeatRuns.id, includeRunIds) : undefined;
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      errorCode: heartbeatRuns.errorCode,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(or(
      and(gte(heartbeatRuns.createdAt, start), lt(heartbeatRuns.createdAt, end)),
      and(gte(heartbeatRuns.finishedAt, start), lt(heartbeatRuns.finishedAt, end)),
      includeRuns,
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(5_000);

  const agentIds = Array.from(new Set(rows.map((row) => row.agentId)));
  const assignedIssueCounts = new Map<string, number>();
  if (agentIds.length > 0) {
    const issueRows = await db
      .select({
        agentId: issues.assigneeAgentId,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(and(
        inArray(issues.assigneeAgentId, agentIds),
        inArray(issues.status, ["todo", "in_progress", "blocked"]),
      ))
      .groupBy(issues.assigneeAgentId);
    for (const row of issueRows) {
      if (row.agentId) assignedIssueCounts.set(row.agentId, Number(row.count ?? 0));
    }
  }

  return rows.map((row) => ({
    ...row,
    agentName: row.agentName ?? null,
    triggerDetail: row.triggerDetail ?? null,
    errorCode: row.errorCode ?? null,
    usageJson: asRecord(row.usageJson),
    resultJson: asRecord(row.resultJson),
    contextSnapshot: asRecord(row.contextSnapshot),
    openAssignedIssueCount: assignedIssueCounts.get(row.agentId) ?? 0,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

async function collectWakeupSamples(db: Db, start: Date, end: Date): Promise<TokenomicsWakeupSample[]> {
  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      agentId: agentWakeupRequests.agentId,
      agentName: agents.name,
      source: agentWakeupRequests.source,
      triggerDetail: agentWakeupRequests.triggerDetail,
      reason: agentWakeupRequests.reason,
      status: agentWakeupRequests.status,
      payload: agentWakeupRequests.payload,
      runId: agentWakeupRequests.runId,
      requestedAt: agentWakeupRequests.requestedAt,
      finishedAt: agentWakeupRequests.finishedAt,
    })
    .from(agentWakeupRequests)
    .innerJoin(agents, eq(agents.id, agentWakeupRequests.agentId))
    .where(and(gte(agentWakeupRequests.requestedAt, start), lt(agentWakeupRequests.requestedAt, end)))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(5_000);

  return rows.map((row) => ({
    ...row,
    agentName: row.agentName ?? null,
    triggerDetail: row.triggerDetail ?? null,
    reason: row.reason ?? null,
    payload: asRecord(row.payload),
    runId: row.runId ?? null,
    requestedAt: row.requestedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

async function collectIssueOutputSamples(db: Db, start: Date, end: Date, includeRunIds: string[] = []): Promise<TokenomicsIssueOutputSample[]> {
  const includeRuns = includeRunIds.length > 0 ? inArray(issues.executionRunId, includeRunIds) : undefined;
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
      identifier: issues.identifier,
      completedAt: issues.completedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(or(
      and(gte(issues.completedAt, start), lt(issues.completedAt, end)),
      and(eq(issues.status, "done"), gte(issues.updatedAt, start), lt(issues.updatedAt, end)),
      includeRuns,
    ))
    .orderBy(desc(issues.updatedAt))
    .limit(5_000);

  return rows.map((row) => ({
    ...row,
    assigneeAgentId: row.assigneeAgentId ?? null,
    identifier: row.identifier ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function collectLedgerOutputSamples(db: Db, start: Date, end: Date, includeRunIds: string[] = []): Promise<TokenomicsLedgerOutputSample[]> {
  const includeRuns = includeRunIds.length > 0 ? inArray(contextLedgerEntries.runId, includeRunIds) : undefined;
  const rows = await db
    .select({
      id: contextLedgerEntries.id,
      companyId: contextLedgerEntries.companyId,
      runId: contextLedgerEntries.runId,
      issueId: contextLedgerEntries.issueId,
      agentId: contextLedgerEntries.agentId,
      responseClass: contextLedgerEntries.responseClass,
      finalOutcome: contextLedgerEntries.finalOutcome,
      artifactRefs: contextLedgerEntries.artifactRefs,
      contextPackRefs: contextLedgerEntries.contextPackRefs,
      finalResponseArtifactRefs: contextLedgerEntries.finalResponseArtifactRefs,
      receiptPaths: contextLedgerEntries.receiptPaths,
      metadata: contextLedgerEntries.metadata,
      createdAt: contextLedgerEntries.createdAt,
    })
    .from(contextLedgerEntries)
    .where(or(
      and(gte(contextLedgerEntries.createdAt, start), lt(contextLedgerEntries.createdAt, end)),
      includeRuns,
    ))
    .orderBy(desc(contextLedgerEntries.createdAt))
    .limit(5_000);

  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    responseClass: row.responseClass,
    finalOutcome: row.finalOutcome ?? null,
    artifactRefs: asRecordArray(row.artifactRefs),
    contextPackRefs: asRecordArray(row.contextPackRefs),
    finalResponseArtifactRefs: asRecordArray(row.finalResponseArtifactRefs),
    receiptPaths: asStringArray(row.receiptPaths),
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
  }));
}

async function collectCostSamplesForRunIds(db: Db, runIds: string[]): Promise<TokenomicsCostSample[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({
      id: costEvents.id,
      companyId: costEvents.companyId,
      agentId: costEvents.agentId,
      agentName: agents.name,
      heartbeatRunId: costEvents.heartbeatRunId,
      provider: costEvents.provider,
      biller: costEvents.biller,
      billingType: costEvents.billingType,
      model: costEvents.model,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      outputTokens: costEvents.outputTokens,
      costCents: costEvents.costCents,
      occurredAt: costEvents.occurredAt,
    })
    .from(costEvents)
    .leftJoin(agents, eq(agents.id, costEvents.agentId))
    .where(inArray(costEvents.heartbeatRunId, runIds))
    .orderBy(desc(costEvents.occurredAt))
    .limit(5_000);

  return rows.map((row) => ({
    ...row,
    agentName: row.agentName ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

async function collectLedgerOutputSamplesForRunIds(db: Db, runIds: string[]): Promise<TokenomicsLedgerOutputSample[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({
      id: contextLedgerEntries.id,
      companyId: contextLedgerEntries.companyId,
      runId: contextLedgerEntries.runId,
      issueId: contextLedgerEntries.issueId,
      agentId: contextLedgerEntries.agentId,
      responseClass: contextLedgerEntries.responseClass,
      finalOutcome: contextLedgerEntries.finalOutcome,
      artifactRefs: contextLedgerEntries.artifactRefs,
      contextPackRefs: contextLedgerEntries.contextPackRefs,
      finalResponseArtifactRefs: contextLedgerEntries.finalResponseArtifactRefs,
      receiptPaths: contextLedgerEntries.receiptPaths,
      metadata: contextLedgerEntries.metadata,
      createdAt: contextLedgerEntries.createdAt,
    })
    .from(contextLedgerEntries)
    .where(inArray(contextLedgerEntries.runId, runIds))
    .orderBy(desc(contextLedgerEntries.createdAt))
    .limit(5_000);

  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    responseClass: row.responseClass,
    finalOutcome: row.finalOutcome ?? null,
    artifactRefs: asRecordArray(row.artifactRefs),
    contextPackRefs: asRecordArray(row.contextPackRefs),
    finalResponseArtifactRefs: asRecordArray(row.finalResponseArtifactRefs),
    receiptPaths: asStringArray(row.receiptPaths),
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
  }));
}

async function collectActiveRunSamples(db: Db): Promise<TokenomicsRunSample[]> {
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      errorCode: heartbeatRuns.errorCode,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(inArray(heartbeatRuns.status, ["queued", "running"]))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(500);

  return rows.map((row) => ({
    ...row,
    agentName: row.agentName ?? null,
    triggerDetail: row.triggerDetail ?? null,
    errorCode: row.errorCode ?? null,
    usageJson: asRecord(row.usageJson),
    resultJson: asRecord(row.resultJson),
    contextSnapshot: asRecord(row.contextSnapshot),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

async function collectActiveIssueSamples(db: Db, runs: TokenomicsRunSample[]): Promise<TokenomicsActiveIssueSample[]> {
  if (runs.length === 0) return [];
  const runIds = runs.map((run) => run.id);
  const contextIssueIds = uniqueStrings(runs.map(issueIdFromRunContext));
  const conditions = [
    inArray(issues.executionRunId, runIds),
    ...(contextIssueIds.length > 0 ? [inArray(issues.id, contextIssueIds)] : []),
  ];
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      identifier: issues.identifier,
      executionRunId: issues.executionRunId,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(or(...conditions))
    .orderBy(desc(issues.updatedAt))
    .limit(1_000);

  return rows.map((row) => ({
    ...row,
    description: row.description ?? null,
    identifier: row.identifier ?? null,
    executionRunId: row.executionRunId ?? null,
    originRunId: row.originRunId ?? null,
  }));
}

async function collectRoutineRunSamples(db: Db, issuesInScope: TokenomicsActiveIssueSample[]): Promise<TokenomicsRoutineRunSample[]> {
  const originRunIds = uniqueStrings(issuesInScope.map((issue) => issue.originRunId));
  if (originRunIds.length === 0) return [];
  const rows = await db
    .select({
      id: routineRuns.id,
      routineId: routineRuns.routineId,
      routineTitle: routines.title,
      routineDescription: routines.description,
      triggerPayload: routineRuns.triggerPayload,
    })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(inArray(routineRuns.id, originRunIds))
    .limit(1_000);

  return rows.map((row) => ({
    id: row.id,
    routineId: row.routineId,
    routineTitle: row.routineTitle ?? null,
    routineDescription: row.routineDescription ?? null,
    triggerPayload: asRecord(row.triggerPayload),
  }));
}

async function collectActiveRunFlywheelCoverage(db: Db, generatedAt: Date): Promise<ActiveRunFlywheelCoverage> {
  const runs = await collectActiveRunSamples(db);
  const issuesInScope = await collectActiveIssueSamples(db, runs);
  const runIds = runs.map((run) => run.id);
  const [routineRunSamples, ledgerEntries, costs] = await Promise.all([
    collectRoutineRunSamples(db, issuesInScope),
    collectLedgerOutputSamplesForRunIds(db, runIds),
    collectCostSamplesForRunIds(db, runIds),
  ]);
  return buildActiveRunFlywheelCoverage({
    generatedAt,
    runs,
    issues: issuesInScope,
    routineRuns: routineRunSamples,
    ledgerEntries,
    costs,
  });
}

async function collectWindowMetrics(db: Db, input: {
  start: Date;
  end: Date;
  highBurnThresholdTokens: number;
  estimatedTokensPerIdleSkip: number;
}) {
  const costs = await collectCostSamples(db, input.start, input.end);
  const includeRunIds = Array.from(new Set(costs.map((sample) => sample.heartbeatRunId).filter((value): value is string => Boolean(value))));
  const [runs, wakeups, issueOutputs, ledgerOutputs] = await Promise.all([
    collectRunSamples(db, input.start, input.end, includeRunIds),
    collectWakeupSamples(db, input.start, input.end),
    collectIssueOutputSamples(db, input.start, input.end, includeRunIds),
    collectLedgerOutputSamples(db, input.start, input.end, includeRunIds),
  ]);
  return buildTokenomicsWindowMetrics({
    windowStart: input.start,
    windowEnd: input.end,
    costs,
    runs,
    wakeups,
    issues: issueOutputs,
    ledgerEntries: ledgerOutputs,
    highBurnThresholdTokens: input.highBurnThresholdTokens,
    estimatedTokensPerIdleSkip: input.estimatedTokensPerIdleSkip,
  });
}

async function collectBudgetDrift(db: Db): Promise<HermesBudgetDriftSummary> {
  const rows = await db
    .select({
      id: agents.id,
      companyName: companies.name,
      name: agents.name,
      role: agents.role,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(eq(agents.adapterType, "hermes_local"))
    .orderBy(sql`${companies.name}`, sql`${agents.name}`);

  const driftedAgentNames: string[] = [];
  for (const row of rows) {
    const adapterConfig = asRecord(row.adapterConfig);
    const runtimeConfig = asRecord(row.runtimeConfig);
    const next = buildBalancedHermesAgentConfig({
      role: row.role,
      name: row.name,
      adapterConfig,
      runtimeConfig,
    });
    if (
      stableJson(adapterConfig) !== stableJson(next.nextAdapterConfig) ||
      stableJson(runtimeConfig) !== stableJson(next.nextRuntimeConfig)
    ) {
      driftedAgentNames.push(`${row.companyName}/${row.name}`);
    }
  }

  return {
    hermesAgents: rows.length,
    driftedAgents: driftedAgentNames.length,
    driftedAgentNames: driftedAgentNames.slice(0, 50),
  };
}

export async function runHermesTokenomicsWatch(options: WatchOptions = {}): Promise<TokenomicsWatchReport> {
  const now = options.now ?? new Date();
  const windowMinutes = Math.max(1, options.windowMinutes ?? 30);
  const baselineHours = Math.max(1, options.baselineHours ?? 96);
  const highBurnThresholdTokens = Math.max(1, options.highBurnThresholdTokens ?? DEFAULT_HIGH_BURN_TOKENS);
  const estimatedTokensPerIdleSkip = Math.max(1, options.estimatedTokensPerIdleSkip ?? DEFAULT_ESTIMATED_TOKENS_PER_IDLE_SKIP);
  const currentEnd = now;
  const currentStart = new Date(currentEnd.getTime() - windowMinutes * 60_000);
  const baselineEnd = options.baselineEnd ?? currentStart;
  const baselineStart = options.baselineStart ?? new Date(baselineEnd.getTime() - baselineHours * 60 * 60_000);
  const homeDir = options.homeDir ?? DEFAULT_HOME;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;

  await loadInstanceEnvFile(homeDir, instanceId);
  const config = await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const db = createDb(connection.connectionString);
  try {
    let budgetDrift = await collectBudgetDrift(db);
    if (options.applyBalanceOnDrift && budgetDrift.driftedAgents > 0) {
      await balanceHermesTokenomics({
        dryRun: false,
        connectionString: connection.connectionString,
        homeDir,
        instanceId,
        receiptDir: options.receiptDir,
      });
      budgetDrift = await collectBudgetDrift(db);
    }

    const current = await collectWindowMetrics(db, {
      start: currentStart,
      end: currentEnd,
      highBurnThresholdTokens,
      estimatedTokensPerIdleSkip,
    });
    const baseline = await collectWindowMetrics(db, {
      start: baselineStart,
      end: baselineEnd,
      highBurnThresholdTokens,
      estimatedTokensPerIdleSkip,
    });
    const activeRunFlywheelCoverage = await collectActiveRunFlywheelCoverage(db, now);
    const minimaxCapacity = await evaluateProviderCapacity({
      target: {
        adapterType: "hermes_local",
        lane: "hermes_minimax",
        provider: "minimax",
        model: "MiniMax-M3",
        cacheKey: "hermes_local:hermes_minimax:minimax:MiniMax-M3",
      },
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
      },
      now,
    });

    const outPath = receiptFilePath(homeDir, instanceId, options.receiptDir);
    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift,
      providerCapacity: {
        minimax: minimaxCapacity,
      },
      activeRunFlywheelCoverage,
      minSavingsRatio: options.minSavingsRatio,
      minOptimizationRatio: options.minOptimizationRatio,
      minOutputGainRatio: options.minOutputGainRatio,
      highBurnThresholdTokens,
      generatedAt: now,
      receiptPath: outPath,
    });

    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(path.dirname(outPath), "latest-tokenomics-watch.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    const client = (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } }).$client;
    await client?.end?.({ timeout: 0 });
  }
}

function parseDateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): WatchOptions & { watch?: boolean; intervalSeconds?: number; samples?: number } {
  const out: WatchOptions & { watch?: boolean; intervalSeconds?: number; samples?: number } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--connection-string") out.connectionString = argv[++index];
    else if (arg === "--home") out.homeDir = argv[++index];
    else if (arg === "--instance") out.instanceId = argv[++index];
    else if (arg === "--receipt-dir") out.receiptDir = argv[++index];
    else if (arg === "--window-minutes") out.windowMinutes = Number(argv[++index]);
    else if (arg === "--baseline-hours") out.baselineHours = Number(argv[++index]);
    else if (arg === "--baseline-start") out.baselineStart = parseDateArg(argv[++index]);
    else if (arg === "--baseline-end") out.baselineEnd = parseDateArg(argv[++index]);
    else if (arg === "--now") out.now = parseDateArg(argv[++index]);
    else if (arg === "--min-savings") out.minSavingsRatio = Number(argv[++index]);
    else if (arg === "--min-optimization") out.minOptimizationRatio = Number(argv[++index]);
    else if (arg === "--min-output-gain") out.minOutputGainRatio = Number(argv[++index]);
    else if (arg === "--high-burn-tokens") out.highBurnThresholdTokens = Number(argv[++index]);
    else if (arg === "--estimated-tokens-per-idle-skip") out.estimatedTokensPerIdleSkip = Number(argv[++index]);
    else if (arg === "--apply-balance-on-drift") out.applyBalanceOnDrift = true;
    else if (arg === "--watch") out.watch = true;
    else if (arg === "--interval-seconds") out.intervalSeconds = Number(argv[++index]);
    else if (arg === "--samples") out.samples = Number(argv[++index]);
    else if (arg === "--once") out.watch = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx server/src/ops/hermes-tokenomics-watch.ts [--once|--watch] [--window-minutes <n>] [--baseline-hours <n>] [--min-output-gain <ratio>] [--apply-balance-on-drift]");
      process.exit(0);
    }
  }
  return out;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samples = options.samples === undefined
    ? (options.watch ? 0 : 1)
    : Math.max(1, options.samples);
  const intervalMs = Math.max(1, options.intervalSeconds ?? 300) * 1_000;
  let count = 0;
  do {
    const report = await runHermesTokenomicsWatch({ ...options, now: new Date() });
    console.log(JSON.stringify({
      status: report.status,
      version: report.version,
      tokenReductionRatio: report.evaluation.tokenReductionRatio,
      valuableOrSafelySkippedRatio: report.current.optimization.valuableOrSafelySkippedRatio,
      valuableOutputStatus: report.evaluation.valuableOutputStatus,
      valuableOutputGainRatio: report.evaluation.valuableOutputGainRatio,
      finalDeliverableUnits: report.current.output.finalDeliverableUnits,
      verifiedOutputUnits: report.current.output.verifiedOutputUnits,
      currentRawTokens: report.current.tokens.rawTotal,
      highBurnEvents: report.current.highBurnEvents.length,
      driftedAgents: report.budgetDrift.driftedAgents,
      minimaxCapacity: report.providerCapacity.minimax
        ? {
            status: report.providerCapacity.minimax.status,
            expiresAt: report.providerCapacity.minimax.expiresAt,
            intervalRemainingPercent: report.providerCapacity.minimax.quota?.currentIntervalRemainingPercent ?? null,
            weeklyRemainingPercent: report.providerCapacity.minimax.quota?.currentWeeklyRemainingPercent ?? null,
          }
        : null,
      receiptPath: report.receiptPath,
    }, null, 2));
    count += 1;
    if (!options.watch || (samples > 0 && count >= samples)) break;
    await delay(intervalMs);
  } while (true);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
