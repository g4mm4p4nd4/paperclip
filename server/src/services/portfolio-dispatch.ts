import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX, DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { companyService } from "./companies.js";
import { projectService } from "./projects.js";
import { agentService } from "./agents.js";
import { agentRoleDefaultsService } from "./agent-role-defaults.js";
import { issueService } from "./issues.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { heartbeatService } from "./heartbeat.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { routineService } from "./routines.js";
import { assertRoutineCoverage } from "./flywheel-coverage.js";
import { buildCompanyVisionContract } from "./company-vision-contract.js";

const execFile = promisify(execFileCallback);

const DEFAULT_POS_DIR = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_PAPERCLIP_DIR = "/Users/mnm/Documents/Github/paperclip";
const DEFAULT_GSTACK_DIR = "/Users/mnm/Documents/Github/gstack";
const DEFAULT_DISPATCH_OUTBOX = `${DEFAULT_POS_DIR}/data/dispatch/outbox`;
const DEFAULT_DISPATCH_GATE_PATH = `${DEFAULT_POS_DIR}/data/state/paperclip_dispatch_gate.json`;
const DEFAULT_DISPATCH_LEDGER_PATH = path.resolve(
  resolvePaperclipInstanceRoot(),
  "data",
  "portfolio-os-dispatch-ledger.json",
);
const DEFAULT_GSTACK_SKILL_LINK = path.resolve(os.homedir(), ".codex", "skills", "gstack");
const DEFAULT_DISPATCH_POLL_INTERVAL_MS = 15_000;
const DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV = "PAPERCLIP_POS_DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION";
const DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_DEFAULT = true;
const ALLOWED_DOSSIER_GATE_STATUSES = new Set(["APPROVED_DISTINCT_RESKIN", "APPROVED_NO_CONFLICT"]);

type DispatchTask = {
  function?: string;
  ticket_title?: string;
  summary?: string;
  acceptance_criteria?: string[];
  requires_approval_before_merge?: boolean;
  requires_approval_before_deploy?: boolean;
  repo_target?: {
    target_repo_full_name?: string;
    target_repo_branch?: string;
    target_repo_clone_path_hint?: string | null;
    suggested_branch_name?: string;
    repo_url?: string;
  };
};

type InternetPipesRawSource = {
  internet_pipes_score?: unknown;
  internet_pipes_readiness?: unknown;
  internet_pipes_missing_stations?: unknown;
  internet_pipes_recommendations?: unknown;
  internet_pipes?: {
    score?: unknown;
    readiness?: unknown;
    missing_stations?: unknown;
    recommendations?: unknown;
  } | null;
};

type InternetPipesCompletenessContract = {
  score: number | null;
  readiness: string;
  missing_stations: string[];
  recommendations: string[];
  source: string;
};

type PortfolioDispatchPayload = {
  schema_version?: string;
  run_id?: string;
  generated_at?: string;
  selection_snapshot_hash?: string;
  selection_snapshot_path?: string;
  packet_snapshot_path?: string;
  selected_repo_dossier_path?: string;
  selected_repo_dossier_hash?: string;
  target_repo_full_name?: string;
  target_repo_branch?: string;
  target_repo_clone_path_hint?: string | null;
  execution_manifest?: {
    repo_target?: DispatchTask["repo_target"];
    task_groups?: Record<string, DispatchTask[]>;
  };
  paperclip?: {
    dispatch_gate?: InternetPipesRawSource | null;
  };
  selection_snapshot?: {
    launch_target?: InternetPipesRawSource & {
      repo?: string;
      repo_url?: string;
      robust_branch?: string;
      launch_packet_slug?: string;
      strongest_wedge?: string;
      recommended_offer_angle?: string;
    };
    selected_opportunity?: InternetPipesRawSource | null;
    paperclip?: {
      dispatch_gate?: InternetPipesRawSource | null;
    };
    artifacts?: {
      scaffold_dir?: string | null;
      launch_packet_path?: string | null;
      daily_report_path?: string | null;
      business_report_path?: string | null;
      council_report_path?: string | null;
    };
    frozen_bundle?: {
      pending_semantic_review?: boolean;
      research_target?: InternetPipesRawSource | null;
      business_choice?: InternetPipesRawSource | null;
      launch_target?: InternetPipesRawSource | null;
      execution_candidate?: InternetPipesRawSource | null;
    };
  };
  dossier_contract?: {
    selected_repo_dossier?: {
      repo?: string;
      dossier_path?: string;
      dossier_hash?: string;
      inventory_built_at?: string;
      semantic_review_at?: string;
    };
    pending_semantic_review?: boolean;
    gate_statuses?: Record<string, string>;
    freshness_statuses?: Record<string, string>;
  };
  cockpit?: {
    portfolio_os_dir?: string;
    paperclip_dir?: string;
    gstack_dir?: string;
  };
};

type DispatchLedgerEntry = {
  dispatchHash: string;
  runId: string;
  selectionSnapshotHash: string;
  dispatchPath: string;
  companyId: string;
  projectId: string;
  issueIds: string[];
  approvalIds: string[];
  routineIds?: string[];
  ingestedAt: string;
};

type DispatchLedger = {
  ingested: Record<string, DispatchLedgerEntry>;
};

type DispatchLedgerHashEntry = {
  hash: string;
  entry: DispatchLedgerEntry;
};

type PortfolioCompany = {
  id: string;
  name: string;
  description: string | null;
};

type PortfolioProject = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status?: string | null;
  workspaces?: Array<{
    id: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
  }>;
};

type PortfolioAgent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsTo: string | null;
  status?: string | null;
};

type PortfolioIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
  assigneeAgentId?: string | null;
};

type PortfolioApproval = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
};

type PortfolioRoutine = {
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
  triggers: Array<{
    id: string;
    kind: string;
    label: string | null;
    enabled: boolean;
  }>;
};

