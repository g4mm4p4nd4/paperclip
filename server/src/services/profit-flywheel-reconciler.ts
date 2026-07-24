import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  profitFlywheelEvents,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { canonicalProfitFlywheelReceiptHash, profitFlywheelService } from "./profit-flywheel.js";
import { subscribeProfitFlywheelReconciliation } from "./profit-flywheel-reconcile-signal.js";
import type { FactoryMode } from "../config.js";
import {
  defaultDenyFactoryLaunchAuthority,
  type FactoryLaunchAuthority,
} from "./factory-launch-authority.js";
import {
  runPosConsumerAttempt,
  type PosConsumerAttemptResult,
  type PosConsumerPlane,
  type PosConsumerSecretReference,
} from "./pos-consumer-runner.js";
import { resolveManagedPortfolioOsRuntime } from "./managed-pos-runtime.js";
import { publishActiveProviderPolicyAuthority } from "./provider-policy-authority.js";

const SAFE_OUTPUT_SECRET = /(?:\b(?:bearer|basic)\s+[a-z0-9._~+\-/=]{8,}|(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]{6,}|\bsk-[a-z0-9_-]{16,}|\bghp_[a-z0-9]{20,})/i;

type Plane = "return" | "research" | "portfolio_os_stage_plane";

class ProfitFlywheelCredentialError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicPlane(plane: Plane): PosConsumerPlane {
  return plane === "portfolio_os_stage_plane" ? "stage" : plane;
}

function planeForStage(stage: string): Plane | null {
  if (stage === "commercial_observation" || stage === "learning") return "return";
  if (stage === "research_intake") return "research";
  if (["evidence_normalization", "commercial_validation", "council_decision", "dispatch"].includes(stage)) {
    return "portfolio_os_stage_plane";
  }
  return null;
}

function stagesForPlane(plane: Plane) {
  if (plane === "return") return ["commercial_observation", "learning"];
  if (plane === "research") return ["research_intake"];
  return ["evidence_normalization", "commercial_validation", "council_decision", "dispatch"];
}

function journalCredentialForPlane(plane: Plane) {
  if (plane === "return") return "PAPERCLIP_RETURN_PLANE_JOURNAL_KEY";
  if (plane === "research") return "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY";
  return "PAPERCLIP_STAGE_PLANE_JOURNAL_KEY";
}

function safeError(error: unknown, knownSecrets: string[] = []) {
  const value = error instanceof Error ? error.message : String(error);
  if (SAFE_OUTPUT_SECRET.test(value) || knownSecrets.some((secret) => secret.length >= 8 && value.includes(secret))) {
    return "[REDACTED: secret-like POS executor error rejected]";
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 2000) || "Unspecified POS executor failure";
}

