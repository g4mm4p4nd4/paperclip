import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  companySecrets,
  createDb,
  formatDatabaseBackupResult,
  issueApprovals,
  issues,
  routineTriggers,
  routines,
  runDatabaseBackup,
  type Db,
} from "@paperclipai/db";
import { buildBlockerApprovalPayload, classifyBlockerRouting } from "../services/company-vision-contract.js";

const execFileAsync = promisify(execFile);

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/unattended-factory-configuration/runs";
const DEFAULT_PORTFOLIO_OS_ROOT = "/Users/mnm/Documents/Github/portfolio-os";
const FROZEN_SELECTION_RELATIVE_PATH = "data/frozen_selection.json";
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const PORTFOLIO_DISPATCH_CONTRACT_RE = /## Portfolio Dispatch Contract\s*```json\s*([\s\S]*?)```/i;
const FACTORY_GUARD_ORIGIN_KIND = "factory_guard";
const MIGRATION_VERSION = "unattended-factory-configuration.v1";
const PORTFOLIO_OS_COMPANY_NAME = "Portfolio OS Orchestrator";
const PORTFOLIO_CONTROL_PLANE_ROUTINES = [
  "Signal Desk :: Market Sweep",
  "Signal Desk :: VOC Sweep",
  "Signal Desk :: Evidence Intake Gate",
  "Council Chamber :: Existing Venture Gate",
  "Council Chamber :: Council Triage",
  "Asset Composition Lab :: Venture Composition",
  "Venture Graduation :: Route Or Graduate",
  "Truth Boundary :: Canonical Guard",
] as const;

type JsonRecord = Record<string, unknown>;

export type FactoryActionabilityContract = {
  contractVersion: "paperclip.actionability.v1";
  lane: string;
  state: string;
  blockerOwner: string;
  nextActionOwner: string;
  blockerClass: string;
  requiredSecretNames: string[];
  upstreamArtifactHash: string | null;
  requireUpstreamChange: boolean;
  councilIdeationMandate?: string | null;
  councilEvidenceGate?: JsonRecord | null;
  councilIssuePolicy?: JsonRecord | null;
  scratchPersistence?: JsonRecord | null;
  cadenceGroup: string;
  minCadenceMinutes: number;
  minIntervalMinutes: number;
  requiresCleanWorkspace: boolean;
  requireCleanWorkspace: boolean;
  workspaceCwd: string | null;
  allowDirtyPathPrefixes: string[];
  standingIssueKey: string;
  shipCaptain: boolean;
  blockerFingerprint: string;
};

type LiveRoutineRow = {
  id: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
  projectId: string | null;
  projectName: string | null;
  goalId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  workspaceCwd: string | null;
};

export type LiveTriggerRow = {
  id: string;
  routineId: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  lastResult: string | null;
};

export type LiveStaleTriggerRow = LiveTriggerRow & {
  companyName: string;
  issuePrefix: string;
  routineTitle: string;
  routineStatus: string;
};

type LiveAgentRow = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  adapterConfig: JsonRecord;
};

type LiveIssueRow = {
  id: string;
  companyId: string;
  companyName: string;
  title: string;
  status: string;
  originId: string | null;
  originRunId: string | null;
  routineTitle: string | null;
  updatedAt: Date | string;
  executionState: JsonRecord | null;
};

type RuntimeConfig = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
    backup?: {
      dir?: string;
      retentionDays?: number;
    };
  };
};

type PlannedRoutineUpdate = {
  routine: LiveRoutineRow;
  contract: FactoryActionabilityContract;
  nextDescription: string;
  nextStatus: "active" | "paused";
  nextConcurrencyPolicy: "coalesce_if_active" | "skip_if_active" | "always_enqueue";
};

type PlannedAgentUpdate = {
  agent: LiveAgentRow;
  nextAdapterConfig: JsonRecord;
  changed: boolean;
};

export type PlannedTriggerUpdate = {
  trigger: LiveTriggerRow;
  nextEnabled: boolean;
  nextCronExpression: string | null;
  nextLabel: string | null;
  nextRunAt: Date | null | undefined;
  reason: string;
};

type WorkspaceGuardPlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  cwd: string;
  fingerprint: string;
  originId: string;
  dirtyPaths: string[];
  reason: string;
  error?: string;
};

export type LiveWorkspaceGuardIssue = {
  id: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
  identifier: string | null;
  originId: string | null;
  cwd: string | null;
  fingerprint: string | null;
};

export type WorkspaceGuardResolutionPlan = {
  issue: LiveWorkspaceGuardIssue;
  reason: "workspace_cleanliness_resolved";
};

export type LiveDuplicateLoopGuardIssue = {
  id: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
  identifier: string | null;
  originId: string | null;
};

export type DuplicateLoopGuardResolutionPlan = {
  issue: LiveDuplicateLoopGuardIssue;
  reason: "duplicate_loop_not_active";
};

type CredentialGuardPlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  missingSecretNames: string[];
  originId: string;
};

type ProviderGuardPlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  originId: string;
  degradedSignals: Array<Record<string, unknown>>;
};

type InternetPipesGapGuardPlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  originId: string;
  runId: string;
  repo: string;
  sourcePath: string;
  decisionStatus: string;
  readiness: string;
  score: number | null;
  missingStations: string[];
  recommendations: string[];
  missingEvidence: string;
};

type IssueCollapsePlan = {
  groupKey: string;
  companyId: string;
  companyName: string;
  keptIssueId: string;
  keptTitle: string;
  cancelledIssueIds: string[];
};

type GuardIssueResult = {
  originId: string;
  issueId: string;
  identifier: string | null;
  action: "created" | "reused";
};

type GuardApprovalResult = {
  approvalId: string;
  issueId: string;
  blockerFingerprint: string;
  route: string;
  action: "created" | "reused";
};

export type ConfigureFactoryOptions = {
  dryRun?: boolean;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
  portfolioOsRoot?: string;
  backup?: boolean;
  now?: Date;
};

export type ConfigureFactoryResult = {
  status: "dry_run" | "applied";
  migrationVersion: string;
  startedAt: string;
  finishedAt: string;
  connectionSource: string;
  backup: null | {
    path: string | null;
    summary: string;
  };
  freeze: {
    enabledTriggerIds: string[];
  };
  counts: {
    activeRoutinesBefore: number;
    routineContractsPlanned: number;
    routineContractsApplied: number;
    agencyRoutinesPaused: number;
    triggerUpdatesApplied: number;
    staleTriggersDisabled: number;
    workspaceBlockedTriggersDisabled: number;
    agentsExamined: number;
    agentRoutingUpdatesApplied: number;
    credentialGuards: number;
    workspaceGuards: number;
    internetPipesGapGuards: number;
    resolvedWorkspaceGuards: number;
    resolvedDuplicateLoopGuards: number;
    providerGuards: number;
    blockerApprovals: number;
    collapsedIssueGroups: number;
    cancelledDuplicateRoutineIssues: number;
  };
  planned: {
    routines: Array<{
      id: string;
      companyName: string;
      title: string;
      lane: string;
      state: string;
      requiredSecretNames: string[];
      shipCaptain: boolean;
      nextStatus: string;
      nextConcurrencyPolicy: string;
    }>;
    credentialGuards: CredentialGuardPlan[];
    workspaceGuards: WorkspaceGuardPlan[];
    internetPipesGapGuards: InternetPipesGapGuardPlan[];
    providerGuard: ProviderGuardPlan | null;
    issueCollapses: IssueCollapsePlan[];
    resolvedWorkspaceGuards: Array<{
      id: string;
      companyName: string;
      issuePrefix: string;
      identifier: string | null;
      cwd: string | null;
      fingerprint: string | null;
      reason: string;
    }>;
    resolvedDuplicateLoopGuards: Array<{
      id: string;
      companyName: string;
      issuePrefix: string;
      identifier: string | null;
      originId: string | null;
      reason: string;
    }>;
    staleTriggers: Array<{
      id: string;
      companyName: string;
      issuePrefix: string;
      routineTitle: string;
      routineStatus: string;
      reason: string;
    }>;
  };
  applied: {
    guardIssues: GuardIssueResult[];
    guardApprovals: GuardApprovalResult[];
    receiptPath: string | null;
  };
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringList(value: unknown, separator: RegExp = /\|/): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
  }
  const raw = readString(value);
  if (!raw) return [];
  return raw.split(separator).map((item) => item.trim()).filter(Boolean);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "factory";
}

function originSafe(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").replace(/-+/g, "-").slice(0, 180);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function shortSha(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

export function routineFamilyTitle(title: string) {
  return title.replace(/^\[run_id:[^\]]+\]\s*/i, "").trim();
}

