import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProviderPolicyV2,
  type ProviderPolicyRoute,
  type ProviderPolicySourceBinding,
} from "../services/provider-policy.js";
import {
  verifyActiveHermesExternalAdapterBinding,
  verifyPolicyOwnedAdapterProvenance,
  verifyProviderPolicySourceBinding,
} from "../services/provider-source-binding.js";
import { getActiveServerAdapterProvenance } from "../adapters/registry.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(root: string, args: string[]) {
  const result = await execFile("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture(): Promise<ProviderPolicySourceBinding> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-source-binding-")));
  roots.push(root);
  await Promise.all([
    writeFile(path.join(root, "index.js"), "export const value = 1;\n", "utf8"),
    writeFile(path.join(root, "receipt-contract.js"), "export const contract = 'v1';\n", "utf8"),
  ]);
  await git(root, ["init", "-q"]);
  await git(root, ["add", "--", "index.js", "receipt-contract.js"]);
  await git(root, ["-c", "user.name=Paperclip Test", "-c", "user.email=test@paperclip.local", "commit", "-qm", "fixture"]);
  const modules = ["index.js", "receipt-contract.js"];
  const hash = createHash("sha256");
  for (const relativePath of modules) {
    hash.update(relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(await readFile(path.join(root, relativePath)));
    hash.update(Buffer.from([0]));
  }
  return {
    repoRoot: root,
    gitRevision: await git(root, ["rev-parse", "HEAD"]),
    gitTree: await git(root, ["rev-parse", "HEAD^{tree}"]),
    criticalModules: modules,
    criticalModulesSha256: hash.digest("hex"),
    requireCleanTree: true,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-policy source binding", () => {
  it("reverifies every distinct Hermes source root in the currently pinned policy", async () => {
    const loaded = await loadProviderPolicyV2();
    const routes = Object.values(loaded.policy.routes)
      .filter((route) => route.runtimeBinding.adapterType === "hermes_local");
    const runtimeBindings = [...new Map(routes.map((route) => [
      route.runtimeBinding.repoRoot,
      route.runtimeBinding,
    ])).values()];
    const adapterBindings = [...new Map(routes.map((route) => [
      route.runtimeBinding.externalAdapter?.repoRoot,
      route.runtimeBinding.externalAdapter,
    ])).values()].filter((binding): binding is ProviderPolicySourceBinding => Boolean(binding));

    expect(runtimeBindings).not.toHaveLength(0);
    expect(adapterBindings).not.toHaveLength(0);
    await Promise.all(runtimeBindings.map((binding) =>
      verifyProviderPolicySourceBinding(binding as ProviderPolicySourceBinding, "pinned Hermes runtime")));
    await Promise.all(adapterBindings.map((binding) =>
      verifyProviderPolicySourceBinding(binding, "pinned Hermes external adapter")));
  });

  it("verifies the exact clean revision, tree, and critical module bytes", async () => {
    const binding = await fixture();
    await expect(verifyProviderPolicySourceBinding(binding, "fixture adapter")).resolves.toEqual({
      repoRoot: binding.repoRoot,
      gitRevision: binding.gitRevision,
      gitTree: binding.gitTree,
      criticalModulesSha256: binding.criticalModulesSha256,
      dirty: false,
    });
  });

  it("fails closed when a critical module changes without a policy revision", async () => {
    const binding = await fixture();
    await writeFile(path.join(binding.repoRoot, "index.js"), "export const value = 2;\n", "utf8");
    const error = await verifyProviderPolicySourceBinding(binding, "fixture adapter").catch((value) => value);
    expect(error).toMatchObject({ code: "provider_source_binding_mismatch" });
    expect(String(error.message)).toMatch(/criticalModulesSha256|requireCleanTree/);
  });

  it("binds a Hermes policy route to the exact loader-owned external module", async () => {
    const binding = await fixture();
    const modulePath = path.join(binding.repoRoot, "index.js");
    const route = {
      runtimeBinding: { adapterType: "hermes_local", externalAdapter: binding },
    } as ProviderPolicyRoute;
    await expect(verifyActiveHermesExternalAdapterBinding(route, {
      kind: "external",
      installKind: "local_path",
      packageName: "fixture-adapter",
      packageRoot: binding.repoRoot,
      modulePath,
      moduleSha256: createHash("sha256").update(await readFile(modulePath)).digest("hex"),
    })).resolves.toMatchObject({ repoRoot: binding.repoRoot, dirty: false });
  });

  it("verifies a managed immutable adapter from manifest-bound bytes without reading a mutable source checkout", async () => {
    const binding = await fixture();
    const modulePath = path.join(binding.repoRoot, "index.js");
    const route = { runtimeBinding: { adapterType: "hermes_local", externalAdapter: binding } } as ProviderPolicyRoute;
    const files = await Promise.all(binding.criticalModules.map(async (relativePath) => {
      const bytes = await readFile(path.join(binding.repoRoot, relativePath));
      return { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mode: "0444" as const };
    }));
    const provenance = {
      kind: "managed_immutable_bundle" as const,
      packageName: "@henkey/hermes-paperclip-adapter",
      packageVersion: "0.2.0",
      packageRoot: binding.repoRoot,
      modulePath,
      moduleSha256: createHash("sha256").update(await readFile(modulePath)).digest("hex"),
      bundleSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      payloadTreeSha256: "3".repeat(64),
      installReceiptSha256: "4".repeat(64),
      sourceGitHead: binding.gitRevision,
      sourceGitTree: binding.gitTree,
      files,
    };
    await expect(verifyActiveHermesExternalAdapterBinding(route, provenance)).resolves.toMatchObject({
      gitRevision: binding.gitRevision,
      gitTree: binding.gitTree,
      criticalModulesSha256: binding.criticalModulesSha256,
      dirty: false,
    });
    await writeFile(modulePath, "export const value = 99;\n", "utf8");
    await expect(verifyActiveHermesExternalAdapterBinding(route, provenance)).rejects.toThrow(/differs from its immutable manifest/);
  });

  it("rejects a builtin, paused, or manually registered Hermes implementation", async () => {
    const binding = await fixture();
    const route = {
      runtimeBinding: { adapterType: "hermes_local", externalAdapter: binding },
    } as ProviderPolicyRoute;
    await expect(verifyActiveHermesExternalAdapterBinding(route, {
      kind: "registered",
      adapterType: "hermes_local",
    })).rejects.toThrow(/requires the pinned external adapter/);
  });

  it("requires in-tree builtin provenance for direct CLI policy routes", async () => {
    const route = {
      id: "codex-policy-route",
      runtimeBinding: { adapterType: "codex_cli" },
    } as ProviderPolicyRoute;
    const builtin = getActiveServerAdapterProvenance("codex_local");
    expect(builtin).not.toBeNull();
    await expect(verifyPolicyOwnedAdapterProvenance(route, "codex_local", builtin!)).resolves.toBeNull();
    await expect(verifyPolicyOwnedAdapterProvenance(route, "codex_local", {
      kind: "builtin",
      adapterType: "codex_local",
    })).rejects.toThrow(/requires the in-tree codex_local adapter/);
    await expect(verifyPolicyOwnedAdapterProvenance(route, "codex_local", {
      kind: "external",
      installKind: "local_path",
      packageName: "untrusted-override",
      packageRoot: "/tmp/untrusted",
      modulePath: "/tmp/untrusted/index.js",
      moduleSha256: "0".repeat(64),
    })).rejects.toThrow(/requires the in-tree codex_local adapter/);
  });
});
