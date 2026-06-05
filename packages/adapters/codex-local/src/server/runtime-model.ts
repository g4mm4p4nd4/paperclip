import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js";

export const STALE_CODEX_SUBSCRIPTION_MODEL_PATTERN = /^gpt-5\.[0-4]-codex(?:$|-)/i;
export const CODEX_SUBSCRIPTION_MODEL_IDS = new Set([
  DEFAULT_CODEX_LOCAL_MODEL,
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
  "o3-mini",
  "codex-mini-latest",
]);

export type CodexBillingType = "api" | "subscription";

export type CodexModelNormalization = {
  originalModel: string;
  effectiveModel: string;
  billingType: CodexBillingType;
  reason:
    | "codex_subscription_stale_model_alias"
    | "codex_subscription_unsupported_model";
};

function hasNonEmptyEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function resolveCodexBillingType(env: Record<string, string | undefined>): CodexBillingType {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

export function resolveCodexBiller(env: Record<string, string>, billingType: CodexBillingType): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

export function normalizeCodexModelForRuntime(
  model: string,
  billingType: CodexBillingType,
): CodexModelNormalization | null {
  const configuredModel = model.trim();
  if (!configuredModel) return null;
  if (configuredModel === DEFAULT_CODEX_LOCAL_MODEL) return null;
  if (billingType !== "subscription") return null;
  if (STALE_CODEX_SUBSCRIPTION_MODEL_PATTERN.test(configuredModel)) {
    return {
      originalModel: configuredModel,
      effectiveModel: DEFAULT_CODEX_LOCAL_MODEL,
      billingType,
      reason: "codex_subscription_stale_model_alias",
    };
  }
  if (CODEX_SUBSCRIPTION_MODEL_IDS.has(configuredModel)) return null;

  return {
    originalModel: configuredModel,
    effectiveModel: DEFAULT_CODEX_LOCAL_MODEL,
    billingType,
    reason: "codex_subscription_unsupported_model",
  };
}
