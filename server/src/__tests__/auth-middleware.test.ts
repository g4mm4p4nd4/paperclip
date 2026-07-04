import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function queryRows<T>(rows: T[]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    then: (resolve: (value: T[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

function createAuthDb(options: {
  runningRunRows?: Array<{
    agentId: string;
    companyId: string;
    runStatus: string;
    agentStatus: string;
  }>;
  membershipRows?: Array<{ companyId: string }>;
}) {
  return {
    select(selection?: Record<string, unknown>) {
      if (selection && "runStatus" in selection) {
        return queryRows(options.runningRunRows ?? []);
      }
      if (selection && Object.keys(selection).length === 1 && "companyId" in selection) {
        return queryRows(options.membershipRows ?? []);
      }
      return queryRows([]);
    },
  };
}

function createApp(db: unknown) {
  const app = express();
  app.use(actorMiddleware(db as any, { deploymentMode: "authenticated" }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actor middleware loopback run-id fallback", () => {
  it("authenticates a loopback request with an active heartbeat run id when bearer auth is missing", async () => {
    const res = await request(
      createApp(createAuthDb({
        runningRunRows: [
          {
            agentId: "agent-1",
            companyId: "company-1",
            runStatus: "running",
            agentStatus: "running",
          },
        ],
        membershipRows: [{ companyId: "company-2" }],
      })),
    )
      .get("/actor")
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1", "company-2"],
      runId: "run-1",
      source: "loopback_run_id",
    });
  });

  it("does not authenticate a missing bearer request when the run is not active", async () => {
    const res = await request(createApp(createAuthDb({ runningRunRows: [] })))
      .get("/actor")
      .set("X-Paperclip-Run-Id", "queued-run")
      .expect(200);

    expect(res.body).toMatchObject({
      type: "none",
      runId: "queued-run",
      source: "none",
    });
  });

  it("authenticates an empty bearer token with an active loopback run id", async () => {
    const res = await request(
      createApp(createAuthDb({
        runningRunRows: [
          {
            agentId: "agent-1",
            companyId: "company-1",
            runStatus: "running",
            agentStatus: "running",
          },
        ],
      })),
    )
      .get("/actor")
      .set("Authorization", "Bearer ")
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "loopback_run_id",
    });
  });

  it("does not fall back to run-id auth when an invalid bearer token is present", async () => {
    const res = await request(
      createApp(createAuthDb({
        runningRunRows: [
          {
            agentId: "agent-1",
            companyId: "company-1",
            runStatus: "running",
            agentStatus: "running",
          },
        ],
      })),
    )
      .get("/actor")
      .set("Authorization", "Bearer invalid")
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toMatchObject({
      type: "none",
      source: "none",
    });
  });
});
