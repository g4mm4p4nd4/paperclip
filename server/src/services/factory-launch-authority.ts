import type { FactoryMode } from "../config.js";

export type FactoryNewWorkKind =
  | "paperclip_stage_dispatch"
  | "portfolio_dispatch"
  | "pos_consumer_launch";

export interface FactoryLaunchAuthorityInput {
  kind: FactoryNewWorkKind;
  mode: FactoryMode;
  pauseNewWork: boolean;
  companyId?: string;
  targetRepo?: string;
  workflowId?: string;
  runId?: string;
  inputHash?: string;
  stage?: string;
  transitionContext?: Record<string, unknown>;
}

export interface FactoryLaunchAuthorityDecision {
  allowed: boolean;
  code: string;
  detail: string;
  terminal: boolean;
  approvalId?: string;
  consumptionReceipt?: { path: string; sha256: string };
}

/**
 * One server-owned admission boundary for every operation that can create a
 * new lease, claim, or subprocess. Live implementations must atomically
 * consume their exact shadow/production approval before returning allowed.
 */
export interface FactoryLaunchAuthority {
  claim(input: FactoryLaunchAuthorityInput): Promise<FactoryLaunchAuthorityDecision>;
}

export const defaultDenyFactoryLaunchAuthority: FactoryLaunchAuthority = {
  async claim(input) {
    return {
      allowed: false,
      code: input.pauseNewWork
        ? "factory_new_work_paused"
        : "factory_launch_authority_unconfigured",
      detail: input.pauseNewWork
        ? "Factory posture pauses all new leases, outbox claims, and subprocess launches."
        : "No DB-backed factory launch authority consumed an exact matching approval.",
      terminal: false,
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isFixtureTarget(targetRepo: string | undefined) {
  const normalized = targetRepo?.trim().toLowerCase() ?? "";
  return normalized.startsWith("fixture/") || normalized.startsWith("fixtures/") ||
    normalized.startsWith("test/") || normalized.startsWith("tests/");
}

function fixtureBindingsAreOffline(context: Record<string, unknown> | undefined) {
  if (!context) return false;
  const continuation = asRecord(context.research_continuation ?? context.continuation);
  const plan = asRecord(context.research_plan);
  const sourceRequests = Array.isArray(continuation.source_requests)
    ? continuation.source_requests
    : Array.isArray(plan.source_requests) ? plan.source_requests : [];
  const continuationModeValid = Object.keys(continuation).length === 0 || continuation.mode === "fixture";
  return continuationModeValid && sourceRequests.length > 0 && sourceRequests.every((request) => {
    const binding = asRecord(asRecord(request).offline_fixture);
    return typeof binding.path === "string" && /^\//.test(binding.path) &&
      typeof binding.sha256 === "string" && /^[0-9a-f]{64}$/.test(binding.sha256);
  });
}

/** Fixture authority is deliberately narrow and has no live-tier fallback. */
export const fixtureFactoryLaunchAuthority: FactoryLaunchAuthority = {
  async claim(input) {
    if (input.pauseNewWork) return defaultDenyFactoryLaunchAuthority.claim(input);
    if (input.mode !== "fixture") {
      return {
        allowed: false,
        code: "factory_live_launch_approval_required",
        detail: "Shadow and production launches require a consumed explicit launch approval.",
        terminal: true,
      };
    }
    if (!isFixtureTarget(input.targetRepo)) {
      return {
        allowed: false,
        code: "factory_fixture_real_target_rejected",
        detail: "Fixture mode cannot claim work for a real repository target.",
        terminal: true,
      };
    }
    if (input.stage === "research_intake" && !fixtureBindingsAreOffline(input.transitionContext)) {
      return {
        allowed: false,
        code: "factory_fixture_live_source_rejected",
        detail: "Fixture research requires an offline fixture continuation and immutable source bindings.",
        terminal: true,
      };
    }
    return { allowed: true, code: "factory_fixture_authorized", detail: "Exact offline fixture launch authorized.", terminal: false };
  },
};
