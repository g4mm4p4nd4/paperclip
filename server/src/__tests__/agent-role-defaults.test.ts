import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoleDefaultsService } from "../services/agent-role-defaults.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listFull: vi.fn(),
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => mockCompanySkillService,
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => mockAgentInstructionsService,
}));

const skillKeyMap: Record<string, string> = {
  "paperclipai/paperclip/paperclip": "paperclipai/paperclip/paperclip",
  "paperclipai/paperclip/paperclip-create-agent": "paperclipai/paperclip/paperclip-create-agent",
  "paperclipai/paperclip/paperclip-create-plugin": "paperclipai/paperclip/paperclip-create-plugin",
  "paperclipai/paperclip/paperclip-product-scope": "paperclipai/paperclip/paperclip-product-scope",
  "paperclipai/paperclip/paperclip-go-to-market": "paperclipai/paperclip/paperclip-go-to-market",
  "paperclipai/paperclip/paperclip-backend-api-security": "paperclipai/paperclip/paperclip-backend-api-security",
  "paperclipai/paperclip/paperclip-frontend-experience": "paperclipai/paperclip/paperclip-frontend-experience",
  "paperclipai/paperclip/paperclip-integration-engineer": "paperclipai/paperclip/paperclip-integration-engineer",
  "paperclipai/paperclip/para-memory-files": "paperclipai/paperclip/para-memory-files",
  investigate: "local/investigate",
  review: "local/review",
  checkpoint: "local/checkpoint",
  autoplan: "local/autoplan",
  health: "local/health",
  "office-hours": "local/office-hours",
  "plan-ceo-review": "local/plan-ceo-review",
  "plan-eng-review": "local/plan-eng-review",
  qa: "local/qa",
};

const fullSkillList = [
  { id: "skill-paperclip", key: "paperclipai/paperclip/paperclip", slug: "paperclip" },
  { id: "skill-create-agent", key: "paperclipai/paperclip/paperclip-create-agent", slug: "paperclip-create-agent" },
  { id: "skill-create-plugin", key: "paperclipai/paperclip/paperclip-create-plugin", slug: "paperclip-create-plugin" },
  { id: "skill-product-scope", key: "paperclipai/paperclip/paperclip-product-scope", slug: "paperclip-product-scope" },
  { id: "skill-go-to-market", key: "paperclipai/paperclip/paperclip-go-to-market", slug: "paperclip-go-to-market" },
  { id: "skill-backend", key: "paperclipai/paperclip/paperclip-backend-api-security", slug: "paperclip-backend-api-security" },
  { id: "skill-frontend", key: "paperclipai/paperclip/paperclip-frontend-experience", slug: "paperclip-frontend-experience" },
  { id: "skill-integrations", key: "paperclipai/paperclip/paperclip-integration-engineer", slug: "paperclip-integration-engineer" },
  { id: "skill-memory", key: "paperclipai/paperclip/para-memory-files", slug: "para-memory-files" },
  { id: "skill-investigate", key: "local/investigate", slug: "investigate" },
  { id: "skill-review", key: "local/review", slug: "review" },
  { id: "skill-checkpoint", key: "local/checkpoint", slug: "checkpoint" },
  { id: "skill-autoplan", key: "local/autoplan", slug: "autoplan" },
  { id: "skill-health", key: "local/health", slug: "health" },
  { id: "skill-office-hours", key: "local/office-hours", slug: "office-hours" },
  { id: "skill-plan-ceo-review", key: "local/plan-ceo-review", slug: "plan-ceo-review" },
  { id: "skill-plan-eng-review", key: "local/plan-eng-review", slug: "plan-eng-review" },
  { id: "skill-qa", key: "local/qa", slug: "qa" },
];

let currentAgent: Record<string, unknown> | null = null;

