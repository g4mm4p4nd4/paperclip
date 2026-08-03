import { describe, expect, it } from "vitest";
import { createProviderPolicyCanaryScheduler } from "../ops/provider-policy-canary.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";

describe("provider policy canary scheduler", () => {
  it("does not load policy or spend provider tokens while the factory is paused", async () => {
    let listedCompanies = 0;
    let runs = 0;
    const scheduler = createProviderPolicyCanaryScheduler({} as never, {
      isPaused: () => true,
      listCompanyIds: async () => {
        listedCompanies += 1;
        return ["company-a"];
      },
      listHealth: async () => [],
      runCanaries: async () => {
        runs += 1;
        return [];
      },
    });

    await expect(scheduler.tickOnce()).resolves.toEqual({
      companies: 0,
      dueCompanies: 0,
      refreshed: [],
      factoryPaused: true,
    });
    scheduler.start();
    await Promise.resolve();
    scheduler.stop();
    expect(listedCompanies).toBe(0);
    expect(runs).toBe(0);
  });

  it("deduplicates by company and enforces bounded company concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: Array<{ companyId: string; routeIds: string[] }> = [];
    const refreshed: string[] = [];
    const scheduler = createProviderPolicyCanaryScheduler({} as never, {
      maxConcurrency: 2,
      now: () => new Date("2026-07-12T06:00:00.000Z"),
      listCompanyIds: async () => ["company-a", "company-a", "company-b", "company-c"],
      listHealth: async () => [],
      runCanaries: async (_db, input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push({ companyId: input.companyId, routeIds: input.routeIds ?? [] });
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return [];
      },
      onRefresh: ({ companyId }) => { refreshed.push(companyId); },
    });

    const result = await scheduler.tickOnce();
    const policy = await loadProviderPolicyV2();
    expect(result.dueCompanies).toBe(3);
    expect(maxActive).toBe(2);
    expect(calls.map((call) => call.companyId).sort()).toEqual(["company-a", "company-b", "company-c"]);
    expect(calls.every((call) => call.routeIds.length === Object.keys(policy.policy.routes).length)).toBe(true);
    expect(refreshed.sort()).toEqual(["company-a", "company-b", "company-c"]);
  });

  it("does not spend canary tokens while all route receipts remain fresh", async () => {
    const policy = await loadProviderPolicyV2();
    let runs = 0;
    const scheduler = createProviderPolicyCanaryScheduler({} as never, {
      now: () => new Date("2026-07-12T06:00:00.000Z"),
      listCompanyIds: async () => ["company-a"],
      listHealth: async () => Object.keys(policy.policy.routes).map((routeId) => ({
        routeId,
        expiresAt: new Date("2026-07-12T12:00:00.000Z"),
      })),
      runCanaries: async () => { runs += 1; return []; },
    });
    const result = await scheduler.tickOnce();
    expect(result.dueCompanies).toBe(0);
    expect(runs).toBe(0);
  });
});
