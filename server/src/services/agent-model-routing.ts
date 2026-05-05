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

const OPENCODE_GO_ROUTED_ADAPTERS = new Set(["hermes_local", "opencode_local"]);

const STALE_GPT_MODEL_PATTERN = /^(openai\/)?gpt-5\./i;
const STALE_CLAUDE_MODEL_PATTERN = /^(anthropic\/)?claude-/i;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
