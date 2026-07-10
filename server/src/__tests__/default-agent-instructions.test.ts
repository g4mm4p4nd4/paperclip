import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentDesiredSkills,
  resolveDefaultAgentInstructionsBundleRole,
  resolveDefaultAgentSkillPolicy,
} from "../services/default-agent-instructions.js";

describe("default agent instructions", () => {
  it("resolves known roles to role-specific bundles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("cfo")).toBe("cfo");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("engineer");
    expect(resolveDefaultAgentInstructionsBundleRole("general")).toBe("general");
    expect(resolveDefaultAgentInstructionsBundleRole("integration_engineer")).toBe("integration_engineer");
    expect(resolveDefaultAgentInstructionsBundleRole("skill_curator")).toBe("skill_curator");
  });

  it("falls back to the default bundle for unknown roles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("unknown_role")).toBe("default");
  });

  it("loads role-specific bundle content for engineers", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("engineer");
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
    expect(bundle["AGENTS.md"]).toContain("paperclip-frontend-experience");
    expect(bundle["AGENTS.md"]).toContain("paperclip-backend-api-security");
  });

  it("loads the skill curator bundle content", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("skill_curator");
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
    expect(bundle["AGENTS.md"]).toContain("You are the Skill Curator.");
    expect(bundle["AGENTS.md"]).toContain("paperclip-create-agent");
  });

  it("returns built-in desired skills for each role profile", () => {
    expect(resolveDefaultAgentDesiredSkills("ceo")).toEqual([
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ]);
    expect(resolveDefaultAgentDesiredSkills("engineer")).toContain("paperclipai/paperclip/paperclip-create-plugin");
    expect(resolveDefaultAgentDesiredSkills("skill_curator")).toContain("paperclipai/paperclip/paperclip-create-agent");
    expect(resolveDefaultAgentDesiredSkills("unknown_role")).toEqual(["paperclipai/paperclip/paperclip-product-scope"]);
  });

  it("separates canonical bundled defaults from optional company-local skills", () => {
    expect(resolveDefaultAgentSkillPolicy("ceo").optionalDesiredSkills).toContain("office-hours");
    expect(resolveDefaultAgentSkillPolicy("qa").optionalDesiredSkills).toContain("qa");
    expect(resolveDefaultAgentSkillPolicy("engineer").optionalDesiredSkills).toContain("investigate");
    expect(resolveDefaultAgentSkillPolicy("skill_curator").optionalDesiredSkills).toContain("plan-eng-review");
  });
});
