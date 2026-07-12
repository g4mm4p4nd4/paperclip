import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { sanitizeSecretText } from "../redaction.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
  compaction?: {
    originalBytes: number;
    compactedSnapshots: number;
    finalSnapshotSha256?: string;
  };
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

type MessageUpdateCompactionState = {
  firstSha256: string;
  latestSha256: string;
  latestChunk: string;
  latestText: string;
  latestTs: string;
  latestStream: "stdout" | "stderr" | "system";
  compactedSnapshots: number;
  originalBytes: number;
};

const compactionStates = new Map<string, MessageUpdateCompactionState>();

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonLine(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function isMessageUpdateSnapshot(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record.type === "message_update" ||
    record.kind === "message_update" ||
    record.event === "message_update" ||
    record.eventType === "message_update"
  );
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const texts: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if ((key === "text" || key === "content" || key === "delta") && typeof entry === "string") {
      texts.push(entry);
      continue;
    }
    if (typeof entry === "object") {
      texts.push(...collectText(entry, depth + 1));
    }
  }
  return texts;
}

function extractSnapshotText(parsed: unknown): string {
  return collectText(parsed).join("");
}

function textDelta(previous: string, next: string) {
  let prefixChars = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefixChars < maxPrefix && previous[prefixChars] === next[prefixChars]) prefixChars += 1;

  let suffixChars = 0;
  const maxSuffix = Math.min(previous.length - prefixChars, next.length - prefixChars);
  while (
    suffixChars < maxSuffix &&
    previous[previous.length - 1 - suffixChars] === next[next.length - 1 - suffixChars]
  ) {
    suffixChars += 1;
  }

  return {
    prefixChars,
    suffixChars,
    removeChars: previous.length - prefixChars - suffixChars,
    insert: next.slice(prefixChars, next.length - suffixChars),
  };
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function writeLogLine(absPath: string, line: Record<string, unknown>) {
    await fs.appendFile(absPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");
      compactionStates.delete(relPath);

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      // The store is the final persistence boundary. Callers should redact
      // provider-specific exact values, but recognized credential shapes must
      // never reach disk even when a future or legacy caller forgets.
      const chunk = sanitizeSecretText(event.chunk);
      const parsed = parseJsonLine(chunk);
      const snapshotHash = sha256Text(chunk);
      if (isMessageUpdateSnapshot(parsed)) {
        const snapshotText = extractSnapshotText(parsed);
        const existing = compactionStates.get(handle.logRef);
        if (!existing) {
          compactionStates.set(handle.logRef, {
            firstSha256: snapshotHash,
            latestSha256: snapshotHash,
            latestChunk: chunk,
            latestText: snapshotText,
            latestTs: event.ts,
            latestStream: event.stream,
            compactedSnapshots: 0,
            originalBytes: Buffer.byteLength(chunk, "utf8"),
          });
          await writeLogLine(absPath, {
            ts: event.ts,
            stream: event.stream,
            chunk,
            compaction: {
              type: "message_update_first_snapshot",
              snapshotSha256: snapshotHash,
              originalBytes: Buffer.byteLength(chunk, "utf8"),
            },
          });
          return;
        }

        const previousSha256 = existing.latestSha256;
        const delta = textDelta(existing.latestText, snapshotText);
        existing.compactedSnapshots += 1;
        existing.originalBytes += Buffer.byteLength(chunk, "utf8");
        existing.latestSha256 = snapshotHash;
        existing.latestChunk = chunk;
        existing.latestText = snapshotText;
        existing.latestTs = event.ts;
        existing.latestStream = event.stream;
        await writeLogLine(absPath, {
          ts: event.ts,
          stream: event.stream,
          chunk: `[paperclip] compacted message_update snapshot ${snapshotHash.slice(0, 12)} (${delta.insert.length} inserted chars)`,
          compaction: {
            type: "message_update_delta",
            previousSha256,
            snapshotSha256: snapshotHash,
            originalBytes: Buffer.byteLength(chunk, "utf8"),
            textDelta: delta,
          },
        });
        return;
      }

      await writeLogLine(absPath, {
        ts: event.ts,
        stream: event.stream,
        chunk,
      });
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const compactionState = compactionStates.get(handle.logRef);
      if (compactionState && compactionState.compactedSnapshots > 0) {
        await writeLogLine(absPath, {
          ts: compactionState.latestTs,
          stream: compactionState.latestStream,
          chunk: compactionState.latestChunk,
          compaction: {
            type: "message_update_final_snapshot",
            firstSha256: compactionState.firstSha256,
            snapshotSha256: compactionState.latestSha256,
            compactedSnapshots: compactionState.compactedSnapshots,
            originalBytes: Buffer.byteLength(compactionState.latestChunk, "utf8"),
          },
        });
      }
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      compactionStates.delete(handle.logRef);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
        ...(compactionState
          ? {
              compaction: {
                originalBytes: compactionState.originalBytes,
                compactedSnapshots: compactionState.compactedSnapshots,
                finalSnapshotSha256: compactionState.latestSha256,
              },
            }
          : {}),
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function resetRunLogStoreForTests() {
  cachedStore = null;
  compactionStates.clear();
}

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}
