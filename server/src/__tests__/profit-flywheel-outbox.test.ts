import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import type { ProfitFlywheelReceiptInput, ProfitFlywheelStage } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { errorHandler } from "../middleware/error-handler.js";
import { profitFlywheelRoutes } from "../routes/profit-flywheel.js";
import { buildResolvedProviderRoute, loadProviderPolicyV2 } from "../services/provider-policy.js";
import {
  buildProfitFlywheelIdempotencyKey,
  buildProfitFlywheelStageInput,
  canonicalProfitFlywheelReceiptHash,
  hashProfitFlywheelValue,
  loadPortfolioOsResearchRegistryAuthority,
  profitFlywheelService,
} from "../services/profit-flywheel.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const execFile = promisify(execFileCallback);

describe("Profit Flywheel cross-language canonical JSON", () => {
  it("matches the Portfolio OS Unicode golden hash", () => {
    expect(hashProfitFlywheelValue({ é: "雪", value: 1.0, nested: ["😀", 2.0] }))
      .toBe("728f65757cad7ec14aa13c740b308a224ecc3d7c947b08ad0fc368bbdbd67ab6");
  });
});

describeDb("Profit Flywheel Portfolio OS durable outbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let artifactRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-outbox-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-profit-outbox-artifacts-"));
  });

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
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  afterAll(async () => tempDb?.cleanup());

  async function immutableArtifact(name: string, value: Record<string, unknown> = { state: "succeeded" }) {
    const artifactPath = path.join(artifactRoot, name);
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(artifactPath, bytes, { mode: 0o444 });
    await chmod(artifactPath, 0o444);
    return { path: await realpath(artifactPath), sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async function seedWorkflow() {
    const loadedContract = await loadProfitFlywheelContract();
    const loadedPolicy = await loadProviderPolicyV2();
    const researchRegistryAuthority = await loadPortfolioOsResearchRegistryAuthority();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Outbox ${companyId.slice(0, 6)}`,
      issuePrefix: `O${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const orchestratorId = randomUUID();
    await db.insert(agents).values({
      id: orchestratorId,
      companyId,
      name: "Portfolio OS Orchestrator",
      role: "orchestrator",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Profit Flywheel" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Execution issue",
      status: "todo",
      priority: "high",
    });
    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId,
      projectId,
      runId: `run-${randomUUID()}`,
      state: "running",
      currentStage: "commercial_observation",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: path.join(artifactRoot, "dispatch.json"),
      sourceDispatchHash: "d".repeat(64),
      targetRepo: "fixture/profit-flywheel",
      targetWorkspaceRoot: artifactRoot,
      contractPath: loadedContract.path,
      contractSha256: loadedContract.sha256,
      contractSnapshot: loadedContract.contract as unknown as Record<string, unknown>,
      correlationId: `profit:${randomUUID()}`,
      traceId: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32),
      portfolioOsExecutorAgentId: orchestratorId,
      feedback: {
        provider_policy: {
          path: loadedPolicy.path,
          sha256: loadedPolicy.sha256,
          schema_version: "provider-policy.v2",
          schema_path: loadedPolicy.schemaPath,
          schema_sha256: loadedPolicy.schemaSha256,
        },
        research_registry_authority: researchRegistryAuthority,
      },
    }).returning().then((rows) => rows[0]!);
    return { companyId, projectId, issueId, orchestratorId, workflow, contract: loadedContract.contract };
  }

  async function seedStage(input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    contract: Awaited<ReturnType<typeof loadProfitFlywheelContract>>["contract"];
    stage: ProfitFlywheelStage;
    state?: string;
    linkedIssueId?: string | null;
    transitionSourceStageRunId?: string | null;
    transitionSourceOutputHash?: string | null;
    feedback?: Record<string, unknown>;
  }) {
    const sourceHashes = Object.fromEntries(
      input.contract.stages[input.stage].input_hash_fields.map((field) => [field, hashProfitFlywheelValue({ field, stage: input.stage })]),
    );
    const canonical = buildProfitFlywheelStageInput({ contract: input.contract, stage: input.stage, sourceHashes });
    return db.insert(profitFlywheelStageRuns).values({
      workflowId: input.workflow.id,
      companyId: input.workflow.companyId,
      stage: input.stage,
      state: input.state ?? "pending",
      ownerPlane: input.contract.stages[input.stage].owner_plane,
      inputSchemaVersion: input.contract.stages[input.stage].input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({
        companyId: input.workflow.companyId,
        runId: input.workflow.runId,
        stage: input.stage,
        inputHash: canonical.inputHash,
      }),
      maxAttempts: Math.max(1, input.contract.stages[input.stage].retry.limit + 1),
      linkedIssueId: input.linkedIssueId ?? null,
      transitionSourceStageRunId: input.transitionSourceStageRunId ?? null,
      transitionSourceOutputHash: input.transitionSourceOutputHash ?? null,
      providerCapabilityClass: input.contract.stages[input.stage].provider_capability_class,
      concurrencyKey: input.contract.stages[input.stage].concurrency_key,
      concurrencyLimit: input.contract.stages[input.stage].concurrency_limit,
      requiredReceipts: input.contract.stages[input.stage].required_receipts,
      completionEvidence: input.contract.stages[input.stage].completion_evidence,
      feedback: input.feedback ?? null,
      correlationId: input.workflow.correlationId,
      traceId: input.workflow.traceId,
      spanId: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
  }

  async function seedOutboxEvent(
    workflow: typeof profitFlywheelWorkflows.$inferSelect,
    stageRun: typeof profitFlywheelStageRuns.$inferSelect,
  ) {
    return db.insert(profitFlywheelEvents).values({
      companyId: workflow.companyId,
      workflowId: workflow.id,
      stageRunId: stageRun.id,
      eventType: "portfolio_os_stage_requested",
      dedupeKey: `stage-requested:${stageRun.id}`,
      toState: "pending",
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: stageRun.spanId,
      payload: { stage: stageRun.stage, input_hash: stageRun.inputHash, source_hashes: stageRun.sourceHashes },
      nextAttemptAt: new Date(Date.now() - 1000),
    }).returning().then((rows) => rows[0]!);
  }

  async function insertReceiptRow(input: {
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    stageRun: typeof profitFlywheelStageRuns.$inferSelect;
    type: string;
    artifactRef: string;
    artifactHash: string;
    attributes?: Record<string, unknown>;
  }) {
    const currentStage = await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, input.stageRun.id)).then((rows) => rows[0]!);
    const observedAt = new Date();
    const schemaVersion = `paperclip.${input.type}.v2`;
    const attributes = { attempt: currentStage.attemptCount, artifact_hash: input.artifactHash, ...(input.attributes ?? {}) };
    const contentHash = canonicalProfitFlywheelReceiptHash({
      type: input.type,
      schemaVersion,
      artifactRef: input.artifactRef,
      observedAt: observedAt.toISOString(),
      expiresAt: null,
      attributes,
    });
    return db.insert(profitFlywheelReceipts).values({
      companyId: input.workflow.companyId,
      workflowId: input.workflow.id,
      stageRunId: input.stageRun.id,
      receiptType: input.type,
      schemaVersion,
      contentHash,
      artifactRef: input.artifactRef,
      status: "valid",
      observedAt,
      attributes,
      correlationId: input.workflow.correlationId,
      traceId: input.workflow.traceId,
      spanId: input.stageRun.spanId,
    }).returning().then((rows) => rows[0]!);
  }

  async function seedQaReleaseLineage(seeded: Awaited<ReturnType<typeof seedWorkflow>>) {
    const qaArtifact = await immutableArtifact("qa-execution.json", { state: "passed", linked_issue_id: seeded.issueId });
    const releaseArtifact = await immutableArtifact("release-execution.json", { state: "succeeded", linked_issue_id: seeded.issueId });
    const qaSeed = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "qa",
      state: "succeeded",
      linkedIssueId: seeded.issueId,
      feedback: { execution_receipt_path: qaArtifact.path, execution_receipt_sha256: qaArtifact.sha256, output_hash: "a".repeat(64) },
    });
    const qa = await db.update(profitFlywheelStageRuns).set({ attemptCount: 1 }).where(eq(profitFlywheelStageRuns.id, qaSeed.id)).returning().then((rows) => rows[0]!);
    const releaseSeed = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "release",
      state: "succeeded",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: qa.id,
      transitionSourceOutputHash: "a".repeat(64),
      feedback: { execution_receipt_path: releaseArtifact.path, execution_receipt_sha256: releaseArtifact.sha256, output_hash: "b".repeat(64) },
    });
    const release = await db.update(profitFlywheelStageRuns).set({ attemptCount: 1 }).where(eq(profitFlywheelStageRuns.id, releaseSeed.id)).returning().then((rows) => rows[0]!);
    const qaWork = await immutableArtifact("qa-work-result.json", { state: "passed" });
    const releaseWork = await immutableArtifact("release-work-result.json", { state: "succeeded" });
    const identity = (stageRun: typeof profitFlywheelStageRuns.$inferSelect, work: { path: string; sha256: string }) => ({
      workflow_id: seeded.workflow.id,
      stage_run_id: stageRun.id,
      trace_id: seeded.workflow.traceId,
      attempt: stageRun.attemptCount,
      input_hash: stageRun.inputHash,
      execution_manifest_sha256: "c".repeat(64),
      execution_manifest_file_sha256: "d".repeat(64),
      work_result_path: work.path,
      work_result_sha256: work.sha256,
    });
    await insertReceiptRow({ workflow: seeded.workflow, stageRun: qa, type: "provider_run_receipt", artifactRef: qaArtifact.path, artifactHash: qaArtifact.sha256, attributes: { execution_receipt_sha256: qaArtifact.sha256, ...identity(qa, qaWork) } });
    await insertReceiptRow({ workflow: seeded.workflow, stageRun: qa, type: "qa_receipt", artifactRef: qaArtifact.path, artifactHash: qaArtifact.sha256, attributes: { execution_receipt_sha256: qaArtifact.sha256, ...identity(qa, qaWork) } });
    await insertReceiptRow({ workflow: seeded.workflow, stageRun: release, type: "provider_run_receipt", artifactRef: releaseArtifact.path, artifactHash: releaseArtifact.sha256, attributes: { execution_receipt_sha256: releaseArtifact.sha256, ...identity(release, releaseWork) } });
    await insertReceiptRow({ workflow: seeded.workflow, stageRun: release, type: "release_receipt", artifactRef: `git:${"1".repeat(40)}`, artifactHash: "e".repeat(64), attributes: { execution_receipt_sha256: releaseArtifact.sha256, ...identity(release, releaseWork) } });
    return { qa, release, qaArtifact, releaseArtifact };
  }

  it("rejects QA completion when an independent-review artifact changes after receipts are ready", async () => {
    const seeded = await seedWorkflow();
    await execFile("git", ["init", "-b", "main", artifactRoot]);
    await execFile("git", ["-C", artifactRoot, "config", "user.email", "qa-lineage@example.invalid"]);
    await execFile("git", ["-C", artifactRoot, "config", "user.name", "QA Lineage"]);
    await writeFile(path.join(artifactRoot, "implementation.txt"), "verified implementation\n");
    await execFile("git", ["-C", artifactRoot, "add", "implementation.txt"]);
    await execFile("git", ["-C", artifactRoot, "commit", "-m", "implementation"]);
    const implementationGitObject = await execFile("git", ["-C", artifactRoot, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim());
    const objectType = await execFile("git", ["-C", artifactRoot, "cat-file", "-t", implementationGitObject]).then(({ stdout }) => stdout.trim());
    const objectBytes = await execFile("git", ["-C", artifactRoot, "cat-file", objectType, implementationGitObject]).then(({ stdout }) => Buffer.from(stdout, "utf8"));
    const implementationArtifactHash = createHash("sha256").update(Buffer.concat([
      Buffer.from(`${objectType} ${objectBytes.length}\0`, "utf8"),
      objectBytes,
    ])).digest("hex");
    const implementationOutputHash = "4".repeat(64);
    const implementation = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "implementation",
      state: "succeeded",
      linkedIssueId: seeded.issueId,
      feedback: { output_hash: implementationOutputHash },
    });
    const policy = await loadProviderPolicyV2();
    const [routeId, route] = Object.entries(policy.policy.routes)[0]!;
    const routeSnapshot = buildResolvedProviderRoute({
      policy: policy.policy,
      policySha256: policy.sha256,
      policySchemaSha256: policy.schemaSha256,
      routeId,
    });
    const builderProviderFamily = route.providerFamily === "builder-family" ? "different-builder" : "builder-family";
    await db.update(profitFlywheelStageRuns).set({ providerFamily: builderProviderFamily }).where(eq(profitFlywheelStageRuns.id, implementation.id));
    const leaseOwner = `system:${randomUUID()}:qa`;
    const leaseActorId = randomUUID();
    const qa = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "qa",
      state: "running",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: implementation.id,
      transitionSourceOutputHash: implementationOutputHash,
      feedback: {
        transition_source_stage_run_id: implementation.id,
        transition_source_output_hash: implementationOutputHash,
      },
    });
    await db.update(profitFlywheelStageRuns).set({
      attemptCount: 1,
      providerRouteId: routeId,
      providerFamily: route.providerFamily,
      providerModel: route.model.kind === "exact" ? route.model.value : "policy-model",
      providerModelVersion: route.model.version,
      providerPolicySha256: policy.sha256,
      providerRouteCoreSha256: routeSnapshot.policyRouteCoreSha256,
      providerRouteSha256: routeSnapshot.resolvedRouteSha256,
      providerRouteSnapshot: routeSnapshot,
      leaseOwner,
      leaseActorType: "system",
      leaseActorId,
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      heartbeatAt: new Date(),
      startedAt: new Date(),
    }).where(eq(profitFlywheelStageRuns.id, qa.id));
    const execution = await immutableArtifact("qa-server-execution.json", { schema_version: "paperclip.profit_flywheel_stage_execution.v2", stage_run_id: qa.id });
    const reviewerModel = route.model.kind === "exact" ? route.model.value : "policy-model";
    const review = await immutableArtifact("independent-review.json", {
      schema_version: "paperclip.independent_review_result.v1",
      state: "succeeded",
      final_disposition: "passed",
      qa_stage_run_id: qa.id,
      implementation_stage_run_id: implementation.id,
      implementation_git_object: implementationGitObject,
      implementation_artifact_hash: implementationArtifactHash,
      reviewer_provider_family: route.providerFamily,
      reviewer_model: reviewerModel,
      reviewer_version: route.model.version,
      provider_policy_sha256: policy.sha256,
      provider_policy_schema_sha256: policy.schemaSha256,
      summary: "Independent completion-time review passed.",
      findings: [],
    });
    const passingTest = [{ command: "test -f implementation.txt", exit_code: 0, status: "passed", artifact_ref: execution.path, artifact_hash: execution.sha256 }];
    await insertReceiptRow({
      workflow: seeded.workflow,
      stageRun: qa,
      type: "provider_run_receipt",
      artifactRef: execution.path,
      artifactHash: execution.sha256,
      attributes: {
        provider_route_id: routeId,
        provider_route_core_sha256: routeSnapshot.policyRouteCoreSha256,
        provider_route_sha256: routeSnapshot.resolvedRouteSha256,
        provider_family: route.providerFamily,
        model: reviewerModel,
        provider_version: route.model.version,
        provider_policy_sha256: policy.sha256,
        provider_policy_schema_sha256: policy.schemaSha256,
        final_response_sha256: "5".repeat(64),
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    });
    await insertReceiptRow({
      workflow: seeded.workflow,
      stageRun: qa,
      type: "qa_receipt",
      artifactRef: execution.path,
      artifactHash: execution.sha256,
      attributes: {
        test_commands: ["test -f implementation.txt"],
        test_results: passingTest,
        implementation_stage_run_id: implementation.id,
        implementation_git_object: implementationGitObject,
        implementation_artifact_hash: implementationArtifactHash,
        builder_provider_family: builderProviderFamily,
        reviewer_provider_family: route.providerFamily,
        reviewer_model: reviewerModel,
        reviewer_version: route.model.version,
        reviewer_policy_sha256: policy.sha256,
        reviewer_policy_schema_sha256: policy.schemaSha256,
        independent_review_artifact_ref: review.path,
        independent_review_artifact_hash: review.sha256,
        independent_review_final_disposition: "passed",
      },
    });
    await insertReceiptRow({
      workflow: seeded.workflow,
      stageRun: qa,
      type: "independent_review_receipt",
      artifactRef: review.path,
      artifactHash: review.sha256,
      attributes: {
        review_provider_family: route.providerFamily,
        review_model: reviewerModel,
        review_version: route.model.version,
        review_policy_sha256: policy.sha256,
        review_policy_schema_sha256: policy.schemaSha256,
        builder_provider_family: builderProviderFamily,
        implementation_stage_run_id: implementation.id,
        implementation_git_object: implementationGitObject,
        implementation_artifact_hash: implementationArtifactHash,
        review_status: "succeeded",
        final_disposition: "passed",
        review_summary: "Independent completion-time review passed.",
      },
    });

    await chmod(review.path, 0o644);
    await writeFile(review.path, '{"state":"tampered"}\n');
    await chmod(review.path, 0o444);
    const service = profitFlywheelService(db);
    await expect(service.completeStage({
      stageRunId: qa.id,
      expectedLease: { leaseOwner, actorType: "system", actorId: leaseActorId },
    })).rejects.toThrow("Artifact bytes do not match artifact_hash");
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, qa.id)).then((rows) => rows[0]!.state)).toBe("running");
  });

  it("authorizes only the workflow-pinned Portfolio OS executor id despite mutable names", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const impostorId = randomUUID();
    await db.insert(agents).values({
      id: impostorId,
      companyId: seeded.companyId,
      name: "Market Analyst",
      role: "analyst",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ name: "Portfolio OS Orchestrator", role: "orchestrator" }).where(eq(agents.id, impostorId));
    await db.update(agents).set({ name: "Durably Pinned POS Executor", role: "operator" }).where(eq(agents.id, seeded.orchestratorId));
    const input = {
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation" as const,
      inputHash: stage.inputHash,
      state: "blocked" as const,
      blocker: {
        blockerCode: "source_unavailable",
        blockerDetail: "Exact measured source is unavailable",
        nextOwner: "portfolio_os_owner",
        resumeCondition: "Restore the registered source and resume",
      },
    };
    const service = profitFlywheelService(db);
    await expect(service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: impostorId },
    })).rejects.toThrow("workflow-pinned executor agent id");
    const claim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await expect(service.acknowledgePortfolioOsOutbox({
      ...input,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      principal: { type: "agent", id: seeded.orchestratorId },
    })).resolves.toMatchObject({ status: "acknowledged", state: "blocked" });
  });

  it("advertises the exact completion-event stage-plane command for deterministic decision stages", async () => {
    const seeded = await seedWorkflow();
    const source = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "research_intake",
      state: "succeeded",
    });
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "evidence_normalization",
      transitionSourceStageRunId: source.id,
      transitionSourceOutputHash: "a".repeat(64),
    });
    await seedOutboxEvent(seeded.workflow, stage);
    const page = await profitFlywheelService(db).listPortfolioOsOutbox(seeded.companyId);
    expect(page.events).toEqual([
      expect.objectContaining({
        stage: "evidence_normalization",
        executor: {
          route: "portfolio_os_stage_plane",
          invocation: "completion_event",
          command: `./bin/pos paperclip-stage-plane --company-id ${seeded.companyId}`,
          next_owner: "portfolio_os_stage_plane_executor",
        },
      }),
    ]);
  });

  it("durably blocks one malformed envelope without starving a later same-plane event", async () => {
    const seeded = await seedWorkflow();
    const source = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "research_intake",
      state: "succeeded",
    });
    const poisoned = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_validation",
      transitionSourceStageRunId: null,
      transitionSourceOutputHash: "b".repeat(64),
    });
    const healthy = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "evidence_normalization",
      transitionSourceStageRunId: source.id,
      transitionSourceOutputHash: "a".repeat(64),
    });
    const poisonedEvent = await seedOutboxEvent(seeded.workflow, poisoned);
    const healthyEvent = await seedOutboxEvent(seeded.workflow, healthy);
    await db.update(profitFlywheelEvents).set({ createdAt: new Date(Date.now() - 2_000) })
      .where(eq(profitFlywheelEvents.id, poisonedEvent.id));
    await db.update(profitFlywheelEvents).set({ createdAt: new Date(Date.now() - 1_000) })
      .where(eq(profitFlywheelEvents.id, healthyEvent.id));

    const page = await profitFlywheelService(db).listPortfolioOsOutbox(seeded.companyId);
    expect(page.events).toEqual([
      expect.objectContaining({ event_id: healthyEvent.id, stage: "evidence_normalization" }),
    ]);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, poisoned.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: "profit_flywheel_outbox_envelope_invalid" });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, poisonedEvent.id)).then((rows) => rows[0]!.processedAt))
      .toBeInstanceOf(Date);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, healthyEvent.id)).then((rows) => rows[0]!.processedAt))
      .toBeNull();
  });

  it("binds a second-iteration dispatch artifact without reusing the workflow kickoff hash", async () => {
    const seeded = await seedWorkflow();
    await db.update(profitFlywheelWorkflows).set({
      feedback: {
        ...(seeded.workflow.feedback as Record<string, unknown>),
        target_base_sha: "1".repeat(40),
        workspace_fingerprint: "2".repeat(64),
      },
    }).where(eq(profitFlywheelWorkflows.id, seeded.workflow.id));
    const council = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "council_decision",
      state: "succeeded",
    });
    const dispatch = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "dispatch",
      transitionSourceStageRunId: council.id,
      transitionSourceOutputHash: "c".repeat(64),
    });
    const event = await seedOutboxEvent(seeded.workflow, dispatch);
    const service = profitFlywheelService(db);
    const page = await service.listPortfolioOsOutbox(seeded.companyId, { stages: ["dispatch"] });
    const envelope = page.events.find((candidate) => candidate.event_id === event.id)!;
    const issueIdentity = envelope.dispatch_issue_identity as {
      origin_id: string;
      description_marker: string;
    };
    expect(envelope.dispatch_authoring_authority).toMatchObject({
      workflow_id: seeded.workflow.id,
      stage_run_id: dispatch.id,
      input_hash: dispatch.inputHash,
      source_hashes: dispatch.sourceHashes,
      historical_workflow_dispatch: { artifact_hash: seeded.workflow.sourceDispatchHash, role: "workflow_kickoff_history_only" },
    });
    await db.update(issues).set({
      description: `Second iteration execution\n\n${issueIdentity.description_marker}`,
      createdByAgentId: seeded.orchestratorId,
      createdAt: new Date(event.createdAt.getTime() + 1_000),
    }).where(eq(issues.id, seeded.issueId));
    const artifact = await immutableArtifact("second-iteration-dispatch.json", {
      schema_version: "pos.dispatch.v2",
      workflow_id: seeded.workflow.id,
      stage_run_id: dispatch.id,
      input_hash: dispatch.inputHash,
      source_hashes: dispatch.sourceHashes,
    });
    expect(artifact.sha256).not.toBe(seeded.workflow.sourceDispatchHash);
    const claim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: dispatch.id,
      stage: "dispatch",
      inputHash: dispatch.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const observedAt = new Date().toISOString();
    const attributes = {
      attempt: claim.attempt,
      workflow_id: seeded.workflow.id,
      stage_run_id: dispatch.id,
      input_hash: dispatch.inputHash,
      authoring_inputs: dispatch.sourceHashes,
      dispatch_hash: artifact.sha256,
      artifact_hash: artifact.sha256,
      issue_id: seeded.issueId,
      issue_origin_id: issueIdentity.origin_id,
    };
    const receipts = (["portfolio_os_dispatch_authorization", "immutable_dispatch_artifact"] as const).map((type) => {
      const body = {
        type,
        schemaVersion: "pos.dispatch.v2",
        artifactRef: artifact.path,
        observedAt,
        expiresAt: null,
        attributes,
      };
      return { ...body, contentHash: canonicalProfitFlywheelReceiptHash(body) };
    });
    const bindings = receipts.map((receipt) => ({
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      contentHash: receipt.contentHash,
      artifactRef: receipt.artifactRef,
    })).sort((left, right) => left.contentHash.localeCompare(right.contentHash));
    const outputHash = hashProfitFlywheelValue({ stage: "dispatch", input_hash: dispatch.inputHash, receipts: bindings });
    const wrongOriginReceipts = receipts.map((receipt) => {
      const body = { ...receipt, attributes: { ...receipt.attributes, issue_origin_id: "0".repeat(64) } };
      return { ...body, contentHash: canonicalProfitFlywheelReceiptHash(body) };
    });
    const wrongBindings = wrongOriginReceipts.map((receipt) => ({
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      contentHash: receipt.contentHash,
      artifactRef: receipt.artifactRef,
    })).sort((left, right) => left.contentHash.localeCompare(right.contentHash));
    await expect(service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: dispatch.id,
      stage: "dispatch",
      inputHash: dispatch.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "succeeded",
      outputHash: hashProfitFlywheelValue({ stage: "dispatch", input_hash: dispatch.inputHash, receipts: wrongBindings }),
      receipts: wrongOriginReceipts,
      linkedIssueId: seeded.issueId,
      principal: { type: "agent", id: seeded.orchestratorId },
    })).rejects.toThrow("server-issued issue origin");
    await expect(service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: dispatch.id,
      stage: "dispatch",
      inputHash: dispatch.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "succeeded",
      outputHash,
      receipts,
      linkedIssueId: seeded.issueId,
      principal: { type: "agent", id: seeded.orchestratorId },
    })).resolves.toMatchObject({ status: "acknowledged" });
    const implementation = await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.workflowId, seeded.workflow.id))
      .then((rows) => rows.find((row) => row.stage === "implementation")!);
    expect(implementation.sourceHashes).toMatchObject({ dispatch_hash: artifact.sha256 });
    expect(implementation.feedback).toMatchObject({
      iteration_dispatch_binding: {
        dispatch_stage_run_id: dispatch.id,
        dispatch_artifact_ref: artifact.path,
        dispatch_artifact_hash: artifact.sha256,
      },
    });
    expect(await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0])).toMatchObject({
      originKind: "profit_flywheel_dispatch",
      originId: issueIdentity.origin_id,
      originRunId: seeded.workflow.runId,
    });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, seeded.workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ sourceDispatchHash: seeded.workflow.sourceDispatchHash, sourceDispatchPath: seeded.workflow.sourceDispatchPath });
  });

  it("exposes a machine-readable stale-claim conflict while every non-claim API response redacts the nonce", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: seeded.orchestratorId,
        companyId: seeded.companyId,
        companyIds: [seeded.companyId],
        source: "api_key",
      };
      next();
    });
    app.use("/api", profitFlywheelRoutes(db));
    app.use(errorHandler);
    const claimResponse = await request(app)
      .post(`/api/companies/${seeded.companyId}/profit-flywheel/portfolio-os-outbox/${event.id}/claim`)
      .send({
        schema_version: "paperclip.portfolio_os_stage_claim.v2",
        workflow_id: seeded.workflow.id,
        stage_run_id: stage.id,
        stage: stage.stage,
        input_hash: stage.inputHash,
        attempt: 1,
      });
    expect(claimResponse.status, JSON.stringify(claimResponse.body)).toBe(200);
    const nonce = String(claimResponse.body.claim_nonce);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    const workflowResponse = await request(app).get(`/api/profit-flywheel/workflows/${seeded.workflow.id}`);
    expect(workflowResponse.status).toBe(200);
    expect(JSON.stringify(workflowResponse.body)).not.toContain(nonce);
    const staleNonce = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const staleAck = await request(app)
      .post(`/api/companies/${seeded.companyId}/profit-flywheel/portfolio-os-outbox/${event.id}/ack`)
      .send({
        schema_version: "paperclip.portfolio_os_stage_ack.v2",
        event_id: event.id,
        workflow_id: seeded.workflow.id,
        stage_run_id: stage.id,
        stage: stage.stage,
        input_hash: stage.inputHash,
        attempt: 1,
        claim_nonce: staleNonce,
        state: "blocked",
        blocker: {
          blocker_code: "route_stale_fixture",
          blocker_detail: "Stale route fixture",
          next_owner: "portfolio_os_owner",
          resume_condition: "Reclaim the exact attempt",
        },
      });
    expect(staleAck.status).toBe(409);
    expect(staleAck.body).toEqual({
      error: "Profit Flywheel request rejected",
      details: { code: "profit_flywheel_outbox_stale_attempt" },
    });
    expect(JSON.stringify(staleAck.body)).not.toContain(staleNonce);
  });

  for (const state of ["blocked", "degraded", "failed"] as const) {
    it(`atomically consumes and idempotently replays a ${state} acknowledgement`, async () => {
      const seeded = await seedWorkflow();
      const stage = await seedStage({
        workflow: seeded.workflow,
        contract: seeded.contract,
        stage: "commercial_observation",
        linkedIssueId: seeded.issueId,
      });
      const event = await seedOutboxEvent(seeded.workflow, stage);
      const service = profitFlywheelService(db);
      const claim = await service.claimPortfolioOsOutbox({
        companyId: seeded.companyId,
        eventId: event.id,
        workflowId: seeded.workflow.id,
        stageRunId: stage.id,
        stage: "commercial_observation",
        inputHash: stage.inputHash,
        attempt: 1,
        principal: { type: "agent", id: seeded.orchestratorId },
      });
      const blocker = {
        blockerCode: `${state}_evidence_gap`,
        blockerDetail: `Exact ${state} evidence is unavailable`,
        nextOwner: "portfolio_os_owner",
        resumeCondition: "Publish a fresh immutable measured artifact and replay the event",
      };
      const acknowledge = () => service.acknowledgePortfolioOsOutbox({
        companyId: seeded.companyId,
        eventId: event.id,
        workflowId: seeded.workflow.id,
        stageRunId: stage.id,
        stage: "commercial_observation",
        inputHash: stage.inputHash,
        attempt: claim.attempt,
        claimNonce: claim.claim_nonce,
        state,
        blocker,
        principal: { type: "agent", id: seeded.orchestratorId },
      });
      if (state === "degraded") {
        const [first, concurrentReplay] = await Promise.all([acknowledge(), acknowledge()]);
        expect(first).toMatchObject({ status: "deferred", state, persistedState: "retry", blocker });
        expect(concurrentReplay).toMatchObject({ status: "deferred", state, persistedState: "retry", blocker });
        expect((await db.select().from(profitFlywheelStageRuns)).find((row) => row.id === stage.id)).toMatchObject({ state: "retry", attemptCount: 1, blockerCode: blocker.blockerCode });
        expect((await db.select().from(profitFlywheelWorkflows)).find((row) => row.id === seeded.workflow.id)).toMatchObject({ state: "degraded", blockerCode: blocker.blockerCode });
        const persistedEvent = (await db.select().from(profitFlywheelEvents)).find((row) => row.id === event.id)!;
        expect(persistedEvent.processedAt).toBeNull();
        expect(persistedEvent.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect((await service.listPortfolioOsOutbox(seeded.companyId, { stages: ["commercial_observation"] })).count).toBe(0);
      } else {
        const first = await acknowledge();
        expect(first).toMatchObject({ status: "acknowledged", state, blocker });
        const replay = await acknowledge();
        expect(replay.status).toBe("already_acknowledged");
        expect((await db.select().from(profitFlywheelStageRuns)).find((row) => row.id === stage.id)).toMatchObject({ state, blockerCode: blocker.blockerCode });
        expect((await db.select().from(profitFlywheelWorkflows)).find((row) => row.id === seeded.workflow.id)).toMatchObject({ state, blockerCode: blocker.blockerCode });
        expect((await db.select().from(profitFlywheelEvents)).find((row) => row.id === event.id)?.processedAt).toBeInstanceOf(Date);
      }
      expect((await db.select().from(issues)).find((row) => row.id === seeded.issueId)?.status).toBe("blocked");
    });
  }

  it("rejects a delayed acknowledgement from attempt N after attempt N+1 is claimed", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const service = profitFlywheelService(db);
    const claimInput = {
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation" as const,
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    };
    const [firstClaim, concurrentClaim] = await Promise.all([
      service.claimPortfolioOsOutbox(claimInput),
      service.claimPortfolioOsOutbox(claimInput),
    ]);
    expect(concurrentClaim).toEqual(firstClaim);
    expect(JSON.stringify(await service.getWorkflow(seeded.workflow.id))).not.toContain(firstClaim.claim_nonce);
    const claimEvent = (await db.select().from(profitFlywheelEvents)).find((candidate) =>
      candidate.stageRunId === stage.id && candidate.eventType === "stage_attempt_claimed");
    expect(claimEvent?.payload).toMatchObject({ attempt: 1, claim_nonce_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(claimEvent)).not.toContain(firstClaim.claim_nonce);
    const blocker = {
      blockerCode: "measurement_source_temporarily_unavailable",
      blockerDetail: "The exact measured source was unavailable during attempt one",
      nextOwner: "portfolio_os_market_voc_source_executor",
      resumeCondition: "Restore the source and explicitly resume this exact event",
    };
    await service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: firstClaim.attempt,
      claimNonce: firstClaim.claim_nonce,
      state: "blocked",
      blocker,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await service.resumePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      inputHash: stage.inputHash,
      expectedBlockerCode: blocker.blockerCode,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const secondClaim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 2,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    expect(secondClaim).toMatchObject({ attempt: firstClaim.attempt + 1 });
    expect(secondClaim.claim_nonce).not.toBe(firstClaim.claim_nonce);
    await expect(service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: firstClaim.attempt,
      claimNonce: firstClaim.claim_nonce,
      state: "blocked",
      blocker,
      principal: { type: "agent", id: seeded.orchestratorId },
    })).rejects.toThrow("exact current server-issued attempt nonce");
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "pending", attemptCount: secondClaim.attempt });
  });

  it("repairs a terminal stage with an unprocessed torn outbox event without a local POS journal", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const service = profitFlywheelService(db);
    const claim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "blocked",
      blocker: {
        blockerCode: "terminal_torn_fixture",
        blockerDetail: "Fixture terminalized before outbox processed_at persisted",
        nextOwner: "portfolio_os_owner",
        resumeCondition: "Repair source authority and resume",
      },
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await db.update(profitFlywheelEvents).set({
      processedAt: null,
      nextAttemptAt: new Date(Date.now() - 1000),
    }).where(eq(profitFlywheelEvents.id, event.id));
    const concurrentRepairs = await Promise.all([
      service.listPortfolioOsOutbox(seeded.companyId, { stages: ["commercial_observation"] }),
      service.listPortfolioOsOutbox(seeded.companyId, { stages: ["commercial_observation"] }),
    ]);
    expect(concurrentRepairs).toEqual([
      expect.objectContaining({ count: 0, events: [] }),
      expect.objectContaining({ count: 0, events: [] }),
    ]);
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]!.processedAt))
      .toBeInstanceOf(Date);
    expect((await db.select().from(profitFlywheelEvents)).filter((candidate) =>
      candidate.stageRunId === stage.id && candidate.eventType === "outbox_terminal_reconciled")).toHaveLength(1);
  });

  it("rolls back terminal outbox processed_at when reconciliation audit append fails", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const baseService = profitFlywheelService(db);
    const claim = await baseService.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await baseService.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "blocked",
      blocker: {
        blockerCode: "terminal_torn_append_failure_fixture",
        blockerDetail: "Fixture terminalized before outbox reconciliation append",
        nextOwner: "portfolio_os_owner",
        resumeCondition: "Replay atomic terminal outbox reconciliation",
      },
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    await db.update(profitFlywheelEvents).set({
      processedAt: null,
      nextAttemptAt: new Date(Date.now() - 1000),
    }).where(eq(profitFlywheelEvents.id, event.id));
    const service = profitFlywheelService(db, {
      terminalOutboxReconciliationBeforeAppend: () => {
        throw new Error("injected terminal reconciliation append failure");
      },
    });
    await expect(service.listPortfolioOsOutbox(seeded.companyId, { stages: ["commercial_observation"] }))
      .rejects.toThrow("injected terminal reconciliation append failure");
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]!.processedAt))
      .toBeNull();
    expect((await db.select().from(profitFlywheelEvents)).filter((candidate) =>
      candidate.stageRunId === stage.id && candidate.eventType === "outbox_terminal_reconciled")).toHaveLength(0);
  });

  it("atomically blocks terminal executor exhaustion with one idempotent workflow blocker issue", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const blocker = {
      blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      blockerDetail: "The exact Portfolio OS consumer exhausted its bounded launcher attempts.",
      nextOwner: "portfolio_os_runtime_owner",
      resumeCondition: "Repair the deterministic launcher failure and explicitly resume this event.",
    };
    const torn = profitFlywheelService(db, {
      terminalOutboxReconciliationBeforeAppend: () => {
        throw new Error("injected infrastructure blocker append failure");
      },
    });
    await expect(torn.blockPortfolioOsOutboxInfrastructure({
      companyId: seeded.companyId,
      eventId: event.id,
      blocker,
    })).rejects.toThrow("injected infrastructure blocker append failure");
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "pending", blockerCode: null });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, seeded.workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "running", blockerCode: null });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]!.processedAt))
      .toBeNull();
    expect(await db.select().from(issues).where(eq(issues.companyId, seeded.companyId))).toHaveLength(1);

    const service = profitFlywheelService(db);
    const results = await Promise.all([
      service.blockPortfolioOsOutboxInfrastructure({ companyId: seeded.companyId, eventId: event.id, blocker }),
      service.blockPortfolioOsOutboxInfrastructure({ companyId: seeded.companyId, eventId: event.id, blocker }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_blocked", "blocked"]);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, stage.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: blocker.blockerCode });
    expect(await db.select().from(profitFlywheelWorkflows).where(eq(profitFlywheelWorkflows.id, seeded.workflow.id)).then((rows) => rows[0]))
      .toMatchObject({ state: "blocked", blockerCode: blocker.blockerCode });
    expect(await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]!.processedAt))
      .toBeInstanceOf(Date);
    const allIssues = await db.select().from(issues).where(eq(issues.companyId, seeded.companyId));
    expect(allIssues.filter((issue) => issue.originKind === "profit_flywheel_outbox_blocker")).toEqual([
      expect.objectContaining({
        status: "blocked",
        originId: `${seeded.workflow.id}:${blocker.blockerCode}`,
        identifier: expect.stringMatching(/^[A-Za-z0-9]+-\d+$/),
      }),
    ]);
    expect((await db.select().from(profitFlywheelEvents)).filter((candidate) =>
      candidate.stageRunId === stage.id && candidate.eventType === "stage_blocked")).toHaveLength(1);

    const firstProcessedAt = (await db.select().from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.id, event.id)).then((rows) => rows[0]!.processedAt))!;
    const firstResumeAt = new Date(firstProcessedAt.getTime() + 1_000);
    await service.resumePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      inputHash: stage.inputHash,
      expectedBlockerCode: blocker.blockerCode,
      principal: { type: "agent", id: seeded.orchestratorId },
      now: firstResumeAt,
    });
    const secondBlockAt = new Date(firstProcessedAt.getTime() + 2_000);
    await service.blockPortfolioOsOutboxInfrastructure({
      companyId: seeded.companyId,
      eventId: event.id,
      blocker,
      now: secondBlockAt,
    });
    await service.resumePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      inputHash: stage.inputHash,
      expectedBlockerCode: blocker.blockerCode,
      principal: { type: "agent", id: seeded.orchestratorId },
      now: new Date(firstProcessedAt.getTime() + 3_000),
    });
    const cycleEvents = await db.select().from(profitFlywheelEvents);
    expect(cycleEvents.filter((candidate) => candidate.stageRunId === stage.id && candidate.eventType === "stage_blocked"))
      .toHaveLength(2);
    expect(cycleEvents.filter((candidate) => candidate.stageRunId === stage.id && candidate.eventType === "stage_resumed"))
      .toHaveLength(2);
    expect(cycleEvents.find((candidate) => candidate.id === event.id)?.processedAt).toBeNull();
  });

  it("concurrently resumes one exact blocked event with a single CAS mutation", async () => {
    const seeded = await seedWorkflow();
    const lineage = await seedQaReleaseLineage(seeded);
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: lineage.release.id,
      transitionSourceOutputHash: "b".repeat(64),
    });
    const event = await seedOutboxEvent(seeded.workflow, stage);
    const service = profitFlywheelService(db);
    const claim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const blocker = {
      blockerCode: "registered_measurement_source_missing",
      blockerDetail: "The registered commercial source is not available",
      nextOwner: "portfolio_os_market_voc_source_executor",
      resumeCondition: "Register and verify the source, then resume this exact event",
    };
    await service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      stage: "commercial_observation",
      inputHash: stage.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "blocked",
      blocker,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const resume = () => service.resumePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: stage.id,
      inputHash: stage.inputHash,
      expectedBlockerCode: blocker.blockerCode,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const results = await Promise.all([resume(), resume()]);
    expect(results.map((result) => result.status).sort()).toEqual(["already_resumed", "resumed"]);
    for (const result of results) {
      expect(result).toMatchObject({
        event_id: event.id,
        workflow_id: seeded.workflow.id,
        stage_run_id: stage.id,
        stage: "commercial_observation",
        input_hash: stage.inputHash,
        expected_blocker_code: blocker.blockerCode,
      });
      expect(typeof result.retry_not_before).toBe("string");
    }
    expect((await db.select().from(profitFlywheelStageRuns)).find((row) => row.id === stage.id)).toMatchObject({ state: "retry", blockerCode: null });
    expect((await db.select().from(profitFlywheelEvents)).find((row) => row.id === event.id)?.processedAt).toBeNull();
    expect((await service.listPortfolioOsOutbox(seeded.companyId, { stages: ["commercial_observation"] })).count).toBe(1);
  });

  it("emits verified QA and release execution files in an observation envelope", async () => {
    const seeded = await seedWorkflow();
    const lineage = await seedQaReleaseLineage(seeded);
    const observation = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: lineage.release.id,
      transitionSourceOutputHash: "b".repeat(64),
    });
    await seedOutboxEvent(seeded.workflow, observation);

    const page = await profitFlywheelService(db).listPortfolioOsOutbox(seeded.companyId);
    expect(page.count).toBe(1);
    expect(page.events[0]).toMatchObject({
      stage: "commercial_observation",
      linked_issue_id: seeded.issueId,
      qa_binding: { path: lineage.qaArtifact.path, sha256: lineage.qaArtifact.sha256, stage_run_id: lineage.qa.id },
      release_binding: { path: lineage.releaseArtifact.path, sha256: lineage.releaseArtifact.sha256, stage_run_id: lineage.release.id },
    });
  });

  it("idempotently repairs an exact cross-language receipt replay after timestamptz normalization", async () => {
    const seeded = await seedWorkflow();
    const stage = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      linkedIssueId: seeded.issueId,
    });
    const artifact = await immutableArtifact("cross-language-observation.json", { observed_value: 1 });
    const body = {
      type: "commercial_observation_receipt",
      schemaVersion: "pos.commercial_observation.v2",
      artifactRef: artifact.path,
      observedAt: "2026-07-12T01:04:00.123456+00:00",
      expiresAt: null,
      attributes: {
        attempt: 1,
        metric_name: "artifact_backed_release_verified",
        baseline: 0,
        observed_value: 1,
        measurement_window: { start: "2026-07-12T01:00:00.000Z", end: "2026-07-12T01:04:00.123Z" },
        source_artifact_hash: artifact.sha256,
        artifact_hash: artifact.sha256,
      },
    };
    const receipt = { ...body, contentHash: canonicalProfitFlywheelReceiptHash(body) };
    const service = profitFlywheelService(db);
    const first = await service.recordReceipt({ stageRunId: stage.id, receipt });
    const replay = await service.recordReceipt({ stageRunId: stage.id, receipt });
    expect(replay.id).toBe(first.id);
    const persisted = await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, stage.id));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ observedAtRaw: body.observedAt, expiresAtRaw: null });

    await db.update(profitFlywheelReceipts).set({ attributes: { ...body.attributes, observed_value: 2 } })
      .where(eq(profitFlywheelReceipts.id, first.id));
    await expect(service.recordReceipt({ stageRunId: stage.id, receipt })).rejects.toMatchObject({
      code: "profit_flywheel_receipt_type_conflict",
    });
  });

  it("emits canonical receipt proofs that make every learning binding independently verifiable", async () => {
    const seeded = await seedWorkflow();
    const lineage = await seedQaReleaseLineage(seeded);
    const measuredSource = await immutableArtifact("measured-source.json", { state: "measured", observed_value: 1 });
    const observationArtifact = await immutableArtifact("commercial-observation.json", {
      schema_version: "pos.commercial_observation.v2",
      workflow_id: seeded.workflow.id,
      linked_issue_id: seeded.issueId,
      source_artifact_ref: measuredSource.path,
      source_artifact_hash: measuredSource.sha256,
    });
    const observation = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      state: "succeeded",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: lineage.release.id,
      transitionSourceOutputHash: "b".repeat(64),
      feedback: { output_hash: "c".repeat(64) },
    });
    await insertReceiptRow({
      workflow: seeded.workflow,
      stageRun: observation,
      type: "commercial_observation_receipt",
      artifactRef: observationArtifact.path,
      artifactHash: observationArtifact.sha256,
      attributes: {
        metric_name: "artifact_backed_release_verified",
        baseline: 0,
        observed_value: 1,
        measurement_window: { start: "2026-07-11T00:00:00.000Z", end: "2026-07-11T01:00:00.000Z" },
        source_artifact_ref: measuredSource.path,
        source_artifact_hash: measuredSource.sha256,
      },
    });
    const learning = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "learning",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: observation.id,
      transitionSourceOutputHash: "c".repeat(64),
    });
    await seedOutboxEvent(seeded.workflow, learning);

    const page = await profitFlywheelService(db).listPortfolioOsOutbox(seeded.companyId, { stages: ["learning"] });
    expect(page.count).toBe(1);
    const envelope = page.events[0]!;
    expect(envelope.receipt_proofs).not.toBeNull();
    for (const key of ["qa", "release", "commercial_observation"] as const) {
      const proof = envelope.receipt_proofs![key];
      expect(Object.keys(proof)).toEqual([
        "type", "schemaVersion", "contentHash", "artifactRef", "observedAt", "expiresAt", "attributes",
      ]);
      const { contentHash, ...body } = proof;
      expect(canonicalProfitFlywheelReceiptHash(body)).toBe(contentHash);
    }
    expect(envelope.receipt_proofs!.qa).toMatchObject({
      type: "qa_receipt",
      contentHash: envelope.qa_binding!.receipt_hash,
      artifactRef: envelope.qa_binding!.artifact_ref,
      attributes: { artifact_hash: envelope.qa_binding!.artifact_hash },
    });
    expect(envelope.receipt_proofs!.release).toMatchObject({
      type: "release_receipt",
      contentHash: envelope.release_binding!.receipt_hash,
      artifactRef: envelope.release_binding!.artifact_ref,
      attributes: { artifact_hash: envelope.release_binding!.artifact_hash },
    });
    expect(envelope.receipt_proofs!.commercial_observation).toMatchObject({
      type: "commercial_observation_receipt",
      contentHash: envelope.commercial_observation_binding!.receipt_hash,
      artifactRef: observationArtifact.path,
      attributes: {
        artifact_hash: observationArtifact.sha256,
        source_artifact_ref: measuredSource.path,
        source_artifact_hash: measuredSource.sha256,
      },
    });
    for (const binding of [envelope.qa_binding, envelope.release_binding]) {
      expect(Object.keys(binding!)).toEqual([
        "path", "sha256", "artifact_ref", "artifact_hash", "receipt_hash", "stage_run_id", "receipt_type",
        "workflow_id", "trace_id", "attempt", "input_hash", "execution_manifest_sha256",
        "execution_manifest_file_sha256", "work_result_path", "work_result_sha256",
      ]);
    }
    expect(Object.keys(envelope.commercial_observation_binding!)).toEqual([
      "path", "sha256", "artifact_ref", "artifact_hash", "receipt_hash", "stage_run_id", "receipt_type",
    ]);
  });

  it("acks learning once, closes its issue, and durably delivers the next research iteration", async () => {
    const seeded = await seedWorkflow();
    const lineage = await seedQaReleaseLineage(seeded);
    const learningSourceHash = "9".repeat(64);
    const registry = await loadPortfolioOsResearchRegistryAuthority();
    const authorizedAt = new Date(Date.now() - 2_000);
    const notBefore = new Date(Date.now() + 800);
    const nextExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const query = "Re-check current repository market signals for the cheapest next commercial test";
    const sourceRequest = {
      source_id: "github_repository_api",
      source_kind: "repository",
      authority_class: "primary_platform",
      evidence_families: ["market_signal"],
      query_families: ["market_signal"],
      query,
      url_template: "https://api.github.com/repos/{owner}/{repo}",
      template_values: { owner: "fixture", repo: "profit-flywheel" },
      approved_domains: ["api.github.com"],
      approved_file_roots: [],
      legal: {
        permitted_use: "public_repository_metadata",
        robots_policy: "not_applicable",
        terms_status: "approved",
        approval_owner: "portfolio_os",
        runtime_approval: {
          status: "registry_approved",
          owner: "portfolio_os",
          approved_at: null,
          expires_at: null,
          artifact_ref: null,
          artifact_sha256: null,
        },
      },
      authentication: {
        requirement: "optional",
        runtime_ref_name: "GH_TOKEN",
        allowed_header_names: ["Authorization"],
      },
      extractor: "deterministic_json",
      freshness_sla_hours: 24,
      offline_fixture: null,
    };
    const authorization = {
      schema_version: "pos.next_research_authorization.v1",
      target_repo: seeded.workflow.targetRepo,
      source_registry: registry.registry,
      evidence_families: ["market_signal"],
      query_families: ["market_signal"],
      query,
      source_requests: [sourceRequest],
      governance: {
        owner: "portfolio_os",
        authorized_at: authorizedAt.toISOString(),
        expires_at: nextExpiresAt.toISOString(),
        collection_window_policy: { not_before: notBefore.toISOString(), max_duration_seconds: 1800 },
      },
      source_plan_hash: hashProfitFlywheelValue([sourceRequest]),
      immutable: true,
    };
    const authority = await immutableArtifact("next-research-authority.json", authorization);
    const authorityPayloadSha256 = hashProfitFlywheelValue(authorization);
    const measuredSourceArtifact = await immutableArtifact("learning-measured-source.json", { observed_value: 1 });
    const observationArtifact = await immutableArtifact("learning-commercial-observation.json", { state: "succeeded", observed_value: 1 });
    const observation = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "commercial_observation",
      state: "succeeded",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: lineage.release.id,
      transitionSourceOutputHash: "b".repeat(64),
      feedback: { output_hash: learningSourceHash },
    });
    await insertReceiptRow({
      workflow: seeded.workflow,
      stageRun: observation,
      type: "commercial_observation_receipt",
      artifactRef: observationArtifact.path,
      artifactHash: observationArtifact.sha256,
      attributes: {
        metric_name: "artifact_backed_release_verified",
        baseline: 0,
        observed_value: 1,
        measurement_window: { start: authorizedAt.toISOString(), end: new Date().toISOString() },
        source_artifact_hash: measuredSourceArtifact.sha256,
      },
    });
    const learning = await seedStage({
      workflow: seeded.workflow,
      contract: seeded.contract,
      stage: "learning",
      linkedIssueId: seeded.issueId,
      transitionSourceStageRunId: observation.id,
      transitionSourceOutputHash: learningSourceHash,
      feedback: { transition_source_stage_run_id: observation.id, transition_source_output_hash: learningSourceHash },
    });
    const event = await seedOutboxEvent(seeded.workflow, learning);
    const generatedAt = new Date().toISOString();
    const artifact = await immutableArtifact("learning-receipt.json", {
      schema_version: "pos.learning_receipt.v2",
      state: "succeeded",
      company: seeded.companyId,
      run_id: seeded.workflow.runId,
      workflow_id: seeded.workflow.id,
      correlation_id: seeded.workflow.correlationId,
      trace_id: seeded.workflow.traceId,
      linked_issue_id: seeded.issueId,
      target_repo: seeded.workflow.targetRepo,
      generated_at: generatedAt,
      input_hash: learning.inputHash,
      idempotency_key: learning.idempotencyKey,
      artifact_receipts: {
        qa: { path: lineage.qaArtifact.path, sha256: lineage.qaArtifact.sha256 },
        release: { path: lineage.releaseArtifact.path, sha256: lineage.releaseArtifact.sha256 },
        commercial_observation: { path: observationArtifact.path, sha256: observationArtifact.sha256 },
        next_research_authority: { path: authority.path, sha256: authority.sha256 },
      },
      observation: {
        kind: "operational",
        metric_name: "artifact_backed_release_verified",
        baseline_value: 0,
        observed_value: 1,
        metric_unit: "verified_release",
        measurement_window_start: authorizedAt.toISOString(),
        measurement_window_end: generatedAt,
        source_artifact: { path: measuredSourceArtifact.path, sha256: measuredSourceArtifact.sha256 },
        validation_outcome: "validated",
      },
      repo_memory_update: {
        status: "measured",
        metric_name: "artifact_backed_release_verified",
        baseline_value: 0,
        observed_value: 1,
        score_delta: 1,
        observation_sha256: observationArtifact.sha256,
      },
      source_hashes: {
        result_sha256: "8".repeat(64),
        qa_sha256: lineage.qaArtifact.sha256,
        release_sha256: lineage.releaseArtifact.sha256,
        observation_sha256: observationArtifact.sha256,
        measurement_source_sha256: measuredSourceArtifact.sha256,
        next_research_authority_sha256: authority.sha256,
      },
      next_research_authority: {
        schema_version: "pos.next_research_authorization.v1",
        artifact_ref: authority.path,
        artifact_sha256: authority.sha256,
        payload_sha256: authorityPayloadSha256,
        not_before: notBefore.toISOString(),
        expires_at: nextExpiresAt.toISOString(),
      },
      final_disposition: "operational_learning_recorded",
      immutable: true,
    });
    const receiptBase = {
      type: "learning_receipt",
      schemaVersion: "pos.learning_receipt.v2",
      artifactRef: artifact.path,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      attributes: {
        attempt: 0,
        artifact_hash: artifact.sha256,
        measured_external_or_operational_evidence: true,
        source_artifact_hash: observationArtifact.sha256,
        validation_outcome_hash: "a".repeat(64),
        learning_receipt_hash: artifact.sha256,
        next_cheapest_validation_step: "Measure the next authorized cohort",
        next_research_authority_ref: authority.path,
        next_research_authority_sha256: authority.sha256,
        next_research_payload_sha256: authorityPayloadSha256,
        next_research_not_before: notBefore.toISOString(),
        next_research_expires_at: nextExpiresAt.toISOString(),
      },
    };
    const service = profitFlywheelService(db);
    const claim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: learning.id,
      stage: "learning",
      inputHash: learning.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    receiptBase.attributes.attempt = claim.attempt;
    const receipt: ProfitFlywheelReceiptInput = { ...receiptBase, contentHash: canonicalProfitFlywheelReceiptHash(receiptBase) };
    const binding = {
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      contentHash: receipt.contentHash,
      artifactRef: receipt.artifactRef,
    };
    const outputHash = hashProfitFlywheelValue({ stage: "learning", input_hash: learning.inputHash, receipts: [binding] });
    const first = await service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: learning.id,
      stage: "learning",
      inputHash: learning.inputHash,
      attempt: claim.attempt,
      claimNonce: claim.claim_nonce,
      state: "succeeded",
      outputHash,
      receipts: [receipt],
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    expect(first.status).toBe("acknowledged");
    const recoveredClaim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: learning.id,
      stage: "learning",
      inputHash: learning.inputHash,
      attempt: claim.attempt,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    expect(recoveredClaim.claim_nonce).toBe(claim.claim_nonce);
    const replay = await service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: event.id,
      workflowId: seeded.workflow.id,
      stageRunId: learning.id,
      stage: "learning",
      inputHash: learning.inputHash,
      attempt: claim.attempt,
      claimNonce: recoveredClaim.claim_nonce,
      state: "succeeded",
      outputHash,
      receipts: [receipt],
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    expect(replay.status).toBe("already_acknowledged");
    expect((await db.select().from(issues)).find((row) => row.id === seeded.issueId)?.status).toBe("done");
    const research = (await db.select().from(profitFlywheelStageRuns)).find((row) => row.workflowId === seeded.workflow.id && row.stage === "research_intake");
    expect(research, JSON.stringify(await db.select().from(profitFlywheelEvents))).toMatchObject({ state: "pending", ownerPlane: "portfolio_os", linkedIssueId: null });
    const pendingResearchEvent = (await db.select().from(profitFlywheelEvents)).find((row) => row.stageRunId === research?.id && row.eventType === "portfolio_os_stage_requested")!;
    expect(pendingResearchEvent.nextAttemptAt.toISOString()).toBe(notBefore.toISOString());
    expect(pendingResearchEvent).toMatchObject({ attemptCount: 0, lastError: null, processedAt: null });
    expect((await service.listPortfolioOsOutbox(seeded.companyId)).events.some((candidate) => candidate.stage === "research_intake")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const page = await service.listPortfolioOsOutbox(seeded.companyId);
    const dueResearchEvent = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, pendingResearchEvent.id)).then((rows) => rows[0]!);
    expect(dueResearchEvent).toMatchObject({ attemptCount: 0, lastError: null, processedAt: null });
    expect(page.events.filter((candidate) => candidate.stage === "research_intake")).toHaveLength(1);
    expect(page.events).toEqual(expect.arrayContaining([expect.objectContaining({
      stage: "research_intake",
      stage_run_id: research?.id,
      transition_source_stage_run_id: learning.id,
      source_hashes: expect.objectContaining({
        source_registry_hash: registry.registry.sha256,
        selection_hash: outputHash,
        research_plan_hash: expect.any(String),
      }),
      executor: {
        route: "market_voc_source_pipeline",
        invocation: "event_driven",
        command: `./bin/pos paperclip-research-plane --company-id ${seeded.companyId}`,
        next_owner: "portfolio_os_market_voc_source_executor",
      },
      research_plan: expect.objectContaining({
        schema_version: "paperclip.research_plan.v2",
        authority: {
          artifact_ref: authority.path,
          artifact_sha256: authority.sha256,
          payload_sha256: authorityPayloadSha256,
        },
        source_registry: registry.registry,
        evidence_families: authorization.evidence_families,
        query_families: authorization.query_families,
        query,
        source_requests: authorization.source_requests,
        source_plan_hash: authorization.source_plan_hash,
        target_repo: seeded.workflow.targetRepo,
      }),
    })]));
    const researchEvent = page.events.find((candidate) => candidate.stage === "research_intake")!;
    expect(researchEvent).toMatchObject({ attempt: 1, max_attempts: expect.any(Number), claim_active: false });
    expect(researchEvent.ack.claim_path).toBe(`/api/companies/${seeded.companyId}/profit-flywheel/portfolio-os-outbox/${researchEvent.event_id}/claim`);
    const researchClaim = await service.claimPortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: researchEvent.event_id,
      workflowId: seeded.workflow.id,
      stageRunId: research!.id,
      stage: "research_intake",
      inputHash: research!.inputHash,
      attempt: 1,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    const activeResearchPage = await service.listPortfolioOsOutbox(seeded.companyId, { stages: ["research_intake"] });
    expect(activeResearchPage.events[0]).toMatchObject({ attempt: 1, claim_active: true });
    expect(JSON.stringify(activeResearchPage)).not.toContain(researchClaim.claim_nonce);
    const rawArtifact = await immutableArtifact("research-raw-evidence.json", { records: [{ id: "signal-1" }] });
    const sourceArtifact = await immutableArtifact("research-source-run.json", { source_ids: [sourceRequest.source_id], state: "succeeded" });
    const researchReceiptBases: Array<Omit<ProfitFlywheelReceiptInput, "contentHash">> = [
      {
        type: "source_run_receipt",
        schemaVersion: "pos.source_run_receipt.v2",
        artifactRef: sourceArtifact.path,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        attributes: {
          attempt: researchClaim.attempt,
          artifact_hash: sourceArtifact.sha256,
          validated_source_receipts: true,
          source_registry_hash: registry.registry.sha256,
          normalizer_version_hash: "7".repeat(64),
        },
      },
      {
        type: "raw_evidence_manifest",
        schemaVersion: "pos.raw_evidence_manifest.v2",
        artifactRef: rawArtifact.path,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        attributes: {
          attempt: researchClaim.attempt,
          artifact_hash: rawArtifact.sha256,
          raw_evidence_hash: rawArtifact.sha256,
        },
      },
    ];
    const researchReceipts = researchReceiptBases.map((base) => ({ ...base, contentHash: canonicalProfitFlywheelReceiptHash(base) }));
    const researchBindings = researchReceipts.map((receipt) => ({
      type: receipt.type,
      schemaVersion: receipt.schemaVersion,
      contentHash: receipt.contentHash,
      artifactRef: receipt.artifactRef,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const researchOutputHash = hashProfitFlywheelValue({
      stage: "research_intake",
      input_hash: research!.inputHash,
      receipts: researchBindings,
    });
    const researchAck = () => service.acknowledgePortfolioOsOutbox({
      companyId: seeded.companyId,
      eventId: researchEvent.event_id,
      workflowId: seeded.workflow.id,
      stageRunId: research!.id,
      stage: "research_intake",
      inputHash: research!.inputHash,
      attempt: researchClaim.attempt,
      claimNonce: researchClaim.claim_nonce,
      state: "succeeded",
      outputHash: researchOutputHash,
      receipts: researchReceipts,
      principal: { type: "agent", id: seeded.orchestratorId },
    });
    expect((await researchAck()).status).toBe("acknowledged");
    expect((await researchAck()).status).toBe("already_acknowledged");
    const normalization = (await db.select().from(profitFlywheelStageRuns)).find((row) =>
      row.workflowId === seeded.workflow.id && row.stage === "evidence_normalization");
    expect(normalization).toMatchObject({
      state: "pending",
      ownerPlane: "portfolio_os",
      transitionSourceStageRunId: research!.id,
      sourceHashes: {
        raw_evidence_hash: rawArtifact.sha256,
        source_registry_hash: registry.registry.sha256,
        normalizer_version: "7".repeat(64),
      },
    });
  });
});
