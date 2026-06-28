type JsonRecord = Record<string, unknown>;

export const COMPANY_VISION_CONTRACT_VERSION = "paperclip.company_vision.v1";
export const GO_LIVE_DELTA_VERSION = "paperclip.go_live_delta.v1";
export const GO_LIVE_EVALUATION_VERSION = "paperclip.go_live_evaluation.v1";
export const BLOCKER_ROUTING_VERSION = "paperclip.blocker_routing.v1";

const VALUABLE_GO_LIVE_DELTA_CLASSES = new Set([
  "milestone_progress",
  "artifact_delivery",
  "handoff",
  "truthful_blocker",
]);

const GO_LIVE_DELTA_CLASSES = new Set([
  ...VALUABLE_GO_LIVE_DELTA_CLASSES,
  "maintenance",
  "noop",
  "misaligned",
]);

const OWNERLESS_VALUES = /^(null|none|n\/a|na|unknown|nobody)$/i;

export type GoLiveDeltaClassification =
  | "milestone_progress"
  | "artifact_delivery"
  | "handoff"
  | "truthful_blocker"
  | "maintenance"
  | "noop"
  | "misaligned";

export type GoLiveDelta = {
  deltaVersion: typeof GO_LIVE_DELTA_VERSION;
  classification: GoLiveDeltaClassification;
  source: "explicit_result_json" | "explicit_final_response" | "inferred_from_disposition";
  companyGoal: string | null;
  milestone: string | null;
  gapClosed: string | null;
  artifactRefs: JsonRecord[];
  receiptPaths: string[];
  handoffTarget: string | null;
  blockerOwner: string | null;
  tokenEfficiency: JsonRecord | null;
};

export type GoLiveDeltaEvaluation = {
  evaluationVersion: typeof GO_LIVE_EVALUATION_VERSION;
  status: "valuable" | "weak" | "not_valuable";
  reason: string;
  countsAsFinalDeliverable: boolean;
};

export type CompanyVisionContract = {
  contractVersion: typeof COMPANY_VISION_CONTRACT_VERSION;
  companyId: string;
  companyName: string;
  issuePrefix: string | null;
  goLiveDefinition: string;
  milestones: Array<{
    id: string | null;
    title: string;
    status: string | null;
    source: "goal" | "project" | "issue";
  }>;
  roleMissions: Array<{
    agentId: string | null;
    agentName: string;
    role: string;
    mission: string;
  }>;
  handoffEdges: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  progressSignals: string[];
  blockerRouting: Array<{
    blockerClass: string;
    owner: string;
    route: string;
  }>;
};

export type BlockerRoutingKind =
  | "credential"
  | "duplicate_loop"
  | "workspace"
  | "provider_capacity"
  | "human_decision"
  | "implementation";

export type BlockerRouting = {
  routingVersion: typeof BLOCKER_ROUTING_VERSION;
  kind: BlockerRoutingKind;
  owner: "board" | "agent" | "manager";
  route: "request_board_approval" | "refactor_decision" | "agent_issue" | "manager_review";
  reason: string;
  requiredSecretNames: string[];
  approvalRequired: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
}

function readRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is JsonRecord => isRecord(entry));
}

function normalizeGoLiveClass(value: unknown): GoLiveDeltaClassification | null {
  const normalized = readString(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
  return normalized && GO_LIVE_DELTA_CLASSES.has(normalized)
    ? normalized as GoLiveDeltaClassification
    : null;
}

function normalizeOwner(value: unknown): string | null {
  const owner = readString(value);
  if (!owner || OWNERLESS_VALUES.test(owner)) return null;
  return owner;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) return parsed;
  }
  return null;
}

