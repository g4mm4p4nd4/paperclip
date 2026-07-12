import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProviderPolicyV2,
  type ProviderPolicyRoute,
  type ProviderRuntimeClosureBinding,
} from "../services/provider-policy.js";
import {
  computeProviderRuntimeDirectoryManifest,
  providerRuntimeClosureSha256,
  verifyProviderPolicyRuntimeClosure,
} from "../services/provider-runtime-closure.js";

const roots: string[] = [];

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-closure-")));
  roots.push(root);
  return root;
}

async function sha256(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider runtime dependency closure", () => {
  it.runIf(existsSync("/Users/mnm/Documents/Github/hermes-agent/venv/bin/hermes"))(
    "verifies every distinct frozen host runtime without provider traffic",
    async () => {
      const loaded = await loadProviderPolicyV2();
      const routeIds = ["opencode_go_flash", "gemini_flash", "codex_fast", "claude_sonnet"];
      const observed = [];
      for (const routeId of routeIds) {
        const route = loaded.policy.routes[routeId]!;
        observed.push(await verifyProviderPolicyRuntimeClosure(route, {
          environment: process.env,
          verifyVersions: false,
        }));
      }
      expect(observed.map((entry) => entry.runtimeClosureId)).toEqual([
        "hermes_python_0_18_2_frozen_06e1dcfe",
        "gemini_node_0_50_0",
        "codex_native_0_136_0",
        "claude_native_2_1_185",
      ]);
      expect(observed.map((entry, index) => entry.directories.map((directory) => ({
        manifestSha256: directory.manifestSha256,
        fileCount: directory.fileCount,
        totalBytes: directory.totalBytes,
      })))).toEqual(routeIds.map((routeId) => loaded.policy.routes[routeId]!.runtimeBinding.runtimeClosure.directories.map((directory) => ({
        manifestSha256: directory.manifestSha256,
        fileCount: directory.fileCount,
        totalBytes: directory.totalBytes,
      }))));
    },
    120_000,
  );

  it("verifies a native command closure and rejects command drift", async () => {
    const root = await fixtureRoot();
    const command = path.join(root, "fixture-runtime");
    const dependencyRoot = path.join(root, "dependencies");
    await mkdir(dependencyRoot);
    await Promise.all([
      writeFile(command, "#!/bin/sh\nprintf 'fixture-runtime 1.0\\n'\n", { mode: 0o755 }),
      writeFile(path.join(dependencyRoot, "module.js"), "export const value = 1;\n"),
      writeFile(path.join(dependencyRoot, "module.pth"), "import fixture_bootstrap\n"),
    ]);
    await chmod(command, 0o755);
    const manifest = await computeProviderRuntimeDirectoryManifest({
      root: dependencyRoot,
      rejectSymlinks: true,
    });
    const closure: ProviderRuntimeClosureBinding = {
      schemaVersion: "provider-runtime-closure.v1",
      kind: "native_binary",
      files: [{ path: command, sha256: await sha256(command) }],
      directories: [],
    };
    // The native command is pinned separately. A second manifest exercises the
    // same canonical directory algorithm used by Node and Python closures.
    expect(manifest).toMatchObject({ fileCount: 2, totalBytes: expect.any(Number) });
    const route = {
      id: "fixture-native",
      runtimeBinding: {
        commandRealpath: command,
        commandSha256: await sha256(command),
        expectedVersion: "fixture-runtime 1.0",
        versionArgs: ["--version"],
        runtimeClosureId: "fixture_native",
        runtimeClosureSha256: providerRuntimeClosureSha256(closure),
        runtimeClosure: closure,
      },
    } as ProviderPolicyRoute;
    await expect(verifyProviderPolicyRuntimeClosure(route, { environment: process.env })).resolves.toMatchObject({
      commandRealpath: command,
      observedVersion: "fixture-runtime 1.0",
      runtimeClosureSha256: route.runtimeBinding.runtimeClosureSha256,
    });

    await writeFile(command, "#!/bin/sh\nprintf 'fixture-runtime compromised\\n'\n", { mode: 0o755 });
    await expect(verifyProviderPolicyRuntimeClosure(route, { environment: process.env })).rejects.toMatchObject({
      code: "provider_runtime_closure_mismatch",
    });
  });

  it("rejects added symlinks and hashes path, mode, size, and content", async () => {
    const root = await fixtureRoot();
    const packageRoot = path.join(root, "package");
    await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, "index.js"), "export {};\n", { mode: 0o644 });
    const before = await computeProviderRuntimeDirectoryManifest({ root: packageRoot, rejectSymlinks: true });
    await chmod(path.join(packageRoot, "index.js"), 0o600);
    const afterModeChange = await computeProviderRuntimeDirectoryManifest({ root: packageRoot, rejectSymlinks: true });
    expect(afterModeChange.manifestSha256).not.toBe(before.manifestSha256);
    await symlink(path.join(packageRoot, "index.js"), path.join(packageRoot, "alias.js"));
    await expect(computeProviderRuntimeDirectoryManifest({ root: packageRoot, rejectSymlinks: true })).rejects.toThrow(
      /forbidden symlink/,
    );
  });

  it("can require a runtime tree to remain read-only", async () => {
    const root = await fixtureRoot();
    const packageRoot = path.join(root, "read-only-package");
    const modulePath = path.join(packageRoot, "module.py");
    await mkdir(packageRoot);
    await writeFile(modulePath, "VALUE = 1\n", { mode: 0o644 });
    await expect(computeProviderRuntimeDirectoryManifest({
      root: packageRoot,
      rejectSymlinks: true,
      rejectWritable: true,
    })).rejects.toThrow(/directory is writable/);

    await chmod(modulePath, 0o444);
    await chmod(packageRoot, 0o555);
    await expect(computeProviderRuntimeDirectoryManifest({
      root: packageRoot,
      rejectSymlinks: true,
      rejectWritable: true,
    })).resolves.toMatchObject({ fileCount: 1 });
    await chmod(modulePath, 0o644);
    await expect(computeProviderRuntimeDirectoryManifest({
      root: packageRoot,
      rejectSymlinks: true,
      rejectWritable: true,
    })).rejects.toThrow(/file is writable/);
    await chmod(packageRoot, 0o755);
  });

  it("pins the exact PATH-resolved Node interpreter and package bytes", async () => {
    const root = await fixtureRoot();
    const bin = path.join(root, "bin");
    const packageRoot = path.join(root, "node-package");
    await Promise.all([mkdir(bin), mkdir(packageRoot)]);
    const node = path.join(bin, "node");
    const command = path.join(packageRoot, "cli.js");
    await Promise.all([
      writeFile(node, "#!/bin/sh\nprintf 'v1.2.3\\n'\n", { mode: 0o755 }),
      writeFile(command, "#!/usr/bin/env node\n", { mode: 0o755 }),
      writeFile(path.join(packageRoot, "chunk.js"), "export const chunk = true;\n"),
    ]);
    await Promise.all([chmod(node, 0o755), chmod(command, 0o755)]);
    const manifest = await computeProviderRuntimeDirectoryManifest({ root: packageRoot, rejectSymlinks: true });
    const closure: ProviderRuntimeClosureBinding = {
      schemaVersion: "provider-runtime-closure.v1",
      kind: "node_bundle",
      interpreter: {
        invocationPath: node,
        realpath: node,
        sha256: await sha256(node),
        expectedVersion: "v1.2.3",
        versionArgs: ["--version"],
        shebang: "#!/usr/bin/env node",
        pathCommand: "node",
      },
      files: [],
      directories: [{ ...manifest, rejectSymlinks: true }],
    };
    const route = {
      id: "fixture-node",
      runtimeBinding: {
        commandRealpath: command,
        commandSha256: await sha256(command),
        expectedVersion: "v1.2.3",
        versionArgs: ["--version"],
        runtimeClosureId: "fixture_node",
        runtimeClosureSha256: providerRuntimeClosureSha256(closure),
        runtimeClosure: closure,
      },
    } as ProviderPolicyRoute;
    await expect(verifyProviderPolicyRuntimeClosure(route, {
      environment: { PATH: bin },
    })).resolves.toMatchObject({
      interpreter: { realpath: node, observedVersion: "v1.2.3" },
      directories: [{ manifestSha256: manifest.manifestSha256 }],
    });
    await expect(verifyProviderPolicyRuntimeClosure(route, {
      environment: { PATH: "/usr/bin:/bin" },
      verifyVersions: false,
    })).rejects.toThrow(/PATH resolves node/);
    await writeFile(path.join(packageRoot, "chunk.js"), "export const chunk = 'changed';\n");
    await expect(verifyProviderPolicyRuntimeClosure(route, {
      environment: { PATH: bin },
      verifyVersions: false,
    })).rejects.toThrow(/directory manifest mismatch/);
  });
});
