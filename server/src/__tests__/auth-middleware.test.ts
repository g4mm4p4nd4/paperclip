import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
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
    executionAdapterType: string;
    agentStatus: string;
  }>;
  membershipRows?: Array<{ companyId: string }>;
}) {
  return {
    select(selection?: Record<string, unknown>) {
      if (selection && "runStatus" in selection) return queryRows(options.runningRunRows ?? []);
      if (selection && Object.keys(selection).length === 1 && "companyId" in selection) {
        return queryRows(options.membershipRows ?? []);
      }
      return queryRows([]);
    },
  };
}

function createApp(db: unknown, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(actorMiddleware(db as any, { deploymentMode }));
  app.get("/actor", (req, res) => res.json(req.actor));
  return app;
}

describe("actor middleware run-scoped agent authority", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "middleware-test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
  });

  it("never treats a loopback run id as a credential", async () => {
    const res = await request(createApp(createAuthDb({
      runningRunRows: [{
        agentId: "agent-1",
        companyId: "company-1",
        runStatus: "running",
        executionAdapterType: "codex_local",
        agentStatus: "running",
      }],
    })))
      .get("/actor")
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toEqual({ type: "none", source: "none" });
  });

  it("authenticates a JWT only for its exact active run, adapter, agent, and home company", async () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    const res = await request(createApp(createAuthDb({
      runningRunRows: [{
        agentId: "agent-1",
        companyId: "company-1",
        runStatus: "running",
        executionAdapterType: "codex_local",
        agentStatus: "running",
      }],
      membershipRows: [{ companyId: "company-2" }],
    })))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      runId: "run-1",
      source: "agent_jwt",
    });
  });

  it("rejects a run-id header that conflicts with signed claims", async () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    const res = await request(createApp(createAuthDb({
      runningRunRows: [{
        agentId: "agent-1",
        companyId: "company-1",
        runStatus: "running",
        executionAdapterType: "codex_local",
        agentStatus: "running",
      }],
    })))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "other-run")
      .expect(200);

    expect(res.body).toEqual({ type: "none", source: "none" });
  });

  it("rejects a valid JWT when the active run adapter does not match", async () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1")!;
    const res = await request(createApp(createAuthDb({
      runningRunRows: [{
        agentId: "agent-1",
        companyId: "company-1",
        runStatus: "running",
        executionAdapterType: "gemini_local",
        agentStatus: "running",
      }],
    })))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "run-1")
      .expect(200);

    expect(res.body).toEqual({ type: "none", source: "none" });
  });

  it("never falls through an invalid bearer to local_trusted board authority", async () => {
    const res = await request(createApp(createAuthDb({}), "local_trusted"))
      .get("/actor")
      .set("Authorization", "Bearer invalid-token")
      .expect(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
  });

  it("keeps bearerless local_trusted requests as implicit board authority", async () => {
    const res = await request(createApp(createAuthDb({}), "local_trusted"))
      .get("/actor")
      .expect(200);
    expect(res.body).toMatchObject({ type: "board", source: "local_implicit" });
  });
});
