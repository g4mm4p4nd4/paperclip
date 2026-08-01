import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManagedPortfolioOsRuntime } from "../services/managed-pos-runtime.js";

const execFile = promisify(execFileCallback);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILT_AT = "2026-07-15T03:00:00.000Z";
const GITLINK_RELATIVE_PATH = "data/mirror/fixture/runtime-source";
const LEGACY_RUNTIME_CONTRACT_PATHS = [
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json",
  "contracts/paperclip.research_continuation.v1.schema.json",
  "contracts/paperclip.research_plan.v2.schema.json",
  "contracts/paperclip.research_plan.v3.schema.json",
  "contracts/pos.learning_receipt.v2.schema.json",
  "contracts/pos.learning_receipt.v3.schema.json",
  "contracts/pos.managed_runtime_package.v1.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json",
  "contracts/pos.managed_runtime_rollback.v1.schema.json",
  "contracts/pos.managed_runtime_selector.v1.schema.json",
  "contracts/pos.managed_runtime_transition.v1.schema.json",
  "contracts/pos.next_research_authorization.v1.schema.json",
  "contracts/pos.next_research_authorization.v2.schema.json",
  "contracts/pos.paperclip_consumer_crash_journal.v1.schema.json",
  "contracts/pos.paperclip_consumer_envelope.v1.schema.json",
  "contracts/profit-flywheel.v2.json",
  "contracts/profit-flywheel.v2.schema.json",
] as const;

