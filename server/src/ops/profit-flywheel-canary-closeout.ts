import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDb,
  issues,
  projectWorkspaces,
  profitFlywheelEvents,
  profitFlywheelReceipts,
  profitFlywheelStageRuns,
  profitFlywheelWorkflows,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  parsePortfolioOsProfitFlywheelContractV2,
  type PortfolioOsProfitFlywheelContractV2,
  type ProfitFlywheelStage,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import {
  assertCompletionEvidence,
  buildProfitFlywheelIdempotencyKey,
  buildProfitFlywheelStageInput,
  canonicalDbReceiptProof,
  hashProfitFlywheelValue,
  validateDispatchEvidence,
  validatePinnedResearchArtifactSchema,
  validateReceiptTypeAttributes,
  verifyArtifactReference,
  workflowArtifactRoots,
} from "../services/profit-flywheel.js";
import {
  loadProfitFlywheelContract,
  PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256,
  PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256,
} from "../services/profit-flywheel-contract.js";
import { canaryFixtureIdentity } from "./profit-flywheel-canary-fixture.js";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  readTrustedJsonFile,
  requireTrustedDirectory,
} from "./trusted-receipt-directory.js";

const execFile = promisify(execFileCallback);
const SCHEMA_VERSION = "paperclip.profit_flywheel_canary_closeout.v1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

type JsonRecord = Record<string, unknown>;
type StageName = "dispatch" | "implementation" | "qa" | "release" | "commercial_observation" | "learning" | "research_intake";

export type ProfitFlywheelCanaryCloseoutOptions = {
  companyId: string;
  runId: string;
  correlationId: string;
  projectId: string;
  workflowId: string;
  issueId: string;
  implementationStageRunId: string;
  qaStageRunId: string;
  releaseStageRunId: string;
  observationStageRunId: string;
  learningStageRunId: string;
  nextResearchStageRunId: string;
  setupReceiptPath: string;
  promotionReceiptPath: string;
  receiptDir: string;
};

type CloseoutDependencies = {
  now?: () => Date;
  afterSnapshotEstablished?: () => Promise<void>;
  completionEvidenceValidator?: typeof assertCompletionEvidence;
  dispatchEvidenceValidator?: typeof validateDispatchEvidence;
  contractLoader?: typeof loadProfitFlywheelContract;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sameJson(left: unknown, right: unknown) {
  return hashProfitFlywheelValue(left) === hashProfitFlywheelValue(right);
}

const SAFE_GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
};

function canonicalUuid(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error("profit_canary_closeout_" + label + "_invalid");
  return normalized;
}

function canonicalBoundedId(value: string, label: string) {
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized) || normalized.includes("..")) {
    throw new Error("profit_canary_closeout_" + label + "_invalid");
  }
  return normalized;
}

function requireString(record: JsonRecord, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("profit_canary_closeout_" + label + "_" + key + "_missing");
  }
  return value.trim();
}

function requireSha(record: JsonRecord, key: string, label: string) {
  const value = requireString(record, key, label).replace(/^sha256:/, "").toLowerCase();
  if (!SHA256.test(value)) throw new Error("profit_canary_closeout_" + label + "_" + key + "_invalid");
  return value;
}

function requirePassingTests(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("profit_canary_closeout_" + label + "_tests_missing");
  }
  return value.map((entry, index) => {
    const result = asRecord(entry);
    const command = requireString(result, "command", label + "_test_" + index);
    const artifactRef = requireString(result, "artifact_ref", label + "_test_" + index);
    const artifactHash = requireSha(result, "artifact_hash", label + "_test_" + index);
    if (result.exit_code !== 0 || result.status !== "passed") {
      throw new Error("profit_canary_closeout_" + label + "_test_failed");
    }
    return { command, exit_code: 0, status: "passed", artifact_ref: artifactRef, artifact_hash: artifactHash };
  });
}

function stageIdentity(
  stage: typeof profitFlywheelStageRuns.$inferSelect,
  options: { requireOutputHash?: boolean } = {},
) {
  const feedback = asRecord(stage.feedback);
  const outputHash = options.requireOutputHash === false
    ? (typeof feedback.output_hash === "string" && SHA256.test(feedback.output_hash) ? feedback.output_hash : null)
    : requireSha(feedback, "output_hash", stage.stage);
  return {
    id: stage.id,
    stage: stage.stage,
    state: stage.state,
    owner_plane: stage.ownerPlane,
    input_hash: stage.inputHash,
    output_hash: outputHash,
    linked_issue_id: stage.linkedIssueId,
    transition_source_stage_run_id: stage.transitionSourceStageRunId,
    transition_source_output_hash: stage.transitionSourceOutputHash,
    provider: stage.providerRouteId ? {
      route_id: stage.providerRouteId,
      family: stage.providerFamily,
      model: stage.providerModel,
      version: stage.providerModelVersion,
      policy_sha256: stage.providerPolicySha256,
      route_core_sha256: stage.providerRouteCoreSha256,
      route_sha256: stage.providerRouteSha256,
    } : null,
    attempt: stage.attemptCount,
    started_at: stage.startedAt?.toISOString() ?? null,
    completed_at: stage.completedAt?.toISOString() ?? null,
  };
}

function assertStage(input: {
  stage: typeof profitFlywheelStageRuns.$inferSelect | undefined;
  expectedName: StageName;
  expectedId: string;
  workflowId: string;
  companyId: string;
  issueId?: string;
  expectedSource?: typeof profitFlywheelStageRuns.$inferSelect;
}) {
  const stage = input.stage;
  if (!stage || stage.id !== input.expectedId || stage.stage !== input.expectedName ||
      stage.workflowId !== input.workflowId || stage.companyId !== input.companyId) {
    throw new Error("profit_canary_closeout_" + input.expectedName + "_identity_mismatch");
  }
  if (input.expectedName === "research_intake") {
    if (stage.state !== "pending" || stage.ownerPlane !== "portfolio_os" || stage.attemptCount !== 0 ||
        stage.leaseOwner || stage.blockerCode || stage.completedAt) {
      throw new Error("profit_canary_closeout_next_research_not_pending");
    }
  } else if (stage.state !== "succeeded" || !stage.startedAt || !stage.completedAt || stage.blockerCode) {
    throw new Error("profit_canary_closeout_" + input.expectedName + "_incomplete");
  }
  if (input.issueId && stage.linkedIssueId !== input.issueId) {
    throw new Error("profit_canary_closeout_" + input.expectedName + "_issue_mismatch");
  }
  if (input.expectedSource) {
    const outputHash = requireSha(asRecord(input.expectedSource.feedback), "output_hash", input.expectedSource.stage);
    if (stage.transitionSourceStageRunId !== input.expectedSource.id ||
        stage.transitionSourceOutputHash !== outputHash) {
      throw new Error("profit_canary_closeout_" + input.expectedName + "_lineage_mismatch");
    }
  }
  return stage;
}

