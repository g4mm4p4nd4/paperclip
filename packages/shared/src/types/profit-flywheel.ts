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

export const PROFIT_FLYWHEEL_FACTORY_STATES = [
  "healthy",
  "degraded",
  "blocked",
  "paused",
  "unknown",
] as const;

export type ProfitFlywheelFactoryState = (typeof PROFIT_FLYWHEEL_FACTORY_STATES)[number];

export const PROFIT_FLYWHEEL_FACTORY_MODES = ["fixture", "shadow", "production"] as const;

export type ProfitFlywheelFactoryMode = (typeof PROFIT_FLYWHEEL_FACTORY_MODES)[number];

export interface ProfitFlywheelFactoryIdentity {
  component: "contract" | "provider_policy" | "adapter" | "portfolio_os" | "hermes";
  version: string | null;
  sha256: string | null;
  verified: boolean;
  detail: string | null;
}

export interface ProfitFlywheelFactoryPipelineStage {
  stage: ProfitFlywheelStage;
  counts: Record<ProfitFlywheelRunState, number>;
  total: number;
  conversionFromDispatch: number | null;
}

export interface ProfitFlywheelFactoryBlocker {
  workflowId: string;
  stageRunId: string;
  inputHash: string;
  issueId: string | null;
  stage: ProfitFlywheelStage;
  code: string;
  detail: string;
  nextOwner: string;
  resumeCondition: string;
  retryable: boolean;
  nextAttemptAt: string | null;
  ageSeconds: number;
  receiptPath: string | null;
  receiptId: string | null;
  receiptSha256: string | null;
}

export interface ProfitFlywheelFactoryActiveWork {
  workflowId: string;
  stageRunId: string;
  issueId: string | null;
  targetRepo: string;
  stage: ProfitFlywheelStage;
  state: ProfitFlywheelRunState;
  agentId: string | null;
  routeId: string | null;
  providerFamily: string | null;
  elapsedSeconds: number;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  maxAttempts: number;
  budgetConsumedTokens: number | null;
  budgetLimitTokens: number | null;
  lastUsefulAction: string | null;
}

export interface ProfitFlywheelFactoryProviderRoute {
  routeId: string;
  providerFamily: string;
  status: "healthy" | "failed" | "quarantined" | "unknown";
  failureClass: string | null;
  failureDetail: string | null;
  observedAt: string | null;
  expiresAt: string | null;
}

export interface ProfitFlywheelFactoryAliasReadiness {
  alias: ProfitFlywheelCapabilityAlias;
  status: "ready" | "degraded" | "unavailable" | "unknown";
  eligibleRouteCount: number;
  distinctProviderFamilies: number;
  independentReviewReady: boolean;
  evidence: "policy_and_fresh_canary" | "observed_route_binding" | "missing";
  routes: ProfitFlywheelFactoryProviderRoute[];
}

export interface ProfitFlywheelFactoryHealth {
  schemaVersion: "paperclip.profit_flywheel_factory_health.v1";
  companyId: string;
  generatedAt: string;
  state: ProfitFlywheelFactoryState;
  mode: ProfitFlywheelFactoryMode;
  pauseNewWork: boolean;
  freshness: {
    ageSeconds: number;
    maxAgeSeconds: number;
    stale: boolean;
  };
  identities: ProfitFlywheelFactoryIdentity[];
  pipeline: ProfitFlywheelFactoryPipelineStage[];
  blockers: ProfitFlywheelFactoryBlocker[];
  activeWork: ProfitFlywheelFactoryActiveWork[];
  providerReadiness: ProfitFlywheelFactoryAliasReadiness[];
  economics: {
    tokensPerCompletedDeliverable: number | null;
    costPerCompletedDeliverableUsd: number | null;
    artifactBackedPercentage: number | null;
    falseSuccessPercentage: number | null;
    secondIterationCompletionRate: number | null;
    highBurnEventCount: number | null;
    tokenomicsStatus: "healthy" | "failed" | "stale" | "unknown";
    tokenomicsGeneratedAt: string | null;
  };
  host: {
    diskAvailableBytes: number | null;
    diskFreePercent: number | null;
    diskState: "healthy" | "warning" | "hard_stop" | "unknown";
    databaseBytes: number | null;
    logBytes: number | null;
    archiveBacklogBytes: number | null;
    factoryBrowserProcessCount: number | null;
  };
  closeouts: {
    twoIteration: ProfitFlywheelReceipt | null;
    shadow: ProfitFlywheelReceipt | null;
    production: ProfitFlywheelReceipt | null;
  };
  approvalGates: Array<{
    code: string;
    title: string;
    detail: string;
    action: "credential" | "spend" | "publish" | "merge" | "deploy" | "retention" | "shadow" | "other";
  }>;
}

export interface ProfitFlywheelFactoryWorkflowDetail {
  schemaVersion: "paperclip.profit_flywheel_factory_workflow_detail.v1";
  companyId: string;
  generatedAt: string;
  workflow: {
    id: string;
    runId: string;
    state: ProfitFlywheelRunState;
    currentStage: ProfitFlywheelStage;
    targetRepo: string;
    correlationId: string;
    traceId: string;
    sourceSchemaVersion: string;
    sourceDispatchHash: string;
    contractSha256: string;
    blockerCode: string | null;
    blockerDetail: string | null;
    nextOwner: string | null;
    resumeCondition: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
  stages: Array<{
    id: string;
    stage: ProfitFlywheelStage;
    state: ProfitFlywheelRunState;
    ownerPlane: "portfolio_os" | "paperclip" | "hermes";
    inputSchemaVersion: string;
    inputHash: string;
    sourceHashes: Record<string, string>;
    idempotencyKey: string;
    attempt: number;
    maxAttempts: number;
    retryAt: string | null;
    issueId: string | null;
    routeId: string | null;
    providerFamily: string | null;
    providerModel: string | null;
    providerPolicySha256: string | null;
    providerRouteSha256: string | null;
    transitionSourceStageRunId: string | null;
    transitionSourceOutputHash: string | null;
    requiredReceipts: string[];
    completionEvidence: string[];
    checkpointSha256: string | null;
    blockerCode: string | null;
    blockerDetail: string | null;
    nextOwner: string | null;
    resumeCondition: string | null;
    heartbeatAt: string | null;
    leaseExpiresAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  receipts: Array<{
    id: string;
    stageRunId: string;
    type: string;
    schemaVersion: string;
    contentHash: string;
    artifactRef: string | null;
    status: "valid" | "invalid" | "expired" | "revoked" | "quarantined";
    observedAt: string;
    expiresAt: string | null;
    createdAt: string;
  }>;
  audit: Array<{
    id: string;
    stageRunId: string | null;
    eventType: string;
    fromState: ProfitFlywheelRunState | null;
    toState: ProfitFlywheelRunState | null;
    attempt: number;
    nextAttemptAt: string;
    processedAt: string | null;
    lastError: string | null;
    createdAt: string;
  }>;
}
