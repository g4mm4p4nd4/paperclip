import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const OBJECT_TYPES = new Set(["blob", "tree", "commit", "tag"]);
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;

async function runGitBytes(repoRoot: string, args: string[], maxBytes = MAX_OBJECT_BYTES) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        outputTooLarge = true;
        child.kill("SIGKILL");
      }
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 8192 - stderrBytes;
      if (remaining > 0) {
        const bounded = Buffer.from(chunk).subarray(0, remaining);
        stderr.push(bounded);
        stderrBytes += bounded.length;
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("profit_canary_git_object_timeout"));
      } else if (outputTooLarge || bytes > maxBytes) {
        reject(new Error("profit_canary_git_object_too_large"));
      } else if (code !== 0) {
        reject(new Error("profit_canary_git_object_command_failed:" +
          Buffer.concat(stderr).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 512)));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
  });
}

export function canonicalGitObjectSha256(objectType: string, body: Buffer) {
  if (!OBJECT_TYPES.has(objectType)) throw new Error("profit_canary_git_object_type_invalid");
  const header = Buffer.from(objectType + " " + body.byteLength + "\0", "utf8");
  return createHash("sha256").update(header).update(body).digest("hex");
}

export async function computeCanonicalGitObjectSha256(repoRootValue: string, objectIdValue: string) {
  if (!path.isAbsolute(repoRootValue) || path.resolve(repoRootValue) !== repoRootValue ||
      /[\r\n\0]/.test(repoRootValue)) {
    throw new Error("profit_canary_git_repo_path_invalid");
  }
  const metadata = await lstat(repoRootValue).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("profit_canary_git_repo_invalid");
  }
  const repoRoot = await realpath(repoRootValue);
  if (repoRoot !== repoRootValue) throw new Error("profit_canary_git_repo_not_canonical");
  const objectId = objectIdValue.trim().toLowerCase();
  if (!GIT_OBJECT.test(objectId)) throw new Error("profit_canary_git_object_id_invalid");
  const [typeBytes, sizeBytes] = await Promise.all([
    runGitBytes(repoRoot, ["cat-file", "-t", objectId], 128),
    runGitBytes(repoRoot, ["cat-file", "-s", objectId], 128),
  ]);
  const objectType = typeBytes.toString("utf8").trim();
  const declaredSize = Number(sizeBytes.toString("utf8").trim());
  if (!OBJECT_TYPES.has(objectType) || !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 || declaredSize > MAX_OBJECT_BYTES) {
    throw new Error("profit_canary_git_object_metadata_invalid");
  }
  const body = await runGitBytes(repoRoot, ["cat-file", objectType, objectId], declaredSize + 1);
  if (body.byteLength !== declaredSize) throw new Error("profit_canary_git_object_size_mismatch");
  return {
    object: objectId,
    type: objectType,
    byte_length: body.byteLength,
    canonical_header: objectType + " " + body.byteLength + "\\0",
    sha256: canonicalGitObjectSha256(objectType, body),
  };
}

export function parseGitObjectSha256Args(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const allowed = new Set(["--repo", "--object"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag) || flag.includes("=") || values.has(flag)) {
      throw new Error("profit_canary_git_object_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("profit_canary_git_object_argument_missing:" + flag);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) if (!values.has(flag)) throw new Error("profit_canary_git_object_argument_required:" + flag);
  return { repoRoot: values.get("--repo")!, objectId: values.get("--object")! };
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: pnpm ops:git-object-sha256 -- --repo <canonical-absolute-git-root> --object <full-git-object-id>");
    return;
  }
  const input = parseGitObjectSha256Args(process.argv.slice(2));
  console.log(JSON.stringify(await computeCanonicalGitObjectSha256(input.repoRoot, input.objectId)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "profit_canary_git_object_unknown_failure",
    }));
    process.exit(1);
  });
}