function assertCanonicalStageDefinition(
  stage: typeof profitFlywheelStageRuns.$inferSelect,
  workflow: typeof profitFlywheelWorkflows.$inferSelect,
  contract: PortfolioOsProfitFlywheelContractV2,
) {
  const stageName = stage.stage as ProfitFlywheelStage;
  const definition = contract.stages[stageName];
  if (!definition) throw new Error("profit_canary_closeout_stage_not_in_contract");
  const canonicalInput = buildProfitFlywheelStageInput({
    contract,
    stage: stageName,
    sourceHashes: stage.sourceHashes,
  });
  const expectedIdempotencyKey = buildProfitFlywheelIdempotencyKey({
    companyId: workflow.companyId,
    runId: workflow.runId,
    stage: stageName,
    inputHash: canonicalInput.inputHash,
  });
  if (stage.ownerPlane !== definition.owner_plane ||
      stage.inputSchemaVersion !== definition.input_schema ||
      stage.inputHash !== canonicalInput.inputHash ||
      stage.idempotencyKey !== expectedIdempotencyKey ||
      stage.maxAttempts !== Math.max(1, definition.retry.limit + 1) ||
      stage.providerCapabilityClass !== definition.provider_capability_class ||
      stage.concurrencyKey !== definition.concurrency_key ||
      stage.concurrencyLimit !== definition.concurrency_limit ||
      !sameJson(stage.requiredReceipts, definition.required_receipts) ||
      !sameJson(stage.completionEvidence, definition.completion_evidence) ||
      stage.correlationId !== workflow.correlationId || stage.traceId !== workflow.traceId) {
    throw new Error("profit_canary_closeout_" + stage.stage + "_contract_drift");
  }
}

function assertLocalReleaseAuthorityBeforeCompletion(
  workflow: typeof profitFlywheelWorkflows.$inferSelect,
  releaseStage: typeof profitFlywheelStageRuns.$inferSelect,
  receipts: Array<typeof profitFlywheelReceipts.$inferSelect>,
) {
  const expectedOrigin = requireString(asRecord(workflow.feedback), "target_origin_url", "workflow_feedback");
  const candidates = receipts.filter((receipt) =>
    receipt.stageRunId === releaseStage.id && receipt.receiptType === "release_receipt");
  if (candidates.length !== 1) throw new Error("profit_canary_closeout_release_receipt_ambiguous");
  const attributes = asRecord(candidates[0]!.attributes);
  const remoteOrigin = requireString(attributes, "remote_origin_url", "release_receipt");
  const remoteRef = requireString(attributes, "remote_ref", "release_receipt");
  let parsed: URL;
  try {
    parsed = new URL(remoteOrigin);
  } catch {
    throw new Error("profit_canary_closeout_release_origin_invalid");
  }
  if (remoteOrigin !== expectedOrigin || parsed.protocol !== "file:" || parsed.host ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      !path.isAbsolute(fileURLToPath(parsed)) || remoteRef !== "refs/heads/main") {
    throw new Error("profit_canary_closeout_release_remote_binding_invalid");
  }
}

async function verifyReleaseRemote(
  targetRoot: string,
  expectedOrigin: string,
  expectedRef: "refs/heads/main",
  attributes: JsonRecord,
) {
  const remoteOrigin = requireString(attributes, "remote_origin_url", "release_receipt");
  const remoteRef = requireString(attributes, "remote_ref", "release_receipt");
  const remoteObject = requireString(attributes, "remote_object", "release_receipt").toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(remoteOrigin);
  } catch {
    throw new Error("profit_canary_closeout_release_origin_invalid");
  }
  if (parsed.protocol !== "file:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || /[\r\n\0]/.test(remoteOrigin + remoteRef) ||
      remoteOrigin !== expectedOrigin || remoteRef !== expectedRef || !GIT_OBJECT.test(remoteObject)) {
    throw new Error("profit_canary_closeout_release_remote_binding_invalid");
  }
  const beforeOrigin = await execFile("git", ["-C", targetRoot, "config", "--local", "--no-includes", "--get", "remote.origin.url"], {
    timeout: 15_000,
    env: SAFE_GIT_ENV,
  }).then(({ stdout }) => stdout.trim()).catch(() => "");
  const remoteOutput = await execFile("git", ["-c", "protocol.file.allow=always", "ls-remote", "--exit-code", remoteOrigin, remoteRef], {
    timeout: 30_000,
    cwd: path.parse(targetRoot).root,
    env: SAFE_GIT_ENV,
    maxBuffer: 1024 * 1024,
  }).then(({ stdout }) => stdout.trim()).catch(() => "");
  const afterOrigin = await execFile("git", ["-C", targetRoot, "config", "--local", "--no-includes", "--get", "remote.origin.url"], {
    timeout: 15_000,
    env: SAFE_GIT_ENV,
  }).then(({ stdout }) => stdout.trim()).catch(() => "");
  const remoteLines = remoteOutput ? remoteOutput.split("\n") : [];
  const exactLine = remoteLines.length === 1 ? remoteLines[0]!.split("\t") : [];
  if (!beforeOrigin || beforeOrigin !== remoteOrigin || afterOrigin !== remoteOrigin ||
      exactLine.length !== 2 || exactLine[0]?.toLowerCase() !== remoteObject || exactLine[1] !== expectedRef) {
    throw new Error("profit_canary_closeout_release_remote_drift");
  }
  return {
    origin: remoteOrigin,
    ref: remoteRef,
    object: remoteObject,
    attestation: "git ls-remote --exit-code <receipt-origin> <receipt-ref>",
  };
}

function artifactBinding(record: JsonRecord, key: string, label: string) {
  const binding = asRecord(record[key]);
  return {
    path: requireString(binding, "path", label),
    sha256: requireSha(binding, "sha256", label),
  };
}

