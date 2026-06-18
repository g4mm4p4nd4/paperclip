import { describe, expect, it } from "vitest";
import {
  buildTokenomicsAnalysisReceipt,
  classifyBurnClass,
  receiptFilePath,
  type BurnClassSummary,
} from "../ops/hermes-tokenomics-analysis.js";

describe("Hermes tokenomics analysis", () => {
  it("includes process identity in receipt filenames to avoid same-timestamp collisions", () => {
    const now = new Date("2026-06-17T05:10:49.123Z");
    const first = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 111);
    const second = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 222);

    expect(first).not.toBe(second);
    expect(first).toContain("20260617T051049123Z-111-hermes-tokenomics-analysis.json");
    expect(second).toContain("20260617T051049123Z-222-hermes-tokenomics-analysis.json");
  });

  it("classifies no-issue timer/manual runs separately from issue-tied delivery", () => {
    expect(classifyBurnClass({
      heartbeatRunId: "run-1",
      invocationSource: "timer",
      hasContextIssue: false,
      executionIssues: 0,
      completedIssues: 0,
      issueTiedSuccessfulLedgerEntries: 0,
    })).toBe("no_issue_no_deliverable_timer_or_manual");

    expect(classifyBurnClass({
      heartbeatRunId: "run-2",
      invocationSource: "assignment",
      hasContextIssue: true,
      executionIssues: 0,
      completedIssues: 0,
      issueTiedSuccessfulLedgerEntries: 2,
    })).toBe("issue_tied_delivery_or_evidence");

    expect(classifyBurnClass({
      heartbeatRunId: "run-3",
      invocationSource: "assignment",
      hasContextIssue: true,
      executionIssues: 1,
      completedIssues: 0,
      issueTiedSuccessfulLedgerEntries: 0,
    })).toBe("issue_context_without_completed_delivery");
  });

  it("estimates whether deterministic no-issue shaping can meet the 50 percent savings target", () => {
    const burnClasses: BurnClassSummary[] = [
      {
        class: "no_issue_no_deliverable_timer_or_manual",
        runs: 271,
        inputTokens: 36_129_577,
        cachedInputTokens: 152_813_062,
        outputTokens: 748_677,
        rawTokens: 189_691_316,
        rawPercent: 59.02,
      },
      {
        class: "issue_tied_delivery_or_evidence",
        runs: 98,
        inputTokens: 91_825_393,
        cachedInputTokens: 21_831_383,
        outputTokens: 429_797,
        rawTokens: 114_086_573,
        rawPercent: 35.5,
      },
    ];

    const receipt = buildTokenomicsAnalysisReceipt({
      windowDays: 5,
      connectionSource: "test",
      generatedAt: new Date("2026-06-17T05:00:00.000Z"),
      burnClasses,
      providerBreakdown: [],
      agentSourceBreakdown: [],
      topRuns: [],
    });

    expect(receipt.totals.rawTokens).toBe(303_777_889);
    expect(receipt.deterministicRequestCandidates[0]).toMatchObject({
      class: "no_issue_no_deliverable_timer_or_manual",
      observedRuns: 271,
      targetRawTokensPerRun: 30_000,
      estimatedTargetRawTokens: 8_130_000,
      estimatedSavingsTokens: 181_561_316,
    });
    expect(receipt.deterministicRequestCandidates[0].estimatedSavingsRatioOfTotal).toBeGreaterThan(0.5);
    expect(receipt.recommendations[0]).toContain("can meet the 50 percent token-reduction target");
  });
});
