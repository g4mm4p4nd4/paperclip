import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activityLog,
  agents,
  companies,
  createDb,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import { prepareTrustedReceiptDirectory } from "./trusted-receipt-directory.js";

const SCHEMA_VERSION = "paperclip.profit_flywheel_canary_fixture_setup.v1";
const SETUP_INTENT_SCHEMA_VERSION = "paperclip.profit_flywheel_canary_fixture_setup_intent.v1";
const ROLLBACK_SCHEMA_VERSION = "paperclip.profit_flywheel_canary_fixture_rollback.v1";
const AGENT_NAME = "Engineer-1";
const TARGET_REPO = "fixture/profit-canary";
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type JsonRecord = Record<string, unknown>;

export type CanaryFixtureSetupOptions = {
  companyId: string;
  engineerAgentId: string;
  runId: string;
  portfolioOsRoot: string;
  receiptDir: string;
};

export type CanaryFixtureRollbackOptions = {
  setupReceiptPath: string;
  receiptDir: string;
};

type CanaryFixtureSetupDependencies = {
  now?: () => Date;
  afterDatabaseMutationBeforeFinalReceipt?: () => void | Promise<void>;
  writeFinalReceipt?: typeof writeImmutableJsonReceipt;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value as JsonRecord)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry))
    .join(",") + "}";
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicCanaryFixtureUuid(seed: string) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function canonicalUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error("profit_canary_fixture_" + label + "_invalid");
  return normalized;
}

function canonicalRunId(value: string) {
  const normalized = value.trim();
  if (!SAFE_RUN_ID.test(normalized) || normalized === "." || normalized === ".." || normalized.includes("..")) {
    throw new Error("profit_canary_fixture_run_id_invalid");
  }
  return normalized;
}

async function requireTrustedSourceDirectory(value: string, label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    throw new Error("profit_canary_fixture_" + label + "_invalid");
  }
  const metadata = await lstat(value).catch(() => null);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() ||
      (currentUid !== null && metadata.uid !== currentUid) || (metadata.mode & 0o022) !== 0) {
    throw new Error("profit_canary_fixture_" + label + "_unsafe");
  }
  return realpath(value);
}

async function readImmutableJson(pathValue: string, label: string) {
  if (!path.isAbsolute(pathValue) || path.resolve(pathValue) !== pathValue) {
    throw new Error("profit_canary_fixture_" + label + "_path_invalid");
  }
  const metadata = await lstat(pathValue).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o444 ||
      metadata.size < 2 || metadata.size > 1024 * 1024) {
    throw new Error("profit_canary_fixture_" + label + "_immutable_invalid");
  }
  const canonical = await realpath(pathValue);
  if (canonical !== pathValue) throw new Error("profit_canary_fixture_" + label + "_symlink_invalid");
  const bytes = await readFile(canonical);
  const after = await lstat(canonical);
  if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs || (after.mode & 0o777) !== 0o444) {
    throw new Error("profit_canary_fixture_" + label + "_changed");
  }
  let value: JsonRecord;
  try {
    value = JSON.parse(bytes.toString("utf8")) as JsonRecord;
  } catch {
    throw new Error("profit_canary_fixture_" + label + "_json_invalid");
  }
  return { path: canonical, sha256: sha256(bytes), value };
}

export function canaryFixtureIdentity(companyId: string, runId: string) {
  return {
    projectId: deterministicCanaryFixtureUuid("paperclip:profit-canary:project:v1:" + companyId + ":" + runId),
    workspaceId: deterministicCanaryFixtureUuid("paperclip:profit-canary:workspace:v1:" + companyId + ":" + runId),
  };
}

