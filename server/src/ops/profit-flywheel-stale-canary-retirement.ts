import { createHash } from "node:crypto";
import { constants, readFileSync, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  createDb,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
  runDatabaseBackup,
  type Db,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
} from "@paperclipai/db";
import {
  parsePortfolioOsProfitFlywheelContractV2,
  type ProfitFlywheelStage,
} from "@paperclipai/shared";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  hashProfitFlywheelValue,
  profitFlywheelDispatchIssueIdentity,
} from "../services/profit-flywheel.js";
import {
  buildProfitFlywheelCanaryCloseout,
  type ProfitFlywheelCanaryCloseoutOptions,
} from "./profit-flywheel-canary-closeout.js";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedJsonFile,
} from "./trusted-receipt-directory.js";

const PLAN_SCHEMA_VERSION = "paperclip.profit_flywheel_stale_canary_retirement_plan.v1";
const INTENT_SCHEMA_VERSION = "paperclip.profit_flywheel_stale_canary_retirement_intent.v1";
const RESULT_SCHEMA_VERSION = "paperclip.profit_flywheel_stale_canary_retirement_result.v1";
const CLOSEOUT_SCHEMA_VERSION = "paperclip.profit_flywheel_canary_closeout.v1";
const FIXTURE_TARGET_REPO = "fixture/profit-canary";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ELIGIBLE_NONTERMINAL_STATES = new Set(["pending", "retry", "blocked", "degraded"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "safely_skipped"]);
const OPEN_ISSUE_STATES = new Set(["backlog", "todo", "in_review", "blocked"]);
const TERMINAL_ISSUE_STATES = new Set(["done", "cancelled"]);
const RETIREMENT_SCHEMA_PATH = fileURLToPath(new URL("../../../contracts/profit-flywheel/stale-canary-retirement.v1.schema.json", import.meta.url));
// Updating the receipt schema is an explicit compatibility event. Keep the
// runtime validator pinned to the exact reviewed bytes, rather than silently
// accepting a locally edited schema at mutation time.
const RETIREMENT_SCHEMA_SHA256 = "d3456f9845fbff9c9568b43f553c071219e8b5f692c109f23a87cf2b22083ba6";

type JsonRecord = Record<string, unknown>;
type StageRow = typeof profitFlywheelStageRuns.$inferSelect;
type WorkflowRow = typeof profitFlywheelWorkflows.$inferSelect;
type EventRow = typeof profitFlywheelEvents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type JsonSchemaValidator = ((value: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; keyword: string; message?: string }> | null;
};

function loadRetirementSchema() {
  const bytes = readFileSync(RETIREMENT_SCHEMA_PATH);
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== RETIREMENT_SCHEMA_SHA256) {
    throw new Error("profit_canary_retirement_schema_hash_mismatch");
  }
  return JSON.parse(bytes.toString("utf8")) as JsonRecord;
}

const retirementSchemaAjv = new (Ajv2020 as unknown as new (options: Record<string, unknown>) => {
  compile(schema: JsonRecord): JsonSchemaValidator;
})({ allErrors: true, strict: true, strictRequired: false });
(addFormats as unknown as (instance: typeof retirementSchemaAjv) => void)(retirementSchemaAjv);
const validateRetirementReceiptSchema = retirementSchemaAjv.compile(loadRetirementSchema());

export type ProfitFlywheelStaleCanaryRetirementOptions = {
  companyId: string;
  cutoffAt: string;
  replacementCloseoutPath: string;
  replacementCloseoutSha256: string;
  receiptDir: string;
};

export type ApplyProfitFlywheelStaleCanaryRetirementOptions = ProfitFlywheelStaleCanaryRetirementOptions & {
  planPath: string;
  planSha256: string;
};

export type StaleCanaryRetirementPlan = {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  operation: "profit_flywheel_stale_canary_retirement";
  mode: "plan";
  immutable: true;
  operation_id: string;
  generated_at: string;
  company_id: string;
  cutoff_at: string;
  factory_pause_required: true;
  replacement_closeout: ReplacementCloseout;
  receipt_dir: string;
  target_snapshot_sha256: string;
  ready: boolean;
  blockers: Array<{ code: string; workflow_id?: string; stage_run_id?: string; issue_id?: string }>;
  targets: RetirementTarget[];
};

type ReplacementCloseout = {
  path: string;
  sha256: string;
  generated_at: string;
  identity: {
    company_id: string;
    run_id: string;
    correlation_id: string;
    project_id: string;
    workflow_id: string;
    issue_id: string;
    trace_id: string;
    target_repo: string;
    target_workspace_root: string;
  };
};

type PlannedStage = {
  id: string;
  stage: string;
  state: string;
  updated_at: string;
  input_hash: string;
  linked_issue_id: string | null;
  span_id: string;
};

type PlannedEvent = {
  id: string;
  stage_run_id: string | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  span_id: string | null;
  updated_at: string;
};

type PlannedIssue = {
  id: string;
  stage_run_id: string;
  status: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  action: "cancel" | "already_terminal" | "retained_unverified" | "retained_terminal";
  deterministic_fixture_identity: boolean;
};

type RetirementTarget = {
  workflow: {
    id: string;
    state: string;
    updated_at: string;
    created_at: string;
    current_stage: string;
    run_id: string;
    correlation_id: string;
    trace_id: string;
  };
  stages_to_cancel: PlannedStage[];
  preserved_terminal_stage_ids: string[];
  events_to_drain: PlannedEvent[];
  linked_issues: PlannedIssue[];
};

type BackupConfiguration = {
  connectionString: string;
  backupDir: string;
  retentionDays: number;
  keepLatestBackups?: number;
};

export type FactoryPauseAuthoritySnapshot = {
  paused: boolean;
  /** Stable hash/generation for the exact authority snapshot read. */
  generation: string;
};

type RetirementDependencies = {
  now?: () => Date;
  /**
   * A live, selected-instance authority reader. A frozen boolean is
   * intentionally not accepted: this operation is non-compensable and must
   * re-read pause authority immediately before mutating.
   */
  factoryPauseAuthority?: () => FactoryPauseAuthoritySnapshot;
  databaseBackup?: BackupConfiguration;
  backupRunner?: (options: RunDatabaseBackupOptions) => Promise<RunDatabaseBackupResult>;
  afterIntentBeforeMutation?: () => Promise<void> | void;
  afterDatabaseMutationBeforeFinalReceipt?: () => Promise<void> | void;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sameCanonical(left: unknown, right: unknown) {
  return hashProfitFlywheelValue(left) === hashProfitFlywheelValue(right);
}

function canonicalUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error("profit_canary_retirement_" + label + "_invalid");
  return normalized;
}

function canonicalSha256(value: string, label: string) {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!SHA256.test(normalized)) throw new Error("profit_canary_retirement_" + label + "_invalid");
  return normalized;
}

function canonicalAbsolutePath(value: string, label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error("profit_canary_retirement_" + label + "_invalid");
  }
  return value;
}

function canonicalTimestamp(value: string, label: string) {
  const normalized = value.trim();
  const date = new Date(normalized);
  if (!normalized || Number.isNaN(date.getTime()) || date.toISOString() !== normalized) {
    throw new Error("profit_canary_retirement_" + label + "_invalid");
  }
  return normalized;
}

function requireString(record: JsonRecord, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("profit_canary_retirement_" + label + "_" + key + "_missing");
  }
  return value.trim();
}

function requireIdentityUuid(record: JsonRecord, key: string, label: string) {
  return canonicalUuid(requireString(record, key, label), label + "_" + key);
}

function requirePaused(
  dependencies: RetirementDependencies,
  expectedGeneration?: string,
): FactoryPauseAuthoritySnapshot {
  if (!dependencies.factoryPauseAuthority) {
    throw new Error("profit_canary_retirement_live_factory_pause_authority_required");
  }
  const snapshot = dependencies.factoryPauseAuthority();
  if (!snapshot || snapshot.paused !== true || typeof snapshot.generation !== "string" || !SHA256.test(snapshot.generation)) {
    throw new Error("profit_canary_retirement_factory_pause_required");
  }
  if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) {
    throw new Error("profit_canary_retirement_factory_pause_authority_changed");
  }
  return snapshot;
}

function operationIdentity(options: ProfitFlywheelStaleCanaryRetirementOptions) {
  return hashProfitFlywheelValue({
    schema_version: PLAN_SCHEMA_VERSION,
    operation: "profit_flywheel_stale_canary_retirement",
    company_id: options.companyId,
    cutoff_at: options.cutoffAt,
    replacement_closeout_path: options.replacementCloseoutPath,
    replacement_closeout_sha256: options.replacementCloseoutSha256,
  });
}

function receiptPaths(receiptDir: string, operationId: string) {
  const prefix = `${operationId}-profit-flywheel-stale-canary-retirement`;
  return {
    planPath: path.join(receiptDir, `${prefix}-plan.json`),
    intentPath: path.join(receiptDir, `${prefix}-intent.json`),
    resultPath: path.join(receiptDir, `${prefix}-result.json`),
  };
}

function isDeterministicFixtureIssue(issue: IssueRow, workflow: WorkflowRow, stage: StageRow) {
  const expected = profitFlywheelDispatchIssueIdentity({
    companyId: workflow.companyId,
    workflowId: workflow.id,
    stageRunId: stage.id,
    inputHash: stage.inputHash,
  });
  return issue.companyId === workflow.companyId && issue.projectId === workflow.projectId &&
    issue.originKind === expected.origin_kind && issue.originId === expected.origin_id &&
    issue.originRunId === workflow.runId &&
    typeof issue.description === "string" && issue.description.includes(expected.description_marker);
}

