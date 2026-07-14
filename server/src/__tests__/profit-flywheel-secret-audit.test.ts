import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  buildAuditReceipt,
  parseArgs,
  scanText,
} = await import("../../../scripts/audit-profit-flywheel-secrets.mjs");

const roots: string[] = [];

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), "paperclip-secret-audit-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Secret Audit Test");
  git(root, "config", "user.email", "secret-audit@example.invalid");
  writeFileSync(join(root, "README.md"), "safe\n");
  const base = commit(root, "base");
  return { root, base };
}

function policyFor(root: string, base: string) {
  const fixtureObjectId = git(root, "rev-parse", "HEAD:fixture.txt");
  return {
    schemaVersion: "paperclip.profit_flywheel_secret_audit_policy.v1",
    repositories: [{ name: "fixture", historyBase: base }],
    reviewedGitScopes: [{
      id: "synthetic-fixture",
      repository: "fixture",
      path: "fixture.txt",
      objectId: fixtureObjectId,
      disposition: "synthetic_security_test_fixture",
      reason: "Test-only value.",
    }],
    reviewedRuntimeFiles: [],
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Profit Flywheel secret audit", () => {
  it("accepts the package-manager argument separator", () => {
    expect(parseArgs([
      "--",
      "--policy", "policy.json",
      "--repo", "paperclip=/repo",
      "--receipt-dir", "/receipts",
    ])).toMatchObject({
      repositories: [{ name: "paperclip", root: "/repo" }],
      runtimeRoots: [],
    });
  });

  it("detects high-confidence credential shapes without returning raw values", () => {
    const synthetic = ["sk", "proj", "abcdefghijklmnopqrstuvwx"].join("-");
    const findings = scanText(`OPENAI_API_KEY=${synthetic}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ detector: "openai_like", line: 1 });
    expect(findings[0]).not.toHaveProperty("value");
    expect(findings[0].matchDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only the exact reviewed current fixture", () => {
    const { root, base } = makeRepository();
    const reviewed = ["sk", "proj", "reviewedsyntheticfixture123"].join("-");
    writeFileSync(join(root, "fixture.txt"), `${reviewed}\n`);
    commit(root, "add reviewed fixture");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(runtimeRoot);

    const receipt = buildAuditReceipt({
      policy: policyFor(root, base),
      repositories: [{ name: "fixture", root, historyBase: base }],
      runtimeRoots: [{ name: "runtime", root: runtimeRoot }],
      generatedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(receipt.status).toBe("verified");
    expect(receipt.summary.unsuppressed).toBe(0);
    expect(receipt.summary.reviewedNonSecrets).toBeGreaterThan(0);
  });

  it("blocks a credential that existed only in task history", () => {
    const { root, base } = makeRepository();
    const reviewed = ["sk", "proj", "reviewedsyntheticfixture123"].join("-");
    const historical = ["sk", "proj", "unreviewedhistoricalvalue456"].join("-");
    writeFileSync(join(root, "fixture.txt"), `${reviewed}\n`);
    commit(root, "add reviewed fixture");
    writeFileSync(join(root, "leak.txt"), `${historical}\n`);
    commit(root, "add leak");
    rmSync(join(root, "leak.txt"));
    commit(root, "remove leak");
    const runtimeRoot = join(root, "runtime");
    mkdirSync(runtimeRoot);

    const receipt = buildAuditReceipt({
      policy: policyFor(root, base),
      repositories: [{ name: "fixture", root, historyBase: base }],
      runtimeRoots: [{ name: "runtime", root: runtimeRoot }],
      generatedAt: "2026-07-14T00:00:00.000Z",
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.summary.unsuppressed).toBe(1);
    expect(receipt.unsuppressedFindings[0]).toMatchObject({
      scope: "git_task_history",
      path: "leak.txt",
      detector: "openai_like",
    });
    expect(JSON.stringify(receipt)).not.toContain("unreviewedhistoricalvalue456");
    expect(receipt.unsuppressedFindings[0]).not.toHaveProperty("matchDigest");
  });
});
