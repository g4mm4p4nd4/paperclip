import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  agents,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createProfitFlywheelReconciler } from "../services/profit-flywheel-reconciler.js";
import {
  buildProfitFlywheelIdempotencyKey,
  buildProfitFlywheelStageInput,
  canonicalProfitFlywheelReceiptHash,
  hashProfitFlywheelValue,
  profitFlywheelService,
} from "../services/profit-flywheel.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import { fixtureFactoryLaunchAuthority } from "../services/factory-launch-authority.js";
import { ProviderPolicyAuthorityError } from "../services/provider-policy-authority.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const allowTestFactoryLaunch = {
  claim: async () => ({
    allowed: true,
    code: "test_factory_launch_authorized",
    detail: "Test fixture explicitly authorizes this launch.",
    terminal: false,
  }),
};
const allowTestFactoryServiceDeps = {
  factoryMode: "fixture" as const,
  factoryPauseNewWork: false,
  factoryLaunchAuthority: allowTestFactoryLaunch,
};

function createTestReconciler(
  db: Parameters<typeof createProfitFlywheelReconciler>[0],
  options: Parameters<typeof createProfitFlywheelReconciler>[1] = {},
) {
  return createProfitFlywheelReconciler(db, {
    factoryMode: "fixture",
    factoryPauseNewWork: false,
    factoryLaunchAuthority: allowTestFactoryLaunch,
    ...options,
  });
}

