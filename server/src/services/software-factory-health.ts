import {
  profitFlywheelEvents,
  profitFlywheelProviderHealth,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import {
  PROFIT_FLYWHEEL_CAPABILITY_ALIASES,
  PROFIT_FLYWHEEL_RUN_STATES,
  PROFIT_FLYWHEEL_STAGES,
  profitFlywheelFactoryHealthSchema,
  profitFlywheelFactoryWorkflowDetailSchema,
  profitFlywheelFactoryBaselineSchema,
  type ProfitFlywheelCapabilityAlias,
  type ProfitFlywheelFactoryHealth,
  type ProfitFlywheelFactoryMode,
  type ProfitFlywheelFactoryProviderRoute,
  type ProfitFlywheelReceipt,
  type ProfitFlywheelRunState,
  type ProfitFlywheelStage,
} from "@paperclipai/shared";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { readTrustedFile, readTrustedJsonFile } from "../ops/trusted-receipt-directory.js";
import { hashProfitFlywheelValue, profitFlywheelService } from "./profit-flywheel.js";
import { loadProviderPolicyV2 } from "./provider-policy.js";
import { resolveManagedPortfolioOsRuntime } from "./managed-pos-runtime.js";

const MAX_POINTER_BYTES = 16 * 1024;
const MAX_BASELINE_BYTES = 4 * 1024 * 1024;
const GIB = 1024 ** 3;

export interface SoftwareFactoryHealthOptions {
  mode: ProfitFlywheelFactoryMode;
  pauseNewWork: boolean | (() => boolean);
  pause?: () => Promise<void>;
  baselinePointerPath?: string;
  maxSnapshotAgeSeconds?: number;
  providerPolicyLoader?: typeof loadProviderPolicyV2;
  /** Full managed POS closure root. Omission keeps live identity fail-closed. */
  portfolioOsRuntimeRoot?: string;
  /** Injectable verifier used by tests and alternate process composition. */
  managedPortfolioOsRuntimeResolver?: typeof resolveManagedPortfolioOsRuntime;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteOrNull(value: unknown) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function measuredValue(value: unknown) {
  const metric = asRecord(value);
  return metric.status === "measured" ? finiteOrNull(metric.value) : null;
}

async function readBaseline(pointerPath: string | undefined, expectedCompanyId: string) {
  if (!pointerPath) return null;
  try {
    const pointerArtifact = await readTrustedFile(pointerPath, "factory_health_baseline_pointer", {
      maxBytes: MAX_POINTER_BYTES,
      requireReadOnly: false,
      requireCurrentOwner: true,
    });
    const pointer = asRecord(JSON.parse(pointerArtifact.bytes.toString("utf8")));
    const receiptPath = stringOrNull(pointer.receipt_path);
    const expectedSha256 = stringOrNull(pointer.receipt_sha256);
    if (pointer.schema_version !== "paperclip.profit_flywheel_factory_baseline_pointer.v1" ||
        !receiptPath || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) return null;
    const receipt = await readTrustedJsonFile(receiptPath, "factory_health_baseline_receipt", {
      maxBytes: MAX_BASELINE_BYTES,
      requireCurrentOwner: true,
    });
    if (receipt.sha256 !== expectedSha256) return null;
    const parsed = profitFlywheelFactoryBaselineSchema.safeParse(receipt.value);
    if (!parsed.success || parsed.data.company_id !== expectedCompanyId) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function receiptProjection(row: typeof profitFlywheelReceipts.$inferSelect): ProfitFlywheelReceipt {
  return {
    type: row.receiptType,
    schemaVersion: row.schemaVersion,
    contentHash: row.contentHash,
    artifactRef: row.artifactRef,
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    attributes: row.attributes,
  };
}

function latestReceipt(
  receipts: Array<typeof profitFlywheelReceipts.$inferSelect>,
  types: readonly string[],
) {
  const row = receipts.find((candidate) => types.includes(candidate.receiptType) && candidate.status === "valid");
  return row ? receiptProjection(row) : null;
}

function baselineRepository(baseline: Record<string, unknown> | null, name: string) {
  const repositories = Array.isArray(baseline?.repositories) ? baseline.repositories.map(asRecord) : [];
  return repositories.find((entry) => entry.name === name) ?? {};
}

function baselineIdentity(baseline: Record<string, unknown> | null, component: "adapter") {
  if (!baseline) return { component, version: null, sha256: null, verified: false, detail: "Baseline receipt is unavailable" };
  const adapter = asRecord(baseline.adapter);
  const immutable = adapter.plugin_store_mode === "immutable_bundle" && adapter.package_version === adapter.plugin_store_version;
  return {
    component,
    version: stringOrNull(adapter.package_version),
    sha256: stringOrNull(adapter.file_manifest_sha256),
    verified: immutable,
    detail: immutable ? null : "Adapter is not loaded from a version-matched immutable bundle",
  };
}

async function managedPortfolioOsIdentity(
  runtimeRoot: string | undefined,
  resolver: typeof resolveManagedPortfolioOsRuntime,
) {
  if (!runtimeRoot) return {
    component: "portfolio_os" as const,
    version: null,
    sha256: null,
    verified: false,
    detail: "Managed POS runtime root is not configured",
  };
  try {
    const runtime = await resolver({ runtimeRoot });
    return {
      component: "portfolio_os" as const,
      version: runtime.current.runtime_id,
      sha256: runtime.current.closure_sha256,
      verified: true,
      detail: null,
    };
  } catch (error) {
    return {
      component: "portfolio_os" as const,
      version: null,
      sha256: null,
      verified: false,
      detail: error instanceof Error ? error.message : "Managed POS runtime verification failed",
    };
  }
}

function retryableFromStage(stage: typeof profitFlywheelStageRuns.$inferSelect) {
  const feedback = asRecord(stage.feedback);
  const retry = asRecord(feedback.retry_classification ?? feedback.retryClassification);
  return retry.retryable === true || stage.retryAt !== null;
}

function receiptForStage(
  stageId: string,
  receipts: Array<typeof profitFlywheelReceipts.$inferSelect>,
) {
  const candidates = receipts.filter((receipt) => receipt.stageRunId === stageId && receipt.status === "valid");
  const attempt = candidates.find((receipt) => receipt.receiptType === "paperclip_stage_blocker_receipt") ??
    candidates.find((receipt) => receipt.receiptType === "pos_consumer_attempt_receipt") ?? candidates[0];
  if (!attempt) return { id: null, path: null, sha256: null };
  return { id: attempt.id, path: attempt.artifactRef, sha256: attempt.contentHash };
}

function providerRoute(
  row: typeof profitFlywheelProviderHealth.$inferSelect | undefined,
  expected?: { id: string; providerFamily: string },
): ProfitFlywheelFactoryProviderRoute {
  return row ? {
    routeId: row.routeId,
    providerFamily: row.providerFamily,
    status: row.status as ProfitFlywheelFactoryProviderRoute["status"],
    failureClass: row.failureClass,
    failureDetail: row.failureDetail,
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  } : {
    routeId: expected?.id ?? "unobserved",
    providerFamily: expected?.providerFamily ?? "unknown",
    status: "unknown",
    failureClass: null,
    failureDetail: null,
    observedAt: null,
    expiresAt: null,
  };
}

export function softwareFactoryHealthService(db: Db, options: SoftwareFactoryHealthOptions) {
  const svc = profitFlywheelService(db);
  const isPaused = () => typeof options.pauseNewWork === "function" ? options.pauseNewWork() : options.pauseNewWork;

  async function workflowDetail(companyId: string, workflowId: string, now = new Date()) {
    const workflow = await db.select().from(profitFlywheelWorkflows).where(and(
      eq(profitFlywheelWorkflows.id, workflowId),
      eq(profitFlywheelWorkflows.companyId, companyId),
    )).then((rows) => rows[0] ?? null);
    if (!workflow) return null;
    const [stages, receipts, events] = await Promise.all([
      db.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.workflowId, workflowId),
        eq(profitFlywheelStageRuns.companyId, companyId),
      )).orderBy(asc(profitFlywheelStageRuns.createdAt)),
      db.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.workflowId, workflowId),
        eq(profitFlywheelReceipts.companyId, companyId),
      )).orderBy(asc(profitFlywheelReceipts.createdAt)),
      db.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.workflowId, workflowId),
        eq(profitFlywheelEvents.companyId, companyId),
      )).orderBy(asc(profitFlywheelEvents.createdAt)),
    ]);
    return profitFlywheelFactoryWorkflowDetailSchema.parse({
      schemaVersion: "paperclip.profit_flywheel_factory_workflow_detail.v1",
      companyId,
      generatedAt: now.toISOString(),
      workflow: {
        id: workflow.id,
        runId: workflow.runId,
        state: workflow.state,
        currentStage: workflow.currentStage,
        targetRepo: workflow.targetRepo,
        correlationId: workflow.correlationId,
        traceId: workflow.traceId,
        sourceSchemaVersion: workflow.sourceSchemaVersion,
        sourceDispatchHash: workflow.sourceDispatchHash,
        contractSha256: workflow.contractSha256,
        blockerCode: stringOrNull(workflow.blockerCode),
        blockerDetail: stringOrNull(workflow.blockerDetail),
        nextOwner: stringOrNull(workflow.nextOwner),
        resumeCondition: stringOrNull(workflow.resumeCondition),
        createdAt: workflow.createdAt.toISOString(),
        updatedAt: workflow.updatedAt.toISOString(),
        completedAt: workflow.completedAt?.toISOString() ?? null,
      },
      stages: stages.map((stage) => ({
        id: stage.id,
        stage: stage.stage,
        state: stage.state,
        ownerPlane: stage.ownerPlane,
        inputSchemaVersion: stage.inputSchemaVersion,
        inputHash: stage.inputHash,
        sourceHashes: stage.sourceHashes,
        idempotencyKey: stage.idempotencyKey,
        attempt: stage.attemptCount,
        maxAttempts: stage.maxAttempts,
        retryAt: stage.retryAt?.toISOString() ?? null,
        issueId: stage.linkedIssueId,
        routeId: stringOrNull(stage.providerRouteId),
        providerFamily: stringOrNull(stage.providerFamily),
        providerModel: stringOrNull(stage.providerModel),
        providerPolicySha256: stringOrNull(stage.providerPolicySha256),
        providerRouteSha256: stringOrNull(stage.providerRouteSha256),
        transitionSourceStageRunId: stage.transitionSourceStageRunId,
        transitionSourceOutputHash: stringOrNull(stage.transitionSourceOutputHash),
        requiredReceipts: stage.requiredReceipts,
        completionEvidence: stage.completionEvidence,
        checkpointSha256: stage.artifactCheckpoint ? hashProfitFlywheelValue(stage.artifactCheckpoint) : null,
        blockerCode: stringOrNull(stage.blockerCode),
        blockerDetail: stringOrNull(stage.blockerDetail),
        nextOwner: stringOrNull(stage.nextOwner),
        resumeCondition: stringOrNull(stage.resumeCondition),
        heartbeatAt: stage.heartbeatAt?.toISOString() ?? null,
        leaseExpiresAt: stage.leaseExpiresAt?.toISOString() ?? null,
        startedAt: stage.startedAt?.toISOString() ?? null,
        completedAt: stage.completedAt?.toISOString() ?? null,
        createdAt: stage.createdAt.toISOString(),
        updatedAt: stage.updatedAt.toISOString(),
      })),
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        stageRunId: receipt.stageRunId,
        type: receipt.receiptType,
        schemaVersion: receipt.schemaVersion,
        contentHash: receipt.contentHash,
        artifactRef: stringOrNull(receipt.artifactRef),
        status: receipt.status,
        observedAt: receipt.observedAt.toISOString(),
        expiresAt: receipt.expiresAt?.toISOString() ?? null,
        createdAt: receipt.createdAt.toISOString(),
      })),
      audit: events.map((event) => ({
        id: event.id,
        stageRunId: event.stageRunId,
        eventType: event.eventType,
        fromState: event.fromState,
        toState: event.toState,
        attempt: event.attemptCount,
        nextAttemptAt: event.nextAttemptAt.toISOString(),
        processedAt: event.processedAt?.toISOString() ?? null,
        lastError: stringOrNull(event.lastError),
        createdAt: event.createdAt.toISOString(),
      })),
    });
  }

  async function build(companyId: string, input: { now?: Date; since?: Date } = {}) {
    const now = input.now ?? new Date();
    const since = input.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [workflows, stages, receipts, events, providerRows, opsReceipt, baseline, loadedPolicy, portfolioOsIdentity] = await Promise.all([
      db.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.companyId, companyId),
        gte(profitFlywheelWorkflows.updatedAt, since),
      )),
      db.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.companyId, companyId),
        gte(profitFlywheelStageRuns.createdAt, since),
      )),
      db.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.companyId, companyId),
        gte(profitFlywheelReceipts.createdAt, since),
      )).orderBy(desc(profitFlywheelReceipts.createdAt)),
      db.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.companyId, companyId),
        gte(profitFlywheelEvents.createdAt, since),
      )).orderBy(desc(profitFlywheelEvents.createdAt)),
      db.select().from(profitFlywheelProviderHealth).where(eq(profitFlywheelProviderHealth.companyId, companyId)).orderBy(desc(profitFlywheelProviderHealth.updatedAt)),
      svc.buildOpsReceipt(companyId, { since, now }),
      readBaseline(options.baselinePointerPath, companyId),
      (options.providerPolicyLoader ?? loadProviderPolicyV2)().catch(() => null),
      managedPortfolioOsIdentity(
        options.portfolioOsRuntimeRoot,
        options.managedPortfolioOsRuntimeResolver ?? resolveManagedPortfolioOsRuntime,
      ),
    ]);
    const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const latestWorkflow = [...workflows].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    const dispatchSucceeded = stages.filter((stage) => stage.stage === "dispatch" && stage.state === "succeeded").length;
    const pipeline = PROFIT_FLYWHEEL_STAGES.map((stage) => {
      const rows = stages.filter((row) => row.stage === stage);
      const counts = Object.fromEntries(PROFIT_FLYWHEEL_RUN_STATES.map((state) => [state, rows.filter((row) => row.state === state).length])) as Record<ProfitFlywheelRunState, number>;
      const succeeded = counts.succeeded;
      return {
        stage,
        counts,
        total: rows.length,
        conversionFromDispatch: dispatchSucceeded > 0 ? Math.min(1, succeeded / dispatchSucceeded) : null,
      };
    });
    const blockers = stages.filter((stage) => stage.state === "blocked").map((stage) => {
      const source = receiptForStage(stage.id, receipts);
      return {
        workflowId: stage.workflowId,
        stageRunId: stage.id,
        inputHash: stage.inputHash,
        issueId: stage.linkedIssueId,
        stage: stage.stage as ProfitFlywheelStage,
        code: stage.blockerCode ?? "unknown_blocker",
        detail: stage.blockerDetail ?? "No blocker detail was persisted",
        nextOwner: stage.nextOwner ?? "factory_operator",
        resumeCondition: stage.resumeCondition ?? "Inspect the linked immutable receipt before resuming",
        retryable: retryableFromStage(stage),
        nextAttemptAt: stage.retryAt?.toISOString() ?? null,
        ageSeconds: Math.max(0, (now.getTime() - stage.updatedAt.getTime()) / 1000),
        receiptPath: source.path,
        receiptId: source.id,
        receiptSha256: source.sha256,
      };
    }).sort((left, right) => right.ageSeconds - left.ageSeconds);
    const activeStates = new Set(["pending", "running", "retry"]);
    const lastEventsByStage = new Map<string, typeof events[number]>();
    for (const event of events) if (event.stageRunId && !lastEventsByStage.has(event.stageRunId)) lastEventsByStage.set(event.stageRunId, event);
    const activeWork = stages.filter((stage) => activeStates.has(stage.state)).map((stage) => {
      const workflow = workflowsById.get(stage.workflowId)!;
      const feedback = asRecord(stage.feedback);
      const usage = asRecord(feedback.usage);
      const budget = asRecord(feedback.budget);
      return {
        workflowId: stage.workflowId,
        stageRunId: stage.id,
        issueId: stage.linkedIssueId,
        targetRepo: workflow?.targetRepo ?? "unknown",
        stage: stage.stage as ProfitFlywheelStage,
        state: stage.state as ProfitFlywheelRunState,
        agentId: stage.leaseActorType === "agent" ? stage.leaseActorId : null,
        routeId: stage.providerRouteId,
        providerFamily: stage.providerFamily,
        elapsedSeconds: Math.max(0, (now.getTime() - (stage.startedAt ?? stage.createdAt).getTime()) / 1000),
        heartbeatAt: stage.heartbeatAt?.toISOString() ?? null,
        leaseExpiresAt: stage.leaseExpiresAt?.toISOString() ?? null,
        attempt: stage.attemptCount,
        maxAttempts: stage.maxAttempts,
        budgetConsumedTokens: finiteOrNull(usage.total_tokens ?? usage.totalTokens),
        budgetLimitTokens: finiteOrNull(budget.token_limit ?? budget.tokenLimit),
        lastUsefulAction: stringOrNull(asRecord(lastEventsByStage.get(stage.id)?.payload).detail) ?? lastEventsByStage.get(stage.id)?.eventType ?? null,
      };
    });

    const activePolicy = loadedPolicy
      ? { sha256: loadedPolicy.sha256, schemaSha256: loadedPolicy.schemaSha256 }
      : null;
    const currentHealth = activePolicy
      ? providerRows.filter((row) => row.policySha256 === activePolicy.sha256 && row.policySchemaSha256 === activePolicy.schemaSha256)
      : [];
    const latestAliasRoutes = new Map<ProfitFlywheelCapabilityAlias, Set<string>>(
      PROFIT_FLYWHEEL_CAPABILITY_ALIASES.map((alias) => [
        alias,
        new Set(loadedPolicy?.policy.aliases[alias].orderedRouteIds ?? []),
      ]),
    );
    const healthByRoute = new Map(currentHealth.map((row) => [row.routeId, row]));
    const freshHealthy = (row: typeof profitFlywheelProviderHealth.$inferSelect | undefined) =>
      Boolean(row && row.status === "healthy" && row.expiresAt > now && (!row.backoffUntil || row.backoffUntil <= now));
    const reviewFamilies = new Set(
      [...(latestAliasRoutes.get("independent_review") ?? [])]
        .map((routeId) => healthByRoute.get(routeId))
        .filter(freshHealthy)
        .map((row) => row!.providerFamily),
    );
    const workFamilies = new Set(
      ["research_fast", "research_deep", "code_fast", "code_deep", "multimodal_qa"]
        .flatMap((alias) => [...(latestAliasRoutes.get(alias as ProfitFlywheelCapabilityAlias) ?? [])])
        .map((routeId) => healthByRoute.get(routeId))
        .filter(freshHealthy)
        .map((row) => row!.providerFamily),
    );
    const providerReadiness = PROFIT_FLYWHEEL_CAPABILITY_ALIASES.map((alias) => {
      const routeIds = [...(latestAliasRoutes.get(alias) ?? [])];
      const rows = routeIds.map((routeId) => healthByRoute.get(routeId));
      const healthyRows = rows.filter(freshHealthy) as Array<typeof profitFlywheelProviderHealth.$inferSelect>;
      const families = new Set(healthyRows.map((row) => row.providerFamily));
      const independentReviewReady = alias === "independent_review"
        ? healthyRows.some((row) => [...workFamilies].some((family) => family !== row.providerFamily))
        : healthyRows.some((row) => [...reviewFamilies].some((family) => family !== row.providerFamily));
      return {
        alias,
        status: routeIds.length === 0 ? "unknown" as const : healthyRows.length === 0 ? "unavailable" as const
          : independentReviewReady || alias === "summarization" || alias === "emergency_free" ? "ready" as const : "degraded" as const,
        eligibleRouteCount: healthyRows.length,
        distinctProviderFamilies: families.size,
        independentReviewReady,
        evidence: loadedPolicy && routeIds.length > 0 ? "policy_and_fresh_canary" as const : "missing" as const,
        routes: routeIds.map((routeId, index) => providerRoute(rows[index], loadedPolicy?.policy.routes[routeId])),
      };
    });
    const healthyHermesBindings = loadedPolicy
      ? Object.values(loadedPolicy.policy.routes).filter((route) =>
          route.runtimeBinding?.adapterType === "hermes_local" &&
          freshHealthy(healthByRoute.get(route.id)) &&
          healthByRoute.get(route.id)?.receiptSchemaVersion === "hermes-completion-canary-receipt.v1")
      : [];
    const hermesClosureHashes = new Set(healthyHermesBindings.map((route) => route.runtimeBinding.runtimeClosureSha256));
    const hermesVersions = new Set(healthyHermesBindings.map((route) => route.runtimeBinding.expectedVersion));
    const hermesIdentity = {
      component: "hermes" as const,
      version: hermesVersions.size === 1 ? [...hermesVersions][0]! : null,
      sha256: hermesClosureHashes.size === 1 ? [...hermesClosureHashes][0]! : null,
      verified: healthyHermesBindings.length > 0 && hermesClosureHashes.size === 1 && hermesVersions.size === 1,
      detail: healthyHermesBindings.length === 0
        ? "No fresh policy-bound Hermes runtime canary is available"
        : hermesClosureHashes.size !== 1 || hermesVersions.size !== 1
          ? "Fresh Hermes routes disagree on runtime closure identity"
          : null,
    };

    const metrics = asRecord(opsReceipt.metrics);
    const baselineResources = asRecord(baseline?.resources);
    const baselineDisk = asRecord(baselineResources.disk);
    const diskAvailableBytes = finiteOrNull(baselineDisk.available_bytes);
    const diskFreePercent = finiteOrNull(baselineDisk.free_percent);
    const diskState = diskAvailableBytes === null || diskFreePercent === null ? "unknown" as const
      : diskAvailableBytes < 25 * GIB ? "hard_stop" as const
      : diskAvailableBytes < 40 * GIB || diskFreePercent < 15 ? "warning" as const
      : "healthy" as const;
    const baselineTokenomics = asRecord(baseline?.tokenomics);
    const tokenomicsGeneratedAt = stringOrNull(baselineTokenomics.generated_at);
    const tokenomicsGeneratedAtMs = tokenomicsGeneratedAt ? Date.parse(tokenomicsGeneratedAt) : Number.NaN;
    const tokenomicsFreshNow = baselineTokenomics.fresh === true && Number.isFinite(tokenomicsGeneratedAtMs) &&
      now.getTime() >= tokenomicsGeneratedAtMs && now.getTime() - tokenomicsGeneratedAtMs <= 10 * 60 * 1000;
    const tokenomicsStatus = !tokenomicsFreshNow ? (tokenomicsGeneratedAt ? "stale" as const : "unknown" as const)
      : baselineTokenomics.status === "pass" ? "healthy" as const : "failed" as const;
    const identities = [
      {
        component: "contract" as const,
        version: latestWorkflow?.sourceSchemaVersion ?? null,
        sha256: latestWorkflow?.contractSha256 ?? null,
        verified: Boolean(latestWorkflow?.contractSha256),
        detail: latestWorkflow?.contractSha256 ? null : "No workflow contract binding is available",
      },
      {
        component: "provider_policy" as const,
        version: null,
        sha256: activePolicy?.sha256 ?? null,
        verified: providerReadiness
          .filter((entry) => !["summarization", "emergency_free"].includes(entry.alias))
          .every((entry) => entry.status === "ready"),
        detail: providerReadiness
          .filter((entry) => !["summarization", "emergency_free"].includes(entry.alias))
          .every((entry) => entry.status === "ready")
          ? null
          : "One or more required capability aliases lacks fresh policy-bound readiness or different-family review capacity",
      },
      baselineIdentity(baseline, "adapter"),
      portfolioOsIdentity,
      hermesIdentity,
    ];
    const maxSnapshotAgeSeconds = options.maxSnapshotAgeSeconds ?? 120;
    const baselineCapturedAt = stringOrNull(baseline?.captured_at);
    const baselineCapturedAtMs = baselineCapturedAt ? Date.parse(baselineCapturedAt) : Number.NaN;
    const freshnessAgeSeconds = Number.isFinite(baselineCapturedAtMs)
      ? Math.max(0, Math.floor((now.getTime() - baselineCapturedAtMs) / 1000))
      : maxSnapshotAgeSeconds + 1;
    const snapshotStale = freshnessAgeSeconds > maxSnapshotAgeSeconds;
    const forcedPause = isPaused() || diskState === "hard_stop";
    const noObservedWork = workflows.length === 0 && stages.length === 0;
    const unavailableRequiredAlias = providerReadiness.some((alias) =>
      !["summarization", "emergency_free"].includes(alias.alias) && alias.status !== "ready");
    const degraded = snapshotStale || tokenomicsStatus !== "healthy" || identities.some((identity) => !identity.verified) ||
      unavailableRequiredAlias || providerReadiness.some((alias) => alias.status === "degraded");
    const state = diskState === "hard_stop" ? "blocked" as const
      : isPaused() ? "paused" as const
      : blockers.length > 0 ? "blocked" as const
      : noObservedWork ? "unknown" as const
      : degraded ? "degraded" as const
      : "healthy" as const;
    const baselineConstraints = asRecord(baseline?.constraints);
    const promotionBlockers = Array.isArray(baselineConstraints.promotion_blockers)
      ? baselineConstraints.promotion_blockers.filter((value): value is string => typeof value === "string")
      : [];
    const approvalGates: ProfitFlywheelFactoryHealth["approvalGates"] = promotionBlockers.map((code) => ({
      code,
      title: code === "disk_below_30_gib" ? "Disk recovery approval required" : "Promotion gate is not satisfied",
      detail: code === "disk_below_30_gib"
        ? "Review the immutable retention dry run before the first destructive cleanup; production promotion remains blocked below 30 GiB."
        : `Resolve ${code.replaceAll("_", " ")} and attach a verified receipt before mode promotion.`,
      action: code === "disk_below_30_gib" ? "retention" as const : "other" as const,
    }));
    if (options.mode === "fixture") approvalGates.push({
      code: "shadow_cycle_requires_approval",
      title: "Real-repository shadow cycle",
      detail: "Select an allowlisted repository other than Glitch-Cipher-Syndicate/LeadForge and approve the isolated non-production shadow boundary.",
      action: "shadow",
    });

    const output = {
      schemaVersion: "paperclip.profit_flywheel_factory_health.v1" as const,
      companyId,
      generatedAt: now.toISOString(),
      state,
      mode: options.mode,
      pauseNewWork: forcedPause,
      freshness: { ageSeconds: freshnessAgeSeconds, maxAgeSeconds: maxSnapshotAgeSeconds, stale: snapshotStale },
      identities,
      pipeline,
      blockers,
      activeWork,
      providerReadiness,
      economics: {
        tokensPerCompletedDeliverable: measuredValue(metrics.tokens_per_completed_deliverable),
        costPerCompletedDeliverableUsd: measuredValue(metrics.cost_per_completed_deliverable_usd),
        artifactBackedPercentage: measuredValue(metrics.artifact_backed_percentage),
        falseSuccessPercentage: measuredValue(metrics.false_success_percentage),
        secondIterationCompletionRate: measuredValue(metrics.second_iteration_completion_rate),
        highBurnEventCount: finiteOrNull(asRecord(metrics.high_burn_events).count),
        tokenomicsStatus,
        tokenomicsGeneratedAt,
      },
      host: {
        diskAvailableBytes,
        diskFreePercent,
        diskState,
        databaseBytes: finiteOrNull(baselineResources.database_bytes),
        logBytes: finiteOrNull(baselineResources.log_bytes),
        archiveBacklogBytes: finiteOrNull(baselineResources.archive_backlog_bytes),
        factoryBrowserProcessCount: finiteOrNull(asRecord(baselineResources.factory_browser_processes).count),
      },
      closeouts: {
        twoIteration: latestReceipt(receipts, ["profit_flywheel_two_iteration_closeout", "two_iteration_closeout"]),
        shadow: latestReceipt(receipts, ["profit_flywheel_shadow_closeout"]),
        production: latestReceipt(receipts, ["profit_flywheel_production_closeout"]),
      },
      approvalGates,
    };
    return profitFlywheelFactoryHealthSchema.parse(output);
  }

  return { build, workflowDetail };
}