type PortfolioDispatchIngestDeps = {
  readFile(pathValue: string): Promise<string>;
  readDispatchLedger(): Promise<DispatchLedger>;
  writeDispatchLedger(ledger: DispatchLedger): Promise<void>;
  ensureGstackSkillLink(): Promise<void>;
  ensureRepoClone(input: {
    repoFullName: string;
    repoUrl: string;
    clonePathHint: string;
    baseBranch: string;
    runBranch: string;
  }): Promise<{ clonePath: string; runBranch: string }>;
  listCompanies(): Promise<PortfolioCompany[]>;
  createCompany(input: {
    name: string;
    description: string;
  }): Promise<PortfolioCompany>;
  listProjects(companyId: string): Promise<PortfolioProject[]>;
  createProject(companyId: string, input: {
    name: string;
    description: string;
    status: "planned";
  }): Promise<PortfolioProject>;
  createWorkspace(projectId: string, input: {
    name: string;
    cwd: string;
    repoUrl: string;
    repoRef: string;
    defaultRef: string;
    isPrimary: boolean;
  }): Promise<void>;
  listAgents(companyId: string): Promise<PortfolioAgent[]>;
  createAgent(companyId: string, input: {
    name: string;
    role: string;
    title: string;
    reportsTo: string | null;
    capabilities: string;
    adapterType: "codex_local";
    adapterConfig: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<PortfolioAgent>;
  listIssues(companyId: string, projectId: string): Promise<PortfolioIssue[]>;
  createIssue(companyId: string, input: {
    projectId: string;
    title: string;
    description: string;
    status: "todo";
    priority: "high" | "medium";
    assigneeAgentId: string | null;
    executionPolicy?: IssueExecutionPolicy | null;
  }): Promise<PortfolioIssue>;
  listApprovals(companyId: string): Promise<PortfolioApproval[]>;
  createApproval(companyId: string, input: {
    type: "launch_execution";
    requestedByAgentId: string | null;
    payload: Record<string, unknown>;
  }): Promise<PortfolioApproval>;
  linkApprovalToIssues(approvalId: string, issueIds: string[]): Promise<void>;
  listRoutines(companyId: string): Promise<PortfolioRoutine[]>;
  createRoutine(companyId: string, input: {
    projectId: string;
    title: string;
    description: string;
    assigneeAgentId: string;
    priority: "high" | "medium";
    status: "active";
    concurrencyPolicy: "coalesce_if_active";
    catchUpPolicy: "skip_missed";
    variables: [];
    parentIssueId?: string | null;
  }): Promise<PortfolioRoutine>;
  createRoutineTrigger(routineId: string, input: {
    kind: "schedule";
    label: string;
    enabled: boolean;
    cronExpression: string;
    timezone: string;
  }): Promise<void>;
  wakeAgent(agentId: string, issueId: string, projectId: string, runId: string, projectWorkspaceId?: string | null): Promise<void>;
  logInfo(message: string, details?: Record<string, unknown>): void;
  logWarn(message: string, details?: Record<string, unknown>): void;
  logError(message: string, details?: Record<string, unknown>): void;
};

type DispatchIngestResult = {
  status: "ingested" | "skipped";
  dispatchHash: string;
  runId: string;
  companyId?: string;
  projectId?: string;
  issueIds?: string[];
  approvalIds?: string[];
  routineIds?: string[];
};

type ExistingVentureGatePayload = InternetPipesRawSource & {
  schema_version?: string;
  status?: string;
  route_type?: string;
  request_type?: string;
  route_backlog_only?: boolean | string;
  repo?: string;
  assessment?: string;
  reason?: string;
  required_next_step?: string;
  existing_venture_company?: string;
  existing_company_id?: string;
  existing_project_id?: string;
  existing_project_identity?: string;
  existing_repo_project_identity?: string;
  approved_by?: string;
  source_request_path?: string;
  affected_workflow?: string;
  distinct_customer?: string;
  distinct_use_case?: string;
  distinct_niche?: string;
  differentiation_summary?: string;
  why_not_existing_company?: string;
  existing_venture_insufficient_reason?: string;
  ingredient_overlap_repo?: string;
  recommended_owner?: string;
  urgency?: string;
  expected_impact?: string;
};

type ExistingVentureGateIssue = PortfolioIssue & {
  description: string | null;
  status: string;
  assigneeAgentId: string | null;
  executionState?: Record<string, unknown> | null;
};

type ExistingVentureGateDeps = {
  readFile(pathValue: string): Promise<string>;
  listProjects(companyId: string): Promise<PortfolioProject[]>;
  listAgents(companyId: string): Promise<PortfolioAgent[]>;
  listIssuesByOrigin(companyId: string, originKind: string, originId: string): Promise<ExistingVentureGateIssue[]>;
  createIssue(companyId: string, input: {
    projectId: string | null;
    title: string;
    description: string;
    status: "todo";
    priority: "high" | "medium";
    assigneeAgentId: string | null;
    parentId?: string | null;
    originKind: string;
    originId: string;
    executionState: Record<string, unknown>;
  }): Promise<ExistingVentureGateIssue>;
  updateIssue(issueId: string, input: {
    projectId?: string | null;
    parentId?: string | null;
    title?: string;
    description?: string;
    status?: "todo";
    priority?: "high" | "medium";
    assigneeAgentId?: string | null;
    executionState?: Record<string, unknown>;
  }): Promise<ExistingVentureGateIssue | null>;
  wakeAgent(agentId: string, issueId: string, projectId: string | null, runId: string): Promise<void>;
  logInfo(message: string, details?: Record<string, unknown>): void;
  logWarn(message: string, details?: Record<string, unknown>): void;
  logError(message: string, details?: Record<string, unknown>): void;
};

type ExistingVentureGateResult = {
  status: "created" | "updated" | "skipped";
  gateHash: string;
  originId?: string;
  companyId?: string;
  projectId?: string | null;
  issueId?: string;
  assigneeAgentId?: string | null;
  wakeQueued?: boolean;
  childIssueCount?: number;
  childIssuesCreated?: number;
  childIssuesUpdated?: number;
  childWakeQueued?: number;
  reason?: string;
};

type PortfolioDispatchWorkerResult = DispatchIngestResult | ExistingVentureGateResult;

const EXISTING_VENTURE_GATE_ORIGIN_KIND = "portfolio_existing_venture_gate";
const EXISTING_VENTURE_STATION_ORIGIN_KIND = "portfolio_existing_venture_station";
const OPEN_EXISTING_VENTURE_GATE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const TERMINAL_EXISTING_VENTURE_GATE_STATUSES = new Set(["done", "cancelled"]);
const ACTIONABLE_EXISTING_VENTURE_REQUEST_TYPES = new Set([
  "feature_delta",
  "remediation",
  "existing_venture_delta",
  "existing_company_request",
  "board_promoted",
  "operator_promoted",
]);
const ACTIONABLE_EXISTING_VENTURE_ROUTE_TYPES = new Set([
  "feature_delta",
  "remediation",
  "existing_venture_delta",
  "existing_company_request",
]);
const SUPPRESSED_EXISTING_VENTURE_REASONS = new Set([
  "already_owned_venture_suppressed",
  "already_owned_venture_backlog_suppressed",
  "already_owned_venture_missing_action_provenance",
]);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDispatchLedger(input: unknown): DispatchLedger {
  if (
    typeof input === "object"
    && input !== null
    && "ingested" in input
    && typeof (input as { ingested?: unknown }).ingested === "object"
    && (input as { ingested?: unknown }).ingested !== null
  ) {
    return {
      ingested: { ...((input as { ingested: Record<string, DispatchLedgerEntry> }).ingested ?? {}) },
    };
  }
  return { ingested: {} };
}

function dispatchLedgerEntriesForRun(ledger: DispatchLedger, runId: string): DispatchLedgerHashEntry[] {
  return Object.entries(ledger.ingested)
    .filter(([, entry]) => entry.runId === runId)
    .map(([hash, entry]) => ({ hash, entry }));
}

function parseIngestedAtTimestamp(ingestedAt: string | null | undefined) {
  if (!ingestedAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(ingestedAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function selectCanonicalRunLedgerEntry(entries: DispatchLedgerHashEntry[]) {
  if (entries.length === 0) {
    throw new Error("Cannot select canonical dispatch ledger entry from an empty run set.");
  }
  return [...entries].sort((left, right) => {
    const timeDiff = parseIngestedAtTimestamp(left.entry.ingestedAt) - parseIngestedAtTimestamp(right.entry.ingestedAt);
    if (timeDiff !== 0) return timeDiff;
    return left.hash.localeCompare(right.hash);
  })[0];
}

function pruneRunLedgerEntries(ledger: DispatchLedger, runId: string, canonicalHash: string) {
  const removedHashes: string[] = [];
  for (const [hash, entry] of Object.entries(ledger.ingested)) {
    if (entry.runId !== runId || hash === canonicalHash) continue;
    delete ledger.ingested[hash];
    removedHashes.push(hash);
  }
  return removedHashes;
}

function normalizeRepoUrl(repoFullName: string, candidate: string | null | undefined) {
  const trimmed = candidate?.trim() ?? "";
  if (trimmed.length > 0) {
    if (trimmed.endsWith(".git")) return trimmed;
    if (trimmed.includes("github.com/")) return `${trimmed.replace(/\/+$/, "")}.git`;
    return trimmed;
  }
  return `https://github.com/${repoFullName}.git`;
}

function deriveVentureCompanyName(repoFullName: string) {
  return `Portfolio Venture Factory :: ${repoFullName}`;
}

function deriveRunProjectName(runId: string, repoFullName: string) {
  return `Run ${runId} :: ${repoFullName}`;
}

const TERMINAL_PROJECT_STATUSES = new Set(["completed", "cancelled"]);

function findDispatchTargetProject(input: {
  projects: PortfolioProject[];
  repoFullName: string;
  repoUrl: string;
  runProjectName: string;
}) {
  const activeProjects = input.projects.filter(
    (project) => !TERMINAL_PROJECT_STATUSES.has(String(project.status ?? "").trim().toLowerCase()),
  );
  const existingRunProject = activeProjects.find((project) => project.name === input.runProjectName) ?? null;
  if (existingRunProject) return existingRunProject;

  const canonicalProject = activeProjects.find((project) => project.name === input.repoFullName) ?? null;
  if (canonicalProject) return canonicalProject;

  const targetRepoUrl = normalizeRepoUrl(input.repoFullName, input.repoUrl);
  return activeProjects.find((project) => {
    const primaryWorkspace = project.workspaces?.find((workspace) => workspace.isPrimary) ?? null;
    if (!primaryWorkspace?.repoUrl) return false;
    return normalizeRepoUrl(input.repoFullName, primaryWorkspace.repoUrl) === targetRepoUrl;
  }) ?? null;
}

function buildMetadataContract(input: {
  runId: string;
  dispatchHash: string;
  selectionSnapshotHash: string;
  targetRepoFullName: string;
  targetRepoRef: string;
  suggestedBranchName: string;
  sourceDispatchPath: string;
}) {
  return {
    run_id: input.runId,
    dispatch_hash: input.dispatchHash,
    selection_snapshot_hash: input.selectionSnapshotHash,
    target_repo_full_name: input.targetRepoFullName,
    target_repo_ref: input.targetRepoRef,
    suggested_branch_name: input.suggestedBranchName,
    source_dispatch_path: input.sourceDispatchPath,
  };
}

function renderMetadataBlock(metadata: Record<string, unknown>) {
  return [
    "## Portfolio Dispatch Contract",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExistingVentureKey(value: unknown) {
  return normalizeOptionalString(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeExistingVentureKey(value);
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return false;
}

function existingVentureGateActionability(payload: ExistingVentureGatePayload) {
  if (normalizeOptionalBoolean(payload.route_backlog_only)) {
    return {
      actionable: false,
      reason: "already_owned_venture_backlog_suppressed",
    };
  }

  const hasProvenance =
    Boolean(normalizeOptionalString(payload.approved_by))
    && Boolean(normalizeOptionalString(payload.source_request_path));
  const requestType = normalizeExistingVentureKey(payload.request_type);
  if (requestType && ACTIONABLE_EXISTING_VENTURE_REQUEST_TYPES.has(requestType)) {
    if (!hasProvenance) {
      return {
        actionable: false,
        reason: "already_owned_venture_missing_action_provenance",
      };
    }
    return {
      actionable: true,
      reason: `explicit_${requestType}_request`,
    };
  }

  const routeType = normalizeExistingVentureKey(payload.route_type);
  if (routeType && ACTIONABLE_EXISTING_VENTURE_ROUTE_TYPES.has(routeType)) {
    if (!hasProvenance) {
      return {
        actionable: false,
        reason: "already_owned_venture_missing_action_provenance",
      };
    }
    return {
      actionable: true,
      reason: `explicit_${routeType}_route`,
    };
  }

  const approvedBy = normalizeOptionalString(payload.approved_by);
  const explicitWorkPointer =
    normalizeOptionalString(payload.source_request_path)
    || normalizeOptionalString(payload.affected_workflow)
    || normalizeOptionalString(payload.existing_venture_insufficient_reason);
  if (approvedBy && explicitWorkPointer) {
    return {
      actionable: true,
      reason: "operator_approved_existing_venture_work",
    };
  }

  return {
    actionable: false,
    reason: "already_owned_venture_suppressed",
  };
}

function existingVentureIssueGateHash(issue: ExistingVentureGateIssue, stateKey: string) {
  const executionState = asRecord(issue.executionState);
  const state = asRecord(executionState?.[stateKey]);
  return normalizeOptionalString(state?.gateHash);
}

function sortExistingVentureIssues(left: ExistingVentureGateIssue, right: ExistingVentureGateIssue) {
  return left.id.localeCompare(right.id);
}

function sortTerminalExistingVentureIssues(left: ExistingVentureGateIssue, right: ExistingVentureGateIssue) {
  const leftRank = left.status === "done" ? 0 : 1;
  const rightRank = right.status === "done" ? 0 : 1;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return sortExistingVentureIssues(left, right);
}

function selectOpenExistingVentureIssue(issues: ExistingVentureGateIssue[]) {
  return issues
    .filter((issue) => OPEN_EXISTING_VENTURE_GATE_STATUSES.has(issue.status))
    .sort(sortExistingVentureIssues)[0] ?? null;
}

function selectTerminalSameHashExistingVentureIssue(
  issues: ExistingVentureGateIssue[],
  stateKey: string,
  gateHash: string,
) {
  return issues
    .filter((issue) =>
      TERMINAL_EXISTING_VENTURE_GATE_STATUSES.has(issue.status)
      && existingVentureIssueGateHash(issue, stateKey) === gateHash
    )
    .sort(sortTerminalExistingVentureIssues)[0] ?? null;
}

function normalizeStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function normalizeOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeInternetPipesSource(
  source: unknown,
  sourceLabel: string,
): InternetPipesCompletenessContract | null {
  const sourceRecord = asRecord(source);
  if (!sourceRecord) return null;
  const nested = asRecord(sourceRecord.internet_pipes);
  const score = normalizeOptionalNumber(sourceRecord.internet_pipes_score ?? nested?.score);
  const readiness = normalizeOptionalString(sourceRecord.internet_pipes_readiness ?? nested?.readiness);
  const missingStations = normalizeStringList(sourceRecord.internet_pipes_missing_stations ?? nested?.missing_stations);
  const recommendations = normalizeStringList(sourceRecord.internet_pipes_recommendations ?? nested?.recommendations);
  if (score === null && !readiness && missingStations.length === 0 && recommendations.length === 0) {
    return null;
  }
  return {
    score: score === null ? null : Math.round(score * 100) / 100,
    readiness,
    missing_stations: missingStations,
    recommendations,
    source: sourceLabel,
  };
}

function internetPipesCompletenessFromPayload(
  payload: PortfolioDispatchPayload,
): InternetPipesCompletenessContract | null {
  const selectionSnapshot = asRecord(payload.selection_snapshot);
  const frozenBundle = asRecord(selectionSnapshot?.frozen_bundle);
  const candidates: Array<{ source: unknown; label: string }> = [
    { source: frozenBundle?.launch_target, label: "selection_snapshot.frozen_bundle.launch_target" },
    { source: frozenBundle?.business_choice, label: "selection_snapshot.frozen_bundle.business_choice" },
    { source: frozenBundle?.execution_candidate, label: "selection_snapshot.frozen_bundle.execution_candidate" },
    { source: frozenBundle?.research_target, label: "selection_snapshot.frozen_bundle.research_target" },
    { source: selectionSnapshot?.launch_target, label: "selection_snapshot.launch_target" },
    { source: selectionSnapshot?.business_choice, label: "selection_snapshot.business_choice" },
    { source: selectionSnapshot?.execution_candidate, label: "selection_snapshot.execution_candidate" },
    { source: selectionSnapshot?.selected_opportunity, label: "selection_snapshot.selected_opportunity" },
    { source: selectionSnapshot?.research_target, label: "selection_snapshot.research_target" },
    { source: selectionSnapshot?.execution_target, label: "selection_snapshot.execution_target" },
    { source: payload.paperclip?.dispatch_gate, label: "payload.paperclip.dispatch_gate" },
    { source: payload.selection_snapshot?.paperclip?.dispatch_gate, label: "selection_snapshot.paperclip.dispatch_gate" },
  ];
  for (const candidate of candidates) {
    const normalized = normalizeInternetPipesSource(candidate.source, candidate.label);
    if (normalized) return normalized;
  }
  return null;
}

function formatInternetPipesScore(score: number | null) {
  return score === null ? "n/a" : score.toFixed(2);
}

function renderInternetPipesCompletenessBlock(
  internetPipes: InternetPipesCompletenessContract | null | undefined,
) {
  if (!internetPipes) return [];
  const readiness = internetPipes.readiness || "unscored";
  const missingStations = internetPipes.missing_stations.length > 0
    ? internetPipes.missing_stations.join(", ")
    : "none";
  const lines = [
    "## Internet Pipes Completeness",
    `- Score: ${formatInternetPipesScore(internetPipes.score)}`,
    `- Readiness: \`${readiness}\``,
    `- Missing stations: ${missingStations}`,
    `- Source: ${internetPipes.source}`,
  ];
  if (internetPipes.recommendations.length > 0) {
    lines.push(`- Next station work: ${internetPipes.recommendations[0]}`);
  }
  return lines;
}

function parseExistingVentureGatePayload(raw: string): ExistingVentureGatePayload {
  const parsed = JSON.parse(raw) as ExistingVentureGatePayload;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Existing venture gate payload is not a JSON object.");
  }
  return parsed;
}

function isExistingVentureGateRoute(payload: ExistingVentureGatePayload) {
  return (
    normalizeOptionalString(payload.status) === "ROUTE_TO_EXISTING_VENTURE" ||
    normalizeOptionalString(payload.route_type) === "existing_venture"
  );
}

function existingVentureGateOriginId(payload: ExistingVentureGatePayload) {
  const companyId = normalizeOptionalString(payload.existing_company_id);
  const repo = normalizeOptionalString(payload.repo);
  if (!companyId) throw new Error("Existing venture gate is missing existing_company_id.");
  if (!repo) throw new Error("Existing venture gate is missing repo.");
  return `existing_venture:${companyId}:${repo.toLowerCase()}`;
}

function safeExistingVentureGateOriginId(payload: ExistingVentureGatePayload) {
  const companyId = normalizeOptionalString(payload.existing_company_id);
  const repo = normalizeOptionalString(payload.repo);
  if (!companyId || !repo) return undefined;
  return `existing_venture:${companyId}:${repo.toLowerCase()}`;
}

function normalizeEvidenceStationKey(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function evidenceStationLabel(station: string) {
  return station.replace(/[-_]+/g, " ");
}

function missingExistingVentureStations(
  payload: ExistingVentureGatePayload,
  internetPipes: InternetPipesCompletenessContract | null,
) {
  const stations = [
    ...normalizeStringList(payload.internet_pipes_missing_stations),
    ...(internetPipes?.missing_stations ?? []),
  ];
  const byKey = new Map<string, string>();
  for (const station of stations) {
    const key = normalizeEvidenceStationKey(station);
    if (!key) continue;
    byKey.set(key, key);
  }
  return [...byKey.values()].sort();
}

const EXISTING_VENTURE_STATION_SPECS: Record<string, {
  title: string;
  ownerCandidates: string[];
  cakeOutput: string;
  acceptance: string[];
}> = {
  evaluation: {
    title: "evaluation",
    ownerCandidates: ["Venture Factory Liaison", "Market Intelligence", "CEO"],
    cakeOutput: "A cited market and competitor evaluation packet that proves whether this venture has a revenue-bearing wedge.",
    acceptance: [
      "Identify buyer, budget owner, current substitute, and top competitors with source URLs.",
      "State market size and near-term demand direction with enough evidence to justify or reject continued execution.",
      "Create the next execution issue if the evidence supports moving toward a launchable offer.",
    ],
  },
  differentiation: {
    title: "differentiation",
    ownerCandidates: ["Growth/Distribution", "CMO", "Venture Factory Liaison", "CEO"],
    cakeOutput: "A concrete differentiation thesis tied to buyer pain, competitor gaps, and the repo's feasible advantages.",
    acceptance: [
      "Name the competitor gap this venture can exploit and the exact proof required to support it.",
      "Translate the gap into offer positioning, ICP, and a first go-to-market angle.",
      "Create the next execution issue if the differentiation thesis is strong enough to test.",
    ],
  },
  visualization: {
    title: "visualization",
    ownerCandidates: ["Designer/Copy", "Asset Composition Lab", "Venture Factory Liaison", "CEO"],
    cakeOutput: "A visible proof artifact, mockup, flow, or demo brief that makes the venture legible to a buyer.",
    acceptance: [
      "Produce a visual artifact or exact build brief that can be used by the next builder without reinterpreting the idea.",
      "Tie the artifact to the buyer problem and the promised outcome.",
      "Create the next execution issue needed to turn the artifact into a usable pilot when appropriate.",
    ],
  },
  recommendation: {
    title: "recommendation",
    ownerCandidates: ["Venture Factory Liaison", "CEO", "Growth/Distribution"],
    cakeOutput: "A go/no-go recommendation with the next concrete Paperclip/Hermes execution task.",
    acceptance: [
      "Rank the venture hypothesis against the evidence threshold and explain the decision.",
      "If go, create the next execution issue with owner, scope, and acceptance criteria.",
      "If no-go, record the reason and prevent the same hypothesis from being recycled without new evidence.",
    ],
  },
};

function existingVentureStationSpec(station: string) {
  return EXISTING_VENTURE_STATION_SPECS[station] ?? {
    title: evidenceStationLabel(station),
    ownerCandidates: ["Venture Factory Liaison", "CEO", "Growth/Distribution"],
    cakeOutput: `A concrete ${evidenceStationLabel(station)} artifact that closes the missing evidence station.`,
    acceptance: [
      "Produce a cited, durable artifact rather than a status-only comment.",
      "State whether this station now clears the venture for the next launch step.",
      "Create the next execution issue when the station output supports continued execution.",
    ],
  };
}

function existingVentureStationOriginId(payload: ExistingVentureGatePayload, station: string) {
  return `${existingVentureGateOriginId(payload)}:station:${station}`;
}

function selectExistingVentureStationOwnerAgent(
  agents: PortfolioAgent[],
  station: string,
  fallbackOwner: PortfolioAgent | null,
) {
  const activeAgents = agents.filter((agent) => {
    const status = String(agent.status ?? "").trim().toLowerCase();
    return status !== "paused" && status !== "pending_approval" && status !== "terminated";
  });
  const byName = new Map(activeAgents.map((agent) => [agent.name.toLowerCase(), agent]));
  const spec = existingVentureStationSpec(station);
  for (const name of spec.ownerCandidates) {
    const exact = byName.get(name.toLowerCase());
    if (exact) return exact;
  }
  return fallbackOwner ?? activeAgents[0] ?? null;
}

function recommendationForExistingVentureStation(
  payload: ExistingVentureGatePayload,
  station: string,
  internetPipes: InternetPipesCompletenessContract | null,
) {
  const payloadStations = normalizeStringList(payload.internet_pipes_missing_stations)
    .map((entry) => normalizeEvidenceStationKey(entry));
  const payloadRecommendations = normalizeStringList(payload.internet_pipes_recommendations);
  const payloadIndex = payloadStations.indexOf(station);
  if (payloadIndex >= 0 && payloadRecommendations[payloadIndex]) {
    return payloadRecommendations[payloadIndex];
  }
  const internetPipesStations = (internetPipes?.missing_stations ?? [])
    .map((entry) => normalizeEvidenceStationKey(entry));
  const internetPipesIndex = internetPipesStations.indexOf(station);
  if (internetPipesIndex >= 0 && internetPipes?.recommendations[internetPipesIndex]) {
    return internetPipes.recommendations[internetPipesIndex];
  }
  return "";
}

function existingVentureStationExecutionState(input: {
  payload: ExistingVentureGatePayload;
  gateHash: string;
  gatePath: string;
  station: string;
  parentIssueId: string;
  internetPipes: InternetPipesCompletenessContract | null;
}) {
  return {
    portfolioExistingVentureStation: {
      version: "portfolio-existing-venture-station.v1",
      gateHash: input.gateHash,
      gatePath: path.resolve(input.gatePath),
      station: input.station,
      parentIssueId: input.parentIssueId,
      repo: input.payload.repo ?? null,
      existingCompanyId: input.payload.existing_company_id ?? null,
      existingProjectId: input.payload.existing_project_id ?? null,
      internetPipes: input.internetPipes,
    },
  };
}

function renderExistingVentureStationDescription(input: {
  payload: ExistingVentureGatePayload;
  gateHash: string;
  gatePath: string;
  station: string;
  parentIssueId: string;
  internetPipes: InternetPipesCompletenessContract | null;
}) {
  const spec = existingVentureStationSpec(input.station);
  const recommendation = recommendationForExistingVentureStation(input.payload, input.station, input.internetPipes);
  const lines = [
    `Close the Internet Pipes ${spec.title} station for ${normalizeOptionalString(input.payload.repo) || "the routed existing venture"}.`,
    "",
    "## Cake Output Required",
    `- ${spec.cakeOutput}`,
    "- The output must be a durable artifact in the Paperclip issue, attached repo, or cited source set. A status-only comment is not enough.",
    "- The issue is not done until it either creates the next execution issue or records a no-go decision that prevents repeated token spend.",
    "",
    "## Acceptance Criteria",
    ...spec.acceptance.map((item) => `- ${item}`),
    "",
    "## Parent Gate",
    `- Parent issue: ${input.parentIssueId}`,
    `- Repo: ${normalizeOptionalString(input.payload.repo) || "unknown"}`,
    `- Existing company: ${normalizeOptionalString(input.payload.existing_venture_company) || normalizeOptionalString(input.payload.existing_company_id) || "unknown"}`,
  ];
  if (recommendation) {
    lines.push("", "## Station Recommendation", `- ${recommendation}`);
  }
  const internetPipesLines = renderInternetPipesCompletenessBlock(input.internetPipes);
  if (internetPipesLines.length > 0) {
    lines.push("", ...internetPipesLines);
  }
  lines.push(
    "",
    "## Source Contract",
    "```json",
    JSON.stringify({
      schema_version: input.payload.schema_version ?? "pos.paperclip_dispatch_gate.v1",
      gate_hash: input.gateHash,
      gate_path: path.resolve(input.gatePath),
      parent_issue_id: input.parentIssueId,
      station: input.station,
      repo: input.payload.repo ?? null,
      route_type: input.payload.route_type ?? null,
      existing_company_id: input.payload.existing_company_id ?? null,
      internet_pipes: input.internetPipes,
    }, null, 2),
    "```",
  );
  return lines.join("\n");
}

function renderExistingVentureGateDescription(input: {
  payload: ExistingVentureGatePayload;
  gateHash: string;
  gatePath: string;
  internetPipes: InternetPipesCompletenessContract | null;
}) {
  const payload = input.payload;
  const missingStations = normalizeStringList(payload.internet_pipes_missing_stations);
  const recommendations = normalizeStringList(payload.internet_pipes_recommendations);
  const lines = [
    normalizeOptionalString(payload.required_next_step) ||
      "Validate this existing venture route before any new-company dispatch path is used.",
    "",
    "## Existing Venture Gate",
    `- Route: ${normalizeOptionalString(payload.status) || "unknown"}`,
    `- Repo: ${normalizeOptionalString(payload.repo) || "unknown"}`,
    `- Existing company: ${normalizeOptionalString(payload.existing_venture_company) || normalizeOptionalString(payload.existing_company_id) || "unknown"}`,
    `- Existing project identity: ${normalizeOptionalString(payload.existing_project_identity) || normalizeOptionalString(payload.existing_repo_project_identity) || "unknown"}`,
    `- Recommended owner: ${normalizeOptionalString(payload.recommended_owner) || "Venture Factory Liaison"}`,
    `- Urgency: ${normalizeOptionalString(payload.urgency) || "medium"}`,
    `- Expected impact: ${normalizeOptionalString(payload.expected_impact) || "Evidence gap closure continues in the existing venture."}`,
    "",
    "## Cake Output Required",
    "- Produce a concrete validation artifact, not a status-only comment.",
    "- Close the buyer/revenue clarity gap or write the exact blocker with owner and next runnable action.",
    "- If the evidence threshold is crossed, create the downstream Paperclip/Hermes execution issue that moves the venture toward a launchable product.",
    "- If the evidence threshold is not crossed, record the no-go rationale so the portfolio loop does not repeat the same hypothesis.",
  ];
  const internetPipesLines = renderInternetPipesCompletenessBlock(input.internetPipes);
  if (internetPipesLines.length > 0) {
    lines.push("", ...internetPipesLines);
  }
  if (missingStations.length > 0) {
    lines.push("", "## Missing Evidence Stations", ...missingStations.map((station) => `- ${station}`));
  }
  if (recommendations.length > 0) {
    lines.push("", "## Recommended Evidence Work", ...recommendations.map((recommendation) => `- ${recommendation}`));
  }
  lines.push(
    "",
    "## Gate Reason",
    normalizeOptionalString(payload.reason) || "No gate reason was provided.",
    "",
    "## Source Contract",
    "```json",
    JSON.stringify({
      schema_version: payload.schema_version ?? "pos.paperclip_dispatch_gate.v1",
      gate_hash: input.gateHash,
      gate_path: path.resolve(input.gatePath),
      status: payload.status ?? null,
      route_type: payload.route_type ?? null,
      repo: payload.repo ?? null,
      existing_company_id: payload.existing_company_id ?? null,
      existing_project_id: payload.existing_project_id ?? null,
      recommended_owner: payload.recommended_owner ?? null,
      internet_pipes: input.internetPipes,
    }, null, 2),
    "```",
  );
  return lines.join("\n");
}

function selectExistingVentureProject(
  projects: PortfolioProject[],
  payload: ExistingVentureGatePayload,
) {
  const explicitProjectId = normalizeOptionalString(payload.existing_project_id);
  if (explicitProjectId) {
    const explicit = projects.find((project) => project.id === explicitProjectId);
    if (explicit) return explicit;
  }
  const identityCandidates = [
    normalizeOptionalString(payload.existing_project_identity),
    normalizeOptionalString(payload.existing_repo_project_identity),
    normalizeOptionalString(payload.repo)?.split("/").pop(),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => candidate.toLowerCase());
  const activeProjects = projects.filter(
    (project) => !TERMINAL_PROJECT_STATUSES.has(String(project.status ?? "").trim().toLowerCase()),
  );
  for (const candidate of identityCandidates) {
    const byName = activeProjects.find((project) => project.name.toLowerCase() === candidate);
    if (byName) return byName;
  }
  const repo = normalizeOptionalString(payload.repo);
  if (repo) {
    const normalizedRepoUrl = normalizeRepoUrl(repo, null);
    const byWorkspace = activeProjects.find((project) => project.workspaces?.some((workspace) => (
      workspace.repoUrl ? normalizeRepoUrl(repo, workspace.repoUrl) === normalizedRepoUrl : false
    )));
    if (byWorkspace) return byWorkspace;
  }
  return activeProjects[0] ?? null;
}

function selectExistingVentureOwnerAgent(
  agents: PortfolioAgent[],
  payload: ExistingVentureGatePayload,
) {
  const activeAgents = agents.filter((agent) => {
    const status = String(agent.status ?? "").trim().toLowerCase();
    return status !== "paused" && status !== "pending_approval" && status !== "terminated";
  });
  const byName = new Map(activeAgents.map((agent) => [agent.name.toLowerCase(), agent]));
  const preferredNames = [
    normalizeOptionalString(payload.recommended_owner),
    "Venture Factory Liaison",
    "Asset Composition Lab",
    "Growth/Distribution",
    "CEO",
  ].filter((name): name is string => Boolean(name));
  for (const name of preferredNames) {
    const exact = byName.get(name.toLowerCase());
    if (exact) return exact;
  }
  return activeAgents[0] ?? null;
}

function existingVentureGateExecutionState(input: {
  payload: ExistingVentureGatePayload;
  gateHash: string;
  gatePath: string;
  internetPipes: InternetPipesCompletenessContract | null;
}) {
  return {
    portfolioExistingVentureGate: {
      version: "portfolio-existing-venture-gate.v1",
      gateHash: input.gateHash,
      gatePath: path.resolve(input.gatePath),
      status: input.payload.status ?? null,
      routeType: input.payload.route_type ?? null,
      repo: input.payload.repo ?? null,
      existingCompanyId: input.payload.existing_company_id ?? null,
      existingProjectId: input.payload.existing_project_id ?? null,
      recommendedOwner: input.payload.recommended_owner ?? null,
      internetPipes: input.internetPipes,
    },
  };
}

async function reconcileExistingVentureStationIssues(input: {
  deps: ExistingVentureGateDeps;
  companyId: string;
  projectId: string | null;
  parentIssue: ExistingVentureGateIssue;
  payload: ExistingVentureGatePayload;
  gateHash: string;
  gatePath: string;
  internetPipes: InternetPipesCompletenessContract | null;
  agents: PortfolioAgent[];
  fallbackOwner: PortfolioAgent | null;
}) {
  const stations = missingExistingVentureStations(input.payload, input.internetPipes);
  let created = 0;
  let updated = 0;
  let wakeQueued = 0;

  for (const station of stations) {
    const owner = selectExistingVentureStationOwnerAgent(input.agents, station, input.fallbackOwner);
    const originId = existingVentureStationOriginId(input.payload, station);
    const spec = existingVentureStationSpec(station);
    const title = `Close ${normalizeOptionalString(input.payload.repo) || "existing venture"} Internet Pipes ${spec.title} station`;
    const description = renderExistingVentureStationDescription({
      payload: input.payload,
      gateHash: input.gateHash,
      gatePath: input.gatePath,
      station,
      parentIssueId: input.parentIssue.id,
      internetPipes: input.internetPipes,
    });
    const executionState = existingVentureStationExecutionState({
      payload: input.payload,
      gateHash: input.gateHash,
      gatePath: input.gatePath,
      station,
      parentIssueId: input.parentIssue.id,
      internetPipes: input.internetPipes,
    });
    const existingCandidates = await input.deps.listIssuesByOrigin(
      input.companyId,
      EXISTING_VENTURE_STATION_ORIGIN_KIND,
      originId,
    );
    const terminalSameHash = selectTerminalSameHashExistingVentureIssue(
      existingCandidates,
      "portfolioExistingVentureStation",
      input.gateHash,
    );
    const existing = selectOpenExistingVentureIssue(existingCandidates);
    if (!existing) {
      if (terminalSameHash) continue;
      const issue = await input.deps.createIssue(input.companyId, {
        projectId: input.projectId,
        parentId: input.parentIssue.id,
        title,
        description,
        status: "todo",
        priority: "high",
        assigneeAgentId: owner?.id ?? null,
        originKind: EXISTING_VENTURE_STATION_ORIGIN_KIND,
        originId,
        executionState,
      });
      created += 1;
      if (owner?.id) {
        await input.deps.wakeAgent(owner.id, issue.id, input.projectId ?? issue.projectId ?? null, input.gateHash);
        wakeQueued += 1;
      }
      continue;
    }

    const nextStatus = ["backlog", "blocked"].includes(existing.status) ? "todo" : undefined;
    const needsStatusReset = Boolean(nextStatus);
    const needsUpdate =
      existing.title !== title ||
      existing.description !== description ||
      (existing.projectId ?? null) !== input.projectId ||
      (existing.parentId ?? null) !== input.parentIssue.id ||
      (existing.assigneeAgentId ?? null) !== (owner?.id ?? null) ||
      needsStatusReset;
    if (!needsUpdate) continue;

    const issue = await input.deps.updateIssue(existing.id, {
      projectId: input.projectId,
      parentId: input.parentIssue.id,
      title,
      description,
      ...(nextStatus ? { status: nextStatus } : {}),
      priority: "high",
      assigneeAgentId: owner?.id ?? null,
      executionState,
    }) ?? existing;
    updated += 1;
    if (owner?.id) {
      await input.deps.wakeAgent(owner.id, issue.id, input.projectId ?? issue.projectId ?? null, input.gateHash);
      wakeQueued += 1;
    }
  }

  return {
    childIssueCount: stations.length,
    childIssuesCreated: created,
    childIssuesUpdated: updated,
    childWakeQueued: wakeQueued,
  };
}

export async function ingestExistingVentureGateFile(
  gatePath: string,
  deps: ExistingVentureGateDeps,
): Promise<ExistingVentureGateResult> {
  const raw = await deps.readFile(gatePath);
  const gateHash = sha256(raw);
  const payload = parseExistingVentureGatePayload(raw);
  if (!isExistingVentureGateRoute(payload)) {
    return { status: "skipped", gateHash, reason: "not_existing_venture_route" };
  }

  const actionability = existingVentureGateActionability(payload);
  if (!actionability.actionable) {
    return {
      status: "skipped",
      gateHash,
      originId: safeExistingVentureGateOriginId(payload),
      companyId: normalizeOptionalString(payload.existing_company_id) || undefined,
      projectId: normalizeOptionalString(payload.existing_project_id) || null,
      wakeQueued: false,
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
      reason: actionability.reason,
    };
  }

  const companyId = normalizeOptionalString(payload.existing_company_id);
  if (!companyId) throw new Error("Existing venture gate is missing existing_company_id.");
  const originId = existingVentureGateOriginId(payload);
  const internetPipes = normalizeInternetPipesSource(payload, "paperclip_dispatch_gate");
  const projects = await deps.listProjects(companyId);
  const project = selectExistingVentureProject(projects, payload);
  const allAgents = await deps.listAgents(companyId);
  const owner = selectExistingVentureOwnerAgent(allAgents, payload);
  const title = `Close existing-venture validation gaps for ${normalizeOptionalString(payload.repo) || "portfolio route"}`;
  const description = renderExistingVentureGateDescription({
    payload,
    gateHash,
    gatePath,
    internetPipes,
  });
  const executionState = existingVentureGateExecutionState({
    payload,
    gateHash,
    gatePath,
    internetPipes,
  });

  const existingCandidates = await deps.listIssuesByOrigin(companyId, EXISTING_VENTURE_GATE_ORIGIN_KIND, originId);
  const terminalSameHash = selectTerminalSameHashExistingVentureIssue(
    existingCandidates,
    "portfolioExistingVentureGate",
    gateHash,
  );
  const existing = selectOpenExistingVentureIssue(existingCandidates);
  const nextStatus = existing && (existing.status === "backlog" || existing.status === "blocked") ? "todo" : undefined;
  if (!existing && terminalSameHash) {
    return {
      status: "skipped",
      gateHash,
      originId,
      companyId,
      projectId: terminalSameHash.projectId ?? project?.id ?? null,
      issueId: terminalSameHash.id,
      assigneeAgentId: terminalSameHash.assigneeAgentId ?? null,
      wakeQueued: false,
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
      reason: "existing_terminal_issue_up_to_date",
    };
  }
  if (existing) {
    const needsUpdate =
      existing.title !== title ||
      existing.description !== description ||
      (project?.id ?? null) !== (existing.projectId ?? null) ||
      (owner?.id ?? null) !== (existing.assigneeAgentId ?? null) ||
      Boolean(nextStatus);
    if (!needsUpdate) {
      const childResult = await reconcileExistingVentureStationIssues({
        deps,
        companyId,
        projectId: existing.projectId ?? project?.id ?? null,
        parentIssue: existing,
        payload,
        gateHash,
        gatePath,
        internetPipes,
        agents: allAgents,
        fallbackOwner: owner,
      });
      if (childResult.childIssuesCreated > 0 || childResult.childIssuesUpdated > 0) {
        return {
          status: "updated",
          gateHash,
          originId,
          companyId,
          projectId: existing.projectId ?? project?.id ?? null,
          issueId: existing.id,
          assigneeAgentId: existing.assigneeAgentId ?? null,
          wakeQueued: false,
          ...childResult,
          reason: "station_child_issues_reconciled",
        };
      }
      return {
        status: "skipped",
        gateHash,
        originId,
        companyId,
        projectId: existing.projectId ?? null,
        issueId: existing.id,
        assigneeAgentId: existing.assigneeAgentId ?? null,
        wakeQueued: false,
        ...childResult,
        reason: "existing_issue_up_to_date",
      };
    }
    const updated = await deps.updateIssue(existing.id, {
      projectId: project?.id ?? null,
      title,
      description,
      ...(nextStatus ? { status: nextStatus } : {}),
      priority: "high",
      assigneeAgentId: owner?.id ?? null,
      executionState,
    });
    const issue = updated ?? existing;
    if (owner?.id) {
      await deps.wakeAgent(owner.id, issue.id, project?.id ?? issue.projectId ?? null, gateHash);
    }
    const childResult = await reconcileExistingVentureStationIssues({
      deps,
      companyId,
      projectId: issue.projectId ?? project?.id ?? null,
      parentIssue: issue,
      payload,
      gateHash,
      gatePath,
      internetPipes,
      agents: allAgents,
      fallbackOwner: owner,
    });
    return {
      status: "updated",
      gateHash,
      originId,
      companyId,
      projectId: issue.projectId ?? project?.id ?? null,
      issueId: issue.id,
      assigneeAgentId: owner?.id ?? issue.assigneeAgentId ?? null,
      wakeQueued: Boolean(owner?.id),
      ...childResult,
    };
  }

  const issue = await deps.createIssue(companyId, {
    projectId: project?.id ?? null,
    title,
    description,
    status: "todo",
    priority: "high",
    assigneeAgentId: owner?.id ?? null,
    originKind: EXISTING_VENTURE_GATE_ORIGIN_KIND,
    originId,
    executionState,
  });
  if (owner?.id) {
    await deps.wakeAgent(owner.id, issue.id, project?.id ?? issue.projectId ?? null, gateHash);
  }
  const childResult = await reconcileExistingVentureStationIssues({
    deps,
    companyId,
    projectId: issue.projectId ?? project?.id ?? null,
    parentIssue: issue,
    payload,
    gateHash,
    gatePath,
    internetPipes,
    agents: allAgents,
    fallbackOwner: owner,
  });
  return {
    status: "created",
    gateHash,
    originId,
    companyId,
    projectId: issue.projectId ?? project?.id ?? null,
    issueId: issue.id,
    assigneeAgentId: owner?.id ?? issue.assigneeAgentId ?? null,
    wakeQueued: Boolean(owner?.id),
    ...childResult,
  };
}

function internetPipesCompletenessFromMetadata(
  metadata: Record<string, unknown>,
): InternetPipesCompletenessContract | null {
  const sourceRecord = asRecord(metadata.internet_pipes);
  if (!sourceRecord) return null;
  const score = normalizeOptionalNumber(sourceRecord.score);
  const readiness = normalizeOptionalString(sourceRecord.readiness);
  const missingStations = normalizeStringList(sourceRecord.missing_stations);
  const recommendations = normalizeStringList(sourceRecord.recommendations);
  if (score === null && !readiness && missingStations.length === 0 && recommendations.length === 0) {
    return null;
  }
  return {
    score,
    readiness,
    missing_stations: missingStations,
    recommendations,
    source: normalizeOptionalString(sourceRecord.source) || "portfolio_dispatch_contract",
  };
}

function renderInternetPipesGateLines(metadata: Record<string, unknown>) {
  const internetPipes = internetPipesCompletenessFromMetadata(metadata);
  const block = renderInternetPipesCompletenessBlock(internetPipes);
  if (block.length === 0) return [];
  return [
    ...block,
    "If readiness is not `alpha_ready` or `factory_ready`, or missing stations are present, keep the run in evidence backfill and record the exact station blocker before release movement.",
  ];
}

function issueDescriptionFromTask(input: {
  task: DispatchTask;
  metadata: Record<string, unknown>;
}) {
  const acceptanceCriteria = input.task.acceptance_criteria ?? [];
  const lines = [input.task.summary?.trim() || "Execute the assigned dispatch task."];
  const internetPipesLines = renderInternetPipesGateLines(input.metadata);
  if (internetPipesLines.length > 0) {
    lines.push("", ...internetPipesLines);
  }
  lines.push(
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria.map((line) => `- ${line}`),
    "",
    renderMetadataBlock(input.metadata),
  );
  return lines.join("\n");
}

function projectDescriptionFromDispatch(input: {
  payload: PortfolioDispatchPayload;
  metadata: Record<string, unknown>;
}) {
  const launchTarget = input.payload.selection_snapshot?.launch_target;
  const artifacts = input.payload.selection_snapshot?.artifacts;
  return [
    `Paperclip cockpit project for run \`${input.metadata.run_id}\`.`,
    "",
    launchTarget?.strongest_wedge ? `Wedge: ${launchTarget.strongest_wedge}` : "",
    launchTarget?.recommended_offer_angle ? `Offer angle: ${launchTarget.recommended_offer_angle}` : "",
    artifacts?.scaffold_dir ? `Scaffold dir: ${artifacts.scaffold_dir}` : "",
    artifacts?.launch_packet_path ? `Launch packet: ${artifacts.launch_packet_path}` : "",
    "",
    ...renderInternetPipesGateLines(input.metadata),
    "",
    renderMetadataBlock(input.metadata),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function parseDispatchPayload(raw: string): PortfolioDispatchPayload {
  const parsed = JSON.parse(raw) as PortfolioDispatchPayload;
  if (!parsed.run_id || !parsed.target_repo_full_name) {
    throw new Error("Dispatch payload is missing required run or repo fields.");
  }
  return parsed;
}

function dispatchRepoArtifactSlug(repoFullName: string) {
  return repoFullName.replace("/", "-").toLowerCase();
}

async function readJsonObjectFromFs(filePath: string | null | undefined) {
  const normalized = filePath?.trim();
  if (!normalized) return {} as Record<string, unknown>;
  const raw = await fs.readFile(normalized, "utf8").catch(() => "");
  if (!raw.trim()) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

function compatibilityDossierGateStatus(payload: PortfolioDispatchPayload) {
  const candidate = String(
    payload.dossier_contract?.gate_statuses?.[payload.target_repo_full_name?.trim() ?? ""]
      ?? "APPROVED_NO_CONFLICT",
  ).trim();
  return ALLOWED_DOSSIER_GATE_STATUSES.has(candidate) ? candidate : "APPROVED_NO_CONFLICT";
}

function compatibilityDossierFreshnessStatus(input: {
  inventoryDetail: Record<string, unknown>;
  pendingSemanticReview: boolean;
}) {
  if (input.pendingSemanticReview) return "stale";
  const normalized = String(input.inventoryDetail.freshness_status ?? "").trim().toLowerCase();
  if (normalized === "pending_semantic_review") return "stale";
  return "fresh";
}

function normalizeJsonHash(raw: string) {
  return sha256(JSON.stringify(JSON.parse(raw)));
}

type SelectionSnapshotContractResolution = {
  selectionSnapshotHash: string;
};

async function resolveSelectionSnapshotContract(input: {
  payload: PortfolioDispatchPayload;
  dispatchPath: string;
  deps: Pick<PortfolioDispatchIngestDeps, "readFile" | "logWarn">;
}): Promise<SelectionSnapshotContractResolution> {
  const declaredHash = input.payload.selection_snapshot_hash?.trim() || "";
  const embeddedSnapshot = input.payload.selection_snapshot ?? null;
  const embeddedHash = embeddedSnapshot ? sha256(JSON.stringify(embeddedSnapshot)) : "";

  if (declaredHash && embeddedHash && declaredHash !== embeddedHash) {
    throw new Error(
      `Dispatch selection snapshot hash mismatch: declared ${declaredHash} does not match embedded selection_snapshot hash ${embeddedHash}.`,
    );
  }

  const selectionSnapshotHash = declaredHash || embeddedHash;
  if (!selectionSnapshotHash) {
    throw new Error("Dispatch payload is missing selection_snapshot_hash and embedded selection_snapshot.");
  }

  const advisoryPaths = new Map<string, string>();
  const captureAdvisoryPath = (kind: string, candidate: string | null | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed || advisoryPaths.has(trimmed)) return;
    advisoryPaths.set(trimmed, kind);
  };

  const selectionSnapshotArtifacts = input.payload.selection_snapshot?.artifacts as
    | {
        scaffold_snapshot_path?: string | null;
        packet_snapshot_path?: string | null;
      }
    | null
    | undefined;

  captureAdvisoryPath("selection_snapshot_path", input.payload.selection_snapshot_path);
  captureAdvisoryPath("packet_snapshot_path", input.payload.packet_snapshot_path);
  captureAdvisoryPath("artifacts.scaffold_snapshot_path", selectionSnapshotArtifacts?.scaffold_snapshot_path);
  captureAdvisoryPath("artifacts.packet_snapshot_path", selectionSnapshotArtifacts?.packet_snapshot_path);

  for (const [snapshotPath, pathKind] of advisoryPaths.entries()) {
    try {
      const normalizedFileHash = normalizeJsonHash(await input.deps.readFile(snapshotPath));
      if (normalizedFileHash !== selectionSnapshotHash) {
        input.deps.logWarn("portfolio dispatch advisory selection snapshot path drift", {
          runId: input.payload.run_id,
          dispatchPath: path.resolve(input.dispatchPath),
          pathKind,
          snapshotPath: path.resolve(snapshotPath),
          canonicalSelectionSnapshotHash: selectionSnapshotHash,
          observedSelectionSnapshotHash: normalizedFileHash,
        });
      }
    } catch (error) {
      input.deps.logWarn("portfolio dispatch advisory selection snapshot path unreadable", {
        runId: input.payload.run_id,
        dispatchPath: path.resolve(input.dispatchPath),
        pathKind,
        snapshotPath: path.resolve(snapshotPath),
        canonicalSelectionSnapshotHash: selectionSnapshotHash,
        error: String(error),
      });
    }
  }

  return { selectionSnapshotHash };
}

async function ensureLegacyDispatchDossierCompatibility(
  payload: PortfolioDispatchPayload,
  dispatchPath: string,
) {
  if (payload.selected_repo_dossier_path?.trim() && payload.selected_repo_dossier_hash?.trim()) {
    return payload;
  }

  const targetRepoFullName =
    payload.target_repo_full_name?.trim()
    || payload.selection_snapshot?.launch_target?.repo?.trim()
    || "";
  const selectionSnapshotPath = payload.selection_snapshot_path?.trim() || "";
  if (!targetRepoFullName || !selectionSnapshotPath) {
    return payload;
  }

  const portfolioOsDir = payload.cockpit?.portfolio_os_dir?.trim() || DEFAULT_POS_DIR;
  const artifactSlug = dispatchRepoArtifactSlug(targetRepoFullName);
  const inventoryDetailPath = path.join(portfolioOsDir, "data", "repo_inventory_detail", `${artifactSlug}.json`);
  const repoThesisPath = path.join(portfolioOsDir, "data", "repo_thesis", `${artifactSlug}.json`);
  const [inventoryDetail, repoThesis] = await Promise.all([
    readJsonObjectFromFs(inventoryDetailPath),
    readJsonObjectFromFs(repoThesisPath),
  ]);

  const pendingSemanticReview =
    Boolean(payload.selection_snapshot?.frozen_bundle?.pending_semantic_review)
    || String(inventoryDetail.freshness_status ?? "").trim().toLowerCase() === "pending_semantic_review";
  const gateStatus = compatibilityDossierGateStatus(payload);
  const freshnessStatus = compatibilityDossierFreshnessStatus({
    inventoryDetail,
    pendingSemanticReview,
  });
  const dossierPath = path.resolve(path.dirname(selectionSnapshotPath || dispatchPath), "selected_repo_dossier.json");
  const dossierPayload = {
    schema_version: "pos.selected_repo_dossier.v1",
    generated_at: payload.generated_at?.trim() || new Date().toISOString(),
    identity: {
      full_name: targetRepoFullName,
      repo_url:
        payload.selection_snapshot?.launch_target?.repo_url?.trim()
        || String(inventoryDetail.repo_url ?? "").trim(),
      robust_branch:
        payload.selection_snapshot?.launch_target?.robust_branch?.trim()
        || payload.target_repo_branch?.trim()
        || "main",
      source_type: String(repoThesis.source_type ?? inventoryDetail.source_type ?? "").trim(),
    },
    stage_0_gate_receipt: {
      gate_status: gateStatus,
      decision: {
        status: gateStatus,
      },
    },
    inventory_summary: {
      freshness_status: freshnessStatus,
      source_freshness_status: String(inventoryDetail.freshness_status ?? "").trim() || "unknown",
      inventory_built_at: String(inventoryDetail.inventory_built_at ?? "").trim(),
      selected_branch:
        String(inventoryDetail.selected_branch ?? "").trim()
        || payload.selection_snapshot?.launch_target?.robust_branch?.trim()
        || payload.target_repo_branch?.trim()
        || "main",
      selected_branch_commit_sha: String(inventoryDetail.selected_branch_commit_sha ?? "").trim(),
      selected_branch_commit_at: String(inventoryDetail.selected_branch_commit_at ?? "").trim(),
    },
    semantic_review: {
      pending_semantic_review: pendingSemanticReview,
      semantic_review_at: String((inventoryDetail.semantic_review as Record<string, unknown> | undefined)?.semantic_review_at ?? "").trim(),
      last_reviewed_commit_sha: String((inventoryDetail.semantic_review as Record<string, unknown> | undefined)?.last_reviewed_commit_sha ?? "").trim(),
      last_reviewed_commit_at: String((inventoryDetail.semantic_review as Record<string, unknown> | undefined)?.last_reviewed_commit_at ?? "").trim(),
    },
    thesis_summary: {
      strongest_wedge:
        payload.selection_snapshot?.launch_target?.strongest_wedge?.trim()
        || String(repoThesis.strongest_wedge ?? "").trim(),
      likely_user: String(repoThesis.likely_user ?? "").trim(),
      likely_buyer: String(repoThesis.likely_buyer ?? "").trim(),
      likely_problem: String(repoThesis.likely_problem ?? "").trim(),
      likely_outcome: String(repoThesis.likely_outcome ?? "").trim(),
    },
    dispatch_context: {
      run_id: payload.run_id?.trim() || "",
      selection_snapshot_hash: payload.selection_snapshot_hash?.trim() || "",
      selection_snapshot_path: selectionSnapshotPath,
      repo_thesis_path: repoThesisPath,
      inventory_detail_path: inventoryDetailPath,
      source_dispatch_path: path.resolve(dispatchPath),
    },
  };
  const dossierRaw = JSON.stringify(dossierPayload, null, 2) + "\n";
  const dossierHash = createHash("sha256").update(dossierRaw).digest("hex");
  await fs.mkdir(path.dirname(dossierPath), { recursive: true });
  await fs.writeFile(dossierPath, dossierRaw, "utf8");

  payload.selected_repo_dossier_path = dossierPath;
  payload.selected_repo_dossier_hash = dossierHash;
  payload.dossier_contract = {
    selected_repo_dossier: {
      repo: targetRepoFullName,
      dossier_path: dossierPath,
      dossier_hash: dossierHash,
      inventory_built_at: String(dossierPayload.inventory_summary.inventory_built_at ?? "").trim(),
      semantic_review_at: String(dossierPayload.semantic_review.semantic_review_at ?? "").trim(),
    },
    pending_semantic_review: pendingSemanticReview,
    gate_statuses: {
      [targetRepoFullName]: gateStatus,
    },
    freshness_statuses: {
      [targetRepoFullName]: freshnessStatus,
    },
  };
  return payload;
}

type VerifiedDossierContract = {
  dossierPath: string;
  dossierHash: string;
  gateStatus: string;
  freshnessStatus: string;
};

async function validateDossierContract(
  payload: PortfolioDispatchPayload,
  deps: Pick<PortfolioDispatchIngestDeps, "readFile">,
): Promise<VerifiedDossierContract> {
  const targetRepoFullName = payload.target_repo_full_name?.trim();
  const contract = payload.dossier_contract ?? {};
  const selected = contract.selected_repo_dossier ?? {};
  const dossierPath = payload.selected_repo_dossier_path?.trim() || selected.dossier_path?.trim() || "";
  const dossierHash = payload.selected_repo_dossier_hash?.trim() || selected.dossier_hash?.trim() || "";

  if (!dossierPath) {
    throw new Error("Dispatch payload is missing selected_repo_dossier_path.");
  }
  if (!dossierHash) {
    throw new Error("Dispatch payload is missing selected_repo_dossier_hash.");
  }

  let dossierRaw = "";
  try {
    dossierRaw = await deps.readFile(dossierPath);
  } catch (error) {
    throw new Error(`Dispatch dossier could not be loaded at ${dossierPath}: ${String(error)}`);
  }

  let dossier: any = null;
  try {
    dossier = JSON.parse(dossierRaw);
  } catch {
    throw new Error(`Dispatch dossier is not valid JSON at ${dossierPath}.`);
  }

  const dossierRepo = String(dossier?.identity?.full_name ?? "").trim();
  if (!dossierRepo || dossierRepo !== targetRepoFullName) {
    throw new Error(`Dispatch dossier repo mismatch: expected ${targetRepoFullName}, got ${dossierRepo || "missing"}.`);
  }

  const gateStatus = String(
    dossier?.stage_0_gate_receipt?.gate_status
      ?? dossier?.stage_0_gate_receipt?.decision?.status
      ?? contract.gate_statuses?.[targetRepoFullName ?? ""]
      ?? "NOT_CHECKED",
  ).trim();
  if (!ALLOWED_DOSSIER_GATE_STATUSES.has(gateStatus)) {
    throw new Error(`Dispatch dossier gate status ${gateStatus} is not allowed for Paperclip ingest.`);
  }

  const freshnessStatus = String(
    dossier?.inventory_summary?.freshness_status
      ?? contract.freshness_statuses?.[targetRepoFullName ?? ""]
      ?? "unknown",
  ).trim();
  if (freshnessStatus !== "fresh") {
    throw new Error(`Dispatch dossier freshness ${freshnessStatus} is not eligible for Paperclip ingest.`);
  }

  if (contract.pending_semantic_review) {
    throw new Error("Dispatch dossier indicates pending semantic review and cannot be ingested.");
  }

  return {
    dossierPath,
    dossierHash,
    gateStatus,
    freshnessStatus,
  };
}

function taskGroupEntries(payload: PortfolioDispatchPayload) {
  return Object.entries(payload.execution_manifest?.task_groups ?? {});
}

function dispatchTargetLocator(payload: PortfolioDispatchPayload) {
  return payload.execution_manifest?.repo_target ?? {
    target_repo_full_name: payload.target_repo_full_name,
    target_repo_branch: payload.target_repo_branch,
    target_repo_clone_path_hint: payload.target_repo_clone_path_hint,
  };
}

const AGENT_BLUEPRINTS = [
  {
    key: "CEO",
    name: "CEO",
    role: "ceo",
    title: "CEO",
    reportsTo: null,
    capabilities: "Strategy, wedge acceptance, and launch execution governance.",
  },
  {
    key: "CTO",
    name: "CTO",
    role: "cto",
    title: "CTO",
    reportsTo: "CEO",
    capabilities: "Architecture planning, branch strategy, and engineering milestones.",
  },
  {
    key: "CMO",
    name: "CMO",
    role: "cmo",
    title: "CMO",
    reportsTo: "CEO",
    capabilities: "Positioning, launch messaging, and demand creation.",
  },
  {
    key: "Engineer-1",
    name: "Engineer-1",
    role: "engineer",
    title: "Engineer-1",
    reportsTo: "CTO",
    capabilities: "Primary implementation owner for the target repository.",
  },
  {
    key: "Engineer-2",
    name: "Engineer-2",
    role: "engineer",
    title: "Engineer-2",
    reportsTo: "CTO",
    capabilities: "Parallel implementation and support for the target repository.",
  },
  {
    key: "Designer/Copy",
    name: "Designer/Copy",
    role: "designer",
    title: "Designer/Copy",
    reportsTo: "CMO",
    capabilities: "Landing pages, copy, and creative execution assets.",
  },
  {
    key: "QA",
    name: "QA",
    role: "qa",
    title: "QA",
    reportsTo: "CTO",
    capabilities: "Browser QA, regression checks, and release verification.",
  },
  {
    key: "Release Manager",
    name: "Release Manager",
    role: "devops",
    title: "Release Manager",
    reportsTo: "CTO",
    capabilities: "Push-on-green discipline, merge gating, and release notes.",
  },
  {
    key: "Growth/Distribution",
    name: "Growth/Distribution",
    role: "general",
    title: "Growth/Distribution",
    reportsTo: "CMO",
    capabilities: "Distribution, outreach, and launch amplification.",
  },
];

const ISSUE_ASSIGNEE_BY_FUNCTION: Record<string, string> = {
  CEO: "CEO",
  CTO: "CTO",
  Engineer: "Engineer-1",
  QA: "QA",
  Marketing: "CMO",
  Release: "Release Manager",
};

function issueExecutionPolicyForFunction(
  functionName: string,
  agentByName: Map<string, PortfolioAgent>,
) {
  if (functionName !== "Engineer") return null;
  const qaAgentId = agentByName.get("QA")?.id ?? null;
  const releaseManagerId = agentByName.get("Release Manager")?.id ?? null;
  if (!qaAgentId || !releaseManagerId) return null;
  return normalizeIssueExecutionPolicy({
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        type: "review",
        participants: [{ type: "agent", agentId: qaAgentId }],
      },
      {
        type: "approval",
        participants: [{ type: "agent", agentId: releaseManagerId }],
      },
    ],
  });
}

const PORTFOLIO_ROUTINE_TIME_ZONE = "America/New_York";

type RoutineBlueprint = {
  key: string;
  title: string;
  assigneeName: string;
  priority: "high" | "medium";
  cronExpression: string;
  triggerLabel: string;
  parentIssueFunction?: string;
  description(input: {
    payload: PortfolioDispatchPayload;
    metadata: Record<string, unknown>;
    clonePath: string;
    runBranch: string;
    baseBranch: string;
    approvalId: string;
  }): string;
};

function isDispatchPollerIsolatedBranchValidationEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV];
  if (!raw || raw.trim() === "") return DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_DEFAULT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") return true;
  return DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_DEFAULT;
}

const ROUTINE_BLUEPRINTS: RoutineBlueprint[] = [
  {
    key: "dispatch-poller",
    title: "Dispatch Poller",
    assigneeName: "Release Manager",
    priority: "medium",
    cronExpression: "*/30 * * * *",
    triggerLabel: "Every 30 minutes",
    parentIssueFunction: "Release",
    description: ({ metadata, clonePath, runBranch }) => {
      const isolationEnabled = isDispatchPollerIsolatedBranchValidationEnabled();
      const branchValidationMode = isolationEnabled ? "isolated" : "legacy_shared_checkout";
      const branchValidationLines = isolationEnabled
        ? [
          "Validate expected branch in an isolated workspace context: prefer task-session/worktree (`PAPERCLIP_WORKSPACE_SOURCE != project_primary`) before any branch inspection command.",
          "If only shared workspace context is available, do not checkout/switch/reset in-place; use metadata comparison (`project.codebase.repoRef` vs `suggested_branch_name`) and record a shared-workspace warning.",
          "Emit deterministic branch telemetry with keys: `run_id`, `workspace_id`, `workspace_source`, `branch_owner`, `expected_branch`, `observed_branch`, `observed_head_ref`, `observed_head_sha`.",
          "Resolve `branch_owner` from `paperclipWorkspace.branchOwner` when non-null (isolated worktree). Fallback: if `paperclipWorkspace.branchOwner` is null, log `branch_owner=unknown` and escalate as a blocker for contract/schema follow-up before merge.",
          "Preserve mismatch surfacing with remediation links to the current poller issue, parent release issue, and launch approval.",
          "Do not force branch switching inside shared dirty workspaces. Do not rewrite the dispatch artifact.",
        ]
        : [
          "Legacy branch validation mode is active: confirm the target repo remains on the run branch and repair drift directly in the shared clone if needed.",
          "This rollback mode may mutate shared clone branch state via checkout/switch operations; use it only for emergency fallback while isolation mode is disabled.",
          "Preserve mismatch surfacing with remediation links to the current poller issue, parent release issue, and launch approval.",
          "Do not rewrite the dispatch artifact.",
        ];

      return [
        "Reconcile this run against the immutable Portfolio OS dispatch contract.",
        "",
        `Dispatch file: ${metadata.source_dispatch_path}`,
        `Dispatch hash: ${metadata.dispatch_hash}`,
        `Target clone: ${clonePath}`,
        `Expected run branch: ${runBranch}`,
        "",
        "Canonical contract hash source order:",
        "1. Approved `launch_execution` payload fields `dispatch_hash` + `selection_snapshot_hash`.",
        "2. Issue contract block `dispatch_hash` + `selection_snapshot_hash` when approval payload is unavailable.",
        "3. If neither source is available, emit `missing contract source` and stop.",
        "Treat `selection_snapshot_path` and packet snapshot paths as advisory provenance only, never as canonical hash authority for historical runs.",
        "Never treat local dispatch artifact bytes as the canonical hash source.",
        "Compute local file SHA only for advisory drift evidence against the canonical source.",
        "Invariant (required for every run, including `20260410T005324Z`): compare canonical dispatch hash against SHA-256 of `source_dispatch_path`.",
        "Emit an actionable `dispatch_parity_invariant` payload with keys: `run_id`, `dispatch_path`, `canonical_hash`, `observed_hash`, `parity_status`, `poller_state`.",
        "Emit exactly one explicit poller state in your report:",
        "- `contract mismatch`: canonical source mismatch, canonical ledger/linkage mismatch, or missing seeded issue/approval links.",
        "- `artifact drift`: canonical source and linkage align, but local artifact hash differs.",
        "- `missing contract source`: canonical hash source cannot be resolved.",
        "`artifact drift` alone must not block release gating.",
        `Branch validation mode: ${branchValidationMode} (${DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV}=${isolationEnabled ? "true" : "false"}).`,
        ...branchValidationLines,
        "",
        ...renderInternetPipesGateLines(metadata),
        "",
        renderMetadataBlock({
          ...metadata,
          routine_key: "dispatch-poller",
          paperclip_actionability: routineActionabilityContract({
            key: "dispatch-poller",
            metadata,
            clonePath,
          }),
        }),
      ].join("\n");
    },
  },
  {
    key: "run-qa-sweep",
    title: "Run QA Sweep",
    assigneeName: "QA",
    priority: "high",
    cronExpression: "15 */4 * * *",
    triggerLabel: "Every 4 hours",
    parentIssueFunction: "QA",
    description: ({ payload, metadata, clonePath }) => [
      "Run a QA sweep for the current Portfolio OS dispatch using gstack.",
      "",
      `Primary artifact: ${metadata.source_dispatch_path}`,
      payload.selection_snapshot_path ? `Selection snapshot: ${payload.selection_snapshot_path}` : "",
      payload.selection_snapshot?.artifacts?.scaffold_dir ? `Scaffold dir: ${payload.selection_snapshot.artifacts.scaffold_dir}` : "",
      metadata.target_repo_ref ? `Release target branch: ${metadata.target_repo_ref}` : "",
      "",
      "Use `/pos-run-qa` first, then use `/qa` or `/review` if the flow needs a narrower regression pass.",
      "State explicitly whether the validated batch is ready to land to the release target branch, or name the blocker that still prevents landing.",
      "Write `qa_report.md`, screenshots, and regression notes into the target repo or scaffold outputs for this run.",
      "",
      ...renderInternetPipesGateLines(metadata),
      "",
      renderMetadataBlock({
        ...metadata,
        routine_key: "run-qa-sweep",
        paperclip_actionability: routineActionabilityContract({
          key: "run-qa-sweep",
          metadata,
          clonePath,
        }),
      }),
    ].filter((line) => line !== "").join("\n"),
  },
  {
    key: "evidence-backfill-reconciler",
    title: "Evidence Backfill Reconciler",
    assigneeName: "Growth/Distribution",
    priority: "medium",
    cronExpression: "45 9,15,21 * * *",
    triggerLabel: "Three times daily",
    parentIssueFunction: "Marketing",
    description: ({ payload, metadata, clonePath }) => [
      "Backfill any missing evidence that still blocks this run.",
      "",
      `Primary artifact: ${payload.selection_snapshot_path ?? metadata.source_dispatch_path}`,
      "Use `/pos-evidence-backfill` with the current dispatch or selection snapshot.",
      "Write `evidence_<run_id>.json` into Portfolio OS inbox and link any new citations back to the active work.",
      "",
      ...renderInternetPipesGateLines(metadata),
      "",
      renderMetadataBlock({
        ...metadata,
        routine_key: "evidence-backfill-reconciler",
        paperclip_actionability: routineActionabilityContract({
          key: "evidence-backfill-reconciler",
          metadata,
          clonePath,
        }),
      }),
    ].join("\n"),
  },
  {
    key: "release-gate-reconciler",
    title: "Release Gate Reconciler",
    assigneeName: "Release Manager",
    priority: "high",
    cronExpression: "0 */2 * * *",
    triggerLabel: "Every 2 hours",
    parentIssueFunction: "Release",
    description: ({ metadata, clonePath, runBranch, baseBranch, approvalId }) => [
      "Reconcile merge readiness, approval state, and ship discipline for this run.",
      "",
      `Target clone: ${clonePath}`,
      `Expected run branch: ${runBranch}`,
      `Release target branch: ${baseBranch}`,
      `launch_execution approval: ${approvalId}`,
      "",
      "Inspect open implementation, QA, and evidence issues. Use `/review` before merge movement and `/ship` when the branch is ready to land.",
      "Treat the run branch as a staging lane only. QA-cleared work is not done until it lands on the release target branch locally and the matching origin branch is updated.",
      "Do not leave the latest good state only on a run branch or only on the local machine after release readiness is established.",
      "Before closing the release pass, verify the shipped commit is reachable from both the local release target branch and the matching origin branch, then record the commit, merge, or PR reference.",
      "Release/tag lineage checks must not rely on shallow local ancestry. Before declaring a tag orphaned or a release missing from the target branch, run `git rev-parse --is-shallow-repository`; if true, run `git fetch --unshallow --tags origin` (or `git fetch --tags origin` if already complete), then verify with `git merge-base --is-ancestor <tag>^{} origin/<branch>` or an authenticated GitHub compare. If local and remote evidence disagree, treat the local shallow result as invalid and record remote compare evidence.",
      "If the local release target branch and the matching origin branch diverge, treat that as a blocker and record the exact remediation path.",
      "If merge or deploy remains blocked, record the exact blocker and approval status instead of claiming progress.",
      "",
      ...renderInternetPipesGateLines(metadata),
      "",
      renderMetadataBlock({
        ...metadata,
        routine_key: "release-gate-reconciler",
        approval_id: approvalId,
        paperclip_actionability: routineActionabilityContract({
          key: "release-gate-reconciler",
          metadata,
          clonePath,
        }),
      }),
    ].join("\n"),
  },
];

function assertPortfolioRoutineCoverage() {
  assertRoutineCoverage(ROUTINE_BLUEPRINTS.map((blueprint) => blueprint.key));
}

function deriveRoutineTitle(runId: string, title: string) {
  return `[run_id:${runId}] ${title}`;
}

function routineActionabilityContract(input: {
  key: string;
  metadata: Record<string, unknown>;
  clonePath?: string | null;
}) {
  const runId = normalizeOptionalString(input.metadata.run_id);
  const dispatchHash = normalizeOptionalString(input.metadata.dispatch_hash);
  const selectionSnapshotHash = normalizeOptionalString(input.metadata.selection_snapshot_hash);
  const base = {
    contractVersion: "paperclip.actionability.v1",
    runId,
    blockerOwner: "agent",
    nextActionOwner: "agent",
    upstreamArtifactHash: [dispatchHash, selectionSnapshotHash].filter(Boolean).join(":") || null,
    requireUpstreamChange: true,
    blockerFingerprint: [
      runId,
      input.key,
      dispatchHash,
      selectionSnapshotHash,
    ].filter(Boolean).join(":"),
  };

  switch (input.key) {
    case "dispatch-poller":
      return {
        ...base,
        lane: "release",
        state: "ready_for_agent",
        blockerClass: "dispatch_parity",
        minIntervalMinutes: 30,
      };
    case "run-qa-sweep":
      return {
        ...base,
        lane: "qa",
        state: "ready_for_qa",
        blockerClass: "qa_gate",
        requireCleanWorkspace: true,
        workspaceCwd: input.clonePath ?? null,
        minIntervalMinutes: 240,
      };
    case "evidence-backfill-reconciler":
      return {
        ...base,
        lane: "maintenance",
        state: "maintenance_due",
        blockerClass: "evidence_backfill",
        minIntervalMinutes: 480,
      };
    case "release-gate-reconciler":
      return {
        ...base,
        lane: "release",
        state: "ready_to_ship",
        blockerClass: "release_gate",
        requireCleanWorkspace: true,
        workspaceCwd: input.clonePath ?? null,
        shipCaptain: true,
        minIntervalMinutes: 120,
      };
    default:
      return {
        ...base,
        lane: "maintenance",
        state: "maintenance_due",
        blockerClass: "routine",
      };
  }
}

async function ensureGstackSkillLinkFromFs(options?: {
  sourceDir?: string;
  linkPath?: string;
}) {
  const sourceDir = options?.sourceDir ?? process.env.PAPERCLIP_POS_GSTACK_DIR ?? DEFAULT_GSTACK_DIR;
  const linkPath = options?.linkPath ?? DEFAULT_GSTACK_SKILL_LINK;
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const existing = await fs.lstat(linkPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const target = await fs.realpath(linkPath).catch(() => null);
      if (target) return;
      await fs.unlink(linkPath).catch(() => {});
    } else {
      return;
    }
  }
  await fs.symlink(sourceDir, linkPath);
}

export async function ensureTargetRepoCloneAndRunBranch(input: {
  repoFullName: string;
  repoUrl: string;
  clonePathHint: string;
  baseBranch: string;
  runBranch: string;
}) {
  const clonePath = path.resolve(input.clonePathHint);
  const gitDir = path.join(clonePath, ".git");
  const exists = await fs.stat(clonePath).then(() => true).catch(() => false);
  if (!exists) {
    await fs.mkdir(path.dirname(clonePath), { recursive: true });
    await execFile("git", ["clone", input.repoUrl, clonePath]);
  } else {
    const hasGit = await fs.stat(gitDir).then((entry) => entry.isDirectory()).catch(() => false);
    if (!hasGit) {
      throw new Error(`Target clone path exists but is not a git checkout: ${clonePath}`);
    }
  }

  await execFile("git", ["-C", clonePath, "fetch", "origin"]);

  const localBranchExists = await execFile("git", ["-C", clonePath, "rev-parse", "--verify", input.runBranch])
    .then(() => true)
    .catch(() => false);
  if (localBranchExists) {
    await execFile("git", ["-C", clonePath, "checkout", input.runBranch]);
    return { clonePath, runBranch: input.runBranch };
  }

  const remoteBase = `origin/${input.baseBranch}`;
  const baseRefExists = await execFile("git", ["-C", clonePath, "rev-parse", "--verify", remoteBase])
    .then(() => true)
    .catch(() => false);
  await execFile("git", [
    "-C",
    clonePath,
    "checkout",
    "-b",
    input.runBranch,
    baseRefExists ? remoteBase : input.baseBranch,
  ]);
  return { clonePath, runBranch: input.runBranch };
}

async function readDispatchLedgerFromFs(ledgerPath: string) {
  const raw = await fs.readFile(ledgerPath, "utf8").catch(() => "{\"ingested\":{}}");
  try {
    return normalizeDispatchLedger(JSON.parse(raw));
  } catch {
    return { ingested: {} };
  }
}

async function writeDispatchLedgerToFs(ledgerPath: string, ledger: DispatchLedger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export async function ingestPortfolioDispatchFile(
  dispatchPath: string,
  deps: PortfolioDispatchIngestDeps,
): Promise<DispatchIngestResult> {
  const raw = await deps.readFile(dispatchPath);
  const dispatchHash = sha256(raw);
  const payload = parseDispatchPayload(raw);
  const runId = payload.run_id!;
  const ledger = await deps.readDispatchLedger();
  const runEntries = dispatchLedgerEntriesForRun(ledger, runId);
  if (runEntries.length > 0) {
    const canonicalRunEntry = selectCanonicalRunLedgerEntry(runEntries);
    const canonicalDispatchHash = canonicalRunEntry.entry.dispatchHash?.trim() || canonicalRunEntry.hash;
    const removedDispatchHashes = pruneRunLedgerEntries(ledger, runId, canonicalRunEntry.hash);
    if (removedDispatchHashes.length > 0) {
      await deps.writeDispatchLedger(ledger);
      deps.logWarn("portfolio dispatch run ledger duplicates pruned", {
        runId,
        canonicalDispatchHash,
        removedDispatchHashes,
      });
    }
    if (canonicalDispatchHash !== dispatchHash) {
      deps.logWarn("portfolio dispatch run hash drift ignored", {
        runId,
        canonicalDispatchHash,
        observedDispatchHash: dispatchHash,
        sourceDispatchPath: path.resolve(dispatchPath),
      });
    }
    return {
      status: "skipped",
      dispatchHash: canonicalDispatchHash,
      runId: canonicalRunEntry.entry.runId,
      companyId: canonicalRunEntry.entry.companyId,
      projectId: canonicalRunEntry.entry.projectId,
      issueIds: canonicalRunEntry.entry.issueIds,
      approvalIds: canonicalRunEntry.entry.approvalIds,
    };
  }

  const existingEntry = ledger.ingested[dispatchHash];
  if (existingEntry) {
    return {
      status: "skipped",
      dispatchHash,
      runId: existingEntry.runId,
      companyId: existingEntry.companyId,
      projectId: existingEntry.projectId,
      issueIds: existingEntry.issueIds,
      approvalIds: existingEntry.approvalIds,
    };
  }

  assertPortfolioRoutineCoverage();
  await ensureLegacyDispatchDossierCompatibility(payload, dispatchPath);
  const repoLocator = dispatchTargetLocator(payload);
  const targetRepoFullName = repoLocator.target_repo_full_name?.trim() || payload.target_repo_full_name!.trim();
  const targetRepoRef = repoLocator.target_repo_branch?.trim() || payload.target_repo_branch?.trim() || "main";
  const clonePathHint = repoLocator.target_repo_clone_path_hint?.trim()
    || payload.target_repo_clone_path_hint?.trim()
    || path.resolve("/Users/mnm/Documents/Github", targetRepoFullName.split("/").pop() ?? targetRepoFullName);
  const suggestedBranchName = repoLocator.suggested_branch_name?.trim() || `run/${runId}/bootstrap`;
  const repoUrl = normalizeRepoUrl(targetRepoFullName, repoLocator.repo_url);
  const { selectionSnapshotHash } = await resolveSelectionSnapshotContract({
    payload,
    dispatchPath,
    deps,
  });
  const verifiedDossier = await validateDossierContract(payload, deps);
  const internetPipesCompleteness = internetPipesCompletenessFromPayload(payload);
  const baseMetadataContract = {
    ...buildMetadataContract({
      runId,
      dispatchHash,
      selectionSnapshotHash,
      targetRepoFullName,
      targetRepoRef,
      suggestedBranchName,
      sourceDispatchPath: path.resolve(dispatchPath),
    }),
    selected_repo_dossier_path: verifiedDossier.dossierPath,
    selected_repo_dossier_hash: verifiedDossier.dossierHash,
    dossier_gate_status: verifiedDossier.gateStatus,
    dossier_freshness_status: verifiedDossier.freshnessStatus,
    ...(internetPipesCompleteness ? { internet_pipes: internetPipesCompleteness } : {}),
  };

  await deps.ensureGstackSkillLink();
  const clone = await deps.ensureRepoClone({
    repoFullName: targetRepoFullName,
    repoUrl,
    clonePathHint,
    baseBranch: targetRepoRef,
    runBranch: suggestedBranchName,
  });

  const companies = await deps.listCompanies();
  const companyName = deriveVentureCompanyName(targetRepoFullName);
  let company = companies.find((entry) => entry.name === companyName) ?? null;
  if (!company) {
    company = await deps.createCompany({
      name: companyName,
      description: `Autonomous venture company for ${targetRepoFullName}.`,
    });
  }
  const companyVisionContract = buildCompanyVisionContract({
    company: {
      id: company.id,
      name: company.name,
      description: company.description,
      issuePrefix: null,
    },
    goals: [
      {
        title: `Launch ${targetRepoFullName} as a validated, marketable, profitable product.`,
        status: "active",
        level: "company",
      },
    ],
    projects: [{ name: deriveRunProjectName(runId, targetRepoFullName), status: "planned" }],
    agents: AGENT_BLUEPRINTS.map((agent) => ({ name: agent.name, role: agent.role })),
  });
  const metadataContract = {
    ...baseMetadataContract,
    company_vision_contract: companyVisionContract,
  };

  const projects = await deps.listProjects(company.id);
  const projectName = deriveRunProjectName(runId, targetRepoFullName);
  let project = findDispatchTargetProject({
    projects,
    repoFullName: targetRepoFullName,
    repoUrl,
    runProjectName: projectName,
  });
  if (!project) {
    project = await deps.createProject(company.id, {
      name: projectName,
      description: projectDescriptionFromDispatch({
        payload,
        metadata: metadataContract,
      }),
      status: "planned",
    });
  }

  const workspaceSpecs = [
    {
      name: "Target Repo",
      cwd: clone.clonePath,
      repoUrl,
      repoRef: suggestedBranchName,
      defaultRef: suggestedBranchName,
      isPrimary: true,
    },
    {
      name: "portfolio-os",
      cwd: payload.cockpit?.portfolio_os_dir?.trim() || DEFAULT_POS_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/portfolio-os.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
    {
      name: "paperclip",
      cwd: payload.cockpit?.paperclip_dir?.trim() || DEFAULT_PAPERCLIP_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/paperclip.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
    {
      name: "gstack",
      cwd: payload.cockpit?.gstack_dir?.trim() || DEFAULT_GSTACK_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/gstack.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
  ];
  const existingWorkspaces = project.workspaces ?? [];
  for (const workspace of workspaceSpecs) {
    const exists = existingWorkspaces.some((entry) => entry.cwd === workspace.cwd || entry.name === workspace.name);
    if (!exists) {
      await deps.createWorkspace(project.id, workspace);
    }
  }

  const agents = await deps.listAgents(company.id);
  const agentByName = new Map(agents.map((entry) => [entry.name, entry]));
  for (const blueprint of AGENT_BLUEPRINTS) {
    if (agentByName.has(blueprint.name)) continue;
    const managerId = blueprint.reportsTo ? agentByName.get(blueprint.reportsTo)?.id ?? null : null;
    const created = await deps.createAgent(company.id, {
      name: blueprint.name,
      role: blueprint.role,
      title: blueprint.title,
      reportsTo: managerId,
      capabilities: blueprint.capabilities,
      adapterType: "codex_local",
      adapterConfig: {
        cwd: clone.clonePath,
        model: DEFAULT_CODEX_LOCAL_MODEL,
        dangerouslyBypassApprovalsAndSandbox: DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
      },
      metadata: {
        portfolioDispatch: metadataContract,
        ventureTargetRepo: targetRepoFullName,
      },
    });
    agentByName.set(created.name, created);
  }

  const existingIssues = await deps.listIssues(company.id, project.id);
  const createdOrExistingIssues: PortfolioIssue[] = [];
  for (const [functionName, tasks] of taskGroupEntries(payload)) {
    const assigneeName = ISSUE_ASSIGNEE_BY_FUNCTION[functionName] ?? null;
    const assigneeId = assigneeName ? agentByName.get(assigneeName)?.id ?? null : null;
    for (const task of tasks) {
      const title = task.ticket_title?.trim() || `[run_id:${runId}] ${functionName}`;
      const existingIssue = existingIssues.find((issue) => issue.title === title);
      if (existingIssue) {
        createdOrExistingIssues.push(existingIssue);
        continue;
      }
      const issue = await deps.createIssue(company.id, {
        projectId: project.id,
        title,
        description: issueDescriptionFromTask({
          task,
          metadata: {
            ...metadataContract,
            functional_owner: functionName,
          },
        }),
        status: "todo",
        priority: functionName === "Engineer" || functionName === "Release" ? "high" : "medium",
        assigneeAgentId: assigneeId,
        executionPolicy: issueExecutionPolicyForFunction(functionName, agentByName),
      });
      createdOrExistingIssues.push(issue);
      if (assigneeId) {
        await deps.wakeAgent(assigneeId, issue.id, project.id, runId, null);
      }
    }
  }

  const approvals = await deps.listApprovals(company.id);
  const existingApproval = approvals.find((approval) => {
    const payloadValue = approval.payload ?? {};
    return approval.type === "launch_execution" && payloadValue.run_id === runId;
  });
  const releaseIssueIds = createdOrExistingIssues
    .filter((issue) => issue.title.includes("Release"))
    .map((issue) => issue.id);
  const approval = existingApproval ?? await deps.createApproval(company.id, {
    type: "launch_execution",
    requestedByAgentId: agentByName.get("CEO")?.id ?? null,
    payload: {
      ...metadataContract,
      company_name: companyName,
      project_name: projectName,
    },
  });
  if (releaseIssueIds.length > 0) {
    await deps.linkApprovalToIssues(approval.id, releaseIssueIds);
  }

  const existingRoutines = (await deps.listRoutines(company.id))
    .filter((routine) => routine.projectId === project.id);
  const parentIssueByFunction = new Map<string, string>();
  for (const issue of createdOrExistingIssues) {
    for (const [functionName] of taskGroupEntries(payload)) {
      if (issue.title.includes(functionName) && !parentIssueByFunction.has(functionName)) {
        parentIssueByFunction.set(functionName, issue.id);
      }
    }
  }

  const provisionedRoutines: PortfolioRoutine[] = [];
  for (const blueprint of ROUTINE_BLUEPRINTS) {
    const title = deriveRoutineTitle(runId, blueprint.title);
    const assignee = agentByName.get(blueprint.assigneeName);
    if (!assignee) continue;

    let routine = existingRoutines.find((entry) => entry.title === title) ?? null;
    if (!routine) {
      routine = await deps.createRoutine(company.id, {
        projectId: project.id,
        title,
        description: blueprint.description({
          payload,
          metadata: metadataContract,
          clonePath: clone.clonePath,
          runBranch: suggestedBranchName,
          baseBranch: targetRepoRef,
          approvalId: approval.id,
        }),
        assigneeAgentId: assignee.id,
        priority: blueprint.priority,
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
        parentIssueId: blueprint.parentIssueFunction
          ? parentIssueByFunction.get(blueprint.parentIssueFunction) ?? null
          : null,
      });
    }

    const hasTrigger = routine.triggers.some(
      (trigger) => trigger.kind === "schedule" && trigger.label === blueprint.triggerLabel,
    );
    if (!hasTrigger) {
      await deps.createRoutineTrigger(routine.id, {
        kind: "schedule",
        label: blueprint.triggerLabel,
        enabled: true,
        cronExpression: blueprint.cronExpression,
        timezone: PORTFOLIO_ROUTINE_TIME_ZONE,
      });
    }
    provisionedRoutines.push(routine);
  }

  ledger.ingested[dispatchHash] = {
    dispatchHash,
    runId,
    selectionSnapshotHash,
    dispatchPath: path.resolve(dispatchPath),
    companyId: company.id,
    projectId: project.id,
    issueIds: createdOrExistingIssues.map((issue) => issue.id),
    approvalIds: [approval.id],
    routineIds: provisionedRoutines.map((routine) => routine.id),
    ingestedAt: new Date().toISOString(),
  };
  await deps.writeDispatchLedger(ledger);

  return {
    status: "ingested",
    dispatchHash,
    runId,
    companyId: company.id,
    projectId: project.id,
    issueIds: createdOrExistingIssues.map((issue) => issue.id),
    approvalIds: [approval.id],
    routineIds: provisionedRoutines.map((routine) => routine.id),
  };
}

function buildPortfolioDispatchDeps(db: Db, options?: {
  ledgerPath?: string;
  gstackDir?: string;
}) : PortfolioDispatchIngestDeps {
  const companies = companyService(db);
  const projects = projectService(db);
  const agents = agentService(db);
  const roleDefaults = agentRoleDefaultsService(db);
  const issues = issueService(db);
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);
  const heartbeat = heartbeatService(db);
  const routines = routineService(db);
  const ledgerPath = options?.ledgerPath ?? process.env.PAPERCLIP_POS_DISPATCH_LEDGER_PATH ?? DEFAULT_DISPATCH_LEDGER_PATH;
  const gstackDir = options?.gstackDir ?? process.env.PAPERCLIP_POS_GSTACK_DIR ?? DEFAULT_GSTACK_DIR;
  const workerLog = logger.child({ service: "portfolio-dispatch" });

  return {
    readFile: (pathValue) => fs.readFile(pathValue, "utf8"),
    readDispatchLedger: () => readDispatchLedgerFromFs(ledgerPath),
    writeDispatchLedger: (ledger) => writeDispatchLedgerToFs(ledgerPath, ledger),
    ensureGstackSkillLink: () => ensureGstackSkillLinkFromFs({ sourceDir: gstackDir }),
    ensureRepoClone: (input) => ensureTargetRepoCloneAndRunBranch(input),
    listCompanies: async () => {
      const rows = await companies.list();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? null,
      }));
    },
    createCompany: async (input) => {
      const row = await companies.create({
        name: input.name,
        description: input.description,
        status: "active",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
      });
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
      };
    },
    listProjects: async (companyId) => {
      const rows = await projects.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description ?? null,
        status: row.status,
        workspaces: row.workspaces?.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          repoUrl: workspace.repoUrl ?? null,
          repoRef: workspace.repoRef ?? null,
          isPrimary: workspace.isPrimary,
        })) ?? [],
      }));
    },
    createProject: async (companyId, input) => {
      const row = await projects.create(companyId, {
        name: input.name,
        description: input.description,
        status: input.status,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description ?? null,
        status: row.status,
        workspaces: row.workspaces?.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          repoUrl: workspace.repoUrl ?? null,
          repoRef: workspace.repoRef ?? null,
          isPrimary: workspace.isPrimary,
        })) ?? [],
      };
    },
    createWorkspace: async (projectId, input) => {
      await projects.createWorkspace(projectId, input);
    },
    listAgents: async (companyId) => {
      const rows = await agents.list(companyId, { includeTerminated: true });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        role: row.role,
        reportsTo: row.reportsTo ?? null,
        status: row.status,
      }));
    },
    createAgent: async (companyId, input) => {
      const desiredSkillAssignment = await roleDefaults.resolveDesiredSkillAssignment(
        companyId,
        input.role,
        input.adapterType,
        input.adapterConfig,
        undefined,
      );
      const row = await agents.create(companyId, {
        name: input.name,
        role: input.role,
        title: input.title,
        reportsTo: input.reportsTo,
        capabilities: input.capabilities,
        adapterType: input.adapterType,
        adapterConfig: desiredSkillAssignment.adapterConfig,
        budgetMonthlyCents: 0,
        metadata: input.metadata,
        status: "idle",
        spentMonthlyCents: 0,
        permissions: input.role === "ceo" ? { canCreateAgents: true } : undefined,
        lastHeartbeatAt: null,
      });
      const { agent } = await roleDefaults.materializeDefaultInstructionsBundleForAgent(row);
      return {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        role: agent.role,
        reportsTo: agent.reportsTo ?? null,
      };
    },
    listIssues: async (companyId, projectId) => {
      const rows = await issues.list(companyId, { projectId });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        title: row.title,
      }));
    },
    createIssue: async (companyId, input) => {
      const row = await issues.create(companyId, {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        title: row.title,
      };
    },
    listApprovals: async (companyId) => {
      const rows = await approvals.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        type: row.type,
        status: row.status,
        payload: (row.payload as Record<string, unknown>) ?? {},
      }));
    },
    createApproval: async (companyId, input) => {
      const row = await approvals.create(companyId, {
        type: input.type,
        requestedByAgentId: input.requestedByAgentId,
        payload: input.payload,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        type: row.type,
        status: row.status,
        payload: (row.payload as Record<string, unknown>) ?? {},
      };
    },
    linkApprovalToIssues: async (approvalId, issueIds) => {
      if (issueIds.length === 0) return;
      await issueApprovals.linkManyForApproval(approvalId, issueIds);
    },
    listRoutines: async (companyId) => {
      const rows = await routines.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId,
        title: row.title,
        triggers: (row.triggers ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled,
        })),
      }));
    },
    createRoutine: async (companyId, input) => {
      const row = await routines.create(companyId, {
        projectId: input.projectId,
        parentIssueId: input.parentIssueId ?? null,
        title: input.title,
        description: input.description,
        assigneeAgentId: input.assigneeAgentId,
        priority: input.priority,
        status: input.status,
        concurrencyPolicy: input.concurrencyPolicy,
        catchUpPolicy: input.catchUpPolicy,
        variables: input.variables,
      }, {});
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId,
        title: row.title,
        triggers: [],
      };
    },
    createRoutineTrigger: async (routineId, input) => {
      await routines.createTrigger(routineId, {
        kind: input.kind,
        label: input.label,
        enabled: input.enabled,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
      }, {});
    },
    wakeAgent: async (agentId, issueId, projectId, runId) => {
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "portfolio_dispatch_ingest",
        requestedByActorType: "system",
        requestedByActorId: "portfolio_dispatch",
        contextSnapshot: {
          issueId,
          projectId,
          runId,
          source: "portfolio_dispatch",
        },
        payload: {
          issueId,
          projectId,
          runId,
          source: "portfolio_dispatch",
        },
      });
    },
    logInfo: (message, details) => workerLog.info(details ?? {}, message),
    logWarn: (message, details) => workerLog.warn(details ?? {}, message),
    logError: (message, details) => workerLog.error(details ?? {}, message),
  };
}

