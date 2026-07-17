import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  findLaunchExecutionDuplicate: vi.fn(),
  mergeLaunchExecutionRequestPayload: vi.fn(),
  upsertLaunchExecution: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ approvalRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/approvals.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp() {
  const [{ approvalRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/approvals.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockApprovalService.findLaunchExecutionDuplicate.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(403);
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        type: "request_board_approval",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "pending",
        decisionNote: null,
      }),
    );
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("rejects hand-authored factory launch approvals before persistence", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "profit_flywheel_shadow_launch",
        payload: { forged: "operator-supplied-hashes" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("server-verified state");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects resubmission mutation of server-generated factory launch bindings", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "factory-approval-1",
      companyId: "company-1",
      type: "profit_flywheel_shadow_launch",
      status: "revision_requested",
      payload: { source_generated: true },
      requestedByAgentId: null,
    });

    const res = await request(await createApp({ isInstanceAdmin: true }))
      .post("/api/approvals/factory-approval-1/resubmit")
      .send({ payload: { contract_hashes: { forged: "b".repeat(64) } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bindings are immutable");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("merges duplicate launch execution requests into the canonical approval", async () => {
    mockApprovalService.upsertLaunchExecution.mockResolvedValue({
      created: false,
      mergedFromApprovalId: "approval-canonical",
      approval: {
        id: "approval-canonical",
        companyId: "company-1",
        type: "launch_execution",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "approved",
        payload: {
          repo: "g4mm4p4nd4/CE",
          venture_name: "Security Analytics Workstation",
          launch_execution_merge_state: "canonical",
        },
        decisionNote: null,
        decidedByUserId: "board",
        decidedAt: new Date("2026-07-06T14:56:15.807Z"),
        createdAt: new Date("2026-07-06T08:00:00.000Z"),
        updatedAt: new Date("2026-07-06T15:00:00.000Z"),
      },
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "launch_execution",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: {
          repo: "g4mm4p4nd4/CE",
          venture_name: "Security Analytics Workstation",
          source_issue: "PORA-1980",
        },
      });

    expect(res.status).toBe(200);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.upsertLaunchExecution).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        type: "launch_execution",
        payload: expect.objectContaining({
          repo: "g4mm4p4nd4/CE",
          source_issue: "PORA-1980",
        }),
      }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-canonical",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.launch_execution_duplicate_merged",
        entityId: "approval-canonical",
      }),
    );
    expect(res.body.payload.launch_execution_merge_state).toBe("canonical");
  });
});
