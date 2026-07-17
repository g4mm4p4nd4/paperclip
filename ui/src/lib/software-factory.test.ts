import { describe, expect, it } from "vitest";
import type { ProfitFlywheelFactoryBlocker } from "@paperclipai/shared";
import {
  formatFactoryBytes,
  formatFactoryDuration,
  formatFactoryMetric,
  managedAdapterRollbackTargets,
  shortFactoryIdentity,
  sortedFactoryBlockers,
} from "./software-factory";

function blocker(input: Partial<ProfitFlywheelFactoryBlocker>): ProfitFlywheelFactoryBlocker {
  return {
    workflowId: crypto.randomUUID(),
    stageRunId: crypto.randomUUID(),
    inputHash: "a".repeat(64),
    issueId: null,
    stage: "research_intake",
    code: "blocked",
    detail: "Blocked",
    nextOwner: "operator",
    resumeCondition: "Repair evidence",
    retryable: true,
    nextAttemptAt: null,
    ageSeconds: 1,
    receiptPath: null,
    receiptId: null,
    receiptSha256: null,
    ...input,
  };
}

describe("software factory UI formatters", () => {
  it("formats unknown, byte, duration, metric, and hash values without inventing evidence", () => {
    expect(formatFactoryBytes(null)).toBe("Unknown");
    expect(formatFactoryBytes(6 * 1024 ** 3)).toBe("6.0 GiB");
    expect(formatFactoryDuration(3661)).toBe("1h 1m");
    expect(formatFactoryMetric(null)).toBe("Not measured");
    expect(formatFactoryMetric(0.875, { percent: true })).toBe("87.5%");
    expect(shortFactoryIdentity("a".repeat(64))).toBe("aaaaaaaa…aaaaaa");
  });

  it("orders terminal blockers before retryable blockers, then by age", () => {
    const retrying = blocker({ code: "retrying", retryable: true, nextAttemptAt: "2026-07-15T12:00:00.000Z", ageSeconds: 500 });
    const waiting = blocker({ code: "waiting", retryable: true, nextAttemptAt: null, ageSeconds: 10 });
    const terminal = blocker({ code: "terminal", retryable: false, ageSeconds: 1 });
    expect(sortedFactoryBlockers([retrying, waiting, terminal]).map((entry) => entry.code)).toEqual([
      "terminal",
      "waiting",
      "retrying",
    ]);
  });

  it("offers only unique, well-formed prior managed adapter bundles for rollback", () => {
    const active = "a".repeat(64);
    const prior = { bundleSha256: "b".repeat(64), packageVersion: "0.1.1", manifestSha256: "c".repeat(64) };
    expect(managedAdapterRollbackTargets({
      type: "hermes_local",
      label: "Hermes",
      source: "external",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      installKind: "managed_immutable_bundle",
      canManageManagedRuntime: true,
      bundleSha256: active,
      rollbackTargets: [prior, prior, { ...prior, bundleSha256: active }, { ...prior, bundleSha256: "invalid" }],
    })).toEqual([prior]);
    expect(managedAdapterRollbackTargets({
      type: "hermes_local",
      label: "Hermes",
      source: "external",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      installKind: "local_path",
      bundleSha256: active,
      rollbackTargets: [prior],
    })).toEqual([]);
    expect(managedAdapterRollbackTargets({
      type: "hermes_local",
      label: "Hermes",
      source: "external",
      modelsCount: 0,
      loaded: true,
      disabled: false,
      installKind: "managed_immutable_bundle",
      canManageManagedRuntime: false,
      bundleSha256: active,
      rollbackTargets: [prior],
    })).toEqual([]);
  });
});