function fixtureMetadata(input: {
  companyId: string;
  engineerAgentId: string;
  runId: string;
  projectId: string;
  workspaceId: string;
  targetWorkspace: string;
  targetOrigin: string;
  setupAt: string;
  priorAgentStatus: string;
}) {
  return {
    schema_version: SCHEMA_VERSION,
    company_id: input.companyId,
    run_id: input.runId,
    correlation_id: "profit-canary:" + input.runId,
    project_id: input.projectId,
    workspace_id: input.workspaceId,
    target_repo: TARGET_REPO,
    target_workspace: input.targetWorkspace,
    target_origin: input.targetOrigin,
    engineer_agent_id: input.engineerAgentId,
    engineer_agent_name: AGENT_NAME,
    prior_agent_status: input.priorAgentStatus,
    resumed_by_setup: input.priorAgentStatus === "paused",
    setup_at: input.setupAt,
  };
}

function exactProjectProjection(input: ReturnType<typeof fixtureMetadata>) {
  return {
    id: input.project_id,
    companyId: input.company_id,
    name: "Profit Flywheel Canary " + input.run_id,
    description: "Run-bound work-bearing Profit Flywheel fixture for " + input.correlation_id,
    status: "in_progress",
    leadAgentId: input.engineer_agent_id,
  };
}

function exactWorkspaceProjection(input: ReturnType<typeof fixtureMetadata>) {
  return {
    id: input.workspace_id,
    companyId: input.company_id,
    projectId: input.project_id,
    name: "profit-canary-" + input.run_id + "-primary",
    sourceType: "local_path",
    cwd: input.target_workspace,
    repoUrl: pathToFileURL(input.target_origin).href,
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    metadata: { profit_flywheel_canary_fixture: input },
    isPrimary: true,
  };
}

function assertExactSubset(observed: JsonRecord, expected: JsonRecord, label: string) {
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJson(observed[key]) !== canonicalJson(value)) {
      throw new Error("profit_canary_fixture_" + label + "_conflict:" + key);
    }
  }
}

