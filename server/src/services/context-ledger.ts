import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentContextCursors,
  contextLedgerComponents,
  contextLedgerEntries,
  issues,
  promptBudgetPolicies,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { AdapterInvocationMeta } from "../adapters/index.js";
import { evaluateGoLiveDelta, extractGoLiveDelta } from "./company-vision-contract.js";

type JsonRecord = Record<string, unknown>;

type PromptBudgetStatus = "ok" | "warning" | "hard_stop";
type OutputBudgetStatus = "ok" | "warning";

const DEFAULT_PROMPT_BUDGET_SLO_VERSION = "context-economy.slo.v1";
const DEFAULT_OUTPUT_BUDGET_VERSION = "output-economy.v1";
const DEFAULT_PROMPT_BUDGETS_BY_CLASS: Record<string, { maxPromptTokens: number; warnPromptTokens: number }> = {
  bootstrap: { maxPromptTokens: 60_000, warnPromptTokens: 45_000 },
  resume_delta: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
  timer_delta: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
  comment_delta: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
  failure_recovery: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
  context_manifest: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
  resume_refresh: { maxPromptTokens: 25_000, warnPromptTokens: 15_000 },
};
const DEFAULT_OUTPUT_BUDGETS_BY_CLASS: Record<string, {
  maxOutputTokens: number;
  warnOutputTokens: number;
  maxChars: number;
  maxSentences: number;
}> = {
  compact_success: { maxOutputTokens: 700, warnOutputTokens: 450, maxChars: 1_200, maxSentences: 7 },
  compact_failure: { maxOutputTokens: 700, warnOutputTokens: 450, maxChars: 1_200, maxSentences: 7 },
  compact_status: { maxOutputTokens: 700, warnOutputTokens: 450, maxChars: 1_200, maxSentences: 7 },
  review_findings: { maxOutputTokens: 1_500, warnOutputTokens: 1_000, maxChars: 6_000, maxSentences: 35 },
  handoff: { maxOutputTokens: 1_500, warnOutputTokens: 1_000, maxChars: 6_000, maxSentences: 35 },
  operator_requested_detail: { maxOutputTokens: 1_500, warnOutputTokens: 1_000, maxChars: 6_000, maxSentences: 35 },
  expanded_allowed: { maxOutputTokens: 1_500, warnOutputTokens: 1_000, maxChars: 6_000, maxSentences: 35 },
  verbose_unjustified: { maxOutputTokens: 700, warnOutputTokens: 450, maxChars: 1_200, maxSentences: 7 },
};
const FINAL_DISPOSITIONS = new Set(["advanced_vision", "maintenance", "blocked", "noop", "misaligned"]);

export interface ContextLedgerRecordInput {
  companyId: string;
  runId: string;
  agentId: string;
  issueId?: string | null;
  taskKey?: string | null;
  adapterType: string;
  adapterVersion?: string | null;
  branch?: string | null;
  sessionIdBefore?: string | null;
  meta: AdapterInvocationMeta;
  context?: JsonRecord | null;
}

export interface ContextLedgerFinalizeInput {
  runId: string;
  outcome: string;
  blocker?: string | null;
  receiptPaths?: string[] | null;
  sessionIdAfter?: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
  } | null;
  resultJson?: JsonRecord | null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function estimateTokensFromText(value: string | null): number | null {
  if (!value) return null;
  return Math.ceil(value.length / 4);
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function withoutRawPrompt(meta: AdapterInvocationMeta): JsonRecord {
  const raw = meta as unknown as JsonRecord;
  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "prompt") continue;
    sanitized[key] = value;
  }
  if (typeof raw.prompt === "string") {
    sanitized.promptSha256 = sha256(raw.prompt);
    sanitized.promptChars = raw.prompt.length;
  }
  return sanitized;
}

function normalizeComponent(component: unknown, fallbackIndex: number) {
  const record = asRecord(component);
  const name = readString(record.name) ?? `component_${fallbackIndex}`;
  const hash =
    readString(record.sha256) ??
    readString(record.contentSha256) ??
    sha256(stableStringify(record));
  const chars = Math.max(0, readNumber(record.chars) ?? 0);
  const estimatedTokens = Math.max(
    0,
    readNumber(record.estimatedTokens) ?? readNumber(record.tokens) ?? 0,
  );
  return {
    name,
    componentType: readString(record.type) ?? readString(record.componentType) ?? "prompt_component",
    contentSha256: hash,
    chars,
    estimatedTokens,
    truncated: readBoolean(record.truncated) ?? Boolean(asRecord(record.truncationFlags).truncated),
    evidenceSliceCount: Math.max(0, readNumber(record.evidenceSliceCount) ?? 0),
    artifactRef: asRecord(record.artifactRef),
    metadata: record,
  };
}

function synthesizePromptComponentsFromFlatMetrics(metrics: JsonRecord) {
  const specs = [
    ["managed_agent_instructions", "instructionsChars"],
    ["bootstrap_prompt", "bootstrapPromptChars"],
    ["paperclip_wake", "wakePromptChars"],
    ["context_pack_manifest", "contextEconomyPromptChars"],
    ["session_handoff", "sessionHandoffChars"],
    ["heartbeat_prompt", "heartbeatPromptChars"],
  ] as const;
  return specs.flatMap(([name, metricKey], index) => {
    const chars = Math.max(0, readNumber(metrics[metricKey]) ?? 0);
    if (chars === 0) return [];
    return [
      {
        name,
        componentType: "prompt_component",
        contentSha256: sha256(stableStringify({ name, chars, metricKey })),
        chars,
        estimatedTokens: Math.ceil(chars / 4),
        truncated: false,
        evidenceSliceCount: 0,
        artifactRef: {},
        metadata: {
          name,
          metricKey,
          chars,
          synthesizedFromFlatPromptMetrics: true,
          index,
        },
      },
    ];
  });
}