function runIdFromText(value: string | null | undefined) {
  const match = value?.match(/\[run_id:([^\]]+)\]/i) ?? value?.match(/\brun [`"]?([0-9T]{8,}Z)\b/i);
  return match?.[1] ?? null;
}

export function extractPortfolioDispatchContract(description: string | null | undefined): JsonRecord {
  const match = description?.match(PORTFOLIO_DISPATCH_CONTRACT_RE);
  if (!match?.[1]) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function upsertActionabilityContract(
  description: string | null | undefined,
  contract: FactoryActionabilityContract,
) {
  const current = description?.trimEnd() ?? "";
  const existing = extractPortfolioDispatchContract(current);
  const nextMetadata = {
    ...existing,
    paperclip_actionability: contract,
  };
  const block = [
    "## Portfolio Dispatch Contract",
    "```json",
    JSON.stringify(nextMetadata, null, 2),
    "```",
  ].join("\n");
  if (PORTFOLIO_DISPATCH_CONTRACT_RE.test(current)) {
    return current.replace(PORTFOLIO_DISPATCH_CONTRACT_RE, block);
  }
  return [current, "", block].filter((part) => part.length > 0).join("\n");
}

const COUNCIL_IDEATION_MANDATE_RE = /## Council Ideation Mandate[\s\S]*?(?=\n## |\s*$)/i;

function upsertCouncilIdeationMandate(
  description: string,
  routine: LiveRoutineRow,
  contract: FactoryActionabilityContract,
) {
  if (!isPortfolioControlPlaneRoutine(routine.companyName, routine.title)) return description;
  if (contract.blockerClass !== "council_triage") return description;
  const mandate = [
    "## Council Ideation Mandate",
    "",
    "Every council pass must evaluate repository potential as products, reskins, standalone offers, and combined solutions.",
    "Create separate child issues immediately for distinct hypotheses so competing council theses can run in parallel without overwriting one another.",
    "Return a ranked set of venture hypotheses with target buyer, revenue mechanism, wedge, evidence gaps, cheapest validation step, and whether the next action is evidence backfill, composition, graduation, pilot build, distribution, or kill.",
    "Score each hypothesis out of 100: VOC signal 25, market size and trajectory 20, repo feasibility 20, competitive gap 20, council confidence 15.",
    "Promote a hypothesis into build or go-to-market execution only at score >= 70 and only when buyer/user, revenue mechanism, first tangible deliverable, cheapest validation step, and duplicate-hypothesis check are present.",
    "Below the threshold, create validation/research child issues rather than build issues; at or above the threshold, create concrete Paperclip/Hermes execution tasks.",
    "Persist scratch output in the Paperclip issue document key `council-hypothesis-ledger` and mirror durable copies under Portfolio OS `data/council_hypotheses/paperclip/`.",
    "Do not wait for a perfect launch target before ideating; use the current frozen selection, repo memory, and company goals to close the gap to go-live.",
  ].join("\n");
  if (COUNCIL_IDEATION_MANDATE_RE.test(description)) {
    return description.replace(COUNCIL_IDEATION_MANDATE_RE, mandate);
  }
  return [description.trimEnd(), "", mandate].filter((part) => part.length > 0).join("\n");
}

function existingUpstreamHash(routine: LiveRoutineRow) {
  const metadata = extractPortfolioDispatchContract(routine.description);
  const dispatchHash = readString(metadata.dispatch_hash);
  const selectionHash = readString(metadata.selection_snapshot_hash);
  return [dispatchHash, selectionHash].filter(Boolean).join(":") || null;
}

function baseHashForRoutine(routine: LiveRoutineRow, lane: string, blockerClass: string) {
  return existingUpstreamHash(routine) ?? `factory:${shortSha({
    companyId: routine.companyId,
    projectId: routine.projectId,
    routineId: routine.id,
    title: routine.title,
    lane,
    blockerClass,
  })}`;
}

function inferRoutineLane(routine: LiveRoutineRow): {
  lane: string;
  state: string;
  blockerOwner: string;
  nextActionOwner: string;
  blockerClass: string;
  cadenceGroup: string;
  minCadenceMinutes: number;
  requiresUpstreamChange: boolean;
  requiresCleanWorkspace: boolean;
  requiredSecretNames: string[];
  shipCaptain: boolean;
  nextStatus: "active" | "paused";
} {
  const title = routine.title.toLowerCase();
  const company = routine.companyName.toLowerCase();
  const family = routineFamilyTitle(routine.title).toLowerCase();

  if (company.includes("agency-swarm")) {
    return {
      lane: "maintenance",
      state: "waiting_for_human_credential",
      blockerOwner: "board",
      nextActionOwner: "board",
      blockerClass: "execution_mandate",
      cadenceGroup: "maintenance",
      minCadenceMinutes: 1440,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: false,
      requiredSecretNames: [],
      shipCaptain: false,
      nextStatus: "paused",
    };
  }

  if (title.includes("operating contract") || title.includes("skill inventory") || title.includes("truth boundary")) {
    return {
      lane: "maintenance",
      state: "maintenance_due",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: title.includes("skill") ? "skill_sync" : "governance_drift",
      cadenceGroup: "maintenance",
      minCadenceMinutes: 720,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: false,
      requiredSecretNames: [],
      shipCaptain: false,
      nextStatus: "active",
    };
  }

  if (family.includes("release gate") || title.includes("release readiness")) {
    return {
      lane: "release",
      state: "ready_to_ship",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: family.includes("release gate") ? "release_gate" : "release_readiness",
      cadenceGroup: "release",
      minCadenceMinutes: 120,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: true,
      requiredSecretNames: company.includes("leadforge") ? ["FLY_API_TOKEN"] : [],
      shipCaptain: true,
      nextStatus: "active",
    };
  }

  if (family.includes("run qa") || title.includes("qa gate")) {
    return {
      lane: "qa",
      state: "ready_for_qa",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: "qa_gate",
      cadenceGroup: "release",
      minCadenceMinutes: 240,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: true,
      requiredSecretNames: [],
      shipCaptain: false,
      nextStatus: "active",
    };
  }

  if (family.includes("dispatch poller")) {
    return {
      lane: "release",
      state: "ready_for_agent",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: "dispatch_parity",
      cadenceGroup: "release",
      minCadenceMinutes: 30,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: false,
      requiredSecretNames: [],
      shipCaptain: false,
      nextStatus: "active",
    };
  }

  if (family.includes("evidence") || family.includes("distribution")) {
    const portfolioResearchBoundary = company.includes("portfolio os orchestrator");
    return {
      lane: company.includes("yt-synth") ? "distribution" : "evidence",
      state: "ready_for_agent",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: company.includes("yt-synth")
        ? "distribution_credentials"
        : portfolioResearchBoundary
          ? "research_boundary"
          : "evidence_backfill",
      cadenceGroup: company.includes("yt-synth") ? "product" : "maintenance",
      minCadenceMinutes: company.includes("yt-synth") ? 480 : 720,
      requiresUpstreamChange: true,
      requiresCleanWorkspace: portfolioResearchBoundary,
      requiredSecretNames: company.includes("yt-synth")
        ? ["YT_SYNTH_EMAIL_CREDENTIALS", "YT_SYNTH_SOCIAL_CREDENTIALS"]
        : [],
      shipCaptain: false,
      nextStatus: "active",
    };
  }

  return {
    lane: title.includes("market") || title.includes("voc") || title.includes("evidence")
      ? "evidence"
      : "product_execution",
    state: "ready_for_agent",
    blockerOwner: "agent",
    nextActionOwner: "agent",
    blockerClass: title.includes("council")
      ? "council_triage"
      : title.includes("graduation")
        ? "graduation"
        : "product_execution",
    cadenceGroup: "product",
    minCadenceMinutes: title.includes("council") ? 720 : 240,
    requiresUpstreamChange: !title.includes("council"),
    requiresCleanWorkspace: false,
    requiredSecretNames: [],
    shipCaptain: false,
    nextStatus: "active",
  };
}

export function isPortfolioControlPlaneRoutine(companyName: string, title: string) {
  return companyName === PORTFOLIO_OS_COMPANY_NAME
    && (PORTFOLIO_CONTROL_PLANE_ROUTINES as readonly string[]).includes(title);
}

function councilEvidenceGateForContract(blockerClass: string) {
  if (blockerClass !== "council_triage") return null;
  return {
    promoteScoreThreshold: 70,
    scoring: {
      vocSignal: 25,
      marketSizeAndTrajectory: 20,
      repoFeasibility: 20,
      competitiveGap: 20,
      councilConfidence: 15,
    },
    hardGates: [
      "buyer_or_user_identified",
      "revenue_mechanism_identified",
      "first_tangible_deliverable_identified",
      "cheapest_validation_step_identified",
      "duplicate_hypothesis_check_completed",
    ],
    belowThresholdAction: "create_research_or_validation_child_issue",
    atOrAboveThresholdAction: "create_concrete_paperclip_or_hermes_execution_child_issue",
  };
}

