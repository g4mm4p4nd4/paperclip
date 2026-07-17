import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
  createDb,
  profitFlywheelEvents,
  profitFlywheelProviderHealth,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import { prepareTrustedReceiptDirectory } from "./trusted-receipt-directory.js";
import {
  factoryCanonicalJsonBytes,
  factoryCanonicalJsonSha256,
  factoryCanonicalJsonValue,
} from "./factory-canonical-json.js";
import {
  verifyManagedAdapterPluginRecord,
  type ManagedAdapterBundleIdentity,
} from "../services/managed-adapter-bundle.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";

const execFile = promisify(execFileCallback);
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40,64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const HERMES_ADAPTER_PACKAGE = "@henkey/hermes-paperclip-adapter";
const HERMES_ADAPTER_TYPE = "hermes_local";

export const FACTORY_BASELINE_SCHEMA_VERSION = "paperclip.profit_flywheel_factory_baseline.v1" as const;

export interface FactoryBaselineRepositoryInput {
  name: "portfolio-os" | "paperclip" | "hermes-agent" | "hermes-paperclip-adapter";
  path: string;
}

export interface FactoryBaselineOptions {
  companyId: string;
  targetWorkflowRunId: string;
  instanceRoot: string;
  pluginStorePath: string;
  tokenomicsReceiptPath: string;
  repositories: readonly FactoryBaselineRepositoryInput[];
  now?: Date;
}

interface CommandRunner {
  (file: string, args: readonly string[], options: { cwd?: string; maxBuffer: number }): Promise<{ stdout: string; stderr: string }>;
}

function sha256(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function immutableReceiptBytes(value: unknown) {
  return factoryCanonicalJsonBytes(value);
}

function requireAbsolutePath(value: string, label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

async function readBoundedJson(filePath: string, label: string) {
  requireAbsolutePath(filePath, label);
  const metadata = await lstat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_JSON_BYTES) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function git(command: CommandRunner, repoPath: string, args: readonly string[]) {
  const result = await command("git", ["-C", repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function collectRepositoryIdentity(
  input: FactoryBaselineRepositoryInput,
  command: CommandRunner = execFile,
) {
  const repoPath = requireAbsolutePath(input.path, `factory_baseline_${input.name}_path`);
  const canonicalPath = await realpath(repoPath);
  if (canonicalPath !== repoPath) throw new Error(`factory_baseline_${input.name}_path_not_canonical`);
  const [headRaw, branchRaw, upstreamRaw, statusRaw] = await Promise.all([
    git(command, repoPath, ["rev-parse", "HEAD"]).catch(() => ""),
    git(command, repoPath, ["branch", "--show-current"]).catch(() => ""),
    git(command, repoPath, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => ""),
    git(command, repoPath, ["status", "--porcelain=v1", "-z"]).catch(() => ""),
  ]);
  const entries = statusRaw.split("\0").filter(Boolean);
  const untrackedChanges = entries.filter((entry) => entry.startsWith("?? ")).length;
  const trackedChanges = entries.length - untrackedChanges;
  const head = GIT_SHA_RE.test(headRaw) ? headRaw : null;
  return {
    name: input.name,
    path: repoPath,
    head,
    branch: branchRaw || null,
    upstream: upstreamRaw || null,
    tracked_changes: trackedChanges,
    untracked_changes: untrackedChanges,
    tree_clean: entries.length === 0,
  };
}

export async function computeTrackedFileManifestSha256(
  repoPath: string,
  command: CommandRunner = execFile,
) {
  const canonicalPath = await realpath(requireAbsolutePath(repoPath, "factory_baseline_adapter_path"));
  if (canonicalPath !== repoPath) throw new Error("factory_baseline_adapter_path_not_canonical");
  const { stdout } = await command("git", ["-C", repoPath, "ls-files", "-z"], { maxBuffer: 32 * 1024 * 1024 });
  const names = stdout.split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right, "en"));
  const manifest: Array<{ path: string; kind: "file" | "symlink"; sha256: string; mode: number }> = [];
  for (const relativePath of names) {
    const absolutePath = path.resolve(repoPath, relativePath);
    if (absolutePath !== repoPath && !absolutePath.startsWith(`${repoPath}${path.sep}`)) {
      throw new Error("factory_baseline_adapter_manifest_path_escape");
    }
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      manifest.push({ path: relativePath, kind: "symlink", sha256: sha256(await readlink(absolutePath)), mode: metadata.mode & 0o777 });
    } else if (metadata.isFile()) {
      manifest.push({ path: relativePath, kind: "file", sha256: sha256(await readFile(absolutePath)), mode: metadata.mode & 0o777 });
    } else {
      throw new Error("factory_baseline_adapter_manifest_entry_invalid");
    }
  }
  return sha256(JSON.stringify(manifest));
}

async function directorySizeBytes(directory: string, command: CommandRunner = execFile) {
  const metadata = await lstat(directory).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return null;
  try {
    const { stdout } = await command("/usr/bin/du", ["-sk", directory], { maxBuffer: 1024 * 1024 });
    const kib = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) && kib >= 0 ? Math.trunc(kib * 1024) : null;
  } catch {
    return null;
  }
}

async function factoryBrowserUsage(instanceRoot: string, command: CommandRunner = execFile) {
  try {
    const { stdout } = await command("/bin/ps", ["-axo", "rss=,command="], { maxBuffer: 16 * 1024 * 1024 });
    let count = 0;
    let rssKiB = 0;
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const commandLine = match[2]!;
      const browserLike = /(?:chrome|chromium|playwright|browser)/i.test(commandLine);
      const factoryOwned = commandLine.includes(instanceRoot) && /(?:profiles|browser|playwright|chromium)/i.test(commandLine);
      if (!browserLike || !factoryOwned) continue;
      count += 1;
      rssKiB += Number(match[1]);
    }
    return { count, rss_bytes: Math.trunc(rssKiB * 1024) };
  } catch {
    return { count: 0, rss_bytes: 0 };
  }
}

