import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  projectWorkspaces,
  profitFlywheelEvents,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  buildProfitFlywheelCanaryCloseout,
  parseCanaryCloseoutCliArgs,
  resolveEmbeddedCanaryCloseoutConnection,
} from "../ops/profit-flywheel-canary-closeout.js";
import {
  canonicalGitObjectSha256,
  computeCanonicalGitObjectSha256,
  parseGitObjectSha256Args,
} from "../ops/git-object-sha256.js";
import { canaryFixtureIdentity } from "../ops/profit-flywheel-canary-fixture.js";
import {
  buildProfitFlywheelIdempotencyKey,
  buildProfitFlywheelStageInput,
  canonicalProfitFlywheelReceiptHash,
  hashProfitFlywheelValue,
  loadPortfolioOsResearchRegistryAuthority,
} from "../services/profit-flywheel.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { buildResolvedProviderRoute, loadProviderPolicyV2 } from "../services/provider-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFile = promisify(execFileCallback);
const COMPANY_ID = "216897d4-0f94-4736-9b6b-a20c8e48d694";
const RUN_ID = "closeout-fixture";
const CORRELATION_ID = "profit-canary:" + RUN_ID;
const TRACE_ID = "1".repeat(32);

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("canonical Git object SHA-256 helper", () => {
  it("hashes the type/byte-length/NUL/body contract rather than body-only bytes", () => {
    const body = Buffer.from("héllo\n", "utf8");
    const observed = canonicalGitObjectSha256("blob", body);
    const expected = createHash("sha256")
      .update(Buffer.from("blob " + body.byteLength + "\0"))
      .update(body)
      .digest("hex");
    expect(observed).toBe(expected);
    expect(observed).not.toBe(digest(body));
  });

  it("rejects abbreviated object ids and inline argv", async () => {
    expect(() => parseGitObjectSha256Args(["--repo=/tmp/repo", "--object", "a".repeat(40)]))
      .toThrow("profit_canary_git_object_argument_invalid");
    await expect(computeCanonicalGitObjectSha256(await realpath(os.tmpdir()), "abc"))
      .rejects.toThrow("profit_canary_git_object_id_invalid");
  });

  it("hashes the raw object even when a hostile replace ref is installed", async () => {
    const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-git-replace-")));
    try {
      await execFile("git", ["init", repo]);
      const originalBody = Buffer.from("original object\n");
      const replacementBody = Buffer.from("replacement object\n");
      const originalPath = path.join(repo, "original.txt");
      const replacementPath = path.join(repo, "replacement.txt");
      await Promise.all([writeFile(originalPath, originalBody), writeFile(replacementPath, replacementBody)]);
      const original = await execFile("git", ["-C", repo, "hash-object", "-w", originalPath])
        .then(({ stdout }) => stdout.trim());
      const replacement = await execFile("git", ["-C", repo, "hash-object", "-w", replacementPath])
        .then(({ stdout }) => stdout.trim());
      await execFile("git", ["-C", repo, "replace", original, replacement]);

      const observed = await computeCanonicalGitObjectSha256(repo, original);
      expect(observed.sha256).toBe(canonicalGitObjectSha256("blob", originalBody));
      expect(observed.sha256).not.toBe(canonicalGitObjectSha256("blob", replacementBody));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("canary closeout CLI boundary", () => {
  it("rejects environment DB URLs and only resolves embedded instance ports", () => {
    expect(() => parseCanaryCloseoutCliArgs([], {
      DATABASE_URL: "postgres://operator:secret@127.0.0.1/paperclip",
    })).toThrow("profit_canary_closeout_database_url_forbidden");
    expect(resolveEmbeddedCanaryCloseoutConnection({
      databaseMode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    })).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
    expect(() => resolveEmbeddedCanaryCloseoutConnection({
      databaseMode: "postgres",
      embeddedPostgresPort: 54329,
    })).toThrow("profit_canary_closeout_embedded_instance_required");
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("read-only Profit Flywheel canary closeout", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-canary-closeout-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function git(cwd: string, ...args: string[]) {
    return execFile("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Paperclip Test",
        GIT_AUTHOR_EMAIL: "paperclip@example.invalid",
        GIT_COMMITTER_NAME: "Paperclip Test",
        GIT_COMMITTER_EMAIL: "paperclip@example.invalid",
        GIT_AUTHOR_DATE: "2026-07-12T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-07-12T12:00:00Z",
      },
    }).then(({ stdout }) => stdout.trim());
  }

  async function immutableArtifact(root: string, name: string, value: unknown) {
    const filePath = path.join(root, name);
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n");
    await writeFile(filePath, bytes, { mode: 0o444 });
    await chmod(filePath, 0o444);
    return { path: await realpath(filePath), sha256: digest(bytes) };
  }

  async function seedCloseout(
    canarySchemaVersion = "pos.profit_flywheel_canary.v3",
  ) {
    const loadedContract = await loadProfitFlywheelContract();
    const contract = loadedContract.contract;
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-closeout-fs-")));
    roots.push(root);
    const policyPath = fileURLToPath(new URL("../../../config/provider-policy.v2.json", import.meta.url));
    const policySchemaPath = fileURLToPath(new URL("../../../config/provider-policy.v2.schema.json", import.meta.url));
    const [policyBytes, policySchemaBytes] = await Promise.all([
      readFile(policyPath),
      readFile(policySchemaPath),
    ]);
    const exactPolicySha256 = digest(policyBytes);
    const exactPolicySchemaSha256 = digest(policySchemaBytes);
    const providerPolicy = await loadProviderPolicyV2({
      path: policyPath,
      schemaPath: policySchemaPath,
      expectedSha256: exactPolicySha256,
      expectedSchemaSha256: exactPolicySchemaSha256,
    });
    const routeForFamily = (family: "opencode" | "openai") => {
      const entry = Object.entries(providerPolicy.policy.routes).find(([, route]) =>
        route.providerFamily === family && route.model.kind === "exact");
      if (!entry) throw new Error(`Missing exact ${family} route in test provider policy`);
      return buildResolvedProviderRoute({
        policy: providerPolicy.policy,
        policySha256: providerPolicy.sha256,
        policySchemaSha256: providerPolicy.schemaSha256,
        routeId: entry[0],
      });
    };
    const resolvedRoutes = {
      opencode: routeForFamily("opencode"),
      openai: routeForFamily("openai"),
    };
    const target = path.join(root, "target");
    const origin = path.join(root, "origin.git");
    const serverArtifacts = path.join(root, "server-artifacts");
    const receiptDir = path.join(root, "closeout");
    await Promise.all([
      mkdir(target, { mode: 0o700 }),
      mkdir(origin, { mode: 0o700 }),
      mkdir(serverArtifacts, { mode: 0o700 }),
      mkdir(receiptDir, { mode: 0o700 }),
    ]);
    await execFile("git", ["init", "--bare", origin]);
    await git(target, "init", "-b", "main");
    await git(target, "remote", "add", "origin", pathToFileURL(origin).href);
    await writeFile(path.join(target, "README.md"), "fixture\\n");
    await git(target, "add", "README.md");
    await git(target, "commit", "-m", "fixture base");
    const baseObject = await git(target, "rev-parse", "HEAD");
    await writeFile(path.join(target, "feature.txt"), "work-bearing result\\n");
    await git(target, "add", "feature.txt");
    await git(target, "commit", "-m", "work-bearing implementation");
    const targetObject = await git(target, "rev-parse", "HEAD");
    await git(target, "push", "origin", "HEAD:refs/heads/main");
    const targetArtifact = await computeCanonicalGitObjectSha256(await realpath(target), targetObject);
    const ids = {
      dispatch: randomUUID(),
      implementation: randomUUID(),
      qa: randomUUID(),
      release: randomUUID(),
      observation: randomUUID(),
      learning: randomUUID(),
      research: randomUUID(),
    };

    const artifacts = {
      implementationExecution: await immutableArtifact(serverArtifacts, "implementation-execution.json", { status: "passed" }),
      qaExecution: await immutableArtifact(serverArtifacts, "qa-execution.json", { status: "passed" }),
      releaseExecution: await immutableArtifact(serverArtifacts, "release-execution.json", { status: "passed" }),
      implementationTest: await immutableArtifact(serverArtifacts, "implementation-test.json", { exit_code: 0 }),
      qaTest: await immutableArtifact(serverArtifacts, "qa-test.json", { exit_code: 0 }),
      review: await immutableArtifact(serverArtifacts, "independent-review.json", {
        schema_version: "paperclip.independent_review_result.v1",
        state: "succeeded",
        final_disposition: "passed",
        qa_stage_run_id: ids.qa,
        implementation_stage_run_id: ids.implementation,
        implementation_git_object: targetObject,
        implementation_artifact_hash: targetArtifact.sha256,
        reviewer_provider_family: resolvedRoutes.openai.providerFamily,
        reviewer_model: resolvedRoutes.openai.model,
        reviewer_version: resolvedRoutes.openai.modelVersion,
        provider_policy_sha256: providerPolicy.sha256,
        provider_policy_schema_sha256: providerPolicy.schemaSha256,
        summary: "Independent cross-family review passed",
        findings: [],
      }),
      observation: await immutableArtifact(serverArtifacts, "observation.json", { baseline: 0, observed: 1 }),
    };

    const { projectId, workspaceId } = canaryFixtureIdentity(COMPANY_ID, RUN_ID);
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const targetWorkspace = await realpath(target);
    const targetOrigin = await realpath(origin);
    const targetOriginUrl = pathToFileURL(targetOrigin).href;
    const selectionSnapshotHash = "4".repeat(64);
    const sourceDispatchValue = {
      schema_version: "pos.dispatch.v2",
      company: COMPANY_ID,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      immutable: true,
      paperclip: { company_id: COMPANY_ID, project_id: projectId },
      target_repo_full_name: "fixture/profit-canary",
      target_repo_clone_path_hint: targetWorkspace,
      selection_snapshot_hash: selectionSnapshotHash,
      target: { base_sha: baseObject },
      execution_manifest: { repo_target: { repo_url: targetOriginUrl } },
    };
    const sourceDispatch = await immutableArtifact(root, "dispatch.json", sourceDispatchValue);
    const researchRegistryAuthority = await loadPortfolioOsResearchRegistryAuthority();
    const fixtureMetadata = {
      schema_version: "paperclip.profit_flywheel_canary_fixture_setup.v1",
      company_id: COMPANY_ID,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      project_id: projectId,
      workspace_id: workspaceId,
      target_repo: "fixture/profit-canary",
      target_workspace: targetWorkspace,
      target_origin: targetOrigin,
      engineer_agent_id: "35014584-00ed-4dd1-a822-f6119db5af1d",
      engineer_agent_name: "Engineer-1",
      prior_agent_status: "paused",
      resumed_by_setup: true,
      setup_at: "2026-07-12T11:00:00.000Z",
    };
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Closeout fixture",
      issuePrefix: "CLO",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId: COMPANY_ID,
      name: "Profit Flywheel Canary " + RUN_ID,
      status: "in_progress",
      executionWorkspacePolicy: {
        workspaceStrategy: { type: "project_primary" },
        profitFlywheelCanaryFixture: fixtureMetadata,
      },
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId: COMPANY_ID,
      projectId,
      name: `profit-canary-${RUN_ID}-primary`,
      sourceType: "local_path",
      cwd: targetWorkspace,
      repoUrl: targetOriginUrl,
      repoRef: "main",
      defaultRef: "main",
      visibility: "default",
      metadata: { profit_flywheel_canary_fixture: fixtureMetadata },
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: COMPANY_ID,
      projectId,
      title: "Implement fixture",
      status: "done",
      completedAt: new Date("2026-07-12T12:30:00.000Z"),
    });
    await db.insert(profitFlywheelWorkflows).values({
      id: workflowId,
      companyId: COMPANY_ID,
      projectId,
      runId: RUN_ID,
      state: "running",
      currentStage: "research_intake",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: sourceDispatch.path,
      sourceDispatchHash: sourceDispatch.sha256,
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: targetWorkspace,
      contractPath: loadedContract.path,
      contractSha256: loadedContract.sha256,
      contractSnapshot: contract as unknown as Record<string, unknown>,
      correlationId: CORRELATION_ID,
      traceId: TRACE_ID,
      feedback: {
        server_artifact_root: root,
        selection_snapshot_hash: selectionSnapshotHash,
        target_origin_url: targetOriginUrl,
        target_base_sha: baseObject,
        research_registry_authority: researchRegistryAuthority,
      },
    });
    const completedAt = new Date("2026-07-12T12:30:00.000Z");
    const startedAt = new Date("2026-07-12T12:00:00.000Z");
    const outputHashes = {
      dispatch: sourceDispatch.sha256,
      implementation: "a".repeat(64),
      qa: "b".repeat(64),
      release: "c".repeat(64),
      commercial_observation: "d".repeat(64),
      learning: "e".repeat(64),
    };
    const stages: Record<string, typeof profitFlywheelStageRuns.$inferSelect> = {};
    const insertStage = async (input: {
      id: string;
      stage: keyof typeof contract.stages;
      source?: typeof profitFlywheelStageRuns.$inferSelect;
      state?: string;
      attempt?: number;
      providerFamily?: string;
      sourceHashes?: Record<string, string>;
      feedback?: Record<string, unknown>;
    }) => {
      const state = input.state ?? "succeeded";
      const definition = contract.stages[input.stage];
      const providerRoute = input.providerFamily ? resolvedRoutes[input.providerFamily as keyof typeof resolvedRoutes] : null;
      const sourceHashes = input.sourceHashes ?? Object.fromEntries(
        definition.input_hash_fields.map((field) => [field, digest(`${input.stage}:${field}:${input.id}`)]),
      );
      const canonicalInput = buildProfitFlywheelStageInput({ contract, stage: input.stage, sourceHashes });
      const row = await db.insert(profitFlywheelStageRuns).values({
        id: input.id,
        workflowId,
        companyId: COMPANY_ID,
        stage: input.stage,
        state,
        ownerPlane: definition.owner_plane,
        inputSchemaVersion: definition.input_schema,
        inputHash: canonicalInput.inputHash,
        sourceHashes: canonicalInput.sourceHashes,
        idempotencyKey: buildProfitFlywheelIdempotencyKey({
          companyId: COMPANY_ID,
          runId: RUN_ID,
          stage: input.stage,
          inputHash: canonicalInput.inputHash,
        }),
        attemptCount: input.attempt ?? (state === "succeeded" ? 1 : 0),
        maxAttempts: Math.max(1, definition.retry.limit + 1),
        linkedIssueId: input.stage === "research_intake" ? null : issueId,
        providerCapabilityClass: definition.provider_capability_class,
        providerRouteId: providerRoute?.routeId ?? null,
        providerFamily: providerRoute?.providerFamily ?? null,
        providerModel: providerRoute?.model ?? null,
        providerModelVersion: providerRoute?.modelVersion ?? null,
        providerPolicySha256: providerRoute ? providerPolicy.sha256 : null,
        providerRouteCoreSha256: providerRoute?.policyRouteCoreSha256 ?? null,
        providerRouteSha256: providerRoute?.resolvedRouteSha256 ?? null,
        providerRouteSnapshot: providerRoute ?? null,
        transitionSourceStageRunId: input.source?.id ?? null,
        transitionSourceOutputHash: input.source ? outputHashes[input.source.stage as keyof typeof outputHashes] : null,
        concurrencyKey: definition.concurrency_key,
        concurrencyLimit: definition.concurrency_limit,
        requiredReceipts: definition.required_receipts,
        completionEvidence: definition.completion_evidence,
        feedback: input.feedback ?? (state === "succeeded"
          ? { output_hash: outputHashes[input.stage as keyof typeof outputHashes] }
          : {}),
        correlationId: CORRELATION_ID,
        traceId: TRACE_ID,
        spanId: digest(input.id).slice(0, 16),
        startedAt: state === "succeeded" ? startedAt : null,
        completedAt: state === "succeeded" ? completedAt : null,
      }).returning().then((rows) => rows[0]!);
      stages[input.stage] = row;
      return row;
    };
    const dispatch = await insertStage({ id: ids.dispatch, stage: "dispatch" });
    const implementation = await insertStage({ id: ids.implementation, stage: "implementation", source: dispatch, providerFamily: "opencode" });
    const qa = await insertStage({
      id: ids.qa,
      stage: "qa",
      source: implementation,
      providerFamily: "openai",
      feedback: {
        output_hash: outputHashes.qa,
        execution_receipt_path: artifacts.qaExecution.path,
        execution_receipt_sha256: artifacts.qaExecution.sha256,
      },
    });
    const release = await insertStage({
      id: ids.release,
      stage: "release",
      source: qa,
      providerFamily: "openai",
      feedback: {
        output_hash: outputHashes.release,
        execution_receipt_path: artifacts.releaseExecution.path,
        execution_receipt_sha256: artifacts.releaseExecution.sha256,
      },
    });
    const observation = await insertStage({ id: ids.observation, stage: "commercial_observation", source: release });
    const learning = await insertStage({ id: ids.learning, stage: "learning", source: observation });

    const observedAt = new Date("2026-07-12T12:31:00.000Z");
    const expiresAt = new Date("2026-07-14T12:31:00.000Z");
    const receiptRows: Array<typeof profitFlywheelReceipts.$inferSelect> = [];
    const addReceipt = async (
      stage: typeof profitFlywheelStageRuns.$inferSelect,
      type: string,
      artifactRef: string,
      attributes: Record<string, unknown>,
      schemaVersion = "fixture.receipt.v1",
    ) => {
      const attemptScoped = new Set([
        "issue_receipt",
        "provider_run_receipt",
        "implementation_receipt",
        "qa_receipt",
        "qa_failure_receipt",
        "independent_review_receipt",
        "release_receipt",
        "measured_source_receipt",
      ]);
      const effectiveAttributes = attemptScoped.has(type)
        ? { ...attributes, attempt: stage.attemptCount }
        : attributes;
      const body = {
        type,
        schemaVersion,
        artifactRef,
        observedAt: observedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        attributes: effectiveAttributes,
      };
      const row = await db.insert(profitFlywheelReceipts).values({
        companyId: COMPANY_ID,
        workflowId,
        stageRunId: stage.id,
        receiptType: type,
        schemaVersion,
        contentHash: canonicalProfitFlywheelReceiptHash(body),
        artifactRef,
        status: "valid",
        observedAt,
        expiresAt,
        attributes: effectiveAttributes,
        correlationId: CORRELATION_ID,
        traceId: TRACE_ID,
        spanId: stage.spanId,
      }).returning().then((rows) => rows[0]!);
      receiptRows.push(row);
      return row;
    };
    const testResult = (command: string, artifact: { path: string; sha256: string }) => ({
      command,
      exit_code: 0,
      status: "passed",
      artifact_ref: artifact.path,
      artifact_hash: artifact.sha256,
    });
    const providerAttrs = (stage: typeof profitFlywheelStageRuns.$inferSelect, artifact: { path: string; sha256: string }) => ({
      provider_route_id: stage.providerRouteId,
      provider_route_core_sha256: stage.providerRouteCoreSha256,
      provider_route_sha256: stage.providerRouteSha256,
      provider_family: stage.providerFamily,
      model: stage.providerModel,
      provider_version: stage.providerModelVersion,
      provider_policy_sha256: providerPolicy.sha256,
      provider_policy_schema_sha256: providerPolicy.schemaSha256,
      final_response_sha256: "8".repeat(64),
      usage: { input_tokens: 120, output_tokens: 40 },
      artifact_hash: artifact.sha256,
    });
    for (const type of ["portfolio_os_dispatch_authorization", "immutable_dispatch_artifact"] as const) {
      await addReceipt(dispatch, type, sourceDispatch.path, {
        portfolio_os_authorized: true,
        workflow_id: workflowId,
        stage_run_id: dispatch.id,
        input_hash: dispatch.inputHash,
        authoring_inputs: dispatch.sourceHashes,
        dispatch_hash: sourceDispatch.sha256,
        artifact_hash: sourceDispatch.sha256,
        issue_id: issueId,
      }, "pos.dispatch.v2");
    }
    await addReceipt(implementation, "issue_receipt", artifacts.implementationExecution.path, {
      artifact_hash: artifacts.implementationExecution.sha256,
    });
    await addReceipt(implementation, "provider_run_receipt", artifacts.implementationExecution.path,
      providerAttrs(implementation, artifacts.implementationExecution));
    await addReceipt(implementation, "implementation_receipt", "git:" + targetObject, {
      changed_files: ["feature.txt"],
      target_commit_or_patch_hash: "git:" + targetObject,
      artifact_hash: targetArtifact.sha256,
      test_results: [testResult("test -f feature.txt", artifacts.implementationTest)],
      final_response: "sha256:" + "8".repeat(64),
    });
    const review = await addReceipt(qa, "independent_review_receipt", artifacts.review.path, {
      review_provider_family: "openai",
      review_model: qa.providerModel,
      review_version: qa.providerModelVersion,
      review_policy_sha256: providerPolicy.sha256,
      review_policy_schema_sha256: providerPolicy.schemaSha256,
      builder_provider_family: "opencode",
      implementation_stage_run_id: implementation.id,
      implementation_git_object: targetObject,
      implementation_artifact_hash: targetArtifact.sha256,
      artifact_hash: artifacts.review.sha256,
      review_status: "succeeded",
      final_disposition: "passed",
      review_summary: "Independent cross-family review passed",
    });
    const qaReceipt = await addReceipt(qa, "qa_receipt", artifacts.qaExecution.path, {
      test_commands: ["test -f feature.txt"],
      test_results: [testResult("test -f feature.txt", artifacts.qaTest)],
      implementation_stage_run_id: implementation.id,
      implementation_git_object: targetObject,
      implementation_artifact_hash: targetArtifact.sha256,
      builder_provider_family: "opencode",
      reviewer_provider_family: "openai",
      reviewer_model: qa.providerModel,
      reviewer_version: qa.providerModelVersion,
      reviewer_policy_sha256: providerPolicy.sha256,
      reviewer_policy_schema_sha256: providerPolicy.schemaSha256,
      independent_review_artifact_ref: artifacts.review.path,
      independent_review_artifact_hash: artifacts.review.sha256,
      independent_review_final_disposition: "passed",
      execution_receipt_sha256: artifacts.qaExecution.sha256,
      artifact_hash: artifacts.qaExecution.sha256,
    });
    await addReceipt(qa, "provider_run_receipt", artifacts.qaExecution.path,
      providerAttrs(qa, artifacts.qaExecution));
    await addReceipt(release, "release_receipt", "git:" + targetObject, {
      artifact_hash: targetArtifact.sha256,
      release_status: "verified",
      qa_stage_run_id: qa.id,
      qa_receipt_hash: qaReceipt.contentHash,
      qa_execution_receipt_ref: artifacts.qaExecution.path,
      qa_execution_receipt_hash: artifacts.qaExecution.sha256,
      implementation_stage_run_id: implementation.id,
      implementation_git_object: targetObject,
      implementation_artifact_hash: targetArtifact.sha256,
      builder_provider_family: "opencode",
      reviewer_provider_family: "openai",
      independent_review_artifact_ref: artifacts.review.path,
      independent_review_artifact_hash: artifacts.review.sha256,
      remote_origin_url: pathToFileURL(origin).href,
      remote_ref: "refs/heads/main",
      remote_object: targetObject,
      remote_attestation_method: "git ls-remote --exit-code origin <authorized-ref>",
      verified_at: "2026-07-12T12:30:00.000Z",
      execution_receipt_sha256: artifacts.releaseExecution.sha256,
    });
    await addReceipt(release, "provider_run_receipt", artifacts.releaseExecution.path,
      providerAttrs(release, artifacts.releaseExecution));
    await addReceipt(observation, "commercial_observation_receipt", artifacts.observation.path, {
      metric_name: "artifact_backed_release_verified",
      baseline: 0,
      observed_value: 1,
      measurement_window: "immediate",
      source_artifact_hash: targetArtifact.sha256,
      artifact_hash: artifacts.observation.sha256,
    });
    const notBefore = new Date("2026-07-13T00:31:00.000Z");
    const authorityExpires = new Date("2026-07-14T00:31:00.000Z");
    const authorizedAt = new Date("2026-07-12T12:31:00.000Z");
    const sourceRequest = {
      source_id: "fixture-api",
      source_kind: "api",
      authority_class: "primary_platform",
      evidence_families: ["market_signal"],
      query_families: ["market_signal"],
      query: "profit canary",
      url_template: "https://example.invalid/api/signals?q={query}",
      template_values: { query: "profit-canary" },
      approved_domains: ["example.invalid"],
      approved_file_roots: [],
      legal: {
        permitted_use: "fixture_market_signal",
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
      target_repo: "fixture/profit-canary",
      source_registry: researchRegistryAuthority.registry,
      evidence_families: ["market_signal"],
      query_families: ["market_signal"],
      query: "profit canary",
      source_requests: [sourceRequest],
      governance: {
        owner: "portfolio_os",
        authorized_at: authorizedAt.toISOString(),
        expires_at: authorityExpires.toISOString(),
        collection_window_policy: { not_before: notBefore.toISOString(), max_duration_seconds: 1800 },
      },
      source_plan_hash: hashProfitFlywheelValue([sourceRequest]),
      immutable: true,
    };
    const authority = await immutableArtifact(serverArtifacts, "next-research.json", authorization);
    const authorityPayloadSha256 = hashProfitFlywheelValue(authorization);
    const learningArtifact = await immutableArtifact(serverArtifacts, "learning.json", {
      schema_version: "pos.learning_receipt.v2",
      state: "succeeded",
      company: COMPANY_ID,
      run_id: RUN_ID,
      workflow_id: workflowId,
      correlation_id: CORRELATION_ID,
      trace_id: TRACE_ID,
      linked_issue_id: issueId,
      target_repo: "fixture/profit-canary",
      generated_at: "2026-07-12T12:31:00.000Z",
      input_hash: learning.inputHash,
      idempotency_key: learning.idempotencyKey,
      artifact_receipts: {
        qa: { path: artifacts.qaExecution.path, sha256: artifacts.qaExecution.sha256 },
        release: { path: artifacts.releaseExecution.path, sha256: artifacts.releaseExecution.sha256 },
        commercial_observation: { path: artifacts.observation.path, sha256: artifacts.observation.sha256 },
        next_research_authority: { path: authority.path, sha256: authority.sha256 },
      },
      observation: {
        kind: "operational",
        metric_name: "artifact_backed_release_verified",
        baseline_value: 0,
        observed_value: 1,
        metric_unit: "verified_release",
        measurement_window_start: authorizedAt.toISOString(),
        measurement_window_end: "2026-07-12T12:31:00.000Z",
        source_artifact: { path: artifacts.observation.path, sha256: artifacts.observation.sha256 },
        validation_outcome: "validated",
      },
      repo_memory_update: {
        status: "measured",
        metric_name: "artifact_backed_release_verified",
        baseline_value: 0,
        observed_value: 1,
        score_delta: 1,
        observation_sha256: artifacts.observation.sha256,
      },
      source_hashes: {
        result_sha256: outputHashes.learning,
        qa_sha256: artifacts.qaExecution.sha256,
        release_sha256: artifacts.releaseExecution.sha256,
        observation_sha256: artifacts.observation.sha256,
        measurement_source_sha256: artifacts.observation.sha256,
        next_research_authority_sha256: authority.sha256,
      },
      next_research_authority: {
        schema_version: "pos.next_research_authorization.v1",
        artifact_ref: authority.path,
        artifact_sha256: authority.sha256,
        payload_sha256: authorityPayloadSha256,
        not_before: notBefore.toISOString(),
        expires_at: authorityExpires.toISOString(),
      },
      final_disposition: "operational_learning_recorded",
      immutable: true,
    });
    await addReceipt(learning, "learning_receipt", learningArtifact.path, {
      measured_external_or_operational_evidence: true,
      source_artifact_hash: artifacts.observation.sha256,
      validation_outcome_hash: "9".repeat(64),
      learning_receipt_hash: learningArtifact.sha256,
      artifact_hash: learningArtifact.sha256,
      next_research_authority_ref: authority.path,
      next_research_authority_sha256: authority.sha256,
      next_research_payload_sha256: authorityPayloadSha256,
      next_research_not_before: notBefore.toISOString(),
      next_research_expires_at: authorityExpires.toISOString(),
    });
    const authorityBinding = {
      artifact_ref: authority.path,
      artifact_sha256: authority.sha256,
      payload_sha256: authorityPayloadSha256,
    };
    const researchPlanBody = {
      schema_version: "paperclip.research_plan.v2",
      schema: {
        path: loadedContract.researchPlanSchemaPath,
        sha256: loadedContract.researchPlanSchemaSha256,
      },
      authority: authorityBinding,
      target_repo: "fixture/profit-canary",
      source_registry: researchRegistryAuthority.registry,
      evidence_families: authorization.evidence_families,
      query_families: authorization.query_families,
      query: authorization.query,
      source_requests: authorization.source_requests,
      collection_window: {
        from: notBefore.toISOString(),
        to: new Date(notBefore.getTime() + 1800 * 1000).toISOString(),
      },
      source_plan_hash: authorization.source_plan_hash,
      immutable: true,
    };
    const researchPlan = { ...researchPlanBody, plan_hash: hashProfitFlywheelValue(researchPlanBody) };
    const researchSourceHashes = {
      source_registry_hash: String((researchRegistryAuthority.registry as Record<string, unknown>).sha256),
      selection_hash: outputHashes.learning,
      research_plan_hash: researchPlan.plan_hash,
    };
    const research = await insertStage({
      id: ids.research,
      stage: "research_intake",
      source: learning,
      state: "pending",
      attempt: 0,
      sourceHashes: researchSourceHashes,
      feedback: {
        transition_source_stage_run_id: learning.id,
        transition_source_output_hash: outputHashes.learning,
        research_plan: researchPlan,
        research_authority_snapshot: authorization,
        research_authority_binding: authorityBinding,
      },
    });
    const transition = contract.transitions.find((row) => row.from === "learning" && row.to === "research_intake")!;
    const transitionContext = {
      research_plan: researchPlan,
      research_authority_snapshot: authorization,
      research_authority_binding: authorityBinding,
    };
    const event = await db.insert(profitFlywheelEvents).values({
      companyId: COMPANY_ID,
      workflowId,
      stageRunId: research.id,
      eventType: "portfolio_os_stage_requested",
      dedupeKey: "stage-requested:" + research.id,
      toState: "pending",
      correlationId: CORRELATION_ID,
      traceId: TRACE_ID,
      spanId: research.spanId,
      payload: {
        schema_version: "paperclip.profit_flywheel_event.v2",
        company_id: COMPANY_ID,
        run_id: RUN_ID,
        workflow_id: workflowId,
        correlation_id: CORRELATION_ID,
        trace_id: TRACE_ID,
        contract_sha256: loadedContract.sha256,
        occurred_at: "2026-07-12T12:31:00.000Z",
        stage: "research_intake",
        input_hash: research.inputHash,
        trigger: transition.trigger,
        guard: transition.guard,
        from_stage: "learning",
        to_stage: "research_intake",
        linked_issue_id: null,
        source_hashes: research.sourceHashes,
        transition_context: transitionContext,
      },
      nextAttemptAt: notBefore,
      createdAt: new Date("2026-07-12T12:31:00.000Z"),
      updatedAt: new Date("2026-07-12T12:31:00.000Z"),
    }).returning().then((rows) => rows[0]!);

    const setupReceipt = await immutableArtifact(receiptDir, `${RUN_ID}-fixture-setup.json`, {
      ...fixtureMetadata,
      project: {
        id: projectId,
        companyId: COMPANY_ID,
        name: "Profit Flywheel Canary " + RUN_ID,
        status: "in_progress",
      },
      primary_workspace: {
        id: workspaceId,
        companyId: COMPANY_ID,
        projectId,
        name: `profit-canary-${RUN_ID}-primary`,
        sourceType: "local_path",
        cwd: targetWorkspace,
        repoUrl: targetOriginUrl,
        repoRef: "main",
        defaultRef: "main",
        visibility: "default",
        isPrimary: true,
      },
      resulting_agent_status: "idle",
      immutable: true,
    });
    const canaryReceipt = await immutableArtifact(serverArtifacts, "pos-canary.json", {
      schema_version: canarySchemaVersion,
      state: "dispatch_ready",
      mode: "offline_fixture_only",
      immutable: true,
      e2e_proof: false,
      execution_authority: "paperclip_control_plane",
      target_repo: "fixture/profit-canary",
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      target_workspace: targetWorkspace,
      target_origin: targetOrigin,
      paperclip: { company_id: COMPANY_ID, project_id: projectId },
      artifacts: { dispatch: { path: sourceDispatch.path, sha256: sourceDispatch.sha256 } },
    });
    const posPromotionReceipt = await immutableArtifact(serverArtifacts, "pos-promotion.json", {
      schema_version: "pos.profit_flywheel_canary_promotion.v1",
      state: "published",
      immutable: true,
      run_id: RUN_ID,
      company_id: COMPANY_ID,
      project_id: projectId,
      correlation_id: CORRELATION_ID,
      published_path: sourceDispatch.path,
      published_sha256: sourceDispatch.sha256,
    });
    const posObservationReceipt = await immutableArtifact(serverArtifacts, "pos-observation.json", {
      schema_version: "pos.profit_flywheel_canary_workflow_observation.v1",
      state: "workflow_observed",
      immutable: true,
      workflow: {
        id: workflowId,
        companyId: COMPANY_ID,
        projectId,
        runId: RUN_ID,
        correlationId: CORRELATION_ID,
        sourceDispatchPath: sourceDispatch.path,
        sourceDispatchHash: sourceDispatch.sha256,
      },
    });
    const promotionAggregate = await immutableArtifact(receiptDir, `${RUN_ID}-promotion-aggregate.json`, {
      schema_version: "paperclip.profit_flywheel_fixture_promotion.v1",
      status: "succeeded",
      blocker: null,
      immutable: true,
      company_id: COMPANY_ID,
      project_id: projectId,
      run_id: RUN_ID,
      inputs: {
        canary_receipt: { path: canaryReceipt.path, sha256: canaryReceipt.sha256 },
        source_dispatch: { path: sourceDispatch.path, sha256: sourceDispatch.sha256 },
        target_workspace: targetWorkspace,
        target_origin: targetOrigin,
      },
      result: {
        state: "workflow_observed",
        workflow_id: workflowId,
        persisted_workflow: {
          id: workflowId,
          companyId: COMPANY_ID,
          projectId,
          runId: RUN_ID,
          correlationId: CORRELATION_ID,
          sourceDispatchPath: sourceDispatch.path,
          sourceDispatchHash: sourceDispatch.sha256,
          targetRepo: "fixture/profit-canary",
          targetWorkspaceRoot: targetWorkspace,
        },
        published_dispatch: { path: sourceDispatch.path, sha256: sourceDispatch.sha256 },
        promotion_receipt: { path: posPromotionReceipt.path, sha256: posPromotionReceipt.sha256 },
        observation_receipt: { path: posObservationReceipt.path, sha256: posObservationReceipt.sha256 },
      },
    });

    return {
      options: {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        correlationId: CORRELATION_ID,
        projectId,
        workflowId,
        issueId,
        implementationStageRunId: implementation.id,
        qaStageRunId: qa.id,
        releaseStageRunId: release.id,
        observationStageRunId: observation.id,
        learningStageRunId: learning.id,
        nextResearchStageRunId: research.id,
        setupReceiptPath: setupReceipt.path,
        promotionReceiptPath: promotionAggregate.path,
        receiptDir: await realpath(receiptDir),
      },
      stages: { dispatch, implementation, qa, release, observation, learning, research },
      artifacts: { ...artifacts, learning: learningArtifact },
      targetObject,
      targetArtifact,
      review,
      event,
      providerPolicyPins: {
        path: policyPath,
        schemaPath: policySchemaPath,
        sha256: exactPolicySha256,
        schemaSha256: exactPolicySchemaSha256,
      },
      dispatchEvidence: {
        dispatch: sourceDispatchValue,
        selection: {},
        dossier: {},
        commercial: {},
        commercialGateHash: "0".repeat(64),
        authorityRoot: root,
      },
    };
  }

  function closeoutDependencies(
    fixture: Awaited<ReturnType<typeof seedCloseout>>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      now: () => new Date("2026-07-12T13:00:00.000Z"),
      completionEvidenceValidator: async (input: { receipts: Array<typeof profitFlywheelReceipts.$inferSelect> }) => input.receipts,
      dispatchEvidenceValidator: async () => fixture.dispatchEvidence,
      ...overrides,
    } as Parameters<typeof buildProfitFlywheelCanaryCloseout>[2];
  }

  it("writes an immutable honest closeout for a complete cycle and exactly one pending next research", async () => {
    const fixture = await seedCloseout();
    const beforeCounts = {
      workflows: (await db.select().from(profitFlywheelWorkflows)).length,
      stages: (await db.select().from(profitFlywheelStageRuns)).length,
      receipts: (await db.select().from(profitFlywheelReceipts)).length,
      events: (await db.select().from(profitFlywheelEvents)).length,
    };
    const outcome = await buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture));
    expect(outcome.status).toBe("closed_next_research_pending");
    await expect((await import("node:fs/promises")).stat(outcome.receiptPath).then((row) => row.mode & 0o777))
      .resolves.toBe(0o444);
    expect(outcome.receipt).toMatchObject({
      outcome: "work_bearing_cycle_closed_next_research_pending",
      expected_control_plane_state: {
        workflow_state: "running",
        current_stage: "research_intake",
      },
      cross_family_review: {
        builder_provider_family: "opencode",
        reviewer_provider_family: "openai",
        final_disposition: "passed",
      },
      released: {
        ref: "refs/heads/main",
        object: fixture.targetObject,
      },
      next_research_intake: {
        stage_run_id: fixture.stages.research.id,
        identity_count: 1,
        event_state: "pending",
      },
      read_only_database_audit: true,
      immutable: true,
    });
    expect({
      workflows: (await db.select().from(profitFlywheelWorkflows)).length,
      stages: (await db.select().from(profitFlywheelStageRuns)).length,
      receipts: (await db.select().from(profitFlywheelReceipts)).length,
      events: (await db.select().from(profitFlywheelEvents)).length,
    }).toEqual(beforeCounts);
    const replay = await buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture, {
      now: () => new Date("2026-07-12T13:00:01.000Z"),
    }));
    expect(replay.receiptPath).toBe(outcome.receiptPath);
    expect(replay.receiptSha256).toBe(outcome.receiptSha256);
    expect(replay.receipt).toEqual(outcome.receipt);
  });

  it("retains exact v2 canary receipt compatibility during closeout", async () => {
    const fixture = await seedCloseout("pos.profit_flywheel_canary.v2");
    const outcome = await buildProfitFlywheelCanaryCloseout(
      db,
      fixture.options,
      closeoutDependencies(fixture),
    );
    expect(outcome.status).toBe("closed_next_research_pending");
  });

  it("ignores superseded attempt-scoped release receipts during closeout", async () => {
    const fixture = await seedCloseout();
    const current = await db.select().from(profitFlywheelReceipts)
      .where(eq(profitFlywheelReceipts.stageRunId, fixture.stages.release.id))
      .then((rows) => rows.find((row) => row.receiptType === "release_receipt")!);
    await db.insert(profitFlywheelReceipts).values({
      ...current,
      id: randomUUID(),
      contentHash: "f".repeat(64),
      status: "revoked",
      attributes: { ...(current.attributes as Record<string, unknown>), attempt: 0 },
      createdAt: new Date(current.createdAt.getTime() - 1_000),
    });
    const outcome = await buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture));
    expect(outcome.status).toBe("closed_next_research_pending");
  });

  it("validates historical provider receipts from persisted route authority after the current policy changes", async () => {
    const fixture = await seedCloseout();
    const priorPolicyPin = process.env.PAPERCLIP_PROVIDER_POLICY_SHA256;
    const priorSchemaPin = process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256;
    const priorPolicyPath = process.env.PAPERCLIP_PROVIDER_POLICY_PATH;
    const priorSchemaPath = process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH;
    const changedPolicyPath = path.join(fixture.dispatchEvidence.authorityRoot, "changed-current-provider-policy.json");
    const changedPolicy = JSON.parse(await readFile(fixture.providerPolicyPins.path, "utf8"));
    changedPolicy.revision = Number(changedPolicy.revision) + 1;
    changedPolicy.updatedAt = "2026-07-12T13:30:00Z";
    const changedPolicyBytes = Buffer.from(JSON.stringify(changedPolicy, null, 2) + "\n", "utf8");
    await writeFile(changedPolicyPath, changedPolicyBytes, { mode: 0o600 });
    process.env.PAPERCLIP_PROVIDER_POLICY_PATH = changedPolicyPath;
    process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH = fixture.providerPolicyPins.schemaPath;
    process.env.PAPERCLIP_PROVIDER_POLICY_SHA256 = digest(changedPolicyBytes);
    process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256 = fixture.providerPolicyPins.schemaSha256;
    try {
      const outcome = await buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture, {
        completionEvidenceValidator: undefined,
        now: () => new Date("2026-07-12T14:00:00.000Z"),
      }));
      expect(outcome.status).toBe("closed_next_research_pending");
    } finally {
      if (priorPolicyPin === undefined) delete process.env.PAPERCLIP_PROVIDER_POLICY_SHA256;
      else process.env.PAPERCLIP_PROVIDER_POLICY_SHA256 = priorPolicyPin;
      if (priorSchemaPin === undefined) delete process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256;
      else process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256 = priorSchemaPin;
      if (priorPolicyPath === undefined) delete process.env.PAPERCLIP_PROVIDER_POLICY_PATH;
      else process.env.PAPERCLIP_PROVIDER_POLICY_PATH = priorPolicyPath;
      if (priorSchemaPath === undefined) delete process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH;
      else process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH = priorSchemaPath;
    }
  });

  it("fails closed when a passing test result points to a now-mutable artifact", async () => {
    const fixture = await seedCloseout();
    await chmod(fixture.artifacts.implementationTest.path, 0o644);
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture)))
      .rejects.toThrow(/artifact|immutable/i);
  });

  it("attests one serializable snapshot instead of mixing rows across a concurrent advance", async () => {
    const fixture = await seedCloseout();
    const writer = createDb(tempDb!.connectionString);
    try {
      const outcome = await buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture, {
        afterSnapshotEstablished: async () => {
          await writer.update(profitFlywheelEvents).set({
            processedAt: new Date("2026-07-12T13:00:00.000Z"),
            updatedAt: new Date("2026-07-12T13:00:00.000Z"),
          }).where(eq(profitFlywheelEvents.id, fixture.event.id));
        },
      }));
      expect(outcome.receipt).toMatchObject({
        database_snapshot: {
          isolation_level: "serializable",
          access_mode: "read only",
        },
        next_research_intake: { event_state: "pending" },
      });
      expect(await writer.select({ processedAt: profitFlywheelEvents.processedAt })
        .from(profitFlywheelEvents)
        .where(eq(profitFlywheelEvents.id, fixture.event.id)))
        .toEqual([{ processedAt: new Date("2026-07-12T13:00:00.000Z") }]);
    } finally {
      await (writer as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }
  });

  it("fails closed when learning has more than one next research identity", async () => {
    const fixture = await seedCloseout();
    await db.insert(profitFlywheelStageRuns).values({
      ...fixture.stages.research,
      id: randomUUID(),
      inputHash: "0".repeat(64),
      idempotencyKey: "duplicate-next-research-" + randomUUID(),
      spanId: "0".repeat(16),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture)))
      .rejects.toThrow("profit_canary_closeout_next_research_identity_ambiguous");
  });

  it("fails closed on event correlation drift", async () => {
    const fixture = await seedCloseout();
    await db.update(profitFlywheelEvents).set({ correlationId: "profit-canary:other" })
      .where(eq(profitFlywheelEvents.id, fixture.event.id));
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture)))
      .rejects.toThrow("profit_canary_closeout_next_research_event_invalid");
  });

  it("fails closed when the next-research event predates its learning source", async () => {
    const fixture = await seedCloseout();
    await db.update(profitFlywheelEvents).set({
      payload: {
        ...(fixture.event.payload as Record<string, unknown>),
        occurred_at: "2026-07-12T11:59:59.000Z",
      },
    }).where(eq(profitFlywheelEvents.id, fixture.event.id));
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture)))
      .rejects.toThrow("profit_canary_closeout_next_research_event_invalid");
  });

  it("rejects a non-local release origin before shared completion validation", async () => {
    const fixture = await seedCloseout();
    const releaseReceipt = (await db.select().from(profitFlywheelReceipts)
      .where(eq(profitFlywheelReceipts.stageRunId, fixture.stages.release.id)))
      .find((receipt) => receipt.receiptType === "release_receipt");
    expect(releaseReceipt).toBeDefined();
    await db.update(profitFlywheelReceipts).set({
      attributes: {
        ...(releaseReceipt!.attributes as Record<string, unknown>),
        remote_origin_url: "https://example.invalid/fixture.git",
      },
    }).where(eq(profitFlywheelReceipts.id, releaseReceipt!.id));
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture, {
      completionEvidenceValidator: undefined,
    }))).rejects.toThrow("profit_canary_closeout_release_remote_binding_invalid");
  });

  it("rejects stage receipt requirements that drift from the pinned contract", async () => {
    const fixture = await seedCloseout();
    await db.update(profitFlywheelStageRuns).set({
      requiredReceipts: [...fixture.stages.qa.requiredReceipts, "forged_receipt"],
    }).where(eq(profitFlywheelStageRuns.id, fixture.stages.qa.id));
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture)))
      .rejects.toThrow("profit_canary_closeout_qa_contract_drift");
  });

  it("rejects an authorization that expires before the final closeout clock", async () => {
    const fixture = await seedCloseout();
    await expect(buildProfitFlywheelCanaryCloseout(db, fixture.options, closeoutDependencies(fixture, {
      now: () => new Date("2026-07-14T01:00:00.000Z"),
    }))).rejects.toThrow("profit_canary_closeout_next_research_authority_expired");
  });
});
