import { describe, expect, it, vi } from "vitest";
import { createFactoryBaselineRefreshSupervisor } from "../services/factory-baseline-refresh-supervisor.js";

describe("factory baseline refresh supervisor", () => {
  it("runs immediately, prevents overlap, and records an immutable binding", async () => {
    let resolveRun!: (value: { receiptPath: string; receiptSha256: string }) => void;
    const run = vi.fn(() => new Promise<{ receiptPath: string; receiptSha256: string }>((resolve) => {
      resolveRun = resolve;
    }));
    const scheduled: Array<() => void> = [];
    const supervisor = createFactoryBaselineRefreshSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => new Date("2026-07-17T18:00:00.000Z"),
      run,
      setIntervalFn: ((callback: () => void) => {
        scheduled.push(callback);
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
    });

    supervisor.start();
    expect(run).toHaveBeenCalledTimes(1);
    scheduled[0]!();
    expect(run).toHaveBeenCalledTimes(1);
    resolveRun({ receiptPath: "/receipts/baseline.json", receiptSha256: "a".repeat(64) });
    await vi.waitFor(() => expect(supervisor.snapshot()).toMatchObject({
      state: "healthy",
      lastReceiptPath: "/receipts/baseline.json",
      lastReceiptSha256: "a".repeat(64),
      consecutiveFailures: 0,
    }));
  });

  it("fails closed on malformed bindings and becomes stale after 120 seconds", async () => {
    let now = new Date("2026-07-17T18:00:00.000Z");
    const outcomes = [
      async () => ({ receiptPath: "/receipts/valid.json", receiptSha256: "b".repeat(64) }),
      async () => ({ receiptPath: "relative.json", receiptSha256: "not-a-hash" }),
    ];
    const supervisor = createFactoryBaselineRefreshSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => now,
      run: () => outcomes.shift()!(),
    });
    await supervisor.runOnce();
    now = new Date("2026-07-17T18:01:00.000Z");
    await supervisor.runOnce();
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastFailureCode: "factory_baseline_refresh_result_invalid",
      consecutiveFailures: 1,
    });
    now = new Date("2026-07-17T18:02:01.000Z");
    expect(supervisor.snapshot()).toMatchObject({ state: "stale", freshnessAgeSeconds: 121 });
  });

  it("is inert when disabled", async () => {
    const run = vi.fn();
    const supervisor = createFactoryBaselineRefreshSupervisor({ enabled: false, intervalSeconds: 60, run });
    supervisor.start();
    await supervisor.runOnce();
    expect(run).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ state: "disabled", enabled: false });
  });
});
