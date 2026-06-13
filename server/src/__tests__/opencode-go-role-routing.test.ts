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
  classifyProviderReliabilityFailureText,
  filterProviderReliabilityFailureRunsForRouting,
  isProviderReliabilityTextRelevantToTarget,
  isModelQuotaStallText,
  resolveAgentOpenCodeGoRoleRouting,
  resolveProviderReliabilityHealthTarget,
  resolveProviderReliabilityGateFailureKind,
  resolveAgentTieredExecutionRouting,
  selectRecentModelStallForRouting,
  shouldReprobeProviderStallsForRun,
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
        model: "minimax-m2.7",
        provider: "auto",
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

  it("maps Hermes qwen3.7-max selections to the OpenCode Go oa-compat 1M model", () => {
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
      model: "deepseek-v4-pro",
      provider: "opencode-go",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      model: "opencode-go/deepseek-v4-pro",
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

  it("routes stalled OpenCode work to Hermes MiniMax first when Hermes is available", () => {
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
        hermes_local: true,
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stallReason: "opencode_go_usage_limit",
    });

    expect(result.changed).toBe(true);
    expect(result.adapterType).toBe("hermes_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      model: "MiniMax-M3",
      provider: "minimax",
      disableFallbackModel: true,
    });
    expect(result.adapterConfig).not.toHaveProperty("command");
    expect(result.adapterConfig).not.toHaveProperty("variant");
    expect(result.route).toMatchObject({
      state: "degraded",
      source: "tiered_execution_policy",
      originalAdapterType: "opencode_local",
      selectedAdapterType: "hermes_local",
      selectedLane: "hermes_minimax",
      provider: "minimax",
      model: "MiniMax-M3",
    });
  });

  it("keeps MiniMax provider identity and rotates from M3 to M2.7 after model-access failures", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        tieredExecution: {
          hermes_minimax: {
            model: "minimax/MiniMax-M3",
            provider: "anthropic",
          },
        },
      },
      availableAdapters: {
        hermes_local: true,
      },
      recentStall: true,
      stallFailureKind: "provider_model_access",
      stalledLanes: ["hermes_minimax"],
      stalledLaneModels: {
        hermes_minimax: "MiniMax-M3",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.adapterType).toBe("hermes_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "MiniMax-M2.7",
      provider: "minimax",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      selectedLane: "hermes_minimax",
      provider: "minimax",
      model: "MiniMax-M2.7",
    });
  });

  it("routes to Hermes OpenRouter only after explicit post-MiniMax approval", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-pro",
        provider: "opencode-go",
        tieredExecution: {
          adapterOrder: ["hermes_opencode_zen_free", "hermes_openrouter"],
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free"],
    });

    expect(result.adapterType).toBe("hermes_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      selectedAdapterType: "hermes_local",
      selectedLane: "hermes_openrouter",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      candidates: [
        "hermes_minimax",
        "hermes_opencode_zen_free",
        "hermes_openrouter",
      ],
    });
  });

  it("builds distinct provider preflight targets for selected Hermes fallback lanes", () => {
    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "hermes_local",
        adapterConfig: {
          provider: "minimax",
          model: "MiniMax-M3",
        },
        selectedLane: "hermes_minimax",
      }),
    ).toMatchObject({
      adapterType: "hermes_local",
      lane: "hermes_minimax",
      provider: "minimax",
      model: "MiniMax-M3",
    });

    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "hermes_local",
        adapterConfig: {
          provider: "opencode-zen",
          model: "deepseek-v4-flash-free",
        },
        selectedLane: "hermes_opencode_zen_free",
      }),
    ).toMatchObject({
      adapterType: "hermes_local",
      lane: "hermes_opencode_zen_free",
      provider: "opencode-zen",
      model: "deepseek-v4-flash-free",
    });

    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "hermes_local",
        adapterConfig: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-pro",
        },
        selectedLane: "hermes_openrouter",
      }),
    ).toMatchObject({
      adapterType: "hermes_local",
      lane: "hermes_openrouter",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
    });
  });

  it("does not treat unrelated auth warnings as selected-lane provider preflight failures", () => {
    const target = resolveProviderReliabilityHealthTarget({
      adapterType: "hermes_local",
      adapterConfig: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      },
      selectedLane: "hermes_openrouter",
    });

    expect(target).not.toBeNull();
    expect(
      isProviderReliabilityTextRelevantToTarget(
        "OpenRouter API failed with HTTP 401.",
        target!,
      ),
    ).toBe(true);
    expect(
      isProviderReliabilityTextRelevantToTarget(
        "OpenAI Codex auth failed with HTTP 401.",
        target!,
      ),
    ).toBe(false);
  });

  it("does not carry stale provider failures into a validated healthy preflight gate", () => {
    expect(
      resolveProviderReliabilityGateFailureKind({
        hasTieredRoute: false,
        recentFailureKind: "provider_auth",
        preflightStatus: "healthy",
        preflightFailureKind: null,
      }),
    ).toBeNull();

    expect(
      resolveProviderReliabilityGateFailureKind({
        hasTieredRoute: true,
        recentFailureKind: "provider_quota",
        preflightStatus: "healthy",
        preflightFailureKind: null,
      }),
    ).toBe("provider_quota");
  });

  it("builds provider preflight targets for OpenCode Go and local fallback lanes", () => {
    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "opencode_local",
        adapterConfig: {
          model: "opencode-go/deepseek-v4-flash",
        },
      }),
    ).toMatchObject({
      adapterType: "opencode_local",
      lane: "opencode_local",
      provider: "opencode-go",
      model: "opencode-go/deepseek-v4-flash",
    });

    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.3-codex",
        },
      }),
    ).toMatchObject({
      adapterType: "codex_local",
      lane: "codex_local",
      provider: "openai",
      model: "gpt-5.3-codex",
    });

    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({
      adapterType: "claude_local",
      lane: "claude_local",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(
      resolveProviderReliabilityHealthTarget({
        adapterType: "gemini_local",
        adapterConfig: {
          model: "gemini-2.5-flash",
        },
      }),
    ).toMatchObject({
      adapterType: "gemini_local",
      lane: "gemini_local",
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  it("routes OpenRouter fallback to the role-intended OpenCode Go model", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "pm",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "auto",
        provider: "auto",
        tieredExecution: {
          disableMiniMaxPrimary: true,
          adapterOrder: ["hermes_openrouter"],
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: [],
    });

    expect(result.adapterType).toBe("hermes_local");
    expect(result.adapterConfig).toMatchObject({
      model: "moonshotai/kimi-k2.6",
      provider: "openrouter",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      selectedLane: "hermes_openrouter",
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("routes explicit Qwen OpenCode Go intent to native Qwen on OpenRouter", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "opencode-go/qwen3.7-max",
        provider: "opencode-go",
        tieredExecution: {
          disableMiniMaxPrimary: true,
          adapterOrder: ["hermes_openrouter"],
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: [],
    });

    expect(result.adapterType).toBe("hermes_local");
    expect(result.adapterConfig).toMatchObject({
      model: "qwen/qwen3.7-max",
      provider: "openrouter",
      disableFallbackModel: true,
    });
    expect(result.route).toMatchObject({
      selectedLane: "hermes_openrouter",
      provider: "openrouter",
      model: "qwen/qwen3.7-max",
    });
  });

  it("routes to Gemini before Claude and Codex only after approved MiniMax/Hermes API fallback stalls", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        instructionsFilePath: "/tmp/project/AGENTS.md",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free"],
    });

    expect(result.changed).toBe(true);
    expect(result.adapterType).toBe("gemini_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gemini-3.5-flash",
      sandbox: false,
    });
    expect(result.adapterConfig).not.toHaveProperty("provider");
    expect(result.route).toMatchObject({
      selectedAdapterType: "gemini_local",
      selectedLane: "gemini_local",
    });
    expect(result.route?.candidates).toEqual([
      "hermes_minimax",
      "hermes_opencode_zen_free",
      "gemini_local",
      "claude_local",
      "codex_local",
    ]);
  });

  it("skips low-intelligence free fallback lanes for executive and strategic roles", () => {
    for (const role of ["ceo", "chief of staff", "pm", "researcher"]) {
      const result = resolveAgentTieredExecutionRouting({
        role,
        adapterType: "hermes_local",
        adapterConfig: {
          cwd: "/tmp/project",
          model: "deepseek-v4-pro",
          provider: "opencode-go",
          tieredExecution: {
            allowPostMiniMaxFallbacks: true,
          },
        },
        availableAdapters: {
          hermes_local: true,
          gemini_local: true,
        },
        recentStall: true,
        stalledLanes: ["hermes_minimax"],
      });

      expect(result.changed).toBe(true);
      expect(result.adapterType).toBe("gemini_local");
      expect(result.adapterConfig).toMatchObject({
        cwd: "/tmp/project",
        model: "gemini-3.1-pro",
      });
      expect(result.route).toMatchObject({
        selectedLane: "gemini_local",
      });
      expect(result.route?.candidates).toEqual([
        "hermes_minimax",
        "hermes_opencode_zen_free",
        "gemini_local",
        "claude_local",
        "codex_local",
      ]);
    }
  });

  it("does not route beyond MiniMax without explicit post-MiniMax approval", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
        hermes_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax"],
    });

    expect(result.changed).toBe(false);
    expect(result.route).toBeNull();
    expect(result.adapterType).toBe("hermes_local");
  });

  it("marks manual and on-demand retries as provider recovery probes", () => {
    expect(shouldReprobeProviderStallsForRun({ invocationSource: "on_demand" })).toBe(true);
    expect(shouldReprobeProviderStallsForRun({ triggerDetail: "manual" })).toBe(true);
    expect(
      shouldReprobeProviderStallsForRun({
        contextSnapshot: { wakeReason: "retry_failed_run" },
      }),
    ).toBe(true);
    expect(
      shouldReprobeProviderStallsForRun({
        contextSnapshot: { wakeSource: "on_demand" },
      }),
    ).toBe(true);
    expect(shouldReprobeProviderStallsForRun({ invocationSource: "timer" })).toBe(false);
  });

  it("does not keep a fallback lane stalled when Gemini can advance past the failed model", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stallFailureKind: "provider_model_access",
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free", "gemini_local", "claude_local", "codex_local"],
      stalledLaneModels: {
        gemini_local: "gemini-2.5-flash",
        claude_local: "claude-sonnet-4-6",
        codex_local: "gpt-5.3-codex",
      },
    });

    expect(result.adapterType).toBe("gemini_local");
    expect(result.adapterConfig).toMatchObject({
      model: "gemini-3.1-pro",
    });
  });

  it("normalizes unsupported Codex fallback overrides before routing", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-pro",
        provider: "opencode-go",
        tieredExecution: {
          disableMiniMaxPrimary: true,
          allowPostMiniMaxFallbacks: true,
          adapterOrder: ["codex_local"],
          codex_local: {
            model: "gpt-5.5",
            modelReasoningEffort: "high",
          },
        },
      },
      availableAdapters: {
        codex_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_opencode_zen_free", "hermes_openrouter", "gemini_local", "claude_local"],
    });

    expect(result.changed).toBe(true);
    expect(result.adapterType).toBe("codex_local");
    expect(result.adapterConfig).toMatchObject({
      model: "gpt-5.4",
      modelReasoningEffort: "high",
    });
    expect(result.route).toMatchObject({
      selectedLane: "codex_local",
      provider: null,
      model: "gpt-5.4",
    });
  });

  it("advances Codex fallback into effort models after model-access failures", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        tieredExecution: {
          disableMiniMaxPrimary: true,
          allowPostMiniMaxFallbacks: true,
          adapterOrder: ["codex_local"],
        },
      },
      availableAdapters: {
        codex_local: true,
      },
      recentStall: true,
      stallFailureKind: "provider_model_access",
      stalledLanes: ["codex_local"],
      stalledLaneModels: {
        codex_local: "gpt-5.4",
      },
    });

    expect(result.adapterType).toBe("codex_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gpt-5.3-codex-high",
      modelReasoningEffort: "high",
    });
  });

  it("keeps auth-failed fallback lanes stalled even when the candidate model changed", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stallFailureKind: "provider_auth",
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free", "codex_local", "claude_local"],
      stalledLaneModels: {
        codex_local: "gpt-5.4",
        claude_local: "claude-opus-4-6",
      },
    });

    expect(result.adapterType).toBe("gemini_local");
    expect(result.route).toMatchObject({
      selectedLane: "gemini_local",
    });
  });

  it("keeps a fallback lane stalled when the current fallback model still matches", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-flash",
        provider: "opencode-go",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: true,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free", "gemini_local", "codex_local"],
      stalledLaneModels: {
        gemini_local: "gemini-3-flash",
        codex_local: "gpt-5.4",
      },
    });

    expect(result.adapterType).toBe("claude_local");
    expect(result.route).toMatchObject({
      selectedLane: "claude_local",
    });
  });

  it("falls back through Gemini and Claude Code before Codex", () => {
    const geminiFirstResult = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-pro",
        provider: "auto",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: false,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free"],
    });

    expect(geminiFirstResult.adapterType).toBe("gemini_local");
    expect(geminiFirstResult.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gemini-3.1-pro",
      sandbox: false,
    });

    const claudeResult = resolveAgentTieredExecutionRouting({
      role: "cto",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "deepseek-v4-pro",
        provider: "auto",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
      },
      availableAdapters: {
        codex_local: false,
        claude_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stalledLanes: ["hermes_minimax", "hermes_opencode_zen_free", "gemini_local"],
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
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
        },
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
      model: "gemini-3.1-pro",
      sandbox: false,
    });
  });

  it("keeps executive Gemini fallback on high-intelligence models", () => {
    for (const role of ["ceo", "chief of staff"]) {
      const result = resolveAgentTieredExecutionRouting({
        role,
        adapterType: "opencode_local",
        adapterConfig: {
          cwd: "/tmp/project",
          tieredExecution: {
            adapterOrder: ["gemini_local"],
          },
        },
        availableAdapters: {
          gemini_local: true,
        },
        contextSnapshot: {
          paperclipExecutionRouting: {
            forceTieredFallback: true,
            allowPostMiniMaxFallbacks: true,
          },
        },
      });

      expect(result.adapterType).toBe("gemini_local");
      expect(result.adapterConfig).toMatchObject({
        cwd: "/tmp/project",
        model: "gemini-3.1-pro",
      });
      expect(result.adapterConfig.model).not.toBe("gemini-3-flash");
    }
  });

  it("advances Gemini fallback models after model-access failures", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        tieredExecution: {
          allowPostMiniMaxFallbacks: true,
          adapterOrder: ["gemini_local", "codex_local"],
        },
      },
      availableAdapters: {
        codex_local: true,
        gemini_local: true,
      },
      recentStall: true,
      stallFailureKind: "provider_model_access",
      stalledLanes: ["gemini_local"],
      stalledLaneModels: {
        gemini_local: "gemini-3-flash",
      },
    });

    expect(result.adapterType).toBe("gemini_local");
    expect(result.adapterConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gemini-3-flash-preview",
    });
  });

  it("supports explicit tiered adapter order and adapter-specific overrides", () => {
    const result = resolveAgentTieredExecutionRouting({
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        tieredExecution: {
          disableMiniMaxPrimary: true,
          allowPostMiniMaxFallbacks: true,
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
    expect(isModelQuotaStallText("HTTP 401: Insufficient balance")).toBe(true);
    expect(isModelQuotaStallText("ordinary unit test failure")).toBe(false);
  });

  it("classifies provider reliability failures before the next spawn", () => {
    expect(classifyProviderReliabilityFailureText("HTTP 401: Insufficient balance")).toEqual({
      kind: "provider_billing",
      reason: "provider_billing_failure",
    });
    expect(classifyProviderReliabilityFailureText("Your API key was rejected by the provider")).toEqual({
      kind: "provider_auth",
      reason: "provider_auth_failure",
    });
    expect(
      classifyProviderReliabilityFailureText(
        "Claude run failed: Failed to authenticate. API Error: 401 invalid authentication credentials",
      ),
    ).toEqual({
      kind: "provider_auth",
      reason: "provider_auth_failure",
    });
    expect(classifyProviderReliabilityFailureText("Claude CLI is installed, but login is required.")).toEqual({
      kind: "provider_auth",
      reason: "provider_auth_failure",
    });
    expect(classifyProviderReliabilityFailureText("Does your account have access to deepseek-v4-pro?")).toEqual({
      kind: "provider_model_access",
      reason: "provider_model_access_failure",
    });
    expect(
      classifyProviderReliabilityFailureText(
        "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toEqual({
      kind: "provider_model_access",
      reason: "provider_model_access_failure",
    });
    expect(classifyProviderReliabilityFailureText("HTTP 429 too many requests")).toEqual({
      kind: "provider_rate_limit",
      reason: "provider_rate_limit_failure",
    });
    expect(classifyProviderReliabilityFailureText("HTTP 429: Monthly usage limit reached. Resets in 23 days.")).toEqual({
      kind: "provider_quota",
      reason: "provider_quota_failure",
    });
    expect(
      classifyProviderReliabilityFailureText(
        "Gemini CLI authentication is configured, but the current account or API key is over quota.",
      ),
    ).toEqual({
      kind: "provider_quota",
      reason: "provider_quota_failure",
    });
    expect(classifyProviderReliabilityFailureText("Implemented quota reporting without provider errors.")).toBeNull();
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
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("enters pre-spawn failover after the newest run hit Opencode billing failure", () => {
    expect(
      selectRecentModelStallForRouting([
        {
          id: "run-opencode-balance",
          status: "failed",
          errorCode: "adapter_failed",
          stderrExcerpt: [
            "AuthenticationError [HTTP 401]",
            "HTTP 401: Insufficient balance. Manage your billing here.",
            "Details: {'type': 'CreditsError'}",
          ].join("\n"),
          contextSnapshot: {},
        },
      ]),
    ).toEqual({
      runId: "run-opencode-balance",
      reason: "provider_billing_failure",
      failureKind: "provider_billing",
      stalledLanes: [],
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
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("does not mark a successful fallback lane as stalled when preflight shows the failed lanes", () => {
    const providerFailureRuns = filterProviderReliabilityFailureRunsForRouting([
      {
        id: "run-codex-recovery",
        status: "succeeded",
        stdoutExcerpt: "Recovered through Codex after HTTP 401 on the original Hermes lanes.",
        contextSnapshot: {
          paperclipExecutionRouting: {
            source: "tiered_execution_policy",
            originalAdapterType: "hermes_local",
            selectedAdapterType: "codex_local",
            selectedLane: "codex_local",
            model: "gpt-5.4",
            preflightAttempts: [
              {
                status: "degraded",
                reason: "provider_quota_failure",
                target: {
                  lane: "hermes_opencode_zen_free",
                  model: "deepseek-v4-flash-free",
                },
              },
              {
                status: "degraded",
                reason: "provider_auth_failure",
                target: {
                  lane: "hermes_openrouter",
                  model: "deepseek/deepseek-v4-pro",
                },
              },
              {
                status: "healthy",
                target: {
                  lane: "codex_local",
                  model: "gpt-5.4",
                },
              },
            ],
          },
          paperclipProviderReliabilityGate: {
            status: "validated",
            selectedAdapterType: "codex_local",
            selectedLane: "codex_local",
            model: "gpt-5.4",
          },
        },
      },
    ]);

    expect(selectRecentModelStallForRouting(providerFailureRuns)).toEqual({
      runId: "run-codex-recovery",
      reason: "provider_auth_failure",
      failureKind: "provider_auth",
      stalledLanes: ["hermes_opencode_zen_free", "hermes_openrouter"],
      stalledLaneModels: {
        hermes_opencode_zen_free: "deepseek-v4-flash-free",
        hermes_openrouter: "deepseek/deepseek-v4-pro",
      },
    });
  });

  it("does not keep expired provider preflight attempts in stalled lane evidence", () => {
    const providerFailureRuns = filterProviderReliabilityFailureRunsForRouting([
      {
        id: "run-codex-recovery",
        status: "succeeded",
        createdAt: "2026-06-01T14:40:00Z",
        stdoutExcerpt: "Recovered through Codex after HTTP 401 on earlier provider lanes.",
        contextSnapshot: {
          paperclipExecutionRouting: {
            source: "tiered_execution_policy",
            originalAdapterType: "hermes_local",
            selectedAdapterType: "codex_local",
            selectedLane: "codex_local",
            model: "gpt-5.4",
            preflightAttempts: [
              {
                status: "degraded",
                reason: "provider_auth_failure",
                expiresAt: "2026-06-01T14:45:00Z",
                target: {
                  lane: "hermes_openrouter",
                  model: "deepseek/deepseek-v4-flash",
                },
              },
            ],
          },
        },
      },
    ]);

    expect(
      selectRecentModelStallForRouting(providerFailureRuns, {
        now: new Date("2026-06-01T14:46:00Z"),
      }),
    ).toEqual({
      runId: "run-codex-recovery",
      reason: "provider_auth_failure",
      failureKind: "provider_auth",
      stalledLanes: [],
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

  it("keeps failover active longer when the provider reports a long reset window", () => {
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
            id: "run-monthly-quota",
            status: "succeeded",
            createdAt: "2026-06-01T14:00:00Z",
            stdoutExcerpt: "GoUsageLimitError: Monthly usage limit reached. Resets in 25 days.",
            contextSnapshot: {},
          },
        ],
        {
          now: new Date("2026-06-01T14:31:00Z"),
          recoveryProbeAfterMs: 30 * 60 * 1000,
        },
      ),
    ).toEqual({
      runId: "run-monthly-quota",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("keeps company-scoped provider failures active despite unrelated successful runs", () => {
    const providerFailureRuns = filterProviderReliabilityFailureRunsForRouting([
      {
        id: "run-unrelated-success",
        status: "succeeded",
        createdAt: "2026-06-01T14:20:00Z",
        stdoutExcerpt: "Task completed without provider fallback.",
        contextSnapshot: {},
      },
      {
        id: "run-monthly-quota",
        status: "failed",
        createdAt: "2026-06-01T14:00:00Z",
        error: "HTTP 429: Monthly usage limit reached. Resets in 25 days.",
        contextSnapshot: {},
      },
    ]);

    expect(providerFailureRuns.map((run) => run.id)).toEqual(["run-monthly-quota"]);
    expect(
      selectRecentModelStallForRouting(providerFailureRuns, {
        now: new Date("2026-06-01T14:31:00Z"),
        recoveryProbeAfterMs: 30 * 60 * 1000,
      }),
    ).toEqual({
      runId: "run-monthly-quota",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("keeps a newer active provider stall when older noisy provider text has expired", () => {
    expect(
      selectRecentModelStallForRouting(
        [
          {
            id: "run-monthly-quota",
            status: "failed",
            createdAt: "2026-06-01T14:40:00Z",
            error: "HTTP 429: Monthly usage limit reached. Resets in 23 days.",
            contextSnapshot: {},
          },
          {
            id: "run-old-fallback-warning",
            status: "succeeded",
            createdAt: "2026-06-01T14:00:00Z",
            stdoutExcerpt: "HTTP 429: Rate limit exceeded before fallback completed successfully.",
            contextSnapshot: {},
          },
        ],
        {
          now: new Date("2026-06-01T14:45:00Z"),
          recoveryProbeAfterMs: 30 * 60 * 1000,
        },
      ),
    ).toEqual({
      runId: "run-monthly-quota",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("does not let expired short-window provider text hide an older long-reset quota failure", () => {
    expect(
      selectRecentModelStallForRouting(
        [
          {
            id: "run-expired-rate-limit",
            status: "succeeded",
            createdAt: "2026-06-01T14:00:00Z",
            stdoutExcerpt: "HTTP 429: Rate limit exceeded before fallback completed successfully.",
            contextSnapshot: {},
          },
          {
            id: "run-monthly-quota",
            status: "failed",
            createdAt: "2026-06-01T13:59:00Z",
            error: "HTTP 429: Monthly usage limit reached. Resets in 23 days.",
            contextSnapshot: {},
          },
        ],
        {
          now: new Date("2026-06-01T14:45:00Z"),
          recoveryProbeAfterMs: 30 * 60 * 1000,
        },
      ),
    ).toEqual({
      runId: "run-monthly-quota",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
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
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      stalledLanes: [],
    });
  });

  it("records stalled tiered lanes so recovery advances through the ordered chain", () => {
    expect(
      selectRecentModelStallForRouting(
        [
          {
            id: "run-openrouter-quota",
            status: "failed",
            createdAt: "2026-06-01T14:10:00Z",
            stderrExcerpt: "HTTP 429 too many requests",
            contextSnapshot: {
              paperclipExecutionRouting: {
                source: "tiered_execution_policy",
                originalAdapterType: "hermes_local",
                selectedAdapterType: "hermes_local",
                selectedLane: "hermes_openrouter",
              },
            },
          },
          {
            id: "run-zen-quota",
            status: "failed",
            createdAt: "2026-06-01T14:00:00Z",
            stderrExcerpt: "FreeUsageLimitError: weekly usage limit reached",
            contextSnapshot: {
              paperclipExecutionRouting: {
                source: "tiered_execution_policy",
                originalAdapterType: "hermes_local",
                selectedAdapterType: "hermes_local",
                selectedLane: "hermes_opencode_zen_free",
              },
            },
          },
        ],
        {
          now: new Date("2026-06-01T14:11:00Z"),
        },
      ),
    ).toEqual({
      runId: "run-openrouter-quota",
      reason: "provider_rate_limit_failure",
      failureKind: "provider_rate_limit",
      stalledLanes: ["hermes_openrouter", "hermes_opencode_zen_free"],
      stalledLaneModels: {
        hermes_openrouter: null,
        hermes_opencode_zen_free: null,
      },
    });
  });
});
