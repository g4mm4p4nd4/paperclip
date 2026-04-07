export const DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC = 2 * 60 * 60;
export const MAX_AGENT_HEARTBEAT_INTERVAL_SEC = DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampAgentHeartbeatIntervalSec(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_AGENT_HEARTBEAT_INTERVAL_SEC, Math.max(0, value));
}

export function normalizeAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
  if (!isRecord(runtimeConfig)) return {};

  const nextRuntimeConfig = { ...runtimeConfig };
  const heartbeat = isRecord(nextRuntimeConfig.heartbeat) ? { ...nextRuntimeConfig.heartbeat } : null;
  if (!heartbeat) return nextRuntimeConfig;

  const intervalSec = parseNumberLike(heartbeat.intervalSec);
  if (intervalSec !== null) {
    heartbeat.intervalSec = clampAgentHeartbeatIntervalSec(intervalSec);
  }

  nextRuntimeConfig.heartbeat = heartbeat;
  return nextRuntimeConfig;
}
