import { z } from "zod";
import {
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES,
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
