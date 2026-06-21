import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildActiveRunFlywheelCoverage,
  buildTokenomicsWatchReport,
  buildTokenomicsWindowMetrics,
  receiptFilePath,
  type TokenomicsActiveIssueSample,
  type TokenomicsCostSample,
  type TokenomicsIssueOutputSample,
  type TokenomicsLedgerOutputSample,
  type TokenomicsRoutineRunSample,
  type TokenomicsRunSample,
  type TokenomicsWakeupSample,
} from "../ops/hermes-tokenomics-watch.js";

const start = new Date("2026-06-16T20:00:00.000Z");
const end = new Date("2026-06-16T21:00:00.000Z");

function wakeup(overrides: Partial<TokenomicsWakeupSample>): TokenomicsWakeupSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    agentId: "agent-1",
    agentName: "Hermes Builder",
    source: "timer",
    triggerDetail: "system",
    reason: null,
    status: "queued",
    payload: {},
    runId: null,
    requestedAt: start.toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<TokenomicsRunSample>): TokenomicsRunSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    agentId: "agent-1",
    agentName: "Hermes Builder",
    status: "succeeded",
    invocationSource: "timer",
    triggerDetail: "system",
    errorCode: null,
    usageJson: {},
    contextSnapshot: {},
    createdAt: start.toISOString(),
    startedAt: start.toISOString(),
    finishedAt: end.toISOString(),
    ...overrides,
  };
}

function cost(overrides: Partial<TokenomicsCostSample>): TokenomicsCostSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    agentId: "agent-1",
    agentName: "Hermes Builder",
    heartbeatRunId: overrides.heartbeatRunId ?? null,
    provider: "minimax",
    biller: "minimax",
    billingType: "subscription",
    model: "MiniMax-M3",
    inputTokens: 20_000,
    cachedInputTokens: 10_000,
    outputTokens: 2_000,
    costCents: 0,
    occurredAt: start.toISOString(),
    ...overrides,
  };
}

function issueOutput(overrides: Partial<TokenomicsIssueOutputSample>): TokenomicsIssueOutputSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    assigneeAgentId: "agent-1",
    status: "done",
    identifier: "PAP-1",
    completedAt: end.toISOString(),
    updatedAt: end.toISOString(),
    ...overrides,
  };
}

function ledgerOutput(overrides: Partial<TokenomicsLedgerOutputSample>): TokenomicsLedgerOutputSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    runId: overrides.runId ?? "run-output",
    issueId: overrides.issueId ?? "issue-1",
    agentId: "agent-1",
    responseClass: "artifact_backed",
    finalOutcome: "completed",
    artifactRefs: [{ path: "reports/output.md" }],
    contextPackRefs: [],
    finalResponseArtifactRefs: [],
    receiptPaths: ["receipts/output.json"],
    createdAt: end.toISOString(),
    ...overrides,
  };
}

function activeIssue(overrides: Partial<TokenomicsActiveIssueSample>): TokenomicsActiveIssueSample {
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    title: "Run QA Sweep for portfolio-os",
    description: "routine_key: run-qa-sweep",
    status: "in_progress",
    identifier: "PAP-qa",
    executionRunId: null,
    originRunId: "routine-run-qa",
    ...overrides,
  };
}

function routineRun(overrides: Partial<TokenomicsRoutineRunSample>): TokenomicsRoutineRunSample {
  return {
    id: overrides.id ?? "routine-run-qa",
    routineId: "routine-qa",
    routineTitle: "Run QA Sweep",
    routineDescription: "routine_key: run-qa-sweep",
    triggerPayload: {
      paperclipActionabilityPreflight: {
        lane: "qa",
        blockerClass: "qa_sweep",
      },
    },
    ...overrides,
  };
}