const RUNTIME_CONTRACT_PATHS = [
  "contracts/paperclip.factory_runtime_manifest.v1.schema.json",
  "contracts/paperclip.factory_runtime_manifest.v2.schema.json",
  "contracts/paperclip.research_continuation.v1.schema.json",
  "contracts/paperclip.research_plan.v2.schema.json",
  "contracts/paperclip.research_plan.v3.schema.json",
  "contracts/pos.learning_receipt.v2.schema.json",
  "contracts/pos.learning_receipt.v3.schema.json",
  "contracts/pos.managed_runtime_package.v1.schema.json",
  "contracts/pos.managed_runtime_package.v2.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v1.schema.json",
  "contracts/pos.managed_runtime_pointer_set.v2.schema.json",
  "contracts/pos.managed_runtime_rollback.v1.schema.json",
  "contracts/pos.managed_runtime_rollback.v2.schema.json",
  "contracts/pos.managed_runtime_selector.v1.schema.json",
  "contracts/pos.managed_runtime_selector.v2.schema.json",
  "contracts/pos.managed_runtime_transition.v1.schema.json",
  "contracts/pos.managed_runtime_transition.v2.schema.json",
  "contracts/pos.next_research_authorization.v1.schema.json",
  "contracts/pos.next_research_authorization.v2.schema.json",
  "contracts/pos.paperclip_consumer_crash_journal.v1.schema.json",
  "contracts/pos.paperclip_consumer_envelope.v1.schema.json",
  "contracts/paperclip.fleet_repair_scheduled_value_wave_accept.v2.schema.json",
  "contracts/pos.research_portfolio_corroboration.v1.schema.json",
  "contracts/pos.research_portfolio_cross_review.v1.schema.json",
  "contracts/pos.research_portfolio_primary_dossier.v1.schema.json",
  "contracts/pos.research_portfolio.v1.schema.json",
  "contracts/pos.source_custody.v1.schema.json",
  "contracts/pos.paperclip_provider_policy_authority.v1.schema.json",
  "contracts/pos.paperclip_provider_policy_authority.v2.schema.json",
  "contracts/profit-flywheel.v2.json",
  "contracts/profit-flywheel.v2.schema.json",
] as const;
const ALL_RUNTIME_CONTRACT_PATHS = [...new Set([
  ...LEGACY_RUNTIME_CONTRACT_PATHS,
  ...RUNTIME_CONTRACT_PATHS,
])];
const LEGACY_MANAGED_CONTRACT_SHA256 = {
  "paperclip.factory_runtime_manifest.v1.schema.json":
    "dc0ea3a2c69103f7c889fc0b93f93bef6c4b28fd7d13cc44cd891953c429ddce",
  "pos.managed_runtime_package.v1.schema.json":
    "9d448c3105aaca60adc5c51772fdef0bbd343be06449d71c0d6910fc3baf6628",
  "pos.managed_runtime_pointer_set.v1.schema.json":
    "19fe3f09d8d70d4ac873f31ab3fe63048df800303d4a36435ae86cbb13bd3691",
  "pos.managed_runtime_rollback.v1.schema.json":
    "ba3f172708f0a3bcf9fb1fc7f9cbd0159fa682fbe8f3e00d680710b8a328e30e",
  "pos.managed_runtime_selector.v1.schema.json":
    "266d708a72cc4371995f6e8650b500822952068098920a0f51d663681864a718",
  "pos.managed_runtime_transition.v1.schema.json":
    "f5be589d60157a04ca3d7b3a09c4ebd331d6063b4551e0451c3834873cbf43cd",
} as const;
const MANAGED_CONTRACT_SHA256 = {
  "paperclip.factory_runtime_manifest.v1.schema.json":
    "dc0ea3a2c69103f7c889fc0b93f93bef6c4b28fd7d13cc44cd891953c429ddce",
  "paperclip.factory_runtime_manifest.v2.schema.json":
    "719d2c9eded06069f1a15dd6669c6eb2e2398f6e080c92d4f93f2596498b986c",
  "pos.managed_runtime_package.v1.schema.json":
    "9d448c3105aaca60adc5c51772fdef0bbd343be06449d71c0d6910fc3baf6628",
  "pos.managed_runtime_package.v2.schema.json":
    "2c37b0969c67585ee5bd02a509182aac54baf8eb3915bbbf500cceedaf930dce",
  "pos.managed_runtime_pointer_set.v1.schema.json":
    "19fe3f09d8d70d4ac873f31ab3fe63048df800303d4a36435ae86cbb13bd3691",
  "pos.managed_runtime_pointer_set.v2.schema.json":
    "a392e05a6c5763a7fa4fb80484bc3133899a4dd0a316d33ac889219218158239",
  "pos.managed_runtime_rollback.v1.schema.json":
    "ba3f172708f0a3bcf9fb1fc7f9cbd0159fa682fbe8f3e00d680710b8a328e30e",
  "pos.managed_runtime_rollback.v2.schema.json":
    "6b196a156fbe9d6ab220b24510db7dc2a4c5be528b1856bcace4e2c58e41765e",
  "pos.managed_runtime_selector.v1.schema.json":
    "266d708a72cc4371995f6e8650b500822952068098920a0f51d663681864a718",
  "pos.managed_runtime_selector.v2.schema.json":
    "7b226593b98f1560db26450bad857680b83af552d4f8cb56d54cdc95fde17c6f",
  "pos.managed_runtime_transition.v1.schema.json":
    "f5be589d60157a04ca3d7b3a09c4ebd331d6063b4551e0451c3834873cbf43cd",
  "pos.managed_runtime_transition.v2.schema.json":
    "8b1d951047907585dd897886c810c09713c2bd34948bbf1e3d545a341929129b",
  "pos.paperclip_provider_policy_authority.v1.schema.json":
    "bd800da956bfb3b2966c5b38326fe4b2e0e8049a1153d51c33394cb862c68541",
  "pos.paperclip_provider_policy_authority.v2.schema.json":
    "6e50583d014303664ca9fd17b9f8dd79c78fa8bf96ab316e439b280563736088",
  "paperclip.fleet_repair_scheduled_value_wave_accept.v2.schema.json":
    "0822b9db96eaa5b8a6454c9f4bb075a05026b74f8915a114e149ebe66ee64314",
  "pos.research_portfolio_corroboration.v1.schema.json":
    "f2c2cb7f40a83d3bd31a779f15000d3e092afddf70a618535abf16679acaf30d",
  "pos.research_portfolio_cross_review.v1.schema.json":
    "cbef6b87edd0f6c9e9fb76ebd42be85fbd6d597e81542a1be37ce412f23d5c4c",
  "pos.research_portfolio_primary_dossier.v1.schema.json":
    "a0405fe77defe624d9321526c74eb4f980def3d415fd2893ffea95ebc85247a7",
  "pos.research_portfolio.v1.schema.json":
    "63d325a5f06881ef1aed4bb4d6bce2b514ede5fe0ba17fae883e9f0391947d38",
  "pos.source_custody.v1.schema.json":
    "bfe16becce869330ec6b505cd0a7ed5e90dd00c52531dbe03d81adc45d8fdaa8",
} as const;
const tempRoots: string[] = [];

type JsonObject = Record<string, unknown>;
type SourceFileBinding = { relative_path: string; path: string; sha256: string };
type RuntimeTarget = {
  runtime_id: string;
  closure_sha256: string;
  package_root: string;
  package: { path: string; sha256: string };
  runtime_manifest: { path: string; sha256: string };
};

