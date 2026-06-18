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
  createdAt: string;
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
  return Math.max(0, sample.inputTokens) + Math.max(0, sample.cachedInputTokens) + Math.max(0, sample.outputTokens);
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
    if (ledgerOutcomeIsSuccessful(entry.finalOutcome)) {
      outputUnits.add(`ledger-outcome:${entry.id}`);
      if (entry.issueId && ledgerHasArtifactEvidence(entry)) {
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
    issueBoundRuns + assignmentBacklogScans + explicitRuns + idleSkipped + providerBackoffSkipped + noNewSignalSkipped,
  );
  const rawTotal = inputTokens + cachedInputTokens + outputTokens;
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
      uncachedTotal: inputTokens + outputTokens,
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
    createdAt: row.createdAt.toISOString(),
  }));
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
