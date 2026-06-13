import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPaperclipPromptMetrics,
  PAPERCLIP_OUTPUT_BUDGET_VERSION,
  renderPaperclipOutputContract,
  renderPaperclipContextEconomyPrompt,
  renderPaperclipSessionDeltaPrompt,
  renderPaperclipWakePrompt,
  resolvePaperclipPromptClass,
  runChildProcess,
  sanitizeClaudeParentHarnessEnv,
} from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe("runChildProcess", () => {
  it("strips parent harness markers from Claude child environments while preserving explicit overrides", () => {
    const sanitized = sanitizeClaudeParentHarnessEnv(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION: "parent-session",
        CLAUDE_CODE_PARENT_SESSION: "root-session",
        CODEX_HOME: "/parent/codex",
        ANTHROPIC_API_KEY: "sk-ant",
        CLAUDE_CONFIG_DIR: "/home/user/.claude",
        PATH: "/usr/bin",
      },
      new Set(["CODEX_HOME"]),
    );

    expect(sanitized.CLAUDECODE).toBeUndefined();
    expect(sanitized.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(sanitized.CLAUDE_CODE_PARENT_SESSION).toBeUndefined();
    expect(sanitized.CODEX_HOME).toBe("/parent/codex");
    expect(sanitized.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(sanitized.CLAUDE_CONFIG_DIR).toBe("/home/user/.claude");
    expect(sanitized.PATH).toBe("/usr/bin");
  });

  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    const descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("renders issue-assigned wakes without inline comments when the issue is already checked out", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Require a comment",
        status: "in_progress",
        priority: "medium",
      },
      checkedOutByHarness: true,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      commentWindow: {
        requestedCount: 0,
        includedCount: 0,
        missingCount: 0,
      },
      truncated: false,
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("- issue: PAP-1 Require a comment");
    expect(prompt).toContain("- checkout: already claimed by the harness for this run");
    expect(prompt).toContain("The harness already checked out this issue for the current run.");
    expect(prompt).toContain("No inline comments were included in this wake.");
  });
});

describe("renderPaperclipSessionDeltaPrompt", () => {
  it("renders a compact timer delta when a resumed session has no inline wake payload", () => {
    const prompt = renderPaperclipSessionDeltaPrompt(
      {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        wakeTriggerDetail: "system",
      },
      { resumedSession: true, runId: "run-1" },
    );

    expect(prompt).toContain("## Paperclip Resume Delta");
    expect(prompt).toContain("- reason: heartbeat_timer");
    expect(prompt).toContain("- run id: run-1");
    expect(prompt).toContain("- scope: timer heartbeat with no pinned issue");
    expect(prompt).not.toContain("Paperclip API access note");
  });

  it("does not render a fallback delta for fresh bootstrap runs", () => {
    expect(renderPaperclipSessionDeltaPrompt({ wakeReason: "heartbeat_timer" })).toBe("");
  });
});

describe("renderPaperclipContextEconomyPrompt", () => {
  it("renders map-first Repomix and TOON context guidance", () => {
    const prompt = renderPaperclipContextEconomyPrompt({
      mode: "map_first",
      repoKey: "paperclip",
      generatedAt: "2026-05-31T05:17:54.561Z",
      contextPacks: {
        dir: "/tmp/context-packs",
        manifest: "/tmp/context-packs/latest.json",
        compact: "/tmp/context-packs/latest.compact.md",
        toon: "/tmp/context-packs/latest.toon",
        tsv: "/tmp/context-packs/latest.tsv",
        policy: "/tmp/context-packs/CONTEXT_ECONOMY.md",
      },
      packs: {
        map: "/tmp/context-packs/packs/paperclip-map-latest.md",
        delta: "/tmp/context-packs/packs/paperclip-delta-latest.md",
        core: "/tmp/context-packs/packs/paperclip-core-latest.md",
      },
    });

    expect(prompt).toContain("## Paperclip Context Economy");
    expect(prompt).toContain("- repo: paperclip");
    expect(prompt).toContain("paperclip-map-latest.md");
    expect(prompt).toContain("latest.toon");
    expect(prompt).toContain("Use delta packs for recent dirty-tree context");
  });

  it("returns an empty prompt when no context pack paths are available", () => {
    expect(renderPaperclipContextEconomyPrompt({})).toBe("");
  });
});

describe("paperclip prompt metrics", () => {
  it("renders a compact final response output contract with explicit expansion rules", () => {
    const prompt = renderPaperclipOutputContract();

    expect(prompt).toContain("## Paperclip Output Contract");
    expect(prompt).toContain(PAPERCLIP_OUTPUT_BUDGET_VERSION);
    expect(prompt).toContain("7 sentences");
    expect(prompt).toContain("1200 characters");
    expect(prompt).toContain("Expansion is allowed only");
    expect(prompt).toContain("receipts/artifacts");
  });

  it("classifies prompt classes from session and wake reason", () => {
    expect(resolvePaperclipPromptClass({ hasSession: false, wakeReason: "issue_commented" })).toBe("bootstrap");
    expect(resolvePaperclipPromptClass({ hasSession: true, wakeReason: "issue_commented" })).toBe("comment_delta");
    expect(resolvePaperclipPromptClass({ hasSession: true, wakeReason: "timer_heartbeat" })).toBe("timer_delta");
    expect(resolvePaperclipPromptClass({ hasSession: true, wakeReason: "provider_failure_recovery" })).toBe("failure_recovery");
    expect(resolvePaperclipPromptClass({ hasSession: true, wakeReason: "issue_assigned" })).toBe("resume_delta");
  });

  it("emits versioned component hashes without storing raw component text in metadata", () => {
    const result = buildPaperclipPromptMetrics({
      prompt: "wake evidence\nheartbeat",
      promptClass: "comment_delta",
      baseMetrics: { wakePromptChars: 13, heartbeatPromptChars: 9 },
      components: [
        {
          name: "paperclip_wake",
          componentType: "evidence_slice",
          content: "wake evidence",
          metadata: { source: "wake" },
        },
        {
          name: "heartbeat_prompt",
          content: "heartbeat",
        },
      ],
    });

    expect(result.promptBudgetVersion).toBe("context-economy.v1");
    expect(result.outputBudgetVersion).toBe("output-economy.v1");
    expect(result.evidenceSliceCount).toBe(1);
    expect(result.promptMetrics).toMatchObject({
      promptClass: "comment_delta",
      promptBudgetVersion: "context-economy.v1",
      outputBudgetVersion: "output-economy.v1",
      outputBudget: expect.objectContaining({
        maxOutputTokens: 700,
        maxSentences: 7,
      }),
      totalChars: "wake evidence\nheartbeat".length,
      estimatedPromptTokens: Math.ceil("wake evidence\nheartbeat".length / 4),
    });
    expect(result.promptMetrics.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "paperclip_wake",
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          evidenceSliceCount: 1,
          metadata: expect.objectContaining({ source: "wake" }),
        }),
      ]),
    );
    expect(JSON.stringify(result.promptMetrics.components)).not.toContain("wake evidence");
  });
});
