import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  companySecrets,
  executionWorkspaces,
  issueComments,
  goals,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RoutineVariable,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import {
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import { parseCron, validateCron } from "./cron.js";
import { evaluateProviderReliabilityPreflight, heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import {
  resolveAgentTieredExecutionRouting,
  type TieredExecutionAdapterType,
  type TieredExecutionLane,
} from "./agent-model-routing.js";
import {
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
  isDeploymentSecretSatisfiedByRuntime,
  normalizeDeploymentRequiredSecretNames,
} from "./deployment-target-policy.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"];
const UNATTENDED_ROUTINE_SOURCES = new Set(["schedule", "api", "webhook"]);
const ROUTINE_ACTIONABILITY_METADATA_KEYS = ["paperclipActionability", "paperclip_actionability"];
const ROUTINE_ACTIONABILITY_PREFLIGHT_KEY = "paperclipActionabilityPreflight";
const PORTFOLIO_DISPATCH_CONTRACT_RE = /## Portfolio Dispatch Contract\s*```json\s*([\s\S]*?)```/i;
const DISPATCH_POLLER_RUNBOOK_COMMAND = "node scripts/process-runbooks/dispatch-poller-runner.mjs";
const EVIDENCE_BACKFILL_RUNBOOK_COMMAND = "node scripts/process-runbooks/evidence-backfill-runner.mjs";
const RELEASE_GATE_RUNBOOK_COMMAND = "node scripts/process-runbooks/release-gate-runner.mjs";
const RUN_QA_SWEEP_RUNBOOK_COMMAND = "node scripts/process-runbooks/run-qa-sweep-runner.mjs";
const SKILL_INVENTORY_RUNBOOK_COMMAND = "node scripts/process-runbooks/skill-inventory-runner.mjs";
const SCHEDULE_IDENTITY_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function scheduledDispatchIdentity(trigger: typeof routineTriggers.$inferSelect) {
  const identity = trigger.scheduleIdentity;
  if (identity == null) return null;
  if (
    typeof identity !== "object" ||
    !SCHEDULE_IDENTITY_VALUE_RE.test(identity.portfolioRunId) ||
    identity.portfolioRunId.length > 200 ||
    !SCHEDULE_IDENTITY_VALUE_RE.test(identity.stage) ||
    identity.stage.length > 120 ||
    !SHA256_RE.test(identity.inputHash)
  ) {
    throw unprocessable("Scheduled trigger identity is invalid");
  }
  const logicalKey = {
    company_id: trigger.companyId,
    portfolio_run_id: identity.portfolioRunId,
    stage: identity.stage,
    input_hash: identity.inputHash,
  };
  const idempotencyKey = `schedule.v1.${crypto
    .createHash("sha256")
    .update(JSON.stringify(logicalKey), "utf8")
    .digest("hex")}`;
  return {
    idempotencyKey,
    payload: {
      schedule_identity: {
        schema_version: "paperclip.routine_schedule_identity.v1",
        ...logicalKey,
        idempotency_key: idempotencyKey,
      },
    },
  };
}
const PROVIDER_BACKOFF_LOOKBACK_MS = 30 * 60 * 1000;
const DUPLICATE_LOOP_SUPPRESSION_THRESHOLD = 3;
const STALE_UNATTENDED_IDLE_ROUTINE_ISSUE_MS = 24 * 60 * 60 * 1000;
const SYSTEM_SELF_HEAL_RESCHEDULE_CAP = 3;
const SYSTEM_SELF_HEAL_RESCHEDULE_WINDOW_MS = 60 * 60 * 1000;
const SYSTEM_SELF_HEAL_BLOCK_REASONS = new Set([
  "maintenance_lane_cadence",
  "upstream_artifact_unchanged",
]);
const MAINTENANCE_LANE_DEFAULT_MIN_INTERVAL_MINUTES = 360;
const FACTORY_GUARD_ORIGIN_KIND = "factory_guard";
const AGENT_ACTIONABLE_STATES = new Set([
  "agent_actionable",
  "ready_for_agent",
  "ready_for_qa",
  "ready_to_ship",
  "maintenance_due",
]);
const HUMAN_OWNED_BLOCKER_OWNERS = new Set(["board", "ceo", "human", "operator", "user"]);
const EXECUTION_LANES_REQUIRING_CLEAN_WORKSPACE = new Set(["qa", "release", "deploy", "ship", "outreach"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const RUN_SCOPED_ROUTINE_TITLE_PREFIX = /^\[run_id:[^\]]+\]\s*/i;
const execFileAsync = promisify(execFile);
const ROUTINE_PROVIDER_PREFLIGHT_AVAILABLE_ADAPTERS = {
  hermes_local: true,
  opencode_local: true,
  codex_local: true,
  claude_local: true,
  gemini_local: true,
} satisfies Partial<Record<TieredExecutionAdapterType, boolean>>;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type Actor = { agentId?: string | null; userId?: string | null };
type RoutineRunSource = "schedule" | "manual" | "api" | "webhook";
type RoutineActionabilityBlock = {
  reason: string;
  status: "skipped";
  state: string;
  blockerClass: string;
  blockerOwner: string;
  fingerprint: string;
  message: string;
  details?: Record<string, unknown>;
  standingIssue?: {
    originId: string;
    title: string;
    description: string;
    priority?: "critical" | "high" | "medium" | "low";
  };
  freezeRoutine?: boolean;
};
type RoutineActionabilityContract = {
  state: string | null;
  blockerOwner: string | null;
  nextActionOwner: string | null;
  blockerClass: string | null;
  lane: string | null;
  shipCaptain: boolean;
  requiredSecretNames: string[];
  upstreamArtifactHash: string | null;
  requireUpstreamChange: boolean;
  requireCleanWorkspace: boolean;
  workspaceCwd: string | null;
  allowDirtyPathPrefixes: string[];
  minIntervalMinutes: number | null;
  deterministicAdapterType: string | null;
  deterministicAdapterConfig: Record<string, unknown> | null;
  providerPolicyExcludedFamilies: string[];
  deploymentTarget: Record<string, unknown> | null;
  raw: Record<string, unknown>;
};
type ProviderReliabilityPreflightFn = typeof evaluateProviderReliabilityPreflight;

function isSystemSelfHealingBlock(
  block: RoutineActionabilityBlock,
) {
  return block.blockerOwner === "system" && SYSTEM_SELF_HEAL_BLOCK_REASONS.has(block.reason);
}

function dateFromUnknown(value: unknown) {
  const text = nonEmptyString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function systemSelfHealRescheduleDecision(input: {
  block: RoutineActionabilityBlock;
  duplicateCount: number;
  trigger: typeof routineTriggers.$inferSelect | null;
  triggeredAt: Date;
  naturalNextRunAt?: Date | null;
}) {
  if (!isSystemSelfHealingBlock(input.block)) return null;
  const withinWindowCutoff = new Date(input.triggeredAt.getTime() + SYSTEM_SELF_HEAL_RESCHEDULE_WINDOW_MS);
  const naturalNextRunAt = input.naturalNextRunAt ?? null;
  const base = {
    kind: "system_blocker_reschedule",
    blockerOwner: input.block.blockerOwner,
    reason: input.block.reason,
    fingerprint: input.block.fingerprint,
    duplicateCount: input.duplicateCount,
    rescheduleCap: SYSTEM_SELF_HEAL_RESCHEDULE_CAP,
    windowMinutes: SYSTEM_SELF_HEAL_RESCHEDULE_WINDOW_MS / 60_000,
    naturalNextRunAt: naturalNextRunAt?.toISOString() ?? null,
  };

  if (input.duplicateCount > SYSTEM_SELF_HEAL_RESCHEDULE_CAP) {
    return {
      ...base,
      status: "exhausted",
      rescheduled: false,
      nextRunAt: null as Date | null,
      message: "Self-heal reschedule cap reached; routine remains active for the next natural run.",
    };
  }

  if (input.trigger?.kind !== "schedule") {
    return {
      ...base,
      status: "not_rescheduled",
      rescheduled: false,
      nextRunAt: null as Date | null,
      message: "Self-heal reschedule applies only to scheduled routine triggers.",
    };
  }

  if (naturalNextRunAt && naturalNextRunAt.getTime() <= withinWindowCutoff.getTime()) {
    return {
      ...base,
      status: "not_rescheduled",
      rescheduled: false,
      nextRunAt: null as Date | null,
      message: "Natural next run is already within the self-heal window.",
    };
  }

  let target = withinWindowCutoff;
  if (input.block.reason === "maintenance_lane_cadence") {
    const previousRunCreatedAt = dateFromUnknown(input.block.details?.previousRunCreatedAt);
    const minIntervalMinutes = readPositiveNumber(input.block.details?.minIntervalMinutes);
    if (previousRunCreatedAt && minIntervalMinutes) {
      const cadenceDueAt = new Date(previousRunCreatedAt.getTime() + minIntervalMinutes * 60_000);
      if (cadenceDueAt.getTime() > input.triggeredAt.getTime()) {
        target = cadenceDueAt.getTime() <= withinWindowCutoff.getTime() ? cadenceDueAt : withinWindowCutoff;
      } else {
        target = new Date(input.triggeredAt.getTime() + 60_000);
      }
    }
  }

  return {
    ...base,
    status: "rescheduled",
    rescheduled: true,
    nextRunAt: target,
    message: "System-owned blocker self-healed by moving the next scheduled run into the recovery window.",
  };
}

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

export function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing execution issue";
  if (status === "skipped") return "Skipped because an execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

function routineFamilyTitle(title: string) {
  return title.replace(RUN_SCOPED_ROUTINE_TITLE_PREFIX, "").trim();
}

function isUnattendedRoutineSource(source: RoutineRunSource) {
  return UNATTENDED_ROUTINE_SOURCES.has(source);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeToken(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => nonEmptyString(entry)).filter((entry): entry is string => Boolean(entry)))];
  }
  const scalar = nonEmptyString(value);
  if (!scalar) return [];
  return [...new Set(scalar.split(/[,\n|]/).map((entry) => entry.trim()).filter(Boolean))];
}

