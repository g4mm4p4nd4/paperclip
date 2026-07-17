import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareAndSwapManagedAdapterPlugin,
  type AdapterPluginRecord,
} from "../services/adapter-plugin-store.js";

function managed(bundleSha256: string): AdapterPluginRecord {
  return {
    packageName: "@henkey/hermes-paperclip-adapter",
    version: "0.2.0",
    type: "hermes_local",
    installedAt: "2026-07-15T06:00:00.000Z",
    installKind: "managed_immutable_bundle",
    managedBundle: {
      kind: "managed_immutable_bundle",
      objectRoot: `/objects/${bundleSha256}`,
      packageRoot: `/objects/${bundleSha256}/package`,
      archivePath: `/objects/${bundleSha256}/${bundleSha256}.tgz`,
      bundleSha256,
      packageName: "@henkey/hermes-paperclip-adapter",
      packageVersion: "0.2.0",
      manifestPath: `/objects/${bundleSha256}/package/immutable-adapter-manifest.json`,
      manifestSha256: "b".repeat(64),
      payloadTreeSha256: "c".repeat(64),
      installReceiptPath: `/objects/${bundleSha256}/${"d".repeat(64)}.json`,
      installReceiptSha256: "d".repeat(64),
      sourceGitHead: "e".repeat(40),
      sourceGitTree: "f".repeat(40),
      files: [],
    },
  };
}

describe("managed adapter plugin-store compare-and-swap", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("allows exactly one request to swap a verified current bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-adapter-store-"));
    roots.push(root);
    const storePath = path.join(root, "adapter-plugins.json");
    const current = managed("a".repeat(64));
    const first = managed("1".repeat(64));
    const staleSecond = managed("2".repeat(64));
    await writeFile(storePath, `${JSON.stringify([current], null, 2)}\n`);

    expect(compareAndSwapManagedAdapterPlugin("hermes_local", "a".repeat(64), first, storePath)).toBe(true);
    expect(compareAndSwapManagedAdapterPlugin("hermes_local", "a".repeat(64), staleSecond, storePath)).toBe(false);
    const installed = JSON.parse(await readFile(storePath, "utf8")) as AdapterPluginRecord[];
    expect(installed[0]?.managedBundle?.bundleSha256).toBe("1".repeat(64));
  });

  it("allows one no-current install and rejects a stale concurrent installer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-adapter-store-"));
    roots.push(root);
    const storePath = path.join(root, "adapter-plugins.json");
    const first = managed("1".repeat(64));
    const staleSecond = managed("2".repeat(64));
    await writeFile(storePath, "[]\n");

    expect(compareAndSwapManagedAdapterPlugin("hermes_local", null, first, storePath)).toBe(true);
    expect(compareAndSwapManagedAdapterPlugin("hermes_local", null, staleSecond, storePath)).toBe(false);
    const installed = JSON.parse(await readFile(storePath, "utf8")) as AdapterPluginRecord[];
    expect(installed).toHaveLength(1);
    expect(installed[0]?.managedBundle?.bundleSha256).toBe("1".repeat(64));
  });
});
