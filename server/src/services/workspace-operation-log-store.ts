import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { logger } from "../middleware/logger.js";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type WorkspaceOperationLogStoreType = "local_file";

export interface WorkspaceOperationLogHandle {
  store: WorkspaceOperationLogStoreType;
  logRef: string;
}

export interface WorkspaceOperationLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface WorkspaceOperationLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface WorkspaceOperationLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface WorkspaceOperationLogStore {
  begin(input: { companyId: string; operationId: string }): Promise<WorkspaceOperationLogHandle>;
  append(
    handle: WorkspaceOperationLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: WorkspaceOperationLogHandle): Promise<WorkspaceOperationLogFinalizeSummary>;
  read(handle: WorkspaceOperationLogHandle, opts?: WorkspaceOperationLogReadOptions): Promise<WorkspaceOperationLogReadResult>;
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

function createLocalFileWorkspaceOperationLogStore(basePath: string): WorkspaceOperationLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    // Try .ndjson first, then fall back to .ndjson.gz for transparent decompression
    let gzipped = false;
    let stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      const gzPath = filePath + ".gz";
      stat = await fs.stat(gzPath).catch(() => null);
      if (!stat) throw notFound("Workspace operation log not found");
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
      const [companyId] = safeSegments(input.companyId);
      const operationId = safeSegments(input.operationId)[0]!;
      const relDir = companyId;
      const relPath = path.join(relDir, `${operationId}.ndjson`);
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
      if (!stat) throw notFound("Workspace operation log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Workspace operation log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CompressWorkspaceOperationLogsResult {
  scanned: number;
  compressed: number;
  bytesReclaimed: number;
  errors: number;
}

/**
 * Walk the workspace-operation-logs directory tree and gzip .ndjson files
 * older than the specified age threshold. Same safety guarantees as
 * compressOldRunLogs.
 */
export async function compressOldWorkspaceOperationLogs(ageDays: number): Promise<CompressWorkspaceOperationLogsResult> {
  const basePath = getWorkspaceOperationLogStoreBasePath();
  return compressNdjsonFiles(basePath, ageDays);
}

function getWorkspaceOperationLogStoreBasePath(): string {
  return process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
}

async function compressNdjsonFiles(dirPath: string, ageDays: number): Promise<CompressWorkspaceOperationLogsResult> {
  const result: CompressWorkspaceOperationLogsResult = { scanned: 0, compressed: 0, bytesReclaimed: 0, errors: 0 };
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
      logger.error({ err, filePath }, "Failed to compress workspace operation log");
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
      logger.warn({ err, dirPath }, "Cannot scan workspace-operation-log directory");
    }
  }
  return results;
}

async function gzipNdjsonFile(filePath: string): Promise<number> {
  const gzPath = filePath + ".gz";
  const stat = await fs.stat(filePath);
  const size = stat.size;

  if (size === 0) return 0;

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

  const finalStat = await fs.stat(filePath);
  if (finalStat.mtimeMs !== stat.mtimeMs || finalStat.size !== stat.size) {
    await fs.unlink(gzPath).catch(() => {});
    logger.warn({ filePath }, "Skipping compression: file was modified concurrently");
    return 0;
  }

  await fs.unlink(filePath);

  logger.info(
    { filePath, size, compressedSize: (await fs.stat(gzPath)).size },
    "Compressed workspace operation log",
  );

  return size;
}

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
  cachedStore = createLocalFileWorkspaceOperationLogStore(basePath);
  return cachedStore;
}
