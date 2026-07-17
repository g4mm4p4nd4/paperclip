import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES,
  PROFIT_FLYWHEEL_RUN_STATES,
  PROFIT_FLYWHEEL_STAGES,
} from "./types/profit-flywheel.js";
import { profitFlywheelFactoryHealthSchema } from "./validators/profit-flywheel.js";

function snapshot() {
  const zeroCounts = Object.fromEntries(PROFIT_FLYWHEEL_RUN_STATES.map((state) => [state, 0]));
  return {
    schemaVersion: "paperclip.profit_flywheel_factory_health.v1",
    companyId: randomUUID(),
    generatedAt: "2026-07-15T12:00:00.000Z",
    state: "degraded",
    mode: "fixture",
    pauseNewWork: false,
    freshness: { ageSeconds: 5, maxAgeSeconds: 120, stale: false },
    identities: ["contract", "provider_policy", "adapter", "portfolio_os", "hermes"].map((component) => ({
      component,
      version: null,
      sha256: null,
      verified: false,
      detail: "Verification evidence is not yet available",
    })),
    pipeline: PROFIT_FLYWHEEL_STAGES.map((stage) => ({ stage, counts: { ...zeroCounts }, total: 0, conversionFromDispatch: null })),
    blockers: [],
    activeWork: [],
    providerReadiness: PROFIT_FLYWHEEL_CAPABILITY_ALIASES.map((alias) => ({
      alias,
      status: "unknown",
      eligibleRouteCount: 0,
      distinctProviderFamilies: 0,
      independentReviewReady: false,
      evidence: "missing",
      routes: [],
    })),
    economics: {
      tokensPerCompletedDeliverable: null,
      costPerCompletedDeliverableUsd: null,
      artifactBackedPercentage: null,
      falseSuccessPercentage: null,
      secondIterationCompletionRate: null,
      highBurnEventCount: null,
      tokenomicsStatus: "unknown",
      tokenomicsGeneratedAt: null,
    },
    host: {
      diskAvailableBytes: null,
      diskFreePercent: null,
      diskState: "unknown",
      databaseBytes: null,
      logBytes: null,
      archiveBacklogBytes: null,
      factoryBrowserProcessCount: null,
    },
    closeouts: { twoIteration: null, shadow: null, production: null },
    approvalGates: [],
  };
}

describe("Profit Flywheel factory health read model", () => {
  it("accepts one explicit entry for every canonical stage, identity, and provider alias", () => {
    const result = profitFlywheelFactoryHealthSchema.parse(snapshot());
    expect(result.pipeline.map((entry) => entry.stage)).toEqual(PROFIT_FLYWHEEL_STAGES);
    expect(result.providerReadiness.map((entry) => entry.alias)).toEqual(PROFIT_FLYWHEEL_CAPABILITY_ALIASES);
    expect(result.identities).toHaveLength(5);
  });

  it("rejects reordered stages, inconsistent freshness, and an unexplained dispatch pause", () => {
    const reordered = snapshot();
    [reordered.pipeline[0], reordered.pipeline[1]] = [reordered.pipeline[1]!, reordered.pipeline[0]!];
    expect(profitFlywheelFactoryHealthSchema.safeParse(reordered).success).toBe(false);

    const staleMismatch = snapshot();
    staleMismatch.freshness = { ageSeconds: 121, maxAgeSeconds: 120, stale: false };
    expect(profitFlywheelFactoryHealthSchema.safeParse(staleMismatch).success).toBe(false);

    const unexplainedPause = snapshot();
    unexplainedPause.pauseNewWork = true;
    expect(profitFlywheelFactoryHealthSchema.safeParse(unexplainedPause).success).toBe(false);
  });

  it("allows a disk hard stop to pause dispatch while preserving the blocked primary state", () => {
    const hardStop = snapshot();
    hardStop.state = "blocked";
    hardStop.pauseNewWork = true;
    hardStop.host.diskState = "hard_stop";
    expect(profitFlywheelFactoryHealthSchema.safeParse(hardStop).success).toBe(true);
  });
});
