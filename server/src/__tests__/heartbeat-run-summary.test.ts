import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  inferHeartbeatRunResultFailure,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("compacts verbose summaries while preserving decisive evidence lines", () => {
    const paragraphs = Array.from({ length: 14 }, (_, index) =>
      `Paragraph ${index + 1} explains background that should not be replayed into future prompts.`,
    ).join("\n\n");
    const comment = buildHeartbeatRunIssueComment({
      summary: [
        "Implemented the output budget ledger.",
        "Tests passed.",
        "Receipt: .tmp/output-budget/POR-2600-receipt.json",
        "Changed files: server/src/services/context-ledger.ts, ui/src/pages/AgentDetail.tsx",
        paragraphs,
      ].join("\n"),
    });

    expect(comment).not.toBeNull();
    expect(comment!.length).toBeLessThanOrEqual(1_200);
    expect(comment).toContain("Receipt: .tmp/output-budget/POR-2600-receipt.json");
    expect(comment).toContain("Tests passed.");
    expect(comment).toContain("Full detail remains in the run log/result and context ledger.");
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });

  it("normalizes strings so adapter metadata is safe for Postgres jsonb", () => {
    const merged = mergeHeartbeatRunResultJson(
      {
        result: "ok\u0000",
        stdoutTail: "\udf10 Endpoint",
        nested: {
          lines: ["valid \ud83c\udf10", "\ud83c broken"],
        },
      },
      "done\udf10",
    );

    expect(merged).toEqual({
      result: "ok",
      stdoutTail: "\ufffd Endpoint",
      nested: {
        lines: ["valid \ud83c\udf10", "\ufffd broken"],
      },
      summary: "done\ufffd",
    });
  });
});

describe("inferHeartbeatRunResultFailure", () => {
  it("detects terminal Hermes API failures even when the process exited cleanly", () => {
    const failure = inferHeartbeatRunResultFailure(
      {
        stdoutTail: [
          "Rate limited - switching to fallback provider...",
          "Max retries (3) exceeded. Giving up.",
          "API call failed after 3 retries: HTTP 429: Monthly usage limit reached.",
          "session_id: 20260601_180009_2127a8",
        ].join("\n"),
      },
      null,
    );

    expect(failure).toEqual({
      code: "adapter_failed",
      message: "API call failed after 3 retries: HTTP 429: Monthly usage limit reached.",
    });
  });

  it("does not treat recoverable retry text as a terminal adapter failure", () => {
    expect(
      inferHeartbeatRunResultFailure(
        {
          stdoutTail: [
            "API call failed (attempt 1/3): HTTP 429",
            "Rate limited - switching to fallback provider...",
            "Fallback completed the task successfully.",
          ].join("\n"),
          summary: "Fallback completed the task successfully.",
        },
        null,
      ),
    ).toBeNull();
  });
});
