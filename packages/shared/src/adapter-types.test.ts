import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_LABELS,
  acceptInviteSchema,
  createAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentSchema,
} from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts an explicit managed instructions bundle for new agents", () => {
    expect(
      createAgentSchema.parse({
        name: "Bundle Agent",
        adapterType: "codex_local",
        instructionsBundle: {
          files: {
            "AGENTS.md": "Use AGENTS.md.",
          },
        },
      }).instructionsBundle?.files["AGENTS.md"],
    ).toBe("Use AGENTS.md.");
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("accepts the security agent role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
  });

  it("accepts the skill curator role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Skill Curator",
        role: "skill_curator",
        adapterType: "hermes_local",
      }).role,
    ).toBe("skill_curator");

    expect(AGENT_ROLE_LABELS.skill_curator).toBe("Skill Curator");
  });

  it("accepts execution-approval bypass as a typed agent permission", () => {
    expect(
      createAgentSchema.parse({
        name: "Trusted Hermes Agent",
        adapterType: "hermes_local",
        permissions: { canBypassExecutionApprovals: true },
      }).permissions,
    ).toEqual({
      canCreateAgents: false,
      canBypassExecutionApprovals: true,
    });

    expect(
      updateAgentPermissionsSchema.parse({
        canCreateAgents: false,
        canAssignTasks: false,
        canBypassExecutionApprovals: true,
      }).canBypassExecutionApprovals,
    ).toBe(true);
  });
});
