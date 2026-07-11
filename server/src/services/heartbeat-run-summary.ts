import { isIncompleteHermesFinalResponse } from "../adapters/hermes-local/final-response.js";

function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (isProtocolOnlyText(trimmed)) return null;
  return trimmed.length > 0 ? trimmed : null;
}

function isProtocolOnlyText(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^session[_ -]?id:\s*\S+$/i.test(line));
}

const HEARTBEAT_ISSUE_COMMENT_MAX_CHARS = 1_200;
const HEARTBEAT_ISSUE_COMMENT_MAX_SENTENCES = 7;

function countSentences(value: string): number {
  const matches = value.replace(/\s+/g, " ").match(/[.!?](?:\s|$)/g);
  return matches?.length ?? (value.trim().length > 0 ? 1 : 0);
}

function splitSentences(value: string): string[] {
  return (
    value
      .replace(/\s+/g, " ")
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function compactHeartbeatIssueCommentText(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length <= HEARTBEAT_ISSUE_COMMENT_MAX_CHARS &&
    countSentences(trimmed) <= HEARTBEAT_ISSUE_COMMENT_MAX_SENTENCES
  ) {
    return trimmed;
  }

  const lead = splitSentences(trimmed).slice(0, 3);
  const evidenceLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      /receipt|artifact|changed files?|tests?|passed|failed|blocker|error|sha256|path/i.test(line),
    )
    .slice(0, 6);
  const lines = [...new Set([...lead, ...evidenceLines])];
  const footer = "Full detail remains in the run log/result and context ledger.";
  let compact = [...lines, footer].filter(Boolean).join("\n").trim();
  if (compact.length <= HEARTBEAT_ISSUE_COMMENT_MAX_CHARS) return compact;
  const room = Math.max(0, HEARTBEAT_ISSUE_COMMENT_MAX_CHARS - footer.length - 2);
  compact = `${compact.slice(0, room).trimEnd()}\n${footer}`;
  return compact.slice(0, HEARTBEAT_ISSUE_COMMENT_MAX_CHARS);
}

function collectText(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) collected.push(trimmed);
    return collected;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, collected);
    return collected;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectText(entry, collected);
    }
  }

  return collected;
}

function sanitizeJsonbString(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) continue;

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i] + value[i + 1];
        i += 1;
      } else {
        result += "\ufffd";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
      continue;
    }

    result += value[i];
  }
  return result;
}

function sanitizeJsonbValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeJsonbString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonbValue(entry));
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    sanitized[sanitizeJsonbString(key)] = sanitizeJsonbValue(entry);
  }
  return sanitized;
}

export function sanitizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }
  const sanitized = sanitizeJsonbValue(resultJson);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;
  const sanitizedSummary = normalizedSummary ? sanitizeJsonbString(normalizedSummary) : null;

  if (!baseResult) {
    return sanitizedSummary ? { summary: sanitizedSummary } : null;
  }

  const sanitizedBaseResult = sanitizeHeartbeatRunResultJson(baseResult);
  if (!sanitizedBaseResult) {
    return sanitizedSummary ? { summary: sanitizedSummary } : null;
  }

  if (!sanitizedSummary) {
    return sanitizedBaseResult;
  }

  if (readCommentText(sanitizedBaseResult.summary)) {
    return sanitizedBaseResult;
  }

  return {
    ...sanitizedBaseResult,
    summary: sanitizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

const TERMINAL_ADAPTER_FAILURE_PATTERNS = [
  /api call failed after \d+ retries/i,
  /max retries \(\d+\) exceeded\.\s*giving up/i,
  /final error:\s*http\s+\d+/i,
];

export function inferHeartbeatRunResultFailure(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): { code: "adapter_failed"; message: string } | null {
  const explicitFinalCandidates = [
    summary,
    resultJson?.summary,
    resultJson?.result,
    resultJson?.message,
  ];
  if (explicitFinalCandidates.some(isIncompleteHermesFinalResponse)) {
    return {
      code: "adapter_failed",
      message: "Adapter returned an incomplete tool-call envelope instead of a final response.",
    };
  }

  const merged = mergeHeartbeatRunResultJson(resultJson, summary);
  if (!merged) return null;

  const text = collectText(merged).join("\n");
  if (!TERMINAL_ADAPTER_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }

  const failureLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /api call failed after \d+ retries/i.test(line))
    ?? text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /final error:/i.test(line))
    ?? "Adapter reported a terminal failure despite exiting successfully.";

  return {
    code: "adapter_failed",
    message: failureLine.slice(0, 1000),
  };
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const comment = (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
  return comment ? compactHeartbeatIssueCommentText(comment) : null;
}