function councilIssuePolicyForContract(blockerClass: string) {
  if (blockerClass !== "council_triage") return null;
  return {
    centralOwner: PORTFOLIO_OS_COMPANY_NAME,
    dispatchModel: "central_council_dispatches_into_companies",
    createSeparateChildIssuesImmediately: true,
    allowParallelCompetingHypotheses: true,
    wakeCommentReassignExistingIssues: true,
    duplicateHypothesisCheckRequired: true,
  };
}

function scratchPersistenceForContract(blockerClass: string) {
  if (blockerClass !== "council_triage") return null;
  return {
    primaryStore: "paperclip_issue_document",
    paperclipIssueDocumentKey: "council-hypothesis-ledger",
    backupCoveredBy: "paperclip_database_backup",
    portfolioOsMirrorRoot: "data/council_hypotheses/paperclip",
    mirrorPurpose: "durable Portfolio OS recovery copy for scratch ideation when canonical dispatch writes are blocked",
  };
}

export function routineConcurrencyPolicyForContract(
  routine: LiveRoutineRow,
  contract: FactoryActionabilityContract,
): "coalesce_if_active" | "skip_if_active" | "always_enqueue" {
  if (
    isPortfolioControlPlaneRoutine(routine.companyName, routine.title) &&
    contract.blockerClass === "council_triage"
  ) {
    return "always_enqueue";
  }
  return "coalesce_if_active";
}

export function deriveRoutineActionabilityContract(routine: LiveRoutineRow): {
  contract: FactoryActionabilityContract;
  nextStatus: "active" | "paused";
} {
  const inferred = inferRoutineLane(routine);
  const runId = runIdFromText(routine.title) ?? runIdFromText(routine.projectName);
  const upstreamArtifactHash = baseHashForRoutine(routine, inferred.lane, inferred.blockerClass);
  const councilEvidenceGate = councilEvidenceGateForContract(inferred.blockerClass);
  const councilIssuePolicy = councilIssuePolicyForContract(inferred.blockerClass);
  const scratchPersistence = scratchPersistenceForContract(inferred.blockerClass);
  const standingIssueKey = [
    "factory",
    slug(routine.companyName),
    runId ? `run-${runId.toLowerCase()}` : null,
    inferred.lane,
    inferred.blockerClass,
  ].filter(Boolean).join(":");
  const contract: FactoryActionabilityContract = {
    contractVersion: "paperclip.actionability.v1",
    lane: inferred.lane,
    state: inferred.state,
    blockerOwner: inferred.blockerOwner,
    nextActionOwner: inferred.nextActionOwner,
    blockerClass: inferred.blockerClass,
    requiredSecretNames: inferred.requiredSecretNames,
    upstreamArtifactHash,
    requireUpstreamChange: inferred.requiresUpstreamChange,
    councilIdeationMandate: inferred.blockerClass === "council_triage"
      ? "Evaluate repositories as products, reskins, standalone offers, and combined solutions; create child issues for distinct hypotheses; promote only score >= 70 with hard gates satisfied."
      : null,
    councilEvidenceGate,
    councilIssuePolicy,
    scratchPersistence,
    cadenceGroup: inferred.cadenceGroup,
    minCadenceMinutes: inferred.minCadenceMinutes,
    minIntervalMinutes: inferred.minCadenceMinutes,
    requiresCleanWorkspace: inferred.requiresCleanWorkspace,
    requireCleanWorkspace: inferred.requiresCleanWorkspace,
    workspaceCwd: inferred.requiresCleanWorkspace ? routine.workspaceCwd : null,
    allowDirtyPathPrefixes: [],
    standingIssueKey,
    shipCaptain: inferred.shipCaptain,
    blockerFingerprint: [runId, inferred.lane, inferred.blockerClass, upstreamArtifactHash]
      .filter(Boolean)
      .join(":"),
  };
  return { contract, nextStatus: inferred.nextStatus };
}

function isOpenCodeGoLikeModel(model: string | null) {
  return Boolean(model && /^(deepseek|kimi|qwen|glm|minimax|mimo|hy3)/i.test(model));
}

export function normalizeAgentConfigForFactoryRouting(agent: Pick<LiveAgentRow, "adapterType" | "adapterConfig">) {
  const current = { ...(agent.adapterConfig ?? {}) };
  if (!["hermes_local", "opencode_local"].includes(agent.adapterType)) {
    return { nextAdapterConfig: current, changed: false };
  }
  const model = readString(current.model);
  const next: JsonRecord = { ...current };
  delete next.quotaMode;
  if (agent.adapterType === "hermes_local" && isOpenCodeGoLikeModel(model)) {
    next.provider = "opencode-go";
  }
  if (agent.adapterType === "opencode_local" && isOpenCodeGoLikeModel(model) && !model?.startsWith("opencode-go/")) {
    next.model = `opencode-go/${model}`;
  }
  next.disableFallbackModel = true;
  next.tieredExecution = {
    ...isRecord(current.tieredExecution) ? current.tieredExecution : {},
    enabled: true,
    minimaxPrimary: true,
    adapterOrder: ["hermes_minimax"],
    approvePostMiniMaxFallback: false,
    approvedPostMiniMaxFallback: false,
    allowPostMiniMaxFallbacks: false,
    approvePaidSubscriptionFallback: false,
    approvedPaidSubscriptionFallback: false,
    allowPaidSubscriptionFallbacks: false,
    hermes_minimax: {
      ...isRecord(isRecord(current.tieredExecution) ? current.tieredExecution.hermes_minimax : null)
        ? (current.tieredExecution as JsonRecord).hermes_minimax as JsonRecord
        : {},
      provider: "minimax",
      model: readString(isRecord(current.tieredExecution) && isRecord(current.tieredExecution.hermes_minimax)
        ? current.tieredExecution.hermes_minimax.model
        : null) ?? "MiniMax-M3",
    },
  };
  return {
    nextAdapterConfig: next,
    changed: stableJson(next) !== stableJson(current),
  };
}

function classifyTriggerUpdate(
  trigger: LiveTriggerRow,
  routineUpdate: PlannedRoutineUpdate,
  triggerIndexForRoutine: number,
  now: Date,
  workspaceBlocked: boolean,
): PlannedTriggerUpdate {
  const contract = routineUpdate.contract;
  if (workspaceBlocked) {
    return {
      trigger,
      nextEnabled: false,
      nextCronExpression: trigger.cronExpression,
      nextLabel: trigger.label,
      nextRunAt: null,
      reason: "workspace_dirty_guard_active",
    };
  }
  if (routineUpdate.nextStatus === "paused") {
    return {
      trigger,
      nextEnabled: false,
      nextCronExpression: trigger.cronExpression,
      nextLabel: trigger.label,
      nextRunAt: null,
      reason: "routine_paused_no_approved_execution_mandate",
    };
  }
  if (trigger.kind === "schedule" && trigger.lastResult?.startsWith("non_active_routine_trigger_disabled:")) {
    return {
      trigger,
      nextEnabled: true,
      nextCronExpression: trigger.cronExpression,
      nextLabel: trigger.label,
      nextRunAt: new Date(now.getTime() + contract.minIntervalMinutes * 60 * 1000),
      reason: "control_plane_routine_resumed_trigger_restored",
    };
  }
  if (["maintenance", "governance"].includes(contract.lane)) {
    const keepPrimarySchedule = trigger.kind === "schedule" && triggerIndexForRoutine === 0;
    return {
      trigger,
      nextEnabled: keepPrimarySchedule,
      nextCronExpression: keepPrimarySchedule ? "17 */12 * * *" : trigger.cronExpression,
      nextLabel: keepPrimarySchedule ? "Every 12 hours (factory maintenance cadence)" : trigger.label,
      nextRunAt: keepPrimarySchedule ? new Date(now.getTime() + 12 * 60 * 60 * 1000) : null,
      reason: keepPrimarySchedule ? "lower_frequency_maintenance_cadence" : "duplicate_maintenance_trigger_disabled",
    };
  }
  if (trigger.lastResult === "workspace_dirty_guard_active" && trigger.kind === "schedule") {
    return {
      trigger,
      nextEnabled: true,
      nextCronExpression: trigger.cronExpression,
      nextLabel: trigger.label,
      nextRunAt: new Date(now.getTime() + contract.minIntervalMinutes * 60 * 1000),
      reason: "workspace_guard_cleared_trigger_restored",
    };
  }
  return {
    trigger,
    nextEnabled: trigger.enabled,
    nextCronExpression: trigger.cronExpression,
    nextLabel: trigger.label,
    nextRunAt: undefined,
    reason: "preserve_execution_trigger",
  };
}

