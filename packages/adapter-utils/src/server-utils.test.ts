import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  budgetPromptSections,
  buildPaperclipPromptMetrics,
  PAPERCLIP_OUTPUT_BUDGET_VERSION,
  renderPaperclipOutputContract,
  renderPaperclipContextEconomyPrompt,
  renderPaperclipSessionDeltaPrompt,
  renderPaperclipWakePrompt,
  resolvePaperclipPromptClass,
  resolvePaperclipRequestShaping,
  resolvePaperclipSessionContinuity,
  resolvePaperclipRuntimeSkillCandidateNames,
  runChildProcess,
  sanitizeClaudeParentHarnessEnv,
  selectPaperclipRuntimeSkillsForRun,
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
  it("selects a bounded role-and-context skill set with skipped metrics", () => {
    const selection = selectPaperclipRuntimeSkillsForRun({
      config: {},
      agentName: "CMO",
      identifiers: [
        "paperclip/paperclip",
        "paperclip/paperclip-go-to-market",
        "paperclip/paperclip-product-scope",
        "paperclip/product-launch",
        "paperclip/distribution-spine",
        "paperclip/analytics-tracking",
        "paperclip/long-form-sales-letter",
        "paperclip/b2b-case-study-journalist",
      ],
      context: {
        issue: {
          title: "Reissue GTM as community-channel launch pack gated to v0.4.0",
        },
      },
    });

    expect(selection.selected.length).toBeLessThanOrEqual(5);
    expect(selection.selected).toEqual(expect.arrayContaining([
      "paperclip/paperclip",
      "paperclip/paperclip-go-to-market",
      "paperclip/paperclip-product-scope",
      "paperclip/product-launch",
      "paperclip/distribution-spine",
    ]));
    expect(selection.selected).not.toContain("paperclip/long-form-sales-letter");
    expect(selection.metrics).toMatchObject({
      mode: "adaptive",
      maxSkills: 5,
      selectedCount: 5,
      candidatePool: "approved_company",
      selectionPolicyVersion: "paperclip.skill-selection.v2",
      skippedCount: 3,
    });
  });

  it("keeps broad CMO strategy prompts from selecting direct-response content skills", () => {
    const selection = selectPaperclipRuntimeSkillsForRun({
      config: {},
      agentRole: "cmo",
      agentName: "CMO",
      identifiers: [
        "paperclip/paperclip",
        "paperclip/paperclip-go-to-market",
        "paperclip/paperclip-product-scope",
        "paperclip/para-memory-files",
        "paperclip/product-launch",
        "paperclip/distribution-spine",
        "paperclip/analytics-tracking",
        "paperclip/long-form-sales-letter",
        "paperclip/seo-article-architect",
      ],
      context: {
        issue: {
          title: "Create a marketing strategy for project X",
        },
      },
    });

    expect(selection.selected).toEqual(expect.arrayContaining([
      "paperclip/paperclip",
      "paperclip/paperclip-go-to-market",
      "paperclip/paperclip-product-scope",
      "paperclip/para-memory-files",
    ]));
    expect(selection.selected).not.toContain("paperclip/long-form-sales-letter");
    expect(selection.selected).not.toContain("paperclip/seo-article-architect");
    expect(selection.metrics.trace?.find((entry) => entry.identifier === "paperclip/long-form-sales-letter")).toMatchObject({
      selected: false,
      score: 0,
    });
  });

  it("gives Growth and Distribution role-relevant launch skills even when desiredSkills is sparse", () => {
    const available = [
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", required: true },
      { key: "paperclipai/paperclip/paperclip-go-to-market", runtimeName: "paperclip-go-to-market" },
      { key: "paperclipai/paperclip/paperclip-product-scope", runtimeName: "paperclip-product-scope" },
      { key: "local/distribution-spine", runtimeName: "distribution-spine" },
      { key: "local/product-launch", runtimeName: "product-launch" },
      { key: "local/analytics-tracking", runtimeName: "analytics-tracking" },
      { key: "local/long-form-sales-letter", runtimeName: "long-form-sales-letter" },
    ];
    const candidates = resolvePaperclipRuntimeSkillCandidateNames(
      { paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip"] } },
      available,
    );
    const selection = selectPaperclipRuntimeSkillsForRun({
      config: {},
      agentRole: "cmo",
      agentName: "Growth/Distribution",
      identifiers: candidates,
      context: {
        issue: {
          title: "Launch the product through community and newsletter channels with analytics",
        },
      },
    });

    expect(selection.selected).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip",
      "local/distribution-spine",
      "local/product-launch",
      "local/analytics-tracking",
    ]));
    expect(selection.selected).not.toContain("local/long-form-sales-letter");
    expect(selection.metrics.maxSkills).toBe(6);
  });

  it("uses the explicit agent role to retain research specialty skills", () => {
    const selection = selectPaperclipRuntimeSkillsForRun({
      config: {},
      agentRole: "researcher",
      agentName: "VOC Researcher",
      identifiers: [
        "paperclip/paperclip",
        "paperclip/paperclip-product-scope",
        "paperclip/para-memory-files",
        "paperclip/market-signal-scout",
        "paperclip/repo-opportunity-analyst",
        "paperclip/voc-research-miner",
        "paperclip/web-content-extractor",
        "paperclip/evidence-factory",
        "paperclip/ponytail",
      ],
      context: {
        issue: {
          title: "Mine VOC evidence and repository opportunity signals from source URLs",
        },
      },
    });

    expect(selection.selected).toEqual(expect.arrayContaining([
      "paperclip/paperclip",
      "paperclip/market-signal-scout",
      "paperclip/repo-opportunity-analyst",
      "paperclip/voc-research-miner",
      "paperclip/web-content-extractor",
    ]));
    expect(selection.metrics.maxSkills).toBe(7);
  });

  it("allows explicit all and none skill budget modes", () => {
    const identifiers = ["paperclip/paperclip", "paperclip/ponytail"];

    expect(selectPaperclipRuntimeSkillsForRun({
      config: { paperclipSkillBudgetMode: "all" },
      identifiers,
    }).selected).toEqual(identifiers);

    expect(selectPaperclipRuntimeSkillsForRun({
      config: { paperclipSkillBudgetMode: "none" },
      identifiers,
    }).selected).toEqual([]);
  });

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
  it("trims large non-protected prompt sections before protected wake evidence", () => {
    const result = budgetPromptSections(
      [
        { name: "agent_instructions", content: "A".repeat(2_000), minChars: 100 },
        { name: "paperclip_wake", content: "wake evidence must stay", protected: true, minChars: 20 },
        { name: "output_contract", content: "contract must stay", protected: true, minChars: 10 },
        { name: "heartbeat_prompt", content: "B".repeat(2_000), minChars: 100 },
      ],
      700,
    );

    expect(result.prompt.length).toBeLessThanOrEqual(700);
    expect(result.sections.paperclip_wake).toBe("wake evidence must stay");
    expect(result.sections.output_contract).toBe("contract must stay");
    expect(result.truncatedSections.map((section) => section.name)).toEqual(
      expect.arrayContaining(["agent_instructions", "heartbeat_prompt"]),
    );
    expect(result.truncatedSections.map((section) => section.name)).not.toContain("paperclip_wake");
  });

  it("renders a compact final response output contract with explicit expansion rules", () => {
    const prompt = renderPaperclipOutputContract();

    expect(prompt).toContain("## Paperclip Output Contract");
    expect(prompt).toContain(PAPERCLIP_OUTPUT_BUDGET_VERSION);
    expect(prompt).toContain("7 sentences");
    expect(prompt).toContain("1200 characters");
    expect(prompt).toContain("finalDisposition");
    expect(prompt).toContain("advanced_vision, maintenance, blocked, noop, or misaligned");
    expect(prompt).toContain("nextActionOwner");
    expect(prompt).toContain("goLiveDelta");
    expect(prompt).toContain("milestone_progress, artifact_delivery, handoff, truthful_blocker, maintenance, noop, or misaligned");
    expect(prompt).toContain("companyMilestone");
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

describe("Paperclip session continuity", () => {
  it("allows resume only when the saved session matches the current issue work key", () => {
    const requestShaping = resolvePaperclipRequestShaping({
      config: {},
      context: { issueId: "issue-1" },
      baseContextMaxChars: 24_000,
      baseOutputMaxChars: 3_200,
      baseOutputMaxSentences: 12,
      baseMaxTurnsPerRun: 12,
    });

    const result = resolvePaperclipSessionContinuity({
      config: {},
      context: { issueId: "issue-1" },
      runtimeSessionId: "session-1",
      sessionParams: { sessionId: "session-1", cwd: "/tmp/work", workKey: "issue:issue-1", issueId: "issue-1" },
      cwd: "/tmp/work",
      requestShaping,
    });

    expect(result.sessionId).toBe("session-1");
    expect(result.reason).toBe("work_key_match");
    expect(result.suppressed).toBe(false);
  });

  it("suppresses ambiguous legacy resumes even when the current issue is explicit work", () => {
    const requestShaping = resolvePaperclipRequestShaping({
      config: {},
      context: { issueId: "issue-2" },
      baseContextMaxChars: 24_000,
      baseOutputMaxChars: 3_200,
      baseOutputMaxSentences: 12,
      baseMaxTurnsPerRun: 12,
    });

    const result = resolvePaperclipSessionContinuity({
      config: {},
      context: { issueId: "issue-2" },
      runtimeSessionId: "legacy-session",
      sessionParams: { sessionId: "legacy-session", cwd: "/tmp/work" },
      cwd: "/tmp/work",
      requestShaping,
    });

    expect(result.sessionId).toBeNull();
    expect(result.reason).toBe("missing_saved_work_key");
    expect(result.suppressed).toBe(true);
    expect(result.workIdentity).toMatchObject({ workKey: "issue:issue-2", issueId: "issue-2" });
  });

  it("suppresses any resume for bounded no-handoff status checks", () => {
    const requestShaping = resolvePaperclipRequestShaping({
      config: {},
      context: {},
      baseContextMaxChars: 24_000,
      baseOutputMaxChars: 3_200,
      baseOutputMaxSentences: 12,
      baseMaxTurnsPerRun: 12,
    });

    const result = resolvePaperclipSessionContinuity({
      config: {},
      context: {},
      runtimeSessionId: "session-1",
      sessionParams: { sessionId: "session-1", cwd: "/tmp/work", workKey: "issue:issue-1", issueId: "issue-1" },
      cwd: "/tmp/work",
      requestShaping,
    });

    expect(result.sessionId).toBeNull();
    expect(result.reason).toBe("request_shaping_bounded_status");
    expect(result.suppressed).toBe(true);
  });

  it("suppresses resume for timer-pinned assigned work without a fresh external signal", () => {
    const context = {
      issueId: "issue-timer",
      taskId: "issue-timer",
      wakeSource: "timer",
      wakeReason: "assigned_work_timer",
      paperclipTimerPinnedIssue: {
        reason: "timer_open_assignment_pinned",
        issueId: "issue-timer",
        identifier: "TIMER-1",
        status: "in_progress",
      },
      paperclipWake: {
        issue: { id: "issue-timer", identifier: "TIMER-1" },
        reason: "assigned_work_timer",
        comments: [],
        commentIds: [],
      },
    };
    const requestShaping = resolvePaperclipRequestShaping({
      config: {},
      context,
      baseContextMaxChars: 24_000,
      baseOutputMaxChars: 3_200,
      baseOutputMaxSentences: 12,
      baseMaxTurnsPerRun: 12,
    });
    const result = resolvePaperclipSessionContinuity({
      config: {},
      context,
      runtimeSessionId: "session-1",
      sessionParams: { sessionId: "session-1", cwd: "/tmp/work", workKey: "issue:issue-timer", issueId: "issue-timer" },
      cwd: "/tmp/work",
      requestShaping,
    });

    expect(requestShaping.mode).toBe("deliverable_work");
    expect(requestShaping.reason).toBe("timer_assigned_work_without_external_signal");
    expect(requestShaping.allowSessionResume).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.reason).toBe("request_shaping_deliverable_work");
    expect(result.suppressed).toBe(true);
  });
});
