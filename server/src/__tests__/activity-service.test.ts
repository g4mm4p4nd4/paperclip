import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const checkoutRunId = randomUUID();
    const executionRunId = randomUUID();
    const activityRunId = randomUUID();
    const contextRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio OS",
      issuePrefix: "POR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: checkoutRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "assignment",
        createdAt: new Date("2026-07-04T10:00:00.000Z"),
      },
      {
        id: executionRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        createdAt: new Date("2026-07-04T10:01:00.000Z"),
      },
      {
        id: activityRunId,
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "manual",
        createdAt: new Date("2026-07-04T10:02:00.000Z"),
      },
      {
        id: contextRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "timer",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-04T10:03:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Trace issue runs",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId,
      executionRunId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.comment_created",
      entityType: "issue",
      entityId: issueId,
      runId: activityRunId,
    });

    return { companyId, issueId, checkoutRunId, executionRunId, activityRunId, contextRunId };
  }

  it("loads issue runs from direct issue links, activity links, and bounded context links", async () => {
    const ids = await seedIssueRuns();

    const result = await activityService(db).runsForIssue(ids.companyId, ids.issueId);

    expect(result.map((run) => run.runId)).toEqual([
      ids.contextRunId,
      ids.activityRunId,
      ids.executionRunId,
      ids.checkoutRunId,
    ]);
  });
});
