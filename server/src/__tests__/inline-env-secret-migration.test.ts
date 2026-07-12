import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  INLINE_SECRET_MIGRATION_MAINTENANCE_ACK,
  INLINE_SECRET_MIGRATION_MAINTENANCE_ENV,
  parseInlineEnvSecretMigrationArgs,
  runInlineEnvSecretMigration,
} from "../ops/inline-env-secret-migration.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import { secretService } from "../services/secrets.js";
import { activityService } from "../services/activity.js";
import { isSensitiveEnvKey } from "../services/sensitive-env-keys.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describe("inline env secret migration CLI", () => {
  it("is dry-run by default and requires an explicit plan pin for apply", () => {
    expect(parseInlineEnvSecretMigrationArgs([])).toMatchObject({
      apply: false,
      importEnvNames: [],
      rotateImportedSecrets: false,
    });
    expect(parseInlineEnvSecretMigrationArgs([
      "--apply",
      "--expected-plan-sha256", "a".repeat(64),
      "--company-id", "11111111-1111-4111-8111-111111111111",
      "--import-env", "OPENCODE_GO_API_KEY",
      "--import-env", "SECONDARY_PROVIDER_API_KEY",
    ])).toMatchObject({
      apply: true,
      expectedPlanSha256: "a".repeat(64),
      importEnvNames: ["OPENCODE_GO_API_KEY", "SECONDARY_PROVIDER_API_KEY"],
    });
    expect(() => parseInlineEnvSecretMigrationArgs(["--apply"]))
      .toThrow("--apply requires --expected-plan-sha256");
    expect(() => parseInlineEnvSecretMigrationArgs(["--expected-plan-sha256", "a".repeat(64)]))
      .toThrow("valid only with --apply");
    expect(() => parseInlineEnvSecretMigrationArgs(["--import-env", "API_KEY"]))
      .toThrow("--company-id is required");
    expect(() => parseInlineEnvSecretMigrationArgs(["--master-key", "forbidden-inline-material"]))
      .toThrow("inline_secret_argument_invalid");
    expect(() => parseInlineEnvSecretMigrationArgs(["--apply", "--dry-run", "--expected-plan-sha256", "a".repeat(64)]))
      .toThrow("mutually exclusive");
  });
});

describe("inline env sensitive key boundary", () => {
  it("recognizes credential aliases without classifying cwd and metadata names", () => {
    for (const name of [
      "BEARER",
      "SERVICE_BEARER",
      "BEARER_FILE",
      "DB_PASSWD",
      "DB_PASSWD_FILE",
      "USER_PASSPHRASE",
      "SSH_PASSPHRASE_FILE",
      "PGPASSWORD",
      "PGPASSFILE",
      "MYSQL_PWD",
      "POSTGRES_PWD",
    ]) {
      expect(isSensitiveEnvKey(name), name).toBe(true);
    }
    for (const name of ["PWD", "COMPASS", "PASSENGER", "BEARER_STYLE", "PASSWORDLESS", "WORKING_PWD"]) {
      expect(isSensitiveEnvKey(name), name).toBe(false);
    }
  });
});

