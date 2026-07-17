import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  profitFlywheelEvents,
  profitFlywheelProviderHealth,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { softwareFactoryHealthService } from "../services/software-factory-health.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

describeDb("software factory health", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirectories: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-software-factory-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelEvents);
    await db.delete(profitFlywheelProviderHealth);
    await db.delete(profitFlywheelReceipts);
    await db.delete(profitFlywheelStageRuns);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function writeBaseline(input: { companyId: string; availableBytes: number; promotionBlockers: string[] }) {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-factory-baseline-")));
    tempDirectories.push(directory);
    await chmod(directory, 0o700);
    const receipt = {
      schema_version: "paperclip.profit_flywheel_factory_baseline.v1",
      company_id: input.companyId,
      captured_at: "2026-07-15T12:00:00.000Z",
      target_workflow: null,
      stage_counts: [],
      blocker_counts: [],
      provider_policy: { sha256: null, schema_sha256: null, routes: [] },
      repositories: [
        { name: "portfolio-os", path: "/repos/portfolio-os", head: "a".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "paperclip", path: "/repos/paperclip", head: "b".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-agent", path: "/repos/hermes-agent", head: "c".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-paperclip-adapter", path: "/repos/adapter", head: "d".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
      ],
      adapter: {
        package_name: "@henkey/hermes-paperclip-adapter",
        package_version: "0.1.2",
        plugin_store_version: "0.1.0",
        plugin_store_mode: "development_local_path",
        git_commit: "d".repeat(40),
        git_branch: "main",
        file_manifest_sha256: "c".repeat(64),
      },
      resources: {
        disk: { path: "/System/Volumes/Data", total_bytes: 100 * 1024 ** 3, free_bytes: input.availableBytes, available_bytes: input.availableBytes, free_percent: 2.5 },
        database_bytes: 100,
        ops_bytes: 150,
        backup_bytes: 175,
        log_bytes: 200,
        factory_browser_processes: { count: 0, rss_bytes: 0 },
      },
      tokenomics: {
        receipt_path: "/receipts/tokenomics.json",
        fresh: false,
        status: "fail",
        generated_at: "2026-07-14T00:00:00.000Z",
        age_seconds: 129_600,
      },
      constraints: {
        live_pos_checkout_preserved: true,
        leadforge_excluded: true,
        secrets_redacted: true,
        promotion_blockers: input.promotionBlockers,
      },
    };
    const receiptBytes = `${JSON.stringify(receipt)}\n`;
    const receiptSha256 = sha256(receiptBytes);
    const receiptPath = path.join(directory, `${receiptSha256}.json`);
    await writeFile(receiptPath, receiptBytes, { mode: 0o444 });
    await chmod(receiptPath, 0o444);
    const pointer = {
      schema_version: "paperclip.profit_flywheel_factory_baseline_pointer.v1",
      receipt_path: receiptPath,
      receipt_sha256: receiptSha256,
    };
    const pointerPath = path.join(directory, "latest.json");
    await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, { mode: 0o444 });
    await chmod(pointerPath, 0o444);
    return pointerPath;
  }

  it("returns a canonical fail-closed unknown snapshot when no factory evidence exists", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Empty factory",
      issuePrefix: `E${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });

    const snapshot = await softwareFactoryHealthService(db, {
      mode: "fixture",
      pauseNewWork: false,
    }).build(companyId, { now: new Date("2026-07-15T12:00:00.000Z") });

    expect(snapshot.state).toBe("unknown");
    expect(snapshot.pipeline).toHaveLength(10);
    expect(snapshot.pipeline.every((stage) => stage.total === 0)).toBe(true);
    expect(snapshot.providerReadiness).toHaveLength(8);
    expect(snapshot.providerReadiness.every((alias) => alias.status === "unavailable")).toBe(true);
    expect(snapshot.identities.every((identity) => !identity.verified)).toBe(true);
    expect(snapshot.approvalGates).toContainEqual(expect.objectContaining({ code: "shadow_cycle_requires_approval" }));
  });

  it("forces a dispatch pause and exposes immutable blocker evidence on disk hard stop", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const stageRunId = randomUUID();
    const now = new Date("2026-07-15T12:00:00.000Z");
    const pointerPath = await writeBaseline({
      companyId,
      availableBytes: 6 * 1024 ** 3,
      promotionBlockers: ["disk_below_30_gib", "mutable_adapter_runtime"],
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Blocked factory",
      issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Factory project" });
    await db.insert(profitFlywheelWorkflows).values({
      id: workflowId,
      companyId,
      projectId,
      runId: "fixture-blocked-run",
      state: "blocked",
      currentStage: "research_intake",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/dispatch.json",
      sourceDispatchHash: sha256("dispatch"),
      targetRepo: "fixture/profit-canary",
      targetWorkspaceRoot: "/tmp",
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: sha256("contract"),
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId: "fixture-blocked-run",
      traceId: sha256("trace").slice(0, 32),
    });
    await db.insert(profitFlywheelStageRuns).values({
      id: stageRunId,
      workflowId,
      companyId,
      stage: "research_intake",
      state: "blocked",
      ownerPlane: "portfolio_os",
      inputSchemaVersion: "paperclip.stage_input.v2",
      inputHash: sha256("input"),
      sourceHashes: { source: sha256("source") },
      idempotencyKey: "fixture-blocked-stage",
      attemptCount: 2,
      maxAttempts: 4,
      retryAt: new Date(now.getTime() + 60_000),
      providerCapabilityClass: "research_fast",
      providerRouteId: "fixture_research_fast",
      providerFamily: "fixture",
      concurrencyKey: "factory:research",
      concurrencyLimit: 1,
      requiredReceipts: ["pos_consumer_attempt_receipt"],
      completionEvidence: ["pos_consumer_attempt_receipt"],
      feedback: { retry_classification: { retryable: true } },
      blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
      blockerDetail: "The continuation attempted a live network route",
      nextOwner: "portfolio_os",
      resumeCondition: "Install and verify the fixture-only continuation contract",
      correlationId: "fixture-blocked-run",
      traceId: sha256("trace").slice(0, 32),
      spanId: sha256("span").slice(0, 16),
      createdAt: new Date(now.getTime() - 120_000),
      updatedAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(profitFlywheelReceipts).values({
      companyId,
      workflowId,
      stageRunId,
      receiptType: "pos_consumer_attempt_receipt",
      schemaVersion: "paperclip.pos_consumer_attempt_receipt.v1",
      contentHash: sha256("attempt-receipt"),
      artifactRef: "/tmp/attempt-receipt.json",
      status: "valid",
      observedAt: new Date(now.getTime() - 60_000),
      attributes: {},
      correlationId: "fixture-blocked-run",
      traceId: sha256("trace").slice(0, 32),
      spanId: sha256("span").slice(0, 16),
    });

    const snapshot = await softwareFactoryHealthService(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: pointerPath,
    }).build(companyId, { now });

    expect(snapshot).toMatchObject({
      state: "blocked",
      pauseNewWork: true,
      host: { diskState: "hard_stop", diskAvailableBytes: 6 * 1024 ** 3 },
      economics: { tokenomicsStatus: "stale" },
    });
    expect(snapshot.blockers).toContainEqual(expect.objectContaining({
      stageRunId,
      retryable: true,
      receiptPath: "/tmp/attempt-receipt.json",
      receiptSha256: sha256("attempt-receipt"),
    }));
    expect(snapshot.approvalGates).toContainEqual(expect.objectContaining({
      code: "disk_below_30_gib",
      action: "retention",
    }));
    expect(snapshot.identities.find((identity) => identity.component === "adapter")).toMatchObject({
      verified: false,
      version: "0.1.2",
    });

    const detail = await softwareFactoryHealthService(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: pointerPath,
    }).workflowDetail(companyId, workflowId, now);
    expect(detail).toMatchObject({
      schemaVersion: "paperclip.profit_flywheel_factory_workflow_detail.v1",
      companyId,
      workflow: {
        id: workflowId,
        runId: "fixture-blocked-run",
        state: "blocked",
        currentStage: "research_intake",
      },
      stages: [{
        id: stageRunId,
        state: "blocked",
        attempt: 2,
        inputHash: sha256("input"),
        sourceHashes: { source: sha256("source") },
      }],
      receipts: [expect.objectContaining({
        stageRunId,
        type: "pos_consumer_attempt_receipt",
        contentHash: sha256("attempt-receipt"),
        artifactRef: "/tmp/attempt-receipt.json",
      })],
    });
    expect(await softwareFactoryHealthService(db, { mode: "fixture", pauseNewWork: false })
      .workflowDetail(companyId, randomUUID(), now)).toBeNull();
  });

  it("requires a different healthy provider family for independent review readiness", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const now = new Date("2026-07-15T12:00:00.000Z");
    const policySha256 = sha256("provider-policy");
    const policySchemaSha256 = sha256("provider-policy-schema");
    const aliases = [
      "research_fast",
      "research_deep",
      "code_fast",
      "code_deep",
      "multimodal_qa",
      "independent_review",
    ] as const;
    const providerPolicyLoader = async () => {
      const orderedRouteIds = Object.fromEntries(aliases.map((alias) => [alias, [`route_${alias}`]]));
      return {
        sha256: policySha256,
        schemaSha256: policySchemaSha256,
        policy: {
          aliases: Object.fromEntries([
            ...aliases.map((alias) => [alias, { orderedRouteIds: orderedRouteIds[alias] }]),
            ["summarization", { orderedRouteIds: [] }],
            ["emergency_free", { orderedRouteIds: [] }],
          ]),
          routes: Object.fromEntries(aliases.map((alias) => [`route_${alias}`, {
            id: `route_${alias}`,
            providerFamily: "family-alpha",
            ...(alias === "code_deep" ? {
              runtimeBinding: {
                adapterType: "hermes_local",
                runtimeClosureSha256: sha256("hermes-runtime-closure"),
                expectedVersion: "hermes-1.2.3",
              },
            } : {}),
          }])),
        },
      } as Awaited<ReturnType<NonNullable<Parameters<typeof softwareFactoryHealthService>[1]["providerPolicyLoader"]>>>;
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Provider factory",
      issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Provider project" });
    await db.insert(profitFlywheelWorkflows).values({
      id: workflowId,
      companyId,
      projectId,
      runId: "provider-readiness-run",
      state: "running",
      currentStage: "qa",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/dispatch.json",
      sourceDispatchHash: sha256("provider-dispatch"),
      targetRepo: "fixture/provider-canary",
      targetWorkspaceRoot: "/tmp",
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: sha256("provider-contract"),
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId: "provider-readiness-run",
      traceId: sha256("provider-trace").slice(0, 32),
    });
    for (const [index, alias] of aliases.entries()) {
      const routeId = `route_${alias}`;
      await db.insert(profitFlywheelStageRuns).values({
        workflowId,
        companyId,
        stage: index < 2 ? "research_intake" : index < 4 ? "implementation" : "qa",
        state: "succeeded",
        ownerPlane: index < 2 ? "portfolio_os" : "hermes",
        inputSchemaVersion: "paperclip.stage_input.v2",
        inputHash: sha256(`provider-input:${alias}`),
        sourceHashes: { source: sha256(`provider-source:${alias}`) },
        idempotencyKey: `provider-stage:${alias}`,
        maxAttempts: 2,
        providerCapabilityClass: alias,
        providerRouteId: routeId,
        providerFamily: "family-alpha",
        providerPolicySha256: policySha256,
        concurrencyKey: `provider:${alias}`,
        concurrencyLimit: 1,
        requiredReceipts: [],
        completionEvidence: [],
        correlationId: "provider-readiness-run",
        traceId: sha256("provider-trace").slice(0, 32),
        spanId: sha256(`provider-span:${alias}`).slice(0, 16),
      });
      await db.insert(profitFlywheelProviderHealth).values({
        companyId,
        routeId,
        policySha256,
        policySchemaSha256,
        provider: `provider-${alias}`,
        providerFamily: "family-alpha",
        status: "healthy",
        resolvedModel: `model-${alias}`,
        resolvedVersion: "v1",
        policyRouteCoreSha256: sha256(`core:${alias}`),
        resolvedRouteSha256: sha256(`resolved:${alias}`),
        receiptPath: `/tmp/${routeId}.json`,
        receiptSha256: sha256(`receipt:${alias}`),
        receiptSchemaVersion: alias === "code_deep"
          ? "hermes-completion-canary-receipt.v1"
          : "paperclip.provider_canary.v1",
        canaryKind: "minimal_token",
        observedAt: new Date(now.getTime() - 1_000),
        expiresAt: new Date(now.getTime() + 60_000),
        correlationId: "provider-readiness-run",
        traceId: sha256("provider-trace").slice(0, 32),
        spanId: sha256(`provider-health-span:${alias}`).slice(0, 16),
        details: {},
      });
    }

    await db.insert(profitFlywheelProviderHealth).values({
      companyId,
      routeId: "obsolete_route",
      policySha256: sha256("obsolete-policy"),
      policySchemaSha256: sha256("obsolete-schema"),
      provider: "obsolete-provider",
      providerFamily: "obsolete-family",
      status: "healthy",
      resolvedModel: "obsolete-model",
      resolvedVersion: "v9",
      policyRouteCoreSha256: sha256("obsolete-core"),
      resolvedRouteSha256: sha256("obsolete-resolved"),
      receiptPath: "/tmp/obsolete.json",
      receiptSha256: sha256("obsolete-receipt"),
      receiptSchemaVersion: "paperclip.provider_canary.v1",
      canaryKind: "minimal_token",
      observedAt: new Date(now.getTime()),
      expiresAt: new Date(now.getTime() + 120_000),
      correlationId: "obsolete-policy",
      traceId: sha256("obsolete-trace").slice(0, 32),
      spanId: sha256("obsolete-span").slice(0, 16),
      details: {},
    });

    const service = softwareFactoryHealthService(db, {
      mode: "fixture",
      pauseNewWork: false,
      providerPolicyLoader,
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
      managedPortfolioOsRuntimeResolver: async () => ({
        current: {
          runtime_id: `portfolio-os-${sha256("pos-runtime-id")}`,
          closure_sha256: sha256("pos-runtime-closure"),
        },
      }) as Awaited<ReturnType<NonNullable<Parameters<typeof softwareFactoryHealthService>[1]["managedPortfolioOsRuntimeResolver"]>>>,
    });
    const sameFamily = await service.build(companyId, { now });
    expect(sameFamily.identities.find((entry) => entry.component === "provider_policy")?.sha256).toBe(policySha256);
    expect(sameFamily.providerReadiness.flatMap((entry) => entry.routes).some((route) => route.routeId === "obsolete_route")).toBe(false);
    expect(sameFamily.providerReadiness.find((entry) => entry.alias === "independent_review")).toMatchObject({
      status: "degraded",
      independentReviewReady: false,
    });
    expect(sameFamily.identities.find((entry) => entry.component === "provider_policy")?.verified).toBe(false);
    expect(sameFamily.identities.find((entry) => entry.component === "portfolio_os")).toMatchObject({
      version: `portfolio-os-${sha256("pos-runtime-id")}`,
      sha256: sha256("pos-runtime-closure"),
      verified: true,
    });
    expect(sameFamily.identities.find((entry) => entry.component === "hermes")).toMatchObject({
      version: "hermes-1.2.3",
      sha256: sha256("hermes-runtime-closure"),
      verified: true,
    });

    await db.update(profitFlywheelProviderHealth).set({ providerFamily: "family-beta" })
      .where(eq(profitFlywheelProviderHealth.routeId, "route_independent_review"));
    const differentFamily = await service.build(companyId, { now });
    expect(differentFamily.providerReadiness.find((entry) => entry.alias === "independent_review")).toMatchObject({
      status: "ready",
      independentReviewReady: true,
    });
    expect(differentFamily.identities.find((entry) => entry.component === "provider_policy")?.verified).toBe(true);
  });

  it("bounds funnel counts to the requested factory window", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const now = new Date("2026-07-15T12:00:00.000Z");
    const old = new Date("2026-07-01T12:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Windowed factory",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Window project" });
    for (const [label, timestamp] of [["old", old], ["current", now]] as const) {
      const workflowId = randomUUID();
      await db.insert(profitFlywheelWorkflows).values({
        id: workflowId,
        companyId,
        projectId,
        runId: `window-${label}`,
        state: "running",
        currentStage: "dispatch",
        sourceSchemaVersion: "pos.dispatch.v2",
        sourceDispatchPath: `/tmp/${label}.json`,
        sourceDispatchHash: sha256(`dispatch:${label}`),
        targetRepo: `fixture/${label}`,
        targetWorkspaceRoot: "/tmp",
        contractPath: "/tmp/profit-flywheel.v2.json",
        contractSha256: sha256("contract"),
        contractSnapshot: { schema_version: "profit-flywheel.v2" },
        correlationId: `window-${label}`,
        traceId: sha256(`trace:${label}`).slice(0, 32),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await db.insert(profitFlywheelStageRuns).values({
        workflowId,
        companyId,
        stage: "dispatch",
        state: "succeeded",
        ownerPlane: "portfolio_os",
        inputSchemaVersion: "paperclip.stage_input.v2",
        inputHash: sha256(`input:${label}`),
        sourceHashes: { source: sha256(`source:${label}`) },
        idempotencyKey: `window-stage:${label}`,
        maxAttempts: 1,
        providerCapabilityClass: "code_fast",
        concurrencyKey: "factory:window",
        concurrencyLimit: 1,
        requiredReceipts: [],
        completionEvidence: [],
        correlationId: `window-${label}`,
        traceId: sha256(`trace:${label}`).slice(0, 32),
        spanId: sha256(`span:${label}`).slice(0, 16),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    const snapshot = await softwareFactoryHealthService(db, {
      mode: "fixture",
      pauseNewWork: false,
    }).build(companyId, { now, since: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
    expect(snapshot.pipeline.find((entry) => entry.stage === "dispatch")).toMatchObject({
      total: 1,
      counts: { succeeded: 1 },
    });
  });
});
