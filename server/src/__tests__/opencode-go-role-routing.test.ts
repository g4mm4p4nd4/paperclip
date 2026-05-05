import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_ROLE_ROUTING,
  resolveOpenCodeGoRoutingForRole,
} from "@paperclipai/adapter-opencode-local";
import {
  DEFAULT_AGENT_BUNDLE_ROLES,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { resolveAgentOpenCodeGoRoleRouting } from "../services/agent-model-routing.js";

describe("Paperclip OpenCode Go model routing", () => {
  it("stays synchronized with default agent instruction roles", () => {
    for (const role of DEFAULT_AGENT_BUNDLE_ROLES) {
      const resolvedRole = resolveDefaultAgentInstructionsBundleRole(role);
      expect(OPENCODE_GO_ROLE_ROUTING).toHaveProperty(resolvedRole);
    }
  });

  it("formats opencode_local routes with provider/model and variant", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {},
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toMatchObject({
      model: "opencode-go/deepseek-v4-flash",
      variant: "high",
    });
  });

  it("formats Hermes OpenCode Go routes as bare model ids with provider auto", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "gpt-5.4",
        provider: "openai-codex",
        variant: "high",
      },
      force: true,
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({
      model: "deepseek-v4-pro",
      provider: "auto",
    });
  });

  it("repairs malformed opencode_local model shapes to qualified role routes", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "pm",
      adapterType: "opencode_local",
      adapterConfig: {
        model: "deepseek-v4-flash",
        variant: "medium",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toMatchObject({
      model: "opencode-go/kimi-k2.6",
      variant: "high",
    });
  });

  it("cleans stale Hermes provider and effort fields even when the model is valid", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "researcher",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "minimax-m2.7",
        provider: "openai-codex",
        effort: "high",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({
      model: "deepseek-v4-flash",
      provider: "auto",
    });
  });

  it("does not overwrite explicit non-stale OpenCode Go model choices without force", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "minimax-m2.7",
        provider: "auto",
      },
    });

    expect(result.changed).toBe(false);
    expect(result.adapterConfig.model).toBe("minimax-m2.7");
  });

  it("keeps the docs catalog synchronized with routing constants", () => {
    const docPath = path.resolve(process.cwd(), "docs/adapters/opencode-local.md");
    const doc = fs.readFileSync(docPath, "utf8");
    for (const id of OPENCODE_GO_MODEL_IDS) {
      expect(doc).toContain(id);
    }
    for (const route of Object.values(OPENCODE_GO_ROLE_ROUTING)) {
      expect(doc).toContain(route.model);
    }
    expect(resolveOpenCodeGoRoutingForRole("general").model).toBe("opencode-go/deepseek-v4-flash");
  });
});
