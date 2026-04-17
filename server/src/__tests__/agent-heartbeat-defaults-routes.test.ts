import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";

vi.mock("@paperclipai/shared", () => {
  const passthroughSchema = {
    parse: (value: unknown) => value,
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  };
  return {
    agentSkillSyncSchema: passthroughSchema,
    agentMineInboxQuerySchema: passthroughSchema,
    createAgentKeySchema: passthroughSchema,
    createAgentHireSchema: passthroughSchema,
    createAgentSchema: passthroughSchema,
    deriveAgentUrlKey: (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-"),
    isUuidLike: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
    resetAgentSessionSchema: passthroughSchema,
    testAdapterEnvironmentSchema: passthroughSchema,
    upsertAgentInstructionsFileSchema: passthroughSchema,
    updateAgentInstructionsBundleSchema: passthroughSchema,
    updateAgentPermissionsSchema: passthroughSchema,
    updateAgentInstructionsPathSchema: passthroughSchema,
    wakeAgentSchema: passthroughSchema,
    updateAgentSchema: passthroughSchema,
  };
});

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockRoleDefaults = vi.hoisted(() => ({
  resolveDesiredSkillAssignment: vi.fn(async (
    _companyId: string,
    _role: string,
    _adapterType: string,
    adapterConfig: Record<string, unknown>,
  ) => ({
    adapterConfig,
    desiredSkills: [],
    runtimeSkillEntries: [],
  })),
  materializeDefaultInstructionsBundleForAgent: vi.fn(async (agent: Record<string, unknown>) => ({
    agent,
    changed: false,
    action: "unchanged",
  })),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentRoleDefaultsService: () => mockRoleDefaults,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async (_companyId: string, requested: string[]) => requested),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => ({ cancelActiveForAgent: vi.fn() }),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: vi.fn(async () => undefined),
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => null),
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

describe("agent heartbeat defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: agentId,
      companyId,
      name: String(input.name ?? "Builder"),
      urlKey: "builder",
      role: String(input.role ?? "engineer"),
      title: null,
      icon: null,
      status: String(input.status ?? "idle"),
      reportsTo: null,
      capabilities: null,
      adapterType: String(input.adapterType ?? "process"),
      adapterConfig: (input.adapterConfig as Record<string, unknown>) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown>) ?? {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-04-17T12:00:00.000Z"),
      updatedAt: new Date("2026-04-17T12:00:00.000Z"),
    }));
  });

  it("normalizes direct agent creation to disable timer heartbeats by default", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
          },
        },
      }),
    );
  });

  it("normalizes hire requests to disable timer heartbeats by default", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
          },
        },
      }),
    );
  });
});
