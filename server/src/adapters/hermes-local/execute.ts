import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "../types.js";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  resolvePaperclipRuntimeSkillCandidateNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensurePathInEnv,
  parseObject,
  resolveCommandForLogs,
  runChildProcess,
  selectPaperclipRuntimeSkillsForRun,
} from "../utils.js";

const ADAPTER_TYPE = "hermes_local";
const ADAPTER_VERSION = "paperclip-compat-2026.06.15";
const DEFAULT_COMMAND = "hermes";
const DEFAULT_SOURCE = "paperclip";
const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_GRACE_SEC = 15;
const DEFAULT_CONTEXT_MAX_CHARS = 16_000;
const DEFAULT_OUTPUT_MAX_SENTENCES = 7;
const DEFAULT_OUTPUT_MAX_CHARS = 1200;
const DEFAULT_NO_ISSUE_CONTEXT_MAX_CHARS = 8_000;
const DEFAULT_NO_ISSUE_OUTPUT_MAX_SENTENCES = 6;
const DEFAULT_NO_ISSUE_OUTPUT_MAX_CHARS = 1_200;
const DEFAULT_NO_ISSUE_MAX_TURNS = 4;
const DEFAULT_TIMER_ASSIGNED_CONTEXT_MAX_CHARS = 12_000;
const DEFAULT_TIMER_ASSIGNED_OUTPUT_MAX_SENTENCES = 6;
const DEFAULT_TIMER_ASSIGNED_OUTPUT_MAX_CHARS = 1_400;
const DEFAULT_TIMER_ASSIGNED_MAX_TURNS = 6;
const PROMPT_BUDGET_VERSION = "context-economy.v1";
const PRIOR_RUN_VALUE_QUESTION = "Does this session's prior runs provide any value to this current run?";
const DEFAULT_HERMES_TOOL_OUTPUT_MAX_BYTES = 16_000;
const DEFAULT_HERMES_TOOL_OUTPUT_MAX_LINES = 320;
const DEFAULT_HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH = 1_000;
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function truncateText(value: string, maxChars: number, label = "truncated"): string {
  if (value.length <= maxChars) return value;
  const marker = `[${label}: ${value.length - maxChars} chars omitted]`;
  const available = Math.max(0, maxChars - marker.length - 6);
  const head = Math.ceil(available * 0.65);
  const tail = Math.max(0, available - head);
  return `${value.slice(0, head)}...${marker}...${tail > 0 ? value.slice(-tail) : ""}`;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
        if (!Array.isArray(item)) {
          return Object.fromEntries(
            Object.keys(item as Record<string, unknown>)
              .sort()
              .map((key) => [key, (item as Record<string, unknown>)[key]]),
          );
        }
      }
      return item;
    },
    2,
  ) ?? "null";
}

