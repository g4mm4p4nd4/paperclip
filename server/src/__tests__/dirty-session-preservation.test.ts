import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDirtySessionLedger,
  parseGitStatusPorcelainV1Z,
  parseGitWorktreePorcelain,
  resolveLedgerOutputDir,
  writeDirtySessionLedger,
  type RepoTarget,
} from "../ops/dirty-session-preservation.js";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dirty-session-"));
  tempDirs.add(parent);
  const repoRoot = path.join(parent, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return { parent, repoRoot };
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("dirty session preservation helpers", () => {
  it("parses git worktree porcelain including detached and prunable entries", () => {
    const parsed = parseGitWorktreePorcelain([
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /missing",
      "HEAD def456",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"));

    expect(parsed).toEqual([
      {
        path: "/repo",
        head: "abc123",
        branchRef: "refs/heads/main",
        branchName: "main",
        detached: false,
        bare: false,
        prunable: false,
        prunableReason: null,
      },
      {
        path: "/missing",
        head: "def456",
        branchRef: null,
        branchName: null,
        detached: true,
        bare: false,
        prunable: true,
        prunableReason: "gitdir file points to non-existent location",
      },
    ]);
  });

  it("separates tracked, untracked, and renamed status entries", () => {
    const parsed = parseGitStatusPorcelainV1Z([
      " M README.md",
      "?? scratch.txt",
      "R  new-name.txt",
      "old-name.txt",
      "",
    ].join("\0"));

    expect(parsed).toEqual([
      { code: " M", path: "README.md", originalPath: null, category: "tracked" },
      { code: "??", path: "scratch.txt", originalPath: null, category: "untracked" },
      { code: "R ", path: "new-name.txt", originalPath: "old-name.txt", category: "tracked" },
    ]);
  });

  it("inventories dirty and prunable registered worktrees without deleting or pruning them", async () => {
    const { parent, repoRoot } = await createTempRepo();
    const dirtyWorktree = path.join(parent, "dirty-worktree");
    const missingWorktree = path.join(parent, "missing-worktree");
    await runGit(repoRoot, ["worktree", "add", "-b", "dirty-session-test", dirtyWorktree, "main"]);
    await runGit(repoRoot, ["worktree", "add", "-b", "missing-session-test", missingWorktree, "main"]);

    await fs.writeFile(path.join(dirtyWorktree, "README.md"), "changed\n", "utf8");
    await fs.writeFile(path.join(dirtyWorktree, "scratch.txt"), "preserve me\n", "utf8");
    const dirtyWorktreeRegisteredPath = await fs.realpath(dirtyWorktree);
    const missingWorktreeRegisteredPath = await fs.realpath(missingWorktree);
    await fs.rm(missingWorktree, { recursive: true, force: true });

    const target: RepoTarget = {
      role: "paperclip",
      name: "paperclip-test",
      root: repoRoot,
      source: "test",
    };
    const ledger = await collectDirtySessionLedger({
      includeDefaultTargets: false,
      includeCockpitDb: false,
      extraRepos: [target],
      outputDir: path.join(parent, "ledger"),
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    const dirty = ledger.worktrees.find((entry) => entry.worktreePath === dirtyWorktreeRegisteredPath);
    expect(dirty).toMatchObject({
      preservationStatus: "dirty_preserve",
      recommendedAction: "preserve_before_cleanup",
      missing: false,
      prunable: false,
      status: {
        trackedEntryCount: 1,
        untrackedEntryCount: 1,
        hasDirtyTrackedFiles: true,
        hasUntrackedFiles: true,
      },
    });
    expect(dirty?.status.trackedEntries.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(dirty?.status.untrackedEntries.map((entry) => entry.path)).toEqual(["scratch.txt"]);

    const missing = ledger.worktrees.find((entry) => entry.worktreePath === missingWorktreeRegisteredPath);
    expect(missing).toMatchObject({
      preservationStatus: "missing_prunable",
      recommendedAction: "eligible_for_git_prune_after_review",
      missing: true,
      prunable: true,
      status: {
        inspected: false,
        skippedReason: "worktree_path_missing",
      },
    });

    expect(await fs.stat(dirtyWorktree).then(() => true, () => false)).toBe(true);
    expect(ledger.counts).toMatchObject({
      dirtyWorktrees: 1,
      missingWorktrees: 1,
      prunableWorktrees: 1,
      dirtyTrackedEntries: 1,
      untrackedEntries: 1,
    });
  }, 20_000);

  it("uses cockpit data/ops when available and docs/ops otherwise", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dirty-session-output-"));
    tempDirs.add(tempRoot);
    const homeDir = path.join(tempRoot, "home");
    const instanceData = path.join(homeDir, "instances", "default", "data");
    await fs.mkdir(instanceData, { recursive: true });

    await expect(resolveLedgerOutputDir({
      homeDir,
      instanceId: "default",
      repoRoot: tempRoot,
    })).resolves.toEqual({
      mode: "cockpit",
      directory: path.join(homeDir, "instances", "default", "data", "ops", "dirty-session-preservation", "runs"),
    });

    await expect(resolveLedgerOutputDir({
      homeDir: path.join(tempRoot, "missing-home"),
      instanceId: "default",
      repoRoot: tempRoot,
    })).resolves.toEqual({
      mode: "docs",
      directory: path.join(tempRoot, "docs", "ops", "dirty-session-preservation", "runs"),
    });
  });

  it("writes matching timestamped JSON and Markdown ledgers", async () => {
    const { parent, repoRoot } = await createTempRepo();
    const target: RepoTarget = {
      role: "paperclip",
      name: "paperclip-test",
      root: repoRoot,
      source: "test",
    };
    const ledger = await collectDirtySessionLedger({
      includeDefaultTargets: false,
      includeCockpitDb: false,
      extraRepos: [target],
      outputDir: path.join(parent, "ledger"),
      now: new Date("2026-07-04T12:00:00.000Z"),
    });

    const written = await writeDirtySessionLedger(ledger);

    expect(path.basename(written.jsonPath)).toMatch(/^20260704T120000000Z-\d+-dirty-session-preservation\.json$/);
    expect(path.basename(written.markdownPath)).toMatch(/^20260704T120000000Z-\d+-dirty-session-preservation\.md$/);
    await expect(fs.readFile(written.jsonPath, "utf8")).resolves.toContain("\"version\": \"dirty-session-preservation.v1\"");
    await expect(fs.readFile(written.markdownPath, "utf8")).resolves.toContain("# Dirty Session Preservation Ledger");
  }, 20_000);
});
