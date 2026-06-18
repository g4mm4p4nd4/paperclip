import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildApprovedSonnetFallbackConfig,
  drainServiceWindowActiveRuns,
  loadInstanceEnvFile,
  planApprovedSonnetServiceWindowAgents,
  restoreApprovedSonnetServiceWindowFromReceipt,
} from "../ops/approved-sonnet-service-window.js";

function makeDrainReceipt() {
  return {
    version: "approved-sonnet-service-window.v1",
    status: "running",
    startedAt: "2026-06-16T04:00:00.000Z",
    finishedAt: null,
    deadlineAt: "2026-06-16T04:01:00.000Z",
    connectionSource: "test",
    options: {
      durationMinutes: 1,
      tickSeconds: 60,
      drainTimeoutMinutes: 20,
      drainPollSeconds: 5,
      recoverLookbackMinutes: 30,
      model: "role_default",
      maxTurnsPerRun: 25,
      command: "/opt/homebrew/bin/claude",
      geminiCommand: "/opt/homebrew/bin/gemini",
      agentIds: null,
    },
    counts: {
      candidates: 1,
      overlaysChanged: 1,
      dueAtStart: 1,
      dueWithinWindow: 1,
      restoreAttempts: 0,
      restoreSucceeded: 0,
      restoreFailed: 0,
    },
    planned: [],
    ticks: [],
    drain: {
      status: "not_started",
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      timeoutMinutes: 20,
      pollSeconds: 5,
      checks: [],
      remaining: [],
      cancelled: [],
    },
    recentRuns: [],
    recoveries: [],
    restored: [],
    receiptPath: null,
  } as any;
}

const activeRun = {
  id: "run-1",
  agentId: "agent-1",
  agentName: "Engineer",
  status: "running",
  processPid: 123,
  processGroupId: 123,
  createdAt: "2026-06-16T04:00:10.000Z",
  startedAt: "2026-06-16T04:00:10.000Z",
  lastOutputAt: "2026-06-16T04:00:20.000Z",
  lane: "gemini_local",
  model: "gemini-2.5-flash",
};

