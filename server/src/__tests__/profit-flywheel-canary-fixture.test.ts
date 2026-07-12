import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  canaryFixtureIdentity,
  parseCanaryFixtureCliArgs,
  resolveEmbeddedCanaryFixtureConnection,
  rollbackProfitFlywheelCanaryFixture,
  setupProfitFlywheelCanaryFixture,
} from "../ops/profit-flywheel-canary-fixture.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import { prepareTrustedReceiptDirectory } from "../ops/trusted-receipt-directory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const COMPANY_ID = "216897d4-0f94-4736-9b6b-a20c8e48d694";
const ENGINEER_ID = "35014584-00ed-4dd1-a822-f6119db5af1d";
const RUN_ID = "fixture-setup-test";

describe("Profit Flywheel canary fixture CLI", () => {
  it("rejects database URLs and credential-shaped argv", () => {
    expect(() => parseCanaryFixtureCliArgs(["setup"], {
      DATABASE_URL: "postgres://operator:secret@127.0.0.1/paperclip",
    })).toThrow("profit_canary_fixture_database_url_forbidden");
    expect(() => parseCanaryFixtureCliArgs([
      "setup", "--company-id", COMPANY_ID, "--engineer-agent-id", ENGINEER_ID,
      "--run-id", RUN_ID, "--portfolio-os-root", "/safe", "--receipt-dir", "/safe",
      "--api-key", "secret",
    ], {})).toThrow("profit_canary_fixture_credential_argv_forbidden");
  });

  it("accepts only a selected embedded instance", () => {
    expect(resolveEmbeddedCanaryFixtureConnection({
      databaseMode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    })).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
    expect(() => resolveEmbeddedCanaryFixtureConnection({
      databaseMode: "postgres",
      embeddedPostgresPort: 54329,
    })).toThrow("profit_canary_fixture_embedded_instance_required");
  });

  it("derives stable distinct project and workspace identities", () => {
    const first = canaryFixtureIdentity(COMPANY_ID, RUN_ID);
    expect(first).toEqual(canaryFixtureIdentity(COMPANY_ID, RUN_ID));
    expect(first.projectId).not.toBe(first.workspaceId);
    expect(first.projectId).toMatch(/^[a-f0-9-]{36}$/);
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("Profit Flywheel canary fixture transactional operator", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-canary-fixture-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed(status = "paused") {
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Canary fixture company",
      issuePrefix: "CFT",
    });
    await db.insert(agents).values({
      id: ENGINEER_ID,
      companyId: COMPANY_ID,
      name: "Engineer-1",
      role: "engineer",
      status,
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      pauseReason: status === "paused" ? "fleet quiescence" : null,
      pausedAt: status === "paused" ? new Date("2026-07-12T10:00:00.000Z") : null,
    });
    const lexicalRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-canary-fixture-fs-"));
    const root = await realpath(lexicalRoot);
    roots.push(root);
    const portfolioOsRoot = path.join(root, "portfolio-os");
    const receiptDir = path.join(root, "receipts");
    await mkdir(portfolioOsRoot, { mode: 0o700 });
    await mkdir(receiptDir, { mode: 0o700 });
    await chmod(portfolioOsRoot, 0o700);
    await chmod(receiptDir, 0o700);
    return { portfolioOsRoot, receiptDir };
  }

  it("creates exact run-bound rows, resumes once, replays idempotently, and safely re-pauses", async () => {
    const dirs = await seed();
    const now = () => new Date("2026-07-12T12:00:00.000Z");
    const first = await setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    }, { now });
    expect(first.status).toBe("ready");
    expect(first.priorAgentStatus).toBe("paused");
    expect((await lstat(first.receiptPath)).mode & 0o777).toBe(0o444);
    expect(first.setupIntentPath).toBe(path.join(dirs.receiptDir, RUN_ID + "-fixture-setup-intent.json"));
    expect((await lstat(first.setupIntentPath!)).mode & 0o777).toBe(0o444);
    const receipt = JSON.parse(await readFile(first.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      company_id: COMPANY_ID,
      run_id: RUN_ID,
      target_repo: "fixture/profit-canary",
      engineer_agent_id: ENGINEER_ID,
      prior_agent_status: "paused",
      resumed_by_setup: true,
      resulting_agent_status: "idle",
      secrets_in_argv: false,
      database_url_accepted: false,
      immutable: true,
      setup_intent: {
        path: first.setupIntentPath,
        sha256: first.setupIntentSha256,
      },
    });
    const intent = JSON.parse(await readFile(first.setupIntentPath!, "utf8"));
    expect(intent).toMatchObject({
      schema_version: "paperclip.profit_flywheel_canary_fixture_setup_intent.v1",
      operation: "profit_flywheel_canary_fixture_setup",
      phase: "prepared",
      run_id: RUN_ID,
      final_receipt_path: first.receiptPath,
      immutable: true,
    });
    expect(await db.select({ status: agents.status }).from(agents).where(eq(agents.id, ENGINEER_ID)))
      .toEqual([{ status: "idle" }]);
    const [project] = await db.select().from(projects);
    const [workspace] = await db.select().from(projectWorkspaces);
    expect(project).toMatchObject({
      id: first.projectId,
      companyId: COMPANY_ID,
      leadAgentId: ENGINEER_ID,
      status: "in_progress",
    });
    expect(workspace).toMatchObject({
      id: first.workspaceId,
      projectId: first.projectId,
      cwd: first.targetWorkspace,
      isPrimary: true,
      sourceType: "local_path",
    });

    const replay = await setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    }, { now: () => new Date("2026-07-12T12:05:00.000Z") });
    expect(replay.receiptSha256).toBe(first.receiptSha256);
    expect(await db.select().from(activityLog)).toHaveLength(1);

    const rolledBack = await rollbackProfitFlywheelCanaryFixture(db, {
      setupReceiptPath: first.receiptPath,
      receiptDir: dirs.receiptDir,
    }, { now: () => new Date("2026-07-12T13:00:00.000Z") });
    expect(rolledBack).toMatchObject({
      status: "safe",
      result: { prior_status: "paused", resulting_status: "paused", changed: true },
    });
    expect((await lstat(rolledBack.receiptPath)).mode & 0o777).toBe(0o444);
    expect(await db.select({ status: agents.status }).from(agents).where(eq(agents.id, ENGINEER_ID)))
      .toEqual([{ status: "paused" }]);
    expect(await db.select().from(projects)).toHaveLength(1);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(1);
  });

  it("does not mutate the database when the final receipt path conflicts", async () => {
    const dirs = await seed();
    const receiptPath = path.join(dirs.receiptDir, RUN_ID + "-fixture-setup.json");
    const intentPath = path.join(dirs.receiptDir, RUN_ID + "-fixture-setup-intent.json");
    await writeImmutableJsonReceipt(receiptPath, {
      schema_version: "conflicting.receipt.v1",
      immutable: true,
    });

    await expect(setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    }, { now: () => new Date("2026-07-12T12:00:00.000Z") }))
      .rejects.toThrow("profit_canary_fixture_setup_receipt_conflict");

    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect(await db.select({ status: agents.status }).from(agents).where(eq(agents.id, ENGINEER_ID)))
      .toEqual([{ status: "paused" }]);
    await expect(lstat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers deterministically after a crash between database commit and final receipt", async () => {
    const dirs = await seed();
    const setupOptions = {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    };
    const setupAt = "2026-07-12T12:00:00.000Z";
    const receiptPath = path.join(dirs.receiptDir, RUN_ID + "-fixture-setup.json");
    const intentPath = path.join(dirs.receiptDir, RUN_ID + "-fixture-setup-intent.json");

    await expect(setupProfitFlywheelCanaryFixture(db, setupOptions, {
      now: () => new Date(setupAt),
      afterDatabaseMutationBeforeFinalReceipt: () => {
        throw new Error("simulated_process_crash");
      },
    })).rejects.toThrow("simulated_process_crash");

    expect((await lstat(intentPath)).mode & 0o777).toBe(0o444);
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(projects)).toHaveLength(1);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(1);
    expect(await db.select({ status: agents.status }).from(agents).where(eq(agents.id, ENGINEER_ID)))
      .toEqual([{ status: "idle" }]);
    expect(await db.select().from(activityLog)).toHaveLength(1);

    const recovered = await setupProfitFlywheelCanaryFixture(db, setupOptions, {
      now: () => new Date("2026-07-12T12:05:00.000Z"),
    });
    expect(recovered.status).toBe("ready");
    expect(recovered.setupIntentPath).toBe(intentPath);
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o444);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      setup_at: setupAt,
      setup_intent: { path: intentPath, sha256: recovered.setupIntentSha256 },
    });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("recovers after a final receipt write failure without duplicating mutations", async () => {
    const dirs = await seed();
    const setupOptions = {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    };
    let writeAttempts = 0;
    await expect(setupProfitFlywheelCanaryFixture(db, setupOptions, {
      now: () => new Date("2026-07-12T12:00:00.000Z"),
      writeFinalReceipt: async () => {
        writeAttempts += 1;
        throw new Error("simulated_final_receipt_write_failure");
      },
    })).rejects.toThrow("simulated_final_receipt_write_failure");
    expect(writeAttempts).toBe(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);

    const recovered = await setupProfitFlywheelCanaryFixture(db, setupOptions, {
      now: () => new Date("2026-07-12T12:10:00.000Z"),
    });
    expect(recovered.status).toBe("ready");
    expect((await lstat(recovered.receiptPath)).mode & 0o777).toBe(0o444);
    expect(await db.select().from(projects)).toHaveLength(1);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("never re-pauses an agent that was already idle", async () => {
    const dirs = await seed("idle");
    const setup = await setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    }, { now: () => new Date("2026-07-12T12:00:00.000Z") });
    const rollback = await rollbackProfitFlywheelCanaryFixture(db, {
      setupReceiptPath: setup.receiptPath,
      receiptDir: dirs.receiptDir,
    }, { now: () => new Date("2026-07-12T13:00:00.000Z") });
    expect(rollback.result).toEqual({
      prior_status: "idle",
      resulting_status: "idle",
      changed: false,
    });
  });

  it("fails closed on project drift and a busy post-canary agent", async () => {
    const dirs = await seed();
    const setup = await setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    }, { now: () => new Date("2026-07-12T12:00:00.000Z") });
    await db.update(projects).set({ status: "completed" }).where(eq(projects.id, setup.projectId));
    await expect(setupProfitFlywheelCanaryFixture(db, {
      companyId: COMPANY_ID,
      engineerAgentId: ENGINEER_ID,
      runId: RUN_ID,
      ...dirs,
    })).rejects.toThrow("profit_canary_fixture_project_conflict:status");
    await db.update(projects).set({ status: "in_progress" }).where(eq(projects.id, setup.projectId));
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, ENGINEER_ID));
    await expect(rollbackProfitFlywheelCanaryFixture(db, {
      setupReceiptPath: setup.receiptPath,
      receiptDir: dirs.receiptDir,
    })).rejects.toThrow("profit_canary_fixture_rollback_agent_busy");
  });

  it("rejects a symlinked or group-writable receipt hierarchy", async () => {
    const dirs = await seed();
    const link = path.join(path.dirname(dirs.receiptDir), "receipt-link");
    await (await import("node:fs/promises")).symlink(dirs.receiptDir, link);
    await expect(prepareTrustedReceiptDirectory(link, "test_receipt_dir"))
      .rejects.toThrow(/not_canonical|symlink_hierarchy/);
    await chmod(dirs.receiptDir, 0o770);
    await expect(prepareTrustedReceiptDirectory(dirs.receiptDir, "test_receipt_dir"))
      .rejects.toThrow("test_receipt_dir_unsafe_hierarchy");
  });
});
