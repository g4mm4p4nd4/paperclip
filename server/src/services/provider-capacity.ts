import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import type { ProviderReliabilityHealthTarget } from "./agent-model-routing.js";

type JsonRecord = Record<string, unknown>;

export type ProviderCapacityStatus = "available" | "exhausted" | "unknown" | "not_applicable";

export type ProviderCapacitySnapshot = {
  provider: string;
  status: ProviderCapacityStatus;
  source: "minimax_token_plan_remains" | "not_supported" | "missing_credentials" | "poll_error";
  checkedAt: string;
  expiresAt: string | null;
  reason: string | null;
  failureKind: string | null;
  detail: string | null;
  quota: {
    modelName: string | null;
    currentIntervalStatus: number | null;
    currentIntervalRemainingPercent: number | null;
    currentIntervalEndsAt: string | null;
    currentIntervalRemainingMs: number | null;
    currentWeeklyStatus: number | null;
    currentWeeklyRemainingPercent: number | null;
    currentWeeklyEndsAt: string | null;
    currentWeeklyRemainingMs: number | null;
    limitingWindow: "interval" | "weekly" | null;
  } | null;
};

type FetchLike = typeof fetch;

const MINIMAX_REMAINS_URL = "https://www.minimax.io/v1/token_plan/remains";
const MINIMAX_CAPACITY_AVAILABLE_TTL_MS = 60 * 1000;
const MINIMAX_CAPACITY_UNKNOWN_TTL_MS = 5 * 60 * 1000;
const MINIMAX_CAPACITY_RESET_GRACE_MS = 30 * 1000;
const MINIMAX_KEY_NAMES = [
  "MINIMAX_API_KEY",
  "MINIMAX_SUBSCRIPTION_KEY",
  "MINIMAX_TOKEN_PLAN_KEY",
  "MINIMAX_API_TOKEN",
] as const;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoFromMs(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function readEnvBindings(adapterConfig: Record<string, unknown>): Record<string, string> {
  const raw = asRecord(adapterConfig.env);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function readHermesEnv(adapterConfig: Record<string, unknown>): Promise<Record<string, string>> {
  if (process.env.NODE_ENV === "test" && process.env.PAPERCLIP_MINIMAX_QUOTA_POLL_READ_HERMES_ENV !== "1") {
    return {};
  }
  const env = readEnvBindings(adapterConfig);
  const hermesHome =
    asString(adapterConfig.hermesHome) ??
    asString(env.HERMES_HOME) ??
    asString(process.env.HERMES_HOME) ??
    path.join(os.homedir(), ".hermes");
  const envPath = path.join(hermesHome, ".env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  if (!contents) return {};
  return Object.fromEntries(
    Object.entries(parseEnvFileContents(contents)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function resolveMiniMaxTokenPlanKey(adapterConfig: Record<string, unknown>): Promise<string | null> {
  const configEnv = readEnvBindings(adapterConfig);
  const directCandidates = [
    asString(adapterConfig.minimaxApiKey),
    asString(adapterConfig.minimaxSubscriptionKey),
    asString(adapterConfig.subscriptionKey),
    asString(adapterConfig.apiKey),
  ];
  for (const candidate of directCandidates) {
    if (candidate) return candidate;
  }
  for (const key of MINIMAX_KEY_NAMES) {
    const candidate = asString(configEnv[key]) ?? asString(process.env[key]);
    if (candidate) return candidate;
  }
  const hermesEnv = await readHermesEnv(adapterConfig);
  for (const key of MINIMAX_KEY_NAMES) {
    const candidate = asString(hermesEnv[key]);
    if (candidate) return candidate;
  }
  return null;
}

function isMiniMaxProvider(provider: string | null | undefined) {
  return provider === "minimax" || provider === "minimax-cn";
}

function selectMiniMaxRemainRow(body: unknown): JsonRecord | null {
  const rows = Array.isArray(asRecord(body).model_remains) ? asRecord(body).model_remains as unknown[] : [];
  const records = rows.map(asRecord).filter((row) => Object.keys(row).length > 0);
  return records.find((row) => asString(row.model_name) === "general") ?? records[0] ?? null;
}

function addMs(now: Date, ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return new Date(now.getTime() + ms).toISOString();
}

function buildMiniMaxCapacitySnapshot(input: {
  provider: string;
  now: Date;
  body: unknown;
}): ProviderCapacitySnapshot {
  const row = selectMiniMaxRemainRow(input.body);
  if (!row) {
    return {
      provider: input.provider,
      status: "unknown",
      source: "poll_error",
      checkedAt: input.now.toISOString(),
      expiresAt: addMs(input.now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS),
      reason: "provider_capacity_unavailable",
      failureKind: null,
      detail: "MiniMax Token Plan response did not include model_remains usage rows.",
      quota: null,
    };
  }

  const intervalPercent = asNumber(row.current_interval_remaining_percent);
  const weeklyPercent = asNumber(row.current_weekly_remaining_percent);
  const intervalRemainingMs = asNumber(row.remains_time);
  const weeklyRemainingMs = asNumber(row.weekly_remains_time);
  const intervalEndsAtMs = asNumber(row.end_time);
  const weeklyEndsAtMs = asNumber(row.weekly_end_time);
  const intervalEndsAt = isoFromMs(intervalEndsAtMs) ?? addMs(input.now, intervalRemainingMs);
  const weeklyEndsAt = isoFromMs(weeklyEndsAtMs) ?? addMs(input.now, weeklyRemainingMs);
  const intervalAvailable = intervalPercent === null || intervalPercent > 0;
  const weeklyAvailable = weeklyPercent === null || weeklyPercent > 0;
  const limitingWindow = !weeklyAvailable ? "weekly" : !intervalAvailable ? "interval" : null;
  const status: ProviderCapacityStatus = intervalAvailable && weeklyAvailable ? "available" : "exhausted";
  const resetAt = limitingWindow === "weekly" ? weeklyEndsAt : limitingWindow === "interval" ? intervalEndsAt : null;
  const expiresAt = status === "available"
    ? addMs(input.now, MINIMAX_CAPACITY_AVAILABLE_TTL_MS)
    : resetAt
      ? new Date(new Date(resetAt).getTime() + MINIMAX_CAPACITY_RESET_GRACE_MS).toISOString()
      : addMs(input.now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS);

  const detailParts = [
    `MiniMax Token Plan general quota: 5h=${intervalPercent ?? "unknown"}% remaining`,
    `weekly=${weeklyPercent ?? "unknown"}% remaining`,
    resetAt ? `${limitingWindow} reset/release around ${resetAt}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    provider: input.provider,
    status,
    source: "minimax_token_plan_remains",
    checkedAt: input.now.toISOString(),
    expiresAt,
    reason: status === "exhausted" ? "provider_quota_failure" : null,
    failureKind: status === "exhausted" ? "provider_quota" : null,
    detail: detailParts.join("; "),
    quota: {
      modelName: asString(row.model_name),
      currentIntervalStatus: asNumber(row.current_interval_status),
      currentIntervalRemainingPercent: intervalPercent,
      currentIntervalEndsAt: intervalEndsAt,
      currentIntervalRemainingMs: intervalRemainingMs,
      currentWeeklyStatus: asNumber(row.current_weekly_status),
      currentWeeklyRemainingPercent: weeklyPercent,
      currentWeeklyEndsAt: weeklyEndsAt,
      currentWeeklyRemainingMs: weeklyRemainingMs,
      limitingWindow,
    },
  };
}

export async function evaluateProviderCapacity(input: {
  target: ProviderReliabilityHealthTarget | null;
  adapterConfig: Record<string, unknown>;
  now?: Date;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ProviderCapacitySnapshot | null> {
  const now = input.now ?? new Date();
  if (!input.target || !isMiniMaxProvider(input.target.provider)) {
    return input.target
      ? {
          provider: input.target.provider,
          status: "not_applicable",
          source: "not_supported",
          checkedAt: now.toISOString(),
          expiresAt: null,
          reason: null,
          failureKind: null,
          detail: null,
          quota: null,
        }
      : null;
  }

  const key = await resolveMiniMaxTokenPlanKey(input.adapterConfig);
  if (!key) {
    return {
      provider: input.target.provider,
      status: "unknown",
      source: "missing_credentials",
      checkedAt: now.toISOString(),
      expiresAt: addMs(now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS),
      reason: "provider_capacity_credentials_missing",
      failureKind: null,
      detail: "MiniMax Token Plan usage polling is unavailable because no MiniMax subscription key was found.",
      quota: null,
    };
  }

  const endpoint = asString(input.adapterConfig.minimaxTokenPlanRemainsUrl) ?? MINIMAX_REMAINS_URL;
  const timeoutMs = Math.max(1_000, Math.trunc(input.timeoutMs ?? 8_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      return {
        provider: input.target.provider,
        status: "unknown",
        source: "poll_error",
        checkedAt: now.toISOString(),
        expiresAt: addMs(now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS),
        reason: "provider_capacity_poll_failed",
        failureKind: null,
        detail: `MiniMax Token Plan usage poll failed with HTTP ${response.status}.`,
        quota: null,
      };
    }
    const baseResp = asRecord(asRecord(body).base_resp);
    const statusCode = asNumber(baseResp.status_code);
    if (statusCode !== null && statusCode !== 0) {
      return {
        provider: input.target.provider,
        status: "unknown",
        source: "poll_error",
        checkedAt: now.toISOString(),
        expiresAt: addMs(now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS),
        reason: "provider_capacity_poll_failed",
        failureKind: null,
        detail: `MiniMax Token Plan usage poll returned status_code=${statusCode}.`,
        quota: null,
      };
    }
    return buildMiniMaxCapacitySnapshot({
      provider: input.target.provider,
      now,
      body,
    });
  } catch (error) {
    return {
      provider: input.target.provider,
      status: "unknown",
      source: "poll_error",
      checkedAt: now.toISOString(),
      expiresAt: addMs(now, MINIMAX_CAPACITY_UNKNOWN_TTL_MS),
      reason: "provider_capacity_poll_failed",
      failureKind: null,
      detail: `MiniMax Token Plan usage poll failed: ${error instanceof Error ? error.message : String(error)}`,
      quota: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function providerCapacityIndicatesRecovery(snapshot: ProviderCapacitySnapshot | null | undefined): boolean {
  return snapshot?.status === "available";
}

export function providerCapacityIndicatesExhaustion(snapshot: ProviderCapacitySnapshot | null | undefined): boolean {
  return snapshot?.status === "exhausted";
}
