import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  loadProviderPolicyV2,
  parseProviderPolicy,
  ProviderPolicyError,
} from "../services/provider-policy.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { PROFIT_FLYWHEEL_STAGES } from "@paperclipai/shared";

describe("provider-policy.v2", () => {
  it("loads both pinned artifacts and enforces exact runtime/discovery roles", async () => {
    const loaded = await loadProviderPolicyV2();
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(loaded.policy.routes).length).toBeGreaterThanOrEqual(6);
    const required = new Set([
      "opencode-go:hermes_local",
      "opencode-zen:hermes_local",
      "minimax:hermes_local",
      "google-gemini:gemini_cli",
      "openai-codex:codex_cli",
      "anthropic-claude:claude_cli",
    ]);
    for (const route of Object.values(loaded.policy.routes)) {
      required.delete(`${route.provider}:${route.runtimeBinding.adapterType}`);
      expect(route.discovery.requireExactVersion).toBe(true);
      expect(route.runtimeBinding.commandSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(route.runtimeBinding.hiddenFallbackDisabled).toBe(true);
      expect(route.runtimeBinding.isolatedCanaryCwd).toBe(true);
      expect(route.runtimeBinding.isolatedCanaryProfile).toBe(true);
      expect(route.runtimeBinding.runtimeClosureId).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
      expect(route.runtimeBinding.runtimeClosureSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(route.canary.kind).not.toBe("work_bearing");
      expect(route.discovery.refreshSeconds).toBeGreaterThanOrEqual(1800);
      if (route.runtimeBinding.adapterType === "hermes_local") {
        expect(route.runtimeBinding.externalAdapter).toMatchObject({
          repoRoot: "/Users/mnm/Documents/Github/hermes-paperclip-adapter",
          gitRevision: "940724af9b94fc7c7d11230a5eb46cd91ab6c20b",
          gitTree: "c3e67ee0a912e0a7e6df9ab12ae709ef8bb0e391",
          criticalModulesSha256: "c7d0f6322964829d7adb0158320bb9a77a2fb6d2667dfb9ce817a6ee3f49ad72",
          requireCleanTree: true,
        });
      } else {
        expect(route.runtimeBinding.externalAdapter).toBeUndefined();
      }
    }
    expect(required).toEqual(new Set());
    expect(loaded.policy.routes.codex_deep.runtimeBinding.maxCanaryInputTokens).toBe(12_000);
    expect(loaded.policy.routes.codex_deep.runtimeBinding.commandRealpath).toMatch(/\/vendor\/aarch64-apple-darwin\/bin\/codex$/);
    expect(loaded.policy.routes.codex_deep.runtimeBinding.runtimeClosure.kind).toBe("native_binary");
    const geminiClosure = loaded.policy.routes.gemini_flash.runtimeBinding.runtimeClosure;
    expect(geminiClosure).toMatchObject({
      kind: "node_bundle",
      interpreter: { pathCommand: "node" },
      directories: [{ rejectSymlinks: true }],
    });
    expect(geminiClosure.directories[0]?.fileCount).toBeGreaterThan(0);
    const hermesClosure = loaded.policy.routes.opencode_go_flash.runtimeBinding.runtimeClosure;
    expect(hermesClosure).toMatchObject({
      kind: "python_venv",
      directories: [{ rejectSymlinks: true }],
    });
    expect(hermesClosure.directories[0]?.fileCount).toBeGreaterThan(0);
    expect(loaded.policy.routes.opencode_go_deep.model.version).toBe("2026-04-24");
  });

  it("fails closed when either policy or schema pin is missing/mismatched", async () => {
    await expect(loadProviderPolicyV2({ expectedSha256: "0".repeat(64) })).rejects.toMatchObject<Partial<ProviderPolicyError>>({
      code: "provider_policy_hash_mismatch",
    });
    await expect(loadProviderPolicyV2({ expectedSchemaSha256: "0".repeat(64) })).rejects.toMatchObject<Partial<ProviderPolicyError>>({
      code: "provider_policy_schema_hash_mismatch",
    });
  });

  it("rejects a cross-provider catalog key before any evidence lookup", async () => {
    const policyPath = new URL("../../../config/provider-policy.v2.json", import.meta.url);
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    const routes = raw.routes as Record<string, Record<string, unknown>>;
    routes.opencode_go_deep = {
      ...routes.opencode_go_deep,
      discovery: { ...(routes.opencode_go_deep.discovery as Record<string, unknown>), catalogProviderKey: "opencode" },
    };
    expect(() => parseProviderPolicy(raw)).toThrowError(expect.objectContaining<Partial<ProviderPolicyError>>({
      code: "provider_policy_catalog_provider_mismatch",
    }));
  });

  it("rejects launcher-only Codex bindings and incompatible closure kinds", async () => {
    const policyPath = new URL("../../../config/provider-policy.v2.json", import.meta.url);
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    const routes = raw.routes as Record<string, Record<string, unknown>>;
    const codex = routes.codex_fast;
    routes.codex_fast = {
      ...codex,
      runtimeBinding: {
        ...(codex.runtimeBinding as Record<string, unknown>),
        commandRealpath: "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
      },
    };
    expect(() => parseProviderPolicy(raw)).toThrowError(expect.objectContaining<Partial<ProviderPolicyError>>({
      code: "provider_policy_invalid_runtime_binding",
    }));
  });

  it("has one budget authority and resumable orphan recovery at every stage", async () => {
    const [policy, contract] = await Promise.all([loadProviderPolicyV2(), loadProfitFlywheelContract()]);
    for (const stageName of PROFIT_FLYWHEEL_STAGES) {
      const stage = contract.contract.stages[stageName];
      expect(stage.retry.retryable).toContain("process_interrupted");
      expect(stage.run_state_transitions.running).toContain("retry");
      const aliasName = stage.provider_capability_class;
      if (aliasName === "deterministic") continue;
      const alias = policy.policy.aliases[aliasName];
      const budget = policy.policy.budgetClasses[alias.budgetClass];
      expect(stage.budgets).toEqual({
        turns: budget.maxTurns,
        context_chars: budget.maxContextChars,
        output_chars: budget.maxOutputChars,
        token_limit: budget.maxTotalTokens,
        tool_output_bytes: budget.toolOutput.maxBytes,
        tool_output_lines: budget.toolOutput.maxLines,
        tool_output_line_chars: budget.toolOutput.maxLineLength,
        max_escalations: budget.maxEscalations,
      });
    }
  });
});
