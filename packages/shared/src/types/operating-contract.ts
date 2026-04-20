import type { GoalLevel, GoalStatus } from "../constants.js";

export type OperatingContractReviewStatus = "unconfigured" | "needs_review" | "healthy" | "warning";

export interface OperatingContractGoalDefinition {
  slug: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentSlug: string | null;
  ownerAgentSlug: string | null;
}

export interface OperatingContractChiefOfStaffPolicy {
  enabled: boolean;
  ceoSlug: string | null;
  directReportThreshold: number;
  role: "pm";
  title: "Chief of Staff";
}

export interface OperatingContractOrgPolicy {
  chiefOfStaff: OperatingContractChiefOfStaffPolicy | null;
  staleHeartbeatThresholdHours: number;
  openWorkStaleDays: number;
}

export interface OperatingContractWorkspaceRef {
  id: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  cwd: string | null;
  repoUrl: string | null;
  isPrimary: boolean;
}

export interface OperatingContractRemediationOwner {
  role: "pm";
  title: "Chief of Staff";
  soleOwner: true;
  status: "assigned" | "missing";
  agentId: string | null;
  agentSlug: string | null;
  agentName: string | null;
}

export interface OperatingContractFindingCounts {
  companyMetadata: number;
  goals: number;
  projectGoalLinks: number;
  issueGoalBackfills: number;
  agents: number;
  staffingRecommendations: number;
  warnings: number;
  total: number;
}

export interface OperatingContractReviewSummary {
  status: Exclude<OperatingContractReviewStatus, "unconfigured" | "needs_review">;
  counts: OperatingContractFindingCounts;
  previewHash: string;
}

export interface OperatingContractConfig {
  companyId: string;
  projectWorkspaceId: string | null;
  packageRootPath: string;
  workspace: OperatingContractWorkspaceRef | null;
  lastReviewedAt: Date | null;
  lastReviewSourceHash: string | null;
  lastReviewSummary: OperatingContractReviewSummary | null;
  sourceChangedSinceReview: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export type OperatingContractActionGroup =
  | "company_metadata"
  | "goals"
  | "project_goal_links"
  | "issue_goal_backfills"
  | "agents"
  | "staffing_recommendations";

export interface OperatingContractAction {
  id: string;
  group: OperatingContractActionGroup;
  kind: string;
  title: string;
  description: string;
  entityType: "company" | "goal" | "project" | "issue" | "agent";
  entityId: string | null;
  entitySlug: string | null;
  metadata: Record<string, unknown> | null;
}

export interface OperatingContractWarningFinding {
  kind: string;
  title: string;
  description: string;
  entityType: "company" | "goal" | "project" | "issue" | "agent";
  entityId: string | null;
  entitySlug: string | null;
  metadata: Record<string, unknown> | null;
}

export interface OperatingContractResolvedContract {
  companyName: string;
  companyDescription: string | null;
  companySlug: string | null;
  goals: OperatingContractGoalDefinition[];
  orgPolicy: OperatingContractOrgPolicy;
}

export interface OperatingContractPreviewResult {
  companyId: string;
  config: OperatingContractConfig;
  previewHash: string;
  sourceHash: string;
  status: "healthy" | "warning";
  source: {
    workspaceId: string;
    packageRootPath: string;
    companyPath: string;
    paperclipExtensionPath: string | null;
  };
  contract: OperatingContractResolvedContract;
  remediationOwner: OperatingContractRemediationOwner;
  counts: OperatingContractFindingCounts;
  actions: OperatingContractAction[];
  warnings: OperatingContractWarningFinding[];
}

export interface UpdateOperatingContractConfigRequest {
  projectWorkspaceId: string | null;
  packageRootPath: string;
}

export interface OperatingContractApplyRequest {
  previewHash: string;
  selectedActionGroups: OperatingContractActionGroup[];
}

export interface OperatingContractApplyResult {
  companyId: string;
  appliedActionGroups: OperatingContractActionGroup[];
  appliedCounts: Partial<Record<OperatingContractActionGroup, number>>;
  preview: OperatingContractPreviewResult;
}

export interface OperatingContractDashboardSummary {
  status: OperatingContractReviewStatus;
  sourceChangedSinceReview: boolean;
  lastReviewedAt: Date | null;
  previewPath: string;
  remediationOwner: OperatingContractRemediationOwner;
  counts: OperatingContractFindingCounts | null;
}