export function createProfitFlywheelReconciler(db: Db, options: {
  reconciliationIntervalMs?: number;
  commandTimeoutMs?: number;
  runtimeRoot?: string;
  runtimeManifestPath?: string;
  attemptReceiptDirectory?: string;
  apiUrl?: string;
  resolveRuntimeSecrets?: (companyId: string, plane: Plane) => Promise<Record<string, string>>;
  /** Legacy test seam. Production always uses runPosConsumerAttempt. */
  runCommand?: (input: { plane: Plane; companyId: string; env: Record<string, string> }) => Promise<void>;
  executeAttempt?: typeof runPosConsumerAttempt;
  resolveManagedRuntime?: typeof resolveManagedPortfolioOsRuntime;
  /** Test seam; production publishes from the active immutable D7 policy. */
  publishProviderPolicyAuthority?: typeof publishActiveProviderPolicyAuthority;
  factoryMode?: FactoryMode;
  factoryPauseNewWork?: boolean | (() => boolean);
  factoryLaunchAuthority?: FactoryLaunchAuthority;
} = {}) {
  const factoryMode = options.factoryMode ?? "fixture";
  const factoryPauseNewWork = () => typeof options.factoryPauseNewWork === "function"
    ? options.factoryPauseNewWork()
    : (options.factoryPauseNewWork ?? true);
  const factoryLaunchAuthority = options.factoryLaunchAuthority ?? defaultDenyFactoryLaunchAuthority;
  const service = profitFlywheelService(db, {
    factoryMode,
    factoryPauseNewWork,
    factoryLaunchAuthority,
  });
  const secrets = secretService(db);
  const intervalMs = Math.max(10_000, options.reconciliationIntervalMs ?? 60_000);
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let inFlight = false;
  let rerunRequested = false;

  const resolveStoredRuntimeSecrets = async (companyId: string, plane: Plane) => {
    const journalName = journalCredentialForPlane(plane);
    const names = ["PAPERCLIP_API_KEY", journalName] as const;
    try {
      const values = await Promise.all(names.map(async (name) => {
        const secret = await secrets.getByName(companyId, name);
        if (!secret) throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
        const value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
        return {
          name,
          value,
          reference: {
            name,
            version: String(secret.latestVersion),
            fingerprint: createHash("sha256").update(value, "utf8").digest("hex"),
          } satisfies PosConsumerSecretReference,
        };
      }));
      const env = Object.fromEntries(values.map((entry) => [entry.name, entry.value])) as Record<string, string>;
      if (Object.values(env).some((value) => value.length < 20) || new Set(Object.values(env)).size !== names.length) {
        throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
      }
      return { env, references: values.map((entry) => entry.reference) };
    } catch (error) {
      if (error instanceof ProfitFlywheelCredentialError) throw error;
      throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
    }
  };

  const resolveRuntimeSecrets = async (companyId: string, plane: Plane) => {
    const journalName = journalCredentialForPlane(plane);
    try {
      const resolved = options.resolveRuntimeSecrets
        ? (() => options.resolveRuntimeSecrets!(companyId, plane).then((env) => ({
          env,
          references: Object.entries(env).map(([name, value]) => ({
            name,
            version: "injected-test-seam",
            fingerprint: createHash("sha256").update(value, "utf8").digest("hex"),
          })),
        })))()
        : await resolveStoredRuntimeSecrets(companyId, plane);
      const { env, references } = await resolved;
      const api = env.PAPERCLIP_API_KEY;
      const journal = env[journalName];
      if (typeof api !== "string" || typeof journal !== "string" || api.length < 20 || journal.length < 20 || api === journal) {
        throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
      }
      return { env, references };
    } catch (error) {
      if (error instanceof ProfitFlywheelCredentialError) throw error;
      throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
    }
  };

  const blockEvents = async (
    events: Array<typeof profitFlywheelEvents.$inferSelect>,
    blocker: { blockerCode: string; blockerDetail: string; nextOwner: string; resumeCondition: string },
    now: Date,
    launcherAttemptCount?: number,
  ) => {
    const failures: string[] = [];
    for (const event of events) {
      try {
        if (!event.stageRunId) continue;
        const detail = await service.getStageRun(event.stageRunId);
        if (!detail) continue;
        if (["pending", "retry"].includes(detail.stageRun.state)) {
          await service.blockPortfolioOsOutboxInfrastructure({
            companyId: event.companyId,
            eventId: event.id,
            blocker,
            launcherAttemptCount,
            now,
          });
        }
      } catch (error) {
        const detail = safeError(error);
        failures.push(event.id);
        logger.error({ eventId: event.id, companyId: event.companyId, error: detail }, "Profit Flywheel outbox blocker item failed without starving later events");
      }
    }
    if (failures.length > 0) {
      throw new Error(`profit_flywheel_outbox_block_partial_failure:${failures.length}`);
    }
    return blocker;
  };

  type ClaimedAttempt = {
    event: typeof profitFlywheelEvents.$inferSelect;
    stage: typeof profitFlywheelStageRuns.$inferSelect;
    workflow: typeof profitFlywheelWorkflows.$inferSelect;
    attemptId: string;
    attempt: number;
    claimNonce: string;
    claimNonceSha256: string;
  };

  const peekOldestAttempt = async (companyId: string, plane: Plane) => {
    const event = await db.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.companyId, companyId),
      eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
      isNull(profitFlywheelEvents.processedAt),
      lte(profitFlywheelEvents.nextAttemptAt, new Date()),
      inArray(sql<string>`${profitFlywheelEvents.payload}->>'stage'`, stagesForPlane(plane)),
    )).orderBy(asc(profitFlywheelEvents.createdAt)).limit(1).then((rows) => rows[0] ?? null);
    if (!event?.stageRunId) return null;
    const [stage, workflow] = await Promise.all([
      db.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, event.stageRunId),
        eq(profitFlywheelStageRuns.companyId, companyId),
      )).then((rows) => rows[0] ?? null),
      db.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, event.workflowId),
        eq(profitFlywheelWorkflows.companyId, companyId),
      )).then((rows) => rows[0] ?? null),
    ]);
    return stage && workflow ? { event, stage, workflow } : null;
  };

  const claimOldestAttempt = async (
    companyId: string,
    plane: Plane,
    expectedEventId: string,
  ): Promise<ClaimedAttempt | null | "already_claimed"> =>
    db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const now = new Date();
      const event = await tx.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.id, expectedEventId),
        eq(profitFlywheelEvents.companyId, companyId),
        eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
        isNull(profitFlywheelEvents.processedAt),
        lte(profitFlywheelEvents.nextAttemptAt, now),
        inArray(sql<string>`${profitFlywheelEvents.payload}->>'stage'`, stagesForPlane(plane)),
      )).orderBy(asc(profitFlywheelEvents.createdAt)).limit(1).for("update", { skipLocked: true })
        .then((rows) => rows[0] ?? null);
      if (!event?.stageRunId) return null;
      const priorClaim = asRecord(asRecord(event.payload).pos_consumer_launcher_claim);
      const priorExpiry = Date.parse(String(priorClaim.expires_at ?? ""));
      if (priorClaim.status === "active" && Number.isFinite(priorExpiry) && priorExpiry > now.getTime()) {
        return "already_claimed" as const;
      }
      const stage = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, event.stageRunId),
        eq(profitFlywheelStageRuns.companyId, companyId),
        eq(profitFlywheelStageRuns.workflowId, event.workflowId),
      )).for("update").then((rows) => rows[0] ?? null);
      const workflow = stage ? await tx.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, event.workflowId),
        eq(profitFlywheelWorkflows.companyId, companyId),
      )).then((rows) => rows[0] ?? null) : null;
      if (!stage || !workflow || stage.ownerPlane !== "portfolio_os" || !["pending", "retry"].includes(stage.state)) {
        return null;
      }
      const attemptId = randomUUID();
      const claimNonce = randomUUID();
      const claimNonceSha256 = createHash("sha256").update(claimNonce, "utf8").digest("hex");
      const attempt = event.attemptCount + 1;
      const payload = {
        ...asRecord(event.payload),
        pos_consumer_launcher_claim: {
          schema_version: "paperclip.pos_consumer_launcher_claim.v1",
          status: "active",
          attempt_id: attemptId,
          attempt,
          claim_nonce_sha256: claimNonceSha256,
          claimed_at: now.toISOString(),
          expires_at: new Date(now.getTime() + Math.max(60_000, (options.commandTimeoutMs ?? 10 * 60_000) + 60_000)).toISOString(),
        },
      };
      await tx.update(profitFlywheelEvents).set({ payload, updatedAt: now }).where(eq(profitFlywheelEvents.id, event.id));
      return { event: { ...event, payload }, stage, workflow, attemptId, attempt, claimNonce, claimNonceSha256 };
    });

  const finishClaimWithoutReceipt = async (claim: ClaimedAttempt, status: string) => {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const event = await tx.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, claim.event.id))
        .for("update").then((rows) => rows[0] ?? null);
      if (!event) return;
      const payload = asRecord(event.payload);
      const active = asRecord(payload.pos_consumer_launcher_claim);
      if (active.attempt_id !== claim.attemptId || active.claim_nonce_sha256 !== claim.claimNonceSha256) return;
      await tx.update(profitFlywheelEvents).set({
        payload: {
          ...payload,
          pos_consumer_launcher_claim: { ...active, status, finalized_at: new Date().toISOString() },
        },
        updatedAt: new Date(),
      }).where(eq(profitFlywheelEvents.id, event.id));
    });
  };

  const finalizeAttemptReceipt = async (claim: ClaimedAttempt, result: PosConsumerAttemptResult) =>
    db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const now = new Date(result.receipt.timing.ended_at);
      const event = await tx.select().from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.id, claim.event.id),
        eq(profitFlywheelEvents.companyId, claim.event.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      const stage = await tx.select().from(profitFlywheelStageRuns).where(and(
        eq(profitFlywheelStageRuns.id, claim.stage.id),
        eq(profitFlywheelStageRuns.companyId, claim.event.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      const workflow = await tx.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, claim.workflow.id),
        eq(profitFlywheelWorkflows.companyId, claim.event.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!event || !stage || !workflow || event.workflowId !== workflow.id || event.stageRunId !== stage.id) {
        throw new Error("pos_consumer_attempt_finalize_binding_mismatch");
      }
      const eventPayload = asRecord(event.payload);
      const active = asRecord(eventPayload.pos_consumer_launcher_claim);
      if (active.status !== "active" || active.attempt_id !== claim.attemptId ||
          active.claim_nonce_sha256 !== claim.claimNonceSha256 || active.attempt !== claim.attempt) {
        throw new Error("pos_consumer_attempt_finalize_fence_lost");
      }
      const receiptLink = {
        schema_version: result.receipt.schema_version,
        attempt_id: claim.attemptId,
        path: result.receiptBinding.path,
        sha256: result.receiptBinding.sha256,
        classification: result.classification.code,
        recorded_at: now.toISOString(),
      };
      const receiptAttributes = {
        artifact_hash: result.receiptBinding.sha256,
        attempt_id: claim.attemptId,
        outbox_event_id: event.id,
        classification: result.receipt.classification,
        process: {
          exit_code: result.receipt.process.exit_code,
          signal: result.receipt.process.signal,
          timed_out: result.receipt.process.timed_out,
          stdout_sha256: result.receipt.process.stdout.sha256,
          stderr_sha256: result.receipt.process.stderr.sha256,
        },
        protocol: result.receipt.protocol,
        runtime: result.receipt.runtime,
        immutable_attempt_receipt: receiptLink,
      };
      const receiptBody = {
        type: "pos_consumer_attempt_receipt",
        schemaVersion: result.receipt.schema_version,
        artifactRef: result.receiptBinding.path,
        observedAt: now.toISOString(),
        expiresAt: null,
        attributes: receiptAttributes,
      };
      const contentHash = canonicalProfitFlywheelReceiptHash(receiptBody);
      await tx.insert(profitFlywheelReceipts).values({
        companyId: event.companyId,
        workflowId: workflow.id,
        stageRunId: stage.id,
        receiptType: receiptBody.type,
        schemaVersion: receiptBody.schemaVersion,
        contentHash,
        artifactRef: receiptBody.artifactRef,
        status: "valid",
        observedAt: now,
        expiresAt: null,
        observedAtRaw: receiptBody.observedAt,
        expiresAtRaw: null,
        attributes: receiptAttributes,
        correlationId: workflow.correlationId,
        traceId: workflow.traceId,
        spanId: stage.spanId,
      }).onConflictDoNothing();
      const finalizedClaim = {
        ...active,
        status: "finalized",
        finalized_at: now.toISOString(),
        attempt_receipt: receiptLink,
      };
      const retryable = event.processedAt === null && result.classification.retryable;
      const exhausted = retryable && claim.attempt >= stage.maxAttempts;
      await tx.update(profitFlywheelEvents).set({
        payload: {
          ...eventPayload,
          pos_consumer_launcher_claim: finalizedClaim,
          pos_consumer_attempt_receipt: receiptLink,
        },
        ...(retryable ? {
          attemptCount: claim.attempt,
          nextAttemptAt: new Date(result.classification.nextAttemptAt ?? now.getTime() + 5_000),
          lastError: result.classification.code,
        } : {}),
        updatedAt: now,
      }).where(eq(profitFlywheelEvents.id, event.id));
      await tx.update(profitFlywheelStageRuns).set({
        feedback: { ...asRecord(stage.feedback), pos_consumer_attempt_receipt: receiptLink },
        updatedAt: now,
      }).where(eq(profitFlywheelStageRuns.id, stage.id));
      await tx.update(profitFlywheelWorkflows).set({
        feedback: { ...asRecord(workflow.feedback), pos_consumer_attempt_receipt: receiptLink },
        updatedAt: now,
      }).where(eq(profitFlywheelWorkflows.id, workflow.id));
      await tx.insert(profitFlywheelEvents).values({
        companyId: event.companyId,
        workflowId: workflow.id,
        stageRunId: stage.id,
        eventType: "pos_consumer_attempt_recorded",
        dedupeKey: `pos-consumer-attempt:${claim.attemptId}`,
        fromState: stage.state,
        toState: stage.state,
        correlationId: workflow.correlationId,
        traceId: workflow.traceId,
        spanId: stage.spanId,
        payload: {
          company_id: event.companyId,
          workflow_id: workflow.id,
          stage_run_id: stage.id,
          outbox_event_id: event.id,
          input_hash: stage.inputHash,
          ...receiptLink,
        },
        processedAt: now,
        nextAttemptAt: now,
      }).onConflictDoNothing();
      return { processed: event.processedAt !== null, exhausted };
    });

  const scheduleLegacyFailure = async (claim: ClaimedAttempt, detail: string) => {
    const now = new Date();
    const current = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, claim.event.id))
      .then((rows) => rows[0] ?? null);
    if (!current || current.processedAt) {
      await finishClaimWithoutReceipt(claim, "source_acknowledged");
      return { status: "executed" as const, companyId: claim.event.companyId, events: 1 };
    }
    if (claim.attempt >= claim.stage.maxAttempts) {
      await finishClaimWithoutReceipt(claim, "retry_exhausted");
      await blockEvents([current], {
        blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
        blockerDetail: `Portfolio OS ${publicPlane(planeForStage(claim.stage.stage) ?? "research")}-plane executor exhausted its bounded attempts without an acknowledged terminal receipt. Final safe launcher failure: ${detail}`.slice(0, 2_000),
        nextOwner: "portfolio_os_runtime_owner",
        resumeCondition: "Repair the final recorded executor failure, verify its immutable crash journal, then explicitly resume the same outbox event and input hash.",
      }, now, claim.attempt);
      return { status: "blocked_retry_exhausted" as const, companyId: current.companyId, events: 1 };
    }
    await db.update(profitFlywheelEvents).set({
      attemptCount: claim.attempt,
      nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 5_000 * 2 ** Math.min(claim.attempt, 10))),
      lastError: detail,
      payload: {
        ...asRecord(current.payload),
        pos_consumer_launcher_claim: {
          ...asRecord(asRecord(current.payload).pos_consumer_launcher_claim),
          status: "retry_scheduled",
          finalized_at: now.toISOString(),
        },
      },
      updatedAt: now,
    }).where(and(eq(profitFlywheelEvents.id, current.id), isNull(profitFlywheelEvents.processedAt)));
    return { status: "retry_scheduled" as const, companyId: current.companyId, events: 1 };
  };

  const runPlane = async (companyId: string, plane: Plane) => {
    if (factoryPauseNewWork()) {
      return { status: "admission_paused" as const, companyId, plane, events: 0 };
    }
    const preview = await peekOldestAttempt(companyId, plane);
    if (!preview) return { status: "empty" as const, companyId, plane };
    const authority = await factoryLaunchAuthority.claim({
      kind: "pos_consumer_launch",
      mode: factoryMode,
      pauseNewWork: factoryPauseNewWork(),
      companyId,
      targetRepo: preview.workflow.targetRepo,
      workflowId: preview.workflow.id,
      runId: preview.workflow.runId,
      inputHash: preview.stage.inputHash,
      stage: preview.stage.stage,
      transitionContext: asRecord(preview.stage.feedback),
    });
    if (!authority.allowed) {
      if (authority.terminal) {
        await blockEvents([preview.event], {
          blockerCode: authority.code,
          blockerDetail: authority.detail,
          nextOwner: "paperclip_factory_authority_owner",
          resumeCondition: "Satisfy the exact configured factory-mode authority and explicitly resume this unchanged event.",
        }, new Date());
        return { status: "blocked_factory_authority" as const, companyId, plane, events: 1, error: authority.code };
      }
      return { status: "admission_denied" as const, companyId, plane, events: 0, error: authority.code };
    }
    const claim = await claimOldestAttempt(companyId, plane, preview.event.id);
    if (claim === "already_claimed") return { status: "already_claimed" as const, companyId, plane };
    if (!claim) return { status: "empty" as const, companyId, plane };
    let resolved: { env: Record<string, string>; references: PosConsumerSecretReference[] } | null = null;
    let credentialError: ProfitFlywheelCredentialError | null = null;
    try {
      resolved = await resolveRuntimeSecrets(companyId, plane);
    } catch (error) {
      credentialError = error instanceof ProfitFlywheelCredentialError
        ? error : new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
    }
    if (options.runCommand) {
      if (credentialError || !resolved) {
        await finishClaimWithoutReceipt(claim, "blocked_credentials");
        await blockEvents([claim.event], {
          blockerCode: "profit_flywheel_runtime_credentials_unavailable",
          blockerDetail: "Required encrypted Portfolio OS runtime credentials are missing, revoked, invalid, or reused.",
          nextOwner: "paperclip_security_owner",
          resumeCondition: "Provision or rotate the dedicated company API and selected-plane journal credentials, then explicitly resume this exact outbox event and input hash.",
        }, new Date());
        return { status: "blocked_credentials" as const, companyId, plane, events: 1 };
      }
      try {
        await options.runCommand({ plane, companyId, env: resolved.env });
        const current = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, claim.event.id))
          .then((rows) => rows[0] ?? null);
        if (!current?.processedAt) throw new Error("profit_flywheel_pos_executor_exit_without_progress");
        await finishClaimWithoutReceipt(claim, "source_acknowledged");
        return { status: "executed" as const, companyId, plane, events: 1 };
      } catch (error) {
        const detail = safeError(error, Object.values(resolved.env));
        const scheduled = await scheduleLegacyFailure(claim, detail);
        logger.error({ companyId, plane, error: detail }, "Profit Flywheel POS test-seam execution failed");
        return { ...scheduled, plane, error: detail };
      }
    }
    if ((!options.runtimeRoot && !options.runtimeManifestPath) || !options.attemptReceiptDirectory) {
      await finishClaimWithoutReceipt(claim, "blocked_runtime_configuration");
      await blockEvents([claim.event], {
        blockerCode: "profit_flywheel_pos_runtime_manifest_unconfigured",
        blockerDetail: "factoryRuntime.portfolioOsRuntimeRoot and the immutable POS attempt receipt directory are required before managed POS execution.",
        nextOwner: "paperclip_runtime_owner",
        resumeCondition: "Configure a verified managed Portfolio OS runtime root in config.json, restart Paperclip, then explicitly resume this exact outbox event.",
      }, new Date());
      return { status: "blocked_runtime_configuration" as const, companyId, plane, events: 1 };
    }
    const workflowFeedback = asRecord(claim.workflow.feedback);
    const providerPolicy = asRecord(workflowFeedback.provider_policy);
    const providerPolicySha256 = typeof claim.stage.providerPolicySha256 === "string"
      ? claim.stage.providerPolicySha256
      : typeof providerPolicy.sha256 === "string" ? providerPolicy.sha256 : null;
    let result: PosConsumerAttemptResult;
    try {
      // Publish before resolving the D6 package so a package built from the
      // deterministic descriptor binding can be validated on its first
      // launch. The resolver below still requires the package/manifest to
      // bind this exact immutable artifact before any child can start.
      const providerPolicyAuthority = options.runtimeRoot
        ? await (options.publishProviderPolicyAuthority ?? publishActiveProviderPolicyAuthority)()
        : null;
      const managedRuntime = options.runtimeRoot
        ? await (options.resolveManagedRuntime ?? resolveManagedPortfolioOsRuntime)({ runtimeRoot: options.runtimeRoot })
        : null;
      if (managedRuntime && (
        providerPolicyAuthority!.path !== managedRuntime.providerPolicyAuthority.path ||
        providerPolicyAuthority!.sha256 !== managedRuntime.providerPolicyAuthority.sha256
      )) {
        throw new Error("profit_flywheel_provider_policy_binding_mismatch");
      }
      const runtimeManifestPath = managedRuntime?.command.runtimeManifestPath ?? options.runtimeManifestPath!;
      const artifactRoot = managedRuntime
        ? path.join(managedRuntime.writableRoots.output, "paperclip-consumer")
        : undefined;
      result = await (options.executeAttempt ?? runPosConsumerAttempt)({
        attemptId: claim.attemptId,
        plane: publicPlane(plane),
        companyId,
        event: {
          eventId: claim.event.id,
          workflowId: claim.workflow.id,
          stageRunId: claim.stage.id,
          stage: claim.stage.stage,
          inputHash: claim.stage.inputHash,
          attempt: claim.attempt,
          idempotencyKey: claim.stage.idempotencyKey,
          claimNonceSha256: claim.claimNonceSha256,
        },
        runtimeManifestPath,
        providerPolicyAuthorityPath: providerPolicyAuthority?.path ?? "",
        artifactRoot,
        receiptDirectory: options.attemptReceiptDirectory,
        contractSha256: claim.workflow.contractSha256,
        providerPolicySha256,
        apiUrl: options.apiUrl ?? process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
        environment: resolved?.env ?? {},
        secretReferences: resolved?.references ?? [],
        timeoutMs: options.commandTimeoutMs,
        ...(credentialError ? {
          prelaunchFailure: {
            code: "pos_consumer_credential_unavailable" as const,
            detail: "Required encrypted Portfolio OS runtime credentials are unavailable.",
            nextOwner: "paperclip_security_owner",
            resumeCondition: "Provision or rotate the dedicated company API and selected-plane journal credentials before resuming this event.",
          },
        } : {}),
      });
    } catch (error) {
      const detail = safeError(error, Object.values(resolved?.env ?? {}));
      const runtimeProvenanceFailure = detail.startsWith("managed_pos_runtime_");
      const providerPolicyFailure = detail.startsWith("profit_flywheel_provider_policy_binding_");
      await finishClaimWithoutReceipt(claim, providerPolicyFailure
        ? "blocked_provider_policy_binding_mismatch"
        : runtimeProvenanceFailure
          ? "blocked_runtime_provenance_mismatch"
          : "blocked_attempt_evidence_unavailable");
      await blockEvents([claim.event], {
        blockerCode: providerPolicyFailure
          ? "profit_flywheel_provider_policy_binding_mismatch"
          : runtimeProvenanceFailure
          ? "profit_flywheel_pos_runtime_provenance_mismatch"
          : "profit_flywheel_pos_attempt_evidence_unavailable",
        blockerDetail: providerPolicyFailure
          ? `The active Paperclip provider-policy authority descriptor does not exactly match the managed POS runtime binding. Safe failure: ${detail}`.slice(0, 2_000)
          : runtimeProvenanceFailure
          ? `The managed POS selector, pointer set, or content-addressed closure failed verification before launch. Safe failure: ${detail}`.slice(0, 2_000)
          : `The managed POS runner could not durably record a truthful immutable attempt receipt; the subprocess outcome is intentionally not inferred. Safe failure: ${detail}`.slice(0, 2_000),
        nextOwner: "paperclip_runtime_owner",
        resumeCondition: providerPolicyFailure
          ? "Publish the active immutable Paperclip provider-policy descriptor, rebuild or roll back the POS runtime binding to that exact descriptor, then explicitly resume this exact event."
          : runtimeProvenanceFailure
          ? "Repair or atomically roll back the managed runtime pointer to a verified closure, then explicitly resume this exact event."
          : "Repair the verified runtime manifest or immutable attempt-receipt store, reconcile any POS-side claim evidence, then explicitly resume this exact event.",
      }, new Date());
      logger.error({ companyId, plane, error: detail }, providerPolicyFailure
        ? "Profit Flywheel provider-policy authority mismatch"
        : runtimeProvenanceFailure
        ? "Profit Flywheel managed POS runtime provenance mismatch"
        : "Profit Flywheel POS attempt evidence unavailable");
      return {
        status: providerPolicyFailure ? "blocked_provider_policy" as const
          : runtimeProvenanceFailure ? "blocked_runtime_provenance" as const : "blocked_attempt_evidence" as const,
        companyId,
        plane,
        events: 1,
        error: detail,
      };
    }
    const finalized = await finalizeAttemptReceipt(claim, result);
    const current = await db.select().from(profitFlywheelEvents).where(eq(profitFlywheelEvents.id, claim.event.id))
      .then((rows) => rows[0] ?? null);
    if (current?.processedAt) {
      return { status: "executed" as const, companyId, plane, events: 1, attemptReceipt: result.receiptBinding };
    }
    if (result.classification.retryable && !finalized.exhausted) {
      return { status: "retry_scheduled" as const, companyId, plane, events: 1, error: result.classification.code, attemptReceipt: result.receiptBinding };
    }
    const exhausted = finalized.exhausted;
    const blockerCode = exhausted ? "profit_flywheel_pos_executor_retry_exhausted" : result.classification.code;
    await blockEvents([current ?? claim.event], {
      blockerCode,
      blockerDetail: `${result.classification.code}: ${result.classification.resumeCondition} Attempt receipt: ${result.receiptBinding.path}#${result.receiptBinding.sha256}`.slice(0, 2_000),
      nextOwner: result.classification.nextOwner,
      resumeCondition: result.classification.resumeCondition,
    }, new Date(), exhausted ? claim.attempt : undefined);
    return {
      status: exhausted ? "blocked_retry_exhausted" as const
        : result.classification.code === "pos_consumer_credential_unavailable" ? "blocked_credentials" as const
          : "blocked_consumer" as const,
      companyId, plane, events: 1, error: result.classification.code, attemptReceipt: result.receiptBinding,
    };
  };

  const dispatchAuthorizedPaperclipStages = async () => {
    if (factoryPauseNewWork()) return [];
    return service.dispatchPendingStages({ limit: 100, now: new Date() });
  };

  const tickOnce = async () => {
    const phaseFailures: Array<{ phase: string; error: string }> = [];
    const isolatedPhase = async <T>(phase: string, fallback: T, run: () => Promise<T>) => {
      try {
        return await run();
      } catch (error) {
        const detail = safeError(error);
        phaseFailures.push({ phase, error: detail });
        logger.error({ phase, error: detail }, "Profit Flywheel reconciliation phase failed without starving later phases");
        return fallback;
      }
    };
    const recoveredLedgerSync = await isolatedPhase("context_ledger_sync", [], () =>
      service.reconcilePendingContextLedgerSync({ limit: 100 }));
    const repairedOrphans = await isolatedPhase("orphan_recovery", [], () =>
      service.recoverOrphans({ limit: 100 }));
    const recoveredProviderStages = await isolatedPhase("provider_blocked_stage_recovery", [], () =>
      service.recoverProviderBlockedStages({ limit: 100 }));
    const processedEvents = await isolatedPhase("completion_event_processing", [], () =>
      service.processPendingEvents({ limit: 100 }));
    const dispatchedStages = await isolatedPhase("paperclip_stage_dispatch", [], dispatchAuthorizedPaperclipStages);
    const now = new Date();
    const due = await isolatedPhase("portfolio_os_outbox_discovery", [], () => db.select({
        companyId: profitFlywheelEvents.companyId,
        stage: sql<string>`${profitFlywheelEvents.payload}->>'stage'`,
      }).from(profitFlywheelEvents).where(and(
        eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
        isNull(profitFlywheelEvents.processedAt),
        lte(profitFlywheelEvents.nextAttemptAt, now),
      )).orderBy(asc(profitFlywheelEvents.createdAt)).limit(500));
    const pairs = new Map<string, { companyId: string; plane: Plane }>();
    for (const row of due) {
      const plane = planeForStage(row.stage);
      if (plane) pairs.set(`${row.companyId}:${plane}`, { companyId: row.companyId, plane });
    }
    const outbox = [];
    for (const pair of pairs.values()) {
      const result = await isolatedPhase(`portfolio_os_${pair.plane}:${pair.companyId}`, null, () =>
        runPlane(pair.companyId, pair.plane));
      if (result) outbox.push(result);
    }
    return {
      repairedOrphans: repairedOrphans.length,
      recoveredProviderStages: recoveredProviderStages.length,
      recoveredLedgerSync: recoveredLedgerSync.length,
      processedEvents: processedEvents.length,
      dispatchedStages: dispatchedStages.length,
      outbox,
      phaseFailures,
    };
  };

  const requestRun = () => {
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    void tickOnce().catch((error) => {
      logger.error({ error: safeError(error) }, "Profit Flywheel reconciliation failed");
    }).finally(() => {
      inFlight = false;
      if (rerunRequested) {
        rerunRequested = false;
        queueMicrotask(requestRun);
      }
    });
  };

  return {
    start() {
      if (timer) return;
      unsubscribe = subscribeProfitFlywheelReconciliation(requestRun);
      requestRun();
      // This interval is crash reconciliation only. Completion signals above
      // are the normal, low-latency execution trigger.
      timer = setInterval(requestRun, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    tickOnce,
  };
}