function providerFamilyArrayFromUnknown(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const rawValues = Array.isArray(value)
    ? value.map((entry) => nonEmptyString(entry))
    : (nonEmptyString(value)?.split(/[,\n|]/).map((entry) => nonEmptyString(entry)) ?? []);
  if (
    rawValues.length === 0 ||
    rawValues.length > 8 ||
    rawValues.some((entry) => !entry)
  ) {
    throw unprocessable("providerPolicyExcludedFamilies must contain 1-8 canonical provider-family ids");
  }
  const values = rawValues.map((entry) => entry!);
  if (
    values.some((entry) => !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(entry)) ||
    new Set(values).size !== values.length
  ) {
    throw unprocessable("providerPolicyExcludedFamilies must contain unique canonical provider-family ids");
  }
  return values;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function shortSha(value: unknown) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

function mergeActionabilityRecords(...records: Array<Record<string, unknown> | null | undefined>) {
  return records.reduce<Record<string, unknown>>((acc, record) => {
    if (!record) return acc;
    return { ...acc, ...record };
  }, {});
}

function extractPortfolioDispatchContract(description: string | null | undefined) {
  const match = description?.match(PORTFOLIO_DISPATCH_CONTRACT_RE);
  if (!match?.[1]) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultProcessRunbookCwd() {
  return path.basename(process.cwd()) === "server" ? path.dirname(process.cwd()) : process.cwd();
}

function defaultSkillInventoryRoot() {
  return path.resolve(defaultProcessRunbookCwd(), "..", "portfolio-os");
}

function defaultDeterministicAdapterForRoutine(routineKey: string | null): {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
} | null {
  if (routineKey === "release_gate_reconciler") {
    return {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", RELEASE_GATE_RUNBOOK_COMMAND],
        cwd: defaultProcessRunbookCwd(),
        timeoutSec: 3600,
        env: {
          RELEASE_GATE_WRITE_DOCS: "1",
        },
      },
    };
  }
  if (routineKey === "skill_inventory") {
    return {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", SKILL_INVENTORY_RUNBOOK_COMMAND],
        cwd: defaultProcessRunbookCwd(),
        timeoutSec: 900,
        env: {
          SKILL_INVENTORY_ROOT: defaultSkillInventoryRoot(),
          SKILL_INVENTORY_WRITE_KEYWORDS: "1",
        },
      },
    };
  }
  if (routineKey === "evidence_backfill_reconciler") {
    return {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", EVIDENCE_BACKFILL_RUNBOOK_COMMAND],
        cwd: defaultProcessRunbookCwd(),
        timeoutSec: 1200,
        env: {
          PORTFOLIO_OS_DIR: path.resolve(defaultProcessRunbookCwd(), "..", "portfolio-os"),
        },
      },
    };
  }
  if (routineKey === "run_qa_sweep") {
    return {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", RUN_QA_SWEEP_RUNBOOK_COMMAND],
        cwd: defaultProcessRunbookCwd(),
        timeoutSec: 1200,
        env: {
          RUN_QA_SWEEP_WRITE_DOCS: "1",
          GSTACK_DIR: path.resolve(defaultProcessRunbookCwd(), "..", "gstack"),
        },
      },
    };
  }
  if (routineKey !== "dispatch_poller") return null;
  return {
    adapterType: "process",
    adapterConfig: {
      command: "/bin/zsh",
      args: ["-lc", DISPATCH_POLLER_RUNBOOK_COMMAND],
      cwd: defaultProcessRunbookCwd(),
      timeoutSec: 300,
      env: {
        DISPATCH_POLLER_WRITE_DOCS: "1",
      },
    },
  };
}

function inferRoutineKey(input: {
  routine: typeof routines.$inferSelect;
  raw: Record<string, unknown>;
  descriptionContract: Record<string, unknown>;
}) {
  const explicit = normalizeToken(input.raw.routineKey ?? input.raw.routine_key ?? input.descriptionContract.routine_key);
  if (explicit) return explicit;

  const title = normalizeToken(input.routine.title);
  const blockerClass = normalizeToken(input.raw.blockerClass ?? input.raw.blocker);
  if (title === "skill_inventory_curate_and_sync" && blockerClass === "skill_sync") return "skill_inventory";
  return null;
}

function actionabilityRecordFromContainer(container: Record<string, unknown>) {
  for (const key of ROUTINE_ACTIONABILITY_METADATA_KEYS) {
    const value = container[key];
    if (isPlainRecord(value)) return value;
  }
  return {};
}

function extractRoutineActionabilityContract(input: {
  routine: typeof routines.$inferSelect;
  triggerPayload: Record<string, unknown> | null;
}): RoutineActionabilityContract | null {
  const descriptionContract = extractPortfolioDispatchContract(input.routine.description);
  const raw = mergeActionabilityRecords(
    actionabilityRecordFromContainer(descriptionContract),
    input.triggerPayload && isPlainRecord(input.triggerPayload)
      ? actionabilityRecordFromContainer(input.triggerPayload)
      : null,
  );
  if (Object.keys(raw).length === 0) return null;

  const state = normalizeToken(raw.state ?? raw.blockerState ?? raw.factoryState);
  const lane = normalizeToken(raw.lane ?? raw.routineLane ?? raw.executionLane);
  const blockerOwner = normalizeToken(raw.blockerOwner ?? raw.owner ?? raw.nextActionOwner);
  const nextActionOwner = normalizeToken(raw.nextActionOwner ?? raw.blockerOwner ?? raw.owner);
  const blockerClass = normalizeToken(raw.blockerClass ?? raw.blocker ?? state ?? lane);
  const minIntervalMinutes =
    readPositiveNumber(raw.minIntervalMinutes ?? raw.minimumIntervalMinutes ?? raw.minCadenceMinutes) ??
    (lane === "maintenance" || lane === "governance" ? MAINTENANCE_LANE_DEFAULT_MIN_INTERVAL_MINUTES : null);
  const requireCleanWorkspace =
    readBoolean(raw.requireCleanWorkspace ?? raw.workspaceCleanRequired ?? raw.cleanWorkspaceRequired) ??
    (lane ? EXECUTION_LANES_REQUIRING_CLEAN_WORKSPACE.has(lane) : false);
  const deterministicAdapterConfig =
    (isPlainRecord(raw.deterministicAdapterConfig) ? raw.deterministicAdapterConfig : null) ??
    (isPlainRecord(raw.executionAdapterConfig) ? raw.executionAdapterConfig : null) ??
    (isPlainRecord(raw.adapterConfig) ? raw.adapterConfig : null);
  const routineKey = inferRoutineKey({ routine: input.routine, raw, descriptionContract });
  const defaultDeterministicAdapter = defaultDeterministicAdapterForRoutine(routineKey);
  const providerPolicyExcludedFamilies = providerFamilyArrayFromUnknown(
    raw.providerPolicyExcludedFamilies,
  );
  if (
    providerPolicyExcludedFamilies.length > 0 &&
    (nonEmptyString(raw.deterministicAdapterType) ||
      nonEmptyString(raw.executionAdapterType) ||
      nonEmptyString(raw.adapterType) ||
      defaultDeterministicAdapter)
  ) {
    throw unprocessable(
      "providerPolicyExcludedFamilies cannot be combined with a deterministic execution adapter",
    );
  }

  return {
    state,
    blockerOwner,
    nextActionOwner,
    blockerClass,
    lane,
    shipCaptain: readBoolean(raw.shipCaptain ?? raw.ship_captain ?? raw.captainLane) === true,
    requiredSecretNames: normalizeDeploymentRequiredSecretNames([
      ...stringArrayFromUnknown(raw.requiredSecretNames),
      ...stringArrayFromUnknown(raw.requiredSecrets),
      ...stringArrayFromUnknown(raw.requiredCredentialNames),
      ...stringArrayFromUnknown(raw.requiredCredentials),
    ], lane),
    upstreamArtifactHash:
      nonEmptyString(raw.upstreamArtifactHash) ??
      nonEmptyString(raw.upstreamHash) ??
      nonEmptyString(raw.artifactHash) ??
      nonEmptyString(raw.dispatchHash) ??
      null,
    requireUpstreamChange: readBoolean(raw.requireUpstreamChange ?? raw.skipWhenUpstreamUnchanged) !== false,
    requireCleanWorkspace,
    workspaceCwd:
      nonEmptyString(raw.workspaceCwd) ??
      nonEmptyString(raw.cwd) ??
      nonEmptyString(raw.targetClone) ??
      nonEmptyString(raw.clonePath) ??
      null,
    allowDirtyPathPrefixes: [
      ...stringArrayFromUnknown(raw.allowDirtyPathPrefixes),
      ...stringArrayFromUnknown(raw.allowDirtyPaths),
    ],
    minIntervalMinutes,
    deterministicAdapterType:
      nonEmptyString(raw.deterministicAdapterType) ??
      nonEmptyString(raw.executionAdapterType) ??
      nonEmptyString(raw.adapterType) ??
      defaultDeterministicAdapter?.adapterType ??
      null,
    deterministicAdapterConfig: deterministicAdapterConfig ?? defaultDeterministicAdapter?.adapterConfig ?? null,
    providerPolicyExcludedFamilies,
    deploymentTarget: isPlainRecord(raw.deploymentTarget) ? raw.deploymentTarget : null,
    raw,
  };
}

function assigneeAdapterOverridesFromContract(contract: RoutineActionabilityContract | null) {
  if (
    !contract?.deterministicAdapterType &&
    !contract?.deterministicAdapterConfig &&
    !contract?.providerPolicyExcludedFamilies.length
  ) return null;
  return {
    ...(contract.deterministicAdapterType ? { adapterType: contract.deterministicAdapterType } : {}),
    ...(contract.deterministicAdapterConfig ? { adapterConfig: contract.deterministicAdapterConfig } : {}),
    ...(contract.providerPolicyExcludedFamilies.length > 0
      ? { providerPolicyExcludedFamilies: contract.providerPolicyExcludedFamilies }
      : {}),
  };
}

