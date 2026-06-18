import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  processGroupId: number | null;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

function resolveProcessGroupId(child: ChildProcess) {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
export const PAPERCLIP_PROMPT_BUDGET_VERSION = "context-economy.v1";
export const PAPERCLIP_OUTPUT_BUDGET_VERSION = "output-economy.v1";
export const PAPERCLIP_DEFAULT_OUTPUT_BUDGET = {
  maxSentences: 7,
  maxChars: 1_200,
  warnOutputTokens: 450,
  maxOutputTokens: 700,
} as const;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export const CORE_PAPERCLIP_REQUIRED_SKILL_RUNTIME_NAME = "paperclip";
export const CORE_PAPERCLIP_REQUIRED_SKILL_REASON =
  "The core Paperclip coordination skill is always available for local adapters.";

export type PaperclipPromptClass =
  | "bootstrap"
  | "resume_delta"
  | "timer_delta"
  | "comment_delta"
  | "failure_recovery";

export type PaperclipResponseClass =
  | "compact_success"
  | "compact_failure"
  | "compact_status"
  | "review_findings"
  | "handoff"
  | "operator_requested_detail"
  | "expanded_allowed"
  | "verbose_unjustified";

export interface PaperclipPromptComponentInput {
  name: string;
  componentType?: string;
  content: string;
  evidenceSliceCount?: number;
  metadata?: Record<string, unknown>;
}

export interface PaperclipPromptMetricsInput {
  prompt: string;
  promptClass: PaperclipPromptClass;
  promptBudgetVersion?: string;
  outputBudgetVersion?: string;
  outputBudget?: typeof PAPERCLIP_DEFAULT_OUTPUT_BUDGET;
  totalChars?: number;
  baseMetrics?: Record<string, unknown>;
  components?: PaperclipPromptComponentInput[];
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function resolvePaperclipPromptClass(input: {
  hasSession: boolean;
  wakeReason?: string | null;
}): PaperclipPromptClass {
  if (!input.hasSession) return "bootstrap";
  const reason = (input.wakeReason ?? "").toLowerCase();
  if (/fail|error|recover|retry|blocked|stalled/.test(reason)) return "failure_recovery";
  if (/comment/.test(reason)) return "comment_delta";
  if (/timer|schedule|heartbeat|routine|cron/.test(reason)) return "timer_delta";
  return "resume_delta";
}

export function buildPaperclipPromptMetrics(input: PaperclipPromptMetricsInput) {
  const promptBudgetVersion = input.promptBudgetVersion ?? PAPERCLIP_PROMPT_BUDGET_VERSION;
  const totalChars = Math.max(0, input.totalChars ?? input.prompt.length);
  const components = (input.components ?? [])
    .filter((component) => component.content.length > 0)
    .map((component) => {
      const componentType = component.componentType ?? "prompt_component";
      const chars = component.content.length;
      const contentSha256 = sha256Text(component.content);
      const evidenceSliceCount =
        component.evidenceSliceCount ??
        (componentType === "evidence_slice" || componentType === "context_manifest" ? 1 : 0);
      return {
        name: component.name,
        type: componentType,
        componentType,
        sha256: contentSha256,
        contentSha256,
        chars,
        estimatedTokens: estimateTokensFromChars(chars),
        truncated: false,
        evidenceSliceCount,
        metadata: {
          name: component.name,
          componentType,
          ...(component.metadata ?? {}),
        },
      };
    });
  const evidenceSliceCount = components.reduce(
    (total, component) => total + component.evidenceSliceCount,
    0,
  );
  return {
    promptClass: input.promptClass,
    promptBudgetVersion,
    outputBudgetVersion: input.outputBudgetVersion ?? PAPERCLIP_OUTPUT_BUDGET_VERSION,
    promptMetrics: {
      ...(input.baseMetrics ?? {}),
      promptClass: input.promptClass,
      promptBudgetVersion,
      outputBudgetVersion: input.outputBudgetVersion ?? PAPERCLIP_OUTPUT_BUDGET_VERSION,
      outputBudget: input.outputBudget ?? PAPERCLIP_DEFAULT_OUTPUT_BUDGET,
      promptChars: input.prompt.length,
      totalChars,
      estimatedPromptTokens: estimateTokensFromChars(totalChars),
      totalTokens: estimateTokensFromChars(totalChars),
      components,
      evidenceSliceCount,
    },
    evidenceSliceCount,
  };
}

export function isPaperclipRequiredSkillEntry(
  entry: Pick<PaperclipSkillEntry, "key" | "runtimeName"> | { key?: string | null; runtimeName?: string | null },
): boolean {
  const runtimeName = (entry.runtimeName ?? "").trim().toLowerCase();
  if (runtimeName === CORE_PAPERCLIP_REQUIRED_SKILL_RUNTIME_NAME) return true;

  const key = (entry.key ?? "").trim().toLowerCase();
  return key === CORE_PAPERCLIP_REQUIRED_SKILL_RUNTIME_NAME || key.endsWith("/paperclip");
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const PAPERCLIP_PRIOR_RUN_VALUE_QUESTION =
  "Does this session's prior runs provide any value to this current run?";

export interface PaperclipRequestShapingResult {
  mode: "deliverable_work" | "bounded_status";
  enabled: boolean;
  reason: string;
  priorRunValueQuestion: string;
  contextMaxChars: number;
  outputMaxChars: number;
  outputMaxSentences: number;
  maxTurnsPerRun: number | null;
  allowSessionResume: boolean;
  dropSessionHandoff: boolean;
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function contextHasExplicitPaperclipWorkHandoff(context: Record<string, unknown>): boolean {
  const wake = parseObject(context.paperclipWake);
  const approval = parseObject(context.paperclipApproval ?? context.approval);
  return Boolean(
    asString(context.issueId, "").trim() ||
      asString(context.wakeCommentId, "").trim() ||
      asString(context.commentId, "").trim() ||
      asString(context.approvalId, "").trim() ||
      asString(context.userPrompt, "").trim() ||
      asString(context.prompt, "").trim() ||
      asString(parseObject(wake.issue).id, "").trim() ||
      asString(wake.latestCommentId, "").trim() ||
      asString(approval.id, "").trim() ||
      hasNonEmptyArray(wake.comments) ||
      hasNonEmptyArray(wake.commentIds),
  );
}

function readRequestShapingConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...parseObject(parseObject(config.tokenomics).requestShaping),
    ...parseObject(config.requestShaping),
  };
}

function boundedPositiveNumber(value: unknown, fallback: number, min: number) {
  return Math.max(min, Math.trunc(asNumber(value, fallback)));
}

export function resolvePaperclipRequestShaping(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  baseContextMaxChars: number;
  baseOutputMaxChars: number;
  baseOutputMaxSentences: number;
  baseMaxTurnsPerRun?: number | null;
}): PaperclipRequestShapingResult {
  const config = readRequestShapingConfig(input.config);
  const enabled = asBoolean(config.enabled, true);
  const priorRunValueQuestion =
    asString(config.priorRunValueQuestion, PAPERCLIP_PRIOR_RUN_VALUE_QUESTION).trim() ||
    PAPERCLIP_PRIOR_RUN_VALUE_QUESTION;

  if (!enabled) {
    return {
      mode: "deliverable_work",
      enabled: false,
      reason: "request_shaping_disabled",
      priorRunValueQuestion,
      contextMaxChars: input.baseContextMaxChars,
      outputMaxChars: input.baseOutputMaxChars,
      outputMaxSentences: input.baseOutputMaxSentences,
      maxTurnsPerRun: input.baseMaxTurnsPerRun ?? null,
      allowSessionResume: true,
      dropSessionHandoff: false,
    };
  }

  if (contextHasExplicitPaperclipWorkHandoff(input.context)) {
    return {
      mode: "deliverable_work",
      enabled: true,
      reason: "explicit_issue_comment_approval_or_prompt",
      priorRunValueQuestion,
      contextMaxChars: input.baseContextMaxChars,
      outputMaxChars: input.baseOutputMaxChars,
      outputMaxSentences: input.baseOutputMaxSentences,
      maxTurnsPerRun: input.baseMaxTurnsPerRun ?? null,
      allowSessionResume: true,
      dropSessionHandoff: false,
    };
  }

  return {
    mode: "bounded_status",
    enabled: true,
    reason: "no_issue_comment_approval_or_prompt_handoff",
    priorRunValueQuestion,
    contextMaxChars: Math.min(
      input.baseContextMaxChars || boundedPositiveNumber(config.noIssueContextMaxChars, 8_000, 1_000),
      boundedPositiveNumber(config.noIssueContextMaxChars, 8_000, 1_000),
    ),
    outputMaxChars: Math.min(
      input.baseOutputMaxChars || boundedPositiveNumber(config.noIssueOutputMaxChars, 1_200, 400),
      boundedPositiveNumber(config.noIssueOutputMaxChars, 1_200, 400),
    ),
    outputMaxSentences: Math.min(
      input.baseOutputMaxSentences || boundedPositiveNumber(config.noIssueOutputMaxSentences, 6, 1),
      boundedPositiveNumber(config.noIssueOutputMaxSentences, 6, 1),
    ),
    maxTurnsPerRun: boundedPositiveNumber(config.noIssueMaxTurnsPerRun, 4, 1),
    allowSessionResume: false,
    dropSessionHandoff: true,
  };
}

export function renderPaperclipRequestShapingPrompt(shaping: PaperclipRequestShapingResult): string {
  const lines = [
    "## Paperclip Request Shaping",
    "",
    `- mode: ${shaping.mode}`,
    `- reason: ${shaping.reason}`,
    `- prior-run value question: ${shaping.priorRunValueQuestion}`,
  ];
  if (shaping.mode === "bounded_status") {
    lines.push(
      "",
      "No explicit issue, comment, approval, or human prompt handoff was provided.",
      "Default answer to the prior-run value question: no.",
      "Do not resume prior sessions, replay previous session handoff text, dump repository context, run broad implementation, or browse raw files for speculative work.",
      "Use compact current Paperclip evidence only. Complete a bounded status/readiness decision: identify assigned actionable work or blockers, create/update a precise issue with acceptance criteria, or return a safe-skip/status receipt.",
      "Do not mutate code unless Paperclip exposes an explicit issue handoff inside this run.",
    );
  } else {
    lines.push(
      "",
      "Explicit Paperclip work handoff detected. Use prior sessions only when they materially change the current issue/comment/approval task.",
      "The deliverable is finished issue-scoped work: code, docs, tests, receipts, or a precise blocker update tied to the issue.",
    );
  }
  return lines.join("\n").trim();
}

export interface PaperclipWorkIdentity {
  workKey: string | null;
  issueId: string | null;
  taskKey: string | null;
  approvalId: string | null;
  commentId: string | null;
}

export interface PaperclipSessionContinuityResult {
  sessionId: string | null;
  suppressed: boolean;
  reason: string;
  workIdentity: PaperclipWorkIdentity;
  savedWorkIdentity: PaperclipWorkIdentity;
  runtimeSessionCwd: string | null;
}

function workKeyFromIdentity(identity: Omit<PaperclipWorkIdentity, "workKey">): string | null {
  if (identity.issueId) return `issue:${identity.issueId}`;
  if (identity.taskKey) return `task:${identity.taskKey}`;
  if (identity.approvalId) return `approval:${identity.approvalId}`;
  if (identity.commentId) return `comment:${identity.commentId}`;
  return null;
}

export function readPaperclipWorkIdentity(context: Record<string, unknown>): PaperclipWorkIdentity {
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const approval = parseObject(context.paperclipApproval ?? context.approval);
  const identity = {
    issueId:
      asString(context.issueId, "").trim() ||
      asString(context.taskId, "").trim() ||
      asString(wakeIssue.id, "").trim() ||
      null,
    taskKey:
      asString(context.taskKey, "").trim() ||
      asString(wakeIssue.identifier, "").trim() ||
      null,
    approvalId:
      asString(context.approvalId, "").trim() ||
      asString(approval.id, "").trim() ||
      null,
    commentId:
      asString(context.wakeCommentId, "").trim() ||
      asString(context.commentId, "").trim() ||
      asString(wake.latestCommentId, "").trim() ||
      null,
  };
  return {
    ...identity,
    workKey: workKeyFromIdentity(identity),
  };
}

export function readPaperclipSessionWorkIdentity(sessionParams: Record<string, unknown>): PaperclipWorkIdentity {
  const identity = {
    issueId:
      asString(sessionParams.issueId, "").trim() ||
      asString(sessionParams.taskId, "").trim() ||
      null,
    taskKey: asString(sessionParams.taskKey, "").trim() || null,
    approvalId: asString(sessionParams.approvalId, "").trim() || null,
    commentId: asString(sessionParams.commentId, "").trim() || null,
  };
  return {
    ...identity,
    workKey: asString(sessionParams.workKey, "").trim() || workKeyFromIdentity(identity),
  };
}

export function buildPaperclipSessionParams(input: {
  sessionId?: string | null;
  cwd: string;
  source?: string | null;
  workIdentity?: PaperclipWorkIdentity | null;
}): Record<string, string> {
  const identity = input.workIdentity ?? {
    workKey: null,
    issueId: null,
    taskKey: null,
    approvalId: null,
    commentId: null,
  };
  return Object.fromEntries(
    Object.entries({
      sessionId: asString(input.sessionId, "").trim() || null,
      cwd: input.cwd,
      source: asString(input.source, "").trim() || null,
      workKey: identity.workKey,
      issueId: identity.issueId,
      taskKey: identity.taskKey,
      approvalId: identity.approvalId,
      commentId: identity.commentId,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

export function resolvePaperclipSessionContinuity(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeSessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  cwd: string;
  requestShaping: PaperclipRequestShapingResult;
}): PaperclipSessionContinuityResult {
  const runtimeSessionId = asString(input.runtimeSessionId, "").trim() || null;
  const sessionParams = parseObject(input.sessionParams);
  const workIdentity = readPaperclipWorkIdentity(input.context);
  const savedWorkIdentity = readPaperclipSessionWorkIdentity(sessionParams);
  const runtimeSessionCwd = asString(sessionParams.cwd, "").trim() || null;
  if (!runtimeSessionId) {
    return {
      sessionId: null,
      suppressed: false,
      reason: "no_runtime_session",
      workIdentity,
      savedWorkIdentity,
      runtimeSessionCwd,
    };
  }
  if (runtimeSessionCwd && path.resolve(runtimeSessionCwd) !== path.resolve(input.cwd)) {
    return {
      sessionId: null,
      suppressed: true,
      reason: "cwd_mismatch",
      workIdentity,
      savedWorkIdentity,
      runtimeSessionCwd,
    };
  }
  if (!input.requestShaping.allowSessionResume) {
    return {
      sessionId: null,
      suppressed: true,
      reason: `request_shaping_${input.requestShaping.mode}`,
      workIdentity,
      savedWorkIdentity,
      runtimeSessionCwd,
    };
  }
  if (!workIdentity.workKey) {
    return {
      sessionId: null,
      suppressed: true,
      reason: "missing_current_work_key",
      workIdentity,
      savedWorkIdentity,
      runtimeSessionCwd,
    };
  }
  if (!savedWorkIdentity.workKey) {
    const allowLegacy = asBoolean(
      parseObject(input.config.requestShaping).allowLegacySessionResumeWithoutWorkKey,
      false,
    );
    return allowLegacy
      ? {
          sessionId: runtimeSessionId,
          suppressed: false,
          reason: "legacy_session_resume_allowed",
          workIdentity,
          savedWorkIdentity,
          runtimeSessionCwd,
        }
      : {
          sessionId: null,
          suppressed: true,
          reason: "missing_saved_work_key",
          workIdentity,
          savedWorkIdentity,
          runtimeSessionCwd,
        };
  }
  if (savedWorkIdentity.workKey !== workIdentity.workKey) {
    return {
      sessionId: null,
      suppressed: true,
      reason: "work_key_mismatch",
      workIdentity,
      savedWorkIdentity,
      runtimeSessionCwd,
    };
  }
  return {
    sessionId: runtimeSessionId,
    suppressed: false,
    reason: "work_key_match",
    workIdentity,
    savedWorkIdentity,
    runtimeSessionCwd,
  };
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export interface PromptBudgetSectionInput {
  name: string;
  content: string;
  protected?: boolean;
  minChars?: number;
}

export function budgetPromptSections(
  sections: PromptBudgetSectionInput[],
  maxChars: number,
  separator = "\n\n",
) {
  const limit = Math.trunc(maxChars);
  const budgeted = sections.map((section) => ({
    ...section,
    originalChars: section.content.length,
    content: section.content,
    minChars: Math.max(0, Math.trunc(section.minChars ?? 0)),
    truncated: false,
  }));

  const buildPrompt = () => joinPromptSections(budgeted.map((section) => section.content), separator);
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      prompt: buildPrompt(),
      sections: Object.fromEntries(budgeted.map((section) => [section.name, section.content])),
      truncatedSections: [] as Array<{ name: string; originalChars: number; finalChars: number }>,
    };
  }

  let prompt = buildPrompt();
  for (let attempts = 0; prompt.length > limit && attempts < budgeted.length * 4; attempts += 1) {
    const candidates = budgeted.filter((section) => section.content.length > section.minChars);
    if (candidates.length === 0) break;
    const preferred = candidates
      .filter((section) => !section.protected)
      .sort((left, right) => right.content.length - left.content.length)[0];
    const target = preferred ?? candidates.sort((left, right) => right.content.length - left.content.length)[0];
    if (!target) break;

    const excess = prompt.length - limit;
    const nextLength = Math.max(target.minChars, target.content.length - excess - separator.length);
    if (nextLength >= target.content.length) break;
    target.content = truncatePromptSection(target.content, nextLength, target.name);
    target.truncated = true;
    prompt = buildPrompt();
  }

  return {
    prompt,
    sections: Object.fromEntries(budgeted.map((section) => [section.name, section.content])),
    truncatedSections: budgeted
      .filter((section) => section.truncated)
      .map((section) => ({
        name: section.name,
        originalChars: section.originalChars,
        finalChars: section.content.length,
      })),
  };
}

function truncatePromptSection(value: string, maxChars: number, name: string) {
  const limit = Math.max(0, Math.trunc(maxChars));
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  const marker = `\n\n[Paperclip truncated ${name} for prompt budget.]`;
  if (limit <= marker.length + 24) return value.slice(0, limit);
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

export function renderPaperclipOutputContract(
  options: {
    responseClass?: PaperclipResponseClass;
    outputBudgetVersion?: string;
    maxSentences?: number;
    maxChars?: number;
    maxOutputTokens?: number;
  } = {},
): string {
  const responseClass = options.responseClass ?? "compact_status";
  const outputBudgetVersion = options.outputBudgetVersion ?? PAPERCLIP_OUTPUT_BUDGET_VERSION;
  const maxSentences = options.maxSentences ?? PAPERCLIP_DEFAULT_OUTPUT_BUDGET.maxSentences;
  const maxChars = options.maxChars ?? PAPERCLIP_DEFAULT_OUTPUT_BUDGET.maxChars;
  const maxOutputTokens = options.maxOutputTokens ?? PAPERCLIP_DEFAULT_OUTPUT_BUDGET.maxOutputTokens;

  return [
    "## Paperclip Output Contract",
    "",
    `Contract version: ${outputBudgetVersion}. Response class: ${responseClass}.`,
    `Default final response cap: ${maxSentences} sentences, ${maxChars} characters, about ${maxOutputTokens} output tokens.`,
    "Write the smallest response that lets the board or next agent act safely.",
    "Include only: outcome, changed files, tests run, blocker, receipt/artifact paths, and the next concrete action if one is required.",
    "Set finalDisposition to one of advanced_vision, maintenance, blocked, noop, or misaligned; include nextActionOwner when follow-up belongs to another owner.",
    "Do not include tutorials, broad recaps, motivational prose, repeated plans, raw logs, or long file listings in the final response.",
    "Expansion is allowed only for explicit operator requests, unresolved blockers, failed verification, code-review/security findings, legal/financial risk, or a handoff that would be unsafe if compressed.",
    "When expansion is necessary, start with `Expansion reason: <reason>` and keep the decisive evidence first.",
    "Put bulky proof in receipts/artifacts and cite paths or hashes instead of pasting the detail.",
  ].join("\n").trim();
}

type PaperclipWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
};

type PaperclipWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakePayload = {
  reason: string | null;
  issue: PaperclipWakeIssue | null;
  checkedOutByHarness: boolean;
  commentIds: string[];
  latestCommentId: string | null;
  comments: PaperclipWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
};

function normalizePaperclipWakeIssue(value: unknown): PaperclipWakeIssue | null {
  const issue = parseObject(value);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  const status = asString(issue.status, "").trim() || null;
  const priority = asString(issue.priority, "").trim() || null;
  if (!id && !identifier && !title) return null;
  return {
    id,
    identifier,
    title,
    status,
    priority,
  };
}

function normalizePaperclipWakeComment(value: unknown): PaperclipWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment.author);
  const body = asString(comment.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(comment.id, "").trim() || null,
    issueId: asString(comment.issueId, "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment.bodyTruncated, false),
    createdAt: asString(comment.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

export function normalizePaperclipWakePayload(value: unknown): PaperclipWakePayload | null {
  const payload = parseObject(value);
  const issue = normalizePaperclipWakeIssue(payload.issue);
  const comments = Array.isArray(payload.comments)
    ? payload.comments
        .map((entry) => normalizePaperclipWakeComment(entry))
        .filter((entry): entry is PaperclipWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload.commentWindow);
  const commentIds = Array.isArray(payload.commentIds)
    ? payload.commentIds
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];

  if (comments.length === 0 && commentIds.length === 0 && !issue) return null;

  return {
    reason: asString(payload.reason, "").trim() || null,
    issue,
    checkedOutByHarness: asBoolean(payload.checkedOutByHarness, false),
    commentIds,
    latestCommentId: asString(payload.latestCommentId, "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow.requestedCount, comments.length || commentIds.length),
    includedCount: asNumber(commentWindow.includedCount, comments.length),
    missingCount: asNumber(commentWindow.missingCount, 0),
    truncated: asBoolean(payload.truncated, false),
    fallbackFetchNeeded: asBoolean(payload.fallbackFetchNeeded, false),
  };
}

export function stringifyPaperclipWakePayload(value: unknown): string | null {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

export function renderPaperclipWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;

  const lines = resumedSession
      ? [
        "## Paperclip Resume Delta",
        "",
        "You are resuming an existing Paperclip session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
        "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ]
    : [
        "## Paperclip Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.priority) {
    lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.checkedOutByHarness) {
    lines.push("- checkout: already claimed by the harness for this run");
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (normalized.checkedOutByHarness) {
    lines.push("", "The harness already checked out this issue for the current run.");
  }

  if (normalized.comments.length === 0) {
    lines.push("", "No inline comments were included in this wake.");
    return lines.join("\n").trim();
  }

  lines.push("", "New comments in order:");

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function renderPaperclipSessionDeltaPrompt(
  value: unknown,
  options: { resumedSession?: boolean; runId?: string | null } = {},
): string {
  if (options.resumedSession !== true) return "";

  const context = parseObject(value);
  const reason = maybeString(context.wakeReason) ?? maybeString(context.reason) ?? "heartbeat_timer";
  const source = maybeString(context.wakeSource) ?? maybeString(context.source);
  const triggerDetail = maybeString(context.wakeTriggerDetail) ?? maybeString(context.triggerDetail);
  const issueId = maybeString(context.issueId) ?? maybeString(context.taskId);
  const taskKey = maybeString(context.taskKey);
  const commentId = maybeString(context.wakeCommentId) ?? maybeString(context.commentId);
  const executionStage = parseObject(context.executionStage);
  const commentIds = Array.isArray(context.wakeCommentIds)
    ? context.wakeCommentIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  const lines = [
    "## Paperclip Resume Delta",
    "",
    "You are resuming an existing Paperclip session.",
    "No inline issue/comment wake payload was attached to this heartbeat.",
    "Continue from the existing session state without restating the full heartbeat boilerplate.",
    "Use the Paperclip API inbox/context endpoints only when the fields below require fresh state.",
    "",
    `- reason: ${reason}`,
  ];

  if (options.runId) lines.push(`- run id: ${options.runId}`);
  if (source) lines.push(`- source: ${source}`);
  if (triggerDetail) lines.push(`- trigger detail: ${triggerDetail}`);
  if (issueId) lines.push(`- issue/task id: ${issueId}`);
  if (taskKey) lines.push(`- task key: ${taskKey}`);
  if (commentId) lines.push(`- latest comment id: ${commentId}`);
  if (commentIds.length > 0) lines.push(`- wake comment ids: ${commentIds.join(", ")}`);
  if (Object.keys(executionStage).length > 0) {
    lines.push(`- execution stage: ${JSON.stringify(executionStage)}`);
  }
  if (!issueId && /timer|schedule|heartbeat|routine|cron/i.test(reason)) {
    lines.push("- scope: timer heartbeat with no pinned issue; continue assigned work incrementally.");
  }

  return lines.join("\n").trim();
}

function maybeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function renderContextEconomyPathLines(
  label: string,
  value: unknown,
): string[] {
  const record = parseObject(value);
  const entries = Object.entries(record)
    .map(([key, rawValue]) => [key, maybeString(rawValue)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  if (entries.length === 0) return [];
  return [
    `- ${label}:`,
    ...entries.map(([key, pathValue]) => `  - ${key}: ${pathValue}`),
  ];
}

export function renderPaperclipContextEconomyPrompt(value: unknown): string {
  const economy = parseObject(value);
  const contextPacks = parseObject(economy.contextPacks);
  const packs = parseObject(economy.packs);
  const mode = maybeString(economy.mode) ?? "map_first";
  const dir = maybeString(contextPacks.dir);
  const manifest = maybeString(contextPacks.manifest);
  const repoKey = maybeString(economy.repoKey) ?? maybeString(contextPacks.repoKey);

  if (!dir && !manifest && Object.keys(packs).length === 0) return "";

  const lines = [
    "## Paperclip Context Economy",
    "",
    "Use the smallest sufficient context before escalating to full repository reads.",
    `- mode: ${mode}`,
  ];
  if (repoKey) lines.push(`- repo: ${repoKey}`);
  if (dir) lines.push(`- context pack dir: ${dir}`);
  if (manifest) lines.push(`- manifest: ${manifest}`);
  const generatedAt = maybeString(economy.generatedAt) ?? maybeString(contextPacks.generatedAt);
  if (generatedAt) lines.push(`- generated at: ${generatedAt}`);

  const indexLines = renderContextEconomyPathLines("indexes", {
    compact: contextPacks.compact,
    toon: contextPacks.toon,
    tsv: contextPacks.tsv,
    policy: contextPacks.policy,
  });
  if (indexLines.length > 0) lines.push(...indexLines);

  const packLines = renderContextEconomyPathLines("repo packs", packs);
  if (packLines.length > 0) lines.push(...packLines);

  lines.push(
    "",
    "Context-use contract:",
    "1. Read the map pack or compact index first, then use rg and exact file reads for implementation.",
    "2. Use delta packs for recent dirty-tree context and reserve core packs for tasks that truly need broad context.",
    "3. Do not paste whole repositories, old transcripts, or large pack contents back into the conversation.",
    "4. Use TOON only for compact structured metadata; keep source code in targeted file reads or Repomix markdown.",
  );

  return lines.join("\n").trim();
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] = resolvedCommand;
  }

  return redactEnvForLogs(merged);
}

const CLAUDE_PARENT_HARNESS_ENV_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
]);

function isClaudeParentHarnessEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (CLAUDE_PARENT_HARNESS_ENV_KEYS.has(normalized)) return true;
  if (normalized.startsWith("CLAUDE_CODE_")) return true;
  if (normalized.startsWith("CODEX_")) return true;
  return false;
}

function commandLooksLikeClaude(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  const basename = path.basename(normalized);
  return basename === "claude" || basename.startsWith("claude-") || normalized.includes("/claude");
}

export function sanitizeClaudeParentHarnessEnv(
  env: NodeJS.ProcessEnv,
  explicitEnvKeys: ReadonlySet<string> = new Set(),
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (explicitEnvKeys.has(key)) continue;
    if (isClaudeParentHarnessEnvKey(key)) delete sanitized[key];
  }
  return sanitized;
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveWindowsCmdShell(env: NodeJS.ProcessEnv): string {
  const fallbackRoot = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return path.join(fallbackRoot, "System32", "cmd.exe");
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    // Always use cmd.exe for .cmd/.bat wrappers. Some environments override
    // ComSpec to PowerShell, which breaks cmd-specific flags like /d /s /c.
    const shell = resolveWindowsCmdShell(env);
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skill = {
          key: `paperclipai/paperclip/${entry.name}`,
          runtimeName: entry.name,
          source: path.join(root, entry.name),
        };
        const required = isPaperclipRequiredSkillEntry(skill);
        return {
          ...skill,
          required,
          requiredReason: required ? CORE_PAPERCLIP_REQUIRED_SKILL_REASON : null,
        };
      });
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = commandLooksLikeClaude(command)
      ? sanitizeClaudeParentHarnessEnv(
        { ...process.env, ...opts.env },
        new Set(Object.keys(opts.env)),
      )
      : { ...process.env, ...opts.env };

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          detached: process.platform !== "win32",
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();
        const processGroupId = resolveProcessGroupId(child);

        const spawnPersistPromise =
          typeof child.pid === "number" && child.pid > 0 && opts.onSpawn
            ? opts.onSpawn({ pid: child.pid, processGroupId, startedAt }).catch((err) => {
              onLogError(err, runId, "failed to record child process metadata");
            })
            : Promise.resolve();

        runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                signalRunningProcess({ child, processGroupId }, "SIGTERM");
                setTimeout(() => {
                  signalRunningProcess({ child, processGroupId }, "SIGKILL");
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        const stdin = child.stdin;
        if (opts.stdin != null && stdin) {
          void spawnPersistPromise.finally(() => {
            if (child.killed || stdin.destroyed) return;
            stdin.write(opts.stdin as string);
            stdin.end();
          });
        }

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          void Promise.allSettled([spawnPersistPromise, logChain]).finally(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
