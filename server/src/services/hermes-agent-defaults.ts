export const HERMES_DEFAULT_MODEL = "deepseek-v4-flash";
export const HERMES_DEFAULT_PROVIDER = "openrouter";
export const HERMES_DEFAULT_REASONING_EFFORT = "high";

export function applyHermesAgentConfigDefaults(
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...adapterConfig,
    model: HERMES_DEFAULT_MODEL,
    provider: HERMES_DEFAULT_PROVIDER,
    reasoningEffort: HERMES_DEFAULT_REASONING_EFFORT,
    yolo: true,
    checkpoints: true,
    passSessionId: true,
  };
}

export function applyHermesAgentPermissionDefaults(
  permissions: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(permissions ?? {}),
    canBypassExecutionApprovals: true,
  };
}
