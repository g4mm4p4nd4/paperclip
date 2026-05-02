import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  findReusableManualIssue: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    getExperimental: vi.fn(async () => ({})),
    listCompanyIds: vi.fn(async () => [companyId]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
      source: "agent_key",
      runId: "run-1",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue create dedupe route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("creates a fresh issue when there is no reusable canonical issue", async () => {
    mockIssueService.findReusableManualIssue.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      companyId,
      identifier: "PAP-12",
      title: "Targeted Market Signal Intake - agency-swarm & IdeaSparkPro",
      status: "todo",
      assigneeAgentId: null,
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Targeted Market Signal Intake - agency-swarm & IdeaSparkPro",
        description: "Use the latest evidence batch.",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findReusableManualIssue).toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
      }),
    );
  });

  it("collapses duplicate agent issue creation into the canonical issue", async () => {
    mockIssueService.findReusableManualIssue.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      companyId,
      identifier: "PAP-12",
      title: "Targeted Market Signal Intake - agency-swarm & IdeaSparkPro",
      description: "Use the earlier evidence batch.",
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      startedAt: null,
    });
    mockIssueService.update.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      companyId,
      identifier: "PAP-12",
      title: "Targeted Market Signal Intake - agency-swarm & IdeaSparkPro",
      description: "Use the latest evidence batch.",
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      startedAt: null,
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "33333333-3333-4333-8333-333333333333",
      body: "duplicate collapsed",
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Targeted Market Signal Intake - agency-swarm & IdeaSparkPro",
        description: "Use the latest evidence batch.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        description: "Use the latest evidence batch.",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.stringContaining("duplicate issue creation request"),
      expect.objectContaining({
        agentId,
        runId: "run-1",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.duplicate_collapsed",
        entityId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });
});
