import { createHash, randomUUID } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  profitFlywheelEvents,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { canonicalProfitFlywheelReceiptHash, profitFlywheelService } from "../services/profit-flywheel.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

function hash(label: string) {
  return createHash("sha256").update(label).digest("hex");
}

describeDb("Profit Flywheel v2 operations receipt", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const artifactPaths: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-profit-ops-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(artifactPaths.splice(0).map((artifactPath) => rm(artifactPath, { force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedCompany() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const traceId = hash(`trace:${companyId}`).slice(0, 32);
    const correlationId = `profit:${companyId}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Ops ${companyId.slice(0, 6)}`,
      issuePrefix: `O${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Ops receipt fixture" });
    await db.insert(profitFlywheelWorkflows).values({
      id: workflowId,
      companyId,
      projectId,
      runId: `ops-${companyId}`,
      state: "running",
      currentStage: "learning",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/ops-dispatch.json",
      sourceDispatchHash: hash("ops-dispatch"),
      targetRepo: "fixture/profit-flywheel",
      targetWorkspaceRoot: "/tmp",
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: hash("ops-contract"),
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId,
      traceId,
    });
    return { companyId, projectId, workflowId, traceId, correlationId };
  }

  async function addStage(input: {
    fixture: Awaited<ReturnType<typeof seedCompany>>;
    label: string;
    stage: "research_intake" | "commercial_validation" | "council_decision" | "dispatch" | "implementation" | "qa" | "release";
    state: "succeeded" | "failed" | "blocked" | "safely_skipped";
    completedAt: Date;
    requiredReceipts?: string[];
    feedback?: Record<string, unknown>;
    blockerCode?: string;
    providerRouteId?: string;
    usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
  }) {
    const id = randomUUID();
    const spanId = hash(`span:${input.label}`).slice(0, 16);
    const requiredReceipts = input.requiredReceipts ?? [];
    let artifactPath: string | null = null;
    await db.insert(profitFlywheelStageRuns).values({
      id,
      workflowId: input.fixture.workflowId,
      companyId: input.fixture.companyId,
      stage: input.stage,
      state: input.state,
      ownerPlane: input.stage === "research_intake" ? "portfolio_os" : "paperclip",
      inputSchemaVersion: "paperclip.stage_input.v2",
      inputHash: hash(`input:${input.label}`),
      sourceHashes: { source: hash(`source:${input.label}`) },
      idempotencyKey: `${input.fixture.companyId}:${input.label}`,
      maxAttempts: 2,
      providerCapabilityClass: input.providerRouteId ? "code_deep" : "deterministic",
      providerRouteId: input.providerRouteId ?? null,
      concurrencyKey: `ops:${input.label}`,
      concurrencyLimit: 1,
      requiredReceipts,
      completionEvidence: requiredReceipts,
      feedback: input.feedback ?? {},
      blockerCode: input.blockerCode ?? null,
      blockerDetail: input.blockerCode ? `${input.blockerCode} detail` : null,
      nextOwner: input.blockerCode ? "research_owner" : null,
      resumeCondition: input.blockerCode ? "Repair source and retry" : null,
      correlationId: input.fixture.correlationId,
      traceId: input.fixture.traceId,
      spanId,
      startedAt: new Date(input.completedAt.getTime() - 60_000),
      completedAt: input.completedAt,
      createdAt: new Date(input.completedAt.getTime() - 60_000),
      updatedAt: input.completedAt,
    });
    if (requiredReceipts.includes("implementation_receipt")) {
      artifactPath = path.join("/tmp", `paperclip-profit-ops-${randomUUID()}.json`);
      const bytes = `${JSON.stringify({ label: input.label, state: "succeeded" })}\n`;
      await writeFile(artifactPath, bytes, { mode: 0o444 });
      await chmod(artifactPath, 0o444);
      artifactPaths.push(artifactPath);
      const artifactHash = createHash("sha256").update(bytes).digest("hex");
      const base = {
        type: "implementation_receipt",
        schemaVersion: "paperclip.implementation_receipt.v2",
        artifactRef: artifactPath,
        observedAt: input.completedAt.toISOString(),
        expiresAt: null,
        attributes: { artifact_hash: artifactHash },
      };
      await db.insert(profitFlywheelReceipts).values({
        companyId: input.fixture.companyId,
        workflowId: input.fixture.workflowId,
        stageRunId: id,
        receiptType: "implementation_receipt",
        schemaVersion: "paperclip.implementation_receipt.v2",
        contentHash: canonicalProfitFlywheelReceiptHash(base),
        artifactRef: artifactPath,
        status: "valid",
        observedAt: input.completedAt,
        attributes: base.attributes,
        correlationId: input.fixture.correlationId,
        traceId: input.fixture.traceId,
        spanId,
      });
    }
    if (input.usage) {
      await db.insert(profitFlywheelReceipts).values({
        companyId: input.fixture.companyId,
        workflowId: input.fixture.workflowId,
        stageRunId: id,
        receiptType: "provider_run_receipt",
        schemaVersion: "paperclip.provider_run_receipt.v2",
        contentHash: hash(`provider:${input.label}`),
        artifactRef: `/tmp/${input.label}-execution.json`,
        status: "valid",
        observedAt: input.completedAt,
        attributes: { usage: input.usage, artifact_hash: hash(`execution:${input.label}`) },
        correlationId: input.fixture.correlationId,
        traceId: input.fixture.traceId,
        spanId,
      });
    }
    return { id, spanId, artifactPath };
  }

  it("marks sample-dependent SLOs insufficient instead of manufacturing zero health", async () => {
    const fixture = await seedCompany();
    const receipt = await profitFlywheelService(db).buildOpsReceipt(fixture.companyId, {
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(receipt.metrics.seven_day_work_bearing_token_reduction).toMatchObject({ status: "insufficient_data", passes_target: null });
    expect(receipt.metrics.valuable_safe_skip_percentage).toMatchObject({ status: "insufficient_data", passes_target: null });
    expect(receipt.metrics.artifact_backed_percentage).toMatchObject({ status: "insufficient_data", passes_target: null });
    expect(receipt.metrics.false_success_count).toMatchObject({ status: "insufficient_data", value: null });
    expect(receipt.metrics.research_source_failure_rate).toMatchObject({ status: "insufficient_data", passes_target: null });
  });

  it("measures token reduction, valuable decisions, artifact evidence, false success, and research-source failure against explicit samples", async () => {
    const fixture = await seedCompany();
    const now = new Date("2026-07-15T12:00:00.000Z");
    const prior = await addStage({
      fixture,
      label: "prior-implementation",
      stage: "implementation",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      requiredReceipts: ["implementation_receipt"],
      providerRouteId: "opencode_go_deep",
      usage: { input_tokens: 600, output_tokens: 400, cost_usd: 0.2 },
    });
    const current = await addStage({
      fixture,
      label: "current-implementation",
      stage: "implementation",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      requiredReceipts: ["implementation_receipt"],
      providerRouteId: "opencode_go_deep",
      usage: { input_tokens: 200, output_tokens: 200, cost_usd: 0.1 },
    });
    const council = await addStage({
      fixture,
      label: "valuable-council",
      stage: "council_decision",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
      feedback: { valuable: true },
    });
    await addStage({
      fixture,
      label: "safe-dispatch",
      stage: "dispatch",
      state: "safely_skipped",
      completedAt: new Date(now.getTime() - 19 * 60 * 60 * 1000),
    });
    await addStage({
      fixture,
      label: "research-success",
      stage: "research_intake",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 18 * 60 * 60 * 1000),
    });
    const failedResearch = await addStage({
      fixture,
      label: "research-failure",
      stage: "research_intake",
      state: "failed",
      completedAt: new Date(now.getTime() - 17 * 60 * 60 * 1000),
      blockerCode: "source_timeout",
    });
    await db.insert(profitFlywheelEvents).values([
      {
        companyId: fixture.companyId,
        workflowId: fixture.workflowId,
        stageRunId: current.id,
        eventType: "stage_succeeded",
        dedupeKey: "ops-current-succeeded",
        fromState: "running",
        toState: "succeeded",
        correlationId: fixture.correlationId,
        traceId: fixture.traceId,
        spanId: current.spanId,
        payload: { explicit_terminal_evidence: true },
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
      {
        companyId: fixture.companyId,
        workflowId: fixture.workflowId,
        stageRunId: council.id,
        eventType: "stage_succeeded",
        dedupeKey: "ops-council-succeeded",
        fromState: "running",
        toState: "succeeded",
        correlationId: fixture.correlationId,
        traceId: fixture.traceId,
        spanId: council.spanId,
        payload: { explicit_terminal_evidence: true },
        createdAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
      },
      {
        companyId: fixture.companyId,
        workflowId: fixture.workflowId,
        stageRunId: failedResearch.id,
        eventType: "stage_failed",
        dedupeKey: "ops-research-failed",
        fromState: "running",
        toState: "failed",
        correlationId: fixture.correlationId,
        traceId: fixture.traceId,
        spanId: failedResearch.spanId,
        payload: { blockerCode: "source_timeout" },
        createdAt: new Date(now.getTime() - 17 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 17 * 60 * 60 * 1000),
      },
    ]);

    const receipt = await profitFlywheelService(db).buildOpsReceipt(fixture.companyId, {
      since: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      now,
    });
    expect(receipt.metrics.tokens_per_completed_deliverable).toMatchObject({ status: "measured", value: 700, sample_size: 2 });
    expect(receipt.metrics.cost_per_completed_deliverable_usd).toMatchObject({ status: "measured", sample_size: 2 });
    expect(receipt.metrics.cost_per_completed_deliverable_usd.value).toBeCloseTo(0.15);
    expect(receipt.metrics.seven_day_work_bearing_token_reduction).toMatchObject({
      status: "measured",
      value: 0.6,
      passes_target: true,
      current_window: { deliverables: 1, tokens: 400, tokensPerDeliverable: 400 },
      prior_window: { deliverables: 1, tokens: 1000, tokensPerDeliverable: 1000 },
    });
    expect(receipt.metrics.valuable_safe_skip_percentage).toMatchObject({ status: "measured", value: 1, passes_target: true, sample_size: 2 });
    expect(receipt.metrics.artifact_backed_percentage).toMatchObject({ status: "measured", value: 1, passes_target: true, sample_size: 2 });
    expect(receipt.metrics.false_success_count).toMatchObject({ status: "insufficient_data", value: null });
    expect(receipt.metrics.research_source_failure_rate).toMatchObject({ status: "measured", value: 0.5, passes_target: false, sample_size: 2 });
    expect(receipt.metrics.source_failures).toMatchObject({ status: "measured", value: { count: 1, by_code: { source_timeout: 1 } }, sample_size: 2 });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prior.id).not.toBe(current.id);
  });

  it("requires complete token coverage in both seven-day windows and revalidates artifact bytes", async () => {
    const fixture = await seedCompany();
    const now = new Date("2026-07-15T12:00:00.000Z");
    await addStage({
      fixture,
      label: "prior-covered",
      stage: "implementation",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      providerRouteId: "route-a",
      usage: { input_tokens: 100, output_tokens: 100 },
    });
    await addStage({
      fixture,
      label: "current-covered",
      stage: "implementation",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      providerRouteId: "route-b",
      usage: { input_tokens: 20, output_tokens: 20 },
    });
    const missingUsage = await addStage({
      fixture,
      label: "current-uncovered",
      stage: "implementation",
      state: "succeeded",
      completedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      requiredReceipts: ["implementation_receipt"],
      providerRouteId: "route-b",
    });
    const partial = await profitFlywheelService(db).buildOpsReceipt(fixture.companyId, {
      since: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      now,
    });
    expect(partial.metrics.seven_day_work_bearing_token_reduction).toMatchObject({
      status: "insufficient_data",
      passes_target: null,
      current_window: { deliverables: 2, token_covered_deliverables: 1, token_coverage: 0.5 },
    });
    expect(partial.metrics.artifact_backed_percentage).toMatchObject({ status: "measured", value: 1 / 3 });
    await rm(missingUsage.artifactPath!, { force: true });
    const deleted = await profitFlywheelService(db).buildOpsReceipt(fixture.companyId, {
      since: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      now,
    });
    expect(deleted.metrics.artifact_backed_percentage).toMatchObject({ status: "measured", value: 0 });
  });
});