function parseKeyValueLine(text: string | null, key: string) {
  if (!text) return null;
  const match = text.match(new RegExp(`\\b${key}\\s*[:=]\\s*([^;\\n]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}

export function extractGoLiveDelta(input: {
  resultJson?: JsonRecord | null;
  finalResponseText?: string | null;
  finalDisposition?: JsonRecord | null;
}): GoLiveDelta | null {
  const result = isRecord(input.resultJson) ? input.resultJson : {};
  const raw =
    isRecord(result.goLiveDelta) ? result.goLiveDelta :
    isRecord(result.go_live_delta) ? result.go_live_delta :
    isRecord(result.companyVisionDelta) ? result.companyVisionDelta :
    null;
  const text = input.finalResponseText ?? null;
  const classification =
    normalizeGoLiveClass(raw?.classification) ??
    normalizeGoLiveClass(raw?.delta) ??
    normalizeGoLiveClass(result.goLiveDelta) ??
    normalizeGoLiveClass(parseKeyValueLine(text, "goLiveDelta")) ??
    normalizeGoLiveClass(parseKeyValueLine(text, "goLiveDeltaClassification"));

  if (classification) {
    return {
      deltaVersion: GO_LIVE_DELTA_VERSION,
      classification,
      source: raw ? "explicit_result_json" : "explicit_final_response",
      companyGoal: firstString(raw?.companyGoal, raw?.goal, result.companyGoal, parseKeyValueLine(text, "companyGoal")),
      milestone: firstString(raw?.milestone, raw?.companyMilestone, result.companyMilestone, parseKeyValueLine(text, "milestone"), parseKeyValueLine(text, "companyMilestone")),
      gapClosed: firstString(raw?.gapClosed, raw?.goLiveGapClosed, result.goLiveGapClosed, parseKeyValueLine(text, "gapClosed"), parseKeyValueLine(text, "goLiveGapClosed")),
      artifactRefs: [
        ...readRecordArray(raw?.artifactRefs),
        ...readRecordArray(result.artifactRefs),
        ...readRecordArray(result.finalResponseArtifactRefs),
      ],
      receiptPaths: [
        ...readStringArray(raw?.receiptPaths),
        ...readStringArray(result.receiptPaths),
      ],
      handoffTarget: normalizeOwner(raw?.handoffTarget ?? raw?.nextHandoffTarget ?? result.nextHandoffTarget ?? parseKeyValueLine(text, "handoffTarget")),
      blockerOwner: normalizeOwner(raw?.blockerOwner ?? result.blockerOwner ?? parseKeyValueLine(text, "blockerOwner")),
      tokenEfficiency: isRecord(raw?.tokenEfficiency) ? raw.tokenEfficiency : isRecord(result.tokenEfficiency) ? result.tokenEfficiency : null,
    };
  }

  const disposition = isRecord(input.finalDisposition) ? input.finalDisposition : {};
  const dispositionClass = readString(disposition.classification);
  if (dispositionClass === "blocked") {
    const owner = normalizeOwner(disposition.nextActionOwner ?? disposition.owner);
    if (owner) {
      return {
        deltaVersion: GO_LIVE_DELTA_VERSION,
        classification: "truthful_blocker",
        source: "inferred_from_disposition",
        companyGoal: null,
        milestone: null,
        gapClosed: null,
        artifactRefs: [],
        receiptPaths: [],
        handoffTarget: null,
        blockerOwner: owner,
        tokenEfficiency: null,
      };
    }
  }

  return null;
}

export function evaluateGoLiveDelta(input: {
  delta: GoLiveDelta | null;
  finalDisposition?: JsonRecord | null;
  issueId?: string | null;
  artifactRefs?: JsonRecord[] | null;
  receiptPaths?: string[] | null;
  outcome?: string | null;
}): GoLiveDeltaEvaluation {
  const delta = input.delta;
  if (!delta) {
    return {
      evaluationVersion: GO_LIVE_EVALUATION_VERSION,
      status: "not_valuable",
      reason: "missing_go_live_delta",
      countsAsFinalDeliverable: false,
    };
  }

  const artifactCount =
    delta.artifactRefs.length +
    delta.receiptPaths.length +
    (input.artifactRefs?.length ?? 0) +
    (input.receiptPaths?.length ?? 0);

  let reason = "go_live_delta_not_actionable";
  let valuable = false;
  if (delta.classification === "milestone_progress") {
    valuable = Boolean(delta.companyGoal || delta.milestone || delta.gapClosed);
    reason = valuable ? "milestone_progress_tied_to_company_goal" : "milestone_progress_missing_goal_or_milestone";
  } else if (delta.classification === "artifact_delivery") {
    valuable = artifactCount > 0;
    reason = valuable ? "artifact_delivery_with_receipt" : "artifact_delivery_missing_receipt";
  } else if (delta.classification === "handoff") {
    valuable = Boolean(delta.handoffTarget);
    reason = valuable ? "handoff_has_next_owner" : "handoff_missing_next_owner";
  } else if (delta.classification === "truthful_blocker") {
    valuable = Boolean(delta.blockerOwner);
    reason = valuable ? "blocker_has_owner" : "blocker_missing_owner";
  }

  const status = valuable ? "valuable" : VALUABLE_GO_LIVE_DELTA_CLASSES.has(delta.classification) ? "weak" : "not_valuable";
  return {
    evaluationVersion: GO_LIVE_EVALUATION_VERSION,
    status,
    reason,
    countsAsFinalDeliverable: Boolean(
      valuable &&
      input.issueId &&
      (delta.classification === "milestone_progress" || delta.classification === "artifact_delivery") &&
      (artifactCount > 0 || input.outcome === "succeeded" || input.outcome === "completed")
    ),
  };
}

function roleMission(role: string, name: string) {
  const normalizedRole = role.toLowerCase();
  const haystack = `${role} ${name}`.toLowerCase();
  if (normalizedRole === "ceo") return "Choose and unblock the shortest path to go-live.";
  if (normalizedRole === "cto") return "Convert the company thesis into a tested, releasable technical path.";
  if (normalizedRole.includes("engineer")) return "Ship issue-scoped implementation with tests and receipts.";
  if (normalizedRole === "qa") return "Prove release readiness or name the blocker with evidence.";
  if (normalizedRole === "cmo") return "Turn the product into launch positioning, channels, and measurable demand.";
  if (haystack.includes("growth") || haystack.includes("distribution")) return "Drive launch distribution and conversion evidence.";
  if (normalizedRole === "designer") return "Improve the customer-facing product surface needed for launch.";
  if (normalizedRole === "devops") return "Keep deploy, release, and runtime gates ready for go-live.";
  if (normalizedRole === "researcher") return "Produce cited market, VOC, and repo evidence for the company thesis.";
  return "Advance assigned work toward go-live or route the blocker to the right owner.";
}

export function buildCompanyVisionContract(input: {
  company: { id: string; name: string; description?: string | null; issuePrefix?: string | null };
  goals?: Array<{ id?: string | null; title: string; status?: string | null; level?: string | null }>;
  projects?: Array<{ id?: string | null; name: string; status?: string | null }>;
  agents?: Array<{ id?: string | null; name: string; role: string }>;
  issues?: Array<{ id?: string | null; identifier?: string | null; title: string; status?: string | null }>;
}): CompanyVisionContract {
  const activeGoals = (input.goals ?? []).filter((goal) => !goal.status || !["done", "cancelled", "archived"].includes(goal.status));
  const primaryGoal = activeGoals.find((goal) => goal.level === "company") ?? activeGoals[0] ?? null;
  const companyDescription = readString(input.company.description);
  const goLiveDefinition =
    primaryGoal?.title ??
    companyDescription ??
    `Move ${input.company.name} to a validated, marketable, profitable go-live state.`;

  const milestones = [
    ...activeGoals.map((goal) => ({ id: goal.id ?? null, title: goal.title, status: goal.status ?? null, source: "goal" as const })),
    ...(input.projects ?? [])
      .filter((project) => !project.status || !["done", "archived", "cancelled"].includes(project.status))
      .map((project) => ({ id: project.id ?? null, title: project.name, status: project.status ?? null, source: "project" as const })),
    ...(input.issues ?? [])
      .filter((issue) => issue.status && ["todo", "in_progress", "in_review", "blocked"].includes(issue.status))
      .slice(0, 8)
      .map((issue) => ({ id: issue.id ?? issue.identifier ?? null, title: issue.title, status: issue.status ?? null, source: "issue" as const })),
  ].slice(0, 20);

  const roleMissions = (input.agents ?? []).map((agent) => ({
    agentId: agent.id ?? null,
    agentName: agent.name,
    role: agent.role,
    mission: roleMission(agent.role, agent.name),
  }));

  return {
    contractVersion: COMPANY_VISION_CONTRACT_VERSION,
    companyId: input.company.id,
    companyName: input.company.name,
    issuePrefix: input.company.issuePrefix ?? null,
    goLiveDefinition,
    milestones,
    roleMissions,
    handoffEdges: [
      { from: "CEO", to: "CTO", reason: "approved product thesis needs technical execution" },
      { from: "CTO", to: "Engineer", reason: "architecture or issue scope is ready for implementation" },
      { from: "Engineer", to: "QA", reason: "implementation is ready for verification" },
      { from: "QA", to: "Release Manager", reason: "verification is ready for release gate" },
      { from: "CMO", to: "Growth/Distribution", reason: "positioning is ready for launch distribution" },
    ],
    progressSignals: [
      "company milestone completed",
      "issue-linked artifact or receipt produced",
      "release/QA/evidence handoff created",
      "blocker routed to the owner who can resolve it",
      "context ledger records explicit goLiveDelta",
    ],
    blockerRouting: [
      { blockerClass: "credential", owner: "board", route: "request_board_approval" },
      { blockerClass: "duplicate_loop", owner: "board", route: "refactor_decision" },
      { blockerClass: "workspace", owner: "agent", route: "agent_issue" },
      { blockerClass: "provider_capacity", owner: "board", route: "request_board_approval" },
      { blockerClass: "implementation", owner: "agent", route: "agent_issue" },
    ],
  };
}

export function classifyBlockerRouting(input: {
  blockerClass?: string | null;
  text?: string | null;
  requiredSecretNames?: string[];
}): BlockerRouting {
  const haystack = `${input.blockerClass ?? ""} ${input.text ?? ""} ${(input.requiredSecretNames ?? []).join(" ")}`.toLowerCase();
  const requiredSecretNames = [...new Set(input.requiredSecretNames ?? [])].sort();
  if (requiredSecretNames.length > 0 || /credential|secret|token|api key|login|auth/.test(haystack)) {
    return {
      routingVersion: BLOCKER_ROUTING_VERSION,
      kind: "credential",
      owner: "board",
      route: "request_board_approval",
      reason: "credential_or_secret_required",
      requiredSecretNames,
      approvalRequired: true,
    };
  }
  if (/duplicate|loop|frozen|coalesc|suppressed/.test(haystack)) {
    return {
      routingVersion: BLOCKER_ROUTING_VERSION,
      kind: "duplicate_loop",
      owner: "board",
      route: "refactor_decision",
      reason: "duplicate_loop_requires_refactor_decision",
      requiredSecretNames: [],
      approvalRequired: true,
    };
  }
  if (/workspace|dirty|branch|checkout/.test(haystack)) {
    return {
      routingVersion: BLOCKER_ROUTING_VERSION,
      kind: "workspace",
      owner: "agent",
      route: "agent_issue",
      reason: "workspace_cleanup_required",
      requiredSecretNames: [],
      approvalRequired: false,
    };
  }
  if (/provider|quota|capacity|usage limit|429|balance/.test(haystack)) {
    return {
      routingVersion: BLOCKER_ROUTING_VERSION,
      kind: "provider_capacity",
      owner: "board",
      route: "request_board_approval",
      reason: "provider_capacity_decision_required",
      requiredSecretNames: [],
      approvalRequired: true,
    };
  }
  return {
    routingVersion: BLOCKER_ROUTING_VERSION,
    kind: "implementation",
    owner: "agent",
    route: "agent_issue",
    reason: "implementation_blocker",
    requiredSecretNames: [],
    approvalRequired: false,
  };
}

export function buildBlockerApprovalPayload(input: {
  title: string;
  companyName: string;
  issueIdentifier?: string | null;
  blockerFingerprint: string;
  routing: BlockerRouting;
  details?: JsonRecord;
}) {
  return {
    kind: "factory_blocker_routing",
    routingVersion: BLOCKER_ROUTING_VERSION,
    title: input.title,
    companyName: input.companyName,
    issueIdentifier: input.issueIdentifier ?? null,
    blockerFingerprint: input.blockerFingerprint,
    routing: input.routing,
    decisionRequired:
      input.routing.kind === "duplicate_loop"
        ? "Approve refactoring the loop/routine design or retiring the offending routine family."
        : input.routing.kind === "credential"
          ? "Provide or configure the required credential/secrets, or explicitly mark the lane non-executable."
          : "Approve the routed blocker decision.",
    details: input.details ?? {},
  };
}
