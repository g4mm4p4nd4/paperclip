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
import {
  isModelQuotaStallText,
  resolveAgentOpenCodeGoRoleRouting,
  resolveAgentTieredExecutionRouting,
} from "../services/agent-model-routing.js";

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

  it("routes stalled OpenCode work to Codex first when Codex is available", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        instructionsFilePath: "/tmp/project/AGENTS.md",
        command: "opencode",
        model: "opencode-go/deepseek-v4-flash",
        variant: "high",
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stallReason: "opencode_go_usage_limit",
    });

    expect(result.changed).toBe(true);
    expect(result.adapterType).toBe("codex_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      dangerouslyBypassApprovalsAndSandbox: true,
    });
    expect(result.adapterConfig).not.toHaveProperty("command");
    expect(result.adapterConfig).not.toHaveProperty("variant");
    expect(result.route).toMatchObject({
      source: "tiered_execution_policy",
      originalAdapterType: "opencode_local",
      selectedAdapterType: "codex_local",
    });
  });

  it("falls back through Claude Code and Gemini when Codex is unavailable", () => {
    const claudeResult = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-pro",
        provider: "auto",
      },
      availableAdapters: {
        codex_local: false,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
    });

    expect(claudeResult.adapterType).toBe("claude_local");
    expect(claudeResult.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "claude-opus-4-6",
      effort: "high",
      dangerouslySkipPermissions: true,
    });
    expect(claudeResult.adapterConfig).not.toHaveProperty("provider");

    const geminiResult = resolveAgentTieredExecutionRouting({
      role: "researcher",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "opencode-go/deepseek-v4-flash",
      },
      availableAdapters: {
        codex_local: false,
        claude_local: false,
        gemini_local: true,
      },
      recentStall: true,
    });

    expect(geminiResult.adapterType).toBe("gemini_local");
    expect(geminiResult.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gemini-2.5-pro",
      sandbox: false,
    });
  });

  it("supports explicit tiered adapter order and adapter-specific overrides", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        tieredExecution: {
          adapterOrder: ["gemini_local", "codex_local"],
          gemini_local: {
            model: "gemini-2.5-flash-lite",
          },
        },
      },
      availableAdapters: {
        codex_local: true,
        gemini_local: true,
      },
      contextSnapshot: {
        paperclipExecutionRouting: {
          forceTieredFallback: true,
        },
      },
    });

    expect(result.adapterType).toBe("gemini_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gemini-2.5-flash-lite",
    });
    expect(result.route?.candidates).toEqual(["gemini_local", "codex_local"]);
  });

  it("detects model quota and usage stall text", () => {
    expect(isModelQuotaStallText("FreeUsageLimitError: weekly usage limit reached")).toBe(true);
    expect(isModelQuotaStallText("HTTP 429 too many requests")).toBe(true);
    expect(isModelQuotaStallText("ordinary unit test failure")).toBe(false);
  });
});
