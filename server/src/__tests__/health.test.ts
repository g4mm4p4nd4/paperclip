import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

describe("GET /health", () => {
  beforeEach(() => {
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok", async () => {
    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      components: { tokenomicsWatch: { enabled: false, state: "disabled" } },
    });
  });

  it("surfaces supervised tokenomics freshness without changing API availability", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      tokenomicsWatchSnapshot: () => ({
        enabled: true,
        state: "stale",
        intervalSeconds: 300,
        running: false,
        lastStartedAt: "2026-07-15T05:00:00.000Z",
        lastCompletedAt: "2026-07-15T05:00:10.000Z",
        lastSuccessAt: "2026-07-15T05:00:10.000Z",
        lastReceiptPath: "/receipts/tokenomics.json",
        lastReportStatus: "fail",
        lastPromotionStatus: "fail",
        consecutiveFailures: 2,
        freshnessAgeSeconds: 900,
        staleAfterSeconds: 600,
        lastFailureCode: "provider_capacity_unavailable",
      }),
    }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.components.tokenomicsWatch).toMatchObject({
      enabled: true,
      state: "stale",
      lastReceiptPath: "/receipts/tokenomics.json",
      lastFailureCode: "provider_capacity_unavailable",
    });
  });

  it("surfaces supervised immutable baseline freshness", async () => {
    const db = { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      factoryBaselineRefreshSnapshot: () => ({
        enabled: true,
        state: "healthy",
        intervalSeconds: 60,
        running: false,
        lastStartedAt: "2026-07-17T18:00:00.000Z",
        lastCompletedAt: "2026-07-17T18:00:01.000Z",
        lastSuccessAt: "2026-07-17T18:00:01.000Z",
        lastReceiptPath: "/receipts/factory-baseline.json",
        lastReceiptSha256: "a".repeat(64),
        consecutiveFailures: 0,
        freshnessAgeSeconds: 0,
        staleAfterSeconds: 120,
        lastFailureCode: null,
      }),
    }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.components.factoryBaselineRefresh).toMatchObject({
      enabled: true,
      state: "healthy",
      lastReceiptSha256: "a".repeat(64),
    });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });
});