function normalizeArtifactRefs(value: unknown): JsonRecord[] {
  const refs = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as JsonRecord).map(([key, ref]) => ({ key, ref }))
      : [];
  return refs
    .map((entry) => asRecord(entry))
    .filter((entry) => Object.keys(entry).length > 0);
}

function readContextPackProfile(value: unknown): string | null {
  const profile = readString(value)?.trim().toLowerCase();
  return profile && /^[a-z0-9_-]+$/.test(profile) ? profile : null;
}

function collectContextPackProfiles(value: unknown): string[] {
  const profiles = Array.isArray(value)
    ? value
    : readString(value)?.includes(",")
      ? readString(value)?.split(",") ?? []
      : [value];
  return profiles
    .map((entry) => readContextPackProfile(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function selectedContextPackProfiles(record: JsonRecord, packs: JsonRecord): Set<string> {
  const explicitProfiles = [
    ...collectContextPackProfiles(record.selectedProfile),
    ...collectContextPackProfiles(record.selectedProfiles),
    ...collectContextPackProfiles(record.packProfile),
    ...collectContextPackProfiles(record.packProfiles),
    ...collectContextPackProfiles(record.profile),
  ];
  if (explicitProfiles.length > 0) return new Set(explicitProfiles);

  const mode = readContextPackProfile(record.mode);
  if (mode === "map_first") return new Set(["map"]);
  if (mode === "index_first") return new Set(["index"]);
  if (mode && /^(map|index|delta|core)$/.test(mode)) return new Set([mode]);

  const packProfiles = Object.keys(packs).filter((profile) => readString(packs[profile]));
  return packProfiles.length === 1 ? new Set(packProfiles) : new Set();
}

function extractContextPackRefs(value: unknown, depth = 0): JsonRecord[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractContextPackRefs(entry, depth + 1));
  }
  if (typeof value !== "object") return [];
  const record = value as JsonRecord;
  const refs: JsonRecord[] = [];
  const hasPackSignal =
    "manifestPath" in record ||
    "manifestSha" in record ||
    "packSha" in record ||
    "packPath" in record ||
    "selectedProfile" in record ||
    "freshnessStatus" in record;
  if (hasPackSignal) {
    const directRef = {
      manifestPath: readString(record.manifestPath),
      manifestSha: readString(record.manifestSha),
      packSha: readString(record.packSha),
      packPath: readString(record.packPath),
      repoSlug: readString(record.repoSlug),
      selectedProfile: readContextPackProfile(record.selectedProfile) ?? readContextPackProfile(record.packProfile),
      estimatedTokens: readNumber(record.estimatedTokens),
      freshnessStatus: readString(record.freshnessStatus),
      packHead: readString(record.packHead),
      currentHead: readString(record.currentHead),
    };
    const hasSelectedPackRef = Boolean(directRef.selectedProfile || directRef.packPath || directRef.packSha);
    if (hasSelectedPackRef) refs.push(directRef);
  }
  const packs = asRecord(record.packs);
  const packShas = asRecord(record.packShas);
  const contextPacks = asRecord(record.contextPacks);
  const manifestPath =
    readString(record.manifestPath) ??
    readString(contextPacks.manifest);
  const selectedProfiles = selectedContextPackProfiles(record, packs);
  if (Object.keys(packs).length > 0) {
    for (const [profile, packPathRaw] of Object.entries(packs)) {
      const normalizedProfile = readContextPackProfile(profile);
      if (!normalizedProfile) continue;
      if (selectedProfiles.size === 0 || !selectedProfiles.has(normalizedProfile)) continue;
      const packPath = readString(packPathRaw);
      if (!packPath) continue;
      refs.push({
        manifestPath,
        manifestSha: readString(record.manifestSha),
        packSha: readString(packShas[normalizedProfile]) ?? readString(record.packSha),
        packPath,
        repoSlug: readString(record.repoSlug) ?? readString(record.repoKey),
        selectedProfile: normalizedProfile,
        estimatedTokens: readNumber(asRecord(record.estimatedTokens)[normalizedProfile]),
        freshnessStatus: readString(record.freshnessStatus),
        packHead: readString(record.packHead),
        currentHead: readString(record.currentHead),
      });
    }
  }
  for (const value of Object.values(record)) {
    refs.push(...extractContextPackRefs(value, depth + 1));
  }
  return refs.filter((ref) => Object.values(ref).some((entry) => entry !== null && entry !== undefined));
}

function extractReceiptPaths(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    const isDirectPath =
      trimmed.length > 0 &&
      trimmed.length < 500 &&
      !/[\r\n{}]/.test(trimmed) &&
      /^[~./A-Za-z0-9_-]/.test(trimmed);
    const direct = isDirectPath && (
      /receipt[~./A-Za-z0-9_.-]*\.(?:json|md|txt|log|ndjson)$/i.test(trimmed) ||
      /\/receipts?\//i.test(trimmed)
    )
      ? [trimmed]
      : [];
    const embedded = Array.from(
      value.matchAll(
        /(?:^|[`"'\s])((?:[~./A-Za-z0-9_-]+\/)?[~./A-Za-z0-9_./-]*receipt[~./A-Za-z0-9_.-]*\.(?:json|md|txt|log|ndjson))(?:$|[`"'\s,.)])/gi,
      ),
    )
      .map((match) => match[1])
      .filter((path): path is string => Boolean(path && path.length < 500));
    return [...new Set([...direct, ...embedded])];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => extractReceiptPaths(entry, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as JsonRecord;
  const paths: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (/receipt/i.test(key) || typeof entry === "string") {
      paths.push(...extractReceiptPaths(entry, depth + 1));
    } else if (typeof entry === "object") {
      paths.push(...extractReceiptPaths(entry, depth + 1));
    }
  }
  return [...new Set(paths)];
}

function filterReceiptPathsForIssue(paths: string[], issueIdentifier: string | null): string[] {
  const unique = [...new Set(paths.filter((entry) => entry.trim().length > 0))];
  if (!issueIdentifier) return unique;
  const hasCanaryReceipt = unique.some((entry) => /\.tmp\/context-economy-canary\//i.test(entry));
  if (!hasCanaryReceipt) return unique;
  return unique.filter((entry) => {
    if (!/\.tmp\/context-economy-canary\//i.test(entry)) return true;
    return entry.includes(`${issueIdentifier}-receipt`);
  });
}

function artifactRefsFromReceiptPaths(paths: string[]): JsonRecord[] {
  return paths.map((path) => ({
    kind: /receipt/i.test(path) ? "receipt" : "artifact",
    path,
  }));
}

function artifactRefKey(ref: JsonRecord): string {
  return stableStringify({
    kind: readString(ref.kind),
    path: readString(ref.path),
    sha256: readString(ref.sha256),
    key: readString(ref.key),
  });
}

function mergeArtifactRefs(...groups: JsonRecord[][]): JsonRecord[] {
  const byKey = new Map<string, JsonRecord>();
  for (const ref of groups.flat()) {
    const key = artifactRefKey(ref);
    if (!byKey.has(key)) byKey.set(key, ref);
  }
  return Array.from(byKey.values());
}

function readBlocker(resultJson: JsonRecord | null | undefined, fallback?: string | null, outcome?: string): string | null {
  if (outcome === "succeeded") return null;
  const result = asRecord(resultJson);
  const direct =
    readString(result.finalBlocker) ??
    readString(result.blocker) ??
    readString(result.error) ??
    readString(result.message) ??
    readString(result.summary) ??
    readString(fallback);
  return direct ? direct.slice(0, 2_000) : null;
}

function normalizeFinalDisposition(raw: unknown) {
  const value = readString(raw)?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return value && FINAL_DISPOSITIONS.has(value) ? value : null;
}

function parseFinalDispositionFromText(text: string | null) {
  if (!text) return null;
  const classification = normalizeFinalDisposition(
    text.match(/\bfinalDisposition\s*[:=]\s*([A-Za-z_-]+)/i)?.[1] ?? null,
  );
  if (!classification) return null;
  const ownerRaw = readString(text.match(/\bnextActionOwner\s*[:=]\s*([^;\n]+)/i)?.[1]) ?? null;
  const nextActionOwner = ownerRaw && !/^(null|none|n\/a|na)$/i.test(ownerRaw.trim())
    ? ownerRaw.trim()
    : null;
  return {
    classification,
    source: "explicit_final_response",
    nextActionOwner,
  };
}

function resolveFinalDisposition(input: {
  outcome: string;
  resultJson: JsonRecord | null | undefined;
  blocker: string | null;
  finalResponseText?: string | null;
}) {
  const result = asRecord(input.resultJson);
  const nested = asRecord(result.finalDisposition);
  const explicit =
    normalizeFinalDisposition(result.finalDisposition) ??
    normalizeFinalDisposition(result.disposition) ??
    normalizeFinalDisposition(result.outputClassification) ??
    normalizeFinalDisposition(nested.classification) ??
    normalizeFinalDisposition(nested.disposition);
  if (explicit) {
    return {
      classification: explicit,
      source: "explicit",
      nextActionOwner:
        readString(result.nextActionOwner) ??
        readString(nested.nextActionOwner) ??
        readString(nested.owner) ??
        null,
    };
  }
  const textDisposition = parseFinalDispositionFromText(input.finalResponseText ?? null);
  if (textDisposition) return textDisposition;
  if (input.outcome !== "succeeded" || input.blocker) {
    return {
      classification: "blocked",
      source: "inferred_from_outcome",
      nextActionOwner: readString(result.nextActionOwner) ?? readString(result.blockerOwner) ?? null,
    };
  }
  if (readBoolean(result.noop) === true || readBoolean(result.noOp) === true) {
    return {
      classification: "noop",
      source: "inferred_from_result",
      nextActionOwner: readString(result.nextActionOwner) ?? null,
    };
  }
  if (readBoolean(result.maintenance) === true || readBoolean(result.governance) === true) {
    return {
      classification: "maintenance",
      source: "inferred_from_result",
      nextActionOwner: readString(result.nextActionOwner) ?? null,
    };
  }
  return {
    classification: "advanced_vision",
    source: "default_success",
    nextActionOwner: readString(result.nextActionOwner) ?? null,
  };
}

function extractFinalResponseText(resultJson: JsonRecord | null | undefined): string | null {
  const result = asRecord(resultJson);
  const direct =
    readString(result.finalResponse) ??
    readString(result.summary) ??
    readString(result.result) ??
    readString(result.message) ??
    readString(result.error);
  return direct ? direct.slice(0, 20_000) : null;
}

function countApproxSentences(text: string | null): number | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const punctuationSentences = normalized.match(/[.!?](?:\s|$)/g)?.length ?? 0;
  if (punctuationSentences > 0) return punctuationSentences;
  return Math.max(1, normalized.split(/\n{2,}|(?:^|\n)\s*[-*]\s+/).filter((entry) => entry.trim()).length);
}

function readExpansionReason(resultJson: JsonRecord | null | undefined, finalResponseText: string | null): string | null {
  const result = asRecord(resultJson);
  const explicit = readString(result.expansionReason);
  if (explicit) return explicit.slice(0, 500);
  if (!finalResponseText) return null;
  const match = finalResponseText.match(/^\s*Expansion reason:\s*(.+)$/im);
  return match?.[1]?.trim().slice(0, 500) ?? null;
}

function responseClassFromExpansionReason(reason: string | null): string {
  if (!reason) return "expanded_allowed";
  if (/review|finding|security|vulnerab|risk/i.test(reason)) return "review_findings";
  if (/handoff|handover|transition/i.test(reason)) return "handoff";
  if (/operator|requested|asked|explicit/i.test(reason)) return "operator_requested_detail";
  return "expanded_allowed";
}

function classifyOutputBudget(input: {
  outcome: string;
  resultJson: JsonRecord | null | undefined;
  finalResponseText: string | null;
  actualOutputTokens: number | null;
  estimatedOutputTokens: number | null;
  finalResponseChars: number | null;
  finalResponseSentenceCount: number | null;
}) {
  const explicitClass = readString(asRecord(input.resultJson).responseClass);
  const expansionReason = readExpansionReason(input.resultJson, input.finalResponseText);
  const compactClass = input.outcome === "succeeded"
    ? "compact_success"
    : input.outcome === "failed" || input.outcome === "blocked"
      ? "compact_failure"
      : "compact_status";
  const compactBudget = DEFAULT_OUTPUT_BUDGETS_BY_CLASS[compactClass] ?? DEFAULT_OUTPUT_BUDGETS_BY_CLASS.compact_status;
  const observedOutputTokens = input.actualOutputTokens ?? input.estimatedOutputTokens ?? 0;
  const exceedsCompact =
    observedOutputTokens > compactBudget.maxOutputTokens ||
    (input.finalResponseChars ?? 0) > compactBudget.maxChars ||
    (input.finalResponseSentenceCount ?? 0) > compactBudget.maxSentences;
  const responseClass =
    explicitClass ??
    (exceedsCompact && !expansionReason
      ? "verbose_unjustified"
      : expansionReason
        ? responseClassFromExpansionReason(expansionReason)
        : compactClass);
  const budget = DEFAULT_OUTPUT_BUDGETS_BY_CLASS[responseClass] ?? compactBudget;
  const warning =
    responseClass === "verbose_unjustified" ||
    observedOutputTokens >= budget.warnOutputTokens ||
    observedOutputTokens > budget.maxOutputTokens ||
    (input.finalResponseChars ?? 0) > budget.maxChars ||
    (input.finalResponseSentenceCount ?? 0) > budget.maxSentences;
  const status: OutputBudgetStatus = warning ? "warning" : "ok";
  return {
    responseClass,
    outputBudgetStatus: status,
    outputBudgetLimitTokens: budget.maxOutputTokens,
    expansionReason,
    observedOutputTokens,
    outputBudget: budget,
  };
}

function positiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = readNumber(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function extractUsageFromResultJson(resultJson: JsonRecord) {
  const stats = asRecord(resultJson.stats);
  const usage = asRecord(resultJson.usage);
  return {
    inputTokens: positiveNumber(
      stats.input_tokens,
      stats.inputTokens,
      stats.total_input_tokens,
      usage.input_tokens,
      usage.inputTokens,
      stats.input,
    ),
    cachedInputTokens: positiveNumber(
      stats.cached_input_tokens,
      stats.cachedInputTokens,
      stats.cached,
      usage.cached_input_tokens,
      usage.cachedInputTokens,
    ),
    outputTokens: positiveNumber(
      stats.output_tokens,
      stats.outputTokens,
      usage.output_tokens,
      usage.outputTokens,
      stats.output,
    ),
  };
}

function cursorTimestamp(cursor: unknown): number | null {
  const record = asRecord(cursor);
  const value = readString(record.timestamp) ?? readString(record.createdAt);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerCursor(candidate: unknown, existing: unknown): boolean {
  const candidateTs = cursorTimestamp(candidate);
  const existingTs = cursorTimestamp(existing);
  if (candidateTs !== null && existingTs !== null) return candidateTs >= existingTs;
  if (candidateTs !== null) return true;
  if (existingTs !== null) return false;
  return Object.keys(asRecord(candidate)).length > 0;
}

function extractWakeState(context: JsonRecord | null | undefined) {
  const wake = asRecord(asRecord(context).paperclipWake);
  const explicitCursor = asRecord(wake.commentCursor);
  const comments = asArray(wake.comments).map((comment) => asRecord(comment));
  const latestCommentId =
    readString(explicitCursor.latestCommentId) ??
    readString(wake.latestCommentId) ??
    readString(wake.commentId) ??
    (asArray(wake.commentIds).map(readString).filter(Boolean).pop() as string | undefined) ??
    null;
  const latestComment =
    latestCommentId
      ? comments.find((comment) => readString(comment.id) === latestCommentId)
      : comments[comments.length - 1];
  const derivedCursor = latestCommentId
    ? {
        latestCommentId,
        timestamp: readString(latestComment?.createdAt) ?? readString(wake.timestamp) ?? null,
        source: "paperclipWake",
      }
    : {};
  const commentCursor = Object.keys(explicitCursor).length > 0 ? explicitCursor : derivedCursor;
  const wakeCursor = Object.keys(wake).length > 0 ? wake : {};
  const wakeCount =
    readNumber(wake.wakeCount) ??
    asArray(wake.commentIds).length ??
    comments.length ??
    0;
  return {
    commentCursor,
    wakeCursor,
    wakeCount,
    latestCommentId,
  };
}

function promptFingerprint(input: {
  meta: AdapterInvocationMeta;
  promptClass: string;
  promptBudgetVersion: string;
  componentHashes: JsonRecord;
  estimatedPromptTokens: number;
}) {
  const rawMeta = input.meta as unknown as JsonRecord;
  const promptHash =
    typeof rawMeta.prompt === "string"
      ? sha256(rawMeta.prompt)
      : readString(rawMeta.promptSha256) ?? null;
  return sha256(
    stableStringify({
      adapterType: input.meta.adapterType,
      command: input.meta.command,
      cwd: input.meta.cwd,
      promptHash,
      promptClass: input.promptClass,
      promptBudgetVersion: input.promptBudgetVersion,
      componentHashes: input.componentHashes,
      estimatedPromptTokens: input.estimatedPromptTokens,
    }),
  );
}

function extractPromptShape(meta: AdapterInvocationMeta) {
  const metrics = asRecord(meta.promptMetrics);
  const rawMeta = meta as unknown as JsonRecord;
  const explicitComponents = asArray(metrics.components).map((component, index) => normalizeComponent(component, index));
  const components = explicitComponents.length > 0
    ? explicitComponents
    : synthesizePromptComponentsFromFlatMetrics(metrics);
  const componentHashes = Object.fromEntries(components.map((component) => [component.name, component.contentSha256]));
  const promptClass =
    readString(meta.promptClass) ??
    readString(metrics.promptClass) ??
    "bootstrap";
  const promptBudgetVersion =
    readString(meta.promptBudgetVersion) ??
    readString(metrics.promptBudgetVersion) ??
    "context-economy.legacy";
  const outputBudgetVersion =
    readString((meta as unknown as JsonRecord).outputBudgetVersion) ??
    readString(metrics.outputBudgetVersion) ??
    DEFAULT_OUTPUT_BUDGET_VERSION;
  const outputBudget = asRecord(metrics.outputBudget);
  const promptChars =
    Math.max(0, readNumber(metrics.totalChars) ?? readNumber(rawMeta.promptChars) ?? readNumber(metrics.promptChars) ?? 0);
  const estimatedPromptTokens = Math.max(
    0,
    readNumber(metrics.estimatedPromptTokens) ??
      readNumber(metrics.totalTokens) ??
      (typeof rawMeta.prompt === "string" ? Math.ceil(rawMeta.prompt.length / 4) : 0),
  );
  const artifactRefs = [
    ...normalizeArtifactRefs(metrics.artifactHashes),
    ...normalizeArtifactRefs(meta.artifactHashes),
  ];
  const contextPackRefs = extractContextPackRefs(meta.context);

  return {
    metrics,
    components,
    componentHashes,
    promptClass,
    promptBudgetVersion,
    outputBudgetVersion,
    outputBudget,
    promptChars,
    estimatedPromptTokens,
    artifactRefs,
    contextPackRefs,
    evidenceSliceCount: readNumber(metrics.evidenceSliceCount) ?? readNumber(rawMeta.evidenceSliceCount) ?? 0,
  };
}

function nonEmptyRecordOrNull(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function budgetSpecificity(scopeType: string) {
  if (scopeType === "issue") return 3;
  if (scopeType === "agent") return 2;
  if (scopeType === "company") return 1;
  return 0;
}

function toReadModel(entry: typeof contextLedgerEntries.$inferSelect, components: Array<typeof contextLedgerComponents.$inferSelect>) {
  return {
    id: entry.id,
    companyId: entry.companyId,
    runId: entry.runId,
    agentId: entry.agentId,
    issueId: entry.issueId,
    taskKey: entry.taskKey,
    cwd: entry.cwd,
    branch: entry.branch,
    adapterType: entry.adapterType,
    adapterVersion: entry.adapterVersion,
    promptClass: entry.promptClass,
    promptBudgetVersion: entry.promptBudgetVersion,
    promptFingerprint: entry.promptFingerprint,
    promptChars: entry.promptChars,
    estimatedPromptTokens: entry.estimatedPromptTokens,
    componentHashes: entry.componentHashes,
    artifactRefs: entry.artifactRefs,
    contextPackRefs: entry.contextPackRefs,
    sessionIdBefore: entry.sessionIdBefore,
    sessionIdAfter: entry.sessionIdAfter,
    commentCursor: entry.commentCursor,
    wakeCursor: entry.wakeCursor,
    budgetStatus: entry.budgetStatus,
    budgetLimitTokens: entry.budgetLimitTokens,
    estimatedInputTokens: entry.estimatedInputTokens,
    actualInputTokens: entry.actualInputTokens,
    actualOutputTokens: entry.actualOutputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    responseClass: entry.responseClass,
    outputBudgetVersion: entry.outputBudgetVersion,
    estimatedOutputTokens: entry.estimatedOutputTokens,
    outputBudgetStatus: entry.outputBudgetStatus,
    outputBudgetLimitTokens: entry.outputBudgetLimitTokens,
    finalResponseChars: entry.finalResponseChars,
    finalResponseSentenceCount: entry.finalResponseSentenceCount,
    finalResponseSha256: entry.finalResponseSha256,
    finalResponseArtifactRefs: entry.finalResponseArtifactRefs,
    finalOutcome: entry.finalOutcome,
    finalBlocker: entry.finalBlocker,
    receiptPaths: entry.receiptPaths,
    redactionApplied: entry.redactionApplied,
    metadata: entry.metadata,
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      componentType: component.componentType,
      contentSha256: component.contentSha256,
      chars: component.chars,
      estimatedTokens: component.estimatedTokens,
      truncated: component.truncated,
      evidenceSliceCount: component.evidenceSliceCount,
      artifactRef: component.artifactRef,
      metadata: component.metadata,
    })),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function contextLedgerService(db: Db) {
  async function evaluatePromptBudget(input: {
    companyId: string;
    agentId?: string | null;
    issueId?: string | null;
    promptClass?: string | null;
    estimatedPromptTokens: number;
  }): Promise<{ status: PromptBudgetStatus; limitTokens: number | null; policyId: string | null }> {
    const conditions = [
      and(eq(promptBudgetPolicies.scopeType, "company"), eq(promptBudgetPolicies.scopeId, input.companyId)),
    ];
    if (input.agentId) {
      conditions.push(and(eq(promptBudgetPolicies.scopeType, "agent"), eq(promptBudgetPolicies.scopeId, input.agentId)));
    }
    if (input.issueId) {
      conditions.push(and(eq(promptBudgetPolicies.scopeType, "issue"), eq(promptBudgetPolicies.scopeId, input.issueId)));
    }

    const policies = await db
      .select()
      .from(promptBudgetPolicies)
      .where(and(eq(promptBudgetPolicies.companyId, input.companyId), eq(promptBudgetPolicies.isActive, true), or(...conditions)))
      .orderBy(desc(promptBudgetPolicies.updatedAt));

    const active = policies
      .filter((policy) => policy.maxPromptTokens > 0 || policy.warnPromptTokens > 0)
      .sort((a, b) => budgetSpecificity(b.scopeType) - budgetSpecificity(a.scopeType))[0];
    if (!active) {
      const defaultBudget = DEFAULT_PROMPT_BUDGETS_BY_CLASS[input.promptClass ?? ""];
      if (!defaultBudget) return { status: "ok", limitTokens: null, policyId: null };
      if (input.estimatedPromptTokens > defaultBudget.maxPromptTokens) {
        return { status: "hard_stop", limitTokens: defaultBudget.maxPromptTokens, policyId: DEFAULT_PROMPT_BUDGET_SLO_VERSION };
      }
      if (input.estimatedPromptTokens >= defaultBudget.warnPromptTokens) {
        return { status: "warning", limitTokens: defaultBudget.maxPromptTokens, policyId: DEFAULT_PROMPT_BUDGET_SLO_VERSION };
      }
      return { status: "ok", limitTokens: defaultBudget.maxPromptTokens, policyId: DEFAULT_PROMPT_BUDGET_SLO_VERSION };
    }

    if (
      active.maxPromptTokens > 0 &&
      input.estimatedPromptTokens > active.maxPromptTokens &&
      active.hardStopEnabled
    ) {
      return { status: "hard_stop", limitTokens: active.maxPromptTokens, policyId: active.id };
    }

    const warnAt = active.warnPromptTokens > 0
      ? active.warnPromptTokens
      : active.maxPromptTokens > 0
        ? Math.ceil(active.maxPromptTokens * 0.8)
        : 0;
    if (warnAt > 0 && input.estimatedPromptTokens >= warnAt) {
      return { status: "warning", limitTokens: active.maxPromptTokens || warnAt, policyId: active.id };
    }

    return { status: "ok", limitTokens: active.maxPromptTokens || null, policyId: active.id };
  }

  async function recordPreSpawn(input: ContextLedgerRecordInput) {
    const shape = extractPromptShape(input.meta);
    const wakeState = extractWakeState(input.context);
    const fingerprint = promptFingerprint({
      meta: input.meta,
      promptClass: shape.promptClass,
      promptBudgetVersion: shape.promptBudgetVersion,
      componentHashes: shape.componentHashes,
      estimatedPromptTokens: shape.estimatedPromptTokens,
    });
    const budget = await evaluatePromptBudget({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      promptClass: shape.promptClass,
      estimatedPromptTokens: shape.estimatedPromptTokens,
    });
    const metadata = {
      adapterInvocation: withoutRawPrompt(input.meta),
      evidenceSliceCount: shape.evidenceSliceCount,
      budgetPolicyId: budget.policyId,
      outputBudgetVersion: shape.outputBudgetVersion,
      outputBudget: Object.keys(shape.outputBudget).length > 0
        ? shape.outputBudget
        : DEFAULT_OUTPUT_BUDGETS_BY_CLASS.compact_status,
      executionRouting: nonEmptyRecordOrNull(asRecord(input.context).paperclipExecutionRouting),
      providerReliabilityGate: nonEmptyRecordOrNull(asRecord(input.context).paperclipProviderReliabilityGate),
      runtimeProvenance:
        nonEmptyRecordOrNull((input.meta as unknown as JsonRecord).runtimeProvenance) ??
        nonEmptyRecordOrNull(asRecord(input.context).paperclipRuntimeProvenance),
    };
    const contextPackRefs = shape.contextPackRefs.length > 0
      ? shape.contextPackRefs
      : extractContextPackRefs(input.context);

    const [entry] = await db
      .insert(contextLedgerEntries)
      .values({
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
        issueId: input.issueId ?? null,
        taskKey: input.taskKey ?? null,
        cwd: input.meta.cwd ?? null,
        branch: input.branch ?? null,
        adapterType: input.adapterType,
        adapterVersion: input.adapterVersion ?? readString((input.meta as unknown as JsonRecord).adapterVersion),
        promptClass: shape.promptClass,
        promptBudgetVersion: shape.promptBudgetVersion,
        promptFingerprint: fingerprint,
        promptChars: shape.promptChars,
        estimatedPromptTokens: shape.estimatedPromptTokens,
        componentHashes: shape.componentHashes,
        artifactRefs: shape.artifactRefs,
        contextPackRefs,
        sessionIdBefore: input.sessionIdBefore ?? readString(shape.metrics.sessionIdBefore),
        commentCursor: wakeState.commentCursor,
        wakeCursor: wakeState.wakeCursor,
        estimatedInputTokens: shape.estimatedPromptTokens,
        budgetStatus: budget.status,
        budgetLimitTokens: budget.limitTokens,
        responseClass: "compact_status",
        outputBudgetVersion: shape.outputBudgetVersion,
        outputBudgetStatus: "ok",
        outputBudgetLimitTokens: DEFAULT_OUTPUT_BUDGETS_BY_CLASS.compact_status.maxOutputTokens,
        redactionApplied: true,
        metadata,
      })
      .returning();

    if (!entry) throw new Error("Failed to create context ledger entry");

    if (shape.components.length > 0) {
      await db.insert(contextLedgerComponents).values(
        shape.components.map((component) => ({
          entryId: entry.id,
          companyId: input.companyId,
          name: component.name,
          componentType: component.componentType,
          contentSha256: component.contentSha256,
          chars: component.chars,
          estimatedTokens: component.estimatedTokens,
          truncated: component.truncated,
          evidenceSliceCount: component.evidenceSliceCount,
          artifactRef: Object.keys(component.artifactRef).length > 0 ? component.artifactRef : null,
          metadata: component.metadata,
        })),
      );
    }

    const existingCursor = await db
      .select()
      .from(agentContextCursors)
      .where(
        and(
          eq(agentContextCursors.companyId, input.companyId),
          eq(agentContextCursors.agentId, input.agentId),
          eq(agentContextCursors.taskKey, input.taskKey ?? ""),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const nextCommentCursor = isNewerCursor(wakeState.commentCursor, existingCursor?.commentCursor)
      ? wakeState.commentCursor
      : asRecord(existingCursor?.commentCursor);
    const nextLatestCommentId = isNewerCursor(wakeState.commentCursor, existingCursor?.commentCursor)
      ? wakeState.latestCommentId
      : existingCursor?.latestCommentId ?? wakeState.latestCommentId;
    const nextWakeCount = Math.max(existingCursor?.wakeCount ?? 0, wakeState.wakeCount);

    await db
      .insert(agentContextCursors)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId ?? null,
        taskKey: input.taskKey ?? "",
        latestCommentId: nextLatestCommentId ?? null,
        commentCursor: nextCommentCursor,
        wakeCursor: wakeState.wakeCursor,
        wakeCount: nextWakeCount,
        lastRunId: input.runId,
        sessionDisplayId: input.sessionIdBefore ?? null,
      })
      .onConflictDoUpdate({
        target: [
          agentContextCursors.companyId,
          agentContextCursors.agentId,
          agentContextCursors.taskKey,
        ],
        set: {
          issueId: input.issueId ?? null,
          latestCommentId: nextLatestCommentId ?? null,
          commentCursor: nextCommentCursor,
          wakeCursor: sql`excluded.wake_cursor`,
          wakeCount: nextWakeCount,
          lastRunId: input.runId,
          sessionDisplayId: input.sessionIdBefore ?? null,
          updatedAt: new Date(),
        },
      });

    if (budget.status === "hard_stop") {
      throw conflict("Prompt budget exceeded before adapter spawn", {
        contextLedgerEntryId: entry.id,
        promptClass: entry.promptClass,
        estimatedPromptTokens: entry.estimatedPromptTokens,
        budgetLimitTokens: entry.budgetLimitTokens,
        promptFingerprint: entry.promptFingerprint,
      });
    }

    return entry;
  }

  async function finalizeRun(input: ContextLedgerFinalizeInput) {
    const resultReceiptPaths = extractReceiptPaths(input.resultJson);
    const inputReceiptPaths = [...new Set([...(input.receiptPaths ?? []), ...resultReceiptPaths])];
    const resultJson = asRecord(input.resultJson);
    const entries = await db
      .select()
      .from(contextLedgerEntries)
      .where(eq(contextLedgerEntries.runId, input.runId));
    const issueIds = [
      ...new Set(entries.map((entry) => entry.issueId).filter((entry): entry is string => Boolean(entry))),
    ];
    const issueIdentifiersById = new Map(
      issueIds.length > 0
        ? await db
            .select({ id: issues.id, identifier: issues.identifier })
            .from(issues)
            .where(inArray(issues.id, issueIds))
            .then((rows) => rows.map((row) => [row.id, readString(row.identifier)] as const))
        : [],
    );

    for (const entry of entries) {
      const issueIdentifier = entry.issueId ? issueIdentifiersById.get(entry.issueId) ?? null : null;
      const receiptPaths = filterReceiptPathsForIssue([
        ...extractReceiptPaths(entry.receiptPaths),
        ...inputReceiptPaths,
      ], issueIdentifier);
      const resultArtifactRefs = mergeArtifactRefs(
        normalizeArtifactRefs(resultJson.artifactRefs),
        normalizeArtifactRefs(resultJson.artifactHashes),
        artifactRefsFromReceiptPaths(receiptPaths),
      );
      const resultUsage = extractUsageFromResultJson(resultJson);
      const actualInputTokens = positiveNumber(input.usage?.inputTokens) ?? resultUsage.inputTokens;
      const cachedInputTokens = positiveNumber(input.usage?.cachedInputTokens) ?? resultUsage.cachedInputTokens;
      const actualOutputTokens = positiveNumber(input.usage?.outputTokens) ?? resultUsage.outputTokens;
      const finalResponseText = extractFinalResponseText(resultJson);
      const finalResponseChars = finalResponseText?.length ?? null;
      const finalResponseSentenceCount = countApproxSentences(finalResponseText);
      const finalResponseSha256 = finalResponseText ? sha256(finalResponseText) : null;
      const estimatedOutputTokens = estimateTokensFromText(finalResponseText);
      const finalBlocker = readBlocker(input.resultJson, input.blocker, input.outcome);
      const finalDisposition = resolveFinalDisposition({
        outcome: input.outcome,
        resultJson,
        blocker: finalBlocker,
        finalResponseText,
      });
      const goLiveDelta = extractGoLiveDelta({
        resultJson,
        finalResponseText,
        finalDisposition,
      });
      const goLiveDeltaEvaluation = evaluateGoLiveDelta({
        delta: goLiveDelta,
        finalDisposition,
        issueId: entry.issueId,
        artifactRefs: resultArtifactRefs,
        receiptPaths,
        outcome: input.outcome,
      });
      const outputBudget = classifyOutputBudget({
        outcome: input.outcome,
        resultJson,
        finalResponseText,
        actualOutputTokens,
        estimatedOutputTokens,
        finalResponseChars,
        finalResponseSentenceCount,
      });
      const finalResponseArtifactRefs = finalResponseSha256
        ? [
            {
              kind: "final_response",
              sha256: finalResponseSha256,
              chars: finalResponseChars,
              estimatedTokens: estimatedOutputTokens,
            },
          ]
        : [];
      const uncachedInputTokens =
        actualInputTokens != null && cachedInputTokens != null
          ? Math.max(0, actualInputTokens - cachedInputTokens)
          : actualInputTokens;
      const actualBudgetWarning =
        entry.budgetLimitTokens != null &&
        entry.budgetLimitTokens > 0 &&
        ((actualInputTokens ?? 0) > entry.budgetLimitTokens ||
          (uncachedInputTokens ?? 0) > entry.budgetLimitTokens);
      const budgetStatus =
        entry.budgetStatus === "hard_stop"
          ? "hard_stop"
          : actualBudgetWarning
            ? "warning"
            : entry.budgetStatus;
      const metadata = {
        ...asRecord(entry.metadata),
        actualUsageBudget: {
          actualInputTokens,
          cachedInputTokens,
          uncachedInputTokens,
          budgetLimitTokens: entry.budgetLimitTokens,
          warning: actualBudgetWarning,
        },
        outputUsageBudget: {
          responseClass: outputBudget.responseClass,
          outputBudgetVersion: entry.outputBudgetVersion,
          actualOutputTokens,
          estimatedOutputTokens,
          finalResponseChars,
          finalResponseSentenceCount,
          outputBudgetLimitTokens: outputBudget.outputBudgetLimitTokens,
          outputBudgetStatus: outputBudget.outputBudgetStatus,
          expansionReason: outputBudget.expansionReason,
          observedOutputTokens: outputBudget.observedOutputTokens,
          outputBudget: outputBudget.outputBudget,
        },
        finalDisposition,
        goLiveDelta,
        goLiveDeltaEvaluation,
      };
      await db
        .update(contextLedgerEntries)
        .set({
          sessionIdAfter: input.sessionIdAfter ?? null,
          actualInputTokens,
          actualOutputTokens,
          cachedInputTokens,
          budgetStatus,
          responseClass: outputBudget.responseClass,
          estimatedOutputTokens,
          outputBudgetStatus: outputBudget.outputBudgetStatus,
          outputBudgetLimitTokens: outputBudget.outputBudgetLimitTokens,
          finalResponseChars,
          finalResponseSentenceCount,
          finalResponseSha256,
          finalResponseArtifactRefs,
          finalOutcome: input.outcome,
          finalBlocker,
          receiptPaths,
          artifactRefs: mergeArtifactRefs(normalizeArtifactRefs(entry.artifactRefs), resultArtifactRefs),
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(contextLedgerEntries.id, entry.id));
    }
  }

  async function listForRun(runId: string) {
    const entries = await db
      .select()
      .from(contextLedgerEntries)
      .where(eq(contextLedgerEntries.runId, runId))
      .orderBy(desc(contextLedgerEntries.createdAt));
    if (entries.length === 0) return [];
    const components = await db
      .select()
      .from(contextLedgerComponents)
      .where(inArray(contextLedgerComponents.entryId, entries.map((entry) => entry.id)));
    return entries.map((entry) =>
      toReadModel(entry, components.filter((component) => component.entryId === entry.id)),
    );
  }

  async function listForIssue(companyId: string, issueId: string) {
    const entries = await db
      .select()
      .from(contextLedgerEntries)
      .where(and(eq(contextLedgerEntries.companyId, companyId), eq(contextLedgerEntries.issueId, issueId)))
      .orderBy(desc(contextLedgerEntries.createdAt));
    if (entries.length === 0) return [];
    const components = await db
      .select()
      .from(contextLedgerComponents)
      .where(inArray(contextLedgerComponents.entryId, entries.map((entry) => entry.id)));
    return entries.map((entry) =>
      toReadModel(entry, components.filter((component) => component.entryId === entry.id)),
    );
  }

  return {
    evaluatePromptBudget,
    recordPreSpawn,
    finalizeRun,
    listForRun,
    listForIssue,
  };
}
