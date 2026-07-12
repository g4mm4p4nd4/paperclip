import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderPolicyRouteCore,
  type ProviderPolicyRoute,
  type ProviderPolicyV2,
} from "../services/provider-policy.js";
import {
  attestPolicyOwnedSuccessfulResult,
  prepareProviderResultArtifactRoot,
  PROVIDER_RESULT_RECEIPT_TTL_MS,
  type VerifiedProviderRuntimeIdentity,
} from "../services/provider-result-attestation.js";
import {
  completionCanaryRouteSha256,
  providerPolicyRouteCoreSha256,
} from "../services/provider-route-hash.js";
import { removeProviderRuntimeProfile } from "../services/provider-runtime-profile.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

it("shares a five-minute provider-result receipt TTL with policy adapters", () => {
  expect(PROVIDER_RESULT_RECEIPT_TTL_MS).toBe(5 * 60_000);
});

const route: ProviderPolicyRoute = {
  provider: "openai-codex",
  providerFamily: "openai",
  model: { kind: "exact", value: "gpt-test", version: "gpt-test-2026-07-12" },
  modelFamily: "gpt-test",
  transport: "subscription_cli",
  runtimeBinding: {
    adapterType: "codex_cli",
    commandRealpath: "/opt/pinned/codex",
    commandSha256: HASH_A,
    expectedVersion: "codex-cli test",
    versionArgs: ["--version"],
    credentialEnvNames: [],
    isolatedCanaryCwd: true,
    isolatedCanaryProfile: true,
    hiddenFallbackDisabled: true,
    maxCanaryInputTokens: 12000,
  },
  capabilities: ["code", "tool_use"],
  costRank: 1,
  billingMode: "subscription",
  credentialRef: "runtime-auth://codex-cli",
  releaseAllowed: true,
  emergencyOnly: false,
  discovery: {
    authority: "runtime_cli",
    method: "codex_model_inventory",
    catalogProviderKey: "openai-codex",
    requiredStatus: "active",
    versionSource: "runtime_cli_model_id",
    selectedEntrySchema: "runtime-model-selected-entry.v1",
    refreshSeconds: 3600,
    requireExactVersion: true,
  },
  canary: { kind: "minimal_token", maxTokens: 16, timeoutSeconds: 30, successCriteria: ["complete final response"] },
  rollback: { action: "return_to_alias_resolution", cooldownSeconds: 60, failureThreshold: 1, requirePreviousRevision: true },
};

const budget: ProviderPolicyV2["budgetClasses"][string] = {
  maxTurns: 4,
  maxContextChars: 8000,
  maxOutputChars: 1000,
  maxTotalTokens: 100,
  maxEscalations: 0,
  toolOutput: { maxBytes: 16000, maxLines: 320, maxLineLength: 1000 },
};

const runtimeIdentity: VerifiedProviderRuntimeIdentity = {
  commandRealpath: route.runtimeBinding.commandRealpath,
  commandSha256: route.runtimeBinding.commandSha256,
  observedVersion: route.runtimeBinding.expectedVersion,
  runtimeClosureSha256: HASH_C,
};

function resolvedRoute() {
  const core = buildProviderPolicyRouteCore({ routeId: "codex_test", route });
  const policyRouteCoreSha256 = providerPolicyRouteCoreSha256(core);
  const withProofs = {
    ...core,
    policyId: "test-policy",
    policyRevision: "1",
    providerPolicySha256: HASH_A,
    providerPolicySchemaSha256: HASH_B,
  };
  return {
    ...withProofs,
    policyRouteCoreSha256,
    resolvedRouteSha256: completionCanaryRouteSha256(withProofs),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "paperclip-attestation-"));
  const resolved = resolvedRoute();
  const result = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "openai",
    model: "gpt-test",
    usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 1 },
    summary: "Complete work result.",
  };
  const base = {
    runId: "run-1",
    adapterType: "codex_local",
    routeId: "codex_test",
    route,
    resolvedRoute: resolved,
    providerPolicySha256: HASH_A,
    providerPolicySchemaSha256: HASH_B,
    resolvedRouteSha256: resolved.resolvedRouteSha256,
    expectedRouteCoreSha256: resolved.policyRouteCoreSha256,
    transcriptEpoch: 2,
    budget,
    runtimeIdentity,
    result,
    artifactRoot: path.join(root, "receipts"),
    now: new Date("2026-07-12T08:00:00.000Z"),
  };
  return { root, base, result, resolved };
}

