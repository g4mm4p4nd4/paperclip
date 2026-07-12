import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  profitFlywheelEvents,
  profitFlywheelLeases,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("Profit Flywheel database tenant-lineage integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-tenant-integrity-");
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
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  function workflowValues(companyId: string, projectId: string, suffix = randomUUID()) {
    return {
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
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: "c".repeat(64),
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId: `profit:${suffix}`,
      traceId: createHash("sha256").update(suffix).digest("hex").slice(0, 32),
    };
  }

  function stageValues(
    workflow: typeof profitFlywheelWorkflows.$inferSelect,
    overrides: Partial<typeof profitFlywheelStageRuns.$inferInsert> = {},
  ) {
    const suffix = randomUUID();
    return {
      workflowId: workflow.id,
      companyId: workflow.companyId,
      stage: "implementation",
      state: "pending",
      ownerPlane: "paperclip",
      inputSchemaVersion: "paperclip.stage_input.v2",
      inputHash: createHash("sha256").update(suffix).digest("hex"),
      sourceHashes: { dispatch_hash: "d".repeat(64) },
      idempotencyKey: `${workflow.companyId}:${workflow.runId}:implementation:${suffix}`,
      maxAttempts: 2,
      providerCapabilityClass: "code_deep",
      concurrencyKey: `repo:${suffix}`,
      concurrencyLimit: 1,
      requiredReceipts: ["implementation_receipt"],
      completionEvidence: ["artifact_hash"],
      correlationId: workflow.correlationId,
      traceId: workflow.traceId,
      spanId: createHash("sha256").update(`span:${suffix}`).digest("hex").slice(0, 16),
      ...overrides,
    };
  }

  it("rejects every cross-company workflow, issue, transition, receipt, event, and lease binding", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Tenant A", issuePrefix: `A${companyA.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
      { id: companyB, name: "Tenant B", issuePrefix: `B${companyB.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(projects).values([
      { id: projectA, companyId: companyA, name: "Project A" },
      { id: projectB, companyId: companyB, name: "Project B" },
    ]);
    await db.insert(issues).values([
      { id: issueA, companyId: companyA, projectId: projectA, title: "Issue A" },
      { id: issueB, companyId: companyB, projectId: projectB, title: "Issue B" },
    ]);

    await expect(db.insert(profitFlywheelWorkflows).values(workflowValues(companyA, projectB)))
      .rejects.toThrow("profit_flywheel_workflows_project_company_fk");

    const workflowA = await db.insert(profitFlywheelWorkflows).values(workflowValues(companyA, projectA))
      .returning().then((rows) => rows[0]!);
    const workflowB = await db.insert(profitFlywheelWorkflows).values(workflowValues(companyB, projectB))
      .returning().then((rows) => rows[0]!);
    const sourceA = await db.insert(profitFlywheelStageRuns).values(stageValues(workflowA, { linkedIssueId: issueA }))
      .returning().then((rows) => rows[0]!);
    const sourceB = await db.insert(profitFlywheelStageRuns).values(stageValues(workflowB, { linkedIssueId: issueB }))
      .returning().then((rows) => rows[0]!);

    await expect(db.insert(profitFlywheelStageRuns).values(stageValues(workflowA, { companyId: companyB })))
      .rejects.toThrow("profit_flywheel_stage_runs_workflow_company_fk");
    await expect(db.insert(profitFlywheelStageRuns).values(stageValues(workflowA, { linkedIssueId: issueB })))
      .rejects.toThrow("profit_flywheel_stage_runs_linked_issue_company_fk");
    await expect(db.insert(profitFlywheelStageRuns).values(stageValues(workflowA, {
      transitionSourceStageRunId: sourceB.id,
      transitionSourceOutputHash: "e".repeat(64),
    }))).rejects.toThrow("profit_flywheel_stage_runs_transition_source_lineage_fk");

    await expect(db.insert(profitFlywheelReceipts).values({
      companyId: companyB,
      workflowId: workflowA.id,
      stageRunId: sourceA.id,
      receiptType: "implementation_receipt",
      schemaVersion: "paperclip.receipt.v2",
      contentHash: "a".repeat(64),
      status: "valid",
      observedAt: new Date(),
      attributes: {},
      correlationId: workflowA.correlationId,
      traceId: workflowA.traceId,
      spanId: sourceA.spanId,
    })).rejects.toThrow(/profit_flywheel_receipts_(?:stage_lineage|workflow_company)_fk/);

    await expect(db.insert(profitFlywheelEvents).values({
      companyId: companyB,
      workflowId: workflowA.id,
      stageRunId: sourceA.id,
      eventType: "stage_requested",
      dedupeKey: randomUUID(),
      correlationId: workflowA.correlationId,
      traceId: workflowA.traceId,
      spanId: sourceA.spanId,
      payload: {},
    })).rejects.toThrow(/profit_flywheel_events_(?:stage_lineage|workflow_company)_fk/);

    await expect(db.insert(profitFlywheelLeases).values({
      companyId: companyB,
      stageRunId: sourceA.id,
      scopeType: "stage",
      scopeKey: `stage:${sourceA.id}`,
      slot: 0,
      leaseOwner: "tenant-bound-owner",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow("profit_flywheel_leases_stage_company_fk");
  });
});
