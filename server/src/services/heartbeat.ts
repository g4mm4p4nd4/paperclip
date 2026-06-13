import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  normalizeAgentUrlKey,
  type BillingType,
  type ExecutionWorkspace,
  type ExecutionWorkspaceConfig,
} from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type {
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterSessionCodec,
  AdapterUsageConfidence,
  UsageSummary,
} from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  parseObject,
  asBoolean,
  asNumber,
  appendWithCap,
  MAX_EXCERPT_BYTES,
  ensurePathInEnv,
  ensureCommandResolvable,
} from "../adapters/utils.js";
import { costService } from "./costs.js";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { contextLedgerService } from "./context-ledger.js";
import { secretService } from "./secrets.js";
import {
  resolveDefaultAgentWorkspaceDir,
  resolveHomeAwarePath,
  resolveManagedProjectWorkspaceDir,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";
import {
  buildHeartbeatRunIssueComment,
  inferHeartbeatRunResultFailure,
  mergeHeartbeatRunResultJson,
  summarizeHeartbeatRunResultJson,
} from "./heartbeat-run-summary.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService, mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { isProcessGroupAlive, terminateLocalService } from "./local-service-supervisor.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";
import {
  normalizeCodexModelForRuntime,
  resolveCodexBillingType,
} from "@paperclipai/adapter-codex-local/server";
import {
  classifyProviderReliabilityFailureText,
  filterProviderReliabilityFailureRunsForRouting,
  isProviderReliabilityTextRelevantToTarget,
  resolveProviderReliabilityHealthTarget,
  resolveAgentTieredExecutionRouting,
  resolveProviderReliabilityGateFailureKind,
  selectRecentModelStallForRouting,
  shouldReprobeProviderStallsForRun,
  type ModelRoutingRunHistoryEntry,
  type ProviderReliabilityHealthTarget,
  type TieredExecutionAdapterType,
  type TieredExecutionLane,
} from "./agent-model-routing.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";
const PAPERCLIP_HARNESS_CHECKOUT_KEY = "paperclipHarnessCheckedOut";
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const TIERED_FALLBACK_STALL_LOOKBACK_MS = 45 * 60 * 1000;
const TIMER_MODEL_STALL_BACKOFF_MS = 30 * 60 * 1000;
const CODEX_APP_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const HERMES_DEFAULT_COMMAND = "/Users/mnm/Documents/Github/hermes-agent/venv/bin/hermes";
const PROVIDER_PREFLIGHT_HEALTHY_TTL_MS = 5 * 60 * 1000;
const PROVIDER_PREFLIGHT_DEGRADED_TTL_MS = 30 * 60 * 1000;
const PROVIDER_PREFLIGHT_TIMEOUT_MS = 15 * 1000;
const HEARTBEAT_PRE_SPAWN_WATCHDOG_TIMEOUT_MS = 60 * 1000;
const HEARTBEAT_PRE_SPAWN_WATCHDOG_TIMEOUT_ENV = "PAPERCLIP_HEARTBEAT_PRE_SPAWN_TIMEOUT_MS";
let cachedPaperclipServerGitSha: string | null | undefined;

function normalizeProviderPreflightAdapterConfig(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (adapterType !== "codex_local") return adapterConfig;
  const model = readNonEmptyString(adapterConfig.model);
  if (!model) return adapterConfig;

  const envConfig = parseObject(adapterConfig.env);
  const env = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const normalization = normalizeCodexModelForRuntime(
    model,
    resolveCodexBillingType(effectiveEnv),
  );
  return normalization ? { ...adapterConfig, model: normalization.effectiveModel } : adapterConfig;
}

type ProviderReliabilityPreflightStatus = "healthy" | "degraded" | "unknown";

type ProviderReliabilityPreflightResult = {
  status: ProviderReliabilityPreflightStatus;
  source:
    | "not_provider_backed"
    | "cache"
    | "adapter_environment_test"
    | "adapter_environment_error"
    | "adapter_environment_timeout";
  target: ProviderReliabilityHealthTarget | null;
  testedAt: string;
  expiresAt: string | null;
  reason: string | null;
  failureKind: string | null;
  detail: string | null;
};

type ProviderReliabilityPreflightCacheEntry = {
  status: Exclude<ProviderReliabilityPreflightStatus, "unknown">;
  target: ProviderReliabilityHealthTarget;
  testedAtMs: number;
  expiresAtMs: number;
  reason: string | null;
  failureKind: string | null;
  detail: string | null;
};

const providerReliabilityPreflightCache = new Map<string, ProviderReliabilityPreflightCacheEntry>();

function agentBranchOwnerKey(agent: { id: string; name: string }) {
  return normalizeAgentUrlKey(agent.name) ?? agent.id;
}
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INLINE_WAKE_COMMENTS = 8;
const MAX_INLINE_WAKE_COMMENT_BODY_CHARS = 4_000;
const MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS = 12_000;
const execFile = promisify(execFileCallback);

async function resolvePaperclipServerGitSha(): Promise<string | null> {
  const fromEnv =
    readNonEmptyString(process.env.PAPERCLIP_GIT_SHA) ??
    readNonEmptyString(process.env.GIT_SHA) ??
    readNonEmptyString(process.env.VERCEL_GIT_COMMIT_SHA);
  if (fromEnv) return fromEnv;
  if (cachedPaperclipServerGitSha !== undefined) return cachedPaperclipServerGitSha;
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      timeout: 5_000,
    });
    cachedPaperclipServerGitSha = readNonEmptyString(stdout.trim()) ?? null;
  } catch {
    cachedPaperclipServerGitSha = null;
  }
  return cachedPaperclipServerGitSha;
}

function resolvePaperclipServerVersion(): string | null {
  return readNonEmptyString(process.env.npm_package_version);
}

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

type RuntimeConfigSecretResolver = Pick<
  ReturnType<typeof secretService>,
  "resolveAdapterConfigForRuntime" | "resolveEnvBindings"
>;

export async function resolveExecutionRunAdapterConfig(input: {
  companyId: string;
  executionRunConfig: Record<string, unknown>;
  projectEnv: unknown;
  secretsSvc: RuntimeConfigSecretResolver;
}) {
  const { config: resolvedConfig, secretKeys } = await input.secretsSvc.resolveAdapterConfigForRuntime(
    input.companyId,
    input.executionRunConfig,
  );
  const projectEnvResolution = input.projectEnv
    ? await input.secretsSvc.resolveEnvBindings(input.companyId, input.projectEnv)
    : { env: {}, secretKeys: new Set<string>() };
  if (Object.keys(projectEnvResolution.env).length > 0) {
    resolvedConfig.env = {
      ...parseObject(resolvedConfig.env),
      ...projectEnvResolution.env,
    };
    for (const key of projectEnvResolution.secretKeys) {
      secretKeys.add(key);
    }
  }
  return { resolvedConfig, secretKeys };
}

