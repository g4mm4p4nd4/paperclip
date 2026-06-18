export type GeminiTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumber(value: unknown, fallback = 0): number {
  return readFiniteNumber(value) ?? fallback;
}

function emptyUsage(): GeminiTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function hasUsage(usage: GeminiTokenUsage): boolean {
  return usage.inputTokens > 0 || usage.cachedInputTokens > 0 || usage.outputTokens > 0;
}

function addUsage(target: GeminiTokenUsage, source: GeminiTokenUsage) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
}

function normalizeUsage(usage: GeminiTokenUsage): GeminiTokenUsage {
  return {
    inputTokens: Math.max(0, Math.floor(usage.inputTokens)),
    cachedInputTokens: Math.max(0, Math.floor(usage.cachedInputTokens)),
    outputTokens: Math.max(0, Math.floor(usage.outputTokens)),
  };
}

function readOpenAiOrGeminiUsagePayload(raw: unknown): GeminiTokenUsage {
  const usage = asRecord(raw);
  if (!usage) return emptyUsage();
  const usageMetadata = asRecord(usage.usageMetadata);
  const source = usageMetadata ?? usage;
  return normalizeUsage({
    inputTokens: readNumber(
      source.input_tokens,
      readNumber(source.inputTokens, readNumber(source.promptTokenCount)),
    ),
    cachedInputTokens: readNumber(
      source.cached_input_tokens,
      readNumber(source.cachedInputTokens, readNumber(source.cachedContentTokenCount)),
    ),
    outputTokens: readNumber(
      source.output_tokens,
      readNumber(source.outputTokens, readNumber(source.candidatesTokenCount)),
    ),
  });
}

function readStatsPayload(raw: unknown): GeminiTokenUsage {
  const stats = asRecord(raw);
  if (!stats) return emptyUsage();

  const cachedInputTokens = readNumber(
    stats.cached,
    readNumber(
      stats.cached_input_tokens,
      readNumber(stats.cachedInputTokens, readNumber(stats.cachedContentTokenCount)),
    ),
  );
  const explicitUncachedInput = readFiniteNumber(stats.input);
  const totalInputTokens = readFiniteNumber(stats.input_tokens) ??
    readFiniteNumber(stats.inputTokens) ??
    readFiniteNumber(stats.promptTokenCount);
  const inputTokens = explicitUncachedInput ??
    (totalInputTokens === null ? 0 : Math.max(0, totalInputTokens - cachedInputTokens));
  const outputTokens = readNumber(
    stats.output_tokens,
    readNumber(stats.output, readNumber(stats.outputTokens, readNumber(stats.candidatesTokenCount))),
  );

  const directUsage = normalizeUsage({
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });
  if (hasUsage(directUsage)) return directUsage;

  const models = asRecord(stats.models);
  if (!models) return directUsage;
  const modelUsage = emptyUsage();
  for (const value of Object.values(models)) {
    addUsage(modelUsage, readStatsPayload(value));
  }
  return normalizeUsage(modelUsage);
}

export function readGeminiUsageFromEvent(eventRaw: unknown): GeminiTokenUsage {
  const event = asRecord(eventRaw);
  if (!event) return emptyUsage();

  const usage = event.usage !== undefined || event.usageMetadata !== undefined
    ? readOpenAiOrGeminiUsagePayload(event.usage ?? event.usageMetadata)
    : emptyUsage();
  if (hasUsage(usage)) return usage;

  return readStatsPayload(event.stats);
}
