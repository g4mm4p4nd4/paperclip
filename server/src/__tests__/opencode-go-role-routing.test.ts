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
  selectRecentModelStallForRouting,
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

  it("formats Hermes OpenCode Go routes as bare model ids pinned to OpenCode Go", () => {
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
      provider: "opencode-go",
      disableFallbackModel: true,
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

  it("cleans stale Hermes provider and effort fields while preserving explicit paid OpenCode Go models", () => {
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
      model: "minimax-m2.7",
      provider: "opencode-go",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      model: "opencode-go/minimax-m2.7",
      provider: "opencode-go",
      source: "opencode_go_explicit_model",
    });
  });

  it("pins explicit Hermes OpenCode Go model choices to the paid provider without role overwrites", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "qwen3.7-max",
        provider: "auto",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({
      model: "qwen3.7-max",
      provider: "opencode-go",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      model: "opencode-go/qwen3.7-max",
      provider: "opencode-go",
      source: "opencode_go_explicit_model",
    });
  });

  it("normalizes qualified Hermes OpenCode Go model ids to Hermes args shape", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "opencode-go/deepseek-v4-flash",
        provider: "auto",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({
      model: "deepseek-v4-flash",
      provider: "opencode-go",
      disableFallbackModel: true,
    });
  });

  it("allows explicit Hermes OpenCode Zen free models only when selected", () => {
    const result = resolveAgentOpenCodeGoRoleRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        model: "opencode-zen/deepseek-v4-flash-free",
        provider: "auto",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterConfig).toEqual({
      model: "deepseek-v4-flash-free",
      provider: "opencode-zen",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      model: "opencode-zen/deepseek-v4-flash-free",
      provider: "opencode-zen",
      source: "opencode_zen_explicit_free_model",
    });
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
      state: "degraded",
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

  it("enters failover when the newest normal run hit a quota or usage limit", () => {
    expect(
      selectRecentModelStallForRouting([
        {
          id: "run-quota",
          status: "failed",
          errorCode: "adapter_failed",
          stderrExcerpt: "HTTP 429: 5-hour usage limit reached",
          contextSnapshot: {},
        },
      ]),
    ).toEqual({
      runId: "run-quota",
      reason: "adapter_failed",
    });
  });

  it("stays in failover after fallback succeeds while the original stall is still recent", () => {
    expect(
      selectRecentModelStallForRouting([
        {
          id: "run-fallback-success",
          status: "succeeded",
          contextSnapshot: {
            paperclipExecutionRouting: {
              source: "tiered_execution_policy",
              originalAdapterType: "hermes_local",
              selectedAdapterType: "codex_local",
            },
          },
        },
        {
          id: "run-quota",
          status: "failed",
          stdoutExcerpt: "FreeUsageLimitError: weekly usage limit reached",
          contextSnapshot: {},
        },
      ]),
    ).toEqual({
      runId: "run-quota",
      reason: "recent_model_quota_or_usage_stall",
    });
  });

  it("recovers after a newer clean normal inference succeeds", () => {
    expect(
      selectRecentModelStallForRouting([
        {
          id: "run-normal-success",
          status: "succeeded",
          stdoutExcerpt: "completed without fallback",
          contextSnapshot: {},
        },
        {
          id: "run-quota",
          status: "failed",
          stdoutExcerpt: "GoUsageLimitError: 5-hour usage limit reached",
          contextSnapshot: {},
        },
      ]),
    ).toBeNull();
  });

  it("allows a normal recovery probe after the stall cooldown even when fallback kept succeeding", () => {
    expect(
      selectRecentModelStallForRouting(
        [
          {
            id: "run-fallback-success",
            status: "succeeded",
            createdAt: "2026-06-01T14:20:00Z",
            contextSnapshot: {
              paperclipExecutionRouting: {
                source: "tiered_execution_policy",
                originalAdapterType: "hermes_local",
                selectedAdapterType: "codex_local",
              },
            },
          },
          {
            id: "run-quota",
            status: "succeeded",
            createdAt: "2026-06-01T14:00:00Z",
            stdoutExcerpt: "GoUsageLimitError: 5-hour usage limit reached",
            contextSnapshot: {},
          },
        ],
        {
          now: new Date("2026-06-01T14:31:00Z"),
          recoveryProbeAfterMs: 30 * 60 * 1000,
        },
      ),
    ).toBeNull();
  });

  it("treats a successful run with internal provider fallback text as an active stall", () => {
    expect(
      selectRecentModelStallForRouting([
        {
          id: "run-hermes-internal-fallback",
          status: "succeeded",
          stdoutExcerpt: "HTTP 429: 5-hour usage limit reached\nRate limited — switching to fallback provider",
          contextSnapshot: {},
        },
      ]),
    ).toEqual({
      runId: "run-hermes-internal-fallback",
      reason: "recent_model_quota_or_usage_stall",
    });
  });
});