describe("Hermes tokenomics watch", () => {
  it("includes process identity in receipt filenames to avoid same-timestamp collisions", () => {
    const now = new Date("2026-06-17T05:10:49.123Z");
    const first = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 111);
    const second = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 222);

    expect(first).not.toBe(second);
    expect(first).toContain("20260617T051049123Z-111-hermes-tokenomics-watch.json");
    expect(second).toContain("20260617T051049123Z-222-hermes-tokenomics-watch.json");
  });

  it("treats a quiet current window as cheap but insufficient proof of output lift", () => {
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [],
      runs: [],
      costs: [],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({})],
      runs: [run({ id: "run-baseline", contextSnapshot: { issueId: "issue-1" } })],
      costs: [cost({ heartbeatRunId: "run-baseline" })],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 0, driftedAgentNames: [] },
      generatedAt: end,
    });

    expect(current.optimization.decisionUnits).toBe(0);
    expect(current.optimization.valuableOrSafelySkippedRatio).toBe(1);
    expect(report.status).toBe("warn");
    expect(report.evaluation.tokenReductionStatus).toBe("pass");
    expect(report.evaluation.valuableOutputStatus).toBe("warn");
    expect(report.recommendedActions.join("\n")).toContain("too idle");
  });

  it("keeps idle skips cheap while marking output lift as unproven", () => {
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [
        wakeup({ status: "skipped", reason: "heartbeat.idle_no_assignment", payload: { kind: "paperclipIdleTimerSkip" } }),
        wakeup({ status: "skipped", reason: "heartbeat.idle_no_assignment", payload: { kind: "paperclipIdleTimerSkip" } }),
      ],
      runs: [],
      costs: [],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({}), wakeup({}), wakeup({})],
      runs: [
        run({ id: "run-1", contextSnapshot: { issueId: "issue-1" } }),
        run({ id: "run-2", contextSnapshot: { issueId: "issue-2" } }),
        run({ id: "run-3", contextSnapshot: { issueId: "issue-3" } }),
      ],
      costs: [
        cost({ provider: "minimax", model: "MiniMax-M3", heartbeatRunId: "run-1" }),
        cost({ provider: "google", biller: "google", model: "gemini-3-flash-preview", heartbeatRunId: "run-2" }),
        cost({ provider: "anthropic", biller: "anthropic", model: "claude-sonnet-4-6", heartbeatRunId: "run-3" }),
      ],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 0, driftedAgentNames: [] },
      generatedAt: end,
    });

    expect(report.status).toBe("warn");
    expect(report.evaluation.tokenReductionRatio).toBe(1);
    expect(report.current.optimization.valuableOrSafelySkippedRatio).toBe(1);
    expect(report.current.output.verifiedOutputUnits).toBe(0);
    expect(report.evaluation.valuableOutputStatus).toBe("warn");
    expect(report.evaluation.providerRouteCoverage).toEqual({
      minimaxSeen: true,
      geminiSeen: true,
      claudeSeen: true,
    });
    expect(report.factoryLoop.requiredOptimizerTools).toEqual(
      expect.arrayContaining(["scrapegraphai", "graphify", "gstack", "gbrain", "ponytail"]),
    );
  });

  it("counts no-new-signal timer skips as safe wake decisions", () => {
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [
        wakeup({
          status: "skipped",
          reason: "heartbeat.no_new_issue_signal",
          payload: {
            issueId: "issue-no-signal",
            paperclipNoNewSignalTimerSkip: {
              reason: "no_new_issue_signal",
              latestReceiptRunId: "run-prior",
            },
          },
        }),
      ],
      runs: [],
      costs: [],
    });

    expect(current.wakeups.noNewSignalSkipped).toBe(1);
    expect(current.optimization.decisionUnits).toBe(1);
    expect(current.optimization.valuableOrSafelySkippedUnits).toBe(1);
    expect(current.optimization.valuableOrSafelySkippedRatio).toBe(1);
    expect(current.tokens.rawTotal).toBe(0);
  });

  it("reports active run flywheel coverage from routine contracts and pending receipts", () => {
    const runId = "run-active-qa";
    const issueId = "issue-active-qa";
    const coverage = buildActiveRunFlywheelCoverage({
      generatedAt: end,
      runs: [
        run({
          id: runId,
          status: "running",
          contextSnapshot: { issueId },
          usageJson: {
            providerLane: {
              lane: "qa",
              selectedAdapterType: "process",
              provider: "process",
              biller: "paperclip",
              model: "run-qa-sweep",
              contextPackProfile: "map_first",
            },
          },
        }),
      ],
      issues: [
        activeIssue({
          id: issueId,
          executionRunId: runId,
          originRunId: "routine-run-qa",
          status: "in_progress",
        }),
      ],
      routineRuns: [routineRun({ id: "routine-run-qa" })],
      ledgerEntries: [
        ledgerOutput({
          runId,
          issueId,
          receiptPaths: ["qa_report.md", "screenshots/desktop.png"],
          artifactRefs: [{ path: "regression_notes.md" }],
        }),
      ],
    });

    expect(coverage.manifestSchemaVersion).toBe("paperclip.flywheel_coverage.v1");
    expect(coverage.activeRuns).toBe(1);
    expect(coverage.contractedRuns).toBe(1);
    expect(coverage.pendingRuns).toBe(1);
    expect(coverage.missingContractRuns).toBe(0);
    expect(coverage.runs[0]).toMatchObject({
      runId,
      stage: "qa",
      routineKey: "run-qa-sweep",
      ownerPlane: "paperclip_process_adapter",
      coverageState: "pending",
      selectedAdapterType: "process",
      provider: "process",
      contextPackProfile: "map_first",
    });
    expect(coverage.runs[0]?.pendingRequiredReceipts).toEqual(
      expect.arrayContaining(["PAPERCLIP_ADAPTER_RESULT_JSON", "gstack.pos_qa_verification.v1"]),
    );
    expect(coverage.stages[0]).toMatchObject({
      stage: "qa",
      activeRuns: 1,
      contractedRuns: 1,
      pendingRuns: 1,
      missingContractRuns: 0,
    });
  });

  it("warns when active runs are not tied to a flywheel stage contract", () => {
    const coverage = buildActiveRunFlywheelCoverage({
      generatedAt: end,
      runs: [
        run({
          id: "run-uncontracted",
          status: "running",
          contextSnapshot: {},
          usageJson: {
            provider: "anthropic",
            biller: "anthropic",
            model: "claude-sonnet-4-6",
          },
        }),
      ],
      issues: [],
      routineRuns: [],
      ledgerEntries: [],
    });
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [wakeup({ status: "claimed" })],
      runs: [run({ id: "run-uncontracted", status: "running" })],
      costs: [],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline: null,
      activeRunFlywheelCoverage: coverage,
      generatedAt: end,
    });

    expect(coverage.missingContractRuns).toBe(1);
    expect(coverage.runs[0]).toMatchObject({
      runId: "run-uncontracted",
      stage: null,
      contractPresent: false,
      coverageState: "missing_contract",
    });
    expect(report.activeRunFlywheelCoverage.missingContractRuns).toBe(1);
    expect(report.recommendedActions.join("\n")).toContain("missing flywheel coverage contracts");
  });

  it("counts timer backlog scans as valuable when the agent has assigned open work", () => {
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [wakeup({ status: "claimed" })],
      runs: [run({ id: "run-backlog-scan", openAssignedIssueCount: 4 })],
      costs: [],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({})],
      runs: [run({ id: "run-baseline", contextSnapshot: { issueId: "issue-1" } })],
      costs: [cost({ heartbeatRunId: "run-baseline" })],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 0, driftedAgentNames: [] },
      generatedAt: end,
    });

    expect(current.runs.assignmentBacklogScans).toBe(1);
    expect(current.runs.timerNoIssueLaunches).toBe(0);
    expect(current.optimization.valuableOrSafelySkippedRatio).toBe(1);
    expect(report.status).toBe("warn");
    expect(report.evaluation.valuableOutputStatus).toBe("warn");
  });

  it("passes the output target when current final deliverables per decision are 90 percent above baseline", () => {
    const currentRun = run({ id: "run-current", contextSnapshot: { issueId: "issue-current" } });
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [wakeup({ status: "claimed" }), wakeup({ status: "claimed" })],
      runs: [currentRun, run({ id: "run-current-2", contextSnapshot: { issueId: "issue-current-2" } })],
      costs: [cost({ heartbeatRunId: "run-current", inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 })],
      issues: [issueOutput({ id: "issue-current" }), issueOutput({ id: "issue-current-2" })],
      ledgerEntries: [
        ledgerOutput({ id: "ledger-current", runId: "run-current", issueId: "issue-current" }),
        ledgerOutput({ id: "ledger-current-2", runId: "run-current-2", issueId: "issue-current-2" }),
      ],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({}), wakeup({}), wakeup({}), wakeup({})],
      runs: [run({ id: "run-baseline", contextSnapshot: { issueId: "issue-1" } })],
      costs: [cost({ heartbeatRunId: "run-baseline", inputTokens: 80_000, cachedInputTokens: 60_000 })],
      issues: [issueOutput({ id: "issue-baseline" })],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 0, driftedAgentNames: [] },
      generatedAt: end,
    });

    expect(report.status).toBe("pass");
    expect(report.current.output.verifiedOutputUnits).toBeGreaterThan(report.baseline?.output.verifiedOutputUnits ?? 0);
    expect(report.current.output.finalDeliverableUnits).toBeGreaterThan(report.baseline?.output.finalDeliverableUnits ?? 0);
    expect(report.evaluation.valuableOutputStatus).toBe("pass");
    expect(report.evaluation.valuableOutputGainRatio).toBeGreaterThanOrEqual(0.9);
    expect(report.evaluation.tokenReductionStatus).toBe("pass");
  });

  it("does not treat successful artifact evidence without an issue as a final deliverable", () => {
    const runId = "run-ledger-only";
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      wakeups: [wakeup({ status: "claimed" })],
      runs: [run({ id: runId, contextSnapshot: {} })],
      costs: [cost({ heartbeatRunId: runId, inputTokens: 2_000, cachedInputTokens: 0, outputTokens: 300 })],
      ledgerEntries: [
        ledgerOutput({
          id: "ledger-without-issue",
          runId,
          issueId: null,
          finalOutcome: "succeeded",
          artifactRefs: [{ path: "receipts/timer-summary.md" }],
          receiptPaths: ["receipts/timer-summary.json"],
        }),
      ],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({})],
      runs: [run({ id: "run-baseline", contextSnapshot: { issueId: "issue-1" } })],
      costs: [cost({ heartbeatRunId: "run-baseline", inputTokens: 80_000, cachedInputTokens: 60_000 })],
      issues: [issueOutput({ id: "issue-baseline" })],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 0, driftedAgentNames: [] },
      generatedAt: end,
    });

    expect(report.current.output.verifiedOutputUnits).toBeGreaterThan(0);
    expect(report.current.output.finalDeliverableUnits).toBe(0);
    expect(report.evaluation.valuableOutputStatus).toBe("fail");
    expect(report.recommendedActions.join("\n")).toContain("final-deliverable");
  });

  it("fails on high-burn subscription events and timer launches without issue context", () => {
    const current = buildTokenomicsWindowMetrics({
      windowStart: start,
      windowEnd: end,
      highBurnThresholdTokens: 250_000,
      wakeups: [wakeup({ status: "claimed" })],
      runs: [run({ id: "run-high-burn", contextSnapshot: {} })],
      costs: [
        cost({
          heartbeatRunId: "run-high-burn",
          provider: "google",
          biller: "google",
          model: "gemini-3-flash-preview",
          inputTokens: 500_000,
          cachedInputTokens: 4_800_000,
          outputTokens: 8_000,
        }),
      ],
    });
    const baseline = buildTokenomicsWindowMetrics({
      windowStart: new Date("2026-06-12T20:00:00.000Z"),
      windowEnd: new Date("2026-06-16T20:00:00.000Z"),
      wakeups: [wakeup({})],
      runs: [run({ id: "run-baseline", contextSnapshot: { issueId: "issue-1" } })],
      costs: [cost({ heartbeatRunId: "run-baseline" })],
    });

    const report = buildTokenomicsWatchReport({
      current,
      baseline,
      budgetDrift: { hermesAgents: 56, driftedAgents: 4, driftedAgentNames: ["Paperclip/Hermes Builder"] },
      generatedAt: end,
    });

    expect(report.status).toBe("fail");
    expect(report.current.highBurnEvents).toHaveLength(1);
    expect(report.current.runs.timerNoIssueLaunches).toBe(1);
    expect(report.evaluation.highBurnStatus).toBe("fail");
    expect(report.evaluation.driftStatus).toBe("fail");
    expect(report.recommendedActions.join("\n")).toContain("high-burn");
    expect(report.recommendedActions.join("\n")).toContain("--apply-balance-on-drift");
  });
});
