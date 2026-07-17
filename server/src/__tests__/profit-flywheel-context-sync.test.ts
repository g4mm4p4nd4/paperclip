import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  contextLedgerEntries,
  createDb,
  heartbeatRuns,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { buildResolvedProviderRoute, loadProviderPolicyV2 } from "../services/provider-policy.js";
import { captureProfitFlywheelWorkspaceSnapshot } from "../services/profit-flywheel-workspace-state.js";
import {
  buildProfitFlywheelIdempotencyKey,
  buildWorkCanaryMeasuredSourceReceiptAttributes,
  buildProfitFlywheelServerObservationProof,
  buildProfitFlywheelStageInput,
  hashProfitFlywheelValue,
  profitFlywheelService,
  validateProfitFlywheelTestExecutionResult,
} from "../services/profit-flywheel.js";

describe("work-canary measured-source receipt identity", () => {
  it("always carries the authoritative positive stage attempt", () => {
    expect(buildWorkCanaryMeasuredSourceReceiptAttributes(
      { workflow_id: "workflow-1", stage_run_id: "stage-1", attempt: 2 },
      { artifact_hash: "a".repeat(64), attempt: 99 },
    )).toMatchObject({
      workflow_id: "workflow-1",
      stage_run_id: "stage-1",
      attempt: 2,
      artifact_hash: "a".repeat(64),
    });
    expect(() => buildWorkCanaryMeasuredSourceReceiptAttributes(
      { workflow_id: "workflow-1" },
      { artifact_hash: "a".repeat(64) },
    )).toThrow(/positive stage attempt/);
  });
});

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

type FixtureOptions = {
  workMode?: number;
  claimCommand?: string;
  claimCommands?: string[];
  requiredCommand?: string;
  forgedTestEvidence?: boolean;
  attemptDelta?: number;
  manifestHashOverride?: string;
  alternateReceiptPath?: boolean;
  baseOverride?: string;
  checkoutAlternateBranch?: boolean;
  missingUsage?: boolean;
  missingFinal?: boolean;
  dirtyTracked?: boolean;
  dirtyUntracked?: boolean;
  duplicateResolvedReceiptPath?: boolean;
  serverTestLimits?: { timeoutMs?: number; maxOutputBytes?: number };
};

