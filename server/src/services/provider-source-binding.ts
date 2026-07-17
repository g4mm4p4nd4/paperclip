import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderPolicyRoute, ProviderPolicySourceBinding } from "./provider-policy.js";
import type { AdapterRuntimeProvenance } from "../adapters/registry.js";
import { isRegistryOwnedBuiltinAdapterProvenance } from "../adapters/registry.js";

const execFile = promisify(execFileCallback);

function sourceBindingError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "provider_source_binding_mismatch" });
}

export type ProviderPolicySourceIdentity = {
  repoRoot: string;
  gitRevision: string;
  gitTree: string;
  criticalModulesSha256: string;
  dirty: false;
};

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repoRoot, ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function verifyProviderPolicySourceBinding(
  binding: ProviderPolicySourceBinding,
  label = "provider-policy source",
): Promise<ProviderPolicySourceIdentity> {
  const configuredRoot = path.resolve(binding.repoRoot);
  const repoRoot = await realpath(configuredRoot);
  if (repoRoot !== configuredRoot) throw sourceBindingError(`${label} repoRoot is not its canonical realpath`);

  const [gitRevision, gitTree, status] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
    git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const hash = createHash("sha256");
  for (const relativePath of [...binding.criticalModules].sort()) {
    const configuredPath = path.resolve(repoRoot, relativePath);
    if (!contains(repoRoot, configuredPath)) throw sourceBindingError(`${label} critical module escaped repoRoot`);
    const modulePath = await realpath(configuredPath);
    if (modulePath !== configuredPath || !contains(repoRoot, modulePath)) {
      throw sourceBindingError(`${label} critical module is a symlink or escaped repoRoot`);
    }
    const moduleStat = await lstat(modulePath);
    if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
      throw sourceBindingError(`${label} critical module is not a regular file`);
    }
    hash.update(relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(await readFile(modulePath));
    hash.update(Buffer.from([0]));
  }
  const criticalModulesSha256 = hash.digest("hex");
  const mismatches = [
    repoRoot !== binding.repoRoot && "repoRoot",
    gitRevision !== binding.gitRevision && "gitRevision",
    gitTree !== binding.gitTree && "gitTree",
    criticalModulesSha256 !== binding.criticalModulesSha256 && "criticalModulesSha256",
    status !== "" && "requireCleanTree",
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw sourceBindingError(`${label} does not match its pinned clean source binding: ${mismatches.join(", ")}`);
  }
  return { repoRoot, gitRevision, gitTree, criticalModulesSha256, dirty: false };
}

export async function verifyHermesExternalAdapterBinding(
  route: ProviderPolicyRoute,
): Promise<ProviderPolicySourceIdentity> {
  if (route.runtimeBinding.adapterType !== "hermes_local" || !route.runtimeBinding.externalAdapter) {
    throw sourceBindingError("Hermes route is missing its external adapter source binding");
  }
  return verifyProviderPolicySourceBinding(route.runtimeBinding.externalAdapter, "Hermes external adapter");
}

