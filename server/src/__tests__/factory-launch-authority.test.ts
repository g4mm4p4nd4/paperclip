import { describe, expect, it } from "vitest";
import {
  defaultDenyFactoryLaunchAuthority,
  fixtureFactoryLaunchAuthority,
} from "../services/factory-launch-authority.js";

const base = {
  kind: "pos_consumer_launch" as const,
  mode: "fixture" as const,
  pauseNewWork: false,
  companyId: "10000000-0000-4000-8000-000000000001",
  targetRepo: "fixture/research",
  workflowId: "20000000-0000-4000-8000-000000000002",
  runId: "fixture-run-1",
  inputHash: "1".repeat(64),
};

describe("factory launch authority", () => {
  it("defaults to deny and never treats a generic caller as launch authority", async () => {
    await expect(defaultDenyFactoryLaunchAuthority.claim(base)).resolves.toMatchObject({
      allowed: false,
      code: "factory_launch_authority_unconfigured",
    });
  });

  it("rejects real repositories and every live mode from fixture authority", async () => {
    await expect(fixtureFactoryLaunchAuthority.claim({
      ...base,
      targetRepo: "owner/real-repository",
    })).resolves.toMatchObject({ allowed: false, code: "factory_fixture_real_target_rejected", terminal: true });
    await expect(fixtureFactoryLaunchAuthority.claim({
      ...base,
      mode: "shadow",
    })).resolves.toMatchObject({ allowed: false, code: "factory_live_launch_approval_required", terminal: true });
  });

  it("requires immutable offline source bindings for fixture research", async () => {
    await expect(fixtureFactoryLaunchAuthority.claim({
      ...base,
      stage: "research_intake",
      transitionContext: {
        research_continuation: {
          mode: "fixture",
          source_requests: [{
            offline_fixture: {
              path: "/fixtures/research/source.json",
              sha256: "2".repeat(64),
            },
          }],
        },
      },
    })).resolves.toMatchObject({ allowed: true, code: "factory_fixture_authorized" });

    await expect(fixtureFactoryLaunchAuthority.claim({
      ...base,
      stage: "research_intake",
      transitionContext: {
        research_continuation: {
          mode: "live",
          source_requests: [{ url: "https://example.invalid/live" }],
        },
      },
    })).resolves.toMatchObject({ allowed: false, code: "factory_fixture_live_source_rejected", terminal: true });
  });
});

