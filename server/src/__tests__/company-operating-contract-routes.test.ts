import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockOperatingContractService = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  operatingContractService: () => mockOperatingContractService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const { companyRoutes } = await import("../routes/companies.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function makeConfig() {
  return {
    companyId,
    projectWorkspaceId: workspaceId,
    packageRootPath: "contracts/leadforge",
    workspace: {
      id: workspaceId,
      projectId: "33333333-3333-4333-8333-333333333333",
      projectName: "LeadForge",
      workspaceName: "Main Repo",
      cwd: "/tmp/leadforge",
      repoUrl: "https://github.com/example/leadforge.git",
      isPrimary: true,
    },
    lastReviewedAt: null,
    lastReviewSourceHash: null,
    lastReviewSummary: null,
    sourceChangedSinceReview: false,
    createdAt: null,
    updatedAt: null,
  };
}

function makePreview() {
  return {
    companyId,
    config: makeConfig(),
    previewHash: "preview-hash-1",
    sourceHash: "source-hash-1",
    status: "warning" as const,
    source: {
      workspaceId,
      packageRootPath: "contracts/leadforge",
      companyPath: "/tmp/leadforge/contracts/leadforge/COMPANY.md",
      paperclipExtensionPath: "/tmp/leadforge/contracts/leadforge/.paperclip.yaml",
    },
    contract: {
      companyName: "LeadForge",
      companyDescription: null,
      companySlug: "leadforge",
      goals: [],
      orgPolicy: {
        chiefOfStaff: {
          enabled: true,
          ceoSlug: "ceo",
          directReportThreshold: 5,
          role: "pm" as const,
          title: "Chief of Staff" as const,
        },
        staleHeartbeatThresholdHours: 48,
        openWorkStaleDays: 7,
      },
    },
    remediationOwner: {
      role: "pm" as const,
      title: "Chief of Staff" as const,
      soleOwner: true as const,
      status: "assigned" as const,
      agentId: "44444444-4444-4444-8444-444444444444",
      agentSlug: "chief-of-staff",
      agentName: "Chief of Staff",
    },
    counts: {
      companyMetadata: 0,
      goals: 1,
      projectGoalLinks: 1,
      issueGoalBackfills: 2,
      agents: 0,
      staffingRecommendations: 1,
      warnings: 1,
      total: 6,
    },
    actions: [],
    warnings: [],
  };
}

describe("company operating contract routes", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAgentService.getById.mockReset();
    mockOperatingContractService.getConfig.mockReset();
    mockOperatingContractService.updateConfig.mockReset();
    mockOperatingContractService.preview.mockReset();
    mockOperatingContractService.apply.mockReset();
    mockLogActivity.mockReset();
  });

  it("returns the stored operating contract config for board users", async () => {
    mockOperatingContractService.getConfig.mockResolvedValue(makeConfig());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/companies/${companyId}/operating-contract`);

    expect(res.status).toBe(200);
    expect(mockOperatingContractService.getConfig).toHaveBeenCalledWith(companyId);
    expect(res.body.projectWorkspaceId).toBe(workspaceId);
    expect(res.body.packageRootPath).toBe("contracts/leadforge");
  });

  it("updates the operating contract source and writes an activity log", async () => {
    mockOperatingContractService.updateConfig.mockResolvedValue(makeConfig());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .put(`/api/companies/${companyId}/operating-contract`)
      .send({
        projectWorkspaceId: workspaceId,
        packageRootPath: "contracts/leadforge",
      });

    expect(res.status).toBe(200);
    expect(mockOperatingContractService.updateConfig).toHaveBeenCalledWith(companyId, {
      projectWorkspaceId: workspaceId,
      packageRootPath: "contracts/leadforge",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "company.operating_contract.updated",
      details: expect.objectContaining({
        projectWorkspaceId: workspaceId,
        packageRootPath: "contracts/leadforge",
      }),
    }));
  });

  it("previews drift findings for board users", async () => {
    mockOperatingContractService.preview.mockResolvedValue(makePreview());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app).post(`/api/companies/${companyId}/operating-contract/preview`).send({});

    expect(res.status).toBe(200);
    expect(mockOperatingContractService.preview).toHaveBeenCalledWith(companyId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "company.operating_contract.previewed",
      details: expect.objectContaining({
        previewHash: "preview-hash-1",
        status: "warning",
      }),
    }));
  });

  it("applies selected action groups with preview hash protection", async () => {
    const preview = makePreview();
    mockOperatingContractService.apply.mockResolvedValue({
      companyId,
      appliedActionGroups: ["goals", "project_goal_links"],
      appliedCounts: {
        goals: 1,
        project_goal_links: 1,
      },
      preview,
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/operating-contract/apply`)
      .send({
        previewHash: "preview-hash-1",
        selectedActionGroups: ["goals", "project_goal_links"],
      });

    expect(res.status).toBe(200);
    expect(mockOperatingContractService.apply).toHaveBeenCalledWith(companyId, {
      previewHash: "preview-hash-1",
      selectedActionGroups: ["goals", "project_goal_links"],
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "company.operating_contract.applied",
      details: expect.objectContaining({
        previewHash: "preview-hash-1",
        selectedActionGroups: ["goals", "project_goal_links"],
      }),
    }));
  });
});
