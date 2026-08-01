import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  attachProfitFlywheelExecutionDirective,
  buildRealizedExecutionWorkspaceFromPersisted,
  buildExplicitResumeSessionOverride,
  deriveTaskKeyWithHeartbeatFallback,
  extractWakeCommentIds,
  formatRuntimeWorkspaceWarningLog,
  mergeCoalescedContextSnapshot,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveRuntimeSessionParamsForWorkspace,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  shouldResetTaskSessionForWake,
  shouldRequireIssueCommentForWake,
  shouldAttachPaperclipContextEconomy,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

describe("attachProfitFlywheelExecutionDirective", () => {
  it("puts the exact release action and immutable receipt requirement into the highest-priority wake payload", () => {
    const enriched = attachProfitFlywheelExecutionDirective({
      wakePayload: {
        issue: { id: "issue-1", identifier: "CAN-1", title: "Implement product" },
        comments: [],
        commentWindow: { includedCount: 0, requestedCount: 0, missingCount: 0 },
      },
      issueId: "issue-1",
      stage: "release",
      attempt: 2,
      manifestPath: "/workspace/.paperclip/manifests/release-attempt-2.json",
      receiptOutputPath: "/workspace/.paperclip/receipts/release-attempt-2.json",
      observedAt: new Date("2026-07-13T05:00:00.000Z"),
    });
    const comments = enriched.comments as Array<{ body: string }>;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("You are executing stage release, attempt 2");
    expect(comments[0]?.body).toContain("Publish the QA-tested implementation object");
    expect(comments[0]?.body).toContain("/workspace/.paperclip/manifests/release-attempt-2.json");
    expect(comments[0]?.body).toContain("/workspace/.paperclip/receipts/release-attempt-2.json");
    expect(enriched.commentWindow).toMatchObject({ includedCount: 1, requestedCount: 1, missingCount: 0 });
  });
});

describe("shouldAttachPaperclipContextEconomy", () => {
  it("never reattaches context packs to manifest-only flywheel execution", () => {
    expect(shouldAttachPaperclipContextEconomy({
      paperclipContextEconomy: { mode: "map_first", packs: { map: "/tmp/map.md" } },
      paperclipProfitFlywheelExecutionScope: { mode: "manifest_only" },
    })).toBe(false);
  });

  it("keeps context packs available for ordinary agent work", () => {
    expect(shouldAttachPaperclipContextEconomy({})).toBe(true);
  });
});

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildAgent(adapterType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("applyPersistedExecutionWorkspaceConfig", () => {
  it("does not add workspace runtime when only the project workspace had manual runtime config", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: null,
      mode: "isolated_workspace",
    });

    expect("workspaceRuntime" in result).toBe(false);
  });

  it("applies explicit persisted execution workspace runtime config when present", () => {
    const result = applyPersistedExecutionWorkspaceConfig({
      config: {},
      workspaceConfig: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        desiredState: null,
        workspaceRuntime: {
          services: [{ name: "workspace-web" }],
        },
      },
      mode: "isolated_workspace",
    });

    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "workspace-web" }],
    });
  });
});

