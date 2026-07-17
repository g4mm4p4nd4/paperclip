import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFactoryLaunchProposal: vi.fn(),
}));

vi.mock("../services/factory-launch-proposals.js", () => ({
  createFactoryLaunchProposal: mocks.createFactoryLaunchProposal,
}));

vi.mock("../services/profit-flywheel.js", () => ({
  profitFlywheelService: vi.fn(() => ({})),
}));

vi.mock("../services/software-factory-health.js", () => ({
  softwareFactoryHealthService: vi.fn(() => ({})),
}));

import { errorHandler } from "../middleware/index.js";
import { profitFlywheelRoutes } from "../routes/profit-flywheel.js";

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "operator-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: true,
    };
    next();
  });
  server.use("/api", profitFlywheelRoutes({} as any, {
    factoryHealth: {
      mode: "shadow",
      pauseNewWork: false,
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
    },
    factoryLaunchAuthority: {
      claim: vi.fn(async () => ({
        allowed: false,
        code: "unused",
        detail: "unused",
        terminal: false,
      })),
    },
  }));
  server.use(errorHandler);
  return server;
}

describe("factory launch proposal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createFactoryLaunchProposal.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "profit_flywheel_shadow_launch",
      status: "pending",
      payload: { source_generated: true },
    });
  });

  it("accepts operator intent and delegates all exact binding generation to the server", async () => {
    const body = {
      requestedMode: "shadow",
      targetRepo: "owner/isolated-shadow",
      runId: "shadow-run-1",
      inputHash: "a".repeat(64),
      expiresInSeconds: 900,
    };
    const response = await request(app())
      .post("/api/companies/company-1/profit-flywheel/factory-launch-proposals")
      .send(body);

    expect(response.status).toBe(201);
    expect(mocks.createFactoryLaunchProposal).toHaveBeenCalledWith(
      expect.anything(),
      {
        companyId: "company-1",
        ...body,
        requestedByUserId: "operator-1",
        portfolioOsRuntimeRoot: "/managed/portfolio-os",
      },
    );
  });

  it("rejects operator-supplied binding maps", async () => {
    const response = await request(app())
      .post("/api/companies/company-1/profit-flywheel/factory-launch-proposals")
      .send({
        requestedMode: "shadow",
        targetRepo: "owner/isolated-shadow",
        runId: "shadow-run-1",
        inputHash: "a".repeat(64),
        contractHashes: { forged: "b".repeat(64) },
      });

    expect(response.status).toBe(400);
    expect(mocks.createFactoryLaunchProposal).not.toHaveBeenCalled();
  });
});