export function selectFactoryAdapterPluginRecord(value: unknown, adapterRepoPath: string) {
  const entries = Array.isArray(value) ? value.map(asRecord) : [];
  const managed = entries.filter((entry) =>
    entry.type === HERMES_ADAPTER_TYPE &&
    entry.packageName === HERMES_ADAPTER_PACKAGE &&
    entry.installKind === "managed_immutable_bundle");
  if (managed.length > 1) throw new Error("factory_baseline_managed_adapter_record_ambiguous");
  if (managed.length === 1) return managed[0]!;
  const development = entries.filter((entry) =>
    entry.type === HERMES_ADAPTER_TYPE &&
    entry.installKind === "local_path" &&
    entry.localPath === adapterRepoPath);
  if (development.length > 1) throw new Error("factory_baseline_local_adapter_record_ambiguous");
  return development[0] ?? {};
}

function promotionBlockers(input: {
  repositories: Awaited<ReturnType<typeof collectRepositoryIdentity>>[];
  adapter: { package_version: string | null; plugin_store_version: string | null; plugin_store_mode: string };
  tokenomics: { fresh: boolean; status: string | null };
  diskFreeBytes: number;
  providerRoutes: Array<{ status: string; expires_at: string }>;
  now: Date;
}) {
  const blockers: string[] = [];
  const pos = input.repositories.find((repo) => repo.name === "portfolio-os");
  if (pos && !pos.tree_clean) blockers.push("mutable_portfolio_os_checkout");
  if (input.adapter.plugin_store_mode !== "immutable_bundle") blockers.push("mutable_adapter_runtime");
  if (!input.adapter.package_version || input.adapter.package_version !== input.adapter.plugin_store_version) blockers.push("adapter_version_mismatch");
  if (!input.tokenomics.fresh || input.tokenomics.status !== "pass") blockers.push("tokenomics_unhealthy_or_stale");
  if (input.diskFreeBytes < 30 * 1024 ** 3) blockers.push("disk_below_30_gib");
  if (!input.providerRoutes.some((route) => route.status === "healthy" && Date.parse(route.expires_at) > input.now.getTime())) {
    blockers.push("no_fresh_healthy_provider_route");
  }
  return [...new Set(blockers)].sort();
}