describe("approved Sonnet service window", () => {
  it("keeps MiniMax first and approves Gemini/Claude subscription fallbacks", () => {
    const current = {
      cwd: "/workspace/repo",
      source: "paperclip",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      tieredExecution: {
        enabled: true,
        minimaxPrimary: true,
        adapterOrder: ["hermes_minimax"],
        approvePostMiniMaxFallback: false,
        allowPostMiniMaxFallbacks: false,
        hermes_minimax: {
          provider: "minimax",
          model: "MiniMax-M3",
          command: "/opt/hermes/bin/hermes",
          disableFallbackModel: true,
        },
        claude_local: {
          model: "claude-opus-4-6",
          effort: "high",
        },
      },
    };

    const next = buildApprovedSonnetFallbackConfig(current, {
      command: "/opt/homebrew/bin/claude",
      geminiCommand: "/opt/homebrew/bin/gemini",
      model: "role_default",
      maxTurnsPerRun: 25,
    });

    const tieredExecution = next.tieredExecution as Record<string, unknown>;
    expect(tieredExecution).toMatchObject({
      enabled: true,
      minimaxPrimary: true,
      adapterOrder: ["hermes_minimax", "gemini_local", "claude_local"],
      approvePostMiniMaxFallback: true,
      approvedPostMiniMaxFallback: true,
      allowPostMiniMaxFallbacks: true,
      approvePaidSubscriptionFallback: true,
      approvedPaidSubscriptionFallback: true,
      allowPaidSubscriptionFallbacks: true,
      hermes_minimax: {
        provider: "minimax",
        model: "MiniMax-M3",
        command: "/opt/hermes/bin/hermes",
        disableFallbackModel: true,
      },
      gemini_local: {
        command: "/opt/homebrew/bin/gemini",
        authMode: "subscription",
        sandbox: false,
      },
      claude_local: {
        command: "/opt/homebrew/bin/claude",
        authMode: "subscription",
        effort: "high",
        maxTurnsPerRun: 25,
        dangerouslySkipPermissions: true,
      },
    });
    expect(tieredExecution.claude_local).not.toHaveProperty("model");
  });

  it("plans only invokable heartbeat-enabled Hermes agents in the service window", () => {
    const now = new Date("2026-06-16T04:00:00Z");
    const rows = [
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
        lastHeartbeatAt: new Date("2026-06-16T03:56:00Z"),
        createdAt: new Date("2026-06-16T03:00:00Z"),
      },
      {
        id: "agent-2",
        companyId: "company-1",
        name: "Paused",
        role: "engineer",
        status: "paused",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
        lastHeartbeatAt: new Date("2026-06-16T03:00:00Z"),
        createdAt: new Date("2026-06-16T03:00:00Z"),
      },
      {
        id: "agent-3",
        companyId: "company-1",
        name: "Codex",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
        lastHeartbeatAt: new Date("2026-06-16T03:00:00Z"),
        createdAt: new Date("2026-06-16T03:00:00Z"),
      },
      {
        id: "agent-4",
        companyId: "company-1",
        name: "Not Due",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 7200 } },
        lastHeartbeatAt: new Date("2026-06-16T03:59:00Z"),
        createdAt: new Date("2026-06-16T03:00:00Z"),
      },
    ];

    const planned = planApprovedSonnetServiceWindowAgents(rows, {
      now,
      durationMinutes: 60,
      model: "claude-sonnet-4-6",
      command: "/opt/homebrew/bin/claude",
      geminiCommand: "/opt/homebrew/bin/gemini",
      maxTurnsPerRun: 25,
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      agentId: "agent-1",
      dueAtStart: false,
      dueWithinWindow: true,
      nextAdapterConfig: {
        tieredExecution: {
          gemini_local: {
            command: "/opt/homebrew/bin/gemini",
          },
        },
      },
    });
  });

  it("loads the instance env file without overriding caller-provided values", async () => {
    const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const originalExisting = process.env.PAPERCLIP_EXISTING_VALUE;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_EXISTING_VALUE = "caller-value";

    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-sonnet-window-"));
      const instanceDir = path.join(home, "instances", "default");
      await mkdir(instanceDir, { recursive: true });
      await writeFile(
        path.join(instanceDir, ".env"),
        [
          "PAPERCLIP_AGENT_JWT_SECRET=file-secret",
          "PAPERCLIP_EXISTING_VALUE=file-value",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await loadInstanceEnvFile(home, "default");

      expect(result.loaded).toBe(true);
      expect(result.loadedKeys).toContain("PAPERCLIP_AGENT_JWT_SECRET");
      expect(result.loadedKeys).not.toContain("PAPERCLIP_EXISTING_VALUE");
      expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("file-secret");
      expect(process.env.PAPERCLIP_EXISTING_VALUE).toBe("caller-value");
    } finally {
      if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
      if (originalExisting === undefined) delete process.env.PAPERCLIP_EXISTING_VALUE;
      else process.env.PAPERCLIP_EXISTING_VALUE = originalExisting;
    }
  });

  it("waits for active service-window runs to settle before restore can proceed", async () => {
    const receipt = makeDrainReceipt();
    const writes: unknown[] = [];
    let nowMs = Date.parse("2026-06-16T04:00:00.000Z");
    let checks = 0;
    const cancelRun = vi.fn();

    const result = await drainServiceWindowActiveRuns({
      receipt,
      snapshotActiveRuns: async () => {
        checks += 1;
        return checks === 1 ? [activeRun] : [];
      },
      cancelRun,
      writeReceipt: async (updated) => {
        writes.push(JSON.parse(JSON.stringify(updated.drain)));
      },
      timeoutMs: 60_000,
      pollMs: 5_000,
      cancelReason: "test timeout",
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });

    expect(result).toEqual({ settled: true, cancelled: false, activeRuns: [] });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(receipt.drain.status).toBe("completed");
    expect(receipt.drain.checks.map((entry: { activeRuns: number }) => entry.activeRuns)).toEqual([1, 0]);
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });

  it("does not let new post-deadline scheduler starts extend the drain set", async () => {
    const receipt = makeDrainReceipt();
    const writes: unknown[] = [];
    let nowMs = Date.parse("2026-06-16T04:00:00.000Z");
    let checks = 0;
    const laterRun = {
      ...activeRun,
      id: "run-2",
      createdAt: "2026-06-16T04:00:15.000Z",
      startedAt: "2026-06-16T04:00:15.000Z",
    };

    const result = await drainServiceWindowActiveRuns({
      receipt,
      snapshotActiveRuns: async () => {
        checks += 1;
        return checks === 1 ? [activeRun] : [laterRun];
      },
      cancelRun: vi.fn(),
      writeReceipt: async (updated) => {
        writes.push(JSON.parse(JSON.stringify(updated.drain)));
      },
      timeoutMs: 60_000,
      pollMs: 5_000,
      cancelReason: "test timeout",
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });

    expect(result).toEqual({ settled: true, cancelled: false, activeRuns: [] });
    expect(receipt.drain.trackedRunIds).toEqual(["run-1"]);
    expect(receipt.drain.checks.map((entry: { activeRuns: number }) => entry.activeRuns)).toEqual([1, 0]);
    expect(receipt.drain.checks[1].ignoredRuns).toEqual([laterRun]);
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });

  it("cancels active service-window runs instead of restoring over live children after drain timeout", async () => {
    const receipt = makeDrainReceipt();
    let cancelled = false;
    const cancelRun = vi.fn(async () => {
      cancelled = true;
    });

    const result = await drainServiceWindowActiveRuns({
      receipt,
      snapshotActiveRuns: async () => (cancelled ? [] : [activeRun]),
      cancelRun,
      writeReceipt: async () => undefined,
      timeoutMs: 0,
      pollMs: 1_000,
      cancelGraceMs: 30_000,
      cancelReason: "test timeout",
      now: () => Date.parse("2026-06-16T04:00:00.000Z"),
      sleep: async () => undefined,
    });

    expect(result).toEqual({ settled: true, cancelled: true, activeRuns: [] });
    expect(cancelRun).toHaveBeenCalledWith("run-1", "test timeout");
    expect(receipt.drain.status).toBe("cancelled");
    expect(receipt.drain.cancelled).toEqual([{ runId: "run-1", ok: true }]);
  });

  it("restores temporary overlays from an interrupted receipt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-sonnet-restore-"));
    const receiptPath = path.join(home, "receipt.json");
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        version: "approved-sonnet-service-window.v1",
        status: "running",
        startedAt: "2026-06-16T04:00:00.000Z",
        finishedAt: null,
        deadlineAt: "2026-06-16T05:00:00.000Z",
        connectionSource: "test",
        options: {
          durationMinutes: 60,
          tickSeconds: 60,
          recoverLookbackMinutes: 30,
          model: "claude-sonnet-4-6",
          maxTurnsPerRun: 25,
          command: "/opt/homebrew/bin/claude",
          geminiCommand: "/opt/homebrew/bin/gemini",
          agentIds: null,
        },
        counts: {
          candidates: 1,
          overlaysChanged: 1,
          dueAtStart: 1,
          dueWithinWindow: 1,
          restoreAttempts: 0,
          restoreSucceeded: 0,
          restoreFailed: 0,
        },
        planned: [
          {
            agentId: "agent-1",
            companyId: "company-1",
            agentName: "Engineer",
            role: "engineer",
            previousAdapterConfig: { tieredExecution: { adapterOrder: ["hermes_minimax"] } },
            nextAdapterConfig: { tieredExecution: { adapterOrder: ["hermes_minimax", "claude_local"] } },
            changed: true,
            intervalSec: 300,
            elapsedSecAtStart: 300,
            dueAtStart: true,
            dueWithinWindow: true,
          },
        ],
        ticks: [],
        recentRuns: [],
        recoveries: [],
        restored: [],
        receiptPath,
      }, null, 2)}\n`,
      "utf8",
    );

    const updates: unknown[] = [];
    const db = {
      update: () => ({
        set: (payload: unknown) => {
          updates.push(payload);
          return { where: async () => undefined };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    };

    const result = await restoreApprovedSonnetServiceWindowFromReceipt(db as never, receiptPath, {
      markFailedReason: "interrupted in test",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      adapterConfig: { tieredExecution: { adapterOrder: ["hermes_minimax"] } },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("interrupted in test");
    expect(result.counts.restoreSucceeded).toBe(1);
    expect(result.counts.restoreFailed).toBe(0);

    const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(persisted.status).toBe("failed");
    expect(persisted.restored).toEqual([{ agentId: "agent-1", ok: true }]);
  });
});
