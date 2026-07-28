import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  FACTORY_BASELINE_SCHEMA_VERSION,
  collectRepositoryIdentity,
  computeTrackedFileManifestSha256,
  installFactoryBaselineReceipt,
  parseFactoryBaselineCliArgs,
  selectFactoryAdapterPluginRecord,
  summarizeFactoryTokenomicsReceipt,
} from "../ops/zero-touch-factory-baseline.js";
import { factoryCanonicalJsonBytes, factoryCanonicalJsonSha256 } from "../ops/factory-canonical-json.js";

const execFile = promisify(execFileCallback);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(directory);
  return realpath(directory);
}

async function git(repo: string, ...args: string[]) {
  return execFile("git", ["-C", repo, ...args]);
}

async function makeRepository() {
  const repo = await tempDirectory("paperclip-factory-baseline-repo-");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Factory Baseline Test");
  await git(repo, "config", "user.email", "factory-baseline@example.invalid");
  await writeFile(path.join(repo, "index.js"), "export const value = 1;\n");
  await writeFile(path.join(repo, "package.json"), "{\"name\":\"fixture-adapter\",\"version\":\"1.0.0\"}\n");
  await git(repo, "add", "index.js", "package.json");
  await git(repo, "commit", "-qm", "fixture");
  return repo;
}

describe("zero-touch factory baseline", () => {
  it("captures immutable repository identity without mutating the checkout", async () => {
    const repo = await makeRepository();
    const before = await git(repo, "status", "--porcelain=v1");
    const identity = await collectRepositoryIdentity({ name: "hermes-paperclip-adapter", path: repo });
    const after = await git(repo, "status", "--porcelain=v1");
    expect(identity).toMatchObject({
      name: "hermes-paperclip-adapter",
      path: repo,
      tracked_changes: 0,
      untracked_changes: 0,
      tree_clean: true,
    });
    expect(identity.head).toMatch(/^[a-f0-9]{40}$/);
    expect(after.stdout).toBe(before.stdout);
  });

  it("hashes the actual tracked adapter bytes, not just the commit", async () => {
    const repo = await makeRepository();
    const cleanHash = await computeTrackedFileManifestSha256(repo);
    await writeFile(path.join(repo, "index.js"), "export const value = 2;\n");
    const dirtyHash = await computeTrackedFileManifestSha256(repo);
    expect(cleanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(dirtyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(dirtyHash).not.toBe(cleanHash);
  });

  it("installs one content-addressed read-only receipt and only a small mutable pointer", async () => {
    const instanceRoot = await tempDirectory("paperclip-factory-baseline-instance-");
    await mkdir(path.join(instanceRoot, "data", "ops"), { recursive: true, mode: 0o700 });
    const receipt = minimalReceipt();
    const first = await installFactoryBaselineReceipt(instanceRoot, receipt);
    const second = await installFactoryBaselineReceipt(instanceRoot, receipt);
    expect(second).toEqual(first);
    expect(first.receiptPath).toContain(first.receiptSha256);
    expect((await lstat(first.receiptPath)).mode & 0o777).toBe(0o444);
    const pointer = JSON.parse(await readFile(first.pointerPath, "utf8"));
    expect(pointer).toEqual({
      schema_version: "paperclip.profit_flywheel_factory_baseline_pointer.v1",
      receipt_path: first.receiptPath,
      receipt_sha256: first.receiptSha256,
      generated_at: receipt.captured_at,
    });
    expect((await lstat(first.pointerPath)).size).toBeLessThan(2048);
  });

  it("validates the frozen baseline shape with the checked-in JSON schema", async () => {
    const schemaPath = path.resolve(process.cwd(), "contracts/profit-flywheel/factory-baseline.v1.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const receipt = minimalReceipt();
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...receipt, resources: { ...receipt.resources, disk: { ...receipt.resources.disk, free_percent: 101 } } })).toBe(false);
  });

  it("requires every explicit path and rejects secret-shaped CLI flags", () => {
    const args = [
      "--company-id", randomUUID(),
      "--workflow-run-id", "fixture-run",
      "--instance-root", "/tmp/instance",
      "--plugin-store", "/tmp/plugins.json",
      "--tokenomics-receipt", "/tmp/tokenomics.json",
      "--portfolio-os-repo", "/tmp/portfolio-os",
      "--paperclip-repo", "/tmp/paperclip",
      "--hermes-repo", "/tmp/hermes",
      "--adapter-repo", "/tmp/adapter",
    ];
    expect(parseFactoryBaselineCliArgs(args)).toMatchObject({ targetWorkflowRunId: "fixture-run" });
    expect(() => parseFactoryBaselineCliArgs([...args, "--api-key", "not-a-real-key"])).toThrow("factory_baseline_argument_invalid");
    expect(() => parseFactoryBaselineCliArgs(args.map((value) => value === "/tmp/instance" ? "relative" : value))).toThrow("factory_baseline_instance_root_invalid");
  });

  it("preserves analytical warnings while promoting only an explicit safe tokenomics verdict", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    expect(summarizeFactoryTokenomicsReceipt({
      status: "warn",
      promotionStatus: "pass",
      generatedAt: "2026-07-28T11:59:00.000Z",
    }, "/tmp/safe-idle-tokenomics.json", now)).toEqual({
      receipt_path: "/tmp/safe-idle-tokenomics.json",
      generated_at: "2026-07-28T11:59:00.000Z",
      status: "pass",
      report_status: "warn",
      promotion_status: "pass",
      age_seconds: 60,
      fresh: true,
    });
    expect(summarizeFactoryTokenomicsReceipt({
      status: "warn",
      generatedAt: "2026-07-28T11:59:00.000Z",
    }, "/tmp/unproven-tokenomics.json", now)).toMatchObject({
      status: "warn",
      report_status: "warn",
      promotion_status: null,
    });
  });

  it("canonicalizes hashes across object insertion orders and rejects lossy values", () => {
    const left = { z: 1, nested: { b: true, a: "value" } };
    const right = { nested: { a: "value", b: true }, z: 1 };
    expect(factoryCanonicalJsonBytes(left)).toEqual(factoryCanonicalJsonBytes(right));
    expect(factoryCanonicalJsonSha256(left)).toBe(factoryCanonicalJsonSha256(right));
    expect(() => factoryCanonicalJsonBytes({ value: Number.NaN })).toThrow("factory_canonical_json_non_finite_number");
    expect(() => factoryCanonicalJsonBytes({ value: undefined })).toThrow("factory_canonical_json_undefined");
  });

  it("selects only the exact Hermes adapter record and rejects ambiguous managed authority", () => {
    const adapterPath = "/tmp/hermes-paperclip-adapter";
    const unrelated = { type: "other", packageName: "other-package", installKind: "managed_immutable_bundle" };
    const exact = {
      type: "hermes_local",
      packageName: "@henkey/hermes-paperclip-adapter",
      installKind: "managed_immutable_bundle",
      managedBundle: { bundleSha256: "a".repeat(64) },
    };
    expect(selectFactoryAdapterPluginRecord([unrelated, exact], adapterPath)).toBe(exact);
    expect(selectFactoryAdapterPluginRecord([unrelated], adapterPath)).toEqual({});
    expect(() => selectFactoryAdapterPluginRecord([exact, { ...exact }], adapterPath))
      .toThrow("factory_baseline_managed_adapter_record_ambiguous");
  });
});

