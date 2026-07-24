import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  applyProfitFlywheelStaleCanaryRetirement,
  parseStaleCanaryRetirementCliArgs,
  planProfitFlywheelStaleCanaryRetirement,
  resolveEmbeddedStaleCanaryRetirementConnection,
} from "../ops/profit-flywheel-stale-canary-retirement.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import { hashProfitFlywheelValue, profitFlywheelDispatchIssueIdentity } from "../services/profit-flywheel.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Retirement's own state-machine tests do not need to reconstruct a complete
// multi-stage canary. Mock only that external verifier at the module boundary;
// production code has no injectable verifier/bypass, and the dedicated test
// below imports it unmocked to prove a synthetic closeout cannot authorize.
vi.mock("../ops/profit-flywheel-canary-closeout.js", async () => ({
  buildProfitFlywheelCanaryCloseout: async (_db: unknown, closeout: { receiptDir: string; runId: string }) => {
    const [{ readFile: readReceipt }, pathModule, crypto] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:crypto"),
    ]);
    const receiptPath = pathModule.join(closeout.receiptDir, `${closeout.runId}-canary-closeout.json`);
    const bytes = await readReceipt(receiptPath);
    return {
      status: "closed_next_research_pending" as const,
      receiptPath,
      receiptSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      receipt: JSON.parse(bytes.toString("utf8")),
    };
  },
}));