function compactContext(context: Record<string, unknown>, maxChars: number): string {
  return truncateText(stableStringify(context), maxChars, "context truncated");
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function contextIsTimerAssignedWorkWithoutExternalSignal(context: Record<string, unknown>): boolean {
  const wake = parseObject(context.paperclipWake);
  const approval = parseObject(context.paperclipApproval ?? context.approval);
  const timerPinnedIssue = parseObject(context.paperclipTimerPinnedIssue ?? context.paperclipWakePinnedIssue);
  const wakeReason = readString(context.wakeReason) ?? readString(wake.reason);
  const wakeSource = readString(context.wakeSource) ?? readString(context.source);
  const hasTimerAssignedIssue = Boolean(
    readString(timerPinnedIssue.issueId) &&
      (wakeReason === "assigned_work_timer" ||
        wakeSource === "timer" ||
        readString(timerPinnedIssue.reason) === "timer_open_assignment_pinned"),
  );
  if (!hasTimerAssignedIssue) return false;
  return !(
    readString(context.wakeCommentId) ||
    readString(context.commentId) ||
    readString(context.approvalId) ||
    readString(context.userPrompt) ||
    readString(context.prompt) ||
    readString(wake.latestCommentId) ||
    readString(approval.id) ||
    hasNonEmptyArray(wake.comments) ||
    hasNonEmptyArray(wake.commentIds)
  );
}

function contextHasExplicitWorkHandoff(context: Record<string, unknown>): boolean {
  const wake = parseObject(context.paperclipWake);
  const approval = parseObject(context.paperclipApproval ?? context.approval);
  return Boolean(
    readString(context.issueId) ||
      readString(context.wakeCommentId) ||
      readString(context.commentId) ||
      readString(context.approvalId) ||
      readString(context.userPrompt) ||
      readString(context.prompt) ||
      readString(parseObject(wake.issue).id) ||
      readString(wake.latestCommentId) ||
      readString(approval.id) ||
      hasNonEmptyArray(wake.comments) ||
      hasNonEmptyArray(wake.commentIds),
  );
}

function requestShapingConfig(config: Record<string, unknown>) {
  return {
    ...parseObject(parseObject(config.tokenomics).requestShaping),
    ...parseObject(config.requestShaping),
  };
}

function resolveTimerAssignedWorkBudget(input: {
  config: Record<string, unknown>;
  baseContextMaxChars: number;
  baseOutputMaxSentences: number;
  baseOutputMaxChars: number;
  baseMaxTurnsPerRun: number | null;
}) {
  const contextMaxChars = Math.min(
    input.baseContextMaxChars,
    Math.max(1_000, Math.trunc(readNumber(
      input.config.timerAssignedContextMaxChars,
      DEFAULT_TIMER_ASSIGNED_CONTEXT_MAX_CHARS,
    ))),
  );
  const outputMaxSentences = Math.min(
    input.baseOutputMaxSentences,
    Math.max(1, Math.trunc(readNumber(
      input.config.timerAssignedOutputMaxSentences,
      DEFAULT_TIMER_ASSIGNED_OUTPUT_MAX_SENTENCES,
    ))),
  );
  const outputMaxChars = Math.min(
    input.baseOutputMaxChars,
    Math.max(400, Math.trunc(readNumber(
      input.config.timerAssignedOutputMaxChars,
      DEFAULT_TIMER_ASSIGNED_OUTPUT_MAX_CHARS,
    ))),
  );
  const configuredMaxTurns = Math.max(1, Math.trunc(readNumber(
    input.config.timerAssignedMaxTurnsPerRun,
    DEFAULT_TIMER_ASSIGNED_MAX_TURNS,
  )));
  const maxTurnsPerRun = input.baseMaxTurnsPerRun && input.baseMaxTurnsPerRun > 0
    ? Math.min(input.baseMaxTurnsPerRun, configuredMaxTurns)
    : configuredMaxTurns;

  return {
    contextMaxChars,
    outputMaxSentences,
    outputMaxChars,
    maxTurnsPerRun,
  };
}

function resolveRequestShaping(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  baseContextMaxChars: number;
  baseOutputMaxSentences: number;
  baseOutputMaxChars: number;
  baseMaxTurnsPerRun: number | null;
}): {
  mode: "deliverable_work" | "bounded_status";
  enabled: boolean;
  reason: string;
  priorRunValueQuestion: string;
  contextMaxChars: number;
  outputMaxSentences: number;
  outputMaxChars: number;
  maxTurnsPerRun: number | null;
  allowSessionResume: boolean;
  dropSessionHandoff: boolean;
  instructions: string;
} {
  const config = requestShapingConfig(input.config);
  const enabled = readBoolean(config.enabled, true);
  const explicitWork = contextHasExplicitWorkHandoff(input.context);
  const priorRunValueQuestion = readString(config.priorRunValueQuestion) ?? PRIOR_RUN_VALUE_QUESTION;
  if (!enabled) {
    return {
      mode: "deliverable_work",
      enabled: false,
      reason: "request_shaping_disabled",
      priorRunValueQuestion,
      contextMaxChars: input.baseContextMaxChars,
      outputMaxSentences: input.baseOutputMaxSentences,
      outputMaxChars: input.baseOutputMaxChars,
      maxTurnsPerRun: null,
      allowSessionResume: true,
      dropSessionHandoff: false,
      instructions: [
        "Request shaping: disabled by adapter config.",
        `Still answer this before using prior session context: ${priorRunValueQuestion}`,
      ].join("\n"),
    };
  }
  if (contextIsTimerAssignedWorkWithoutExternalSignal(input.context)) {
    const timerBudget = resolveTimerAssignedWorkBudget({
      config,
      baseContextMaxChars: input.baseContextMaxChars,
      baseOutputMaxSentences: input.baseOutputMaxSentences,
      baseOutputMaxChars: input.baseOutputMaxChars,
      baseMaxTurnsPerRun: input.baseMaxTurnsPerRun,
    });
    return {
      mode: "deliverable_work",
      enabled: true,
      reason: "timer_assigned_work_without_external_signal",
      priorRunValueQuestion,
      contextMaxChars: timerBudget.contextMaxChars,
      outputMaxSentences: timerBudget.outputMaxSentences,
      outputMaxChars: timerBudget.outputMaxChars,
      maxTurnsPerRun: timerBudget.maxTurnsPerRun,
      allowSessionResume: false,
      dropSessionHandoff: true,
      instructions: [
        "Request shaping: timer-pinned assigned work has no new external signal.",
        `Before using prior session context, answer internally: ${priorRunValueQuestion}`,
        "Default answer for session resume: no. Do not resume prior sessions for this refresh; rely on current Paperclip issue context, compact receipts, and workspace state.",
        "Keep exploration bounded unless the current issue exposes a new actionable acceptance criterion.",
        "The deliverable remains issue-scoped work, a precise blocker update, or a safe-skip/status receipt tied to the assigned issue.",
      ].join("\n"),
    };
  }
  if (explicitWork) {
    return {
      mode: "deliverable_work",
      enabled: true,
      reason: "explicit_issue_comment_approval_or_prompt",
      priorRunValueQuestion,
      contextMaxChars: input.baseContextMaxChars,
      outputMaxSentences: input.baseOutputMaxSentences,
      outputMaxChars: input.baseOutputMaxChars,
      maxTurnsPerRun: null,
      allowSessionResume: true,
      dropSessionHandoff: false,
      instructions: [
        "Request shaping: explicit work handoff detected.",
        `Before using prior session context, answer internally: ${priorRunValueQuestion}`,
        "Use prior runs only when they materially change the current issue/comment/approval task; otherwise rely on the current Paperclip issue, receipts, context packs, and workspace state.",
        "The deliverable is finished issue-scoped work: code/docs/tests/receipts or a precise blocker update tied to the issue. Do not treat accepted patches, build attempts, or broad status narration as final delivery by themselves.",
      ].join("\n"),
    };
  }

  const contextMaxChars = Math.min(
    input.baseContextMaxChars,
    Math.max(1000, Math.trunc(readNumber(config.noIssueContextMaxChars, DEFAULT_NO_ISSUE_CONTEXT_MAX_CHARS))),
  );
  const outputMaxSentences = Math.min(
    input.baseOutputMaxSentences,
    Math.max(1, Math.trunc(readNumber(config.noIssueOutputMaxSentences, DEFAULT_NO_ISSUE_OUTPUT_MAX_SENTENCES))),
  );
  const outputMaxChars = Math.min(
    input.baseOutputMaxChars,
    Math.max(400, Math.trunc(readNumber(config.noIssueOutputMaxChars, DEFAULT_NO_ISSUE_OUTPUT_MAX_CHARS))),
  );
  const maxTurnsPerRun = Math.max(1, Math.trunc(readNumber(config.noIssueMaxTurnsPerRun, DEFAULT_NO_ISSUE_MAX_TURNS)));
  return {
    mode: "bounded_status",
    enabled: true,
    reason: "no_issue_comment_approval_or_prompt_handoff",
    priorRunValueQuestion,
    contextMaxChars,
    outputMaxSentences,
    outputMaxChars,
    maxTurnsPerRun,
    allowSessionResume: false,
    dropSessionHandoff: true,
    instructions: [
      "Request shaping: no explicit issue, comment, approval, or human prompt was provided.",
      `Before using prior session context, answer internally: ${priorRunValueQuestion}`,
      "Default answer for this run: no. Use only compact current Paperclip evidence unless a specific prior-run receipt in the bounded context directly changes the decision.",
      "Do not replay previous sessions, dump repository context, run broad implementation, or browse raw files for speculative work.",
      "Complete a bounded status/readiness decision: inspect Paperclip source-of-truth state, identify assigned actionable work or blockers, and either update/create a precise issue with acceptance criteria or return a safe-skip/status receipt.",
      "Do not mutate code unless Paperclip exposes an explicit issue handoff inside this run.",
    ].join("\n"),
  };
}

