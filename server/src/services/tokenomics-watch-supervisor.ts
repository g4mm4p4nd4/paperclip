export type TokenomicsWatchState = "disabled" | "starting" | "healthy" | "degraded" | "stale";

export interface TokenomicsWatchSnapshot {
  enabled: boolean;
  state: TokenomicsWatchState;
  intervalSeconds: number;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastReceiptPath: string | null;
  lastReportStatus: string | null;
  consecutiveFailures: number;
  freshnessAgeSeconds: number | null;
  staleAfterSeconds: number;
  lastFailureCode: string | null;
}

export interface TokenomicsWatchSupervisorOptions {
  enabled: boolean;
  intervalSeconds: number;
  run: () => Promise<{ status?: unknown; receiptPath?: unknown }>;
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onSuccess?: (snapshot: TokenomicsWatchSnapshot) => void;
  onFailure?: (error: unknown, snapshot: TokenomicsWatchSnapshot) => void;
}

function failureCode(error: unknown) {
  if (!error || typeof error !== "object") return "tokenomics_watch_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[a-z0-9_.-]{1,100}$/i.test(code)) return code;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && /^[a-z0-9_.-]{1,100}$/i.test(name)) return name;
  return "tokenomics_watch_failed";
}

function safeStatus(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,100}$/i.test(value) ? value : "unknown";
}

function safeReceiptPath(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/.test(value) ? value : null;
}

export function createTokenomicsWatchSupervisor(options: TokenomicsWatchSupervisorOptions) {
  const intervalSeconds = Math.max(60, Math.floor(options.intervalSeconds));
  const staleAfterSeconds = intervalSeconds * 2;
  const clock = options.now ?? (() => new Date());
  const schedule = options.setIntervalFn ?? setInterval;
  const cancel = options.clearIntervalFn ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastStartedAt: Date | null = null;
  let lastCompletedAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let lastReceiptPath: string | null = null;
  let lastReportStatus: string | null = null;
  let consecutiveFailures = 0;
  let lastFailureCode: string | null = null;

  function snapshot(now = clock()): TokenomicsWatchSnapshot {
    const freshnessAgeSeconds = lastSuccessAt
      ? Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000))
      : null;
    const stale = options.enabled && freshnessAgeSeconds !== null && freshnessAgeSeconds > staleAfterSeconds;
    const state: TokenomicsWatchState = !options.enabled
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
      lastReportStatus,
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
      lastCompletedAt = clock();
      lastReceiptPath = safeReceiptPath(result.receiptPath);
      lastReportStatus = safeStatus(result.status);
      if (lastReportStatus !== "pass") {
        throw Object.assign(
          new Error(`Tokenomics report status ${lastReportStatus} is not promotion-safe.`),
          { code: `tokenomics_report_${lastReportStatus}` },
        );
      }
      lastSuccessAt = lastCompletedAt;
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
