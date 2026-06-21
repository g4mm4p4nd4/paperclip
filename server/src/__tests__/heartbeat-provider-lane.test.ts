import { describe, expect, it } from "vitest";
import { buildProviderLaneTelemetry } from "../services/heartbeat.js";

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
