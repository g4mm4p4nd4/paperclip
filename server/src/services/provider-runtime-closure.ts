import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { canonicalProviderRouteJson } from "./provider-route-hash.js";
import type {
  ProviderPolicyRoute,
  ProviderRuntimeClosureBinding,
  ProviderRuntimeDirectoryManifestBinding,
  ProviderRuntimeFileBinding,
} from "./provider-policy.js";

const execFile = promisify(execFileCallback);
const DIRECTORY_MANIFEST_DOMAIN = "paperclip.provider-runtime-directory-manifest.v1";
const MAX_DIRECTORY_MANIFEST_ENTRIES = 100_000;
const MAX_DIRECTORY_MANIFEST_BYTES = 2 * 1024 * 1024 * 1024;

export type ProviderRuntimeDirectoryManifest = {
  root: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
};

export type VerifiedProviderRuntimeClosure = {
  commandRealpath: string;
  commandSha256: string;
  observedVersion: string;
  runtimeClosureId: string;
  runtimeClosureSha256: string;
  interpreter?: {
    invocationPath: string;
    realpath: string;
    sha256: string;
    observedVersion: string;
  };
  files: Array<{ path: string; sha256: string; bytes: number }>;
  directories: ProviderRuntimeDirectoryManifest[];
};

function runtimeError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "provider_runtime_closure_mismatch" });
}

function normalizeAbsolutePath(value: string, label: string) {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw runtimeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hashStrictRegularFile(filePath: string, label: string) {
  const configuredPath = normalizeAbsolutePath(filePath, label);
  const observed = await lstat(configuredPath).catch(() => null);
  if (!observed || !observed.isFile() || observed.isSymbolicLink()) {
    throw runtimeError(`${label} is not a no-symlink regular file: ${configuredPath}`);
  }
  const canonicalPath = await realpath(configuredPath);
  if (canonicalPath !== configuredPath) {
    throw runtimeError(`${label} is not its canonical realpath: ${configuredPath}`);
  }
  const handle = await open(
    configuredPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) throw runtimeError(`${label} could not be opened without following symlinks`);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !sameFileIdentity(observed, stats)) {
      throw runtimeError(`${label} changed identity while it was being verified`);
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(configuredPath)]);
    if (
      !afterHandle.isFile() || !afterPath.isFile() || afterPath.isSymbolicLink() ||
      !sameFileIdentity(stats, afterHandle) || !sameFileIdentity(stats, afterPath) ||
      afterHandle.size !== stats.size || afterPath.size !== stats.size ||
      afterHandle.mode !== stats.mode || afterPath.mode !== stats.mode ||
      afterHandle.mtimeMs !== stats.mtimeMs || afterPath.mtimeMs !== stats.mtimeMs ||
      afterHandle.ctimeMs !== stats.ctimeMs || afterPath.ctimeMs !== stats.ctimeMs
    ) {
      throw runtimeError(`${label} changed during bounded verification`);
    }
    return {
      path: canonicalPath,
      sha256: hash.digest("hex"),
      bytes: stats.size,
      mode: stats.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function verifyInvocationPath(input: {
  invocationPath: string;
  expectedRealpath: string;
  label: string;
}) {
  const invocationPath = normalizeAbsolutePath(input.invocationPath, `${input.label}.invocationPath`);
  const observed = await lstat(invocationPath).catch(() => null);
  if (!observed || (!observed.isFile() && !observed.isSymbolicLink())) {
    throw runtimeError(`${input.label} invocation path is unavailable: ${invocationPath}`);
  }
  const resolved = await realpath(invocationPath);
  if (resolved !== normalizeAbsolutePath(input.expectedRealpath, `${input.label}.realpath`)) {
    throw runtimeError(`${input.label} invocation path resolved to ${resolved}, not ${input.expectedRealpath}`);
  }
  return invocationPath;
}

function splitPath(value: string | undefined) {
  return (value ?? "").split(path.delimiter).filter(Boolean);
}

async function resolvePathCommand(command: string, pathValue: string | undefined) {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) throw runtimeError("Interpreter PATH command is invalid");
  for (const directory of splitPath(pathValue)) {
    const candidate = path.resolve(directory, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  return null;
}

async function firstLine(filePath: string) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(512);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  } finally {
    await handle.close();
  }
}