export function buildPortfolioExistingVentureGateDeps(db: Db): ExistingVentureGateDeps {
  const projects = projectService(db);
  const agents = agentService(db);
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);
  const workerLog = logger.child({ service: "portfolio-existing-venture-gate" });

  return {
    readFile: (pathValue) => fs.readFile(pathValue, "utf8"),
    listProjects: async (companyId) => {
      const rows = await projects.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description ?? null,
        status: row.status,
        workspaces: row.workspaces?.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          repoUrl: workspace.repoUrl ?? null,
          repoRef: workspace.repoRef ?? null,
          isPrimary: workspace.isPrimary,
        })) ?? [],
      }));
    },
    listAgents: async (companyId) => {
      const rows = await agents.list(companyId, { includeTerminated: true });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        role: row.role,
        reportsTo: row.reportsTo ?? null,
        status: row.status,
      }));
    },
    listIssuesByOrigin: async (companyId, originKind, originId) => {
      const rows = await issues.list(companyId, {
        originKind,
        originId,
        includeRoutineExecutions: true,
      });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        parentId: row.parentId ?? null,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        assigneeAgentId: row.assigneeAgentId ?? null,
        executionState: row.executionState ?? null,
      }));
    },
    createIssue: async (companyId, input) => {
      const row = await issues.create(companyId, {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
        parentId: input.parentId ?? null,
        originKind: input.originKind,
        originId: input.originId,
        executionState: input.executionState,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        parentId: row.parentId ?? null,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        assigneeAgentId: row.assigneeAgentId ?? null,
        executionState: row.executionState ?? null,
      };
    },
    updateIssue: async (issueId, input) => {
      const row = await issues.update(issueId, input);
      if (!row) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        parentId: row.parentId ?? null,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        assigneeAgentId: row.assigneeAgentId ?? null,
        executionState: row.executionState ?? null,
      };
    },
    wakeAgent: async (agentId, issueId, projectId, runId) => {
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "portfolio_existing_venture_gate",
        requestedByActorType: "system",
        requestedByActorId: "portfolio_existing_venture_gate",
        contextSnapshot: {
          issueId,
          projectId,
          runId,
          source: "portfolio_existing_venture_gate",
        },
        payload: {
          issueId,
          projectId,
          runId,
          source: "portfolio_existing_venture_gate",
        },
      });
    },
    logInfo: (message, details) => workerLog.info(details ?? {}, message),
    logWarn: (message, details) => workerLog.warn(details ?? {}, message),
    logError: (message, details) => workerLog.error(details ?? {}, message),
  };
}

