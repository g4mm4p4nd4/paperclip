import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_UNTRACKED_FILES = 1000;
const MAX_UNTRACKED_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 512 * 1024 * 1024;
const SECRET_LIKE_VALUE = /(?:\b(?:bearer|basic)\s+[a-z0-9._~+\-/=]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth|token|secret|password|cookie|recovery[_-]?code|verification[_-]?code|phone[_-]?number|mfa|otp)\s*[=:]\s*[^\s,;]{6,}|\bsk-[a-z0-9_-]{16,}\b|\b(?:ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b)/i;

export type ProfitFlywheelWorkspaceSnapshot = {
  workspaceRoot: string;
  headGitObject: string;
  branch: string;
  trackedDiffSha256: string;
  indexDiffSha256: string;
  statusSha256: string;
  untracked: Array<{ path: string; sha256: string; bytes: number }>;
  observedAt: string;
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function gitOutput(workspaceRoot: string, args: string[], maxBuffer = 128 * 1024 * 1024) {
  const result = await execFile("git", ["-C", workspaceRoot, ...args], {
    maxBuffer,
    timeout: 30_000,
    encoding: "utf8",
  });
  return result.stdout;
}

function workspacePathspec() {
  return ["--", ".", ":(exclude).paperclip/**"];
}

function assertSafeRelativePath(relativePath: string, workspaceRoot: string) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error("Profit Flywheel checkpoint contains an unsafe untracked path");
  }
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (absolutePath === workspaceRoot || !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Profit Flywheel checkpoint untracked path escapes the workspace");
  }
  return absolutePath;
}

function assertSnapshotReceiptSafe(snapshot: ProfitFlywheelWorkspaceSnapshot) {
  const strings = [
    snapshot.workspaceRoot,
    snapshot.headGitObject,
    snapshot.branch,
    snapshot.trackedDiffSha256,
    snapshot.indexDiffSha256,
    snapshot.statusSha256,
    snapshot.observedAt,
    ...snapshot.untracked.flatMap((entry) => [entry.path, entry.sha256]),
  ];
  if (strings.some((value) => value.length > 10_000 || SECRET_LIKE_VALUE.test(value))) {
    throw new Error("Profit Flywheel checkpoint contains secret-like or oversized receipt material");
  }
}

export async function captureProfitFlywheelWorkspaceSnapshot(
  workspaceRootInput: string,
): Promise<ProfitFlywheelWorkspaceSnapshot> {
  const workspaceRoot = await realpath(workspaceRootInput);
  const pathspec = workspacePathspec();
  const [headRaw, branchRaw, trackedDiff, indexDiff, status, untrackedRaw] = await Promise.all([
    gitOutput(workspaceRoot, ["rev-parse", "HEAD"]),
    gitOutput(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitOutput(workspaceRoot, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", ...pathspec]),
    gitOutput(workspaceRoot, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "HEAD", ...pathspec]),
    gitOutput(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec]),
    gitOutput(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]),
  ]);
  const headGitObject = headRaw.trim().toLowerCase();
  const branch = branchRaw.trim();
  if (!/^[a-f0-9]{40,64}$/.test(headGitObject) || !branch) {
    throw new Error("Profit Flywheel checkpoint workspace lacks a valid Git HEAD or branch authority");
  }
  const relativePaths = untrackedRaw.split("\0").filter(Boolean).sort();
  if (relativePaths.length > MAX_UNTRACKED_FILES) {
    throw new Error(`Profit Flywheel checkpoint exceeds the ${MAX_UNTRACKED_FILES}-file untracked artifact limit`);
  }
  const untracked: ProfitFlywheelWorkspaceSnapshot["untracked"] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = assertSafeRelativePath(relativePath, workspaceRoot);
    const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_UNTRACKED_FILE_BYTES) {
        throw new Error("Profit Flywheel checkpoint untracked artifacts must be regular files no larger than 100 MiB");
      }
      totalBytes += before.size;
      if (totalBytes > MAX_UNTRACKED_TOTAL_BYTES) {
        throw new Error("Profit Flywheel checkpoint exceeds the 512 MiB total untracked artifact limit");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || bytes.length !== before.size
      ) {
        throw new Error("Profit Flywheel checkpoint artifact changed while it was being hashed");
      }
      untracked.push({ path: relativePath, sha256: sha256(bytes), bytes: bytes.length });
    } finally {
      await handle.close();
    }
  }
  const snapshot = {
    workspaceRoot,
    headGitObject,
    branch,
    trackedDiffSha256: sha256(trackedDiff),
    indexDiffSha256: sha256(indexDiff),
    statusSha256: sha256(status),
    untracked,
    observedAt: new Date().toISOString(),
  };
  assertSnapshotReceiptSafe(snapshot);
  return snapshot;
}

export async function revalidateProfitFlywheelWorkspaceSnapshot(
  expected: ProfitFlywheelWorkspaceSnapshot,
) {
  assertSnapshotReceiptSafe(expected);
  const current = await captureProfitFlywheelWorkspaceSnapshot(expected.workspaceRoot);
  const expectedState = {
    workspaceRoot: expected.workspaceRoot,
    headGitObject: expected.headGitObject,
    branch: expected.branch,
    trackedDiffSha256: expected.trackedDiffSha256,
    indexDiffSha256: expected.indexDiffSha256,
    statusSha256: expected.statusSha256,
    untracked: expected.untracked,
  };
  const currentState = {
    workspaceRoot: current.workspaceRoot,
    headGitObject: current.headGitObject,
    branch: current.branch,
    trackedDiffSha256: current.trackedDiffSha256,
    indexDiffSha256: current.indexDiffSha256,
    statusSha256: current.statusSha256,
    untracked: current.untracked,
  };
  if (JSON.stringify(currentState) !== JSON.stringify(expectedState)) {
    throw new Error("Profit Flywheel checkpoint workspace changed after immutable publication");
  }
  return current;
}
