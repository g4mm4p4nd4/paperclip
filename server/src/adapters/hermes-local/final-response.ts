export function isIncompleteHermesFinalResponse(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let text = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!text) return false;

  text = text.replace(
    /^(?:\s*<(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning|thought|REASONING_SCRATCHPAD)>\s*)+/i,
    "",
  ).trim();

  if (/^<[^>]*(?:tool_calls?|function_calls?)[^>]*>/i.test(text)) {
    const closingPattern = /<\/[^>]*(?:tool_calls?|function_calls?)[^>]*>/gi;
    let lastClosingEnd = 0;
    for (const match of text.matchAll(closingPattern)) {
      lastClosingEnd = (match.index ?? 0) + match[0].length;
    }
    return lastClosingEnd === 0 || !text.slice(lastClosingEnd).trim();
  }

  const malformedJsonToolPrefix = /^\{\s*"(?:tool_calls?|function_calls?)"\s*:/i.test(text);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return malformedJsonToolPrefix;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const record = payload as Record<string, unknown>;
  const hasToolPayload = ["tool_call", "tool_calls", "function_call", "function_calls"]
    .some((key) => Object.hasOwn(record, key)) || ["tool_call", "function_call"]
    .includes(String(record.type ?? "").trim().toLowerCase());
  if (!hasToolPayload) return false;
  return !["content", "final_response", "summary", "result", "message"]
    .some((key) => typeof record[key] === "string" && record[key].trim());
}