export function createPortfolioDispatchIngestWorker(db: Db, options?: {
  outboxDir?: string;
  gatePath?: string;
  pollIntervalMs?: number;
  ledgerPath?: string;
  gstackDir?: string;
}) {
  const enabled = process.env.PAPERCLIP_POS_DISPATCH_INGEST_ENABLED !== "false";
  const outboxDir = options?.outboxDir ?? process.env.PAPERCLIP_POS_DISPATCH_OUTBOX ?? DEFAULT_DISPATCH_OUTBOX;
  const gatePath = options?.gatePath ?? process.env.PAPERCLIP_POS_DISPATCH_GATE_PATH ?? DEFAULT_DISPATCH_GATE_PATH;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_DISPATCH_POLL_INTERVAL_MS;
  const deps = buildPortfolioDispatchDeps(db, options);
  const existingVentureGateDeps = buildPortfolioExistingVentureGateDeps(db);
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const processedDispatchFiles = new Map<string, { signature: string; status: DispatchIngestResult["status"] }>();
  let processedGateSignature: string | null = null;

  function fileSignature(stat: Awaited<ReturnType<typeof fs.stat>>) {
    return `${Math.trunc(Number(stat.mtimeMs))}:${Number(stat.size)}`;
  }

  const tickOnce = async () => {
    if (!enabled || running) return [];
    running = true;
    try {
      const entries = await fs.readdir(outboxDir, { withFileTypes: true }).catch(() => []);
      const dispatchFiles = entries
        .filter((entry) => entry.isFile() && /^dispatch_.*\.json$/i.test(entry.name))
        .map((entry) => path.resolve(outboxDir, entry.name))
        .sort();
      const results: PortfolioDispatchWorkerResult[] = [];
      const gateStat = await fs.stat(gatePath).catch(() => null);
      if (gateStat?.isFile()) {
        const signature = fileSignature(gateStat);
        if (signature !== processedGateSignature) {
          try {
            const result = await ingestExistingVentureGateFile(gatePath, existingVentureGateDeps);
            results.push(result);
            processedGateSignature = signature;
            if (result.status === "created" || result.status === "updated") {
              existingVentureGateDeps.logInfo("portfolio existing venture gate routed", {
                gatePath,
                companyId: result.companyId,
                projectId: result.projectId,
                issueId: result.issueId,
                assigneeAgentId: result.assigneeAgentId,
              });
            } else if (result.reason && SUPPRESSED_EXISTING_VENTURE_REASONS.has(result.reason)) {
              existingVentureGateDeps.logInfo("portfolio existing venture gate suppressed", {
                gatePath,
                companyId: result.companyId,
                projectId: result.projectId,
                reason: result.reason,
              });
            }
          } catch (error) {
            processedGateSignature = signature;
            existingVentureGateDeps.logError("portfolio existing venture gate ingest failed", {
              gatePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const activeDispatchFiles = new Set(dispatchFiles);
      for (const cachedPath of processedDispatchFiles.keys()) {
        if (!activeDispatchFiles.has(cachedPath)) {
          processedDispatchFiles.delete(cachedPath);
        }
      }
      for (const dispatchPath of dispatchFiles) {
        const stat = await fs.stat(dispatchPath).catch(() => null);
        if (!stat) {
          processedDispatchFiles.delete(dispatchPath);
          continue;
        }
        const signature = fileSignature(stat);
        const cached = processedDispatchFiles.get(dispatchPath);
        if (cached && cached.signature === signature) {
          continue;
        }
        try {
          const result = await ingestPortfolioDispatchFile(dispatchPath, deps);
          results.push(result);
          processedDispatchFiles.set(dispatchPath, { signature, status: result.status });
          if (result.status === "ingested") {
            deps.logInfo("portfolio dispatch ingested", {
              dispatchPath,
              runId: result.runId,
              companyId: result.companyId,
              projectId: result.projectId,
            });
          }
        } catch (error) {
          processedDispatchFiles.set(dispatchPath, { signature, status: "skipped" });
          deps.logError("portfolio dispatch ingest failed", {
            dispatchPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    } finally {
      running = false;
    }
  };

  return {
    enabled,
    start() {
      if (!enabled || timer) return;
      void tickOnce();
      timer = setInterval(() => {
        void tickOnce();
      }, pollIntervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tickOnce,
  };
}
