import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockAgentRoleDefaultsService = vi.hoisted(() => ({
  resolveDesiredSkillAssignment: vi.fn(),
  materializeDefaultInstructionsBundleForAgent: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  listFull: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentRoleDefaultsService: () => mockAgentRoleDefaultsService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(() => mockAdapter),
    findActiveServerAdapter: vi.fn(() => mockAdapter),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));
}

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

async function createApp(db: Record<string, unknown> = createDb()) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function makeAgent(adapterType: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

describe.sequential("agent skill routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    for (const mock of Object.values(mockAgentService)) mock.mockReset();
    for (const mock of Object.values(mockAccessService)) mock.mockReset();
    for (const mock of Object.values(mockApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
    for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
    for (const mock of Object.values(mockSecretService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockTrackAgentCreated.mockReset();
    mockGetTelemetryClient.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockAdapter.listSkills.mockReset();
    mockAdapter.syncSkills.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    let persistedAgent: Record<string, unknown> | null = null;
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
        required: true,
        requiredReason: "required",
      },
    ]);
    mockCompanySkillService.listFull.mockResolvedValue([
      {
        id: "skill-paperclip",
        key: "paperclipai/paperclip/paperclip",
        slug: "paperclip",
      },
      {
        id: "skill-create-agent",
        key: "paperclipai/paperclip/paperclip-create-agent",
        slug: "paperclip-create-agent",
      },
      {
        id: "skill-create-plugin",
        key: "paperclipai/paperclip/paperclip-create-plugin",
        slug: "paperclip-create-plugin",
      },
      {
        id: "skill-product-scope",
        key: "paperclipai/paperclip/paperclip-product-scope",
        slug: "paperclip-product-scope",
      },
      {
        id: "skill-gtm",
        key: "paperclipai/paperclip/paperclip-go-to-market",
        slug: "paperclip-go-to-market",
      },
      {
        id: "skill-frontend",
        key: "paperclipai/paperclip/paperclip-frontend-experience",
        slug: "paperclip-frontend-experience",
      },
      {
        id: "skill-backend",
        key: "paperclipai/paperclip/paperclip-backend-api-security",
        slug: "paperclip-backend-api-security",
      },
      {
        id: "skill-integrations",
        key: "paperclipai/paperclip/paperclip-integration-engineer",
        slug: "paperclip-integration-engineer",
      },
      {
        id: "skill-memory",
        key: "paperclipai/paperclip/para-memory-files",
        slug: "para-memory-files",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => {
        const skillKeyMap: Record<string, string> = {
          paperclip: "paperclipai/paperclip/paperclip",
          "paperclipai/paperclip/paperclip": "paperclipai/paperclip/paperclip",
          "paperclipai/paperclip/paperclip-create-agent": "paperclipai/paperclip/paperclip-create-agent",
          "paperclipai/paperclip/paperclip-create-plugin": "paperclipai/paperclip/paperclip-create-plugin",
          "paperclipai/paperclip/paperclip-product-scope": "paperclipai/paperclip/paperclip-product-scope",
          "paperclipai/paperclip/paperclip-go-to-market": "paperclipai/paperclip/paperclip-go-to-market",
          "paperclipai/paperclip/paperclip-backend-api-security": "paperclipai/paperclip/paperclip-backend-api-security",
          "paperclipai/paperclip/paperclip-frontend-experience": "paperclipai/paperclip/paperclip-frontend-experience",
          "paperclipai/paperclip/paperclip-integration-engineer": "paperclipai/paperclip/paperclip-integration-engineer",
          "paperclipai/paperclip/para-memory-files": "paperclipai/paperclip/para-memory-files",
          "paperclip-product-scope": "paperclipai/paperclip/paperclip-product-scope",
          "paperclip-go-to-market": "paperclipai/paperclip/paperclip-go-to-market",
          "paperclip-create-agent": "paperclipai/paperclip/paperclip-create-agent",
          "paperclip-backend-api-security": "paperclipai/paperclip/paperclip-backend-api-security",
          "paperclip-frontend-experience": "paperclipai/paperclip/paperclip-frontend-experience",
          "paperclip-integration-engineer": "paperclipai/paperclip/paperclip-integration-engineer",
          "paperclip-create-plugin": "paperclipai/paperclip/paperclip-create-plugin",
          "para-memory-files": "paperclipai/paperclip/para-memory-files",
        };
        return requested.map((value) => skillKeyMap[value] ?? value);
      },
    );
    mockAgentRoleDefaultsService.resolveDesiredSkillAssignment.mockImplementation(
      async (
        companyId: string,
        role: string,
        _adapterType: string,
        adapterConfig: Record<string, unknown>,
        requestedDesiredSkills: string[] | undefined,
        options?: { includeRoleDefaults?: boolean },
      ) => {
        const defaultSkillsByRole: Record<string, string[]> = {
          ceo: [
            "paperclipai/paperclip/paperclip-create-agent",
            "paperclipai/paperclip/paperclip-product-scope",
            "paperclipai/paperclip/paperclip-go-to-market",
            "paperclipai/paperclip/para-memory-files",
          ],
          engineer: [
            "paperclipai/paperclip/paperclip-product-scope",
            "paperclipai/paperclip/paperclip-frontend-experience",
            "paperclipai/paperclip/paperclip-backend-api-security",
            "paperclipai/paperclip/paperclip-integration-engineer",
            "paperclipai/paperclip/paperclip-create-plugin",
          ],
          default: ["paperclipai/paperclip/paperclip-product-scope"],
        };
        const roleDefaults = defaultSkillsByRole[role] ?? defaultSkillsByRole.default;
        const requestedOrDefaultDesiredSkills = options?.includeRoleDefaults === false
          ? (requestedDesiredSkills ?? [])
          : requestedDesiredSkills === undefined
            ? roleDefaults
            : requestedDesiredSkills.length === 0
              ? []
              : Array.from(new Set([...roleDefaults, ...requestedDesiredSkills]));
        const resolvedRequestedSkills = await mockCompanySkillService.resolveRequestedSkillKeys(
          companyId,
          requestedOrDefaultDesiredSkills,
        );
        const runtimeSkillEntries = await mockCompanySkillService.listRuntimeSkillEntries(companyId, {
          materializeMissing: false,
        });
        const requiredSkills = runtimeSkillEntries
          .filter((entry: { required: boolean }) => entry.required)
          .map((entry: { key: string }) => entry.key);
        const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));
        return {
          adapterConfig: {
            ...adapterConfig,
            paperclipSkillSync: {
              desiredSkills,
            },
          },
          desiredSkills,
          runtimeSkillEntries,
        };
      },
    );
    mockAgentRoleDefaultsService.materializeDefaultInstructionsBundleForAgent.mockImplementation(
      async (
        agent: Record<string, unknown>,
        options?: { replaceManaged?: boolean },
      ) => {
        const adapterConfig = (agent.adapterConfig as Record<string, unknown> | undefined) ?? {};
        const hasExplicitBundle =
          Boolean(adapterConfig.instructionsBundleMode)
          || Boolean(adapterConfig.instructionsRootPath)
          || Boolean(adapterConfig.instructionsEntryFile)
          || Boolean(adapterConfig.instructionsFilePath)
          || Boolean(adapterConfig.agentsMdPath);
        if (hasExplicitBundle && !options?.replaceManaged) {
          return { agent, changed: false, action: "unchanged" };
        }
        const promptTemplate = typeof adapterConfig.promptTemplate === "string"
          ? adapterConfig.promptTemplate
          : "";
        const files = promptTemplate.trim().length > 0
          ? { "AGENTS.md": promptTemplate }
          : await loadDefaultAgentInstructionsBundle((agent.role as string) === "ceo" ? "ceo" : "engineer");
        const materialized = await mockAgentInstructionsService.materializeManagedBundle(
          agent,
          files,
          { entryFile: "AGENTS.md", replaceExisting: options?.replaceManaged === true },
        );
        const nextAdapterConfig = {
          ...materialized.adapterConfig,
        };
        delete nextAdapterConfig.promptTemplate;
        const updated = await mockAgentService.update(String(agent.id), { adapterConfig: nextAdapterConfig });
        return {
          agent: updated,
          changed: true,
          action: options?.replaceManaged === true ? "replaced_managed" : "created_managed",
        };
      },
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      const previousAgent = persistedAgent ?? makeAgent("claude_local");
      persistedAgent = {
        ...previousAgent,
        ...patch,
        adapterConfig: patch.adapterConfig ?? previousAgent.adapterConfig ?? {},
      };
      return persistedAgent;
    });
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => {
      persistedAgent = {
        ...makeAgent(String(input.adapterType ?? "claude_local")),
        ...input,
        adapterConfig: input.adapterConfig ?? {},
        runtimeConfig: input.runtimeConfig ?? {},
        budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
        permissions: null,
      };
      return persistedAgent;
    });
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  }, 10_000);

  it("skips runtime materialization when listing Codex skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("keeps runtime materialization for persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("cursor"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "cursor",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"] }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.syncSkills).toHaveBeenCalled();
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"] }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-integration-engineer",
      "paperclipai/paperclip/paperclip-create-plugin",
      "paperclip",
    ]);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: [
              "paperclipai/paperclip/paperclip",
              "paperclipai/paperclip/paperclip-product-scope",
              "paperclipai/paperclip/paperclip-frontend-experience",
              "paperclipai/paperclip/paperclip-backend-api-security",
              "paperclipai/paperclip/paperclip-integration-engineer",
              "paperclipai/paperclip/paperclip-create-plugin",
            ],
          }),
        }),
      }),
    );
    expect(mockTrackAgentCreated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentRole: "engineer",
      }),
    );
  });

  it("applies role-default Paperclip skills when desiredSkills is omitted", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", [
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ]);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: [
              "paperclipai/paperclip/paperclip",
              "paperclipai/paperclip/paperclip-create-agent",
              "paperclipai/paperclip/paperclip-product-scope",
              "paperclipai/paperclip/paperclip-go-to-market",
              "paperclipai/paperclip/para-memory-files",
            ],
          }),
        }),
      }),
    );
  });

  it("allows explicit empty desiredSkills to suppress optional role defaults", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        desiredSkills: [],
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", []);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("accepts the security role on direct agent creation and preserves it in telemetry", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Security Engineer",
        role: "security",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      role: "security",
    });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        role: "security",
      }),
    );
    expect(mockTrackAgentCreated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentRole: "security",
      }),
    );
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        instructionsBundle: {
          files: {
            "AGENTS.md": "You are QA.",
          },
        },
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
        }),
      }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      adapterConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("rejects legacy prompt templates for directly created local agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          instructionsFilePath: "/tmp/existing/AGENTS.md",
          promptTemplate: "You are QA.",
          bootstrapPromptTemplate: "Bootstrap QA.",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("New agents must use instructionsBundle/AGENTS.md");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.materializeManagedBundle).not.toHaveBeenCalled();
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "ceo",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "HEARTBEAT.md": expect.stringContaining("CEO Heartbeat Checklist"),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
  });

  it("materializes the bundled role-specific instruction set for non-CEO agents with no prompt template", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    await vi.waitFor(() => {
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "11111111-1111-4111-8111-111111111111",
          role: "engineer",
          adapterType: "claude_local",
        }),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining("You are an Engineer."),
        }),
        { entryFile: "AGENTS.md", replaceExisting: false },
      );
    });
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-integration-engineer",
      "paperclipai/paperclip/paperclip-create-plugin",
      "paperclip",
    ]);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: [
            "paperclipai/paperclip/paperclip",
            "paperclipai/paperclip/paperclip-product-scope",
            "paperclipai/paperclip/paperclip-frontend-experience",
            "paperclipai/paperclip/paperclip-backend-api-security",
            "paperclipai/paperclip/paperclip-integration-engineer",
            "paperclipai/paperclip/paperclip-create-plugin",
          ],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: [
              "paperclipai/paperclip/paperclip",
              "paperclipai/paperclip/paperclip-product-scope",
              "paperclipai/paperclip/paperclip-frontend-experience",
              "paperclipai/paperclip/paperclip-backend-api-security",
              "paperclipai/paperclip/paperclip-integration-engineer",
              "paperclipai/paperclip/paperclip-create-plugin",
            ],
          }),
        }),
      }),
    );
  });

  it("preserves hire source issues, icons, desired skills, and approval payload details", async () => {
    const db = createDb(true);
    const sourceIssueId = "22222222-2222-4222-8222-222222222222";

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Security Engineer",
        role: "engineer",
        icon: "crown",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
        sourceIssueId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        icon: "crown",
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          icon: "crown",
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      [sourceIssueId],
      { agentId: null, userId: "local-board" },
    );
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        instructionsBundle: {
          files: {
            "AGENTS.md": "You are QA.",
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
          }),
        }),
      }),
    );
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { adapterConfig?: Record<string, unknown> } }
      | undefined;
    expect(approvalInput?.payload?.adapterConfig?.promptTemplate).toBeUndefined();
  });

  it("rejects legacy prompt templates for hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          instructionsFilePath: "/tmp/existing/AGENTS.md",
          promptTemplate: "You are QA.",
          bootstrapPromptTemplate: "Bootstrap QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("New agents must use instructionsBundle/AGENTS.md");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.materializeManagedBundle).not.toHaveBeenCalled();
  });
});
