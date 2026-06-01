export const OPENCODE_GO_PROVIDER = "opencode-go" as const;
export const OPENCODE_ZEN_PROVIDER = "opencode-zen" as const;

export const OPENCODE_GO_MODEL_IDS = [
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "glm-5.1",
  "glm-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "hy3-preview",
] as const;

export type OpenCodeGoModelId = (typeof OPENCODE_GO_MODEL_IDS)[number];
export type OpenCodeGoQualifiedModelId = `${typeof OPENCODE_GO_PROVIDER}/${OpenCodeGoModelId}`;
export const OPENCODE_ZEN_FREE_MODEL_IDS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-super-free",
  "big-pickle",
] as const;

export type OpenCodeZenFreeModelId = (typeof OPENCODE_ZEN_FREE_MODEL_IDS)[number];
export type OpenCodeZenFreeQualifiedModelId = `${typeof OPENCODE_ZEN_PROVIDER}/${OpenCodeZenFreeModelId}`;
export type OpenCodeGoVariant = "medium" | "high";

export type PaperclipOpenCodeGoRole =
  | "ceo"
  | "cto"
  | "cmo"
  | "cfo"
  | "engineer"
  | "integration_engineer"
  | "designer"
  | "pm"
  | "qa"
  | "devops"
  | "researcher"
  | "skill_curator"
  | "general"
  | "default";

export type OpenCodeGoFallback = {
  model: OpenCodeGoModelId;
  reason: string;
};

export type OpenCodeGoRoleRoute = {
  role: PaperclipOpenCodeGoRole;
  primaryModel: OpenCodeGoModelId;
  model: OpenCodeGoQualifiedModelId;
  variant: OpenCodeGoVariant;
  fallbacks: OpenCodeGoFallback[];
};

export type OpenCodeGoModel = {
  id: OpenCodeGoQualifiedModelId;
  label: string;
};

export type OpenCodeZenFreeModel = {
  id: OpenCodeZenFreeQualifiedModelId;
  label: string;
};

const MODEL_LABELS: Record<OpenCodeGoModelId, string> = {
  "minimax-m2.7": "MiniMax M2.7",
  "minimax-m2.5": "MiniMax M2.5",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "glm-5.1": "GLM 5.1",
  "glm-5": "GLM 5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "qwen3.7-max": "Qwen3.7 Max",
  "qwen3.6-plus": "Qwen3.6 Plus",
  "qwen3.5-plus": "Qwen3.5 Plus",
  "mimo-v2-pro": "MiMo V2 Pro",
  "mimo-v2-omni": "MiMo V2 Omni",
  "mimo-v2.5-pro": "MiMo V2.5 Pro",
  "mimo-v2.5": "MiMo V2.5",
  "hy3-preview": "HY3 Preview",
};

const ZEN_FREE_MODEL_LABELS: Record<OpenCodeZenFreeModelId, string> = {
  "deepseek-v4-flash-free": "DeepSeek V4 Flash Free",
  "mimo-v2.5-free": "MiMo V2.5 Free",
  "nemotron-3-super-free": "Nemotron 3 Super Free",
  "big-pickle": "Big Pickle Free",
};

export const OPENCODE_GO_MODEL_CONTEXT_LIMITS: Record<OpenCodeGoModelId, number | null> = {
  "minimax-m2.7": 204_800,
  "minimax-m2.5": 204_800,
  "kimi-k2.6": 262_144,
  "kimi-k2.5": 262_144,
  "glm-5.1": 202_752,
  "glm-5": 202_752,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "qwen3.7-max": 1_000_000,
  "qwen3.6-plus": 262_144,
  "qwen3.5-plus": 262_144,
  "mimo-v2-pro": 1_048_576,
  "mimo-v2-omni": 262_144,
  "mimo-v2.5-pro": 1_048_576,
  "mimo-v2.5": 1_000_000,
  "hy3-preview": null,
};

export const OPENCODE_ZEN_FREE_MODEL_CONTEXT_LIMITS: Record<OpenCodeZenFreeModelId, number | null> = {
  "deepseek-v4-flash-free": 1_000_000,
  "mimo-v2.5-free": 1_000_000,
  "nemotron-3-super-free": null,
  "big-pickle": null,
};

export function toOpenCodeGoModelId(modelId: OpenCodeGoModelId): OpenCodeGoQualifiedModelId {
  return `${OPENCODE_GO_PROVIDER}/${modelId}`;
}

export function toOpenCodeZenModelId(modelId: OpenCodeZenFreeModelId): OpenCodeZenFreeQualifiedModelId {
  return `${OPENCODE_ZEN_PROVIDER}/${modelId}`;
}

