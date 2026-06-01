import {
  OPENCODE_GO_PROVIDER,
  isOpenCodeGoModelId,
  resolveOpenCodeGoRoutingForRole,
  stripOpenCodeGoProvider,
} from "@paperclipai/adapter-opencode-local";

type AdapterModelRoutingResult = {
  adapterConfig: Record<string, unknown>;
  changed: boolean;
  route: {
    model: string;
    variant: string;
    provider: "opencode-go";
    source: "opencode_go_role_matrix";
  } | null;
};

export type TieredExecutionAdapterType =
  | "codex_local"
  | "claude_local"
  | "gemini_local"
  | "opencode_local"
  | "hermes_local";

type TieredExecutionRoutingResult = {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  changed: boolean;
  route: {
    source: "tiered_execution_policy";
    reason: string;
    originalAdapterType: string;
    selectedAdapterType: TieredExecutionAdapterType;
    model: string | null;
    candidates: TieredExecutionAdapterType[];
  } | null;
};

const OPENCODE_GO_ROUTED_ADAPTERS = new Set(["hermes_local", "opencode_local"]);
const TIERED_EXECUTION_SOURCE_ADAPTERS = new Set(["hermes_local", "opencode_local"]);

const HEAVY_IMPLEMENTATION_ROLES = new Set([
  "cto",
  "engineer",
  "integration_engineer",
  "devops",
  "pm",
  "general",
]);
const REVIEW_AND_SYNTHESIS_ROLES = new Set(["ceo", "researcher", "qa", "designer"]);

const STALE_GPT_MODEL_PATTERN = /^(openai\/)?gpt-5\./i;
const STALE_CLAUDE_MODEL_PATTERN = /^(anthropic\/)?claude-/i;
const MODEL_QUOTA_STALL_PATTERN =
  /(freeusagelimiterror|usage limit|weekly limit|5 hour limit|rate limit|rate-limit|quota|insufficient_quota|too many requests|429)/i;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function isTieredExecutionAdapterType(value: string): value is TieredExecutionAdapterType {
  return (
    value === "codex_local" ||
    value === "claude_local" ||
    value === "gemini_local" ||
    value === "opencode_local" ||
    value === "hermes_local"
  );
}

function uniqueTieredAdapters(values: string[]): TieredExecutionAdapterType[] {
  const result: TieredExecutionAdapterType[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const adapterType = value.trim();
    if (!isTieredExecutionAdapterType(adapterType)) continue;
    if (seen.has(adapterType)) continue;
    seen.add(adapterType);
    result.push(adapterType);
  }
  return result;
}

function tieredExecutionPolicy(adapterConfig: Record<string, unknown>) {
  return asRecord(adapterConfig.tieredExecution ?? adapterConfig.executionRouting);
}

function tieredAdapterOverride(
  adapterConfig: Record<string, unknown>,
  adapterType: TieredExecutionAdapterType,
) {
  const policy = tieredExecutionPolicy(adapterConfig);
  const shorthand = adapterType.replace(/_local$/, "");
  return {
    ...asRecord(policy[adapterType]),
    ...asRecord(policy[shorthand]),
  };
}

function preservePortableExecutionConfig(adapterConfig: Record<string, unknown>) {
  const next = { ...adapterConfig };
  delete next.provider;
  delete next.variant;
  delete next.effort;
  delete next.modelReasoningEffort;
  delete next.reasoningEffort;
  delete next.thinkingEffort;
  delete next.search;
  delete next.chrome;
  delete next.sandbox;
  delete next.command;
  delete next.extraArgs;
  delete next.args;
  delete next.tieredExecution;
  delete next.executionRouting;
  return next;
}

function defaultTieredAdapterOrder(role: string): TieredExecutionAdapterType[] {
  const normalizedRole = role.trim().toLowerCase();
  if (REVIEW_AND_SYNTHESIS_ROLES.has(normalizedRole)) {
    return ["codex_local", "claude_local", "gemini_local"];
  }
  if (normalizedRole === "skill_curator") {
    return ["codex_local", "gemini_local", "claude_local"];
  }
  if (HEAVY_IMPLEMENTATION_ROLES.has(normalizedRole)) {
    return ["codex_local", "claude_local", "gemini_local"];
  }
  return ["codex_local", "claude_local", "gemini_local"];
}