describe("buildRealizedExecutionWorkspaceFromPersisted", () => {
  it("reuses the persisted execution workspace path instead of deriving a new worktree", () => {
    const result = buildRealizedExecutionWorkspaceFromPersisted({
      base: buildResolvedWorkspace({
        cwd: "/tmp/project-primary",
        repoRef: "main",
      }),
      workspace: {
        id: "execution-workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "PAP-880-thumbs-capture-for-evals-feature",
        status: "active",
        cwd: "/tmp/reused-worktree",
        repoUrl: "https://example.com/paperclip.git",
        baseRef: "main",
        branchName: "PAP-880-thumbs-capture-for-evals-feature",
        providerType: "git_worktree",
        providerRef: "/tmp/reused-worktree",
        derivedFromExecutionWorkspaceId: null,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        closedAt: null,
        cleanupEligibleAt: null,
        cleanupReason: null,
        config: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(result.created).toBe(false);
    expect(result.strategy).toBe("git_worktree");
    expect(result.cwd).toBe("/tmp/reused-worktree");
    expect(result.worktreePath).toBe("/tmp/reused-worktree");
    expect(result.branchName).toBe("PAP-880-thumbs-capture-for-evals-feature");
    expect(result.source).toBe("task_session");
  });

  it("falls back to realization when the persisted workspace has no local path yet", () => {
    const result = buildRealizedExecutionWorkspaceFromPersisted({
      base: buildResolvedWorkspace({
        cwd: "/tmp/project-primary",
        repoRef: "main",
      }),
      workspace: {
        id: "execution-workspace-2",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-2",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "PAP-999-missing-provider-ref",
        status: "active",
        cwd: null,
        repoUrl: "https://example.com/paperclip.git",
        baseRef: "main",
        branchName: "feature/PAP-999-missing-provider-ref",
        providerType: "git_worktree",
        providerRef: null,
        derivedFromExecutionWorkspaceId: null,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        closedAt: null,
        cleanupEligibleAt: null,
        cleanupReason: null,
        config: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    expect(result).toBeNull();
  });
});

describe("stripWorkspaceRuntimeFromExecutionRunConfig", () => {
  it("removes workspace runtime before heartbeat execution", () => {
    const input = {
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
      workspaceRuntime: {
        services: [{ name: "web" }],
      },
    };

    const result = stripWorkspaceRuntimeFromExecutionRunConfig(input);

    expect(result).toEqual({
      cwd: "/tmp/project",
      workspaceStrategy: {
        type: "git_worktree",
      },
    });
    expect(input.workspaceRuntime).toEqual({
      services: [{ name: "web" }],
    });
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});

describe("shouldRequireIssueCommentForWake", () => {
  it("requires a comment for ordinary assignment wakes", () => {
    expect(shouldRequireIssueCommentForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("defers comment and retry ownership to the profit-flywheel stage controller", () => {
    expect(
      shouldRequireIssueCommentForWake({
        wakeReason: "issue_assigned",
        profitFlywheelStageRunId: "stage-run-1",
      }),
    ).toBe(false);
  });

  it("does not queue a generic comment retry for the exact persisted no-fallback provider route", () => {
    const context = {
      wakeReason: "issue_assigned",
      paperclipResolvedRoute: {
        routeId: "opencode_go_deep",
        resolvedRouteSha256: "a".repeat(64),
        runtimeBinding: { hiddenFallbackDisabled: true },
      },
    };

    expect(shouldRequireIssueCommentForWake(context, {
      providerRouteId: "opencode_go_deep",
      providerRouteSha256: "a".repeat(64),
    })).toBe(false);
  });

  it("does not trust an unpersisted or mismatched no-fallback route claim", () => {
    const context = {
      wakeReason: "issue_assigned",
      paperclipResolvedRoute: {
        routeId: "opencode_go_deep",
        resolvedRouteSha256: "a".repeat(64),
        runtimeBinding: { hiddenFallbackDisabled: true },
      },
    };

    expect(shouldRequireIssueCommentForWake(context)).toBe(true);
    expect(shouldRequireIssueCommentForWake(context, {
      providerRouteId: "opencode_go_deep",
      providerRouteSha256: "b".repeat(64),
    })).toBe(true);
  });
});

describe("deriveTaskKeyWithHeartbeatFallback", () => {
  it("returns explicit taskKey when present", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ taskKey: "issue-123" }, null)).toBe("issue-123");
  });

  it("returns explicit issueId when no taskKey", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ issueId: "issue-456" }, null)).toBe("issue-456");
  });

  it("returns __heartbeat__ for timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer" }, null)).toBe("__heartbeat__");
  });

  it("prefers explicit key over heartbeat fallback even on timer wakes", () => {
    expect(
      deriveTaskKeyWithHeartbeatFallback({ wakeSource: "timer", taskKey: "issue-789" }, null),
    ).toBe("issue-789");
  });

  it("returns null for non-timer wakes with no explicit key", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({ wakeSource: "on_demand" }, null)).toBeNull();
  });

  it("returns null for empty context", () => {
    expect(deriveTaskKeyWithHeartbeatFallback({}, null)).toBeNull();
  });
});

describe("comment wake batching", () => {
  it("preserves ordered wake comment ids when coalescing queued follow-up wakes", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
        paperclipWake: {
          latestCommentId: "comment-1",
        },
      },
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        wakeCommentId: "comment-2",
      },
    );

    expect(extractWakeCommentIds(merged)).toEqual(["comment-1", "comment-2"]);
    expect(merged.commentId).toBe("comment-2");
    expect(merged.wakeCommentId).toBe("comment-2");
    expect(merged.paperclipWake).toBeUndefined();
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("reuses saved task session params when they belong to the selected failed run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-1",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
      },
    });
  });

  it("falls back to the selected run session id when no matching task session params are available", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "other-session",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "other-session",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
      },
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Using fallback workspace")).toEqual({
      stream: "stdout",
      chunk: "[paperclip] Using fallback workspace\n",
    });
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("uses Paperclip-managed guardrails for Hermes sessions", () => {
    expect(parseSessionCompactionPolicy(buildAgent("hermes_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 12,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});