export function classifyStaleTriggerUpdate(trigger: LiveStaleTriggerRow): PlannedTriggerUpdate {
  return {
    trigger,
    nextEnabled: false,
    nextCronExpression: trigger.cronExpression,
    nextLabel: trigger.label,
    nextRunAt: null,
    reason: `non_active_routine_trigger_disabled:${trigger.routineStatus}`,
  };
}

async function classifyWorkspaceCleanliness(cwd: string) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    const dirtyPaths = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const rawPath = line.slice(3).trim();
        return rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
      })
      .map((dirtyPath) => dirtyPath.replace(/^"|"$/g, ""));
    return { ok: dirtyPaths.length === 0, dirtyPaths, reason: dirtyPaths.length === 0 ? "workspace_clean" : "workspace_dirty" };
  } catch (error) {
    return {
      ok: false,
      dirtyPaths: [] as string[],
      reason: "workspace_status_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildFactoryGuardDescription(input: {
  message: string;
  reason: string;
  state: string;
  blockerOwner: string;
  fingerprint: string;
  details?: JsonRecord;
}) {
  return [
    input.message,
    "",
    "## Factory Guard",
    `- Reason: \`${input.reason}\``,
    `- State: \`${input.state}\``,
    `- Owner: \`${input.blockerOwner}\``,
    `- Fingerprint: \`${input.fingerprint}\``,
    input.details ? ["", "```json", JSON.stringify(input.details, null, 2), "```"].join("\n") : "",
  ].filter(Boolean).join("\n");
}

async function collectActiveRoutines(db: Db): Promise<LiveRoutineRow[]> {
  const result = await db.execute(sql`
    select
      r.id,
      r.company_id as "companyId",
      c.name as "companyName",
      c.issue_prefix as "issuePrefix",
      r.project_id as "projectId",
      p.name as "projectName",
      r.goal_id as "goalId",
      r.title,
      r.description,
      r.status,
      r.priority,
      r.concurrency_policy as "concurrencyPolicy",
      r.catch_up_policy as "catchUpPolicy",
      pw.cwd as "workspaceCwd"
    from routines r
    join companies c on c.id = r.company_id
    left join projects p on p.id = r.project_id
    left join lateral (
      select cwd
      from project_workspaces
      where project_id = r.project_id and company_id = r.company_id
      order by is_primary desc, created_at asc, id asc
      limit 1
    ) pw on true
    where r.status = 'active'
      or (
        c.name = 'Portfolio OS Orchestrator'
        and r.status = 'paused'
        and r.title in (
          'Signal Desk :: Market Sweep',
          'Signal Desk :: VOC Sweep',
          'Signal Desk :: Evidence Intake Gate',
          'Council Chamber :: Existing Venture Gate',
          'Council Chamber :: Council Triage',
          'Asset Composition Lab :: Venture Composition',
          'Venture Graduation :: Route Or Graduate',
          'Truth Boundary :: Canonical Guard'
        )
      )
    order by c.name asc, r.title asc
  `);
  return rows<LiveRoutineRow>(result);
}

async function collectTriggers(db: Db, routineIds: string[]): Promise<LiveTriggerRow[]> {
  if (routineIds.length === 0) return [];
  return db
    .select({
      id: routineTriggers.id,
      routineId: routineTriggers.routineId,
      kind: routineTriggers.kind,
      label: routineTriggers.label,
      enabled: routineTriggers.enabled,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      lastResult: routineTriggers.lastResult,
    })
    .from(routineTriggers)
    .where(inArray(routineTriggers.routineId, routineIds))
    .orderBy(asc(routineTriggers.routineId), asc(routineTriggers.kind), asc(routineTriggers.createdAt), asc(routineTriggers.id));
}

async function collectEnabledTriggersForNonActiveRoutines(db: Db): Promise<LiveStaleTriggerRow[]> {
  const result = await db.execute(sql`
    select
      rt.id,
      rt.routine_id as "routineId",
      rt.kind,
      rt.label,
      rt.enabled,
      rt.cron_expression as "cronExpression",
      rt.timezone,
      rt.last_result as "lastResult",
      c.name as "companyName",
      c.issue_prefix as "issuePrefix",
      r.title as "routineTitle",
      r.status as "routineStatus"
    from routine_triggers rt
    join routines r on r.id = rt.routine_id
    join companies c on c.id = r.company_id
    where rt.enabled = true
      and r.status <> 'active'
      and not (
        c.name = 'Portfolio OS Orchestrator'
        and r.status = 'paused'
        and r.title in (
          'Signal Desk :: Market Sweep',
          'Signal Desk :: VOC Sweep',
          'Signal Desk :: Evidence Intake Gate',
          'Council Chamber :: Existing Venture Gate',
          'Council Chamber :: Council Triage',
          'Asset Composition Lab :: Venture Composition',
          'Venture Graduation :: Route Or Graduate',
          'Truth Boundary :: Canonical Guard'
        )
      )
    order by c.name asc, r.title asc, rt.created_at asc, rt.id asc
  `);
  return rows<LiveStaleTriggerRow>(result);
}

async function collectOpenWorkspaceGuardIssues(db: Db): Promise<LiveWorkspaceGuardIssue[]> {
  const result = await db.execute(sql`
    select
      i.id,
      i.company_id as "companyId",
      c.name as "companyName",
      c.issue_prefix as "issuePrefix",
      i.identifier,
      i.origin_id as "originId",
      i.execution_state #>> '{paperclipFactoryGuard,cwd}' as cwd,
      i.execution_state #>> '{paperclipFactoryGuard,fingerprint}' as fingerprint
    from issues i
    join companies c on c.id = i.company_id
    where i.origin_kind = ${FACTORY_GUARD_ORIGIN_KIND}
      and i.hidden_at is null
      and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
      and i.execution_state #>> '{paperclipFactoryGuard,reason}' = 'workspace_not_clean'
      and i.execution_state #>> '{paperclipFactoryGuard,blockerClass}' = 'workspace_cleanliness'
    order by c.name asc, i.updated_at desc, i.id asc
  `);
  return rows<LiveWorkspaceGuardIssue>(result);
}

async function collectOpenDuplicateLoopGuardIssues(db: Db): Promise<LiveDuplicateLoopGuardIssue[]> {
  const result = await db.execute(sql`
    select
      i.id,
      i.company_id as "companyId",
      c.name as "companyName",
      c.issue_prefix as "issuePrefix",
      i.identifier,
      i.origin_id as "originId"
    from issues i
    join companies c on c.id = i.company_id
    where i.origin_kind = ${FACTORY_GUARD_ORIGIN_KIND}
      and i.hidden_at is null
      and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
      and i.execution_state #>> '{paperclipFactoryGuard,reason}' = 'duplicate_loop_suppressed'
    order by c.name asc, i.updated_at desc, i.id asc
  `);
  return rows<LiveDuplicateLoopGuardIssue>(result);
}

export function planResolvedWorkspaceGuardIssues(
  openWorkspaceGuards: LiveWorkspaceGuardIssue[],
  activeWorkspaceGuardFingerprints: Set<string>,
): WorkspaceGuardResolutionPlan[] {
  return openWorkspaceGuards
    .filter((issue) => issue.fingerprint && !activeWorkspaceGuardFingerprints.has(issue.fingerprint))
    .map((issue) => ({ issue, reason: "workspace_cleanliness_resolved" }));
}

export function planResolvedDuplicateLoopGuardIssues(
  openDuplicateLoopGuards: LiveDuplicateLoopGuardIssue[],
  activeDuplicateLoopOrigins: Set<string>,
): DuplicateLoopGuardResolutionPlan[] {
  return openDuplicateLoopGuards
    .filter((issue) => !issue.originId || !activeDuplicateLoopOrigins.has(issue.originId))
    .map((issue) => ({ issue, reason: "duplicate_loop_not_active" }));
}

async function collectAgents(db: Db): Promise<LiveAgentRow[]> {
  const result = await db.execute(sql`
    select
      a.id,
      a.company_id as "companyId",
      c.name as "companyName",
      a.name,
      a.role,
      a.status,
      a.adapter_type as "adapterType",
      a.adapter_config as "adapterConfig"
    from agents a
    join companies c on c.id = a.company_id
    where a.status <> 'terminated'
    order by c.name asc, a.name asc
  `);
  return rows<LiveAgentRow>(result);
}

async function collectOpenRoutineIssues(db: Db): Promise<LiveIssueRow[]> {
  const result = await db.execute(sql`
    select
      i.id,
      i.company_id as "companyId",
      c.name as "companyName",
      i.title,
      i.status,
      i.origin_id as "originId",
      i.origin_run_id as "originRunId",
      r.title as "routineTitle",
      i.updated_at as "updatedAt",
      i.execution_state as "executionState"
    from issues i
    join companies c on c.id = i.company_id
    left join routines r on r.id::text = i.origin_id and r.company_id = i.company_id
    where i.origin_kind = 'routine_execution'
      and i.hidden_at is null
      and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
    order by i.company_id asc, i.updated_at desc, i.id asc
  `);
  return rows<LiveIssueRow>(result);
}

