import { createHash, randomUUID } from "node:crypto";
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

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

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
    const reconciler = createProfitFlywheelReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null }).where(eq(profitFlywheelEvents.id, fixture.event.id));
      },
    });
    const [left, right] = await Promise.all([reconciler.tickOnce(), reconciler.tickOnce()]);
    expect(calls).toBe(1);
    expect([...left.outbox, ...right.outbox].map((entry) => entry.status)).toEqual(expect.arrayContaining(["executed", "already_claimed"]));
    expect((await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!.processedAt))).not.toBeNull();
  });

  it.each([
    "evidence_normalization",
    "commercial_validation",
    "council_decision",
    "dispatch",
  ] as const)("routes %s through the exact isolated Portfolio OS stage plane", async (stageName) => {
    const fixture = await seedResearchOutbox(2, stageName);
    const observed: Array<{ plane: string; env: Record<string, string> }> = [];
    const result = await createProfitFlywheelReconciler(db, {
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
    const result = await createProfitFlywheelReconciler(db, {
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
    const first = createProfitFlywheelReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => { throw new Error(`child stderr: ${bareSecret}`); },
    });
    await first.tickOnce();
    const retried = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]!);
    expect(retried.attemptCount).toBe(1);
    expect(retried.lastError).toContain("REDACTED");
    expect(retried.lastError).not.toContain(bareSecret);
    await db.update(profitFlywheelEvents).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(profitFlywheelEvents.id, fixture.event.id));
    const restarted = createProfitFlywheelReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null }).where(eq(profitFlywheelEvents.id, fixture.event.id));
      },
    });
    expect((await restarted.tickOnce()).outbox).toEqual(expect.arrayContaining([expect.objectContaining({ status: "executed" })]));
  });

  it("retries only the still-due suffix when a child acknowledges part of a batch before crashing", async () => {
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
    const result = await createProfitFlywheelReconciler(db, {
      resolveRuntimeSecrets: validSecrets,
      runCommand: async () => {
        await db.update(profitFlywheelEvents).set({ processedAt: new Date(), lastError: null })
          .where(eq(profitFlywheelEvents.id, fixture.event.id));
        throw new Error("child crashed after acknowledging first event");
      },
    }).tickOnce();
    expect(result.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "retry_scheduled", events: 1 }),
    ]));
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, fixture.event.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 2, lastError: null });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, siblingEvent.id)).then((rows) => rows[0]))
      .toMatchObject({ attemptCount: 1, processedAt: null });
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
    const result = await createProfitFlywheelReconciler(db, {
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
    await createProfitFlywheelReconciler(db, { resolveRuntimeSecrets, runCommand: async () => { commandCalls += 1; } }).tickOnce();
    expect(commandCalls).toBe(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId))).toHaveLength(1);
  });

  it("bounds consecutive launcher failures without consuming a stage execution attempt", async () => {
    const fixture = await seedResearchOutbox(2);
    const reconciler = createProfitFlywheelReconciler(db, {
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
      nextOwner: "portfolio_os_runtime_owner",
    });
    expect(await db.select().from(issues).where(eq(issues.companyId, fixture.companyId)).then((rows) => rows[0]!.title)).toContain("profit_flywheel_pos_executor_retry_exhausted");
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
    const service = profitFlywheelService(db, { dispatchWakeup: async (agentId) => {
      wakes.push(agentId);
      return { id: randomUUID() };
    } });
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
    const resume = () => service.resumePaperclipStage({
      companyId: fixture.companyId,
      stageRunId: implementation.id,
      inputHash: implementation.inputHash,
      expectedBlockerCode: "profit_flywheel_stage_agent_missing",
      principal: { type: "board", id: "board-user" },
    });
    const results = await Promise.all([resume(), resume()]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_resumed", "resumed"]);
    expect(wakes).toEqual([agentId]);
  });
});