async function hermesFixture() {
  const { root, base, result } = await fixture();
  const hermesRoute: ProviderPolicyRoute = {
    ...route,
    runtimeBinding: { ...route.runtimeBinding, adapterType: "hermes_local" },
  };
  const core = buildProviderPolicyRouteCore({ routeId: "hermes_test", route: hermesRoute });
  const policyRouteCoreSha256 = providerPolicyRouteCoreSha256(core);
  const withProofs = {
    ...core,
    policyId: "test-policy",
    policyRevision: "1",
    providerPolicySha256: HASH_A,
    providerPolicySchemaSha256: HASH_B,
  };
  const hermesResolvedRoute = {
    ...withProofs,
    policyRouteCoreSha256,
    resolvedRouteSha256: completionCanaryRouteSha256(withProofs),
  };
  const artifactRoot = path.join(root, "hermes-receipts");
  const { runRoot } = await prepareProviderResultArtifactRoot(artifactRoot, base.runId);
  const summary = result.summary;
  const finalResponseSha256 = createHash("sha256").update(summary).digest("hex");
  const artifactPath = path.join(runRoot, `${finalResponseSha256}.txt`);
  await writeFile(artifactPath, summary, { mode: 0o400, flag: "wx" });
  await chmod(artifactPath, 0o400);
  const providerResultReceipt = {
    schemaVersion: "paperclip.provider-result-receipt.v1",
    routeId: "hermes_test",
    provider: hermesRoute.provider,
    providerFamily: hermesRoute.providerFamily,
    model: "gpt-test",
    modelVersion: hermesRoute.model.version,
    observedProvider: hermesRoute.provider,
    observedModel: "gpt-test",
    observedModelVersion: hermesRoute.model.version,
    observedModelVersionSource: hermesRoute.discovery.versionSource,
    providerPolicySha256: HASH_A,
    providerPolicySchemaSha256: HASH_B,
    policyRouteCoreSha256,
    resolvedRouteSha256: hermesResolvedRoute.resolvedRouteSha256,
    runtimeVersion: runtimeIdentity.observedVersion,
    commandRealpath: runtimeIdentity.commandRealpath,
    commandSha256: runtimeIdentity.commandSha256,
    runtimeClosureSha256: runtimeIdentity.runtimeClosureSha256,
    repoRoot: null,
    gitRevision: null,
    gitTree: null,
    gitDirty: false,
    criticalModules: [],
    criticalModulesSha256: null,
    runtimeIdentityVerified: true,
    runtimeBindingMatched: true,
    runtimeBindingMismatches: [],
    routeIdentityMatched: true,
    routeIdentityMismatches: [],
    transcriptEpoch: 2,
    status: "succeeded",
    failureClass: null,
    usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 1, reasoningTokens: 0, totalTokens: 10 },
    usageScope: "adapter_result",
    observedAt: "2026-07-12T08:00:00.000Z",
    expiresAt: "2026-07-12T08:05:00.000Z",
    finalResponseComplete: true,
    finalResponseSha256,
    finalResponseChars: summary.length,
    finalResponseSource: "hermes_state_db",
    finalResponseArtifact: {
      kind: "content_addressed_final_response",
      path: artifactPath,
      sha256: finalResponseSha256,
      bytes: Buffer.byteLength(summary),
      mode: "0400",
    },
  };
  return {
    root,
    base: {
      ...base,
      adapterType: "hermes_local",
      routeId: "hermes_test",
      route: hermesRoute,
      resolvedRoute: hermesResolvedRoute,
      resolvedRouteSha256: hermesResolvedRoute.resolvedRouteSha256,
      expectedRouteCoreSha256: policyRouteCoreSha256,
      artifactRoot,
      result: {
        ...result,
        provider: hermesRoute.provider,
        providerResultReceipt,
      },
    },
  };
}