describeDb("canonical inline env secret migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let root = "";
  let masterKeyPath = "";
  let priorMasterKeyFile: string | undefined;
  let priorInlineMasterKey: string | undefined;
  let companySequence = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inline-secret-migration-");
    db = createDb(tempDb.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-inline-secret-receipts-"));
    masterKeyPath = path.join(root, "master.key");
    await writeFile(masterKeyPath, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
    await chmod(masterKeyPath, 0o600);
    priorMasterKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    priorInlineMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = masterKeyPath;
  });

  afterAll(async () => {
    if (priorMasterKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = priorMasterKeyFile;
    if (priorInlineMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorInlineMasterKey;
    await tempDb?.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  async function seedCompany() {
    companySequence += 1;
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Inline migration fixture ${companySequence}`,
      issuePrefix: `IS${companySequence.toString(36).toUpperCase().padStart(4, "0")}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(input: {
    companyId: string;
    env: Record<string, unknown>;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: `Secret fixture ${id.slice(0, 8)}`,
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "hermes_local",
      adapterConfig: { env: input.env, harmless: "preserved" },
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  const runOptions = () => ({
    connectionString: tempDb!.connectionString,
    homeDir: root,
    instanceId: "test",
    masterKeyFilePath: masterKeyPath,
  });

  const backupRunner = async ({ backupDir }: { connectionString: string; backupDir: string }) => {
    const backupFile = path.join(backupDir, `fixture-${randomUUID()}.sql.gz`);
    await writeFile(backupFile, "synthetic test backup\n", { mode: 0o600 });
    return { backupFile, compression: "gzip" as const, sizeBytes: 22, prunedCount: 0 };
  };

  async function dryAndApply(options: Parameters<typeof runInlineEnvSecretMigration>[1] = {}) {
    const common = { ...runOptions(), ...options };
    const dry = await runInlineEnvSecretMigration(db, common);
    const applied = await runInlineEnvSecretMigration(db, {
      ...common,
      apply: true,
      expectedPlanSha256: dry.planSha256,
      maintenanceAcknowledged: true,
      backupRunner,
    });
    return { dry, applied };
  }

  it("groups equal legacy and canonical plaintext across active and terminated agents into one encrypted secret", async () => {
    const companyId = await seedCompany();
    const name = `SHARED_${companySequence}_API_KEY`;
    const value = "same-private-fixture-value-alpha";
    const legacyAgent = await seedAgent({ companyId, env: { [name]: value }, status: "terminated" });
    const canonicalAgent = await seedAgent({
      companyId,
      env: { [name]: { type: "plain", value }, SAFE_SETTING: "left-alone" },
    });

    const { dry, applied } = await dryAndApply();
    expect(dry).toMatchObject({
      mode: "dry_run",
      summary: { changedAgentCount: 2, createCount: 1 },
    });
    expect((await stat(dry.receiptPath)).mode & 0o777).toBe(0o444);
    expect(applied).toMatchObject({ mode: "apply", status: "OK" });
    const secret = await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.name, name),
    )).then((rows) => rows[0]!);
    expect(secret.name).toBe(name);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id)))
      .toHaveLength(1);
    for (const agentId of [legacyAgent, canonicalAgent]) {
      const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
      expect((agent.adapterConfig.env as Record<string, unknown>)[name]).toEqual({
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      });
      expect(agent.adapterConfig.harmless).toBe("preserved");
    }
    const canonical = await db.select().from(agents).where(eq(agents.id, canonicalAgent)).then((rows) => rows[0]!);
    expect((canonical.adapterConfig.env as Record<string, unknown>).SAFE_SETTING).toEqual({
      type: "plain",
      value: "left-alone",
    });
    expect(await secretService(db).resolveSecretValue(companyId, secret.id, "latest")).toBe(value);
    const receiptBytes = await readFile(applied.receiptPath, "utf8");
    expect(receiptBytes).not.toContain(value);
    expect(Object.keys(applied.secrets[0]!)).toEqual(["companyId", "name", "id", "version", "action"]);
    expect((await stat(applied.databaseBackup!.path)).mode & 0o777).toBe(0o400);
  });

  it("keeps the same key isolated by company", async () => {
    const leftCompany = await seedCompany();
    const rightCompany = await seedCompany();
    const name = `TENANT_${companySequence}_TOKEN`;
    await seedAgent({ companyId: leftCompany, env: { [name]: "left-company-private-value" } });
    await seedAgent({ companyId: rightCompany, env: { [name]: "right-company-private-value" } });
    expect(await activityService(db).list({ companyId: leftCompany })).toEqual([]);
    expect(await activityService(db).list({ companyId: rightCompany })).toEqual([]);
    await dryAndApply();
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.name, name));
    expect(secrets).toHaveLength(2);
    expect(new Set(secrets.map((secret) => secret.companyId))).toEqual(new Set([leftCompany, rightCompany]));
    expect(await activityService(db).list({ companyId: leftCompany })).toEqual([]);
    expect(await activityService(db).list({ companyId: rightCompany })).toEqual([]);
    expect((await db.select().from(activityLog)).some((entry) =>
      entry.action === "inline_env_secret_migration.applied")).toBe(false);
  });

  it("migrates canonical database URLs and credential-bearing URI user-info without capturing ordinary endpoints", async () => {
    const companyId = await seedCompany();
    const databaseValue = "postgres://fixture-user:fixture-pass@db.example.test/paperclip";
    const userInfoValue = "https://fixture-user:fixture-pass@service.example.test/v1";
    const agentId = await seedAgent({
      companyId,
      env: {
        DATABASE_URL: databaseValue,
        SERVICE_ENDPOINT: { type: "plain", value: userInfoValue },
        API_BASE_URL: "https://api.example.test/v1",
      },
    });

    const { dry, applied } = await dryAndApply();
    expect(dry.secrets.filter((entry) => entry.companyId === companyId).map((entry) => entry.name).sort())
      .toEqual(["DATABASE_URL", "SERVICE_ENDPOINT"]);
    expect(JSON.stringify(applied)).not.toContain(databaseValue);
    expect(JSON.stringify(applied)).not.toContain(userInfoValue);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    const env = agent.adapterConfig.env as Record<string, unknown>;
    expect(env.DATABASE_URL).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(env.SERVICE_ENDPOINT).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(env.API_BASE_URL).toEqual({ type: "plain", value: "https://api.example.test/v1" });
  });

  it("fails closed without mutations when one company/key has divergent plaintext", async () => {
    const companyId = await seedCompany();
    const name = `COLLISION_${companySequence}_SECRET`;
    const firstAgent = await seedAgent({ companyId, env: { [name]: "first-collision-fixture" } });
    const secondAgent = await seedAgent({ companyId, env: { [name]: "second-collision-fixture" } });
    const beforeAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await expect(runInlineEnvSecretMigration(db, runOptions()))
      .rejects.toThrow(`inline_secret_plaintext_collision: company=${companyId} name=${name}`);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual(beforeAgents);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toEqual([]);
    await db.delete(agents).where(eq(agents.id, firstAgent));
    await db.delete(agents).where(eq(agents.id, secondAgent));
  });

  it("reuses a matching canonical secret without growing versions and rejects a mismatched fingerprint", async () => {
    const companyId = await seedCompany();
    const matchingName = `MATCH_${companySequence}_API_KEY`;
    const mismatchName = `MISMATCH_${companySequence}_API_KEY`;
    const matchingValue = "matching-existing-private-fixture";
    const mismatchInline = "mismatch-inline-private-fixture";
    const secrets = secretService(db);
    const existing = await secrets.create(companyId, {
      name: matchingName,
      provider: "local_encrypted",
      value: matchingValue,
    });
    await seedAgent({ companyId, env: { [matchingName]: matchingValue } });
    const { dry } = await dryAndApply();
    expect(dry.secrets.find((entry) => entry.name === matchingName)).toMatchObject({
      id: existing.id,
      version: 1,
      action: "reuse",
    });
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, existing.id)))
      .toHaveLength(1);

    await secrets.create(companyId, {
      name: mismatchName,
      provider: "local_encrypted",
      value: "different-existing-private-fixture",
    });
    const mismatchAgent = await seedAgent({ companyId, env: { [mismatchName]: mismatchInline } });
    const error = await runInlineEnvSecretMigration(db, runOptions()).catch((caught) => caught as Error);
    expect(error.message).toBe(`inline_secret_fingerprint_mismatch: company=${companyId} name=${mismatchName}`);
    expect(error.message).not.toContain(mismatchInline);
    expect(error.message).not.toMatch(/[a-f0-9]{64}/);
    await db.delete(agents).where(eq(agents.id, mismatchAgent));
  });

  it("imports only named process-environment values and rotates only on explicit mismatch approval", async () => {
    const companyId = await seedCompany();
    const name = `IMPORTED_${companySequence}_API_KEY`;
    const firstValue = "first-imported-process-value";
    const secondValue = "second-imported-process-value";
    const firstOptions = {
      ...runOptions(),
      importCompanyId: companyId,
      importEnvNames: [name],
      environment: { [name]: firstValue },
    };
    const alternateValueDry = await runInlineEnvSecretMigration(db, {
      ...firstOptions,
      environment: { [name]: secondValue },
    });
    const approvedValueDry = await runInlineEnvSecretMigration(db, firstOptions);
    expect(alternateValueDry.planSha256).not.toBe(approvedValueDry.planSha256);
    expect(JSON.stringify(alternateValueDry)).not.toContain(secondValue);
    const first = await dryAndApply(firstOptions);
    expect(first.applied.secrets).toEqual([{
      companyId,
      name,
      id: first.applied.secrets[0]!.id,
      version: 1,
      action: "create",
    }]);
    expect(JSON.stringify(first.applied)).not.toContain(firstValue);

    const secondDry = await runInlineEnvSecretMigration(db, firstOptions);
    expect(secondDry.secrets[0]).toMatchObject({ action: "reuse", version: 1 });
    await dryAndApply(firstOptions);
    const secretId = secondDry.secrets[0]!.id;
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId)))
      .toHaveLength(1);

    await expect(runInlineEnvSecretMigration(db, {
      ...firstOptions,
      environment: { [name]: secondValue },
    })).rejects.toThrow(`inline_secret_fingerprint_mismatch: company=${companyId} name=${name}`);
    const rotateOptions = {
      ...firstOptions,
      environment: { [name]: secondValue },
      rotateImportedSecrets: true,
    };
    const rotated = await dryAndApply(rotateOptions);
    expect(rotated.applied.secrets[0]).toMatchObject({ action: "rotate", version: 2 });
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId)))
      .toHaveLength(2);
    expect(await secretService(db).resolveSecretValue(companyId, secretId, "latest")).toBe(secondValue);
  });

  it("requires the exact dry-run approval pin before backup or mutation", async () => {
    const companyId = await seedCompany();
    const name = `PIN_${companySequence}_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "approval-pin-private-fixture" } });
    let backupCalls = 0;
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      apply: true,
      expectedPlanSha256: "0".repeat(64),
      maintenanceAcknowledged: true,
      backupRunner: async (input) => {
        backupCalls += 1;
        return backupRunner(input);
      },
    })).rejects.toThrow("inline_secret_plan_approval_mismatch");
    expect(backupCalls).toBe(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toEqual([]);
    await db.delete(agents).where(eq(agents.id, agentId));
  });

  it("does not accept a maintenance acknowledgment sourced implicitly from process.env", async () => {
    const companyId = await seedCompany();
    const name = `ACK_${companySequence}_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "ack-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    const priorAck = process.env[INLINE_SECRET_MIGRATION_MAINTENANCE_ENV];
    process.env[INLINE_SECRET_MIGRATION_MAINTENANCE_ENV] = INLINE_SECRET_MIGRATION_MAINTENANCE_ACK;
    let backupCalls = 0;
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        apply: true,
        expectedPlanSha256: dry.planSha256,
        backupRunner: async (input) => {
          backupCalls += 1;
          return backupRunner(input);
        },
      })).rejects.toThrow("inline_secret_maintenance_ack_required");
      expect(backupCalls).toBe(0);
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
    } finally {
      if (priorAck === undefined) delete process.env[INLINE_SECRET_MIGRATION_MAINTENANCE_ENV];
      else process.env[INLINE_SECRET_MIGRATION_MAINTENANCE_ENV] = priorAck;
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  });

  it("rolls back secret and agent writes together when an injected crash crosses the secret-write boundary", async () => {
    const companyId = await seedCompany();
    const name = `ROLLBACK_${companySequence}_PASSWORD`;
    const agentId = await seedAgent({ companyId, env: { [name]: "rollback-private-fixture" } });
    const before = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      apply: true,
      expectedPlanSha256: dry.planSha256,
      maintenanceAcknowledged: true,
      backupRunner,
      testHooks: { afterSecretWrites: () => { throw new Error("synthetic-crash"); } },
    })).rejects.toThrow("synthetic-crash");
    expect(await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!)).toEqual(before);
    expect(await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.name, name),
    ))).toEqual([]);
    await db.delete(agents).where(eq(agents.id, agentId));
  });

  it("recomputes the complete locked plan and rejects a new inline binding created after backup", async () => {
    const companyId = await seedCompany();
    const name = `CAS_${companySequence}_AUTH_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "cas-original-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    let lateAgentId = "";
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      apply: true,
      expectedPlanSha256: dry.planSha256,
      maintenanceAcknowledged: true,
      backupRunner,
      testHooks: {
        beforeTransaction: async () => {
          lateAgentId = await seedAgent({
            companyId,
            env: { [name]: "cas-original-private-fixture" },
          });
        },
      },
    })).rejects.toThrow("inline_secret_full_plan_changed_under_lock");
    expect(await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.name, name),
    ))).toEqual([]);
    await db.delete(agents).where(eq(agents.id, agentId));
    if (lateAgentId) await db.delete(agents).where(eq(agents.id, lateAgentId));
  });

  it("rejects a master-key path replacement immediately before the transaction", async () => {
    const companyId = await seedCompany();
    const name = `KEY_SWAP_PRE_TX_${companySequence}_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "key-swap-pre-tx-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    const displacedKey = `${masterKeyPath}.${randomUUID()}.displaced`;
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        apply: true,
        expectedPlanSha256: dry.planSha256,
        maintenanceAcknowledged: true,
        backupRunner,
        testHooks: {
          beforeTransaction: async () => {
            await rename(masterKeyPath, displacedKey);
            await writeFile(masterKeyPath, Buffer.alloc(32, 8).toString("base64"), { mode: 0o600 });
            await chmod(masterKeyPath, 0o600);
          },
        },
      })).rejects.toThrow("inline_secret_master_key_changed");
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
    } finally {
      await rm(masterKeyPath, { force: true });
      await rename(displacedKey, masterKeyPath);
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  });

  it("rolls back when the master-key path is replaced immediately before commit", async () => {
    const companyId = await seedCompany();
    const name = `KEY_SWAP_COMMIT_${companySequence}_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "key-swap-commit-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    const displacedKey = `${masterKeyPath}.${randomUUID()}.displaced`;
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        apply: true,
        expectedPlanSha256: dry.planSha256,
        maintenanceAcknowledged: true,
        backupRunner,
        testHooks: {
          beforeCommit: async () => {
            await rename(masterKeyPath, displacedKey);
            await writeFile(masterKeyPath, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
            await chmod(masterKeyPath, 0o600);
          },
        },
      })).rejects.toThrow("inline_secret_master_key_changed");
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
    } finally {
      await rm(masterKeyPath, { force: true });
      await rename(displacedKey, masterKeyPath);
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  });

  it("rejects a backup symlink before writing intent or mutating the database", async () => {
    const companyId = await seedCompany();
    const name = `BACKUP_LINK_${companySequence}_TOKEN`;
    const agentId = await seedAgent({ companyId, env: { [name]: "backup-link-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    const outsideBackup = path.join(root, `outside-backup-${randomUUID()}.sql.gz`);
    await writeFile(outsideBackup, "outside synthetic backup\n", { mode: 0o600 });
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        apply: true,
        expectedPlanSha256: dry.planSha256,
        maintenanceAcknowledged: true,
        backupRunner: async ({ backupDir }) => {
          const linkPath = path.join(backupDir, `linked-${randomUUID()}.sql.gz`);
          await symlink(outsideBackup, linkPath);
          return { backupFile: linkPath, compression: "gzip", sizeBytes: 25, prunedCount: 0 };
        },
      })).rejects.toThrow("inline_secret_backup_not_regular_file");
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
    } finally {
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  });

  it("reconciles a committed migration when the final immutable receipt write fails", async () => {
    const companyId = await seedCompany();
    const name = `RECONCILE_${companySequence}_API_KEY`;
    const value = "receipt-reconciliation-private-fixture";
    const agentId = await seedAgent({ companyId, env: { [name]: value } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    let receiptWrites = 0;
    let backupCalls = 0;
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      apply: true,
      expectedPlanSha256: dry.planSha256,
      maintenanceAcknowledged: true,
      backupRunner: async (input) => {
        backupCalls += 1;
        return backupRunner(input);
      },
      receiptWriter: async (receiptPath, receipt) => {
        receiptWrites += 1;
        if (receiptWrites === 3) throw new Error("synthetic-final-receipt-failure");
        return writeImmutableJsonReceipt(receiptPath, receipt);
      },
    })).rejects.toThrow("inline_secret_final_receipt_failed_after_commit");
    expect(backupCalls).toBe(1);
    const committedSecret = await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.name, name),
    )).then((rows) => rows[0]!);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, committedSecret.id)))
      .toHaveLength(1);

    const reconciled = await runInlineEnvSecretMigration(db, {
      ...runOptions(),
      apply: true,
      expectedPlanSha256: dry.planSha256,
      backupRunner: async (input) => {
        backupCalls += 1;
        return backupRunner(input);
      },
    });
    expect(reconciled).toMatchObject({ status: "OK", mode: "apply", reconciled: true });
    expect(backupCalls).toBe(1);
    expect((await stat(reconciled.receiptPath)).mode & 0o777).toBe(0o444);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((agent.adapterConfig.env as Record<string, unknown>)[name]).toEqual({
      type: "secret_ref",
      secretId: committedSecret.id,
      version: "latest",
    });
    expect(await secretService(db).resolveSecretValue(companyId, committedSecret.id, "latest")).toBe(value);
  });

  it("rejects a tampered private recovery receipt without another mutation or receipt", async () => {
    const companyId = await seedCompany();
    const name = `RECOVERY_TAMPER_${companySequence}_TOKEN`;
    const value = "recovery-tamper-private-fixture";
    const agentId = await seedAgent({ companyId, env: { [name]: value } });
    const receiptDir = `data/ops/recovery-tamper-${randomUUID()}`;
    const common = { ...runOptions(), receiptDir };
    const dry = await runInlineEnvSecretMigration(db, common);
    let receiptWrites = 0;
    let backupCalls = 0;
    await expect(runInlineEnvSecretMigration(db, {
      ...common,
      apply: true,
      expectedPlanSha256: dry.planSha256,
      maintenanceAcknowledged: true,
      backupRunner: async (input) => {
        backupCalls += 1;
        return backupRunner(input);
      },
      receiptWriter: async (receiptPath, receipt) => {
        receiptWrites += 1;
        if (receiptWrites === 3) throw new Error("synthetic-final-receipt-failure");
        return writeImmutableJsonReceipt(receiptPath, receipt);
      },
    })).rejects.toThrow("inline_secret_final_receipt_failed_after_commit");

    const canonicalReceiptDir = path.join(root, "instances", "test", receiptDir);
    const beforeNames = await readdir(canonicalReceiptDir);
    const recoveryName = beforeNames.find((entry) => entry.endsWith("-recovery.json"));
    expect(recoveryName).toBeTruthy();
    const recoveryPath = path.join(canonicalReceiptDir, recoveryName!);
    const recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
    const result = JSON.parse(String(recovery.resultReceiptJson)) as Record<string, unknown>;
    result.summary = { ...(result.summary as Record<string, unknown>), changedAgentCount: 999 };
    recovery.resultReceiptJson = `${JSON.stringify(result, null, 2)}\n`;
    await chmod(recoveryPath, 0o600);
    await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`);
    await chmod(recoveryPath, 0o444);

    await expect(runInlineEnvSecretMigration(db, {
      ...common,
      apply: true,
      expectedPlanSha256: dry.planSha256,
      backupRunner: async (input) => {
        backupCalls += 1;
        return backupRunner(input);
      },
    })).rejects.toThrow("inline_secret_recovery_receipt_invalid");
    expect(backupCalls).toBe(1);
    expect((await readdir(canonicalReceiptDir)).sort()).toEqual([...beforeNames].sort());
    const secret = await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.name, name),
    )).then((rows) => rows[0]!);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id)))
      .toHaveLength(1);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((agent.adapterConfig.env as Record<string, unknown>)[name]).toMatchObject({
      type: "secret_ref",
      secretId: secret.id,
      version: "latest",
    });
  });

  it("refuses to auto-create a missing master key before mutation", async () => {
    const companyId = await seedCompany();
    const name = `KEYFILE_${companySequence}_PRIVATE_KEY`;
    await seedAgent({ companyId, env: { [name]: "missing-key-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    const missingKey = path.join(root, "must-not-be-created.key");
    const prior = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        masterKeyFilePath: missingKey,
        apply: true,
        expectedPlanSha256: dry.planSha256,
        maintenanceAcknowledged: true,
        backupRunner,
      })).rejects.toThrow("inline_secret_master_key_invalid");
      await expect(stat(missingKey)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = prior;
    }
  });

  it("rejects inline master-key material even when the configured key file exists", async () => {
    const companyId = await seedCompany();
    const name = `INLINE_MASTER_${companySequence}_API_KEY`;
    const agentId = await seedAgent({ companyId, env: { [name]: "inline-master-private-fixture" } });
    const dry = await runInlineEnvSecretMigration(db, runOptions());
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        apply: true,
        expectedPlanSha256: dry.planSha256,
        maintenanceAcknowledged: true,
        backupRunner,
      })).rejects.toThrow("inline_secret_inline_master_key_forbidden");
      expect(await db.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.name, name),
      ))).toEqual([]);
      expect((await stat(masterKeyPath)).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      await db.delete(agents).where(eq(agents.id, agentId));
    }
  });

  it("rejects a master-key file with group permissions without changing or replacing it", async () => {
    const insecureKey = path.join(root, "group-readable-master.key");
    await writeFile(insecureKey, Buffer.alloc(32, 5).toString("base64"), { mode: 0o640 });
    await chmod(insecureKey, 0o640);
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      masterKeyFilePath: insecureKey,
    })).rejects.toThrow("inline_secret_master_key_invalid");
    const metadata = await stat(insecureKey);
    expect(metadata.mode & 0o777).toBe(0o640);
    expect(metadata.size).toBeGreaterThan(0);
  });

  it("rejects a master-key leaf symlink without following it", async () => {
    const symlinkPath = path.join(root, `master-link-${randomUUID()}.key`);
    await symlink(masterKeyPath, symlinkPath);
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      masterKeyFilePath: symlinkPath,
    })).rejects.toThrow("inline_secret_master_key_invalid");
    expect((await stat(masterKeyPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked receipt-path component without writing through it", async () => {
    const alternateHome = path.join(root, `symlink-home-${randomUUID()}`);
    const outside = path.join(root, `symlink-outside-${randomUUID()}`);
    await mkdir(path.join(alternateHome, "instances", "test"), { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(alternateHome, "instances", "test", "data"));
    await expect(runInlineEnvSecretMigration(db, {
      ...runOptions(),
      homeDir: alternateHome,
    })).rejects.toThrow("inline_secret_operator_root_invalid");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects an intermediate operator directory writable by another uid", async () => {
    const unsafeHome = path.join(root, `unsafe-home-${randomUUID()}`);
    const unsafeInstances = path.join(unsafeHome, "instances");
    await mkdir(unsafeInstances, { recursive: true, mode: 0o700 });
    await chmod(unsafeInstances, 0o777);
    try {
      await expect(runInlineEnvSecretMigration(db, {
        ...runOptions(),
        homeDir: unsafeHome,
      })).rejects.toThrow("inline_secret_operator_root_invalid");
      expect(await readdir(unsafeHome)).toEqual(["instances"]);
    } finally {
      await chmod(unsafeInstances, 0o700);
    }
  });

  it("rejects a master-key file not owned by the current effective uid", async () => {
    if (typeof process.geteuid !== "function") return;
    const actualUid = process.geteuid();
    const ownerSpy = vi.spyOn(process, "geteuid").mockReturnValue(actualUid + 1);
    try {
      await expect(runInlineEnvSecretMigration(db, runOptions()))
        .rejects.toThrow("inline_secret_master_key_invalid");
      expect((await stat(masterKeyPath)).mode & 0o777).toBe(0o600);
    } finally {
      ownerSpy.mockRestore();
    }
  });
});