export function stripOpenCodeGoProvider(modelId: string): string {
  const trimmed = modelId.trim();
  const prefix = `${OPENCODE_GO_PROVIDER}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

export function isOpenCodeGoModelId(modelId: string): modelId is OpenCodeGoModelId {
  return (OPENCODE_GO_MODEL_IDS as readonly string[]).includes(stripOpenCodeGoProvider(modelId));
}

export function stripOpenCodeZenProvider(modelId: string): string {
  const trimmed = modelId.trim();
  const prefix = `${OPENCODE_ZEN_PROVIDER}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

export function isOpenCodeZenFreeModelId(modelId: string): modelId is OpenCodeZenFreeModelId {
  return (OPENCODE_ZEN_FREE_MODEL_IDS as readonly string[]).includes(stripOpenCodeZenProvider(modelId));
}

export const OPENCODE_GO_MODELS: OpenCodeGoModel[] = OPENCODE_GO_MODEL_IDS.map((modelId) => ({
  id: toOpenCodeGoModelId(modelId),
  label: `${OPENCODE_GO_PROVIDER}/${MODEL_LABELS[modelId]}`,
}));

export const OPENCODE_ZEN_FREE_MODELS: OpenCodeZenFreeModel[] = OPENCODE_ZEN_FREE_MODEL_IDS.map((modelId) => ({
  id: toOpenCodeZenModelId(modelId),
  label: `${OPENCODE_ZEN_PROVIDER}/${ZEN_FREE_MODEL_LABELS[modelId]}`,
}));

const route = (
  role: PaperclipOpenCodeGoRole,
  primaryModel: OpenCodeGoModelId,
  variant: OpenCodeGoVariant,
  fallbacks: OpenCodeGoFallback[],
): OpenCodeGoRoleRoute => ({
  role,
  primaryModel,
  model: toOpenCodeGoModelId(primaryModel),
  variant,
  fallbacks,
});

export const OPENCODE_GO_ROLE_ROUTING = {
  engineer: route("engineer", "deepseek-v4-flash", "high", [
    { model: "deepseek-v4-pro", reason: "hard debugging" },
    { model: "minimax-m2.7", reason: "cheap low-risk implementation" },
  ]),
  integration_engineer: route("integration_engineer", "deepseek-v4-flash", "high", [
    { model: "mimo-v2.5-pro", reason: "huge vendor docs/spec context" },
  ]),
  devops: route("devops", "deepseek-v4-flash", "high", [
    { model: "deepseek-v4-pro", reason: "incident and root-cause analysis" },
  ]),
  qa: route("qa", "deepseek-v4-flash", "high", [
    { model: "kimi-k2.6", reason: "screenshot and UI evidence" },
    { model: "qwen3.6-plus", reason: "structured visual review" },
  ]),
  cto: route("cto", "deepseek-v4-pro", "high", [
    { model: "glm-5.1", reason: "strict architecture/code-plan review" },
  ]),
  ceo: route("ceo", "deepseek-v4-pro", "high", [
    { model: "kimi-k2.6", reason: "multimodal product context" },
  ]),
  pm: route("pm", "kimi-k2.6", "high", [
    { model: "deepseek-v4-pro", reason: "high-stakes planning" },
    { model: "qwen3.6-plus", reason: "structured visual/product review" },
  ]),
  designer: route("designer", "kimi-k2.6", "high", [
    { model: "qwen3.6-plus", reason: "structured visual fallback" },
    { model: "mimo-v2-omni", reason: "visual fallback" },
  ]),
  researcher: route("researcher", "deepseek-v4-flash", "high", [
    { model: "deepseek-v4-pro", reason: "final synthesis" },
    { model: "kimi-k2.6", reason: "image and video inputs" },
  ]),
  skill_curator: route("skill_curator", "qwen3.5-plus", "medium", [
    { model: "deepseek-v4-flash", reason: "long-context skill/library scans" },
  ]),
  cmo: route("cmo", "kimi-k2.6", "high", [
    { model: "qwen3.6-plus", reason: "structured campaign assets" },
  ]),
  cfo: route("cfo", "deepseek-v4-pro", "high", [
    { model: "glm-5", reason: "budget-sensitive finance/planning passes" },
  ]),
  general: route("general", "deepseek-v4-flash", "medium", [
    { model: "qwen3.5-plus", reason: "cheap comments/docs triage" },
  ]),
  default: route("default", "deepseek-v4-flash", "medium", [
    { model: "qwen3.5-plus", reason: "cheap comments/docs triage" },
  ]),
} as const satisfies Record<PaperclipOpenCodeGoRole, OpenCodeGoRoleRoute>;

export function resolveOpenCodeGoRoutingForRole(role: string | null | undefined): OpenCodeGoRoleRoute {
  const normalized = typeof role === "string" ? role.trim() : "";
  if (normalized && normalized in OPENCODE_GO_ROLE_ROUTING) {
    return OPENCODE_GO_ROLE_ROUTING[normalized as PaperclipOpenCodeGoRole];
  }
  return OPENCODE_GO_ROLE_ROUTING.default;
}

export function collectOpenCodeGoRoutingModelIds(): OpenCodeGoQualifiedModelId[] {
  const ids = new Set<OpenCodeGoQualifiedModelId>();
  for (const route of Object.values(OPENCODE_GO_ROLE_ROUTING)) {
    ids.add(route.model);
    for (const fallback of route.fallbacks) {
      ids.add(toOpenCodeGoModelId(fallback.model));
    }
  }
  return Array.from(ids);
}
