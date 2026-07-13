import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";
import {
  buildProfitFlywheelIdempotencyKey,
  buildProfitFlywheelStageInput,
  hashProfitFlywheelValue,
  profitFlywheelService,
} from "../services/profit-flywheel.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("Profit Flywheel exact-once Paperclip stage dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(heartbeatRuns);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelLeases);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    for (const root of tempRoots) await rm(root, { recursive: true, force: true });
    tempRoots.clear();
  });

  afterAll(async () => tempDb?.cleanup());

  it("coalesces concurrent dispatchers into one wake for the pre-linked authoritative issue", async () => {
    const contract = await loadProfitFlywheelContract();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Dispatch tenant",
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Portfolio OS Orchestrator",
      role: "orchestrator",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementation Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Profit Flywheel" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      assigneeAgentId: agentId,
      title: "Authoritative execution issue",
      status: "todo",
      priority: "high",
    });
    const suffix = randomUUID();
    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId,
      projectId,
      runId: `run-${suffix}`,
      state: "running",
      currentStage: "implementation",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: `/tmp/${suffix}-dispatch.json`,
      sourceDispatchHash: "d".repeat(64),
      targetRepo: "fixture/profit-flywheel",
      targetWorkspaceRoot: "/tmp",
      contractPath: contract.path,
      contractSha256: contract.sha256,
      contractSnapshot: contract.contract as unknown as Record<string, unknown>,
      correlationId: `profit:${suffix}`,
      traceId: createHash("sha256").update(suffix).digest("hex").slice(0, 32),
    }).returning().then((rows) => rows[0]!);
    const sourceHashes = Object.fromEntries(
      contract.contract.stages.implementation.input_hash_fields.map((field) => [field, hashProfitFlywheelValue({ field, suffix })]),
    );
    const canonical = buildProfitFlywheelStageInput({ contract: contract.contract, stage: "implementation", sourceHashes });
    const stage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: workflow.id,
      companyId,
      stage: "implementation",
      state: "pending",
      ownerPlane: "paperclip",
      inputSchemaVersion: contract.contract.stages.implementation.input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId, runId: workflow.runId, stage: "implementation", inputHash: canonical.inputHash }),
      maxAttempts: Math.max(1, contract.contract.stages.implementation.retry.limit + 1),
      linkedIssueId: issueId,
      providerCapabilityClass: contract.contract.stages.implementation.provider_capability_class,
      concurrencyKey: contract.contract.stages.implementation.concurrency_key,
      concurrencyLimit: contract.contract.stages.implementation.concurrency_limit,
      requiredReceipts: contract.contract.stages.implementation.required_receipts,
      completionEvidence: contract.contract.stages.implementation.completion_evidence,
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: createHash("sha256").update(`span:${suffix}`).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);

    const wakes: Array<{ agentId: string; input: Record<string, unknown>; runId: string }> = [];
    const dispatchWakeup = async (wakeAgentId: string, input: Record<string, unknown>) => {
      const runId = randomUUID();
      wakes.push({ agentId: wakeAgentId, input, runId });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { id: runId };
    };
    const service = profitFlywheelService(db, {
      dispatchWakeup,
      providerBlockedStageRouteAvailable: async () => true,
    });
    const [left, right] = await Promise.all([
      service.dispatchPendingStages({ workflowId: workflow.id }),
      service.dispatchPendingStages({ workflowId: workflow.id }),
    ]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId,
      input: {
        idempotencyKey: `profit-flywheel-stage:${stage.id}:attempt-1`,
        requestedByActorId: `profit-flywheel:${stage.id}`,
      },
    });
    expect([...left, ...right]).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    const persisted = await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]!);
    expect(persisted.dispatchClaimId).not.toBeNull();
    expect(persisted.feedback).toMatchObject({ heartbeat_run_id: wakes[0]!.runId });

    expect(await service.releaseDispatchClaimAfterHeartbeatSetupFailure({
      stageRunId: stage.id,
      heartbeatRunId: randomUUID(),
      failureClass: "provider_auth",
      detail: "wrong heartbeat must not release the claim",
    })).toBe(false);
    expect(await service.releaseDispatchClaimAfterHeartbeatSetupFailure({
      stageRunId: stage.id,
      heartbeatRunId: wakes[0]!.runId,
      failureClass: "provider_unavailable",
      failureCode: "provider_policy_no_capable_route",
      detail: "No capable route remains for alias code_deep",
    })).toBe(true);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({
        state: "blocked",
        dispatchClaimId: null,
        dispatchClaimedAt: null,
        blockerCode: "provider_policy_no_capable_route",
        nextOwner: "paperclip_provider_operator",
        feedback: { dispatch_setup_failure: { heartbeat_run_id: wakes[0]!.runId, failure_code: "provider_policy_no_capable_route" } },
      });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: "provider_policy_no_capable_route" });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status)).toBe("blocked");
    expect(await service.dispatchPendingStages({ workflowId: workflow.id })).toHaveLength(0);
    expect(wakes).toHaveLength(1);
    expect(await service.recoverProviderBlockedStages()).toEqual([
      { stageRunId: stage.id, workflowId: workflow.id, stage: "implementation" },
    ]);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "pending", blockerCode: null, nextOwner: null });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "running", blockerCode: null });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status)).toBe("todo");
    expect(await service.dispatchPendingStages({ workflowId: workflow.id })).toHaveLength(1);
    expect(wakes).toHaveLength(2);

    const leaseOwner = `system:${wakes[1]!.runId}:retry-fixture`;
    await db.update(profitFlywheelStageRuns).set({
      state: "running",
      attemptCount: 1,
      dispatchClaimId: null,
      dispatchClaimedAt: null,
      leaseOwner,
      leaseActorType: "system",
      leaseActorId: wakes[1]!.runId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
    }).where(eq(profitFlywheelStageRuns.id, stage.id));
    const failureNow = new Date(Date.now() - 60 * 60 * 1000);
    await service.failStage({
      stageRunId: stage.id,
      failureClass: "process_interrupted",
      detail: "server-observed process loss after the first wake",
      expectedLease: { leaseOwner, actorType: "system", actorId: wakes[1]!.runId },
      now: failureNow,
    });
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0])).toMatchObject({
      state: "retry",
      attemptCount: 1,
    });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status)).toBe("blocked");

    const retryNow = new Date();
    const [retryLeft, retryRight] = await Promise.all([
      service.dispatchPendingStages({ workflowId: workflow.id, now: retryNow }),
      service.dispatchPendingStages({ workflowId: workflow.id, now: retryNow }),
    ]);
    expect([...retryLeft, ...retryRight]).toHaveLength(1);
    expect(wakes).toHaveLength(3);
    expect(wakes[2]).toMatchObject({
      agentId,
      input: {
        idempotencyKey: `profit-flywheel-stage:${stage.id}:attempt-2`,
        requestedByActorId: `profit-flywheel:${stage.id}`,
      },
    });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status)).toBe("todo");
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, workflow.id)).then((rows) => rows[0])).toMatchObject({
      state: "running",
      currentStage: "implementation",
      blockerCode: null,
    });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.stageRunId, stage.id))
      .then((rows) => rows.filter((row) => row.eventType === "stage_retry_dispatched"))).toHaveLength(1);

    await db.update(profitFlywheelStageRuns).set({
      state: "blocked",
      attemptCount: stage.maxAttempts,
      dispatchClaimId: null,
      dispatchClaimedAt: null,
      blockerCode: "provider_policy_no_capable_route",
      blockerDetail: "No capable route remains for alias code_deep",
      nextOwner: "paperclip_provider_operator",
      resumeCondition: "Restore a fresh healthy policy-valid route",
    }).where(eq(profitFlywheelStageRuns.id, stage.id));
    expect(await service.recoverProviderBlockedStages()).toEqual([]);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", attemptCount: stage.maxAttempts, blockerCode: "provider_policy_no_capable_route" });

    await db.update(profitFlywheelStageRuns).set({ state: "pending" }).where(eq(profitFlywheelStageRuns.id, stage.id));
    expect(await service.dispatchPendingStages({ workflowId: workflow.id })).toEqual([]);
    expect(wakes).toHaveLength(3);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({
        state: "blocked",
        attemptCount: stage.maxAttempts,
        blockerCode: "profit_flywheel_retry_exhausted",
        nextOwner: "paperclip_board_operator",
      });
  });

  it("coalesces concurrent startFromDispatch calls into one exact workflow and rejects replay drift", async () => {
    const contract = await loadProfitFlywheelContract();
    const policy = await loadProviderPolicyV2();
    const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-profit-start-race-")));
    tempRoots.add(workspaceRoot);
    const dispatchPath = path.join(workspaceRoot, "dispatch.json");
    const dispatchBytes = "{\"immutable\":true}\n";
    await writeFile(dispatchPath, dispatchBytes, { mode: 0o444 });
    await chmod(dispatchPath, 0o444);
    const dispatchHash = createHash("sha256").update(dispatchBytes).digest("hex");
    const selectionSnapshotHash = "1".repeat(64);
    const commercialGateHash = "2".repeat(64);
    const decisionArtifactHash = "3".repeat(64);
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = `dispatch-race-${randomUUID()}`;
    const correlationId = `profit:${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Dispatch race tenant",
      issuePrefix: `DR${companyId.replaceAll("-", "").slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Portfolio OS Orchestrator",
      role: "orchestrator",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Dispatch race" });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "primary",
      cwd: workspaceRoot,
      repoUrl: "https://example.invalid/fixture/dispatch-race.git",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Dispatch-backed implementation",
      status: "todo",
      priority: "high",
    });
    const sourceHashes = Object.fromEntries(contract.contract.stages.dispatch.input_hash_fields.map((field) => {
      if (field === "selection_hash") return [field, selectionSnapshotHash];
      if (field === "commercial_gate_hash") return [field, commercialGateHash];
      if (field === "decision_artifact_hash") return [field, decisionArtifactHash];
      return [field, createHash("sha256").update(field).digest("hex")];
    }));
    const canonical = buildProfitFlywheelStageInput({ contract: contract.contract, stage: "dispatch", sourceHashes });
    const feedbackFingerprint = "4".repeat(64);
    const artifact = {
      path: dispatchPath,
      raw: dispatchBytes,
      value: {},
      byteHash: selectionSnapshotHash,
      stableHash: selectionSnapshotHash,
    };
    const dispatch = {
      company: companyId,
      paperclip: { company_id: companyId, project_id: projectId },
      input_hash: canonical.inputHash,
      idempotency_key: `${companyId}+${runId}+dispatch+${canonical.inputHash}`,
      source_hashes: canonical.sourceHashes,
      contract: {
        path: contract.path,
        schema_path: contract.schemaPath,
        sha256: contract.sha256,
        schema_sha256: contract.schemaSha256,
        schema_version: contract.contract.schema_version,
      },
      provider_policy: {
        path: policy.path,
        sha256: policy.sha256,
        schema_version: "provider-policy.v2",
        schema_path: policy.schemaPath,
        schema_sha256: policy.schemaSha256,
      },
      artifact_provenance_hashes: {
        contract_sha256: contract.sha256,
        contract_schema_sha256: contract.schemaSha256,
        selection_snapshot_sha256: selectionSnapshotHash,
        commercial_gate_sha256: commercialGateHash,
        provider_policy_sha256: policy.sha256,
        provider_policy_schema_sha256: policy.schemaSha256,
      },
      target: { base_sha: "5".repeat(40), workspace_fingerprint: feedbackFingerprint },
    };
    const evidence = {
      dispatch,
      selection: artifact,
      dossier: artifact,
      commercial: {
        ...artifact,
        value: {
          summary: { recommendation: "ship" },
          source_registry_set_hash: "6".repeat(64),
        },
      },
      commercialGateHash,
      authorityRoot: workspaceRoot,
    };
    const service = profitFlywheelService(db, {
      dispatchWakeup: async () => ({ id: randomUUID() }),
      dispatchEvidenceValidator: async () => evidence as any,
      researchRegistryAuthorityLoader: async () => ({
        schema_version: "paperclip.research_registry_authority.v1",
        registry: { path: "/authority/research_sources.yaml", sha256: "7".repeat(64), schema_version: "pos.research_sources.v2" },
      }),
    });
    const startInput = {
      companyId,
      projectId,
      runId,
      correlationId,
      sourceSchemaVersion: "pos.dispatch.v2" as const,
      sourceDispatchPath: dispatchPath,
      dispatchHash,
      selectionSnapshotHash,
      targetRepo: "fixture/dispatch-race",
      targetRepoUrl: "https://example.invalid/fixture/dispatch-race.git",
      targetWorkspaceRoot: workspaceRoot,
      implementationIssueId: issueId,
      providerPolicy: {
        path: policy.path,
        sha256: policy.sha256,
        schemaVersion: "provider-policy.v2" as const,
        schemaPath: policy.schemaPath,
        schemaSha256: policy.schemaSha256,
      },
      contract,
      policy,
    };

    const [left, right] = await Promise.all([
      service.startFromDispatch(startInput),
      service.startFromDispatch(startInput),
    ]);
    expect(left?.workflow.id).toBe(right?.workflow.id);
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.workflowId, left!.workflow.id))
      .then((rows) => rows.filter((row) => row.stage === "dispatch"))).toHaveLength(1);
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.workflowId, left!.workflow.id))
      .then((rows) => rows.filter((row) => row.stageRunId === left!.stages.find((stage) => stage.stage === "dispatch")!.id))).toHaveLength(2);
    for (const result of [left, right]) {
      expect(result!.stages.find((stage) => stage.stage === "implementation")).toMatchObject({
        sourceHashes: { dispatch_hash: dispatchHash },
        feedback: {
          iteration_dispatch_binding: {
            dispatch_artifact_ref: dispatchPath,
            dispatch_artifact_hash: dispatchHash,
          },
        },
      });
    }
    const persistedDispatch = left!.stages.find((stage) => stage.stage === "dispatch")!;
    const persistedImplementation = left!.stages.find((stage) => stage.stage === "implementation")!;
    const immutableDispatchReceipt = await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, persistedDispatch.id))
      .then((rows) => rows.find((row) => row.receiptType === "immutable_dispatch_artifact")!);
    expect(immutableDispatchReceipt.attributes).toMatchObject({
      workflow_id: left!.workflow.id,
      stage_run_id: persistedDispatch.id,
      input_hash: persistedDispatch.inputHash,
      authoring_inputs: persistedDispatch.sourceHashes,
      dispatch_hash: dispatchHash,
      artifact_hash: dispatchHash,
      issue_id: issueId,
      issue_origin_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(persistedImplementation.sourceHashes).toMatchObject({ dispatch_hash: dispatchHash });
    expect(persistedImplementation.feedback).toMatchObject({
      iteration_dispatch_binding: {
        dispatch_stage_run_id: persistedDispatch.id,
        dispatch_artifact_ref: dispatchPath,
        dispatch_artifact_hash: dispatchHash,
        dispatch_receipt_hash: immutableDispatchReceipt.contentHash,
      },
    });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0])).toMatchObject({
      originKind: "profit_flywheel_dispatch",
      originId: (immutableDispatchReceipt.attributes as Record<string, unknown>).issue_origin_id,
      originRunId: runId,
    });
    expect(left!.workflow).toMatchObject({ sourceDispatchPath: dispatchPath, sourceDispatchHash: dispatchHash });
    await expect(service.startFromDispatch({
      ...startInput,
      targetRepoUrl: "https://example.invalid/fixture/drifted-origin.git",
    })).rejects.toThrow("different immutable dispatch, project, repository, workspace, policy, or contract authority");
  });
});