describe("provider result attestation", () => {
  it("budgets uncached input plus output while preserving raw cached usage", async () => {
    const { base } = await fixture();
    const attested = await attestPolicyOwnedSuccessfulResult({
      ...base,
      budget: { ...base.budget, maxTotalTokens: 4 },
      result: {
        ...base.result,
        usage: { inputTokens: 100, cachedInputTokens: 98, outputTokens: 2 },
      },
    });
    expect(attested.receipt.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 98,
      outputTokens: 2,
      totalTokens: 102,
    });
  });

  it("rejects impossible cached usage", async () => {
    const { base } = await fixture();
    await expect(attestPolicyOwnedSuccessfulResult({
      ...base,
      result: {
        ...base.result,
        usage: { inputTokens: 10, cachedInputTokens: 11, outputTokens: 2 },
      },
    })).rejects.toMatchObject({ code: "provider_security_compromise" });
  });

  it("persists one content-addressed result idempotently and binds an attempt-2 transcript", async () => {
    const { base } = await fixture();
    const first = await attestPolicyOwnedSuccessfulResult(base);
    const artifact = first.receipt.finalResponseArtifact as Record<string, unknown>;
    const before = await stat(String(artifact.path));
    const second = await attestPolicyOwnedSuccessfulResult(base);
    const after = await stat(String((second.receipt.finalResponseArtifact as Record<string, unknown>).path));
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.transcriptEpoch).toBe(2);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(String(artifact.path), "utf8")).toBe("Complete work result.");
  });

  it("rejects secret-bearing output before creating any artifact", async () => {
    const { base } = await fixture();
    const opaque = "opaque-value-without-a-provider-prefix-123456";
    await expect(attestPolicyOwnedSuccessfulResult({
      ...base,
      exactRedactionValues: new Set([opaque]),
      result: { ...base.result, summary: `Result accidentally included ${opaque}` },
    })).rejects.toMatchObject({ code: "provider_security_compromise" });
    await expect(stat(base.artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const broker = "paperclip-broker-abcdefghijklmnopqrstuvwxyz123456";
    await expect(attestPolicyOwnedSuccessfulResult({
      ...base,
      result: { ...base.result, summary: `Result included ${broker}` },
    })).rejects.toMatchObject({ code: "provider_security_compromise" });
    await expect(stat(base.artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing", undefined],
    ["zero", { inputTokens: 0, outputTokens: 0 }],
    ["no output", { inputTokens: 1, outputTokens: 0 }],
    ["negative", { inputTokens: -1, outputTokens: 1 }],
    ["fractional", { inputTokens: 1.5, outputTokens: 1 }],
    ["over budget", { inputTokens: 99, outputTokens: 2 }],
  ])("rejects %s usage", async (_label, usage) => {
    const { base } = await fixture();
    await expect(attestPolicyOwnedSuccessfulResult({
      ...base,
      result: { ...base.result, usage } as typeof base.result,
    })).rejects.toMatchObject({ code: "provider_security_compromise" });
  });

  it("rejects provider, model, route-core, and resolved-route mismatches", async () => {
    const { base } = await fixture();
    for (const changed of [
      { result: { ...base.result, provider: "unexpected" } },
      { result: { ...base.result, model: "unexpected" } },
      { expectedRouteCoreSha256: HASH_C },
      { resolvedRouteSha256: HASH_C },
    ]) {
      await expect(attestPolicyOwnedSuccessfulResult({ ...base, ...changed })).rejects.toMatchObject({
        code: "provider_security_compromise",
      });
    }
  });

  it("validates a Hermes-native receipt after its disposable profile is gone", async () => {
    const { root, base } = await hermesFixture();
    const instanceRoot = path.join(root, "instance");
    const profile = path.join(instanceRoot, "companies", "company-1", "provider-runtime", "hermes_local", "run-1", "home");
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await removeProviderRuntimeProfile({ companyId: "company-1", executionId: "run-1", route: base.route, instanceRoot });
    await expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    const attested = await attestPolicyOwnedSuccessfulResult(base);
    expect(attested.receipt.schemaVersion).toBe("paperclip.provider-result-receipt.v1");
    expect(await readFile(String((attested.receipt.finalResponseArtifact as Record<string, unknown>).path), "utf8"))
      .toBe(base.result.summary);
  });

  it("rejects tampered, expired, wrong-epoch, or mutable Hermes receipts and artifacts", async () => {
    const { base } = await hermesFixture();
    const original = base.result.providerResultReceipt as Record<string, unknown>;
    const cases: Array<Record<string, unknown>> = [
      { ...original, schemaVersion: "wrong" },
      { ...original, transcriptEpoch: 1 },
      { ...original, providerPolicySha256: HASH_C },
      { ...original, runtimeClosureSha256: HASH_B },
      { ...original, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 2 } },
      { ...original, expiresAt: "2026-07-12T07:59:59.000Z" },
    ];
    for (const receipt of cases) {
      await expect(attestPolicyOwnedSuccessfulResult({
        ...base,
        result: { ...base.result, providerResultReceipt: receipt },
      })).rejects.toMatchObject({ code: "provider_security_compromise" });
    }

    const artifact = original.finalResponseArtifact as Record<string, unknown>;
    await chmod(String(artifact.path), 0o600);
    await writeFile(String(artifact.path), "tampered");
    await expect(attestPolicyOwnedSuccessfulResult({
      ...base,
      result: { ...base.result, providerResultReceipt: original },
    })).rejects.toMatchObject({ code: "provider_security_compromise" });
  });
});
