export type FactoryBaselineRefreshState = "disabled" | "starting" | "healthy" | "degraded" | "stale";

export interface FactoryBaselineRefreshSnapshot {
  enabled: boolean;
  state: FactoryBaselineRefreshState;
  intervalSeconds: number;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastReceiptPath: string | null;
  lastReceiptSha256: string | null;
  consecutiveFailures: number;
  freshnessAgeSeconds: number | null;
  staleAfterSeconds: number;
  lastFailureCode: string | null;
}

export interface FactoryBaselineRefreshSupervisorOptions {
  enabled: boolean;
  intervalSeconds: number;
  run: () => Promise<{ receiptPath: string; receiptSha256: string }>;
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onSuccess?: (snapshot: FactoryBaselineRefreshSnapshot) => void;
  onFailure?: (error: unknown, snapshot: FactoryBaselineRefreshSnapshot) => void;
}

function failureCode(error: unknown) {
  if (!error || typeof error !== "object") return "factory_baseline_refresh_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[a-z0-9_.-]{1,100}$/i.test(code)) return code;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && /^[a-z0-9_.-]{1,100}$/i.test(message)) return message;
  return "factory_baseline_refresh_failed";
}

function safeAbsolutePath(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/.test(value) ? value : null;
}

function safeSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/**
 * Keeps the immutable factory-baseline pointer inside the 120-second launch
 * freshness window. Every successful sample is still a new content-addressed
 * read-only receipt; only the atomic latest pointer is refreshed.
 */
export function createFactoryBaselineRefreshSupervisor(options: FactoryBaselineRefreshSupervisorOptions) {
  const intervalSeconds = Math.min(60, Math.max(30, Math.floor(options.intervalSeconds)));
  const staleAfterSeconds = 120;
  const clock = options.now ?? (() => new Date());
  const schedule = options.setIntervalFn ?? setInterval;
  const cancel = options.clearIntervalFn ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastStartedAt: Date | null = null;
  let lastCompletedAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let lastReceiptPath: string | null = null;
  let lastReceiptSha256: string | null = null;
  let consecutiveFailures = 0;
  let lastFailureCode: string | null = null;

  function snapshot(now = clock()): FactoryBaselineRefreshSnapshot {
    const freshnessAgeSeconds = lastSuccessAt
      ? Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000))
      : null;
    const stale = options.enabled && freshnessAgeSeconds !== null && freshnessAgeSeconds > staleAfterSeconds;
    const state: FactoryBaselineRefreshState = !options.enabled
      ? "disabled"
      : stale
        ? "stale"
        : consecutiveFailures > 0
          ? "degraded"
          : lastSuccessAt
            ? "healthy"
            : "starting";
    return {
      enabled: options.enabled,
      state,
      intervalSeconds,
      running,
      lastStartedAt: lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: lastCompletedAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lastReceiptPath,
      lastReceiptSha256,
      consecutiveFailures,
      freshnessAgeSeconds,
      staleAfterSeconds,
      lastFailureCode,
    };
  }

  async function runOnce() {
    if (!options.enabled || running) return snapshot();
    running = true;
    lastStartedAt = clock();
    try {
      const result = await options.run();
      const receiptPath = safeAbsolutePath(result.receiptPath);
      const receiptSha256 = safeSha256(result.receiptSha256);
      if (!receiptPath || !receiptSha256) {
        throw Object.assign(new Error("factory_baseline_refresh_result_invalid"), {
          code: "factory_baseline_refresh_result_invalid",
        });
      }
      lastCompletedAt = clock();
      lastSuccessAt = lastCompletedAt;
      lastReceiptPath = receiptPath;
      lastReceiptSha256 = receiptSha256;
      consecutiveFailures = 0;
      lastFailureCode = null;
      const current = snapshot(lastCompletedAt);
      options.onSuccess?.(current);
      return current;
    } catch (error) {
      lastCompletedAt = clock();
      consecutiveFailures += 1;
      lastFailureCode = failureCode(error);
      const current = snapshot(lastCompletedAt);
      options.onFailure?.(error, current);
      return current;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!options.enabled || timer) return snapshot();
    void runOnce();
    timer = schedule(() => void runOnce(), intervalSeconds * 1000);
    timer.unref?.();
    return snapshot();
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
  }

  return { start, stop, runOnce, snapshot };
}
