export const PROFIT_FLYWHEEL_SCHEMA_VERSION = "profit-flywheel.v2" as const;

export const PROFIT_FLYWHEEL_STAGES = [
  "research_intake",
  "evidence_normalization",
  "commercial_validation",
  "council_decision",
  "dispatch",
  "implementation",
  "qa",
  "release",
  "commercial_observation",
  "learning",
] as const;

export type ProfitFlywheelStage = (typeof PROFIT_FLYWHEEL_STAGES)[number];

/** The single canonical run-state vocabulary shared by POS and Paperclip. */
export const PROFIT_FLYWHEEL_RUN_STATES = [
  "pending",
  "running",
  "retry",
  "blocked",
  "degraded",
  "succeeded",
  "failed",
  "cancelled",
  "safely_skipped",
] as const;

export type ProfitFlywheelRunState = (typeof PROFIT_FLYWHEEL_RUN_STATES)[number];

export const PROFIT_FLYWHEEL_FAILURE_CLASSES = [
  "provider_auth",
  "provider_billing",
  "provider_capability_mismatch",
  "provider_malformed_response",
  "provider_quota",
  "provider_rate_limit",
  "transient_network",
  "process_lost",
  "lease_expired",
  "artifact_missing",
  "artifact_invalid",
  "artifact_stale",
  "contract_mismatch",
  "human_decision_required",
  "non_retryable",
] as const;

export type ProfitFlywheelFailureClass = (typeof PROFIT_FLYWHEEL_FAILURE_CLASSES)[number];

export const PROFIT_FLYWHEEL_CAPABILITY_ALIASES = [
  "research_fast",
  "research_deep",
  "code_fast",
  "code_deep",
  "multimodal_qa",
  "independent_review",
  "summarization",
  "emergency_free",
] as const;

export type ProfitFlywheelCapabilityAlias = (typeof PROFIT_FLYWHEEL_CAPABILITY_ALIASES)[number];

export type ProfitFlywheelReceipt = {
  type: string;
  schemaVersion: string;
  contentHash: string;
  artifactRef: string | null;
  observedAt: string;
  expiresAt: string | null;
  attributes: Record<string, unknown>;
};