describe("agent role defaults service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCompanySkillService.listFull.mockResolvedValue(fullSkillList);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
        required: true,
        requiredReason: "required",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested.map((value) => skillKeyMap[value] ?? value),
    );
    currentAgent = null;
    mockAgentService.update.mockImplementation(async (_agentId: string, patch: Record<string, unknown>) => {
      currentAgent = {
        ...(currentAgent ?? {}),
        ...patch,
      };
      return currentAgent;
    });
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "skill-curator-agent",
      companyId: _companyId,
      name: input.name,
      role: input.role,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
    }));
  });

  it("merges available company-local optional skills into role defaults", async () => {
    const svc = agentRoleDefaultsService({} as never);

    const result = await svc.resolveDesiredSkillAssignment(
      "company-1",
      "engineer",
      "codex_local",
      {},
      undefined,
    );

    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        "paperclipai/paperclip/paperclip-product-scope",
        "paperclipai/paperclip/paperclip-frontend-experience",
        "paperclipai/paperclip/paperclip-backend-api-security",
        "paperclipai/paperclip/paperclip-integration-engineer",
        "paperclipai/paperclip/paperclip-create-plugin",
        "local/investigate",
        "local/review",
        "local/checkpoint",
      ]),
    );
    expect(result.desiredSkills).toEqual(
      expect.arrayContaining([
        "paperclipai/paperclip/paperclip",
        "paperclipai/paperclip/paperclip-product-scope",
        "paperclipai/paperclip/paperclip-frontend-experience",
        "paperclipai/paperclip/paperclip-backend-api-security",
        "paperclipai/paperclip/paperclip-integration-engineer",
        "paperclipai/paperclip/paperclip-create-plugin",
        "local/investigate",
        "local/review",
        "local/checkpoint",
      ]),
    );
  });

  it("repairs missing skills and managed instructions for an existing agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
      name: "Engineer-1",
      adapterConfig: {},
    });
    currentAgent = {
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
      name: "Engineer-1",
      adapterConfig: {},
    };
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      mode: null,
    });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (_agent: Record<string, unknown>, _files: Record<string, string>, options: { replaceExisting: boolean }) => ({
        bundle: null,
        adapterConfig: {
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1/instructions",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/instructions/AGENTS.md",
          replaceExisting: options.replaceExisting,
        },
      }),
    );

    const svc = agentRoleDefaultsService({} as never);
    const result = await svc.repairAgentRoleDefaults("agent-1");

    expect(result?.desiredSkills).toEqual(
      expect.arrayContaining([
        "paperclipai/paperclip/paperclip",
        "paperclipai/paperclip/paperclip-product-scope",
        "local/investigate",
      ]),
    );
    expect(mockAgentService.update).toHaveBeenCalledTimes(2);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        role: "engineer",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are an Engineer."),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    expect(result?.instructionsAction).toBe("created_managed");
  });

  it("can replace stale managed instructions for an existing agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-2",
      companyId: "company-1",
      role: "ceo",
      adapterType: "codex_local",
      name: "CEO",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-2/instructions",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-2/instructions/AGENTS.md",
      },
    });
    currentAgent = {
      id: "agent-2",
      companyId: "company-1",
      role: "ceo",
      adapterType: "codex_local",
      name: "CEO",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-2/instructions",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-2/instructions/AGENTS.md",
      },
    };
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      mode: "managed",
    });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (_agent: Record<string, unknown>, _files: Record<string, string>, options: { replaceExisting: boolean }) => ({
        bundle: null,
        adapterConfig: {
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-2/instructions",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-2/instructions/AGENTS.md",
          replaceExisting: options.replaceExisting,
        },
      }),
    );

    const svc = agentRoleDefaultsService({} as never);
    const result = await svc.repairAgentRoleDefaults("agent-2", {
      overwriteManagedInstructions: true,
    });

    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-2",
        role: "ceo",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "HEARTBEAT.md": expect.stringContaining("CEO Heartbeat Checklist"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    expect(result?.instructionsAction).toBe("replaced_managed");
  });

  it("treats Hermes as a managed skill and instruction adapter", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-hermes",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
      name: "Engineer-1",
      adapterConfig: {},
    });
    currentAgent = {
      id: "agent-hermes",
      companyId: "company-1",
      role: "engineer",
      adapterType: "codex_local",
      name: "Engineer-1",
      adapterConfig: {},
    };
    mockAgentInstructionsService.getBundle.mockResolvedValue({ mode: null });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (_agent: Record<string, unknown>, _files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-hermes/instructions",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-hermes/instructions/AGENTS.md",
        },
      }),
    );

    const svc = agentRoleDefaultsService({} as never);
    const result = await svc.repairAgentRoleDefaults("agent-hermes", {
      adapterType: "hermes_local",
    });

    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: true,
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "agent-hermes",
      expect.objectContaining({
        adapterType: "hermes_local",
        adapterConfig: expect.objectContaining({
          model: "deepseek-v4-flash",
          provider: "openrouter",
          reasoningEffort: "high",
          yolo: true,
          checkpoints: true,
          passSessionId: true,
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: expect.arrayContaining(["local/investigate"]),
          }),
        }),
        permissions: expect.objectContaining({
          canBypassExecutionApprovals: true,
        }),
      }),
    );
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-hermes",
        adapterType: "hermes_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are an Engineer."),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    expect(result?.instructionsAction).toBe("created_managed");
  });

  it("creates a Hermes skill curator agent for a company without one", async () => {
    mockAgentService.list.mockResolvedValue([
      {
        id: "ceo-1",
        companyId: "company-1",
        name: "CEO",
        role: "ceo",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
    ]);
    mockAgentInstructionsService.getBundle.mockResolvedValue({ mode: null });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...(agent.adapterConfig as Record<string, unknown>),
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/skill-curator/instructions",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/skill-curator/instructions/AGENTS.md",
          fileNames: Object.keys(files),
        },
      }),
    );

    const svc = agentRoleDefaultsService({} as never);
    const result = await svc.ensureCompanySkillCuratorAgent("company-1", {
      adapterType: "hermes_local",
    });

    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Skill Curator",
        role: "skill_curator",
        reportsTo: "ceo-1",
        adapterType: "hermes_local",
        permissions: {
          canCreateAgents: true,
          canBypassExecutionApprovals: true,
        },
        adapterConfig: expect.objectContaining({
          model: "deepseek-v4-flash",
          provider: "openrouter",
          reasoningEffort: "high",
          yolo: true,
          checkpoints: true,
          passSessionId: true,
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: expect.arrayContaining([
              "paperclipai/paperclip/paperclip-create-agent",
              "local/autoplan",
              "local/health",
              "local/plan-eng-review",
            ]),
          }),
        }),
      }),
    );
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ role: "skill_curator" }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the Skill Curator."),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    expect(result.created).toBe(true);
  });
});