const COMPANY_ID = "216897d4-0f94-4736-9b6b-a20c8e48d694";
const CUTOFF_AT = "2026-07-20T00:00:00.000Z";
const RETIREMENT_AT = new Date("2026-07-24T12:00:00.000Z");
const HASH = (value: string) => value.repeat(64).slice(0, 64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const RETIREMENT_SCHEMA_PATH = fileURLToPath(
  new URL("../../../contracts/profit-flywheel/stale-canary-retirement.v1.schema.json", import.meta.url),
);

describe("stale fixture-canary retirement CLI boundary", () => {
  it("pins the immutable receipt schema used by plan, intent, and result artifacts", async () => {
    const bytes = await readFile(RETIREMENT_SCHEMA_PATH);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("d3456f9845fbff9c9568b43f553c071219e8b5f692c109f23a87cf2b22083ba6");
    const schema = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(schema.$id).toBe("https://paperclip.ai/contracts/profit-flywheel/stale-canary-retirement.v1.schema.json");
    expect(schema.oneOf).toHaveLength(3);
  });

  it("rejects credential-shaped argv and only accepts an embedded selected instance", () => {
    expect(() => parseStaleCanaryRetirementCliArgs(["plan"], {
      DATABASE_URL: "postgres://operator:secret@127.0.0.1/paperclip",
    })).toThrow("profit_canary_retirement_database_url_forbidden");
    expect(() => parseStaleCanaryRetirementCliArgs([
      "plan", "--company-id", COMPANY_ID, "--cutoff-at", CUTOFF_AT,
      "--replacement-closeout", "/safe/closeout.json", "--replacement-closeout-sha256", HASH("a"),
      "--receipt-dir", "/safe", "--api-key", "secret",
    ], {})).toThrow("profit_canary_retirement_credential_argv_forbidden");
    expect(resolveEmbeddedStaleCanaryRetirementConnection({
      databaseMode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    })).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
    expect(() => resolveEmbeddedStaleCanaryRetirementConnection({
      databaseMode: "postgres",
      embeddedPostgresPort: 54329,
    })).toThrow("profit_canary_retirement_embedded_instance_required");
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("stale fixture-canary retirement operator", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-canary-retirement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelLeases);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function rootDirectory() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-stale-canary-retirement-")));
    const receiptDir = path.join(root, "receipts");
    await mkdir(receiptDir, { mode: 0o700 });
    await chmod(receiptDir, 0o700);
    roots.push(root);
    return { root, receiptDir };
  }

  async function seed(options: { unsafeRunning?: boolean; manualTerminal?: boolean } = {}) {
    const loaded = await loadProfitFlywheelContract();
    const dirs = await rootDirectory();
    const projectId = randomUUID();
    const replacementProjectId = randomUUID();
    const oldWorkflowId = randomUUID();
    const replacementWorkflowId = randomUUID();
    const replacementIssueId = randomUUID();
    const oldRunId = `fixture-old-${randomUUID()}`;
    const replacementRunId = `fixture-replacement-${randomUUID()}`;
    const oldCorrelationId = `profit-canary:${oldRunId}`;
    const replacementCorrelationId = `profit-canary:${replacementRunId}`;
    const oldTraceId = HASH("1").slice(0, 32);
    const replacementTraceId = HASH("2").slice(0, 32);
    const oldCreatedAt = new Date("2026-07-01T12:00:00.000Z");
    const replacementCreatedAt = new Date("2026-07-23T12:00:00.000Z");
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Stale canary retirement test company",
      issuePrefix: "SCR",
    });
    await db.insert(projects).values([
      { id: projectId, companyId: COMPANY_ID, name: "Old fixture canary" },
      { id: replacementProjectId, companyId: COMPANY_ID, name: "Replacement fixture canary" },
    ]);
    await db.insert(issues).values({
      id: replacementIssueId,
      companyId: COMPANY_ID,
      projectId: replacementProjectId,
      title: "Replacement fixture canary completed",
      status: "done",
      completedAt: replacementCreatedAt,
    });
    await db.insert(profitFlywheelWorkflows).values({
      id: replacementWorkflowId,
      companyId: COMPANY_ID,
      projectId: replacementProjectId,
      runId: replacementRunId,
      state: "running",
      currentStage: "research_intake",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/fixture/replacement-dispatch.json",
      sourceDispatchHash: HASH("d"),
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: "/fixture/replacement-workspace",
      contractPath: loaded.path,
      contractSha256: loaded.sha256,
      contractSnapshot: loaded.contract as unknown as Record<string, unknown>,
      correlationId: replacementCorrelationId,
      traceId: replacementTraceId,
      feedback: {},
      createdAt: replacementCreatedAt,
      updatedAt: replacementCreatedAt,
    });
    const closeoutStageIds = {
      implementation: randomUUID(),
      qa: randomUUID(),
      release: randomUUID(),
      commercialObservation: randomUUID(),
      learning: randomUUID(),
      nextResearch: randomUUID(),
    };
    const closeoutPath = path.join(dirs.receiptDir, `${replacementRunId}-canary-closeout.json`);
    const closeoutSha256 = await writeImmutableJsonReceipt(closeoutPath, {
      schema_version: "paperclip.profit_flywheel_canary_closeout.v1",
      outcome: "work_bearing_cycle_closed_next_research_pending",
      expected_control_plane_state: {
        workflow_state: "running",
        current_stage: "research_intake",
      },
      identity: {
        company_id: COMPANY_ID,
        run_id: replacementRunId,
        correlation_id: replacementCorrelationId,
        project_id: replacementProjectId,
        workflow_id: replacementWorkflowId,
        issue_id: replacementIssueId,
        trace_id: replacementTraceId,
        target_repo: "fixture/profit-canary",
        target_workspace_root: "/fixture/replacement-workspace",
      },
      authority_baseline: {
        setup_receipt: { path: path.join(dirs.receiptDir, "replacement-setup.json"), sha256: HASH("5") },
        promotion_aggregate_receipt: { path: path.join(dirs.receiptDir, "replacement-promotion.json"), sha256: HASH("6") },
      },
      stages: {
        implementation: { id: closeoutStageIds.implementation },
        qa: { id: closeoutStageIds.qa },
        release: { id: closeoutStageIds.release },
        commercial_observation: { id: closeoutStageIds.commercialObservation },
        learning: { id: closeoutStageIds.learning },
        next_research_intake: { id: closeoutStageIds.nextResearch },
      },
      generated_at: "2026-07-23T12:00:00.000Z",
      database_snapshot: { isolation_level: "serializable", access_mode: "read only" },
      read_only_database_audit: true,
      immutable: true,
    });
    await db.insert(profitFlywheelWorkflows).values({
      id: oldWorkflowId,
      companyId: COMPANY_ID,
      projectId,
      runId: oldRunId,
      state: "blocked",
      currentStage: "dispatch",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/fixture/old-dispatch.json",
      sourceDispatchHash: HASH("e"),
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: "/fixture/old-workspace",
      contractPath: loaded.path,
      contractSha256: loaded.sha256,
      contractSnapshot: loaded.contract as unknown as Record<string, unknown>,
      correlationId: oldCorrelationId,
      traceId: oldTraceId,
      feedback: { historical_receipts_preserved: true },
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
    });

    const dispatchStageId = randomUUID();
    const implementationStageId = randomUUID();
    const researchStageId = randomUUID();
    const dispatchInputHash = HASH("a");
    const implementationInputHash = HASH("b");
    const deterministicIdentity = profitFlywheelDispatchIssueIdentity({
      companyId: COMPANY_ID,
      workflowId: oldWorkflowId,
      stageRunId: dispatchStageId,
      inputHash: dispatchInputHash,
    });
    const deterministicIssueId = randomUUID();
    const manualIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: deterministicIssueId,
        companyId: COMPANY_ID,
        projectId,
        title: "Fixture dispatch to retire",
        description: `Fixture operator identity ${deterministicIdentity.description_marker}`,
        status: "todo",
        originKind: deterministicIdentity.origin_kind,
        originId: deterministicIdentity.origin_id,
        originRunId: oldRunId,
      },
      {
        id: manualIssueId,
        companyId: COMPANY_ID,
        projectId,
        title: "Manual issue must remain",
        description: "Not a deterministic Paperclip fixture issue",
        status: options.manualTerminal ? "cancelled" : "todo",
        cancelledAt: options.manualTerminal ? oldCreatedAt : null,
        originKind: "manual",
      },
    ]);
    const insertStage = async (input: {
      id: string;
      stage: "research_intake" | "dispatch" | "implementation";
      state: "succeeded" | "blocked" | "retry" | "running";
      inputHash: string;
      linkedIssueId?: string | null;
      updatedAt?: Date;
      lease?: boolean;
    }) => db.insert(profitFlywheelStageRuns).values({
      id: input.id,
      workflowId: oldWorkflowId,
      companyId: COMPANY_ID,
      stage: input.stage,
      state: input.state,
      ownerPlane: loaded.contract.stages[input.stage].owner_plane,
      inputSchemaVersion: loaded.contract.stages[input.stage].input_schema,
      inputHash: input.inputHash,
      sourceHashes: { fixture: HASH(input.stage.slice(0, 1)) },
      idempotencyKey: `${oldRunId}:${input.stage}:${input.inputHash}`,
      attemptCount: input.state === "succeeded" ? 1 : 0,
      maxAttempts: Math.max(1, loaded.contract.stages[input.stage].retry.limit + 1),
      retryAt: input.state === "retry" ? new Date("2026-07-02T00:00:00.000Z") : null,
      linkedIssueId: input.linkedIssueId ?? null,
      providerCapabilityClass: loaded.contract.stages[input.stage].provider_capability_class,
      concurrencyKey: loaded.contract.stages[input.stage].concurrency_key,
      concurrencyLimit: loaded.contract.stages[input.stage].concurrency_limit,
      requiredReceipts: loaded.contract.stages[input.stage].required_receipts,
      completionEvidence: loaded.contract.stages[input.stage].completion_evidence,
      feedback: input.state === "succeeded" ? { output_hash: HASH("f") } : {},
      leaseOwner: input.lease ? "live-worker" : null,
      leaseActorType: input.lease ? "system" : null,
      leaseActorId: input.lease ? "live-worker" : null,
      leaseExpiresAt: input.lease ? new Date("2026-07-25T00:00:00.000Z") : null,
      heartbeatAt: input.lease ? new Date("2026-07-24T00:00:00.000Z") : null,
      correlationId: oldCorrelationId,
      traceId: oldTraceId,
      spanId: digest(input.id).slice(0, 16),
      startedAt: input.state === "succeeded" || input.state === "running" ? oldCreatedAt : null,
      completedAt: input.state === "succeeded" ? oldCreatedAt : null,
      createdAt: oldCreatedAt,
      updatedAt: input.updatedAt ?? oldCreatedAt,
    }).returning().then((rows) => rows[0]!);
    const research = await insertStage({
      id: researchStageId,
      stage: "research_intake",
      state: "succeeded",
      inputHash: HASH("c"),
    });
    const dispatch = await insertStage({
      id: dispatchStageId,
      stage: "dispatch",
      state: "blocked",
      inputHash: dispatchInputHash,
      linkedIssueId: deterministicIssueId,
    });
    const implementation = await insertStage({
      id: implementationStageId,
      stage: "implementation",
      state: "retry",
      inputHash: implementationInputHash,
      linkedIssueId: manualIssueId,
    });
    const event = await db.insert(profitFlywheelEvents).values({
      companyId: COMPANY_ID,
      workflowId: oldWorkflowId,
      stageRunId: dispatch.id,
      eventType: "stage_requested",
      dedupeKey: `old-pending-event:${dispatch.id}`,
      toState: "blocked",
      correlationId: oldCorrelationId,
      traceId: oldTraceId,
      spanId: dispatch.spanId,
      payload: { fixture: true },
      nextAttemptAt: oldCreatedAt,
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
    }).returning().then((rows) => rows[0]!);

    const newerWorkflowId = randomUUID();
    await db.insert(profitFlywheelWorkflows).values({
      id: newerWorkflowId,
      companyId: COMPANY_ID,
      projectId,
      runId: `fixture-newer-${randomUUID()}`,
      state: "blocked",
      currentStage: "dispatch",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/fixture/newer-dispatch.json",
      sourceDispatchHash: HASH("9"),
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: "/fixture/newer-workspace",
      contractPath: loaded.path,
      contractSha256: loaded.sha256,
      contractSnapshot: loaded.contract as unknown as Record<string, unknown>,
      correlationId: `profit-canary:newer-${randomUUID()}`,
      traceId: HASH("3").slice(0, 32),
      feedback: {},
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      updatedAt: new Date("2026-07-22T12:00:00.000Z"),
    });

    let unsafeStageId: string | null = null;
    if (options.unsafeRunning) {
      const unsafeWorkflowId = randomUUID();
      unsafeStageId = randomUUID();
      await db.insert(profitFlywheelWorkflows).values({
        id: unsafeWorkflowId,
        companyId: COMPANY_ID,
        projectId,
        runId: `fixture-running-${randomUUID()}`,
        state: "running",
        currentStage: "implementation",
        sourceSchemaVersion: "pos.dispatch.v2",
        sourceDispatchPath: "/fixture/running-dispatch.json",
        sourceDispatchHash: HASH("8"),
        targetRepo: "fixture/profit-canary",
        targetWorkspaceRoot: "/fixture/running-workspace",
        contractPath: loaded.path,
        contractSha256: loaded.sha256,
        contractSnapshot: loaded.contract as unknown as Record<string, unknown>,
        correlationId: `profit-canary:running-${randomUUID()}`,
        traceId: HASH("4").slice(0, 32),
        feedback: {},
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      });
      await db.insert(profitFlywheelStageRuns).values({
        id: unsafeStageId,
        workflowId: unsafeWorkflowId,
        companyId: COMPANY_ID,
        stage: "implementation",
        state: "running",
        ownerPlane: loaded.contract.stages.implementation.owner_plane,
        inputSchemaVersion: loaded.contract.stages.implementation.input_schema,
        inputHash: HASH("7"),
        sourceHashes: { fixture: HASH("7") },
        idempotencyKey: `unsafe:${unsafeStageId}`,
        attemptCount: 1,
        maxAttempts: Math.max(1, loaded.contract.stages.implementation.retry.limit + 1),
        providerCapabilityClass: loaded.contract.stages.implementation.provider_capability_class,
        concurrencyKey: loaded.contract.stages.implementation.concurrency_key,
        concurrencyLimit: loaded.contract.stages.implementation.concurrency_limit,
        requiredReceipts: loaded.contract.stages.implementation.required_receipts,
        completionEvidence: loaded.contract.stages.implementation.completion_evidence,
        feedback: {},
        leaseOwner: "active-worker",
        leaseActorType: "system",
        leaseActorId: "active-worker",
        leaseExpiresAt: new Date("2026-07-25T00:00:00.000Z"),
        heartbeatAt: new Date("2026-07-24T00:00:00.000Z"),
        correlationId: `profit-canary:running-${unsafeStageId}`,
        traceId: HASH("4").slice(0, 32),
        spanId: digest(unsafeStageId).slice(0, 16),
        startedAt: oldCreatedAt,
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      });
      await db.insert(profitFlywheelLeases).values({
        companyId: COMPANY_ID,
        stageRunId: unsafeStageId,
        scopeType: "stage",
        scopeKey: `stage:${unsafeStageId}`,
        slot: 0,
        leaseOwner: "active-worker",
        expiresAt: new Date("2026-07-25T00:00:00.000Z"),
        createdAt: oldCreatedAt,
        updatedAt: oldCreatedAt,
      });
    }
    return {
      ...dirs,
      closeoutPath,
      closeoutSha256,
      oldWorkflowId,
      replacementWorkflowId,
      replacementProjectId,
      replacementIssueId,
      newerWorkflowId,
      deterministicIssueId,
      manualIssueId,
      dispatchStageId: dispatch.id,
      implementationStageId: implementation.id,
      researchStageId: research.id,
      eventId: event.id,
      unsafeStageId,
    };
  }

  function operatorOptions(seed: Awaited<ReturnType<typeof seed>>) {
    return {
      companyId: COMPANY_ID,
      cutoffAt: CUTOFF_AT,
      replacementCloseoutPath: seed.closeoutPath,
      replacementCloseoutSha256: seed.closeoutSha256,
      receiptDir: seed.receiptDir,
    };
  }

  function pausedAuthority(paused = true, generation = HASH("f")) {
    return () => ({ paused, generation });
  }

  async function replaceImmutableJson(pathname: string, value: Record<string, unknown>) {
    await chmod(pathname, 0o600);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await writeFile(pathname, bytes, { mode: 0o600 });
    await chmod(pathname, 0o444);
    return createHash("sha256").update(bytes).digest("hex");
  }

  function backupDependencies(fixture: Awaited<ReturnType<typeof seed>>) {
    let calls = 0;
    const backupFile = path.join(fixture.root, "pre-retirement.sql.gz");
    const backupBytes = Buffer.from("embedded-postgres-backup\n", "utf8");
    return {
      dependencies: {
        factoryPauseAuthority: pausedAuthority(),
        now: () => RETIREMENT_AT,
        databaseBackup: {
          connectionString: "postgres://internal-selected-embedded-instance/paperclip",
          backupDir: fixture.root,
          retentionDays: 30,
        },
        backupRunner: async () => {
          calls += 1;
          await writeFile(backupFile, backupBytes, { mode: 0o600 });
          return { backupFile, compression: "gzip" as const, sizeBytes: backupBytes.length, prunedCount: 0 };
        },
      },
      calls: () => calls,
      backupFile,
    };
  }

  it("requires the factory pause before inspecting or mutating any candidate", async () => {
    const fixture = await seed();
    await expect(planProfitFlywheelStaleCanaryRetirement(db, operatorOptions(fixture), {
      factoryPauseAuthority: pausedAuthority(false),
    })).rejects.toThrow("profit_canary_retirement_factory_pause_required");
  });

  it("reruns canonical closeout verification so a minimal self-authored closeout cannot authorize retirement", async () => {
    const fixture = await seed();
    // This test deliberately bypasses the module mock used by retirement state
    // tests above. The fixture has a matching immutable header/hash but no
    // completed-cycle DB lineage, stages, receipts, or proofs.
    vi.doUnmock("../ops/profit-flywheel-canary-closeout.js");
    vi.resetModules();
    const { planProfitFlywheelStaleCanaryRetirement: planWithCanonicalCloseout } =
      await import("../ops/profit-flywheel-stale-canary-retirement.js");
    await expect(planWithCanonicalCloseout(db, operatorOptions(fixture), {
      factoryPauseAuthority: pausedAuthority(),
    })).rejects.toThrow(/profit_canary_closeout_/);
    const [oldWorkflow] = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    expect(oldWorkflow?.state).toBe("blocked");
  });

  it("fails closed when the canonical replacement identity references a missing, wrong-project, or cross-company issue", async () => {
    const fixture = await seed();
    const dependency = { factoryPauseAuthority: pausedAuthority() };
    const closeout = JSON.parse((await readFile(fixture.closeoutPath)).toString("utf8")) as Record<string, unknown>;
    const identity = closeout.identity as Record<string, unknown>;
    const attempts = [
      { name: "missing", issueId: randomUUID() },
      { name: "wrong-project", issueId: fixture.deterministicIssueId },
    ];
    const crossCompanyId = randomUUID();
    const crossProjectId = randomUUID();
    const crossIssueId = randomUUID();
    await db.insert(companies).values({ id: crossCompanyId, name: "Other company", issuePrefix: "OTH" });
    await db.insert(projects).values({ id: crossProjectId, companyId: crossCompanyId, name: "Other project" });
    await db.insert(issues).values({
      id: crossIssueId,
      companyId: crossCompanyId,
      projectId: crossProjectId,
      title: "Other company completed issue",
      status: "done",
      completedAt: RETIREMENT_AT,
    });
    attempts.push({ name: "cross-company", issueId: crossIssueId });
    for (const attempt of attempts) {
      const next = structuredClone(closeout);
      (next.identity as Record<string, unknown>).issue_id = attempt.issueId;
      const closeoutSha256 = await replaceImmutableJson(fixture.closeoutPath, next);
      await expect(planProfitFlywheelStaleCanaryRetirement(db, {
        ...operatorOptions(fixture),
        replacementCloseoutSha256: closeoutSha256,
      }, dependency)).rejects.toThrow("profit_canary_retirement_replacement_project_or_issue_mismatch");
    }
  });

  it("rejects a validly hashed immutable plan that omits a selected stage, issue, or workflow", async () => {
    const cases: Array<{
      name: string;
      mutate: (plan: Record<string, unknown>) => void;
      error: string;
    }> = [
      {
        name: "stage",
        mutate(plan) {
          const target = (plan.targets as Array<Record<string, unknown>>)[0]!;
          const stages = target.stages_to_cancel as Array<Record<string, unknown>>;
          const removed = stages.shift()!;
          target.linked_issues = (target.linked_issues as Array<Record<string, unknown>>)
            .filter((issue) => issue.stage_run_id !== removed.id);
        },
        error: "profit_canary_retirement_plan_drift",
      },
      {
        name: "issue",
        mutate(plan) {
          const target = (plan.targets as Array<Record<string, unknown>>)[0]!;
          (target.linked_issues as Array<Record<string, unknown>>).pop();
        },
        error: "profit_canary_retirement_plan_drift",
      },
      {
        name: "workflow",
        mutate(plan) {
          plan.targets = [];
          plan.blockers = [{ code: "forged_workflow_omission" }];
          plan.ready = false;
        },
        error: "profit_canary_retirement_plan_not_applyable",
      },
    ];
    for (const [caseIndex, testCase] of cases.entries()) {
      if (caseIndex > 0) {
        await db.delete(profitFlywheelEvents);
        await db.delete(profitFlywheelLeases);
        await db.delete(profitFlywheelStageRuns);
        await db.delete(profitFlywheelWorkflows);
        await db.delete(issues);
        await db.delete(projects);
        await db.delete(companies);
      }
      const fixture = await seed();
      const options = operatorOptions(fixture);
      const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
        factoryPauseAuthority: pausedAuthority(),
        now: () => RETIREMENT_AT,
      });
      const altered = JSON.parse((await readFile(planned.receiptPath)).toString("utf8")) as Record<string, unknown>;
      testCase.mutate(altered);
      altered.target_snapshot_sha256 = hashProfitFlywheelValue(altered.targets);
      const planSha256 = await replaceImmutableJson(planned.receiptPath, altered);
      const backup = backupDependencies(fixture);
      await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
        ...options,
        planPath: planned.receiptPath,
        planSha256,
      }, backup.dependencies), testCase.name).rejects.toThrow(testCase.error);
      const [oldWorkflow] = await db.select().from(profitFlywheelWorkflows)
        .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
      expect(oldWorkflow?.state, testCase.name).toBe("blocked");
    }
  });

  it("rechecks live pause authority after durable intent and before locked mutation", async () => {
    const fixture = await seed();
    const options = operatorOptions(fixture);
    let paused = true;
    let generation = HASH("a");
    const authority = () => ({ paused, generation });
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: authority,
      now: () => RETIREMENT_AT,
    });
    const backup = backupDependencies(fixture);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, {
      ...backup.dependencies,
      factoryPauseAuthority: authority,
      afterIntentBeforeMutation: () => {
        paused = false;
        generation = HASH("b");
      },
    })).rejects.toThrow("profit_canary_retirement_factory_pause_required");
    expect(backup.calls()).toBe(1);
    const [workflow] = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    const [stage] = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.dispatchStageId));
    expect(workflow?.state).toBe("blocked");
    expect(stage?.state).toBe("blocked");
  });

  it("preserves an already-terminal non-deterministic linked issue exactly", async () => {
    const fixture = await seed({ manualTerminal: true });
    const options = operatorOptions(fixture);
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    expect(planned.plan.targets[0]!.linked_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.manualIssueId, action: "retained_terminal", status: "cancelled" }),
    ]));
    const backup = backupDependencies(fixture);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies)).resolves.toMatchObject({ status: "retired" });
    const [manualIssue] = await db.select().from(issues).where(eq(issues.id, fixture.manualIssueId));
    expect(manualIssue?.status).toBe("cancelled");
    expect(manualIssue?.cancelledAt?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("fails before mutation when a backup runner returns a symlinked path", async () => {
    const fixture = await seed();
    const options = operatorOptions(fixture);
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    const backingFile = path.join(fixture.root, "real-pre-retirement.sql.gz");
    const symlinkedBackup = path.join(fixture.root, "pre-retirement-link.sql.gz");
    const bytes = Buffer.from("backup bytes", "utf8");
    await writeFile(backingFile, bytes, { mode: 0o600 });
    await symlink(backingFile, symlinkedBackup);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
      databaseBackup: {
        connectionString: "postgres://internal-selected-embedded-instance/paperclip",
        backupDir: fixture.root,
        retentionDays: 30,
      },
      backupRunner: async () => ({
        backupFile: symlinkedBackup,
        compression: "gzip" as const,
        sizeBytes: bytes.length,
        prunedCount: 0,
      }),
    })).rejects.toThrow("profit_canary_retirement_backup_path_not_canonical");
    const [workflow] = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    expect(workflow?.state).toBe("blocked");
  });

  it("plans and retires only safe older fixture canaries, preserves history, drains events, and replays idempotently", async () => {
    const fixture = await seed();
    const options = operatorOptions(fixture);
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    expect(planned.plan.ready).toBe(true);
    expect(planned.plan.targets).toHaveLength(1);
    expect(planned.plan.targets[0]).toMatchObject({
      workflow: { id: fixture.oldWorkflowId, state: "blocked" },
      preserved_terminal_stage_ids: [fixture.researchStageId],
      events_to_drain: [{ id: fixture.eventId }],
    });
    expect(planned.plan.targets[0]!.linked_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.deterministicIssueId, action: "cancel", deterministic_fixture_identity: true }),
      expect.objectContaining({ id: fixture.manualIssueId, action: "retained_unverified", deterministic_fixture_identity: false }),
    ]));
    const replayedPlan = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => new Date("2026-07-24T13:00:00.000Z"),
    });
    expect(replayedPlan.receiptSha256).toBe(planned.receiptSha256);

    const backup = backupDependencies(fixture);
    const applied = await applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies);
    expect(applied.status).toBe("retired");
    expect(backup.calls()).toBe(1);
    expect(applied.result).toMatchObject({
      immutable: true,
      rollback: { state: "non_compensable", cas_reversible: false },
      database_backup: { backup_file: backup.backupFile, size_bytes: 25, mode: "0400" },
    });
    const [oldWorkflow] = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    const [replacement] = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.replacementWorkflowId));
    const [newer] = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.newerWorkflowId));
    expect(oldWorkflow).toMatchObject({ state: "cancelled", blockerCode: "profit_flywheel_fixture_canary_superseded" });
    expect(replacement).toMatchObject({ state: "running", currentStage: "research_intake" });
    expect(newer).toMatchObject({ state: "blocked" });
    const retiredStages = await db.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.workflowId, fixture.oldWorkflowId),
      eq(profitFlywheelStageRuns.companyId, COMPANY_ID),
    ));
    expect(retiredStages.find((stage) => stage.id === fixture.dispatchStageId)).toMatchObject({ state: "cancelled", retryAt: null });
    expect(retiredStages.find((stage) => stage.id === fixture.implementationStageId)).toMatchObject({ state: "cancelled", retryAt: null });
    expect(retiredStages.find((stage) => stage.id === fixture.researchStageId)).toMatchObject({ state: "succeeded" });
    const [deterministicIssue] = await db.select().from(issues).where(eq(issues.id, fixture.deterministicIssueId));
    const [manualIssue] = await db.select().from(issues).where(eq(issues.id, fixture.manualIssueId));
    expect(deterministicIssue).toMatchObject({ status: "cancelled" });
    expect(manualIssue).toMatchObject({ status: "todo" });
    const [drained] = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.eventId));
    expect(drained?.processedAt).not.toBeNull();
    const auditEvents = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.workflowId, fixture.oldWorkflowId));
    expect(auditEvents.filter((event) => event.eventType.startsWith("retirement_")).every((event) => event.processedAt !== null)).toBe(true);

    const replay = await applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies);
    expect(replay.receiptSha256).toBe(applied.receiptSha256);
    expect(backup.calls()).toBe(1);
    const auditAfterReplay = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.workflowId, fixture.oldWorkflowId));
    expect(auditAfterReplay).toHaveLength(auditEvents.length);

    await db.update(profitFlywheelStageRuns).set({
      state: "blocked",
      completedAt: null,
      updatedAt: new Date("2026-07-24T12:01:00.000Z"),
    }).where(eq(profitFlywheelStageRuns.id, fixture.dispatchStageId));
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies)).rejects.toThrow("profit_canary_retirement_existing_result_db_postcondition_failed");
  });

  it("fails closed for any older running workflow or lease rather than silently skipping it", async () => {
    const fixture = await seed({ unsafeRunning: true });
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, operatorOptions(fixture), {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    expect(planned.plan.ready).toBe(false);
    expect(planned.plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "nonterminal_workflow_not_safe_to_retire" }),
    ]));
    const backup = backupDependencies(fixture);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...operatorOptions(fixture),
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies)).rejects.toThrow("profit_canary_retirement_plan_not_applyable");
    expect(backup.calls()).toBe(0);
  });

  it("rejects a preplanted audit dedupe key unless every event field is the exact retirement audit entry", async () => {
    const fixture = await seed();
    const options = operatorOptions(fixture);
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    const [stage] = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.dispatchStageId));
    const [workflow] = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    await db.insert(profitFlywheelEvents).values({
      companyId: COMPANY_ID,
      workflowId: fixture.oldWorkflowId,
      stageRunId: fixture.dispatchStageId,
      eventType: "retirement_stage_cancelled",
      dedupeKey: `stale-canary-retirement:${planned.plan.operation_id}:stage:${fixture.dispatchStageId}`,
      fromState: "blocked",
      toState: "cancelled",
      correlationId: workflow!.correlationId,
      traceId: workflow!.traceId,
      spanId: stage!.spanId,
      payload: { operation_id: "preplanted-wrong-operation" },
      processedAt: RETIREMENT_AT,
      nextAttemptAt: RETIREMENT_AT,
      createdAt: RETIREMENT_AT,
      updatedAt: RETIREMENT_AT,
    });
    const backup = backupDependencies(fixture);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies)).rejects.toThrow("profit_canary_retirement_audit_dedupe_conflict");
    const [unretired] = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    expect(unretired?.state).toBe("blocked");
  });

  it("recovers a committed transaction from immutable intent when final receipt installation is interrupted", async () => {
    const fixture = await seed();
    const options = operatorOptions(fixture);
    const planned = await planProfitFlywheelStaleCanaryRetirement(db, options, {
      factoryPauseAuthority: pausedAuthority(),
      now: () => RETIREMENT_AT,
    });
    const backup = backupDependencies(fixture);
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, {
      ...backup.dependencies,
      afterDatabaseMutationBeforeFinalReceipt: () => {
        throw new Error("simulated_final_receipt_interruption");
      },
    })).rejects.toThrow("simulated_final_receipt_interruption");
    expect(backup.calls()).toBe(1);
    const [cancelled] = await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.oldWorkflowId));
    expect(cancelled?.state).toBe("cancelled");
    const recovered = await applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies);
    expect(recovered.status).toBe("retired");
    expect(backup.calls()).toBe(1);
    await chmod(backup.backupFile, 0o600);
    await writeFile(backup.backupFile, "tampered backup", "utf8");
    await expect(applyProfitFlywheelStaleCanaryRetirement(db, {
      ...options,
      planPath: planned.receiptPath,
      planSha256: planned.receiptSha256,
    }, backup.dependencies)).rejects.toThrow("profit_canary_retirement_backup_file_invalid");
  });
});
