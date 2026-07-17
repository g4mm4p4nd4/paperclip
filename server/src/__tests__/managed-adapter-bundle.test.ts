import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  installManagedAdapterBundle,
  managedAdapterIdentityFromRecord,
  verifyManagedAdapterBundleIdentity,
  verifyManagedAdapterPluginRecord,
} from "../services/managed-adapter-bundle.js";
import { compareAndSwapManagedAdapterPlugin, type AdapterPluginRecord } from "../services/adapter-plugin-store.js";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function writeText(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field overflow: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeText(header, offset, length, `${encoded}\0`);
}

function tar(entries: Array<{ path: string; bytes: Buffer; mode: number }>) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeText(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeText(header, 257, 6, "ustar\0");
    writeText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

async function makeFixture(root: string, version = "0.2.0", marker = "") {
  const files = [
    { path: "index.js", bytes: Buffer.from(`export function createServerAdapter(){return {type:'hermes_local',execute:async()=>({marker:${JSON.stringify(marker)}})}}\n`), mode: "0444" as const },
    { path: "package.json", bytes: Buffer.from(`${JSON.stringify({ name: "@henkey/hermes-paperclip-adapter", version, type: "module", main: "./index.js" })}\n`), mode: "0444" as const },
    { path: "ui-parser.js", bytes: Buffer.from("export const parser = true;\n"), mode: "0444" as const },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifestFiles = files.map((file) => ({ path: file.path, sha256: sha256(file.bytes), bytes: file.bytes.length, mode: file.mode }));
  const manifest = {
    schema_version: "paperclip.hermes_adapter_immutable_bundle.v1",
    package: { name: "@henkey/hermes-paperclip-adapter", version, type: "module", entry_point: "index.js" },
    source: { git_head: "a".repeat(40), git_tree: "b".repeat(40), git_branch: "fixture", git_status_sha256: sha256(""), clean: true },
    files: manifestFiles,
    payload_tree_sha256: sha256(canonical(manifestFiles)),
    integration: { adapter_type: "hermes_local", create_server_adapter: true, session_codec: true, ui_parser_export: "./ui-parser.js" },
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const archiveBytes = tar([...files.map((file) => ({ ...file, mode: Number.parseInt(file.mode, 8) })), { path: "immutable-adapter-manifest.json", bytes: manifestBytes, mode: 0o444 }]);
  const bundleSha256 = sha256(archiveBytes);
  const manifestSha256 = sha256(manifestBytes);
  const packageRelativePath = `packages/${bundleSha256}`;
  const manifestRelativePath = `${packageRelativePath}/immutable-adapter-manifest.json`;
  const archiveRelativePath = `bundles/${bundleSha256}.tgz`;
  const packageRoot = path.join(root, packageRelativePath);
  await mkdir(packageRoot, { recursive: true, mode: 0o755 });
  for (const file of files) {
    await writeFile(path.join(packageRoot, file.path), file.bytes, { mode: 0o444 });
    await chmod(path.join(packageRoot, file.path), 0o444);
  }
  await writeFile(path.join(packageRoot, "immutable-adapter-manifest.json"), manifestBytes, { mode: 0o444 });
  await chmod(path.join(packageRoot, "immutable-adapter-manifest.json"), 0o444);
  await chmod(packageRoot, 0o555);
  await mkdir(path.join(root, "bundles"), { recursive: true });
  const archivePath = path.join(root, archiveRelativePath);
  await writeFile(archivePath, archiveBytes, { mode: 0o444 });
  await chmod(archivePath, 0o444);
  const descriptor = {
    kind: "managed_immutable_bundle",
    artifact_root: "${HERMES_ADAPTER_BUNDLE_ROOT}",
    adapter_type: "hermes_local",
    package_name: "@henkey/hermes-paperclip-adapter",
    package_version: version,
    bundle_sha256: bundleSha256,
    package_relative_path: packageRelativePath,
    manifest_relative_path: manifestRelativePath,
    manifest_sha256: manifestSha256,
    payload_tree_sha256: manifest.payload_tree_sha256,
  };
  const receipt = {
    schema_version: "paperclip.hermes_adapter_install_receipt.v1",
    adapter_type: "hermes_local",
    package_name: "@henkey/hermes-paperclip-adapter",
    package_version: version,
    source: { git_head: manifest.source.git_head, git_tree: manifest.source.git_tree },
    manifest: { relative_path: manifestRelativePath, sha256: manifestSha256, body: manifest },
    bundle: {
      sha256: bundleSha256,
      manifest_sha256: manifestSha256,
      payload_tree_sha256: manifest.payload_tree_sha256,
      archive_relative_path: archiveRelativePath,
      archive_bytes: archiveBytes.length,
      package_relative_path: packageRelativePath,
    },
    managed_install_descriptor: descriptor,
    verification: { source_clean: true, archive_verified: true, extracted_bytes_verified: true, module_integration_verified: true, secret_scan_passed: true },
  };
  const receiptBytes = Buffer.from(canonical(receipt));
  const receiptSha256 = sha256(receiptBytes);
  await mkdir(path.join(root, "receipts"), { recursive: true });
  const receiptPath = path.join(root, "receipts", `${receiptSha256}.json`);
  await writeFile(receiptPath, receiptBytes, { mode: 0o444 });
  await chmod(receiptPath, 0o444);
  return { installReceiptPath: receiptPath, installReceiptSha256: receiptSha256 };
}

describe("managed immutable adapter bundles", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      // Tests intentionally make objects immutable; restore owner permissions
      // before deleting only the test-owned temporary tree.
      async function writable(entry: string) {
        const metadata = await lstat(entry);
        if (metadata.isDirectory()) {
          await chmod(entry, 0o700);
          for (const name of await readdir(entry)) await writable(path.join(entry, name));
        } else {
          await chmod(entry, 0o600);
        }
      }
      await writable(root).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies, re-verifies, records, and quarantines byte drift", async () => {
    const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-source-")));
    const managedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-managed-")));
    roots.push(sourceRoot, managedRoot);
    const fixture = await makeFixture(sourceRoot);
    const identity = await installManagedAdapterBundle({ ...fixture, managedRoot });
    expect(identity).toMatchObject({
      kind: "managed_immutable_bundle",
      bundleSha256: path.basename(identity.objectRoot),
      packageVersion: "0.2.0",
      sourceGitHead: "a".repeat(40),
      sourceGitTree: "b".repeat(40),
    });
    await expect(verifyManagedAdapterPluginRecord({
      packageName: identity.packageName,
      version: identity.packageVersion,
      type: "hermes_local",
      installedAt: new Date().toISOString(),
      installKind: "managed_immutable_bundle",
      managedBundle: identity,
    })).resolves.toMatchObject({ bundleSha256: identity.bundleSha256 });

    const entryPoint = path.join(identity.packageRoot, "index.js");
    await chmod(entryPoint, 0o644);
    await writeFile(entryPoint, `${await readFile(entryPoint, "utf8")}// tampered\n`);
    await expect(verifyManagedAdapterBundleIdentity(identity)).rejects.toThrow(/mode 0444|differs from the manifest/);
  });

  it("rejects a forged expected receipt digest before copying any package", async () => {
    const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-source-")));
    const managedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-managed-")));
    roots.push(sourceRoot, managedRoot);
    const fixture = await makeFixture(sourceRoot);
    await expect(installManagedAdapterBundle({ ...fixture, installReceiptSha256: "0".repeat(64), managedRoot }))
      .rejects.toThrow(/receipt hash or filename mismatch/);
  });

  it("re-parses the installed receipt and rejects plugin-store receipt rebinding", async () => {
    const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-source-")));
    const managedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-managed-")));
    roots.push(sourceRoot, managedRoot);
    const fixture = await makeFixture(sourceRoot);
    const identity = await installManagedAdapterBundle({ ...fixture, managedRoot });
    const original = JSON.parse(await readFile(identity.installReceiptPath, "utf8")) as Record<string, unknown>;
    original.package_version = "9.9.9";
    const forgedBytes = Buffer.from(canonical(original));
    const forgedSha256 = sha256(forgedBytes);
    const forgedPath = path.join(identity.objectRoot, `${forgedSha256}.json`);
    await chmod(identity.objectRoot, 0o755);
    await writeFile(forgedPath, forgedBytes, { mode: 0o444 });
    await chmod(forgedPath, 0o444);
    await chmod(identity.objectRoot, 0o555);
    await expect(verifyManagedAdapterBundleIdentity({
      ...identity,
      installReceiptPath: forgedPath,
      installReceiptSha256: forgedSha256,
    })).rejects.toThrow(/receipt package identity mismatch/);
  });

  it("recovers from a tampered active object by fencing its pointer and verifying the prior target", async () => {
    const sourceA = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-source-a-")));
    const sourceB = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-source-b-")));
    const managedRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-managed-")));
    const storeRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-adapter-store-")));
    roots.push(sourceA, sourceB, managedRoot, storeRoot);
    const prior = await installManagedAdapterBundle({ ...(await makeFixture(sourceA, "0.2.0", "prior")), managedRoot });
    const active = await installManagedAdapterBundle({ ...(await makeFixture(sourceB, "0.3.0", "active")), managedRoot });
    const activeRecord: AdapterPluginRecord = {
      packageName: active.packageName,
      version: active.packageVersion,
      type: "hermes_local",
      installedAt: new Date().toISOString(),
      installKind: "managed_immutable_bundle",
      managedBundle: active,
      managedBundleHistory: [prior],
    };
    const storePath = path.join(storeRoot, "adapter-plugins.json");
    await writeFile(storePath, `${JSON.stringify([activeRecord], null, 2)}\n`);
    const entryPoint = path.join(active.packageRoot, "index.js");
    await chmod(entryPoint, 0o644);
    await writeFile(entryPoint, `${await readFile(entryPoint, "utf8")}// tampered\n`);

    expect(managedAdapterIdentityFromRecord(activeRecord).bundleSha256).toBe(active.bundleSha256);
    await expect(verifyManagedAdapterPluginRecord(activeRecord)).rejects.toThrow(/mode 0444|differs from the manifest/);
    await expect(verifyManagedAdapterBundleIdentity(prior)).resolves.toMatchObject({ bundleSha256: prior.bundleSha256 });
    const recovered: AdapterPluginRecord = {
      ...activeRecord,
      version: prior.packageVersion,
      managedBundle: prior,
      managedBundleHistory: [],
    };
    expect(compareAndSwapManagedAdapterPlugin("hermes_local", active.bundleSha256, recovered, storePath)).toBe(true);
    const stored = JSON.parse(await readFile(storePath, "utf8")) as AdapterPluginRecord[];
    expect(stored[0]?.managedBundle?.bundleSha256).toBe(prior.bundleSha256);
    expect(stored[0]?.managedBundleHistory).toEqual([]);
  });
});
