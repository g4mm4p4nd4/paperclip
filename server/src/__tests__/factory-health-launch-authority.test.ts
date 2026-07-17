import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { createHealthGatedFactoryLaunchAuthority } from "../services/factory-health-launch-authority.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("health-gated factory launch authority", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-factory-launch-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function baselinePointer(availableBytes: number, companyId: string, capturedAt = new Date().toISOString()) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-launch-health-")));
    roots.push(root);
    const receipt = {
      schema_version: "paperclip.profit_flywheel_factory_baseline.v1",
      company_id: companyId,
      captured_at: capturedAt,
      target_workflow: null,
      stage_counts: [],
      blocker_counts: [],
      provider_policy: { sha256: null, schema_sha256: null, routes: [] },
      repositories: [
        { name: "portfolio-os", path: "/repos/portfolio-os", head: "a".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "paperclip", path: "/repos/paperclip", head: "b".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-agent", path: "/repos/hermes-agent", head: "c".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-paperclip-adapter", path: "/repos/adapter", head: "d".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
      ],
      adapter: {
        package_name: "@henkey/hermes-paperclip-adapter",
        package_version: "0.2.0",
        plugin_store_version: "0.2.0",
        plugin_store_mode: "immutable_bundle",
        git_commit: "d".repeat(40),
        git_branch: "main",
        file_manifest_sha256: "e".repeat(64),
      },
      resources: {
        disk: { path: "/System/Volumes/Data", total_bytes: 100 * 1024 ** 3, free_bytes: availableBytes, available_bytes: availableBytes, free_percent: 20 },
        database_bytes: 0,
        ops_bytes: 0,
        backup_bytes: 0,
        log_bytes: 0,
        factory_browser_processes: { count: 0, rss_bytes: 0 },
      },
      tokenomics: { receipt_path: null, generated_at: null, status: null, age_seconds: null, fresh: false },
      constraints: { live_pos_checkout_preserved: true, leadforge_excluded: true, secrets_redacted: true, promotion_blockers: [] },
    };
    const bytes = `${JSON.stringify(receipt)}\n`;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const receiptPath = path.join(root, `${digest}.json`);
    await writeFile(receiptPath, bytes, { mode: 0o444 });
    await chmod(receiptPath, 0o444);
    const pointerPath = path.join(root, "latest.json");
    await writeFile(pointerPath, `${JSON.stringify({
      schema_version: "paperclip.profit_flywheel_factory_baseline_pointer.v1",
      receipt_path: receiptPath,
      receipt_sha256: digest,
    })}\n`, { mode: 0o444 });
    await chmod(pointerPath, 0o444);
    return pointerPath;
  }

  async function decision(availableBytes: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Factory ${availableBytes}`,
      issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(availableBytes, companyId),
    });
    return authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId,
      targetRepo: "fixture/disk-boundary",
      workflowId: randomUUID(),
      runId: "disk-boundary",
      inputHash: "1".repeat(64),
      stage: "implementation",
    });
  }

  it("enforces the exact 30 GiB launch boundary, including the 25-30 GiB warning band", async () => {
    await expect(decision(29 * 1024 ** 3)).resolves.toMatchObject({
      allowed: false,
      code: "factory_disk_hard_stop",
    });
    await expect(decision(30 * 1024 ** 3)).resolves.toMatchObject({
      allowed: true,
      code: "factory_fixture_authorized",
    });
  });

  it("rejects a stale baseline before fixture admission", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stale factory",
      issuePrefix: `S${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const pointerPath = await baselinePointer(30 * 1024 ** 3, companyId, "2026-07-14T00:00:00.000Z");

    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: pointerPath,
    });
    await expect(authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId,
      targetRepo: "fixture/stale",
      workflowId: randomUUID(),
      runId: "stale",
      inputHash: "1".repeat(64),
      stage: "implementation",
    })).resolves.toMatchObject({ allowed: false, code: "factory_health_snapshot_stale" });
  });

  it("rejects a fresh baseline issued for another company", async () => {
    const sourceCompanyId = randomUUID();
    const requestedCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: sourceCompanyId, name: "Source company", issuePrefix: `A${sourceCompanyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
      { id: requestedCompanyId, name: "Requested company", issuePrefix: `B${requestedCompanyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
    ]);
    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(30 * 1024 ** 3, sourceCompanyId),
    });
    await expect(authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId: requestedCompanyId,
      targetRepo: "fixture/cross-company",
      workflowId: randomUUID(),
      runId: "cross-company",
      inputHash: "1".repeat(64),
      stage: "implementation",
    })).resolves.toMatchObject({ allowed: false, code: "factory_health_snapshot_stale" });
  });
});
