import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  instanceSettings,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { routineService } from "../services/routines.ts";
import {
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_SECRET_NAME,
  HOSTINGER_API_KEY_FILE_SECRET_NAME,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
} from "../services/deployment-target-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type RoutineServiceDeps = NonNullable<Parameters<typeof routineService>[1]>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  function actionabilityDescription(contract: Record<string, unknown>) {
    return [
      "Routine actionability contract.",
      "",
      "## Portfolio Dispatch Contract",
      "```json",
      JSON.stringify({ paperclip_actionability: contract }, null, 2),
      "```",
    ].join("\n");
  }

  function providerPreflightResult(status: "healthy" | "degraded") {
    const now = new Date().toISOString();
    return {
      status,
      source: "adapter_environment_test",
      target: {
        adapterType: "hermes_local",
        lane: "hermes_minimax",
        provider: "minimax",
        model: "MiniMax-M3",
        cacheKey: "hermes_local:hermes_minimax:minimax:MiniMax-M3",
      },
      testedAt: now,
      expiresAt: now,
      reason: status === "healthy" ? null : "provider_quota_failure",
      failureKind: status === "healthy" ? null : "provider_quota",
      detail: status === "healthy" ? null : "MiniMax quota exhausted",
    } satisfies Awaited<ReturnType<NonNullable<RoutineServiceDeps["providerPreflight"]>>>;
  }

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
    providerPreflight?: RoutineServiceDeps["providerPreflight"];
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
      providerPreflight: opts?.providerPreflight,
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("coalesces an unattended routine run into an open idle issue without waking the assignee", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);
    expect(wakeups).toHaveLength(0);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("supersedes stale unattended idle routine issues and creates replacement work", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const previousRunId = randomUUID();
    const staleAt = new Date("2026-03-20T12:00:00.000Z");
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db
      .update(issues)
      .set({ createdAt: staleAt, updatedAt: staleAt })
      .where(eq(issues.id, previousIssue.id));

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: staleAt,
      linkedIssueId: previousIssue.id,
      completedAt: staleAt,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);
    expect(wakeups).toHaveLength(1);

    const staleIssue = await db
      .select({
        status: issues.status,
        cancelledAt: issues.cancelledAt,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(staleIssue?.status).toBe("cancelled");
    expect(staleIssue?.cancelledAt).toBeInstanceOf(Date);
    expect(staleIssue?.executionState?.paperclipRoutineSupersession).toMatchObject({
      status: "superseded",
      reason: "stale_unattended_idle_routine_issue",
      replacementRoutineRunId: run.id,
      previousOriginRunId: previousRunId,
      routineId: routine.id,
    });

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, previousIssue.id));
    expect(comments.map((comment) => comment.body).join("\n")).toContain("superseded this stale idle routine issue");

    const routineIssues = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.originId, routine.id));
    expect(routineIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: previousIssue.id, status: "cancelled" }),
      expect.objectContaining({ id: run.linkedIssueId, status: "todo" }),
    ]));
  });

  it("reports scheduled coalesced routine runs separately from enqueued work", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "blocked",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "every minute",
      cronExpression: "* * * * *",
      timezone: "UTC",
    }, {});
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date("2026-03-20T12:01:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));

    const result = await svc.tickScheduledTriggers(new Date("2026-03-20T12:01:30.000Z"));

    expect(result).toMatchObject({
      checked: 1,
      due: 1,
      triggered: 1,
      enqueued: 0,
      coalesced: 1,
      skipped: 0,
      failed: 0,
      byStatus: {
        coalesced: 1,
      },
    });
    expect(result.examples).toEqual([
      expect.objectContaining({
        routineId: routine.id,
        routineTitle: routine.title,
        status: "coalesced",
        linkedIssueId: previousIssue.id,
        coalescedIntoRunId: previousRunId,
      }),
    ]);
    expect(wakeups).toHaveLength(0);
  });

  it("claims due schedule triggers stored with Postgres microsecond precision", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "every minute",
      cronExpression: "* * * * *",
      timezone: "UTC",
    }, {});
    await db.$client.unsafe(
      "update routine_triggers set next_run_at = timestamptz '2026-03-20T12:01:00.123456Z' where id = $1",
      [trigger.id],
    );

    const beforeTick = Date.now();
    const result = await svc.tickScheduledTriggers(new Date("2026-03-20T12:01:30.000Z"));

    expect(result).toMatchObject({
      checked: 1,
      due: 1,
      triggered: 1,
      enqueued: 1,
      coalesced: 0,
      skipped: 0,
      failed: 0,
      byStatus: {
        issue_created: 1,
      },
    });
    const [storedTrigger] = await db
      .select({
        lastFiredAt: routineTriggers.lastFiredAt,
        nextRunAt: routineTriggers.nextRunAt,
      })
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id));
    expect(storedTrigger?.lastFiredAt?.getTime()).toBeGreaterThanOrEqual(beforeTick);
    expect(storedTrigger?.nextRunAt?.getTime()).toBeGreaterThanOrEqual(beforeTick);
    expect(wakeups).toHaveLength(1);
  });

  it("reuses a scheduled logical key and records a second key as non-executable coalescing ingress", async () => {
    const { companyId, routine, svc, wakeups } = await seedFixture();
    const firstInputHash = "a".repeat(64);
    const secondInputHash = "b".repeat(64);
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "portfolio stage",
      cronExpression: "* * * * *",
      timezone: "UTC",
      scheduleIdentity: {
        portfolioRunId: "portfolio-scheduler-canary",
        stage: "primary_research",
        inputHash: firstInputHash,
      },
    }, {});
    const dueAt = new Date("2026-03-20T12:01:00.000Z");
    const tickAt = new Date("2026-03-20T12:01:30.000Z");
    await db.update(routineTriggers).set({ nextRunAt: dueAt }).where(eq(routineTriggers.id, trigger.id));

    const initial = await svc.tickScheduledTriggers(tickAt);
    expect(initial).toMatchObject({ enqueued: 1, coalesced: 0, triggered: 1 });
    const [firstRun] = await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id));
    expect(firstRun).toBeDefined();
    expect(firstRun?.triggerPayload?.schedule_identity).toMatchObject({
      schema_version: "paperclip.routine_schedule_identity.v1",
      company_id: companyId,
      portfolio_run_id: "portfolio-scheduler-canary",
      stage: "primary_research",
      input_hash: firstInputHash,
    });
    expect(wakeups).toHaveLength(1);
    const activityAfterInitial = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.entityId, firstRun!.id));
    expect(activityAfterInitial).toHaveLength(1);

    await db.update(routineTriggers).set({ nextRunAt: dueAt }).where(eq(routineTriggers.id, trigger.id));
    const replay = await svc.tickScheduledTriggers(tickAt);
    expect(replay).toMatchObject({ triggered: 1, reused: 1, enqueued: 0, coalesced: 0 });
    expect(replay.examples[0]).toMatchObject({ runId: firstRun!.id, status: "reused" });
    const afterReplay = await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id));
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]?.id).toBe(firstRun?.id);
    expect(wakeups).toHaveLength(1);
    const activityAfterReplay = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.entityId, firstRun!.id));
    expect(activityAfterReplay).toEqual(activityAfterInitial);

    const { trigger: duplicateTrigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "duplicate logical portfolio stage",
      cronExpression: "* * * * *",
      timezone: "UTC",
      scheduleIdentity: {
        portfolioRunId: "portfolio-scheduler-canary",
        stage: "primary_research",
        inputHash: firstInputHash,
      },
    }, {});
    await db
      .update(routineTriggers)
      .set({ nextRunAt: dueAt })
      .where(eq(routineTriggers.id, duplicateTrigger.id));
    const crossTriggerReplay = await svc.tickScheduledTriggers(tickAt);
    expect(crossTriggerReplay).toMatchObject({ triggered: 1, reused: 1, enqueued: 0, coalesced: 0 });
    expect(crossTriggerReplay.examples[0]).toMatchObject({ runId: firstRun!.id, status: "reused" });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id))).toHaveLength(1);
    expect(wakeups).toHaveLength(1);

    await svc.updateTrigger(trigger.id, {
      scheduleIdentity: {
        portfolioRunId: "portfolio-scheduler-canary",
        stage: "primary_research",
        inputHash: secondInputHash,
      },
    }, {});
    await db.update(routineTriggers).set({ nextRunAt: dueAt }).where(eq(routineTriggers.id, trigger.id));
    const coalesced = await svc.tickScheduledTriggers(tickAt);
    expect(coalesced).toMatchObject({ triggered: 1, enqueued: 0, coalesced: 1 });

    const afterCoalescing = await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id));
    expect(afterCoalescing).toHaveLength(2);
    const coalescedRun = afterCoalescing.find((run) => run.id !== firstRun?.id);
    expect(coalescedRun).toMatchObject({
      status: "coalesced",
      linkedIssueId: firstRun?.linkedIssueId,
      coalescedIntoRunId: firstRun?.id,
    });
    const executionIssues = await db.select().from(issues).where(eq(issues.originId, routine.id));
    expect(executionIssues).toHaveLength(1);
    expect(wakeups).toHaveLength(1);

    await expect(db.insert(routineRuns).values({
      companyId,
      routineId: routine.id,
      triggerId: trigger.id,
      source: "schedule",
      status: "received",
      idempotencyKey: firstRun!.idempotencyKey,
    })).rejects.toThrow();
  });

  it("skips unattended routine dispatch when provider capacity is already blocked", async () => {
    const { agentId, companyId, routine, svc, wakeups } = await seedFixture({
      providerPreflight: async () => providerPreflightResult("degraded"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "provider_degraded_backoff",
      status: "skipped",
      error: "MiniMax quota exhausted and no approved post-MiniMax lane is available",
      finishedAt: new Date(),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("skipped");
    expect(run.failureReason).toBe("provider_capacity_blocked");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      reason: "provider_capacity_blocked",
      state: "waiting_for_provider_capacity",
      blockerOwner: "board",
      details: {
        providerCapacityRecoveryProbe: {
          status: "not_healthy",
        },
      },
    });
    expect(wakeups).toHaveLength(0);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originKind, "routine_execution"));
    expect(routineIssues).toHaveLength(0);

    const guardIssues = await db
      .select({ id: issues.id, title: issues.title, status: issues.status, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.originKind, "factory_guard"));
    expect(guardIssues).toHaveLength(1);
    expect(guardIssues[0]).toMatchObject({
      title: "Execution capacity blocked",
      status: "blocked",
      originKind: "factory_guard",
    });
  });

  it("dispatches unattended routine when the approved recovery provider preflight is healthy", async () => {
    const preflightCalls: Parameters<NonNullable<RoutineServiceDeps["providerPreflight"]>>[0][] = [];
    const { agentId, companyId, routine, svc, wakeups } = await seedFixture({
      providerPreflight: async (input) => {
        preflightCalls.push(input);
        return providerPreflightResult("healthy");
      },
    });
    await db
      .update(agents)
      .set({
        adapterType: "hermes_local",
        adapterConfig: {
          cwd: "/tmp",
          provider: "opencode-go",
          model: "deepseek-v4-flash",
          tieredExecution: {
            enabled: true,
            adapterOrder: ["hermes_minimax"],
            allowPostMiniMaxFallbacks: false,
            hermes_minimax: {
              provider: "minimax",
              model: "MiniMax-M3",
            },
          },
        },
      })
      .where(eq(agents.id, agentId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "provider_degraded_backoff",
      status: "skipped",
      error: "MiniMax DNS failed before authentication",
      finishedAt: new Date(),
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.failureReason).toBeNull();
    expect(preflightCalls[0]).toMatchObject({
      adapterType: "hermes_local",
      selectedLane: "hermes_minimax",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
      },
    });
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      providerCapacityRecoveryProbe: {
        status: "healthy",
        source: "tiered_execution_policy",
        selectedLane: "hermes_minimax",
      },
    });
    expect(wakeups).toHaveLength(1);

    const guardIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originKind, "factory_guard"));
    expect(guardIssues).toHaveLength(0);
  });

  it("materializes deterministic adapter overrides from routine actionability contracts", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "maintenance",
          state: "ready_for_agent",
          blockerClass: "dispatch_parity",
          deterministicAdapterType: "process",
          deterministicAdapterConfig: {
            command: "/bin/zsh",
            args: ["-lc", "pnpm vitest run"],
            timeoutSec: 300,
          },
        }),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "pnpm vitest run"],
        timeoutSec: 300,
      },
    });
  });

  it("materializes immutable scheduled provider-family exclusions without an adapter override", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "research",
          state: "ready_for_qa",
          blockerClass: "different_family_review",
          providerPolicyExcludedFamilies: ["opencode", "minimax"],
        }),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      providerPolicyExcludedFamilies: ["opencode", "minimax"],
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toEqual({
      providerPolicyExcludedFamilies: ["opencode", "minimax"],
    });
    expect(createdIssue?.executionState).toMatchObject({
      paperclipFactoryGuard: {
        providerPolicyExcludedFamilies: ["opencode", "minimax"],
      },
    });
  });

  it("rejects mixed deterministic and provider-family route authority", async () => {
    const { routine, svc } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "research",
          state: "ready_for_qa",
          deterministicAdapterType: "process",
          deterministicAdapterConfig: { command: "/bin/true" },
          providerPolicyExcludedFamilies: ["opencode"],
        }),
      })
      .where(eq(routines.id, routine.id));

    await expect(svc.runRoutine(routine.id, { source: "schedule" }))
      .rejects.toThrow(/cannot be combined/i);
  });

  it("defaults dispatch-poller routine contracts to the deterministic process runbook", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Reconcile this run against the immutable Portfolio OS dispatch contract.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260503T193357Z",
            routine_key: "dispatch-poller",
            dispatch_hash: "960bc8bfdf9a2f95c9323ec652410c2d54a15c04d65b6293ca06ca741cb097ae",
            selection_snapshot_hash: "733797fda64a21adb7414ac6db974c80278903013ade3d40f4fae753cb919252",
            paperclip_actionability: {
              lane: "release",
              state: "ready_for_agent",
              blockerClass: "dispatch_parity",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/dispatch-poller-runner.mjs"],
        timeoutSec: 300,
        env: {
          DISPATCH_POLLER_WRITE_DOCS: "1",
        },
      },
    });
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { cwd?: unknown } })?.adapterConfig?.cwd))
      .toContain("paperclip");
  });

  it("backfills deterministic process overrides when dispatch-poller schedules coalesce into open work", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Reconcile this run against the immutable Portfolio OS dispatch contract.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260504T004042Z",
            routine_key: "dispatch-poller",
            dispatch_hash: "505da7682d2d5834034cb08d727db0066ac86fae0e7eba6a3054708997578f25",
            paperclip_actionability: {
              lane: "release",
              state: "ready_for_agent",
              blockerClass: "dispatch_parity",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);
    expect(wakeups).toHaveLength(0);

    const updatedIssue = await db
      .select({
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/dispatch-poller-runner.mjs"],
        timeoutSec: 300,
        env: {
          DISPATCH_POLLER_WRITE_DOCS: "1",
        },
      },
    });
  });

  it("defaults run-qa-sweep routine contracts to the deterministic process runbook", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Run a QA sweep for the current Portfolio OS dispatch using gstack.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260504T004042Z",
            routine_key: "run-qa-sweep",
            source_dispatch_path: "/Users/mnm/Documents/Github/portfolio-os/data/dispatch/outbox/dispatch_20260504T004042Z.json",
            selection_snapshot_hash: "64c35c01951d104973d40e533958f89ae16d455feec0f92110ff44d4c594505b",
            paperclip_actionability: {
              lane: "qa",
              state: "ready_for_qa",
              blockerClass: "qa_gate",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/run-qa-sweep-runner.mjs"],
        timeoutSec: 1200,
        env: {
          RUN_QA_SWEEP_WRITE_DOCS: "1",
        },
      },
    });
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { cwd?: unknown } })?.adapterConfig?.cwd))
      .toContain("paperclip");
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { env?: { GSTACK_DIR?: unknown } } })?.adapterConfig?.env?.GSTACK_DIR))
      .toContain("gstack");
  });

  it("defaults evidence-backfill-reconciler routine contracts to the deterministic process runbook", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Backfill any missing evidence that still blocks this run.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260504T004042Z",
            routine_key: "evidence-backfill-reconciler",
            dispatch_hash: "505da7682d2d5834034cb08d727db0066ac86fae0e7eba6a3054708997578f25",
            selection_snapshot_hash: "64c35c01951d104973d40e533958f89ae16d455feec0f92110ff44d4c594505b",
            paperclip_actionability: {
              lane: "maintenance",
              state: "maintenance_due",
              blockerClass: "evidence_backfill",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/evidence-backfill-runner.mjs"],
        timeoutSec: 1200,
      },
    });
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { cwd?: unknown } })?.adapterConfig?.cwd))
      .toContain("paperclip");
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { env?: { PORTFOLIO_OS_DIR?: unknown } } })?.adapterConfig?.env?.PORTFOLIO_OS_DIR))
      .toContain("portfolio-os");
  });

  it("defaults release-gate-reconciler routine contracts to the deterministic process runbook", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Reconcile merge readiness, approval state, and ship discipline for this run.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260504T004042Z",
            routine_key: "release-gate-reconciler",
            dispatch_hash: "505da7682d2d5834034cb08d727db0066ac86fae0e7eba6a3054708997578f25",
            selection_snapshot_hash: "64c35c01951d104973d40e533958f89ae16d455feec0f92110ff44d4c594505b",
            target_repo_ref: "main",
            approval_id: "5d42ba8d-9e16-43fa-ae1c-cda4664babdc",
            paperclip_actionability: {
              lane: "release",
              state: "ready_for_agent",
              blockerClass: "release_gate",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/release-gate-runner.mjs"],
        timeoutSec: 3600,
        env: {
          RELEASE_GATE_WRITE_DOCS: "1",
        },
      },
    });
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { cwd?: unknown } })?.adapterConfig?.cwd))
      .toContain("paperclip");
  });

  it("infers the Skill Inventory routine contract and assigns the deterministic process runbook", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        title: "Skill Inventory :: Curate And Sync",
        description: actionabilityDescription({
          lane: "maintenance",
          state: "maintenance_due",
          blockerClass: "skill_sync",
          requireCleanWorkspace: false,
        }),
      })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      status: "passed",
      reason: "agent_actionable",
      deterministicAdapterType: "process",
    });
    expect(wakeups).toHaveLength(1);

    const createdIssue = await db
      .select({
        id: issues.id,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/skill-inventory-runner.mjs"],
        timeoutSec: 900,
        env: {
          SKILL_INVENTORY_WRITE_KEYWORDS: "1",
        },
      },
    });
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { cwd?: unknown } })?.adapterConfig?.cwd))
      .toContain("paperclip");
    expect(String((createdIssue?.assigneeAdapterOverrides as { adapterConfig?: { env?: { SKILL_INVENTORY_ROOT?: unknown } } })?.adapterConfig?.env?.SKILL_INVENTORY_ROOT))
      .toContain("portfolio-os");
  });

  it("backfills deterministic process overrides when release-gate-reconciler schedules coalesce into open work", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: [
          "Reconcile merge readiness, approval state, and ship discipline for this run.",
          "",
          "## Portfolio Dispatch Contract",
          "```json",
          JSON.stringify({
            run_id: "20260504T004042Z",
            routine_key: "release-gate-reconciler",
            dispatch_hash: "505da7682d2d5834034cb08d727db0066ac86fae0e7eba6a3054708997578f25",
            approval_id: "5d42ba8d-9e16-43fa-ae1c-cda4664babdc",
            paperclip_actionability: {
              lane: "release",
              state: "ready_for_agent",
              blockerClass: "release_gate",
              requireCleanWorkspace: false,
            },
          }, null, 2),
          "```",
        ].join("\n"),
      })
      .where(eq(routines.id, routine.id));

    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);
    expect(wakeups).toHaveLength(0);

    const updatedIssue = await db
      .select({
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/release-gate-runner.mjs"],
        timeoutSec: 3600,
        env: {
          RELEASE_GATE_WRITE_DOCS: "1",
        },
      },
    });
  });

  it("backfills deterministic process overrides when Skill Inventory schedules coalesce into open work", async () => {
    const { companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        title: "Skill Inventory :: Curate And Sync",
        description: actionabilityDescription({
          lane: "maintenance",
          state: "maintenance_due",
          blockerClass: "skill_sync",
          requireCleanWorkspace: false,
        }),
      })
      .where(eq(routines.id, routine.id));

    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: "Skill Inventory :: Curate And Sync",
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);
    expect(wakeups).toHaveLength(0);

    const updatedIssue = await db
      .select({
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(eq(issues.id, previousIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedIssue?.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "node scripts/process-runbooks/skill-inventory-runner.mjs"],
        timeoutSec: 900,
        env: {
          SKILL_INVENTORY_WRITE_KEYWORDS: "1",
        },
      },
    });
  });

  it("turns legacy Fly deploy credentials into one Hostinger operator-owned target blocker and then freezes repeated loops", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();
    const previousHostingerApiKey = process.env.HOSTINGER_API_KEY;
    const previousHostingerKeyFile = process.env.HOSTINGER_API_KEY_FILE;
    const tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-hostinger-key-"));
    const hostingerKeyFile = path.join(tempDir, "hosty.txt");
    await writeFile(hostingerKeyFile, "test-hostinger-key\n", "utf8");
    delete process.env.HOSTINGER_API_KEY;
    process.env.HOSTINGER_API_KEY_FILE = hostingerKeyFile;

    try {
      await db
        .update(routines)
        .set({
          description: actionabilityDescription({
            lane: "deploy",
            state: "ready_for_agent",
            blockerClass: "credential",
            requiredSecretNames: ["FLY_API_TOKEN"],
          }),
        })
        .where(eq(routines.id, routine.id));
      const { trigger } = await svc.createTrigger(routine.id, {
        kind: "schedule",
        label: "twice daily",
        cronExpression: "30 8,17 * * *",
        timezone: "UTC",
      }, {});
      await db
        .update(routineTriggers)
        .set({ nextRunAt: new Date("2026-03-20T08:30:00.000Z") })
        .where(eq(routineTriggers.id, trigger.id));

      const first = await svc.runRoutine(routine.id, { source: "schedule" });
      const second = await svc.runRoutine(routine.id, { source: "schedule" });
      const third = await svc.runRoutine(routine.id, { source: "schedule" });

      expect([first.status, second.status, third.status]).toEqual(["skipped", "skipped", "skipped"]);
      expect(first.failureReason).toBe("hostinger_deployment_target_missing");
      expect(third.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
        reason: "hostinger_deployment_target_missing",
        routinePaused: true,
        duplicateCount: 3,
      });
      expect(first.linkedIssueId).toBeTruthy();
      expect(second.linkedIssueId).toBe(first.linkedIssueId);
      expect(third.linkedIssueId).toBe(first.linkedIssueId);
      expect(wakeups).toHaveLength(1);

      const guardIssues = await db
        .select({ id: issues.id, title: issues.title, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.originKind, "factory_guard"));
      expect(guardIssues).toHaveLength(1);
      expect(guardIssues[0]).toMatchObject({
        title: "Hostinger deployment target blocker",
        status: "blocked",
        assigneeAgentId: agentId,
      });
      expect(guardIssues[0]?.title).not.toContain("FLY_API_TOKEN");
      expect(guardIssues[0]?.title).not.toContain(HOSTINGER_API_KEY_SECRET_NAME);

      const updatedRoutine = await db
        .select({ status: routines.status })
        .from(routines)
        .where(eq(routines.id, routine.id))
        .then((rows) => rows[0] ?? null);
      expect(updatedRoutine?.status).toBe("paused");

      const updatedTrigger = await db
        .select({
          enabled: routineTriggers.enabled,
          nextRunAt: routineTriggers.nextRunAt,
          lastResult: routineTriggers.lastResult,
        })
        .from(routineTriggers)
        .where(eq(routineTriggers.id, trigger.id))
        .then((rows) => rows[0] ?? null);
      expect(updatedTrigger).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastResult: "non_active_routine_trigger_disabled:hostinger_deployment_target_missing",
      });
    } finally {
      if (previousHostingerApiKey === undefined) delete process.env.HOSTINGER_API_KEY;
      else process.env.HOSTINGER_API_KEY = previousHostingerApiKey;
      if (previousHostingerKeyFile === undefined) delete process.env.HOSTINGER_API_KEY_FILE;
      else process.env.HOSTINGER_API_KEY_FILE = previousHostingerKeyFile;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates one assigned cleanup issue and wakes the owner for a dirty workspace", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    const repoDir = await mkdtemp(path.join(tmpdir(), "paperclip-routine-dirty-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      await writeFile(path.join(repoDir, "dirty.txt"), "uncommitted\n", "utf8");
      await db
        .update(routines)
        .set({
          description: actionabilityDescription({
            lane: "release",
            state: "ready_to_ship",
            requireCleanWorkspace: true,
            workspaceCwd: repoDir,
            upstreamArtifactHash: "dispatch-hash-a",
          }),
        })
        .where(eq(routines.id, routine.id));

      const run = await svc.runRoutine(routine.id, { source: "schedule" });

      expect(run.status).toBe("skipped");
      expect(run.failureReason).toBe("workspace_not_clean");
      expect(run.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
        reason: "workspace_not_clean",
        state: "waiting_for_clean_workspace",
        blockerClass: "workspace_cleanliness",
      });
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.opts.contextSnapshot?.source).toBe("routine.factory_guard");

      const guardIssue = await db
        .select({
          title: issues.title,
          status: issues.status,
          description: issues.description,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.originKind, "factory_guard"))
        .then((rows) => rows[0] ?? null);
      expect(guardIssue?.title).toBe("Workspace cleanup required before release lane resumes");
      expect(guardIssue?.status).toBe("blocked");
      expect(guardIssue?.description).toContain("dirty.txt");
      expect(guardIssue?.assigneeAgentId).toBe(routine.assigneeAgentId);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("records a deterministic no-wake status when an upstream artifact hash is unchanged", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "dispatch",
          state: "ready_for_agent",
          blockerClass: "dispatch_parity",
          upstreamArtifactHash: "dispatch-hash-a",
          requireUpstreamChange: true,
        }),
      })
      .where(eq(routines.id, routine.id));

    const first = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(first.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, first.linkedIssueId!));

    const second = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(second.status).toBe("skipped");
    expect(second.failureReason).toBe("upstream_artifact_unchanged");
    expect(second.linkedIssueId).toBeNull();
    expect(second.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      reason: "upstream_artifact_unchanged",
      state: "waiting_for_upstream_change",
      upstreamArtifactHash: "dispatch-hash-a",
    });
    expect(wakeups).toHaveLength(1);
  });

  it("keeps repeated upstream-artifact waits active without spending agent tokens", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "product_execution",
          state: "ready_for_agent",
          blockerClass: "council_triage",
          upstreamArtifactHash: "selection-hash-a",
          requireUpstreamChange: true,
        }),
      })
      .where(eq(routines.id, routine.id));

    const first = await svc.runRoutine(routine.id, { source: "schedule" });
    expect(first.status).toBe("issue_created");
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, first.linkedIssueId!));

    const second = await svc.runRoutine(routine.id, { source: "schedule" });
    const third = await svc.runRoutine(routine.id, { source: "schedule" });
    const fourth = await svc.runRoutine(routine.id, { source: "schedule" });
    const fifth = await svc.runRoutine(routine.id, { source: "schedule" });

    expect([second.failureReason, third.failureReason, fourth.failureReason, fifth.failureReason]).toEqual([
      "upstream_artifact_unchanged",
      "upstream_artifact_unchanged",
      "upstream_artifact_unchanged",
      "upstream_artifact_unchanged",
    ]);
    expect(fourth.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      reason: "upstream_artifact_unchanged",
      routinePaused: false,
      duplicateCount: 3,
    });
    expect(fifth.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      reason: "upstream_artifact_unchanged",
      routinePaused: false,
      duplicateCount: 4,
      selfHeal: {
        status: "exhausted",
        rescheduled: false,
      },
    });
    expect([second.linkedIssueId, third.linkedIssueId, fourth.linkedIssueId, fifth.linkedIssueId]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const updatedRoutine = await db
      .select({ status: routines.status })
      .from(routines)
      .where(eq(routines.id, routine.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedRoutine?.status).toBe("active");

    const guardIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        status: issues.status,
        originKind: issues.originKind,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.originKind, "factory_guard"));
    expect(guardIssues).toHaveLength(0);
    expect(wakeups).toHaveLength(1);
  });

  it("self-heals repeated system cadence blockers without pausing the routine or waking assignees", async () => {
    const { routine, svc, wakeups } = await seedFixture();
    await db
      .update(routines)
      .set({
        description: actionabilityDescription({
          lane: "product_execution",
          state: "ready_for_agent",
          blockerClass: "council_triage",
          minIntervalMinutes: 240,
        }),
      })
      .where(eq(routines.id, routine.id));
    const recoveryCronHourUtc = (new Date().getUTCHours() + 2) % 24;
    const { trigger } = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "daily",
      cronExpression: `0 ${recoveryCronHourUtc} * * *`,
      timezone: "UTC",
    }, {});

    const first = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    expect(first.status).toBe("issue_created");
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, first.linkedIssueId!));

    const setNaturalNextRunFarAway = async () => {
      await db
        .update(routineTriggers)
        .set({ nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(routineTriggers.id, trigger.id));
    };

    await setNaturalNextRunFarAway();
    const firstSkipStartedAt = Date.now();
    const second = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    expect(second.status).toBe("skipped");
    expect(second.failureReason).toBe("maintenance_lane_cadence");
    expect(second.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      reason: "maintenance_lane_cadence",
      routinePaused: false,
      duplicateCount: 1,
      selfHeal: {
        status: "rescheduled",
        rescheduled: true,
        rescheduleCap: 3,
      },
    });

    const rescheduledTrigger = await db
      .select({ enabled: routineTriggers.enabled, nextRunAt: routineTriggers.nextRunAt })
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0] ?? null);
    expect(rescheduledTrigger?.enabled).toBe(true);
    expect(rescheduledTrigger?.nextRunAt?.getTime()).toBeGreaterThanOrEqual(firstSkipStartedAt + 55 * 60 * 1000);
    expect(rescheduledTrigger?.nextRunAt?.getTime()).toBeLessThanOrEqual(firstSkipStartedAt + 65 * 60 * 1000);

    await setNaturalNextRunFarAway();
    const third = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    await setNaturalNextRunFarAway();
    const fourth = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });
    await setNaturalNextRunFarAway();
    const fifth = await svc.runRoutine(routine.id, { source: "schedule", triggerId: trigger.id });

    expect([third.failureReason, fourth.failureReason, fifth.failureReason]).toEqual([
      "maintenance_lane_cadence",
      "maintenance_lane_cadence",
      "maintenance_lane_cadence",
    ]);
    expect(fourth.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      duplicateCount: 3,
      routinePaused: false,
      selfHeal: {
        status: "rescheduled",
        rescheduled: true,
      },
    });
    expect(fifth.triggerPayload?.paperclipActionabilityPreflight).toMatchObject({
      duplicateCount: 4,
      routinePaused: false,
      selfHeal: {
        status: "exhausted",
        rescheduled: false,
      },
    });
    expect([second.linkedIssueId, third.linkedIssueId, fourth.linkedIssueId, fifth.linkedIssueId]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const updatedRoutine = await db
      .select({ status: routines.status })
      .from(routines)
      .where(eq(routines.id, routine.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedRoutine?.status).toBe("active");

    const guardIssues = await db
      .select({
        title: issues.title,
        status: issues.status,
        originKind: issues.originKind,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.originKind, "factory_guard"));
    expect(guardIssues).toHaveLength(0);
    expect(wakeups).toHaveLength(1);
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("assigns and wakes open child issues when a routine execution completes", async () => {
    const { agentId, companyId, issueSvc, routine, svc, wakeups } = await seedFixture();
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    wakeups.splice(0);

    const childIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      parentId: run.linkedIssueId!,
      title: "Council hypothesis validation",
      description: "Validate a council-created hypothesis.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      createdByAgentId: agentId,
    });

    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, run.linkedIssueId!));

    const synced = await svc.syncRunStatusForIssue(run.linkedIssueId!);

    expect(synced?.status).toBe("completed");
    const updatedChild = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, childIssue.id))
      .then((rows) => rows[0] ?? null);
    expect(updatedChild).toEqual({
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(wakeups).toEqual([
      {
        agentId,
        opts: expect.objectContaining({
          reason: "issue_assigned",
          payload: { issueId: childIssue.id, mutation: "update" },
          requestedByActorType: "system",
          contextSnapshot: { issueId: childIssue.id, source: "routine.child_handoff" },
        }),
      },
    ]);
  });

  it("coalesces a manual run only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("coalesces run-scoped routine siblings into one live family issue", async () => {
    const { agentId, companyId, issueSvc, projectId, svc } = await seedFixture();
    const siblingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T123000Z] Dispatch Poller",
        description: "Poll dispatch parity for the first run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const currentRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T130000Z] Dispatch Poller",
        description: "Poll dispatch parity for the second run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId,
      title: siblingRoutine.title,
      description: siblingRoutine.description,
      status: "in_progress",
      priority: siblingRoutine.priority,
      assigneeAgentId: siblingRoutine.assigneeAgentId,
      originKind: "routine_execution",
      originId: siblingRoutine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: siblingRoutine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const run = await svc.runRoutine(currentRoutine.id, { source: "manual" });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const familyIssues = await db
      .select({
        id: issues.id,
        originId: issues.originId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.originId, [siblingRoutine.id, currentRoutine.id]),
        ),
      );

    expect(familyIssues).toHaveLength(1);
    expect(familyIssues[0]?.id).toBe(previousIssue.id);
    expect(familyIssues[0]?.originId).toBe(siblingRoutine.id);
  });

  it("coalesces unattended run-scoped routine siblings into one open family issue", async () => {
    const { agentId, companyId, issueSvc, projectId, svc, wakeups } = await seedFixture();
    const siblingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T123000Z] Dispatch Poller",
        description: "Poll dispatch parity for the first run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const currentRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T130000Z] Dispatch Poller",
        description: "Poll dispatch parity for the second run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId,
      title: siblingRoutine.title,
      description: siblingRoutine.description,
      status: "todo",
      priority: siblingRoutine.priority,
      assigneeAgentId: siblingRoutine.assigneeAgentId,
      originKind: "routine_execution",
      originId: siblingRoutine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: siblingRoutine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    const run = await svc.runRoutine(currentRoutine.id, { source: "schedule" });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);
    expect(wakeups).toHaveLength(0);

    const familyIssues = await db
      .select({
        id: issues.id,
        originId: issues.originId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.originId, [siblingRoutine.id, currentRoutine.id]),
        ),
      );

    expect(familyIssues).toHaveLength(1);
    expect(familyIssues[0]?.id).toBe(previousIssue.id);
    expect(familyIssues[0]?.originId).toBe(siblingRoutine.id);
  });

  it("supersedes stale unattended run-scoped family issues before creating current work", async () => {
    const { agentId, companyId, issueSvc, projectId, svc, wakeups } = await seedFixture();
    const siblingRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T123000Z] Dispatch Poller",
        description: "Poll dispatch parity for the first run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const currentRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "[run_id:20260405T130000Z] Dispatch Poller",
        description: "Poll dispatch parity for the second run",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const previousRunId = randomUUID();
    const staleAt = new Date("2026-03-20T12:00:00.000Z");
    const previousIssue = await issueSvc.create(companyId, {
      projectId,
      title: siblingRoutine.title,
      description: siblingRoutine.description,
      status: "todo",
      priority: siblingRoutine.priority,
      assigneeAgentId: siblingRoutine.assigneeAgentId,
      originKind: "routine_execution",
      originId: siblingRoutine.id,
      originRunId: previousRunId,
    });

    await db
      .update(issues)
      .set({ createdAt: staleAt, updatedAt: staleAt })
      .where(eq(issues.id, previousIssue.id));

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: siblingRoutine.id,
      triggerId: null,
      source: "schedule",
      status: "issue_created",
      triggeredAt: staleAt,
      linkedIssueId: previousIssue.id,
    });

    const run = await svc.runRoutine(currentRoutine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);
    expect(wakeups).toHaveLength(1);

    const familyIssues = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        status: issues.status,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.originId, [siblingRoutine.id, currentRoutine.id]),
        ),
      );

    expect(familyIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: previousIssue.id,
        originId: siblingRoutine.id,
        status: "cancelled",
      }),
      expect.objectContaining({
        id: run.linkedIssueId,
        originId: currentRoutine.id,
        status: "todo",
      }),
    ]));
    const superseded = familyIssues.find((issue) => issue.id === previousIssue.id);
    expect(superseded?.executionState?.paperclipRoutineSupersession).toMatchObject({
      reason: "stale_unattended_idle_routine_issue",
      replacementRoutineRunId: run.id,
      previousOriginRunId: previousRunId,
      routineId: currentRoutine.id,
    });
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toMatchObject({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
      paperclipActionabilityPreflight: {
        status: "passed",
        reason: "agent_actionable",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });
});
