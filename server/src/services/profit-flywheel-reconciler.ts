import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { profitFlywheelEvents, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { profitFlywheelService } from "./profit-flywheel.js";
import { subscribeProfitFlywheelReconciliation } from "./profit-flywheel-reconcile-signal.js";

const execFile = promisify(execFileCallback);
const POS_ROOT = "/Users/mnm/Documents/Github/portfolio-os";
const POS_BIN = path.join(POS_ROOT, "bin", "pos");
const SAFE_OUTPUT_SECRET = /(?:\b(?:bearer|basic)\s+[a-z0-9._~+\-/=]{8,}|(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]{6,}|\bsk-[a-z0-9_-]{16,}|\bghp_[a-z0-9]{20,})/i;

type Plane = "return" | "research" | "portfolio_os_stage_plane";

class ProfitFlywheelCredentialError extends Error {}

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
  resolveRuntimeSecrets?: (companyId: string, plane: Plane) => Promise<Record<string, string>>;
  runCommand?: (input: { plane: Plane; companyId: string; env: Record<string, string> }) => Promise<void>;
} = {}) {
  const service = profitFlywheelService(db);
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
        return [name, await secrets.resolveSecretValue(companyId, secret.id, "latest")] as const;
      }));
      const env = Object.fromEntries(values) as Record<string, string>;
      if (Object.values(env).some((value) => value.length < 20) || new Set(Object.values(env)).size !== names.length) {
        throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
      }
      return env;
    } catch (error) {
      if (error instanceof ProfitFlywheelCredentialError) throw error;
      throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
    }
  };

  const resolveRuntimeSecrets = async (companyId: string, plane: Plane) => {
    const journalName = journalCredentialForPlane(plane);
    try {
      const env = options.resolveRuntimeSecrets
        ? await options.resolveRuntimeSecrets(companyId, plane)
        : await resolveStoredRuntimeSecrets(companyId, plane);
      const api = env.PAPERCLIP_API_KEY;
      const journal = env[journalName];
      if (typeof api !== "string" || typeof journal !== "string" || api.length < 20 || journal.length < 20 || api === journal) {
        throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
      }
      return env;
    } catch (error) {
      if (error instanceof ProfitFlywheelCredentialError) throw error;
      throw new ProfitFlywheelCredentialError("profit_flywheel_runtime_credentials_unavailable");
    }
  };

  const blockEvents = async (
    events: Array<typeof profitFlywheelEvents.$inferSelect>,
    blocker: { blockerCode: string; blockerDetail: string; nextOwner: string; resumeCondition: string },
    now: Date,
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

  const defaultRunCommand = async (input: { plane: Plane; companyId: string; env: Record<string, string> }) => {
    const command = input.plane === "return"
      ? "paperclip-return-plane"
      : input.plane === "research" ? "paperclip-research-plane" : "paperclip-stage-plane";
    const journalName = journalCredentialForPlane(input.plane);
    const commandArgs = input.plane === "portfolio_os_stage_plane"
      ? [command, "--company-id", input.companyId]
      : [command, "--company-id", input.companyId, "--limit", "100"];
    const { stdout, stderr } = await execFile(POS_BIN, commandArgs, {
      cwd: POS_ROOT,
      timeout: options.commandTimeoutMs ?? 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
        PAPERCLIP_API_KEY: input.env.PAPERCLIP_API_KEY!,
        [journalName]: input.env[journalName]!,
      },
    });
    if (SAFE_OUTPUT_SECRET.test(stdout) || SAFE_OUTPUT_SECRET.test(stderr)) {
      throw new Error("profit_flywheel_pos_executor_secret_like_output");
    }
  };

  const runPlane = async (companyId: string, plane: Plane) => db.transaction(async (tx) => {
    const lockKey = `profit-flywheel-pos:${companyId}:${plane}`;
    const lock = await tx.select({
      acquired: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    }).from(profitFlywheelEvents)
      .where(eq(profitFlywheelEvents.companyId, companyId))
      .limit(1)
      .then((rows) => rows[0]?.acquired === true);
    if (!lock) return { status: "already_claimed" as const, companyId, plane };
    const stages = stagesForPlane(plane);
    const now = new Date();
    const due = await tx.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.companyId, companyId),
      eq(profitFlywheelEvents.eventType, "portfolio_os_stage_requested"),
      isNull(profitFlywheelEvents.processedAt),
      lte(profitFlywheelEvents.nextAttemptAt, now),
      inArray(sql<string>`${profitFlywheelEvents.payload}->>'stage'`, stages),
    )).orderBy(asc(profitFlywheelEvents.createdAt)).limit(100);
    if (due.length === 0) return { status: "empty" as const, companyId, plane };
    let resolvedSecretValues: string[] = [];
    try {
      const env = await resolveRuntimeSecrets(companyId, plane);
      resolvedSecretValues = Object.values(env);
      await (options.runCommand ?? defaultRunCommand)({ plane, companyId, env });
      const stillDue = await tx.select({ id: profitFlywheelEvents.id }).from(profitFlywheelEvents).where(and(
        inArray(profitFlywheelEvents.id, due.map((event) => event.id)),
        isNull(profitFlywheelEvents.processedAt),
        lte(profitFlywheelEvents.nextAttemptAt, new Date()),
      ));
      if (stillDue.length > 0) throw new Error("profit_flywheel_pos_executor_exit_without_progress");
      // A successful consumer invocation breaks the consecutive launcher-failure
      // streak. Execution attempts are tracked only on the stage plus claim nonce.
      await tx.update(profitFlywheelEvents).set({ attemptCount: 0, lastError: null, updatedAt: new Date() }).where(and(
        inArray(profitFlywheelEvents.id, due.map((event) => event.id)),
        isNull(profitFlywheelEvents.processedAt),
      ));
      return { status: "executed" as const, companyId, plane, events: due.length };
    } catch (error) {
      const failureNow = new Date();
      const detail = safeError(error, resolvedSecretValues);
      // The child may have durably acknowledged a prefix of the batch before it
      // failed. Re-read current state and retry/block only events that remain due.
      const remainingIds = await tx.select({ id: profitFlywheelEvents.id }).from(profitFlywheelEvents).where(and(
        inArray(profitFlywheelEvents.id, due.map((event) => event.id)),
        isNull(profitFlywheelEvents.processedAt),
        lte(profitFlywheelEvents.nextAttemptAt, failureNow),
      ));
      const remainingIdSet = new Set(remainingIds.map((row) => row.id));
      const remainingDue = due.filter((event) => remainingIdSet.has(event.id));
      if (remainingDue.length === 0) {
        return { status: "executed" as const, companyId, plane, events: due.length };
      }
      if (error instanceof ProfitFlywheelCredentialError) {
        await blockEvents(remainingDue, {
          blockerCode: "profit_flywheel_runtime_credentials_unavailable",
          blockerDetail: "Required encrypted Portfolio OS runtime credentials are missing, revoked, invalid, or reused.",
          nextOwner: "paperclip_security_owner",
          resumeCondition: "Provision or rotate the dedicated company API and selected-plane journal credentials, then explicitly resume this exact outbox event and input hash.",
        }, failureNow);
        logger.error({ companyId, plane, eventCount: remainingDue.length, error: "profit_flywheel_runtime_credentials_unavailable" }, "Profit Flywheel POS credentials blocked");
        return { status: "blocked_credentials" as const, companyId, plane, events: remainingDue.length };
      }
      // A plane command is a batch launcher, not proof that every due event was
      // attempted. Charge only the oldest still-due event. This lets a poison
      // head consume its own bounded budget without exhausting healthy siblings
      // that the child may never have reached.
      const attemptedDue = remainingDue.slice(0, 1);
      const exhausted = [];
      for (const event of attemptedDue) {
        const consecutiveLaunchFailures = event.attemptCount + 1;
        const stage = event.stageRunId ? await service.getStageRun(event.stageRunId) : null;
        if (stage && consecutiveLaunchFailures >= stage.stageRun.maxAttempts) {
          exhausted.push(event);
          continue;
        }
        const backoffSeconds = Math.min(3600, 5 * 2 ** Math.min(consecutiveLaunchFailures, 10));
        await tx.update(profitFlywheelEvents).set({
          attemptCount: consecutiveLaunchFailures,
          nextAttemptAt: new Date(failureNow.getTime() + backoffSeconds * 1000),
          lastError: detail,
          updatedAt: failureNow,
        }).where(and(
          eq(profitFlywheelEvents.id, event.id),
          isNull(profitFlywheelEvents.processedAt),
          eq(profitFlywheelEvents.attemptCount, event.attemptCount),
        ));
      }
      if (exhausted.length > 0) {
        await blockEvents(exhausted, {
          blockerCode: "profit_flywheel_pos_executor_retry_exhausted",
          blockerDetail: `Portfolio OS ${plane}-plane executor exhausted its bounded attempts without an acknowledged terminal receipt.`,
          nextOwner: "portfolio_os_runtime_owner",
          resumeCondition: "Repair the deterministic executor failure, verify its immutable crash journal, then explicitly resume the same outbox event and input hash.",
        }, failureNow);
      }
      logger.error({ companyId, plane, eventCount: remainingDue.length, error: detail }, "Profit Flywheel POS outbox execution failed");
      return {
        status: exhausted.length === attemptedDue.length ? "blocked_retry_exhausted" as const : "retry_scheduled" as const,
        companyId,
        plane,
        events: attemptedDue.length,
        exhausted: exhausted.length,
        error: detail,
      };
    }
  });

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
    const dispatchedStages = await isolatedPhase("paperclip_stage_dispatch", [], () =>
      service.dispatchPendingStages({ limit: 100 }));
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
