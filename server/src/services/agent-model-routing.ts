import {
  OPENCODE_GO_PROVIDER,
  OPENCODE_ZEN_PROVIDER,
  isOpenCodeGoModelId,
  isOpenCodeZenFreeModelId,
  normalizeOpenCodeGoModelForHermesOaCompat,
  resolveOpenCodeGoRoutingForRole,
  stripOpenCodeGoProvider,
  stripOpenCodeZenProvider,
} from "@paperclipai/adapter-opencode-local";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { normalizeCodexModelForRuntime } from "@paperclipai/adapter-codex-local/server";

type AdapterModelRoutingResult = {
  adapterConfig: Record<string, unknown>;
  changed: boolean;
  route: {
    model: string;
    variant: string;
    provider: "opencode-go" | "opencode-zen";
    source:
      | "opencode_go_role_matrix"
      | "opencode_go_explicit_model"
      | "opencode_zen_explicit_free_model";
  } | null;
};

export type TieredExecutionAdapterType =
  | "codex_local"
  | "claude_local"
  | "gemini_local"
  | "opencode_local"
  | "hermes_local";

export type TieredExecutionLane =
  | TieredExecutionAdapterType
  | "hermes_opencode_zen_free"
  | "hermes_openrouter";

export type TieredExecutionRoutingResult = {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  changed: boolean;
  route: {
    state: "degraded";
    source: "tiered_execution_policy";
    reason: string;
    originalAdapterType: string;
    selectedAdapterType: TieredExecutionAdapterType;
    selectedLane: TieredExecutionLane;
    provider: string | null;
    model: string | null;
    candidates: TieredExecutionLane[];
  } | null;
};

export type ProviderReliabilityHealthTarget = {
  adapterType: TieredExecutionAdapterType;
  lane: TieredExecutionLane;
  provider: string;
  model: string | null;
  cacheKey: string;
};

