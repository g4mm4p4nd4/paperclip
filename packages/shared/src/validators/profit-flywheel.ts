import { z } from "zod";
import {
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES,
  PROFIT_FLYWHEEL_FACTORY_MODES,
  PROFIT_FLYWHEEL_FACTORY_STATES,
  PROFIT_FLYWHEEL_RUN_STATES,
  PROFIT_FLYWHEEL_SCHEMA_VERSION,
  PROFIT_FLYWHEEL_STAGES,
} from "../types/profit-flywheel.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest");

export const profitFlywheelDispatchInputSchema = z.object({
  sourceSchemaVersion: z.string().trim().min(1).max(160),
  runId: z.string().trim().min(1).max(200),
  dispatchHash: sha256Schema,
  selectionSnapshotHash: sha256Schema,
  inputHash: sha256Schema,
  sourceDispatchPath: z.string().trim().min(1),
  authorizedByPortfolioOs: z.literal(true),
}).strict();

export const profitFlywheelReceiptSchema = z.object({
  type: z.string().trim().min(1).max(120),
  schemaVersion: z.string().trim().min(1).max(160),
  contentHash: sha256Schema,
  artifactRef: z.string().trim().min(1).nullable(),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  attributes: z.record(z.unknown()),
}).strict();

export type ProfitFlywheelDispatchInput = z.infer<typeof profitFlywheelDispatchInputSchema>;
export type ProfitFlywheelReceiptInput = z.infer<typeof profitFlywheelReceiptSchema>;

const nullableSha256Schema = sha256Schema.nullable();
const nullableDatetimeSchema = z.string().datetime({ offset: true }).nullable();
const nonnegativeFiniteSchema = z.number().finite().min(0);
const nullableMetricSchema = nonnegativeFiniteSchema.nullable();

const factoryBaselineRepositorySchema = z.object({
  name: z.enum(["portfolio-os", "paperclip", "hermes-agent", "hermes-paperclip-adapter"]),
  path: z.string().trim().min(1).max(4096),
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  branch: z.string().max(300).nullable(),
  upstream: z.string().max(300).nullable(),
  tracked_changes: z.number().int().min(0),
  untracked_changes: z.number().int().min(0),
  tree_clean: z.boolean(),
}).strict();

export const profitFlywheelFactoryBaselineSchema = z.object({
  schema_version: z.literal("paperclip.profit_flywheel_factory_baseline.v1"),
  company_id: z.string().uuid(),
  captured_at: z.string().datetime({ offset: true }),
  target_workflow: z.object({
    run_id: z.string().trim().min(1).max(200),
    workflow_id: z.string().uuid(),
    state: z.string().trim().min(1).max(80),
    current_stage: z.string().trim().min(1).max(80),
    latest_event: z.record(z.unknown()).nullable(),
  }).strict().nullable(),
  stage_counts: z.array(z.object({
    stage: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(80),
    count: z.number().int().min(0),
  }).strict()).max(100),
  blocker_counts: z.array(z.object({
    code: z.string().trim().min(1).max(160),
    count: z.number().int().min(0),
  }).strict()).max(500),
  provider_policy: z.object({
    sha256: nullableSha256Schema,
    schema_sha256: nullableSha256Schema,
    routes: z.array(z.object({
      route_id: z.string().trim().min(1).max(160),
      provider_family: z.string().trim().min(1).max(160),
      status: z.enum(["healthy", "failed", "quarantined"]),
      failure_class: z.string().max(160).nullable(),
      observed_at: z.string().datetime({ offset: true }),
      expires_at: z.string().datetime({ offset: true }),
    }).strict()).max(200),
  }).strict(),
  repositories: z.array(factoryBaselineRepositorySchema).length(4).superRefine((value, ctx) => {
    if (new Set(value.map((entry) => entry.name)).size !== value.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Repository baseline names must be unique" });
    }
  }),
  adapter: z.object({
    package_name: z.string().max(200).nullable(),
    package_version: z.string().max(80).nullable(),
    plugin_store_version: z.string().max(80).nullable(),
    plugin_store_mode: z.enum(["immutable_bundle", "development_local_path", "missing"]),
    git_commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
    git_branch: z.string().max(300).nullable(),
    file_manifest_sha256: nullableSha256Schema,
  }).strict(),
  tokenomics: z.object({
    receipt_path: z.string().max(4096).nullable(),
    generated_at: nullableDatetimeSchema,
    status: z.string().max(80).nullable(),
    age_seconds: nullableMetricSchema,
    fresh: z.boolean(),
  }).strict(),
  resources: z.object({
    disk: z.object({
      path: z.string().trim().min(1).max(4096),
      total_bytes: z.number().int().min(0),
      free_bytes: z.number().int().min(0),
      available_bytes: z.number().int().min(0),
      free_percent: z.number().min(0).max(100),
    }).strict(),
    database_bytes: z.number().int().min(0).nullable(),
    ops_bytes: z.number().int().min(0).nullable(),
    backup_bytes: z.number().int().min(0).nullable(),
    log_bytes: z.number().int().min(0).nullable(),
    factory_browser_processes: z.object({
      count: z.number().int().min(0),
      rss_bytes: z.number().int().min(0),
    }).strict(),
  }).strict(),
  constraints: z.object({
    live_pos_checkout_preserved: z.literal(true),
    leadforge_excluded: z.literal(true),
    secrets_redacted: z.literal(true),
    promotion_blockers: z.array(z.string().trim().min(1).max(200)).max(50),
  }).strict(),
}).strict();