export async function collectFactoryBaseline(
  db: Db,
  options: FactoryBaselineOptions,
  dependencies: {
    command?: CommandRunner;
    verifyManagedAdapterRecord?: (record: AdapterPluginRecord) => Promise<ManagedAdapterBundleIdentity>;
  } = {},
) {
  const command = dependencies.command ?? execFile;
  const verifyManagedAdapterRecord = dependencies.verifyManagedAdapterRecord ?? verifyManagedAdapterPluginRecord;
  const now = options.now ?? new Date();
  const instanceRoot = await realpath(requireAbsolutePath(options.instanceRoot, "factory_baseline_instance_root"));
  if (instanceRoot !== options.instanceRoot) throw new Error("factory_baseline_instance_root_not_canonical");
  if (options.repositories.length !== 4 || new Set(options.repositories.map((repo) => repo.name)).size !== 4) {
    throw new Error("factory_baseline_repository_set_invalid");
  }
  const repositories = await Promise.all(options.repositories.map((repo) => collectRepositoryIdentity(repo, command)));
  const adapterRepo = options.repositories.find((repo) => repo.name === "hermes-paperclip-adapter");
  if (!adapterRepo) throw new Error("factory_baseline_adapter_repository_missing");
  const adapterPackage = asRecord(await readBoundedJson(path.join(adapterRepo.path, "package.json"), "factory_baseline_adapter_package"));
  const pluginStore = await readBoundedJson(options.pluginStorePath, "factory_baseline_plugin_store");
  const installed = selectFactoryAdapterPluginRecord(pluginStore, adapterRepo.path);
  const adapterIdentity = repositories.find((repo) => repo.name === "hermes-paperclip-adapter")!;
  const verifiedManagedBundle = installed.installKind === "managed_immutable_bundle"
    ? await verifyManagedAdapterRecord(installed as unknown as AdapterPluginRecord)
    : null;
  const managedBundle = asRecord(verifiedManagedBundle);
  const managedInstall = verifiedManagedBundle !== null;
  const packageName = managedInstall ? nullableString(managedBundle.packageName) : nullableString(adapterPackage.name);
  const packageVersion = managedInstall ? nullableString(managedBundle.packageVersion) : nullableString(adapterPackage.version);
  const pluginStoreVersion = nullableString(installed.version);
  const localPath = nullableString(installed.localPath);
  const adapter = {
    package_name: packageName,
    package_version: packageVersion,
    plugin_store_version: pluginStoreVersion,
    plugin_store_mode: managedInstall ? "immutable_bundle" as const : localPath ? "development_local_path" as const : "missing" as const,
    git_commit: managedInstall ? nullableString(managedBundle.sourceGitHead) : adapterIdentity.head,
    git_branch: adapterIdentity.branch,
    file_manifest_sha256: managedInstall
      ? nullableString(managedBundle.manifestSha256)
      : await computeTrackedFileManifestSha256(adapterRepo.path, command),
  };

  const [stageRows, blockerRows, targetWorkflow, providerRows] = await Promise.all([
    db.select({ stage: profitFlywheelStageRuns.stage, state: profitFlywheelStageRuns.state })
      .from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.companyId, options.companyId)),
    db.select({ blockerCode: profitFlywheelStageRuns.blockerCode })
      .from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.companyId, options.companyId),
        eq(profitFlywheelStageRuns.state, "blocked"),
      )),
    db.select().from(profitFlywheelWorkflows).where(and(
      eq(profitFlywheelWorkflows.companyId, options.companyId),
      eq(profitFlywheelWorkflows.runId, options.targetWorkflowRunId),
    )).then((rows) => rows[0] ?? null),
    db.select().from(profitFlywheelProviderHealth)
      .where(eq(profitFlywheelProviderHealth.companyId, options.companyId))
      .orderBy(desc(profitFlywheelProviderHealth.updatedAt)),
  ]);
  const latestEvent = targetWorkflow
    ? await db.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.companyId, options.companyId),
        eq(profitFlywheelEvents.workflowId, targetWorkflow.id),
      )).orderBy(desc(profitFlywheelEvents.createdAt)).then((rows) => rows[0] ?? null)
    : null;

  const stageCountsMap = new Map<string, number>();
  for (const row of stageRows) stageCountsMap.set(`${row.stage}\0${row.state}`, (stageCountsMap.get(`${row.stage}\0${row.state}`) ?? 0) + 1);
  const stageCounts = [...stageCountsMap].map(([key, count]) => {
    const [stage, state] = key.split("\0");
    return { stage: stage!, state: state!, count };
  }).sort((left, right) => left.stage.localeCompare(right.stage) || left.state.localeCompare(right.state));
  const blockerCountsMap = new Map<string, number>();
  for (const row of blockerRows) {
    const code = row.blockerCode?.trim() || "unknown";
    blockerCountsMap.set(code, (blockerCountsMap.get(code) ?? 0) + 1);
  }
  const blockerCounts = [...blockerCountsMap].map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  const activePolicy = providerRows[0]
    ? { sha256: providerRows[0].policySha256, schemaSha256: providerRows[0].policySchemaSha256 }
    : null;
  const activeProviderRows = activePolicy
    ? providerRows.filter((row) => row.policySha256 === activePolicy.sha256 && row.policySchemaSha256 === activePolicy.schemaSha256)
    : [];
  const providerRoutes = activeProviderRows.map((row) => ({
    route_id: row.routeId,
    provider_family: row.providerFamily,
    status: row.status as "healthy" | "failed" | "quarantined",
    failure_class: row.failureClass,
    observed_at: row.observedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  })).sort((left, right) => left.route_id.localeCompare(right.route_id));

  const tokenomicsRaw = asRecord(await readBoundedJson(options.tokenomicsReceiptPath, "factory_baseline_tokenomics_receipt"));
  const generatedAt = nullableString(tokenomicsRaw.generatedAt ?? tokenomicsRaw.generated_at);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const ageSeconds = Number.isFinite(generatedAtMs) ? Math.max(0, (now.getTime() - generatedAtMs) / 1000) : null;
  const tokenomics = {
    receipt_path: Object.keys(tokenomicsRaw).length > 0 ? options.tokenomicsReceiptPath : null,
    generated_at: Number.isFinite(generatedAtMs) ? new Date(generatedAtMs).toISOString() : null,
    status: nullableString(tokenomicsRaw.status),
    age_seconds: ageSeconds,
    fresh: ageSeconds !== null && ageSeconds <= 600,
  };

  const fsStats = await statfs(instanceRoot);
  const totalBytes = Number(fsStats.blocks) * Number(fsStats.bsize);
  const freeBytes = Number(fsStats.bfree) * Number(fsStats.bsize);
  const availableBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  const dataRoot = path.join(instanceRoot, "data");
  const [databaseBytes, opsBytes, backupBytes, logBytes, browserUsage] = await Promise.all([
    directorySizeBytes(path.join(instanceRoot, "db"), command),
    directorySizeBytes(path.join(dataRoot, "ops"), command),
    directorySizeBytes(path.join(instanceRoot, "backups"), command),
    directorySizeBytes(path.join(instanceRoot, "logs"), command),
    factoryBrowserUsage(instanceRoot, command),
  ]);
  const promotion = promotionBlockers({ repositories, adapter, tokenomics, diskFreeBytes: availableBytes, providerRoutes, now });
  return {
    schema_version: FACTORY_BASELINE_SCHEMA_VERSION,
    company_id: options.companyId,
    captured_at: now.toISOString(),
    target_workflow: targetWorkflow ? {
      run_id: targetWorkflow.runId,
      workflow_id: targetWorkflow.id,
      state: targetWorkflow.state,
      current_stage: targetWorkflow.currentStage,
      latest_event: latestEvent ? {
        event_id: latestEvent.id,
        event_type: latestEvent.eventType,
        stage_run_id: latestEvent.stageRunId,
        attempt_count: latestEvent.attemptCount,
        next_attempt_at: latestEvent.nextAttemptAt.toISOString(),
        processed_at: latestEvent.processedAt?.toISOString() ?? null,
        last_error: latestEvent.lastError,
      } : null,
    } : null,
    stage_counts: stageCounts,
    blocker_counts: blockerCounts,
    provider_policy: {
      sha256: activePolicy?.sha256 ?? null,
      schema_sha256: activePolicy?.schemaSha256 ?? null,
      routes: providerRoutes,
    },
    repositories,
    adapter,
    tokenomics,
    resources: {
      disk: {
        path: instanceRoot,
        total_bytes: Math.trunc(totalBytes),
        free_bytes: Math.trunc(freeBytes),
        available_bytes: Math.trunc(availableBytes),
        free_percent: totalBytes > 0 ? availableBytes / totalBytes * 100 : 0,
      },
      database_bytes: databaseBytes,
      ops_bytes: opsBytes,
      backup_bytes: backupBytes,
      log_bytes: logBytes,
      factory_browser_processes: browserUsage,
    },
    constraints: {
      live_pos_checkout_preserved: true as const,
      leadforge_excluded: true as const,
      secrets_redacted: true as const,
      promotion_blockers: promotion,
    },
  };
}