async function verifyCanaryBaseline(input: {
  options: ProfitFlywheelCanaryCloseoutOptions;
  workflow: typeof profitFlywheelWorkflows.$inferSelect;
  project: typeof projects.$inferSelect;
  workspace: typeof projectWorkspaces.$inferSelect;
  contractLoader: typeof loadProfitFlywheelContract;
  dispatchEvidenceValidator: typeof validateDispatchEvidence;
}) {
  const { options, workflow, project, workspace } = input;
  const setupArtifact = await readTrustedJsonFile(
    options.setupReceiptPath,
    "profit_canary_closeout_setup_receipt",
    { maxBytes: 2 * 1024 * 1024 },
  );
  const setup = setupArtifact.value;
  const deterministic = canaryFixtureIdentity(workflow.companyId, workflow.runId);
  const setupProject = asRecord(setup.project);
  const setupWorkspace = asRecord(setup.primary_workspace);
  const projectFixture = asRecord(asRecord(project.executionWorkspacePolicy).profitFlywheelCanaryFixture);
  if (setup.schema_version !== "paperclip.profit_flywheel_canary_fixture_setup.v1" ||
      setup.immutable !== true || setup.company_id !== workflow.companyId ||
      setup.run_id !== workflow.runId || setup.correlation_id !== workflow.correlationId ||
      setup.project_id !== deterministic.projectId || setup.workspace_id !== deterministic.workspaceId ||
      project.id !== deterministic.projectId || workspace.id !== deterministic.workspaceId ||
      workspace.projectId !== project.id || workspace.companyId !== workflow.companyId ||
      workspace.isPrimary !== true || workspace.sourceType !== "local_path" ||
      setupProject.id !== project.id || setupWorkspace.id !== workspace.id ||
      setupWorkspace.cwd !== workspace.cwd || setupWorkspace.repoUrl !== workspace.repoUrl ||
      projectFixture.run_id !== workflow.runId || projectFixture.project_id !== project.id ||
      projectFixture.workspace_id !== workspace.id || projectFixture.company_id !== workflow.companyId) {
    throw new Error("profit_canary_closeout_setup_fixture_binding_invalid");
  }
  const targetWorkspace = await requireTrustedDirectory(
    requireString(setup, "target_workspace", "setup_receipt"),
    "profit_canary_closeout_target_workspace",
  );
  const targetOrigin = await requireTrustedDirectory(
    requireString(setup, "target_origin", "setup_receipt"),
    "profit_canary_closeout_target_origin",
  );
  const targetOriginUrl = pathToFileURL(targetOrigin).href;
  if (targetWorkspace !== workflow.targetWorkspaceRoot || targetWorkspace !== workspace.cwd ||
      targetOriginUrl !== workspace.repoUrl || setup.target_repo !== "fixture/profit-canary") {
    throw new Error("profit_canary_closeout_setup_target_binding_invalid");
  }

  const aggregateArtifact = await readTrustedJsonFile(
    options.promotionReceiptPath,
    "profit_canary_closeout_promotion_aggregate",
    { maxBytes: 4 * 1024 * 1024 },
  );
  const aggregate = aggregateArtifact.value;
  const aggregateInputs = asRecord(aggregate.inputs);
  const aggregateResult = asRecord(aggregate.result);
  const persisted = asRecord(aggregateResult.persisted_workflow);
  const canaryBinding = artifactBinding(aggregateInputs, "canary_receipt", "promotion_canary_receipt");
  const sourceBinding = artifactBinding(aggregateInputs, "source_dispatch", "promotion_source_dispatch");
  const publishedBinding = artifactBinding(aggregateResult, "published_dispatch", "promotion_published_dispatch");
  const posPromotionBinding = artifactBinding(aggregateResult, "promotion_receipt", "promotion_receipt");
  const observationBinding = artifactBinding(aggregateResult, "observation_receipt", "observation_receipt");
  if (aggregate.schema_version !== "paperclip.profit_flywheel_fixture_promotion.v1" ||
      aggregate.status !== "succeeded" || aggregate.blocker != null || aggregate.immutable !== true ||
      aggregate.company_id !== workflow.companyId || aggregate.project_id !== project.id ||
      aggregate.run_id !== workflow.runId || aggregateResult.state !== "workflow_observed" ||
      aggregateResult.workflow_id !== workflow.id || aggregateInputs.target_workspace !== targetWorkspace ||
      aggregateInputs.target_origin !== targetOrigin || persisted.id !== workflow.id ||
      persisted.companyId !== workflow.companyId || persisted.projectId !== project.id ||
      persisted.runId !== workflow.runId || persisted.correlationId !== workflow.correlationId ||
      persisted.sourceDispatchPath !== workflow.sourceDispatchPath ||
      persisted.sourceDispatchHash !== workflow.sourceDispatchHash ||
      persisted.targetRepo !== workflow.targetRepo || persisted.targetWorkspaceRoot !== targetWorkspace ||
      publishedBinding.path !== workflow.sourceDispatchPath || publishedBinding.sha256 !== workflow.sourceDispatchHash ||
      sourceBinding.sha256 !== workflow.sourceDispatchHash) {
    throw new Error("profit_canary_closeout_promotion_binding_invalid");
  }

  const [canaryArtifact, sourceArtifact, publishedArtifact, posPromotionArtifact, observationArtifact] = await Promise.all([
    readTrustedJsonFile(canaryBinding.path, "profit_canary_closeout_pos_canary", { maxBytes: 4 * 1024 * 1024 }),
    readTrustedFile(sourceBinding.path, "profit_canary_closeout_source_dispatch", { maxBytes: 20 * 1024 * 1024 }),
    readTrustedFile(publishedBinding.path, "profit_canary_closeout_published_dispatch", { maxBytes: 20 * 1024 * 1024 }),
    readTrustedJsonFile(posPromotionBinding.path, "profit_canary_closeout_pos_promotion", { maxBytes: 4 * 1024 * 1024 }),
    readTrustedJsonFile(observationBinding.path, "profit_canary_closeout_pos_observation", { maxBytes: 4 * 1024 * 1024 }),
  ]);
  if (canaryArtifact.sha256 !== canaryBinding.sha256 || sourceArtifact.sha256 !== sourceBinding.sha256 ||
      publishedArtifact.sha256 !== publishedBinding.sha256 || !sourceArtifact.bytes.equals(publishedArtifact.bytes) ||
      posPromotionArtifact.sha256 !== posPromotionBinding.sha256 || observationArtifact.sha256 !== observationBinding.sha256) {
    throw new Error("profit_canary_closeout_promotion_artifact_hash_mismatch");
  }
  const canary = canaryArtifact.value;
  const canaryPaperclip = asRecord(canary.paperclip);
  const canaryDispatch = artifactBinding(asRecord(canary.artifacts), "dispatch", "canary_dispatch");
  if (canary.schema_version !== "pos.profit_flywheel_canary.v2" || canary.state !== "dispatch_ready" ||
      canary.mode !== "offline_fixture_only" || canary.immutable !== true || canary.e2e_proof !== false ||
      canary.execution_authority !== "paperclip_control_plane" || canary.target_repo !== workflow.targetRepo ||
      canary.run_id !== workflow.runId || canary.correlation_id !== workflow.correlationId ||
      canary.target_workspace !== targetWorkspace || canary.target_origin !== targetOrigin ||
      canaryPaperclip.company_id !== workflow.companyId || canaryPaperclip.project_id !== project.id ||
      canaryDispatch.path !== sourceBinding.path || canaryDispatch.sha256 !== sourceBinding.sha256) {
    throw new Error("profit_canary_closeout_pos_canary_binding_invalid");
  }
  const posPromotion = posPromotionArtifact.value;
  const observation = observationArtifact.value;
  const observationWorkflow = asRecord(observation.workflow);
  if (posPromotion.schema_version !== "pos.profit_flywheel_canary_promotion.v1" ||
      posPromotion.state !== "published" || posPromotion.immutable !== true ||
      posPromotion.run_id !== workflow.runId || posPromotion.company_id !== workflow.companyId ||
      posPromotion.project_id !== project.id || posPromotion.correlation_id !== workflow.correlationId ||
      posPromotion.published_path !== publishedBinding.path || posPromotion.published_sha256 !== publishedBinding.sha256 ||
      observation.schema_version !== "pos.profit_flywheel_canary_workflow_observation.v1" ||
      observation.state !== "workflow_observed" || observation.immutable !== true ||
      observationWorkflow.id !== workflow.id || observationWorkflow.companyId !== workflow.companyId ||
      observationWorkflow.projectId !== project.id || observationWorkflow.runId !== workflow.runId ||
      observationWorkflow.correlationId !== workflow.correlationId ||
      observationWorkflow.sourceDispatchPath !== workflow.sourceDispatchPath ||
      observationWorkflow.sourceDispatchHash !== workflow.sourceDispatchHash) {
    throw new Error("profit_canary_closeout_promotion_terminal_receipt_invalid");
  }

  const loadedContract = await input.contractLoader({
    path: workflow.contractPath,
    expectedSha256: workflow.contractSha256,
  });
  if (loadedContract.path !== workflow.contractPath || loadedContract.sha256 !== workflow.contractSha256 ||
      !sameJson(loadedContract.contract, workflow.contractSnapshot)) {
    throw new Error("profit_canary_closeout_contract_binding_invalid");
  }
  const feedback = asRecord(workflow.feedback);
  const selectionSnapshotHash = requireSha(feedback, "selection_snapshot_hash", "workflow_feedback");
  if (feedback.target_origin_url !== targetOriginUrl) {
    throw new Error("profit_canary_closeout_workflow_origin_binding_invalid");
  }
  const evidence = await input.dispatchEvidenceValidator({
    sourceDispatchPath: workflow.sourceDispatchPath,
    dispatchHash: workflow.sourceDispatchHash,
    selectionSnapshotHash,
    runId: workflow.runId,
    correlationId: workflow.correlationId,
    sourceSchemaVersion: workflow.sourceSchemaVersion,
    targetRepo: workflow.targetRepo,
    targetRepoUrl: targetOriginUrl,
    targetWorkspaceRoot: targetWorkspace,
    contract: loadedContract.contract,
  });
  const dispatchPaperclip = asRecord(evidence.dispatch.paperclip);
  if (evidence.dispatch.company !== workflow.companyId || dispatchPaperclip.company_id !== workflow.companyId ||
      dispatchPaperclip.project_id !== project.id) {
    throw new Error("profit_canary_closeout_dispatch_identity_invalid");
  }
  return {
    contract: loadedContract.contract,
    contractBinding: { path: loadedContract.path, sha256: loadedContract.sha256 },
    sourceDispatch: { path: workflow.sourceDispatchPath, sha256: workflow.sourceDispatchHash },
    setupReceipt: { path: setupArtifact.path, sha256: setupArtifact.sha256 },
    promotionReceipt: { path: aggregateArtifact.path, sha256: aggregateArtifact.sha256 },
    canaryReceipt: { path: canaryArtifact.path, sha256: canaryArtifact.sha256 },
    targetOrigin,
    targetOriginUrl,
    targetBaseObject: requireString(asRecord(evidence.dispatch.target), "base_sha", "dispatch_target"),
    dispatch: evidence.dispatch,
  };
}