function stageCanTransitionToCancelled(stage: StageRow, contractSnapshot: unknown) {
  let contract;
  try {
    contract = parsePortfolioOsProfitFlywheelContractV2(contractSnapshot);
  } catch {
    throw new Error("profit_canary_retirement_contract_snapshot_invalid:" + stage.workflowId);
  }
  const stageDefinition = contract.stages[stage.stage as ProfitFlywheelStage];
  if (!stageDefinition) throw new Error("profit_canary_retirement_contract_stage_unknown:" + stage.id);
  const transitions = stageDefinition.run_state_transitions[
    stage.state as keyof typeof stageDefinition.run_state_transitions
  ] as readonly string[] | undefined;
  return transitions?.includes("cancelled") === true;
}

function targetSnapshot(targets: RetirementTarget[]) {
  return hashProfitFlywheelValue(targets);
}

function closeoutStageId(stages: JsonRecord, key: string) {
  return requireIdentityUuid(asRecord(stages[key]), "id", "replacement_closeout_stage_" + key);
}

function closeoutArtifactPath(authorityBaseline: JsonRecord, key: string) {
  return canonicalAbsolutePath(
    requireString(asRecord(authorityBaseline[key]), "path", "replacement_closeout_" + key),
    "replacement_closeout_" + key + "_path",
  );
}

function deriveCanonicalCloseoutOptions(
  artifactPath: string,
  value: JsonRecord,
  identity: ReplacementCloseout["identity"],
): ProfitFlywheelCanaryCloseoutOptions {
  // `buildProfitFlywheelCanaryCloseout` is the canonical read-only proof
  // verifier.  Require this exact naming convention so rerunning it can only
  // reuse the already-read artifact; it can never install a sibling receipt as
  // a side effect of retirement verification.
  if (path.basename(identity.run_id) !== identity.run_id ||
      artifactPath !== path.join(path.dirname(artifactPath), `${identity.run_id}-canary-closeout.json`)) {
    throw new Error("profit_canary_retirement_replacement_closeout_path_not_canonical");
  }
  const stages = asRecord(value.stages);
  const authorityBaseline = asRecord(value.authority_baseline);
  return {
    companyId: identity.company_id,
    runId: identity.run_id,
    correlationId: identity.correlation_id,
    projectId: identity.project_id,
    workflowId: identity.workflow_id,
    issueId: identity.issue_id,
    implementationStageRunId: closeoutStageId(stages, "implementation"),
    qaStageRunId: closeoutStageId(stages, "qa"),
    releaseStageRunId: closeoutStageId(stages, "release"),
    observationStageRunId: closeoutStageId(stages, "commercial_observation"),
    learningStageRunId: closeoutStageId(stages, "learning"),
    nextResearchStageRunId: closeoutStageId(stages, "next_research_intake"),
    setupReceiptPath: closeoutArtifactPath(authorityBaseline, "setup_receipt"),
    promotionReceiptPath: closeoutArtifactPath(authorityBaseline, "promotion_aggregate_receipt"),
    receiptDir: path.dirname(artifactPath),
  };
}

async function readReplacementCloseout(
  db: Db,
  options: ProfitFlywheelStaleCanaryRetirementOptions,
  dependencies: RetirementDependencies,
): Promise<ReplacementCloseout> {
  const expectedSha = canonicalSha256(options.replacementCloseoutSha256, "replacement_closeout_sha256");
  const artifact = await readTrustedJsonFile(
    canonicalAbsolutePath(options.replacementCloseoutPath, "replacement_closeout_path"),
    "profit_canary_retirement_replacement_closeout",
    { maxBytes: 16 * 1024 * 1024 },
  );
  if (artifact.sha256 !== expectedSha) throw new Error("profit_canary_retirement_replacement_closeout_hash_mismatch");
  const value = artifact.value;
  if (value.schema_version !== CLOSEOUT_SCHEMA_VERSION ||
      value.outcome !== "work_bearing_cycle_closed_next_research_pending" ||
      value.immutable !== true || value.read_only_database_audit !== true) {
    throw new Error("profit_canary_retirement_replacement_closeout_untrusted");
  }
  const expected = asRecord(value.expected_control_plane_state);
  if (expected.workflow_state !== "running" || expected.current_stage !== "research_intake") {
    throw new Error("profit_canary_retirement_replacement_closeout_state_invalid");
  }
  const identity = asRecord(value.identity);
  const parsedIdentity = {
    company_id: requireIdentityUuid(identity, "company_id", "replacement_closeout_identity"),
    run_id: requireString(identity, "run_id", "replacement_closeout_identity"),
    correlation_id: requireString(identity, "correlation_id", "replacement_closeout_identity"),
    project_id: requireIdentityUuid(identity, "project_id", "replacement_closeout_identity"),
    workflow_id: requireIdentityUuid(identity, "workflow_id", "replacement_closeout_identity"),
    issue_id: requireIdentityUuid(identity, "issue_id", "replacement_closeout_identity"),
    trace_id: requireString(identity, "trace_id", "replacement_closeout_identity"),
    target_repo: requireString(identity, "target_repo", "replacement_closeout_identity"),
    target_workspace_root: requireString(identity, "target_workspace_root", "replacement_closeout_identity"),
  };
  if (parsedIdentity.target_repo !== FIXTURE_TARGET_REPO) {
    throw new Error("profit_canary_retirement_replacement_closeout_target_invalid");
  }
  const closeout = {
    path: artifact.path,
    sha256: artifact.sha256,
    generated_at: canonicalTimestamp(requireString(value, "generated_at", "replacement_closeout"), "replacement_closeout_generated_at"),
    identity: parsedIdentity,
  };
  const canonicalOptions = deriveCanonicalCloseoutOptions(artifact.path, value, parsedIdentity);
  const verified = await buildProfitFlywheelCanaryCloseout(db, canonicalOptions);
  if (canonicalAbsolutePath(verified.receiptPath, "replacement_closeout_verified_path") !== artifact.path ||
      canonicalSha256(verified.receiptSha256, "replacement_closeout_verified_sha256") !== artifact.sha256 ||
      !sameCanonical(verified.receipt, value)) {
    throw new Error("profit_canary_retirement_replacement_closeout_canonical_verification_failed");
  }
  return closeout;
}

async function assertReplacementWorkflow(
  db: Db,
  companyId: string,
  cutoffAt: string,
  replacement: ReplacementCloseout,
) {
  if (replacement.identity.company_id !== companyId) {
    throw new Error("profit_canary_retirement_replacement_company_mismatch");
  }
  if (new Date(replacement.generated_at).getTime() <= new Date(cutoffAt).getTime()) {
    throw new Error("profit_canary_retirement_replacement_not_newer_than_cutoff");
  }
  const workflow = await db.select().from(profitFlywheelWorkflows).where(and(
    eq(profitFlywheelWorkflows.id, replacement.identity.workflow_id),
    eq(profitFlywheelWorkflows.companyId, companyId),
  )).then((rows) => rows[0] ?? null);
  if (!workflow || workflow.projectId !== replacement.identity.project_id ||
      workflow.runId !== replacement.identity.run_id ||
      workflow.correlationId !== replacement.identity.correlation_id ||
      workflow.traceId !== replacement.identity.trace_id ||
      workflow.targetRepo !== replacement.identity.target_repo ||
      workflow.targetWorkspaceRoot !== replacement.identity.target_workspace_root ||
      workflow.state !== "running" || workflow.currentStage !== "research_intake") {
    throw new Error("profit_canary_retirement_replacement_workflow_mismatch");
  }
  const [project, issue] = await Promise.all([
    db.select().from(projects).where(and(
      eq(projects.id, replacement.identity.project_id),
      eq(projects.companyId, companyId),
    )).then((rows) => rows[0] ?? null),
    db.select().from(issues).where(and(
      eq(issues.id, replacement.identity.issue_id),
      eq(issues.companyId, companyId),
    )).then((rows) => rows[0] ?? null),
  ]);
  if (!project || !issue || issue.projectId !== project.id || issue.status !== "done" || !issue.completedAt) {
    throw new Error("profit_canary_retirement_replacement_project_or_issue_mismatch");
  }
  return workflow;
}

type CandidateSnapshot = {
  targets: RetirementTarget[];
  blockers: StaleCanaryRetirementPlan["blockers"];
};

