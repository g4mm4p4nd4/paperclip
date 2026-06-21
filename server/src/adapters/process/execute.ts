import type { AdapterBillingType, AdapterExecutionContext, AdapterExecutionResult, AdapterProviderLaneTelemetry } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";

function parseStructuredProcessResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith(STRUCTURED_RESULT_MARKER)) continue;
    const rawJson = line.slice(STRUCTURED_RESULT_MARKER.length).trim();
    if (!rawJson) return null;
    try {
      const parsed = JSON.parse(rawJson);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeBillingType(value: unknown): AdapterBillingType | null {
  const raw = nonEmptyString(value);
  switch (raw) {
    case "api":
    case "subscription":
    case "metered_api":
    case "subscription_included":
    case "subscription_overage":
    case "credits":
    case "fixed":
    case "unknown":
      return raw;
    default:
      return null;
  }
}

function normalizeProviderLane(value: unknown): AdapterProviderLaneTelemetry | null {
  const lane = parseObject(value);
  if (Object.keys(lane).length === 0) return null;
  const telemetry: AdapterProviderLaneTelemetry = {
    lane: nonEmptyString(lane.lane),
    originalAdapterType: nonEmptyString(lane.originalAdapterType),
    selectedAdapterType: nonEmptyString(lane.selectedAdapterType),
    provider: nonEmptyString(lane.provider),
    biller: nonEmptyString(lane.biller),
    model: nonEmptyString(lane.model),
    billingType: normalizeBillingType(lane.billingType) ?? nonEmptyString(lane.billingType),
    cacheMode: nonEmptyString(lane.cacheMode),
    cacheSource: nonEmptyString(lane.cacheSource),
    cachedInputTokens: numberOrNull(lane.cachedInputTokens),
    cacheWriteInputTokens: numberOrNull(lane.cacheWriteInputTokens),
    quotaSource: nonEmptyString(lane.quotaSource),
    quotaStatus: nonEmptyString(lane.quotaStatus),
    contextPackProfile: nonEmptyString(lane.contextPackProfile),
    contextPackRepoSlug: nonEmptyString(lane.contextPackRepoSlug),
    contextPackManifestSha: nonEmptyString(lane.contextPackManifestSha),
    escalationReason: nonEmptyString(lane.escalationReason),
    escalationSource: nonEmptyString(lane.escalationSource),
    failureKind: nonEmptyString(lane.failureKind),
  };
  return Object.values(telemetry).some((entry) => entry !== null && entry !== undefined)
    ? telemetry
    : null;
}

function normalizeUsage(value: unknown): AdapterExecutionResult["usage"] | undefined {
  const usage = parseObject(value);
  if (Object.keys(usage).length === 0) return undefined;
  return {
    inputTokens: Math.max(0, Math.floor(numberOrNull(usage.inputTokens) ?? numberOrNull(usage.input_tokens) ?? 0)),
    cachedInputTokens: Math.max(
      0,
      Math.floor(
        numberOrNull(usage.cachedInputTokens) ??
          numberOrNull(usage.cached_input_tokens) ??
          numberOrNull(usage.cacheReadInputTokens) ??
          numberOrNull(usage.cache_read_input_tokens) ??
          0,
      ),
    ),
    outputTokens: Math.max(0, Math.floor(numberOrNull(usage.outputTokens) ?? numberOrNull(usage.output_tokens) ?? 0)),
  };
}

function normalizeConfidence(value: unknown): AdapterExecutionResult["usageConfidence"] | null {
  const raw = nonEmptyString(value);
  switch (raw) {
    case "actual":
    case "estimated":
    case "pending":
    case "unavailable":
      return raw;
    default:
      return null;
  }
}

function contextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function buildPaperclipContextEnv(context: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  const taskId = nonEmptyString(context.taskId) ?? nonEmptyString(context.issueId);
  const issueId = nonEmptyString(context.issueId) ?? taskId;
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (issueId) env.PAPERCLIP_ISSUE_ID = issueId;
  const wakeReason = nonEmptyString(context.wakeReason);
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId = nonEmptyString(context.wakeCommentId);
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const approvalId = nonEmptyString(context.approvalId);
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = nonEmptyString(context.approvalStatus);
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  const linkedIssueIds = contextArray(context.linkedIssueIds);
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  return env;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildPaperclipContextEnv(context),
  };
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  const structuredResult = parseStructuredProcessResult(proc.stdout);
  const summary = typeof structuredResult?.summary === "string"
    ? structuredResult.summary
    : null;
  const providerLane = normalizeProviderLane(structuredResult?.providerLane);
  const usage = normalizeUsage(structuredResult?.usage);
  const provider = nonEmptyString(structuredResult?.provider) ?? providerLane?.provider ?? null;
  const biller = nonEmptyString(structuredResult?.biller) ?? providerLane?.biller ?? null;
  const model = nonEmptyString(structuredResult?.model) ?? providerLane?.model ?? null;
  const billingType = normalizeBillingType(structuredResult?.billingType) ?? normalizeBillingType(providerLane?.billingType);
  const usageConfidence = normalizeConfidence(structuredResult?.usageConfidence);
  const costConfidence = normalizeConfidence(structuredResult?.costConfidence);
  const costUsd = numberOrNull(structuredResult?.costUsd);
  const promotedResultFields = {
    ...(provider ? { provider } : {}),
    ...(biller ? { biller } : {}),
    ...(model ? { model } : {}),
    ...(billingType ? { billingType } : {}),
    ...(usage ? { usage } : {}),
    ...(usageConfidence ? { usageConfidence } : {}),
    ...(costConfidence ? { costConfidence } : {}),
    ...(costUsd != null ? { costUsd } : {}),
    ...(providerLane ? { providerLane } : {}),
  };
  const resultJson = structuredResult
    ? {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...structuredResult,
      }
    : {
        stdout: proc.stdout,
        stderr: proc.stderr,
      };

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson,
      summary,
      ...promotedResultFields,
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson,
    summary,
    ...promotedResultFields,
  };
}