export const profitFlywheelFactoryHealthSchema = z.object({
  schemaVersion: z.literal("paperclip.profit_flywheel_factory_health.v1"),
  companyId: z.string().uuid(),
  generatedAt: z.string().datetime({ offset: true }),
  state: z.enum(PROFIT_FLYWHEEL_FACTORY_STATES),
  mode: z.enum(PROFIT_FLYWHEEL_FACTORY_MODES),
  pauseNewWork: z.boolean(),
  freshness: z.object({
    ageSeconds: nonnegativeFiniteSchema,
    maxAgeSeconds: z.number().int().positive(),
    stale: z.boolean(),
  }).strict(),
  identities: z.array(z.object({
    component: z.enum(["contract", "provider_policy", "adapter", "portfolio_os", "hermes"]),
    version: z.string().trim().min(1).max(300).nullable(),
    sha256: nullableSha256Schema,
    verified: z.boolean(),
    detail: z.string().trim().min(1).max(1000).nullable(),
  }).strict()).length(5),
  pipeline: z.array(z.object({
    stage: z.enum(PROFIT_FLYWHEEL_STAGES),
    counts: z.object(Object.fromEntries(
      PROFIT_FLYWHEEL_RUN_STATES.map((state) => [state, z.number().int().min(0)]),
    ) as Record<(typeof PROFIT_FLYWHEEL_RUN_STATES)[number], z.ZodNumber>).strict(),
    total: z.number().int().min(0),
    conversionFromDispatch: z.number().finite().min(0).max(1).nullable(),
  }).strict()).length(PROFIT_FLYWHEEL_STAGES.length),
  blockers: z.array(z.object({
    workflowId: z.string().uuid(),
    stageRunId: z.string().uuid(),
    inputHash: sha256Schema,
    issueId: z.string().uuid().nullable(),
    stage: z.enum(PROFIT_FLYWHEEL_STAGES),
    code: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(4000),
    nextOwner: z.string().trim().min(1).max(200),
    resumeCondition: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
    nextAttemptAt: nullableDatetimeSchema,
    ageSeconds: nonnegativeFiniteSchema,
    receiptPath: z.string().trim().min(1).max(4096).nullable(),
    receiptId: z.string().uuid().nullable(),
    receiptSha256: nullableSha256Schema,
  }).strict()).max(1000),
  activeWork: z.array(z.object({
    workflowId: z.string().uuid(),
    stageRunId: z.string().uuid(),
    issueId: z.string().uuid().nullable(),
    targetRepo: z.string().trim().min(1).max(500),
    stage: z.enum(PROFIT_FLYWHEEL_STAGES),
    state: z.enum(PROFIT_FLYWHEEL_RUN_STATES),
    agentId: z.string().uuid().nullable(),
    routeId: z.string().trim().min(1).max(160).nullable(),
    providerFamily: z.string().trim().min(1).max(160).nullable(),
    elapsedSeconds: nonnegativeFiniteSchema,
    heartbeatAt: nullableDatetimeSchema,
    leaseExpiresAt: nullableDatetimeSchema,
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().positive(),
    budgetConsumedTokens: z.number().int().min(0).nullable(),
    budgetLimitTokens: z.number().int().positive().nullable(),
    lastUsefulAction: z.string().trim().min(1).max(1000).nullable(),
  }).strict()).max(1000),
  providerReadiness: z.array(z.object({
    alias: z.enum(PROFIT_FLYWHEEL_CAPABILITY_ALIASES),
    status: z.enum(["ready", "degraded", "unavailable", "unknown"]),
    eligibleRouteCount: z.number().int().min(0),
    distinctProviderFamilies: z.number().int().min(0),
    independentReviewReady: z.boolean(),
    evidence: z.enum(["policy_and_fresh_canary", "observed_route_binding", "missing"]),
    routes: z.array(z.object({
      routeId: z.string().trim().min(1).max(160),
      providerFamily: z.string().trim().min(1).max(160),
      status: z.enum(["healthy", "failed", "quarantined", "unknown"]),
      failureClass: z.string().trim().min(1).max(160).nullable(),
      failureDetail: z.string().trim().min(1).max(1000).nullable(),
      observedAt: nullableDatetimeSchema,
      expiresAt: nullableDatetimeSchema,
    }).strict()).max(200),
  }).strict()).length(PROFIT_FLYWHEEL_CAPABILITY_ALIASES.length),
  economics: z.object({
    tokensPerCompletedDeliverable: nullableMetricSchema,
    costPerCompletedDeliverableUsd: nullableMetricSchema,
    artifactBackedPercentage: z.number().finite().min(0).max(1).nullable(),
    falseSuccessPercentage: z.number().finite().min(0).max(1).nullable(),
    secondIterationCompletionRate: z.number().finite().min(0).max(1).nullable(),
    highBurnEventCount: z.number().int().min(0).nullable(),
    tokenomicsStatus: z.enum(["healthy", "failed", "stale", "unknown"]),
    tokenomicsGeneratedAt: nullableDatetimeSchema,
  }).strict(),
  host: z.object({
    diskAvailableBytes: z.number().int().min(0).nullable(),
    diskFreePercent: z.number().finite().min(0).max(100).nullable(),
    diskState: z.enum(["healthy", "warning", "hard_stop", "unknown"]),
    databaseBytes: z.number().int().min(0).nullable(),
    logBytes: z.number().int().min(0).nullable(),
    archiveBacklogBytes: z.number().int().min(0).nullable(),
    factoryBrowserProcessCount: z.number().int().min(0).nullable(),
  }).strict(),
  closeouts: z.object({
    twoIteration: profitFlywheelReceiptSchema.nullable(),
    shadow: profitFlywheelReceiptSchema.nullable(),
    production: profitFlywheelReceiptSchema.nullable(),
  }).strict(),
  approvalGates: z.array(z.object({
    code: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(2000),
    action: z.enum(["credential", "spend", "publish", "merge", "deploy", "retention", "shadow", "other"]),
  }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  PROFIT_FLYWHEEL_STAGES.forEach((stage, index) => {
    if (value.pipeline[index]?.stage !== stage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pipeline", index, "stage"], message: `Expected canonical stage ${stage}` });
    }
  });
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES.forEach((alias, index) => {
    if (value.providerReadiness[index]?.alias !== alias) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerReadiness", index, "alias"], message: `Expected canonical alias ${alias}` });
    }
  });
  if (value.freshness.stale !== (value.freshness.ageSeconds > value.freshness.maxAgeSeconds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["freshness", "stale"], message: "Stale must match the declared age threshold" });
  }
  if (value.pauseNewWork && value.state !== "paused" && value.host.diskState !== "hard_stop") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Paused dispatch requires paused state unless a disk hard stop forced the pause" });
  }
});