async function collectCandidates(
  db: Db,
  input: { companyId: string; cutoffAt: string; replacementWorkflowId: string; lockRows?: boolean },
): Promise<CandidateSnapshot> {
  let workflowQuery = db.select().from(profitFlywheelWorkflows).where(and(
    eq(profitFlywheelWorkflows.companyId, input.companyId),
    eq(profitFlywheelWorkflows.targetRepo, FIXTURE_TARGET_REPO),
    lt(profitFlywheelWorkflows.createdAt, new Date(input.cutoffAt)),
  )).orderBy(profitFlywheelWorkflows.id);
  if (input.lockRows) workflowQuery = workflowQuery.for("update") as typeof workflowQuery;
  const workflows = await workflowQuery;
  const targets: RetirementTarget[] = [];
  const blockers: StaleCanaryRetirementPlan["blockers"] = [];

  for (const workflow of workflows) {
    if (workflow.id === input.replacementWorkflowId || TERMINAL_STATES.has(workflow.state)) continue;
    if (!ELIGIBLE_NONTERMINAL_STATES.has(workflow.state)) {
      blockers.push({ code: "nonterminal_workflow_not_safe_to_retire", workflow_id: workflow.id });
      continue;
    }
    let stageQuery = db.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.workflowId, workflow.id),
      eq(profitFlywheelStageRuns.companyId, workflow.companyId),
    )).orderBy(profitFlywheelStageRuns.id);
    if (input.lockRows) stageQuery = stageQuery.for("update") as typeof stageQuery;
    const stages = await stageQuery;
    const stageIds = stages.map((stage) => stage.id);
    let leaseRows: Array<typeof profitFlywheelLeases.$inferSelect> = [];
    if (stageIds.length > 0) {
      let leaseQuery = db.select().from(profitFlywheelLeases).where(and(
        eq(profitFlywheelLeases.companyId, workflow.companyId),
        inArray(profitFlywheelLeases.stageRunId, stageIds),
      )).orderBy(profitFlywheelLeases.id);
      if (input.lockRows) leaseQuery = leaseQuery.for("update") as typeof leaseQuery;
      leaseRows = await leaseQuery;
    }
    if (leaseRows.length > 0) {
      blockers.push({ code: "active_stage_lease_present", workflow_id: workflow.id });
      continue;
    }
    const stagesToCancel: StageRow[] = [];
    const terminalStageIds: string[] = [];
    let unsafe = false;
    for (const stage of stages) {
      if (TERMINAL_STATES.has(stage.state)) {
        terminalStageIds.push(stage.id);
        continue;
      }
      if (!ELIGIBLE_NONTERMINAL_STATES.has(stage.state) || stage.leaseOwner || stage.leaseExpiresAt ||
          stage.leaseActorType || stage.leaseActorId || stage.heartbeatAt || stage.dispatchClaimId || stage.dispatchClaimedAt) {
        blockers.push({ code: "nonterminal_stage_not_safe_to_retire", workflow_id: workflow.id, stage_run_id: stage.id });
        unsafe = true;
        continue;
      }
      if (!stageCanTransitionToCancelled(stage, workflow.contractSnapshot)) {
        blockers.push({ code: "contract_transition_to_cancelled_forbidden", workflow_id: workflow.id, stage_run_id: stage.id });
        unsafe = true;
        continue;
      }
      stagesToCancel.push(stage);
    }
    if (unsafe || stagesToCancel.length === 0) {
      if (!unsafe) blockers.push({ code: "workflow_has_no_retirable_nonterminal_stages", workflow_id: workflow.id });
      continue;
    }
    let eventQuery = db.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.workflowId, workflow.id),
      eq(profitFlywheelEvents.companyId, workflow.companyId),
      isNull(profitFlywheelEvents.processedAt),
    )).orderBy(profitFlywheelEvents.id);
    if (input.lockRows) eventQuery = eventQuery.for("update") as typeof eventQuery;
    const events = await eventQuery;

    const linkedIssueIds = stagesToCancel.flatMap((stage) => stage.linkedIssueId ? [stage.linkedIssueId] : []);
    let issueRows: IssueRow[] = [];
    if (linkedIssueIds.length > 0) {
      let issueQuery = db.select().from(issues).where(and(
        eq(issues.companyId, workflow.companyId),
        inArray(issues.id, linkedIssueIds),
      )).orderBy(issues.id);
      if (input.lockRows) issueQuery = issueQuery.for("update") as typeof issueQuery;
      issueRows = await issueQuery;
    }
    const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
    const plannedIssues: PlannedIssue[] = [];
    for (const stage of stagesToCancel) {
      if (!stage.linkedIssueId) continue;
      const issue = issueById.get(stage.linkedIssueId);
      if (!issue) {
        blockers.push({ code: "linked_issue_missing", workflow_id: workflow.id, stage_run_id: stage.id, issue_id: stage.linkedIssueId });
        unsafe = true;
        continue;
      }
      const deterministic = isDeterministicFixtureIssue(issue, workflow, stage);
      const active = issue.status === "in_progress" || issue.checkoutRunId !== null || issue.executionRunId !== null;
      if (active) {
        blockers.push({ code: "linked_issue_has_active_work", workflow_id: workflow.id, stage_run_id: stage.id, issue_id: issue.id });
        unsafe = true;
        continue;
      }
      if (!OPEN_ISSUE_STATES.has(issue.status) && !TERMINAL_ISSUE_STATES.has(issue.status)) {
        blockers.push({
          code: deterministic ? "deterministic_linked_issue_state_unknown" : "non_deterministic_linked_issue_state_unknown",
          workflow_id: workflow.id,
          stage_run_id: stage.id,
          issue_id: issue.id,
        });
        unsafe = true;
        continue;
      }
      const action: PlannedIssue["action"] = deterministic && OPEN_ISSUE_STATES.has(issue.status)
        ? "cancel"
        : deterministic ? "already_terminal"
          : TERMINAL_ISSUE_STATES.has(issue.status) ? "retained_terminal" : "retained_unverified";
      plannedIssues.push({
        id: issue.id,
        stage_run_id: stage.id,
        status: issue.status,
        updated_at: issue.updatedAt.toISOString(),
        completed_at: issue.completedAt?.toISOString() ?? null,
        cancelled_at: issue.cancelledAt?.toISOString() ?? null,
        action,
        deterministic_fixture_identity: deterministic,
      });
    }
    if (unsafe) continue;
    targets.push({
      workflow: {
        id: workflow.id,
        state: workflow.state,
        updated_at: workflow.updatedAt.toISOString(),
        created_at: workflow.createdAt.toISOString(),
        current_stage: workflow.currentStage,
        run_id: workflow.runId,
        correlation_id: workflow.correlationId,
        trace_id: workflow.traceId,
      },
      stages_to_cancel: stagesToCancel.map((stage) => ({
        id: stage.id,
        stage: stage.stage,
        state: stage.state,
        updated_at: stage.updatedAt.toISOString(),
        input_hash: stage.inputHash,
        linked_issue_id: stage.linkedIssueId,
        span_id: stage.spanId,
      })),
      preserved_terminal_stage_ids: terminalStageIds.sort(),
      events_to_drain: events.map((event) => ({
        id: event.id,
        stage_run_id: event.stageRunId,
        event_type: event.eventType,
        from_state: event.fromState,
        to_state: event.toState,
        span_id: event.spanId,
        updated_at: event.updatedAt.toISOString(),
      })),
      linked_issues: plannedIssues.sort((left, right) => left.id.localeCompare(right.id)),
    });
  }
  return { targets: targets.sort((left, right) => left.workflow.id.localeCompare(right.workflow.id)), blockers };
}

function isSortedUnique(values: string[]) {
  return values.every((value, index) => index === 0 || values[index - 1]! < value) && new Set(values).size === values.length;
}

/**
 * The JSON Schema prevents shape tricks; this validator supplies the canonical
 * semantics that JSON Schema cannot express (exact timestamps, ordered unique
 * identities, snapshot self-binding, and action/state invariants).  It runs
 * both when reusing a plan and immediately before apply.
 */