async function observedVersion(input: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  label: string;
}) {
  const result = await execFile(input.command, input.args, {
    cwd: input.cwd,
    env: input.environment,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  }).catch((error: unknown) => {
    const observed = error as { code?: string | number; signal?: string };
    const outcome = observed.signal
      ? `signal ${observed.signal}`
      : `exit ${typeof observed.code === "string" || typeof observed.code === "number" ? observed.code : "unknown"}`;
    throw runtimeError(`${input.label} version probe failed (${outcome})`);
  });
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function providerRuntimeClosureSha256(binding: ProviderRuntimeClosureBinding) {
  return createHash("sha256")
    .update(canonicalProviderRouteJson(binding), "utf8")
    .digest("hex");
}

export async function computeProviderRuntimeDirectoryManifest(
  binding: Pick<ProviderRuntimeDirectoryManifestBinding, "root" | "rejectSymlinks">,
): Promise<ProviderRuntimeDirectoryManifest> {
  const root = normalizeAbsolutePath(binding.root, "runtime closure directory root");
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw runtimeError(`Runtime closure directory is not a no-symlink directory: ${root}`);
  }
  if (await realpath(root) !== root) {
    throw runtimeError(`Runtime closure directory is not its canonical realpath: ${root}`);
  }
  const hash = createHash("sha256");
  hash.update(DIRECTORY_MANIFEST_DOMAIN, "utf8");
  hash.update(Buffer.from([0]));
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw runtimeError(`Runtime closure entry escaped its root: ${absolute}`);
      }
      if (entry.isSymbolicLink()) {
        if (binding.rejectSymlinks) {
          throw runtimeError(`Runtime closure contains a forbidden symlink: ${absolute}`);
        }
        const target = await readlink(absolute);
        hash.update(`L\0${relative}\0${target}\0`, "utf8");
        continue;
      }
      if (entry.isDirectory()) {
        const before = await lstat(absolute);
        if (!before.isDirectory() || before.isSymbolicLink()) {
          throw runtimeError(`Runtime closure directory changed type: ${absolute}`);
        }
        await visit(absolute);
        const after = await lstat(absolute);
        if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(before, after)) {
          throw runtimeError(`Runtime closure directory changed identity: ${absolute}`);
        }
        continue;
      }
      if (!entry.isFile()) {
        throw runtimeError(`Runtime closure contains a non-file entry: ${absolute}`);
      }
      const file = await hashStrictRegularFile(absolute, "runtime closure file");
      fileCount += 1;
      totalBytes += file.bytes;
      if (fileCount > MAX_DIRECTORY_MANIFEST_ENTRIES || totalBytes > MAX_DIRECTORY_MANIFEST_BYTES) {
        throw runtimeError("Runtime closure directory exceeds bounded verification limits");
      }
      hash.update(`F\0${relative}\0${file.mode.toString(8)}\0${file.bytes}\0${file.sha256}\0`, "utf8");
    }
  };

  await visit(root);
  const rootAfter = await lstat(root);
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !sameFileIdentity(rootStats, rootAfter)) {
    throw runtimeError(`Runtime closure directory root changed identity: ${root}`);
  }
  return { root, manifestSha256: hash.digest("hex"), fileCount, totalBytes };
}

async function verifyPinnedFile(binding: ProviderRuntimeFileBinding) {
  const observed = await hashStrictRegularFile(binding.path, "runtime closure pinned file");
  if (observed.sha256 !== binding.sha256) {
    throw runtimeError(`Runtime closure file hash mismatch: ${binding.path}`);
  }
  return { path: observed.path, sha256: observed.sha256, bytes: observed.bytes };
}