function minimalReceipt() {
  const hash = "a".repeat(64);
  return {
    schema_version: FACTORY_BASELINE_SCHEMA_VERSION,
    company_id: randomUUID(),
    captured_at: "2026-07-15T12:00:00.000Z",
    target_workflow: null,
    stage_counts: [{ stage: "dispatch", state: "succeeded", count: 1 }],
    blocker_counts: [{ code: "fixture_blocker", count: 1 }],
    provider_policy: {
      sha256: hash,
      schema_sha256: hash,
      routes: [{
        route_id: "codex_fast",
        provider_family: "openai",
        status: "healthy",
        failure_class: null,
        observed_at: "2026-07-15T11:59:00.000Z",
        expires_at: "2026-07-15T12:10:00.000Z",
      }],
    },
    repositories: [
      repository("portfolio-os", hash.slice(0, 40)),
      repository("paperclip", hash.slice(0, 40)),
      repository("hermes-agent", hash.slice(0, 40)),
      repository("hermes-paperclip-adapter", hash.slice(0, 40)),
    ],
    adapter: {
      package_name: "hermes-paperclip-adapter",
      package_version: "1.0.0",
      plugin_store_version: "1.0.0",
      plugin_store_mode: "immutable_bundle",
      git_commit: hash.slice(0, 40),
      git_branch: "main",
      file_manifest_sha256: hash,
    },
    tokenomics: {
      receipt_path: "/tmp/tokenomics.json",
      generated_at: "2026-07-15T11:59:00.000Z",
      status: "pass",
      age_seconds: 60,
      fresh: true,
    },
    resources: {
      disk: {
        path: "/tmp",
        total_bytes: 100,
        free_bytes: 50,
        available_bytes: 50,
        free_percent: 50,
      },
      database_bytes: 1,
      ops_bytes: 1,
      backup_bytes: 1,
      log_bytes: 1,
      factory_browser_processes: { count: 0, rss_bytes: 0 },
    },
    constraints: {
      live_pos_checkout_preserved: true,
      leadforge_excluded: true,
      secrets_redacted: true,
      promotion_blockers: [],
    },
  };
}

function repository(name: "portfolio-os" | "paperclip" | "hermes-agent" | "hermes-paperclip-adapter", head: string) {
  return {
    name,
    path: `/tmp/${name}`,
    head,
    branch: "main",
    upstream: "origin/main",
    tracked_changes: 0,
    untracked_changes: 0,
    tree_clean: true,
  };
}