function parseCanonicalPlan(value: JsonRecord): StaleCanaryRetirementPlan {
  if (!validateRetirementReceiptSchema(value)) {
    throw new Error("profit_canary_retirement_plan_schema_invalid");
  }
  const plan = value as unknown as StaleCanaryRetirementPlan;
  try {
    canonicalSha256(plan.operation_id, "plan_operation_id");
    canonicalUuid(plan.company_id, "plan_company_id");
    canonicalTimestamp(plan.generated_at, "plan_generated_at");
    canonicalTimestamp(plan.cutoff_at, "plan_cutoff_at");
    canonicalAbsolutePath(plan.receipt_dir, "plan_receipt_dir");
    canonicalSha256(plan.target_snapshot_sha256, "plan_target_snapshot_sha256");
    canonicalAbsolutePath(plan.replacement_closeout.path, "plan_replacement_closeout_path");
    canonicalSha256(plan.replacement_closeout.sha256, "plan_replacement_closeout_sha256");
    canonicalTimestamp(plan.replacement_closeout.generated_at, "plan_replacement_closeout_generated_at");
    canonicalUuid(plan.replacement_closeout.identity.company_id, "plan_replacement_company_id");
    canonicalUuid(plan.replacement_closeout.identity.project_id, "plan_replacement_project_id");
    canonicalUuid(plan.replacement_closeout.identity.workflow_id, "plan_replacement_workflow_id");
    canonicalUuid(plan.replacement_closeout.identity.issue_id, "plan_replacement_issue_id");
    if (plan.replacement_closeout.identity.company_id !== plan.company_id ||
        plan.replacement_closeout.identity.target_repo !== FIXTURE_TARGET_REPO) {
      throw new Error("profit_canary_retirement_plan_replacement_identity_invalid");
    }
    if (plan.ready && (plan.blockers.length !== 0 || plan.targets.length === 0)) {
      throw new Error("profit_canary_retirement_plan_ready_semantics_invalid");
    }
    const workflowIds = plan.targets.map((target) => target.workflow.id);
    if (!isSortedUnique(workflowIds)) throw new Error("profit_canary_retirement_plan_workflow_order_invalid");
    const stageIds = new Set<string>();
    const eventIds = new Set<string>();
    const issueIds = new Set<string>();
    for (const target of plan.targets) {
      const workflow = target.workflow;
      canonicalUuid(workflow.id, "plan_workflow_id");
      canonicalTimestamp(workflow.updated_at, "plan_workflow_updated_at");
      canonicalTimestamp(workflow.created_at, "plan_workflow_created_at");
      if (!ELIGIBLE_NONTERMINAL_STATES.has(workflow.state) || !workflow.current_stage || !workflow.run_id ||
          !workflow.correlation_id || !/^[0-9a-f]{32}$/.test(workflow.trace_id)) {
        throw new Error("profit_canary_retirement_plan_workflow_invalid");
      }
      const targetStageIds = target.stages_to_cancel.map((stage) => stage.id);
      if (!isSortedUnique(targetStageIds)) throw new Error("profit_canary_retirement_plan_stage_order_invalid");
      if (!isSortedUnique(target.preserved_terminal_stage_ids)) {
        throw new Error("profit_canary_retirement_plan_terminal_stage_order_invalid");
      }
      for (const stage of target.stages_to_cancel) {
        canonicalUuid(stage.id, "plan_stage_id");
        canonicalTimestamp(stage.updated_at, "plan_stage_updated_at");
        canonicalSha256(stage.input_hash, "plan_stage_input_hash");
        if (!stage.stage || !ELIGIBLE_NONTERMINAL_STATES.has(stage.state) || !/^[0-9a-f]{16}$/.test(stage.span_id) ||
            (stage.linked_issue_id !== null && !UUID.test(stage.linked_issue_id)) || stageIds.has(stage.id)) {
          throw new Error("profit_canary_retirement_plan_stage_invalid");
        }
        stageIds.add(stage.id);
      }
      for (const terminalStageId of target.preserved_terminal_stage_ids) {
        if (!UUID.test(terminalStageId) || stageIds.has(terminalStageId)) {
          throw new Error("profit_canary_retirement_plan_terminal_stage_invalid");
        }
      }
      const targetEventIds = target.events_to_drain.map((event) => event.id);
      if (!isSortedUnique(targetEventIds)) throw new Error("profit_canary_retirement_plan_event_order_invalid");
      for (const event of target.events_to_drain) {
        canonicalUuid(event.id, "plan_event_id");
        canonicalTimestamp(event.updated_at, "plan_event_updated_at");
        if (!event.event_type || (event.stage_run_id !== null && !UUID.test(event.stage_run_id)) ||
            (event.span_id !== null && !/^[0-9a-f]{16}$/.test(event.span_id)) || eventIds.has(event.id)) {
          throw new Error("profit_canary_retirement_plan_event_invalid");
        }
        eventIds.add(event.id);
      }
      const targetIssueIds = target.linked_issues.map((issue) => issue.id);
      if (!isSortedUnique(targetIssueIds)) throw new Error("profit_canary_retirement_plan_issue_order_invalid");
      for (const issue of target.linked_issues) {
        canonicalUuid(issue.id, "plan_issue_id");
        canonicalUuid(issue.stage_run_id, "plan_issue_stage_id");
        canonicalTimestamp(issue.updated_at, "plan_issue_updated_at");
        if ((issue.completed_at !== null && !validCanonicalTimestamp(issue.completed_at)) ||
            (issue.cancelled_at !== null && !validCanonicalTimestamp(issue.cancelled_at)) ||
            !targetStageIds.includes(issue.stage_run_id) || issueIds.has(issue.id)) {
          throw new Error("profit_canary_retirement_plan_issue_invalid");
        }
        const actionValid =
          (issue.action === "cancel" && issue.deterministic_fixture_identity && OPEN_ISSUE_STATES.has(issue.status)) ||
          (issue.action === "already_terminal" && issue.deterministic_fixture_identity && TERMINAL_ISSUE_STATES.has(issue.status)) ||
          (issue.action === "retained_unverified" && !issue.deterministic_fixture_identity && OPEN_ISSUE_STATES.has(issue.status)) ||
          (issue.action === "retained_terminal" && !issue.deterministic_fixture_identity && TERMINAL_ISSUE_STATES.has(issue.status));
        if (!actionValid) throw new Error("profit_canary_retirement_plan_issue_action_invalid");
        issueIds.add(issue.id);
      }
    }
    if (targetSnapshot(plan.targets) !== plan.target_snapshot_sha256) {
      throw new Error("profit_canary_retirement_plan_target_snapshot_invalid");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("profit_canary_retirement_")) throw error;
    throw new Error("profit_canary_retirement_plan_schema_invalid", { cause: error });
  }
  return plan;
}

function planBindingMatches(
  value: JsonRecord,
  options: ProfitFlywheelStaleCanaryRetirementOptions,
  operationId: string,
  paths: ReturnType<typeof receiptPaths>,
  expectedReplacement?: ReplacementCloseout,
) {
  try {
    parseCanonicalPlan(value);
  } catch {
    return false;
  }
  const recordedReplacement = asRecord(value.replacement_closeout);
  return value.schema_version === PLAN_SCHEMA_VERSION && value.operation === "profit_flywheel_stale_canary_retirement" &&
    value.mode === "plan" && value.immutable === true && value.operation_id === operationId &&
    value.company_id === options.companyId && value.cutoff_at === options.cutoffAt && value.receipt_dir === options.receiptDir &&
    recordedReplacement.path === options.replacementCloseoutPath && recordedReplacement.sha256 === options.replacementCloseoutSha256 &&
    (!expectedReplacement || sameCanonical(recordedReplacement, expectedReplacement)) &&
    paths.planPath === path.join(options.receiptDir, `${operationId}-profit-flywheel-stale-canary-retirement-plan.json`);
}