function currentWorkIdentity(context: Record<string, unknown>): Record<string, string> {
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const approval = parseObject(context.paperclipApproval ?? context.approval);
  const contextLedger = parseObject(context.paperclipContextLedger);
  const issueId =
    readString(context.issueId) ??
    readString(context.taskId) ??
    readString(wakeIssue.id);
  const taskKey =
    readString(context.taskKey) ??
    readString(wakeIssue.identifier);
  const approvalId =
    readString(context.approvalId) ??
    readString(approval.id);
  const commentId =
    readString(context.wakeCommentId) ??
    readString(context.commentId) ??
    readString(wake.latestCommentId);
  const contextFingerprint =
    readString(context.contextFingerprint) ??
    readString(context.promptFingerprint) ??
    readString(contextLedger.promptFingerprint);
  const workKey = issueId
    ? `issue:${issueId}`
    : taskKey
      ? `task:${taskKey}`
      : approvalId
        ? `approval:${approvalId}`
        : commentId
          ? `comment:${commentId}`
          : undefined;
  return Object.fromEntries(
    Object.entries({ workKey, issueId, taskKey, approvalId, commentId, contextFingerprint })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

function savedWorkIdentity(sessionParams: Record<string, unknown>): Record<string, string> {
  const issueId = readString(sessionParams.issueId) ?? readString(sessionParams.taskId);
  const taskKey = readString(sessionParams.taskKey);
  const approvalId = readString(sessionParams.approvalId);
  const commentId = readString(sessionParams.commentId);
  const contextFingerprint = readString(sessionParams.contextFingerprint);
  const workKey = readString(sessionParams.workKey) ??
    (issueId
      ? `issue:${issueId}`
      : taskKey
        ? `task:${taskKey}`
        : approvalId
          ? `approval:${approvalId}`
          : commentId
            ? `comment:${commentId}`
            : undefined);
  return Object.fromEntries(
    Object.entries({ workKey, issueId, taskKey, approvalId, commentId, contextFingerprint })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

function contextRequiresFreshSession(context: Record<string, unknown>): string | null {
  const wakeReason = readString(context.wakeReason);
  const retryReason = readString(context.retryReason);
  if (wakeReason === "process_lost_retry" || retryReason === "process_lost") {
    return "process_lost_retry_fresh_session";
  }
  return null;
}

function resolveSessionContinuity(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeSessionId: string | null;
  sessionParams: Record<string, unknown>;
  cwd: string;
  requestShaping: ReturnType<typeof resolveRequestShaping>;
}): {
  sessionId: string | null;
  suppressed: boolean;
  reason: string;
  workIdentity: Record<string, string>;
  savedWorkIdentity?: Record<string, string>;
  runtimeSessionCwd?: string;
} {
  const workIdentity = currentWorkIdentity(input.context);
  if (!input.runtimeSessionId) return { sessionId: null, suppressed: false, reason: "no_runtime_session", workIdentity };
  const runtimeSessionCwd = readString(input.sessionParams.cwd);
  if (runtimeSessionCwd && path.resolve(runtimeSessionCwd) !== path.resolve(input.cwd)) {
    return { sessionId: null, suppressed: true, reason: "cwd_mismatch", workIdentity, runtimeSessionCwd };
  }
  if (!input.requestShaping.allowSessionResume) {
    return { sessionId: null, suppressed: true, reason: `request_shaping_${input.requestShaping.mode}`, workIdentity };
  }
  const saved = savedWorkIdentity(input.sessionParams);
  const freshSessionReason = contextRequiresFreshSession(input.context);
  if (freshSessionReason) {
    return { sessionId: null, suppressed: true, reason: freshSessionReason, workIdentity, savedWorkIdentity: saved };
  }
  if (!workIdentity.workKey) {
    return { sessionId: null, suppressed: true, reason: "missing_current_work_key", workIdentity, savedWorkIdentity: saved };
  }
  if (!saved.workKey) {
    const allowLegacy = readBoolean(parseObject(input.config.requestShaping).allowLegacySessionResumeWithoutWorkKey, false);
    return allowLegacy
      ? { sessionId: input.runtimeSessionId, suppressed: false, reason: "legacy_session_resume_allowed", workIdentity, savedWorkIdentity: saved }
      : { sessionId: null, suppressed: true, reason: "missing_saved_work_key", workIdentity, savedWorkIdentity: saved };
  }
  if (saved.workKey !== workIdentity.workKey) {
    return { sessionId: null, suppressed: true, reason: "work_key_mismatch", workIdentity, savedWorkIdentity: saved };
  }
  if (workIdentity.commentId && saved.commentId !== workIdentity.commentId) {
    return {
      sessionId: null,
      suppressed: true,
      reason: saved.commentId ? "comment_signal_mismatch" : "new_comment_signal",
      workIdentity,
      savedWorkIdentity: saved,
    };
  }
  if (workIdentity.contextFingerprint && !saved.contextFingerprint) {
    return {
      sessionId: null,
      suppressed: true,
      reason: "missing_saved_context_fingerprint",
      workIdentity,
      savedWorkIdentity: saved,
    };
  }
  if (workIdentity.contextFingerprint && saved.contextFingerprint !== workIdentity.contextFingerprint) {
    return {
      sessionId: null,
      suppressed: true,
      reason: "context_fingerprint_changed",
      workIdentity,
      savedWorkIdentity: saved,
    };
  }
  return { sessionId: input.runtimeSessionId, suppressed: false, reason: "work_key_match", workIdentity, savedWorkIdentity: saved };
}

function sessionParamsForResult(
  sessionId: string | null | undefined,
  cwd: string,
  source: string,
  workIdentity: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      sessionId: readString(sessionId),
      cwd,
      source,
      workKey: readString(workIdentity.workKey),
      issueId: readString(workIdentity.issueId),
      taskKey: readString(workIdentity.taskKey),
      approvalId: readString(workIdentity.approvalId),
      commentId: readString(workIdentity.commentId),
      contextFingerprint: readString(workIdentity.contextFingerprint),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

async function readOptionalText(filePath: unknown): Promise<string> {
  const value = readString(filePath);
  if (!value) return "";
  try {
    return await fsp.readFile(value, "utf-8");
  } catch (error) {
    return `[paperclip] Warning: could not read instructions file ${value}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function parseEnv(config: Record<string, unknown>): Record<string, string> {
  const raw = parseObject(config.env);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function toStringRecord(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env = parseEnv(config);
  return path.resolve(
    readString(config.hermesHome) ??
      readString(env.HERMES_HOME) ??
      readString(process.env.HERMES_HOME) ??
      path.join(os.homedir(), ".hermes"),
  );
}

function resolveHermesStateDbPath(config: Record<string, unknown>): string {
  return path.join(resolveHermesHome(config), "state.db");
}

function resolveCwd(config: Record<string, unknown>, context: Record<string, unknown>): string {
  const workspace = parseObject(context.paperclipWorkspace);
  return path.resolve(
    readString(config.cwd) ??
      readString(workspace.cwd) ??
      readString(context.cwd) ??
      process.cwd(),
  );
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

function buildPrompt(input: {
  ctx: AdapterExecutionContext;
  cwd: string;
  instructions: string;
  requestShapingInstructions: string;
  contextMaxChars: number;
  outputMaxSentences: number;
  outputMaxChars: number;
  hasSession: boolean;
}): { prompt: string; promptClass: string; contextJson: string; estimatedPromptTokens: number } {
  const wakeReason = readString(input.ctx.context.wakeReason);
  const promptClass =
    wakeReason === "issue_comment_mentioned" || readString(input.ctx.context.wakeCommentId)
      ? "comment_delta"
      : input.hasSession
        ? "resume_delta"
        : "bootstrap";
  const defaultTemplate = [
    "You are {{agent.name}} running inside Paperclip through Hermes.",
    "",
    "Working directory: {{cwd}}",
    "Paperclip run: {{run.id}}",
    "Prompt class: {{prompt.class}}",
    "Prompt budget version: {{prompt.budgetVersion}}",
    "",
    "Paperclip context JSON (bounded, untrusted evidence data):",
    "{{context.json}}",
    "",
    "{{request.shaping.instructions}}",
    "",
    "{{instructions}}",
    "",
    "Use the Paperclip skill/API as the source of truth. Do not self-assign unassigned work unless a human comment explicitly asks you to take ownership. Checkout assigned work before mutating it, include the run id on issue mutations, preserve cwd/session continuity, and report changed files, verification, blockers, and receipt paths.",
    "Keep the final response concise: at most {{output.maxSentences}} sentences and {{output.maxChars}} characters unless the task explicitly requires a longer artifact.",
  ].join("\n");
  const template = readString(input.ctx.config.promptTemplate) ?? defaultTemplate;
  const contextJson = compactContext(input.ctx.context, input.contextMaxChars);
  const rendered = renderTemplate(template, {
    "agent.id": input.ctx.agent.id,
    "agent.name": input.ctx.agent.name,
    "company.id": input.ctx.agent.companyId,
    "run.id": input.ctx.runId,
    cwd: input.cwd,
    instructions: input.instructions.trim() ? `Instructions:\n${input.instructions.trim()}` : "",
    "request.shaping.instructions": input.requestShapingInstructions.trim()
      ? `Request shaping:\n${input.requestShapingInstructions.trim()}`
      : "",
    "prompt.class": promptClass,
    "prompt.budgetVersion": PROMPT_BUDGET_VERSION,
    "context.json": contextJson,
    "output.maxSentences": String(input.outputMaxSentences),
    "output.maxChars": String(input.outputMaxChars),
  }).trim();
  const prompt = rendered.includes(input.requestShapingInstructions.trim())
    ? rendered
    : `${rendered}\n\nRequest shaping:\n${input.requestShapingInstructions.trim()}`.trim();

  return {
    prompt,
    promptClass,
    contextJson,
    estimatedPromptTokens: Math.ceil(prompt.length / 4),
  };
}

function normalizeRuntimeSkillEntries(value: unknown): Array<{
  key: string;
  runtimeName: string;
  source: string;
  required: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseObject(entry))
    .map((entry) => ({
      key: readString(entry.key) ?? readString(entry.name) ?? "",
      runtimeName: readString(entry.runtimeName) ?? readString(entry.name) ?? "",
      source: readString(entry.source) ?? "",
      required: readBoolean(entry.required, false),
    }))
    .filter((entry) => entry.key && entry.runtimeName && entry.source);
}

function desiredSkillKeys(config: Record<string, unknown>, available: Array<{ key: string; required: boolean }>): string[] {
  const sync = parseObject(config.paperclipSkillSync);
  return unique([
    ...available.filter((entry) => entry.required).map((entry) => entry.key),
    ...splitList(sync.desiredSkills),
    ...splitList(config.skills),
  ]);
}

function skillIdentifiersForHermes(
  keys: string[],
  available: Array<{ key: string; runtimeName: string }>,
): string[] {
  const byKey = new Map(available.map((entry) => [entry.key, entry.runtimeName]));
  return unique(keys.map((key) => {
    const runtimeName = byKey.get(key);
    return runtimeName ? `paperclip/${runtimeName}` : key;
  }));
}

async function ensureManagedSkillLinks(config: Record<string, unknown>, selectedIdentifiers?: string[]): Promise<string[]> {
  const available = normalizeRuntimeSkillEntries(config.paperclipRuntimeSkills);
  const selectedRuntimeNames = selectedIdentifiers
    ? new Set(selectedIdentifiers.map((identifier) => identifier.split("/").filter(Boolean).pop() ?? identifier))
    : null;
  const desired = new Set(desiredSkillKeys(config, available));
  const skillsHome = path.join(resolveHermesHome(config), "skills");
  const identifiers: string[] = [];

  for (const entry of available) {
    if (selectedRuntimeNames) {
      if (!selectedRuntimeNames.has(entry.runtimeName)) continue;
    } else if (!desired.has(entry.key)) {
      continue;
    }
    const target = path.join(skillsHome, "paperclip", entry.runtimeName);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const stat = await fsp.lstat(target).catch(() => null);
    if (stat) {
      const linkedPath = stat.isSymbolicLink()
        ? path.resolve(path.dirname(target), await fsp.readlink(target))
        : target;
      if (!stat.isSymbolicLink() || linkedPath !== entry.source) {
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.symlink(entry.source, target, "dir");
      }
    } else {
      await fsp.symlink(entry.source, target, "dir");
    }
    identifiers.push(`paperclip/${entry.runtimeName}`);
  }

  return unique(identifiers);
}

function normalizeRoutingConfig(config: Record<string, unknown>): Record<string, unknown> {
  const policy = parseObject(config.tieredExecution ?? config.executionRouting);
  const hermesLane = parseObject(policy.hermes_minimax ?? policy.hermesLocal ?? policy.hermes_local);
  return {
    ...config,
    ...(Object.keys(hermesLane).length > 0 ? hermesLane : {}),
    tieredExecution: config.tieredExecution,
    executionRouting: config.executionRouting,
  };
}

type HermesCliCapabilities = {
  source: "detected" | "configured" | "fallback";
  command: string;
  helpExitCode: number | null;
  supportedFlags: string[];
  skippedFlags: string[];
  error: string | null;
};

const HERMES_FLAGS_TO_DETECT = [
  "--source",
  "--provider",
  "--max-turns",
  "--disable-fallback-model",
  "--resume",
  "--session-id",
  "--worktree",
  "--checkpoints",
  "--yolo",
  "--pass-session-id",
] as const;

const HERMES_DEFAULT_SUPPORTED_FLAGS = new Set<string>([
  "--source",
  "--provider",
  "--disable-fallback-model",
  "--resume",
  "--worktree",
  "--checkpoints",
  "--yolo",
  "--pass-session-id",
]);

const hermesCliCapabilityCache = new Map<string, HermesCliCapabilities>();

function stringSet(value: unknown): Set<string> {
  return new Set(splitList(value));
}

function resolveHermesCliCapabilities(
  command: string,
  cwd: string,
  env: Record<string, string>,
  config: Record<string, unknown>,
): HermesCliCapabilities {
  const override = parseObject(config.hermesCliCapabilities ?? config.cliCapabilities);
  const configuredSupported = stringSet(override.supportedFlags);
  const configuredUnsupported = stringSet(override.unsupportedFlags);
  if (configuredSupported.size > 0 || configuredUnsupported.size > 0) {
    const supportedFlags = HERMES_FLAGS_TO_DETECT.filter((flag) =>
      configuredSupported.has(flag) || (!configuredUnsupported.has(flag) && HERMES_DEFAULT_SUPPORTED_FLAGS.has(flag)),
    );
    return {
      source: "configured",
      command,
      helpExitCode: null,
      supportedFlags,
      skippedFlags: [],
      error: null,
    };
  }

  const cacheKey = `${command}\0${cwd}\0${env.PATH ?? ""}`;
  const cached = hermesCliCapabilityCache.get(cacheKey);
  if (cached) return { ...cached, skippedFlags: [] };

  const result = spawnSync(command, ["chat", "--help"], {
    cwd,
    env,
    encoding: "utf-8",
    timeout: 5_000,
  });
  const helpText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const error = result.error instanceof Error ? result.error.message : null;
  const canTrustHelp = result.status === 0 && helpText.includes("hermes chat");
  const supportedFlags = HERMES_FLAGS_TO_DETECT.filter((flag) =>
    canTrustHelp ? helpText.includes(flag) : HERMES_DEFAULT_SUPPORTED_FLAGS.has(flag),
  );
  const detected: HermesCliCapabilities = {
    source: canTrustHelp ? "detected" : "fallback",
    command,
    helpExitCode: result.status,
    supportedFlags,
    skippedFlags: [],
    error,
  };
  hermesCliCapabilityCache.set(cacheKey, detected);
  return { ...detected, skippedFlags: [] };
}

function supportsHermesFlag(capabilities: HermesCliCapabilities, flag: string) {
  return capabilities.supportedFlags.includes(flag);
}

function maybePushHermesFlag(
  args: string[],
  capabilities: HermesCliCapabilities,
  flag: string,
  ...values: string[]
) {
  if (!supportsHermesFlag(capabilities, flag)) {
    capabilities.skippedFlags.push(flag);
    return false;
  }
  args.push(flag, ...values);
  return true;
}

function buildHermesArgs(
  config: Record<string, unknown>,
  prompt: string,
  sessionId: string | null,
  newSessionId: string | null,
  capabilities: HermesCliCapabilities,
): string[] {
  const normalized = normalizeRoutingConfig(config);
  const source = readString(normalized.source) ?? DEFAULT_SOURCE;
  const args = ["chat", "-Q", "-q", prompt];
  maybePushHermesFlag(args, capabilities, "--source", source);
  const model = readString(normalized.model);
  if (model && model !== "auto") args.push("-m", model);
  const provider = readString(normalized.provider);
  if (provider && provider !== "auto") maybePushHermesFlag(args, capabilities, "--provider", provider);
  const maxTurns = Math.trunc(readNumber(normalized.maxTurnsPerRun ?? normalized.maxTurns, 0));
  if (maxTurns > 0) maybePushHermesFlag(args, capabilities, "--max-turns", String(maxTurns));
  if (readBoolean(normalized.disableFallbackModel, true)) maybePushHermesFlag(args, capabilities, "--disable-fallback-model");
  const toolsets = splitList(normalized.toolsets).join(",");
  if (toolsets) args.push("-t", toolsets);
  for (const skill of splitList(normalized.skills)) args.push("-s", skill);
  if (sessionId) maybePushHermesFlag(args, capabilities, "--resume", sessionId);
  else if (newSessionId) maybePushHermesFlag(args, capabilities, "--session-id", newSessionId);
  if (readBoolean(normalized.worktree ?? normalized.worktreeMode, false)) maybePushHermesFlag(args, capabilities, "--worktree");
  if (readBoolean(normalized.checkpoints, false)) maybePushHermesFlag(args, capabilities, "--checkpoints");
  if (readBoolean(normalized.yolo ?? normalized.dangerouslyBypassApprovalsAndSandbox, false)) maybePushHermesFlag(args, capabilities, "--yolo");
  if (readBoolean(normalized.passSessionId, true)) maybePushHermesFlag(args, capabilities, "--pass-session-id");
  for (const extra of splitList(normalized.extraArgs)) args.push(extra);
  capabilities.skippedFlags = unique(capabilities.skippedFlags);
  return args;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(readNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function resolveHermesToolOutputBudget(config: Record<string, unknown>): {
  enabled: boolean;
  env: Record<string, string>;
  metrics: Record<string, unknown>;
} {
  const normalized = normalizeRoutingConfig(config);
  const budget = parseObject(
    normalized.hermesToolOutput ??
    normalized.paperclipToolOutput ??
    normalized.toolOutputBudget,
  );
  const enabled = readBoolean(
    budget.enabled ?? normalized.hermesToolOutputBudgetEnabled,
    true,
  );
  if (!enabled) return { enabled: false, env: {}, metrics: { enabled: false } };

  const maxBytes = positiveInt(
    budget.maxBytes ?? normalized.hermesToolOutputMaxBytes,
    DEFAULT_HERMES_TOOL_OUTPUT_MAX_BYTES,
  );
  const maxLines = positiveInt(
    budget.maxLines ?? normalized.hermesToolOutputMaxLines,
    DEFAULT_HERMES_TOOL_OUTPUT_MAX_LINES,
  );
  const maxLineLength = positiveInt(
    budget.maxLineLength ?? normalized.hermesToolOutputMaxLineLength,
    DEFAULT_HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH,
  );
  return {
    enabled: true,
    env: {
      HERMES_TOOL_OUTPUT_MAX_BYTES: String(maxBytes),
      HERMES_TOOL_OUTPUT_MAX_LINES: String(maxLines),
      HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH: String(maxLineLength),
    },
    metrics: {
      enabled: true,
      maxBytes,
      maxLines,
      maxLineLength,
    },
  };
}

function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index]);
    if (args[index] === "-q" || args[index] === "--query") {
      index += 1;
      redacted.push("[prompt omitted]");
    }
  }
  return redacted;
}

function parseSessionId(stdout: string): string | null {
  return readString(stdout.match(/\bsession[_ -]?id:\s*([A-Za-z0-9_.:-]+)/i)?.[1]);
}

function paperclipSessionId(runId: string): string {
  const safeRunId = String(runId || "run").replace(/[^A-Za-z0-9_.:-]+/g, "_");
  return `paperclip_${safeRunId}`;
}

function isHermesToolCallEnvelope(value: unknown): boolean {
  const text = readString(value)?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return Boolean(text && /^<[^>]*tool_calls>[^]*<\/[^>]*tool_calls>\s*$/i.test(text));
}

function latestHermesSessionId(source: string, sinceSeconds: number, config: Record<string, unknown>): string | null {
  const dbPath = resolveHermesStateDbPath(config);
  if (!fs.existsSync(dbPath)) return null;
  const query = [
    "SELECT id FROM sessions",
    `WHERE source = '${escapeSql(source)}' AND started_at >= ${Number(sinceSeconds).toFixed(3)}`,
    "ORDER BY started_at DESC LIMIT 1;",
  ].join(" ");
  const result = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5_000 });
  return result.status === 0 ? readString(result.stdout) : null;
}

function readHermesFinalAssistantMessage(sessionId: string | null, config: Record<string, unknown>): string | null {
  const id = readString(sessionId);
  if (!id) return null;
  const dbPath = resolveHermesStateDbPath(config);
  if (!fs.existsSync(dbPath)) return null;
  const query = [
    "SELECT content FROM messages",
    `WHERE session_id = '${escapeSql(id)}'`,
    "AND role = 'assistant'",
    "AND active = 1",
    "AND length(trim(COALESCE(content, ''))) > 0",
    "ORDER BY timestamp DESC, id DESC LIMIT 1;",
  ].join(" ");
  const result = spawnSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    const rows = JSON.parse(result.stdout || "[]") as Array<{ content?: unknown }>;
    const finalResponse = Array.isArray(rows) ? readString(rows[0]?.content) : null;
    return finalResponse && !isHermesToolCallEnvelope(finalResponse) ? finalResponse : null;
  } catch {
    return null;
  }
}

function readHermesSessionUsage(sessionId: string | null, config: Record<string, unknown>) {
  const id = readString(sessionId);
  if (!id) return null;
  const dbPath = resolveHermesStateDbPath(config);
  if (!fs.existsSync(dbPath)) return null;
  const fields = [
    "COALESCE(input_tokens, 0)",
    "COALESCE(output_tokens, 0)",
    "COALESCE(cache_read_tokens, 0)",
    "COALESCE(cache_write_tokens, 0)",
    "COALESCE(reasoning_tokens, 0)",
    "COALESCE(estimated_cost_usd, '')",
    "COALESCE(actual_cost_usd, '')",
    "COALESCE(cost_status, '')",
    "COALESCE(cost_source, '')",
    "COALESCE(billing_provider, '')",
    "COALESCE(billing_base_url, '')",
    "COALESCE(billing_mode, '')",
    "COALESCE(model, '')",
  ];
  const query = [
    "SELECT",
    fields.join(" || char(9) || "),
    "FROM sessions",
    `WHERE id = '${escapeSql(id)}'`,
    "LIMIT 1;",
  ].join(" ");
  const result = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5_000 });
  if (result.status !== 0) return null;
  const row = result.stdout.trim();
  if (!row) return null;
  const [
    inputTokensRaw,
    outputTokensRaw,
    cacheReadTokensRaw,
    cacheWriteTokensRaw,
    reasoningTokensRaw,
    estimatedCostUsdRaw,
    actualCostUsdRaw,
    costStatus,
    costSource,
    billingProvider,
    billingBaseUrl,
    billingMode,
    model,
  ] = row.split("\t");
  const usage = {
    inputTokens: Math.max(0, Math.floor(readNumber(inputTokensRaw, 0))),
    outputTokens: Math.max(0, Math.floor(readNumber(outputTokensRaw, 0))),
    cachedInputTokens: Math.max(0, Math.floor(readNumber(cacheReadTokensRaw, 0))),
    cacheWriteTokens: Math.max(0, Math.floor(readNumber(cacheWriteTokensRaw, 0))),
    reasoningTokens: Math.max(0, Math.floor(readNumber(reasoningTokensRaw, 0))),
    source: "hermes_state_db",
    sessionId: id,
  };
  const estimated = readString(estimatedCostUsdRaw) ? Number(estimatedCostUsdRaw) : null;
  const actual = readString(actualCostUsdRaw) ? Number(actualCostUsdRaw) : null;
  return {
    usage,
    costUsd: Number.isFinite(actual) ? actual : Number.isFinite(estimated) ? estimated : null,
    costStatus: readString(costStatus),
    costSource: readString(costSource),
    billingProvider: readString(billingProvider),
    billingBaseUrl: readString(billingBaseUrl),
    billingMode: readString(billingMode),
    model: readString(model),
  };
}

function billingTypeFromUsage(
  sessionUsage: ReturnType<typeof readHermesSessionUsage>,
  provider: string | null,
): AdapterBillingType {
  const mode = sessionUsage?.billingMode;
  if (mode === "subscription_included") return "subscription";
  if (
    mode === "api" ||
    mode === "subscription" ||
    mode === "metered_api" ||
    mode === "subscription_overage" ||
    mode === "credits" ||
    mode === "fixed" ||
    mode === "unknown"
  ) {
    return mode;
  }
  if (["openrouter", "openai", "anthropic", "google"].includes(sessionUsage?.billingProvider ?? provider ?? "")) {
    return "metered_api";
  }
  return "unknown";
}

function usageConfidence(provider: string | null) {
  return provider === "opencode-go" || provider === "opencode-zen" ? "pending" : "actual";
}

function costConfidence(sessionUsage: ReturnType<typeof readHermesSessionUsage>, provider: string | null) {
  if (sessionUsage?.costUsd == null) return "unavailable";
  if (provider === "opencode-go" || provider === "opencode-zen") return "pending";
  return sessionUsage.costStatus === "estimated" ? "estimated" : "actual";
}

function diagnosticLines(text: string | null | undefined) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^session[_ -]?id:\s*[A-Za-z0-9_.:-]+$/i.test(line));
}

function inferProviderErrorCode(text: string | null | undefined) {
  if (!text) return null;
  if (/(insufficient balance|creditserror|credits error|out of credits|manage your billing|billing failure)/i.test(text)) {
    return "provider_billing_failure";
  }
  if (/(authenticationerror|authentication error|failed to authenticate|unauthorized|http\s*401|\b401\b|api key was rejected|invalid api key|invalid key|invalid authentication credentials|invalid credentials|auth(?:entication)? required|login is required|login required|requires login)/i.test(text)) {
    return "provider_auth_failure";
  }
  if (/(does your account have access|model access|model unavailable|configured model is unavailable|model not found|unsupported model|model is not supported|disabled model|http\s*403|\b403\b|forbidden)/i.test(text)) {
    return "provider_model_access_failure";
  }
  if (/(freeusagelimiterror|gousagelimiterror|token plan rate limit reached|usage limit reached|usage limit error|weekly usage limit|monthly usage limit|daily usage limit|5[-\s]?hour usage limit|monthly quota|quota exceeded|quota exhausted|quota exhaustion|over quota|insufficient_quota)/i.test(text)) {
    return "provider_quota_failure";
  }
  if (/(rate limit|rate-limit|too many requests|http\s*429|\b429\b)/i.test(text)) {
    return "provider_rate_limit_failure";
  }
  return null;
}

function failedHermesError(
  result: { stdout: string; stderr: string; timedOut: boolean },
  exitCode: number | null,
  timeoutSec: number,
) {
  if (result.timedOut) {
    return {
      message: `Hermes timed out after ${timeoutSec} seconds.`,
      code: "timeout",
    };
  }
  if (!exitCode || exitCode === 0) return { message: null, code: null };

  const stderrDiagnostic = diagnosticLines(result.stderr).join("\n");
  const stdoutDiagnostic = diagnosticLines(result.stdout).join("\n");
  const message = stderrDiagnostic || stdoutDiagnostic || `Hermes exited with code ${exitCode}.`;
  return {
    message,
    code: inferProviderErrorCode(message),
  };
}

function isHermesProtocolLine(line: string): boolean {
  return /^session[_ -]?id:\s*\S+\s*$/i.test(String(line || "").trim());
}

function stripAnsi(value: string): string {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isHermesProgressLine(line: string): boolean {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return true;
  if (isHermesProtocolLine(trimmed)) return true;
  if (/^\u250a\s+/.test(trimmed)) return true;
  if (/^diff --git\s+/i.test(trimmed)) return true;
  if (/^index\s+[0-9a-f]{6,}/i.test(trimmed)) return true;
  if (/^(?:---|\+\+\+)\s+/.test(trimmed)) return true;
  if (/^@@(?:\s|$)/.test(trimmed)) return true;
  if (/^[+](?!\+\+)/.test(trimmed)) return true;
  if (/^a\/.*\s+(?:->|\u2192)\s+b\//.test(trimmed)) return true;
  return false;
}

function meaningfulProcessOutput(stdout: string, stderr: string): string {
  return `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .filter((line) => !isHermesProgressLine(line))
    .join("\n")
    .trim();
}

function summarize(stdout: string, stderr: string, timedOut: boolean): string | null {
  if (timedOut) return "Hermes timed out before completing the run.";
  const source = meaningfulProcessOutput(stdout, stderr);
  if (!source) return null;
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12).join("\n").slice(-1600);
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    const record = parseObject(raw);
    const sessionId = readString(record.sessionId) ?? readString(record.session_id);
    if (!sessionId) return null;
    return {
      sessionId,
      ...(readString(record.cwd) ? { cwd: readString(record.cwd) } : {}),
      ...(readString(record.source) ? { source: readString(record.source) } : {}),
      ...(readString(record.workKey) ? { workKey: readString(record.workKey) } : {}),
      ...(readString(record.issueId) ? { issueId: readString(record.issueId) } : {}),
      ...(readString(record.taskKey) ? { taskKey: readString(record.taskKey) } : {}),
      ...(readString(record.approvalId) ? { approvalId: readString(record.approvalId) } : {}),
      ...(readString(record.commentId) ? { commentId: readString(record.commentId) } : {}),
      ...(readString(record.contextFingerprint) ? { contextFingerprint: readString(record.contextFingerprint) } : {}),
    };
  },
  serialize(params) {
    const record = parseObject(params);
    const sessionId = readString(record.sessionId) ?? readString(record.session_id);
    if (!sessionId) return null;
    return {
      sessionId,
      ...(readString(record.cwd) ? { cwd: readString(record.cwd) } : {}),
      ...(readString(record.source) ? { source: readString(record.source) } : {}),
      ...(readString(record.workKey) ? { workKey: readString(record.workKey) } : {}),
      ...(readString(record.issueId) ? { issueId: readString(record.issueId) } : {}),
      ...(readString(record.taskKey) ? { taskKey: readString(record.taskKey) } : {}),
      ...(readString(record.approvalId) ? { approvalId: readString(record.approvalId) } : {}),
      ...(readString(record.commentId) ? { commentId: readString(record.commentId) } : {}),
      ...(readString(record.contextFingerprint) ? { contextFingerprint: readString(record.contextFingerprint) } : {}),
    };
  },
  getDisplayId(params) {
    return readString(parseObject(params).sessionId) ?? readString(parseObject(params).session_id);
  },
};

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const routingConfig = normalizeRoutingConfig(config);
  const command = readString(routingConfig.command) ?? readString(routingConfig.hermesCommand) ?? DEFAULT_COMMAND;
  const cwd = resolveCwd(config, ctx.context);
  const source = readString(routingConfig.source) ?? DEFAULT_SOURCE;
  const timeoutSec = readNumber(routingConfig.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = readNumber(routingConfig.graceSec, DEFAULT_GRACE_SEC);
  const baseOutputMaxSentences = Math.max(0, readNumber(routingConfig.outputMaxSentences, DEFAULT_OUTPUT_MAX_SENTENCES));
  const baseOutputMaxChars = Math.max(0, readNumber(routingConfig.outputMaxChars, DEFAULT_OUTPUT_MAX_CHARS));
  const baseContextMaxChars = Math.max(1000, readNumber(routingConfig.contextMaxChars, DEFAULT_CONTEXT_MAX_CHARS));
  const baseMaxTurnsPerRun = Math.max(
    0,
    Math.trunc(readNumber(routingConfig.maxTurnsPerRun ?? routingConfig.maxTurns, 0)),
  );
  const requestShaping = resolveRequestShaping({
    config: routingConfig,
    context: ctx.context,
    baseContextMaxChars,
    baseOutputMaxSentences,
    baseOutputMaxChars,
    baseMaxTurnsPerRun: baseMaxTurnsPerRun || null,
  });
  const outputMaxSentences = requestShaping.outputMaxSentences;
  const outputMaxChars = requestShaping.outputMaxChars;
  const contextMaxChars = requestShaping.contextMaxChars;
  const rawSessionId =
    readString(ctx.runtime.sessionId) ??
    readString(ctx.runtime.sessionParams?.sessionId) ??
    null;
  const runtimeSessionParams = parseObject(ctx.runtime.sessionParams);
  const sessionContinuity = resolveSessionContinuity({
    config: routingConfig,
    context: ctx.context,
    runtimeSessionId: rawSessionId,
    sessionParams: runtimeSessionParams,
    cwd,
    requestShaping,
  });
  const sessionId = sessionContinuity.sessionId;
  const newSessionId = sessionId ? null : paperclipSessionId(ctx.runId);
  if (rawSessionId && !sessionId) {
    await ctx.onLog(
      "stdout",
      `[paperclip] Hermes session "${rawSessionId}" will not be resumed: ${sessionContinuity.reason}.\n`,
    );
  }
  const instructions = await readOptionalText(routingConfig.instructionsFilePath);
  const promptEnvelope = buildPrompt({
    ctx,
    cwd,
    instructions,
    requestShapingInstructions: requestShaping.instructions,
    contextMaxChars,
    outputMaxSentences,
    outputMaxChars,
    hasSession: Boolean(sessionId),
  });
  const availableSkillEntries = normalizeRuntimeSkillEntries(routingConfig.paperclipRuntimeSkills);
  const candidateSkillKeys = resolvePaperclipRuntimeSkillCandidateNames(routingConfig, availableSkillEntries);
  const rawSkillIdentifiers = unique([
    ...splitList(routingConfig.skills),
    ...skillIdentifiersForHermes(candidateSkillKeys, availableSkillEntries),
  ]);
  const skillSelection = selectPaperclipRuntimeSkillsForRun({
    config: routingConfig,
    identifiers: rawSkillIdentifiers,
    agentRole: ctx.agent.role,
    agentName: ctx.agent.name,
    runtime: ctx.runtime,
    context: ctx.context,
  });
  await ensureManagedSkillLinks(routingConfig, skillSelection.selected).catch(async (error) => {
    await ctx.onLog("stderr", `[paperclip] Failed to prepare Hermes skills: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
  });
  const toolOutputBudget = resolveHermesToolOutputBudget(routingConfig);
  const envConfig = parseEnv(routingConfig);
  const env = toStringRecord(ensurePathInEnv({
    ...process.env,
    ...buildPaperclipEnv(ctx.agent),
    ...toolOutputBudget.env,
    ...envConfig,
    PAPERCLIP_ADAPTER_TYPE: ADAPTER_TYPE,
    PAPERCLIP_RUN_ID: ctx.runId,
    HERMES_SESSION_SOURCE: source,
    HERMES_OUTPUT_MAX_SENTENCES: String(outputMaxSentences),
    HERMES_OUTPUT_MAX_CHARS: String(outputMaxChars),
    ...(readBoolean(routingConfig.disableFallbackModel, true) ? { HERMES_DISABLE_FALLBACK_MODEL: "1" } : {}),
    ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
  }));
  const hermesCliCapabilities = resolveHermesCliCapabilities(command, cwd, env, routingConfig);
  const args = buildHermesArgs(
    {
      ...routingConfig,
      source,
      ...(requestShaping.maxTurnsPerRun ? { maxTurnsPerRun: requestShaping.maxTurnsPerRun } : {}),
      skills: skillSelection.selected,
    },
    promptEnvelope.prompt,
    sessionId,
    newSessionId,
    hermesCliCapabilities,
  );
  const resolvedCommand = await resolveCommandForLogs(command, cwd, env);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv: env,
    includeRuntimeKeys: ["HOME", "HERMES_HOME"],
    resolvedCommand,
  });
  const meta: AdapterInvocationMeta = {
    adapterType: ADAPTER_TYPE,
    adapterVersion: ADAPTER_VERSION,
    command: resolvedCommand,
    cwd,
    commandArgs: redactArgs(args),
    env: loggedEnv,
    promptClass: promptEnvelope.promptClass,
    promptBudgetVersion: PROMPT_BUDGET_VERSION,
    promptMetrics: {
      promptClass: promptEnvelope.promptClass,
      promptBudgetVersion: PROMPT_BUDGET_VERSION,
      totalChars: promptEnvelope.prompt.length,
      estimatedPromptTokens: promptEnvelope.estimatedPromptTokens,
      contextChars: promptEnvelope.contextJson.length,
      contextMaxChars,
      requestShapingMode: requestShaping.mode,
      requestShapingReason: requestShaping.reason,
      requestShapingEnabled: requestShaping.enabled,
      requestShapingAllowSessionResume: requestShaping.allowSessionResume,
      requestShapingDroppedSessionHandoff: requestShaping.dropSessionHandoff,
      priorRunValueQuestion: requestShaping.priorRunValueQuestion,
      outputMaxSentences,
      outputMaxChars,
      sessionIdBefore: rawSessionId,
      requestedSessionId: sessionId ?? newSessionId,
      sessionResumeSuppressed: Boolean(rawSessionId && !sessionId),
      sessionResumeSuppressedReason: rawSessionId && !sessionId ? sessionContinuity.reason : null,
      sessionContinuityReason: sessionContinuity.reason,
      workIdentity: sessionContinuity.workIdentity,
      savedWorkIdentity: sessionContinuity.savedWorkIdentity ?? null,
      skillBudget: skillSelection.metrics,
      hermesToolOutputBudget: toolOutputBudget.metrics,
      hermesCliCapabilities,
      passSessionIdEffective: supportsHermesFlag(hermesCliCapabilities, "--pass-session-id") &&
        readBoolean(routingConfig.passSessionId, true),
      requestedSessionIdEffective: Boolean(
        sessionId
          ? supportsHermesFlag(hermesCliCapabilities, "--resume")
          : newSessionId && supportsHermesFlag(hermesCliCapabilities, "--session-id"),
      ),
    },
    model: readString(routingConfig.model),
    runtimeProvenance: {
      adapterVersion: ADAPTER_VERSION,
      hermesStateDb: resolveHermesStateDbPath(routingConfig),
      hermesCliCapabilities,
    },
    context: ctx.context,
  };
  await ctx.onMeta?.(meta);
  await ctx.onLog("stdout", `[paperclip] Request shaping: ${requestShaping.mode} (${requestShaping.reason})\n`);
  if (hermesCliCapabilities.skippedFlags.length > 0) {
    await ctx.onLog(
      "stdout",
      `[paperclip] Hermes CLI skipped unsupported flags for ${resolvedCommand}: ${hermesCliCapabilities.skippedFlags.join(", ")}\n`,
    );
  }
  await ctx.onLog("stdout", `[paperclip] Launching Hermes from ${cwd}\n`);

  const startedAtSeconds = Date.now() / 1000 - 3;
  const result = await runChildProcess(ctx.runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: ctx.onLog,
    onSpawn: ctx.onSpawn,
  });
  const stdoutSessionId = parseSessionId(result.stdout);
  const stderrSessionId = parseSessionId(result.stderr);
  const detectedSessionId = latestHermesSessionId(source, startedAtSeconds, routingConfig);
  const finalSessionId = stdoutSessionId ?? stderrSessionId ?? sessionId ?? newSessionId ?? detectedSessionId;
  const sessionUsage = readHermesSessionUsage(finalSessionId, routingConfig);
  const provider = readString(routingConfig.provider) ?? null;
  const confidence = usageConfidence(sessionUsage?.billingProvider ?? provider);
  const costState = costConfidence(sessionUsage, sessionUsage?.billingProvider ?? provider);
  const bookableCostUsd = costState === "actual" || costState === "estimated" ? sessionUsage?.costUsd ?? null : null;
  const hermesError = failedHermesError(result, result.exitCode, timeoutSec);
  const processSummary = summarize(result.stdout, result.stderr, result.timedOut);
  const stateFinalResponse = readHermesFinalAssistantMessage(finalSessionId, routingConfig);
  const finalSummary = result.timedOut ? processSummary : stateFinalResponse ?? processSummary ?? null;
  const finalResponseSource = !result.timedOut && stateFinalResponse
    ? "hermes_state_db"
    : processSummary
      ? "process_output"
      : null;
  if (!hermesError.message && !result.timedOut && (result.exitCode ?? 0) === 0 && !readString(finalSummary)) {
    hermesError.message = "Hermes exited successfully without a final assistant response.";
    hermesError.code = "missing_final_response";
  }

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage: hermesError.message,
    errorCode: hermesError.code,
    sessionId: finalSessionId,
    sessionParams: sessionParamsForResult(finalSessionId, cwd, source, sessionContinuity.workIdentity),
    sessionDisplayId: finalSessionId,
    provider,
    biller: sessionUsage?.billingProvider ?? provider,
    model: readString(routingConfig.model) ?? sessionUsage?.model ?? null,
    billingType: billingTypeFromUsage(sessionUsage, provider),
    usageConfidence: sessionUsage?.usage ? confidence : null,
    costConfidence: costState,
    usage: sessionUsage?.usage,
    costUsd: bookableCostUsd,
    summary: finalSummary,
    resultJson: {
      adapterType: ADAPTER_TYPE,
      adapterVersion: ADAPTER_VERSION,
      cwd,
      command: resolvedCommand,
      source,
      sessionId: finalSessionId,
      usage: sessionUsage?.usage
        ? {
            ...sessionUsage.usage,
            costStatus: sessionUsage.costStatus,
            costSource: sessionUsage.costSource,
            billingProvider: sessionUsage.billingProvider,
            billingBaseUrl: sessionUsage.billingBaseUrl,
            billingMode: sessionUsage.billingMode,
            usageConfidence: sessionUsage.usage ? confidence : null,
            costConfidence: costState,
            observedCostUsd: sessionUsage.costUsd,
            costUsd: bookableCostUsd,
          }
        : null,
      finalResponseSource,
      stdoutTail: result.stdout.trim().slice(-4000),
      stderrTail: result.stderr.trim().slice(-4000),
    },
  };
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const routingConfig = normalizeRoutingConfig(config);
  const command = readString(routingConfig.command) ?? readString(routingConfig.hermesCommand) ?? DEFAULT_COMMAND;
  const checks: AdapterEnvironmentTestResult["checks"] = [];

  const version = spawnSync(command, ["--version"], { encoding: "utf-8", timeout: 20_000 });
  if (version.status === 0) {
    checks.push({
      code: "version",
      level: "info",
      message: version.stdout.trim().split(/\r?\n/)[0] || "Hermes version command passed.",
      detail: version.stdout.trim().slice(0, 1000),
    });
  } else {
    checks.push({
      code: "version_failed",
      level: "error",
      message: `Hermes command failed: ${command}`,
      detail: (version.stderr || version.error?.message || version.stdout || "").trim().slice(0, 1000),
    });
  }

  const doctor = spawnSync(command, ["doctor"], { encoding: "utf-8", timeout: 90_000 });
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`.trim();
  checks.push({
    code: doctor.status === 0 ? "doctor" : "doctor_failed",
    level: doctor.status === 0 ? (/warning|issue\(s\)|⚠/i.test(doctorText) ? "warn" : "info") : "error",
    message: doctor.status === 0 ? "Hermes doctor completed." : "Hermes doctor failed.",
    detail: doctorText.slice(0, 3000),
  });

  const provider = readString(routingConfig.provider);
  const model = readString(routingConfig.model);
  if (provider || model) {
    checks.push({
      code: "routing_configured",
      level: "info",
      message: `Routing configured: provider=${provider ?? "auto"} model=${model ?? "auto"}`,
    });
  }
  if (readBoolean(routingConfig.disableFallbackModel, true)) {
    checks.push({
      code: "fallback_disabled",
      level: "info",
      message: "Hermes fallback model is disabled for Paperclip runs.",
    });
  }

  const hasErrors = checks.some((check) => check.level === "error");
  const hasWarnings = checks.some((check) => check.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}

function resolveHermesPaperclipSkillsHome(config: Record<string, unknown>) {
  return path.join(resolveHermesHome(config), "skills", "paperclip");
}

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveHermesPaperclipSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.hermes/skills/paperclip",
    missingDetail: "Configured but not currently linked into the Hermes skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function syncSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolveHermesPaperclipSkillsHome(ctx.config);
  await fsp.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(available.source, path.join(skillsHome, available.runtimeName));
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fsp.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildHermesSkillSnapshot(ctx.config);
}
