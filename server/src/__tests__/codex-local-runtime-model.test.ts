import { describe, expect, it } from "vitest";
import { normalizeCodexModelForRuntime } from "@paperclipai/adapter-codex-local/server";

describe("codex local runtime model normalization", () => {
  it("keeps native subscription Codex model ids unchanged", () => {
    expect(normalizeCodexModelForRuntime("gpt-5.4-mini", "subscription")).toBeNull();
  });

  it("normalizes unsupported subscription model ids to the Codex default", () => {
    expect(normalizeCodexModelForRuntime("gpt-5.5", "subscription")).toMatchObject({
      originalModel: "gpt-5.5",
      effectiveModel: "gpt-5.4",
      billingType: "subscription",
      reason: "codex_subscription_unsupported_model",
    });
    expect(normalizeCodexModelForRuntime("deepseek-v4-flash", "subscription")).toMatchObject({
      originalModel: "deepseek-v4-flash",
      effectiveModel: "gpt-5.4",
      billingType: "subscription",
      reason: "codex_subscription_unsupported_model",
    });
  });

  it("leaves API-key mode model selection unchanged", () => {
    expect(normalizeCodexModelForRuntime("deepseek-v4-flash", "api")).toBeNull();
  });
});
