import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveFactoryFile,
  buildFactoryRetentionDryRun,
  installFactoryRetentionDryRun,
  verifyFactoryArchiveManifest,
  type FactoryRetentionCandidate,
} from "../ops/factory-archive-retention.js";

const roots: string[] = [];
const ZSTD = "/opt/homebrew/bin/zstd";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function sourceFile(root: string, name: string, body: string) {
  const filePath = path.join(root, name);
  await writeFile(filePath, body, { mode: 0o400 });
  await chmod(filePath, 0o400);
  return filePath;
}

function candidate(filePath: string, root: string, archiveRoot: string, overrides: Partial<FactoryRetentionCandidate> = {}): FactoryRetentionCandidate {
  return {
    path: filePath,
    allowedRoot: root,
    archiveRoot,
    factoryOwnershipToken: "factory-run:test",
    leaseExpiresAt: "2026-07-14T00:00:00.000Z",
    workflowActive: false,
    workflowBlocked: false,
    rollbackEligible: false,
    onlyReferencedCopy: false,
    retentionEligibleAfter: "2026-07-14T00:00:00.000Z",
    archiveManifestPath: null,
    ...overrides,
  };
}

describe("factory archive and retention", () => {
  it("archives verified bytes to a content-addressed zstd object without deleting the source", async () => {
    const sourceRoot = await tempRoot("paperclip-factory-archive-source-");
    const archiveRoot = await tempRoot("paperclip-factory-archive-root-");
    const body = "receipt evidence\n".repeat(1000);
    const filePath = await sourceFile(sourceRoot, "receipt.ndjson", body);
    const result = await archiveFactoryFile({
      sourcePath: filePath,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:archive-test",
      receiptReferences: ["receipt:test:1"],
      zstdExecutable: ZSTD,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(result.sourceSha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect((await lstat(result.objectPath)).mode & 0o777).toBe(0o444);
    expect((await lstat(result.manifestPath)).mode & 0o777).toBe(0o444);
    expect(await readFile(filePath, "utf8")).toBe(body);
    expect(await verifyFactoryArchiveManifest(result.manifestPath, result.sourceSha256, archiveRoot, ZSTD)).toMatchObject({
      verified: true,
      objectPath: result.objectPath,
    });
    const second = await archiveFactoryFile({
      sourcePath: filePath,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:archive-test",
      receiptReferences: ["receipt:test:1"],
      zstdExecutable: ZSTD,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(second.objectPath).toBe(result.objectPath);
    expect(second.manifestSha256).toBe(result.manifestSha256);
  });

  it("rejects symlink sources and never follows them into the archive", async () => {
    const sourceRoot = await tempRoot("paperclip-factory-archive-symlink-");
    const archiveRoot = await tempRoot("paperclip-factory-archive-root-");
    const target = await sourceFile(sourceRoot, "target.json", "{}\n");
    const link = path.join(sourceRoot, "link.json");
    await symlink(target, link);
    await expect(archiveFactoryFile({
      sourcePath: link,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:archive-test",
      zstdExecutable: ZSTD,
    })).rejects.toThrow(/path_not_canonical|source_invalid/);
  });

  it("rejects a manifest that redirects its object outside the content-addressed archive root", async () => {
    const sourceRoot = await tempRoot("paperclip-factory-archive-source-");
    const archiveRoot = await tempRoot("paperclip-factory-archive-root-");
    const outsideRoot = await tempRoot("paperclip-factory-archive-outside-");
    const filePath = await sourceFile(sourceRoot, "receipt.json", "{\"ok\":true}\n");
    const archived = await archiveFactoryFile({
      sourcePath: filePath,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:archive-root-test",
      zstdExecutable: ZSTD,
    });
    const outsideObject = path.join(outsideRoot, `${archived.sourceSha256}.zst`);
    await writeFile(outsideObject, await readFile(archived.objectPath), { mode: 0o444 });
    await chmod(outsideObject, 0o444);
    const forged = {
      ...archived.manifest,
      object: { ...archived.manifest.object, path: outsideObject },
    };
    const forgedBytes = Buffer.from(`${JSON.stringify(forged, null, 2)}\n`);
    const forgedSha256 = createHash("sha256").update(forgedBytes).digest("hex");
    const forgedDirectory = path.join(archiveRoot, "manifests", "sha256", forgedSha256.slice(0, 2));
    await mkdir(forgedDirectory, { recursive: true, mode: 0o700 });
    await chmod(forgedDirectory, 0o700);
    const forgedPath = path.join(forgedDirectory, `${forgedSha256}.json`);
    await writeFile(forgedPath, forgedBytes, { mode: 0o444 });
    await chmod(forgedPath, 0o444);
    await expect(verifyFactoryArchiveManifest(forgedPath, archived.sourceSha256, archiveRoot, ZSTD)).resolves.toMatchObject({
      verified: false,
      reason: "manifest_binding_invalid",
    });
    await expect(verifyFactoryArchiveManifest(archived.manifestPath, archived.sourceSha256, outsideRoot, ZSTD)).resolves.toMatchObject({
      verified: false,
      reason: "manifest_path_invalid",
    });
  });

  it("protects active or unarchived files and marks only verified expired factory files approval-eligible", async () => {
    const sourceRoot = await tempRoot("paperclip-factory-retention-source-");
    const archiveRoot = await tempRoot("paperclip-factory-retention-root-");
    const archivedPath = await sourceFile(sourceRoot, "archived.log", "archived\n");
    const activePath = await sourceFile(sourceRoot, "active.log", "active\n");
    const unarchivedPath = await sourceFile(sourceRoot, "unarchived.log", "unarchived\n");
    const archived = await archiveFactoryFile({
      sourcePath: archivedPath,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:retention-test",
      zstdExecutable: ZSTD,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    const dryRun = await buildFactoryRetentionDryRun({
      now: new Date("2026-07-15T13:00:00.000Z"),
      zstdExecutable: ZSTD,
      candidates: [
        candidate(archivedPath, sourceRoot, archiveRoot, { archiveManifestPath: archived.manifestPath }),
        candidate(activePath, sourceRoot, archiveRoot, { workflowActive: true }),
        candidate(unarchivedPath, sourceRoot, archiveRoot),
      ],
    });
    expect(dryRun.totals).toMatchObject({ candidate_count: 3, eligible_count: 1, protected_count: 1 });
    expect(dryRun.inventory.find((entry) => entry.path === archivedPath)).toMatchObject({
      decision: "eligible_after_approval",
      archive: { verified: true },
    });
    expect(dryRun.inventory.find((entry) => entry.path === activePath)).toMatchObject({ decision: "protect", reason: "active_workflow_reference" });
    expect(dryRun.inventory.find((entry) => entry.path === unarchivedPath)).toMatchObject({ decision: "archive_then_review" });
    const installed = await installFactoryRetentionDryRun(archiveRoot, dryRun);
    expect((await lstat(installed.receiptPath)).mode & 0o777).toBe(0o444);
    expect(await readFile(archivedPath, "utf8")).toBe("archived\n");
    await chmod(installed.receiptPath, 0o644);
    await writeFile(installed.receiptPath, "{\"tampered\":true}\n");
    await chmod(installed.receiptPath, 0o444);
    await expect(installFactoryRetentionDryRun(archiveRoot, dryRun))
      .rejects.toThrow("factory_retention_existing_receipt_invalid");
  });

  it("validates archive and retention receipts against the checked-in schemas", async () => {
    const sourceRoot = await tempRoot("paperclip-factory-schema-source-");
    const archiveRoot = await tempRoot("paperclip-factory-schema-root-");
    const filePath = await sourceFile(sourceRoot, "artifact.json", "{\"ok\":true}\n");
    const archived = await archiveFactoryFile({
      sourcePath: filePath,
      allowedSourceRoots: [sourceRoot],
      archiveRoot,
      factoryOwnershipToken: "factory-run:schema-test",
      zstdExecutable: ZSTD,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    const dryRun = await buildFactoryRetentionDryRun({
      candidates: [candidate(filePath, sourceRoot, archiveRoot, { archiveManifestPath: archived.manifestPath })],
      now: new Date("2026-07-15T13:00:00.000Z"),
      zstdExecutable: ZSTD,
    });
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const archiveSchema = JSON.parse(await readFile(path.resolve(process.cwd(), "contracts/profit-flywheel/factory-archive-manifest.v1.schema.json"), "utf8"));
    const retentionSchema = JSON.parse(await readFile(path.resolve(process.cwd(), "contracts/profit-flywheel/factory-retention-dry-run.v1.schema.json"), "utf8"));
    const validateArchive = ajv.compile(archiveSchema);
    const validateRetention = ajv.compile(retentionSchema);
    expect(validateArchive(archived.manifest), JSON.stringify(validateArchive.errors)).toBe(true);
    expect(validateRetention(dryRun), JSON.stringify(validateRetention.errors)).toBe(true);

    const vectors = JSON.parse(await readFile(path.resolve(process.cwd(), "contracts/profit-flywheel/factory-operations-golden-vectors.v1.json"), "utf8"));
    for (const vector of vectors.vectors) {
      const validate = vector.contract === "paperclip.factory_archive_manifest.v1" ? validateArchive : validateRetention;
      expect(validate(vector.value), `${vector.name}: ${JSON.stringify(validate.errors)}`).toBe(vector.valid);
    }
  });
});