async function readExistingJson(pathname: string, prefix: string) {
  const metadata = await lstat(pathname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  return readTrustedJsonFile(pathname, prefix, { maxBytes: 16 * 1024 * 1024 });
}

async function writeOrReusePlan(
  pathname: string,
  plan: StaleCanaryRetirementPlan,
  options: ProfitFlywheelStaleCanaryRetirementOptions,
  operationId: string,
  paths: ReturnType<typeof receiptPaths>,
) {
  const existing = await readExistingJson(pathname, "profit_canary_retirement_existing_plan");
  if (existing) {
    if (!planBindingMatches(existing.value, options, operationId, paths, plan.replacement_closeout)) {
      throw new Error("profit_canary_retirement_existing_plan_conflict");
    }
    return { sha256: existing.sha256, value: existing.value as unknown as StaleCanaryRetirementPlan };
  }
  try {
    const sha256 = await writeImmutableJsonReceipt(pathname, plan);
    return { sha256, value: plan };
  } catch (error) {
    const raced = await readExistingJson(pathname, "profit_canary_retirement_existing_plan");
    if (raced && planBindingMatches(raced.value, options, operationId, paths, plan.replacement_closeout)) {
      return { sha256: raced.sha256, value: raced.value as unknown as StaleCanaryRetirementPlan };
    }
    throw error;
  }
}

function normalizedOptions(options: ProfitFlywheelStaleCanaryRetirementOptions) {
  const companyId = canonicalUuid(options.companyId, "company_id");
  const cutoffAt = canonicalTimestamp(options.cutoffAt, "cutoff_at");
  const replacementCloseoutPath = canonicalAbsolutePath(options.replacementCloseoutPath, "replacement_closeout_path");
  const replacementCloseoutSha256 = canonicalSha256(options.replacementCloseoutSha256, "replacement_closeout_sha256");
  const receiptDir = canonicalAbsolutePath(options.receiptDir, "receipt_dir");
  return { companyId, cutoffAt, replacementCloseoutPath, replacementCloseoutSha256, receiptDir };
}

export async function planProfitFlywheelStaleCanaryRetirement(
  db: Db,
  rawOptions: ProfitFlywheelStaleCanaryRetirementOptions,
  dependencies: RetirementDependencies = {},
) {
  requirePaused(dependencies);
  const options = normalizedOptions(rawOptions);
  const receiptDir = await prepareTrustedReceiptDirectory(options.receiptDir, "profit_canary_retirement_receipt_dir");
  const normalized = { ...options, receiptDir };
  const operationId = operationIdentity(normalized);
  const paths = receiptPaths(receiptDir, operationId);
  const replacement = await readReplacementCloseout(db, normalized, dependencies);
  const replacementWorkflow = await assertReplacementWorkflow(db, normalized.companyId, normalized.cutoffAt, replacement);
  const existing = await readExistingJson(paths.planPath, "profit_canary_retirement_existing_plan");
  if (existing) {
    if (!planBindingMatches(existing.value, normalized, operationId, paths, replacement)) {
      throw new Error("profit_canary_retirement_existing_plan_conflict");
    }
    return {
      status: "planned" as const,
      receiptPath: paths.planPath,
      receiptSha256: existing.sha256,
      plan: existing.value as unknown as StaleCanaryRetirementPlan,
    };
  }
  const candidates = await collectCandidates(db, {
    companyId: normalized.companyId,
    cutoffAt: normalized.cutoffAt,
    replacementWorkflowId: replacementWorkflow.id,
  });
  const blockers = [...candidates.blockers];
  if (candidates.targets.length === 0) blockers.push({ code: "no_retirable_stale_fixture_canaries" });
  const plan: StaleCanaryRetirementPlan = {
    schema_version: PLAN_SCHEMA_VERSION,
    operation: "profit_flywheel_stale_canary_retirement",
    mode: "plan",
    immutable: true,
    operation_id: operationId,
    generated_at: (dependencies.now?.() ?? new Date()).toISOString(),
    company_id: normalized.companyId,
    cutoff_at: normalized.cutoffAt,
    factory_pause_required: true,
    replacement_closeout: replacement,
    receipt_dir: receiptDir,
    target_snapshot_sha256: targetSnapshot(candidates.targets),
    ready: blockers.length === 0,
    blockers,
    targets: candidates.targets,
  };
  const receipt = await writeOrReusePlan(paths.planPath, plan, normalized, operationId, paths);
  return { status: "planned" as const, receiptPath: paths.planPath, receiptSha256: receipt.sha256, plan: receipt.value };
}

function requirePlan(
  value: JsonRecord,
  rawOptions: ApplyProfitFlywheelStaleCanaryRetirementOptions,
  options: ReturnType<typeof normalizedOptions>,
  operationId: string,
  paths: ReturnType<typeof receiptPaths>,
  replacement: ReplacementCloseout,
) {
  let plan: StaleCanaryRetirementPlan;
  try {
    plan = parseCanonicalPlan(value);
  } catch {
    throw new Error("profit_canary_retirement_plan_binding_invalid");
  }
  if (!planBindingMatches(value, options, operationId, paths, replacement)) {
    throw new Error("profit_canary_retirement_plan_binding_invalid");
  }
  if (rawOptions.planPath !== paths.planPath) {
    throw new Error("profit_canary_retirement_plan_path_invalid");
  }
  return plan;
}

type BackupEvidence = {
  backup_file: string;
  compression: RunDatabaseBackupResult["compression"];
  size_bytes: number;
  sha256: string;
  mode: "0400";
  pruned_count: number;
};

function currentUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function sameBackupMetadata(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.uid === right.uid &&
    left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validSealedBackupMetadata(metadata: Stats, expectedSize: number) {
  const uid = currentUid();
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 && metadata.size === expectedSize &&
    (uid === null || metadata.uid === uid) && (metadata.mode & 0o777) === 0o400;
}

async function canonicalBackupPath(pathname: string) {
  const requested = canonicalAbsolutePath(pathname, "backup_file");
  const canonical = await realpath(requested).catch(() => "");
  if (!canonical || canonical !== requested) throw new Error("profit_canary_retirement_backup_path_not_canonical");
  return canonical;
}

/**
 * Hash through the already-verified descriptor.  This is deliberately shared
 * by verification and sealing so a sealed backup is never chmod/fsync'd on
 * one inode then hashed through a freshly opened pathname that an attacker can
 * substitute in between.
 */
async function hashVerifiedSealedBackupHandle(
  handle: FileHandle,
  canonical: string,
  expected: { sizeBytes: number; sha256?: string },
  expectedPath?: Stats,
) {
  const beforePath = expectedPath ?? await lstat(canonical).catch(() => null);
  if (!beforePath || !validSealedBackupMetadata(beforePath, expected.sizeBytes)) {
    throw new Error("profit_canary_retirement_backup_file_invalid");
  }
  const before = await handle.stat();
  if (!validSealedBackupMetadata(before, expected.sizeBytes) || !sameBackupMetadata(before, beforePath)) {
    throw new Error("profit_canary_retirement_backup_inode_changed");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
  let offset = 0;
  while (offset < before.size) {
    const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
    if (result.bytesRead === 0) throw new Error("profit_canary_retirement_backup_short_read");
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const overflowProbe = Buffer.alloc(1);
  const overflow = await handle.read(overflowProbe, 0, 1, before.size);
  const [after, afterPath] = await Promise.all([handle.stat(), lstat(canonical).catch(() => null)]);
  if (overflow.bytesRead !== 0 || !sameBackupMetadata(after, before) || !afterPath ||
      !validSealedBackupMetadata(afterPath, expected.sizeBytes) || !sameBackupMetadata(afterPath, before)) {
    throw new Error("profit_canary_retirement_backup_changed_during_hash");
  }
  const sha256 = hash.digest("hex");
  if (expected.sha256 && sha256 !== expected.sha256) {
    throw new Error("profit_canary_retirement_backup_hash_mismatch");
  }
  return { path: canonical, sizeBytes: before.size, sha256 };
}

async function hashSealedBackup(pathname: string, expected: { sizeBytes: number; sha256?: string }) {
  const canonical = await canonicalBackupPath(pathname);
  const beforePath = await lstat(canonical).catch(() => null);
  if (!beforePath || !validSealedBackupMetadata(beforePath, expected.sizeBytes)) {
    throw new Error("profit_canary_retirement_backup_file_invalid");
  }
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await hashVerifiedSealedBackupHandle(handle, canonical, expected, beforePath);
  } finally {
    await handle.close();
  }
}

async function sealDatabaseBackup(result: RunDatabaseBackupResult): Promise<BackupEvidence> {
  const backupFile = await canonicalBackupPath(result.backupFile);
  const metadata = await lstat(backupFile).catch(() => null);
  const uid = currentUid();
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size !== result.sizeBytes ||
      (uid !== null && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0) {
    throw new Error("profit_canary_retirement_backup_file_invalid");
  }
  const handle = await open(backupFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameBackupMetadata(opened, metadata)) {
      throw new Error("profit_canary_retirement_backup_inode_changed");
    }
    await handle.chmod(0o400);
    await handle.sync();
    // Snapshot after chmod because chmod necessarily changes ctime.  Keep this
    // descriptor open until hashing and the final pathname/inode rebind check.
    const sealedPath = await lstat(backupFile).catch(() => null);
    const inspected = await hashVerifiedSealedBackupHandle(handle, backupFile, {
      sizeBytes: result.sizeBytes,
    }, sealedPath ?? undefined);
    return {
      backup_file: inspected.path,
      compression: result.compression,
      size_bytes: inspected.sizeBytes,
      sha256: inspected.sha256,
      mode: "0400",
      pruned_count: result.prunedCount,
    };
  } finally {
    await handle.close();
  }
}

async function verifyBackupEvidence(value: unknown): Promise<BackupEvidence> {
  const record = asRecord(value);
  const backupFile = canonicalAbsolutePath(requireString(record, "backup_file", "backup"), "backup_file");
  const sizeBytes = record.size_bytes;
  const sha256 = canonicalSha256(requireString(record, "sha256", "backup"), "backup_sha256");
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || record.mode !== "0400" ||
      (record.compression !== "gzip" && record.compression !== "none") ||
      !Number.isInteger(record.pruned_count) || Number(record.pruned_count) < 0) {
    throw new Error("profit_canary_retirement_backup_evidence_invalid");
  }
  const inspected = await hashSealedBackup(backupFile, { sizeBytes: Number(sizeBytes), sha256 });
  return {
    backup_file: inspected.path,
    compression: record.compression,
    size_bytes: inspected.sizeBytes,
    sha256: inspected.sha256,
    mode: "0400",
    pruned_count: Number(record.pruned_count),
  };
}

type RetirementIntent = {
  schema_version: typeof INTENT_SCHEMA_VERSION;
  operation: "profit_flywheel_stale_canary_retirement";
  phase: "prepared";
  immutable: true;
  operation_id: string;
  recorded_at: string;
  retired_at: string;
  plan: { path: string; sha256: string };
  replacement_closeout: ReplacementCloseout;
  database_backup: BackupEvidence;
  final_receipt_path: string;
};

function exactKeys(record: JsonRecord, keys: readonly string[]) {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validCanonicalTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return canonicalTimestamp(value, "receipt_timestamp") === value;
  } catch {
    return false;
  }
}

function intentMatches(
  value: JsonRecord,
  operationId: string,
  planPath: string,
  planSha256: string,
  resultPath: string,
  replacement: ReplacementCloseout,
) {
  const plan = asRecord(value.plan);
  const recordedReplacement = asRecord(value.replacement_closeout);
  return value.schema_version === INTENT_SCHEMA_VERSION && value.operation === "profit_flywheel_stale_canary_retirement" &&
    value.phase === "prepared" && value.immutable === true && value.operation_id === operationId &&
    validCanonicalTimestamp(value.recorded_at) && value.retired_at === value.recorded_at &&
    plan.path === planPath && plan.sha256 === planSha256 && value.final_receipt_path === resultPath &&
    sameCanonical(recordedReplacement, replacement) &&
    exactKeys(value, [
      "schema_version", "operation", "phase", "immutable", "operation_id", "recorded_at", "retired_at",
      "plan", "replacement_closeout", "database_backup", "final_receipt_path",
    ]);
}

async function writeOrReuseIntent(pathname: string, intent: RetirementIntent) {
  const existing = await readExistingJson(pathname, "profit_canary_retirement_existing_intent");
  if (existing) {
    if (!intentMatches(
      existing.value,
      intent.operation_id,
      intent.plan.path,
      intent.plan.sha256,
      intent.final_receipt_path,
      intent.replacement_closeout,
    ) || !sameCanonical(asRecord(existing.value.database_backup), intent.database_backup)) {
      throw new Error("profit_canary_retirement_existing_intent_conflict");
    }
    return { sha256: existing.sha256, value: existing.value as unknown as RetirementIntent };
  }
  try {
    const sha256 = await writeImmutableJsonReceipt(pathname, intent);
    return { sha256, value: intent };
  } catch (error) {
    const raced = await readExistingJson(pathname, "profit_canary_retirement_existing_intent");
    if (raced && intentMatches(
      raced.value,
      intent.operation_id,
      intent.plan.path,
      intent.plan.sha256,
      intent.final_receipt_path,
      intent.replacement_closeout,
    ) && sameCanonical(asRecord(raced.value.database_backup), intent.database_backup)) {
      return { sha256: raced.sha256, value: raced.value as unknown as RetirementIntent };
    }
    throw error;
  }
}

function auditDedupe(operationId: string, kind: string, id: string) {
  return `stale-canary-retirement:${operationId}:${kind}:${id}`;
}

