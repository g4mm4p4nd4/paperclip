import { describe, expect, it } from "vitest";
import {
  buildProfitFlywheelAdjudicationEvidenceValue,
  buildProviderPolicyBudgetAdapterConfig,
  buildProviderLaneTelemetry,
  canonicalProfitFlywheelFailureForStage,
  classifyProfitFlywheelAdapterFailure,
  createExecutionEvidenceNonce,
  createProviderSecurityAgentQuarantine,
  filterProviderPolicyNonCredentialEnv,
  redactProfitFlywheelRuntimeText,
  sanitizePolicyProviderValue,
} from "../services/heartbeat.js";

describe("heartbeat provider-lane telemetry", () => {
  it("merges adapter, routing, quota, cache, and context-pack metadata into one envelope", () => {
    const providerLane = buildProviderLaneTelemetry({
      adapterType: "gemini_local",
      originalAdapterType: "hermes_local",
      rawUsage: {
        inputTokens: 11_000,
        cachedInputTokens: 43_000,
        outputTokens: 900,
      },
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "google",
        biller: "google",
        model: "gemini-3-flash-preview",
        billingType: "subscription_included",
        resultJson: {
          usage: {
            source: "gemini_stream_json",
          },
        },
      },
      context: {
        paperclipProviderReliabilityGate: {
          status: "rerouted",
          source: "pre_spawn_provider_preflight",
          reason: "MiniMax Token Plan quota exhausted",
          failureKind: "provider_quota",
          originalAdapterType: "hermes_local",
          selectedAdapterType: "gemini_local",
          selectedLane: "gemini_subscription",
          preflight: {
            status: "exhausted",
          },
          capacity: {
            source: "subscription_quota_poll",
            status: "exhausted",
          },
        },
        paperclipContextEconomy: {
          mode: "map_first",
          repoSlug: "paperclip",
          manifestSha: "a".repeat(64),
        },
      },
    });

    expect(providerLane).toMatchObject({
      lane: "gemini_subscription",
      originalAdapterType: "hermes_local",
      selectedAdapterType: "gemini_local",
      provider: "google",
      biller: "google",
      model: "gemini-3-flash-preview",
      billingType: "subscription_included",
      cacheMode: "provider_reported",
      cacheSource: "gemini_stream_json",
      cachedInputTokens: 43_000,
      quotaSource: "pre_spawn_provider_preflight",
      quotaStatus: "exhausted",
      contextPackProfile: "map_first",
      contextPackRepoSlug: "paperclip",
      contextPackManifestSha: "a".repeat(64),
      escalationReason: "MiniMax Token Plan quota exhausted",
      escalationSource: "pre_spawn_provider_preflight",
      failureKind: "provider_quota",
    });
  });

  it("honors explicit process runbook metadata over inferred routing context", () => {
    const providerLane = buildProviderLaneTelemetry({
      adapterType: "process",
      originalAdapterType: "process",
      rawUsage: null,
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        providerLane: {
          lane: "qa",
          selectedAdapterType: "process",
          provider: "process",
          biller: "paperclip",
          model: "run-qa-sweep",
          billingType: "fixed",
          cacheMode: "process_structured_result",
          cacheSource: "PAPERCLIP_ADAPTER_RESULT_JSON",
          quotaSource: "not_applicable",
          quotaStatus: "available",
        },
      },
      context: {
        paperclipProviderReliabilityGate: {
          selectedLane: "gemini_subscription",
          reason: "fallback",
        },
      },
    });

    expect(providerLane).toMatchObject({
      lane: "qa",
      selectedAdapterType: "process",
      provider: "process",
      biller: "paperclip",
      model: "run-qa-sweep",
      cacheMode: "process_structured_result",
      cacheSource: "PAPERCLIP_ADAPTER_RESULT_JSON",
      quotaSource: "not_applicable",
      quotaStatus: "available",
      escalationReason: "fallback",
    });
  });
});