export function applyPersistedExecutionWorkspaceConfig(input: {
  config: Record<string, unknown>;
  workspaceConfig: ExecutionWorkspaceConfig | null;
  mode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const nextConfig = { ...input.config };

  if (input.mode !== "agent_default") {
    if (input.workspaceConfig?.workspaceRuntime === null) {
      delete nextConfig.workspaceRuntime;
    } else if (input.workspaceConfig?.workspaceRuntime) {
      nextConfig.workspaceRuntime = { ...input.workspaceConfig.workspaceRuntime };
    }
  }

  if (input.workspaceConfig && input.mode === "isolated_workspace") {
    const nextStrategy = parseObject(nextConfig.workspaceStrategy);
    if (input.workspaceConfig.provisionCommand === null) delete nextStrategy.provisionCommand;
    else nextStrategy.provisionCommand = input.workspaceConfig.provisionCommand;
    if (input.workspaceConfig.teardownCommand === null) delete nextStrategy.teardownCommand;
    else nextStrategy.teardownCommand = input.workspaceConfig.teardownCommand;
    nextConfig.workspaceStrategy = nextStrategy;
  }

  return nextConfig;
}

export function stripWorkspaceRuntimeFromExecutionRunConfig(config: Record<string, unknown>) {
  const nextConfig = { ...config };
  delete nextConfig.workspaceRuntime;
  return nextConfig;
}

export function buildRealizedExecutionWorkspaceFromPersisted(input: {
  base: ExecutionWorkspaceInput;
  workspace: ExecutionWorkspace;
}): RealizedExecutionWorkspace | null {
  const cwd = readNonEmptyString(input.workspace.cwd) ?? readNonEmptyString(input.workspace.providerRef);
  if (!cwd) {
    return null;
  }

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  return {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (readNonEmptyString(input.workspace.providerRef) ?? cwd) : null,
    warnings: [],
    created: false,
  };
}

function buildExecutionWorkspaceConfigSnapshot(config: Record<string, unknown>): Partial<ExecutionWorkspaceConfig> | null {
  const strategy = parseObject(config.workspaceStrategy);
  const snapshot: Partial<ExecutionWorkspaceConfig> = {};

  if ("workspaceStrategy" in config) {
    snapshot.provisionCommand = typeof strategy.provisionCommand === "string" ? strategy.provisionCommand : null;
    snapshot.teardownCommand = typeof strategy.teardownCommand === "string" ? strategy.teardownCommand : null;
  }

  if ("workspaceRuntime" in config) {
    const workspaceRuntime = parseObject(config.workspaceRuntime);
    snapshot.workspaceRuntime = Object.keys(workspaceRuntime).length > 0 ? workspaceRuntime : null;
  }

  const hasSnapshot = Object.values(snapshot).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
  return hasSnapshot ? snapshot : null;
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunProcessGroupIdColumn =
  heartbeatRuns.processGroupId ?? sql<number | null>`NULL`.as("processGroupId");

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processGroupId: heartbeatRunProcessGroupIdColumn,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

const heartbeatRunIssueSummaryColumns = {
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  createdAt: heartbeatRuns.createdAt,
  agentId: heartbeatRuns.agentId,
  issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
} as const;

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

function resolvePreSpawnWatchdogTimeoutMs() {
  const raw = process.env[HEARTBEAT_PRE_SPAWN_WATCHDOG_TIMEOUT_ENV];
  if (raw == null || raw.trim() === "") return HEARTBEAT_PRE_SPAWN_WATCHDOG_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return HEARTBEAT_PRE_SPAWN_WATCHDOG_TIMEOUT_MS;
  if (parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS);
}

function isOpenIssueStatus(status: string | null | undefined) {
  return (
    status === "backlog" ||
    status === "todo" ||
    status === "in_progress" ||
    status === "in_review" ||
    status === "blocked"
  );
}

function canExecuteIssue(issue: { status: string | null; hiddenAt: Date | null } | null | undefined) {
  return Boolean(issue && !issue.hiddenAt && isOpenIssueStatus(issue.status));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type UsageAccountingMode = "booked" | "telemetry_only";

type UsageAccountingPolicy = {
  usageConfidence: AdapterUsageConfidence;
  costConfidence: AdapterUsageConfidence;
  usageAccountingMode: UsageAccountingMode;
  costAccountingMode: UsageAccountingMode;
  bookUsage: boolean;
  bookCost: boolean;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function providerReliabilityPreflightCacheKey(
  companyId: string,
  target: ProviderReliabilityHealthTarget,
  cwd: string | null,
) {
  const cwdKey = cwd
    ? createHash("sha256").update(cwd).digest("hex").slice(0, 16)
    : "none";
  return `${companyId}:${target.cacheKey}:cwd:${cwdKey}`;
}

function compactAdapterEnvironmentTestText(
  result: unknown,
  opts: { target?: ProviderReliabilityHealthTarget; relevantOnly?: boolean } = {},
): string {
  const record = parseObject(result);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const checkLines = checks
    .slice(0, 20)
    .flatMap((check) => {
      const item = parseObject(check);
      const code = readNonEmptyString(item.code);
      const level = readNonEmptyString(item.level);
      const message = readNonEmptyString(item.message);
      const detail = readNonEmptyString(item.detail);
      const hint = readNonEmptyString(item.hint);
      const prefix = [code, level].filter((value): value is string => Boolean(value)).join(" | ");
      if (!opts.target || !opts.relevantOnly) {
        return [[code, level, message, detail, hint].filter((value): value is string => Boolean(value)).join(" | ")];
      }

      return [message, detail, hint]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => value.split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => (prefix ? `${prefix} | ${line}` : line));
    })
    .filter((line) => {
      if (!opts.target || !opts.relevantOnly) return true;
      return isProviderReliabilityTextRelevantToTarget(line, opts.target);
    });
  return [
    opts.relevantOnly ? null : readNonEmptyString(record.status) ? `status=${record.status}` : null,
    opts.relevantOnly ? null : readNonEmptyString(record.adapterType) ? `adapterType=${record.adapterType}` : null,
    ...checkLines,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 12_000);
}

function preflightResultFromCache(
  entry: ProviderReliabilityPreflightCacheEntry,
): ProviderReliabilityPreflightResult {
  return {
    status: entry.status,
    source: "cache",
    target: entry.target,
    testedAt: new Date(entry.testedAtMs).toISOString(),
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
    reason: entry.reason,
    failureKind: entry.failureKind,
    detail: entry.detail,
  };
}

class ProviderReliabilityPreflightTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider preflight timed out after ${timeoutMs}ms`);
    this.name = "ProviderReliabilityPreflightTimeoutError";
  }
}

async function withProviderPreflightTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ProviderReliabilityPreflightTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function evaluateProviderReliabilityPreflight(input: {
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  selectedLane?: TieredExecutionLane | null;
  timeoutMs?: number;
}): Promise<ProviderReliabilityPreflightResult> {
  const testedAtMs = Date.now();
  const testedAt = new Date(testedAtMs).toISOString();
  const adapterConfig = normalizeProviderPreflightAdapterConfig(
    input.adapterType,
    input.adapterConfig,
  );
  const target = resolveProviderReliabilityHealthTarget({
    adapterType: input.adapterType,
    adapterConfig,
    selectedLane: input.selectedLane,
  });

  if (!target) {
    return {
      status: "unknown",
      source: "not_provider_backed",
      target: null,
      testedAt,
      expiresAt: null,
      reason: null,
      failureKind: null,
      detail: null,
    };
  }

  const preflightCwd = readNonEmptyString(adapterConfig.cwd);
  const cacheKey = providerReliabilityPreflightCacheKey(input.companyId, target, preflightCwd);
  const cached = providerReliabilityPreflightCache.get(cacheKey);
  if (cached && cached.expiresAtMs > testedAtMs) {
    return preflightResultFromCache(cached);
  }

  try {
    const adapter = getServerAdapter(input.adapterType);
    const result = await withProviderPreflightTimeout(
      adapter.testEnvironment({
        companyId: input.companyId,
        adapterType: input.adapterType,
        config: adapterConfig,
      }),
      input.timeoutMs ?? PROVIDER_PREFLIGHT_TIMEOUT_MS,
    );
    const detail = redactCurrentUserText(compactAdapterEnvironmentTestText(result)).slice(0, 4000);
    const classificationText = redactCurrentUserText(
      compactAdapterEnvironmentTestText(result, { target, relevantOnly: true }),
    );
    const failure = classifyProviderReliabilityFailureText(classificationText);
    if (failure) {
      const expiresAtMs = testedAtMs + PROVIDER_PREFLIGHT_DEGRADED_TTL_MS;
      const entry: ProviderReliabilityPreflightCacheEntry = {
        status: "degraded",
        target,
        testedAtMs,
        expiresAtMs,
        reason: failure.reason,
        failureKind: failure.kind,
        detail,
      };
      providerReliabilityPreflightCache.set(cacheKey, entry);
      return preflightResultFromCache(entry);
    }

    const status = readNonEmptyString(parseObject(result).status);
    if (status === "pass" || status === "warn") {
      const expiresAtMs = testedAtMs + PROVIDER_PREFLIGHT_HEALTHY_TTL_MS;
      const entry: ProviderReliabilityPreflightCacheEntry = {
        status: "healthy",
        target,
        testedAtMs,
        expiresAtMs,
        reason: null,
        failureKind: null,
        detail,
      };
      providerReliabilityPreflightCache.set(cacheKey, entry);
      return preflightResultFromCache(entry);
    }

    if (status === "fail" || status === "error") {
      const expiresAtMs = testedAtMs + PROVIDER_PREFLIGHT_DEGRADED_TTL_MS;
      const entry: ProviderReliabilityPreflightCacheEntry = {
        status: "degraded",
        target,
        testedAtMs,
        expiresAtMs,
        reason: "provider_preflight_failed",
        failureKind: "provider_preflight_failed",
        detail,
      };
      providerReliabilityPreflightCache.set(cacheKey, entry);
      return preflightResultFromCache(entry);
    }

    return {
      status: "unknown",
      source: "adapter_environment_test",
      target,
      testedAt,
      expiresAt: null,
      reason: null,
      failureKind: null,
      detail,
    };
  } catch (error) {
    if (error instanceof ProviderReliabilityPreflightTimeoutError) {
      const expiresAtMs = testedAtMs + PROVIDER_PREFLIGHT_DEGRADED_TTL_MS;
      const entry: ProviderReliabilityPreflightCacheEntry = {
        status: "degraded",
        target,
        testedAtMs,
        expiresAtMs,
        reason: "provider_preflight_timeout",
        failureKind: "provider_preflight_timeout",
        detail: error.message,
      };
      providerReliabilityPreflightCache.set(cacheKey, entry);
      return {
        ...preflightResultFromCache(entry),
        source: "adapter_environment_timeout",
      };
    }
    const detail = redactCurrentUserText(error instanceof Error ? error.message : String(error)).slice(0, 4000);
    const failure = isProviderReliabilityTextRelevantToTarget(detail, target)
      ? classifyProviderReliabilityFailureText(detail)
      : null;
    if (failure) {
      const expiresAtMs = testedAtMs + PROVIDER_PREFLIGHT_DEGRADED_TTL_MS;
      const entry: ProviderReliabilityPreflightCacheEntry = {
        status: "degraded",
        target,
        testedAtMs,
        expiresAtMs,
        reason: failure.reason,
        failureKind: failure.kind,
        detail,
      };
      providerReliabilityPreflightCache.set(cacheKey, entry);
      return preflightResultFromCache(entry);
    }
    return {
      status: "unknown",
      source: "adapter_environment_error",
      target,
      testedAt,
      expiresAt: null,
      reason: null,
      failureKind: null,
      detail,
    };
  }
}

async function pathExistsForHeartbeat(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function parseTieredExecutionPolicy(config: Record<string, unknown>): Record<string, unknown> {
  return parseObject(config.tieredExecution ?? config.executionRouting);
}

function parseTieredAdapterOverride(
  config: Record<string, unknown>,
  adapterType: TieredExecutionAdapterType,
): Record<string, unknown> {
  const policy = parseTieredExecutionPolicy(config);
  const shorthand = adapterType.replace(/_local$/, "");
  return {
    ...parseObject(policy[adapterType]),
    ...parseObject(policy[shorthand]),
  };
}

function commandCandidatesForTieredAdapter(
  adapterType: TieredExecutionAdapterType,
  config: Record<string, unknown>,
): string[] {
  const override = parseTieredAdapterOverride(config, adapterType);
  const command = readNonEmptyString(override.command);
  if (command) return [command];

  switch (adapterType) {
    case "codex_local":
      return [CODEX_APP_COMMAND, "codex"];
    case "claude_local":
      return ["claude"];
    case "gemini_local":
      return ["gemini"];
    case "opencode_local":
      return ["opencode"];
    case "hermes_local":
      return [HERMES_DEFAULT_COMMAND, "hermes"];
  }
}

async function isTieredAdapterAvailable(input: {
  adapterType: TieredExecutionAdapterType;
  config: Record<string, unknown>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  for (const command of commandCandidatesForTieredAdapter(input.adapterType, input.config)) {
    try {
      await ensureCommandResolvable(command, input.cwd, input.env);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function resolveTieredExecutionAdapterAvailability(
  config: Record<string, unknown>,
  cwd: string,
): Promise<Partial<Record<TieredExecutionAdapterType, boolean>>> {
  const envConfig = Object.fromEntries(
    Object.entries(parseObject(config.env)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const env = ensurePathInEnv({ ...process.env, ...envConfig });
  const adapters: TieredExecutionAdapterType[] = [
    "hermes_local",
    "codex_local",
    "claude_local",
    "gemini_local",
    "opencode_local",
  ];
  const entries = await Promise.all(
    adapters.map(async (adapterType) => [
      adapterType,
      await isTieredAdapterAvailable({ adapterType, config, cwd, env }),
    ] as const),
  );
  return Object.fromEntries(entries) as Partial<Record<TieredExecutionAdapterType, boolean>>;
}

function resolveContextPacksDir(): string {
  const configured = process.env.PAPERCLIP_CONTEXT_PACKS_DIR?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "ops", "context-packs");
}

function resolveContextPackRepoKey(
  cwd: string,
  repos: Record<string, unknown>,
): string | null {
  const normalizedCwd = path.resolve(cwd);
  let bestMatch: { key: string; length: number } | null = null;
  for (const [key, value] of Object.entries(repos)) {
    const repoState = parseObject(parseObject(value).repoState);
    const repoCwd = readNonEmptyString(repoState.cwd);
    if (!repoCwd) continue;
    const normalizedRepoCwd = path.resolve(repoCwd);
    const matches =
      normalizedCwd === normalizedRepoCwd ||
      normalizedCwd.startsWith(`${normalizedRepoCwd}${path.sep}`);
    if (!matches) continue;
    if (!bestMatch || normalizedRepoCwd.length > bestMatch.length) {
      bestMatch = { key, length: normalizedRepoCwd.length };
    }
  }
  if (bestMatch) return bestMatch.key;

  const basename = path.basename(normalizedCwd).toLowerCase();
  if (basename in repos) return basename;
  return null;
}

export function resolvePaperclipContextEconomyCwd(input: {
  executionWorkspace: { cwd: string; source?: string | null };
  resolvedConfig: Record<string, unknown>;
}): string {
  const configuredContextCwd = readNonEmptyString(input.resolvedConfig.cwd);
  return input.executionWorkspace.source === "agent_home" && configuredContextCwd
    ? configuredContextCwd
    : input.executionWorkspace.cwd;
}

export async function buildPaperclipContextEconomyHint(cwd: string): Promise<Record<string, unknown> | null> {
  const contextPacksDir = resolveContextPacksDir();
  const manifest = path.join(contextPacksDir, "latest.json");
  if (!(await pathExistsForHeartbeat(manifest))) return null;

  const manifestContents = await fs.readFile(manifest, "utf8").catch(() => null);
  if (!manifestContents) return null;
  const manifestJson = await Promise.resolve()
    .then(() => JSON.parse(manifestContents) as Record<string, unknown>)
    .catch(() => null);
  if (!manifestJson) return null;

  const repos = parseObject(manifestJson.repos);
  const repoKey = resolveContextPackRepoKey(cwd, repos);
  const repoManifest = repoKey ? parseObject(repos[repoKey]) : {};
  const repoState = parseObject(repoManifest.repoState);
  const profiles = parseObject(repoManifest.profiles);
  const profileRecord = (profile: "map" | "delta" | "core") => parseObject(profiles[profile]);
  const profileLatestPath = (profile: "map" | "delta" | "core") => {
    const record = profileRecord(profile);
    return (
      readNonEmptyString(record.latestPath) ??
      readNonEmptyString(record.output) ??
      (repoKey ? path.join(contextPacksDir, "packs", `${repoKey}-${profile}-latest.md`) : null)
    );
  };
  const profileSha = (profile: "map" | "delta" | "core") => readNonEmptyString(profileRecord(profile).sha256);
  const profileTokens = (profile: "map" | "delta" | "core") => asNumber(profileRecord(profile).estimatedTokens, 0);
  const generatedAt = readNonEmptyString(manifestJson.generatedAt) ?? readNonEmptyString(repoManifest.generatedAt);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const ageHours = Number.isFinite(generatedAtMs)
    ? Math.max(0, (Date.now() - generatedAtMs) / (60 * 60 * 1000))
    : null;
  const freshnessStatus = ageHours === null ? "unknown" : ageHours > 24 ? "stale" : "fresh";

  return {
    mode: "map_first",
    repoKey,
    repoSlug: readNonEmptyString(repoManifest.slug) ?? repoKey,
    generatedAt,
    manifestPath: manifest,
    manifestSha: createHash("sha256").update(manifestContents).digest("hex"),
    packHead: readNonEmptyString(repoState.head),
    packBranch: readNonEmptyString(repoState.branch),
    dirtyCount: Array.isArray(repoState.statusShort) ? repoState.statusShort.length : null,
    freshnessStatus,
    contextPacks: {
      dir: contextPacksDir,
      manifest,
      compact: path.join(contextPacksDir, "latest.compact.md"),
      toon: path.join(contextPacksDir, "latest.toon"),
      tsv: path.join(contextPacksDir, "latest.tsv"),
      policy: path.join(contextPacksDir, "CONTEXT_ECONOMY.md"),
    },
    packs: repoKey
      ? {
          map: profileLatestPath("map"),
          delta: profileLatestPath("delta"),
          core: profileLatestPath("core"),
        }
      : {},
    packShas: repoKey
      ? {
          map: profileSha("map"),
          delta: profileSha("delta"),
          core: profileSha("core"),
        }
      : {},
    estimatedTokens: repoKey
      ? {
          map: profileTokens("map"),
          delta: profileTokens("delta"),
          core: profileTokens("core"),
        }
      : {},
  };
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeUsageConfidence(value: unknown): AdapterUsageConfidence | null {
  const raw = readNonEmptyString(value)?.toLowerCase();
  switch (raw) {
    case "actual":
    case "authoritative":
      return "actual";
    case "estimated":
    case "estimate":
      return "estimated";
    case "pending":
      return "pending";
    case "unavailable":
    case "none":
      return "unavailable";
    default:
      return null;
  }
}

function readConfidenceFromAdapterResult(
  result: AdapterExecutionResult,
  key: "usageConfidence" | "costConfidence",
): AdapterUsageConfidence | null {
  const resultRecord = parseObject(result);
  const usage = parseObject(result.usage);
  const resultUsage = parseObject(parseObject(result.resultJson).usage);
  return (
    normalizeUsageConfidence(resultRecord[key]) ??
    normalizeUsageConfidence(usage[key]) ??
    normalizeUsageConfidence(resultUsage[key])
  );
}

function readCostStatusConfidence(result: AdapterExecutionResult): AdapterUsageConfidence | null {
  const resultUsage = parseObject(parseObject(result.resultJson).usage);
  const costStatus = readNonEmptyString(resultUsage.costStatus)?.toLowerCase();
  if (costStatus === "estimated" || costStatus === "estimate") return "estimated";
  if (costStatus === "actual" || costStatus === "final") return "actual";
  return null;
}

function isOpenCodeProvider(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "opencode" || normalized === "opencode-go" || normalized === "opencode-zen";
}

function defaultUsageConfidenceForAdapter(input: {
  adapterType: string | null | undefined;
  result: AdapterExecutionResult;
  hasUsage: boolean;
}): AdapterUsageConfidence {
  if (!input.hasUsage) return "unavailable";

  const adapterType = input.adapterType ?? null;
  const provider = readNonEmptyString(input.result.provider);
  const biller = readNonEmptyString(input.result.biller);
  if (adapterType === "opencode_local" || isOpenCodeProvider(provider) || isOpenCodeProvider(biller)) {
    return "pending";
  }

  if (
    adapterType === "codex_local" ||
    adapterType === "claude_local" ||
    adapterType === "gemini_local"
  ) {
    return "actual";
  }

  if (provider === "openrouter" || biller === "openrouter") {
    return "actual";
  }

  return "actual";
}

function defaultCostConfidenceForUsage(input: {
  usageConfidence: AdapterUsageConfidence;
  hasCost: boolean;
}): AdapterUsageConfidence {
  if (!input.hasCost) return "unavailable";
  return input.usageConfidence;
}

function canBookConfidence(confidence: AdapterUsageConfidence): boolean {
  return confidence === "actual" || confidence === "estimated";
}

function resolveUsageAccountingPolicy(input: {
  adapterType: string | null | undefined;
  result: AdapterExecutionResult;
  rawUsage: UsageTotals | null;
  rawCostUsd: number | null;
}): UsageAccountingPolicy {
  const usageConfidence =
    readConfidenceFromAdapterResult(input.result, "usageConfidence") ??
    defaultUsageConfidenceForAdapter({
      adapterType: input.adapterType,
      result: input.result,
      hasUsage: input.rawUsage !== null,
    });
  const costConfidence =
    readConfidenceFromAdapterResult(input.result, "costConfidence") ??
    readCostStatusConfidence(input.result) ??
    defaultCostConfidenceForUsage({
      usageConfidence,
      hasCost: input.rawCostUsd !== null,
    });
  const bookUsage = input.rawUsage !== null && canBookConfidence(usageConfidence);
  const bookCost = input.rawCostUsd !== null && canBookConfidence(costConfidence);

  return {
    usageConfidence,
    costConfidence,
    usageAccountingMode: bookUsage ? "booked" : "telemetry_only",
    costAccountingMode: bookCost ? "booked" : "telemetry_only",
    bookUsage,
    bookCost,
  };
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function readRawCostUsd(usageJson: unknown): number | null {
  const parsed = parseObject(usageJson);
  const rawCostUsd = asNumber(parsed.rawCostUsd, asNumber(parsed.costUsd, Number.NaN));
  return rawCostUsd != null && Number.isFinite(rawCostUsd) ? Math.max(0, rawCostUsd) : null;
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function deriveNormalizedCostUsdDelta(current: number | null, previous: number | null): number | null {
  if (current == null || !Number.isFinite(current)) return null;
  if (previous == null || !Number.isFinite(previous)) return current;
  return current >= previous ? Math.max(0, current - previous) : current;
}

function adapterReportsCumulativeSessionUsage(result: AdapterExecutionResult): boolean {
  const usage = parseObject(result.usage);
  const resultUsage = parseObject(parseObject(result.resultJson).usage);
  const source =
    readNonEmptyString(usage.source) ??
    readNonEmptyString(usage.usageSource) ??
    readNonEmptyString(resultUsage.source) ??
    readNonEmptyString(resultUsage.usageSource);
  return source === "hermes_state_db" || source === "session_totals";
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

/**
 * Synthetic task key for timer/heartbeat wakes that have no issue context.
 * This allows timer wakes to participate in the `agentTaskSessions` system
 * and benefit from robust session resume, instead of relying solely on the
 * simpler `agentRuntimeState.sessionId` fallback.
 */
const HEARTBEAT_TASK_KEY = "__heartbeat__";

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

/**
 * Extended task key derivation that falls back to a stable synthetic key
 * for timer/heartbeat wakes. This ensures timer wakes can resume their
 * previous session via `agentTaskSessions` instead of starting fresh.
 *
 * The synthetic key is only used when:
 * - No explicit task/issue key exists in the context
 * - The wake source is "timer" (scheduled heartbeat)
 */
export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return HEARTBEAT_TASK_KEY;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  ) {
    return true;
  }
  return false;
}

function shouldRequireIssueCommentForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  return (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  );
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === "execution_review_requested") return "wake reason is execution_review_requested";
  if (wakeReason === "execution_approval_requested") return "wake reason is execution_approval_requested";
  if (wakeReason === "execution_changes_requested") return "wake reason is execution_changes_requested";
  return null;
}

function shouldAutoCheckoutIssueForWake(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  issueStatus: string | null;
  issueAssigneeAgentId: string | null;
  agentId: string;
}) {
  if (input.issueAssigneeAgentId !== input.agentId) return false;

  const issueStatus = readNonEmptyString(input.issueStatus);
  if (
    issueStatus !== "todo" &&
    issueStatus !== "backlog" &&
    issueStatus !== "blocked" &&
    issueStatus !== "in_progress"
  ) {
    return false;
  }

  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason);
  if (!wakeReason) return false;
  if (wakeReason === "issue_comment_mentioned") return false;
  if (wakeReason.startsWith("execution_")) return false;

  return true;
}

function isCheckoutConflictError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.message === "Issue checkout conflict";
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function mergeWakeCommentIds(...values: Array<unknown>): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) append(entry);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const candidate = value as Record<string, unknown>;
      const batched = extractWakeCommentIds(candidate);
      if (batched.length > 0) {
        for (const entry of batched) append(entry);
        continue;
      }
      append(candidate.wakeCommentId);
      append(candidate.commentId);
      continue;
    }
    append(value);
  }

  return merged;
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);
  const wakeCommentIds = mergeWakeCommentIds(contextSnapshot, commentIdFromPayload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (wakeCommentIds.length > 0) {
    const latestCommentId = wakeCommentIds[wakeCommentIds.length - 1];
    contextSnapshot[WAKE_COMMENT_IDS_KEY] = wakeCommentIds;
    contextSnapshot.commentId = latestCommentId;
    contextSnapshot.wakeCommentId = latestCommentId;
    // Once comment ids are normalized into the snapshot, rebuild the structured
    // wake payload from those ids later instead of carrying forward stale data.
    delete contextSnapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  } else if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const mergedCommentIds = mergeWakeCommentIds(existing, incoming);
  if (mergedCommentIds.length > 0) {
    const latestCommentId = mergedCommentIds[mergedCommentIds.length - 1];
    merged[WAKE_COMMENT_IDS_KEY] = mergedCommentIds;
    merged.commentId = latestCommentId;
    merged.wakeCommentId = latestCommentId;
    // The merged context should carry canonical comment ids; the next wake will
    // regenerate any structured payload from those ids.
    delete merged[PAPERCLIP_WAKE_PAYLOAD_KEY];
  }
  return merged;
}

async function buildPaperclipWakePayload(input: {
  db: Db;
  companyId: string;
  contextSnapshot: Record<string, unknown>;
  issueSummary?:
    | {
        id: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
      }
    | null;
}) {
  const executionStage = parseObject(input.contextSnapshot.executionStage);
  const commentIds = extractWakeCommentIds(input.contextSnapshot);
  const issueId = readNonEmptyString(input.contextSnapshot.issueId);
  const issueSummary =
    input.issueSummary ??
    (issueId
      ? await input.db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null);
  if (commentIds.length === 0 && Object.keys(executionStage).length === 0 && !issueSummary) return null;

  const commentRows =
    commentIds.length === 0
      ? []
      : await input.db
          .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            authorAgentId: issueComments.authorAgentId,
            authorUserId: issueComments.authorUserId,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, input.companyId),
              inArray(issueComments.id, commentIds),
            ),
          );

  const commentsById = new Map(commentRows.map((comment) => [comment.id, comment]));
  const comments: Array<Record<string, unknown>> = [];
  let remainingBodyChars = MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS;
  let truncated = false;
  let missingCommentCount = 0;

  for (const commentId of commentIds) {
    const row = commentsById.get(commentId);
    if (!row) {
      truncated = true;
      missingCommentCount += 1;
      continue;
    }
    if (comments.length >= MAX_INLINE_WAKE_COMMENTS) {
      truncated = true;
      break;
    }

    const fullBody = row.body;
    const allowedBodyChars = Math.min(MAX_INLINE_WAKE_COMMENT_BODY_CHARS, remainingBodyChars);
    if (allowedBodyChars <= 0) {
      truncated = true;
      break;
    }

    const body = fullBody.length > allowedBodyChars ? fullBody.slice(0, allowedBodyChars) : fullBody;
    const bodyTruncated = body.length < fullBody.length;
    if (bodyTruncated) truncated = true;
    remainingBodyChars -= body.length;

    comments.push({
      id: row.id,
      issueId: row.issueId,
      body,
      bodyTruncated,
      createdAt: row.createdAt.toISOString(),
      author: row.authorAgentId
        ? { type: "agent", id: row.authorAgentId }
        : row.authorUserId
          ? { type: "user", id: row.authorUserId }
          : { type: "system", id: null },
    });
  }

  return {
    reason: readNonEmptyString(input.contextSnapshot.wakeReason),
    issue: issueSummary
      ? {
          id: issueSummary.id,
          identifier: issueSummary.identifier,
          title: issueSummary.title,
          status: issueSummary.status,
          priority: issueSummary.priority,
        }
      : null,
    checkedOutByHarness: input.contextSnapshot[PAPERCLIP_HARNESS_CHECKOUT_KEY] === true,
    executionStage: Object.keys(executionStage).length > 0 ? executionStage : null,
    commentIds,
    latestCommentId: commentIds[commentIds.length - 1] ?? null,
    comments,
    commentWindow: {
      requestedCount: commentIds.length,
      includedCount: comments.length,
      missingCount: missingCommentCount,
    },
    truncated,
    fallbackFetchNeeded: truncated || missingCommentCount > 0,
  };
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

async function terminateHeartbeatRunProcess(input: {
  pid: number | null | undefined;
  processGroupId: number | null | undefined;
  graceMs?: number;
}) {
  const pid = input.pid ?? null;
  const processGroupId = input.processGroupId ?? null;
  if (typeof pid !== "number" && typeof processGroupId !== "number") return;

  await terminateLocalService(
    {
      pid:
        typeof pid === "number" && Number.isInteger(pid) && pid > 0
          ? pid
          : (processGroupId ?? 0),
      processGroupId:
        typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
          ? processGroupId
          : null,
    },
    input.graceMs ? { forceAfterMs: input.graceMs } : undefined,
  );
}

function buildProcessLossMessage(run: {
  processPid: number | null;
  processGroupId: number | null;
}, options?: { descendantOnly?: boolean }) {
  if (options?.descendantOnly && run.processGroupId) {
    return `Process lost -- parent pid ${run.processPid ?? "unknown"} exited, but descendant process group ${run.processGroupId} was still alive and was terminated`;
  }
  if (run.processPid) {
    return `Process lost -- child pid ${run.processPid} is no longer running`;
  }
  if (run.processGroupId) {
    return `Process lost -- process group ${run.processGroupId} is no longer running`;
  }
  return "Process lost -- server may have restarted";
}

function getProcessLossRetrySkipDetails(contextSnapshot: Record<string, unknown>) {
  const workspace = parseObject(contextSnapshot.paperclipWorkspace);
  const workspaceMode = readNonEmptyString(workspace.mode);
  const workspaceSource = readNonEmptyString(workspace.source);

  if (workspaceMode === "shared_workspace" && workspaceSource === "project_primary") {
    return {
      code: "shared_project_primary_workspace",
      message:
        "automatic retry skipped because run used shared project-primary workspace and may have left partial mutations",
    };
  }

  return null;
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);
  const contextLedger = contextLedgerService(db);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getIssueExecutionContext(companyId: string, issueId: string) {
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
    rawCostUsd: number | null;
    deriveCostFromSessionTotals: boolean;
  }) {
    const { agentId, runId, sessionId, rawUsage, rawCostUsd, deriveCostFromSessionTotals } = input;
    if (!sessionId || (!rawUsage && rawCostUsd == null)) {
      return {
        normalizedUsage: rawUsage,
        normalizedCostUsd: rawCostUsd,
        previousRawUsage: null as UsageTotals | null,
        previousRawCostUsd: null as number | null,
        derivedFromSessionTotals: false,
        derivedCostFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    const previousRawCostUsd = deriveCostFromSessionTotals ? readRawCostUsd(previousRun?.usageJson) : null;
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      normalizedCostUsd: deriveCostFromSessionTotals
        ? deriveNormalizedCostUsdDelta(rawCostUsd, previousRawCostUsd)
        : rawCostUsd,
      previousRawUsage,
      previousRawCostUsd,
      derivedFromSessionTotals: previousRawUsage !== null,
      derivedCostFromSessionTotals: deriveCostFromSessionTotals && previousRawCostUsd !== null,
    };
  }

  type RecentProviderStallForRouting = {
    runId: string;
    reason: string;
    failureKind: string;
    stalledLanes: TieredExecutionLane[];
    stalledLaneModels?: Partial<Record<TieredExecutionLane, string | null>>;
    scope: "agent" | "company";
  };

  type RecentProviderStallRow = {
    id: string;
    status: string;
    createdAt: Date | null;
    error: string | null;
    errorCode: string | null;
    stdoutExcerpt: string | null;
    stderrExcerpt: string | null;
    resultJson: unknown;
    contextSnapshot: unknown;
  };

  function mergeProviderStalledLanes(
    ...laneGroups: Array<readonly TieredExecutionLane[] | null | undefined>
  ): TieredExecutionLane[] {
    const lanes: TieredExecutionLane[] = [];
    const seen = new Set<string>();
    for (const group of laneGroups) {
      for (const lane of group ?? []) {
        if (seen.has(lane)) continue;
        seen.add(lane);
        lanes.push(lane);
      }
    }
    return lanes;
  }

  function mergeProviderStalledLaneModels(
    ...modelGroups: Array<Partial<Record<TieredExecutionLane, string | null>> | null | undefined>
  ): Partial<Record<TieredExecutionLane, string | null>> | undefined {
    const merged: Partial<Record<TieredExecutionLane, string | null>> = {};
    for (const group of modelGroups) {
      for (const [lane, model] of Object.entries(group ?? {}) as Array<[TieredExecutionLane, string | null]>) {
        if (lane in merged) continue;
        merged[lane] = model ?? null;
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  function mapRecentProviderStallRun(recentRun: RecentProviderStallRow): ModelRoutingRunHistoryEntry {
    const resultSummary = summarizeHeartbeatRunResultJson(parseObject(recentRun.resultJson));
    return {
      id: recentRun.id,
      status: recentRun.status,
      createdAt: recentRun.createdAt,
      error: recentRun.error,
      errorCode: recentRun.errorCode,
      stdoutExcerpt: recentRun.stdoutExcerpt,
      stderrExcerpt: recentRun.stderrExcerpt,
      resultText: [
        resultSummary?.summary,
        resultSummary?.result,
        resultSummary?.message,
        resultSummary?.error,
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n"),
      contextSnapshot: parseObject(recentRun.contextSnapshot),
    };
  }

  async function findRecentModelStallForRouting(
    agentId: string,
    opts: { lookbackMs?: number } = {},
  ): Promise<Omit<RecentProviderStallForRouting, "scope"> | null> {
    const lookbackMs = opts.lookbackMs ?? TIERED_FALLBACK_STALL_LOOKBACK_MS;
    const cutoff = new Date(Date.now() - lookbackMs);
    const recentRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          gt(heartbeatRuns.createdAt, cutoff),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(12);

    return selectRecentModelStallForRouting(
      recentRuns.map(mapRecentProviderStallRun),
    );
  }

  async function findRecentCompanyProviderStallForRouting(
    companyId: string,
    opts: { lookbackMs?: number } = {},
  ): Promise<Omit<RecentProviderStallForRouting, "scope"> | null> {
    const lookbackMs = opts.lookbackMs ?? TIERED_FALLBACK_STALL_LOOKBACK_MS;
    const cutoff = new Date(Date.now() - lookbackMs);
    const recentRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gt(heartbeatRuns.createdAt, cutoff),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(50);

    const failureRuns = filterProviderReliabilityFailureRunsForRouting(recentRuns.map(mapRecentProviderStallRun));
    const stall = selectRecentModelStallForRouting(failureRuns);
    if (failureRuns.length > 0 && !stall) {
      logger.warn(
        {
          companyId,
          scannedRuns: recentRuns.length,
          providerFailureRunIds: failureRuns.map((run) => run.id).slice(0, 12),
          stall,
        },
        "company provider reliability scan",
      );
    }
    return stall;
  }

  async function findRecentProviderStallForRouting(
    agent: Pick<typeof agents.$inferSelect, "id" | "companyId">,
    opts: { lookbackMs?: number } = {},
  ): Promise<RecentProviderStallForRouting | null> {
    const agentStall = await findRecentModelStallForRouting(agent.id, opts);
    const companyStall = await findRecentCompanyProviderStallForRouting(agent.companyId, opts);
    if (agentStall) {
      return {
        ...agentStall,
        stalledLanes: mergeProviderStalledLanes(agentStall.stalledLanes, companyStall?.stalledLanes),
        stalledLaneModels: mergeProviderStalledLaneModels(
          agentStall.stalledLaneModels,
          companyStall?.stalledLaneModels,
        ),
        scope: "agent",
      };
    }
    return companyStall ? { ...companyStall, scope: "company" } : null;
  }

  async function resolveProviderDegradedWakeBackoff(input: {
    agent: typeof agents.$inferSelect;
    source: string;
    triggerDetail: string | null;
    contextSnapshot: Record<string, unknown>;
  }) {
    if (
      shouldReprobeProviderStallsForRun({
        invocationSource: input.source,
        triggerDetail: input.triggerDetail,
        contextSnapshot: input.contextSnapshot,
      })
    ) {
      return null;
    }

    const recentModelStall = await findRecentProviderStallForRouting(input.agent, {
      lookbackMs: TIMER_MODEL_STALL_BACKOFF_MS,
    });
    if (!recentModelStall) return null;

    const adapterConfig = parseObject(input.agent.adapterConfig);
    const currentTarget = resolveProviderReliabilityHealthTarget({
      adapterType: input.agent.adapterType,
      adapterConfig,
    });
    if (
      recentModelStall.scope === "company" &&
      currentTarget &&
      recentModelStall.stalledLanes.length > 0 &&
      !recentModelStall.stalledLanes.includes(currentTarget.lane)
    ) {
      return null;
    }

    const availability = await resolveTieredExecutionAdapterAvailability(
      adapterConfig,
      readNonEmptyString(adapterConfig.cwd) ?? process.cwd(),
    );
    const recoveryRoute = resolveAgentTieredExecutionRouting({
      role: input.agent.role,
      adapterType: input.agent.adapterType,
      adapterConfig,
      availableAdapters: availability,
      recentStall: true,
      stallReason: recentModelStall.reason,
      stallFailureKind: recentModelStall.failureKind,
      stalledLanes: recentModelStall.stalledLanes,
      stalledLaneModels: recentModelStall.stalledLaneModels,
      contextSnapshot: input.contextSnapshot,
    });
    if (recoveryRoute.route) return null;

    return {
      reason: "provider_degraded_backoff",
      cooldownMs: TIMER_MODEL_STALL_BACKOFF_MS,
      recentModelStall,
      availability,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, resumeTaskKey)
      : null;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId: readNonEmptyString(resumeContext.taskId) ?? readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        projectId: workspaceProjectId,
        repoUrl: null,
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function recordRuntimeFailureState(input: {
    agentId: string;
    companyId: string;
    adapterType: string;
    runId: string;
    errorMessage: string;
  }) {
    const updatedAt = new Date();
    await db
      .insert(agentRuntimeState)
      .values({
        agentId: input.agentId,
        companyId: input.companyId,
        adapterType: input.adapterType,
        stateJson: {},
        lastRunId: input.runId,
        lastRunStatus: "failed",
        lastError: input.errorMessage,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          adapterType: input.adapterType,
          lastRunId: input.runId,
          lastRunStatus: "failed",
          lastError: input.errorMessage,
          updatedAt,
        },
      });
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; processGroupId: number | null; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processGroupId: meta.processGroupId,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function patchRunIssueCommentStatus(
    runId: string,
    patch: Partial<Pick<typeof heartbeatRuns.$inferInsert, "issueCommentStatus" | "issueCommentSatisfiedByCommentId" | "issueCommentRetryQueuedAt">>,
  ) {
    return db
      .update(heartbeatRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function findRunIssueComment(runId: string, companyId: string, issueId: string) {
    return db
      .select({
        id: issueComments.id,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, runId),
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function enqueueMissingIssueCommentRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    issueId: string,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "missing_issue_comment",
      retryReason: "missing_issue_comment",
      missingIssueCommentForRunId: run.id,
    };
    const now = new Date();

    const retryRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);
      if (!issue) return null;

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "missing_issue_comment",
          payload: {
            issueId,
            retryOfRunId: run.id,
            retryReason: "missing_issue_comment",
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const queuedRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          issueCommentStatus: "not_applicable",
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: queuedRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      await tx
        .update(issues)
        .set({
          executionRunId: queuedRun.id,
          executionAgentNameKey: normalizeAgentNameKey(agent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(eq(issues.id, issue.id));

      await tx
        .update(heartbeatRuns)
        .set({
          issueCommentStatus: "retry_queued",
          issueCommentRetryQueuedAt: now,
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, run.id));

      return queuedRun;
    });

    if (!retryRun) return null;

    publishLiveEvent({
      companyId: retryRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: retryRun.id,
        agentId: retryRun.agentId,
        invocationSource: retryRun.invocationSource,
        triggerDetail: retryRun.triggerDetail,
        wakeupRequestId: retryRun.wakeupRequestId,
      },
    });

    return retryRun;
  }

  async function finalizeIssueCommentPolicy(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    const postedComment = await findRunIssueComment(run.id, run.companyId, issueId);
    if (postedComment) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "satisfied",
        issueCommentSatisfiedByCommentId: postedComment.id,
        issueCommentRetryQueuedAt: null,
      });
      return { outcome: "satisfied" as const, queuedRun: null };
    }

    if (readNonEmptyString(contextSnapshot.retryReason) === "missing_issue_comment") {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "retry_exhausted",
        issueCommentSatisfiedByCommentId: null,
      });
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run ended without an issue comment after one retry; no further comment wake will be queued",
      });
      return { outcome: "retry_exhausted" as const, queuedRun: null };
    }

    if (!shouldRequireIssueCommentForWake(contextSnapshot)) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    const queuedRun = await enqueueMissingIssueCommentRetry(run, agent, issueId);
    if (queuedRun) {
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run ended without an issue comment; queued one follow-up wake to require a comment",
      });
      return { outcome: "retry_queued" as const, queuedRun };
    }

    await patchRunIssueCommentStatus(run.id, {
      issueCommentStatus: "retry_exhausted",
      issueCommentSatisfiedByCommentId: null,
    });
    return { outcome: "retry_exhausted" as const, queuedRun: null };
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    };

    const outcome = await db.transaction(async (tx) => {
      const existingRetry = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.agentId, run.agentId),
            eq(heartbeatRuns.retryOfRunId, run.id),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          ),
        )
        .orderBy(
          sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
          asc(heartbeatRuns.createdAt),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      let issue: {
        id: string;
        status: string;
        hiddenAt: Date | null;
        executionRunId: string | null;
      } | null = null;
      if (issueId) {
        issue = await tx
          .select({
            id: issues.id,
            status: issues.status,
            hiddenAt: issues.hiddenAt,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
          .then((rows) => rows[0] ?? null);
      }

      if (issueId && !canExecuteIssue(issue)) {
        if (issue?.executionRunId === run.id) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: now,
            })
            .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
        }
        return { kind: "skipped" as const, run: existingRetry };
      }

      if (existingRetry) {
        if (issueId && issue?.executionRunId === run.id) {
          await tx
            .update(issues)
            .set({
              executionRunId: existingRetry.id,
              executionAgentNameKey: normalizeAgentNameKey(agent.name),
              executionLockedAt: now,
              updatedAt: now,
            })
            .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
        }
        return { kind: "existing" as const, run: existingRetry };
      }

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "process_lost_retry",
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return { kind: "queued" as const, run: retryRun };
    });

    if (outcome.kind === "skipped") return null;

    const queued = outcome.run;
    if (outcome.kind === "existing") return queued;

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued automatic retry after orphaned child process was confirmed dead",
      payload: {
        retryOfRunId: run.id,
      },
    });

    return queued;
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, false),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  function isOpenRoutineExecutionConstraintError(error: unknown) {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown; message?: unknown };
      if (
        candidate.code === "23505" &&
        (candidate.constraint === "issues_open_routine_execution_uq" ||
          (typeof candidate.message === "string" &&
            candidate.message.includes("issues_open_routine_execution_uq")))
      ) {
        return true;
      }
      if (
        candidate.constraint === "issues_open_routine_execution_uq" ||
        (typeof candidate.message === "string" && candidate.message.includes("issues_open_routine_execution_uq"))
      ) {
        return true;
      }
      current = candidate.cause;
    }
    return false;
  }

  function stringifyClaimError(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string") return error;
    return "Unknown issue execution lock error";
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const cancelQueuedRunDuringClaim = async (reason: string) => {
      const finishedAt = new Date();
      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt,
        error: reason,
        errorCode: "cancelled",
      });
      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt,
        error: reason,
      });
      if (cancelled) {
        await appendRunEvent(cancelled, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: "run cancelled",
        });
        await releaseIssueExecutionAndPromote(cancelled);
      }
      await finalizeAgentStatus(run.agentId, "cancelled");
      return null;
    };

    const agent = await getAgent(run.agentId);
    if (!agent) {
      return cancelQueuedRunDuringClaim("Cancelled because the agent no longer exists");
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      return cancelQueuedRunDuringClaim("Cancelled because the agent is not invokable");
    }

    const context = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          hiddenAt: issues.hiddenAt,
          originKind: issues.originKind,
          originId: issues.originId,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!canExecuteIssue(issue)) {
        return cancelQueuedRunDuringClaim("Cancelled because the referenced issue is closed or hidden");
      }
      if (issue?.originKind === "routine_execution" && issue.originId) {
        const activeRoutineExecution = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .innerJoin(
            heartbeatRuns,
            and(
              eq(heartbeatRuns.id, issues.executionRunId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .where(
            and(
              eq(issues.companyId, run.companyId),
              eq(issues.originKind, "routine_execution"),
              eq(issues.originId, issue.originId),
              isNull(issues.hiddenAt),
              inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
              sql`${issues.id} <> ${issue.id}`,
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (activeRoutineExecution) {
          return cancelQueuedRunDuringClaim(
            `Cancelled because another routine execution is already active for this routine (${activeRoutineExecution.identifier ?? activeRoutineExecution.id})`,
          );
        }
      }
    }

    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId,
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      return cancelQueuedRunDuringClaim(budgetBlock.reason);
    }

    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });

    // Fix A (lazy locking): stamp executionRunId now that the run is actually running,
    // not at queue time. Guard is idempotent — safe if called more than once.
    const claimedIssueId = readNonEmptyString(parseObject(claimed.contextSnapshot).issueId);
    if (claimedIssueId) {
      try {
        const claimedAgent = await getAgent(claimed.agentId);
        await db
          .update(issues)
          .set({
            executionRunId: claimed.id,
            executionAgentNameKey: normalizeAgentNameKey(claimedAgent?.name),
            executionLockedAt: claimedAt,
            updatedAt: claimedAt,
          })
          .where(
            and(
              eq(issues.id, claimedIssueId),
              eq(issues.companyId, claimed.companyId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, claimed.id)),
            ),
          );
      } catch (error) {
        const finishedAt = new Date();
        const isRoutineConflict = isOpenRoutineExecutionConstraintError(error);
        const status = isRoutineConflict ? "cancelled" : "failed";
        const errorCode = isRoutineConflict ? "routine_execution_conflict" : "issue_execution_lock_failed";
        const message = isRoutineConflict
          ? "Cancelled because another routine execution is already active for this routine"
          : `Failed to claim issue execution lock: ${stringifyClaimError(error)}`;

        logger.warn(
          { err: error, runId: claimed.id, issueId: claimedIssueId, errorCode },
          "heartbeat run finalized after issue execution lock claim failed",
        );

        const finalized = await setRunStatus(claimed.id, status, {
          finishedAt,
          error: message,
          errorCode,
        });
        await setWakeupStatus(claimed.wakeupRequestId, status, {
          finishedAt,
          error: message,
        });
        if (finalized) {
          await appendRunEvent(finalized, await nextRunEventSeq(finalized.id), {
            eventType: "lifecycle",
            stream: "system",
            level: isRoutineConflict ? "warn" : "error",
            message: status === "cancelled" ? "run cancelled" : "run failed",
            payload: {
              errorCode,
              issueId: claimedIssueId,
            },
          });
          await releaseIssueExecutionAndPromote(finalized);
        }
        await finalizeAgentStatus(claimed.agentId, status);
        return null;
      }
    }

    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const isFirstHeartbeat = !existing.lastHeartbeatAt;

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (isFirstHeartbeat && updated) {
      const tc = getTelemetryClient();
      if (tc) trackAgentFirstHeartbeat(tc, { agentRole: updated.role });
    }

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  function isPreSpawnRunWithoutAdapterEvidence(
    run: typeof heartbeatRuns.$inferSelect,
    hasRecordedProcess: boolean,
  ) {
    return !hasRecordedProcess && !run.processStartedAt;
  }

  async function recordPreSpawnFailureLedger(input: {
    run: typeof heartbeatRuns.$inferSelect;
    adapterType: string;
    failureMessage: string;
    errorCode: string;
    staleThresholdMs: number;
    inMemoryActive: boolean;
  }) {
    const context = parseObject(input.run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const agent = await getAgent(input.run.agentId).catch(() => null);
    const adapterConfig = parseObject(agent?.adapterConfig);
    const workspace = parseObject(context.paperclipWorkspace);
    const cwd =
      readNonEmptyString(workspace.cwd) ??
      readNonEmptyString(adapterConfig.cwd) ??
      process.cwd();
    const evidencePayload = {
      runId: input.run.id,
      agentId: input.run.agentId,
      issueId,
      taskKey,
      adapterType: input.adapterType,
      errorCode: input.errorCode,
      finalBlocker: input.failureMessage,
      staleThresholdMs: input.staleThresholdMs,
      inMemoryActive: input.inMemoryActive,
      processPid: input.run.processPid,
      processGroupId: input.run.processGroupId,
      processStartedAt: input.run.processStartedAt,
      sessionIdBefore: input.run.sessionIdBefore,
      logRef: input.run.logRef,
      startedAt: input.run.startedAt,
      updatedAt: input.run.updatedAt,
    };
    const evidence = redactCurrentUserText(JSON.stringify(evidencePayload, null, 2)).slice(0, 12_000);
    const evidenceTokens = Math.ceil(evidence.length / 4);
    const evidenceSha = createHash("sha256").update(evidence).digest("hex");

    try {
      const entry = await contextLedger.recordPreSpawn({
        companyId: input.run.companyId,
        runId: input.run.id,
        agentId: input.run.agentId,
        issueId,
        taskKey,
        adapterType: input.adapterType,
        adapterVersion: null,
        branch: readNonEmptyString(workspace.branchName),
        sessionIdBefore: input.run.sessionIdBefore ?? null,
        meta: {
          adapterType: input.adapterType,
          command: "paperclip_pre_spawn_watchdog",
          cwd,
          commandArgs: [input.run.id],
          commandNotes: [
            "claimed heartbeat run failed before adapter spawn evidence was recorded",
            input.failureMessage,
          ],
          promptClass: "failure_recovery",
          promptBudgetVersion: "context-economy.v1",
          promptMetrics: {
            promptClass: "failure_recovery",
            promptBudgetVersion: "context-economy.v1",
            totalChars: evidence.length,
            estimatedPromptTokens: evidenceTokens,
            evidenceSliceCount: 1,
            components: [
              {
                name: "pre_spawn_watchdog",
                type: "evidence_slice",
                sha256: evidenceSha,
                chars: evidence.length,
                estimatedTokens: evidenceTokens,
                evidenceSliceCount: 1,
                truncated: evidence.length >= 12_000,
                errorCode: input.errorCode,
                staleThresholdMs: input.staleThresholdMs,
                inMemoryActive: input.inMemoryActive,
              },
            ],
          },
          evidenceSliceCount: 1,
          runtimeProvenance: {
            paperclipServerVersion: resolvePaperclipServerVersion(),
            paperclipServerGitSha: await resolvePaperclipServerGitSha(),
            promptBudgetVersion: "context-economy.v1",
          },
          context,
        } as AdapterInvocationMeta,
        context,
      });
      await contextLedger.finalizeRun({
        runId: input.run.id,
        outcome: "failed",
        blocker: input.failureMessage,
        sessionIdAfter: null,
        usage: null,
        resultJson: {
          errorCode: input.errorCode,
          finalBlocker: input.failureMessage,
          contextLedgerEntryId: entry.id,
          preSpawnWatchdog: evidencePayload,
        },
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          runId: input.run.id,
          errorCode: input.errorCode,
        },
        "failed to record pre-spawn watchdog context ledger evidence",
      );
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    for (const { run, adapterType } of activeRuns) {
      if (runningProcesses.has(run.id)) continue;

      // Apply staleness threshold to avoid false positives
      let stale = true;
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        stale = now.getTime() - refTime >= staleThresholdMs;
        if (!stale) continue;
      }

      const inMemoryActive = activeRunExecutions.has(run.id);
      const hasRecordedProcess = Boolean(run.processPid || run.processGroupId);
      const isPreSpawnStaleRun = isPreSpawnRunWithoutAdapterEvidence(run, hasRecordedProcess);
      if (inMemoryActive && hasRecordedProcess) continue;
      if (inMemoryActive && !hasRecordedProcess && !stale) continue;
      if (inMemoryActive && !hasRecordedProcess) {
        activeRunExecutions.delete(run.id);
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      const processPidAlive = tracksLocalChild && run.processPid && isProcessAlive(run.processPid);
      const processGroupAlive = tracksLocalChild && run.processGroupId && isProcessGroupAlive(run.processGroupId);
      if (processPidAlive) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        continue;
      }

      let descendantOnlyCleanup = false;
      if (processGroupAlive) {
        descendantOnlyCleanup = true;
        await terminateHeartbeatRunProcess({
          pid: run.processPid,
          processGroupId: run.processGroupId,
        });
      }

      const contextSnapshot = parseObject(run.contextSnapshot);
      const retrySkipDetails = getProcessLossRetrySkipDetails(contextSnapshot);
      const shouldRetry =
        tracksLocalChild &&
        (!!run.processPid || !!run.processGroupId) &&
        (run.processLossRetryCount ?? 0) < 1 &&
        !retrySkipDetails;
      const baseMessage =
        isPreSpawnStaleRun
          ? "Process lost -- run exceeded the pre-spawn watchdog before an adapter child process was recorded"
          : buildProcessLossMessage(run, descendantOnlyCleanup ? { descendantOnly: true } : undefined);
      const failureMessage = shouldRetry
        ? `${baseMessage}; retrying once`
        : retrySkipDetails
          ? `${baseMessage}; ${retrySkipDetails.message}`
          : baseMessage;

      if (isPreSpawnStaleRun) {
        await recordPreSpawnFailureLedger({
          run,
          adapterType,
          failureMessage,
          errorCode: "process_lost",
          staleThresholdMs,
          inMemoryActive,
        });
        await appendRunEvent(run, await nextRunEventSeq(run.id), {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: failureMessage,
          payload: {
            stalePreSpawnActiveRun: inMemoryActive,
            preSpawnWatchdogTimeoutMs: staleThresholdMs,
          },
        });
      }

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: failureMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      await contextLedger.finalizeRun({
        runId: run.id,
        outcome: "failed",
        blocker: failureMessage,
        sessionIdAfter: run.sessionIdAfter ?? run.sessionIdBefore ?? null,
        usage: null,
        resultJson: {
          errorCode: "process_lost",
          finalBlocker: failureMessage,
          processPid: run.processPid,
          processGroupId: run.processGroupId,
          preSpawnWatchdog: isPreSpawnStaleRun
            ? {
                staleThresholdMs,
                inMemoryActive,
                processStartedAt: run.processStartedAt,
                sessionIdBefore: run.sessionIdBefore,
                logRef: run.logRef,
              }
            : null,
        },
      });
      await recordRuntimeFailureState({
        agentId: run.agentId,
        companyId: run.companyId,
        adapterType,
        runId: run.id,
        errorMessage: failureMessage,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: failureMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: retriedRun ? `${baseMessage}; queued retry ${retriedRun.id}` : failureMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(run.processGroupId ? { processGroupId: run.processGroupId } : {}),
          ...(isPreSpawnStaleRun
            ? {
                stalePreSpawnActiveRun: inMemoryActive,
                preSpawnWatchdogTimeoutMs: staleThresholdMs,
              }
            : {}),
          ...(descendantOnlyCleanup ? { descendantOnlyCleanup: true } : {}),
          ...(retrySkipDetails ? { retrySkipReason: retrySkipDetails.code } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  function schedulePreSpawnWatchdog(runId: string) {
    const timeoutMs = resolvePreSpawnWatchdogTimeoutMs();
    if (timeoutMs <= 0) return;

    const scheduleCheck = (delayMs: number) => {
      const timer = setTimeout(() => {
        void (async () => {
          const current = await getRun(runId);
          if (!current || current.status !== "running") return;
          const hasSpawnEvidence = Boolean(
            current.processPid ||
              current.processGroupId ||
              current.processStartedAt,
          );
          if (hasSpawnEvidence) return;

          const refTime =
            current.updatedAt?.getTime?.() ??
            current.startedAt?.getTime?.() ??
            current.createdAt?.getTime?.() ??
            0;
          const ageMs = Date.now() - refTime;
          if (ageMs >= timeoutMs) {
            await reapOrphanedRuns({ staleThresholdMs: timeoutMs });
            return;
          }
          scheduleCheck(Math.max(10, timeoutMs - ageMs + 25));
        })().catch((err) => {
          logger.error(
            { err, runId, timeoutMs },
            "pre-spawn watchdog failed while checking heartbeat run",
          );
        });
      }, Math.max(10, delayMs));
      timer.unref?.();
    };

    scheduleCheck(timeoutMs + 25);
  }

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = arguments.length >= 5
      ? normalizedUsage ?? null
      : normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function resolveProviderPreflightCwdForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    adapterConfig: Record<string, unknown>,
  ) {
    const contextWorkspace = parseObject(context.paperclipWorkspace);
    const contextWorkspaceCwd = readNonEmptyString(contextWorkspace.cwd);
    if (contextWorkspaceCwd) return contextWorkspaceCwd;

    const issueId = readNonEmptyString(context.issueId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueWorkspaceCwd = issueId
      ? await db
          .select({ cwd: projectWorkspaces.cwd })
          .from(issues)
          .leftJoin(projectWorkspaces, eq(projectWorkspaces.id, issues.projectWorkspaceId))
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => readNonEmptyString(rows[0]?.cwd))
      : null;
    if (issueWorkspaceCwd) return issueWorkspaceCwd;

    if (contextProjectWorkspaceId) {
      const contextWorkspaceCwd = await db
        .select({ cwd: projectWorkspaces.cwd })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, contextProjectWorkspaceId), eq(projectWorkspaces.companyId, agent.companyId)))
        .then((rows) => readNonEmptyString(rows[0]?.cwd));
      if (contextWorkspaceCwd) return contextWorkspaceCwd;
    }

    return readNonEmptyString(adapterConfig.cwd) ?? process.cwd();
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const context = parseObject(run.contextSnapshot);
    const baseConfig = parseObject(agent.adapterConfig);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const issueId = readNonEmptyString(context.issueId);
    const providerPreflightCwd = await resolveProviderPreflightCwdForRun(agent, context, baseConfig);
    const providerRoutingBaseConfig = providerPreflightCwd
      ? { ...baseConfig, cwd: providerPreflightCwd }
      : baseConfig;
    let recentModelStall = await findRecentProviderStallForRouting(agent);
    const tieredAdapterAvailability = await resolveTieredExecutionAdapterAvailability(
      providerRoutingBaseConfig,
      readNonEmptyString(providerRoutingBaseConfig.cwd) ?? process.cwd(),
    );
    const forceProviderReprobe = shouldReprobeProviderStallsForRun({
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      contextSnapshot: context,
    });
    let routingStalledLanes = forceProviderReprobe
      ? []
      : [...(recentModelStall?.stalledLanes ?? [])];
    let executionRouting = resolveAgentTieredExecutionRouting({
      role: agent.role,
      adapterType: agent.adapterType,
      adapterConfig: providerRoutingBaseConfig,
      availableAdapters: tieredAdapterAvailability,
      recentStall: Boolean(recentModelStall),
      stallReason: recentModelStall?.reason ?? null,
      stallFailureKind: recentModelStall?.failureKind ?? null,
      stalledLanes: routingStalledLanes,
      stalledLaneModels: recentModelStall?.stalledLaneModels,
      contextSnapshot: context,
    });
    const providerPreflightTrail: ProviderReliabilityPreflightResult[] = [];
    let providerPreflightBlocker: ProviderReliabilityPreflightResult | null = null;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      executionRouting = resolveAgentTieredExecutionRouting({
        role: agent.role,
        adapterType: agent.adapterType,
        adapterConfig: providerRoutingBaseConfig,
        availableAdapters: tieredAdapterAvailability,
        recentStall: Boolean(recentModelStall) || routingStalledLanes.length > 0,
        stallReason: recentModelStall?.reason ?? null,
        stallFailureKind: recentModelStall?.failureKind ?? null,
        stalledLanes: routingStalledLanes,
        stalledLaneModels: recentModelStall?.stalledLaneModels,
        contextSnapshot: context,
      });

      const preflightTarget = resolveProviderReliabilityHealthTarget({
        adapterType: executionRouting.adapterType,
        adapterConfig: executionRouting.adapterConfig,
        selectedLane: executionRouting.route?.selectedLane ?? null,
      });
      if (!preflightTarget) break;

      const { config: preflightRuntimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        executionRouting.adapterConfig,
      );
      const providerPreflightConfig = providerPreflightCwd
        ? { ...preflightRuntimeConfig, cwd: providerPreflightCwd }
        : preflightRuntimeConfig;
      const providerPreflight = await evaluateProviderReliabilityPreflight({
        companyId: agent.companyId,
        adapterType: executionRouting.adapterType,
        adapterConfig: providerPreflightConfig,
        selectedLane: executionRouting.route?.selectedLane ?? null,
      });
      providerPreflightTrail.push(providerPreflight);
      if (providerPreflight.status !== "degraded" || !providerPreflight.target) break;

      const nextStalledLanes = mergeProviderStalledLanes(
        routingStalledLanes,
        [providerPreflight.target.lane],
      );
      if (nextStalledLanes.length === routingStalledLanes.length) {
        providerPreflightBlocker = providerPreflight;
        break;
      }

      routingStalledLanes = nextStalledLanes;
      recentModelStall = {
        runId: recentModelStall?.runId ?? run.id,
        reason: providerPreflight.reason ?? "provider_preflight_degraded",
        failureKind: providerPreflight.failureKind ?? "provider_preflight",
        stalledLanes: routingStalledLanes,
        stalledLaneModels: {
          ...(recentModelStall?.stalledLaneModels ?? {}),
          [providerPreflight.target.lane]: providerPreflight.target.model ?? null,
        },
        scope: recentModelStall?.scope ?? "agent",
      };
    }

    if (providerPreflightBlocker) {
      const gate = {
        status: "blocked",
        source: "pre_spawn_provider_preflight",
        scope: recentModelStall?.scope ?? "agent",
        sourceRunId: recentModelStall?.runId ?? run.id,
        reason: providerPreflightBlocker.reason,
        failureKind: providerPreflightBlocker.failureKind,
        originalAdapterType: agent.adapterType,
        selectedAdapterType: executionRouting.route?.selectedAdapterType ?? executionRouting.adapterType,
        selectedLane: providerPreflightBlocker.target?.lane ?? executionRouting.route?.selectedLane ?? null,
        provider: providerPreflightBlocker.target?.provider ?? executionRouting.route?.provider ?? null,
        model: providerPreflightBlocker.target?.model ?? executionRouting.route?.model ?? null,
        candidates: executionRouting.route?.candidates ?? [],
        availability: tieredAdapterAvailability,
        preflight: providerPreflightBlocker,
        preflightAttempts: providerPreflightTrail,
      };
      context.paperclipProviderReliabilityGate = gate;
      context.paperclipExecutionRouting = {
        ...(executionRouting.route ?? {}),
        availability: tieredAdapterAvailability,
        recentStall: recentModelStall,
        preflight: providerPreflightBlocker,
        preflightAttempts: providerPreflightTrail,
      };
      const preflightEvidence = redactCurrentUserText(
        JSON.stringify({
          gate,
          preflightAttempts: providerPreflightTrail,
        }, null, 2),
      ).slice(0, 12_000);
      const preflightEvidenceTokens = Math.ceil(preflightEvidence.length / 4);
      const preflightLedgerEntry = await contextLedger.recordPreSpawn({
        companyId: run.companyId,
        runId: run.id,
        agentId: run.agentId,
        issueId: issueId ?? null,
        taskKey,
        adapterType: executionRouting.adapterType,
        adapterVersion: null,
        branch: null,
        sessionIdBefore: run.sessionIdBefore ?? null,
        meta: {
          adapterType: executionRouting.adapterType,
          command: "provider_reliability_preflight",
          cwd: providerPreflightCwd,
          commandArgs: [
            providerPreflightBlocker.target?.provider,
            providerPreflightBlocker.target?.model,
          ].filter((value): value is string => Boolean(value)),
          commandNotes: [
            "adapter spawn blocked before model invocation because the selected provider preflight was degraded",
          ],
          promptClass: "failure_recovery",
          promptBudgetVersion: "context-economy.v1",
          promptMetrics: {
            promptClass: "failure_recovery",
            promptBudgetVersion: "context-economy.v1",
            totalChars: preflightEvidence.length,
            estimatedPromptTokens: preflightEvidenceTokens,
            evidenceSliceCount: providerPreflightTrail.length,
            components: [
              {
                name: "provider_reliability_preflight",
                type: "evidence_slice",
                chars: preflightEvidence.length,
                estimatedTokens: preflightEvidenceTokens,
                evidenceSliceCount: providerPreflightTrail.length,
                truncated: preflightEvidence.length >= 12_000,
                provider: providerPreflightBlocker.target?.provider ?? null,
                model: providerPreflightBlocker.target?.model ?? null,
                lane: providerPreflightBlocker.target?.lane ?? null,
                status: providerPreflightBlocker.status,
                reason: providerPreflightBlocker.reason,
                failureKind: providerPreflightBlocker.failureKind,
              },
            ],
          },
          evidenceSliceCount: providerPreflightTrail.length,
          context,
        },
        context,
      });
      context.paperclipContextLedger = {
        entryId: preflightLedgerEntry.id,
        promptClass: preflightLedgerEntry.promptClass,
        promptBudgetVersion: preflightLedgerEntry.promptBudgetVersion,
        promptFingerprint: preflightLedgerEntry.promptFingerprint,
        estimatedPromptTokens: preflightLedgerEntry.estimatedPromptTokens,
        budgetStatus: preflightLedgerEntry.budgetStatus,
        budgetLimitTokens: preflightLedgerEntry.budgetLimitTokens,
      };
      const targetLabel = [
        providerPreflightBlocker.target?.provider,
        providerPreflightBlocker.target?.model,
      ]
        .filter((value): value is string => Boolean(value))
        .join("/");
      const blockerMessage = `Provider preflight blocked adapter spawn${targetLabel ? ` for ${targetLabel}` : ""}: ${
        providerPreflightBlocker.reason ?? "provider degraded"
      }`;
      const failedRun = await setRunStatus(run.id, "failed", {
        error: blockerMessage,
        errorCode: "provider_reliability_preflight_failed",
        finishedAt: new Date(),
        contextSnapshot: context,
      });
      await contextLedger.finalizeRun({
        runId: run.id,
        outcome: "failed",
        blocker: blockerMessage,
        sessionIdAfter: null,
        usage: null,
        resultJson: {
          errorCode: "provider_reliability_preflight_failed",
          finalBlocker: blockerMessage,
          providerReliabilityGate: gate,
        },
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: providerPreflightBlocker.reason ?? "provider degraded",
      });
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    if (recentModelStall || executionRouting.route) {
      logger.warn(
        {
          runId: run.id,
          agentId: agent.id,
          agentName: agent.name,
          adapterType: agent.adapterType,
          recentProviderStall: recentModelStall,
          tieredAdapterAvailability,
          executionRouting: executionRouting.route,
        },
        "provider reliability routing decision",
      );
    }
    const executionAdapterType = executionRouting.adapterType;
    const tieredRouteUsesHermesFallbackLane =
      executionRouting.route?.selectedAdapterType === "hermes_local" &&
      executionRouting.route.selectedLane !== "hermes_local";
    const executionAgent =
      executionRouting.changed
        ? {
            ...agent,
            adapterType: executionAdapterType,
            adapterConfig: executionRouting.adapterConfig,
          }
        : agent;
    const runtime = await ensureRuntimeState(executionAgent);
    const sessionCodec = getAdapterSessionCodec(executionAdapterType);
    const latestProviderPreflight = providerPreflightTrail.at(-1) ?? null;
    if (executionRouting.route || latestProviderPreflight) {
      const providerReliabilityGate = {
        status: executionRouting.route ? "rerouted" : "validated",
        source: latestProviderPreflight
          ? "pre_spawn_provider_preflight"
          : recentModelStall?.scope === "company"
            ? "recent_company_provider_failure"
            : recentModelStall
              ? "recent_run_provider_failure"
              : "tiered_execution_policy",
        scope: recentModelStall?.scope ?? null,
        sourceRunId: recentModelStall?.runId ?? null,
        reason: executionRouting.route?.reason ?? latestProviderPreflight?.reason ?? null,
        failureKind: resolveProviderReliabilityGateFailureKind({
          hasTieredRoute: Boolean(executionRouting.route),
          recentFailureKind: recentModelStall?.failureKind ?? null,
          preflightStatus: latestProviderPreflight?.status ?? null,
          preflightFailureKind: latestProviderPreflight?.failureKind ?? null,
        }),
        originalAdapterType: executionRouting.route?.originalAdapterType ?? agent.adapterType,
        selectedAdapterType: executionRouting.route?.selectedAdapterType ?? executionAdapterType,
        selectedLane: executionRouting.route?.selectedLane ?? latestProviderPreflight?.target?.lane ?? null,
        provider: executionRouting.route?.provider ?? latestProviderPreflight?.target?.provider ?? null,
        model: executionRouting.route?.model ?? latestProviderPreflight?.target?.model ?? null,
        candidates: executionRouting.route?.candidates ?? [],
        availability: tieredAdapterAvailability,
        preflight: latestProviderPreflight,
        preflightAttempts: providerPreflightTrail,
      };
      context.paperclipExecutionRouting = {
        ...(executionRouting.route ?? {}),
        availability: tieredAdapterAvailability,
        recentStall: recentModelStall,
        preflight: latestProviderPreflight,
        preflightAttempts: providerPreflightTrail,
      };
      context.paperclipProviderReliabilityGate = providerReliabilityGate;
    }
    let issueContext = issueId ? await getIssueExecutionContext(agent.companyId, issueId) : null;
    if (
      issueId &&
      issueContext &&
      shouldAutoCheckoutIssueForWake({
        contextSnapshot: context,
        issueStatus: issueContext.status,
        issueAssigneeAgentId: issueContext.assigneeAgentId,
        agentId: agent.id,
      })
    ) {
      try {
        await issuesSvc.checkout(issueId, agent.id, ["todo", "backlog", "blocked"], run.id);
        context[PAPERCLIP_HARNESS_CHECKOUT_KEY] = true;
      } catch (error) {
        if (!isCheckoutConflictError(error)) throw error;
        context[PAPERCLIP_HARNESS_CHECKOUT_KEY] = false;
      }
      issueContext = await getIssueExecutionContext(agent.companyId, issueId);
    }
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectContext = executionProjectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
            env: projects.env,
          })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const projectExecutionWorkspacePolicy = gateProjectExecutionWorkspacePolicy(
      parseProjectExecutionWorkspacePolicy(projectContext?.executionWorkspacePolicy),
      isolatedWorkspacesEnabled,
    );
    const taskSession = taskKey && !tieredRouteUsesHermesFallbackLane
      ? await getTaskSession(agent.companyId, agent.id, executionAdapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const explicitResumeSessionParams = tieredRouteUsesHermesFallbackLane
      ? null
      : normalizeSessionParams(sessionCodec.deserialize(parseObject(context.resumeSessionParams)));
    const explicitResumeSessionDisplayId = truncateDisplayId(
      readNonEmptyString(context.resumeSessionDisplayId) ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
        readNonEmptyString(explicitResumeSessionParams?.sessionId),
    );
    const previousSessionParams =
      explicitResumeSessionParams ??
      (explicitResumeSessionDisplayId ? { sessionId: explicitResumeSessionDisplayId } : null) ??
      normalizeSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null));
    const config = executionRouting.adapterConfig;
    const requestedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: requestedExecutionWorkspaceMode !== "agent_default" },
    );
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          status: issueContext.status,
          priority: issueContext.priority,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const paperclipWakePayload = await buildPaperclipWakePayload({
      db,
      companyId: agent.companyId,
      contextSnapshot: context,
      issueSummary: issueRef
        ? {
            id: issueRef.id,
            identifier: issueRef.identifier,
            title: issueRef.title,
            status: issueRef.status,
            priority: issueRef.priority,
          }
        : null,
    });
    if (paperclipWakePayload) {
      context[PAPERCLIP_WAKE_PAYLOAD_KEY] = paperclipWakePayload;
    } else {
      delete context[PAPERCLIP_WAKE_PAYLOAD_KEY];
    }
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    const persistedExecutionWorkspaceMode = shouldReuseExisting && existingExecutionWorkspace
      ? issueExecutionWorkspaceModeForPersistedWorkspace(existingExecutionWorkspace.mode)
      : null;
    const effectiveExecutionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode> =
      persistedExecutionWorkspaceMode === "isolated_workspace" ||
      persistedExecutionWorkspaceMode === "operator_branch" ||
      persistedExecutionWorkspaceMode === "agent_default"
        ? persistedExecutionWorkspaceMode
        : requestedExecutionWorkspaceMode;
    const workspaceManagedConfig = shouldReuseExisting
      ? { ...config }
      : buildExecutionWorkspaceAdapterConfig({
          agentConfig: config,
          projectPolicy: projectExecutionWorkspacePolicy,
          issueSettings: issueExecutionWorkspaceSettings,
          mode: requestedExecutionWorkspaceMode,
          legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
        });
    const persistedWorkspaceManagedConfig = applyPersistedExecutionWorkspaceConfig({
      config: workspaceManagedConfig,
      workspaceConfig: existingExecutionWorkspace?.config ?? null,
      mode: effectiveExecutionWorkspaceMode,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...persistedWorkspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : persistedWorkspaceManagedConfig;
    const configSnapshot = buildExecutionWorkspaceConfigSnapshot(mergedConfig);
    const executionRunConfig = stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
    const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
      companyId: agent.companyId,
      executionRunConfig,
      projectEnv: projectContext?.env ?? null,
      secretsSvc,
    });
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const runtimeConfig = {
      ...resolvedConfig,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspaceBase = {
      baseCwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    } satisfies ExecutionWorkspaceInput;
    const reusedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? buildRealizedExecutionWorkspaceFromPersisted({
          base: executionWorkspaceBase,
          workspace: existingExecutionWorkspace,
        })
      : null;
    const executionWorkspace = reusedExecutionWorkspace ?? await realizeExecutionWorkspace({
          base: executionWorkspaceBase,
          config: runtimeConfig,
          issue: issueRef,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          recorder: workspaceOperationRecorder,
        });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    let persistedExecutionWorkspace = null;
    const nextExecutionWorkspaceMetadataBase = {
      ...(existingExecutionWorkspace?.metadata ?? {}),
      source: executionWorkspace.source,
      createdByRuntime: executionWorkspace.created,
      branchOwner: (() => {
        // Persist the agent that created this execution workspace as the
        // branch owner. For git_worktree strategy this accurately reflects
        // the branch creator; for project_primary / shared_workspace it
        // records the first agent to establish the execution workspace so
        // that Dispatch Poller telemetry and contract checks have a
        // deterministic owner rather than null.
        const prior = existingExecutionWorkspace?.metadata?.branchOwner;
        if (typeof prior === "string" && prior.length > 0) return prior;
        return agentBranchOwnerKey(agent);
      })(),
    } as Record<string, unknown>;
    const nextExecutionWorkspaceMetadata = shouldReuseExisting
      ? nextExecutionWorkspaceMetadataBase
      : configSnapshot
        ? mergeExecutionWorkspaceConfig(nextExecutionWorkspaceMetadataBase, configSnapshot)
        : nextExecutionWorkspaceMetadataBase;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: nextExecutionWorkspaceMetadata,
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            cleanupCommand: configSnapshot?.cleanupCommand ?? null,
            teardownCommand: configSnapshot?.teardownCommand ?? projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace) {
      const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
      const shouldSwitchIssueToExistingWorkspace =
        issueRef?.executionWorkspacePreference === "reuse_existing" ||
        requestedExecutionWorkspaceMode === "isolated_workspace" ||
        requestedExecutionWorkspaceMode === "operator_branch";
      const nextIssuePatch: Record<string, unknown> = {};
      if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
        nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
      }
      if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
        nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
      }
      if (shouldSwitchIssueToExistingWorkspace) {
        nextIssuePatch.executionWorkspacePreference = "reuse_existing";
        nextIssuePatch.executionWorkspaceSettings = {
          ...(issueExecutionWorkspaceSettings ?? {}),
          mode: nextIssueWorkspaceMode,
        };
      }
      if (Object.keys(nextIssuePatch).length > 0) {
        await issuesSvc.update(issueId, nextIssuePatch);
      }
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeAdapterMatchesExecution =
      runtime.adapterType === executionAdapterType && !tieredRouteUsesHermesFallbackLane;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
      ...(executionRouting.route
        ? [
            `Tiered execution routing switched this run from ${executionRouting.route.originalAdapterType} to ${executionRouting.route.selectedLane} (${executionRouting.route.selectedAdapterType}${executionRouting.route.provider ? `/${executionRouting.route.provider}` : ""}${executionRouting.route.model ? `:${executionRouting.route.model}` : ""}) because ${executionRouting.route.reason}.`,
          ]
        : []),
      ...(!runtimeAdapterMatchesExecution && runtime.sessionId
        ? [
            `Skipping saved ${runtime.adapterType} session because this run is using ${executionAdapterType}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: effectiveExecutionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
      branchOwner:
        (() => {
          // Prefer the persisted branchOwner from execution workspace metadata
          // (set when the workspace was created or updated).
          // Falls back to the current agent urlKey/id for backward-compatible
          // behavior when metadata is absent (e.g. workspaces created before
          // this contract was introduced).
          if (executionWorkspace.branchName) {
            const persisted = persistedExecutionWorkspace?.metadata?.branchOwner;
            if (typeof persisted === "string" && persisted.length > 0) return persisted;
            return agentBranchOwnerKey(agent);
          }
          return agentBranchOwnerKey(agent);
        })(),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    const contextEconomyHint = await buildPaperclipContextEconomyHint(
      resolvePaperclipContextEconomyCwd({ executionWorkspace, resolvedConfig }),
    );
    if (contextEconomyHint) {
      context.paperclipContextEconomy = contextEconomyHint;
    } else {
      delete context.paperclipContextEconomy;
    }
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback =
      taskKey || resetTaskSession || !runtimeAdapterMatchesExecution
        ? null
        : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent: executionAgent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id, runId: run.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        const metaRecord = meta as unknown as Record<string, unknown>;
        const runtimeProvenance = {
          ...parseObject(context.paperclipRuntimeProvenance),
          ...parseObject(metaRecord.runtimeProvenance),
          paperclipServerVersion: resolvePaperclipServerVersion(),
          paperclipServerGitSha: await resolvePaperclipServerGitSha(),
          adapterType: executionAdapterType,
          adapterVersion: readNonEmptyString(meta.adapterVersion) ?? null,
          promptBudgetVersion: readNonEmptyString(meta.promptBudgetVersion) ?? null,
        };
        context.paperclipRuntimeProvenance = runtimeProvenance;
        const ledgerEntry = await contextLedger.recordPreSpawn({
          companyId: currentRun.companyId,
          runId: currentRun.id,
          agentId: currentRun.agentId,
          issueId: issueRef?.id ?? null,
          taskKey,
          adapterType: executionAdapterType,
          adapterVersion: readNonEmptyString(meta.adapterVersion) ?? null,
          branch: executionWorkspace.branchName,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          meta,
          context,
        });
        context.paperclipContextLedger = {
          entryId: ledgerEntry.id,
          promptClass: ledgerEntry.promptClass,
          promptBudgetVersion: ledgerEntry.promptBudgetVersion,
          promptFingerprint: ledgerEntry.promptFingerprint,
          estimatedPromptTokens: ledgerEntry.estimatedPromptTokens,
          budgetStatus: ledgerEntry.budgetStatus,
          budgetLimitTokens: ledgerEntry.budgetLimitTokens,
        };
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, currentRun.id));
        const eventPayload = {
          ...(meta as unknown as Record<string, unknown>),
          prompt: undefined,
          contextLedgerEntryId: ledgerEntry.id,
          promptClass: ledgerEntry.promptClass,
          promptBudgetVersion: ledgerEntry.promptBudgetVersion,
          promptFingerprint: ledgerEntry.promptFingerprint,
          budgetStatus: ledgerEntry.budgetStatus,
          budgetLimitTokens: ledgerEntry.budgetLimitTokens,
        };
        delete eventPayload.prompt;
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: eventPayload,
        });
      };

      const adapter = getServerAdapter(executionAdapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, executionAdapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: executionAdapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const liveRunBeforeAdapter = await getRun(run.id);
      if (!liveRunBeforeAdapter || liveRunBeforeAdapter.status !== "running") {
        logger.warn(
          {
            runId: run.id,
            status: liveRunBeforeAdapter?.status ?? null,
            errorCode: liveRunBeforeAdapter?.errorCode ?? null,
          },
          "skipping adapter spawn because heartbeat run is no longer active",
        );
        return;
      }
      schedulePreSpawnWatchdog(run.id);
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent: executionAgent,
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, {
            pid: meta.pid,
            processGroupId:
              "processGroupId" in meta && typeof meta.processGroupId === "number"
                ? meta.processGroupId
                : null,
            startedAt: meta.startedAt,
          });
        },
        authToken: authToken ?? undefined,
      });
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: executionAdapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id, runId: run.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const rawCostUsd =
        typeof adapterResult.costUsd === "number" && Number.isFinite(adapterResult.costUsd)
          ? Math.max(0, adapterResult.costUsd)
          : null;
      const cumulativeSessionUsage = adapterReportsCumulativeSessionUsage(adapterResult);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
        rawCostUsd,
        deriveCostFromSessionTotals: cumulativeSessionUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;
      const normalizedCostUsd = sessionUsageResolution.normalizedCostUsd;
      const usageAccounting = resolveUsageAccountingPolicy({
        adapterType: executionAdapterType,
        result: adapterResult,
        rawUsage,
        rawCostUsd,
      });
      const usageForAccounting = usageAccounting.bookUsage ? normalizedUsage : null;
      const costUsdForAccounting = usageAccounting.bookCost ? normalizedCostUsd : null;
      const inferredResultFailure = inferHeartbeatRunResultFailure(
        adapterResult.resultJson ?? null,
        adapterResult.summary ?? null,
      );

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage && !inferredResultFailure) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        normalizedUsage || rawUsage || rawCostUsd != null
          ? ({
              ...(usageForAccounting ?? {}),
              ...(!usageAccounting.bookUsage && normalizedUsage ? {
                observedInputTokens: normalizedUsage.inputTokens,
                observedCachedInputTokens: normalizedUsage.cachedInputTokens,
                observedOutputTokens: normalizedUsage.outputTokens,
              } : {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(rawCostUsd != null ? { rawCostUsd } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...(sessionUsageResolution.derivedCostFromSessionTotals ? { costUsageSource: "session_delta" } : {}),
              ...((nextSessionState.displayId ?? nextSessionState.legacySessionId)
                ? { persistedSessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId }
                : {}),
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(costUsdForAccounting != null ? { costUsd: costUsdForAccounting } : {}),
              ...(!usageAccounting.bookCost && normalizedCostUsd != null ? { observedCostUsd: normalizedCostUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
              usageConfidence: usageAccounting.usageConfidence,
              costConfidence: usageAccounting.costConfidence,
              usageAccountingMode: usageAccounting.usageAccountingMode,
              costAccountingMode: usageAccounting.costAccountingMode,
            } as Record<string, unknown>)
          : null;

      const persistedResultJson = mergeHeartbeatRunResultJson(
        adapterResult.resultJson ?? null,
        adapterResult.summary ?? null,
      );

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage
                  ?? inferredResultFailure?.message
                  ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
              : outcome === "cancelled"
                ? "cancelled"
                : outcome === "failed"
                  ? (adapterResult.errorCode ?? inferredResultFailure?.code ?? "adapter_failed")
                  : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: persistedResultJson,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await contextLedger.finalizeRun({
        runId: run.id,
        outcome,
        blocker:
          outcome === "succeeded"
            ? null
            : adapterResult.errorMessage ?? inferredResultFailure?.message ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        usage: usageForAccounting,
        resultJson: persistedResultJson,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? inferredResultFailure?.message ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        if (issueId && outcome === "succeeded") {
          try {
            const issueComment = buildHeartbeatRunIssueComment(persistedResultJson);
            if (issueComment) {
              await issuesSvc.addComment(issueId, issueComment, { agentId: agent.id, runId: finalizedRun.id });
            }
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post run summary comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        await finalizeIssueCommentPolicy(finalizedRun, agent);
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        const adapterResultWithNormalizedCost = {
          ...adapterResult,
          costUsd: costUsdForAccounting,
        };
        await updateRuntimeState(executionAgent, finalizedRun, adapterResultWithNormalizedCost, {
          legacySessionId: nextSessionState.legacySessionId,
        }, usageForAccounting);
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: executionAdapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: executionAdapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode:
          err instanceof HttpError &&
          err.status === 409 &&
          /prompt budget exceeded/i.test(err.message)
            ? "prompt_budget_exceeded"
            : "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await contextLedger.finalizeRun({
        runId: run.id,
        outcome: "failed",
        blocker: message,
        sessionIdAfter: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
        usage: null,
        resultJson: null,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await finalizeIssueCommentPolicy(failedRun, agent);
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(executionAgent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: executionAdapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            const failedAgent = await getAgent(run.agentId).catch(() => null);
            if (failedAgent) {
              await finalizeIssueCommentPolicy(failedRun, failedAgent).catch(() => undefined);
            }
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore =
          readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
          await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    let issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const explicitResumeSession = await resolveExplicitResumeSessionOverride(agent, payload, taskKey);
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId = explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId = explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams = explicitResumeSession.sessionParams;
      if (!readNonEmptyString(enrichedContextSnapshot.issueId) && explicitResumeSession.issueId) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskId) && explicitResumeSession.taskId) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskKey) && explicitResumeSession.taskKey) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey = readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      await resolveSessionBeforeForWakeup(agent, effectiveTaskKey);

    const writeSkippedRequest = async (
      skipReason: string,
      skippedPayload: Record<string, unknown> | null | undefined = payload,
      error?: string | null,
    ) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload: skippedPayload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        error: error ?? null,
        finishedAt: new Date(),
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const providerBackoff = await resolveProviderDegradedWakeBackoff({
      agent,
      source,
      triggerDetail,
      contextSnapshot: enrichedContextSnapshot,
    });
    if (providerBackoff) {
      await writeSkippedRequest(
        providerBackoff.reason,
        {
          ...(payload ?? {}),
          paperclipProviderBackoff: {
            source: "provider_degraded_wakeup_backoff",
            cooldownMs: providerBackoff.cooldownMs,
            recentModelStall: providerBackoff.recentModelStall,
            availability: providerBackoff.availability,
          },
        },
        `Skipped automatic wake because provider reliability is degraded and no recovery lane is currently available: ${providerBackoff.recentModelStall.reason}`,
      );
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            hiddenAt: issues.hiddenAt,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        if (!canExecuteIssue(issue)) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_closed",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        // executionRunId is NOT stamped here (enqueueWakeup queues the run but
        // doesn't start it). It will be stamped in claimQueuedRun() once the run
        // transitions to "running" — Fix A (lazy locking).

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      await terminateHeartbeatRunProcess({
        pid: running.child.pid ?? run.processPid,
        processGroupId: running.processGroupId ?? run.processGroupId,
        graceMs: Math.max(1, running.graceSec) * 1000,
      });
    } else if (run.processPid || run.processGroupId) {
      await terminateHeartbeatRunProcess({
        pid: run.processPid,
        processGroupId: run.processGroupId,
      });
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        await terminateHeartbeatRunProcess({
          pid: running.child.pid ?? run.processPid,
          processGroupId: running.processGroupId ?? run.processGroupId,
          graceMs: Math.max(1, running.graceSec) * 1000,
        });
        runningProcesses.delete(run.id);
      } else if (run.processPid || run.processGroupId) {
        await terminateHeartbeatRunProcess({
          pid: run.processPid,
          processGroupId: run.processGroupId,
        });
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = limit ? await query.limit(limit) : await query;
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, agent.companyId),
            eq(agentTaskSessions.agentId, agent.id),
            eq(agentTaskSessions.adapterType, agent.adapterType),
          ),
        )
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
        runtimePatch.lastRunId = null;
        runtimePatch.lastRunStatus = null;
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    resumeQueuedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;
        const recentModelStall = await findRecentProviderStallForRouting(agent, {
          lookbackMs: TIMER_MODEL_STALL_BACKOFF_MS,
        });
        if (recentModelStall) {
          const adapterConfig = parseObject(agent.adapterConfig);
          const availability = await resolveTieredExecutionAdapterAvailability(
            adapterConfig,
            readNonEmptyString(adapterConfig.cwd) ?? process.cwd(),
          );
          const recoveryRoute = resolveAgentTieredExecutionRouting({
            role: agent.role,
            adapterType: agent.adapterType,
            adapterConfig,
            availableAdapters: availability,
            recentStall: true,
            stallReason: recentModelStall.reason,
            stallFailureKind: recentModelStall.failureKind,
            stalledLanes: recentModelStall.stalledLanes,
            stalledLaneModels: recentModelStall.stalledLaneModels,
          });
          if (
            !recoveryRoute.route &&
            elapsedMs < Math.max(policy.intervalSec * 1000, TIMER_MODEL_STALL_BACKOFF_MS)
          ) {
            skipped += 1;
            continue;
          }
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getRunIssueSummary: async (runId: string) => {
      const [run] = await db
        .select(heartbeatRunIssueSummaryColumns)
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      return run ?? null;
    },

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },

    getActiveRunIssueSummaryForAgent: async (agentId: string) => {
      const [run] = await db
        .select(heartbeatRunIssueSummaryColumns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