function planIssueCollapse(issueRows: LiveIssueRow[]): IssueCollapsePlan[] {
  const groups = new Map<string, LiveIssueRow[]>();
  for (const issue of issueRows) {
    const titleSource = issue.routineTitle ?? issue.title;
    const runId = runIdFromText(titleSource) ?? runIdFromText(issue.title) ?? issue.originRunId ?? "unscoped";
    const family = routineFamilyTitle(titleSource || issue.title).toLowerCase();
    const groupKey = `${issue.companyId}:${runId}:${family}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), issue]);
  }
  const plans: IssueCollapsePlan[] = [];
  for (const [groupKey, group] of groups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const delta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return delta || a.id.localeCompare(b.id);
    });
    const kept = ordered[0];
    const cancelledIssueIds = ordered.slice(1).map((issue) => issue.id);
    if (cancelledIssueIds.length > 0) {
      plans.push({
        groupKey,
        companyId: kept.companyId,
        companyName: kept.companyName,
        keptIssueId: kept.id,
        keptTitle: kept.title,
        cancelledIssueIds,
      });
    }
  }
  return plans;
}

async function missingSecretNames(db: Db, companyId: string, secretNames: string[]) {
  const names = [...new Set(secretNames)].sort();
  if (names.length === 0) return [];
  const existing = await db
    .select({ name: companySecrets.name })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.name, names)));
  const existingNames = new Set(existing.map((entry) => entry.name));
  return names.filter((name) => !existingNames.has(name));
}

async function collectProviderDegradedSignals(db: Db) {
  const result = await db.execute(sql`
    select *
    from (
      select
        c.id as "companyId",
        c.name as "companyName",
        'heartbeat_runs' as source,
        h.error_code as reason,
        count(*)::int as count,
        max(h.created_at) as "latestAt"
      from heartbeat_runs h
      join companies c on c.id = h.company_id
      where h.created_at > now() - interval '48 hours'
        and (
          h.error_code ilike '%provider%'
          or h.error ilike '%quota%'
          or h.error ilike '%provider%'
          or h.stderr_excerpt ilike '%quota%'
          or h.stderr_excerpt ilike '%usage limit%'
          or h.stderr_excerpt ilike '%insufficient balance%'
        )
      group by c.id, c.name, h.error_code
      union all
      select
        c.id as "companyId",
        c.name as "companyName",
        'agent_wakeup_requests' as source,
        w.reason as reason,
        count(*)::int as count,
        max(w.requested_at) as "latestAt"
      from agent_wakeup_requests w
      join companies c on c.id = w.company_id
      where w.requested_at > now() - interval '48 hours'
        and (
          w.reason ilike '%provider%'
          or w.error ilike '%quota%'
          or w.error ilike '%provider%'
          or w.error ilike '%usage limit%'
        )
      group by c.id, c.name, w.reason
    ) degraded
    order by "latestAt" desc
  `);
  return rows<Record<string, unknown>>(result);
}

async function collectCompanyRows(db: Db) {
  const result = await db.execute(sql`
    select id, name, issue_prefix as "issuePrefix"
    from companies
    order by name asc
  `);
  return rows<{ id: string; name: string; issuePrefix: string }>(result);
}

export async function planInternetPipesGapGuard(input: {
  portfolioCompany: { id: string; name: string; issuePrefix: string } | undefined;
  portfolioOsRoot: string;
}): Promise<InternetPipesGapGuardPlan | null> {
  if (!input.portfolioCompany) return null;
  const sourcePath = path.join(input.portfolioOsRoot, FROZEN_SELECTION_RELATIVE_PATH);
  let payload: JsonRecord;
  try {
    const raw = await readFile(sourcePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    payload = parsed;
  } catch {
    return null;
  }

  const target = isRecord(payload.research_target)
    ? payload.research_target
    : isRecord(payload.launch_target)
      ? payload.launch_target
      : isRecord(payload.execution_candidate)
        ? payload.execution_candidate
        : isRecord(payload.business_choice)
          ? payload.business_choice
          : null;
  if (!target) return null;

  const readiness = readString(target.internet_pipes_readiness) ?? "";
  const missingStations = readStringList(target.internet_pipes_missing_stations, /[|,]/);
  const dispatchReady = readiness === "alpha_ready" || readiness === "factory_ready";
  if (dispatchReady && missingStations.length === 0) return null;

  const repo = readString(target.repo) ?? readString(payload.repo) ?? "";
  if (!repo) return null;
  const runId = readString(payload.run_id) ?? readString(target.run_id) ?? "unscoped";
  const stationKey = missingStations.length > 0 ? missingStations.join("+") : readiness || "unscored";
  const fingerprint = `internet_pipes:${repo}:${runId}:${stationKey}`;
  return {
    companyId: input.portfolioCompany.id,
    companyName: input.portfolioCompany.name,
    issuePrefix: input.portfolioCompany.issuePrefix,
    originId: originSafe(`internet_pipes_gap:${fingerprint}`),
    runId,
    repo,
    sourcePath,
    decisionStatus: readString(payload.decision_status) ?? readString(target.decision_status) ?? "",
    readiness,
    score: readNumber(target.internet_pipes_score),
    missingStations,
    recommendations: readStringList(target.internet_pipes_recommendations),
    missingEvidence: readString(target.missing_evidence) ?? readString(payload.missing_evidence) ?? "",
  };
}

async function ensureFactoryGuardIssue(
  tx: Db,
  input: {
    companyId: string;
    issuePrefix: string;
    originId: string;
    title: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
    executionState: JsonRecord;
  },
): Promise<GuardIssueResult> {
  const existing = await tx
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.originKind, FACTORY_GUARD_ORIGIN_KIND),
      eq(issues.originId, input.originId),
      inArray(issues.status, OPEN_ISSUE_STATUSES),
      isNull(issues.hiddenAt),
    ))
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(1)
    .then((existingRows) => existingRows[0] ?? null);
  if (existing) {
    await tx
      .update(issues)
      .set({
        title: input.title,
        description: input.description,
        priority: input.priority,
        executionState: input.executionState,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, existing.id));
    return { originId: input.originId, issueId: existing.id, identifier: existing.identifier, action: "reused" };
  }

  const [counter] = await tx
    .update(companies)
    .set({
      issueCounter: sql`${companies.issueCounter} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, input.companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });
  const issueNumber = counter.issueCounter;
  const identifier = `${counter.issuePrefix ?? input.issuePrefix}-${issueNumber}`;
  const id = randomUUID();
  await tx.insert(issues).values({
    id,
    companyId: input.companyId,
    title: input.title,
    description: input.description,
    status: "blocked",
    priority: input.priority,
    assigneeAgentId: null,
    originKind: FACTORY_GUARD_ORIGIN_KIND,
    originId: input.originId,
    issueNumber,
    identifier,
    executionState: input.executionState,
  });
  return { originId: input.originId, issueId: id, identifier, action: "created" };
}

async function ensureFactoryGuardApproval(
  tx: Db,
  input: {
    companyId: string;
    companyName: string;
    issueId: string;
    issueIdentifier?: string | null;
    title: string;
    blockerClass: string;
    blockerFingerprint: string;
    requiredSecretNames?: string[];
    details?: JsonRecord;
  },
): Promise<GuardApprovalResult | null> {
  const routing = classifyBlockerRouting({
    blockerClass: input.blockerClass,
    text: input.title,
    requiredSecretNames: input.requiredSecretNames,
  });
  if (!routing.approvalRequired) return null;

  const payload = buildBlockerApprovalPayload({
    title: input.title,
    companyName: input.companyName,
    issueIdentifier: input.issueIdentifier ?? null,
    blockerFingerprint: input.blockerFingerprint,
    routing,
    details: input.details,
  });

  const existingRows = await tx
    .select({ id: approvals.id, payload: approvals.payload })
    .from(approvals)
    .where(and(
      eq(approvals.companyId, input.companyId),
      eq(approvals.type, "factory_blocker_routing"),
      inArray(approvals.status, ["pending", "revision_requested"]),
    ))
    .orderBy(desc(approvals.updatedAt), desc(approvals.createdAt))
    .limit(100);
  const existing = existingRows.find(
    (row) => readString(isRecord(row.payload) ? row.payload.blockerFingerprint : null) === input.blockerFingerprint,
  );
  const action: GuardApprovalResult["action"] = existing ? "reused" : "created";
  let approvalId = existing?.id ?? null;
  if (!approvalId) {
    const [created] = await tx
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: "factory_blocker_routing",
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
        payload,
      })
      .returning({ id: approvals.id });
    if (!created?.id) throw new Error("Failed to create factory blocker approval");
    approvalId = created.id;
  }

  await tx
    .insert(issueApprovals)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      approvalId,
      linkedByAgentId: null,
      linkedByUserId: null,
    })
    .onConflictDoNothing();

  return {
    approvalId,
    issueId: input.issueId,
    blockerFingerprint: input.blockerFingerprint,
    route: routing.route,
    action,
  };
}