async function existingReceiptOrNull(receiptPath: string, label = "setup_receipt") {
  const metadata = await lstat(receiptPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata ? readImmutableJson(receiptPath, label) : null;
}

function buildSetupReceiptCore(
  metadata: ReturnType<typeof fixtureMetadata>,
  receiptPath: string,
  receiptDir: string,
) {
  return {
    ...metadata,
    project: {
      ...exactProjectProjection(metadata),
      executionWorkspacePolicy: {
        workspaceStrategy: { type: "project_primary" },
        profitFlywheelCanaryFixture: metadata,
      },
    },
    primary_workspace: exactWorkspaceProjection(metadata),
    resulting_agent_status: "idle",
    rollback: {
      command: "pnpm",
      argv: [
        "ops:profit-flywheel-canary-fixture", "--", "rollback",
        "--setup-receipt", receiptPath, "--receipt-dir", receiptDir,
      ],
      effect: metadata.resumed_by_setup
        ? "re-pause Engineer-1 after safe state verification"
        : "leave pre-existing idle status unchanged",
    },
    secrets_in_argv: false,
    database_url_accepted: false,
    immutable: true,
  };
}

function buildSetupIntent(
  metadata: ReturnType<typeof fixtureMetadata>,
  receiptPath: string,
  intentPath: string,
  setupReceiptCore: ReturnType<typeof buildSetupReceiptCore>,
) {
  return {
    schema_version: SETUP_INTENT_SCHEMA_VERSION,
    operation: "profit_flywheel_canary_fixture_setup",
    phase: "prepared",
    prepared_at: metadata.setup_at,
    company_id: metadata.company_id,
    run_id: metadata.run_id,
    project_id: metadata.project_id,
    workspace_id: metadata.workspace_id,
    engineer_agent_id: metadata.engineer_agent_id,
    fixture: metadata,
    final_receipt_path: receiptPath,
    intent_path: intentPath,
    planned_setup_core_sha256: sha256(canonicalJson(setupReceiptCore)),
    recovery: {
      action: "rerun setup with the identical arguments",
      behavior: "verify or finish the pinned database mutation, then install the final receipt",
    },
    immutable: true,
  };
}

function recordedFixture(
  value: JsonRecord,
  expected: {
    companyId: string;
    engineerAgentId: string;
    runId: string;
    projectId: string;
    workspaceId: string;
    targetWorkspace: string;
    targetOrigin: string;
  },
  blocker: string,
) {
  const priorAgentStatus = value.prior_agent_status;
  const setupAt = value.setup_at;
  if ((priorAgentStatus !== "paused" && priorAgentStatus !== "idle") || typeof setupAt !== "string") {
    throw new Error(blocker);
  }
  const parsedSetupAt = new Date(setupAt);
  if (!Number.isFinite(parsedSetupAt.getTime()) || parsedSetupAt.toISOString() !== setupAt) {
    throw new Error(blocker);
  }
  const metadata = fixtureMetadata({
    ...expected,
    setupAt,
    priorAgentStatus,
  });
  try {
    assertExactSubset(value, metadata, "recorded_fixture");
  } catch {
    throw new Error(blocker);
  }
  return metadata;
}

function assertExactReceipt(value: JsonRecord, expected: unknown, blocker: string) {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error(blocker);
}

async function ensureImmutableReceipt(
  receiptPath: string,
  value: unknown,
  label: string,
  writer: typeof writeImmutableJsonReceipt = writeImmutableJsonReceipt,
) {
  const existing = await existingReceiptOrNull(receiptPath, label);
  if (existing) {
    assertExactReceipt(existing.value, value, "profit_canary_fixture_" + label + "_conflict");
    return existing.sha256;
  }
  try {
    return await writer(receiptPath, value);
  } catch (error) {
    // A durable link may have succeeded even if acknowledgement failed, or a
    // concurrent identical replay may have won O_EXCL. Accept only exact bytes.
    const installed = await existingReceiptOrNull(receiptPath, label);
    if (!installed) throw error;
    assertExactReceipt(installed.value, value, "profit_canary_fixture_" + label + "_conflict");
    return installed.sha256;
  }
}

export async function setupProfitFlywheelCanaryFixture(
  db: Db,
  options: CanaryFixtureSetupOptions,
  dependencies: CanaryFixtureSetupDependencies = {},
) {
  const companyId = canonicalUuid(options.companyId, "company_id");
  const engineerAgentId = canonicalUuid(options.engineerAgentId, "engineer_agent_id");
  const runId = canonicalRunId(options.runId);
  const portfolioOsRoot = await requireTrustedSourceDirectory(options.portfolioOsRoot, "portfolio_os_root");
  const receiptDir = await prepareTrustedReceiptDirectory(
    options.receiptDir,
    "profit_canary_fixture_receipt_dir",
  );
  const { projectId, workspaceId } = canaryFixtureIdentity(companyId, runId);
  const targetWorkspace = path.join(portfolioOsRoot, "data", "canary_runs", runId, "target", "profit-canary");
  const targetOrigin = path.join(portfolioOsRoot, "data", "canary_runs", runId, "target", "origin.git");
  const receiptPath = path.join(receiptDir, runId + "-fixture-setup.json");
  const intentPath = path.join(receiptDir, runId + "-fixture-setup-intent.json");
  const coordinates = {
    companyId,
    engineerAgentId,
    runId,
    projectId,
    workspaceId,
    targetWorkspace,
    targetOrigin,
  };

  // A final receipt is completion authority. Reject a conflicting occupant
  // before entering a write transaction. Valid legacy receipts (created before
  // setup intents existed) remain replayable only when their database rows are
  // already present and exact.
  const finalBeforeTransaction = await existingReceiptOrNull(receiptPath);
  let finalPlanBeforeTransaction: {
    metadata: ReturnType<typeof fixtureMetadata>;
    receipt: JsonRecord;
    receiptSha256: string;
    intentSha256: string | null;
  } | null = null;
  if (finalBeforeTransaction) {
    const metadata = recordedFixture(
      finalBeforeTransaction.value,
      coordinates,
      "profit_canary_fixture_setup_receipt_conflict",
    );
    const core = buildSetupReceiptCore(metadata, receiptPath, receiptDir);
    const binding = finalBeforeTransaction.value.setup_intent;
    let expectedReceipt: JsonRecord = core;
    let intentSha256: string | null = null;
    if (binding !== undefined) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error("profit_canary_fixture_setup_receipt_conflict");
      }
      const bindingRecord = binding as JsonRecord;
      if (bindingRecord.path !== intentPath || typeof bindingRecord.sha256 !== "string") {
        throw new Error("profit_canary_fixture_setup_receipt_conflict");
      }
      const intent = await existingReceiptOrNull(intentPath, "setup_intent");
      if (!intent || intent.sha256 !== bindingRecord.sha256) {
        throw new Error("profit_canary_fixture_setup_receipt_conflict");
      }
      const expectedIntent = buildSetupIntent(metadata, receiptPath, intentPath, core);
      assertExactReceipt(
        intent.value,
        expectedIntent,
        "profit_canary_fixture_setup_intent_conflict",
      );
      intentSha256 = intent.sha256;
      expectedReceipt = { ...core, setup_intent: { path: intentPath, sha256: intent.sha256 } };
    }
    assertExactReceipt(
      finalBeforeTransaction.value,
      expectedReceipt,
      "profit_canary_fixture_setup_receipt_conflict",
    );
    finalPlanBeforeTransaction = {
      metadata,
      receipt: expectedReceipt,
      receiptSha256: finalBeforeTransaction.sha256,
      intentSha256,
    };
  }

  const intentBeforeTransaction = finalPlanBeforeTransaction
    ? null
    : await existingReceiptOrNull(intentPath, "setup_intent");

  const transactionResult = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const company = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("update").then((rows) => rows[0] ?? null);
    if (!company) throw new Error("profit_canary_fixture_company_missing");
    const engineer = await tx.select().from(agents).where(and(
      eq(agents.id, engineerAgentId),
      eq(agents.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!engineer || engineer.name !== AGENT_NAME) {
      throw new Error("profit_canary_fixture_engineer_identity_mismatch");
    }
    if (!["paused", "idle"].includes(engineer.status)) {
      throw new Error("profit_canary_fixture_engineer_not_safely_resumable");
    }

    const existingProject = await tx.select().from(projects).where(and(
      eq(projects.id, projectId),
      eq(projects.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    const existingWorkspace = await tx.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, workspaceId),
      eq(projectWorkspaces.companyId, companyId),
      eq(projectWorkspaces.projectId, projectId),
    )).for("update").then((rows) => rows[0] ?? null);
    const policy = existingProject?.executionWorkspacePolicy;
    const persistedFixture = policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as JsonRecord).profitFlywheelCanaryFixture as JsonRecord | undefined
      : undefined;
    let fixture: ReturnType<typeof fixtureMetadata>;
    if (finalPlanBeforeTransaction) {
      fixture = finalPlanBeforeTransaction.metadata;
    } else if (intentBeforeTransaction) {
      const intentFixture = intentBeforeTransaction.value.fixture;
      if (!intentFixture || typeof intentFixture !== "object" || Array.isArray(intentFixture)) {
        throw new Error("profit_canary_fixture_setup_intent_conflict");
      }
      fixture = recordedFixture(
        intentFixture as JsonRecord,
        coordinates,
        "profit_canary_fixture_setup_intent_conflict",
      );
    } else if (persistedFixture) {
      fixture = recordedFixture(
        persistedFixture,
        coordinates,
        "profit_canary_fixture_project_conflict:executionWorkspacePolicy",
      );
    } else {
      const setupAt = (dependencies.now?.() ?? new Date()).toISOString();
      fixture = fixtureMetadata({
        ...coordinates,
        setupAt,
        priorAgentStatus: engineer.status,
      });
    }
    if (fixture.prior_agent_status === "idle" && engineer.status !== "idle") {
      throw new Error("profit_canary_fixture_engineer_status_conflict");
    }

    const setupReceiptCore = buildSetupReceiptCore(fixture, receiptPath, receiptDir);
    let setupReceipt: JsonRecord;
    let intentSha256: string | null;
    if (finalPlanBeforeTransaction) {
      setupReceipt = finalPlanBeforeTransaction.receipt;
      intentSha256 = finalPlanBeforeTransaction.intentSha256;
    } else {
      const setupIntent = buildSetupIntent(
        fixture,
        receiptPath,
        intentPath,
        setupReceiptCore,
      );
      if (intentBeforeTransaction) {
        assertExactReceipt(
          intentBeforeTransaction.value,
          setupIntent,
          "profit_canary_fixture_setup_intent_conflict",
        );
        intentSha256 = intentBeforeTransaction.sha256;
      } else {
        // This fsynced immutable intent is deliberately installed while the
        // rows are locked but before the first database mutation. A crash
        // therefore leaves either no mutation or a deterministic recovery key.
        intentSha256 = await ensureImmutableReceipt(intentPath, setupIntent, "setup_intent");
      }
      setupReceipt = {
        ...setupReceiptCore,
        setup_intent: { path: intentPath, sha256: intentSha256 },
      };
      const racedFinal = await existingReceiptOrNull(receiptPath);
      if (racedFinal) {
        assertExactReceipt(
          racedFinal.value,
          setupReceipt,
          "profit_canary_fixture_setup_receipt_conflict",
        );
      }
    }

    if (finalPlanBeforeTransaction && (!existingProject || !existingWorkspace)) {
      throw new Error("profit_canary_fixture_setup_receipt_conflict");
    }
    if (!finalPlanBeforeTransaction) {
      if (Boolean(existingProject) !== Boolean(existingWorkspace)) {
        throw new Error("profit_canary_fixture_partial_database_state_conflict");
      }
      if (!existingProject && engineer.status !== fixture.prior_agent_status) {
        throw new Error("profit_canary_fixture_engineer_status_conflict");
      }
      if (existingProject && fixture.prior_agent_status === "paused" && engineer.status !== "idle") {
        throw new Error("profit_canary_fixture_recovery_state_conflict");
      }
    }

    const expectedProject = exactProjectProjection(fixture);
    const executionWorkspacePolicy = {
      workspaceStrategy: { type: "project_primary" },
      profitFlywheelCanaryFixture: fixture,
    };
    if (existingProject) {
      assertExactSubset(existingProject as unknown as JsonRecord, {
        ...expectedProject,
        executionWorkspacePolicy,
      }, "project");
    } else {
      if (finalPlanBeforeTransaction) {
        throw new Error("profit_canary_fixture_setup_receipt_conflict");
      }
      await tx.insert(projects).values({ ...expectedProject, executionWorkspacePolicy });
    }

    const expectedWorkspace = exactWorkspaceProjection(fixture);
    if (existingWorkspace) {
      assertExactSubset(existingWorkspace as unknown as JsonRecord, expectedWorkspace, "workspace");
    } else {
      if (finalPlanBeforeTransaction) {
        throw new Error("profit_canary_fixture_setup_receipt_conflict");
      }
      const otherPrimary = await tx.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
        eq(projectWorkspaces.isPrimary, true),
      )).then((rows) => rows[0] ?? null);
      if (otherPrimary) throw new Error("profit_canary_fixture_primary_workspace_conflict");
      await tx.insert(projectWorkspaces).values(expectedWorkspace);
    }

    if (engineer.status === "paused") {
      await tx.update(agents).set({
        status: "idle",
        pauseReason: null,
        pausedAt: null,
        updatedAt: new Date(fixture.setup_at),
      }).where(and(eq(agents.id, engineerAgentId), eq(agents.companyId, companyId), eq(agents.status, "paused")));
      await tx.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "profit-flywheel-canary-fixture-operator",
        action: "agent.resumed_for_profit_canary",
        entityType: "agent",
        entityId: engineerAgentId,
        agentId: engineerAgentId,
        details: { run_id: runId, project_id: projectId, prior_status: fixture.prior_agent_status },
        createdAt: new Date(fixture.setup_at),
      });
    }
    return { metadata: fixture, setupReceipt, intentSha256 };
  }, { isolationLevel: "serializable", accessMode: "read write" });

  if (!finalPlanBeforeTransaction) {
    await dependencies.afterDatabaseMutationBeforeFinalReceipt?.();
  }
  const receiptSha256 = finalPlanBeforeTransaction?.receiptSha256 ?? await ensureImmutableReceipt(
    receiptPath,
    transactionResult.setupReceipt,
    "setup_receipt",
    dependencies.writeFinalReceipt,
  );
  return {
    status: "ready" as const,
    projectId,
    workspaceId,
    targetWorkspace,
    targetOrigin,
    receiptPath,
    receiptSha256,
    setupIntentPath: transactionResult.intentSha256 ? intentPath : null,
    setupIntentSha256: transactionResult.intentSha256,
    priorAgentStatus: transactionResult.metadata.prior_agent_status,
  };
}

