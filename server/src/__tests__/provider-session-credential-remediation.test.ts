import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  buildProviderSessionCredentialRemediationPlan,
  countDecodableJwtShapes,
  CredentialRemediationError,
  providerSessionCredentialRemediationConnectionString,
  redactDecodableJwtShapesSameLength,
  runProviderSessionCredentialRemediation,
  validateRollbackEnvelopeOriginalFile,
} from "../ops/provider-session-credential-remediation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function syntheticJwtShape() {
  return [
    Buffer.from(JSON.stringify({ alg: "none", fixture: true })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "synthetic-test-only" })).toString("base64url"),
    "synthetic_fixture_signature",
  ].join(".");
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

describe("provider-session credential remediation primitives", () => {
  it("redacts every JWT-shaped match without changing its length", () => {
    const token = syntheticJwtShape();
    const input = `before ${token} middle ${token} after`;
    const output = redactDecodableJwtShapesSameLength(input);
    expect(output).toHaveLength(input.length);
    expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(input));
    expect(countDecodableJwtShapes(input)).toBe(2);
    expect(countDecodableJwtShapes(output)).toBe(0);
    expect(output).not.toContain(token);
  });

  it("validates canonical rollback-file base64, decoded length, and digest", () => {
    const original = Buffer.from([0xff]);
    const identity = {
      oldBytes: original.length,
      oldSha256: sha256(original),
    };
    expect(() => validateRollbackEnvelopeOriginalFile({
      ...identity,
      originalBytesBase64: original.toString("base64"),
    })).not.toThrow();
    expect(() => validateRollbackEnvelopeOriginalFile({
      ...identity,
      // Decodes to the same byte under permissive decoders, but has non-zero
      // unused tail bits and is therefore not canonical base64.
      originalBytesBase64: "/x==",
    })).toThrowError(expect.objectContaining({ code: "rollback_envelope_file_invalid" }));
    expect(() => validateRollbackEnvelopeOriginalFile({
      ...identity,
      originalBytesBase64: "AA==",
    })).toThrowError(expect.objectContaining({ code: "rollback_envelope_file_invalid" }));
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const tempRoots: string[] = [];

async function createFixture(db: ReturnType<typeof createDb>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-remediation-")));
  tempRoots.push(root);
  const activeRoot = path.join(root, "active-run-logs");
  const legacyRoot = path.join(root, "legacy-run-logs");
  const receiptRoot = path.join(root, "receipts");
  await Promise.all([mkdir(activeRoot), mkdir(legacyRoot), mkdir(receiptRoot, { mode: 0o700 })]);
  await chmod(receiptRoot, 0o700);
  const keyFile = path.join(root, "rollback.key");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  await chmod(keyFile, 0o600);

  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const missingRunId = randomUUID();
  const token = syntheticJwtShape();
  const relativePath = path.join(companyId, agentId, `${runId}.ndjson`);
  const legacyPath = path.join(legacyRoot, relativePath);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const originalLog = Buffer.from(`${JSON.stringify({ ts: new Date(0).toISOString(), stream: "stdout", chunk: `Authorization: Bearer ${token}` })}\n`);
  await writeFile(legacyPath, originalLog, { mode: 0o600 });

  const orphanRelativePath = path.join(randomUUID(), randomUUID(), `${randomUUID()}.ndjson`);
  const orphanPath = path.join(legacyRoot, orphanRelativePath);
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await writeFile(orphanPath, `${JSON.stringify({ ts: new Date(0).toISOString(), stream: "stderr", chunk: token })}\n`, { mode: 0o600 });
  const gzipOrphanRelativePath = path.join(randomUUID(), randomUUID(), `${randomUUID()}.ndjson.gz`);
  const gzipOrphanPath = path.join(legacyRoot, gzipOrphanRelativePath);
  await mkdir(path.dirname(gzipOrphanPath), { recursive: true });
  const gzipDecoded = Buffer.from(`${JSON.stringify({ ts: new Date(0).toISOString(), stream: "stderr", chunk: `gzip ${token}` })}\n`);
  await writeFile(gzipOrphanPath, gzipSync(gzipDecoded), { mode: 0o600 });

  await db.insert(companies).values({ id: companyId, name: "Credential remediation fixture", issuePrefix: `CR${companyId.slice(0, 4)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", role: "engineer", status: "idle" });
  await db.insert(heartbeatRuns).values([
    {
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      logStore: "local_file",
      logRef: relativePath,
      logBytes: originalLog.length,
      logSha256: sha256(originalLog),
      logCompressed: false,
      stdoutExcerpt: `stdout ${token}`,
      stderrExcerpt: `stderr ${token}`,
      resultJson: { summary: token, nested: { safe: true } },
    },
    {
      id: missingRunId,
      companyId,
      agentId,
      status: "failed",
      logStore: "local_file",
      logRef: path.join(companyId, agentId, `${missingRunId}.ndjson`),
      logBytes: null,
      logSha256: null,
      logCompressed: false,
    },
  ]);
  await db.insert(heartbeatRunEvents).values({
    companyId,
    runId,
    agentId,
    seq: 1,
    eventType: "output",
    message: `event ${token}`,
    payload: { transcript: token },
  });
  return {
    root,
    activeRoot,
    legacyRoot,
    receiptRoot,
    keyFile,
    companyId,
    agentId,
    runId,
    missingRunId,
    token,
    relativePath,
    legacyPath,
    orphanPath,
    gzipOrphanPath,
    gzipDecoded,
    originalLog,
  };
}

function options(fixture: Fixture, remediationId: string) {
  return {
    activeRoot: fixture.activeRoot,
    legacyRoot: fixture.legacyRoot,
    receiptRoot: fixture.receiptRoot,
    keyFile: fixture.keyFile,
    maintenanceConfirmed: true,
    remediationId,
    testHooks: { allowOtherDatabaseClients: true },
  };
}

async function interruptAfterFilesInstalled(db: ReturnType<typeof createDb>, fixture: Fixture, remediationId: string) {
  const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
  await expect(runProviderSessionCredentialRemediation(db, {
    ...options(fixture, remediationId),
    apply: true,
    expectedPlanSha256: dryRun.planSha256,
    testHooks: {
      allowOtherDatabaseClients: true,
      afterFilesInstalled: () => { throw new Error("injected inventory interruption"); },
    },
  })).rejects.toMatchObject({ rollForwardRequired: true });
  return dryRun;
}

describeDb("provider-session credential remediation command", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-credential-remediation-db-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    await tempDb?.cleanup();
  });

  it("overrides request-traffic statement timeouts on every maintenance connection", async () => {
    const constrained = new URL(tempDb!.connectionString);
    constrained.searchParams.set("options", "-c statement_timeout=1ms -c lock_timeout=2s");
    const maintenanceUrl = providerSessionCredentialRemediationConnectionString(constrained.toString());
    const parsed = new URL(maintenanceUrl);
    expect(parsed.searchParams.get("application_name")).toBe("paperclip-provider-session-credential-remediation");
    expect(parsed.searchParams.get("options")).toBe("-c statement_timeout=1ms -c lock_timeout=2s -c statement_timeout=0");

    const maintenanceDb = createDb(maintenanceUrl);
    try {
      const timeout = await maintenanceDb.execute(sql.raw("SHOW statement_timeout"));
      expect(Array.from(timeout as unknown as Array<{ statement_timeout: string }>)).toEqual([{ statement_timeout: "0" }]);
    } finally {
      await (maintenanceDb as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }
  });

  it("keeps multi-megabyte affected payloads out of the deterministic remediation plan", async () => {
    const fixture = await createFixture(db);
    const largePadding = "bounded-memory-regression:".padEnd(8 * 1024 * 1024, "x");
    await db.update(heartbeatRuns).set({
      resultJson: { summary: fixture.token, largePadding },
    }).where(eq(heartbeatRuns.id, fixture.runId));

    const planInput = {
      db,
      remediationId: "fixture-bounded-plan",
      activeRoot: fixture.activeRoot,
      legacyRoot: fixture.legacyRoot,
      receiptRoot: fixture.receiptRoot,
    };
    const first = await buildProviderSessionCredentialRemediationPlan(planInput);
    const second = await buildProviderSessionCredentialRemediationPlan(planInput);
    expect(second.planSha256).toBe(first.planSha256);
    expect(second.runs).toEqual(first.runs);
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toEqual({
      id: fixture.runId,
      oldFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      nextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      surfaceOccurrences: { stdout: 1, stderr: 1, result: 1 },
    });
    expect("old" in first.runs[0]!).toBe(false);
    expect("next" in first.runs[0]!).toBe(false);
    const serializedPlan = JSON.stringify(first);
    expect(Buffer.byteLength(serializedPlan)).toBeLessThan(64 * 1024);
    expect(serializedPlan).not.toContain(fixture.token);
    expect(serializedPlan).not.toContain("bounded-memory-regression:");
  }, 30_000);

  it("refuses to seal a planned successor as the rollback original", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-successor-before-backup";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforeRollbackEnvelope: async (plan) => {
          const mapped = plan.files.find((file) => file.mappedRunId === fixture.runId)!;
          const successor = Buffer.from(redactDecodableJwtShapesSameLength(fixture.originalLog.toString("utf8")), "utf8");
          expect(successor).toHaveLength(mapped.newBytes);
          expect(sha256(successor)).toBe(mapped.newSha256);
          await writeFile(mapped.sourcePath, successor, { mode: 0o600 });
        },
      },
    })).rejects.toMatchObject({ code: "rollback_file_cas_failed", rollForwardRequired: false });

    const runDirectory = path.join(fixture.receiptRoot, remediationId);
    const receiptNames = (await readdir(runDirectory)).filter((name) => name.endsWith(".json"));
    expect(receiptNames.some((name) => name.endsWith("-backup_prepared.json"))).toBe(false);
    expect(await stat(path.join(runDirectory, "rollback-envelope.aes256gcm")).catch(() => null)).toBeNull();
    expect(await stat(path.join(fixture.receiptRoot, "provider-session-credential-remediation.lock")).catch(() => null)).toBeNull();
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((values) => values[0]!);
    expect(run.stdoutExcerpt).toContain(fixture.token);
  }, 30_000);

  it("binds a dry-run approval and receipt chain to the canonical active and legacy roots", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-root-bound-approval";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    const cloneActive = path.join(fixture.root, "active-run-logs-clone");
    const cloneLegacy = path.join(fixture.root, "legacy-run-logs-clone");
    await cp(fixture.activeRoot, cloneActive, { recursive: true });
    await cp(fixture.legacyRoot, cloneLegacy, { recursive: true });
    const clonedPlan = await buildProviderSessionCredentialRemediationPlan({
      db,
      remediationId,
      activeRoot: cloneActive,
      legacyRoot: cloneLegacy,
      receiptRoot: fixture.receiptRoot,
    });
    expect(clonedPlan.planSha256).not.toBe(dryRun.planSha256);
    const runDirectory = path.join(fixture.receiptRoot, remediationId);
    const beforeReceipts = (await readdir(runDirectory)).filter((name) => name.endsWith(".json"));

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      activeRoot: cloneActive,
      legacyRoot: cloneLegacy,
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
    })).rejects.toMatchObject({ code: "root_identity_mismatch" });
    expect((await readdir(runDirectory)).filter((name) => name.endsWith(".json"))).toEqual(beforeReceipts);
  }, 30_000);

  it("does not let an alternate receipt root reuse an approval or create a poisoned chain", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-receipt-root-bound";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    const alternateReceiptRoot = path.join(fixture.root, "alternate-receipts");
    await mkdir(alternateReceiptRoot, { mode: 0o700 });
    await chmod(alternateReceiptRoot, 0o700);

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      receiptRoot: alternateReceiptRoot,
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
    })).rejects.toMatchObject({ code: "plan_approval_mismatch" });
    expect(await readdir(alternateReceiptRoot)).toEqual([]);
  }, 30_000);

  it("does not append roll-forward state when resume is pointed at byte-identical cloned roots", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-resume-root-bound";
    await interruptAfterFilesInstalled(db, fixture, remediationId);
    const cloneActive = path.join(fixture.root, "resume-active-clone");
    const cloneLegacy = path.join(fixture.root, "resume-legacy-clone");
    await cp(fixture.activeRoot, cloneActive, { recursive: true });
    await cp(fixture.legacyRoot, cloneLegacy, { recursive: true });
    const runDirectory = path.join(fixture.receiptRoot, remediationId);
    const beforeReceipts = (await readdir(runDirectory)).filter((name) => name.endsWith(".json"));

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      activeRoot: cloneActive,
      legacyRoot: cloneLegacy,
      apply: true,
    })).rejects.toMatchObject({ code: "root_identity_mismatch", rollForwardRequired: true });
    expect((await readdir(runDirectory)).filter((name) => name.endsWith(".json"))).toEqual(beforeReceipts);
  }, 30_000);

  it("keeps dry-run read-only, then migrates, redacts, CAS-updates, and verifies aggregate receipts", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-remediation-01";
    const dryRun = await runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: false,
    });
    expect(dryRun.status).toBe("dry_run");
    expect(dryRun.counts).toMatchObject({
      legacyOnlyRefs: 1,
      unresolvedMissingRefs: 1,
      affectedLegacyFiles: 3,
      affectedOrphanFiles: 2,
      mappedFilesToMigrate: 1,
      runRowsToUpdate: 1,
      eventRowsToUpdate: 1,
    });
    expect((await readFile(fixture.legacyPath, "utf8"))).toContain(fixture.token);
    expect(await stat(path.join(fixture.activeRoot, fixture.relativePath)).catch(() => null)).toBeNull();
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((values) => values[0]!);
    expect(before.stdoutExcerpt).toContain(fixture.token);

    const applied = await runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
    });
    expect(applied.status).toBe("verified");
    expect(applied.database).toMatchObject({
      txid: expect.stringMatching(/^\d+$/),
      pre_commit_lsn: expect.stringMatching(/^[0-9A-F]+\/[0-9A-F]+$/),
      post_commit_lsn: expect.stringMatching(/^[0-9A-F]+\/[0-9A-F]+$/),
    });
    expect(applied.cleanup).toEqual({
      legacy_sources_expected: 1,
      legacy_sources_removed_this_attempt: 1,
      legacy_sources_removed_total: 1,
    });
    expect(applied.postcheck).toEqual({
      active_referenced_files: 1,
      expected_active_referenced_files: 1,
      legacy_mapped_files: 0,
      unresolved_missing_refs: 1,
      unresolved_missing_refs_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      metadata_matched_rows: 1,
      file_predicate_occurrences: 0,
      database_predicate_rows: 0,
    });
    const activePath = path.join(fixture.activeRoot, fixture.relativePath);
    const activeBytes = await readFile(activePath);
    expect(activeBytes).toHaveLength(fixture.originalLog.length);
    expect(countDecodableJwtShapes(activeBytes.toString("utf8"))).toBe(0);
    expect(await stat(fixture.legacyPath).catch(() => null)).toBeNull();
    expect(countDecodableJwtShapes(await readFile(fixture.orphanPath, "utf8"))).toBe(0);
    const gzipAfter = gunzipSync(await readFile(fixture.gzipOrphanPath));
    expect(gzipAfter).toHaveLength(fixture.gzipDecoded.length);
    expect(countDecodableJwtShapes(gzipAfter.toString("utf8"))).toBe(0);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((values) => values[0]!);
    expect(countDecodableJwtShapes(run.stdoutExcerpt)).toBe(0);
    expect(countDecodableJwtShapes(run.stderrExcerpt)).toBe(0);
    expect(countDecodableJwtShapes(JSON.stringify(run.resultJson))).toBe(0);
    expect(run.logBytes).toBe(activeBytes.length);
    expect(run.logSha256).toBe(sha256(activeBytes));
    const missing = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.missingRunId)).then((values) => values[0]!);
    expect(missing.logRef).toBe(path.join(fixture.companyId, fixture.agentId, `${fixture.missingRunId}.ndjson`));
    expect(missing.logSha256).toBeNull();
    const event = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, fixture.runId)).then((values) => values[0]!);
    expect(countDecodableJwtShapes(event.message)).toBe(0);
    expect(countDecodableJwtShapes(JSON.stringify(event.payload))).toBe(0);

    const runDirectory = path.join(fixture.receiptRoot, remediationId);
    for (const name of await readdir(runDirectory)) {
      const bytes = await readFile(path.join(runDirectory, name));
      expect(bytes.includes(Buffer.from(fixture.token))).toBe(false);
      if (name.endsWith(".json")) {
        const receipt = JSON.parse(bytes.toString("utf8"));
        expect(receipt.aggregate_only).toBe(true);
        expect(receipt.immutable).toBe(true);
      }
    }
    const finalReceiptName = (await readdir(runDirectory)).filter((name) => name.endsWith("-verified.json")).sort().at(-1)!;
    const finalReceipt = JSON.parse(await readFile(path.join(runDirectory, finalReceiptName), "utf8"));
    expect(finalReceipt.approved_plan_sha256).toBe(applied.approvedPlanSha256);
    expect(finalReceipt.roots).toEqual({
      active_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      legacy_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      same_device: true,
    });
    expect(finalReceipt.database).toEqual(applied.database);
    expect(finalReceipt.cleanup).toEqual(applied.cleanup);
    expect(finalReceipt.postcheck).toEqual(applied.postcheck);
    expect((await stat(applied.backupPath)).mode & 0o777).toBe(0o400);
  }, 30_000);

  it("retains the exclusive lock after a post-install failure and resumes forward", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-remediation-resume";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterFilesInstalled: () => { throw new Error("injected post-install crash"); },
      },
    })).rejects.toMatchObject({ rollForwardRequired: true });
    const primaryLock = path.join(fixture.receiptRoot, "provider-session-credential-remediation.lock");
    expect((await stat(primaryLock)).isFile()).toBe(true);
    const preResume = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((values) => values[0]!);
    expect(preResume.stdoutExcerpt).toContain(fixture.token);

    const resumeDurability: string[] = [];
    const resumed = await runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterDurabilityFsync: (point) => { resumeDurability.push(point); },
      },
    });
    expect(resumed.status).toBe("verified");
    expect(resumeDurability).toEqual(["lock_create", "lock_delete", "primary_lock_delete"]);
    expect(await stat(primaryLock).catch(() => null)).toBeNull();
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((values) => values[0]!);
    expect(countDecodableJwtShapes(run.stdoutExcerpt)).toBe(0);
    expect(countDecodableJwtShapes((await readFile(path.join(fixture.activeRoot, fixture.relativePath))).toString("utf8"))).toBe(0);
  }, 30_000);

  it("resumes when every encrypted run, event, and file is already at its exact successor", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-inventory-already-next";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforePostVerify: () => { throw new Error("injected after all successors installed"); },
      },
    })).rejects.toMatchObject({ rollForwardRequired: true });

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).resolves.toMatchObject({
      status: "verified",
      postcheck: { active_referenced_files: 1, legacy_mapped_files: 0 },
    });
  }, 30_000);

  it("rejects coordinated safe drift of an encrypted run row and mapped-file metadata", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-run-safe-drift";
    await interruptAfterFilesInstalled(db, fixture, remediationId);
    const activePath = path.join(fixture.activeRoot, fixture.relativePath);
    const driftBytes = Buffer.from(`${JSON.stringify({ ts: new Date(1).toISOString(), stream: "stdout", chunk: "safe coordinated drift" })}\n`);
    await writeFile(activePath, driftBytes, { mode: 0o600 });
    await writeFile(fixture.legacyPath, driftBytes, { mode: 0o600 });
    await db.update(heartbeatRuns).set({
      logBytes: driftBytes.length,
      logSha256: sha256(driftBytes),
      stdoutExcerpt: "safe coordinated drift",
      stderrExcerpt: null,
      resultJson: { safe: "coordinated drift" },
    }).where(eq(heartbeatRuns.id, fixture.runId));

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).rejects.toMatchObject({ code: "resume_run_state_unbacked", rollForwardRequired: true });
  }, 30_000);

  it("rejects safe drift of an encrypted event that disappears from the resume plan", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-event-safe-drift";
    await interruptAfterFilesInstalled(db, fixture, remediationId);
    await db.update(heartbeatRunEvents).set({
      message: "safe event drift",
      payload: { safe: "event drift" },
    }).where(eq(heartbeatRunEvents.runId, fixture.runId));

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).rejects.toMatchObject({ code: "resume_event_state_unbacked", rollForwardRequired: true });
  }, 30_000);

  it("rejects deletion of an encrypted mapped file even when it disappears into the missing baseline", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-mapped-file-deleted";
    await interruptAfterFilesInstalled(db, fixture, remediationId);
    await rm(path.join(fixture.activeRoot, fixture.relativePath), { force: true });
    await rm(fixture.legacyPath, { force: true });

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).rejects.toMatchObject({ code: "resume_file_state_unbacked", rollForwardRequired: true });
  }, 30_000);

  it("rejects safe drift of an encrypted orphan file that no longer matches old or next", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-orphan-safe-drift";
    await interruptAfterFilesInstalled(db, fixture, remediationId);
    await writeFile(fixture.orphanPath, `${JSON.stringify({ ts: new Date(1).toISOString(), stream: "stderr", chunk: "safe orphan drift" })}\n`, { mode: 0o600 });

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).rejects.toMatchObject({ code: "resume_file_state_unbacked", rollForwardRequired: true });
  }, 30_000);

  it("rejects a resume mutation that was not captured by the verified envelope", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-unbacked-resume";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterFilesInstalled: () => { throw new Error("injected interruption"); },
      },
    })).rejects.toMatchObject({ rollForwardRequired: true });

    await db.insert(heartbeatRunEvents).values({
      companyId: fixture.companyId,
      runId: fixture.runId,
      agentId: fixture.agentId,
      seq: 2,
      eventType: "output",
      message: `late event ${fixture.token}`,
      payload: { late: fixture.token },
    });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).rejects.toMatchObject({ code: "resume_plan_not_backed", rollForwardRequired: true });
    expect((await stat(path.join(fixture.receiptRoot, "provider-session-credential-remediation.lock"))).isFile()).toBe(true);
  }, 30_000);

  it("atomically omits a failed phase receipt and preserves a contiguous resumable chain", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-receipt-crash";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    let injected = false;
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforePhaseReceiptInstall: (phase) => {
          if (phase === "db_committed" && !injected) {
            injected = true;
            throw new Error("injected receipt install failure");
          }
        },
      },
    })).rejects.toMatchObject({ rollForwardRequired: true });

    const runDirectory = path.join(fixture.receiptRoot, remediationId);
    const names = await readdir(runDirectory);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    const sequences = names
      .filter((name) => /^\d+-[a-z_]+[.]json$/.test(name))
      .map((name) => Number(name.split("-", 1)[0]))
      .sort((left, right) => left - right);
    expect(sequences).toEqual(sequences.map((_, index) => index));
    expect(names.some((name) => name.endsWith("-db_committed.json"))).toBe(false);
    expect(names.some((name) => name.endsWith("-roll_forward_required.json"))).toBe(true);

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).resolves.toMatchObject({ status: "verified" });
  }, 30_000);

  it("fails closed when a mapped log is moved back to the legacy root before postcheck", async () => {
    const fixture = await createFixture(db);
    const remediationId = "fixture-placement-postcheck";
    const dryRun = await runProviderSessionCredentialRemediation(db, { ...options(fixture, remediationId), apply: false });
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      apply: true,
      expectedPlanSha256: dryRun.planSha256,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforePostVerify: async () => {
          const activePath = path.join(fixture.activeRoot, fixture.relativePath);
          await mkdir(path.dirname(fixture.legacyPath), { recursive: true });
          await rename(activePath, fixture.legacyPath);
        },
      },
    })).rejects.toMatchObject({ code: "postcheck_root_placement", rollForwardRequired: true });

    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, remediationId),
      remediationId: undefined,
      resumeId: remediationId,
      apply: true,
    })).resolves.toMatchObject({
      status: "verified",
      postcheck: { active_referenced_files: 1, legacy_mapped_files: 0 },
    });
  }, 30_000);

  it("rechecks maintenance after acquiring the filesystem lock", async () => {
    const fixture = await createFixture(db);
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-lock-race"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterLockAcquired: async () => {
          await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, fixture.runId));
        },
      },
    })).rejects.toMatchObject({ code: "active_writers" });
    expect(await readdir(fixture.receiptRoot)).toEqual([]);
  });

  it("rejects a receipt root that is accessible to group or other users", async () => {
    const fixture = await createFixture(db);
    await chmod(fixture.receiptRoot, 0o755);
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-permissive-receipts"),
      apply: false,
    })).rejects.toMatchObject({ code: "unsafe_receipt_root" });
    expect(await readdir(fixture.receiptRoot)).toEqual([]);
  });

  it("rejects active writers before creating a remediation receipt", async () => {
    const fixture = await createFixture(db);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, fixture.runId));
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-active-writer"),
      apply: false,
    })).rejects.toMatchObject({ code: "active_writers" });
    expect(await readdir(fixture.receiptRoot)).toEqual([]);
  });

  it("fsyncs lock creation, run-directory creation, and lock deletion in order", async () => {
    const fixture = await createFixture(db);
    const checkpoints: string[] = [];
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-durability-order"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterDurabilityFsync: (point) => { checkpoints.push(point); },
      },
    })).resolves.toMatchObject({ status: "dry_run" });
    expect(checkpoints).toEqual(["lock_create", "run_directory_create", "lock_delete"]);
  });

  it("cleans the lock if its directory fsync fails before acquisition completes", async () => {
    const fixture = await createFixture(db);
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-lock-fsync-failure"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforeDurabilityFsync: (point) => {
          if (point === "lock_create") throw new Error("injected lock-create fsync failure");
        },
      },
    })).rejects.toThrow("injected lock-create fsync failure");
    expect(await readdir(fixture.receiptRoot)).toEqual([]);
  });

  it("does not append a receipt and durably cleans up when run-directory fsync fails", async () => {
    const fixture = await createFixture(db);
    const checkpoints: string[] = [];
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-run-directory-fsync-failure"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforeDurabilityFsync: (point) => {
          if (point === "run_directory_create") throw new Error("injected run-directory fsync failure");
        },
        afterDurabilityFsync: (point) => { checkpoints.push(point); },
      },
    })).rejects.toThrow("injected run-directory fsync failure");
    expect(checkpoints).toEqual(["lock_create", "lock_delete"]);
    expect(await readdir(fixture.receiptRoot)).toEqual([]);
  });

  it("fails closed if lock-deletion directory fsync cannot complete", async () => {
    const fixture = await createFixture(db);
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-lock-delete-fsync-failure"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        beforeDurabilityFsync: (point) => {
          if (point === "lock_delete") throw new Error("injected lock-delete fsync failure");
        },
      },
    })).rejects.toThrow("injected lock-delete fsync failure");
    expect(await stat(path.join(fixture.receiptRoot, "provider-session-credential-remediation.lock")).catch(() => null)).toBeNull();
  });

  it("uses an O_EXCL process lock", async () => {
    const fixture = await createFixture(db);
    let release!: () => void;
    let locked!: () => void;
    const lockObserved = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-lock-one"),
      apply: false,
      testHooks: {
        allowOtherDatabaseClients: true,
        afterLockAcquired: async () => { locked(); await gate; },
      },
    });
    await lockObserved;
    await expect(runProviderSessionCredentialRemediation(db, {
      ...options(fixture, "fixture-lock-two"),
      apply: false,
    })).rejects.toBeInstanceOf(CredentialRemediationError);
    release();
    await expect(first).resolves.toMatchObject({ status: "dry_run" });
  });
});