function resolveTieredAdapterOrder(input: {
  role: string;
  adapterConfig: Record<string, unknown>;
}) {
  const policy = tieredExecutionPolicy(input.adapterConfig);
  const configuredOrder = uniqueTieredAdapters(asStringArray(policy.adapterOrder));
  return configuredOrder.length > 0 ? configuredOrder : defaultTieredAdapterOrder(input.role);
}

function buildCodexFallbackConfig(
  adapterConfig: Record<string, unknown>,
  role: string,
) {
  const override = tieredAdapterOverride(adapterConfig, "codex_local");
  const heavyRole = HEAVY_IMPLEMENTATION_ROLES.has(role.trim().toLowerCase());
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    model: asNonEmptyString(override.model) ?? "gpt-5.3-codex",
    modelReasoningEffort: asNonEmptyString(override.modelReasoningEffort) ?? (heavyRole ? "high" : "medium"),
    search: override.search === true,
    dangerouslyBypassApprovalsAndSandbox: override.dangerouslyBypassApprovalsAndSandbox !== false,
    ...override,
  };
}

function buildClaudeFallbackConfig(
  adapterConfig: Record<string, unknown>,
  role: string,
) {
  const override = tieredAdapterOverride(adapterConfig, "claude_local");
  const normalizedRole = role.trim().toLowerCase();
  const defaultModel =
    normalizedRole === "cto" || normalizedRole === "ceo"
      ? "claude-opus-4-6"
      : "claude-sonnet-4-6";
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    model: asNonEmptyString(override.model) ?? defaultModel,
    effort: asNonEmptyString(override.effort) ?? "high",
    maxTurnsPerRun: typeof override.maxTurnsPerRun === "number" ? override.maxTurnsPerRun : 25,
    dangerouslySkipPermissions: override.dangerouslySkipPermissions !== false,
    ...override,
  };
}

function buildGeminiFallbackConfig(
  adapterConfig: Record<string, unknown>,
  role: string,
) {
  const override = tieredAdapterOverride(adapterConfig, "gemini_local");
  const normalizedRole = role.trim().toLowerCase();
  const defaultModel =
    normalizedRole === "researcher" || normalizedRole === "qa" || normalizedRole === "designer"
      ? "gemini-2.5-pro"
      : "gemini-2.5-flash";
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    model: asNonEmptyString(override.model) ?? defaultModel,
    sandbox: override.sandbox === true,
    ...override,
  };
}

function buildOpenCodeFallbackConfig(adapterConfig: Record<string, unknown>) {
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    ...tieredAdapterOverride(adapterConfig, "opencode_local"),
  };
}

function buildFallbackConfig(input: {
  adapterType: TieredExecutionAdapterType;
  adapterConfig: Record<string, unknown>;
  role: string;
}) {
  switch (input.adapterType) {
    case "codex_local":
      return buildCodexFallbackConfig(input.adapterConfig, input.role);
    case "claude_local":
      return buildClaudeFallbackConfig(input.adapterConfig, input.role);
    case "gemini_local":
      return buildGeminiFallbackConfig(input.adapterConfig, input.role);
    case "opencode_local":
      return buildOpenCodeFallbackConfig(input.adapterConfig);
    case "hermes_local":
      return input.adapterConfig;
  }
}

function contextForcesTieredFallback(contextSnapshot: Record<string, unknown>) {
  const routing = asRecord(contextSnapshot.paperclipExecutionRouting);
  return routing.forceTieredFallback === true || routing.forceCodexFallback === true;
}

function shouldApplyDefaultRouting(adapterType: string, adapterConfig: Record<string, unknown>): boolean {
  const model = asNonEmptyString(adapterConfig.model);
  if (!model) return true;
  if (model === "auto") return true;
  if (STALE_GPT_MODEL_PATTERN.test(model)) return true;
  if (STALE_CLAUDE_MODEL_PATTERN.test(model)) return true;
  if (adapterType === "opencode_local") {
    const prefix = `${OPENCODE_GO_PROVIDER}/`;
    if (!model.startsWith(prefix)) return true;
    if (!isOpenCodeGoModelId(model)) return true;
  }
  if (adapterType === "hermes_local") {
    if (model.startsWith(`${OPENCODE_GO_PROVIDER}/`)) return true;
    if (asNonEmptyString(adapterConfig.provider) !== "auto") return true;
    if (adapterConfig.variant !== undefined) return true;
    if (adapterConfig.effort !== undefined) return true;
    if (adapterConfig.modelReasoningEffort !== undefined) return true;
    if (adapterConfig.thinkingEffort !== undefined) return true;
  }
  return false;
}