export async function verifyActiveHermesExternalAdapterBinding(
  route: ProviderPolicyRoute,
  provenance: AdapterRuntimeProvenance,
): Promise<ProviderPolicySourceIdentity> {
  if (route.runtimeBinding.adapterType !== "hermes_local" || !route.runtimeBinding.externalAdapter) {
    throw sourceBindingError("Hermes route is missing its external adapter source binding");
  }
  const binding = route.runtimeBinding.externalAdapter;
  if (provenance.kind === "managed_immutable_bundle") {
    if (provenance.sourceGitHead !== binding.gitRevision || provenance.sourceGitTree !== binding.gitTree) {
      throw sourceBindingError("Managed Hermes adapter source commit/tree does not match the provider policy");
    }
    const hash = createHash("sha256");
    for (const relativePath of [...binding.criticalModules].sort()) {
      const manifestFile = provenance.files.find((file) => file.path === relativePath);
      if (!manifestFile) throw sourceBindingError(`Managed Hermes adapter manifest lacks critical module ${relativePath}`);
      const configuredPath = path.resolve(provenance.packageRoot, relativePath);
      if (!contains(provenance.packageRoot, configuredPath)) throw sourceBindingError("Managed Hermes adapter critical module escaped its package root");
      const modulePath = await realpath(configuredPath);
      const moduleStat = await lstat(modulePath);
      if (modulePath !== configuredPath || !contains(provenance.packageRoot, modulePath) || !moduleStat.isFile() || moduleStat.isSymbolicLink()) {
        throw sourceBindingError(`Managed Hermes adapter critical module ${relativePath} is not a canonical regular file`);
      }
      const bytes = await readFile(modulePath);
      const observedSha256 = createHash("sha256").update(bytes).digest("hex");
      if (observedSha256 !== manifestFile.sha256 || bytes.length !== manifestFile.bytes) {
        throw sourceBindingError(`Managed Hermes adapter critical module ${relativePath} differs from its immutable manifest`);
      }
      hash.update(relativePath, "utf8");
      hash.update(Buffer.from([0]));
      hash.update(bytes);
      hash.update(Buffer.from([0]));
    }
    const criticalModulesSha256 = hash.digest("hex");
    if (criticalModulesSha256 !== binding.criticalModulesSha256) {
      throw sourceBindingError("Managed Hermes adapter critical modules do not match the provider policy");
    }
    const expectedModulePath = path.join(provenance.packageRoot, "index.js");
    if (provenance.modulePath !== expectedModulePath ||
        provenance.moduleSha256 !== createHash("sha256").update(await readFile(expectedModulePath)).digest("hex")) {
      throw sourceBindingError("Managed Hermes adapter entry point differs from its loader-owned provenance");
    }
    return {
      repoRoot: binding.repoRoot,
      gitRevision: provenance.sourceGitHead,
      gitTree: provenance.sourceGitTree,
      criticalModulesSha256,
      dirty: false,
    };
  }
  const sourceIdentity = await verifyProviderPolicySourceBinding(binding, "Hermes external adapter");
  if (provenance.kind !== "external") {
    throw sourceBindingError(`Hermes policy route requires the pinned external adapter, but active provenance is ${provenance.kind}`);
  }
  const expectedModulePath = path.join(sourceIdentity.repoRoot, "index.js");
  if (provenance.packageRoot !== sourceIdentity.repoRoot || provenance.modulePath !== expectedModulePath) {
    throw sourceBindingError("Active Hermes adapter provenance does not match the pinned external adapter root and entry point");
  }
  const activeModuleSha256 = createHash("sha256").update(await readFile(expectedModulePath)).digest("hex");
  if (provenance.moduleSha256 !== activeModuleSha256) {
    throw sourceBindingError("Active Hermes adapter module bytes do not match the pinned external adapter source");
  }
  return sourceIdentity;
}

export async function verifyPolicyOwnedAdapterProvenance(
  route: ProviderPolicyRoute,
  executionAdapterType: string,
  provenance: AdapterRuntimeProvenance,
) {
  const expectedAdapterType = route.runtimeBinding.adapterType === "codex_cli"
    ? "codex_local"
    : route.runtimeBinding.adapterType === "claude_cli"
      ? "claude_local"
      : route.runtimeBinding.adapterType === "gemini_cli"
        ? "gemini_local"
        : route.runtimeBinding.adapterType;
  if (executionAdapterType !== expectedAdapterType) {
    throw sourceBindingError(`Policy route adapter mapping mismatch: expected ${expectedAdapterType}, got ${executionAdapterType}`);
  }
  if (route.runtimeBinding.adapterType === "hermes_local") {
    return verifyActiveHermesExternalAdapterBinding(route, provenance);
  }
  if (!isRegistryOwnedBuiltinAdapterProvenance(provenance, executionAdapterType)) {
    throw sourceBindingError(
      `Policy route ${route.id} requires the in-tree ${executionAdapterType} adapter, but active provenance is ${provenance.kind}`,
    );
  }
  return null;
}