describeDb("Profit Flywheel event-driven crash reconciler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelLeases);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedResearchOutbox(
    maxAttempts = 2,
    stageName: "research_intake" | "evidence_normalization" | "commercial_validation" | "council_decision" | "dispatch" = "research_intake",
  ) {
    const loaded = await loadProfitFlywheelContract();
    const policy = await loadProviderPolicyV2();
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Reconcile ${companyId.slice(0, 6)}`,
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Reconciler" });
    const correlationId = `profit:${randomUUID()}`;
    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId,
      projectId,
      runId: `reconcile-${randomUUID()}`,
      state: "running",
      currentStage: stageName,
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/reconciler-dispatch.json",
      sourceDispatchHash: "d".repeat(64),
      targetRepo: "fixture/reconciler",
      targetWorkspaceRoot: "/tmp",
      contractPath: loaded.path,
      contractSha256: loaded.sha256,
      contractSnapshot: loaded.contract as unknown as Record<string, unknown>,
      correlationId,
      traceId: createHash("sha256").update(correlationId).digest("hex").slice(0, 32),
      feedback: {
        provider_policy: {
          sha256: policy.sha256,
          schema_sha256: policy.schemaSha256,
          schema_version: "provider-policy.v2",
        },
      },
    }).returning().then((rows) => rows[0]!);
    const sourceHashes = Object.fromEntries(loaded.contract.stages[stageName].input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, companyId })]));
    const canonical = buildProfitFlywheelStageInput({ contract: loaded.contract, stage: stageName, sourceHashes });
    const stage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: workflow.id,
      companyId,
      stage: stageName,
      state: "pending",
      ownerPlane: "portfolio_os",
      inputSchemaVersion: loaded.contract.stages[stageName].input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId, runId: workflow.runId, stage: stageName, inputHash: canonical.inputHash }),
      maxAttempts,
      providerCapabilityClass: loaded.contract.stages[stageName].provider_capability_class,
      concurrencyKey: loaded.contract.stages[stageName].concurrency_key,
      concurrencyLimit: loaded.contract.stages[stageName].concurrency_limit,
      requiredReceipts: loaded.contract.stages[stageName].required_receipts,
      completionEvidence: loaded.contract.stages[stageName].completion_evidence,
      correlationId,
      traceId: workflow.traceId,
      spanId: createHash("sha256").update(`span:${companyId}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    const event = await db.insert(profitFlywheelEvents).values({
      companyId,
      workflowId: workflow.id,
      stageRunId: stage.id,
      eventType: "portfolio_os_stage_requested",
      dedupeKey: `stage-requested:${stage.id}`,
      toState: "pending",
      correlationId,
      traceId: workflow.traceId,
      spanId: stage.spanId,
      payload: { stage: stageName, input_hash: stage.inputHash },
      nextAttemptAt: new Date(Date.now() - 1000),
    }).returning().then((rows) => rows[0]!);
    return { companyId, workflow, stage, event, contract: loaded.contract };
  }

  const validSecrets = async () => ({
    PAPERCLIP_API_KEY: "api-key-value-that-is-long-and-distinct",
    PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: "research-journal-value-that-is-long-and-distinct",
  });

  const validSecretsForPlane = async (_companyId: string, plane: "return" | "research" | "portfolio_os_stage_plane") => ({
    PAPERCLIP_API_KEY: `api-key-value-that-is-long-and-distinct-${plane}`,
    [plane === "return"
      ? "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY"
      : plane === "research" ? "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY" : "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY"]:
        `journal-value-that-is-long-and-distinct-${plane}`,
  });

  it("coalesces duplicate reconciliation ticks and drains a committed outbox event exactly once", async () => {
    const fixture = await seedResearchOutbox();
    let calls = 0;
    const reconciler = createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null }).where(eq(profitFlywheelEvents.id, fixture.event.id));
      },
    });
    const [left, right] = await Promise.all([reconciler.tickOnce(), reconciler.tickOnce()]);
    expect(calls).toBe(1);
    const statuses = [...left.outbox, ...right.outbox].map((entry) => entry.status);
    expect(statuses).toContain("executed");
    expect(statuses.filter((status) => status === "already_claimed" || status === "empty")).toHaveLength(1);
    expect((await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!.processedAt))).not.toBeNull();
  });

  it("continues reconciliation phases but creates no claim or subprocess while new work is paused", async () => {
    const fixture = await seedResearchOutbox();
    let authorityCalls = 0;
    let commandCalls = 0;
    const result = await createProfitFlywheelReconciler(db, {
      factoryMode: "fixture",
      factoryPauseNewWork: true,
      factoryLaunchAuthority: {
        claim: async () => {
          authorityCalls += 1;
          return { allowed: true, code: "unexpected", detail: "must not be called", terminal: false };
        },
      },
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { commandCalls += 1; },
    }).tickOnce();
    expect(result).toMatchObject({
      repairedOrphans: 0,
      recoveredProviderStages: 0,
      processedEvents: 0,
      dispatchedStages: 0,
      phaseFailures: [],
      outbox: [expect.objectContaining({ status: "admission_paused", events: 0 })],
    });
    expect(authorityCalls).toBe(0);
    expect(commandCalls).toBe(0);
    const event = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id))
      .then((rows) => rows[0]!);
    expect(event).toMatchObject({ processedAt: null, attemptCount: 0, lastError: null });
    expect(event.payload).not.toHaveProperty("pos_consumer_launcher_claim");
  });

  it("creates no outbox claim or subprocess when the admission authority reports a disk hard stop", async () => {
    const fixture = await seedResearchOutbox();
    let commandCalls = 0;
    const result = await createProfitFlywheelReconciler(db, {
      factoryMode: "fixture",
      factoryPauseNewWork: false,
      factoryLaunchAuthority: {
        claim: async () => ({
          allowed: false,
          code: "factory_disk_below_30_gib",
          detail: "Fresh trusted health reports fewer than 30 GiB available.",
          terminal: false,
        }),
      },
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { commandCalls += 1; },
    }).tickOnce();
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "admission_denied", error: "factory_disk_below_30_gib", events: 0 }),
    ]));
    expect(commandCalls).toBe(0);
    const event = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id))
      .then((rows) => rows[0]!);
    expect(event).toMatchObject({ processedAt: null, attemptCount: 0, lastError: null });
    expect(event.payload).not.toHaveProperty("pos_consumer_launcher_claim");
  });

  it("terminally rejects a real target in fixture mode before claim or launch", async () => {
    const fixture = await seedResearchOutbox();
    await db.update(profitFlywheelWorkflows).set({ targetRepo: "real-company/production-repo" })
      .where(eq(profitFlywheelWorkflows.id, fixture.workflow.id));
    let commandCalls = 0;
    const result = await createProfitFlywheelReconciler(db, {
      factoryMode: "fixture",
      factoryPauseNewWork: false,
      factoryLaunchAuthority: fixtureFactoryLaunchAuthority,
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { commandCalls += 1; },
    }).tickOnce();
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "blocked_factory_authority", error: "factory_fixture_real_target_rejected" }),
    ]));
    expect(commandCalls).toBe(0);
    const [event, stage] = await Promise.all([
      db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!),
      db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!),
    ]);
    expect(event.payload).not.toHaveProperty("pos_consumer_launcher_claim");
    expect(stage).toMatchObject({ state: "blocked", blockerCode: "factory_fixture_real_target_rejected" });
  });

  it("persists one fenced immutable POS attempt receipt across receipt, event, stage, workflow, and log surfaces", async () => {
    const fixture = await seedResearchOutbox();
    const providerPolicyAuthority = {
      path: "/configured/paperclip-runtime/authorities/provider-policy/authority.json",
      sha256: "9".repeat(64),
    };
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-pos-attempt-integration-")));
    const receiptDirectory = path.join(root, "receipts");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
    try {
      const result = await createTestReconciler(db, {
        resolveRuntimeSecrets: validSecrets,
        runtimeRoot: "/configured/managed-runtime-root",
        resolveManagedRuntime: async (input) => {
          expect(input).toEqual({ runtimeRoot: "/configured/managed-runtime-root" });
          return {
            schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
            generation: 7,
            selector: { path: "/configured/managed-runtime-root/control/active.json", sha256: "4".repeat(64) },
            pointerSet: { path: "/configured/managed-runtime-root/control/pointer-sets/5.json", sha256: "5".repeat(64) },
            providerPolicyAuthority,
            current: {} as never,
            previous: null,
            command: {
              executablePath: "/configured/managed-runtime-root/packages/current/bin/pos",
              cwd: "/configured/managed-runtime-root/packages/current",
              runtimeManifestPath: "/configured/managed-runtime.json",
              runtimeManifestArgs: ["--runtime-manifest", "/configured/managed-runtime.json"],
            },
            writableRoots: { cache: "/configured/cache", output: "/configured/output" },
            toolchain: {} as never,
          };
        },
        publishProviderPolicyAuthority: async () => providerPolicyAuthority,
        attemptReceiptDirectory: receiptDirectory,
        executeAttempt: async (input) => {
          expect(input.runtimeManifestPath).toBe("/configured/managed-runtime.json");
          expect(input.providerPolicyAuthorityPath).toBe(providerPolicyAuthority.path);
          expect(input.artifactRoot).toBe("/configured/output/paperclip-consumer");
          const endedAt = new Date();
          const receipt = {
            schema_version: "paperclip.pos_consumer_attempt_receipt.v1" as const,
            attempt_id: input.attemptId,
            timing: { started_at: endedAt.toISOString(), ended_at: endedAt.toISOString(), duration_ms: 0 },
            classification: {
              code: "succeeded" as const,
              retryable: false,
              terminal: true,
              next_attempt_at: null,
              next_owner: "paperclip_reconciler",
              resume_condition: "No action required.",
            },
            process: {
              exit_code: 2,
              signal: null,
              timed_out: false,
              stdout: { sha256: "a".repeat(64) },
              stderr: { sha256: "b".repeat(64) },
            },
            protocol: {
              state: "succeeded" as const,
              envelope_sha256: "c".repeat(64),
              result_schema_version: "pos.paperclip_research_plane_run.v2",
              acknowledgement: { path: "/immutable/prepared-ack.json", sha256: "d".repeat(64) },
              ack_response: { path: "/immutable/ack-response.json", sha256: "3".repeat(64) },
            },
            runtime: {
              manifest: { path: "/configured/managed-runtime.json", sha256: "e".repeat(64) },
              source_commit: "f".repeat(40),
              source_tree_sha256: "1".repeat(64),
              interpreter_identity_sha256: "2".repeat(64),
              contract_sha256: fixture.workflow.contractSha256,
              provider_policy_sha256: null,
              provider_policy_authority: providerPolicyAuthority,
            },
          };
          const receiptPath = path.join(receiptDirectory, `${input.attemptId}.json`);
          const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
          await db.update(profitFlywheelEvents).set({ processedAt: endedAt, lastError: null })
            .where(eq(profitFlywheelEvents.id, fixture.event.id));
          return {
            receipt,
            receiptBinding: { path: receiptPath, sha256: receiptSha256 },
            envelope: null,
            classification: {
              code: "succeeded" as const,
              retryable: false,
              terminal: true,
              nextAttemptAt: null,
              nextOwner: "paperclip_reconciler",
              resumeCondition: "No action required.",
            },
            process: { exitCode: 2, signal: null, timedOut: false, overflowed: false, spawnError: null },
          } as Awaited<ReturnType<typeof import("../services/pos-consumer-runner.js")["runPosConsumerAttempt"]>>;
        },
      }).tickOnce();
      expect(result.outbox).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "executed", attemptReceipt: expect.objectContaining({ sha256: expect.any(String) }) }),
      ]));
      const [event, stage, workflow, receipts, logs] = await Promise.all([
        db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!),
        db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!),
        db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id)).then((rows) => rows[0]!),
        db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id)),
        db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.eventType, "pos_consumer_attempt_recorded")),
      ]);
      expect(event.payload).toEqual(expect.objectContaining({
        pos_consumer_launcher_claim: expect.objectContaining({ status: "finalized" }),
        pos_consumer_attempt_receipt: expect.objectContaining({ classification: "succeeded" }),
      }));
      expect(stage.feedback).toEqual(expect.objectContaining({ pos_consumer_attempt_receipt: expect.any(Object) }));
      expect(workflow.feedback).toEqual(expect.objectContaining({ pos_consumer_attempt_receipt: expect.any(Object) }));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ receiptType: "pos_consumer_attempt_receipt", status: "valid" });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.payload).toEqual(expect.objectContaining({ outbox_event_id: fixture.event.id }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks an indeterminate launch when immutable attempt evidence cannot be recorded", async () => {
    const fixture = await seedResearchOutbox();
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runtimeManifestPath: "/configured/managed-runtime.json",
      attemptReceiptDirectory: "/configured/attempt-receipts",
      executeAttempt: async () => {
        throw new Error("immutable receipt store unavailable");
      },
    }).tickOnce();

    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "blocked_attempt_evidence",
        error: "immutable receipt store unavailable",
      }),
    ]));
    const [event, stage] = await Promise.all([
      db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!),
      db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!),
    ]);
    expect(event).toMatchObject({ processedAt: expect.any(Date) });
    expect(event.payload).toEqual(expect.objectContaining({
      pos_consumer_launcher_claim: expect.objectContaining({
        status: "blocked_attempt_evidence_unavailable",
        finalized_at: expect.any(String),
      }),
    }));
    expect(stage).toMatchObject({
      state: "blocked",
      attemptCount: 0,
      blockerCode: "profit_flywheel_pos_attempt_evidence_unavailable",
      blockerDetail: expect.stringContaining("subprocess outcome is intentionally not inferred"),
      nextOwner: "paperclip_runtime_owner",
    });
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id)))
      .toHaveLength(0);
  });

  it("blocks a managed selector mismatch before launching a POS subprocess", async () => {
    const fixture = await seedResearchOutbox();
    let attemptCalls = 0;
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runtimeRoot: "/configured/managed-runtime-root",
      attemptReceiptDirectory: "/configured/attempt-receipts",
      publishProviderPolicyAuthority: async () => ({
        path: "/configured/paperclip-runtime/authorities/provider-policy/authority.json",
        sha256: "9".repeat(64),
      }),
      resolveManagedRuntime: async () => { throw new Error("managed_pos_runtime_selector_canonical_json_mismatch"); },
      executeAttempt: async () => {
        attemptCalls += 1;
        throw new Error("must not execute");
      },
    }).tickOnce();

    expect(attemptCalls).toBe(0);
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "blocked_runtime_provenance",
        error: "managed_pos_runtime_selector_canonical_json_mismatch",
      }),
    ]));
    const stage = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(stage).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_pos_runtime_provenance_mismatch",
      nextOwner: "paperclip_runtime_owner",
    });
  });

  it("blocks a D7 descriptor that differs from the active POS D6 authority binding before launch", async () => {
    const fixture = await seedResearchOutbox();
    let attemptCalls = 0;
    const runtimeAuthority = {
      path: "/configured/paperclip-runtime/authorities/provider-policy/d6-authority.json",
      sha256: "8".repeat(64),
    };
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runtimeRoot: "/configured/managed-runtime-root",
      attemptReceiptDirectory: "/configured/attempt-receipts",
      publishProviderPolicyAuthority: async () => ({
        path: "/configured/paperclip-runtime/authorities/provider-policy/d7-authority.json",
        sha256: "9".repeat(64),
      }),
      resolveManagedRuntime: async () => ({
        schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
        generation: 7,
        selector: { path: "/configured/managed-runtime-root/control/active.json", sha256: "4".repeat(64) },
        pointerSet: { path: "/configured/managed-runtime-root/control/pointer-sets/5.json", sha256: "5".repeat(64) },
        providerPolicyAuthority: runtimeAuthority,
        current: {} as never,
        previous: null,
        command: {
          executablePath: "/configured/managed-runtime-root/packages/current/bin/pos",
          cwd: "/configured/managed-runtime-root/packages/current",
          runtimeManifestPath: "/configured/managed-runtime.json",
          runtimeManifestArgs: ["--runtime-manifest", "/configured/managed-runtime.json"],
        },
        writableRoots: { cache: "/configured/cache", output: "/configured/output" },
        toolchain: {} as never,
      }),
      executeAttempt: async () => {
        attemptCalls += 1;
        throw new Error("must not execute");
      },
    }).tickOnce();

    expect(attemptCalls).toBe(0);
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "blocked_provider_policy",
        error: "profit_flywheel_provider_policy_binding_mismatch",
      }),
    ]));
    const stage = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(stage).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_provider_policy_binding_mismatch",
      nextOwner: "paperclip_runtime_owner",
    });
  });

  it.each([
    "profit_flywheel_provider_policy_binding_missing",
    "profit_flywheel_provider_policy_binding_mismatch",
  ] as const)("preserves the typed %s publisher failure before sanitizing details", async (code) => {
    const fixture = await seedResearchOutbox();
    let resolverCalls = 0;
    let attemptCalls = 0;
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runtimeRoot: "/configured/managed-runtime-root",
      attemptReceiptDirectory: "/configured/attempt-receipts",
      publishProviderPolicyAuthority: async () => {
        throw new ProviderPolicyAuthorityError(code, `publisher fixture for ${code}`);
      },
      resolveManagedRuntime: async () => {
        resolverCalls += 1;
        throw new Error("must not resolve after publisher authority failure");
      },
      executeAttempt: async () => {
        attemptCalls += 1;
        throw new Error("must not execute after publisher authority failure");
      },
    }).tickOnce();

    expect(resolverCalls).toBe(0);
    expect(attemptCalls).toBe(0);
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "blocked_provider_policy", error: code }),
    ]));
    const [stage, event] = await Promise.all([
      db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!),
      db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!),
    ]);
    expect(stage).toMatchObject({
      state: "blocked",
      blockerCode: code,
      nextOwner: "paperclip_runtime_owner",
    });
    expect(event.payload).toMatchObject({
      pos_consumer_launcher_claim: expect.objectContaining({ status: "blocked_provider_policy_binding_mismatch" }),
    });
  });

  it.each([
    "evidence_normalization",
    "commercial_validation",
    "council_decision",
    "dispatch",
  ] as const)("routes %s through the exact isolated Portfolio OS stage plane", async (stageName) => {
    const fixture = await seedResearchOutbox(2, stageName);
    const observed: Array<{ plane: string; env: Record<string, string> }> = [];
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecretsForPlane,
      runCommand: async ({ plane, env }) => {
        observed.push({ plane, env });
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null })
          .where(eq(profitFlywheelEvents.id, fixture.event.id));
      },
    }).tickOnce();
    expect(observed).toEqual([{
      plane: "portfolio_os_stage_plane",
      env: expect.objectContaining({ PAPERCLIP_STAGE_PLANE_JOURNAL_KEY: expect.any(String) }),
    }]);
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "executed", plane: "portfolio_os_stage_plane", events: 1 }),
    ]));
  });

  it("isolates a poisoned decision-plane consumer from a due research-plane event", async () => {
    const poisoned = await seedResearchOutbox(3, "commercial_validation");
    const healthy = await seedResearchOutbox(3, "research_intake");
    const invocations: string[] = [];
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecretsForPlane,
      runCommand: async ({ plane, companyId }) => {
        invocations.push(`${plane}:${companyId}`);
        if (plane === "portfolio_os_stage_plane") throw new Error("poisoned decision-plane fixture");
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null })
          .where(eq(profitFlywheelEvents.id, healthy.event.id));
      },
    }).tickOnce();
    expect(invocations).toEqual(expect.arrayContaining([
      `portfolio_os_stage_plane:${poisoned.companyId}`,
      `research:${healthy.companyId}`,
    ]));
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, poisoned.event.id)).then((rows) => rows[0]))
      .toMatchObject({ processedAt: null, attemptCount: 1, lastError: "poisoned decision-plane fixture" });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, healthy.event.id)).then((rows) => rows[0]!.processedAt))
      .toBeInstanceOf(Date);
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ plane: "portfolio_os_stage_plane", status: "retry_scheduled" }),
      expect.objectContaining({ plane: "research", status: "executed" }),
    ]));
  });

  it("replays after a crash boundary and redacts exact bare credential values before persistence", async () => {
    const fixture = await seedResearchOutbox(3);
    const bareSecret = "api-key-value-that-is-long-and-distinct";
    const first = createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { throw new Error(`child stderr: ${bareSecret}`); },
    });
    await first.tickOnce();
    const retried = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!);
    expect(retried.attemptCount).toBe(1);
    expect(retried.lastError).toContain("REDACTED");
    expect(retried.lastError).not.toContain(bareSecret);
    await db.update(profitFlywheelEvents).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(profitFlywheelEvents.id, fixture.event.id));
    const restarted = createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null }).where(eq(profitFlywheelEvents.id, fixture.event.id));
      },
    });
    expect((await restarted.tickOnce()).outbox).toEqual(expect.arrayContaining([expect.objectContaining({ status: "executed" })]));
  });

  it("preserves the unacknowledged suffix when the limit-one child acknowledges its claimed prefix before crashing", async () => {
    const fixture = await seedResearchOutbox(3);
    const sourceHashes = Object.fromEntries(fixture.contract.stages.research_intake.input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, sibling: fixture.companyId })]));
    const canonical = buildProfitFlywheelStageInput({ contract: fixture.contract, stage: "research_intake", sourceHashes });
    const siblingStage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: fixture.workflow.id,
      companyId: fixture.companyId,
      stage: "research_intake",
      state: "pending",
      ownerPlane: "portfolio_os",
      inputSchemaVersion: fixture.contract.stages.research_intake.input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({
        companyId: fixture.companyId,
        runId: fixture.workflow.runId,
        stage: "research_intake",
        inputHash: canonical.inputHash,
      }),
      maxAttempts: 3,
      providerCapabilityClass: fixture.contract.stages.research_intake.provider_capability_class,
      concurrencyKey: fixture.contract.stages.research_intake.concurrency_key,
      concurrencyLimit: fixture.contract.stages.research_intake.concurrency_limit,
      requiredReceipts: fixture.contract.stages.research_intake.required_receipts,
      completionEvidence: fixture.contract.stages.research_intake.completion_evidence,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: createHash("sha256").update(`sibling:${fixture.companyId}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    const siblingEvent = await db.insert(profitFlywheelEvents).values({
      companyId: fixture.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: siblingStage.id,
      eventType: "portfolio_os_stage_requested",
      dedupeKey: `stage-requested:${siblingStage.id}`,
      toState: "pending",
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: siblingStage.spanId,
      payload: { stage: "research_intake", input_hash: siblingStage.inputHash },
      nextAttemptAt: new Date(Date.now() - 1000),
    }).returning().then((rows) => rows[0]!);
    const untouchedSourceHashes = Object.fromEntries(fixture.contract.stages.research_intake.input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, untouched: fixture.companyId })]));
    const untouchedCanonical = buildProfitFlywheelStageInput({
      contract: fixture.contract,
      stage: "research_intake",
      sourceHashes: untouchedSourceHashes,
    });
    const untouchedStage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: fixture.workflow.id,
      companyId: fixture.companyId,
      stage: "research_intake",
      state: "pending",
      ownerPlane: "portfolio_os",
      inputSchemaVersion: fixture.contract.stages.research_intake.input_schema,
      inputHash: untouchedCanonical.inputHash,
      sourceHashes: untouchedCanonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({
        companyId: fixture.companyId,
        runId: fixture.workflow.runId,
        stage: "research_intake",
        inputHash: untouchedCanonical.inputHash,
      }),
      maxAttempts: 3,
      providerCapabilityClass: fixture.contract.stages.research_intake.provider_capability_class,
      concurrencyKey: fixture.contract.stages.research_intake.concurrency_key,
      concurrencyLimit: fixture.contract.stages.research_intake.concurrency_limit,
      requiredReceipts: fixture.contract.stages.research_intake.required_receipts,
      completionEvidence: fixture.contract.stages.research_intake.completion_evidence,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: createHash("sha256").update(`untouched:${fixture.companyId}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    const untouchedEvent = await db.insert(profitFlywheelEvents).values({
      companyId: fixture.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: untouchedStage.id,
      eventType: "portfolio_os_stage_requested",
      dedupeKey: `stage-requested:${untouchedStage.id}`,
      toState: "pending",
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: untouchedStage.spanId,
      payload: { stage: "research_intake", input_hash: untouchedStage.inputHash },
      nextAttemptAt: new Date(Date.now() - 1000),
    }).returning().then((rows) => rows[0]!);
    await db.update(profitFlywheelEvents).set({ attemptCount: 2 })
      .where(eq(profitFlywheelEvents.id, fixture.event.id));
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null })
          .where(eq(profitFlywheelEvents.id, fixture.event.id));
        throw new Error("child crashed after acknowledging first event");
      },
    }).tickOnce();
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "executed", events: 1 }),
    ]));
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 2, lastError: null });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, siblingEvent.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 0, processedAt: null, lastError: null });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, untouchedEvent.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 0, processedAt: null, lastError: null });
    expect((await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).some((issue) =>
      issue.title.includes("profit_flywheel_pos_executor_retry_exhausted"))).toBe(false);
  });

  it.each([
    ["missing", async () => ({ PAPERCLIP_API_KEY: "api-key-value-that-is-long-and-distinct" })],
    ["revoked", async () => { throw new Error("provider version revoked"); }],
    ["reused", async () => ({
      PAPERCLIP_API_KEY: "same-value-that-is-long-enough-for-both",
      PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: "same-value-that-is-long-enough-for-both",
    })],
  ])("blocks %s credentials once with a precise safe owner and issue", async (_label, resolveRuntimeSecrets) => {
    const fixture = await seedResearchOutbox();
    let commandCalls = 0;
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets,
      runCommand: async () => { commandCalls += 1; },
    }).tickOnce();
    expect(commandCalls).toBe(0);
    expect(result.outbox).toEqual(expect.arrayContaining([expect.objectContaining({ status: "blocked_credentials" })]));
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0])).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_runtime_credentials_unavailable",
      nextOwner: "paperclip_security_owner",
    });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!.processedAt)).not.toBeNull();
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(1);
    await createTestReconciler(db, { resolveRuntimeSecrets, runCommand: async () => { commandCalls += 1; } }).tickOnce();
    expect(commandCalls).toBe(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(1);
  });

  it("bounds consecutive launcher failures without consuming a stage execution attempt", async () => {
    const fixture = await seedResearchOutbox(2);
    const reconciler = createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => undefined,
    });
    expect((await reconciler.tickOnce()).outbox).toEqual(expect.arrayContaining([expect.objectContaining({ status: "retry_scheduled" })]));
    await db.update(profitFlywheelEvents).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(profitFlywheelEvents.id, fixture.event.id));
    expect((await reconciler.tickOnce()).outbox).toEqual(expect.arrayContaining([expect.objectContaining({ status: "blocked_retry_exhausted" })]));
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0])).toMatchObject({
      state: "blocked",
      attemptCount: 0,
      blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      blockerDetail: expect.stringContaining("profit_flywheel_pos_executor_exit_without_progress"),
      nextOwner: "portfolio_os_runtime_owner",
    });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0])).toMatchObject({
      attemptCount: 2,
      processedAt: expect.any(Date),
      lastError: expect.stringContaining("profit_flywheel_pos_executor_exit_without_progress"),
    });
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId)).then((rows) => rows[0]!.title)).toContain("profit_flywheel_pos_executor_retry_exhausted");
  });

  it("survives two complete launcher-exhaustion generations with distinct actionable blockers", async () => {
    const fixture = await seedResearchOutbox(2);
    const orchestratorId = randomUUID();
    await db.insert(agents).values({
      id: orchestratorId,
      companyId: fixture.companyId,
      name: "Portfolio OS Orchestrator",
      role: "orchestrator",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(profitFlywheelWorkflows).set({ portfolioOsExecutorAgentId: orchestratorId })
      .where(eq(profitFlywheelWorkflows.id, fixture.workflow.id));
    let launcherCalls = 0;
    const reconciler = createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        launcherCalls += 1;
        throw new Error(`generation-scoped launcher failure ${launcherCalls}`);
      },
    });
    const exhaustGeneration = async () => {
      expect((await reconciler.tickOnce()).outbox).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "retry_scheduled" }),
      ]));
      await db.update(profitFlywheelEvents).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(profitFlywheelEvents.id, fixture.event.id));
      expect((await reconciler.tickOnce()).outbox).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "blocked_retry_exhausted" }),
      ]));
    };

    await exhaustGeneration();
    const firstBlocked = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(firstBlocked).toMatchObject({
      state: "blocked",
      attemptCount: 0,
      blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      blockerDetail: expect.stringContaining("generation-scoped launcher failure 2"),
    });
    await profitFlywheelService(db).resumePortfolioOsOutbox({
      companyId: fixture.companyId,
      eventId: fixture.event.id,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      inputHash: fixture.stage.inputHash,
      expectedBlockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      principal: { type: "agent", id: orchestratorId },
    });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id))
      .then((rows) => rows[0])).toMatchObject({
        attemptCount: 0,
        processedAt: null,
        payload: expect.objectContaining({ launcher_retry_generation: 1, launcher_attempt_count: 0 }),
      });

    await exhaustGeneration();
    const secondBlocked = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(secondBlocked).toMatchObject({
      state: "blocked",
      attemptCount: 0,
      blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      blockerDetail: expect.stringContaining("generation-scoped launcher failure 4"),
    });
    const durableEvents = await db.select().from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.stageRunId, fixture.stage.id));
    const blockedEvents = durableEvents.filter((event) => event.eventType === "stage_blocked");
    expect(blockedEvents).toHaveLength(2);
    expect(blockedEvents.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ launcher_retry_generation: 0, launcher_attempt_count: 2 }),
      expect.objectContaining({ launcher_retry_generation: 1, launcher_attempt_count: 2 }),
    ]));
    expect(new Set(blockedEvents.map((event) => event.dedupeKey)).size).toBe(2);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id))
      .then((rows) => rows[0])).toMatchObject({
        attemptCount: 2,
        processedAt: expect.any(Date),
        payload: expect.objectContaining({ launcher_retry_generation: 1, launcher_attempt_count: 2 }),
      });
  });

  it("redacts the final launcher failure before persisting an exhausted blocker", async () => {
    const fixture = await seedResearchOutbox(1);
    const bareSecret = "api-key-value-that-is-long-and-distinct";
    const result = await createTestReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { throw new Error(`child stderr: ${bareSecret}`); },
    }).tickOnce();

    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "blocked_retry_exhausted" }),
    ]));
    const blocked = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(blocked.blockerDetail).toContain("REDACTED");
    expect(blocked.blockerDetail).not.toContain(bareSecret);
    const event = await db.select().from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!);
    expect(event.lastError).toContain("REDACTED");
    expect(event.lastError).not.toContain(bareSecret);
  });

  it("rejects generic board authorization and generic claims for Portfolio OS-owned stages", async () => {
    const fixture = await seedResearchOutbox();
    const service = profitFlywheelService(db);
    await expect(service.claimStage({
      stageRunId: fixture.stage.id,
      actorType: "board",
      actorId: "board-user",
    })).rejects.toThrow("identity-bound outbox acknowledgement flow");
    await expect(service.acknowledgePortfolioOsOutbox({
      companyId: fixture.companyId,
      eventId: fixture.event.id,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      stage: "research_intake",
      inputHash: fixture.stage.inputHash,
      state: "blocked",
      blocker: {
        blockerCode: "test_blocker",
        blockerDetail: "test blocker",
        nextOwner: "test_owner",
        resumeCondition: "repair and retry",
      },
      principal: { type: "board", id: "board-user" },
    })).rejects.toThrow("dedicated Portfolio OS Orchestrator agent");
  });

  it("claims a failing completion event once under concurrent processors", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    const invalid = await db.insert(profitFlywheelEvents).values({
      companyId: fixture.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      eventType: "stage_succeeded",
      dedupeKey: `invalid-success:${fixture.stage.id}`,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: fixture.stage.spanId,
      payload: { stage: "not_a_stage", output_hash: "f".repeat(64) },
      nextAttemptAt: new Date(Date.now() - 1000),
    }).returning().then((rows) => rows[0]!);
    const service = profitFlywheelService(db);
    await Promise.all([service.processPendingEvents(), service.processPendingEvents()]);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, invalid.id)).then((rows) => rows[0])).toMatchObject({
      attemptCount: 1,
      processedAt: null,
    });
  });

  it("retries rather than consuming a succeeded event with an unknown transition trigger", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    const outputHash = "f".repeat(64);
    await db.update(profitFlywheelStageRuns).set({
      state: "succeeded",
      feedback: { output_hash: outputHash },
      completedAt: new Date(),
    }).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    for (const receiptType of fixture.contract.stages.research_intake.required_receipts) {
      const observedAt = new Date();
      const schemaVersion = `paperclip.${receiptType}.v2`;
      const attributes = {};
      const contentHash = canonicalProfitFlywheelReceiptHash({
        type: receiptType,
        schemaVersion,
        artifactRef: null,
        observedAt: observedAt.toISOString(),
        expiresAt: null,
        attributes,
      });
      await db.insert(profitFlywheelReceipts).values({
        companyId: fixture.companyId,
        workflowId: fixture.workflow.id,
        stageRunId: fixture.stage.id,
        receiptType,
        schemaVersion,
        contentHash,
        artifactRef: null,
        status: "valid",
        observedAt,
        attributes,
        correlationId: fixture.workflow.correlationId,
        traceId: fixture.workflow.traceId,
        spanId: fixture.stage.spanId,
      });
    }
    const event = await db.insert(profitFlywheelEvents).values({
      companyId: fixture.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      eventType: "stage_succeeded",
      dedupeKey: `unknown-trigger:${fixture.stage.id}`,
      fromState: "running",
      toState: "succeeded",
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: fixture.stage.spanId,
      payload: { stage: "research_intake", output_hash: outputHash, trigger: "unknown_fixture_trigger" },
      nextAttemptAt: new Date(Date.now() - 1_000),
    }).returning().then((rows) => rows[0]!);

    expect(await profitFlywheelService(db).processPendingEvents()).toEqual([
      expect.objectContaining({ eventId: event.id, action: "retry", error: expect.stringContaining("No contract transition exists") }),
    ]);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 1, processedAt: null, lastError: expect.stringContaining("unknown_fixture_trigger") });
  });

  it("atomically terminalizes poisoned completion-event exhaustion with one durable blocker", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    const invalid = await db.insert(profitFlywheelEvents).values({
      companyId: fixture.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      eventType: "stage_succeeded",
      dedupeKey: `terminal-invalid-success:${fixture.stage.id}`,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: fixture.stage.spanId,
      payload: { stage: "not_a_stage", output_hash: "f".repeat(64) },
      attemptCount: 4,
      nextAttemptAt: new Date(Date.now() - 1_000),
    }).returning().then((rows) => rows[0]!);
    const torn = profitFlywheelService(db, {
      terminalOutboxReconciliationBeforeAppend: () => {
        throw new Error("injected completion exhaustion append failure");
      },
    });
    await expect(torn.processPendingEvents()).rejects.toThrow("injected completion exhaustion append failure");
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, invalid.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 4, processedAt: null });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "running", blockerCode: null });
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(0);

    const service = profitFlywheelService(db);
    await Promise.all([service.processPendingEvents(), service.processPendingEvents()]);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, invalid.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 5, processedAt: expect.any(Date), lastError: expect.stringContaining("invalid stage") });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: "profit_flywheel_event_retry_exhausted" });
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toEqual([
      expect.objectContaining({
        status: "blocked",
        originKind: "profit_flywheel_transition_blocker",
        originId: fixture.workflow.id,
      }),
    ]);
    expect((await db.select().from(profitFlywheelEvents)).filter((event) => event.eventType === "event_retry_exhausted"))
      .toHaveLength(1);
  });

  it("cannot resurrect an expired lease and orphan recovery rechecks it under lock", async () => {
    const fixture = await seedResearchOutbox();
    const service = profitFlywheelService(db);
    const claimed = await service.claimStage({
      stageRunId: fixture.stage.id,
      actorType: "system",
      actorId: "profit-flywheel-pos-reconciler",
      portfolioOsAuthority: true,
    });
    const expiredAt = new Date(Date.now() - 1000);
    await db.update(profitFlywheelStageRuns).set({ leaseExpiresAt: expiredAt }).where(eq(profitFlywheelStageRuns.id, claimed.id));
    await db.update(profitFlywheelLeases).set({ expiresAt: expiredAt }).where(eq(profitFlywheelLeases.stageRunId, claimed.id));
    await expect(service.heartbeatStage({ stageRunId: claimed.id, leaseOwner: claimed.leaseOwner! }))
      .rejects.toThrow("missing, expired, or owned by another worker");
    await service.recoverOrphans({ now: new Date() });
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, claimed.id)).then((rows) => rows[0]!.state)).toBe("retry");

    await db.update(profitFlywheelStageRuns).set({ retryAt: new Date(Date.now() - 1) })
      .where(eq(profitFlywheelStageRuns.id, claimed.id));
    const reclaimed = await service.claimStage({
      stageRunId: fixture.stage.id,
      actorType: "system",
      actorId: "profit-flywheel-pos-reconciler",
      portfolioOsAuthority: true,
    });
    expect(reclaimed.leaseOwner).not.toBe(claimed.leaseOwner);
    await expect(service.heartbeatStage({ stageRunId: reclaimed.id, leaseOwner: claimed.leaseOwner! }))
      .rejects.toThrow("missing, expired, or owned by another worker");
  });

  it("atomically rebinds an unclaimed stage to a newer canonical provider policy", async () => {
    const fixture = await seedResearchOutbox();
    const policy = await loadProviderPolicyV2();
    const priorSha256 = "1".repeat(64);
    await db.update(profitFlywheelWorkflows).set({
      feedback: {
        ...fixture.workflow.feedback as Record<string, unknown>,
        provider_policy: {
          path: policy.path,
          sha256: priorSha256,
          schema_version: "provider-policy.v2",
          schema_path: policy.schemaPath,
          schema_sha256: policy.schemaSha256,
        },
      },
    }).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id));

    const claimed = await profitFlywheelService(db).claimStage({
      stageRunId: fixture.stage.id,
      actorType: "system",
      actorId: "profit-flywheel-pos-reconciler",
      portfolioOsAuthority: true,
    });

    expect(claimed.state).toBe("running");
    const reboundWorkflow = await db.select().from(profitFlywheelWorkflows)
      .where(eq(profitFlywheelWorkflows.id, fixture.workflow.id)).then((rows) => rows[0]!);
    expect(reboundWorkflow.feedback).toMatchObject({
      provider_policy: {
        sha256: policy.sha256,
        schema_sha256: policy.schemaSha256,
        schema_version: "provider-policy.v2",
      },
      provider_policy_rebindings: [{
        prior_sha256: priorSha256,
        current_sha256: policy.sha256,
        reason: "unclaimed_stage_canonical_policy_advance",
        stage_run_id: fixture.stage.id,
      }],
    });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.workflowId, fixture.workflow.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        eventType: "provider_policy_rebound",
        stageRunId: fixture.stage.id,
      })]));
  });

  it("redacts secret-shaped failure detail from stage, workflow, and event persistence", async () => {
    const fixture = await seedResearchOutbox();
    const service = profitFlywheelService(db);
    const claimed = await service.claimStage({
      stageRunId: fixture.stage.id,
      actorType: "system",
      actorId: "profit-flywheel-pos-reconciler",
      portfolioOsAuthority: true,
    });
    const sentinel = "Bearer abcdefghijklmnopqrstuvwxyz";
    await service.failStage({
      stageRunId: claimed.id,
      failureClass: "process_interrupted",
      detail: sentinel,
      expectedLease: { leaseOwner: claimed.leaseOwner, actorType: "system", actorId: "profit-flywheel-pos-reconciler" },
    });
    const persisted = JSON.stringify({
      stage: await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, claimed.id)).then((rows) => rows[0]),
      workflow: await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id)).then((rows) => rows[0]),
      events: await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.stageRunId, claimed.id)),
    });
    expect(persisted).toContain("REDACTED");
    expect(persisted).not.toContain(sentinel);
  });

  it("isolates a poisoned Paperclip stage dispatch and still wakes the later stage", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    await db.delete(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: fixture.companyId,
      name: "Implementation Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    await db.insert(issues).values([
      { id: firstIssueId, companyId: fixture.companyId, projectId: fixture.workflow.projectId, title: "Poisoned dispatch", status: "todo", priority: "high", assigneeAgentId: agentId },
      { id: secondIssueId, companyId: fixture.companyId, projectId: fixture.workflow.projectId, title: "Healthy dispatch", status: "todo", priority: "high", assigneeAgentId: agentId },
    ]);
    const createImplementation = async (issueId: string, marker: string, createdAt: Date) => {
      const sourceHashes = Object.fromEntries(fixture.contract.stages.implementation.input_hash_fields.map((field) =>
        [field, hashProfitFlywheelValue({ field, marker })]));
      const canonical = buildProfitFlywheelStageInput({ contract: fixture.contract, stage: "implementation", sourceHashes });
      return db.insert(profitFlywheelStageRuns).values({
        workflowId: fixture.workflow.id,
        companyId: fixture.companyId,
        stage: "implementation",
        state: "pending",
        ownerPlane: "paperclip",
        inputSchemaVersion: fixture.contract.stages.implementation.input_schema,
        inputHash: canonical.inputHash,
        sourceHashes: canonical.sourceHashes,
        idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId: fixture.companyId, runId: fixture.workflow.runId, stage: "implementation", inputHash: canonical.inputHash }),
        maxAttempts: 3,
        linkedIssueId: issueId,
        providerCapabilityClass: fixture.contract.stages.implementation.provider_capability_class,
        concurrencyKey: fixture.contract.stages.implementation.concurrency_key,
        concurrencyLimit: fixture.contract.stages.implementation.concurrency_limit,
        requiredReceipts: fixture.contract.stages.implementation.required_receipts,
        completionEvidence: fixture.contract.stages.implementation.completion_evidence,
        correlationId: fixture.workflow.correlationId,
        traceId: fixture.workflow.traceId,
        spanId: createHash("sha256").update(`dispatch:${marker}`).digest("hex").slice(0, 16),
        createdAt,
        updatedAt: createdAt,
      }).returning().then((rows) => rows[0]!);
    };
    const first = await createImplementation(firstIssueId, "poisoned", new Date(Date.now() - 1_000));
    const second = await createImplementation(secondIssueId, "healthy", new Date());
    const wakes: string[] = [];
    const result = await profitFlywheelService(db, {
      ...allowTestFactoryServiceDeps,
      dispatchWakeup: async (_agentId, input) => {
        const issueId = String(input.contextSnapshot.issueId);
        wakes.push(issueId);
        if (issueId === firstIssueId) throw new Error("poisoned wake fixture");
        return { id: randomUUID() };
      },
    }).dispatchPendingStages({ workflowId: fixture.workflow.id });
    expect(wakes).toEqual([firstIssueId, secondIssueId]);
    expect(result).toEqual([expect.objectContaining({ stageRunId: second.id, issueId: secondIssueId })]);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, first.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "pending", dispatchClaimId: null, dispatchClaimedAt: null });
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, second.id)).then((rows) => rows[0]!.dispatchClaimId))
      .not.toBeNull();
  });

  it("blocks a linked unassigned Paperclip stage without waking an unclaimable fallback agent", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    await db.delete(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: fixture.companyId,
      name: "Fallback Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: fixture.companyId,
      projectId: fixture.workflow.projectId,
      title: "Unassigned implementation",
      status: "todo",
      priority: "high",
      assigneeAgentId: null,
    });
    const sourceHashes = Object.fromEntries(fixture.contract.stages.implementation.input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, issueId })]));
    const canonical = buildProfitFlywheelStageInput({ contract: fixture.contract, stage: "implementation", sourceHashes });
    const stage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: fixture.workflow.id,
      companyId: fixture.companyId,
      stage: "implementation",
      state: "pending",
      ownerPlane: "paperclip",
      inputSchemaVersion: fixture.contract.stages.implementation.input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId: fixture.companyId, runId: fixture.workflow.runId, stage: "implementation", inputHash: canonical.inputHash }),
      maxAttempts: 3,
      linkedIssueId: issueId,
      providerCapabilityClass: fixture.contract.stages.implementation.provider_capability_class,
      concurrencyKey: fixture.contract.stages.implementation.concurrency_key,
      concurrencyLimit: fixture.contract.stages.implementation.concurrency_limit,
      requiredReceipts: fixture.contract.stages.implementation.required_receipts,
      completionEvidence: fixture.contract.stages.implementation.completion_evidence,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: createHash("sha256").update(`unassigned:${issueId}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    let wakes = 0;
    await profitFlywheelService(db, {
      ...allowTestFactoryServiceDeps,
      dispatchWakeup: async () => {
        wakes += 1;
        return { id: randomUUID() };
      },
    }).dispatchPendingStages({ workflowId: fixture.workflow.id });

    expect(wakes).toBe(0);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: "profit_flywheel_stage_agent_missing", dispatchClaimId: null });
  });

  it("idempotently resumes a repaired Paperclip blocker and dispatches exactly once", async () => {
    const fixture = await seedResearchOutbox();
    await db.delete(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id));
    await db.delete(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    const sourceHashes = Object.fromEntries(fixture.contract.stages.implementation.input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, implementation: fixture.companyId })]));
    const canonical = buildProfitFlywheelStageInput({ contract: fixture.contract, stage: "implementation", sourceHashes });
    const implementation = await db.insert(profitFlywheelStageRuns).values({
      workflowId: fixture.workflow.id,
      companyId: fixture.companyId,
      stage: "implementation",
      state: "pending",
      ownerPlane: "paperclip",
      inputSchemaVersion: fixture.contract.stages.implementation.input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId: fixture.companyId, runId: fixture.workflow.runId, stage: "implementation", inputHash: canonical.inputHash }),
      maxAttempts: 3,
      providerCapabilityClass: fixture.contract.stages.implementation.provider_capability_class,
      concurrencyKey: fixture.contract.stages.implementation.concurrency_key,
      concurrencyLimit: fixture.contract.stages.implementation.concurrency_limit,
      requiredReceipts: fixture.contract.stages.implementation.required_receipts,
      completionEvidence: fixture.contract.stages.implementation.completion_evidence,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: createHash("sha256").update(`implementation:${fixture.companyId}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    await db.update(profitFlywheelWorkflows).set({ currentStage: "implementation" }).where(eq(profitFlywheelWorkflows.id, fixture.workflow.id));
    const wakes: string[] = [];
    const service = profitFlywheelService(db, {
      ...allowTestFactoryServiceDeps,
      dispatchWakeup: async (agentId) => {
        wakes.push(agentId);
        return { id: randomUUID() };
      },
    });
    await service.dispatchPendingStages({ workflowId: fixture.workflow.id });
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, implementation.id)).then((rows) => rows[0])).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_stage_agent_missing",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: fixture.companyId,
      name: "Implementation Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const blockerReceipt = await db.select().from(profitFlywheelReceipts)
      .where(eq(profitFlywheelReceipts.stageRunId, implementation.id))
      .then((rows) => rows.find((row) => row.receiptType === "paperclip_stage_blocker_receipt")!);
    await expect(service.resumePaperclipStage({
      companyId: fixture.companyId,
      stageRunId: implementation.id,
      inputHash: implementation.inputHash,
      expectedBlockerCode: "profit_flywheel_stage_agent_missing",
      expectedReceiptId: randomUUID(),
      expectedReceiptHash: blockerReceipt.contentHash,
      principal: { type: "board", id: "board-user" },
    })).rejects.toMatchObject({ code: "profit_flywheel_resume_receipt_invalid" });
    const resume = () => service.resumePaperclipStage({
      companyId: fixture.companyId,
      stageRunId: implementation.id,
      inputHash: implementation.inputHash,
      expectedBlockerCode: "profit_flywheel_stage_agent_missing",
      expectedReceiptId: blockerReceipt.id,
      expectedReceiptHash: blockerReceipt.contentHash,
      principal: { type: "board", id: "board-user" },
    });
    const results = await Promise.all([resume(), resume()]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_resumed", "resumed"]);
    expect(wakes).toEqual([agentId]);
  });
});
