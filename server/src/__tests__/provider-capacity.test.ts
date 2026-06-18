import { describe, expect, it, vi, afterEach } from "vitest";
import { evaluateProviderReliabilityPreflight } from "../services/heartbeat.js";
import { evaluateProviderCapacity } from "../services/provider-capacity.js";

const minimaxTarget = {
  adapterType: "hermes_local" as const,
  lane: "hermes_minimax" as const,
  provider: "minimax",
  model: "MiniMax-M3",
  cacheKey: "hermes_local:hermes_minimax:minimax:MiniMax-M3",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status }) as Awaited<ReturnType<typeof fetch>>;
}

function remainsBody(overrides: Record<string, unknown> = {}) {
  return {
    model_remains: [
      {
        model_name: "general",
        start_time: Date.parse("2026-06-17T00:00:00.000Z"),
        end_time: Date.parse("2026-06-17T05:00:00.000Z"),
        remains_time: 3_600_000,
        current_interval_status: 1,
        current_interval_remaining_percent: 96,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 30,
        weekly_start_time: Date.parse("2026-06-15T00:00:00.000Z"),
        weekly_end_time: Date.parse("2026-06-22T00:00:00.000Z"),
        weekly_remains_time: 360_000_000,
        ...overrides,
      },
    ],
    base_resp: {
      status_code: 0,
      status_msg: "success",
    },
  };
}

describe("provider capacity telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports MiniMax Token Plan quota as available from the remains endpoint", async () => {
    const fetchImpl = vi.fn(async () => response(remainsBody()));
    const snapshot = await evaluateProviderCapacity({
      target: minimaxTarget,
      adapterConfig: { env: { MINIMAX_API_KEY: "test-key" } },
      now: new Date("2026-06-17T01:00:00.000Z"),
      fetchImpl,
    });

    expect(snapshot).toMatchObject({
      provider: "minimax",
      status: "available",
      source: "minimax_token_plan_remains",
      quota: {
        modelName: "general",
        currentIntervalRemainingPercent: 96,
        currentWeeklyRemainingPercent: 30,
        limitingWindow: null,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.minimax.io/v1/token_plan/remains",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("reports MiniMax Token Plan quota as exhausted with a reset ETA", async () => {
    const fetchImpl = vi.fn(async () => response(remainsBody({
      current_interval_remaining_percent: 0,
      current_weekly_remaining_percent: 44,
      remains_time: 900_000,
    })));
    const snapshot = await evaluateProviderCapacity({
      target: minimaxTarget,
      adapterConfig: { env: { MINIMAX_API_KEY: "test-key" } },
      now: new Date("2026-06-17T04:45:00.000Z"),
      fetchImpl,
    });

    expect(snapshot).toMatchObject({
      status: "exhausted",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      quota: {
        limitingWindow: "interval",
        currentIntervalRemainingPercent: 0,
      },
    });
    expect(snapshot?.expiresAt).toBe("2026-06-17T05:00:30.000Z");
    expect(snapshot?.detail).toContain("5h=0% remaining");
  });

  it("does not read Hermes home env during tests unless explicitly enabled", async () => {
    const fetchImpl = vi.fn(async () => response(remainsBody()));
    const snapshot = await evaluateProviderCapacity({
      target: minimaxTarget,
      adapterConfig: {},
      now: new Date("2026-06-17T01:00:00.000Z"),
      fetchImpl,
    });

    expect(snapshot).toMatchObject({
      status: "unknown",
      source: "missing_credentials",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks MiniMax preflight from the quota endpoint before spawning a full adapter check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(remainsBody({
      current_interval_remaining_percent: 0,
      current_weekly_remaining_percent: 25,
    }))));

    const result = await evaluateProviderReliabilityPreflight({
      companyId: "company-provider-capacity-test",
      adapterType: "hermes_local",
      selectedLane: "hermes_minimax",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
        env: { MINIMAX_API_KEY: "test-key" },
      },
    });

    expect(result).toMatchObject({
      status: "degraded",
      source: "provider_capacity_poll",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      capacity: {
        status: "exhausted",
        quota: {
          limitingWindow: "interval",
        },
      },
    });
  });
});
