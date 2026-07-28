import { describe, expect, it, vi } from "vitest";
import { createTokenomicsWatchSupervisor } from "../services/tokenomics-watch-supervisor.js";

describe("tokenomics watch supervisor", () => {
  it("runs immediately, prevents overlap, and reports a fresh immutable receipt", async () => {
    let resolveRun!: (value: { status: string; receiptPath: string }) => void;
    const run = vi.fn(() => new Promise<{ status: string; receiptPath: string }>((resolve) => { resolveRun = resolve; }));
    const scheduled: Array<() => void> = [];
    const supervisor = createTokenomicsWatchSupervisor({
      enabled: true,
      intervalSeconds: 300,
      now: () => new Date("2026-07-15T06:00:00.000Z"),
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
    resolveRun({ status: "pass", receiptPath: "/receipts/abc.json" });
    await vi.waitFor(() => expect(supervisor.snapshot()).toMatchObject({
      state: "healthy",
      lastReportStatus: "pass",
      lastPromotionStatus: "pass",
      lastReceiptPath: "/receipts/abc.json",
      consecutiveFailures: 0,
    }));
  });

  it("keeps an analytically warning but explicitly idle-safe receipt promotion healthy", async () => {
    const supervisor = createTokenomicsWatchSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      run: async () => ({
        status: "warn",
        promotionStatus: "pass",
        receiptPath: "/receipts/safe-idle.json",
      }),
    });
    await supervisor.runOnce();
    expect(supervisor.snapshot()).toMatchObject({
      state: "healthy",
      lastReportStatus: "warn",
      lastPromotionStatus: "pass",
      lastReceiptPath: "/receipts/safe-idle.json",
      lastFailureCode: null,
      consecutiveFailures: 0,
    });
  });

  it("fails closed on a warning receipt without an explicit safe promotion verdict", async () => {
    const supervisor = createTokenomicsWatchSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      run: async () => ({ status: "warn", receiptPath: "/receipts/unproven.json" }),
    });
    await supervisor.runOnce();
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastReportStatus: "warn",
      lastPromotionStatus: "fail",
      lastFailureCode: "tokenomics_promotion_fail",
      consecutiveFailures: 1,
    });
  });

  it("treats a failing report as degraded even when the evaluator process succeeds", async () => {
    const supervisor = createTokenomicsWatchSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => new Date("2026-07-15T06:00:00.000Z"),
      run: async () => ({ status: "fail", receiptPath: "/receipts/failed-report.json" }),
    });
    await supervisor.runOnce();
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastReportStatus: "fail",
      lastReceiptPath: "/receipts/failed-report.json",
      lastSuccessAt: null,
      lastFailureCode: "tokenomics_report_fail",
      consecutiveFailures: 1,
    });
  });

  it("redacts failure detail to a stable code and becomes stale after two intervals", async () => {
    let now = new Date("2026-07-15T06:00:00.000Z");
    const outcomes: Array<() => Promise<{ status: string; receiptPath: string }>> = [
      async () => ({ status: "pass", receiptPath: "/receipts/first.json" }),
      async () => { throw Object.assign(new Error("password=do-not-persist"), { code: "provider_capacity_unavailable" }); },
    ];
    const supervisor = createTokenomicsWatchSupervisor({
      enabled: true,
      intervalSeconds: 60,
      now: () => now,
      run: () => outcomes.shift()!(),
    });
    await supervisor.runOnce();
    now = new Date("2026-07-15T06:01:00.000Z");
    await supervisor.runOnce();
    expect(supervisor.snapshot()).toMatchObject({
      state: "degraded",
      lastFailureCode: "provider_capacity_unavailable",
      consecutiveFailures: 1,
    });
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("do-not-persist");
    now = new Date("2026-07-15T06:02:01.000Z");
    expect(supervisor.snapshot()).toMatchObject({ state: "stale", freshnessAgeSeconds: 121 });
  });

  it("is inert when disabled", async () => {
    const run = vi.fn();
    const supervisor = createTokenomicsWatchSupervisor({ enabled: false, intervalSeconds: 300, run });
    supervisor.start();
    await supervisor.runOnce();
    expect(run).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ state: "disabled", enabled: false });
  });
});
