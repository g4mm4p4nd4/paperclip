import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createDb,
  executionWorkspaces,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";

const execFileAsync = promisify(execFile);

const DEFAULT_HOME = "/Users/mnm/.paperclip-local/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_LEDGER_DIR = "data/ops/dirty-session-preservation/runs";
const FALLBACK_LEDGER_DIR = "docs/ops/dirty-session-preservation/runs";
const PRESERVATION_VERSION = "dirty-session-preservation.v1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

export type RepoRole = "paperclip" | "hermes" | "execution" | "custom";

export type RepoTarget = {
  role: RepoRole;
  name: string;
  root: string;
  source: string;
};

export type NormalizedRepoTarget = {
  roles: RepoRole[];
  names: string[];
  root: string;
  gitCommonDir: string | null;
  sources: RepoTarget[];
};

export type GitWorktreePorcelainEntry = {
  path: string;
  head: string | null;
  branchRef: string | null;
  branchName: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
  prunableReason: string | null;
};

export type GitStatusEntry = {
  code: string;
  path: string;
  originalPath: string | null;
  category: "tracked" | "untracked" | "ignored";
};

export type GitStatusSummary = {
  inspected: boolean;
  trackedEntries: GitStatusEntry[];
  untrackedEntries: GitStatusEntry[];
  ignoredEntries: GitStatusEntry[];
  trackedEntryCount: number;
  untrackedEntryCount: number;
  hasDirtyTrackedFiles: boolean;
  hasUntrackedFiles: boolean;
  error: string | null;
  skippedReason: string | null;
};

export type PreservationStatus =
  | "clean"
  | "dirty_preserve"
  | "missing"
  | "missing_prunable"
  | "prunable"
  | "inspect_failed";

export type DirtySessionWorktreeEntry = {
  repoRoles: RepoRole[];
  repoNames: string[];
  repoRoot: string;
  gitCommonDir: string | null;
  targetSources: RepoTarget[];
  worktreePath: string;
  head: string | null;
  branchRef: string | null;
  branchName: string | null;
  detached: boolean;
  bare: boolean;
  missing: boolean;
  prunable: boolean;
  prunableReason: string | null;
  status: GitStatusSummary;
  preservationStatus: PreservationStatus;
  recommendedAction: string;
};

export type DirtySessionLedger = {
  version: typeof PRESERVATION_VERSION;
  generatedAt: string;
  output: {
    mode: "cockpit" | "docs" | "explicit";
    directory: string;
    jsonPath: string | null;
    markdownPath: string | null;
  };
  discovery: {
    requestedTargets: RepoTarget[];
    inspectedTargets: NormalizedRepoTarget[];
    warnings: string[];
  };
  counts: {
    requestedTargets: number;
    inspectedRepositories: number;
    registeredWorktrees: number;
    cleanWorktrees: number;
    dirtyWorktrees: number;
    missingWorktrees: number;
    prunableWorktrees: number;
    inspectFailedWorktrees: number;
    dirtyTrackedEntries: number;
    untrackedEntries: number;
  };
  worktrees: DirtySessionWorktreeEntry[];
};

export type DirtySessionOptions = {
  repoRoot?: string;
  homeDir?: string;
  instanceId?: string;
  outputDir?: string;
  connectionString?: string;
  includeDefaultTargets?: boolean;
  includeCockpitDb?: boolean;
  paperclipRoot?: string;
  hermesRoot?: string;
  executionRoots?: string[];
  extraRepos?: RepoTarget[];
  now?: Date;
};

type LedgerOutputResolution = {
  mode: "cockpit" | "docs" | "explicit";
  directory: string;
};

function expandHome(input: string) {
  if (!input.startsWith("~")) return input;
  return path.join(process.env.HOME ?? "", input.slice(1));
}

function formatStamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConnectionString(config: ConfigFile, explicit?: string) {
  if (explicit?.trim()) return { connectionString: explicit.trim(), source: "explicit" };
  if (process.env.DATABASE_URL?.trim()) return { connectionString: process.env.DATABASE_URL.trim(), source: "DATABASE_URL" };
  if (config.database?.connectionString?.trim()) {
    return { connectionString: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }
  const port = config.database?.embeddedPostgresPort ?? 54329;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

async function closeDb(db: Db) {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

async function runGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function tryRunGit(cwd: string, args: string[]) {
  try {
    return { ok: true as const, ...(await runGit(cwd, args)) };
  } catch (error) {
    return {
      ok: false as const,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function stripBranchRef(ref: string | null) {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function parseGitWorktreePorcelain(output: string): GitWorktreePorcelainEntry[] {
  const entries: GitWorktreePorcelainEntry[] = [];
  let current: GitWorktreePorcelainEntry | null = null;

  const finish = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      finish();
      continue;
    }

    if (line.startsWith("worktree ")) {
      finish();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branchRef: null,
        branchName: null,
        detached: false,
        bare: false,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length);
      current.branchName = stripBranchRef(current.branchRef);
    } else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line === "prunable") current.prunable = true;
    else if (line.startsWith("prunable ")) {
      current.prunable = true;
      current.prunableReason = line.slice("prunable ".length);
    }
  }
  finish();

  return entries;
}

export function parseGitStatusPorcelainV1Z(output: string): GitStatusEntry[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    let originalPath: string | null = null;

    if ((code.startsWith("R") || code.startsWith("C")) && index + 1 < tokens.length) {
      originalPath = tokens[index + 1]!;
      index += 1;
    }

    const category =
      code === "??"
        ? "untracked"
        : code === "!!"
          ? "ignored"
          : "tracked";
    entries.push({
      code,
      path: filePath,
      originalPath,
      category,
    });
  }
  return entries;
}

function summarizeStatus(entries: GitStatusEntry[]): GitStatusSummary {
  const trackedEntries = entries.filter((entry) => entry.category === "tracked");
  const untrackedEntries = entries.filter((entry) => entry.category === "untracked");
  const ignoredEntries = entries.filter((entry) => entry.category === "ignored");
  return {
    inspected: true,
    trackedEntries,
    untrackedEntries,
    ignoredEntries,
    trackedEntryCount: trackedEntries.length,
    untrackedEntryCount: untrackedEntries.length,
    hasDirtyTrackedFiles: trackedEntries.length > 0,
    hasUntrackedFiles: untrackedEntries.length > 0,
    error: null,
    skippedReason: null,
  };
}

function skippedStatus(reason: string): GitStatusSummary {
  return {
    inspected: false,
    trackedEntries: [],
    untrackedEntries: [],
    ignoredEntries: [],
    trackedEntryCount: 0,
    untrackedEntryCount: 0,
    hasDirtyTrackedFiles: false,
    hasUntrackedFiles: false,
    error: null,
    skippedReason: reason,
  };
}

function failedStatus(error: string): GitStatusSummary {
  return {
    ...skippedStatus("git_status_failed"),
    error,
  };
}

function classifyWorktree(input: {
  missing: boolean;
  prunable: boolean;
  status: GitStatusSummary;
}): PreservationStatus {
  if (input.missing && input.prunable) return "missing_prunable";
  if (input.missing) return "missing";
  if (input.prunable) return "prunable";
  if (input.status.error) return "inspect_failed";
  if (input.status.hasDirtyTrackedFiles || input.status.hasUntrackedFiles) return "dirty_preserve";
  return "clean";
}

function recommendedAction(status: PreservationStatus) {
  if (status === "dirty_preserve") return "preserve_before_cleanup";
  if (status === "inspect_failed") return "review_before_cleanup";
  if (status === "missing_prunable" || status === "prunable") return "eligible_for_git_prune_after_review";
  if (status === "missing") return "review_missing_registration";
  return "no_dirty_session_detected";
}

async function inspectStatus(worktree: GitWorktreePorcelainEntry): Promise<{ missing: boolean; status: GitStatusSummary }> {
  const missing = !(await pathExists(worktree.path));
  if (missing) return { missing, status: skippedStatus("worktree_path_missing") };
  if (worktree.bare) return { missing, status: skippedStatus("bare_worktree") };

  const result = await tryRunGit(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!result.ok) return { missing, status: failedStatus(result.stderr) };
  return { missing, status: summarizeStatus(parseGitStatusPorcelainV1Z(result.stdout)) };
}

async function resolveGitMetadata(root: string) {
  const topLevel = await tryRunGit(root, ["rev-parse", "--show-toplevel"]);
  const commonDir = await tryRunGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    topLevel: topLevel.ok ? asString(topLevel.stdout) : null,
    commonDir: commonDir.ok ? asString(commonDir.stdout) : null,
    error: topLevel.ok ? null : topLevel.stderr,
  };
}

export function defaultRepoTargets(options: {
  repoRoot?: string;
  paperclipRoot?: string;
  hermesRoot?: string;
  executionRoots?: string[];
} = {}): RepoTarget[] {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const githubRoot = path.dirname(repoRoot);
  const paperclipRoot = path.resolve(options.paperclipRoot ?? repoRoot);
  const hermesRoot = path.resolve(options.hermesRoot ?? path.join(githubRoot, "hermes-agent"));
  const executionRoots = options.executionRoots ?? [];

  return [
    {
      role: "paperclip",
      name: "paperclip",
      root: paperclipRoot,
      source: "default",
    },
    {
      role: "hermes",
      name: "hermes-agent",
      root: hermesRoot,
      source: "default",
    },
    ...executionRoots.map((root, index) => ({
      role: "execution" as const,
      name: `execution-${index + 1}`,
      root: path.resolve(expandHome(root)),
      source: "cli",
    })),
  ];
}

export async function discoverCockpitExecutionRepoTargets(options: {
  homeDir?: string;
  instanceId?: string;
  connectionString?: string;
} = {}): Promise<{ targets: RepoTarget[]; warnings: string[] }> {
  const warnings: string[] = [];
  const homeDir = path.resolve(expandHome(options.homeDir ?? process.env.PAPERCLIP_HOME ?? DEFAULT_HOME));
  const instanceId = options.instanceId ?? process.env.PAPERCLIP_INSTANCE_ID ?? DEFAULT_INSTANCE_ID;

  let config: ConfigFile;
  try {
    config = await readConfig(homeDir, instanceId);
  } catch (error) {
    warnings.push(`Could not read cockpit config for execution workspace discovery: ${error instanceof Error ? error.message : String(error)}`);
    return { targets: [], warnings };
  }

  const { connectionString, source } = resolveConnectionString(config, options.connectionString);
  const db = createDb(connectionString);
  try {
    const projectRows = await db
      .select({
        id: projectWorkspaces.id,
        name: projectWorkspaces.name,
        cwd: projectWorkspaces.cwd,
      })
      .from(projectWorkspaces);
    const executionRows = await db
      .select({
        id: executionWorkspaces.id,
        name: executionWorkspaces.name,
        cwd: executionWorkspaces.cwd,
        providerRef: executionWorkspaces.providerRef,
      })
      .from(executionWorkspaces);

    const targets: RepoTarget[] = [];
    for (const row of projectRows) {
      const cwd = asString(row.cwd);
      if (!cwd) continue;
      targets.push({
        role: "execution",
        name: `project-workspace:${row.name || row.id}`,
        root: path.resolve(expandHome(cwd)),
        source: `cockpit_db:${source}:project_workspaces:${row.id}`,
      });
    }
    for (const row of executionRows) {
      const cwd = asString(row.providerRef) ?? asString(row.cwd);
      if (!cwd) continue;
      targets.push({
        role: "execution",
        name: `execution-workspace:${row.name || row.id}`,
        root: path.resolve(expandHome(cwd)),
        source: `cockpit_db:${source}:execution_workspaces:${row.id}`,
      });
    }
    return { targets, warnings };
  } catch (error) {
    warnings.push(`Could not query cockpit execution workspace records: ${error instanceof Error ? error.message : String(error)}`);
    return { targets: [], warnings };
  } finally {
    await closeDb(db);
  }
}

async function normalizeRepoTargets(targets: RepoTarget[]): Promise<{ targets: NormalizedRepoTarget[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byKey = new Map<string, NormalizedRepoTarget>();
  const missingByRoot = new Map<string, RepoTarget[]>();
  const nonGitByRoot = new Map<string, { targets: RepoTarget[]; error: string | null }>();

  for (const target of targets) {
    const root = path.resolve(expandHome(target.root));
    if (!(await pathExists(root))) {
      const key = `missing:${root}`;
      missingByRoot.set(root, [...(missingByRoot.get(root) ?? []), target]);
      const existing = byKey.get(key);
      if (existing) {
        existing.roles = [...new Set([...existing.roles, target.role])];
        existing.names = [...new Set([...existing.names, target.name])];
        existing.sources.push({ ...target, root });
      } else {
        byKey.set(key, {
          roles: [target.role],
          names: [target.name],
          root,
          gitCommonDir: null,
          sources: [{ ...target, root }],
        });
      }
      continue;
    }

    const metadata = await resolveGitMetadata(root);
    if (!metadata.topLevel) {
      const previous = nonGitByRoot.get(root);
      nonGitByRoot.set(root, {
        targets: [...(previous?.targets ?? []), target],
        error: previous?.error ?? metadata.error ?? "unknown git error",
      });
      continue;
    }

    const normalizedRoot = path.resolve(metadata.topLevel);
    const key = metadata.commonDir ? `git:${path.resolve(metadata.commonDir)}` : `root:${normalizedRoot}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.roles = [...new Set([...existing.roles, target.role])];
      existing.names = [...new Set([...existing.names, target.name])];
      existing.sources.push({ ...target, root });
      continue;
    }

    byKey.set(key, {
      roles: [target.role],
      names: [target.name],
      root: normalizedRoot,
      gitCommonDir: metadata.commonDir ? path.resolve(metadata.commonDir) : null,
      sources: [{ ...target, root }],
    });
  }

  for (const [root, rootTargets] of missingByRoot.entries()) {
    warnings.push(
      `Repository target path does not exist at ${root}; ${rootTargets.length} registered target(s) affected: ${rootTargets.slice(0, 5).map((target) => target.name).join(", ")}${rootTargets.length > 5 ? ", ..." : ""}.`,
    );
  }
  for (const [root, entry] of nonGitByRoot.entries()) {
    warnings.push(
      `Repository target path is not a git checkout at ${root}; ${entry.targets.length} registered target(s) affected: ${entry.targets.slice(0, 5).map((target) => target.name).join(", ")}${entry.targets.length > 5 ? ", ..." : ""}: ${entry.error ?? "unknown git error"}`,
    );
  }

  return { targets: [...byKey.values()], warnings };
}

async function inspectRepositoryWorktrees(target: NormalizedRepoTarget): Promise<{
  worktrees: DirtySessionWorktreeEntry[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  if (!(await pathExists(target.root))) {
    warnings.push(`Skipping missing repository root ${target.root}.`);
    return { worktrees: [], warnings };
  }

  const listResult = await tryRunGit(target.root, ["worktree", "list", "--porcelain"]);
  if (!listResult.ok) {
    warnings.push(`Could not list git worktrees for ${target.root}: ${listResult.stderr}`);
    return { worktrees: [], warnings };
  }

  const worktrees: DirtySessionWorktreeEntry[] = [];
  for (const worktree of parseGitWorktreePorcelain(listResult.stdout)) {
    const { missing, status } = await inspectStatus(worktree);
    const preservationStatus = classifyWorktree({
      missing,
      prunable: worktree.prunable,
      status,
    });
    worktrees.push({
      repoRoles: target.roles,
      repoNames: target.names,
      repoRoot: target.root,
      gitCommonDir: target.gitCommonDir,
      targetSources: target.sources,
      worktreePath: worktree.path,
      head: worktree.head,
      branchRef: worktree.branchRef,
      branchName: worktree.branchName,
      detached: worktree.detached,
      bare: worktree.bare,
      missing,
      prunable: worktree.prunable,
      prunableReason: worktree.prunableReason,
      status,
      preservationStatus,
      recommendedAction: recommendedAction(preservationStatus),
    });
  }

  return { worktrees, warnings };
}

function ledgerCounts(input: {
  requestedTargets: RepoTarget[];
  inspectedTargets: NormalizedRepoTarget[];
  worktrees: DirtySessionWorktreeEntry[];
}) {
  return {
    requestedTargets: input.requestedTargets.length,
    inspectedRepositories: input.inspectedTargets.length,
    registeredWorktrees: input.worktrees.length,
    cleanWorktrees: input.worktrees.filter((entry) => entry.preservationStatus === "clean").length,
    dirtyWorktrees: input.worktrees.filter((entry) => entry.preservationStatus === "dirty_preserve").length,
    missingWorktrees: input.worktrees.filter((entry) => entry.missing).length,
    prunableWorktrees: input.worktrees.filter((entry) => entry.prunable).length,
    inspectFailedWorktrees: input.worktrees.filter((entry) => entry.preservationStatus === "inspect_failed").length,
    dirtyTrackedEntries: input.worktrees.reduce((sum, entry) => sum + entry.status.trackedEntryCount, 0),
    untrackedEntries: input.worktrees.reduce((sum, entry) => sum + entry.status.untrackedEntryCount, 0),
  };
}

export async function resolveLedgerOutputDir(options: DirtySessionOptions = {}): Promise<LedgerOutputResolution> {
  if (options.outputDir) {
    return {
      mode: "explicit",
      directory: path.resolve(expandHome(options.outputDir)),
    };
  }

  const homeDir = path.resolve(expandHome(options.homeDir ?? process.env.PAPERCLIP_HOME ?? DEFAULT_HOME));
  const instanceId = options.instanceId ?? process.env.PAPERCLIP_INSTANCE_ID ?? DEFAULT_INSTANCE_ID;
  const dataDir = path.join(homeDir, "instances", instanceId, "data");
  if (await pathExists(dataDir)) {
    return {
      mode: "cockpit",
      directory: path.join(homeDir, "instances", instanceId, DEFAULT_LEDGER_DIR),
    };
  }

  return {
    mode: "docs",
    directory: path.join(path.resolve(options.repoRoot ?? REPO_ROOT), FALLBACK_LEDGER_DIR),
  };
}

export async function collectDirtySessionLedger(options: DirtySessionOptions = {}): Promise<DirtySessionLedger> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const output = await resolveLedgerOutputDir(options);
  const requestedTargets: RepoTarget[] = [];
  const discoveryWarnings: string[] = [];

  if (options.includeDefaultTargets !== false) {
    requestedTargets.push(...defaultRepoTargets({
      repoRoot: options.repoRoot,
      paperclipRoot: options.paperclipRoot,
      hermesRoot: options.hermesRoot,
      executionRoots: options.executionRoots,
    }));
  }

  if (options.extraRepos) requestedTargets.push(...options.extraRepos);

  if (options.includeCockpitDb !== false) {
    const cockpit = await discoverCockpitExecutionRepoTargets({
      homeDir: options.homeDir,
      instanceId: options.instanceId,
      connectionString: options.connectionString,
    });
    requestedTargets.push(...cockpit.targets);
    discoveryWarnings.push(...cockpit.warnings);
  }

  const normalized = await normalizeRepoTargets(requestedTargets);
  discoveryWarnings.push(...normalized.warnings);

  const worktrees: DirtySessionWorktreeEntry[] = [];
  for (const target of normalized.targets) {
    const inspected = await inspectRepositoryWorktrees(target);
    worktrees.push(...inspected.worktrees);
    discoveryWarnings.push(...inspected.warnings);
  }

  return {
    version: PRESERVATION_VERSION,
    generatedAt,
    output: {
      mode: output.mode,
      directory: output.directory,
      jsonPath: null,
      markdownPath: null,
    },
    discovery: {
      requestedTargets,
      inspectedTargets: normalized.targets,
      warnings: discoveryWarnings,
    },
    counts: ledgerCounts({
      requestedTargets,
      inspectedTargets: normalized.targets,
      worktrees,
    }),
    worktrees: worktrees.sort((left, right) => left.worktreePath.localeCompare(right.worktreePath)),
  };
}

function escapeTable(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function formatStatusCell(entry: DirtySessionWorktreeEntry) {
  if (entry.status.error) return `inspect failed: ${entry.status.error}`;
  if (!entry.status.inspected) return entry.status.skippedReason ?? "not inspected";
  return `${entry.status.trackedEntryCount} tracked, ${entry.status.untrackedEntryCount} untracked`;
}

export function renderDirtySessionMarkdown(ledger: DirtySessionLedger) {
  const dirty = ledger.worktrees.filter((entry) => entry.preservationStatus !== "clean");
  const lines: string[] = [
    "# Dirty Session Preservation Ledger",
    "",
    `Generated: ${ledger.generatedAt}`,
    `Version: ${ledger.version}`,
    `Output mode: ${ledger.output.mode}`,
    "",
    "## Summary",
    "",
    `- Requested repo targets: ${ledger.counts.requestedTargets}`,
    `- Inspected git repositories: ${ledger.counts.inspectedRepositories}`,
    `- Registered worktrees: ${ledger.counts.registeredWorktrees}`,
    `- Dirty worktrees to preserve: ${ledger.counts.dirtyWorktrees}`,
    `- Missing worktrees: ${ledger.counts.missingWorktrees}`,
    `- Prunable worktrees: ${ledger.counts.prunableWorktrees}`,
    `- Inspect failures: ${ledger.counts.inspectFailedWorktrees}`,
    `- Dirty tracked entries: ${ledger.counts.dirtyTrackedEntries}`,
    `- Untracked entries: ${ledger.counts.untrackedEntries}`,
    "",
  ];

  if (ledger.discovery.warnings.length > 0) {
    lines.push("## Discovery Warnings", "");
    for (const warning of ledger.discovery.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("## Repositories", "");
  lines.push("| Roles | Root | Sources |");
  lines.push("|---|---|---|");
  for (const target of ledger.discovery.inspectedTargets) {
    lines.push([
      target.roles.join(", "),
      target.root,
      target.sources.map((source) => `${source.name} (${source.source})`).join("; "),
    ].map(escapeTable).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");

  lines.push("## Preservation Queue", "");
  if (dirty.length === 0) {
    lines.push("No dirty, missing, prunable, or failed-inspection worktrees were found.");
    lines.push("");
  } else {
    lines.push("| Status | Repo | Worktree | Branch | Git state | Recommended action |");
    lines.push("|---|---|---|---|---|---|");
    for (const entry of dirty) {
      lines.push([
        entry.preservationStatus,
        entry.repoNames.join(", "),
        entry.worktreePath,
        entry.branchName ?? (entry.detached ? "detached" : ""),
        formatStatusCell(entry),
        entry.recommendedAction,
      ].map(escapeTable).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    lines.push("");
  }

  lines.push("## All Registered Worktrees", "");
  lines.push("| Status | Repo | Worktree | Branch | Missing | Prunable | Git state |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const entry of ledger.worktrees) {
    lines.push([
      entry.preservationStatus,
      entry.repoNames.join(", "),
      entry.worktreePath,
      entry.branchName ?? (entry.detached ? "detached" : ""),
      entry.missing ? "yes" : "no",
      entry.prunable ? (entry.prunableReason ?? "yes") : "no",
      formatStatusCell(entry),
    ].map(escapeTable).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export async function writeDirtySessionLedger(ledger: DirtySessionLedger) {
  await mkdir(ledger.output.directory, { recursive: true });
  const stamp = formatStamp(new Date(ledger.generatedAt));
  const basename = `${stamp}-${process.pid}-dirty-session-preservation`;
  const jsonPath = path.join(ledger.output.directory, `${basename}.json`);
  const markdownPath = path.join(ledger.output.directory, `${basename}.md`);
  const outputLedger: DirtySessionLedger = {
    ...ledger,
    output: {
      ...ledger.output,
      jsonPath,
      markdownPath,
    },
  };

  await writeFile(jsonPath, `${JSON.stringify(outputLedger, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderDirtySessionMarkdown(outputLedger), "utf8");
  return {
    ledger: outputLedger,
    jsonPath,
    markdownPath,
  };
}

export async function runDirtySessionPreservation(options: DirtySessionOptions = {}) {
  const ledger = await collectDirtySessionLedger(options);
  return await writeDirtySessionLedger(ledger);
}

function readNext(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRepoSpec(value: string): RepoTarget {
  const [roleRaw, nameRaw, ...pathParts] = value.split(":");
  const root = pathParts.join(":");
  const role = roleRaw === "paperclip" || roleRaw === "hermes" || roleRaw === "execution" ? roleRaw : "custom";
  if (!nameRaw || !root) {
    throw new Error("--repo expects role:name:path");
  }
  return {
    role,
    name: nameRaw,
    root: path.resolve(expandHome(root)),
    source: "cli",
  };
}

function parseArgs(argv: string[]): DirtySessionOptions {
  const parsed: DirtySessionOptions = {
    includeDefaultTargets: true,
    includeCockpitDb: true,
    executionRoots: [],
    extraRepos: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") continue;
    if (arg === "--home") parsed.homeDir = readNext(argv, index++, arg);
    else if (arg === "--instance-id") parsed.instanceId = readNext(argv, index++, arg);
    else if (arg === "--connection-string") parsed.connectionString = readNext(argv, index++, arg);
    else if (arg === "--output-dir") parsed.outputDir = readNext(argv, index++, arg);
    else if (arg === "--paperclip-root") parsed.paperclipRoot = readNext(argv, index++, arg);
    else if (arg === "--hermes-root") parsed.hermesRoot = readNext(argv, index++, arg);
    else if (arg === "--execution-root") parsed.executionRoots?.push(readNext(argv, index++, arg));
    else if (arg === "--repo") parsed.extraRepos?.push(parseRepoSpec(readNext(argv, index++, arg)));
    else if (arg === "--no-defaults") parsed.includeDefaultTargets = false;
    else if (arg === "--no-cockpit-db") parsed.includeCockpitDb = false;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: tsx src/ops/dirty-session-preservation.ts [options]",
        "",
        "Read-only inventory of registered git worktrees before prune/cleanup.",
        "",
        "Options:",
        "  --home <path>               Paperclip cockpit home directory",
        "  --instance-id <id>          Paperclip instance id",
        "  --connection-string <url>   Override DB URL for cockpit execution workspace discovery",
        "  --output-dir <path>         Write ledger files to an explicit directory",
        "  --paperclip-root <path>     Override Paperclip repo root",
        "  --hermes-root <path>        Override Hermes repo root",
        "  --execution-root <path>     Add an execution repo root (repeatable)",
        "  --repo role:name:path       Add a custom repo target",
        "  --no-defaults               Do not include default paperclip/hermes targets",
        "  --no-cockpit-db             Skip read-only cockpit DB workspace discovery",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function warningSummary(warnings: string[], maxSample = 20) {
  const unique = [...new Set(warnings)];
  return {
    count: warnings.length,
    uniqueCount: unique.length,
    sample: unique.slice(0, maxSample),
    truncated: unique.length > maxSample,
  };
}

async function main() {
  const result = await runDirtySessionPreservation(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    status: "ledger_written",
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    counts: result.ledger.counts,
    warningSummary: warningSummary(result.ledger.discovery.warnings),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