async function verifyReceiptSet(input: {
  stage: typeof profitFlywheelStageRuns.$inferSelect;
  rows: Array<typeof profitFlywheelReceipts.$inferSelect>;
  requiredReceipts: string[];
  workflow: typeof profitFlywheelWorkflows.$inferSelect;
  now: Date;
}) {
  const roots = workflowArtifactRoots(input.workflow);
  const proofs: Record<string, ReturnType<typeof canonicalDbReceiptProof>> = {};
  for (const receiptType of input.requiredReceipts) {
    const candidates = input.rows.filter((row) => row.receiptType === receiptType);
    if (candidates.length !== 1) {
      throw new Error("profit_canary_closeout_" + input.stage.stage + "_" + receiptType + "_ambiguous");
    }
    const row = candidates[0]!;
    if (row.companyId !== input.workflow.companyId || row.workflowId !== input.workflow.id ||
        row.stageRunId !== input.stage.id || row.correlationId !== input.workflow.correlationId ||
        row.traceId !== input.workflow.traceId || row.spanId !== input.stage.spanId ||
        row.observedAt > input.now) {
      throw new Error("profit_canary_closeout_" + receiptType + "_identity_mismatch");
    }
    validateReceiptTypeAttributes(row.receiptType, asRecord(row.attributes), row.artifactRef);
    const proof = canonicalDbReceiptProof(row, input.now);
    if (!row.artifactRef) throw new Error("profit_canary_closeout_" + receiptType + "_artifact_missing");
    const artifactHash = requireSha(asRecord(row.attributes), "artifact_hash", receiptType);
    await verifyArtifactReference(row.artifactRef, artifactHash, roots.allowedArtifactRoots, roots.targetRepoRoot);
    proofs[receiptType] = proof;
  }
  return proofs;
}