async function fsyncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeLatestFactoryBaselinePointer(pointerPath: string, value: unknown) {
  requireAbsolutePath(pointerPath, "factory_baseline_pointer_path");
  const directory = await prepareTrustedReceiptDirectory(path.dirname(pointerPath), "factory_baseline_pointer_directory");
  const target = path.join(directory, path.basename(pointerPath));
  const temporary = path.join(directory, `.${path.basename(pointerPath)}.${process.pid}.${Date.now()}.tmp`);
  const bytes = immutableReceiptBytes(value);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function installFactoryBaselineReceipt(instanceRoot: string, receipt: unknown) {
  const canonicalRoot = await realpath(requireAbsolutePath(instanceRoot, "factory_baseline_instance_root"));
  if (canonicalRoot !== instanceRoot) throw new Error("factory_baseline_instance_root_not_canonical");
  const receiptSha256 = factoryCanonicalJsonSha256(receipt);
  const receiptDirectory = path.join(canonicalRoot, "data", "ops", "factory-baseline", "sha256", receiptSha256.slice(0, 2));
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await prepareTrustedReceiptDirectory(receiptDirectory, "factory_baseline_receipt_directory");
  const receiptPath = path.join(receiptDirectory, `${receiptSha256}.json`);
  const existing = await lstat(receiptPath).catch(() => null);
  if (!existing) {
    const installedHash = await writeImmutableJsonReceipt(receiptPath, factoryCanonicalJsonValue(receipt));
    if (installedHash !== receiptSha256) throw new Error("factory_baseline_receipt_hash_mismatch");
  } else {
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o777) !== 0o444 ||
        sha256(await readFile(receiptPath)) !== receiptSha256) {
      throw new Error("factory_baseline_existing_receipt_invalid");
    }
  }
  const pointerPath = path.join(canonicalRoot, "data", "ops", "factory-baseline", "latest.json");
  await writeLatestFactoryBaselinePointer(pointerPath, {
    schema_version: "paperclip.profit_flywheel_factory_baseline_pointer.v1",
    receipt_path: receiptPath,
    receipt_sha256: receiptSha256,
    generated_at: asRecord(receipt).captured_at,
  });
  return { receiptPath, receiptSha256, pointerPath };
}