type RetirementAuditEvent = {
  companyId: string;
  workflowId: string;
  stageRunId: string | null;
  eventType: string;
  dedupeKey: string;
  fromState: string | null;
  toState: string | null;
  correlationId: string;
  traceId: string;
  spanId: string | null;
  payload: JsonRecord;
  processedAt: Date;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function sameDate(left: Date | null, right: Date) {
  return left?.toISOString() === right.toISOString();
}

function auditEventMatches(existing: EventRow | null, input: RetirementAuditEvent) {
  return Boolean(existing && existing.companyId === input.companyId && existing.workflowId === input.workflowId &&
    existing.stageRunId === input.stageRunId && existing.eventType === input.eventType &&
    existing.dedupeKey === input.dedupeKey && existing.fromState === input.fromState && existing.toState === input.toState &&
    existing.correlationId === input.correlationId && existing.traceId === input.traceId && existing.spanId === input.spanId &&
    sameCanonical(existing.payload, input.payload) && existing.attemptCount === 0 && existing.lastError === null &&
    sameDate(existing.processedAt, input.processedAt) && sameDate(existing.nextAttemptAt, input.nextAttemptAt) &&
    sameDate(existing.createdAt, input.createdAt) && sameDate(existing.updatedAt, input.updatedAt));
}

async function appendVerifiedAuditEvent(db: Db, input: RetirementAuditEvent) {
  const inserted = await db.insert(profitFlywheelEvents).values(input).onConflictDoNothing()
    .returning({ id: profitFlywheelEvents.id });
  if (inserted.length === 1) return;
  const existing = await db.select().from(profitFlywheelEvents).where(and(
    eq(profitFlywheelEvents.workflowId, input.workflowId),
    eq(profitFlywheelEvents.dedupeKey, input.dedupeKey),
  )).then((rows) => rows[0] ?? null);
  if (!auditEventMatches(existing, input)) {
    throw new Error("profit_canary_retirement_audit_dedupe_conflict:" + input.dedupeKey);
  }
}

function expectedRetirementAudits(
  plan: StaleCanaryRetirementPlan,
  target: RetirementTarget,
  operationId: string,
  retiredAt: Date,
): RetirementAuditEvent[] {
  const common = {
    companyId: plan.company_id,
    workflowId: target.workflow.id,
    correlationId: target.workflow.correlation_id,
    traceId: target.workflow.trace_id,
    processedAt: retiredAt,
    nextAttemptAt: retiredAt,
    createdAt: retiredAt,
    updatedAt: retiredAt,
  };
  return [
    {
      ...common,
      stageRunId: null,
      eventType: "retirement_workflow_cancelled",
      dedupeKey: auditDedupe(operationId, "workflow", target.workflow.id),
      fromState: target.workflow.state,
      toState: "cancelled",
      spanId: null,
      payload: { operation_id: operationId, replacement_closeout_sha256: plan.replacement_closeout.sha256 },
    },
    ...target.stages_to_cancel.map((stage) => ({
      ...common,
      stageRunId: stage.id,
      eventType: "retirement_stage_cancelled",
      dedupeKey: auditDedupe(operationId, "stage", stage.id),
      fromState: stage.state,
      toState: "cancelled",
      spanId: stage.span_id,
      payload: { operation_id: operationId, replacement_closeout_sha256: plan.replacement_closeout.sha256 },
    })),
    ...target.events_to_drain.map((event) => ({
      ...common,
      stageRunId: event.stage_run_id,
      eventType: "retirement_event_drained",
      dedupeKey: auditDedupe(operationId, "drained-event", event.id),
      fromState: event.from_state,
      toState: event.to_state,
      spanId: event.span_id,
      payload: { operation_id: operationId, drained_event_id: event.id, original_event_type: event.event_type },
    })),
  ];
}

async function completedRetirementState(
  db: Db,
  plan: StaleCanaryRetirementPlan,
  operationId: string,
  retiredAt: Date,
) {
  for (const target of plan.targets) {
    const workflow = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, target.workflow.id))
      .then((rows) => rows[0] ?? null);
    if (!workflow || workflow.companyId !== plan.company_id || workflow.state !== "cancelled" ||
        workflow.currentStage !== target.workflow.current_stage || workflow.runId !== target.workflow.run_id ||
        workflow.correlationId !== target.workflow.correlation_id || workflow.traceId !== target.workflow.trace_id ||
        workflow.blockerCode !== "profit_flywheel_fixture_canary_superseded" ||
        workflow.blockerDetail !== `Superseded by immutable closeout ${plan.replacement_closeout.sha256}` ||
        workflow.nextOwner !== "none" || workflow.resumeCondition !== "terminal_retirement_non_compensable" ||
        !sameDate(workflow.completedAt, retiredAt)) return false;
    const stageIds = target.stages_to_cancel.map((stage) => stage.id);
    if (stageIds.length > 0) {
      const stages = await db.select().from(profitFlywheelStageRuns).where(inArray(profitFlywheelStageRuns.id, stageIds));
      const stageById = new Map(stages.map((stage) => [stage.id, stage]));
      if (stages.length !== stageIds.length || target.stages_to_cancel.some((planned) => {
        const stage = stageById.get(planned.id);
        return !stage || stage.workflowId !== target.workflow.id || stage.companyId !== plan.company_id ||
          stage.state !== "cancelled" || stage.retryAt || stage.dispatchClaimId || stage.dispatchClaimedAt ||
          stage.leaseOwner || stage.leaseExpiresAt || stage.leaseActorType || stage.leaseActorId || stage.heartbeatAt ||
          stage.blockerCode !== "profit_flywheel_fixture_canary_superseded" ||
          stage.blockerDetail !== `Superseded by immutable closeout ${plan.replacement_closeout.sha256}` ||
          stage.nextOwner !== "none" || stage.resumeCondition !== "terminal_retirement_non_compensable" ||
          !sameDate(stage.completedAt, retiredAt);
      })) return false;
    }
    const workflowEvents = await db.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.workflowId, target.workflow.id),
    ));
    if (workflowEvents.some((event) => event.processedAt === null)) return false;
    const eventById = new Map(workflowEvents.map((event) => [event.id, event]));
    if (target.events_to_drain.some((planned) => {
      const event = eventById.get(planned.id);
      return !event || event.eventType !== planned.event_type || event.fromState !== planned.from_state ||
        event.toState !== planned.to_state || event.spanId !== planned.span_id ||
        !sameDate(event.processedAt, retiredAt) || event.lastError !== "profit_flywheel_stale_fixture_canary_retired";
    })) return false;
    const auditByDedupe = new Map(workflowEvents.map((event) => [event.dedupeKey, event]));
    if (expectedRetirementAudits(plan, target, operationId, retiredAt)
      .some((expected) => !auditEventMatches(auditByDedupe.get(expected.dedupeKey) ?? null, expected))) return false;
    for (const issue of target.linked_issues.filter((entry) => entry.action === "cancel")) {
      const row = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0] ?? null);
      if (!row || row.companyId !== plan.company_id || row.status !== "cancelled" ||
          !sameDate(row.cancelledAt, retiredAt) || row.checkoutRunId || row.executionRunId) return false;
    }
    for (const issue of target.linked_issues.filter((entry) =>
      entry.action === "retained_unverified" || entry.action === "retained_terminal" || entry.action === "already_terminal")) {
      const row = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0] ?? null);
      if (!row || row.companyId !== plan.company_id || row.status !== issue.status ||
          row.updatedAt.toISOString() !== issue.updated_at ||
          (row.completedAt?.toISOString() ?? null) !== issue.completed_at ||
          (row.cancelledAt?.toISOString() ?? null) !== issue.cancelled_at ||
          row.checkoutRunId || row.executionRunId) return false;
    }
  }
  const remaining = await collectCandidates(db, {
    companyId: plan.company_id,
    cutoffAt: plan.cutoff_at,
    replacementWorkflowId: plan.replacement_closeout.identity.workflow_id,
  });
  return remaining.targets.length === 0 && remaining.blockers.length === 0;
}