export async function rollbackProfitFlywheelCanaryFixture(
  db: Db,
  options: CanaryFixtureRollbackOptions,
  dependencies: { now?: () => Date } = {},
) {
  const setup = await readImmutableJson(options.setupReceiptPath, "setup_receipt");
  const receiptDir = await prepareTrustedReceiptDirectory(
    options.receiptDir,
    "profit_canary_fixture_receipt_dir",
  );
  const value = setup.value;
  if (value.schema_version !== SCHEMA_VERSION || value.immutable !== true ||
      value.engineer_agent_name !== AGENT_NAME) {
    throw new Error("profit_canary_fixture_setup_receipt_contract_invalid");
  }
  const companyId = canonicalUuid(String(value.company_id ?? ""), "company_id");
  const engineerAgentId = canonicalUuid(String(value.engineer_agent_id ?? ""), "engineer_agent_id");
  const projectId = canonicalUuid(String(value.project_id ?? ""), "project_id");
  const workspaceId = canonicalUuid(String(value.workspace_id ?? ""), "workspace_id");
  const runId = canonicalRunId(String(value.run_id ?? ""));
  const shouldRepause = value.resumed_by_setup === true && value.prior_agent_status === "paused";
  const rolledBackAt = (dependencies.now?.() ?? new Date()).toISOString();

  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const project = await tx.select().from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    const workspace = await tx.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, workspaceId), eq(projectWorkspaces.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    const engineer = await tx.select().from(agents).where(and(
      eq(agents.id, engineerAgentId), eq(agents.companyId, companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!project || !workspace || !engineer || engineer.name !== AGENT_NAME) {
      throw new Error("profit_canary_fixture_rollback_identity_missing");
    }
    assertExactSubset(project as unknown as JsonRecord, value.project as JsonRecord, "rollback_project");
    assertExactSubset(workspace as unknown as JsonRecord, value.primary_workspace as JsonRecord, "rollback_workspace");
    // `error` is terminal: the heartbeat runner has already released the agent.
    // Rollback must still reject genuinely active states such as `running`.
    if (!["idle", "paused", "error"].includes(engineer.status)) {
      throw new Error("profit_canary_fixture_rollback_agent_busy");
    }
    const changed = shouldRepause && ["idle", "error"].includes(engineer.status);
    if (changed) {
      await tx.update(agents).set({
        status: "paused",
        pauseReason: "Profit Flywheel canary " + runId + " completed; restored pre-canary status",
        pausedAt: new Date(rolledBackAt),
        updatedAt: new Date(rolledBackAt),
      }).where(and(eq(agents.id, engineerAgentId), eq(agents.companyId, companyId), inArray(agents.status, ["idle", "error"])));
      await tx.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "profit-flywheel-canary-fixture-operator",
        action: "agent.repaused_after_profit_canary",
        entityType: "agent",
        entityId: engineerAgentId,
        agentId: engineerAgentId,
        details: { run_id: runId, project_id: projectId, restored_status: "paused" },
        createdAt: new Date(rolledBackAt),
      });
    }
    return {
      prior_status: value.prior_agent_status,
      resulting_status: shouldRepause ? "paused" : engineer.status,
      changed,
    };
  }, { isolationLevel: "serializable", accessMode: "read write" });

  const receipt = {
    schema_version: ROLLBACK_SCHEMA_VERSION,
    setup_receipt: { path: setup.path, sha256: setup.sha256 },
    company_id: companyId,
    project_id: projectId,
    workspace_id: workspaceId,
    run_id: runId,
    engineer_agent_id: engineerAgentId,
    engineer_agent_name: AGENT_NAME,
    rolled_back_at: rolledBackAt,
    result,
    project_and_workspace_preserved: true,
    secrets_in_argv: false,
    immutable: true,
  };
  const receiptPath = path.join(
    receiptDir,
    runId + "-fixture-rollback-" + rolledBackAt.replace(/[-:.]/g, "") + ".json",
  );
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return { status: "safe" as const, receiptPath, receiptSha256, result };
}

export function parseCanaryFixtureCliArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.DATABASE_URL?.trim() || environment.POSTGRES_URL?.trim()) {
    throw new Error("profit_canary_fixture_database_url_forbidden");
  }
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const action = args.shift();
  if (action !== "setup" && action !== "rollback") {
    throw new Error("profit_canary_fixture_action_required");
  }
  const allowed = action === "setup"
    ? new Set(["--company-id", "--engineer-agent-id", "--run-id", "--portfolio-os-root", "--receipt-dir"])
    : new Set(["--setup-receipt", "--receipt-dir"]);
  const forbidden = /(?:credential|password|secret|token|api-key|database-url|postgres-url|connection-string)/i;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (forbidden.test(flag)) throw new Error("profit_canary_fixture_credential_argv_forbidden");
    if (!allowed.has(flag) || flag.includes("=") || values.has(flag)) {
      throw new Error("profit_canary_fixture_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("profit_canary_fixture_argument_missing:" + flag);
    }
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) {
    if (!values.has(flag)) throw new Error("profit_canary_fixture_argument_required:" + flag);
  }
  return action === "setup"
    ? {
        action,
        options: {
          companyId: values.get("--company-id")!,
          engineerAgentId: values.get("--engineer-agent-id")!,
          runId: values.get("--run-id")!,
          portfolioOsRoot: values.get("--portfolio-os-root")!,
          receiptDir: values.get("--receipt-dir")!,
        } satisfies CanaryFixtureSetupOptions,
      }
    : {
        action,
        options: {
          setupReceiptPath: values.get("--setup-receipt")!,
          receiptDir: values.get("--receipt-dir")!,
        } satisfies CanaryFixtureRollbackOptions,
      };
}