export async function buildProfitFlywheelCanaryCloseout(
  db: Db,
  options: ProfitFlywheelCanaryCloseoutOptions,
  dependencies: CloseoutDependencies = {},
) {
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
  const companyId = canonicalUuid(options.companyId, "company_id");
  const projectId = canonicalUuid(options.projectId, "project_id");
  const workflowId = canonicalUuid(options.workflowId, "workflow_id");
  const issueId = canonicalUuid(options.issueId, "issue_id");
  const runId = canonicalBoundedId(options.runId, "run_id");
  const correlationId = canonicalBoundedId(options.correlationId, "correlation_id");
  if (correlationId !== "profit-canary:" + runId) {
    throw new Error("profit_canary_closeout_correlation_mismatch");
  }
  const expectedStageIds = {
    implementation: canonicalUuid(options.implementationStageRunId, "implementation_stage_run_id"),
    qa: canonicalUuid(options.qaStageRunId, "qa_stage_run_id"),
    release: canonicalUuid(options.releaseStageRunId, "release_stage_run_id"),
    commercial_observation: canonicalUuid(options.observationStageRunId, "observation_stage_run_id"),
    learning: canonicalUuid(options.learningStageRunId, "learning_stage_run_id"),
    research_intake: canonicalUuid(options.nextResearchStageRunId, "next_research_stage_run_id"),
  };
  const receiptDir = await prepareTrustedReceiptDirectory(
    options.receiptDir,
    "profit_canary_closeout_receipt_dir",
  );
  const snapshot = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const workflowRows = await tx.select().from(profitFlywheelWorkflows).where(and(
      eq(profitFlywheelWorkflows.id, workflowId),
      eq(profitFlywheelWorkflows.companyId, companyId),
      eq(profitFlywheelWorkflows.projectId, projectId),
      eq(profitFlywheelWorkflows.runId, runId),
      eq(profitFlywheelWorkflows.correlationId, correlationId),
    ));
    await dependencies.afterSnapshotEstablished?.();
    const projectRows = await tx.select().from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
    const workspaceRows = await tx.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.projectId, projectId),
      eq(projectWorkspaces.companyId, companyId),
      eq(projectWorkspaces.isPrimary, true),
    ));
    const issueRows = await tx.select().from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    const stages = await tx.select().from(profitFlywheelStageRuns).where(and(
      eq(profitFlywheelStageRuns.workflowId, workflowId),
      eq(profitFlywheelStageRuns.companyId, companyId),
    ));
    const receipts = await tx.select().from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.workflowId, workflowId),
      eq(profitFlywheelReceipts.companyId, companyId),
    ));
    const events = await tx.select().from(profitFlywheelEvents).where(and(
      eq(profitFlywheelEvents.workflowId, workflowId),
      eq(profitFlywheelEvents.companyId, companyId),
    ));
    if (workflowRows.length !== 1) throw new Error("profit_canary_closeout_primary_identity_missing");
    const workflow = workflowRows[0]!;
    const contract = parsePortfolioOsProfitFlywheelContractV2(workflow.contractSnapshot);
    const implementation = stages.find((stage) => stage.id === expectedStageIds.implementation);
    if (!implementation || !implementation.transitionSourceStageRunId) {
      throw new Error("profit_canary_closeout_dispatch_lineage_missing");
    }
    const dispatch = stages.find((stage) => stage.id === implementation.transitionSourceStageRunId);
    if (!dispatch || dispatch.stage !== "dispatch" || dispatch.state !== "succeeded") {
      throw new Error("profit_canary_closeout_dispatch_lineage_missing");
    }
    const auditedStages = [
      dispatch,
      implementation,
      stages.find((stage) => stage.id === expectedStageIds.qa),
      stages.find((stage) => stage.id === expectedStageIds.release),
      stages.find((stage) => stage.id === expectedStageIds.commercial_observation),
      stages.find((stage) => stage.id === expectedStageIds.learning),
      stages.find((stage) => stage.id === expectedStageIds.research_intake),
    ];
    if (auditedStages.some((stage) => !stage)) {
      throw new Error("profit_canary_closeout_stage_identity_missing");
    }
    for (const stage of auditedStages) assertCanonicalStageDefinition(stage!, workflow, contract);
    assertLocalReleaseAuthorityBeforeCompletion(
      workflow,
      auditedStages[3]!,
      receipts,
    );
    const roots = workflowArtifactRoots(workflow);
    const completionValidator = dependencies.completionEvidenceValidator ?? assertCompletionEvidence;
    const validReceiptRows: Record<string, Array<typeof profitFlywheelReceipts.$inferSelect>> = {};
    for (const stage of auditedStages.slice(0, -1) as Array<typeof profitFlywheelStageRuns.$inferSelect>) {
      validReceiptRows[stage.id] = await completionValidator({
        executor: tx,
        workflow,
        contract,
        stage: stage.stage as ProfitFlywheelStage,
        stageRun: stage,
        receipts: receipts.filter((receipt) => receipt.stageRunId === stage.id),
        now,
        builderProviderFamily: implementation.providerFamily,
        allowedArtifactRoots: roots.allowedArtifactRoots,
        targetRepoRoot: roots.targetRepoRoot,
      });
    }
    return { workflowRows, projectRows, workspaceRows, issueRows, stages, events, validReceiptRows };
  }, { isolationLevel: "serializable", accessMode: "read only" });
  const { workflowRows, projectRows, workspaceRows, issueRows, stages, events, validReceiptRows } = snapshot;
  if (workflowRows.length !== 1 || projectRows.length !== 1 || workspaceRows.length !== 1 || issueRows.length !== 1) {
    throw new Error("profit_canary_closeout_primary_identity_missing");
  }
  const workflow = workflowRows[0]!;
  const project = projectRows[0]!;
  const workspace = workspaceRows[0]!;
  const issue = issueRows[0]!;
  if (workflow.state !== "running" || workflow.currentStage !== "research_intake" ||
      workflow.blockerCode || workflow.completedAt) {
    throw new Error("profit_canary_closeout_workflow_not_running_next_research");
  }
  if (workflow.targetRepo !== "fixture/profit-canary" ||
      project.status !== "in_progress" || issue.projectId !== projectId ||
      issue.status !== "done" || !issue.completedAt) {
    throw new Error("profit_canary_closeout_project_or_issue_incomplete");
  }
  const baseline = await verifyCanaryBaseline({
    options,
    workflow,
    project,
    workspace,
    contractLoader: dependencies.contractLoader ?? loadProfitFlywheelContract,
    dispatchEvidenceValidator: dependencies.dispatchEvidenceValidator ?? validateDispatchEvidence,
  });
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const implementationCandidate = stageById.get(expectedStageIds.implementation);
  const dispatchId = implementationCandidate?.transitionSourceStageRunId;
  const dispatch = assertStage({
    stage: dispatchId ? stageById.get(dispatchId) : undefined,
    expectedName: "dispatch",
    expectedId: dispatchId ?? "",
    workflowId,
    companyId,
    issueId,
  });
  if (asRecord(dispatch.feedback).output_hash !== workflow.sourceDispatchHash) {
    throw new Error("profit_canary_closeout_dispatch_output_mismatch");
  }
  const implementation = assertStage({
    stage: implementationCandidate,
    expectedName: "implementation",
    expectedId: expectedStageIds.implementation,
    workflowId,
    companyId,
    issueId,
    expectedSource: dispatch,
  });
  const qa = assertStage({
    stage: stageById.get(expectedStageIds.qa),
    expectedName: "qa",
    expectedId: expectedStageIds.qa,
    workflowId,
    companyId,
    issueId,
    expectedSource: implementation,
  });
  const release = assertStage({
    stage: stageById.get(expectedStageIds.release),
    expectedName: "release",
    expectedId: expectedStageIds.release,
    workflowId,
    companyId,
    issueId,
    expectedSource: qa,
  });
  const observation = assertStage({
    stage: stageById.get(expectedStageIds.commercial_observation),
    expectedName: "commercial_observation",
    expectedId: expectedStageIds.commercial_observation,
    workflowId,
    companyId,
    issueId,
    expectedSource: release,
  });
  const learning = assertStage({
    stage: stageById.get(expectedStageIds.learning),
    expectedName: "learning",
    expectedId: expectedStageIds.learning,
    workflowId,
    companyId,
    issueId,
    expectedSource: observation,
  });
  const nextResearch = assertStage({
    stage: stageById.get(expectedStageIds.research_intake),
    expectedName: "research_intake",
    expectedId: expectedStageIds.research_intake,
    workflowId,
    companyId,
    expectedSource: learning,
  });
  const nextResearchCandidates = stages.filter((stage) =>
    stage.stage === "research_intake" && stage.transitionSourceStageRunId === learning.id);
  if (nextResearchCandidates.length !== 1 || nextResearchCandidates[0]!.id !== nextResearch.id) {
    throw new Error("profit_canary_closeout_next_research_identity_ambiguous");
  }
  const nextResearchEvents = events.filter((event) =>
    event.stageRunId === nextResearch.id && event.eventType === "portfolio_os_stage_requested");
  const nextResearchEvent = nextResearchEvents[0];
  const nextPayload = asRecord(nextResearchEvent?.payload);
  const eventOccurredAt = new Date(String(nextPayload.occurred_at ?? ""));
  const expectedTransition = baseline.contract.transitions.find((transition) =>
    transition.from === "learning" && transition.to === "research_intake");
  if (nextResearchEvents.length !== 1 || !nextResearchEvent || !expectedTransition ||
      nextResearchEvent.companyId !== companyId || nextResearchEvent.workflowId !== workflowId ||
      nextResearchEvent.stageRunId !== nextResearch.id || nextResearchEvent.dedupeKey !== `stage-requested:${nextResearch.id}` ||
      nextResearchEvent.fromState != null || nextResearchEvent.toState !== "pending" ||
      nextResearchEvent.correlationId !== workflow.correlationId || nextResearchEvent.traceId !== workflow.traceId ||
      nextResearchEvent.spanId !== nextResearch.spanId || nextResearchEvent.attemptCount !== 0 ||
      nextResearchEvent.processedAt || nextResearchEvent.lastError ||
      nextPayload.schema_version !== "paperclip.profit_flywheel_event.v2" ||
      nextPayload.company_id !== companyId || nextPayload.run_id !== runId ||
      nextPayload.workflow_id !== workflowId || nextPayload.correlation_id !== correlationId ||
      nextPayload.trace_id !== workflow.traceId || nextPayload.contract_sha256 !== workflow.contractSha256 ||
      nextPayload.stage !== "research_intake" || nextPayload.input_hash !== nextResearch.inputHash ||
      nextPayload.trigger !== expectedTransition.trigger || nextPayload.guard !== expectedTransition.guard ||
      nextPayload.from_stage !== "learning" || nextPayload.to_stage !== "research_intake" ||
      nextPayload.linked_issue_id != null || !sameJson(nextPayload.source_hashes, nextResearch.sourceHashes) ||
      !Number.isFinite(eventOccurredAt.getTime()) || eventOccurredAt < learning.completedAt! ||
      eventOccurredAt > now || nextResearchEvent.createdAt > now ||
      Math.abs(nextResearchEvent.createdAt.getTime() - eventOccurredAt.getTime()) > 5_000 ||
      nextResearchEvent.nextAttemptAt < eventOccurredAt ||
      !sameJson(nextPayload.transition_context, {
        research_plan: asRecord(nextResearch.feedback).research_plan,
        research_authority_snapshot: asRecord(nextResearch.feedback).research_authority_snapshot,
        research_authority_binding: asRecord(nextResearch.feedback).research_authority_binding,
      })) {
    throw new Error("profit_canary_closeout_next_research_event_invalid");
  }

  const stageList = [dispatch, implementation, qa, release, observation, learning];
  const receiptProofs: Record<string, unknown> = {};
  for (const stage of stageList) {
    receiptProofs[stage.stage] = await verifyReceiptSet({
      stage,
      rows: validReceiptRows[stage.id] ?? [],
      requiredReceipts: baseline.contract.stages[stage.stage as ProfitFlywheelStage].required_receipts,
      workflow,
      now,
    });
  }
  const implementationProofs = asRecord(receiptProofs.implementation);
  const qaProofs = asRecord(receiptProofs.qa);
  const releaseProofs = asRecord(receiptProofs.release);
  const observationProofs = asRecord(receiptProofs.commercial_observation);
  const learningProofs = asRecord(receiptProofs.learning);
  const implementationAttributes = asRecord(asRecord(implementationProofs.implementation_receipt).attributes);
  const qaAttributes = asRecord(asRecord(qaProofs.qa_receipt).attributes);
  const reviewAttributes = asRecord(asRecord(qaProofs.independent_review_receipt).attributes);
  const releaseAttributes = asRecord(asRecord(releaseProofs.release_receipt).attributes);
  const observationAttributes = asRecord(asRecord(observationProofs.commercial_observation_receipt).attributes);
  const learningAttributes = asRecord(asRecord(learningProofs.learning_receipt).attributes);
  const roots = workflowArtifactRoots(workflow);
  const implementationTests = requirePassingTests(implementationAttributes.test_results, "implementation");
  const qaTests = requirePassingTests(qaAttributes.test_results, "qa");
  await Promise.all(
    [...implementationTests, ...qaTests].map((test) =>
      verifyArtifactReference(
        test.artifact_ref,
        test.artifact_hash,
        roots.allowedArtifactRoots,
        roots.targetRepoRoot,
      )),
  );
  const builderFamily = requireString(qaAttributes, "builder_provider_family", "qa_receipt");
  const reviewerFamily = requireString(qaAttributes, "reviewer_provider_family", "qa_receipt");
  const reviewProof = asRecord(qaProofs.independent_review_receipt);
  const reviewProofArtifactRef = requireString(reviewProof, "artifactRef", "independent_review_proof");
  const reviewProofArtifactHash = requireSha(reviewAttributes, "artifact_hash", "independent_review_receipt");
  if (builderFamily === reviewerFamily || reviewAttributes.builder_provider_family !== builderFamily ||
      reviewAttributes.review_provider_family !== reviewerFamily ||
      reviewAttributes.final_disposition !== "passed" ||
      qaAttributes.independent_review_artifact_ref !== reviewProofArtifactRef ||
      qaAttributes.independent_review_artifact_hash !== reviewProofArtifactHash ||
      qaAttributes.implementation_stage_run_id !== implementation.id ||
      releaseAttributes.implementation_stage_run_id !== implementation.id ||
      releaseAttributes.qa_stage_run_id !== qa.id ||
      releaseAttributes.implementation_artifact_hash !== implementationAttributes.artifact_hash ||
      releaseAttributes.implementation_git_object !==
        String(asRecord(implementationProofs.implementation_receipt).artifactRef ?? "").replace(/^git:/, "")) {
    throw new Error("profit_canary_closeout_cross_family_or_release_lineage_mismatch");
  }
  const implementationProof = asRecord(implementationProofs.implementation_receipt);
  const implementationArtifactRef = requireString(implementationProof, "artifactRef", "implementation_proof");
  const targetObject = implementationArtifactRef.replace(/^git:/, "").toLowerCase();
  const baseObject = baseline.targetBaseObject.toLowerCase();
  const declaredChangedFiles = Array.isArray(implementationAttributes.changed_files)
    ? implementationAttributes.changed_files.map((value) => String(value))
    : [];
  if (!GIT_OBJECT.test(baseObject) || !GIT_OBJECT.test(targetObject) || baseObject === targetObject ||
      declaredChangedFiles.length === 0 || new Set(declaredChangedFiles).size !== declaredChangedFiles.length ||
      declaredChangedFiles.some((file) => !file || path.isAbsolute(file) || file.includes("\0") ||
        file.split(/[\\/]/).includes(".."))) {
    throw new Error("profit_canary_closeout_implementation_diff_invalid");
  }
  const [baseType, targetType] = await Promise.all([
    execFile("git", ["-C", workflow.targetWorkspaceRoot, "cat-file", "-t", baseObject], {
      timeout: 15_000,
      env: SAFE_GIT_ENV,
    }).then(({ stdout }) => stdout.trim()).catch(() => ""),
    execFile("git", ["-C", workflow.targetWorkspaceRoot, "cat-file", "-t", targetObject], {
      timeout: 15_000,
      env: SAFE_GIT_ENV,
    }).then(({ stdout }) => stdout.trim()).catch(() => ""),
  ]);
  if (baseType !== "commit" || targetType !== "commit") {
    throw new Error("profit_canary_closeout_implementation_commit_invalid");
  }
  await execFile("git", ["-C", workflow.targetWorkspaceRoot, "merge-base", "--is-ancestor", baseObject, targetObject], {
    timeout: 15_000,
    env: SAFE_GIT_ENV,
  }).catch(() => {
    throw new Error("profit_canary_closeout_implementation_not_descendant");
  });
  const diffOutput = await execFile("git", [
    "-C", workflow.targetWorkspaceRoot,
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z",
    baseObject, targetObject, "--",
  ], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: SAFE_GIT_ENV,
  }).then(({ stdout }) => stdout).catch(() => {
    throw new Error("profit_canary_closeout_implementation_diff_failed");
  });
  const observedChangedFiles = diffOutput.split("\0").filter(Boolean).sort();
  if (observedChangedFiles.length === 0 || !sameJson(observedChangedFiles, [...declaredChangedFiles].sort())) {
    throw new Error("profit_canary_closeout_implementation_changed_files_mismatch");
  }
  const released = await verifyReleaseRemote(
    workflow.targetWorkspaceRoot,
    baseline.targetOriginUrl,
    "refs/heads/main",
    releaseAttributes,
  );
  if (released.object !== releaseAttributes.implementation_git_object) {
    throw new Error("profit_canary_closeout_released_object_not_implementation");
  }
  const nextAuthorityRef = requireString(learningAttributes, "next_research_authority_ref", "learning_receipt");
  const nextAuthorityHash = requireSha(learningAttributes, "next_research_authority_sha256", "learning_receipt");
  const authorityArtifact = await readTrustedJsonFile(
    nextAuthorityRef,
    "profit_canary_closeout_next_research_authority",
    { maxBytes: 1024 * 1024 },
  );
  const authorization = authorityArtifact.value;
  if (authorityArtifact.sha256 !== nextAuthorityHash ||
      hashProfitFlywheelValue(authorization) !== requireSha(learningAttributes, "next_research_payload_sha256", "learning_receipt")) {
    throw new Error("profit_canary_closeout_next_research_authority_hash_mismatch");
  }
  await validatePinnedResearchArtifactSchema({
    value: authorization,
    schemaPath: path.join(path.dirname(workflow.contractPath), "pos.next_research_authorization.v1.schema.json"),
    expectedSha256: PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256,
    label: "closeout POS next-research authorization",
  });
  const workflowRegistry = asRecord(asRecord(workflow.feedback).research_registry_authority);
  if (authorization.target_repo !== workflow.targetRepo ||
      !sameJson(authorization.source_registry, workflowRegistry.registry) ||
      authorization.source_plan_hash !== hashProfitFlywheelValue(authorization.source_requests)) {
    throw new Error("profit_canary_closeout_next_research_authority_binding_invalid");
  }
  const governance = asRecord(authorization.governance);
  const windowPolicy = asRecord(governance.collection_window_policy);
  const notBefore = new Date(requireString(learningAttributes, "next_research_not_before", "learning_receipt"));
  const expiresAt = new Date(requireString(learningAttributes, "next_research_expires_at", "learning_receipt"));
  const authorizedAt = new Date(String(governance.authorized_at ?? ""));
  const authorityNotBefore = new Date(String(windowPolicy.not_before ?? ""));
  const authorityExpiresAt = new Date(String(governance.expires_at ?? ""));
  const maxDurationSeconds = Number(windowPolicy.max_duration_seconds);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(expiresAt.getTime()) ||
      !Number.isFinite(authorizedAt.getTime()) || !Number.isFinite(authorityNotBefore.getTime()) ||
      !Number.isFinite(authorityExpiresAt.getTime()) || !Number.isInteger(maxDurationSeconds) ||
      maxDurationSeconds < 60 || authorizedAt > authorityNotBefore || authorityNotBefore >= authorityExpiresAt ||
      notBefore.getTime() !== authorityNotBefore.getTime() || expiresAt.getTime() !== authorityExpiresAt.getTime() ||
      nextResearchEvent.nextAttemptAt.getTime() !== notBefore.getTime()) {
    throw new Error("profit_canary_closeout_next_research_window_mismatch");
  }
  const collectionTo = new Date(Math.min(expiresAt.getTime(), notBefore.getTime() + maxDurationSeconds * 1000));
  if (collectionTo <= notBefore) throw new Error("profit_canary_closeout_next_research_window_mismatch");
  const nextFeedback = asRecord(nextResearch.feedback);
  const authorityBinding = {
    artifact_ref: nextAuthorityRef,
    artifact_sha256: nextAuthorityHash,
    payload_sha256: requireSha(learningAttributes, "next_research_payload_sha256", "learning_receipt"),
  };
  if (!sameJson(nextFeedback.research_authority_snapshot, authorization) ||
      !sameJson(nextFeedback.research_authority_binding, authorityBinding)) {
    throw new Error("profit_canary_closeout_next_research_feedback_authority_mismatch");
  }
  const researchPlan = asRecord(nextFeedback.research_plan);
  await validatePinnedResearchArtifactSchema({
    value: researchPlan,
    schemaPath: path.join(path.dirname(workflow.contractPath), "paperclip.research_plan.v2.schema.json"),
    expectedSha256: PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256,
    label: "closeout Paperclip research plan v2",
  });
  const { plan_hash: planHash, ...researchPlanBody } = researchPlan;
  if (planHash !== hashProfitFlywheelValue(researchPlanBody) ||
      !sameJson(researchPlan.authority, authorityBinding) || researchPlan.target_repo !== workflow.targetRepo ||
      !sameJson(researchPlan.source_registry, authorization.source_registry) ||
      !sameJson(researchPlan.evidence_families, authorization.evidence_families) ||
      !sameJson(researchPlan.query_families, authorization.query_families) ||
      !sameJson(researchPlan.query, authorization.query) ||
      !sameJson(researchPlan.source_requests, authorization.source_requests) ||
      researchPlan.source_plan_hash !== authorization.source_plan_hash ||
      !sameJson(researchPlan.collection_window, { from: notBefore.toISOString(), to: collectionTo.toISOString() })) {
    throw new Error("profit_canary_closeout_next_research_plan_invalid");
  }
  const expectedResearchSourceHashes = {
    source_registry_hash: requireString(asRecord(authorization.source_registry), "sha256", "research_source_registry"),
    selection_hash: requireSha(asRecord(learning.feedback), "output_hash", "learning"),
    research_plan_hash: String(planHash ?? ""),
  };
  const canonicalResearchInput = buildProfitFlywheelStageInput({
    contract: baseline.contract,
    stage: "research_intake",
    sourceHashes: expectedResearchSourceHashes,
  });
  if (!sameJson(nextResearch.sourceHashes, canonicalResearchInput.sourceHashes) ||
      nextResearch.inputHash !== canonicalResearchInput.inputHash) {
    throw new Error("profit_canary_closeout_next_research_input_mismatch");
  }
  const finalNow = clock();
  if (finalNow.getTime() < now.getTime() || expiresAt.getTime() <= finalNow.getTime()) {
    throw new Error("profit_canary_closeout_next_research_authority_expired");
  }
  for (const validRows of Object.values(validReceiptRows)) {
    if (validRows.some((receipt) => receipt.expiresAt && receipt.expiresAt.getTime() <= finalNow.getTime())) {
      throw new Error("profit_canary_closeout_receipt_expired_during_audit");
    }
  }

  const receipt = {
    schema_version: SCHEMA_VERSION,
    outcome: "work_bearing_cycle_closed_next_research_pending",
    expected_control_plane_state: {
      workflow_state: "running",
      current_stage: "research_intake",
      explanation: "Learning completed one work-bearing cycle and intentionally opened the next bounded research iteration; the workflow is not terminal.",
    },
    identity: {
      company_id: companyId,
      run_id: runId,
      correlation_id: correlationId,
      project_id: projectId,
      workflow_id: workflowId,
      issue_id: issueId,
      trace_id: workflow.traceId,
      target_repo: workflow.targetRepo,
      target_workspace_root: workflow.targetWorkspaceRoot,
    },
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
    },
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      status: issue.status,
      completed_at: issue.completedAt.toISOString(),
    },
    authority_baseline: {
      setup_receipt: baseline.setupReceipt,
      promotion_aggregate_receipt: baseline.promotionReceipt,
      pos_canary_receipt: baseline.canaryReceipt,
      source_dispatch: baseline.sourceDispatch,
      contract: baseline.contractBinding,
      target_origin: baseline.targetOriginUrl,
    },
    stages: {
      dispatch: stageIdentity(dispatch),
      implementation: stageIdentity(implementation),
      qa: stageIdentity(qa),
      release: stageIdentity(release),
      commercial_observation: stageIdentity(observation),
      learning: stageIdentity(learning),
      next_research_intake: stageIdentity(nextResearch, { requireOutputHash: false }),
    },
    canonical_db_receipt_proofs: receiptProofs,
    test_results: {
      implementation: implementationTests,
      qa: qaTests,
    },
    cross_family_review: {
      builder_provider_family: builderFamily,
      reviewer_provider_family: reviewerFamily,
      reviewer_model: qaAttributes.reviewer_model,
      reviewer_version: qaAttributes.reviewer_version,
      final_disposition: reviewAttributes.final_disposition,
      artifact_ref: reviewProofArtifactRef,
      artifact_hash: reviewProofArtifactHash,
    },
    released,
    implementation_diff: {
      base_object: baseObject,
      target_object: targetObject,
      changed_files: observedChangedFiles,
      replace_objects_disabled: true,
    },
    measured_source: {
      artifact_ref: asRecord(observationProofs.commercial_observation_receipt).artifactRef,
      artifact_hash: observationAttributes.artifact_hash,
      source_artifact_hash: observationAttributes.source_artifact_hash,
      metric_name: observationAttributes.metric_name,
      baseline: observationAttributes.baseline,
      observed_value: observationAttributes.observed_value,
      measurement_window: observationAttributes.measurement_window,
    },
    learning: {
      artifact_ref: asRecord(learningProofs.learning_receipt).artifactRef,
      learning_receipt_hash: learningAttributes.learning_receipt_hash,
      validation_outcome_hash: learningAttributes.validation_outcome_hash,
      measured_external_or_operational_evidence:
        learningAttributes.measured_external_or_operational_evidence,
    },
    next_research_authority: {
      artifact_ref: nextAuthorityRef,
      artifact_sha256: nextAuthorityHash,
      payload_sha256: learningAttributes.next_research_payload_sha256,
      not_before: notBefore.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
    next_research_intake: {
      stage_run_id: nextResearch.id,
      input_hash: nextResearch.inputHash,
      idempotency_key: nextResearch.idempotencyKey,
      event_id: nextResearchEvent.id,
      event_state: "pending",
      next_attempt_at: nextResearchEvent.nextAttemptAt.toISOString(),
      identity_count: 1,
    },
    generated_at: finalNow.toISOString(),
    database_snapshot: {
      isolation_level: "serializable",
      access_mode: "read only",
      captured_at: now.toISOString(),
    },
    read_only_database_audit: true,
    immutable: true,
  };
  const receiptPath = path.join(receiptDir, runId + "-canary-closeout.json");
  const receiptSha256 = await writeImmutableJsonReceipt(receiptPath, receipt);
  return { status: "closed_next_research_pending" as const, receiptPath, receiptSha256, receipt };
}