async function cancelTargets(
  db: Db,
  plan: StaleCanaryRetirementPlan,
  operationId: string,
  retiredAt: Date,
) {
  const now = retiredAt;
  for (const target of plan.targets) {
    const workflow = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, target.workflow.id))
      .then((rows) => rows[0] ?? null);
    if (!workflow || workflow.state !== target.workflow.state || workflow.updatedAt.toISOString() !== target.workflow.updated_at) {
      throw new Error("profit_canary_retirement_plan_drift_workflow:" + target.workflow.id);
    }
    for (const planned of target.stages_to_cancel) {
      const stage = await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, planned.id))
        .then((rows) => rows[0] ?? null);
      if (!stage || stage.workflowId !== workflow.id || stage.state !== planned.state ||
          stage.updatedAt.toISOString() !== planned.updated_at || !ELIGIBLE_NONTERMINAL_STATES.has(stage.state) ||
          stage.leaseOwner || stage.leaseExpiresAt || stage.leaseActorType || stage.leaseActorId ||
          stage.heartbeatAt || stage.dispatchClaimId || stage.dispatchClaimedAt ||
          !stageCanTransitionToCancelled(stage, workflow.contractSnapshot)) {
        throw new Error("profit_canary_retirement_plan_drift_stage:" + planned.id);
      }
      const changed = await db.update(profitFlywheelStageRuns).set({
        state: "cancelled",
        retryAt: null,
        dispatchClaimId: null,
        dispatchClaimedAt: null,
        blockerCode: "profit_flywheel_fixture_canary_superseded",
        blockerDetail: `Superseded by immutable closeout ${plan.replacement_closeout.sha256}`,
        nextOwner: "none",
        resumeCondition: "terminal_retirement_non_compensable",
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelStageRuns.id, stage.id),
        eq(profitFlywheelStageRuns.state, stage.state),
        isNull(profitFlywheelStageRuns.leaseOwner),
        isNull(profitFlywheelStageRuns.leaseExpiresAt),
        isNull(profitFlywheelStageRuns.leaseActorType),
        isNull(profitFlywheelStageRuns.leaseActorId),
        isNull(profitFlywheelStageRuns.heartbeatAt),
      )).returning({ id: profitFlywheelStageRuns.id });
      if (changed.length !== 1) throw new Error("profit_canary_retirement_cas_stage_failed:" + stage.id);
      await appendVerifiedAuditEvent(db, {
        companyId: workflow.companyId,
        workflowId: workflow.id,
        stageRunId: stage.id,
        eventType: "retirement_stage_cancelled",
        dedupeKey: auditDedupe(operationId, "stage", stage.id),
        fromState: stage.state,
        toState: "cancelled",
        correlationId: workflow.correlationId,
        traceId: workflow.traceId,
        spanId: stage.spanId,
        payload: { operation_id: operationId, replacement_closeout_sha256: plan.replacement_closeout.sha256 },
        processedAt: now,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const plannedIssue of target.linked_issues.filter((entry) => entry.action === "cancel")) {
      const issue = await db.select().from(issues).where(eq(issues.id, plannedIssue.id)).then((rows) => rows[0] ?? null);
      const linkedStage = await db.select().from(profitFlywheelStageRuns)
        .where(eq(profitFlywheelStageRuns.id, plannedIssue.stage_run_id)).then((rows) => rows[0] ?? null);
      if (!issue || !linkedStage || linkedStage.workflowId !== workflow.id || linkedStage.linkedIssueId !== issue.id ||
          !isDeterministicFixtureIssue(issue, workflow, linkedStage) || issue.status !== plannedIssue.status ||
          issue.checkoutRunId || issue.executionRunId || !OPEN_ISSUE_STATES.has(issue.status)) {
        throw new Error("profit_canary_retirement_plan_drift_issue:" + plannedIssue.id);
      }
      const changed = await db.update(issues).set({
        status: "cancelled",
        cancelledAt: now,
        updatedAt: now,
      }).where(and(
        eq(issues.id, issue.id),
        eq(issues.status, issue.status),
        isNull(issues.checkoutRunId),
        isNull(issues.executionRunId),
      )).returning({ id: issues.id });
      if (changed.length !== 1) throw new Error("profit_canary_retirement_cas_issue_failed:" + issue.id);
    }
    for (const plannedEvent of target.events_to_drain) {
      const event = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, plannedEvent.id))
        .then((rows) => rows[0] ?? null);
      if (!event || event.workflowId !== workflow.id || event.processedAt || event.updatedAt.toISOString() !== plannedEvent.updated_at) {
        throw new Error("profit_canary_retirement_plan_drift_event:" + plannedEvent.id);
      }
      const changed = await db.update(profitFlywheelEvents).set({
        processedAt: now,
        lastError: "profit_flywheel_stale_fixture_canary_retired",
        updatedAt: now,
      }).where(and(
        eq(profitFlywheelEvents.id, event.id),
        isNull(profitFlywheelEvents.processedAt),
      )).returning({ id: profitFlywheelEvents.id });
      if (changed.length !== 1) throw new Error("profit_canary_retirement_cas_event_failed:" + event.id);
      await appendVerifiedAuditEvent(db, {
        companyId: workflow.companyId,
        workflowId: workflow.id,
        stageRunId: event.stageRunId,
        eventType: "retirement_event_drained",
        dedupeKey: auditDedupe(operationId, "drained-event", event.id),
        fromState: event.fromState,
        toState: event.toState,
        correlationId: workflow.correlationId,
        traceId: workflow.traceId,
        spanId: event.spanId,
        payload: { operation_id: operationId, drained_event_id: event.id, original_event_type: event.eventType },
        processedAt: now,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const changedWorkflow = await db.update(profitFlywheelWorkflows).set({
      state: "cancelled",
      blockerCode: "profit_flywheel_fixture_canary_superseded",
      blockerDetail: `Superseded by immutable closeout ${plan.replacement_closeout.sha256}`,
      nextOwner: "none",
      resumeCondition: "terminal_retirement_non_compensable",
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(profitFlywheelWorkflows.id, workflow.id),
      eq(profitFlywheelWorkflows.state, workflow.state),
    )).returning({ id: profitFlywheelWorkflows.id });
    if (changedWorkflow.length !== 1) throw new Error("profit_canary_retirement_cas_workflow_failed:" + workflow.id);
    await appendVerifiedAuditEvent(db, {
      companyId: workflow.companyId,
      workflowId: workflow.id,
      stageRunId: null,
      eventType: "retirement_workflow_cancelled",
      dedupeKey: auditDedupe(operationId, "workflow", workflow.id),
      fromState: workflow.state,
      toState: "cancelled",
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: null,
      payload: { operation_id: operationId, replacement_closeout_sha256: plan.replacement_closeout.sha256 },
      processedAt: now,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}

type RetirementResult = {
  schema_version: typeof RESULT_SCHEMA_VERSION;
  operation: "profit_flywheel_stale_canary_retirement";
  status: "retired";
  immutable: true;
  operation_id: string;
  retired_at: string;
  company_id: string;
  cutoff_at: string;
  plan: { path: string; sha256: string };
  intent: { path: string; sha256: string };
  replacement_closeout: ReplacementCloseout;
  database_backup: BackupEvidence;
  retired: {
    workflow_ids: string[];
    stage_run_ids: string[];
    deterministic_issue_ids_cancelled: string[];
    non_deterministic_issue_ids_retained: string[];
    event_ids_drained: string[];
  };
  rollback: {
    state: "non_compensable";
    cas_reversible: false;
    reason: string;
    required_recovery: string;
  };
};

function buildResult(
  plan: StaleCanaryRetirementPlan,
  intent: RetirementIntent,
  paths: ReturnType<typeof receiptPaths>,
  planSha256: string,
  intentSha256: string,
): RetirementResult {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    operation: "profit_flywheel_stale_canary_retirement",
    status: "retired",
    immutable: true,
    operation_id: plan.operation_id,
    retired_at: intent.retired_at,
    company_id: plan.company_id,
    cutoff_at: plan.cutoff_at,
    plan: { path: paths.planPath, sha256: planSha256 },
    intent: { path: paths.intentPath, sha256: intentSha256 },
    replacement_closeout: plan.replacement_closeout,
    database_backup: intent.database_backup,
    retired: {
      workflow_ids: plan.targets.map((target) => target.workflow.id),
      stage_run_ids: plan.targets.flatMap((target) => target.stages_to_cancel.map((stage) => stage.id)),
      deterministic_issue_ids_cancelled: plan.targets.flatMap((target) => target.linked_issues
        .filter((issue) => issue.action === "cancel").map((issue) => issue.id)),
      non_deterministic_issue_ids_retained: plan.targets.flatMap((target) => target.linked_issues
        .filter((issue) => issue.action === "retained_unverified" || issue.action === "retained_terminal")
        .map((issue) => issue.id)),
      event_ids_drained: plan.targets.flatMap((target) => target.events_to_drain.map((event) => event.id)),
    },
    rollback: {
      state: "non_compensable",
      cas_reversible: false,
      reason: "Cancelled is terminal in the frozen Profit Flywheel contract; reversing it would reanimate explicitly superseded work.",
      required_recovery: "Restore the mandatory pre-retirement embedded PostgreSQL backup only after an explicit instance-wide recovery decision. Do not mutate cancelled rows directly.",
    },
  };
}

function resultMatches(value: JsonRecord, result: RetirementResult) {
  return exactKeys(value, [
    "schema_version", "operation", "status", "immutable", "operation_id", "retired_at", "company_id", "cutoff_at",
    "plan", "intent", "replacement_closeout", "database_backup", "retired", "rollback",
  ]) && sameCanonical(value, result);
}

async function writeOrReuseResult(pathname: string, result: RetirementResult) {
  const existing = await readExistingJson(pathname, "profit_canary_retirement_existing_result");
  if (existing) {
    if (!resultMatches(existing.value, result)) throw new Error("profit_canary_retirement_existing_result_conflict");
    return { sha256: existing.sha256, value: existing.value as unknown as RetirementResult };
  }
  try {
    const sha256 = await writeImmutableJsonReceipt(pathname, result);
    return { sha256, value: result };
  } catch (error) {
    const raced = await readExistingJson(pathname, "profit_canary_retirement_existing_result");
    if (raced && resultMatches(raced.value, result)) {
      return { sha256: raced.sha256, value: raced.value as unknown as RetirementResult };
    }
    throw error;
  }
}

export async function applyProfitFlywheelStaleCanaryRetirement(
  db: Db,
  rawOptions: ApplyProfitFlywheelStaleCanaryRetirementOptions,
  dependencies: RetirementDependencies = {},
) {
  const entryPause = requirePaused(dependencies);
  const options = normalizedOptions(rawOptions);
  const receiptDir = await prepareTrustedReceiptDirectory(options.receiptDir, "profit_canary_retirement_receipt_dir");
  const normalized = { ...options, receiptDir };
  const operationId = operationIdentity(normalized);
  const paths = receiptPaths(receiptDir, operationId);
  const requestedPlanPath = canonicalAbsolutePath(rawOptions.planPath, "plan_path");
  const requestedPlanSha256 = canonicalSha256(rawOptions.planSha256, "plan_sha256");
  if (requestedPlanPath !== paths.planPath) throw new Error("profit_canary_retirement_plan_path_invalid");
  const replacement = await readReplacementCloseout(db, normalized, dependencies);
  await assertReplacementWorkflow(db, normalized.companyId, normalized.cutoffAt, replacement);
  const loadedPlan = await readTrustedJsonFile(requestedPlanPath, "profit_canary_retirement_plan", { maxBytes: 16 * 1024 * 1024 });
  if (loadedPlan.sha256 !== requestedPlanSha256) throw new Error("profit_canary_retirement_plan_hash_mismatch");
  const plan = requirePlan(loadedPlan.value, rawOptions, normalized, operationId, paths, replacement);
  if (!sameCanonical(plan.replacement_closeout, replacement) || !plan.ready) {
    throw new Error("profit_canary_retirement_plan_not_applyable");
  }

  const existingResult = await readExistingJson(paths.resultPath, "profit_canary_retirement_existing_result");
  let intentArtifact = await readExistingJson(paths.intentPath, "profit_canary_retirement_existing_intent");
  let intent: RetirementIntent;
  let intentSha256: string;
  if (intentArtifact) {
    if (!intentMatches(
      intentArtifact.value,
      operationId,
      paths.planPath,
      requestedPlanSha256,
      paths.resultPath,
      replacement,
    )) {
      throw new Error("profit_canary_retirement_existing_intent_conflict");
    }
    const verifiedBackup = await verifyBackupEvidence(intentArtifact.value.database_backup);
    if (!sameCanonical(asRecord(intentArtifact.value.database_backup), verifiedBackup)) {
      throw new Error("profit_canary_retirement_existing_intent_backup_conflict");
    }
    intent = { ...intentArtifact.value, database_backup: verifiedBackup } as unknown as RetirementIntent;
    intentSha256 = intentArtifact.sha256;
  } else {
    if (existingResult) throw new Error("profit_canary_retirement_result_without_intent");
    if (!dependencies.databaseBackup) throw new Error("profit_canary_retirement_backup_configuration_required");
    const backupRunner = dependencies.backupRunner ?? runDatabaseBackup;
    const backup = await backupRunner({
      connectionString: dependencies.databaseBackup.connectionString,
      backupDir: dependencies.databaseBackup.backupDir,
      retentionDays: dependencies.databaseBackup.retentionDays,
      keepLatestBackups: dependencies.databaseBackup.keepLatestBackups ?? 5,
      filenamePrefix: "profit-flywheel-stale-canary-retirement",
      compression: "gzip",
    });
    const sealedBackup = await sealDatabaseBackup(backup);
    const recordedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const candidateIntent: RetirementIntent = {
      schema_version: INTENT_SCHEMA_VERSION,
      operation: "profit_flywheel_stale_canary_retirement",
      phase: "prepared",
      immutable: true,
      operation_id: operationId,
      recorded_at: recordedAt,
      retired_at: recordedAt,
      plan: { path: paths.planPath, sha256: requestedPlanSha256 },
      replacement_closeout: replacement,
      database_backup: sealedBackup,
      final_receipt_path: paths.resultPath,
    };
    const saved = await writeOrReuseIntent(paths.intentPath, candidateIntent);
    intent = saved.value;
    intentSha256 = saved.sha256;
  }
  const expectedResult = buildResult(plan, intent, paths, requestedPlanSha256, intentSha256);
  if (existingResult) {
    if (!resultMatches(existingResult.value, expectedResult)) {
      throw new Error("profit_canary_retirement_existing_result_conflict");
    }
    if (!await completedRetirementState(db, plan, operationId, new Date(intent.retired_at))) {
      throw new Error("profit_canary_retirement_existing_result_db_postcondition_failed");
    }
    return {
      status: "retired" as const,
      receiptPath: paths.resultPath,
      receiptSha256: existingResult.sha256,
      result: existingResult.value as unknown as RetirementResult,
    };
  }
  await dependencies.afterIntentBeforeMutation?.();
  // Re-read the live selected-instance authority after all durable intent and
  // backup work, then again under the mutation locks below. A pause release at
  // either point fails closed before a workflow/stage/event/issue can change.
  const preMutationPause = requirePaused(dependencies, entryPause.generation);

  const retirementApplied = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql.raw("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"));
    await tx.execute(sql.raw(
      "LOCK TABLE profit_flywheel_workflows, profit_flywheel_stage_runs, profit_flywheel_leases, profit_flywheel_events, issues IN SHARE ROW EXCLUSIVE MODE",
    ));
    requirePaused(dependencies, preMutationPause.generation);
    if (await completedRetirementState(tx, plan, operationId, new Date(intent.retired_at))) return "recovered" as const;
    const lockedReplacement = await assertReplacementWorkflow(tx, normalized.companyId, normalized.cutoffAt, replacement);
    const current = await collectCandidates(tx, {
      companyId: normalized.companyId,
      cutoffAt: normalized.cutoffAt,
      replacementWorkflowId: lockedReplacement.id,
      lockRows: true,
    });
    if (current.blockers.length > 0 || targetSnapshot(plan.targets) !== plan.target_snapshot_sha256 ||
        targetSnapshot(current.targets) !== plan.target_snapshot_sha256 || !sameCanonical(current.targets, plan.targets)) {
      throw new Error("profit_canary_retirement_plan_drift");
    }
    // Mutate only the candidates re-read under serializable locks. This guards
    // against a validly hashed immutable plan that omitted a stage, issue,
    // event, or entire workflow from the selected retirement set.
    const lockedPlan: StaleCanaryRetirementPlan = { ...plan, targets: current.targets, blockers: current.blockers };
    requirePaused(dependencies, preMutationPause.generation);
    await cancelTargets(tx, lockedPlan, operationId, new Date(intent.retired_at));
    if (!await completedRetirementState(tx, lockedPlan, operationId, new Date(intent.retired_at))) {
      throw new Error("profit_canary_retirement_postcondition_failed");
    }
    return "applied" as const;
  });
  void retirementApplied;
  await dependencies.afterDatabaseMutationBeforeFinalReceipt?.();
  const savedResult = await writeOrReuseResult(paths.resultPath, expectedResult);
  return { status: "retired" as const, receiptPath: paths.resultPath, receiptSha256: savedResult.sha256, result: savedResult.value };
}

