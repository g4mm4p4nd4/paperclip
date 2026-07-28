import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { createDbFactoryLaunchAuthority } from "../services/factory-live-launch-authority.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describeDb("DB-backed workflow-root factory launch authority", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const receiptRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-factory-live-authority-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelWorkflows);
    await db.delete(approvals);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(receiptRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  it("consumes an approved pre-workflow root once, then authorizes only the persisted bound workflow", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const rootHash = sha("root-dispatch");
    const runId = "shadow-run-1";
    const targetRepo = "owner/shadow-target";
    await db.insert(companies).values({
      id: companyId,
      name: "Shadow factory",
      issuePrefix: "SFA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shadow" });
    const approval = await db.insert(approvals).values({
      companyId,
      type: "profit_flywheel_shadow_launch",
      status: "approved",
      decidedByUserId: "operator-1",
      decidedAt: new Date("2026-07-17T18:00:00.000Z"),
      payload: {
        schema_version: "paperclip.factory_launch_approval.v1",
        company_id: companyId,
        target_repo: targetRepo,
        run_id: runId,
        input_hash: rootHash,
        contract_hashes: { contract: sha("contract") },
        vector_hashes: { vectors: sha("vectors") },
        provider_route_hashes: { route: sha("route") },
        credential_epoch_hashes: { credential: sha("credential") },
        pos_runtime: {
          manifest_path: "/runtime/pos/manifest.json",
          manifest_sha256: sha("pos-manifest"),
          source_commit: "a".repeat(40),
        },
        adapter_bundle: {
          manifest_sha256: sha("adapter-manifest"),
          archive_sha256: sha("adapter-archive"),
          version: "1.0.0",
          source_commit: "b".repeat(40),
        },
        requested_mode: "shadow",
        expires_at: "2026-07-17T19:00:00.000Z",
        excluded_target_checked: true,
        fixture_bindings_absent: true,
      },
    }).returning().then((rows) => rows[0]!);
    const receiptDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-live-authority-receipts-")));
    receiptRoots.push(receiptDir);
    let bindingsCurrent = true;
    const authority = createDbFactoryLaunchAuthority(db, {
      receiptDir,
      verifyBindings: async () => bindingsCurrent,
      now: () => new Date("2026-07-17T18:15:00.000Z"),
    });

    const rootDecision = await authority.claim({
      kind: "portfolio_dispatch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "deterministic",
      companyId,
      targetRepo,
      runId,
      inputHash: rootHash,
      stage: "dispatch_ingest",
    });
    expect(rootDecision).toMatchObject({
      allowed: true,
      code: "factory_workflow_root_approval_consumed",
      approvalId: approval.id,
    });

    await expect(authority.claim({
      kind: "portfolio_dispatch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "deterministic",
      companyId,
      targetRepo,
      runId,
      inputHash: rootHash,
      stage: "dispatch_ingest",
    })).resolves.toMatchObject({
      allowed: true,
      code: "factory_workflow_root_authorized",
      approvalId: approval.id,
      consumptionReceipt: rootDecision.consumptionReceipt,
    });

    await expect(authority.claim({
      kind: "portfolio_dispatch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "deterministic",
      companyId,
      targetRepo,
      runId,
      inputHash: sha("wrong-root-dispatch"),
      stage: "dispatch_ingest",
    })).resolves.toMatchObject({
      allowed: false,
      code: "factory_live_approval_required",
    });

    const workflow = await db.insert(profitFlywheelWorkflows).values({
      companyId,
      projectId,
      runId,
      state: "running",
      currentStage: "implementation",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/immutable/dispatch.json",
      sourceDispatchHash: rootHash,
      targetRepo,
      targetWorkspaceRoot: "/workspace/shadow",
      contractPath: "/contracts/profit-flywheel.v2.json",
      contractSha256: sha("contract"),
      contractSnapshot: {},
      correlationId: "shadow:run-1",
      traceId: sha("trace").slice(0, 32),
    }).returning().then((rows) => rows[0]!);

    await expect(authority.claim({
      kind: "pos_consumer_launch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "research_fast",
      companyId,
      targetRepo,
      workflowId: workflow.id,
      runId,
      inputHash: sha("stage-input"),
      stage: "research_intake",
    })).resolves.toMatchObject({
      allowed: true,
      code: "factory_workflow_root_authorized",
      approvalId: approval.id,
      consumptionReceipt: rootDecision.consumptionReceipt,
    });

    await expect(authority.claim({
      kind: "pos_consumer_launch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "research_fast",
      companyId,
      targetRepo,
      workflowId: randomUUID(),
      runId,
      inputHash: sha("stage-input"),
      stage: "research_intake",
    })).resolves.toMatchObject({ allowed: false, code: "factory_live_approval_required" });

    bindingsCurrent = false;
    await expect(authority.claim({
      kind: "pos_consumer_launch",
      mode: "shadow",
      pauseNewWork: false,
      providerCapabilityClass: "research_fast",
      companyId,
      targetRepo,
      workflowId: workflow.id,
      runId,
      inputHash: sha("stage-input"),
      stage: "research_intake",
    })).resolves.toMatchObject({
      allowed: false,
      code: "factory_live_approval_binding_drift",
      terminal: true,
    });
  });
});
