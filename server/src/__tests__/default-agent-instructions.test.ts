import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions", () => {
  it("resolves known roles to role-specific bundles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("engineer");
    expect(resolveDefaultAgentInstructionsBundleRole("integration_engineer")).toBe("integration_engineer");
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
});