const PLAN_FLAGS: Record<string, keyof ProfitFlywheelStaleCanaryRetirementOptions> = {
  "--company-id": "companyId",
  "--cutoff-at": "cutoffAt",
  "--replacement-closeout": "replacementCloseoutPath",
  "--replacement-closeout-sha256": "replacementCloseoutSha256",
  "--receipt-dir": "receiptDir",
};
const APPLY_FLAGS: Record<string, keyof ApplyProfitFlywheelStaleCanaryRetirementOptions> = {
  ...PLAN_FLAGS,
  "--plan-path": "planPath",
  "--plan-sha256": "planSha256",
};

export function parseStaleCanaryRetirementCliArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.DATABASE_URL?.trim() || environment.POSTGRES_URL?.trim()) {
    throw new Error("profit_canary_retirement_database_url_forbidden");
  }
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const mode = args[0];
  if (mode !== "plan" && mode !== "apply") throw new Error("profit_canary_retirement_mode_required");
  const flags = mode === "plan" ? PLAN_FLAGS : APPLY_FLAGS;
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    const key = flags[flag];
    if (/(?:credential|password|secret|token|api-key|database-url|postgres-url|connection-string)/i.test(flag)) {
      throw new Error("profit_canary_retirement_credential_argv_forbidden");
    }
    if (!key || flag.includes("=") || values[key] !== undefined) {
      throw new Error("profit_canary_retirement_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("profit_canary_retirement_argument_missing:" + flag);
    values[key] = value;
    index += 1;
  }
  for (const [flag, key] of Object.entries(flags)) {
    if (!values[key]) throw new Error("profit_canary_retirement_argument_required:" + flag);
  }
  return { mode, options: values as unknown as ProfitFlywheelStaleCanaryRetirementOptions & ApplyProfitFlywheelStaleCanaryRetirementOptions };
}

export function resolveEmbeddedStaleCanaryRetirementConnection(config: {
  databaseMode: string;
  embeddedPostgresPort: number;
}) {
  if (config.databaseMode !== "embedded-postgres") {
    throw new Error("profit_canary_retirement_embedded_instance_required");
  }
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("profit_canary_retirement_embedded_port_invalid");
  }
  return "postgres://paperclip:paperclip@127.0.0.1:" + port + "/paperclip";
}

function usage() {
  return "Usage: pnpm ops:profit-flywheel-stale-canary-retirement -- <plan|apply> " +
    "--company-id <uuid> --cutoff-at <ISO-8601> --replacement-closeout <absolute-path> " +
    "--replacement-closeout-sha256 <sha256> --receipt-dir <absolute-path> " +
    "[--plan-path <absolute-path> --plan-sha256 <sha256>]";
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const parsed = parseStaleCanaryRetirementCliArgs(process.argv.slice(2));
  const { loadConfig } = await import("../config.js");
  const { readFactoryPauseAuthoritySnapshot } = await import("../config-file.js");
  const config = loadConfig();
  const connectionString = resolveEmbeddedStaleCanaryRetirementConnection(config);
  const db = createDb(connectionString);
  try {
    if (parsed.mode === "plan") {
      const outcome = await planProfitFlywheelStaleCanaryRetirement(db, parsed.options, {
        factoryPauseAuthority: readFactoryPauseAuthoritySnapshot,
      });
      console.log(JSON.stringify({ status: outcome.status, receipt_path: outcome.receiptPath, receipt_sha256: outcome.receiptSha256 }));
      return;
    }
    const outcome = await applyProfitFlywheelStaleCanaryRetirement(db, parsed.options, {
      factoryPauseAuthority: readFactoryPauseAuthoritySnapshot,
      databaseBackup: {
        connectionString,
        backupDir: config.databaseBackupDir,
        retentionDays: config.databaseBackupRetentionDays,
      },
    });
    console.log(JSON.stringify({ status: outcome.status, receipt_path: outcome.receiptPath, receipt_sha256: outcome.receiptSha256 }));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "profit_canary_retirement_unknown_failure",
    }));
    process.exit(1);
  });
}