export type ModelRoutingRunHistoryEntry = {
  id: string;
  status: string;
  createdAt?: Date | string | null;
  error?: string | null;
  errorCode?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  resultText?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export type RecentModelStallForRouting = {
  runId: string;
  reason: string;
  failureKind: ProviderReliabilityFailureKind;
  stalledLanes: TieredExecutionLane[];
  stalledLaneModels?: Partial<Record<TieredExecutionLane, string | null>>;
};

export type ProviderReliabilityFailureKind =
  | "provider_auth"
  | "provider_billing"
  | "provider_model_access"
  | "provider_rate_limit"
  | "provider_quota";

export const DEFAULT_TIERED_FALLBACK_RECOVERY_PROBE_AFTER_MS = 30 * 60 * 1000;
const MAX_TIERED_FALLBACK_RECOVERY_PROBE_AFTER_MS = 24 * 60 * 60 * 1000;
const TIERED_FALLBACK_RECOVERY_PROBE_RESET_GRACE_MS = 5 * 60 * 1000;

const OPENCODE_GO_ROUTED_ADAPTERS = new Set(["hermes_local", "opencode_local"]);
const TIERED_EXECUTION_SOURCE_ADAPTERS = new Set(["hermes_local", "opencode_local"]);
const DEFAULT_HERMES_ZEN_FREE_MODEL = "deepseek-v4-flash-free";
const DEFAULT_OPENROUTER_FLASH_MODEL = "deepseek/deepseek-v4-flash";
const OPENCODE_GO_TO_OPENROUTER_MODEL: Record<string, string> = {
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m2.5": "minimax/minimax-m2.5",
  "kimi-k2.6": "moonshotai/kimi-k2.6",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
  "glm-5.1": "z-ai/glm-5.1",
  "glm-5": "z-ai/glm-5",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": DEFAULT_OPENROUTER_FLASH_MODEL,
  "qwen3.7-max": "qwen/qwen3.7-max",
  "qwen3.6-plus": "qwen/qwen3.6-plus",
  "qwen3.5-plus": "qwen/qwen3.5-plus-20260420",
  "mimo-v2-pro": "xiaomi/mimo-v2.5-pro",
  "mimo-v2-omni": "xiaomi/mimo-v2-flash",
  "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro",
  "mimo-v2.5": "xiaomi/mimo-v2.5",
  "hy3-preview": "tencent/hy3-preview",
};

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
const PROVIDER_RELIABILITY_FAILURE_PATTERNS: Array<{
  kind: ProviderReliabilityFailureKind;
  reason: string;
  pattern: RegExp;
}> = [
  {
    kind: "provider_billing",
    reason: "provider_billing_failure",
    pattern: /(insufficient balance|creditserror|credits error|out of credits|manage your billing|billing failure)/i,
  },
  {
    kind: "provider_auth",
    reason: "provider_auth_failure",
    pattern: /(authenticationerror|authentication error|failed to authenticate|unauthorized|http\s*401|\b401\b|api key was rejected|invalid api key|invalid key|invalid authentication credentials|invalid credentials|auth(?:entication)? required|login is required|login required|requires login)/i,
  },
  {
    kind: "provider_model_access",
    reason: "provider_model_access_failure",
    pattern: /(does your account have access|model access|model unavailable|configured model is unavailable|model not found|unsupported model|model is not supported|not supported when using codex|disabled model|http\s*403|\b403\b|forbidden)/i,
  },
  {
    kind: "provider_quota",
    reason: "provider_quota_failure",
    pattern: /(freeusagelimiterror|goUsageLimitError|usage limit reached|usage limit error|weekly usage limit|monthly usage limit|daily usage limit|5[-\s]?hour usage limit|monthly quota|quota exceeded|quota exhausted|quota exhaustion|over quota|insufficient_quota)/i,
  },
  {
    kind: "provider_rate_limit",
    reason: "provider_rate_limit_failure",
    pattern: /(rate limit|rate-limit|too many requests|http\s*429|\b429\b)/i,
  },
];

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

function isTieredExecutionLane(value: string): value is TieredExecutionLane {
  return (
    isTieredExecutionAdapterType(value) ||
    value === "hermes_opencode_zen_free" ||
    value === "hermes_openrouter"
  );
}

function tieredLaneAdapterType(value: TieredExecutionLane): TieredExecutionAdapterType {
  if (value === "hermes_opencode_zen_free" || value === "hermes_openrouter") {
    return "hermes_local";
  }
  return value;
}

function uniqueTieredLanes(values: string[]): TieredExecutionLane[] {
  const result: TieredExecutionLane[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const lane = value.trim();
    if (!isTieredExecutionLane(lane)) continue;
    if (seen.has(lane)) continue;
    seen.add(lane);
    result.push(lane);
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

function tieredLaneOverride(
  adapterConfig: Record<string, unknown>,
  lane: TieredExecutionLane,
) {
  const policy = tieredExecutionPolicy(adapterConfig);
  const adapterType = tieredLaneAdapterType(lane);
  const shorthand = lane.replace(/_local$/, "");
  return {
    ...tieredAdapterOverride(adapterConfig, adapterType),
    ...asRecord(policy[lane]),
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

function defaultTieredLaneOrder(): TieredExecutionLane[] {
  return [
    "hermes_openrouter",
    "hermes_opencode_zen_free",
    "gemini_local",
    "claude_local",
    "codex_local",
  ];
}

export function shouldReprobeProviderStallsForRun(input: {
  invocationSource?: string | null;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}): boolean {
  const context = asRecord(input.contextSnapshot);
  if (context.forceProviderReprobe === true) return true;
  if (context.forceProviderRecoveryProbe === true) return true;
  const wakeReason = asNonEmptyString(context.wakeReason);
  if (wakeReason === "retry_failed_run") return true;
  const wakeSource = asNonEmptyString(context.wakeSource);
  if (wakeSource === "on_demand") return true;
  if (input.invocationSource === "on_demand") return true;
  if (input.triggerDetail === "manual") return true;
  return false;
}

function resolveTieredAdapterOrder(input: {
  adapterConfig: Record<string, unknown>;
}) {
  const policy = tieredExecutionPolicy(input.adapterConfig);
  const configuredOrder = uniqueTieredLanes(asStringArray(policy.adapterOrder));
  return configuredOrder.length > 0 ? configuredOrder : defaultTieredLaneOrder();
}

function buildCodexFallbackConfig(
  adapterConfig: Record<string, unknown>,
  role: string,
) {
  const override = tieredAdapterOverride(adapterConfig, "codex_local");
  const overrideRest = { ...override };
  delete overrideRest.model;
  const heavyRole = HEAVY_IMPLEMENTATION_ROLES.has(role.trim().toLowerCase());
  const configuredModel = asNonEmptyString(override.model) ?? DEFAULT_CODEX_LOCAL_MODEL;
  const modelNormalization = normalizeCodexModelForRuntime(configuredModel, "subscription");
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    modelReasoningEffort: asNonEmptyString(override.modelReasoningEffort) ?? (heavyRole ? "high" : "medium"),
    search: override.search === true,
    dangerouslyBypassApprovalsAndSandbox: override.dangerouslyBypassApprovalsAndSandbox !== false,
    ...overrideRest,
    model: modelNormalization?.effectiveModel ?? configuredModel,
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

function stripOpenRouterProvider(model: string) {
  if (model.startsWith("openrouter/")) return model.slice("openrouter/".length);
  if (model.startsWith("openrouter:")) return model.slice("openrouter:".length);
  return model;
}

function providerFromQualifiedOpenCodeModel(model: string | null): string | null {
  if (!model) return null;
  if (model.startsWith(`${OPENCODE_GO_PROVIDER}/`)) return OPENCODE_GO_PROVIDER;
  if (model.startsWith(`${OPENCODE_ZEN_PROVIDER}/`)) return OPENCODE_ZEN_PROVIDER;
  return null;
}

function openRouterModelForOpenCodeGoModel(model: string | null) {
  if (!model) return null;
  const bareModel = stripOpenCodeGoProvider(model);
  if (!isOpenCodeGoModelId(bareModel)) return null;
  return OPENCODE_GO_TO_OPENROUTER_MODEL[bareModel] ?? null;
}

function intendedOpenRouterModel(input: {
  adapterConfig: Record<string, unknown>;
  role: string;
}) {
  const configuredModel = asNonEmptyString(input.adapterConfig.model);
  const configuredProvider = asNonEmptyString(input.adapterConfig.provider);
  if (configuredModel && configuredModel !== "auto") {
    const bareModel = stripOpenCodeGoProvider(configuredModel);
    if (isOpenCodeGoModelId(bareModel)) {
      return openRouterModelForOpenCodeGoModel(bareModel);
    }
  }
  if (configuredProvider === OPENCODE_GO_PROVIDER) {
    return openRouterModelForOpenCodeGoModel(configuredModel);
  }
  return openRouterModelForOpenCodeGoModel(resolveOpenCodeGoRoutingForRole(input.role).primaryModel) ??
    DEFAULT_OPENROUTER_FLASH_MODEL;
}

function buildHermesOpenCodeZenFreeFallbackConfig(adapterConfig: Record<string, unknown>) {
  const override = tieredLaneOverride(adapterConfig, "hermes_opencode_zen_free");
  const overrideRest = { ...override };
  delete overrideRest.model;
  delete overrideRest.provider;
  const configuredModel = asNonEmptyString(override.model);
  const model = configuredModel
    ? stripOpenCodeZenProvider(configuredModel)
    : DEFAULT_HERMES_ZEN_FREE_MODEL;
  return guardHermesOpenCodeFallbackModel(adapterConfig, {
    ...cleanHermesOpenCodeConfig(preservePortableExecutionConfig(adapterConfig)),
    ...overrideRest,
    model,
    provider: OPENCODE_ZEN_PROVIDER,
  });
}

function buildHermesOpenRouterFallbackConfig(
  adapterConfig: Record<string, unknown>,
  role: string,
) {
  const override = tieredLaneOverride(adapterConfig, "hermes_openrouter");
  const overrideRest = { ...override };
  delete overrideRest.model;
  delete overrideRest.provider;
  const configuredModel = asNonEmptyString(override.model);
  const model = configuredModel
    ? stripOpenRouterProvider(configuredModel)
    : intendedOpenRouterModel({ adapterConfig, role });
  return guardHermesOpenCodeFallbackModel(adapterConfig, {
    ...cleanHermesOpenCodeConfig(preservePortableExecutionConfig(adapterConfig)),
    ...overrideRest,
    model,
    provider: "openrouter",
  });
}

function buildOpenCodeFallbackConfig(adapterConfig: Record<string, unknown>) {
  return {
    ...preservePortableExecutionConfig(adapterConfig),
    ...tieredAdapterOverride(adapterConfig, "opencode_local"),
  };
}

function buildFallbackConfig(input: {
  lane: TieredExecutionLane;
  adapterConfig: Record<string, unknown>;
  role: string;
}) {
  switch (input.lane) {
    case "hermes_opencode_zen_free":
      return buildHermesOpenCodeZenFreeFallbackConfig(input.adapterConfig);
    case "hermes_openrouter":
      return buildHermesOpenRouterFallbackConfig(input.adapterConfig, input.role);
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

function contextHasTieredFallbackRoute(contextSnapshot: Record<string, unknown> | null | undefined): boolean {
  const routing = asRecord(contextSnapshot?.paperclipExecutionRouting);
  if (routing.source !== "tiered_execution_policy") return false;
  const originalAdapterType = asNonEmptyString(routing.originalAdapterType);
  const selectedAdapterType = asNonEmptyString(routing.selectedAdapterType);
  const selectedLane = asNonEmptyString(routing.selectedLane);
  return Boolean(
    originalAdapterType &&
    (
      (selectedLane && selectedLane !== originalAdapterType) ||
      (selectedAdapterType && originalAdapterType !== selectedAdapterType)
    ),
  );
}

function tieredLaneEvidenceForRun(run: ModelRoutingRunHistoryEntry): {
  lane: TieredExecutionLane;
  model: string | null;
} | null {
  const routing = asRecord(run.contextSnapshot?.paperclipExecutionRouting);
  if (routing.source !== "tiered_execution_policy") return null;
  const selectedLane = asNonEmptyString(routing.selectedLane);
  if (selectedLane && isTieredExecutionLane(selectedLane)) {
    return {
      lane: selectedLane,
      model: asNonEmptyString(routing.model),
    };
  }
  const selectedAdapterType = asNonEmptyString(routing.selectedAdapterType);
  return selectedAdapterType && isTieredExecutionLane(selectedAdapterType)
    ? {
        lane: selectedAdapterType,
        model: asNonEmptyString(routing.model),
      }
    : null;
}

function providerPreflightStalledLaneEvidenceForRun(run: ModelRoutingRunHistoryEntry, nowMs?: number): Array<{
  lane: TieredExecutionLane;
  model: string | null;
}>;
function providerPreflightStalledLaneEvidenceForRun(
  run: ModelRoutingRunHistoryEntry,
  nowMs?: number,
): Array<{
  lane: TieredExecutionLane;
  model: string | null;
}> {
  const evidence: Array<{ lane: TieredExecutionLane; model: string | null }> = [];
  const seen = new Set<TieredExecutionLane>();
  const addAttempt = (raw: unknown) => {
    const attempt = asRecord(raw);
    if (asNonEmptyString(attempt.status) !== "degraded") return;
    const expiresAt = asNonEmptyString(attempt.expiresAt);
    if (expiresAt && typeof nowMs === "number") {
      const expiresAtMs = Date.parse(expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return;
    }
    const target = asRecord(attempt.target);
    const lane = asNonEmptyString(target.lane);
    if (!lane || !isTieredExecutionLane(lane) || seen.has(lane)) return;
    seen.add(lane);
    evidence.push({ lane, model: asNonEmptyString(target.model) });
  };
  const addFromContainer = (raw: unknown) => {
    const container = asRecord(raw);
    addAttempt(container.preflight);
    const attempts = Array.isArray(container.preflightAttempts) ? container.preflightAttempts : [];
    for (const attempt of attempts) addAttempt(attempt);
  };

  addFromContainer(asRecord(run.contextSnapshot?.paperclipProviderReliabilityGate));
  addFromContainer(asRecord(run.contextSnapshot?.paperclipExecutionRouting));
  return evidence;
}

function modelStallTextForRun(run: ModelRoutingRunHistoryEntry): string {
  return [
    run.error,
    run.errorCode,
    run.stderrExcerpt,
    run.stdoutExcerpt,
    run.resultText,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

export function filterProviderReliabilityFailureRunsForRouting(
  runs: ModelRoutingRunHistoryEntry[],
): ModelRoutingRunHistoryEntry[] {
  return runs.filter((run) => classifyProviderReliabilityFailureText(modelStallTextForRun(run)) !== null);
}

function parseResetDurationMs(text: string): number | null {
  const resetMatch = text.match(/resets?\s+in\s+([^\n.]+)/i);
  if (!resetMatch) return null;

  const durationText = resetMatch[1];
  const componentPattern =
    /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
  let totalMs = 0;
  let matched = false;
  for (const match of durationText.matchAll(componentPattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const unit = match[2].toLowerCase();
    matched = true;
    if (unit === "d" || unit.startsWith("day")) totalMs += amount * 24 * 60 * 60 * 1000;
    else if (unit === "h" || unit === "hr" || unit === "hrs" || unit.startsWith("hour")) {
      totalMs += amount * 60 * 60 * 1000;
    } else if (unit === "m" || unit === "min" || unit === "mins" || unit.startsWith("minute")) {
      totalMs += amount * 60 * 1000;
    } else {
      totalMs += amount * 1000;
    }
  }

  return matched ? totalMs : null;
}

function recoveryProbeAfterMsForStallText(text: string, defaultMs: number): number {
  const resetDurationMs = parseResetDurationMs(text);
  if (resetDurationMs === null) return defaultMs;
  return Math.min(
    Math.max(defaultMs, resetDurationMs + TIERED_FALLBACK_RECOVERY_PROBE_RESET_GRACE_MS),
    MAX_TIERED_FALLBACK_RECOVERY_PROBE_AFTER_MS,
  );
}

export function classifyProviderReliabilityFailureText(text: string | null | undefined): {
  kind: ProviderReliabilityFailureKind;
  reason: string;
} | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  for (const entry of PROVIDER_RELIABILITY_FAILURE_PATTERNS) {
    if (entry.pattern.test(text)) {
      return {
        kind: entry.kind,
        reason: entry.reason,
      };
    }
  }
  return null;
}

export function resolveProviderReliabilityGateFailureKind(input: {
  hasTieredRoute: boolean;
  recentFailureKind?: string | null;
  preflightStatus?: "healthy" | "degraded" | "unknown" | null;
  preflightFailureKind?: string | null;
}) {
  if (input.hasTieredRoute) {
    return input.recentFailureKind ?? input.preflightFailureKind ?? null;
  }
  if (input.preflightStatus === "degraded") {
    return input.preflightFailureKind ?? input.recentFailureKind ?? null;
  }
  return input.preflightFailureKind ?? null;
}

function modelStallForRun(
  run: ModelRoutingRunHistoryEntry,
  defaultRecoveryProbeAfterMs: number,
): { reason: string; failureKind: ProviderReliabilityFailureKind; recoveryProbeAfterMs: number } | null {
  const text = modelStallTextForRun(run);
  const failure = classifyProviderReliabilityFailureText(text);
  if (!failure) return null;
  return {
    reason: failure.reason,
    failureKind: failure.kind,
    recoveryProbeAfterMs: recoveryProbeAfterMsForStallText(text, defaultRecoveryProbeAfterMs),
  };
}

function runCreatedAtMs(run: ModelRoutingRunHistoryEntry): number | null {
  if (run.createdAt instanceof Date) {
    const ms = run.createdAt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof run.createdAt === "string" && run.createdAt.trim().length > 0) {
    const ms = Date.parse(run.createdAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function selectRecentModelStallForRouting(
  runs: ModelRoutingRunHistoryEntry[],
  opts: { now?: Date; recoveryProbeAfterMs?: number } = {},
): RecentModelStallForRouting | null {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
  const recoveryProbeAfterMs =
    typeof opts.recoveryProbeAfterMs === "number" && opts.recoveryProbeAfterMs >= 0
      ? opts.recoveryProbeAfterMs
      : DEFAULT_TIERED_FALLBACK_RECOVERY_PROBE_AFTER_MS;

  const stalledLanes = new Set<TieredExecutionLane>();
  const stalledLaneModels: Partial<Record<TieredExecutionLane, string | null>> = {};
  let firstStall: RecentModelStallForRouting | null = null;

  for (const run of runs) {
    const stall = modelStallForRun(run, recoveryProbeAfterMs);
    if (stall) {
      const createdAtMs = runCreatedAtMs(run);
      if (
        createdAtMs !== null &&
        Number.isFinite(nowMs) &&
        nowMs - createdAtMs >= stall.recoveryProbeAfterMs
      ) {
        continue;
      }
      const stalledLaneEvidence = providerPreflightStalledLaneEvidenceForRun(run, nowMs);
      const fallbackStalledLane = stalledLaneEvidence.length === 0 && run.status !== "succeeded"
        ? tieredLaneEvidenceForRun(run)
        : null;
      for (const stalledLane of fallbackStalledLane ? [fallbackStalledLane] : stalledLaneEvidence) {
        stalledLanes.add(stalledLane.lane);
        if (!(stalledLane.lane in stalledLaneModels)) {
          stalledLaneModels[stalledLane.lane] = stalledLane.model;
        }
      }
      if (!firstStall) {
        firstStall = {
          runId: run.id,
          reason: stall.reason,
          failureKind: stall.failureKind,
          stalledLanes: [],
        };
      }
      continue;
    }

    if (run.status === "succeeded" && !contextHasTieredFallbackRoute(run.contextSnapshot)) {
      if (!firstStall) return null;
      break;
    }
  }

  if (!firstStall) return null;
  const modelEntries = Object.entries(stalledLaneModels);
  return {
    ...firstStall,
    stalledLanes: Array.from(stalledLanes),
    ...(modelEntries.length > 0 ? { stalledLaneModels } : {}),
  };
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

function guardHermesOpenCodeFallbackModel(
  adapterConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
) {
  if (adapterConfig.disableFallbackModel === false) return nextConfig;
  return {
    ...nextConfig,
    disableFallbackModel: true,
  };
}

function normalizeExplicitHermesOpenCodeConfig(adapterConfig: Record<string, unknown>):
  | {
      adapterConfig: Record<string, unknown>;
      provider: typeof OPENCODE_GO_PROVIDER | typeof OPENCODE_ZEN_PROVIDER;
      model: string;
      source: "opencode_go_explicit_model" | "opencode_zen_explicit_free_model";
    }
  | null {
  const model = asNonEmptyString(adapterConfig.model);
  if (!model || model === "auto") return null;

  if (isOpenCodeGoModelId(model)) {
    const selectedModel = stripOpenCodeGoProvider(model);
    const bareModel = normalizeOpenCodeGoModelForHermesOaCompat(selectedModel);
    return {
      adapterConfig: guardHermesOpenCodeFallbackModel(adapterConfig, {
        ...cleanHermesOpenCodeConfig(adapterConfig),
        model: bareModel,
        provider: OPENCODE_GO_PROVIDER,
      }),
      provider: OPENCODE_GO_PROVIDER,
      model: bareModel,
      source: "opencode_go_explicit_model",
    };
  }

  if (isOpenCodeZenFreeModelId(model)) {
    const bareModel = stripOpenCodeZenProvider(model);
    return {
      adapterConfig: guardHermesOpenCodeFallbackModel(adapterConfig, {
        ...cleanHermesOpenCodeConfig(adapterConfig),
        model: bareModel,
        provider: OPENCODE_ZEN_PROVIDER,
      }),
      provider: OPENCODE_ZEN_PROVIDER,
      model: bareModel,
      source: "opencode_zen_explicit_free_model",
    };
  }

  return null;
}

export function adapterSupportsOpenCodeGoRoleRouting(adapterType: string): boolean {
  return OPENCODE_GO_ROUTED_ADAPTERS.has(adapterType);
}

export function isModelQuotaStallText(text: string | null | undefined): boolean {
  return classifyProviderReliabilityFailureText(text) !== null;
}

export function adapterSupportsTieredExecutionFallback(adapterType: string): boolean {
  return TIERED_EXECUTION_SOURCE_ADAPTERS.has(adapterType);
}

export function resolveProviderReliabilityHealthTarget(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  selectedLane?: TieredExecutionLane | null;
}): ProviderReliabilityHealthTarget | null {
  if (!isTieredExecutionAdapterType(input.adapterType)) return null;

  const adapterType = input.adapterType;
  const model = asNonEmptyString(input.adapterConfig.model);
  const configuredProvider = asNonEmptyString(input.adapterConfig.provider);
  let provider: string | null = null;
  let lane: TieredExecutionLane = input.selectedLane ?? adapterType;

  if (adapterType === "hermes_local") {
    provider = configuredProvider;
    if (!provider || provider === "auto") return null;
    if (provider === "openrouter") {
      lane = input.selectedLane ?? "hermes_openrouter";
    } else if (provider === OPENCODE_ZEN_PROVIDER) {
      lane = input.selectedLane ?? "hermes_opencode_zen_free";
    } else if (provider === OPENCODE_GO_PROVIDER) {
      lane = input.selectedLane ?? "hermes_local";
    } else {
      return null;
    }
  } else if (adapterType === "opencode_local") {
    provider = providerFromQualifiedOpenCodeModel(model) ?? configuredProvider;
    if (provider !== OPENCODE_GO_PROVIDER && provider !== OPENCODE_ZEN_PROVIDER) return null;
    lane = input.selectedLane ?? "opencode_local";
  } else if (adapterType === "codex_local") {
    provider = "openai";
  } else if (adapterType === "claude_local") {
    provider = "anthropic";
  } else if (adapterType === "gemini_local") {
    provider = "google";
  } else {
    return null;
  }

  return {
    adapterType,
    lane,
    provider,
    model,
    cacheKey: `${adapterType}:${lane}:${provider}:${model ?? "auto"}`,
  };
}

export function providerReliabilityTargetNeedles(
  target: Pick<ProviderReliabilityHealthTarget, "provider" | "model" | "lane">,
): string[] {
  const values = [target.provider, target.model, target.lane];
  if (target.provider === "openrouter") values.push("openrouter");
  if (target.provider === OPENCODE_GO_PROVIDER) values.push("opencode go", "opencode_go", "opencode-go");
  if (target.provider === OPENCODE_ZEN_PROVIDER) values.push("opencode zen", "opencode_zen", "opencode-zen");
  if (target.provider === "openai") values.push("openai", "codex", "chatgpt");
  if (target.provider === "anthropic") values.push("anthropic", "claude");
  if (target.provider === "google") values.push("google", "gemini");
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase()),
    ),
  );
}

export function isProviderReliabilityTextRelevantToTarget(
  text: string | null | undefined,
  target: Pick<ProviderReliabilityHealthTarget, "provider" | "model" | "lane">,
): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  const lowerText = text.toLowerCase();
  return providerReliabilityTargetNeedles(target).some((needle) => lowerText.includes(needle));
}

export function resolveAgentTieredExecutionRouting(input: {
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  availableAdapters: Partial<Record<TieredExecutionAdapterType, boolean>>;
  recentStall?: boolean;
  stallReason?: string | null;
  stallFailureKind?: string | null;
  stalledLanes?: TieredExecutionLane[];
  stalledLaneModels?: Partial<Record<TieredExecutionLane, string | null>>;
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
    adapterConfig: input.adapterConfig,
  });
  const stalledLanes = new Set(input.stalledLanes ?? []);
  const stalledLaneFailureIsModelSpecific = input.stallFailureKind === "provider_model_access";
  const selectedLane =
    candidates.find((candidate) => {
      if (stalledLanes.has(candidate)) {
        if (!stalledLaneFailureIsModelSpecific) return false;
        const stalledModel = input.stalledLaneModels?.[candidate];
        const candidateModel = asNonEmptyString(asRecord(buildFallbackConfig({
          lane: candidate,
          adapterConfig: input.adapterConfig,
          role: input.role,
        })).model);
        if (stalledModel === undefined || stalledModel === null || stalledModel === candidateModel) {
          return false;
        }
      }
      const candidateAdapterType = tieredLaneAdapterType(candidate);
      if (candidate === "hermes_opencode_zen_free" || candidate === "hermes_openrouter") {
        return input.adapterType === "hermes_local" || input.availableAdapters.hermes_local === true;
      }
      return candidateAdapterType !== input.adapterType && input.availableAdapters[candidateAdapterType] === true;
    }) ?? null;

  if (!selectedLane) {
    return {
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      changed: false,
      route: null,
    };
  }

  const selectedAdapterType = tieredLaneAdapterType(selectedLane);
  const adapterConfig = buildFallbackConfig({
    lane: selectedLane,
    adapterConfig: input.adapterConfig,
    role: input.role,
  });
  const provider = asNonEmptyString(asRecord(adapterConfig).provider);
  const changed =
    selectedAdapterType !== input.adapterType ||
    JSON.stringify(adapterConfig) !== JSON.stringify(input.adapterConfig);
  return {
    adapterType: selectedAdapterType,
    adapterConfig,
    changed,
    route: {
      state: "degraded",
      source: "tiered_execution_policy",
      reason:
        input.stallReason ??
        (forced ? "forced_tiered_fallback" : "recent_model_quota_or_usage_stall"),
      originalAdapterType: input.adapterType,
      selectedAdapterType,
      selectedLane,
      provider,
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
  if (input.adapterType === "hermes_local" && input.force !== true) {
    const explicit = normalizeExplicitHermesOpenCodeConfig(input.adapterConfig);
    if (explicit) {
      return {
        adapterConfig: explicit.adapterConfig,
        changed: JSON.stringify(explicit.adapterConfig) !== JSON.stringify(input.adapterConfig),
        route: {
          model:
            explicit.provider === OPENCODE_GO_PROVIDER
              ? `${OPENCODE_GO_PROVIDER}/${explicit.model}`
              : `${OPENCODE_ZEN_PROVIDER}/${explicit.model}`,
          variant: route.variant,
          provider: explicit.provider,
          source: explicit.source,
        },
      };
    }
  }

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
  const hermesModel = normalizeOpenCodeGoModelForHermesOaCompat(stripOpenCodeGoProvider(route.primaryModel));
  const next = guardHermesOpenCodeFallbackModel(input.adapterConfig, {
    ...cleanHermesOpenCodeConfig(input.adapterConfig),
    model: hermesModel,
    provider: OPENCODE_GO_PROVIDER,
  });
  return {
    adapterConfig: next,
    changed:
      currentModel !== hermesModel ||
      asNonEmptyString(input.adapterConfig.provider) !== OPENCODE_GO_PROVIDER ||
      input.adapterConfig.variant !== undefined ||
      input.adapterConfig.effort !== undefined ||
      input.adapterConfig.modelReasoningEffort !== undefined ||
      input.adapterConfig.thinkingEffort !== undefined ||
      next.disableFallbackModel !== input.adapterConfig.disableFallbackModel,
    route: {
      model: route.primaryModel,
      variant: route.variant,
      provider: "opencode-go",
      source: "opencode_go_role_matrix",
    },
  };
}