function deterministicOverridesMatch(
  current: Record<string, unknown> | null | undefined,
  expected: Record<string, unknown>,
) {
  if (!isPlainRecord(current)) return false;
  if ("adapterType" in expected && current.adapterType !== expected.adapterType) return false;
  if (
    "adapterConfig" in expected &&
    JSON.stringify(current.adapterConfig ?? null) !== JSON.stringify(expected.adapterConfig ?? null)
  ) {
    return false;
  }
  if (
    "providerPolicyExcludedFamilies" in expected &&
    stableJson(current.providerPolicyExcludedFamilies ?? null) !==
      stableJson(expected.providerPolicyExcludedFamilies ?? null)
  ) {
    return false;
  }
  return true;
}

function routineActionabilityFingerprint(input: {
  routine: typeof routines.$inferSelect;
  title: string;
  contract: RoutineActionabilityContract | null;
}) {
  const contract = input.contract;
  const explicit =
    nonEmptyString(contract?.raw.blockerFingerprint) ??
    nonEmptyString(contract?.raw.fingerprint) ??
    nonEmptyString(contract?.raw.standingIssueFingerprint);
  if (explicit) return explicit;
  return [
    routineFamilyTitle(input.title || input.routine.title),
    contract?.lane ?? "routine",
    contract?.blockerClass ?? contract?.state ?? "agent_actionable",
    contract?.upstreamArtifactHash ?? "no_upstream_hash",
  ].join(":");
}

function addActionabilityPreflightPayload(
  payload: Record<string, unknown> | null,
  preflight: Record<string, unknown>,
) {
  return {
    ...(payload ?? {}),
    [ROUTINE_ACTIONABILITY_PREFLIGHT_KEY]: preflight,
  };
}

function actionabilityFromRunPayload(payload: unknown) {
  const record = isPlainRecord(payload) ? payload : {};
  return isPlainRecord(record[ROUTINE_ACTIONABILITY_PREFLIGHT_KEY])
    ? record[ROUTINE_ACTIONABILITY_PREFLIGHT_KEY]
    : {};
}

function originSafe(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").replace(/-+/g, "-").slice(0, 180);
}

function buildFactoryGuardDescription(input: {
  routine: typeof routines.$inferSelect;
  reason: string;
  message: string;
  state: string;
  blockerOwner: string;
  fingerprint: string;
  details?: Record<string, unknown>;
}) {
  return [
    input.message,
    "",
    "## Factory Guard",
    `- Routine: ${input.routine.title}`,
    `- Reason: \`${input.reason}\``,
    `- State: \`${input.state}\``,
    `- Owner: \`${input.blockerOwner}\``,
    `- Fingerprint: \`${input.fingerprint}\``,
    input.details && Object.keys(input.details).length > 0
      ? ["", "```json", JSON.stringify(input.details, null, 2), "```"].join("\n")
      : "",
  ].filter(Boolean).join("\n");
}

function finalActionabilityPreflightPayload(input: {
  block: RoutineActionabilityBlock;
  duplicateCount: number;
  routinePaused: boolean;
  standingIssueId?: string | null;
  selfHeal?: Record<string, unknown> | null;
}) {
  return {
    status: input.block.status,
    reason: input.block.reason,
    state: input.block.state,
    blockerClass: input.block.blockerClass,
    blockerOwner: input.block.blockerOwner,
    fingerprint: input.block.fingerprint,
    duplicateCount: input.duplicateCount,
    routinePaused: input.routinePaused,
    standingIssueId: input.standingIssueId ?? null,
    selfHeal: input.selfHeal ?? null,
    details: input.block.details ?? {},
  };
}

function canonicalFactoryGuardOriginId(input: {
  routine: typeof routines.$inferSelect;
  block: RoutineActionabilityBlock;
}) {
  return originSafe(`routine_blocker:${input.routine.id}:${input.block.fingerprint}`);
}

function shouldAssignFactoryGuardBlock(block: RoutineActionabilityBlock) {
  if (!block.standingIssue) return false;
  if (isSystemSelfHealingBlock(block)) return false;
  return !HUMAN_OWNED_BLOCKER_OWNERS.has(block.blockerOwner);
}

function parseBooleanVariableValue(name: string, raw: unknown) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw unprocessable(`Variable "${name}" must be a boolean`);
}

function parseNumberVariableValue(name: string, raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw unprocessable(`Variable "${name}" must be a number`);
}

function normalizeRoutineVariableValue(variable: RoutineVariable, raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);

  const normalized = stringifyRoutineVariableValue(raw);
  if (variable.type === "select") {
    if (!variable.options.includes(normalized)) {
      throw unprocessable(`Variable "${variable.name}" must match one of: ${variable.options.join(", ")}`);
    }
  }
  return normalized;
}

function isMissingRoutineVariableValue(value: string | number | boolean | null) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function assertRoutineVariableDefinitions(variables: RoutineVariable[]) {
  for (const variable of variables) {
    if (variable.defaultValue != null) {
      normalizeRoutineVariableValue(variable, variable.defaultValue);
    }
    if (variable.type === "select" && variable.options.length === 0) {
      throw unprocessable(`Variable "${variable.name}" must define at least one option`);
    }
  }
}

function sanitizeRoutineVariableInputs(
  variables: Array<Partial<RoutineVariable> & Pick<RoutineVariable, "name">> | null | undefined,
): RoutineVariable[] {
  return (variables ?? []).map((variable) => ({
    name: variable.name,
    label: variable.label ?? null,
    type: variable.type ?? "text",
    defaultValue: variable.defaultValue ?? null,
    required: variable.required ?? true,
    options: variable.options ?? [],
  }));
}

function assertScheduleCompatibleVariables(variables: RoutineVariable[]) {
  const missingDefaults = variables
    .filter((variable) => variable.required)
    .filter((variable) => {
      try {
        return isMissingRoutineVariableValue(normalizeRoutineVariableValue(variable, variable.defaultValue));
      } catch {
        return true;
      }
    })
    .map((variable) => variable.name);
  if (missingDefaults.length > 0) {
    throw unprocessable(
      `Scheduled routines require defaults for required variables: ${missingDefaults.join(", ")}`,
    );
  }
}

function statusRequiresDefaultAgent(status: string) {
  return status === "active";
}

function normalizeDraftRoutineStatus(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    return "paused";
  }
  return status;
}

function assertRoutineCanEnable(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    throw unprocessable("Default agent required");
  }
}

function collectProvidedRoutineVariables(
  source: "schedule" | "manual" | "api" | "webhook",
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, unknown> | null | undefined,
) {
  const nestedVariables = isPlainRecord(payload) && isPlainRecord(payload.variables) ? payload.variables : {};
  const provided = {
    ...(source === "webhook" && payload ? payload : {}),
    ...nestedVariables,
    ...(variables ?? {}),
  };
  delete provided.variables;
  return provided;
}

function resolveRoutineVariableValues(
  variables: RoutineVariable[],
  input: {
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
  },
) {
  if (variables.length === 0) return {} as Record<string, string | number | boolean>;
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    const candidate = provided[variable.name] !== undefined ? provided[variable.name] : variable.defaultValue;
    const normalized = normalizeRoutineVariableValue(variable, candidate);
    if (normalized == null || (typeof normalized === "string" && normalized.trim().length === 0)) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = normalized;
  }

  if (missing.length > 0) {
    throw unprocessable(`Missing routine variables: ${missing.join(", ")}`);
  }

  return resolved;
}

