import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { setOverridePaused } from "../adapters/registry.js";
import { adapterRoutes } from "../routes/adapters.js";
import { errorHandler } from "../middleware/index.js";

const overridingConfigSchemaAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  getConfigSchema: async () => ({
    version: 1,
    fields: [
      {
        key: "mode",
        type: "text",
        label: "Mode",
      },
    ],
  }),
};

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: [],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", adapterRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("adapter routes", () => {
  beforeEach(() => {
    setOverridePaused("claude_local", false);
    registerServerAdapter(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
  });

  it("uses the active adapter when resolving config schema for a paused builtin override", async () => {
    const app = createApp();

    const active = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({
      fields: [{ key: "mode" }],
    });

    const paused = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const builtin = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(builtin.status, JSON.stringify(builtin.body)).toBe(404);
    expect(String(builtin.body.error ?? "")).toContain("does not provide a config schema");
  });

  it("requires instance-admin authority for global managed install and rollback", async () => {
    const app = createApp({
      type: "board",
      userId: "ordinary-board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });
    const install = await request(app).post("/api/adapters/install").send({
      packageName: "@henkey/hermes-paperclip-adapter",
      installKind: "managed_immutable_bundle",
    });
    expect(install.status).toBe(403);

    const rollback = await request(app).post("/api/adapters/hermes_local/managed-rollback").send({});
    expect(rollback.status).toBe(403);
  });
});