function cleanHermesOpenCodeConfig(adapterConfig: Record<string, unknown>): Record<string, unknown> {
  const next = { ...adapterConfig };
  delete next.effort;
  delete next.modelReasoningEffort;
  delete next.thinkingEffort;
  delete next.variant;
  return next;
}

export function adapterSupportsOpenCodeGoRoleRouting(adapterType: string): boolean {
  return OPENCODE_GO_ROUTED_ADAPTERS.has(adapterType);
}

export function isModelQuotaStallText(text: string | null | undefined): boolean {
  return typeof text === "string" && MODEL_QUOTA_STALL_PATTERN.test(text);
}

export function adapterSupportsTieredExecutionFallback(adapterType: string): boolean {
  return TIERED_EXECUTION_SOURCE_ADAPTERS.has(adapterType);
}

export function resolveAgentTieredExecutionRouting(input: {
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  availableAdapters: Partial<Record<TieredExecutionAdapterType, boolean>>;
  recentStall?: boolean;
  stallReason?: string | null;
  contextSnapshot?: Record<string, unknown>;
}): TieredExecutionRoutingResult {
  const policy = tieredExecutionPolicy(input.adapterConfig);
  if (policy.enabled === false) {
    return {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }

  const forced = contextForcesTieredFallback(input.contextSnapshot ?? {});
  if (!adapterSupportsTieredExecutionFallback(input.adapterType) && !forced) {
    return {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }
  if (input.recentStall !== true && !forced) {
    return {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }

  const candidates = resolveTieredAdapterOrder({
    role: input.role,
    adapterConfig: input.adapterConfig,
  });
  const selectedAdapterType =
    candidates.find((candidate) => candidate !== input.adapterType && input.availableAdapters[candidate] === true) ??
    null;

  if (!selectedAdapterType) {
    return {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }

  const adapterConfig = buildFallbackConfig({
    adapterType: selectedAdapterType,
    adapterConfig: input.adapterConfig,
    role: input.role,
  });
  return {
    adapterType: selectedAdapterType,
    adapterConfig,
    changed: selectedAdapterType !== input.adapterType,
    route: {
      source: "tiered_execution_policy",
      reason:
        input.stallReason ??
        (forced ? "forced_tiered_fallback" : "recent_model_quota_or_usage_stall"),
      originalAdapterType: input.adapterType,
      selectedAdapterType,
      model: asNonEmptyString(adapterConfig.model),
      candidates,
    },
  };
}

export function resolveAgentOpenCodeGoRoleRouting(input: {
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  force?: boolean;
}): AdapterModelRoutingResult {
  if (!adapterSupportsOpenCodeGoRoleRouting(input.adapterType)) {
    return {
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }

  const route = resolveOpenCodeGoRoutingForRole(input.role);
  const shouldRoute = input.force === true || shouldApplyDefaultRouting(input.adapterType, input.adapterConfig);
  if (!shouldRoute) {
    return {
      adapterConfig: input.adapterConfig,
      changed: false,
      route: {
        model: route.primaryModel,
        variant: route.variant,
        provider: "opencode-go",
        source: "opencode_go_role_matrix",
      },
    };
  }

  if (input.adapterType === "opencode_local") {
    const next = {
      ...input.adapterConfig,
      model: route.model,
      variant: route.variant,
    };
    return {
      adapterConfig: next,
      changed:
        next.model !== input.adapterConfig.model ||
        next.variant !== input.adapterConfig.variant,
      route: {
        model: route.primaryModel,
        variant: route.variant,
        provider: "opencode-go",
        source: "opencode_go_role_matrix",
      },
    };
  }

  const currentModel = asNonEmptyString(input.adapterConfig.model);
  const hermesModel = stripOpenCodeGoProvider(route.primaryModel);
  const next = {
    ...cleanHermesOpenCodeConfig(input.adapterConfig),
    model: hermesModel,
    provider: "auto",
  };
  return {
    adapterConfig: next,
    changed:
      currentModel !== hermesModel ||
      asNonEmptyString(input.adapterConfig.provider) !== "auto" ||
      input.adapterConfig.variant !== undefined ||
      input.adapterConfig.effort !== undefined ||
      input.adapterConfig.modelReasoningEffort !== undefined ||
      input.adapterConfig.thinkingEffort !== undefined,
    route: {
      model: route.primaryModel,
      variant: route.variant,
      provider: "opencode-go",
      source: "opencode_go_role_matrix",
    },
  };
}