function expandHome(raw: string) {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

async function readConfig(homeDir: string, instanceId: string): Promise<RuntimeConfig> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed as RuntimeConfig : {};
  } catch {
    return {};
  }
}

function resolveConnectionString(config: RuntimeConfig, explicit?: string) {
  if (explicit) return { connectionString: explicit, source: "explicit" };
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

function resolveBackupDir(homeDir: string, instanceId: string, config: RuntimeConfig) {
  const configured = config.database?.backup?.dir?.trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(homeDir, "instances", instanceId, "data", "backups");
}

function receiptPathFor(options: Required<Pick<ConfigureFactoryOptions, "homeDir" | "instanceId" | "receiptDir">>, now: Date) {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z");
  return path.join(options.homeDir, "instances", options.instanceId, options.receiptDir, `${stamp}.json`);
}

export async function configureUnattendedFactory(
  db: Db,
  options: ConfigureFactoryOptions = {},
): Promise<ConfigureFactoryResult> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const dryRun = options.dryRun === true;
  const homeDir = path.resolve(options.homeDir ?? DEFAULT_HOME);
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const receiptDir = options.receiptDir ?? DEFAULT_RECEIPT_DIR;
  const portfolioOsRoot = path.resolve(options.portfolioOsRoot ?? process.env.PORTFOLIO_OS_ROOT ?? DEFAULT_PORTFOLIO_OS_ROOT);
  const config = await readConfig(homeDir, instanceId);
  const { connectionString, source: connectionSource } = resolveConnectionString(config, options.connectionString);

  const activeRoutines = await collectActiveRoutines(db);
  const routineIds = activeRoutines.map((routine) => routine.id);
  const triggers = await collectTriggers(db, routineIds);
  const triggersByRoutine = new Map<string, LiveTriggerRow[]>();
  for (const trigger of triggers) {
    triggersByRoutine.set(trigger.routineId, [...(triggersByRoutine.get(trigger.routineId) ?? []), trigger]);
  }
  const staleTriggers = await collectEnabledTriggersForNonActiveRoutines(db);

  const plannedRoutines = activeRoutines.map((routine) => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine);
    const nextDescription = upsertCouncilIdeationMandate(
      upsertActionabilityContract(routine.description, contract),
      routine,
      contract,
    );
    const nextConcurrencyPolicy = routineConcurrencyPolicyForContract(routine, contract);
    return {
      routine,
      contract,
      nextStatus,
      nextConcurrencyPolicy,
      nextDescription,
    } satisfies PlannedRoutineUpdate;
  });

  const liveAgents = await collectAgents(db);
  const plannedAgents: PlannedAgentUpdate[] = liveAgents.map((agent) => ({
    agent,
    ...normalizeAgentConfigForFactoryRouting(agent),
  }));

  const credentialGuards: CredentialGuardPlan[] = [];
  const credentialGroups = new Map<string, { routine: LiveRoutineRow; names: Set<string> }>();
  for (const planned of plannedRoutines) {
    if (planned.contract.requiredSecretNames.length === 0) continue;
    const key = planned.routine.companyId;
    const group = credentialGroups.get(key) ?? { routine: planned.routine, names: new Set<string>() };
    planned.contract.requiredSecretNames.forEach((name) => group.names.add(name));
    credentialGroups.set(key, group);
  }
  for (const group of credentialGroups.values()) {
    const missing = await missingSecretNames(db, group.routine.companyId, [...group.names]);
    if (missing.length === 0) continue;
    credentialGuards.push({
      companyId: group.routine.companyId,
      companyName: group.routine.companyName,
      issuePrefix: group.routine.issuePrefix,
      missingSecretNames: missing,
      originId: originSafe(`credential:${missing.sort().join("+")}`),
    });
  }

  const workspaceGuards: WorkspaceGuardPlan[] = [];
  const workspaceInputs = new Map<string, PlannedRoutineUpdate>();
  for (const planned of plannedRoutines) {
    if (!planned.contract.requireCleanWorkspace || !planned.contract.workspaceCwd) continue;
    workspaceInputs.set(`${planned.routine.companyId}:${planned.contract.workspaceCwd}`, planned);
  }
  for (const [key, planned] of workspaceInputs) {
    const cwd = planned.contract.workspaceCwd!;
    const cleanliness = await classifyWorkspaceCleanliness(cwd);
    if (cleanliness.ok) continue;
    const fingerprint = `workspace:${shortSha({
      cwd,
      dirtyPaths: cleanliness.dirtyPaths,
      reason: cleanliness.reason,
    })}`;
    workspaceGuards.push({
      companyId: planned.routine.companyId,
      companyName: planned.routine.companyName,
      issuePrefix: planned.routine.issuePrefix,
      cwd,
      fingerprint,
      originId: originSafe(`workspace_cleanup:${fingerprint}`),
      dirtyPaths: cleanliness.dirtyPaths,
      reason: cleanliness.reason,
      ...(cleanliness.error ? { error: cleanliness.error } : {}),
    });
    void key;
  }
  const workspaceGuardKeys = new Set(workspaceGuards.map((guard) => `${guard.companyId}:${guard.cwd}`));
  const activeWorkspaceGuardFingerprints = new Set(workspaceGuards.map((guard) => guard.fingerprint));
  const plannedResolvedWorkspaceGuards = planResolvedWorkspaceGuardIssues(
    await collectOpenWorkspaceGuardIssues(db),
    activeWorkspaceGuardFingerprints,
  );
  const workspaceBlockedRoutineIds = new Set(
    plannedRoutines
      .filter((planned) => planned.contract.workspaceCwd
        && workspaceGuardKeys.has(`${planned.routine.companyId}:${planned.contract.workspaceCwd}`))
      .map((planned) => planned.routine.id),
  );
  const plannedTriggers = plannedRoutines.flatMap((routineUpdate) =>
    (triggersByRoutine.get(routineUpdate.routine.id) ?? []).map((trigger, index) =>
      classifyTriggerUpdate(
        trigger,
        routineUpdate,
        index,
        now,
        workspaceBlockedRoutineIds.has(routineUpdate.routine.id),
      ),
    ),
  );
  const plannedStaleTriggerUpdates = staleTriggers.map(classifyStaleTriggerUpdate);
  const plannedTriggerUpdates = [...plannedTriggers, ...plannedStaleTriggerUpdates];
  const plannedWorkspaceBlockedTriggerUpdates = plannedTriggers.filter(
    (planned) => planned.reason === "workspace_dirty_guard_active",
  );

  const companiesRows = await collectCompanyRows(db);
  const providerSignals = await collectProviderDegradedSignals(db);
  const portfolioCompany = companiesRows.find((company) => company.name === "Portfolio OS Orchestrator") ?? companiesRows[0];
  const internetPipesGapGuard = await planInternetPipesGapGuard({ portfolioCompany, portfolioOsRoot });
  const providerGuard: ProviderGuardPlan | null = providerSignals.length > 0 && portfolioCompany
    ? {
        companyId: portfolioCompany.id,
        companyName: portfolioCompany.name,
        issuePrefix: portfolioCompany.issuePrefix,
        originId: originSafe("execution_capacity:portfolio-provider-degraded"),
        degradedSignals: providerSignals,
      }
    : null;

  const issueCollapses = planIssueCollapse(await collectOpenRoutineIssues(db));
  const activeDuplicateLoopOrigins = new Set(issueCollapses.map((collapse) => originSafe(`duplicate_loop:${collapse.groupKey}`)));
  const plannedResolvedDuplicateLoopGuards = planResolvedDuplicateLoopGuardIssues(
    await collectOpenDuplicateLoopGuardIssues(db),
    activeDuplicateLoopOrigins,
  );
  const freezeTriggerIds = triggers.filter((trigger) => trigger.enabled).map((trigger) => trigger.id);

  let backup: ConfigureFactoryResult["backup"] = null;
  if (!dryRun && options.backup !== false) {
    const backupResult = await runDatabaseBackup({
      connectionString,
      backupDir: resolveBackupDir(homeDir, instanceId, config),
      retentionDays: config.database?.backup?.retentionDays ?? 30,
      keepLatestBackups: 2,
      filenamePrefix: "paperclip-unattended-factory-preflight",
      compression: "gzip",
      dataBatchRows: 10,
    });
    backup = {
      path: backupResult.backupFile ?? null,
      summary: formatDatabaseBackupResult(backupResult),
    };
  }

  const result: ConfigureFactoryResult = {
    status: dryRun ? "dry_run" : "applied",
    migrationVersion: MIGRATION_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    connectionSource,
    backup,
    freeze: {
      enabledTriggerIds: freezeTriggerIds,
    },
    counts: {
      activeRoutinesBefore: activeRoutines.length,
      routineContractsPlanned: plannedRoutines.length,
      routineContractsApplied: dryRun ? 0 : plannedRoutines.length,
      agencyRoutinesPaused: plannedRoutines.filter((planned) => planned.nextStatus === "paused").length,
      triggerUpdatesApplied: dryRun ? 0 : plannedTriggerUpdates.length,
      staleTriggersDisabled: dryRun ? 0 : plannedStaleTriggerUpdates.length,
      workspaceBlockedTriggersDisabled: dryRun ? 0 : plannedWorkspaceBlockedTriggerUpdates.length,
      agentsExamined: liveAgents.length,
      agentRoutingUpdatesApplied: dryRun ? 0 : plannedAgents.filter((planned) => planned.changed).length,
      credentialGuards: credentialGuards.length,
      workspaceGuards: workspaceGuards.length,
      internetPipesGapGuards: internetPipesGapGuard ? 1 : 0,
      resolvedWorkspaceGuards: dryRun ? 0 : plannedResolvedWorkspaceGuards.length,
      resolvedDuplicateLoopGuards: dryRun ? 0 : plannedResolvedDuplicateLoopGuards.length,
      providerGuards: providerGuard ? 1 : 0,
      blockerApprovals: credentialGuards.length + (providerGuard ? 1 : 0) + issueCollapses.length,
      collapsedIssueGroups: issueCollapses.length,
      cancelledDuplicateRoutineIssues: issueCollapses.reduce((sum, plan) => sum + plan.cancelledIssueIds.length, 0),
    },
    planned: {
      routines: plannedRoutines.map((planned) => ({
        id: planned.routine.id,
        companyName: planned.routine.companyName,
        title: planned.routine.title,
        lane: planned.contract.lane,
        state: planned.contract.state,
        requiredSecretNames: planned.contract.requiredSecretNames,
        shipCaptain: planned.contract.shipCaptain,
        nextStatus: planned.nextStatus,
        nextConcurrencyPolicy: planned.nextConcurrencyPolicy,
      })),
      credentialGuards,
      workspaceGuards,
      internetPipesGapGuards: internetPipesGapGuard ? [internetPipesGapGuard] : [],
      providerGuard,
      issueCollapses,
      resolvedWorkspaceGuards: plannedResolvedWorkspaceGuards.map((planned) => ({
        id: planned.issue.id,
        companyName: planned.issue.companyName,
        issuePrefix: planned.issue.issuePrefix,
        identifier: planned.issue.identifier,
        cwd: planned.issue.cwd,
        fingerprint: planned.issue.fingerprint,
        reason: planned.reason,
      })),
      resolvedDuplicateLoopGuards: plannedResolvedDuplicateLoopGuards.map((planned) => ({
        id: planned.issue.id,
        companyName: planned.issue.companyName,
        issuePrefix: planned.issue.issuePrefix,
        identifier: planned.issue.identifier,
        originId: planned.issue.originId,
        reason: planned.reason,
      })),
      staleTriggers: plannedStaleTriggerUpdates.map((planned) => {
        const trigger = planned.trigger as LiveStaleTriggerRow;
        return {
          id: trigger.id,
          companyName: trigger.companyName,
          issuePrefix: trigger.issuePrefix,
          routineTitle: trigger.routineTitle,
          routineStatus: trigger.routineStatus,
          reason: planned.reason,
        };
      }),
    },
    applied: {
      guardIssues: [],
      guardApprovals: [],
      receiptPath: null,
    },
  };

  if (dryRun) return result;

  if (freezeTriggerIds.length > 0) {
    await db
      .update(routineTriggers)
      .set({
        enabled: false,
        lastResult: "Temporarily frozen by unattended factory configuration migration",
        updatedAt: new Date(),
      })
      .where(inArray(routineTriggers.id, freezeTriggerIds));
  }

  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      for (const planned of plannedRoutines) {
        await txDb
          .update(routines)
          .set({
            description: planned.nextDescription,
            status: planned.nextStatus,
            concurrencyPolicy: planned.nextConcurrencyPolicy,
            catchUpPolicy: "skip_missed",
            updatedAt: new Date(),
          })
          .where(eq(routines.id, planned.routine.id));
      }

      for (const planned of plannedTriggerUpdates) {
        await txDb
          .update(routineTriggers)
          .set({
            enabled: planned.nextEnabled,
            cronExpression: planned.nextCronExpression,
            label: planned.nextLabel,
            nextRunAt: planned.nextRunAt,
            lastResult: planned.reason,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, planned.trigger.id));
      }

      for (const planned of plannedAgents.filter((entry) => entry.changed)) {
        await txDb
          .update(agents)
          .set({
            adapterConfig: planned.nextAdapterConfig,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, planned.agent.id));
      }

      for (const guard of credentialGuards) {
        const blockerFingerprint = `credential:${[...guard.missingSecretNames].sort().join("+")}`;
        const guardIssue = await ensureFactoryGuardIssue(txDb, {
          companyId: guard.companyId,
          issuePrefix: guard.issuePrefix,
          originId: guard.originId,
          title: `Credential blocker: ${guard.missingSecretNames.join(", ")}`,
          description: buildFactoryGuardDescription({
            reason: "credential_blocked",
            message: "Add the missing company secrets before deploy, distribution, or outreach lanes can run unattended.",
            state: "waiting_for_human_credential",
            blockerOwner: "board",
            fingerprint: blockerFingerprint,
            details: { missingSecretNames: guard.missingSecretNames, migrationVersion: MIGRATION_VERSION },
          }),
          priority: "critical",
          executionState: {
            paperclipFactoryGuard: {
              reason: "credential_blocked",
              state: "waiting_for_human_credential",
              blockerClass: "credential",
              blockerOwner: "board",
              missingSecretNames: guard.missingSecretNames,
              migrationVersion: MIGRATION_VERSION,
            },
          },
        });
        result.applied.guardIssues.push(guardIssue);
        const approval = await ensureFactoryGuardApproval(txDb, {
          companyId: guard.companyId,
          companyName: guard.companyName,
          issueId: guardIssue.issueId,
          issueIdentifier: guardIssue.identifier,
          title: `Credential blocker: ${guard.missingSecretNames.join(", ")}`,
          blockerClass: "credential",
          blockerFingerprint,
          requiredSecretNames: guard.missingSecretNames,
          details: { missingSecretNames: guard.missingSecretNames, migrationVersion: MIGRATION_VERSION },
        });
        if (approval) result.applied.guardApprovals.push(approval);
      }

      for (const guard of workspaceGuards) {
        result.applied.guardIssues.push(await ensureFactoryGuardIssue(txDb, {
          companyId: guard.companyId,
          issuePrefix: guard.issuePrefix,
          originId: guard.originId,
          title: "Workspace cleanup required before guarded lane resumes",
          description: buildFactoryGuardDescription({
            reason: "workspace_not_clean",
            message: "Classify or clean the dirty workspace paths before this release, QA, deploy, or ship routine runs again.",
            state: "waiting_for_clean_workspace",
            blockerOwner: "agent",
            fingerprint: guard.fingerprint,
            details: {
              cwd: guard.cwd,
              dirtyPaths: guard.dirtyPaths,
              reason: guard.reason,
              error: guard.error ?? null,
              migrationVersion: MIGRATION_VERSION,
            },
          }),
          priority: "high",
          executionState: {
            paperclipFactoryGuard: {
              reason: "workspace_not_clean",
              state: "waiting_for_clean_workspace",
              blockerClass: "workspace_cleanliness",
              blockerOwner: "agent",
              fingerprint: guard.fingerprint,
              cwd: guard.cwd,
              dirtyPaths: guard.dirtyPaths,
              migrationVersion: MIGRATION_VERSION,
            },
          },
        }));
      }

      if (internetPipesGapGuard) {
        const missing = internetPipesGapGuard.missingStations.length > 0
          ? internetPipesGapGuard.missingStations.join(", ")
          : "none recorded";
        result.applied.guardIssues.push(await ensureFactoryGuardIssue(txDb, {
          companyId: internetPipesGapGuard.companyId,
          issuePrefix: internetPipesGapGuard.issuePrefix,
          originId: internetPipesGapGuard.originId,
          title: `Internet Pipes evidence gap: ${internetPipesGapGuard.repo}`,
          description: buildFactoryGuardDescription({
            reason: "internet_pipes_gap",
            message: "Close the Portfolio OS Internet Pipes evidence gaps before creating a new venture company or dispatching build work.",
            state: "waiting_for_evidence_backfill",
            blockerOwner: "agent",
            fingerprint: `internet_pipes:${internetPipesGapGuard.repo}:${internetPipesGapGuard.runId}`,
            details: {
              repo: internetPipesGapGuard.repo,
              runId: internetPipesGapGuard.runId,
              sourcePath: internetPipesGapGuard.sourcePath,
              decisionStatus: internetPipesGapGuard.decisionStatus,
              readiness: internetPipesGapGuard.readiness,
              score: internetPipesGapGuard.score,
              missingStations: internetPipesGapGuard.missingStations,
              recommendations: internetPipesGapGuard.recommendations,
              missingEvidence: internetPipesGapGuard.missingEvidence,
              nextAgentActions: [
                "Run Portfolio OS evidence intake for the missing stations.",
                "Refresh business artifacts with `./bin/pos daily --business --reuse-cached-inputs`.",
                "Run `./bin/pos self-heal-graduation --reuse-latest-batch-first --max-attempts 1` and verify the frozen selection no longer reports the same gap.",
              ],
              migrationVersion: MIGRATION_VERSION,
            },
          }),
          priority: "high",
          executionState: {
            paperclipFactoryGuard: {
              reason: "internet_pipes_gap",
              state: "waiting_for_evidence_backfill",
              blockerClass: "internet_pipes",
              blockerOwner: "agent",
              repo: internetPipesGapGuard.repo,
              runId: internetPipesGapGuard.runId,
              sourcePath: internetPipesGapGuard.sourcePath,
              readiness: internetPipesGapGuard.readiness,
              score: internetPipesGapGuard.score,
              missingStations: internetPipesGapGuard.missingStations,
              recommendations: internetPipesGapGuard.recommendations,
              missingEvidence: internetPipesGapGuard.missingEvidence,
              summary: `Internet Pipes readiness ${internetPipesGapGuard.readiness || "unscored"}; missing stations: ${missing}.`,
              migrationVersion: MIGRATION_VERSION,
            },
          },
        }));
      }

      for (const planned of plannedResolvedWorkspaceGuards) {
        const resolvedAt = new Date();
        const guardResolution = {
          state: "workspace_clean",
          reason: planned.reason,
          resolvedAt: resolvedAt.toISOString(),
          resolvedBy: "unattended_factory_configuration",
          migrationVersion: MIGRATION_VERSION,
        };
        await txDb
          .update(issues)
          .set({
            status: "done",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
            executionState: sql`jsonb_set(
              coalesce(${issues.executionState}, '{}'::jsonb),
              '{paperclipFactoryGuard}',
              coalesce(${issues.executionState}->'paperclipFactoryGuard', '{}'::jsonb) || ${JSON.stringify(guardResolution)}::jsonb,
              true
            )`,
          })
          .where(eq(issues.id, planned.issue.id));
      }

      for (const planned of plannedResolvedDuplicateLoopGuards) {
        const resolvedAt = new Date();
        const guardResolution = {
          state: "duplicate_loop_not_active",
          reason: planned.reason,
          resolvedAt: resolvedAt.toISOString(),
          resolvedBy: "unattended_factory_configuration",
          migrationVersion: MIGRATION_VERSION,
        };
        await txDb
          .update(issues)
          .set({
            status: "done",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
            executionState: sql`jsonb_set(
              coalesce(${issues.executionState}, '{}'::jsonb),
              '{paperclipFactoryGuard}',
              coalesce(${issues.executionState}->'paperclipFactoryGuard', '{}'::jsonb) || ${JSON.stringify(guardResolution)}::jsonb,
              true
            )`,
          })
          .where(eq(issues.id, planned.issue.id));
      }

      if (providerGuard) {
        const guardIssue = await ensureFactoryGuardIssue(txDb, {
          companyId: providerGuard.companyId,
          issuePrefix: providerGuard.issuePrefix,
          originId: providerGuard.originId,
          title: "Execution capacity blocked",
          description: buildFactoryGuardDescription({
            reason: "provider_capacity_blocked",
            message: "Paperclip suppressed or failed recent provider-backed wakes; MiniMax remains the only automatic degraded lane and post-MiniMax fallback is not approved.",
            state: "waiting_for_provider_capacity",
            blockerOwner: "board",
            fingerprint: "portfolio-provider-degraded",
            details: {
              degradedSignals: providerGuard.degradedSignals,
              migrationVersion: MIGRATION_VERSION,
            },
          }),
          priority: "critical",
          executionState: {
            paperclipFactoryGuard: {
              reason: "provider_capacity_blocked",
              state: "waiting_for_provider_capacity",
              blockerClass: "provider_capacity",
              blockerOwner: "board",
              degradedSignals: providerGuard.degradedSignals,
              migrationVersion: MIGRATION_VERSION,
            },
          },
        });
        result.applied.guardIssues.push(guardIssue);
        const approval = await ensureFactoryGuardApproval(txDb, {
          companyId: providerGuard.companyId,
          companyName: providerGuard.companyName,
          issueId: guardIssue.issueId,
          issueIdentifier: guardIssue.identifier,
          title: "Execution capacity blocked",
          blockerClass: "provider_capacity",
          blockerFingerprint: "portfolio-provider-degraded",
          details: { degradedSignals: providerGuard.degradedSignals, migrationVersion: MIGRATION_VERSION },
        });
        if (approval) result.applied.guardApprovals.push(approval);
      }

      const collapseByIssueId = new Map<string, IssueCollapsePlan>();
      for (const collapse of issueCollapses) {
        for (const issueId of collapse.cancelledIssueIds) collapseByIssueId.set(issueId, collapse);
      }
      for (const [issueId, collapse] of collapseByIssueId) {
        await txDb
          .update(issues)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            updatedAt: new Date(),
            executionState: sql`coalesce(${issues.executionState}, '{}'::jsonb) || ${JSON.stringify({
              unattendedFactoryCollapse: {
                groupKey: collapse.groupKey,
                supersededByIssueId: collapse.keptIssueId,
                migrationVersion: MIGRATION_VERSION,
                collapsedAt: new Date().toISOString(),
              },
            })}::jsonb`,
          })
          .where(eq(issues.id, issueId));
      }
      for (const collapse of issueCollapses) {
        const approval = await ensureFactoryGuardApproval(txDb, {
          companyId: collapse.companyId,
          companyName: collapse.companyName,
          issueId: collapse.keptIssueId,
          issueIdentifier: null,
          title: `Duplicate routine loop requires refactor decision: ${collapse.keptTitle}`,
          blockerClass: "duplicate_loop",
          blockerFingerprint: `duplicate_loop:${collapse.groupKey}`,
          details: {
            groupKey: collapse.groupKey,
            keptIssueId: collapse.keptIssueId,
            cancelledIssueIds: collapse.cancelledIssueIds,
            migrationVersion: MIGRATION_VERSION,
          },
        });
        if (approval) result.applied.guardApprovals.push(approval);
      }
    });
  } catch (error) {
    if (freezeTriggerIds.length > 0) {
      await db
        .update(routineTriggers)
        .set({
          enabled: true,
          lastResult: "Restored after failed unattended factory configuration migration",
          updatedAt: new Date(),
        })
        .where(inArray(routineTriggers.id, freezeTriggerIds));
    }
    throw error;
  }

  result.finishedAt = new Date().toISOString();
  const receiptPath = receiptPathFor({ homeDir, instanceId, receiptDir }, now);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  result.applied.receiptPath = receiptPath;
  await writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function parseArgs(argv: string[]) {
  const parsed: ConfigureFactoryOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--apply") parsed.dryRun = false;
    else if (arg === "--no-backup") parsed.backup = false;
    else if (arg === "--connection-string") parsed.connectionString = argv[++index];
    else if (arg === "--home") parsed.homeDir = argv[++index];
    else if (arg === "--instance-id") parsed.instanceId = argv[++index];
    else if (arg === "--receipt-dir") parsed.receiptDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: tsx src/ops/unattended-factory-configuration.ts --dry-run|--apply [options]",
        "",
        "Options:",
        "  --connection-string <url>  Override database connection string",
        "  --home <path>              Paperclip home directory",
        "  --instance-id <id>         Paperclip instance id",
        "  --receipt-dir <path>       Receipt dir relative to instance root",
        "  --no-backup                Skip pre-apply database backup",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (parsed.dryRun !== true && parsed.dryRun !== false) {
    throw new Error("Pass either --dry-run or --apply");
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
    const result = await configureUnattendedFactory(db, {
      ...options,
      homeDir,
      instanceId,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
