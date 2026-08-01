import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  loadProviderPolicyV2,
  parseProviderPolicy,
  ProviderPolicyError,
  resolveProviderAlias,
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
        expect(route.runtimeBinding).toMatchObject({
          repoRoot: "/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/runtimes/hermes-source-1751fc2513737c61045b28f273314dedd80a531a",
          gitRevision: "1751fc2513737c61045b28f273314dedd80a531a",
          gitTree: "c554feff3220976f41c27bf2714cf5ac38193495",
          criticalModulesSha256: "0f8c5878738b3ca427011aaacbbedd15bb85b9b1f796811e949b3151474ea2a7",
          requireCleanTree: true,
        });
        expect(route.runtimeBinding.externalAdapter).toMatchObject({
          repoRoot: "/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/runtimes/hermes-paperclip-adapter-source-8a050ff790f38d9ba38274d3135bdecb8fd0e572",
          gitRevision: "8a050ff790f38d9ba38274d3135bdecb8fd0e572",
          gitTree: "298f3b885b1c68d66f0a056cd166dad5fdeb218c",
          criticalModulesSha256: "4944611e74b405e4ae6f4d80b3b896186554ca8a5a0610e71122c2b00535a06e",
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
      directories: [{ rejectSymlinks: true, rejectWritable: true }],
    });
    expect(hermesClosure.directories[0]?.fileCount).toBeGreaterThan(0);
    expect(loaded.policy.routes.opencode_go_deep.model.version).toBe("2026-04-24");
    expect(loaded.policy.routes.opencode_zen_free.canary.maxTokens).toBe(512);
    expect(loaded.policy.routes.minimax_m3.canary.maxTokens).toBe(1024);
    expect(loaded.policy.aliases.independent_review.orderedRouteIds).toEqual([
      "opencode_zen_free",
      "minimax_m3",
      "gemini_pro",
      "claude_sonnet",
      "codex_deep",
    ]);
    expect(loaded.policy.routes.opencode_zen_free.capabilities).toEqual(expect.arrayContaining([
      "review", "reasoning", "qa", "tool_use", "structured_output",
    ]));
    expect(loaded.policy.routes.minimax_m3.capabilities).toEqual(expect.arrayContaining(["architecture", "review", "reasoning", "qa", "structured_output"]));
    expect(loaded.policy.aliases.code_deep.orderedRouteIds).toEqual([
      "minimax_m3",
      "opencode_go_deep",
      "claude_sonnet",
      "codex_deep",
    ]);
  });

  it("uses the explicit emergency-free reviewer only for review and never for release", async () => {
    const { policy } = await loadProviderPolicyV2();
    expect(resolveProviderAlias({
      policy,
      alias: "independent_review",
      excludedProviderFamily: "minimax",
    }).route.id).toBe("opencode_zen_free");
    expect(() => resolveProviderAlias({
      policy,
      alias: "independent_review",
      excludedProviderFamily: "minimax",
      unavailableRouteIds: ["gemini_pro", "claude_sonnet", "codex_deep"],
      release: true,
    })).toThrowError(expect.objectContaining<Partial<ProviderPolicyError>>({
      code: "provider_policy_no_capable_route",
    }));
  });

  it("gives escalated research a full bounded reservation envelope without relaxing its tighter execution limits", async () => {
    const { policy } = await loadProviderPolicyV2();
    const normal = policy.budgetClasses.research_normal;
    const escalated = policy.budgetClasses.research_escalated;
    const implementation = policy.budgetClasses.implementation;

    expect(escalated.maxTotalTokens).toBe(implementation.maxTotalTokens);
    expect(escalated.maxTotalTokens).toBeGreaterThan(normal.maxTotalTokens);
    expect(escalated.maxTurns).toBeLessThan(implementation.maxTurns);
    expect(escalated.toolOutput.maxBytes).toBeLessThan(implementation.toolOutput.maxBytes);
    expect(escalated.maxEscalations).toBe(normal.maxEscalations);
  });

  it("fails closed when either policy or schema pin is missing/mismatched", async () => {
    await expect(loadProviderPolicyV2({ expectedSha256: "0".repeat(64) })).rejects.toMatchObject<Partial<ProviderPolicyError>>({
      code: "provider_policy_hash_mismatch",
    });
    await expect(loadProviderPolicyV2({ expectedSchemaSha256: "0".repeat(64) })).rejects.toMatchObject<Partial<ProviderPolicyError>>({
      code: "provider_policy_schema_hash_mismatch",
    });
  });

  it("keeps every historical policy under its exact content hash, including current", async () => {
    const loaded = await loadProviderPolicyV2();
    const historyDirectory = new URL("../../../config/provider-policy-history/", import.meta.url);
    const entries = (await readdir(historyDirectory)).filter((entry) => entry.endsWith(".json"));
    const revisions: number[] = [];
    expect(entries).toContain(`${loaded.sha256}.json`);
    for (const entry of entries) {
      expect(entry).toMatch(/^[a-f0-9]{64}\.json$/);
      const bytes = await readFile(new URL(entry, historyDirectory));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.slice(0, -5));
      const historicalPolicy = parseProviderPolicy(JSON.parse(bytes.toString("utf8")));
      revisions.push(historicalPolicy.revision);
    }
    const orderedRevisions = [...revisions].sort((left, right) => left - right);
    expect([...new Set(orderedRevisions)]).toEqual(Array.from(
      { length: orderedRevisions.at(-1)! - orderedRevisions[0]! + 1 },
      (_, index) => orderedRevisions[0]! + index,
    ));
    expect(orderedRevisions.at(-1)).toBe(loaded.policy.revision);
    expect(orderedRevisions).toContain(loaded.policy.revision - 1);
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