interface Fixture {
  root: string;
  runtimeRoot: string;
  cacheRoot: string;
  outputRoot: string;
  interpreterPath: string;
  gitlinkPath: string;
  current: RuntimeTarget;
  previous: RuntimeTarget;
  providerPolicyAuthority: { path: string; sha256: string };
  selectorPath: string;
  pointerPath: string;
}

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

async function writeBytes(filePath: string, bytes: Buffer | string, mode = 0o644) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes, { mode });
  await chmod(filePath, mode);
}

async function gitText(repository: string, args: string[]) {
  const result = await execFile("git", args, {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Managed Runtime Test",
      GIT_AUTHOR_EMAIL: "managed-runtime@example.invalid",
      GIT_COMMITTER_NAME: "Managed Runtime Test",
      GIT_COMMITTER_EMAIL: "managed-runtime@example.invalid",
      GIT_AUTHOR_DATE: "2026-07-15T03:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-15T03:00:00Z",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function gitBuffer(repository: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFileCallback("git", args, {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error || !Buffer.isBuffer(stdout)) reject(error ?? new Error("git_buffer_failed"));
      else resolve(stdout);
    });
  });
}

function parseTreeEntries(raw: Buffer) {
  const files: Array<{ mode: string; path: string; sha256: string }> = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index < raw.length && raw[index] !== 0) continue;
    if (index > start) {
      const record = raw.subarray(start, index);
      const separator = record.indexOf(0x09);
      const [mode, , sha256] = record.subarray(0, separator).toString("ascii").split(" ");
      files.push({
        mode: mode!,
        path: new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(separator + 1)),
        sha256: sha256!,
      });
    }
    start = index + 1;
  }
  return files.sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
}

async function makeReadOnly(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    const handle = await opendir(root);
    try {
      for await (const entry of handle) await makeReadOnly(path.join(root, entry.name));
    } finally {
      await handle.close().catch(() => undefined);
    }
    await chmod(root, 0o555);
    return;
  }
  await chmod(root, (metadata.mode & 0o111) === 0 ? 0o444 : 0o555);
}