describeDb("Profit Flywheel context-ledger work-result completion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureRoot = "";
  let serverArtifactRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-context-sync-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelLeases);
    await db.delete(contextLedgerEntries);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    if (serverArtifactRoot) await rm(serverArtifactRoot, { recursive: true, force: true });
  });

  afterAll(async () => tempDb?.cleanup());

  async function git(...args: string[]) {
    return execFile("git", ["-C", fixtureRoot, ...args], { timeout: 15_000 }).then(({ stdout }) => stdout.trim());
  }

  async function gitObjectSha256(objectId: string) {
    const objectType = await git("cat-file", "-t", objectId);
    const { stdout } = await execFile("git", ["-C", fixtureRoot, "cat-file", objectType, objectId], { timeout: 15_000 });
    const bytes = Buffer.from(stdout, "utf8");
    return createHash("sha256").update(Buffer.concat([
      Buffer.from(`${objectType} ${bytes.length}\0`, "utf8"),
      bytes,
    ])).digest("hex");
  }

  async function writeImmutable(filePath: string, value: Record<string, unknown>, mode = 0o444) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(filePath, bytes, { mode });
    await chmod(filePath, mode);
    return { path: await realpath(filePath), sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async function seedFixture(options: FixtureOptions = {}) {
    fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-profit-context-sync-workspace-")));
    serverArtifactRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-profit-context-sync-server-")));
    await execFile("git", ["init", "-b", "main", fixtureRoot]);
    await git("config", "user.email", "profit-canary@example.invalid");
    await git("config", "user.name", "Profit Canary");
    await writeFile(path.join(fixtureRoot, "README.md"), "# Profit canary\n");
    await git("add", "README.md");
    await git("commit", "-m", "base");
    const baseObject = await git("rev-parse", "HEAD");
    const runBranch = `run/${randomUUID()}/profit-canary`;
    await git("checkout", "-b", runBranch);
    await writeFile(path.join(fixtureRoot, "feature.txt"), "work-bearing change\n");
    await git("add", "feature.txt");
    await git("commit", "-m", "implement fixture");
    const targetObject = await git("rev-parse", "HEAD");
    const targetArtifactHash = await gitObjectSha256(targetObject);
    const requiredCommand = options.requiredCommand ?? "test -f feature.txt";
    const dispatchValue = {
      execution_manifest: {
        repo_target: {
          target_repo_branch: "main",
          suggested_branch_name: runBranch,
        },
        stage_acceptance: {
          qa: { commands: [requiredCommand] },
          release: { commands: ["git diff --check"] },
        },
      },
    };
    const dispatch = await writeImmutable(path.join(fixtureRoot, ".paperclip", "dispatch.json"), dispatchValue);
    const contract = await loadProfitFlywheelContract({ expectedSha256: "", expectedSchemaSha256: "" });
    const policy = await loadProviderPolicyV2();
    const routeEntry = Object.entries(policy.policy.routes).find(([, route]) => route.model.kind === "exact");
    if (!routeEntry) throw new Error("Test provider policy has no exact-model route");
    const [routeId, route] = routeEntry;
    const resolvedRoute = buildResolvedProviderRoute({
      policy: policy.policy,
      policySha256: policy.sha256,
      policySchemaSha256: policy.schemaSha256,
      routeId,
    });
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const ledgerEntryId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Context sync ${companyId.slice(0, 6)}`,
      issuePrefix: `CS${companyId.replaceAll("-", "").slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementation Engineer",
      role: "engineer",
      status: "running",
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
      title: "Work-bearing implementation",
      status: "in_progress",
      priority: "high",
    });
    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId,
      projectId,
      runId: `run-${randomUUID()}`,
      state: "running",
      currentStage: "implementation",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: dispatch.path,
      sourceDispatchHash: dispatch.sha256,
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: fixtureRoot,
      contractPath: contract.path,
      contractSha256: contract.sha256,
      contractSnapshot: contract.contract as unknown as Record<string, unknown>,
      correlationId: `profit:${randomUUID()}`,
      traceId: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32),
      feedback: {
        target_base_sha: baseObject,
        target_origin_url: "https://example.invalid/fixture/profit-canary.git",
        server_artifact_root: serverArtifactRoot,
        provider_policy: {
          path: policy.path,
          sha256: policy.sha256,
          schema_version: "provider-policy.v2",
          schema_path: policy.schemaPath,
          schema_sha256: policy.schemaSha256,
        },
      },
    }).returning().then((rows) => rows[0]!);

    // Execution manifests are valid only when the implementation stage is
    // descended from this iteration's completed, immutable dispatch. Seed the
    // same lineage that startFromDispatch/acknowledgePortfolioOsOutbox creates
    // in production instead of bypassing the authority boundary in the test.
    const dispatchSourceHashes = Object.fromEntries(
      contract.contract.stages.dispatch.input_hash_fields.map((field) => [
        field,
        hashProfitFlywheelValue({ field, dispatchSha256: dispatch.sha256 }),
      ]),
    );
    const dispatchInput = buildProfitFlywheelStageInput({
      contract: contract.contract,
      stage: "dispatch",
      sourceHashes: dispatchSourceHashes,
    });
    const dispatchStage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: workflow.id,
      companyId,
      stage: "dispatch",
      state: "succeeded",
      ownerPlane: "portfolio_os",
      inputSchemaVersion: contract.contract.stages.dispatch.input_schema,
      inputHash: dispatchInput.inputHash,
      sourceHashes: dispatchInput.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({
        companyId,
        runId: workflow.runId,
        stage: "dispatch",
        inputHash: dispatchInput.inputHash,
      }),
      maxAttempts: Math.max(1, contract.contract.stages.dispatch.retry.limit + 1),
      attemptCount: 1,
      linkedIssueId: issueId,
      providerCapabilityClass: contract.contract.stages.dispatch.provider_capability_class,
      concurrencyKey: contract.contract.stages.dispatch.concurrency_key,
      concurrencyLimit: contract.contract.stages.dispatch.concurrency_limit,
      requiredReceipts: contract.contract.stages.dispatch.required_receipts,
      completionEvidence: contract.contract.stages.dispatch.completion_evidence,
      feedback: { output_hash: dispatch.sha256 },
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: createHash("sha256").update(`dispatch:${workflow.id}`).digest("hex").slice(0, 16),
      startedAt: new Date(),
      completedAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    const dispatchReceiptHash = hashProfitFlywheelValue({
      schema_version: "pos.dispatch.v2",
      workflow_id: workflow.id,
      stage_run_id: dispatchStage.id,
      dispatch_hash: dispatch.sha256,
      artifact_ref: dispatch.path,
    });
    await db.insert(profitFlywheelReceipts).values({
      companyId,
      workflowId: workflow.id,
      stageRunId: dispatchStage.id,
      receiptType: "immutable_dispatch_artifact",
      schemaVersion: "pos.dispatch.v2",
      contentHash: dispatchReceiptHash,
      artifactRef: dispatch.path,
      status: "valid",
      observedAt: new Date(),
      attributes: {
        workflow_id: workflow.id,
        stage_run_id: dispatchStage.id,
        input_hash: dispatchStage.inputHash,
        authoring_inputs: dispatchStage.sourceHashes,
        dispatch_hash: dispatch.sha256,
        artifact_hash: dispatch.sha256,
        issue_id: issueId,
      },
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: dispatchStage.spanId,
    });
    const sourceHashes = Object.fromEntries(
      contract.contract.stages.implementation.input_hash_fields.map((field) => [field, hashProfitFlywheelValue({ field, targetObject })]),
    );
    sourceHashes.dispatch_hash = dispatch.sha256;
    const canonicalInput = buildProfitFlywheelStageInput({ contract: contract.contract, stage: "implementation", sourceHashes });
    const stage = await db.insert(profitFlywheelStageRuns).values({
      workflowId: workflow.id,
      companyId,
      stage: "implementation",
      state: "running",
      ownerPlane: "paperclip",
      inputSchemaVersion: contract.contract.stages.implementation.input_schema,
      inputHash: canonicalInput.inputHash,
      sourceHashes: canonicalInput.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({ companyId, runId: workflow.runId, stage: "implementation", inputHash: canonicalInput.inputHash }),
      maxAttempts: Math.max(1, contract.contract.stages.implementation.retry.limit + 1),
      attemptCount: 1,
      linkedIssueId: issueId,
      providerCapabilityClass: contract.contract.stages.implementation.provider_capability_class,
      providerRouteId: routeId,
      providerFamily: route.providerFamily,
      providerModel: route.model.kind === "exact" ? route.model.value : null,
      providerModelVersion: route.model.version,
      providerPolicySha256: policy.sha256,
      providerRouteCoreSha256: resolvedRoute.policyRouteCoreSha256,
      providerRouteSha256: resolvedRoute.resolvedRouteSha256,
      providerRouteSnapshot: resolvedRoute,
      concurrencyKey: contract.contract.stages.implementation.concurrency_key,
      concurrencyLimit: contract.contract.stages.implementation.concurrency_limit,
      requiredReceipts: contract.contract.stages.implementation.required_receipts,
      completionEvidence: contract.contract.stages.implementation.completion_evidence,
      leaseOwner: `system:${runId}:fixture`,
      leaseActorType: "system",
      leaseActorId: runId,
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      heartbeatAt: new Date(),
      startedAt: new Date(),
      feedback: {
        iteration_dispatch_binding: {
          schema_version: "paperclip.profit_flywheel_iteration_dispatch_binding.v1",
          dispatch_stage_run_id: dispatchStage.id,
          dispatch_artifact_ref: dispatch.path,
          dispatch_artifact_hash: dispatch.sha256,
          dispatch_receipt_hash: dispatchReceiptHash,
          dispatch_input_hash: dispatchStage.inputHash,
          authoring_inputs: dispatchStage.sourceHashes,
        },
      },
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16),
    }).returning().then((rows) => rows[0]!);
    const service = profitFlywheelService(db, {
      serverTestLimits: options.serverTestLimits,
      serverArtifactRoot,
    });
    const manifest = await service.buildExecutionManifest({ stageRunId: stage.id });
    const workResultPath = options.alternateReceiptPath
      ? path.join(fixtureRoot, ".paperclip", "receipts", "wrong-work-result.json")
      : manifest.receiptOutputPath;
    const testClaims: Record<string, unknown>[] = (options.claimCommands ?? [options.claimCommand ?? requiredCommand])
      .map((command) => ({ command }));
    if (options.forgedTestEvidence) Object.assign(testClaims[0]!, { exit_code: 0, artifact_ref: "/tmp/fake.log", artifact_hash: "a".repeat(64) });
    const workResult = {
      schema_version: "paperclip.profit_flywheel_stage_work_result.v1",
      execution_manifest_sha256: options.manifestHashOverride ?? manifest.manifestSha256,
      execution_manifest_file_sha256: manifest.manifestBinding.file_sha256,
      company_id: companyId,
      workflow_id: workflow.id,
      stage_run_id: stage.id,
      issue_id: issueId,
      correlation_id: workflow.correlationId,
      trace_id: workflow.traceId,
      stage: "implementation",
      attempt: stage.attemptCount + (options.attemptDelta ?? 0),
      input_hash: stage.inputHash,
      tests: testClaims,
      workspace: {
        root: fixtureRoot,
        changed_files: ["feature.txt"],
        base_git_object: options.baseOverride ?? baseObject,
        target_git_object: targetObject,
        target_artifact_hash: targetArtifactHash,
      },
    };
    const work = await writeImmutable(workResultPath, workResult, options.workMode ?? 0o444);
    if (options.checkoutAlternateBranch) await git("checkout", "-b", "alternate-review-branch");
    if (options.dirtyTracked) await writeFile(path.join(fixtureRoot, "feature.txt"), "uncommitted fix\n");
    if (options.dirtyUntracked) await writeFile(path.join(fixtureRoot, "untracked-fix.txt"), "not in target object\n");
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      executionEvidenceNonce: createHash("sha256").update(`execution-evidence:${runId}`).digest("hex"),
      exitCode: 0,
      usageJson: options.missingUsage ? null : { inputTokens: 120, outputTokens: 40 },
      contextSnapshot: {
        profitFlywheelStageRunId: stage.id,
        issueId,
        paperclipContextLedger: { entryId: ledgerEntryId },
        paperclipProfitFlywheelExecutionManifest: manifest.manifestBinding,
        paperclipProfitFlywheelExecutionManifestSha256: manifest.manifestSha256,
      },
    });
    await db.insert(contextLedgerEntries).values({
      id: ledgerEntryId,
      companyId,
      runId,
      agentId,
      issueId,
      cwd: fixtureRoot,
      branch: options.checkoutAlternateBranch ? "alternate-review-branch" : runBranch,
      adapterType: "hermes_local",
      promptClass: "implementation",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "f".repeat(64),
      finalResponseChars: options.missingFinal ? null : 64,
      finalResponseSha256: options.missingFinal ? null : "1".repeat(64),
      finalOutcome: options.missingFinal ? null : "pending_flywheel_sync",
      receiptPaths: options.duplicateResolvedReceiptPath
        ? [work.path, path.relative(fixtureRoot, work.path)]
        : [work.path],
    });
    return {
      service,
      stage,
      workflow,
      manifest,
      work,
      baseObject,
      targetObject,
      runBranch,
      runId,
      ledgerEntryId,
      serverArtifactRoot,
    };
  }

  async function expectServerTestBlock(options: FixtureOptions, blockerCode: string) {
    const fixture = await seedFixture(options);
    const result = await fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    });
    expect(result).toMatchObject({ status: "incomplete", blocker: { blocker_code: blockerCode } });
    if (result.status !== "incomplete") throw new Error(`Expected incomplete result, received ${result.status}`);
    const match = result.blocker.blocker_detail.match(/immutable_failure_receipt=(.*?) sha256=([0-9a-f]{64})$/);
    expect(match).not.toBeNull();
    const receiptPath = match![1]!;
    const receiptSha256 = match![2]!;
    const bytes = await readFile(receiptPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receiptSha256);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o444);
    const receipt = validateProfitFlywheelTestExecutionResult(JSON.parse(bytes.toString("utf8")));
    expect(receipt).toMatchObject({ outcome: "failed", failure_class: blockerCode, authority: "paperclip_server_observed" });
  }

  it("synthesizes provider/test execution evidence, reconciles a torn sync, then completes exactly once", async () => {
    const fixture = await seedFixture();
    const manifestValue = JSON.parse(await readFile(fixture.manifest.manifestBinding.path, "utf8"));
    expect(manifestValue.work_result_contract).toMatchObject({
      schema_version: "paperclip.profit_flywheel_stage_work_result.v1",
      schema_authority: {
        schemaVersion: "paperclip.profit_flywheel_stage_work_result.v1",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      additional_properties: false,
      exact_shapes: {
        tests: [{ command: expect.stringContaining("required_test_commands") }],
        workspace: {
          root: "<workspace.root>",
          changed_files: ["<sorted base-to-target path; at least one>"],
          base_git_object: "<workspace.base_git_object>",
          target_git_object: "<full run-branch HEAD commit id>",
          target_artifact_hash: "<target_artifact_hash_authority helper sha256>",
        },
      },
    });
    const hashAuthority = manifestValue.target_artifact_hash_authority;
    expect(manifestValue.implementation_completion_requirements).toEqual({
      target_git_object_type: "commit",
      target_git_object_must_equal_branch_head: true,
      branch_must_equal: fixture.runBranch,
      worktree_must_be_clean_outside_paperclip: true,
      changed_files_authority: "git diff --name-only <base_git_object> <target_git_object>",
      required_sequence: [
        "implement_and_test",
        "create_commit_on_authorized_run_branch",
        "verify_clean_worktree_outside_.paperclip",
        "compute_target_artifact_hash_from_commit",
        "write_read_only_work_result",
      ],
    });
    expect(hashAuthority).toMatchObject({
      algorithm: "sha256",
      canonical_bytes: "<git-object-type> <body-byte-length>\\0<body>",
      helper: {
        command: "/usr/bin/env",
        cwd_independent: true,
        bounded_tmpdir: "/tmp",
        working_directory: fixture.workflow.targetWorkspaceRoot,
        replacement_required: { placeholder: "<target_git_object>" },
      },
    });
    expect(hashAuthority.helper.argv.slice(0, 6)).toEqual([
      "TMPDIR=/tmp",
      "pnpm",
      "--silent", "--dir",
      path.resolve(import.meta.dirname, "../../.."),
      "ops:git-object-sha256",
    ]);
    const helperArgv = hashAuthority.helper.argv.map((value: string) =>
      value === "<target_git_object>" ? fixture.targetObject : value);
    const helperResult = await execFile(hashAuthority.helper.command, helperArgv, {
      cwd: fixture.workflow.targetWorkspaceRoot,
      timeout: 30_000,
    }).then(({ stdout }) => JSON.parse(stdout));
    expect(helperResult).toMatchObject({
      object: fixture.targetObject,
      type: "commit",
      sha256: await gitObjectSha256(fixture.targetObject),
    });
    const now = new Date("2026-07-12T04:00:00.000Z");
    await db.update(profitFlywheelStageRuns).set({ leaseExpiresAt: new Date("2026-07-12T05:00:00.000Z") }).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    const firstSync = await fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id, now });
    expect(firstSync, JSON.stringify(firstSync))
      .toMatchObject({ status: "receipts_ready", stageRunId: fixture.stage.id });
    expect(await fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id, now }))
      .toMatchObject({ status: "receipts_ready", stageRunId: fixture.stage.id });
    const completed = await fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
      leaseOwner: fixture.stage.leaseOwner!,
      now,
    });
    expect(completed).toMatchObject({ status: "complete", stageRunId: fixture.stage.id });
    const stage = await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(stage.state).toBe("succeeded");
    const receipts = await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id));
    expect(receipts.map((row) => row.receiptType).sort()).toEqual(["implementation_receipt", "issue_receipt", "provider_run_receipt"]);
    const provider = receipts.find((row) => row.receiptType === "provider_run_receipt")!;
    expect(provider.attributes).toMatchObject({
      workflow_id: fixture.workflow.id,
      stage_run_id: fixture.stage.id,
      correlation_id: fixture.workflow.correlationId,
      trace_id: fixture.workflow.traceId,
      attempt: fixture.stage.attemptCount,
      input_hash: fixture.stage.inputHash,
      execution_manifest_path: fixture.manifest.manifestBinding.path,
      execution_manifest_sha256: fixture.manifest.manifestSha256,
      execution_manifest_file_sha256: fixture.manifest.manifestBinding.file_sha256,
      work_result_path: fixture.work.path,
      work_result_sha256: fixture.work.sha256,
      execution_receipt_path: provider.artifactRef,
      execution_receipt_sha256: provider.attributes.artifact_hash,
      final_response_sha256: "1".repeat(64),
      usage: { input_tokens: 120, output_tokens: 40 },
    });
  });

  it("counts one immutable work result once when absolute and workspace-relative paths resolve identically", async () => {
    const fixture = await seedFixture({ duplicateResolvedReceiptPath: true });
    const entry = await db.select().from(contextLedgerEntries)
      .where(eq(contextLedgerEntries.id, fixture.ledgerEntryId))
      .then((rows) => rows[0]!);
    expect(entry.receiptPaths).toHaveLength(2);
    expect(new Set(entry.receiptPaths)).toHaveLength(2);

    const now = new Date("2026-07-12T04:00:00.000Z");
    await db.update(profitFlywheelStageRuns)
      .set({ leaseExpiresAt: new Date("2026-07-12T05:00:00.000Z") })
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    await expect(fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
      now,
    })).resolves.toMatchObject({ status: "receipts_ready", stageRunId: fixture.stage.id });
    await expect(fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
      leaseOwner: fixture.stage.leaseOwner!,
      now,
    })).resolves.toMatchObject({ status: "complete", stageRunId: fixture.stage.id });
  });

  it.each([
    ["wrong attempt", { attemptDelta: 1 }, "attempt"],
    ["wrong manifest hash", { manifestHashOverride: "9".repeat(64) }, "execution_manifest_sha256"],
  ])("classifies %s at the exact receipt path as an identity mismatch", async (_label, options, field) => {
    const fixture = await seedFixture(options);
    const result = await fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      blocker: {
        blocker_code: "context_ledger_work_result_identity_mismatch",
        next_owner: "paperclip_orchestrator",
      },
    });
    if (result.status === "incomplete") expect(result.blocker.blocker_detail).toContain(field);
  });

  it("classifies a schema-invalid immutable receipt as fresh-attempt work instead of throwing", async () => {
    const fixture = await seedFixture({ manifestHashOverride: "9".repeat(63) });
    await expect(fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    })).resolves.toMatchObject({
      status: "incomplete",
      blocker: {
        blocker_code: "context_ledger_work_result_schema_invalid",
        blocker_detail: expect.stringContaining("execution_manifest_sha256"),
        next_owner: "paperclip_orchestrator",
        resume_condition: expect.stringContaining("fresh attempt"),
      },
    });
  });

  it.each([
    ["wrong receipt path", { alternateReceiptPath: true }],
    ["wrong mode 0400", { workMode: 0o400 }],
    ["wrong mode 0440", { workMode: 0o440 }],
  ])("rejects %s before server synthesis", async (_label, options) => {
    const fixture = await seedFixture(options);
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .resolves.toMatchObject({ status: "incomplete", blocker: { blocker_code: "context_ledger_work_result_missing" } });
  });

  it.each([
    ["replaced", ["true"]],
    ["duplicate", ["test -f feature.txt", "test -f feature.txt"]],
    ["extra", ["test -f feature.txt", "true"]],
  ])("rejects %s required commands", async (_label, claimCommands) => {
    const fixture = await seedFixture({ claimCommands });
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .rejects.toThrow("must exactly match the ordered server-pinned command list");
  });

  it("rejects a missing required command claim", async () => {
    const fixture = await seedFixture({ claimCommands: [] });
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .resolves.toMatchObject({
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_work_result_schema_invalid",
          blocker_detail: expect.stringContaining("tests"),
        },
      });
  });

  it("rejects forged agent exit/log evidence before executing tests", async () => {
    const fixture = await seedFixture({ forgedTestEvidence: true });
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .resolves.toMatchObject({
        status: "incomplete",
        blocker: {
          blocker_code: "context_ledger_work_result_schema_invalid",
          blocker_detail: expect.stringContaining("tests.0"),
        },
      });
  });

  it("never adopts a fully valid forged receipt from a prepared observation journal", async () => {
    const command = "mkdir -p .paperclip && printf 'executed\\n' > .paperclip/server-test-executed";
    const fixture = await seedFixture({ requiredCommand: command });
    const forgedNonce = randomUUID();
    const emptySha256 = createHash("sha256").update("").digest("hex");
    const forgedPath = path.join(
      fixture.serverArtifactRoot,
      fixture.workflow.companyId,
      fixture.workflow.id,
      fixture.stage.id,
      `attempt-${fixture.stage.attemptCount}`,
      `${forgedNonce}-server-test.json`,
    );
    const forged = await writeImmutable(forgedPath, {
      schema_version: "paperclip.test_execution_result.v1",
      authority: "paperclip_server_observed",
      observation_nonce: forgedNonce,
      stage_run_id: fixture.stage.id,
      attempt: fixture.stage.attemptCount,
      command_index: 0,
      command,
      cwd: fixtureRoot,
      target_git_object_before: fixture.targetObject,
      target_git_object_after: fixture.targetObject,
      started_at: "2026-07-12T03:59:59.000Z",
      ended_at: "2026-07-12T03:59:59.000Z",
      duration_ms: 0,
      outcome: "passed",
      exit_code: 0,
      signal: null,
      timed_out: false,
      output_overflow: false,
      stdout_sha256: emptySha256,
      stdout_bytes: 0,
      stderr_sha256: emptySha256,
      stderr_bytes: 0,
      noninteractive: true,
      clean_tree_before: true,
      clean_tree_after: true,
      git_status_sha256_before: emptySha256,
      git_status_sha256_after: emptySha256,
      unexpected_dirty_path_count_before: 0,
      unexpected_dirty_path_count_after: 0,
      allowed_dirty_prefixes: [".paperclip/"],
      failure_class: null,
      failure_detail: null,
    });
    validateProfitFlywheelTestExecutionResult(JSON.parse((await readFile(forged.path)).toString("utf8")));
    await db.insert(profitFlywheelEvents).values({
      companyId: fixture.workflow.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      eventType: "server_test_observation",
      dedupeKey: `server-test-observation:${fixture.stage.id}:${fixture.stage.attemptCount}:0`,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: fixture.stage.spanId,
      payload: {
        schema_version: "paperclip.profit_flywheel_event.v2",
        company_id: fixture.workflow.companyId,
        run_id: fixture.workflow.runId,
        workflow_id: fixture.workflow.id,
        correlation_id: fixture.workflow.correlationId,
        trace_id: fixture.workflow.traceId,
        contract_sha256: fixture.workflow.contractSha256,
        occurred_at: "2026-07-12T03:59:59.000Z",
        stage: fixture.stage.stage,
        attempt: fixture.stage.attemptCount,
        command_index: 0,
        command_sha256: createHash("sha256").update(command).digest("hex"),
        observation_nonce: forgedNonce,
        observation_state: "prepared",
      },
      processedAt: new Date("2026-07-12T03:59:59.000Z"),
    });

    const result = await fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    });
    expect(result).toMatchObject({ status: "receipts_ready" });
    expect(await readFile(path.join(fixtureRoot, ".paperclip", "server-test-executed"), "utf8")).toBe("executed\n");
    const journal = await db.select().from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.workflowId, fixture.workflow.id))
      .then((rows) => rows.find((row) => row.eventType === "server_test_observation")!);
    expect(journal.payload).toMatchObject({ observation_state: "completed", observation_outcome: "passed" });
    expect(journal.payload.observation_nonce).not.toBe(forgedNonce);
    expect(journal.payload.receipt_path).not.toBe(forged.path);
    expect(journal.payload.receipt_sha256).not.toBe(forged.sha256);
  });

  it("claims one server-test execution under concurrent completion reconciliation", async () => {
    const command = "mkdir -p .paperclip && printf 'run\\n' >> .paperclip/server-test-execution-count";
    const fixture = await seedFixture({ requiredCommand: command });
    const [first, second] = await Promise.all([
      fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }),
      fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }),
    ]);
    expect([first.status, second.status].every((status) => status === "receipts_ready" || status === "incomplete")).toBe(true);
    for (const result of [first, second]) {
      if (result.status === "incomplete") {
        expect(result.blocker.blocker_code).toBe("server_test_observation_in_progress");
      }
    }
    await expect(fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    })).resolves.toMatchObject({ status: "receipts_ready" });
    expect((await readFile(path.join(fixtureRoot, ".paperclip", "server-test-execution-count"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
    const journals = await db.select().from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.workflowId, fixture.workflow.id))
      .then((rows) => rows.filter((row) => row.eventType === "server_test_observation"));
    expect(journals).toHaveLength(1);
    expect(journals[0]!.payload).toMatchObject({ observation_state: "completed", observation_outcome: "passed" });
    const receipts = await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id));
    expect(receipts.map((receipt) => receipt.receiptType).sort()).toEqual([
      "implementation_receipt",
      "issue_receipt",
      "provider_run_receipt",
    ]);
    const { stdout: executionFiles } = await execFile("find", [fixture.serverArtifactRoot, "-type", "f", "-name", "*-execution.json"]);
    expect(executionFiles.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    const providerReceipt = receipts.find((receipt) => receipt.receiptType === "provider_run_receipt")!;
    await chmod(providerReceipt.artifactRef!, 0o644);
    await writeFile(providerReceipt.artifactRef!, "{}\n");
    await chmod(providerReceipt.artifactRef!, 0o444);
    await expect(fixture.service.recordReceipt({
      stageRunId: fixture.stage.id,
      trustedExecutionSync: true,
      receipt: {
        type: providerReceipt.receiptType,
        schemaVersion: providerReceipt.schemaVersion,
        contentHash: providerReceipt.contentHash,
        artifactRef: providerReceipt.artifactRef,
        observedAt: providerReceipt.observedAt.toISOString(),
        expiresAt: providerReceipt.expiresAt?.toISOString() ?? null,
        attributes: providerReceipt.attributes,
      },
    })).rejects.toThrow();
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))).toHaveLength(3);
  });

  it.each([
    ["deletes the execution manifest", "rm -f .paperclip/manifests/*-attempt-1.json"],
    [
      "rewrites the agent work result",
      "work=$(find .paperclip/receipts -type f -name '*-attempt-1-work-result.json' -print -quit); chmod u+w \"$work\"; printf '{}\\n' > \"$work\"; chmod 0444 \"$work\"",
    ],
  ])("blocks success when a passing server test %s", async (_label, requiredCommand) => {
    const fixture = await seedFixture({ requiredCommand });
    const result = await fixture.service.syncContextLedgerCompletion({
      contextLedgerEntryId: fixture.ledgerEntryId,
      stageRunId: fixture.stage.id,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      blocker: { blocker_code: "execution_authority_drift_after_tests" },
    });
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))).toHaveLength(0);
  });

  it("fails closed when final response or normalized usage is missing", async () => {
    const missingFinal = await seedFixture({ missingFinal: true });
    await expect(missingFinal.service.syncContextLedgerCompletion({ contextLedgerEntryId: missingFinal.ledgerEntryId, stageRunId: missingFinal.stage.id }))
      .resolves.toMatchObject({ status: "incomplete", blocker: { blocker_code: "context_ledger_incomplete_final" } });
  });

  it("fails closed when normalized usage is missing", async () => {
    const fixture = await seedFixture({ missingUsage: true });
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .resolves.toMatchObject({ status: "incomplete", blocker: { blocker_code: "provider_result_observation_invalid" } });
  });

  it.each([
    ["nonzero exit", { requiredCommand: "exit 7" }, "target_test_failure"],
    ["timeout", { requiredCommand: "sleep 1", serverTestLimits: { timeoutMs: 25 } }, "target_test_timeout"],
    ["overflow", { requiredCommand: "yes x | head -c 4096", serverTestLimits: { maxOutputBytes: 1024 } }, "unsafe_test_output"],
    ["secret-like output", { requiredCommand: "printf 'bearer %s' 'abcdefghijklmnop'" }, "unsafe_test_output"],
    ["tracked dirty code", { dirtyTracked: true }, "workspace_dirty"],
    ["untracked fix absent from target", { requiredCommand: "test -f untracked-fix.txt", dirtyUntracked: true }, "workspace_dirty"],
  ] as const)("persists and classifies %s", async (_label, options, blockerCode) => {
    await expectServerTestBlock(options, blockerCode);
  });

  it("rejects alternate implementation base and run branch", async () => {
    const wrongBase = await seedFixture({ baseOverride: "2".repeat(40) });
    await expect(wrongBase.service.syncContextLedgerCompletion({ contextLedgerEntryId: wrongBase.ledgerEntryId, stageRunId: wrongBase.stage.id }))
      .rejects.toThrow("requires canonical workspace, base/target git objects, and changed files");
  });

  it("rejects an alternate run branch even when it points to the same target object", async () => {
    const fixture = await seedFixture({ checkoutAlternateBranch: true });
    await expect(fixture.service.syncContextLedgerCompletion({ contextLedgerEntryId: fixture.ledgerEntryId, stageRunId: fixture.stage.id }))
      .rejects.toThrow("exact HEAD of the authorized run branch");
  });

  it("synthesizes one server-observed process_lost adjudication when a claimed heartbeat dies", async () => {
    const fixture = await seedFixture();
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1_000);
    await db.update(profitFlywheelStageRuns).set({ leaseExpiresAt: expiredAt, heartbeatAt: expiredAt })
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    await db.insert(profitFlywheelEvents).values({
      companyId: fixture.workflow.companyId,
      workflowId: fixture.workflow.id,
      stageRunId: fixture.stage.id,
      eventType: "stage_started",
      dedupeKey: `stage-started:${fixture.stage.id}:${fixture.stage.attemptCount}`,
      fromState: "pending",
      toState: "running",
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: fixture.stage.spanId,
      payload: {
        stage: fixture.stage.stage,
        attempt: fixture.stage.attemptCount,
        input_hash: fixture.stage.inputHash,
        provider_route_id: fixture.stage.providerRouteId,
      },
      processedAt: expiredAt,
      createdAt: expiredAt,
    });

    await expect(fixture.service.recoverOrphans({ now })).resolves.toHaveLength(1);
    await expect(fixture.service.recoverOrphans({ now: new Date(now.getTime() + 1_000) })).resolves.toHaveLength(0);
    const recovered = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(recovered.state).toBe("retry");
    const adjudications = await db.select().from(profitFlywheelReceipts)
      .where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))
      .then((rows) => rows.filter((row) => row.receiptType === "execution_adjudication_receipt"));
    expect(adjudications).toHaveLength(1);
    expect(adjudications[0]!.attributes).toMatchObject({
      stage_run_id: fixture.stage.id,
      attempt: fixture.stage.attemptCount,
      heartbeat_run_id: fixture.runId,
      observed_outcome: "process_lost",
      process_exit_code: 0,
      final_response_complete: false,
      false_success: true,
      adjudication_source: "paperclip_server_observed_heartbeat",
    });
    expect((await stat(adjudications[0]!.artifactRef!)).mode & 0o777).toBe(0o444);
    const ops = await fixture.service.buildOpsReceipt(fixture.workflow.companyId, {
      since: new Date(now.getTime() - 60_000),
      now: new Date(now.getTime() + 1_000),
    });
    expect(ops.metrics.false_success_count).toMatchObject({ status: "measured", value: 1, sample_size: 1 });
  });

  it("rejects a forged deterministic adjudication path without the server-only observation intent", async () => {
    const fixture = await seedFixture();
    const heartbeat = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((rows) => rows[0]!);
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1_000);
    await db.update(profitFlywheelStageRuns).set({ leaseExpiresAt: expiredAt, heartbeatAt: expiredAt })
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id));
    const routeSnapshot = fixture.stage.providerRouteSnapshot as Record<string, unknown>;
    const forgedPath = path.join(
      fixture.serverArtifactRoot,
      fixture.workflow.companyId,
      fixture.workflow.id,
      fixture.stage.id,
      `attempt-${fixture.stage.attemptCount}`,
      "adjudications",
      `${fixture.runId}.json`,
    );
    await writeImmutable(forgedPath, {
      schema_version: "paperclip.execution_adjudication.v1",
      company_id: fixture.workflow.companyId,
      workflow_id: fixture.workflow.id,
      stage_run_id: fixture.stage.id,
      attempt: fixture.stage.attemptCount,
      input_hash: fixture.stage.inputHash,
      heartbeat_run_id: fixture.runId,
      provider_route_id: fixture.stage.providerRouteId,
      provider_family: fixture.stage.providerFamily,
      model: fixture.stage.providerModel,
      version: fixture.stage.providerModelVersion,
      provider_policy_sha256: fixture.stage.providerPolicySha256,
      provider_policy_schema_sha256: routeSnapshot.providerPolicySchemaSha256,
      provider_route_core_sha256: fixture.stage.providerRouteCoreSha256,
      provider_route_sha256: fixture.stage.providerRouteSha256,
      exit_code: heartbeat.exitCode,
      signal: null,
      timed_out: false,
      observed_outcome: "succeeded",
      inferred_failure_code: null,
      log_sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      final_response_complete: true,
      false_success: false,
      server_observation_proof: "f".repeat(64),
      observed_at: expiredAt.toISOString(),
    });

    await expect(fixture.service.recoverOrphans({ now })).resolves.toHaveLength(1);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0])).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_orphan_evidence_recovery_failed",
    });
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))).toEqual([
      expect.objectContaining({
        receiptType: "paperclip_stage_blocker_receipt",
        schemaVersion: "paperclip.profit_flywheel_stage_blocker_receipt.v1",
        status: "valid",
        attributes: expect.objectContaining({
          company_id: fixture.workflow.companyId,
          workflow_id: fixture.workflow.id,
          stage_run_id: fixture.stage.id,
          input_hash: fixture.stage.inputHash,
          blocker_code: "profit_flywheel_orphan_evidence_recovery_failed",
        }),
      }),
    ]);
  });

  it("adopts a fully published checkpoint pair after a kill before the database CAS", async () => {
    const fixture = await seedFixture();
    const snapshot = await captureProfitFlywheelWorkspaceSnapshot(fixture.workflow.targetWorkspaceRoot);
    const checkpointDirectory = path.join(
      fixture.serverArtifactRoot,
      fixture.workflow.companyId,
      fixture.workflow.id,
      fixture.stage.id,
      `attempt-${fixture.stage.attemptCount}`,
      "checkpoints",
    );
    const executionEvidenceNonce = createHash("sha256").update(`execution-evidence:${fixture.runId}`).digest("hex");
    const workspaceValue: Record<string, unknown> = {
      schema_version: "paperclip.profit_flywheel_workspace_evidence.v1",
      company_id: fixture.workflow.companyId,
      workflow_id: fixture.workflow.id,
      stage_run_id: fixture.stage.id,
      attempt: fixture.stage.attemptCount,
      input_hash: fixture.stage.inputHash,
      workspace_root: snapshot.workspaceRoot,
      head_git_object: snapshot.headGitObject,
      branch: snapshot.branch,
      tracked_diff_sha256: snapshot.trackedDiffSha256,
      index_diff_sha256: snapshot.indexDiffSha256,
      status_sha256: snapshot.statusSha256,
      untracked: snapshot.untracked,
      observed_at: snapshot.observedAt,
    };
    workspaceValue.server_observation_proof = buildProfitFlywheelServerObservationProof(executionEvidenceNonce, "workspace", workspaceValue);
    const workspaceEvidence = await writeImmutable(
      path.join(checkpointDirectory, `${fixture.runId}-workspace.json`),
      workspaceValue,
    );
    const checkpointValue: Record<string, unknown> = {
      schema_version: "paperclip.profit_flywheel_artifact_checkpoint.v1",
      company_id: fixture.workflow.companyId,
      workflow_id: fixture.workflow.id,
      stage_run_id: fixture.stage.id,
      issue_id: fixture.stage.linkedIssueId,
      attempt: fixture.stage.attemptCount,
      input_hash: fixture.stage.inputHash,
      provider_route_id: fixture.stage.providerRouteId,
      workspace_root: snapshot.workspaceRoot,
      head_git_object: snapshot.headGitObject,
      branch: snapshot.branch,
      tracked_diff_sha256: snapshot.trackedDiffSha256,
      index_diff_sha256: snapshot.indexDiffSha256,
      status_sha256: snapshot.statusSha256,
      untracked: snapshot.untracked,
      workspace_evidence: workspaceEvidence,
      observed_at: snapshot.observedAt,
    };
    checkpointValue.server_observation_proof = buildProfitFlywheelServerObservationProof(executionEvidenceNonce, "checkpoint", checkpointValue);
    const checkpoint = await writeImmutable(
      path.join(checkpointDirectory, `${fixture.runId}-checkpoint.json`),
      checkpointValue,
    );
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1_000);
    await db.update(profitFlywheelStageRuns).set({ leaseExpiresAt: expiredAt, heartbeatAt: expiredAt })
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id));

    await expect(fixture.service.recoverOrphans({ now })).resolves.toHaveLength(1);
    const recovered = await db.select().from(profitFlywheelStageRuns)
      .where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!);
    expect(recovered.artifactCheckpoint).toMatchObject({
      stage_run_id: fixture.stage.id,
      attempt: fixture.stage.attemptCount,
      input_hash: fixture.stage.inputHash,
      provider_route_id: fixture.stage.providerRouteId,
      index_diff_sha256: snapshot.indexDiffSha256,
      workspace_evidence: workspaceEvidence,
      checkpoint_receipt: checkpoint,
    });
    expect(await db.select().from(profitFlywheelReceipts)
      .where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))
      .then((rows) => rows.filter((row) => row.receiptType === "execution_adjudication_receipt"))).toHaveLength(1);
  });

  it("blocks malformed orphan evidence without starving a later recoverable orphan", async () => {
    const fixture = await seedFixture();
    const contract = await loadProfitFlywheelContract();
    const heartbeat = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).then((rows) => rows[0]!);
    const malformedRunId = randomUUID();
    const sourceHashes = Object.fromEntries(contract.contract.stages.qa.input_hash_fields.map((field) =>
      [field, hashProfitFlywheelValue({ field, malformedRunId })]));
    const canonical = buildProfitFlywheelStageInput({ contract: contract.contract, stage: "qa", sourceHashes });
    const now = new Date();
    const malformedUpdatedAt = new Date(now.getTime() - 4_000);
    const malformed = await db.insert(profitFlywheelStageRuns).values({
      workflowId: fixture.workflow.id,
      companyId: fixture.workflow.companyId,
      stage: "qa",
      state: "running",
      ownerPlane: "paperclip",
      inputSchemaVersion: contract.contract.stages.qa.input_schema,
      inputHash: canonical.inputHash,
      sourceHashes: canonical.sourceHashes,
      idempotencyKey: buildProfitFlywheelIdempotencyKey({
        companyId: fixture.workflow.companyId,
        runId: fixture.workflow.runId,
        stage: "qa",
        inputHash: canonical.inputHash,
      }),
      maxAttempts: Math.max(1, contract.contract.stages.qa.retry.limit + 1),
      attemptCount: 1,
      linkedIssueId: fixture.stage.linkedIssueId,
      providerCapabilityClass: contract.contract.stages.qa.provider_capability_class,
      providerRouteId: fixture.stage.providerRouteId,
      providerFamily: fixture.stage.providerFamily,
      providerModel: fixture.stage.providerModel,
      providerModelVersion: fixture.stage.providerModelVersion,
      providerPolicySha256: fixture.stage.providerPolicySha256,
      providerRouteCoreSha256: fixture.stage.providerRouteCoreSha256,
      providerRouteSha256: fixture.stage.providerRouteSha256,
      providerRouteSnapshot: fixture.stage.providerRouteSnapshot,
      concurrencyKey: contract.contract.stages.qa.concurrency_key,
      concurrencyLimit: contract.contract.stages.qa.concurrency_limit,
      requiredReceipts: contract.contract.stages.qa.required_receipts,
      completionEvidence: contract.contract.stages.qa.completion_evidence,
      leaseOwner: `system:${malformedRunId}:malformed`,
      leaseActorType: "system",
      leaseActorId: malformedRunId,
      leaseExpiresAt: new Date(now.getTime() - 3_000),
      heartbeatAt: malformedUpdatedAt,
      startedAt: malformedUpdatedAt,
      correlationId: fixture.workflow.correlationId,
      traceId: fixture.workflow.traceId,
      spanId: createHash("sha256").update(malformedRunId).digest("hex").slice(0, 16),
      createdAt: malformedUpdatedAt,
      updatedAt: malformedUpdatedAt,
    }).returning().then((rows) => rows[0]!);
    await db.insert(heartbeatRuns).values({
      id: malformedRunId,
      companyId: fixture.workflow.companyId,
      agentId: heartbeat.agentId,
      status: "running",
      startedAt: malformedUpdatedAt,
      executionEvidenceNonce: createHash("sha256").update(`execution-evidence:${malformedRunId}`).digest("hex"),
      contextSnapshot: {
        profitFlywheelStageRunId: malformed.id,
        issueId: malformed.linkedIssueId,
      },
    });
    const malformedPath = path.join(
      fixture.serverArtifactRoot,
      fixture.workflow.companyId,
      fixture.workflow.id,
      malformed.id,
      `attempt-${malformed.attemptCount}`,
      "adjudications",
      `${malformedRunId}.json`,
    );
    await writeImmutable(malformedPath, { schema_version: "paperclip.execution_adjudication.v1" });
    await db.update(profitFlywheelStageRuns).set({
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      heartbeatAt: new Date(now.getTime() - 2_000),
      updatedAt: new Date(now.getTime() - 2_000),
    }).where(eq(profitFlywheelStageRuns.id, fixture.stage.id));

    await expect(fixture.service.recoverOrphans({ now })).resolves.toHaveLength(2);
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, malformed.id)).then((rows) => rows[0])).toMatchObject({
      state: "blocked",
      blockerCode: "profit_flywheel_orphan_evidence_recovery_failed",
      nextOwner: "paperclip_runtime_owner",
    });
    expect(await db.select().from(profitFlywheelStageRuns).where(eq(profitFlywheelStageRuns.id, fixture.stage.id)).then((rows) => rows[0]!.state)).toBe("retry");
    expect(await db.select().from(profitFlywheelReceipts).where(eq(profitFlywheelReceipts.stageRunId, fixture.stage.id))
      .then((rows) => rows.filter((row) => row.receiptType === "execution_adjudication_receipt"))).toHaveLength(1);
  });
});