export async function verifyProviderPolicyRuntimeClosure(
  route: ProviderPolicyRoute,
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    verifyVersions?: boolean;
  } = {},
): Promise<VerifiedProviderRuntimeClosure> {
  const binding = route.runtimeBinding;
  const closure = binding.runtimeClosure;
  const environment = { ...(options.environment ?? process.env) };
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const command = await hashStrictRegularFile(binding.commandRealpath, "provider runtime command");
  if (command.path !== binding.commandRealpath || command.sha256 !== binding.commandSha256) {
    throw runtimeError(`Provider runtime command does not match the pinned realpath/hash for ${route.id}`);
  }
  await access(command.path, fsConstants.X_OK).catch(() => {
    throw runtimeError(`Provider runtime command is not executable: ${command.path}`);
  });
  const closureSha256 = providerRuntimeClosureSha256(closure);
  if (closureSha256 !== binding.runtimeClosureSha256) {
    throw runtimeError(`Provider runtime closure descriptor hash does not match policy for ${route.id}`);
  }

  let interpreter: VerifiedProviderRuntimeClosure["interpreter"];
  if (closure.interpreter) {
    const expected = closure.interpreter;
    const invocationPath = await verifyInvocationPath({
      invocationPath: expected.invocationPath,
      expectedRealpath: expected.realpath,
      label: "provider runtime interpreter",
    });
    if (expected.pathCommand) {
      const resolvedFromPath = await resolvePathCommand(expected.pathCommand, environment.PATH);
      if (resolvedFromPath !== invocationPath) {
        throw runtimeError(
          `Provider runtime PATH resolves ${expected.pathCommand} to ${resolvedFromPath ?? "nothing"}, not ${invocationPath}`,
        );
      }
    }
    const executable = await hashStrictRegularFile(expected.realpath, "provider runtime interpreter executable");
    if (executable.sha256 !== expected.sha256) {
      throw runtimeError(`Provider runtime interpreter hash mismatch: ${expected.realpath}`);
    }
    const observedShebang = await firstLine(command.path);
    if (observedShebang !== expected.shebang) {
      throw runtimeError(`Provider runtime command shebang does not match policy for ${route.id}`);
    }
    const version = options.verifyVersions === false
      ? expected.expectedVersion
      : await observedVersion({
          command: executable.path,
          args: expected.versionArgs,
          cwd,
          environment,
          label: "Provider runtime interpreter",
        });
    if (version !== expected.expectedVersion) {
      throw runtimeError(`Provider runtime interpreter version mismatch for ${route.id}`);
    }
    interpreter = {
      invocationPath,
      realpath: executable.path,
      sha256: executable.sha256,
      observedVersion: version,
    };
  }

  const files = [];
  for (const file of closure.files) files.push(await verifyPinnedFile(file));
  const directories = [];
  for (const directory of closure.directories) {
    const observed = await computeProviderRuntimeDirectoryManifest(directory);
    if (
      observed.manifestSha256 !== directory.manifestSha256 ||
      observed.fileCount !== directory.fileCount ||
      observed.totalBytes !== directory.totalBytes
    ) {
      throw runtimeError(`Provider runtime directory manifest mismatch: ${directory.root}`);
    }
    directories.push(observed);
  }

  const version = options.verifyVersions === false
    ? binding.expectedVersion
    : await observedVersion({
        command: command.path,
        args: binding.versionArgs,
        cwd,
        environment,
        label: "Provider runtime command",
      });
  if (version !== binding.expectedVersion) {
    throw runtimeError(`Provider runtime command version mismatch for ${route.id}`);
  }
  return {
    commandRealpath: command.path,
    commandSha256: command.sha256,
    observedVersion: version,
    runtimeClosureId: binding.runtimeClosureId,
    runtimeClosureSha256: closureSha256,
    ...(interpreter ? { interpreter } : {}),
    files,
    directories,
  };
}