async function makeWritableForCleanup(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(root, 0o755).catch(() => undefined);
    const handle = await opendir(root).catch(() => null);
    if (handle) {
      try {
        for await (const entry of handle) await makeWritableForCleanup(path.join(root, entry.name));
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  } else {
    await chmod(root, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await makeWritableForCleanup(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function createSource(root: string) {
  const gitlinkSource = path.join(root, "gitlink-source");
  await mkdir(gitlinkSource);
  await gitText(gitlinkSource, ["init", "-b", "main"]);
  await writeBytes(path.join(gitlinkSource, "README.md"), "immutable gitlink fixture\n");
  await gitText(gitlinkSource, ["add", "README.md"]);
  await gitText(gitlinkSource, ["commit", "-m", "test: gitlink source"]);
  const gitlinkCommit = (await gitText(gitlinkSource, ["rev-parse", "HEAD"])).trim();

  const source = path.join(root, "source");
  await mkdir(source);
  await gitText(source, ["init", "-b", "main"]);
  await writeBytes(path.join(source, "bin/pos"), "#!/bin/sh\nexit 0\n", 0o755);
  await writeBytes(path.join(source, "uv.lock"), "version = 1\nrevision = 1\n");
  await writeBytes(
    path.join(source, "config/research_sources.yaml"),
    "schema_version: pos.research_sources.v2\nsources: []\n",
  );
  for (const relativePath of ALL_RUNTIME_CONTRACT_PATHS) {
    const basename = path.basename(relativePath);
    const managedMirror = path.join(REPO_ROOT, "contracts/profit-flywheel", basename);
    const bytes = Object.hasOwn(MANAGED_CONTRACT_SHA256, basename) ||
      Object.hasOwn(LEGACY_MANAGED_CONTRACT_SHA256, basename)
      ? await readFile(managedMirror)
      : Buffer.from(`${JSON.stringify({ fixture: relativePath })}\n`, "utf8");
    await writeBytes(path.join(source, relativePath), bytes);
  }
  await writeBytes(path.join(source, "revision.txt"), "one\n");
  await gitText(source, ["add", "."]);
  await mkdir(path.join(source, ...GITLINK_RELATIVE_PATH.split("/")), { recursive: true });
  await gitText(source, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkCommit},${GITLINK_RELATIVE_PATH}`,
  ]);
  await gitText(source, ["commit", "-m", "test: managed runtime source one"]);
  const firstCommit = (await gitText(source, ["rev-parse", "HEAD"])).trim();
  await writeBytes(path.join(source, "revision.txt"), "two\n");
  await gitText(source, ["add", "revision.txt"]);
  await gitText(source, ["commit", "-m", "test: managed runtime source two"]);
  const secondCommit = (await gitText(source, ["rev-parse", "HEAD"])).trim();
  return { source, firstCommit, secondCommit };
}

async function sourceDescriptor(source: string, commit: string) {
  const tree = await gitBuffer(source, ["ls-tree", "-r", "--full-tree", commit]);
  const entries = await gitBuffer(source, ["ls-tree", "-rz", "--full-tree", commit]);
  return {
    repository: source,
    commit,
    tree_sha256: digest(tree),
    tracked_files_sha256: digest(canonicalBytes({ files: parseTreeEntries(entries) })),
    clean: true as const,
  };
}

async function relativeAllowlist(
  source: string,
  commit: string,
  contractPaths: readonly string[],
) {
  const binding = async (relativePath: string) => ({
    relative_path: relativePath,
    sha256: digest(await gitBuffer(source, ["show", `${commit}:${relativePath}`])),
  });
  return {
    entrypoints: [await binding("bin/pos")],
    dependency_locks: [await binding("uv.lock")],
    source_registry: await binding("config/research_sources.yaml"),
    contracts: await Promise.all(contractPaths.map(binding)),
  };
}

async function createProviderPolicyAuthority(runtimeRoot: string) {
  const descriptor = {
    schema_version: "pos.paperclip_provider_policy_authority.v1",
    authority: "paperclip_control_plane",
    provider_policy: {
      path: path.join(runtimeRoot, "packages", "a".repeat(64), "config", "provider-policy.v2.json"),
      sha256: "a".repeat(64),
      schema_version: "provider-policy.v2",
      schema_path: path.join(runtimeRoot, "packages", "a".repeat(64), "config", "provider-policy.v2.schema.json"),
      schema_sha256: "b".repeat(64),
    },
  };
  const bytes = canonicalBytes(descriptor);
  const authorityPath = path.join(runtimeRoot, "authorities", "provider-policy", `${digest(bytes)}.json`);
  await writeBytes(authorityPath, bytes, 0o444);
  return { path: authorityPath, sha256: digest(bytes) };
}

function absoluteBinding(packageRoot: string, value: { relative_path: string; sha256: string }) {
  return { ...value, path: path.join(packageRoot, ...value.relative_path.split("/")) };
}

async function buildPackage(input: {
  source: string;
  commit: string;
  runtimeRoot: string;
  cacheRoot: string;
  outputRoot: string;
  schemaVersion: "v1" | "v2";
  providerPolicyAuthority?: { path: string; sha256: string };
  toolchain: JsonObject;
}) {
  const source = await sourceDescriptor(input.source, input.commit);
  const authorityBound = input.schemaVersion === "v2";
  const providerPolicyAuthority = authorityBound ? input.providerPolicyAuthority : null;
  if (authorityBound && !providerPolicyAuthority) throw new Error("fixture_provider_policy_authority_missing");
  const allowlist = await relativeAllowlist(
    input.source,
    input.commit,
    authorityBound ? RUNTIME_CONTRACT_PATHS : LEGACY_RUNTIME_CONTRACT_PATHS,
  );
  const closure = {
    schema_version: authorityBound ? "pos.managed_runtime_closure.v2" : "pos.managed_runtime_closure.v1",
    source,
    allowlist,
    toolchain: input.toolchain,
    writable_roots: { cache: input.cacheRoot, output: input.outputRoot },
    built_at: BUILT_AT,
    ...(providerPolicyAuthority ? { provider_policy_authority: providerPolicyAuthority } : {}),
  };
  const closureSha256 = digest(canonicalBytes(closure));
  const runtimeId = `portfolio-os-${closureSha256}`;
  const packageRoot = path.join(input.runtimeRoot, "packages", closureSha256);
  await execFile("git", [
    "clone", "--quiet", "--no-hardlinks", "--no-checkout", input.source, packageRoot,
  ]);
  await gitText(packageRoot, ["checkout", "--quiet", "--detach", input.commit]);
  await gitText(packageRoot, ["config", "core.filemode", "true"]);
  const excludePath = path.join(packageRoot, ".git/info/exclude");
  const exclude = await readFile(excludePath, "utf8");
  await writeFile(excludePath, `${exclude.endsWith("\n") ? exclude : `${exclude}\n`}.runtime/\n.venv/\n`);

  const absoluteAllowlist = {
    entrypoints: allowlist.entrypoints.map((value) => absoluteBinding(packageRoot, value)),
    dependency_locks: allowlist.dependency_locks.map((value) => absoluteBinding(packageRoot, value)),
    source_registry: absoluteBinding(packageRoot, allowlist.source_registry),
    contracts: allowlist.contracts.map((value) => absoluteBinding(packageRoot, value)),
  };
  const wrapper = `#!/bin/sh\nexec ${input.toolchain.interpreter_path as string} "$@"\n`;
  await writeBytes(path.join(packageRoot, ".venv/bin/python"), wrapper, 0o755);
  const manifestPath = path.join(packageRoot, ".runtime/runtime-manifest.json");
  const manifest = {
    schema_version: authorityBound ? "paperclip.factory_runtime_manifest.v2" : "paperclip.factory_runtime_manifest.v1",
    runtime_id: runtimeId,
    runtime_kind: "portfolio_os",
    source: {
      repository: packageRoot,
      commit: input.commit,
      tree_sha256: source.tree_sha256,
      clean: true,
    },
    executable: {
      path: absoluteAllowlist.entrypoints[0]!.path,
      sha256: absoluteAllowlist.entrypoints[0]!.sha256,
    },
    interpreter: {
      path: input.toolchain.interpreter_path,
      version: input.toolchain.version,
      identity_sha256: input.toolchain.identity_sha256,
    },
    dependency_lock: {
      path: absoluteAllowlist.dependency_locks[0]!.path,
      sha256: absoluteAllowlist.dependency_locks[0]!.sha256,
    },
    contracts: absoluteAllowlist.contracts.map(({ path: contractPath, sha256 }) => ({
      path: contractPath,
      sha256,
    })),
    source_registry: {
      path: absoluteAllowlist.source_registry.path,
      sha256: absoluteAllowlist.source_registry.sha256,
    },
    writable_roots: [input.cacheRoot, input.outputRoot],
    built_at: BUILT_AT,
    ...(providerPolicyAuthority ? { provider_policy_authority: providerPolicyAuthority } : {}),
  };
  const manifestBytes = canonicalBytes(manifest);
  await writeBytes(manifestPath, manifestBytes, 0o444);
  const packagePath = path.join(packageRoot, ".runtime/package.json");
  const descriptor = {
    schema_version: authorityBound ? "pos.managed_runtime_package.v2" : "pos.managed_runtime_package.v1",
    runtime_id: runtimeId,
    closure_sha256: closureSha256,
    package_root: packageRoot,
    source,
    allowlist: absoluteAllowlist,
    toolchain: input.toolchain,
    writable_roots: { cache: input.cacheRoot, output: input.outputRoot },
    runtime_manifest: { path: manifestPath, sha256: digest(manifestBytes) },
    built_at: BUILT_AT,
    read_only: true,
    ...(providerPolicyAuthority ? { provider_policy_authority: providerPolicyAuthority } : {}),
  };
  const packageBytes = canonicalBytes(descriptor);
  await writeBytes(packagePath, packageBytes, 0o444);
  await makeReadOnly(packageRoot);
  return {
    runtime_id: runtimeId,
    closure_sha256: closureSha256,
    package_root: packageRoot,
    package: { path: packagePath, sha256: digest(packageBytes) },
    runtime_manifest: { path: manifestPath, sha256: digest(manifestBytes) },
  } satisfies RuntimeTarget;
}

async function createFixture(options: {
  cacheOverlapsPackages?: boolean;
  currentSchemaVersion?: "v1" | "v2";
  omitPrevious?: boolean;
  pointerSchemaVersion?: "v1" | "v2";
  previousSchemaVersion?: "v1" | "v2";
  selectorSchemaVersion?: "v1" | "v2";
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-pos-")));
  tempRoots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const cacheRoot = options.cacheOverlapsPackages ? runtimeRoot : path.join(root, "cache");
  const outputRoot = path.join(root, "output");
  const roots = [
    mkdir(path.join(runtimeRoot, "packages"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "control/pointer-sets"), { recursive: true }),
    mkdir(outputRoot),
  ];
  if (!options.cacheOverlapsPackages) roots.push(mkdir(cacheRoot));
  await Promise.all(roots);
  const { source, firstCommit, secondCommit } = await createSource(root);
  const dependencies = ["jsonschema", "PyYAML", "referencing"].map((name) => ({
    name,
    version: "1.0.0",
    files_sha256: digest(`${name}-installed-files`),
  }));
  const observedToolchain = {
    version: "3.13.0",
    implementation: "cpython",
    cache_tag: "cpython-313",
    platform: "managed-pos-test-platform",
    dependencies,
  };
  const interpreterPath = path.join(root, "fixture-python");
  await writeBytes(
    interpreterPath,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(observedToolchain)}'\n`,
    0o755,
  );
  const toolchain = {
    interpreter_path: interpreterPath,
    ...observedToolchain,
    identity_sha256: digest(`${interpreterPath}\0${observedToolchain.version}\n`),
    binary_sha256: digest(await readFile(interpreterPath)),
  };
  const providerPolicyAuthority = await createProviderPolicyAuthority(runtimeRoot);
  const currentSchemaVersion = options.currentSchemaVersion ?? "v2";
  const previousSchemaVersion = options.previousSchemaVersion ?? "v1";
  const pointerSchemaVersion = options.pointerSchemaVersion ?? currentSchemaVersion;
  const selectorSchemaVersion = options.selectorSchemaVersion ?? pointerSchemaVersion;
  const previous = await buildPackage({
    source,
    commit: firstCommit,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    schemaVersion: previousSchemaVersion,
    providerPolicyAuthority: previousSchemaVersion === "v2" ? providerPolicyAuthority : undefined,
    toolchain,
  });
  const current = await buildPackage({
    source,
    commit: secondCommit,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    schemaVersion: currentSchemaVersion,
    providerPolicyAuthority: currentSchemaVersion === "v2" ? providerPolicyAuthority : undefined,
    toolchain,
  });
  const pointerSet = {
    schema_version: pointerSchemaVersion === "v2"
      ? "pos.managed_runtime_pointer_set.v2"
      : "pos.managed_runtime_pointer_set.v1",
    generation: 2,
    current,
    previous: options.omitPrevious ? null : previous,
    activated_at: "2026-07-15T04:05:00.000Z",
  };
  const pointerBytes = canonicalBytes(pointerSet);
  const pointerSha256 = digest(pointerBytes);
  const pointerPath = path.join(runtimeRoot, "control/pointer-sets", `${pointerSha256}.json`);
  await writeBytes(pointerPath, pointerBytes, 0o444);
  const selectorPath = path.join(runtimeRoot, "control/active.json");
  await writeBytes(selectorPath, canonicalBytes({
    schema_version: selectorSchemaVersion === "v2"
      ? "pos.managed_runtime_selector.v2"
      : "pos.managed_runtime_selector.v1",
    pointer_set: { path: pointerPath, sha256: pointerSha256 },
  }), 0o444);
  return {
    root,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    interpreterPath,
    gitlinkPath: path.join(current.package_root, ...GITLINK_RELATIVE_PATH.split("/")),
    current,
    previous,
    providerPolicyAuthority,
    selectorPath,
    pointerPath,
  };
}

describe("managed POS runtime resolver", () => {
  it("pins the authority-bound producer schemas byte-for-byte", async () => {
    for (const [basename, expectedSha256] of Object.entries({
      ...LEGACY_MANAGED_CONTRACT_SHA256,
      ...MANAGED_CONTRACT_SHA256,
    })) {
      const bytes = await readFile(path.join(REPO_ROOT, "contracts/profit-flywheel", basename));
      expect(digest(bytes), basename).toBe(expectedSha256);
    }
  });

  it("accepts an authority-bound v2 current closure with an exact legacy v1 previous closure", async () => {
    const fixture = await createFixture();
    const resolved = await resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot });
    expect(resolved).toMatchObject({
      schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
      generation: 2,
      current: fixture.current,
      previous: fixture.previous,
      providerPolicyAuthority: fixture.providerPolicyAuthority,
      migrationOnly: false,
      command: {
        executablePath: path.join(fixture.current.package_root, "bin/pos"),
        cwd: fixture.current.package_root,
        runtimeManifestPath: fixture.current.runtime_manifest.path,
        runtimeManifestArgs: ["--runtime-manifest", fixture.current.runtime_manifest.path],
      },
      writableRoots: { cache: fixture.cacheRoot, output: fixture.outputRoot },
    });
    expect(resolved.selector.path).toBe(fixture.selectorPath);
    expect(resolved.pointerSet.path).toBe(fixture.pointerPath);
  });

  it("accepts a real Git commit entry only as an empty read-only gitlink directory", async () => {
    const fixture = await createFixture();
    const treeRecord = (await gitBuffer(fixture.current.package_root, [
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      GITLINK_RELATIVE_PATH,
    ])).toString("utf8");
    expect(treeRecord).toMatch(/^160000 commit [0-9a-f]{40}\t/);
    const metadata = await lstat(fixture.gitlinkPath);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o777).toBe(0o555);
    const handle = await opendir(fixture.gitlinkPath);
    try {
      expect(await handle.read()).toBeNull();
    } finally {
      await handle.close();
    }
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot }))
      .resolves.toMatchObject({ current: fixture.current, migrationOnly: false });
  });

  it("rejects populated, writable, and symlinked gitlink checkout paths", async () => {
    const populated = await createFixture();
    await chmod(populated.gitlinkPath, 0o755);
    await writeBytes(path.join(populated.gitlinkPath, "hidden.json"), "{}\n", 0o444);
    await chmod(populated.gitlinkPath, 0o555);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: populated.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_gitlink_checkout_unsafe");

    const writable = await createFixture();
    await chmod(writable.gitlinkPath, 0o755);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: writable.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");

    const linked = await createFixture();
    const gitlinkParent = path.dirname(linked.gitlinkPath);
    const foreignDirectory = path.join(linked.root, "foreign-gitlink");
    await mkdir(foreignDirectory);
    await chmod(foreignDirectory, 0o555);
    await chmod(gitlinkParent, 0o755);
    await rm(linked.gitlinkPath, { recursive: true });
    await symlink(foreignDirectory, linked.gitlinkPath);
    await chmod(gitlinkParent, 0o555);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: linked.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");
  });

  it("accepts an authority-bound v2 current closure with a v2 previous closure", async () => {
    const fixture = await createFixture({ previousSchemaVersion: "v2" });
    const resolved = await resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot });
    expect(resolved.current).toEqual(fixture.current);
    expect(resolved.previous).toEqual(fixture.previous);
    expect(resolved.providerPolicyAuthority).toEqual(fixture.providerPolicyAuthority);
    expect(resolved.migrationOnly).toBe(false);
  });

  it("accepts an absent previous closure in both pointer generations", async () => {
    const authorityFixture = await createFixture({ omitPrevious: true });
    const authorityResolved = await resolveManagedPortfolioOsRuntime({
      runtimeRoot: authorityFixture.runtimeRoot,
    });
    expect(authorityResolved.previous).toBeNull();
    expect(authorityResolved.migrationOnly).toBe(false);

    const legacyFixture = await createFixture({
      currentSchemaVersion: "v1",
      omitPrevious: true,
      previousSchemaVersion: "v1",
    });
    const legacyResolved = await resolveManagedPortfolioOsRuntime({
      runtimeRoot: legacyFixture.runtimeRoot,
    });
    expect(legacyResolved.previous).toBeNull();
    expect(legacyResolved.migrationOnly).toBe(true);
  });

  it("reports a live-shaped legacy v1 current closure as migration-only without fabricating authority", async () => {
    const fixture = await createFixture({ currentSchemaVersion: "v1", previousSchemaVersion: "v1" });
    const resolved = await resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot });
    expect(resolved.current).toEqual(fixture.current);
    expect(resolved.previous).toEqual(fixture.previous);
    expect(resolved.providerPolicyAuthority).toBeNull();
    expect(resolved.migrationOnly).toBe(true);
  });

  it("accepts the POS v2-selector to retained-v1-pointer rollback state as migration-only", async () => {
    const fixture = await createFixture({
      currentSchemaVersion: "v1",
      previousSchemaVersion: "v1",
      selectorSchemaVersion: "v2",
    });
    const resolved = await resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot });
    expect(resolved.current).toEqual(fixture.current);
    expect(resolved.previous).toEqual(fixture.previous);
    expect(resolved.providerPolicyAuthority).toBeNull();
    expect(resolved.migrationOnly).toBe(true);
  });

  it("rejects selectors and pointer sets that forge cross-generation authority", async () => {
    const legacySelectorToV2Pointer = await createFixture({
      currentSchemaVersion: "v2",
      pointerSchemaVersion: "v2",
      previousSchemaVersion: "v1",
      selectorSchemaVersion: "v1",
    });
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: legacySelectorToV2Pointer.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_selector_pointer_generation_mismatch");

    const legacyPointerToV2Current = await createFixture({
      currentSchemaVersion: "v2",
      pointerSchemaVersion: "v1",
      previousSchemaVersion: "v1",
      selectorSchemaVersion: "v1",
    });
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: legacyPointerToV2Current.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_pointer_current_generation_mismatch");

    const legacyPointerToV2Previous = await createFixture({
      currentSchemaVersion: "v1",
      pointerSchemaVersion: "v1",
      previousSchemaVersion: "v2",
      selectorSchemaVersion: "v1",
    });
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: legacyPointerToV2Previous.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_pointer_previous_generation_mismatch");

    const authorityPointerToV1Current = await createFixture({
      currentSchemaVersion: "v1",
      pointerSchemaVersion: "v2",
      previousSchemaVersion: "v1",
      selectorSchemaVersion: "v2",
    });
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: authorityPointerToV1Current.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_pointer_current_generation_mismatch");
  }, 15_000);

  it("rejects selector symlinks and pointer-set byte drift", async () => {
    const symlinkFixture = await createFixture();
    const selectorTarget = `${symlinkFixture.selectorPath}.real`;
    await rename(symlinkFixture.selectorPath, selectorTarget);
    await symlink(selectorTarget, symlinkFixture.selectorPath);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: symlinkFixture.runtimeRoot }))
      .rejects.toThrow(/selector_(?:not_canonical|symlink)/);

    const hashFixture = await createFixture();
    await chmod(hashFixture.pointerPath, 0o644);
    await writeFile(hashFixture.pointerPath, Buffer.concat([
      await readFile(hashFixture.pointerPath),
      Buffer.from("\n"),
    ]));
    await chmod(hashFixture.pointerPath, 0o444);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: hashFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_pointer_set_sha256_mismatch");

    const authorityFixture = await createFixture();
    const selector = JSON.parse(await readFile(authorityFixture.selectorPath, "utf8")) as {
      schema_version: string;
      pointer_set: { path: string; sha256: string };
    };
    selector.pointer_set.path = path.join(authorityFixture.runtimeRoot, "control/foreign.json");
    await chmod(authorityFixture.selectorPath, 0o644);
    await writeFile(authorityFixture.selectorPath, canonicalBytes(selector));
    await chmod(authorityFixture.selectorPath, 0o444);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: authorityFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_pointer_set_path_authority_mismatch");
  });

  it("rejects writable current and previous package closures", async () => {
    const fixture = await createFixture();
    const previousLock = path.join(fixture.previous.package_root, "uv.lock");
    await chmod(previousLock, 0o644);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");
    await chmod(previousLock, 0o444);

    await chmod(previousLock, 0o400);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");
    await chmod(previousLock, 0o444);

    const currentLock = path.join(fixture.current.package_root, "uv.lock");
    await chmod(currentLock, 0o644);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");
  });

  it("rejects interpreter and runtime-manifest drift", async () => {
    const interpreterFixture = await createFixture();
    await chmod(interpreterFixture.interpreterPath, 0o755);
    await writeFile(interpreterFixture.interpreterPath, Buffer.concat([
      await readFile(interpreterFixture.interpreterPath),
      Buffer.from("# drift\n"),
    ]));
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: interpreterFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_interpreter_identity_mismatch");

    const manifestFixture = await createFixture();
    const manifestPath = manifestFixture.current.runtime_manifest.path;
    await chmod(manifestPath, 0o644);
    await writeFile(manifestPath, Buffer.concat([await readFile(manifestPath), Buffer.from("\n")]));
    await chmod(manifestPath, 0o444);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: manifestFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_current_manifest_sha256_mismatch");

    const authorityFixture = await createFixture();
    await chmod(authorityFixture.providerPolicyAuthority.path, 0o644);
    await writeFile(authorityFixture.providerPolicyAuthority.path, Buffer.concat([
      await readFile(authorityFixture.providerPolicyAuthority.path),
      Buffer.from("\n"),
    ]));
    await chmod(authorityFixture.providerPolicyAuthority.path, 0o444);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: authorityFixture.runtimeRoot }))
      .rejects.toThrow(/managed_pos_runtime_(?:current|previous)_provider_policy_authority_invalid/);
  });

  it("rejects hidden closure symlinks and writable-root symlinks", async () => {
    const closureFixture = await createFixture();
    const runtimeMetadata = path.join(closureFixture.current.package_root, ".runtime");
    await chmod(runtimeMetadata, 0o755);
    await symlink("runtime-manifest.json", path.join(runtimeMetadata, "injected-link"));
    await chmod(runtimeMetadata, 0o555);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: closureFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_package_tree_unsafe");

    const rootFixture = await createFixture();
    const realCache = `${rootFixture.cacheRoot}.real`;
    await rename(rootFixture.cacheRoot, realCache);
    await symlink(realCache, rootFixture.cacheRoot);
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: rootFixture.runtimeRoot }))
      .rejects.toThrow(/managed_pos_runtime_cache_root_(?:not_canonical|symlink)/);

    const overlapFixture = await createFixture({ cacheOverlapsPackages: true });
    await expect(resolveManagedPortfolioOsRuntime({ runtimeRoot: overlapFixture.runtimeRoot }))
      .rejects.toThrow("managed_pos_runtime_writable_roots_overlap");
  });
});
