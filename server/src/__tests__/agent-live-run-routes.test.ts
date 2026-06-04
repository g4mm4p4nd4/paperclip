import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  wakeup: vi.fn(),
}));

const mockFlywheelHealthService = vi.hoisted(() => ({
  listReports: vi.fn(),
  summarize: vi.fn(),
}));

const mockContextEconomyLiveCanaryService = vi.hoisted(() => ({
  ensure: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockAgentRoleDefaultsService = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

const mockContextLedgerService = vi.hoisted(() => ({
  listForRun: vi.fn(),
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const WAKEUP_AGENT_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  agentRoleDefaultsService: () => mockAgentRoleDefaultsService,
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  flywheelHealthService: () => mockFlywheelHealthService,
  contextEconomyLiveCanaryService: () => mockContextEconomyLiveCanaryService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/context-ledger.js", () => ({
  contextLedgerService: () => mockContextLedgerService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: vi.fn(),
  requireServerAdapter: vi.fn(),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: "synthetic-caller-run",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: WAKEUP_AGENT_ID,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: WAKEUP_AGENT_ID,
      companyId: "company-1",
      name: "Builder",
      adapterType: "codex_local",
    });
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: WAKEUP_AGENT_ID,
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(null);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: WAKEUP_AGENT_ID,
      status: "running",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-created",
      companyId: "company-1",
      agentId: WAKEUP_AGENT_ID,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: "wakeup-1",
    });
    mockContextLedgerService.listForRun.mockResolvedValue([
      {
        id: "ledger-1",
        runId: "run-1",
        promptClass: "failure_recovery",
        budgetStatus: "ok",
        responseClass: "compact_failure",
        outputBudgetStatus: "ok",
        outputBudgetVersion: "output-economy.v1",
        outputBudgetLimitTokens: 700,
        promptFingerprint: "a".repeat(64),
        components: [],
      },
    ]);
    mockLogActivity.mockResolvedValue(undefined);
    mockContextLedgerService.listForIssue.mockResolvedValue([
      {
        id: "ledger-1",
        issueId: "issue-1",
        promptClass: "failure_recovery",
        budgetStatus: "ok",
        responseClass: "compact_failure",
        outputBudgetStatus: "ok",
        outputBudgetVersion: "output-economy.v1",
        outputBudgetLimitTokens: 700,
        promptFingerprint: "a".repeat(64),
        components: [],
      },
    ]);
    mockFlywheelHealthService.summarize.mockResolvedValue({
      companyId: "company-1",
      window: {
        since: "2026-04-10T08:30:00.000Z",
        until: "2026-04-10T09:30:00.000Z",
        hours: 1,
      },
      tasksAttempted: 2,
      tasksCompleted: 1,
      providerFailures: {
        count: 1,
        recent: [{ runId: "run-1", kind: "provider_billing" }],
      },
      ledgerCompleteness: {
        runs: 2,
        runsWithLedger: 2,
        percent: 100,
      },
      receipts: {
        count: 1,
        paths: ["/tmp/receipt.json"],
      },
    });
    mockFlywheelHealthService.listReports.mockResolvedValue([
      {
        id: "report-1",
        companyId: "company-1",
        windowStart: "2026-04-10T08:00:00.000Z",
        windowEnd: "2026-04-10T09:00:00.000Z",
        source: "scheduler",
        reportJson: { tasksAttempted: 2, tasksCompleted: 1 },
        tasksAttempted: 2,
        tasksCompleted: 1,
        providerFailureCount: 1,
      },
    ]);
    mockContextEconomyLiveCanaryService.ensure.mockResolvedValue({
      dryRun: false,
      createdIssues: [],
      plans: [],
    });
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await request(createApp()).get("/api/issues/PAP-1295/active-run");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: "2026-04-10T09:30:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-10T09:29:59.000Z",
      agentId: WAKEUP_AGENT_ID,
      issueId: "issue-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
    expect(res.body).not.toHaveProperty("resultJson");
    expect(res.body).not.toHaveProperty("contextSnapshot");
    expect(res.body).not.toHaveProperty("logRef");
  });

  it("returns context ledger entries for a heartbeat run", async () => {
    const res = await request(createApp()).get("/api/heartbeat-runs/run-1/context-ledger");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockContextLedgerService.listForRun).toHaveBeenCalledWith("run-1");
    expect(res.body[0]).toMatchObject({
      id: "ledger-1",
      runId: "run-1",
      promptClass: "failure_recovery",
      budgetStatus: "ok",
      promptFingerprint: "a".repeat(64),
    });
  });

  it("returns context ledger entries for an issue identifier", async () => {
    const res = await request(createApp()).get("/api/issues/PAP-1295/context-ledger");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-1295");
    expect(mockContextLedgerService.listForIssue).toHaveBeenCalledWith("company-1", "issue-1");
    expect(res.body[0]).toMatchObject({
      id: "ledger-1",
      issueId: "issue-1",
      promptClass: "failure_recovery",
    });
  });

  it("returns flywheel health for a company", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/flywheel-health?hours=2");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockFlywheelHealthService.summarize).toHaveBeenCalledWith("company-1", {
      windowHours: 2,
    });
    expect(res.body).toMatchObject({
      companyId: "company-1",
      tasksAttempted: 2,
      tasksCompleted: 1,
      providerFailures: {
        count: 1,
        recent: [{ runId: "run-1", kind: "provider_billing" }],
      },
      ledgerCompleteness: {
        percent: 100,
      },
    });
  });

  it("returns persisted flywheel health reports for a company", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/flywheel-health/reports?limit=3");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockFlywheelHealthService.listReports).toHaveBeenCalledWith("company-1", {
      limit: 3,
    });
    expect(res.body[0]).toMatchObject({
      id: "report-1",
      companyId: "company-1",
      source: "scheduler",
      tasksAttempted: 2,
      tasksCompleted: 1,
      providerFailureCount: 1,
    });
  });

  it("passes forced context economy canary requests through the protected route", async () => {
    mockFlywheelHealthService.summarize.mockResolvedValueOnce({
      companyId: "company-1",
      canaryReadiness: {
        readyCount: 4,
        contextPackMatrix: [{ repoSlug: "paperclip", ok: true, reasons: [] }],
        targetCompletionMatrix: [{ repoSlug: "paperclip", ok: true, readyCount: 1, issueIdentifiers: ["POR-2516"], runIds: ["run-1"], reasons: [] }],
      },
    });
    mockContextEconomyLiveCanaryService.ensure.mockResolvedValueOnce({
      dryRun: false,
      createdIssues: [
        {
          repoSlug: "paperclip",
          issueId: "issue-canary",
          issueIdentifier: "POR-3000",
          projectWorkspaceId: "workspace-1",
          assigneeAgentId: WAKEUP_AGENT_ID,
        },
      ],
      plans: [{ repoSlug: "paperclip", action: "create_issue", reasons: [] }],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/flywheel-health/context-economy-canaries")
      .send({
        repoSlugs: ["paperclip"],
        force: true,
        hours: 3,
        createMissingWorkspaces: false,
        assigneeAgentId: WAKEUP_AGENT_ID,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockFlywheelHealthService.summarize).toHaveBeenCalledWith("company-1", {
      windowHours: 3,
    });
    expect(mockContextEconomyLiveCanaryService.ensure).toHaveBeenCalledWith(
      "company-1",
      {
        packMatrix: [{ repoSlug: "paperclip", ok: true, reasons: [] }],
        targetCompletionMatrix: [{ repoSlug: "paperclip", ok: true, readyCount: 1, issueIdentifiers: ["POR-2516"], runIds: ["run-1"], reasons: [] }],
      },
      {
        repoSlugs: ["paperclip"],
        force: true,
        dryRun: false,
        createMissingWorkspaces: false,
        assigneeAgentId: WAKEUP_AGENT_ID,
      },
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(WAKEUP_AGENT_ID, expect.objectContaining({
      source: "assignment",
      reason: "context_economy_canary_missing_live_receipt",
      payload: expect.objectContaining({ issueId: "issue-canary" }),
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.created",
      entityId: "issue-canary",
    }));
  });

  it("logs agent wakeups against the created heartbeat run", async () => {
    const res = await request(createApp())
      .post(`/api/agents/${WAKEUP_AGENT_ID}/wakeup`)
      .send({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: "issue-1" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(WAKEUP_AGENT_ID, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: "issue-1" },
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: "run-created",
      entityType: "heartbeat_run",
      entityId: "run-created",
      action: "heartbeat.invoked",
    }));
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: "synthetic-caller-run",
    }));
  });
});