const CLI_FLAGS = {
  "--company-id": "companyId",
  "--workflow-run-id": "targetWorkflowRunId",
  "--instance-root": "instanceRoot",
  "--plugin-store": "pluginStorePath",
  "--tokenomics-receipt": "tokenomicsReceiptPath",
  "--portfolio-os-repo": "portfolioOsRepo",
  "--paperclip-repo": "paperclipRepo",
  "--hermes-repo": "hermesRepo",
  "--adapter-repo": "adapterRepo",
} as const;

export function parseFactoryBaselineCliArgs(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const key = CLI_FLAGS[flag as keyof typeof CLI_FLAGS];
    if (!key || flag.includes("=") || values[key]) {
      throw new Error("factory_baseline_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`factory_baseline_argument_missing:${flag}`);
    values[key] = value;
    index += 1;
  }
  for (const [flag, key] of Object.entries(CLI_FLAGS)) {
    if (!values[key]) throw new Error(`factory_baseline_argument_required:${flag}`);
  }
  return {
    companyId: values.companyId!,
    targetWorkflowRunId: values.targetWorkflowRunId!,
    instanceRoot: requireAbsolutePath(values.instanceRoot!, "factory_baseline_instance_root"),
    pluginStorePath: requireAbsolutePath(values.pluginStorePath!, "factory_baseline_plugin_store"),
    tokenomicsReceiptPath: requireAbsolutePath(values.tokenomicsReceiptPath!, "factory_baseline_tokenomics_receipt"),
    repositories: [
      { name: "portfolio-os" as const, path: requireAbsolutePath(values.portfolioOsRepo!, "factory_baseline_portfolio_os_repo") },
      { name: "paperclip" as const, path: requireAbsolutePath(values.paperclipRepo!, "factory_baseline_paperclip_repo") },
      { name: "hermes-agent" as const, path: requireAbsolutePath(values.hermesRepo!, "factory_baseline_hermes_repo") },
      { name: "hermes-paperclip-adapter" as const, path: requireAbsolutePath(values.adapterRepo!, "factory_baseline_adapter_repo") },
    ],
  } satisfies FactoryBaselineOptions;
}

export function resolveEmbeddedFactoryBaselineConnection(config: { databaseMode: string; embeddedPostgresPort: number }) {
  if (config.databaseMode !== "embedded-postgres") throw new Error("factory_baseline_embedded_instance_required");
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("factory_baseline_embedded_port_invalid");
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function usage() {
  return `Usage: pnpm ops:zero-touch-factory-baseline -- ${Object.keys(CLI_FLAGS).map((flag) => `${flag} <value>`).join(" ")}`;
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  if (process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim()) {
    throw new Error("factory_baseline_database_url_forbidden");
  }
  const options = parseFactoryBaselineCliArgs(process.argv.slice(2));
  const { loadConfig } = await import("../config.js");
  const db = createDb(resolveEmbeddedFactoryBaselineConnection(loadConfig()));
  try {
    const receipt = await collectFactoryBaseline(db, options);
    const installed = await installFactoryBaselineReceipt(options.instanceRoot, receipt);
    console.log(JSON.stringify({ status: "succeeded", receipt_path: installed.receiptPath, receipt_sha256: installed.receiptSha256, pointer_path: installed.pointerPath }));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "failed", blocker: error instanceof Error ? error.message : "factory_baseline_unknown_failure" }));
    process.exit(1);
  });
}