function mergeRoutineRunPayload(
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, string | number | boolean>,
) {
  if (Object.keys(variables).length === 0) return payload ?? null;
  if (!payload) return { variables };
  const existingVariables = isPlainRecord(payload.variables) ? payload.variables : {};
  return {
    ...payload,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}

export function routineService(db: Db, deps: {
  heartbeat?: IssueAssignmentWakeupDeps;
  providerPreflight?: ProviderReliabilityPreflightFn;
} = {}) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);
  const providerPreflight = deps.providerPreflight ?? evaluateProviderReliabilityPreflight;

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  async function assertAssignableAgent(companyId: string, agentId: string | null | undefined) {
    if (!agentId) return;
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Assignee must belong to same company");
    if (agent.status === "pending_approval") throw conflict("Cannot assign routines to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign routines to terminated agents");
  }

  async function assertProject(companyId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function assertGoal(companyId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.companyId !== companyId) throw unprocessable("Goal must belong to same company");
  }

  async function assertParentIssue(companyId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(row);
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        companyId: routineRuns.companyId,
        routineId: routineRuns.routineId,
        triggerId: routineRuns.triggerId,
        source: routineRuns.source,
        status: routineRuns.status,
        triggeredAt: routineRuns.triggeredAt,
        idempotencyKey: routineRuns.idempotencyKey,
        triggerPayload: routineRuns.triggerPayload,
        linkedIssueId: routineRuns.linkedIssueId,
        coalescedIntoRunId: routineRuns.coalescedIntoRunId,
        failureReason: routineRuns.failureReason,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
        updatedAt: routineRuns.updatedAt,
        triggerKind: routineTriggers.kind,
        triggerLabel: routineTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, {
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingRoutineIds = routineIds.filter((routineId) => !rowsByOriginId.has(routineId));
    if (missingRoutineIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.companyId, issues.companyId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "routine_execution"),
            inArray(issues.originId, missingRoutineIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, RoutineListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateRoutineTouchedState(input: {
    routineId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  async function findLiveExecutionIssue(routine: typeof routines.$inferSelect, executor: Db = db) {
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issues.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  async function lockRoutineFamily(routine: typeof routines.$inferSelect, executor: Db = db) {
    const familyTitle = routineFamilyTitle(routine.title);
    if (!familyTitle) {
      await executor.execute(
        sql`select id from ${routines} where ${routines.id} = ${routine.id} and ${routines.companyId} = ${routine.companyId} for update`,
      );
      return;
    }
    await executor.execute(
      sql`
        select ${routines.id}
        from ${routines}
        where ${routines.companyId} = ${routine.companyId}
          and lower(trim(regexp_replace(${routines.title}, '^\\[run_id:[^\\]]+\\]\\s*', ''))) = lower(${familyTitle})
        for update
      `,
    );
  }

  async function findLiveExecutionIssueForFamily(routine: typeof routines.$inferSelect, executor: Db = db) {
    const familyTitle = routineFamilyTitle(routine.title);
    if (!familyTitle) return null;

    const executionBoundIssue = await executor
      .select({
        issue: issues,
        routineTitle: routines.title,
      })
      .from(issues)
      .innerJoin(
        routines,
        and(
          sql`${routines.id}::text = ${issues.originId}`,
          eq(routines.companyId, issues.companyId),
        ),
      )
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          ne(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .then((rows) => rows.find((row) => routineFamilyTitle(row.routineTitle) === familyTitle)?.issue ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select({
        issue: issues,
        routineTitle: routines.title,
      })
      .from(issues)
      .innerJoin(
        routines,
        and(
          sql`${routines.id}::text = ${issues.originId}`,
          eq(routines.companyId, issues.companyId),
        ),
      )
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issues.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          ne(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .then((rows) => rows.find((row) => routineFamilyTitle(row.routineTitle) === familyTitle)?.issue ?? null);
  }

  function staleUnattendedIdleRoutineIssueReason(input: {
    issue: typeof issues.$inferSelect;
    triggeredAt: Date;
  }) {
    const updatedAt = input.issue.updatedAt instanceof Date ? input.issue.updatedAt : input.issue.createdAt;
    const createdAt = input.issue.createdAt instanceof Date ? input.issue.createdAt : updatedAt;
    const lastSignalAt = updatedAt.getTime() >= createdAt.getTime() ? updatedAt : createdAt;
    const idleMs = input.triggeredAt.getTime() - lastSignalAt.getTime();
    if (idleMs < STALE_UNATTENDED_IDLE_ROUTINE_ISSUE_MS) return null;
    return {
      reason: "stale_unattended_idle_routine_issue",
      idleMs,
      lastSignalAt: new Date(lastSignalAt.getTime()),
      staleAfterMs: STALE_UNATTENDED_IDLE_ROUTINE_ISSUE_MS,
    };
  }

  async function supersedeStaleIdleRoutineIssue(input: {
    issue: typeof issues.$inferSelect;
    routine: typeof routines.$inferSelect;
    replacementRunId: string;
    triggeredAt: Date;
    reason: NonNullable<ReturnType<typeof staleUnattendedIdleRoutineIssueReason>>;
  }, executor: Db = db) {
    const idleHours = Math.floor(input.reason.idleMs / 3_600_000);
    const supersession = {
      status: "superseded",
      reason: input.reason.reason,
      replacementRoutineRunId: input.replacementRunId,
      supersededAt: input.triggeredAt.toISOString(),
      staleAfterHours: Math.floor(input.reason.staleAfterMs / 3_600_000),
      idleHours,
      previousOriginRunId: input.issue.originRunId ?? null,
      routineId: input.routine.id,
      routineTitle: input.routine.title,
    };
    await executor
      .update(issues)
      .set({
        status: "cancelled",
        cancelledAt: input.triggeredAt,
        updatedAt: input.triggeredAt,
        executionState: sql`jsonb_set(
          coalesce(${issues.executionState}, '{}'::jsonb),
          '{paperclipRoutineSupersession}',
          ${JSON.stringify(supersession)}::jsonb,
          true
        )`,
      })
      .where(eq(issues.id, input.issue.id));
    await executor.insert(issueComments).values({
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      body: [
        "Paperclip superseded this stale idle routine issue instead of coalescing another scheduled tick into it.",
        "",
        `Replacement routine run: ${input.replacementRunId}`,
        `Idle window: ${idleHours}h since ${input.reason.lastSignalAt.toISOString()}`,
        "Prior comments, receipts, and token output remain preserved on this issue; current execution continues in the replacement issue.",
      ].join("\n"),
    });
  }

  async function findOpenExecutionIssue(routine: typeof routines.$inferSelect, executor: Db = db) {
    return executor
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenExecutionIssueForFamily(routine: typeof routines.$inferSelect, executor: Db = db) {
    const familyTitle = routineFamilyTitle(routine.title);
    if (!familyTitle) return null;

    return executor
      .select({
        issue: issues,
        routineTitle: routines.title,
      })
      .from(issues)
      .innerJoin(
        routines,
        and(
          sql`${routines.id}::text = ${issues.originId}`,
          eq(routines.companyId, issues.companyId),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          ne(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .then((rows) => rows.find((row) => routineFamilyTitle(row.routineTitle) === familyTitle)?.issue ?? null);
  }

  async function resolveRoutineWorkspaceCwd(input: {
    routine: typeof routines.$inferSelect;
    contract: RoutineActionabilityContract | null;
    projectId: string | null;
    executionWorkspaceId?: string | null;
  }, executor: Db = db) {
    if (input.contract?.workspaceCwd) return input.contract.workspaceCwd;
    if (input.executionWorkspaceId) {
      const executionWorkspace = await executor
        .select({ cwd: executionWorkspaces.cwd })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const cwd = nonEmptyString(executionWorkspace?.cwd);
      if (cwd) return cwd;
    }
    if (!input.projectId) return null;
    return executor
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, input.projectId), eq(projectWorkspaces.companyId, input.routine.companyId)))
      .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      .limit(1)
      .then((rows) => nonEmptyString(rows[0]?.cwd));
  }

  async function classifyWorkspaceCleanliness(cwd: string | null, allowDirtyPathPrefixes: string[]) {
    if (!cwd) {
      return {
        ok: false,
        reason: "workspace_cwd_missing",
        dirtyPaths: [] as string[],
        cwd: null,
      };
    }
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      const dirtyPaths = stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
          const rawPath = line.slice(3).trim();
          const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
          return renamedPath.replace(/^"|"$/g, "");
        })
        .filter((dirtyPath) => {
          if (allowDirtyPathPrefixes.length === 0) return true;
          return !allowDirtyPathPrefixes.some((prefix) => dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`));
        });
      return {
        ok: dirtyPaths.length === 0,
        reason: dirtyPaths.length === 0 ? "workspace_clean" : "workspace_dirty",
        dirtyPaths,
        cwd,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "workspace_status_unavailable",
        dirtyPaths: [] as string[],
        cwd,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function findRecentProviderCapacityBlock(input: {
    companyId: string;
    agentId: string;
  }, executor: Db = db) {
    const cutoff = new Date(Date.now() - PROVIDER_BACKOFF_LOOKBACK_MS);
    const skippedWake = await executor
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, "provider_degraded_backoff"),
          gte(agentWakeupRequests.requestedAt, cutoff),
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (skippedWake) return { source: "agent_wakeup_requests", ...skippedWake };

    return executor
      .select({
        id: heartbeatRuns.id,
        reason: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
        requestedAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.errorCode, "provider_reliability_preflight_failed"),
          gte(heartbeatRuns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ? { source: "heartbeat_runs", ...rows[0] } : null);
  }

  async function probeProviderCapacityRecovery(input: {
    companyId: string;
    agentId: string;
  }, executor: Db = db): Promise<Record<string, unknown>> {
    const agent = await executor
      .select({
        id: agents.id,
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      return {
        status: "not_applicable",
        reason: "agent_not_found",
      };
    }

    const adapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const routed = resolveAgentTieredExecutionRouting({
      role: agent.role,
      adapterType: agent.adapterType,
      adapterConfig,
      availableAdapters: ROUTINE_PROVIDER_PREFLIGHT_AVAILABLE_ADAPTERS,
      recentStall: true,
      stallReason: "provider_degraded_backoff",
    });

    const candidates: Array<{
      source: string;
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      selectedLane?: TieredExecutionLane | null;
      route?: Record<string, unknown> | null;
    }> = [];
    if (routed.route) {
      candidates.push({
        source: "tiered_execution_policy",
        adapterType: routed.adapterType,
        adapterConfig: isPlainRecord(routed.adapterConfig) ? routed.adapterConfig : {},
        selectedLane: routed.route.selectedLane,
        route: {
          selectedLane: routed.route.selectedLane,
          provider: routed.route.provider,
          model: routed.route.model,
          reason: routed.route.reason,
          candidates: routed.route.candidates,
        },
      });
    }
    candidates.push({
      source: "current_agent_adapter",
      adapterType: agent.adapterType,
      adapterConfig,
      selectedLane: null,
      route: null,
    });

    const seen = new Set<string>();
    const attempts: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.adapterType}:${candidate.selectedLane ?? ""}:${JSON.stringify(candidate.adapterConfig)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const preflight = await providerPreflight({
          companyId: input.companyId,
          adapterType: candidate.adapterType,
          adapterConfig: candidate.adapterConfig,
          selectedLane: candidate.selectedLane,
        });
        const attempt = {
          source: candidate.source,
          adapterType: candidate.adapterType,
          selectedLane: candidate.selectedLane ?? null,
          route: candidate.route ?? null,
          preflight,
        };
        attempts.push(attempt);
        if (preflight.status === "healthy") {
          return {
            status: "healthy",
            source: candidate.source,
            selectedLane: candidate.selectedLane ?? null,
            route: candidate.route ?? null,
            attempts,
          };
        }
      } catch (error) {
        attempts.push({
          source: candidate.source,
          adapterType: candidate.adapterType,
          selectedLane: candidate.selectedLane ?? null,
          route: candidate.route ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      status: attempts.length > 0 ? "not_healthy" : "not_applicable",
      attempts,
    };
  }

  async function findMissingSecretNames(companyId: string, names: string[], executor: Db = db) {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (uniqueNames.length === 0) return [];
    const existing = await executor
      .select({ name: companySecrets.name })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.name, uniqueNames)));
    const existingNames = new Set(existing.map((entry) => entry.name));
    return uniqueNames.filter((name) => !existingNames.has(name) && !isDeploymentSecretSatisfiedByRuntime(name));
  }

  function hasMissingHostingerDeploymentTarget(contract: RoutineActionabilityContract, missingSecrets: string[]) {
    if (contract.lane !== "deploy") return false;
    const deploymentTarget = isPlainRecord(contract.deploymentTarget) ? contract.deploymentTarget : null;
    if (deploymentTarget && deploymentTarget.provider !== "hostinger") return false;
    const missing = new Set(missingSecrets);
    return (
      missing.has(HOSTINGER_VM_ID_SECRET_NAME) ||
      missing.has(HOSTINGER_FIREWALL_ID_SECRET_NAME) ||
      missing.has(HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME)
    );
  }

  async function findLastRoutineActionabilityRun(input: {
    routineId: string;
    companyId: string;
    runId: string;
  }, executor: Db = db) {
    return executor
      .select({
        id: routineRuns.id,
        status: routineRuns.status,
        triggerPayload: routineRuns.triggerPayload,
        createdAt: routineRuns.createdAt,
      })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.companyId, input.companyId),
          eq(routineRuns.routineId, input.routineId),
          ne(routineRuns.id, input.runId),
        ),
      )
      .orderBy(desc(routineRuns.createdAt), desc(routineRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function countRecentMatchingActionabilityBlocks(input: {
    routineId: string;
    companyId: string;
    fingerprint: string;
    runId?: string;
    limit?: number;
  }, executor: Db = db) {
    const rows = await executor
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(and(
        eq(routineRuns.companyId, input.companyId),
        eq(routineRuns.routineId, input.routineId),
        input.runId ? ne(routineRuns.id, input.runId) : undefined,
      ))
      .orderBy(desc(routineRuns.createdAt), desc(routineRuns.id))
      .limit(input.limit ?? DUPLICATE_LOOP_SUPPRESSION_THRESHOLD - 1);
    return rows.filter((row) => {
      const preflight = actionabilityFromRunPayload(row.triggerPayload);
      return preflight.fingerprint === input.fingerprint && preflight.status === "skipped";
    }).length;
  }

  async function findOpenFactoryGuardIssue(companyId: string, originId: string, executor: Db = db) {
    return executor
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, FACTORY_GUARD_ORIGIN_KIND),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenFactoryGuardIssueByOriginIds(
    companyId: string,
    originIds: string[],
    executor: Db = db,
  ) {
    for (const originId of originIds) {
      const issue = await findOpenFactoryGuardIssue(companyId, originId, executor);
      if (issue) return issue;
    }
    return null;
  }

  async function firstAssignableAgentId(
    companyId: string,
    candidates: Array<string | null | undefined>,
    executor: Db = db,
  ) {
    const uniqueCandidates = [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
    for (const candidate of uniqueCandidates) {
      const agent = await executor
        .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, candidate))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) continue;
      if (agent.status === "pending_approval" || agent.status === "terminated") continue;
      return agent.id;
    }
    return null;
  }

  async function ensureFactoryGuardIssue(input: {
    routine: typeof routines.$inferSelect;
    projectId: string | null;
    block: RoutineActionabilityBlock;
  }, executor: Db = db) {
    if (!input.block.standingIssue) return null;
    const canonicalOriginId = canonicalFactoryGuardOriginId({
      routine: input.routine,
      block: input.block,
    });
    const legacyOriginId = input.block.standingIssue.originId;
    const originIds = [...new Set(
      [canonicalOriginId, legacyOriginId].filter((originId): originId is string => Boolean(originId)),
    )];
    const assigneeAgentId = shouldAssignFactoryGuardBlock(input.block)
      ? await firstAssignableAgentId(input.routine.companyId, [input.routine.assigneeAgentId], executor)
      : null;
    const executionState = {
      paperclipFactoryGuard: {
        reason: input.block.reason,
        state: input.block.state,
        blockerClass: input.block.blockerClass,
        blockerOwner: input.block.blockerOwner,
        fingerprint: input.block.fingerprint,
      },
    };
    const existing = await findOpenFactoryGuardIssueByOriginIds(
      input.routine.companyId,
      originIds,
      executor,
    );
    if (existing) {
      const shouldAssign = Boolean(assigneeAgentId && !existing.assigneeAgentId && !existing.assigneeUserId);
      const shouldForceBlockedStatus = ["backlog", "todo", "blocked"].includes(existing.status);
      const updated = await executor
        .update(issues)
        .set({
          originId: canonicalOriginId,
          title: input.block.standingIssue.title,
          description: input.block.standingIssue.description,
          priority: input.block.standingIssue.priority ?? existing.priority,
          status: shouldForceBlockedStatus ? "blocked" : existing.status,
          ...(shouldAssign ? { assigneeAgentId, assigneeUserId: null } : {}),
          updatedAt: new Date(),
          executionState,
        })
        .where(eq(issues.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);
      return {
        issue: updated,
        created: false,
        shouldWakeAssignee: Boolean(shouldAssign && updated.assigneeAgentId && updated.status !== "backlog"),
      };
    }
    const issue = await issueSvc.create(input.routine.companyId, {
      projectId: input.projectId,
      goalId: input.routine.goalId,
      title: input.block.standingIssue.title,
      description: input.block.standingIssue.description,
      status: "blocked",
      priority: input.block.standingIssue.priority ?? "high",
      assigneeAgentId,
      originKind: FACTORY_GUARD_ORIGIN_KIND,
      originId: canonicalOriginId,
      executionState,
    });
    return {
      issue,
      created: true,
      shouldWakeAssignee: Boolean(issue.assigneeAgentId && issue.status !== "backlog"),
    };
  }

  async function pauseRoutineAndDisableTriggers(input: {
    routineId: string;
    reason: string;
  }, executor: Db = db) {
    const now = new Date();
    await executor
      .update(routines)
      .set({
        status: "paused",
        updatedAt: now,
      })
      .where(eq(routines.id, input.routineId));
    await executor
      .update(routineTriggers)
      .set({
        enabled: false,
        nextRunAt: null,
        lastResult: `non_active_routine_trigger_disabled:${input.reason}`,
        updatedAt: now,
      })
      .where(and(eq(routineTriggers.routineId, input.routineId), eq(routineTriggers.enabled, true)));
  }

  async function handoffRoutineChildIssuesAfterCompletion(input: {
    issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "assigneeAgentId" | "originRunId">;
  }, executor: Db = db) {
    if (!input.issue.originRunId) return;

    const run = await executor
      .select({ routineId: routineRuns.routineId })
      .from(routineRuns)
      .where(and(
        eq(routineRuns.id, input.issue.originRunId),
        eq(routineRuns.companyId, input.issue.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    const routine = run?.routineId
      ? await executor
        .select({ assigneeAgentId: routines.assigneeAgentId })
        .from(routines)
        .where(and(
          eq(routines.id, run.routineId),
          eq(routines.companyId, input.issue.companyId),
        ))
        .then((rows) => rows[0] ?? null)
      : null;

    const childIssues = await executor
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.issue.companyId),
        eq(issues.parentId, input.issue.id),
        inArray(issues.status, OPEN_ISSUE_STATUSES),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id));

    for (const child of childIssues) {
      if (child.assigneeUserId) continue;
      const assigneeAgentId = child.assigneeAgentId
        ? await firstAssignableAgentId(input.issue.companyId, [child.assigneeAgentId], executor)
        : await firstAssignableAgentId(
          input.issue.companyId,
          [child.createdByAgentId, input.issue.assigneeAgentId, routine?.assigneeAgentId],
          executor,
        );
      if (!assigneeAgentId) continue;

      let handoffIssue: { id: string; status: string; assigneeAgentId: string | null } = {
        id: child.id,
        status: child.status,
        assigneeAgentId,
      };
      if (!child.assigneeAgentId) {
        const [updated] = await executor
          .update(issues)
          .set({
            assigneeAgentId,
            assigneeUserId: null,
            status: child.status === "backlog" ? "todo" : child.status,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, child.id))
          .returning({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          });
        if (!updated?.assigneeAgentId) continue;
        handoffIssue = updated;
      }

      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: handoffIssue,
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "routine.child_handoff",
        requestedByActorType: "system",
      });
    }
  }

  async function ensureRoutineIssueAssigneeAdapterOverrides(input: {
    issue: typeof issues.$inferSelect;
    contract: RoutineActionabilityContract | null;
  }, executor: Db = db) {
    const expectedOverrides = assigneeAdapterOverridesFromContract(input.contract);
    if (!expectedOverrides) return input.issue;
    if (deterministicOverridesMatch(input.issue.assigneeAdapterOverrides, expectedOverrides)) {
      return input.issue;
    }
    if ("providerPolicyExcludedFamilies" in expectedOverrides) {
      throw conflict(
        "Provider-policy family exclusions cannot be changed on an already-created routine issue",
      );
    }
    const mergedOverrides = {
      ...(isPlainRecord(input.issue.assigneeAdapterOverrides) ? input.issue.assigneeAdapterOverrides : {}),
      ...expectedOverrides,
    };
    return executor
      .update(issues)
      .set({
        assigneeAdapterOverrides: mergedOverrides,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issue.id))
      .returning()
      .then((rows) => rows[0] ?? input.issue);
  }

  async function evaluateRoutineActionabilityPreflight(input: {
    routine: typeof routines.$inferSelect;
    source: RoutineRunSource;
    assigneeAgentId: string;
    title: string;
    triggerPayload: Record<string, unknown> | null;
    projectId: string | null;
    executionWorkspaceId?: string | null;
    runId: string;
  }, executor: Db = db): Promise<{
    contract: RoutineActionabilityContract | null;
    fingerprint: string;
    block: RoutineActionabilityBlock | null;
    providerCapacityRecoveryProbe?: Record<string, unknown> | null;
  }> {
    const contract = extractRoutineActionabilityContract({
      routine: input.routine,
      triggerPayload: input.triggerPayload,
    });
    const fingerprint = routineActionabilityFingerprint({
      routine: input.routine,
      title: input.title,
      contract,
    });
    if (!isUnattendedRoutineSource(input.source)) {
      return { contract, fingerprint, block: null };
    }

    const providerCapacityBlock = await findRecentProviderCapacityBlock({
      companyId: input.routine.companyId,
      agentId: input.assigneeAgentId,
    }, executor);
    if (providerCapacityBlock) {
      const providerCapacityRecoveryProbe = await probeProviderCapacityRecovery({
        companyId: input.routine.companyId,
        agentId: input.assigneeAgentId,
      }, executor);
      if (providerCapacityRecoveryProbe.status === "healthy") {
        return {
          contract,
          fingerprint,
          block: null,
          providerCapacityRecoveryProbe,
        };
      }
      const blockFingerprint = `provider_capacity:${input.assigneeAgentId}:${providerCapacityBlock.reason ?? "provider_degraded"}`;
      return {
        contract,
        fingerprint: blockFingerprint,
        block: {
          status: "skipped",
          reason: "provider_capacity_blocked",
          state: "waiting_for_provider_capacity",
          blockerClass: "provider_capacity",
          blockerOwner: "board",
          fingerprint: blockFingerprint,
          message: "Routine wake suppressed because provider capacity is already degraded for this agent.",
          details: { providerCapacityBlock, providerCapacityRecoveryProbe },
          standingIssue: {
            originId: originSafe(`execution_capacity:${input.assigneeAgentId}:${providerCapacityBlock.reason ?? "provider_degraded"}`),
            title: "Execution capacity blocked",
            description: buildFactoryGuardDescription({
              routine: input.routine,
              reason: "provider_capacity_blocked",
              message: "Paperclip suppressed unattended routine wakes because provider capacity is degraded and no approved recovery lane is available.",
              state: "waiting_for_provider_capacity",
              blockerOwner: "board",
              fingerprint: blockFingerprint,
              details: { providerCapacityBlock, providerCapacityRecoveryProbe },
            }),
            priority: "critical",
          },
        },
      };
    }

    if (!contract) return { contract, fingerprint, block: null };

    const missingSecrets = await findMissingSecretNames(
      input.routine.companyId,
      contract.requiredSecretNames,
      executor,
    );
    if (missingSecrets.length > 0) {
      if (hasMissingHostingerDeploymentTarget(contract, missingSecrets)) {
        const missingFingerprint = `hostinger_deploy:${missingSecrets.sort().join("+")}`;
        return {
          contract,
          fingerprint: missingFingerprint,
          block: {
            status: "skipped",
            reason: "hostinger_deployment_target_missing",
            state: "waiting_for_hostinger_target",
            blockerClass: "hostinger_deploy",
            blockerOwner: "agent",
            fingerprint: missingFingerprint,
            message: "Routine wake suppressed until the Hostinger Deploy Operator provisions or records the deployment target.",
            details: {
              missingSecretNames: missingSecrets,
              operatorAgentName: "Hostinger Deploy Operator",
              operatorSkillKey: "paperclipai/paperclip/hostinger-deploy-operator",
            },
            standingIssue: {
              originId: originSafe(`hostinger_deploy:${missingSecrets.sort().join("+")}`),
              title: "Hostinger deployment target blocker",
              description: buildFactoryGuardDescription({
                routine: input.routine,
                reason: "hostinger_deployment_target_missing",
                message: "Provision or record the Hostinger VPS/firewall target, restrict the endpoint to the allowed client IP, and leave deployment receipts before this deploy lane can run unattended.",
                state: "waiting_for_hostinger_target",
                blockerOwner: "agent",
                fingerprint: missingFingerprint,
                details: {
                  missingSecretNames: missingSecrets,
                  operatorAgentName: "Hostinger Deploy Operator",
                  operatorSkillKey: "paperclipai/paperclip/hostinger-deploy-operator",
                },
              }),
              priority: "critical",
            },
          },
        };
      }
      const missingFingerprint = `credential:${missingSecrets.sort().join("+")}`;
      return {
        contract,
        fingerprint: missingFingerprint,
        block: {
          status: "skipped",
          reason: "credential_blocked",
          state: "waiting_for_human_credential",
          blockerClass: "credential",
          blockerOwner: "board",
          fingerprint: missingFingerprint,
          message: "Routine wake suppressed because required company credentials are missing.",
          details: { missingSecretNames: missingSecrets },
          standingIssue: {
            originId: originSafe(`credential:${missingSecrets.sort().join("+")}`),
            title: `Credential blocker: ${missingSecrets.join(", ")}`,
            description: buildFactoryGuardDescription({
              routine: input.routine,
              reason: "credential_blocked",
              message: "Add the missing company secrets before this deploy/outreach routine can run unattended.",
              state: "waiting_for_human_credential",
              blockerOwner: "board",
              fingerprint: missingFingerprint,
              details: { missingSecretNames: missingSecrets },
            }),
            priority: "critical",
          },
        },
      };
    }

    const owner = contract.nextActionOwner ?? contract.blockerOwner;
    const state = contract.state;
    if (
      (state && !AGENT_ACTIONABLE_STATES.has(state)) ||
      (owner && HUMAN_OWNED_BLOCKER_OWNERS.has(owner))
    ) {
      const blockedState = state ?? "needs_decision";
      const blockerOwner = owner ?? "operator";
      const stateFingerprint = `${blockedState}:${blockerOwner}:${contract.blockerClass ?? "decision"}`;
      return {
        contract,
        fingerprint: stateFingerprint,
        block: {
          status: "skipped",
          reason: "blocker_owner_not_agent_actionable",
          state: blockedState,
          blockerClass: contract.blockerClass ?? "decision",
          blockerOwner,
          fingerprint: stateFingerprint,
          message: "Routine wake suppressed because the current blocker is not agent-actionable.",
          details: { state, blockerOwner, nextActionOwner: contract.nextActionOwner },
          standingIssue: {
            originId: originSafe(`blocker_state:${stateFingerprint}`),
            title: `Factory state blocked: ${blockedState}`,
            description: buildFactoryGuardDescription({
              routine: input.routine,
              reason: "blocker_owner_not_agent_actionable",
              message: "Resolve the board/operator-owned blocker before unattended agents resume this lane.",
              state: blockedState,
              blockerOwner,
              fingerprint: stateFingerprint,
              details: { state, blockerOwner, nextActionOwner: contract.nextActionOwner },
            }),
            priority: "high",
          },
        },
      };
    }

    if (contract.minIntervalMinutes) {
      const previousRun = await findLastRoutineActionabilityRun({
        routineId: input.routine.id,
        companyId: input.routine.companyId,
        runId: input.runId,
      }, executor);
      const elapsedMs = previousRun ? Date.now() - previousRun.createdAt.getTime() : Number.POSITIVE_INFINITY;
      const minIntervalMs = contract.minIntervalMinutes * 60 * 1000;
      if (elapsedMs < minIntervalMs) {
        return {
          contract,
          fingerprint,
          block: {
            status: "skipped",
            reason: "maintenance_lane_cadence",
            state: "maintenance_not_due",
            blockerClass: "maintenance_cadence",
            blockerOwner: "system",
            fingerprint,
            message: "Routine wake suppressed because this lower-frequency maintenance lane is not due yet.",
            details: {
              previousRunId: previousRun?.id ?? null,
              previousRunCreatedAt: previousRun?.createdAt.toISOString() ?? null,
              minIntervalMinutes: contract.minIntervalMinutes,
              elapsedMinutes: Math.floor(elapsedMs / 60_000),
            },
          },
        };
      }
    }

    if (contract.upstreamArtifactHash && contract.requireUpstreamChange) {
      const previousRun = await findLastRoutineActionabilityRun({
        routineId: input.routine.id,
        companyId: input.routine.companyId,
        runId: input.runId,
      }, executor);
      const previousPayload = isPlainRecord(previousRun?.triggerPayload) ? previousRun.triggerPayload : null;
      const previousPreflight = actionabilityFromRunPayload(previousPayload);
      const previousContract = previousPayload
        ? extractRoutineActionabilityContract({ routine: input.routine, triggerPayload: previousPayload })
        : null;
      const previousHash =
        nonEmptyString(previousPreflight.upstreamArtifactHash) ??
        previousContract?.upstreamArtifactHash ??
        null;
      if (previousHash && previousHash === contract.upstreamArtifactHash) {
        return {
          contract,
          fingerprint,
          block: {
            status: "skipped",
            reason: "upstream_artifact_unchanged",
            state: "waiting_for_upstream_change",
            blockerClass: "upstream_artifact",
            blockerOwner: "system",
            fingerprint,
            message: "Routine wake suppressed because the upstream artifact hash has not changed.",
            details: {
              upstreamArtifactHash: contract.upstreamArtifactHash,
              previousRunId: previousRun?.id ?? null,
            },
          },
        };
      }
    }

    if (contract.requireCleanWorkspace) {
      const cwd = await resolveRoutineWorkspaceCwd({
        routine: input.routine,
        contract,
        projectId: input.projectId,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
      }, executor);
      const cleanliness = await classifyWorkspaceCleanliness(cwd, contract.allowDirtyPathPrefixes);
      if (!cleanliness.ok) {
        const workspaceFingerprint = `workspace:${shortSha({
          cwd: cleanliness.cwd,
          dirtyPaths: cleanliness.dirtyPaths,
          reason: cleanliness.reason,
        })}`;
        return {
          contract,
          fingerprint: workspaceFingerprint,
          block: {
            status: "skipped",
            reason: "workspace_not_clean",
            state: "waiting_for_clean_workspace",
            blockerClass: "workspace_cleanliness",
            blockerOwner: "agent",
            fingerprint: workspaceFingerprint,
            message: "Routine wake suppressed because the workspace is not clean enough for release/QA/deploy work.",
            details: cleanliness,
            standingIssue: {
              originId: originSafe(`workspace_cleanup:${workspaceFingerprint}`),
              title: "Workspace cleanup required before release lane resumes",
              description: buildFactoryGuardDescription({
                routine: input.routine,
                reason: "workspace_not_clean",
                message: "Classify or clean the dirty workspace paths before this release/QA/deploy routine runs again.",
                state: "waiting_for_clean_workspace",
                blockerOwner: "agent",
                fingerprint: workspaceFingerprint,
                details: cleanliness,
              }),
              priority: "high",
            },
          },
        };
      }
    }

    return { contract, fingerprint, block: null };
  }

  async function finalizeRun(runId: string, patch: Partial<typeof routineRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      companyId,
      {
        name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
        provider: "local_encrypted",
        value: secretValue,
        description: `Webhook auth for routine ${routineId}`,
      },
      actor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest");
    return value;
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: RoutineRunSource;
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    projectId?: string | null;
    assigneeAgentId?: string | null;
    idempotencyKey?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
  }) {
    const projectId = input.projectId ?? input.routine.projectId ?? null;
    const assigneeAgentId = input.assigneeAgentId ?? input.routine.assigneeAgentId ?? null;
    if (!assigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], input);
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...resolvedVariables };
    const title = interpolateRoutineTemplate(input.routine.title, allVariables) ?? input.routine.title;
    const description = interpolateRoutineTemplate(input.routine.description, allVariables);
    const triggerPayload = mergeRoutineRunPayload(input.payload, resolvedVariables);
    const deterministicContract = extractRoutineActionabilityContract({
      routine: input.routine,
      triggerPayload,
    });
    let idempotencyReused = false;
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockRoutineFamily(input.routine, txDb);

      const idempotencyPredicate = input.idempotencyKey
        ? input.source === "schedule"
          ? and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
            )
          : and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(routineRuns.triggerId, input.trigger.id) : isNull(routineRuns.triggerId),
            )
        : null;
      if (idempotencyPredicate) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(idempotencyPredicate)
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) {
          idempotencyReused = true;
          return existing;
        }
      }

      const triggeredAt = new Date();
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
        })
        .onConflictDoNothing()
        .returning();
      if (!createdRun) {
        const raced = idempotencyPredicate
          ? await txDb
              .select()
              .from(routineRuns)
              .where(idempotencyPredicate)
              .orderBy(desc(routineRuns.createdAt))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        if (!raced) throw conflict("Routine run identity conflicted without a reusable row");
        idempotencyReused = true;
        return raced;
      }

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const activeIssue =
          await findLiveExecutionIssue(input.routine, txDb)
          ?? await findLiveExecutionIssueForFamily(input.routine, txDb);
        if (activeIssue && input.routine.concurrencyPolicy !== "always_enqueue") {
          await ensureRoutineIssueAssigneeAdapterOverrides({
            issue: activeIssue,
            contract: deterministicContract,
          }, txDb);
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
            triggerPayload: addActionabilityPreflightPayload(triggerPayload, {
              status,
              reason: "live_execution_issue_exists",
              state: "standing_wip",
              blockerClass: "routine_wip",
              blockerOwner: "agent",
              fingerprint: activeIssue.originRunId ?? activeIssue.id,
              linkedIssueId: activeIssue.id,
            }),
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        // Unattended sources should not spawn more work while unresolved routine WIP exists.
        const openIssue = isUnattendedRoutineSource(input.source) && input.routine.concurrencyPolicy !== "always_enqueue"
          ? await findOpenExecutionIssue(input.routine, txDb)
            ?? await findOpenExecutionIssueForFamily(input.routine, txDb)
          : null;
        if (openIssue) {
          const staleIdleReason = staleUnattendedIdleRoutineIssueReason({ issue: openIssue, triggeredAt });
          if (staleIdleReason) {
            await supersedeStaleIdleRoutineIssue({
              issue: openIssue,
              routine: input.routine,
              replacementRunId: createdRun.id,
              triggeredAt,
              reason: staleIdleReason,
            }, txDb);
          } else {
            await ensureRoutineIssueAssigneeAdapterOverrides({
              issue: openIssue,
              contract: deterministicContract,
            }, txDb);
            const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            const updated = await finalizeRun(createdRun.id, {
              status,
              linkedIssueId: openIssue.id,
              coalescedIntoRunId: openIssue.originRunId,
              completedAt: triggeredAt,
              triggerPayload: addActionabilityPreflightPayload(triggerPayload, {
                status,
                reason: "open_execution_issue_exists",
                state: "standing_wip",
                blockerClass: "routine_wip",
                blockerOwner: "agent",
                fingerprint: openIssue.originRunId ?? openIssue.id,
                linkedIssueId: openIssue.id,
              }),
            }, txDb);
            await updateRoutineTouchedState({
              routineId: input.routine.id,
              triggerId: input.trigger?.id ?? null,
              triggeredAt,
              status,
              issueId: openIssue.id,
              nextRunAt,
            }, txDb);
            return updated ?? createdRun;
          }
        }

        const actionability = await evaluateRoutineActionabilityPreflight({
          routine: input.routine,
          source: input.source,
          assigneeAgentId,
          title,
          triggerPayload,
          projectId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          runId: createdRun.id,
        }, txDb);
        if (actionability.block) {
          const systemSelfHealingBlock = isSystemSelfHealingBlock(actionability.block);
          const priorDuplicateCount = await countRecentMatchingActionabilityBlocks({
            routineId: input.routine.id,
            companyId: input.routine.companyId,
            fingerprint: actionability.block.fingerprint,
            runId: createdRun.id,
            limit: systemSelfHealingBlock
              ? SYSTEM_SELF_HEAL_RESCHEDULE_CAP
              : DUPLICATE_LOOP_SUPPRESSION_THRESHOLD - 1,
          }, txDb);
          const duplicateCount = priorDuplicateCount + 1;
          const selfHeal = systemSelfHealRescheduleDecision({
            block: actionability.block,
            duplicateCount,
            trigger: input.trigger,
            triggeredAt,
            naturalNextRunAt: nextRunAt,
          });
          const routinePaused =
            (actionability.block.freezeRoutine === true && !systemSelfHealingBlock) ||
            (duplicateCount >= DUPLICATE_LOOP_SUPPRESSION_THRESHOLD && !systemSelfHealingBlock);
          const block = routinePaused && !actionability.block.standingIssue
            ? {
                ...actionability.block,
                reason: "duplicate_loop_suppressed",
                standingIssue: {
                  originId: originSafe(`duplicate_loop:${actionability.block.fingerprint}`),
                  title: "Routine frozen after repeated blocker loop",
                  description: buildFactoryGuardDescription({
                    routine: input.routine,
                    reason: "duplicate_loop_suppressed",
                    message: "Paperclip paused this routine after it produced the same blocker fingerprint three times.",
                    state: actionability.block.state,
                    blockerOwner: actionability.block.blockerOwner,
                    fingerprint: actionability.block.fingerprint,
                    details: {
                      duplicateCount,
                      originalReason: actionability.block.reason,
                      ...(actionability.block.details ?? {}),
                    },
                  }),
                  priority: "high" as const,
                },
              }
            : actionability.block;
          const standingIssueResult = systemSelfHealingBlock
            ? null
            : await ensureFactoryGuardIssue({
                routine: input.routine,
                projectId,
                block,
              }, txDb);
          if (standingIssueResult?.shouldWakeAssignee) {
            await queueIssueAssignmentWakeup({
              heartbeat,
              issue: standingIssueResult.issue,
              reason: "issue_assigned",
              mutation: standingIssueResult.created ? "create" : "update",
              contextSource: "routine.factory_guard",
              requestedByActorType: "system",
            });
          }
          if (routinePaused) {
            await pauseRoutineAndDisableTriggers({
              routineId: input.routine.id,
              reason: block.reason,
            }, txDb);
          }
          const preflightPayload = finalActionabilityPreflightPayload({
            block,
            duplicateCount,
            routinePaused,
            standingIssueId: standingIssueResult?.issue.id ?? null,
            selfHeal: selfHeal
              ? {
                  ...selfHeal,
                  nextRunAt: selfHeal.nextRunAt?.toISOString() ?? null,
                }
              : null,
          });
          const selfHealNextRunAt = selfHeal?.rescheduled ? selfHeal.nextRunAt : null;
          const updated = await finalizeRun(createdRun.id, {
            status: block.status,
            linkedIssueId: standingIssueResult?.issue.id ?? null,
            failureReason: block.reason,
            completedAt: triggeredAt,
            triggerPayload: addActionabilityPreflightPayload(triggerPayload, {
              ...preflightPayload,
              upstreamArtifactHash: actionability.contract?.upstreamArtifactHash ?? null,
              lane: actionability.contract?.lane ?? null,
              shipCaptain: actionability.contract?.shipCaptain ?? false,
              deterministicAdapterType: actionability.contract?.deterministicAdapterType ?? null,
              providerPolicyExcludedFamilies: actionability.contract?.providerPolicyExcludedFamilies ?? [],
            }),
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status: block.status,
            nextRunAt: selfHealNextRunAt ?? nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        try {
          const assigneeAdapterOverrides = assigneeAdapterOverridesFromContract(actionability.contract);
          createdIssue = await issueSvc.create(input.routine.companyId, {
            projectId,
            goalId: input.routine.goalId,
            parentId: input.routine.parentIssueId,
            title,
            description,
            status: "todo",
            priority: input.routine.priority,
            assigneeAgentId,
            originKind: "routine_execution",
            originId: input.routine.id,
            originRunId: createdRun.id,
            executionState: {
              paperclipFactoryGuard: {
                status: "agent_actionable",
                state: actionability.contract?.state ?? "ready_for_agent",
                blockerClass: actionability.contract?.blockerClass ?? "agent_actionable",
                blockerOwner: actionability.contract?.blockerOwner ?? "agent",
                lane: actionability.contract?.lane ?? null,
                shipCaptain: actionability.contract?.shipCaptain ?? false,
                fingerprint: actionability.fingerprint,
                upstreamArtifactHash: actionability.contract?.upstreamArtifactHash ?? null,
                providerPolicyExcludedFamilies:
                  actionability.contract?.providerPolicyExcludedFamilies ?? [],
              },
            },
            executionWorkspaceId: input.executionWorkspaceId ?? null,
            executionWorkspacePreference: input.executionWorkspacePreference ?? null,
            executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
            assigneeAdapterOverrides,
          });
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
          if (!isOpenExecutionConflict || input.routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue =
            await findLiveExecutionIssue(input.routine, txDb)
            ?? await findLiveExecutionIssueForFamily(input.routine, txDb);
          if (!existingIssue) throw error;
          await ensureRoutineIssueAssigneeAdapterOverrides({
            issue: existingIssue,
            contract: deterministicContract,
          }, txDb);
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
          triggerPayload: addActionabilityPreflightPayload(triggerPayload, {
            status: "passed",
            reason: "agent_actionable",
            state: actionability.contract?.state ?? "ready_for_agent",
            blockerClass: actionability.contract?.blockerClass ?? "agent_actionable",
            blockerOwner: actionability.contract?.blockerOwner ?? "agent",
            fingerprint: actionability.fingerprint,
            upstreamArtifactHash: actionability.contract?.upstreamArtifactHash ?? null,
            lane: actionability.contract?.lane ?? null,
            shipCaptain: actionability.contract?.shipCaptain ?? false,
            deterministicAdapterType: actionability.contract?.deterministicAdapterType ?? null,
            providerPolicyExcludedFamilies: actionability.contract?.providerPolicyExcludedFamilies ?? [],
            ...(actionability.providerCapacityRecoveryProbe
              ? { providerCapacityRecoveryProbe: actionability.providerCapacityRecoveryProbe }
              : {}),
          }),
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        return updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return failed ?? createdRun;
      }
    });

    if (!idempotencyReused && (input.source === "schedule" || input.source === "webhook")) {
      const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log automated routine run");
      }
    }

    const telemetryClient = getTelemetryClient();
    if (!idempotencyReused && telemetryClient) {
      trackRoutineRun(telemetryClient, {
        source: run.source,
        status: run.status,
      });
    }

    return { run, idempotencyReused };
  }

  return {
    get: getRoutineById,
    getTrigger: getTriggerById,

    list: async (companyId: string): Promise<RoutineListItem[]> => {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.companyId, companyId))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeIssueByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listLiveIssueByRoutineIds(companyId, routineIds),
      ]);
      return rows.map((row) => ({
        ...row,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeIssue: activeIssueByRoutine.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, triggers, recentRuns, activeIssue] = await Promise.all([
        row.projectId
          ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null)
          : null,
        row.assigneeAgentId
          ? db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null)
          : null,
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id)).orderBy(asc(routineTriggers.createdAt)),
        db
          .select({
            id: routineRuns.id,
            companyId: routineRuns.companyId,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            idempotencyKey: routineRuns.idempotencyKey,
            triggerPayload: routineRuns.triggerPayload,
            linkedIssueId: routineRuns.linkedIssueId,
            coalescedIntoRunId: routineRuns.coalescedIntoRunId,
            failureReason: routineRuns.failureReason,
            completedAt: routineRuns.completedAt,
            createdAt: routineRuns.createdAt,
            updatedAt: routineRuns.updatedAt,
            triggerKind: routineTriggers.kind,
            triggerLabel: routineTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(routineRuns)
          .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
          .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
          .where(eq(routineRuns.routineId, row.id))
          .orderBy(desc(routineRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              companyId: run.companyId,
              routineId: run.routineId,
              triggerId: run.triggerId,
              source: run.source as RoutineRunSummary["source"],
              status: run.status as RoutineRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Routine execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
      ]);

      return {
        ...row,
        project,
        assignee,
        parentIssue,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      await assertProject(companyId, input.projectId ?? null);
      await assertAssignableAgent(companyId, input.assigneeAgentId ?? null);
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const variables = syncRoutineVariablesWithTemplate(
        [input.title, input.description],
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const status = normalizeDraftRoutineStatus(input.status, input.assigneeAgentId);
      const [created] = await db
        .insert(routines)
        .values({
          companyId,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          title: input.title,
          description: input.description ?? null,
          assigneeAgentId: input.assigneeAgentId ?? null,
          priority: input.priority,
          status,
          concurrencyPolicy: input.concurrencyPolicy,
          catchUpPolicy: input.catchUpPolicy,
          variables,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      return created;
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId;
      const nextTitle = patch.title ?? existing.title;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const requestedStatus = patch.status ?? existing.status;
      if (patch.status === "active") {
        assertRoutineCanEnable(patch.status, nextAssigneeAgentId);
      }
      const nextStatus = patch.assigneeAgentId === undefined
        ? requestedStatus
        : normalizeDraftRoutineStatus(requestedStatus, nextAssigneeAgentId);
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.assigneeAgentId !== undefined) await assertAssignableAgent(existing.companyId, nextAssigneeAgentId);
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.companyId, patch.parentIssueId);
      assertRoutineVariableDefinitions(nextVariables);
      const enabledScheduleTriggers = await db
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.routineId, existing.id),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);
      if (enabledScheduleTriggers) {
        assertScheduleCompatibleVariables(nextVariables);
      }
      const [updated] = await db
        .update(routines)
        .set({
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? existing.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
          title: nextTitle,
          description: nextDescription,
          assigneeAgentId: nextAssigneeAgentId,
          priority: patch.priority ?? existing.priority,
          status: nextStatus,
          concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? existing.catchUpPolicy,
          variables: nextVariables,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routines.id, id))
        .returning();
      return updated ?? null;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        assertScheduleCompatibleVariables(routine.variables ?? []);
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        if ("scheduleIdentity" in input && input.scheduleIdentity != null) {
          throw unprocessable("Only scheduled triggers may carry a schedule identity");
        }
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const [trigger] = await db
        .insert(routineTriggers)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          kind: input.kind,
          label: input.label ?? null,
          enabled: input.enabled ?? true,
          cronExpression: input.kind === "schedule" ? input.cronExpression : null,
          timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
          scheduleIdentity: input.kind === "schedule" ? (input.scheduleIdentity ?? null) : null,
          nextRunAt,
          publicId,
          secretId,
          signingMode: input.kind === "webhook" ? input.signingMode : null,
          replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
          lastRotatedAt: input.kind === "webhook" ? new Date() : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial,
      };
    },

    updateTrigger: async (id: string, patch: UpdateRoutineTrigger, actor: Actor): Promise<RoutineTrigger | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;
      let scheduleIdentity = existing.scheduleIdentity;

      if (existing.kind === "schedule") {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
        if (patch.scheduleIdentity !== undefined) {
          scheduleIdentity = patch.scheduleIdentity;
        }
      } else if (patch.scheduleIdentity !== undefined) {
        throw unprocessable("Only scheduled triggers may carry a schedule identity");
      }

      const [updated] = await db
        .update(routineTriggers)
        .set({
          label: patch.label === undefined ? existing.label : patch.label,
          enabled: patch.enabled ?? existing.enabled,
          cronExpression,
          timezone,
          nextRunAt,
          scheduleIdentity,
          signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
          replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return (updated as RoutineTrigger | undefined) ?? null;
    },

    deleteTrigger: async (id: string): Promise<boolean> => {
      const existing = await getTriggerById(id);
      if (!existing) return false;
      await db.delete(routineTriggers).where(eq(routineTriggers.id, id));
      return true;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const [updated] = await db
        .update(routineTriggers)
        .set({
          lastRotatedAt: new Date(),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return {
        trigger: updated as RoutineTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
      };
    },

    runRoutine: async (id: string, input: RunRoutine) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      await assertAssignableAgent(routine.companyId, input.assigneeAgentId ?? null);
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      const dispatched = await dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
      });
      return dispatched.run;
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      hubSignatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        // Accept X-Hub-Signature-256 (GitHub/Sentry) or fall back to the
        // generic X-Paperclip-Signature header so operators can use github_hmac
        // mode with either header convention.
        const providedSignature = (input.hubSignatureHeader ?? input.signatureHeader)?.trim() ?? "";
        if (!providedSignature) throw unauthorized();
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const normalizedBuf = Buffer.from(normalizedSignature);
        const expectedBuf = Buffer.from(expectedHmac);
        const valid =
          normalizedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(normalizedBuf, expectedBuf);
        if (!valid) throw unauthorized();
      } else if (trigger.signingMode === "bearer") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      const dispatched = await dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        variables: isPlainRecord(input.payload) && isPlainRecord(input.payload.variables)
          ? input.payload.variables
          : null,
        idempotencyKey: input.idempotencyKey,
      });
      return dispatched.run;
    },

    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
          triggerKind: routineTriggers.kind,
          triggerLabel: routineTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(routineRuns)
        .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
        .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      const byStatus: Record<string, number> = {};
      const examples: Array<{
        routineId: string;
        routineTitle: string;
        runId: string;
        status: string;
        linkedIssueId?: string | null;
        coalescedIntoRunId?: string | null;
        failureReason?: string | null;
      }> = [];
      let triggered = 0;
      let enqueued = 0;
      let reused = 0;
      let coalesced = 0;
      let skipped = 0;
      let failed = 0;
      let blocked = 0;
      let other = 0;

      const recordRun = (
        routine: typeof routines.$inferSelect,
        run: typeof routineRuns.$inferSelect,
        idempotencyReused: boolean,
      ) => {
        triggered += 1;
        const status = idempotencyReused ? "reused" : (run.status || "unknown");
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        if (idempotencyReused) reused += 1;
        else if (status === "issue_created") enqueued += 1;
        else if (status === "coalesced") coalesced += 1;
        else if (status === "skipped") skipped += 1;
        else if (status === "failed") failed += 1;
        else if (status === "blocked") blocked += 1;
        else other += 1;

        if (examples.length < 20) {
          examples.push({
            routineId: routine.id,
            routineTitle: routine.title,
            runId: run.id,
            status,
            linkedIssueId: run.linkedIssueId,
            coalescedIntoRunId: run.coalescedIntoRunId,
            failureReason: run.failureReason,
          });
        }
      };

      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              isNotNull(routineTriggers.nextRunAt),
              lte(routineTriggers.nextRunAt, now),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        for (let i = 0; i < runCount; i += 1) {
          const dispatchIdentity = scheduledDispatchIdentity(row.trigger);
          const dispatched = await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            payload: dispatchIdentity?.payload ?? null,
            idempotencyKey: dispatchIdentity?.idempotencyKey ?? null,
          });
          recordRun(row.routine, dispatched.run, dispatched.idempotencyReused);
        }
      }

      return {
        checked: due.length,
        due: due.length,
        triggered,
        enqueued,
        reused,
        coalesced,
        skipped,
        failed,
        blocked,
        other,
        byStatus,
        examples,
      };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        const finalized = await finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
        await handoffRoutineChildIssuesAfterCompletion({ issue });
        return finalized;
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}