export function resolveEmbeddedCanaryFixtureConnection(config: {
  databaseMode: string;
  embeddedPostgresPort: number;
}) {
  if (config.databaseMode !== "embedded-postgres") {
    throw new Error("profit_canary_fixture_embedded_instance_required");
  }
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("profit_canary_fixture_embedded_port_invalid");
  }
  return "postgres://paperclip:paperclip@127.0.0.1:" + port + "/paperclip";
}

function usage() {
  return [
    "Usage:",
    "  pnpm ops:profit-flywheel-canary-fixture -- setup --company-id <uuid> --engineer-agent-id <uuid> --run-id <id> --portfolio-os-root <absolute-path> --receipt-dir <precreated-safe-dir>",
    "  pnpm ops:profit-flywheel-canary-fixture -- rollback --setup-receipt <immutable-setup-receipt> --receipt-dir <precreated-safe-dir>",
    "",
    "The operator selects PAPERCLIP_HOME/PAPERCLIP_INSTANCE_ID through normal config loading, requires embedded PostgreSQL, and rejects DB URLs and credentials.",
  ].join("\n");
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const parsed = parseCanaryFixtureCliArgs(process.argv.slice(2));
  const { loadConfig } = await import("../config.js");
  const db = createDb(resolveEmbeddedCanaryFixtureConnection(loadConfig()));
  try {
    const result = parsed.action === "setup"
      ? await setupProfitFlywheelCanaryFixture(db, parsed.options as CanaryFixtureSetupOptions)
      : await rollbackProfitFlywheelCanaryFixture(db, parsed.options as CanaryFixtureRollbackOptions);
    console.log(JSON.stringify(result));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "profit_canary_fixture_unknown_failure",
    }));
    process.exit(1);
  });
}
