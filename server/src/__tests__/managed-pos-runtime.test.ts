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
const RUNTIME_CONTRACT_PATHS = [
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
const MANAGED_CONTRACT_SHA256 = {
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
  current: RuntimeTarget;
  previous: RuntimeTarget;
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
  const source = path.join(root, "source");
  await mkdir(source);
  await gitText(source, ["init", "-b", "main"]);
  await writeBytes(path.join(source, "bin/pos"), "#!/bin/sh\nexit 0\n", 0o755);
  await writeBytes(path.join(source, "uv.lock"), "version = 1\nrevision = 1\n");
  await writeBytes(
    path.join(source, "config/research_sources.yaml"),
    "schema_version: pos.research_sources.v2\nsources: []\n",
  );
  for (const relativePath of RUNTIME_CONTRACT_PATHS) {
    const basename = path.basename(relativePath);
    const managedMirror = path.join(REPO_ROOT, "contracts/profit-flywheel", basename);
    const bytes = Object.hasOwn(MANAGED_CONTRACT_SHA256, basename)
      ? await readFile(managedMirror)
      : Buffer.from(`${JSON.stringify({ fixture: relativePath })}\n`, "utf8");
    await writeBytes(path.join(source, relativePath), bytes);
  }
  await writeBytes(path.join(source, "revision.txt"), "one\n");
  await gitText(source, ["add", "."]);
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

async function relativeAllowlist(source: string, commit: string) {
  const binding = async (relativePath: string) => ({
    relative_path: relativePath,
    sha256: digest(await gitBuffer(source, ["show", `${commit}:${relativePath}`])),
  });
  return {
    entrypoints: [await binding("bin/pos")],
    dependency_locks: [await binding("uv.lock")],
    source_registry: await binding("config/research_sources.yaml"),
    contracts: await Promise.all(RUNTIME_CONTRACT_PATHS.map(binding)),
  };
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
  toolchain: JsonObject;
}) {
  const source = await sourceDescriptor(input.source, input.commit);
  const allowlist = await relativeAllowlist(input.source, input.commit);
  const closure = {
    schema_version: "pos.managed_runtime_closure.v1",
    source,
    allowlist,
    toolchain: input.toolchain,
    writable_roots: { cache: input.cacheRoot, output: input.outputRoot },
    built_at: BUILT_AT,
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
    schema_version: "paperclip.factory_runtime_manifest.v1",
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
  };
  const manifestBytes = canonicalBytes(manifest);
  await writeBytes(manifestPath, manifestBytes, 0o444);
  const packagePath = path.join(packageRoot, ".runtime/package.json");
  const descriptor = {
    schema_version: "pos.managed_runtime_package.v1",
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

async function createFixture(options: { cacheOverlapsPackages?: boolean } = {}): Promise<Fixture> {
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
  const previous = await buildPackage({
    source,
    commit: firstCommit,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    toolchain,
  });
  const current = await buildPackage({
    source,
    commit: secondCommit,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    toolchain,
  });
  const pointerSet = {
    schema_version: "pos.managed_runtime_pointer_set.v1",
    generation: 2,
    current,
    previous,
    activated_at: "2026-07-15T04:05:00.000Z",
  };
  const pointerBytes = canonicalBytes(pointerSet);
  const pointerSha256 = digest(pointerBytes);
  const pointerPath = path.join(runtimeRoot, "control/pointer-sets", `${pointerSha256}.json`);
  await writeBytes(pointerPath, pointerBytes, 0o444);
  const selectorPath = path.join(runtimeRoot, "control/active.json");
  await writeBytes(selectorPath, canonicalBytes({
    schema_version: "pos.managed_runtime_selector.v1",
    pointer_set: { path: pointerPath, sha256: pointerSha256 },
  }), 0o444);
  return {
    root,
    runtimeRoot,
    cacheRoot,
    outputRoot,
    interpreterPath,
    current,
    previous,
    selectorPath,
    pointerPath,
  };
}

describe("managed POS runtime resolver", () => {
  it("pins the five producer schemas byte-for-byte", async () => {
    for (const [basename, expectedSha256] of Object.entries(MANAGED_CONTRACT_SHA256)) {
      const bytes = await readFile(path.join(REPO_ROOT, "contracts/profit-flywheel", basename));
      expect(digest(bytes), basename).toBe(expectedSha256);
    }
  });

  it("validates current and previous closures and returns one exact invocation", async () => {
    const fixture = await createFixture();
    const resolved = await resolveManagedPortfolioOsRuntime({ runtimeRoot: fixture.runtimeRoot });
    expect(resolved).toMatchObject({
      schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
      generation: 2,
      current: fixture.current,
      previous: fixture.previous,
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