const CLI_FLAGS: Record<string, keyof ProfitFlywheelCanaryCloseoutOptions> = {
  "--company-id": "companyId",
  "--run-id": "runId",
  "--correlation-id": "correlationId",
  "--project-id": "projectId",
  "--workflow-id": "workflowId",
  "--issue-id": "issueId",
  "--implementation-stage-run-id": "implementationStageRunId",
  "--qa-stage-run-id": "qaStageRunId",
  "--release-stage-run-id": "releaseStageRunId",
  "--observation-stage-run-id": "observationStageRunId",
  "--learning-stage-run-id": "learningStageRunId",
  "--next-research-stage-run-id": "nextResearchStageRunId",
  "--setup-receipt": "setupReceiptPath",
  "--promotion-receipt": "promotionReceiptPath",
  "--receipt-dir": "receiptDir",
};

export function parseCanaryCloseoutCliArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.DATABASE_URL?.trim() || environment.POSTGRES_URL?.trim()) {
    throw new Error("profit_canary_closeout_database_url_forbidden");
  }
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values: Partial<ProfitFlywheelCanaryCloseoutOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const key = CLI_FLAGS[flag];
    if (!key || flag.includes("=") || values[key] !== undefined ||
        /(?:credential|password|secret|token|api-key|database-url|postgres-url|connection-string)/i.test(flag)) {
      throw new Error("profit_canary_closeout_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("profit_canary_closeout_argument_missing:" + flag);
    values[key] = value;
    index += 1;
  }
  for (const [flag, key] of Object.entries(CLI_FLAGS)) {
    if (!values[key]) throw new Error("profit_canary_closeout_argument_required:" + flag);
  }
  return values as ProfitFlywheelCanaryCloseoutOptions;
}

export function resolveEmbeddedCanaryCloseoutConnection(config: {
  databaseMode: string;
  embeddedPostgresPort: number;
}) {
  if (config.databaseMode !== "embedded-postgres") {
    throw new Error("profit_canary_closeout_embedded_instance_required");
  }
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("profit_canary_closeout_embedded_port_invalid");
  }
  return "postgres://paperclip:paperclip@127.0.0.1:" + port + "/paperclip";
}

function usage() {
  return "Usage: pnpm ops:profit-flywheel-canary-closeout -- " +
    Object.keys(CLI_FLAGS).map((flag) => flag + " <value>").join(" ");
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const options = parseCanaryCloseoutCliArgs(process.argv.slice(2));
  const { loadConfig } = await import("../config.js");
  const db = createDb(resolveEmbeddedCanaryCloseoutConnection(loadConfig()));
  try {
    const outcome = await buildProfitFlywheelCanaryCloseout(db, options);
    console.log(JSON.stringify({
      status: outcome.status,
      receipt_path: outcome.receiptPath,
      receipt_sha256: outcome.receiptSha256,
    }));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "profit_canary_closeout_unknown_failure",
    }));
    process.exit(1);
  });
}