describe("Profit Flywheel provider failure normalization", () => {
  it("keeps an agent fail-closed after a provider security quarantine", () => {
    const quarantine = createProviderSecurityAgentQuarantine();
    expect(quarantine.allows("agent-a")).toBe(true);
    quarantine.block("agent-a");
    expect(quarantine.allows("agent-a")).toBe(false);
    expect(quarantine.allows("agent-b")).toBe(true);
  });

  it("maps the single policy budget into both generic and Hermes-native enforcement keys", () => {
    expect(buildProviderPolicyBudgetAdapterConfig({
      maxTurns: 3,
      maxContextChars: 12_000,
      maxOutputChars: 1_200,
      maxTotalTokens: 24_000,
      maxEscalations: 1,
      toolOutput: { maxBytes: 16_000, maxLines: 320, maxLineLength: 1_000 },
    })).toEqual({
      maxTurnsPerRun: 3,
      contextMaxChars: 12_000,
      outputMaxChars: 1_200,
      maxTotalTokens: 24_000,
      maxEscalations: 1,
      toolOutputMaxBytes: 16_000,
      toolOutputMaxLines: 320,
      toolOutputMaxLineLength: 1_000,
      hermesToolOutputMaxBytes: 16_000,
      hermesToolOutputMaxLines: 320,
      hermesToolOutputMaxLineLength: 1_000,
      toolOutputBudget: {
        enabled: true,
        maxBytes: 16_000,
        maxLines: 320,
        maxLineLength: 1_000,
      },
      hermesToolOutput: {
        enabled: true,
        maxBytes: 16_000,
        maxLines: 320,
        maxLineLength: 1_000,
      },
      hermesToolOutputBudgetEnabled: true,
    });
  });

  it("maps observed provider failures into the frozen stage retry vocabulary", () => {
    expect(canonicalProfitFlywheelFailureForStage("implementation", "provider_quota")).toBe("provider_quota");
    expect(canonicalProfitFlywheelFailureForStage("implementation", "provider_auth")).toBe("provider_unavailable");
    expect(canonicalProfitFlywheelFailureForStage("qa", "provider_quota")).toBe("review_provider_unavailable");
    expect(canonicalProfitFlywheelFailureForStage("release", "transient_network")).toBe("transient_release_platform_failure");
    expect(canonicalProfitFlywheelFailureForStage("release", "process_lost")).toBe("process_interrupted");
    expect(canonicalProfitFlywheelFailureForStage("implementation", "product_test_failure")).toBe("product_test_failure");
  });

  it("classifies provider failures without collapsing auth, quota, rate, and malformed output", () => {
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorText: "HTTP 401 authentication required" })).toBe("provider_auth");
    expect(classifyProfitFlywheelAdapterFailure({
      outcome: "failed",
      errorText: "Error authenticating: IneligibleTierError: this client is no longer supported; migrate to the Antigravity suite",
    })).toBe("provider_capability_mismatch");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", providerFailureKind: "provider_capability_mismatch" })).toBe("provider_capability_mismatch");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorText: "account quota exhausted" })).toBe("provider_quota");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorText: "HTTP 429 too many requests" })).toBe("provider_rate_limit");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorText: "tool-call-only missing_final_response" })).toBe("provider_malformed_response");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorCode: "provider_security_compromise" })).toBe("provider_security_compromise");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorCode: "provider_runtime_closure_mismatch" })).toBe("provider_security_compromise");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorCode: "provider_source_binding_mismatch" })).toBe("provider_security_compromise");
    expect(classifyProfitFlywheelAdapterFailure({ outcome: "failed", errorText: "unsafe_final_response_secret" })).toBe("provider_security_compromise");
  });

  it("redacts pattern-based and opaque exact credentials before every provider-owned sink", () => {
    const opaque = "opaque-refresh-value-without-prefix-123456";
    const broker = "paperclip-broker-abcdefghijklmnopqrstuvwxyz123456";
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const providerShaped = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const source = {
      log: `log ${opaque} ${broker}`,
      event: { chunk: `Bearer ${jwt}` },
      resultJson: { final: providerShaped },
      artifactCandidate: opaque,
    };
    const sanitized = sanitizePolicyProviderValue(source, new Set([opaque, broker]));
    const serialized = JSON.stringify(sanitized);
    for (const value of [opaque, broker, jwt, providerShaped]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain("REDACTED");
  });

  it("creates unique 256-bit server-only execution evidence nonces", () => {
    const observed = new Set(Array.from({ length: 128 }, () => createExecutionEvidenceNonce()));
    expect(observed.size).toBe(128);
    for (const nonce of observed) expect(nonce).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts credential, bearer, verification, and token material before durable sinks", () => {
    const redacted = redactProfitFlywheelRuntimeText(
      "Authorization=Bearer abcdefghijklmnop API_KEY=super-secret-value verification_code=123456 AUTH=bare-auth-secret",
      { userNames: [], homeDirs: [] },
    );
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("123456");
    expect(redacted).not.toContain("bare-auth-secret");
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("never forwards control-plane journal keys into provider subprocess environments", () => {
    expect(filterProviderPolicyNonCredentialEnv({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      SAFE_FLAG: "1",
      PAPERCLIP_RETURN_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: "return" },
      PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: "research" },
      PAPERCLIP_STAGE_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: "stage" },
      MINIMAX_API_KEY: { type: "secret_ref", secretId: "provider" },
      FOO_TOKEN: "secret-sentinel",
      INNOCUOUS: { type: "secret_ref", secretId: "disguised" },
    })).toEqual({ LANG: "C.UTF-8" });
  });

  it("authors the exact adjudication schema including policy-schema lineage without persisting raw runtime secrets", () => {
    const evidence = buildProfitFlywheelAdjudicationEvidenceValue({
      companyId: "company-1",
      workflowId: "workflow-1",
      stageRunId: "stage-1",
      attempt: 2,
      inputHash: "1".repeat(64),
      heartbeatRunId: "heartbeat-1",
      providerRouteId: "codex_deep",
      providerFamily: "openai",
      model: "gpt-5.3-codex",
      version: "gpt-5.3-codex",
      providerPolicySha256: "2".repeat(64),
      providerPolicySchemaSha256: "3".repeat(64),
      providerRouteCoreSha256: "4".repeat(64),
      providerRouteSha256: "5".repeat(64),
      exitCode: 0,
      signal: "API_KEY=secret-sentinel-value",
      timedOut: false,
      observedOutcome: "failed",
      inferredFailureCode: "missing_final_response",
      logSha256: "6".repeat(64),
      finalResponseComplete: false,
      serverObservationNonce: "7".repeat(64),
      observedAt: "2026-07-12T06:00:00.000Z",
    });
    expect(evidence).toMatchObject({
      schema_version: "paperclip.execution_adjudication.v1",
      provider_policy_sha256: "2".repeat(64),
      provider_policy_schema_sha256: "3".repeat(64),
      exit_code: 0,
      final_response_complete: false,
      false_success: true,
      server_observation_proof: expect.stringMatching(/^[a-f0-9]{64}$/),
      signal: "redacted_invalid_runtime_field",
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-sentinel-value");
    expect(JSON.stringify(evidence)).not.toContain("7".repeat(64));
  });
});
