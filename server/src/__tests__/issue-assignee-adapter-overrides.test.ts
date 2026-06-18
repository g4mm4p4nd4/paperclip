import { describe, expect, it } from "vitest";
import { createIssueSchema } from "@paperclipai/shared";
import { applyIssueAssigneeAdapterOverridesToAgent } from "../services/heartbeat.js";

describe("issue assignee adapter overrides", () => {
  it("accepts adapter type overrides in the shared issue contract", () => {
    const parsed = createIssueSchema.parse({
      title: "Run deterministic reconciler",
      assigneeAdapterOverrides: {
        adapterType: "process",
        adapterConfig: {
          command: "/bin/zsh",
          args: ["-lc", "echo done"],
        },
        useProjectWorkspace: true,
      },
    });

    expect(parsed.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
      },
      useProjectWorkspace: true,
    });
  });

  it("applies issue-owned adapter type and config before provider routing", () => {
    const agent = {
      id: "agent_test",
      companyId: "company_test",
      name: "Builder",
      role: "engineering",
      adapterType: "hermes_local",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
        cwd: "/tmp/hermes",
      },
    };

    const resolved = applyIssueAssigneeAdapterOverridesToAgent(agent, {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "pnpm test"],
        cwd: "/tmp/process",
      },
      useProjectWorkspace: null,
    });

    expect(resolved).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
        command: "/bin/zsh",
        args: ["-lc", "pnpm test"],
        cwd: "/tmp/process",
      },
    });
    expect(agent.adapterType).toBe("hermes_local");
  });
});
