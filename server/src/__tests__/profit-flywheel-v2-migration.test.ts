import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentApiKeys,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  profitFlywheelLeases,
  profitFlywheelMigrationRuns,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  classifyProfitFlywheelRoutineTitle,
  configureProfitFlywheelCliRuntimeEnvironment,
  generateProfitFlywheelFleetAudit,
  isSensitiveEnvBinding,
  isSensitiveEnvKey,
  migrateProfitFlywheelV2,
  parseProfitFlywheelV2Args,
  planProfitFlywheelV2Agent,
  provisionProfitFlywheelRuntimeIdentity,
  providerPolicyRuntimeAuthorityForAgentAdapter,
  reconcileStaleProfitFlywheelAgents,
  rollbackProfitFlywheelV2Migration,
  validateFleetAuditSnapshot,
  validateCommittedMigrationIntentReceipt,
} from "../ops/profit-flywheel-v2-migration.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("Profit Flywheel v2 fleet migration", () => {
  it("normalizes enabled 300-second history to event-only and is idempotent", async () => {
    const loaded = await loadProviderPolicyV2();
    const agent = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {
        tieredExecution: { enabled: true },
        tokenomics: { intervalSec: 300 },
        provider: "minimax",
        model: "MiniMax-M3",
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 300 },
        autonomyRecovery: { previousHeartbeat: { intervalSec: 300, maxConcurrentRuns: 5 } },
      },
    };
    const args = {
      policy: loaded.policy,
      policyPath: loaded.path,
      policySha256: loaded.sha256,
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
    };
    const first = planProfitFlywheelV2Agent({ agent, ...args });
    expect(first.nextRuntimeConfig.heartbeat).toMatchObject({
      enabled: false,
      intervalSec: 0,
      maxConcurrentRuns: 1,
      wakeOnDemand: true,
      wakeOnAssignment: true,
      triggerMode: "event_only",
    });
    expect(first.nextRuntimeConfig).not.toHaveProperty("autonomyRecovery");
    expect(first.nextAdapterConfig).not.toHaveProperty("tieredExecution");
    expect(first.nextAdapterConfig).not.toHaveProperty("tokenomics");
    expect(JSON.stringify(first.nextRuntimeConfig)).not.toContain(":300");
    expect(JSON.stringify(first.nextRuntimeConfig)).not.toContain(":5");

    const second = planProfitFlywheelV2Agent({
      agent: { ...agent, adapterConfig: first.nextAdapterConfig, runtimeConfig: first.nextRuntimeConfig },
      ...args,
    });
    expect(second.changed).toBe(false);
    expect(second.afterAdapterConfigSha256).toBe(first.afterAdapterConfigSha256);
    expect(second.afterRuntimeConfigSha256).toBe(first.afterRuntimeConfigSha256);
  });

  it("derives runtime identity only from provider-policy routes and fails on adapter disagreement", async () => {
    const loaded = await loadProviderPolicyV2();
    const mutated = structuredClone(loaded.policy);
    for (const route of Object.values(mutated.routes)) {
      if (route.runtimeBinding.adapterType !== "hermes_local") continue;
      route.runtimeBinding.commandRealpath = "/tmp/policy-owned-hermes";
      route.runtimeBinding.commandSha256 = "9".repeat(64);
      route.runtimeBinding.expectedVersion = "Hermes policy authority test";
    }
    const authority = providerPolicyRuntimeAuthorityForAgentAdapter(mutated, "hermes_local");
    expect(authority).toMatchObject({
      commandRealpath: "/tmp/policy-owned-hermes",
      commandSha256: "9".repeat(64),
      expectedVersion: "Hermes policy authority test",
    });
    const plan = planProfitFlywheelV2Agent({
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
        name: "Policy-owned engineer",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
      },
      policy: mutated,
      policyPath: loaded.path,
      policySha256: "7".repeat(64),
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
    });
    expect(plan.nextAdapterConfig).toMatchObject({
      command: "/tmp/policy-owned-hermes",
      hermesCommand: "/tmp/policy-owned-hermes",
      providerPolicy: {
        commandSha256: "9".repeat(64),
        expectedVersion: "Hermes policy authority test",
        runtimeAuthority: { authoritySha256: authority.authoritySha256 },
      },
    });

    const disagreement = structuredClone(mutated);
    const firstHermes = Object.values(disagreement.routes).find((route) => route.runtimeBinding.adapterType === "hermes_local")!;
    firstHermes.runtimeBinding.commandSha256 = "8".repeat(64);
    expect(() => providerPolicyRuntimeAuthorityForAgentAdapter(disagreement, "hermes_local"))
      .toThrow("profit_flywheel_runtime_authority_disagreement");
  });

  it("replaces verified inline credentials by name-only refs and quarantines compromised lanes", async () => {
    const loaded = await loadProviderPolicyV2();
    const companyId = "22222222-2222-4222-8222-222222222222";
    const plan = planProfitFlywheelV2Agent({
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        companyId,
        name: "Operator",
        role: "ops",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            OPENCODE_GO_API_KEY: { type: "plain", value: "never-emit-this-value" },
            MINIMAX_API_KEY: { type: "plain", value: "known-compromised-value" },
          },
        },
        runtimeConfig: {},
      },
      policy: loaded.policy,
      policyPath: loaded.path,
      policySha256: loaded.sha256,
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
      knownSecrets: new Map([[`${companyId}:OPENCODE_GO_API_KEY`, { id: "33333333-3333-4333-8333-333333333333", name: "OPENCODE_GO_API_KEY" }]]),
    });
    expect(plan.secretRefs).toEqual(["OPENCODE_GO_API_KEY"]);
    expect(plan.quarantinedSecretNames).toEqual(["MINIMAX_API_KEY"]);
    expect(plan.nextAdapterConfig.env).toEqual({
      OPENCODE_GO_API_KEY: {
        type: "secret_ref",
        secretId: "33333333-3333-4333-8333-333333333333",
        version: "latest",
      },
    });
    expect(JSON.stringify(plan)).not.toContain("never-emit-this-value");
    expect(JSON.stringify(plan)).not.toContain("known-compromised-value");
  });

  it("classifies only the named Profit Flywheel schedules", () => {
    for (const title of ["Signal Desk :: Market Sweep", "Signal Desk :: VOC Sweep"]) {
      expect(classifyProfitFlywheelRoutineTitle(title)).toBe("twice_daily_market_voc_intake");
    }
    for (const title of [
      "Profit Flywheel :: Evidence Normalization",
      "Profit Flywheel :: Commercial Validation",
      "Profit Flywheel :: Council Decision",
      "Profit Flywheel :: Dispatch Authorization",
      "Profit Flywheel :: Governed Implementation",
      "Profit Flywheel :: Independent QA",
      "Profit Flywheel :: Artifact Release",
      "Profit Flywheel :: Commercial Observation",
      "Profit Flywheel :: Learning Feedback",
      "Signal Desk :: Evidence Intake Gate",
      "Council Chamber :: Existing Venture Gate",
      "Council Chamber :: Council Triage",
      "Asset Composition Lab :: Venture Composition",
      "Venture Graduation :: Route Or Graduate",
      "Truth Boundary :: Canonical Guard",
    ]) {
      expect(classifyProfitFlywheelRoutineTitle(title)).toBe("retired_downstream_fixed_clock");
    }
    expect(classifyProfitFlywheelRoutineTitle("Database backup every 5 minutes")).toBeNull();
    expect(classifyProfitFlywheelRoutineTitle("Customer QA reminders")).toBeNull();
    expect(classifyProfitFlywheelRoutineTitle("Signal Desk :: VOC Sweep - morning")).toBeNull();
  });

  it("exposes a read-only fleet-audit operation and validates explicit audit pins", () => {
    const auditPath = "/tmp/profit-flywheel-fleet-audit.json";
    const auditSha256 = "a".repeat(64);
    expect(parseProfitFlywheelV2Args([
      "--dry-run",
      "--audit-path", auditPath,
      "--audit-sha256", auditSha256,
    ])).toMatchObject({
      apply: false,
      auditPath,
      auditSha256,
    });
    expect(parseProfitFlywheelV2Args(["--", "--generate-fleet-audit"])).toMatchObject({
      operation: "generate_fleet_audit",
      apply: false,
    });
    expect(() => parseProfitFlywheelV2Args(["--generate-fleet-audit", "--apply"]))
      .toThrow("--generate-fleet-audit is read-only; --apply is forbidden");
    expect(() => parseProfitFlywheelV2Args(["--generate-fleet-audit", "--apply", "--dry-run"]))
      .toThrow("--generate-fleet-audit is read-only; --apply is forbidden");
    expect(() => parseProfitFlywheelV2Args(["--generate-fleet-audit", "--company-id", randomUUID()]))
      .toThrow("always snapshots the complete fleet");
    expect(() => parseProfitFlywheelV2Args(["--audit-path", auditPath]))
      .toThrow("--audit-path and --audit-sha256 must be supplied together");
    expect(() => parseProfitFlywheelV2Args(["--audit-path", "relative.json", "--audit-sha256", auditSha256]))
      .toThrow("--audit-path must be absolute");
    expect(() => parseProfitFlywheelV2Args(["--apply"]))
      .toThrow("--apply requires explicit --audit-path and --audit-sha256 v4 pins");
    expect(parseProfitFlywheelV2Args([
      "--apply", "--audit-path", auditPath, "--audit-sha256", auditSha256,
    ])).toMatchObject({ apply: true, auditPath, auditSha256 });
    expect(() => parseProfitFlywheelV2Args(["--connection-string", "postgres://argv.invalid/db"]))
      .toThrow("profit_flywheel_database_url_argv_forbidden");
    expect(() => parseProfitFlywheelV2Args(["--connection-string=postgres://argv.invalid/db"]))
      .toThrow("profit_flywheel_database_url_argv_forbidden");
    expect(() => parseProfitFlywheelV2Args(["--provision-runtime", "--reconcile-stale-agents", "--company-id", randomUUID()]))
      .toThrow("Conflicting operations");
    for (const flag of [
      "--company-id", "--agent-id", "--stale-after-minutes", "--home", "--instance-id", "--receipt-dir",
      "--audit-path", "--audit-sha256",
    ]) {
      expect(() => parseProfitFlywheelV2Args([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseProfitFlywheelV2Args([flag, "--dry-run"])).toThrow(`${flag} requires a value`);
    }

    const env: NodeJS.ProcessEnv = {};
    expect(configureProfitFlywheelCliRuntimeEnvironment({
      homeDir: "/tmp/paperclip-profit-cli",
      instanceId: "fleet-audit",
    }, env)).toEqual({
      homeDir: "/tmp/paperclip-profit-cli",
      instanceId: "fleet-audit",
    });
    expect(env).toMatchObject({
      PAPERCLIP_HOME: "/tmp/paperclip-profit-cli",
      PAPERCLIP_INSTANCE_ID: "fleet-audit",
    });
    expect(() => configureProfitFlywheelCliRuntimeEnvironment({ instanceId: "../escape" }, {}))
      .toThrow("profit_flywheel_instance_id_invalid");
  });

  it("treats bare AUTH as a secret and fails closed on cross-company or revoked secret refs", async () => {
    const loaded = await loadProviderPolicyV2();
    const baseAgent = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      name: "Operator",
      role: "ops",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: { env: { AUTH: { type: "plain", value: "auth-must-never-survive" } } },
      runtimeConfig: {},
    };
    const args = {
      policy: loaded.policy,
      policyPath: loaded.path,
      policySha256: loaded.sha256,
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
    };
    const authPlan = planProfitFlywheelV2Agent({ agent: baseAgent, ...args });
    expect(authPlan.secretsToCreate).toEqual(["AUTH"]);
    expect(JSON.stringify(authPlan)).not.toContain("auth-must-never-survive");

    const secretId = "33333333-3333-4333-8333-333333333333";
    const refAgent = { ...baseAgent, adapterConfig: { env: { API_KEY: { type: "secret_ref", secretId } } } };
    expect(() => planProfitFlywheelV2Agent({
      agent: refAgent,
      ...args,
      knownSecretIds: new Map([[secretId, { id: secretId, name: "API_KEY", companyId: "44444444-4444-4444-8444-444444444444", active: true }]]),
    })).toThrow("profit_flywheel_secret_ref_invalid");
    expect(() => planProfitFlywheelV2Agent({
      agent: refAgent,
      ...args,
      knownSecretIds: new Map([[secretId, { id: secretId, name: "API_KEY", companyId: baseAgent.companyId, active: false }]]),
    })).toThrow("profit_flywheel_secret_ref_invalid");
  });

  it("tokenizes credential key names without matching harmless RootPath substrings", async () => {
    for (const key of [
      "API_KEY", "API_KEY_FILE", "apiKey", "apiKeyFile", "AUTH", "authorization", "accessToken",
      "refresh_token", "tokens", "SECRET", "password", "credential", "credentials", "cookie", "JWT",
      "clientSecret", "privateKey", "connectionString", "recoveryCode", "recoveryCodes", "verificationCode",
      "verificationToken", "phoneNumber", "MFA", "OTP", "OPENAI_APIKEY", "SERVICE_ACCESSTOKEN",
      "DB_CONNECTIONSTRING", "ConnectionStrings__Default", "DATABASE_URL", "POSTGRES_URL",
      "MONGODB_URI", "PRIMARY_DATABASE_URL", "POSTGRES_URL_NON_POOLING",
    ]) {
      expect(isSensitiveEnvKey(key), key).toBe(true);
    }
    for (const key of [
      "instructionsRootPath", "ROOT_PATH", "tokenomics", "prototype", "hotplate", "phonebook",
      "authMode", "authenticationMode", "secretary", "cookiecutter",
    ]) {
      expect(isSensitiveEnvKey(key), key).toBe(false);
    }
    expect(isSensitiveEnvBinding("API_BASE_URL", "https://api.example")).toBe(false);
    expect(isSensitiveEnvBinding("API_BASE_URL", "https://operator:credential@api.example")).toBe(true);
    expect(isSensitiveEnvBinding("DATABASE_URL", "postgres://db.example/paperclip")).toBe(true);

    const loaded = await loadProviderPolicyV2();
    const plan = planProfitFlywheelV2Agent({
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
        name: "Root path regression",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: { instructionsRootPath: "/tmp/operator/instructions-root-path" },
        runtimeConfig: {},
      },
      policy: loaded.policy,
      policyPath: loaded.path,
      policySha256: loaded.sha256,
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
    });
    expect(plan.nextAdapterConfig.instructionsRootPath).toBe("/tmp/operator/instructions-root-path");

    const databasePlan = planProfitFlywheelV2Agent({
      agent: {
        id: "33333333-3333-4333-8333-333333333333",
        companyId: "22222222-2222-4222-8222-222222222222",
        name: "Database operator",
        role: "ops",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {
          env: {
            DATABASE_URL: { type: "plain", value: "postgres://operator:credential@db.example/paperclip" },
          },
        },
        runtimeConfig: {},
      },
      policy: loaded.policy,
      policyPath: loaded.path,
      policySha256: loaded.sha256,
      policySchemaPath: loaded.schemaPath,
      policySchemaSha256: loaded.schemaSha256,
    });
    expect(databasePlan.secretsToCreate).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(databasePlan)).not.toContain("operator:credential");
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("Profit Flywheel v2 transactional fleet migration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome = "";
  let auditPath = "";
  let auditSha256 = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-migration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelMigrationRuns);
    await db.delete(profitFlywheelLeases);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agentApiKeys);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  afterAll(async () => tempDb?.cleanup());

  const readRoutineSnapshotRows = () => db.select({
    id: routineTriggers.id,
    routineId: routineTriggers.routineId,
    kind: routineTriggers.kind,
    title: routines.title,
    enabled: routineTriggers.enabled,
    cronExpression: routineTriggers.cronExpression,
    timezone: routineTriggers.timezone,
    nextRunAt: routineTriggers.nextRunAt,
    routineStatus: routines.status,
  }).from(routineTriggers).innerJoin(routines, eq(routineTriggers.routineId, routines.id));

  async function seedFixture() {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-profit-migration-home-"));
    auditPath = path.join(tempHome, "fleet-audit.json");
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Migration ${companyId.slice(0, 6)}`,
      issuePrefix: `M${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const beforeAdapterConfig = {
      tieredExecution: {
        enabled: true,
        claude_local: { authMode: "subscription" },
        gemini_local: { authMode: "SUBSCRIPTION" },
      },
      provider: "legacy",
      model: "legacy-model",
    };
    const beforeRuntimeConfig = { heartbeat: { enabled: true, intervalSec: 300 }, autonomyRecovery: { previousHeartbeat: { intervalSec: 300 } } };
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Migration Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: beforeAdapterConfig,
      runtimeConfig: beforeRuntimeConfig,
      permissions: {},
    });
    const secretId = randomUUID();
    const secretVersionId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      name: "MINIMAX_API_KEY",
      provider: "local_encrypted",
      latestVersion: 1,
    });
    await db.insert(companySecretVersions).values({
      id: secretVersionId,
      secretId,
      version: 1,
      material: { type: "test_ciphertext", ciphertext: "not-a-secret" },
      valueSha256: "a".repeat(64),
    });
    const routineFixtures = [
      { title: "Signal Desk :: Market Sweep", status: "paused", enabled: false, cronExpression: "0 1 * * *" },
      { title: "Profit Flywheel :: Independent QA", status: "active", enabled: true, cronExpression: "*/5 * * * *" },
      { title: "Unrelated database backup", status: "active", enabled: true, cronExpression: "15 2 * * *" },
    ];
    const triggerIds: string[] = [];
    const routineIds: string[] = [];
    for (const fixture of routineFixtures) {
      const routineId = randomUUID();
      const triggerId = randomUUID();
      await db.insert(routines).values({ id: routineId, companyId, title: fixture.title, status: fixture.status });
      await db.insert(routineTriggers).values({
        id: triggerId,
        companyId,
        routineId,
        kind: "schedule",
        enabled: fixture.enabled,
        cronExpression: fixture.cronExpression,
      });
      triggerIds.push(triggerId);
      routineIds.push(routineId);
    }
    const migrationOptions = {
      apply: true as const,
      backup: false,
      homeDir: tempHome,
      auditPath,
      auditSha256: "",
      now: new Date("2026-07-11T12:00:00.000Z"),
    };
    let auditSequence = 0;
    const refreshAudit = async () => {
      auditSequence += 1;
      const audit = await generateProfitFlywheelFleetAudit(db, {
        homeDir: tempHome,
        now: new Date(Date.parse("2026-07-11T11:59:00.000Z") + auditSequence),
      });
      auditPath = audit.receiptPath;
      auditSha256 = audit.receiptSha256;
      migrationOptions.auditSha256 = auditSha256;
      migrationOptions.auditPath = auditPath;
      return audit;
    };
    await refreshAudit();
    return {
      companyId,
      agentId,
      secretVersionId,
      triggerIds,
      routineIds,
      beforeAdapterConfig,
      beforeRuntimeConfig,
      migrationOptions,
      refreshAudit,
    };
  }

  it("writes a validator-compatible aggregate-only immutable fleet audit without mutating state", async () => {
    const fixture = await seedFixture();
    const sentinel = "test-only-plaintext-api-key-value-must-not-enter-fleet-audit";
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId: fixture.companyId,
        name: "Paused Codex reviewer",
        role: "reviewer",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: { env: { API_KEY: { type: "plain", value: sentinel } } },
        runtimeConfig: { heartbeat: { enabled: false } },
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId: fixture.companyId,
        name: "Retired worker",
        role: "engineer",
        status: "terminated",
        adapterType: "hermes_local",
        adapterConfig: { historical: sentinel },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const before = await db.select().from(agents);
    const audit = await fixture.refreshAudit();
    const auditBytes = await readFile(audit.receiptPath);
    const receipt = JSON.parse(auditBytes.toString("utf8"));
    const routineSnapshot = await readRoutineSnapshotRows();
    const validated = validateFleetAuditSnapshot(auditBytes, before, routineSnapshot);

    expect(validated).toMatchObject({
      strictSnapshot: true,
      allAgentRows: 3,
      terminatedRows: 1,
      liveAgentRows: 2,
      liveAdapterTypes: { codex_local: 1, hermes_local: 1 },
      liveStatuses: { idle: 1, paused: 1 },
      fleetConfigSha256: audit.fleet.fleet_config_sha256,
    });
    expect(receipt).toMatchObject({
      schema_version: "paperclip.profit_flywheel_fleet_audit.v4",
      read_only: true,
      secret_material: {
        company_secret_tables_queried: false,
        secret_provider_invoked: false,
        adapter_or_runtime_config_serialized: false,
        opaque_adapter_runtime_configs_hashed: true,
      },
      fleet: {
        all_agent_rows: 3,
        terminated_rows: 1,
        live_agent_rows: 2,
        live_adapter_types: { codex_local: 1, hermes_local: 1 },
        live_statuses: { idle: 1, paused: 1 },
        fleet_snapshot_sha256: validated.fleetSnapshotSha256,
        fleet_snapshot_hash_method: "sha256(stable_json([{id,companyId,name,role,status,adapterType,adapterConfig,runtimeConfig} all rows sorted by id]))",
        routine_rows: 3,
        classified_routine_rows: 2,
        routine_snapshot_sha256: validated.routineSnapshotSha256,
        routine_snapshot_hash_method: "sha256(stable_json([{id,routineId,kind,title,enabled,cronExpression,timezone,nextRunAt,routineStatus} sorted by id]))",
      },
    });
    expect(auditBytes.toString("utf8")).not.toContain(sentinel);
    expect(createHash("sha256").update(auditBytes).digest("hex")).toBe(audit.receiptSha256);
    expect((await stat(audit.receiptPath)).mode & 0o777).toBe(0o444);
    expect(audit.pin).toEqual({
      auditPath: audit.receiptPath,
      auditSha256: audit.receiptSha256,
      argv: ["--audit-path", audit.receiptPath, "--audit-sha256", audit.receiptSha256],
    });
    expect(await db.select().from(agents)).toEqual(before);

    const liveRows = before.filter((agent) => agent.status !== "terminated").sort((left, right) => left.id.localeCompare(right.id));
    const statusSwapped = before.map((agent) => agent.id === liveRows[0]!.id
      ? { ...agent, status: liveRows[1]!.status }
      : agent.id === liveRows[1]!.id ? { ...agent, status: liveRows[0]!.status } : agent);
    expect(() => validateFleetAuditSnapshot(auditBytes, statusSwapped, routineSnapshot))
      .toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");
    const adaptersSwapped = before.map((agent) => agent.id === liveRows[0]!.id
      ? { ...agent, adapterType: liveRows[1]!.adapterType }
      : agent.id === liveRows[1]!.id ? { ...agent, adapterType: liveRows[0]!.adapterType } : agent);
    expect(() => validateFleetAuditSnapshot(auditBytes, adaptersSwapped, routineSnapshot))
      .toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");

    for (const semanticMutation of [
      before.map((agent) => agent.id === liveRows[0]!.id ? { ...agent, name: `${agent.name} changed` } : agent),
      before.map((agent) => agent.id === liveRows[0]!.id ? { ...agent, role: "researcher" } : agent),
      before.map((agent) => agent.id === liveRows[0]!.id ? { ...agent, companyId: randomUUID() } : agent),
    ]) {
      expect(() => validateFleetAuditSnapshot(auditBytes, semanticMutation, routineSnapshot))
        .toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");
    }
    expect(() => validateFleetAuditSnapshot(auditBytes, before, routineSnapshot.map((row, index) =>
      index === 0 ? { ...row, title: "Unrelated renamed routine" } : row)))
      .toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");

    const legacyV3Receipt = structuredClone(receipt);
    legacyV3Receipt.schema_version = "paperclip.profit_flywheel_fleet_audit.v3";
    const legacyV3Projection = liveRows.map((agent) => ({
      id: agent.id,
      status: agent.status,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
      runtimeConfig: agent.runtimeConfig,
    }));
    legacyV3Receipt.fleet.fleet_snapshot_sha256 = createHash("sha256")
      .update(JSON.stringify(legacyV3Projection)).digest("hex");
    legacyV3Receipt.fleet.fleet_snapshot_hash_method =
      "sha256(JSON.stringify([{id,status,adapterType,adapterConfig,runtimeConfig} sorted by id]))";
    delete legacyV3Receipt.fleet.routine_rows;
    delete legacyV3Receipt.fleet.classified_routine_rows;
    delete legacyV3Receipt.fleet.routine_snapshot_sha256;
    delete legacyV3Receipt.fleet.routine_snapshot_hash_method;
    const legacyV3Bytes = Buffer.from(`${JSON.stringify(legacyV3Receipt)}\n`);
    expect(validateFleetAuditSnapshot(legacyV3Bytes, before).strictSnapshot).toBe(false);
    expect(() => validateFleetAuditSnapshot(legacyV3Bytes, before, [], { requireV4: true }))
      .toThrow("requires an explicit paperclip.profit_flywheel_fleet_audit.v4 receipt");

    const legacyV2Receipt = structuredClone(legacyV3Receipt);
    legacyV2Receipt.schema_version = "paperclip.profit_flywheel_fleet_audit.v2";
    delete legacyV2Receipt.fleet.fleet_snapshot_sha256;
    delete legacyV2Receipt.fleet.fleet_snapshot_hash_method;
    expect(validateFleetAuditSnapshot(
      Buffer.from(`${JSON.stringify(legacyV2Receipt)}\n`),
      before,
    ).strictSnapshot).toBe(false);

    await expect(generateProfitFlywheelFleetAudit(db, {
      homeDir: tempHome,
      now: new Date(audit.observed_at),
    })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(generateProfitFlywheelFleetAudit(db, {
      homeDir: tempHome,
      receiptDir: "../../escape",
    })).rejects.toThrow("profit_flywheel_receipt_dir_must_be_instance_relative");
  });

  it("records immutable intent, applies only classified schedules, revokes compromised credentials, and rolls back exactly", async () => {
    const fixture = await seedFixture();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    expect(applied.status).toBe("OK");
    expect(applied.receiptPath).toContain("apply-intent");
    expect(createHash("sha256").update(await readFile(applied.receiptPath)).digest("hex")).toBe(applied.receiptSha256);
    expect((await stat(applied.receiptPath)).mode & 0o777).toBe(0o444);

    const migrationRow = await db.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, applied.migrationRunId)).then((rows) => rows[0]!);
    expect(migrationRow.state).toBe("applied");
    expect(migrationRow.intentReceiptSha256).toBe(applied.receiptSha256);
    const migratedAgent = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(migratedAgent.adapterConfig).not.toHaveProperty("tieredExecution");
    expect(migratedAgent.runtimeConfig.heartbeat).toMatchObject({ enabled: false, intervalSec: 0, maxConcurrentRuns: 1, triggerMode: "event_only" });
    const triggersAfter = await db.select().from(routineTriggers);
    expect(triggersAfter.find((row) => row.id === fixture.triggerIds[0])).toMatchObject({ enabled: true, cronExpression: "30 8,17 * * *", timezone: "America/New_York" });
    expect(triggersAfter.find((row) => row.id === fixture.triggerIds[0])?.nextRunAt?.getTime()).toBeGreaterThan(fixture.migrationOptions.now.getTime());
    expect(triggersAfter.find((row) => row.id === fixture.triggerIds[1])).toMatchObject({ enabled: false, cronExpression: "*/5 * * * *", nextRunAt: null });
    expect(triggersAfter.find((row) => row.id === fixture.triggerIds[2])).toMatchObject({ enabled: true, cronExpression: "15 2 * * *" });
    expect(await db.select().from(routines).where(eq(routines.id, fixture.routineIds[0])).then((rows) => rows[0]!.status)).toBe("active");
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.id, fixture.secretVersionId)).then((rows) => rows[0]!.revokedAt)).toEqual(fixture.migrationOptions.now);

    const replayed = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    expect(replayed).toMatchObject({
      migrationRunId: applied.migrationRunId,
      idempotent: true,
      reconciled: true,
      receiptSha256: applied.receiptSha256,
    });
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(1);

    const rolledBack = await rollbackProfitFlywheelV2Migration(db, {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:05:00.000Z"),
    });
    expect(rolledBack.state).toBe("rolled_back");
    const restoredAgent = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(restoredAgent.adapterConfig).toEqual(fixture.beforeAdapterConfig);
    expect(restoredAgent.runtimeConfig).toEqual(fixture.beforeRuntimeConfig);
    const triggersRestored = await db.select().from(routineTriggers);
    expect(triggersRestored.find((row) => row.id === fixture.triggerIds[0])).toMatchObject({ enabled: false, cronExpression: "0 1 * * *" });
    expect(triggersRestored.find((row) => row.id === fixture.triggerIds[1])).toMatchObject({ enabled: true, cronExpression: "*/5 * * * *" });
    expect(triggersRestored.find((row) => row.id === fixture.triggerIds[2])).toMatchObject({ enabled: true, cronExpression: "15 2 * * *" });
    expect(await db.select().from(routines).where(eq(routines.id, fixture.routineIds[0])).then((rows) => rows[0]!.status)).toBe("paused");
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.id, fixture.secretVersionId)).then((rows) => rows[0]!.revokedAt)).toEqual(fixture.migrationOptions.now);
    expect(await rollbackProfitFlywheelV2Migration(db, {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:06:00.000Z"),
    })).toMatchObject({ state: "rolled_back", idempotent: true });
  });

  it("rolls every mutation back when apply crashes after mutation and leaves only the prewritten intent", async () => {
    const fixture = await seedFixture();
    await expect(migrateProfitFlywheelV2(db, {
      ...fixture.migrationOptions,
      testHooks: { afterMutationsBeforeCommit: () => { throw new Error("injected_crash_after_mutation"); } },
    })).rejects.toThrow("injected_crash_after_mutation");
    const restoredAgent = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(restoredAgent.adapterConfig).toEqual(fixture.beforeAdapterConfig);
    expect(restoredAgent.runtimeConfig).toEqual(fixture.beforeRuntimeConfig);
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.id, fixture.secretVersionId)).then((rows) => rows[0]!.revokedAt)).toBeNull();
    const receiptDir = path.join(tempHome, "instances", "default", "data/ops/flywheel-repair/runs");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(receiptDir));
    expect(entries.filter((name) => name.endsWith("apply-intent.json"))).toHaveLength(1);
    const intentPath = path.join(receiptDir, entries.find((name) => name.endsWith("apply-intent.json"))!);
    const tampered = JSON.parse(await readFile(intentPath, "utf8"));
    tampered.unapproved_extra_field = true;
    await chmod(intentPath, 0o644);
    await writeFile(intentPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await chmod(intentPath, 0o444);
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions))
      .rejects.toThrow("does not exactly match the deterministic plan");
  });

  it("revalidates immutable intent file type, mode, symlink safety, and row semantics on replay", async () => {
    const fixture = await seedFixture();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    const row = await db.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, applied.migrationRunId)).then((rows) => rows[0]!);

    await chmod(applied.receiptPath, 0o644);
    await expect(validateCommittedMigrationIntentReceipt(row))
      .rejects.toThrow("not an immutable regular file");
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions))
      .rejects.toThrow("not an immutable regular file");
    await chmod(applied.receiptPath, 0o444);

    const targetPath = `${applied.receiptPath}.immutable-target`;
    await rename(applied.receiptPath, targetPath);
    await symlink(targetPath, applied.receiptPath);
    await expect(validateCommittedMigrationIntentReceipt(row))
      .rejects.toThrow("not an immutable regular file");
    await rm(applied.receiptPath);
    await rename(targetPath, applied.receiptPath);

    await expect(validateCommittedMigrationIntentReceipt({
      ...row,
      providerPolicySha256: "f".repeat(64),
    })).rejects.toThrow("semantics do not match the committed database row");
    await expect(validateCommittedMigrationIntentReceipt(row)).resolves.toMatchObject({
      path: applied.receiptPath,
      sha256: applied.receiptSha256,
    });
  });

  it("coalesces concurrent same-plan apply calls onto one committed migration run", async () => {
    const fixture = await seedFixture();
    const [left, right] = await Promise.all([
      migrateProfitFlywheelV2(db, fixture.migrationOptions),
      migrateProfitFlywheelV2(db, fixture.migrationOptions),
    ]);
    expect(left.migrationRunId).toBe(right.migrationRunId);
    expect(left.receiptPath).toBe(right.receiptPath);
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(1);
    expect([left.idempotent, right.idempotent]).toContain(true);
    const receiptDir = path.join(tempHome, "instances", "default", "data/ops/flywheel-repair/runs");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(receiptDir));
    expect(entries.filter((name) => name.endsWith("apply-intent.json"))).toEqual([
      path.basename(left.receiptPath),
    ]);
  });

  it("rechecks active work inside apply and rollback transactions and coalesces concurrent rollback", async () => {
    const applyRace = await seedFixture();
    await expect(migrateProfitFlywheelV2(db, {
      ...applyRace.migrationOptions,
      testHooks: {
        beforeTransactionSafetyCheck: async () => {
          await db.update(agents).set({ status: "running" }).where(eq(agents.id, applyRace.agentId));
        },
      },
    })).rejects.toThrow(`agent_status:${applyRace.agentId}`);
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);
    expect(await db.select().from(agents).where(eq(agents.id, applyRace.agentId)).then((rows) => rows[0]!.adapterConfig))
      .toEqual(applyRace.beforeAdapterConfig);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, applyRace.agentId));

    const applied = await migrateProfitFlywheelV2(db, applyRace.migrationOptions);
    await expect(rollbackProfitFlywheelV2Migration(db, {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:05:00.000Z"),
      testHooks: {
        beforeTransactionSafetyCheck: async () => {
          await db.update(agents).set({ status: "running" }).where(eq(agents.id, applyRace.agentId));
        },
      },
    })).rejects.toThrow(`agent_status:${applyRace.agentId}`);
    expect(await db.select().from(profitFlywheelMigrationRuns).then((rows) => rows[0]!.state)).toBe("applied");
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, applyRace.agentId));
    const rollbackOptions = {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:06:00.000Z"),
    };
    const [left, right] = await Promise.all([
      rollbackProfitFlywheelV2Migration(db, rollbackOptions),
      rollbackProfitFlywheelV2Migration(db, rollbackOptions),
    ]);
    expect([left.idempotent, right.idempotent].sort()).toEqual([false, true]);
    expect(left.receiptPath).toBe(right.receiptPath);
    const receiptDir = path.join(tempHome, "instances", "default", "data/ops/flywheel-repair/runs");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(receiptDir));
    expect(entries.filter((name) => name.endsWith("rollback-intent.json"))).toHaveLength(1);
  });

  it("rejects plan-semantic agent drift before cutover and reports post-apply adapter drift instead of false success", async () => {
    const fixture = await seedFixture();
    await expect(migrateProfitFlywheelV2(db, {
      ...fixture.migrationOptions,
      testHooks: {
        beforeTransactionSafetyCheck: async () => {
          await db.update(agents).set({
            name: "Changed orchestrator identity",
            role: "researcher",
            adapterType: "codex_local",
          }).where(eq(agents.id, fixture.agentId));
        },
      },
    })).rejects.toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);

    await db.update(agents).set({
      name: "Migration Engineer",
      role: "engineer",
      adapterType: "hermes_local",
    }).where(eq(agents.id, fixture.agentId));
    await fixture.refreshAudit();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.agentId));
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions)).resolves.toMatchObject({
      migrationRunId: applied.migrationRunId,
      idempotent: true,
      reconciled: true,
    });
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, fixture.agentId));
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions))
      .rejects.toThrow("canonical post-migration fleet, schedules, or security revocations have drifted");
    await db.update(agents).set({ adapterType: "hermes_local", status: "terminated" })
      .where(eq(agents.id, fixture.agentId));
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions))
      .rejects.toThrow("canonical post-migration fleet, schedules, or security revocations have drifted");
    expect(await db.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, applied.migrationRunId))).toHaveLength(1);
  });

  it("rejects routine title, kind, and trigger-to-routine link drift under the cutover lock", async () => {
    const fixture = await seedFixture();
    await expect(migrateProfitFlywheelV2(db, {
      ...fixture.migrationOptions,
      testHooks: {
        beforeTransactionSafetyCheck: async () => {
          await db.update(routines).set({ title: "Renamed unrelated routine" })
            .where(eq(routines.id, fixture.routineIds[0]!));
          await db.update(routineTriggers).set({ kind: "event" })
            .where(eq(routineTriggers.id, fixture.triggerIds[1]!));
          await db.update(routineTriggers).set({ routineId: fixture.routineIds[0]! })
            .where(eq(routineTriggers.id, fixture.triggerIds[2]!));
        },
      },
    })).rejects.toThrow("Live fleet audit counts, adapter membership, or exact config hash differ");
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);
  });

  it("reconciles canonical intake advancement but rejects structural routine cron drift", async () => {
    const fixture = await seedFixture();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-07-11T21:30:00.000Z") })
      .where(eq(routineTriggers.id, fixture.triggerIds[0]!));
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions)).resolves.toMatchObject({
      migrationRunId: applied.migrationRunId,
      idempotent: true,
      reconciled: true,
    });

    await db.update(routineTriggers).set({ cronExpression: "0 0 * * *" })
      .where(eq(routineTriggers.id, fixture.triggerIds[0]!));
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions))
      .rejects.toThrow("canonical post-migration fleet, schedules, or security revocations have drifted");
  });

  it("holds a table-level cutover lock so a new lease cannot appear after the transactional safety query", async () => {
    const fixture = await seedFixture();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: fixture.companyId, name: "Cutover lock fixture" });
    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId: fixture.companyId,
      projectId,
      runId: `lock-${randomUUID()}`,
      state: "running",
      currentStage: "implementation",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/lock-dispatch.json",
      sourceDispatchHash: "d".repeat(64),
      targetRepo: "fixture/profit-flywheel",
      targetWorkspaceRoot: "/tmp",
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: "c".repeat(64),
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId: `profit:${randomUUID()}`,
      traceId: "a".repeat(32),
    }).returning().then((rows) => rows[0]!);
    const stage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: workflow.id,
      companyId: fixture.companyId,
      stage: "implementation",
      state: "pending",
      ownerPlane: "paperclip",
      inputSchemaVersion: "paperclip.stage_input.v2",
      inputHash: "b".repeat(64),
      sourceHashes: { dispatch_hash: "d".repeat(64) },
      idempotencyKey: `${fixture.companyId}:${workflow.runId}:implementation:${"b".repeat(64)}`,
      maxAttempts: 2,
      providerCapabilityClass: "code_deep",
      concurrencyKey: `repo:${workflow.id}`,
      concurrencyLimit: 1,
      requiredReceipts: ["implementation_receipt"],
      completionEvidence: ["artifact_hash"],
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: "c".repeat(16),
    }).returning().then((rows) => rows[0]!);
    let insertSettled = false;
    let leaseInsert: Promise<unknown> | null = null;
    await migrateProfitFlywheelV2(db, {
      ...fixture.migrationOptions,
      testHooks: {
        afterTransactionSafetyLock: async () => {
          leaseInsert = db.insert(profitFlywheelLeases).values({
            companyId: fixture.companyId,
            stageRunId: stage.id,
            scopeType: "stage",
            scopeKey: `stage:${stage.id}`,
            slot: 0,
            leaseOwner: "concurrent-worker",
            expiresAt: new Date(Date.now() + 60_000),
          }).then(() => { insertSettled = true; });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(insertSettled).toBe(false);
        },
      },
    });
    await leaseInsert;
    expect(insertSettled).toBe(true);
  });

  it("fails closed before mutation when a credential has not been securely pre-seeded", async () => {
    const fixture = await seedFixture();
    await db.update(agents).set({
      adapterConfig: { env: { OPENCODE_GO_API_KEY: { type: "plain", value: "secret-value-that-must-not-migrate" } } },
    }).where(eq(agents.id, fixture.agentId));
    await fixture.refreshAudit();
    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions)).rejects.toThrow("profit_flywheel_secure_secret_preseed_required: OPENCODE_GO_API_KEY");
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.name, "OPENCODE_GO_API_KEY"))).toHaveLength(0);
  });

  it("allows only explicit non-secret auth-mode metadata in rollback state", async () => {
    const fixture = await seedFixture();
    await db.update(agents).set({
      adapterConfig: { tieredExecution: { claude_local: { authMode: "unexpected-mode" } } },
    }).where(eq(agents.id, fixture.agentId));
    await fixture.refreshAudit();

    await expect(migrateProfitFlywheelV2(db, fixture.migrationOptions)).rejects.toThrow(
      "Rollback adapter snapshot contains credential-shaped values at tieredExecution.claude_local.authMode",
    );
    expect(await db.select().from(profitFlywheelMigrationRuns)).toHaveLength(0);
  });

  it("stores only encrypted secret references in durable rollback state and never persists the inline sentinel", async () => {
    const fixture = await seedFixture();
    const sentinel = "SENTINEL_DO_NOT_PERSIST_7BFEA9";
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId: fixture.companyId,
      name: "OPENCODE_GO_API_KEY",
      provider: "local_encrypted",
      latestVersion: 1,
    });
    await db.insert(companySecretVersions).values({
      secretId,
      version: 1,
      material: { type: "test_ciphertext", ciphertext: "opaque" },
      valueSha256: "b".repeat(64),
    });
    await db.update(agents).set({
      adapterConfig: {
        tieredExecution: { enabled: true },
        env: { OPENCODE_GO_API_KEY: { type: "plain", value: sentinel } },
      },
    }).where(eq(agents.id, fixture.agentId));
    await fixture.refreshAudit();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    const row = await db.select().from(profitFlywheelMigrationRuns)
      .where(eq(profitFlywheelMigrationRuns.id, applied.migrationRunId)).then((rows) => rows[0]!);
    expect(JSON.stringify(row)).not.toContain(sentinel);
    expect((await readFile(applied.receiptPath, "utf8"))).not.toContain(sentinel);
    expect(JSON.stringify(row.rollbackSnapshot)).toContain(secretId);
    await rollbackProfitFlywheelV2Migration(db, {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:05:00.000Z"),
    });
    const restored = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(JSON.stringify(restored.adapterConfig)).not.toContain(sentinel);
    expect(restored.adapterConfig.env).toEqual({
      OPENCODE_GO_API_KEY: { type: "secret_ref", secretId, version: "latest" },
    });
  });

  it("consumes every pinned POS plane secret inventory and preserves four distinct refs through rollback", async () => {
    const fixture = await seedFixture();
    await db.update(agents).set({ name: "Portfolio OS Orchestrator" }).where(eq(agents.id, fixture.agentId));
    const apiSecretId = randomUUID();
    const returnJournalSecretId = randomUUID();
    const researchJournalSecretId = randomUUID();
    const stageJournalSecretId = randomUUID();
    await db.insert(companySecrets).values([
      { id: apiSecretId, companyId: fixture.companyId, name: "PAPERCLIP_API_KEY", provider: "local_encrypted", latestVersion: 1 },
      { id: returnJournalSecretId, companyId: fixture.companyId, name: "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY", provider: "local_encrypted", latestVersion: 1 },
      { id: researchJournalSecretId, companyId: fixture.companyId, name: "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY", provider: "local_encrypted", latestVersion: 1 },
      { id: stageJournalSecretId, companyId: fixture.companyId, name: "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY", provider: "local_encrypted", latestVersion: 1 },
    ]);
    await db.insert(companySecretVersions).values([
      { secretId: apiSecretId, version: 1, material: { type: "test_ciphertext", ciphertext: "api" }, valueSha256: "1".repeat(64) },
      { secretId: returnJournalSecretId, version: 1, material: { type: "test_ciphertext", ciphertext: "return-journal" }, valueSha256: "2".repeat(64) },
      { secretId: researchJournalSecretId, version: 1, material: { type: "test_ciphertext", ciphertext: "research-journal" }, valueSha256: "3".repeat(64) },
      { secretId: stageJournalSecretId, version: 1, material: { type: "test_ciphertext", ciphertext: "stage-journal" }, valueSha256: "4".repeat(64) },
    ]);
    await fixture.refreshAudit();
    const applied = await migrateProfitFlywheelV2(db, fixture.migrationOptions);
    const migrated = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(migrated.adapterConfig.env).toMatchObject({
      PAPERCLIP_API_KEY: { type: "secret_ref", secretId: apiSecretId, version: "latest" },
      PAPERCLIP_RETURN_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: returnJournalSecretId, version: "latest" },
      PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: researchJournalSecretId, version: "latest" },
      PAPERCLIP_STAGE_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: stageJournalSecretId, version: "latest" },
    });
    const row = await db.select().from(profitFlywheelMigrationRuns).where(eq(profitFlywheelMigrationRuns.id, applied.migrationRunId)).then((rows) => rows[0]!);
    expect(JSON.stringify(row)).not.toContain("test_ciphertext");
    await rollbackProfitFlywheelV2Migration(db, {
      migrationRunId: applied.migrationRunId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:05:00.000Z"),
    });
    const restored = await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!);
    expect(restored.adapterConfig.env).toMatchObject({
      PAPERCLIP_API_KEY: { type: "secret_ref", secretId: apiSecretId, version: "latest" },
      PAPERCLIP_RETURN_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: returnJournalSecretId, version: "latest" },
      PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: researchJournalSecretId, version: "latest" },
      PAPERCLIP_STAGE_PLANE_JOURNAL_KEY: { type: "secret_ref", secretId: stageJournalSecretId, version: "latest" },
    });
  });

  it("provisions exactly one event-only executor and four pairwise-distinct encrypted runtime credentials without plaintext receipts", async () => {
    const fixture = await seedFixture();
    const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    try {
      const dryRun = await provisionProfitFlywheelRuntimeIdentity(db, {
        companyId: fixture.companyId,
        apply: false,
        homeDir: tempHome,
        now: new Date("2026-07-11T12:00:00.000Z"),
      });
      expect(dryRun).toMatchObject({ mode: "dry_run", status: "changes_required", plaintextValuesRecorded: false });
      expect(await db.select().from(agents).where(eq(agents.companyId, fixture.companyId))).toHaveLength(1);

      const applied = await provisionProfitFlywheelRuntimeIdentity(db, {
        companyId: fixture.companyId,
        apply: true,
        homeDir: tempHome,
        now: new Date("2026-07-11T12:01:00.000Z"),
      });
      const executors = await db.select().from(agents).where(eq(agents.companyId, fixture.companyId))
        .then((rows) => rows.filter((row) => row.name === "Portfolio OS Orchestrator" && row.status !== "terminated"));
      expect(executors).toHaveLength(1);
      expect(executors[0]).toMatchObject({
        role: "operator",
        adapterType: "hermes_local",
        permissions: { canCreateAgents: false },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, maxConcurrentRuns: 1, triggerMode: "event_only" } },
      });

      const runtimeSecrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, fixture.companyId))
        .then((rows) => rows.filter((row) => [
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY",
          "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY",
          "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY",
        ].includes(row.name)));
      expect(runtimeSecrets).toHaveLength(4);
      expect(runtimeSecrets.every((secret) => secret.provider === "local_encrypted")).toBe(true);
      const versions = await db.select().from(companySecretVersions)
        .then((rows) => rows.filter((row) => runtimeSecrets.some((secret) => secret.id === row.secretId)));
      expect(versions).toHaveLength(4);
      expect(new Set(versions.map((version) => version.valueSha256)).size).toBe(4);
      expect(versions.every((version) => asRecordForTest(version.material).scheme === "local_encrypted_v1")).toBe(true);

      const resolvedValues = await Promise.all(runtimeSecrets.map((secret) =>
        secretService(db).resolveSecretValue(fixture.companyId, secret.id, "latest")));
      const apiToken = resolvedValues[runtimeSecrets.findIndex((secret) => secret.name === "PAPERCLIP_API_KEY")]!;
      expect(apiToken.startsWith("pcp_")).toBe(true);
      expect(new Set(resolvedValues).size).toBe(4);
      const receiptBytes = await readFile(String(applied.receiptPath), "utf8");
      expect((await stat(String(applied.receiptPath))).mode & 0o777).toBe(0o444);
      expect(receiptBytes).not.toContain("pcp_");
      expect(receiptBytes).not.toContain("ciphertext");
      for (const value of resolvedValues) expect(receiptBytes).not.toContain(value);

      const firstSecretIds = runtimeSecrets.map((secret) => secret.id).sort();
      const replayed = await provisionProfitFlywheelRuntimeIdentity(db, {
        companyId: fixture.companyId,
        apply: true,
        homeDir: tempHome,
        now: new Date("2026-07-11T12:02:00.000Z"),
      });
      expect(replayed).toMatchObject({ status: "OK", executor: { id: executors[0]!.id, created: false } });
      expect(await db.select().from(agents).where(eq(agents.companyId, fixture.companyId))
        .then((rows) => rows.filter((row) => row.name === "Portfolio OS Orchestrator" && row.status !== "terminated"))).toHaveLength(1);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, fixture.companyId))
        .then((rows) => rows.filter((row) => firstSecretIds.includes(row.id)).map((row) => row.id).sort())).toEqual(firstSecretIds);
      const activeKeys = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, executors[0]!.id))
        .then((rows) => rows.filter((row) => row.revokedAt === null));
      expect(activeKeys).toHaveLength(1);
      expect(activeKeys[0]!.keyHash).toBe(versions.find((version) =>
        version.secretId === runtimeSecrets.find((secret) => secret.name === "PAPERCLIP_API_KEY")!.id)!.valueSha256);
    } finally {
      if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
  });

  it("reconciles a stale running marker only under a no-work lock and updated_at CAS", async () => {
    const fixture = await seedFixture();
    const staleAt = new Date("2026-07-11T10:00:00.000Z");
    await db.update(agents).set({
      name: "Chief Executive Officer",
      role: "ceo",
      status: "running",
      updatedAt: staleAt,
    }).where(eq(agents.id, fixture.agentId));

    const dryRun = await reconcileStaleProfitFlywheelAgents(db, {
      apply: false,
      agentId: fixture.agentId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });
    expect(dryRun).toMatchObject({
      mode: "dry_run",
      status: "OK",
      candidateCount: 1,
      reconciledCount: 0,
      results: [{ agentId: fixture.agentId, state: "eligible", blockers: [] }],
    });
    expect(await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!.status)).toBe("running");

    const applied = await reconcileStaleProfitFlywheelAgents(db, {
      apply: true,
      agentId: fixture.agentId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:01:00.000Z"),
    });
    expect(applied).toMatchObject({ status: "OK", reconciledCount: 1, results: [{ state: "reconciled_idle" }] });
    expect((await stat(String(applied.receiptPath))).mode & 0o777).toBe(0o444);
    expect(await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!.status)).toBe("idle");

    await db.update(agents).set({ status: "running", updatedAt: staleAt }).where(eq(agents.id, fixture.agentId));
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "queued",
      invocationSource: "assignment",
    });
    const blocked = await reconcileStaleProfitFlywheelAgents(db, {
      apply: true,
      agentId: fixture.agentId,
      homeDir: tempHome,
      now: new Date("2026-07-11T12:02:00.000Z"),
    });
    expect(blocked).toMatchObject({
      status: "BLOCKED",
      reconciledCount: 0,
      results: [{ state: "blocked_active_work", blockers: [`heartbeat_run:${activeRunId}:queued`] }],
    });
    expect(await db.select().from(agents).where(eq(agents.id, fixture.agentId)).then((rows) => rows[0]!.status)).toBe("running");
  });
});

function asRecordForTest(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
