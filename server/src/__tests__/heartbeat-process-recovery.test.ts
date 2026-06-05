import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentContextCursors,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  contextLedgerComponents,
  contextLedgerEntries,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  getServerAdapter,
  registerServerAdapter,
  runningProcesses,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { evaluateProviderReliabilityPreflight, heartbeatService } from "../services/heartbeat.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
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

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 25,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(await condition());
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    unregisterServerAdapter("stall_no_spawn");
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await db.delete(companySkills);
    await db.delete(contextLedgerComponents);
    await db.delete(contextLedgerEntries);
    await db.delete(agentContextCursors);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    unregisterServerAdapter("stall_no_spawn");
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    issueStatus?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
    issueHiddenAt?: Date | null;
    runErrorCode?: string | null;
    runError?: string | null;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: {
        ...(input?.includeIssue === false ? {} : { issueId }),
        ...(input?.contextSnapshot ?? {}),
      },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: input?.issueStatus ?? "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        hiddenAt: input?.issueHiddenAt ?? null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("persists runtime-state failure parity when a process_lost run is reaped", async () => {
    const { companyId, agentId, runId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "stale-session",
      stateJson: { foo: "bar" },
      lastRunId: randomUUID(),
      lastRunStatus: "succeeded",
      lastError: null,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();

    const runtimeState = await heartbeat.getRuntimeState(agentId);
    expect(runtimeState).not.toBeNull();
    expect(runtimeState?.lastRunId).toBe(runId);
    expect(runtimeState?.lastRunStatus).toBe("failed");
    expect(runtimeState?.lastError).toContain("Process lost -- child pid 999999999 is no longer running");
    expect(runtimeState?.sessionId).toBe("stale-session");
    expect(runtimeState?.stateJson).toEqual({ foo: "bar" });
  });

  it("reaps an in-memory active run that never records adapter child process metadata", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    let executeCalled = false;
    const stalledAdapter: ServerAdapterModule = {
      type: "stall_no_spawn",
      models: [{ id: "stall", label: "Stall" }],
      supportsLocalAgentJwt: false,
      testEnvironment: async () => ({
        adapterType: "stall_no_spawn",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      execute: async () => {
        executeCalled = true;
        await new Promise(() => {});
        throw new Error("unreachable");
      },
    };
    registerServerAdapter(stalledAdapter);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Spawnless",
      role: "engineer",
      status: "idle",
      adapterType: "stall_no_spawn",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "spawnless_test",
    });
    expect(run).not.toBeNull();

    const deadline = Date.now() + 2_000;
    while (!executeCalled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(executeCalled).toBe(true);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([run?.id]);

    const failedRun = await heartbeat.getRun(run?.id ?? "");
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("before an adapter child process was recorded");
    expect(failedRun?.processPid).toBeNull();

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run?.id ?? ""));
    expect(events.some((row) => row.message?.includes("before an adapter child process was recorded"))).toBe(true);
    expect(events.some((row) => (row.payload as Record<string, unknown> | null)?.stalePreSpawnActiveRun === true)).toBe(true);
  });

  it("automatically fails and ledgers a claimed run that never records adapter child process metadata", async () => {
    const previousWatchdogTimeout = process.env.PAPERCLIP_HEARTBEAT_PRE_SPAWN_TIMEOUT_MS;
    process.env.PAPERCLIP_HEARTBEAT_PRE_SPAWN_TIMEOUT_MS = "25";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    let executeCalled = false;
    const stalledAdapter: ServerAdapterModule = {
      type: "stall_no_spawn",
      models: [{ id: "stall", label: "Stall" }],
      supportsLocalAgentJwt: false,
      testEnvironment: async () => ({
        adapterType: "stall_no_spawn",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      execute: async () => {
        executeCalled = true;
        await new Promise(() => {});
        throw new Error("unreachable");
      },
    };
    registerServerAdapter(stalledAdapter);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Watchdog",
        role: "engineer",
        status: "idle",
        adapterType: "stall_no_spawn",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "spawn_watchdog_test",
      });
      expect(run).not.toBeNull();

      const deadline = Date.now() + 2_000;
      let failedRun = await heartbeat.getRun(run?.id ?? "");
      while (failedRun?.status !== "failed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        failedRun = await heartbeat.getRun(run?.id ?? "");
      }

      expect(executeCalled).toBe(true);
      expect(failedRun?.status).toBe("failed");
      expect(failedRun?.errorCode).toBe("process_lost");
      expect(failedRun?.error).toContain("pre-spawn watchdog");
      expect(failedRun?.error).toContain("before an adapter child process was recorded");

      const ledger = await db
        .select()
        .from(contextLedgerEntries)
        .where(eq(contextLedgerEntries.runId, run?.id ?? ""));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.promptClass).toBe("failure_recovery");
      expect(ledger[0]?.finalOutcome).toBe("failed");
      expect(ledger[0]?.finalBlocker).toContain("pre-spawn watchdog");
      expect(ledger[0]?.estimatedPromptTokens).toBeGreaterThan(0);

      const components = await db
        .select()
        .from(contextLedgerComponents)
        .where(eq(contextLedgerComponents.entryId, ledger[0]?.id ?? ""));
      expect(components.some((row) => row.name === "pre_spawn_watchdog")).toBe(true);

      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run?.id ?? ""));
      expect(events.some((row) => (row.payload as Record<string, unknown> | null)?.preSpawnWatchdogTimeoutMs === 25)).toBe(true);
    } finally {
      if (previousWatchdogTimeout == null) {
        delete process.env.PAPERCLIP_HEARTBEAT_PRE_SPAWN_TIMEOUT_MS;
      } else {
        process.env.PAPERCLIP_HEARTBEAT_PRE_SPAWN_TIMEOUT_MS = previousWatchdogTimeout;
      }
    }
  });

  it("bounds provider preflight hangs before adapter spawn", async () => {
    const originalAdapter = getServerAdapter("opencode_local");
    const hangingAdapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "opencode_local",
      testEnvironment: async () => {
        await new Promise(() => {});
        throw new Error("unreachable");
      },
    };
    registerServerAdapter(hangingAdapter);

    try {
      const startedAt = Date.now();
      const result = await evaluateProviderReliabilityPreflight({
        companyId: randomUUID(),
        adapterType: "opencode_local",
        adapterConfig: {
          provider: "opencode-zen",
          model: "deepseek-v4-flash-free",
        },
        selectedLane: "opencode_local",
        timeoutMs: 25,
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toMatchObject({
        status: "degraded",
        source: "adapter_environment_timeout",
        reason: "provider_preflight_timeout",
        failureKind: "provider_preflight_timeout",
        target: {
          adapterType: "opencode_local",
          lane: "opencode_local",
          provider: "opencode-zen",
          model: "deepseek-v4-flash-free",
        },
      });
      expect(result.detail).toContain("timed out");
    } finally {
      registerServerAdapter(originalAdapter);
    }
  });

  it("does not misclassify unrelated multiline doctor auth warnings as OpenRouter failures", async () => {
    const originalAdapter = getServerAdapter("hermes_local");
    const adapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "hermes_local",
      testEnvironment: async () => ({
        adapterType: "hermes_local",
        status: "warn",
        checks: [
          {
            code: "doctor",
            level: "warn",
            message: "Hermes doctor passed with optional warnings.",
            detail: [
              "Auth Providers",
              "OpenAI Codex auth (not logged in)",
              "Codex token refresh failed with status 401.",
              "API Connectivity",
              "Checking OpenRouter API...",
              "OpenRouter API OK",
            ].join("\n"),
          },
        ],
      }),
    };
    registerServerAdapter(adapter);

    try {
      const result = await evaluateProviderReliabilityPreflight({
        companyId: randomUUID(),
        adapterType: "hermes_local",
        adapterConfig: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
        },
        selectedLane: "hermes_openrouter",
        timeoutMs: 25,
      });

      expect(result.status).toBe("healthy");
      expect(result.reason).toBeNull();
      expect(result.target).toMatchObject({
        adapterType: "hermes_local",
        lane: "hermes_openrouter",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      });
    } finally {
      registerServerAdapter(originalAdapter);
    }
  });

  it("marks Gemini quota warnings degraded before adapter spawn", async () => {
    const originalAdapter = getServerAdapter("gemini_local");
    const adapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "gemini_local",
      testEnvironment: async () => ({
        adapterType: "gemini_local",
        status: "warn",
        checks: [
          {
            code: "gemini_command_resolvable",
            level: "info",
            message: "Command is executable: gemini",
          },
          {
            code: "gemini_hello_probe_quota_exhausted",
            level: "warn",
            message:
              "Gemini CLI authentication is configured, but the current account or API key is over quota.",
            hint:
              "The configured Gemini account or API key is over quota. Check ai.google.dev usage/billing, then retry the probe.",
          },
        ],
      }),
    };
    registerServerAdapter(adapter);

    try {
      const result = await evaluateProviderReliabilityPreflight({
        companyId: randomUUID(),
        adapterType: "gemini_local",
        adapterConfig: {
          model: "gemini-2.5-flash",
        },
        selectedLane: "gemini_local",
        timeoutMs: 25,
      });

      expect(result.status).toBe("degraded");
      expect(result.reason).toBe("provider_quota_failure");
      expect(result.failureKind).toBe("provider_quota");
      expect(result.target).toMatchObject({
        adapterType: "gemini_local",
        lane: "gemini_local",
        provider: "google",
        model: "gemini-2.5-flash",
      });
    } finally {
      registerServerAdapter(originalAdapter);
    }
  });

  it("derives token and cost deltas from cumulative Hermes state usage totals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cumulativeTotals = [
      { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, costUsd: 0.05 },
      { inputTokens: 175, cachedInputTokens: 70, outputTokens: 25, costUsd: 0.08 },
    ];
    let executeCount = 0;
    const adapter: ServerAdapterModule = {
      type: "hermes_usage_test",
      models: [{ id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      supportsLocalAgentJwt: false,
      testEnvironment: async () => ({
        adapterType: "hermes_usage_test",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      execute: async () => {
        const totals = cumulativeTotals[Math.min(executeCount, cumulativeTotals.length - 1)]!;
        executeCount += 1;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "hermes-session-usage",
          sessionParams: { sessionId: "hermes-session-usage" },
          sessionDisplayId: "hermes-session-usage",
          provider: "openrouter",
          biller: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          billingType: "metered_api",
          costUsd: totals.costUsd,
          usage: {
            inputTokens: totals.inputTokens,
            cachedInputTokens: totals.cachedInputTokens,
            outputTokens: totals.outputTokens,
          },
          resultJson: {
            adapterType: "hermes_usage_test",
            usage: { source: "hermes_state_db", costStatus: "estimated" },
          },
          summary: "done",
        };
      },
    };
    registerServerAdapter(adapter);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "HermesUsage",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_usage_test",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const heartbeat = heartbeatService(db);
      const waitForFinished = async (runId: string) => {
        const deadline = Date.now() + 2_000;
        let run = await heartbeat.getRun(runId);
        while (run?.status === "queued" || run?.status === "running") {
          if (Date.now() >= deadline) throw new Error(`run ${runId} did not finish`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          run = await heartbeat.getRun(runId);
        }
        return run;
      };

      const first = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "usage_delta_first",
      });
      expect(first).not.toBeNull();
      const firstRun = await waitForFinished(first!.id);
      expect(firstRun?.status).toBe("succeeded");

      const second = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "usage_delta_second",
      });
      expect(second).not.toBeNull();
      const secondRun = await waitForFinished(second!.id);
      expect(secondRun?.status).toBe("succeeded");

      const refreshedSecond = await heartbeat.getRun(second!.id);
      const usageJson = refreshedSecond?.usageJson as Record<string, unknown>;
      expect(usageJson).toMatchObject({
        inputTokens: 75,
        cachedInputTokens: 30,
        outputTokens: 15,
        rawInputTokens: 175,
        rawCachedInputTokens: 70,
        rawOutputTokens: 25,
        usageSource: "session_delta",
        costUsageSource: "session_delta",
        provider: "openrouter",
        biller: "openrouter",
        billingType: "metered_api",
        usageConfidence: "actual",
        costConfidence: "estimated",
        usageAccountingMode: "booked",
        costAccountingMode: "booked",
      });
      expect(Number(usageJson.rawCostUsd)).toBeCloseTo(0.08, 6);
      expect(Number(usageJson.costUsd)).toBeCloseTo(0.03, 6);

      const costs = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.agentId, agentId));
      expect(costs).toHaveLength(2);
      const firstCost = costs.find((row) => row.heartbeatRunId === first!.id);
      const secondCost = costs.find((row) => row.heartbeatRunId === second!.id);
      expect(firstCost).toMatchObject({
        provider: "openrouter",
        biller: "openrouter",
        billingType: "metered_api",
        model: "deepseek/deepseek-v4-flash",
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
        costCents: 5,
      });
      expect(secondCost).toMatchObject({
        provider: "openrouter",
        biller: "openrouter",
        billingType: "metered_api",
        model: "deepseek/deepseek-v4-flash",
        inputTokens: 75,
        cachedInputTokens: 30,
        outputTokens: 15,
        costCents: 3,
      });
    } finally {
      unregisterServerAdapter("hermes_usage_test");
    }
  });

  it("keeps pending OpenCode Hermes usage out of runtime totals and cost events", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const adapter: ServerAdapterModule = {
      type: "hermes_opencode_pending_test",
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      supportsLocalAgentJwt: false,
      testEnvironment: async () => ({
        adapterType: "hermes_opencode_pending_test",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "opencode-pending-session",
        sessionParams: { sessionId: "opencode-pending-session" },
        sessionDisplayId: "opencode-pending-session",
        provider: "opencode-go",
        biller: "opencode-go",
        model: "deepseek-v4-flash",
        billingType: "unknown",
        usageConfidence: "pending",
        costConfidence: "pending",
        costUsd: 0.75,
        usage: {
          inputTokens: 283_619,
          cachedInputTokens: 159_689,
          outputTokens: 93_003,
        },
        resultJson: {
          adapterType: "hermes_opencode_pending_test",
          usage: {
            source: "hermes_state_db",
            usageConfidence: "pending",
            costConfidence: "pending",
          },
        },
        summary: "done",
      }),
    };
    registerServerAdapter(adapter);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "OpenCodePending",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_opencode_pending_test",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "pending_opencode_usage",
      });
      expect(run).not.toBeNull();

      const deadline = Date.now() + 2_000;
      let finished = await heartbeat.getRun(run!.id);
      while (finished?.status === "queued" || finished?.status === "running") {
        if (Date.now() >= deadline) throw new Error(`run ${run!.id} did not finish`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        finished = await heartbeat.getRun(run!.id);
      }
      expect(finished?.status).toBe("succeeded");

      const usageJson = finished?.usageJson as Record<string, unknown>;
      expect(usageJson.inputTokens).toBeUndefined();
      expect(usageJson.costUsd).toBeUndefined();
      expect(usageJson).toMatchObject({
        observedInputTokens: 283_619,
        observedCachedInputTokens: 159_689,
        observedOutputTokens: 93_003,
        rawInputTokens: 283_619,
        rawCachedInputTokens: 159_689,
        rawOutputTokens: 93_003,
        observedCostUsd: 0.75,
        provider: "opencode-go",
        biller: "opencode-go",
        billingType: "unknown",
        usageConfidence: "pending",
        costConfidence: "pending",
        usageAccountingMode: "telemetry_only",
        costAccountingMode: "telemetry_only",
      });

      const costs = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.agentId, agentId));
      expect(costs).toHaveLength(0);

      const runtime = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(Number(runtime?.totalInputTokens ?? 0)).toBe(0);
      expect(Number(runtime?.totalCachedInputTokens ?? 0)).toBe(0);
      expect(Number(runtime?.totalOutputTokens ?? 0)).toBe(0);
      expect(Number(runtime?.totalCostCents ?? 0)).toBe(0);
    } finally {
      unregisterServerAdapter("hermes_opencode_pending_test");
    }
  });

  it("books usage from Codex, Claude Code, and Gemini CLI adapters", async () => {
    const cases = [
      { adapterType: "codex_local", provider: "openai", biller: "openai", model: "gpt-5.3-codex" },
      { adapterType: "claude_local", provider: "anthropic", biller: "anthropic", model: "claude-opus-4.6" },
      { adapterType: "gemini_local", provider: "google", biller: "google", model: "gemini-3-pro" },
    ];
    const originals = new Map<string, ServerAdapterModule>();

    try {
      for (const entry of cases) {
        const original = getServerAdapter(entry.adapterType);
        originals.set(entry.adapterType, original);
        registerServerAdapter({
          ...original,
          testEnvironment: async () => ({
            adapterType: entry.adapterType,
            status: "pass",
            checks: [],
            testedAt: new Date().toISOString(),
          }),
          execute: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: `${entry.adapterType}-session`,
            sessionParams: { sessionId: `${entry.adapterType}-session` },
            sessionDisplayId: `${entry.adapterType}-session`,
            provider: entry.provider,
            biller: entry.biller,
            model: entry.model,
            billingType: "metered_api",
            costUsd: 0.02,
            usage: {
              inputTokens: 20,
              cachedInputTokens: 7,
              outputTokens: 5,
            },
            resultJson: { adapterType: entry.adapterType, summary: "done" },
            summary: "done",
          }),
        });

        const companyId = randomUUID();
        const agentId = randomUUID();
        const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
        await db.insert(companies).values({
          id: companyId,
          name: "Paperclip",
          issuePrefix,
          requireBoardApprovalForNewAgents: false,
        });
        await db.insert(agents).values({
          id: agentId,
          companyId,
          name: `${entry.adapterType}Agent`,
          role: "engineer",
          status: "idle",
          adapterType: entry.adapterType,
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });

        const heartbeat = heartbeatService(db);
        const run = await heartbeat.wakeup(agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: `${entry.adapterType}_usage`,
        });
        expect(run).not.toBeNull();

        const deadline = Date.now() + 2_000;
        let finished = await heartbeat.getRun(run!.id);
        while (finished?.status === "queued" || finished?.status === "running") {
          if (Date.now() >= deadline) throw new Error(`run ${run!.id} did not finish`);
          await new Promise((resolve) => setTimeout(resolve, 25));
          finished = await heartbeat.getRun(run!.id);
        }
        expect(finished?.status).toBe("succeeded");

        const usageJson = finished?.usageJson as Record<string, unknown>;
        expect(usageJson).toMatchObject({
          inputTokens: 20,
          cachedInputTokens: 7,
          outputTokens: 5,
          rawInputTokens: 20,
          rawCachedInputTokens: 7,
          rawOutputTokens: 5,
          provider: entry.provider,
          biller: entry.biller,
          model: entry.model,
          billingType: "metered_api",
          costUsd: 0.02,
          usageConfidence: "actual",
          costConfidence: "actual",
          usageAccountingMode: "booked",
          costAccountingMode: "booked",
        });

        let costs = await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.agentId, agentId));
        await waitForCondition(async () => {
          costs = await db
            .select()
            .from(costEvents)
            .where(eq(costEvents.agentId, agentId));
          return costs.length === 1;
        });
        expect(costs).toHaveLength(1);
        expect(costs[0]).toMatchObject({
          provider: entry.provider,
          biller: entry.biller,
          billingType: "metered_api",
          model: entry.model,
          inputTokens: 20,
          cachedInputTokens: 7,
          outputTokens: 5,
          costCents: 2,
        });

        let runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null);
        await waitForCondition(async () => {
          runtime = await db
            .select()
            .from(agentRuntimeState)
            .where(eq(agentRuntimeState.agentId, agentId))
            .then((rows) => rows[0] ?? null);
          return Number(runtime?.totalInputTokens ?? 0) === 20;
        });
        expect(Number(runtime?.totalInputTokens ?? 0)).toBe(20);
        expect(Number(runtime?.totalCachedInputTokens ?? 0)).toBe(7);
        expect(Number(runtime?.totalOutputTokens ?? 0)).toBe(5);
        expect(Number(runtime?.totalCostCents ?? 0)).toBe(2);
      }
    } finally {
      for (const [adapterType, original] of originals) {
        registerServerAdapter(original);
      }
    }
  });

  it("normalizes stale Codex subscription model aliases before provider preflight", async () => {
    const originalAdapter = getServerAdapter("codex_local");
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    let capturedModel: unknown = null;
    const adapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "codex_local",
      testEnvironment: async (ctx) => {
        capturedModel = (ctx.config as Record<string, unknown>).model;
        return {
          adapterType: "codex_local",
          status: "pass",
          checks: [
            {
              code: "codex_hello_probe_passed",
              level: "info",
              message: "Codex hello probe succeeded.",
            },
          ],
        };
      },
    };
    registerServerAdapter(adapter);
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await evaluateProviderReliabilityPreflight({
        companyId: randomUUID(),
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.3-codex",
          env: {},
        },
        selectedLane: "codex_local",
        timeoutMs: 25,
      });

      expect(result.status).toBe("healthy");
      expect(result.target).toMatchObject({
        adapterType: "codex_local",
        lane: "codex_local",
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(capturedModel).toBe("gpt-5.4");
    } finally {
      registerServerAdapter(originalAdapter);
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  });

  it("normalizes incompatible Codex subscription model ids before provider preflight", async () => {
    const originalAdapter = getServerAdapter("codex_local");
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    let capturedConfig: Record<string, unknown> | null = null;
    const adapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "codex_local",
      testEnvironment: async (ctx) => {
        capturedConfig = ctx.config as Record<string, unknown>;
        return {
          adapterType: "codex_local",
          status: "pass",
          checks: [
            {
              code: "codex_hello_probe_passed",
              level: "info",
              message: "Codex hello probe succeeded.",
            },
          ],
        };
      },
    };
    registerServerAdapter(adapter);
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await evaluateProviderReliabilityPreflight({
        companyId: randomUUID(),
        adapterType: "codex_local",
        adapterConfig: {
          model: "deepseek-v4-flash",
          provider: "opencode-go",
          env: {},
        },
        selectedLane: "codex_local",
        timeoutMs: 25,
      });

      expect(result.status).toBe("healthy");
      expect(result.target).toMatchObject({
        adapterType: "codex_local",
        lane: "codex_local",
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(capturedConfig).toMatchObject({
        model: "gpt-5.4",
        provider: "opencode-go",
      });
    } finally {
      registerServerAdapter(originalAdapter);
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  });

  it("does not reuse provider preflight cwd validation across different working directories", async () => {
    const originalAdapter = getServerAdapter("codex_local");
    const companyId = randomUUID();
    const capturedCwds: unknown[] = [];
    const adapter: ServerAdapterModule = {
      ...originalAdapter,
      type: "codex_local",
      testEnvironment: async (ctx) => {
        const cwd = (ctx.config as Record<string, unknown>).cwd;
        capturedCwds.push(cwd);
        return {
          adapterType: "codex_local",
          status: "pass",
          checks: [
            {
              code: "codex_cwd_valid",
              level: "info",
              message: `Working directory is valid: ${cwd}`,
            },
          ],
        };
      },
    };
    registerServerAdapter(adapter);

    try {
      const first = await evaluateProviderReliabilityPreflight({
        companyId,
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          cwd: "/Users/mnm/Documents/Github/paperclip",
        },
        selectedLane: "codex_local",
        timeoutMs: 25,
      });
      const second = await evaluateProviderReliabilityPreflight({
        companyId,
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          cwd: "/Users/mnm/Documents/Github/gstack",
        },
        selectedLane: "codex_local",
        timeoutMs: 25,
      });

      expect(first.status).toBe("healthy");
      expect(second.status).toBe("healthy");
      expect(capturedCwds).toEqual([
        "/Users/mnm/Documents/Github/paperclip",
        "/Users/mnm/Documents/Github/gstack",
      ]);
      expect(first.detail).toContain("Documents/Github/paperclip");
      expect(second.detail).toContain("Documents/Github/gstack");
    } finally {
      registerServerAdapter(originalAdapter);
    }
  });

  it("does not queue an automatic retry for shared project-primary workspaces", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      contextSnapshot: {
        paperclipWorkspace: {
          mode: "shared_workspace",
          source: "project_primary",
          cwd: "/tmp/portfolio-os",
        },
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorCode).toBe("process_lost");
    expect(runs[0]?.error).toContain(
      "automatic retry skipped because run used shared project-primary workspace and may have left partial mutations",
    );

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(
      events.some((row) =>
        row.message?.includes(
          "automatic retry skipped because run used shared project-primary workspace and may have left partial mutations",
        ),
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not queue a retry when the referenced issue is already cancelled", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      issueStatus: "cancelled",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("reuses an existing queued process-loss retry instead of creating a duplicate", async () => {
    const { agentId, runId, wakeupRequestId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const existingWakeupRequestId = randomUUID();
    const existingRetryRunId = randomUUID();
    const now = new Date("2026-03-19T00:05:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: existingWakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "process_lost_retry",
      payload: {
        issueId,
        retryOfRunId: runId,
      },
      status: "queued",
      runId: existingRetryRunId,
      requestedByActorType: "system",
      requestedByActorId: null,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: existingRetryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        retryOfRunId: runId,
        wakeReason: "process_lost_retry",
        retryReason: "process_lost",
      },
      retryOfRunId: runId,
      processLossRetryCount: 1,
      updatedAt: now,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id === existingRetryRunId);
    expect(failedRun?.status).toBe("failed");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
    expect(wakeups.some((row) => row.id === wakeupRequestId)).toBe(true);
    expect(wakeups.some((row) => row.id === existingWakeupRequestId)).toBe(true);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(existingRetryRunId);
  });

  it("cancels queued work for closed issues before execution resumes", async () => {
    const { runId, wakeupRequestId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      runStatus: "queued",
      processPid: null,
      issueStatus: "cancelled",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("cancels duplicate queued routine executions before lazy lock conflicts", async () => {
    const companyId = randomUUID();
    const activeAgentId = randomUUID();
    const queuedAgentId = randomUUID();
    const activeRunId = randomUUID();
    const queuedRunId = randomUUID();
    const activeWakeupRequestId = randomUUID();
    const queuedWakeupRequestId = randomUUID();
    const activeIssueId = randomUUID();
    const queuedIssueId = randomUUID();
    const routineId = randomUUID();
    const now = new Date("2026-03-19T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "DUP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: activeAgentId,
        companyId,
        name: "Active Runner",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: queuedAgentId,
        companyId,
        name: "Queued Runner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: activeWakeupRequestId,
        companyId,
        agentId: activeAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "routine",
        payload: { issueId: activeIssueId },
        status: "claimed",
        runId: activeRunId,
        claimedAt: now,
      },
      {
        id: queuedWakeupRequestId,
        companyId,
        agentId: queuedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "routine",
        payload: { issueId: queuedIssueId },
        status: "queued",
        runId: queuedRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: activeRunId,
        companyId,
        agentId: activeAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId: activeWakeupRequestId,
        contextSnapshot: { issueId: activeIssueId },
        startedAt: now,
        updatedAt: now,
      },
      {
        id: queuedRunId,
        companyId,
        agentId: queuedAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: queuedWakeupRequestId,
        contextSnapshot: { issueId: queuedIssueId },
        updatedAt: now,
      },
    ]);
    await db.insert(issues).values([
      {
        id: activeIssueId,
        companyId,
        title: "Active routine execution",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: activeAgentId,
        executionRunId: activeRunId,
        originKind: "routine_execution",
        originId: routineId,
        issueNumber: 1,
        identifier: "DUP-1",
      },
      {
        id: queuedIssueId,
        companyId,
        title: "Duplicate routine execution",
        status: "todo",
        priority: "medium",
        assigneeAgentId: queuedAgentId,
        originKind: "routine_execution",
        originId: routineId,
        issueNumber: 2,
        identifier: "DUP-2",
      },
    ]);
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(queuedRunId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");
    expect(run?.error).toContain("another routine execution is already active");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queuedWakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, queuedIssueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not strand a claimed routine run when the lazy issue lock hits the unique constraint", async () => {
    const companyId = randomUUID();
    const existingAgentId = randomUUID();
    const queuedAgentId = randomUUID();
    const existingRunId = randomUUID();
    const queuedRunId = randomUUID();
    const queuedWakeupRequestId = randomUUID();
    const existingIssueId = randomUUID();
    const queuedIssueId = randomUUID();
    const routineId = randomUUID();
    const now = new Date("2026-03-19T01:10:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "DUPL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: existingAgentId,
        companyId,
        name: "Existing Runner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: queuedAgentId,
        companyId,
        name: "Queued Runner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupRequestId,
      companyId,
      agentId: queuedAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "routine",
      payload: { issueId: queuedIssueId },
      status: "queued",
      runId: queuedRunId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: existingRunId,
        companyId,
        agentId: existingAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId: existingIssueId },
        startedAt: now,
        finishedAt: now,
        updatedAt: now,
      },
      {
        id: queuedRunId,
        companyId,
        agentId: queuedAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: queuedWakeupRequestId,
        contextSnapshot: { issueId: queuedIssueId },
        updatedAt: now,
      },
    ]);
    await db.insert(issues).values([
      {
        id: existingIssueId,
        companyId,
        title: "Existing routine execution lock",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: existingAgentId,
        executionRunId: existingRunId,
        originKind: "routine_execution",
        originId: routineId,
        issueNumber: 1,
        identifier: "DUPL-1",
      },
      {
        id: queuedIssueId,
        companyId,
        title: "Queued routine execution",
        status: "todo",
        priority: "medium",
        assigneeAgentId: queuedAgentId,
        originKind: "routine_execution",
        originId: routineId,
        issueNumber: 2,
        identifier: "DUPL-2",
      },
    ]);
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(queuedRunId);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("routine_execution_conflict");
    expect(run?.error).toContain("another routine execution is already active");
    expect(run?.processPid).toBeNull();
    expect(run?.finishedAt).not.toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queuedWakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, queuedIssueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, queuedAgentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("idle");
  });

  it("clears stale run markers when resetting the full runtime session", async () => {
    const { companyId, agentId, runId } = await seedRunFixture({
      includeIssue: false,
      runStatus: "failed",
      runErrorCode: "process_lost",
      runError: "Process lost -- server may have restarted",
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "stale-session",
      stateJson: { cwd: "/tmp/worktree" },
      lastRunId: runId,
      lastRunStatus: "succeeded",
      lastError: null,
    });
    const heartbeat = heartbeatService(db);

    const runtimeState = await heartbeat.resetRuntimeSession(agentId);

    expect(runtimeState).not.toBeNull();
    expect(runtimeState?.sessionId).toBeNull();
    expect(runtimeState?.stateJson).toEqual({});
    expect(runtimeState?.lastRunId).toBeNull();
    expect(runtimeState?.lastRunStatus).toBeNull();
    expect(runtimeState?.lastError).toBeNull();
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(mockTelemetryClient, {
      agentRole: "engineer",
    });
  });
});