export type ProfitFlywheelFactoryHealthInput = z.infer<typeof profitFlywheelFactoryHealthSchema>;

const factoryRunStateSchema = z.enum(PROFIT_FLYWHEEL_RUN_STATES);
const factoryStageSchema = z.enum(PROFIT_FLYWHEEL_STAGES);
const factoryTextSchema = z.string().trim().min(1).max(4096);

export const profitFlywheelFactoryWorkflowDetailSchema = z.object({
  schemaVersion: z.literal("paperclip.profit_flywheel_factory_workflow_detail.v1"),
  companyId: z.string().uuid(),
  generatedAt: z.string().datetime({ offset: true }),
  workflow: z.object({
    id: z.string().uuid(),
    runId: factoryTextSchema,
    state: factoryRunStateSchema,
    currentStage: factoryStageSchema,
    targetRepo: factoryTextSchema,
    correlationId: factoryTextSchema,
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    sourceSchemaVersion: factoryTextSchema,
    sourceDispatchHash: sha256Schema,
    contractSha256: sha256Schema,
    blockerCode: factoryTextSchema.nullable(),
    blockerDetail: factoryTextSchema.nullable(),
    nextOwner: factoryTextSchema.nullable(),
    resumeCondition: factoryTextSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: nullableDatetimeSchema,
  }).strict(),
  stages: z.array(z.object({
    id: z.string().uuid(),
    stage: factoryStageSchema,
    state: factoryRunStateSchema,
    ownerPlane: z.enum(["portfolio_os", "paperclip", "hermes"]),
    inputSchemaVersion: factoryTextSchema,
    inputHash: sha256Schema,
    sourceHashes: z.record(sha256Schema),
    idempotencyKey: factoryTextSchema,
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().positive(),
    retryAt: nullableDatetimeSchema,
    issueId: z.string().uuid().nullable(),
    routeId: factoryTextSchema.nullable(),
    providerFamily: factoryTextSchema.nullable(),
    providerModel: factoryTextSchema.nullable(),
    providerPolicySha256: nullableSha256Schema,
    providerRouteSha256: nullableSha256Schema,
    transitionSourceStageRunId: z.string().uuid().nullable(),
    transitionSourceOutputHash: nullableSha256Schema,
    requiredReceipts: z.array(factoryTextSchema),
    completionEvidence: z.array(factoryTextSchema),
    checkpointSha256: nullableSha256Schema,
    blockerCode: factoryTextSchema.nullable(),
    blockerDetail: factoryTextSchema.nullable(),
    nextOwner: factoryTextSchema.nullable(),
    resumeCondition: factoryTextSchema.nullable(),
    heartbeatAt: nullableDatetimeSchema,
    leaseExpiresAt: nullableDatetimeSchema,
    startedAt: nullableDatetimeSchema,
    completedAt: nullableDatetimeSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict()).max(5000),
  receipts: z.array(z.object({
    id: z.string().uuid(),
    stageRunId: z.string().uuid(),
    type: factoryTextSchema,
    schemaVersion: factoryTextSchema,
    contentHash: sha256Schema,
    artifactRef: factoryTextSchema.nullable(),
    status: z.enum(["valid", "invalid", "expired", "revoked", "quarantined"]),
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: nullableDatetimeSchema,
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(20_000),
  audit: z.array(z.object({
    id: z.string().uuid(),
    stageRunId: z.string().uuid().nullable(),
    eventType: factoryTextSchema,
    fromState: factoryRunStateSchema.nullable(),
    toState: factoryRunStateSchema.nullable(),
    attempt: z.number().int().min(0),
    nextAttemptAt: z.string().datetime({ offset: true }),
    processedAt: nullableDatetimeSchema,
    lastError: factoryTextSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(50_000),
}).strict().superRefine((value, ctx) => {
  const stageIds = new Set(value.stages.map((stage) => stage.id));
  value.receipts.forEach((receipt, index) => {
    if (!stageIds.has(receipt.stageRunId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receipts", index, "stageRunId"], message: "Receipt must bind a stage in this workflow" });
  });
  value.audit.forEach((event, index) => {
    if (event.stageRunId && !stageIds.has(event.stageRunId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audit", index, "stageRunId"], message: "Audit event must bind a stage in this workflow" });
  });
});

export type ProfitFlywheelFactoryWorkflowDetailInput = z.infer<typeof profitFlywheelFactoryWorkflowDetailSchema>;

const canonicalStageStateSchema = z.enum([
  "pending",
  "running",
  "retry",
  "blocked",
  "degraded",
  "succeeded",
  "failed",
  "cancelled",
  "safely_skipped",
]);

const canonicalRunStateTransitionsSchema = z.object({
  pending: z.tuple([z.literal("running"), z.literal("blocked"), z.literal("cancelled"), z.literal("safely_skipped")]),
  running: z.tuple([
    z.literal("succeeded"),
    z.literal("blocked"),
    z.literal("retry"),
    z.literal("degraded"),
    z.literal("failed"),
    z.literal("cancelled"),
    z.literal("safely_skipped"),
  ]),
  retry: z.tuple([z.literal("running"), z.literal("blocked"), z.literal("failed"), z.literal("cancelled")]),
  blocked: z.tuple([z.literal("pending"), z.literal("retry"), z.literal("failed"), z.literal("cancelled"), z.literal("safely_skipped")]),
  degraded: z.tuple([z.literal("retry"), z.literal("blocked"), z.literal("failed"), z.literal("cancelled"), z.literal("safely_skipped")]),
  succeeded: z.tuple([]),
  failed: z.tuple([]),
  cancelled: z.tuple([]),
  safely_skipped: z.tuple([]),
}).strict();

export const portfolioOsProfitFlywheelStageV2Schema = z.object({
  sequence: z.number().int().min(1).max(PROFIT_FLYWHEEL_STAGES.length),
  owner_plane: z.enum(["portfolio_os", "paperclip", "hermes"]),
  input_schema: z.string().trim().min(1),
  input_hash_fields: z.array(z.string().trim().min(1)).min(1),
  accepts: z.array(canonicalStageStateSchema).min(1),
  terminal_states: z.array(canonicalStageStateSchema).min(1),
  run_state_transitions: canonicalRunStateTransitionsSchema,
  required_receipts: z.array(z.string().trim().min(1)).min(1),
  provider_receipt: z.object({
    mode: z.enum(["required", "conditional_on_inference", "not_applicable"]),
    receipt_name: z.literal("provider_run_receipt"),
    inference_evidence_field: z.string(),
    deterministic_evidence_fields: z.array(z.string().trim().min(1)),
  }).strict(),
  freshness_limit_seconds: z.number().int().positive(),
  idempotency_key: z.string().trim().min(1),
  retry: z.object({
    limit: z.number().int().min(0).max(20),
    backoff_seconds: z.array(z.number().int().min(0)).max(20),
    retryable: z.array(z.string().trim().min(1)),
  }).strict(),
  recovery_actions: z.array(z.string().trim().min(1)).min(1),
  provider_capability_class: z.union([z.literal("deterministic"), z.enum(PROFIT_FLYWHEEL_CAPABILITY_ALIASES)]),
  budgets: z.object({
    turns: z.number().int().min(0),
    context_chars: z.number().int().min(0),
    output_chars: z.number().int().min(0),
    token_limit: z.number().int().min(0),
    tool_output_bytes: z.number().int().positive(),
    tool_output_lines: z.number().int().positive(),
    tool_output_line_chars: z.number().int().positive(),
    max_escalations: z.number().int().min(0),
  }).strict(),
  concurrency_key: z.string().trim().min(1),
  concurrency_limit: z.number().int().positive(),
  completion_evidence: z.array(z.string().trim().min(1)).min(1),
  feedback_fields: z.array(z.string().trim().min(1)),
  guards: z.array(z.string().trim().min(1)).optional(),
}).strict();

const canonicalStagesShape = Object.fromEntries(
  PROFIT_FLYWHEEL_STAGES.map((stage) => [stage, portfolioOsProfitFlywheelStageV2Schema]),
) as Record<(typeof PROFIT_FLYWHEEL_STAGES)[number], typeof portfolioOsProfitFlywheelStageV2Schema>;

export const portfolioOsProfitFlywheelContractV2Schema = z.object({
  $schema: z.literal("./profit-flywheel.v2.schema.json"),
  schema_version: z.literal(PROFIT_FLYWHEEL_SCHEMA_VERSION),
  contract_id: z.literal("profit-flywheel"),
  authority: z.object({
    canonical_author: z.literal("portfolio_os"),
    dispatch_authorizer: z.literal("portfolio_os"),
    workflow_cockpit: z.literal("paperclip"),
    runtime_executor: z.literal("hermes"),
    rule: z.string().trim().min(1),
  }).strict(),
  states: z.object({
    active: z.tuple([z.literal("pending"), z.literal("running"), z.literal("retry")]),
    non_terminal: z.tuple([z.literal("blocked"), z.literal("degraded")]),
    terminal: z.tuple([z.literal("succeeded"), z.literal("failed"), z.literal("cancelled"), z.literal("safely_skipped")]),
    success: z.literal("succeeded"),
  }).strict(),
  idempotency: z.object({
    algorithm: z.literal("sha256"),
    key_template: z.literal("{company}+{run_id}+{stage}+{input_hash}"),
    coalesce_duplicates: z.literal(true),
    mutation_receipt_required: z.literal(true),
  }).strict(),
  concurrency: z.object({
    agent_max_concurrent_runs: z.literal(1),
    keys: z.array(z.string().trim().min(1)).min(3),
    default_limits: z.object({
      provider: z.number().int().positive(),
      repo: z.number().int().positive(),
      stage: z.number().int().positive(),
    }).strict(),
  }).strict(),
  recovery: z.object({
    orphan_timeout_seconds: z.number().int().positive(),
    heartbeat_seconds: z.number().int().positive(),
    resume_from_artifact_checkpoint: z.literal(true),
    fresh_transcript_on_provider_failover: z.literal(true),
    blocked_receipt_fields: z.array(z.string().trim().min(1)).min(4),
    never_treat_as_success: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  observability: z.object({
    correlation_id_field: z.literal("correlation_id"),
    correlation_span: z.array(z.string().trim().min(1)).min(1),
    receipt_format: z.literal("stable_json"),
    otel_compatible: z.literal(true),
    required_metrics: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  provider_policy_binding: z.object({
    mode: z.literal("manifest_path_and_sha256"),
    manifest_field: z.literal("provider_policy"),
    required_fields: z.tuple([
      z.literal("path"),
      z.literal("sha256"),
      z.literal("schema_version"),
      z.literal("schema_path"),
      z.literal("schema_sha256"),
    ]),
    sha256_algorithm: z.literal("sha256"),
    verify_before_stage_start: z.literal(true),
    reject_on_mismatch: z.literal(true),
    authority_rule: z.string().trim().min(1),
  }).strict(),
  artifact_schemas: z.object({
    run_receipt: z.object({
      schema_version: z.literal("profit-flywheel.run.v2"),
      path: z.literal("contracts/profit-flywheel.run.v2.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    dispatch: z.object({
      schema_version: z.literal("pos.dispatch.v2"),
      path: z.literal("contracts/pos.dispatch.v2.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    learning_receipt: z.object({
      schema_version: z.literal("pos.learning_receipt.v2"),
      path: z.literal("contracts/pos.learning_receipt.v2.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    next_research_authority: z.object({
      schema_version: z.literal("pos.next_research_authorization.v1"),
      path: z.literal("contracts/pos.next_research_authorization.v1.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    research_plan: z.object({
      schema_version: z.literal("paperclip.research_plan.v2"),
      path: z.literal("contracts/paperclip.research_plan.v2.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    stage_work_result: z.object({
      schema_version: z.literal("paperclip.profit_flywheel_stage_work_result.v1"),
      path: z.literal("contracts/stage-work-result.v1.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    stage_execution: z.object({
      schema_version: z.literal("paperclip.profit_flywheel_stage_execution.v2"),
      path: z.literal("contracts/stage-execution.v2.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    test_execution_result: z.object({
      schema_version: z.literal("paperclip.test_execution_result.v1"),
      path: z.literal("contracts/test-execution-result.v1.schema.json"),
      sha256: sha256Schema,
    }).strict(),
    independent_review_result: z.object({
      schema_version: z.literal("paperclip.independent_review_result.v1"),
      path: z.literal("contracts/independent-review-result.v1.schema.json"),
      sha256: sha256Schema,
    }).strict(),
  }).strict(),
  artifact_vectors: z.object({
    execution: z.object({
      schema_version: z.literal("paperclip.profit_flywheel_execution_golden_vectors.v1"),
      path: z.literal("contracts/execution-golden-vectors.v1.json"),
      sha256: sha256Schema,
    }).strict(),
  }).strict(),
  commercial_policy: z.object({
    minimum_commercialization_confidence: z.number().min(70),
    maximum_evidence_age_days: z.number().int().positive().max(30),
    future_evidence_tolerance_seconds: z.number().int().min(0).max(300),
    minimum_current_market_signals: z.number().int().min(3),
    minimum_independent_voc_observations: z.number().int().min(3),
    minimum_pricing_signals: z.number().int().min(1),
    minimum_competitive_or_differentiation_signals: z.number().int().min(1),
    minimum_authority_signals: z.number().int().min(1),
    required_identity_fields: z.array(z.string().trim().min(1)).min(2),
    required_internet_pipes_stations: z.array(z.string().trim().min(1)).min(6),
    allowed_internet_pipes_readiness: z.array(z.string().trim().min(1)).min(1),
    required_recommendation_fields: z.array(z.string().trim().min(1)).min(2),
    independence_key_precedence: z.array(z.string().trim().min(1)).min(1),
    missing_or_unknown_evidence_weight: z.literal(0),
    weighted_score_compensation_allowed: z.literal(false),
    future_dated_evidence_allowed: z.literal(false),
    unattributed_evidence_allowed: z.literal(false),
  }).strict().superRefine((value, ctx) => {
    for (const field of ["buyer", "approver"]) {
      if (!value.required_identity_fields.includes(field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["required_identity_fields"], message: `Missing required identity ${field}` });
      }
    }
    for (const field of ["recommendation", "cheapest_validation_step"]) {
      if (!value.required_recommendation_fields.includes(field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["required_recommendation_fields"], message: `Missing recommendation field ${field}` });
      }
    }
  }),
  exclusions: z.object({
    repos: z.array(z.string().trim().min(1)),
    matching: z.literal("case_insensitive_exact"),
    applies_to: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  stages: z.object(canonicalStagesShape).strict(),
  transitions: z.array(z.object({
    from: z.enum(PROFIT_FLYWHEEL_STAGES),
    to: z.enum(PROFIT_FLYWHEEL_STAGES),
    trigger: z.string().trim().min(1),
    guard: z.string().trim().min(1),
  }).strict()).min(PROFIT_FLYWHEEL_STAGES.length),
  compatibility: z.object({
    accepted_legacy_versions: z.array(z.string().trim().min(1)),
    migration_reader: z.string().trim().min(1),
    legacy_provider_receipts: z.literal("missing_means_degraded_revalidation_required"),
    legacy_execution_allowed: z.literal(false),
    unknown_versions: z.literal("reject"),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const requireValues = (actual: readonly string[], required: readonly string[], path: (string | number)[]) => {
    for (const item of required) {
      if (!actual.includes(item)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Missing required value ${item}` });
      }
    }
  };
  requireValues(value.concurrency.keys, [
    "provider:{provider}",
    "repo:{target_repo}",
    "stage:{company}:{stage}",
  ], ["concurrency", "keys"]);
  requireValues(value.recovery.blocked_receipt_fields, [
    "blocker_code",
    "blocker_detail",
    "next_owner",
    "resume_condition",
  ], ["recovery", "blocked_receipt_fields"]);
  requireValues(value.recovery.never_treat_as_success, [
    "process_exit_zero_without_final_response",
    "missing_completion_artifact",
    "stale_input_hash",
    "missing_required_receipt",
  ], ["recovery", "never_treat_as_success"]);
  requireValues(value.provider_policy_binding.required_fields, ["path", "sha256", "schema_version", "schema_path", "schema_sha256"], ["provider_policy_binding", "required_fields"]);
  requireValues(value.commercial_policy.required_internet_pipes_stations, [
    "generation",
    "validation",
    "evaluation",
    "differentiation",
    "visualization",
    "recommendation",
  ], ["commercial_policy", "required_internet_pipes_stations"]);
  if (value.commercial_policy.required_internet_pipes_stations.length !== 6) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commercial_policy", "required_internet_pipes_stations"], message: "Internet Pipes stations must be the exact canonical six" });
  }
  requireValues(value.commercial_policy.allowed_internet_pipes_readiness, [
    "alpha_ready",
    "factory_ready",
  ], ["commercial_policy", "allowed_internet_pipes_readiness"]);
  if (value.commercial_policy.allowed_internet_pipes_readiness.length !== 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commercial_policy", "allowed_internet_pipes_readiness"], message: "Allowed readiness must be exactly alpha_ready and factory_ready" });
  }
  requireValues(value.exclusions.repos.map((repo) => repo.toLowerCase()), [
    "glitch-cipher-syndicate/leadforge",
    "g4mm4p4nd4/octomind-platform",
  ], ["exclusions", "repos"]);
  requireValues(value.exclusions.applies_to, ["fallback_selection"], ["exclusions", "applies_to"]);
  PROFIT_FLYWHEEL_STAGES.forEach((stage, index) => {
    if (value.stages[stage].sequence !== index + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stage, "sequence"],
        message: `Expected ${stage} sequence ${index + 1}`,
      });
    }
    const expectedKey = `{company}+{run_id}+${stage}+{input_hash}`;
    if (value.stages[stage].idempotency_key !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stage, "idempotency_key"],
        message: `Expected stable idempotency key ${expectedKey}`,
      });
    }
  });
  if (!value.stages.implementation.guards?.includes("issue_backed")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", "implementation", "guards"], message: "Implementation must be issue-backed" });
  }
  if (!value.stages.release.guards?.includes("artifact_backed_completion")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", "release", "guards"], message: "Release must be artifact-backed" });
  }
  if (!value.stages.learning.guards?.includes("measured_evidence_only")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stages", "learning", "guards"], message: "Learning must require measured evidence" });
  }
});

export type PortfolioOsProfitFlywheelContractV2 = z.infer<typeof portfolioOsProfitFlywheelContractV2Schema>;

export function parsePortfolioOsProfitFlywheelContractV2(value: unknown): PortfolioOsProfitFlywheelContractV2 {
  return portfolioOsProfitFlywheelContractV2Schema.parse(value);
}
