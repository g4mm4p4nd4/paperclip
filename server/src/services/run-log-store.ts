import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

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

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    // Try .ndjson first, then fall back to .ndjson.gz for transparent decompression
    let gzipped = false;
    let stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      const gzPath = filePath + ".gz";
      stat = await fs.stat(gzPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");
      filePath = gzPath;
      gzipped = true;
    }

    // For gzipped files, decompress entirely into memory, then serve byte range.
    // This is acceptable because gzipped logs are old/infrequently accessed and
    // typically under 2MB compressed.
    if (gzipped) {
      const compressed = await fs.readFile(filePath);
      const decompressed = await new Promise<Buffer>((resolve, reject) => {
        const gunzip = createGunzip();
        const chunks: Buffer[] = [];
        gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
        gunzip.on("error", reject);
        gunzip.on("end", () => resolve(Buffer.concat(chunks)));
        gunzip.end(compressed);
      });

      const size = decompressed.length;
      const gzStart = Math.max(0, Math.min(offset, size));
      const gzEnd = Math.max(gzStart, Math.min(gzStart + limitBytes - 1, size - 1));

      if (gzStart > gzEnd) {
        return { content: "", nextOffset: gzStart };
      }

      const content = decompressed.toString("utf8", gzStart, gzEnd + 1);
      const nextOffset = gzEnd + 1 < size ? gzEnd + 1 : undefined;
      return { content, nextOffset };
    }

    // Original byte-range stream read for uncompressed files
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

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      await fs.appendFile(absPath, `${line}\n`, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
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

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompressRunLogsResult {
  scanned: number;
  compressed: number;
  bytesReclaimed: number;
  errors: number;
}

/**
 * Walk the run-logs directory tree and gzip .ndjson files older than the
 * specified age threshold. Gzipped files retain their .ndjson extension with
 * an additional .gz suffix (.ndjson.gz). Original files are removed after
 * successful compression.
 *
 * This is safe to call concurrently with active log writes because:
 * 1. Logs being actively appended have recent mtime and are skipped
 * 2. Concurrent-modification detection aborts and preserves the original
 */
export async function compressOldRunLogs(ageDays: number): Promise<CompressRunLogsResult> {
  const basePath = getRunLogStoreBasePath();
  return compressNdjsonFiles(basePath, ageDays);
}

/**
 * Resolve the run-logs base path (same logic as getRunLogStore)
 */
function getRunLogStoreBasePath(): string {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

async function compressNdjsonFiles(dirPath: string, ageDays: number): Promise<CompressRunLogsResult> {
  const result: CompressRunLogsResult = { scanned: 0, compressed: 0, bytesReclaimed: 0, errors: 0 };
  const files = await findNdjsonFiles(dirPath);
  result.scanned = files.length;

  const cutoffAge = ageDays * DAY_MS;
  const now = Date.now();

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      const age = now - stat.mtimeMs;
      if (age < cutoffAge) continue;

      const saved = await gzipNdjsonFile(filePath);
      if (saved > 0) {
        result.compressed++;
        result.bytesReclaimed += saved;
      }
    } catch (err) {
      logger.error({ err, filePath }, "Failed to compress run log");
      result.errors++;
    }
  }

  return result;
}

async function findNdjsonFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await findNdjsonFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
        results.push(fullPath);
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err, dirPath }, "Cannot scan run-log directory");
    }
  }
  return results;
}

async function gzipNdjsonFile(filePath: string): Promise<number> {
  const gzPath = filePath + ".gz";
  const stat = await fs.stat(filePath);
  const size = stat.size;

  // Skip empty files
  if (size === 0) return 0;

  // Stream-gzip the file
  await new Promise<void>((resolve, reject) => {
    const readStream = createReadStream(filePath);
    const writeStream = createWriteStream(gzPath);
    const gzip = createGzip();
    readStream.pipe(gzip).pipe(writeStream);
    writeStream.on("finish", () => resolve());
    writeStream.on("error", reject);
    readStream.on("error", reject);
    gzip.on("error", reject);
  });

  // Verify the original file wasn't modified during compression
  const finalStat = await fs.stat(filePath);
  if (finalStat.mtimeMs !== stat.mtimeMs || finalStat.size !== stat.size) {
    // File was modified during compression — abort, keep original
    await fs.unlink(gzPath).catch(() => {});
    logger.warn({ filePath }, "Skipping compression: file was modified concurrently");
    return 0;
  }

  // Remove the original
  await fs.unlink(filePath);

  logger.info(
    { filePath, size, compressedSize: (await fs.stat(gzPath)).size },
    "Compressed run log",
  );

  return size;
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}

