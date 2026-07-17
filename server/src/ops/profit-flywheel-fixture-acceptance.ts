import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factoryCanonicalJsonSha256 } from "./factory-canonical-json.js";
import { writeImmutableJsonReceipt } from "./immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  readTrustedJsonFile,
  requireTrustedDirectory,
} from "./trusted-receipt-directory.js";

const MANIFEST_SCHEMA = "paperclip.profit_flywheel_fixture_acceptance_manifest.v1";
const EVIDENCE_SCHEMA = "paperclip.profit_flywheel_two_iteration_evidence.v1";
const CLOSEOUT_SCHEMA = "paperclip.profit_flywheel_two_iteration_closeout.v1";
const ACCEPTANCE_SCHEMA = "paperclip.profit_flywheel_fixture_acceptance.v1";
const REQUIRED_CYCLES = 20;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

type JsonRecord = Record<string, unknown>;
type ArtifactBinding = { path: string; sha256: string };

export type FixtureAcceptanceOptions = {
  manifestPath: string;
  receiptDir: string;
};

function asRecord(value: unknown, blocker: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(blocker);
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: string[], blocker: string) {
  const observed = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) {
    throw new Error(blocker);
  }
}

function requiredString(record: JsonRecord, key: string, blocker: string) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(blocker);
  return value.trim();
}

function safeId(record: JsonRecord, key: string, blocker: string) {
  const value = requiredString(record, key, blocker);
  if (!SAFE_ID.test(value) || value.includes("..")) throw new Error(blocker);
  return value;
}

function sha256(record: JsonRecord, key: string, blocker: string) {
  const value = requiredString(record, key, blocker).toLowerCase();
  if (!SHA256.test(value)) throw new Error(blocker);
  return value;
}

function dateTime(record: JsonRecord, key: string, blocker: string) {
  const value = requiredString(record, key, blocker);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(blocker);
  return date;
}

function integer(record: JsonRecord, key: string, blocker: string) {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new Error(blocker);
  return value as number;
}

function pathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}

function posStableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(posStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonRecord).sort().map((key) =>
      `${JSON.stringify(key)}:${posStableJson((value as JsonRecord)[key])}`).join(",")}}`;
  }
  throw new Error("fixture_acceptance_canonical_json_invalid");
}

function posValueSha256(value: unknown) {
  return createHash("sha256").update(posStableJson(value), "utf8").digest("hex");
}

async function verifyArtifactBinding(
  value: unknown,
  root: string,
  label: string,
  options: { json?: boolean } = {},
) {
  const binding = asRecord(value, `fixture_acceptance_${label}_binding_invalid`);
  exactKeys(binding, ["path", "sha256"], `fixture_acceptance_${label}_binding_invalid`);
  const requestedPath = requiredString(binding, "path", `fixture_acceptance_${label}_path_invalid`);
  const expectedSha256 = sha256(binding, "sha256", `fixture_acceptance_${label}_sha256_invalid`);
  const artifact = options.json
    ? await readTrustedJsonFile(requestedPath, `fixture_acceptance_${label}`, { maxBytes: 16 * 1024 * 1024 })
    : await readTrustedFile(requestedPath, `fixture_acceptance_${label}`, { maxBytes: 16 * 1024 * 1024 });
  if (!pathWithin(root, artifact.path)) throw new Error(`fixture_acceptance_${label}_outside_isolation_root`);
  if (artifact.sha256 !== expectedSha256) throw new Error(`fixture_acceptance_${label}_hash_mismatch`);
  return {
    binding: { path: artifact.path, sha256: artifact.sha256 },
    value: "value" in artifact ? artifact.value : undefined,
  };
}

async function verifyFixtureAuthority(
  value: unknown,
  input: { root: string; targetRepo: string; iteration: number; label: string },
) {
  const artifact = await verifyArtifactBinding(value, input.root, input.label, { json: true });
  const authority = asRecord(artifact.value, `fixture_acceptance_${input.label}_json_invalid`);
  exactKeys(authority, [
    "schema_version", "mode", "iteration", "target_repo", "source_registry", "evidence_families",
    "query_families", "query", "source_requests", "governance", "source_plan_hash", "immutable",
  ], `fixture_acceptance_${input.label}_authority_keys_invalid`);
  if (authority.schema_version !== "pos.next_research_authorization.v2" || authority.mode !== "fixture" ||
      authority.iteration !== input.iteration || authority.target_repo !== input.targetRepo || authority.immutable !== true) {
    throw new Error(`fixture_acceptance_${input.label}_authority_invalid`);
  }
  const requests = authority.source_requests;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) {
    throw new Error(`fixture_acceptance_${input.label}_source_requests_invalid`);
  }
  const sourceRegistry = asRecord(
    authority.source_registry,
    `fixture_acceptance_${input.label}_source_registry_invalid`,
  );
  exactKeys(sourceRegistry, ["path", "sha256", "schema_version"],
    `fixture_acceptance_${input.label}_source_registry_invalid`);
  if (sourceRegistry.schema_version !== "pos.research_sources.v2") {
    throw new Error(`fixture_acceptance_${input.label}_source_registry_invalid`);
  }
  await verifyArtifactBinding({
    path: sourceRegistry.path,
    sha256: sourceRegistry.sha256,
  }, input.root, `${input.label}_source_registry`);
  const offlineFixtures: ArtifactBinding[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = asRecord(requests[index], `fixture_acceptance_${input.label}_source_request_invalid`);
    exactKeys(request, [
      "source_id", "source_kind", "authority_class", "evidence_families", "query_families", "query",
      "url_template", "template_values", "approved_domains", "approved_file_roots", "legal",
      "authentication", "extractor", "freshness_sla_hours", "offline_fixture",
    ], `fixture_acceptance_${input.label}_source_request_keys_invalid`);
    const approvedDomains = request.approved_domains;
    const authentication = asRecord(
      request.authentication,
      `fixture_acceptance_${input.label}_authentication_invalid`,
    );
    if (!Array.isArray(approvedDomains) || approvedDomains.length !== 0 ||
        typeof request.url_template !== "string" || !request.url_template.startsWith("file:") ||
        authentication.requirement !== "none" || authentication.runtime_ref_name !== null) {
      throw new Error(`fixture_acceptance_${input.label}_network_authority_forbidden`);
    }
    offlineFixtures.push((await verifyArtifactBinding(
      request.offline_fixture,
      input.root,
      `${input.label}_offline_fixture_${index}`,
    )).binding);
  }
  const governance = asRecord(authority.governance, `fixture_acceptance_${input.label}_governance_invalid`);
  exactKeys(governance, ["owner", "authorized_at", "expires_at", "collection_window_policy"],
    `fixture_acceptance_${input.label}_governance_invalid`);
  const policy = asRecord(
    governance.collection_window_policy,
    `fixture_acceptance_${input.label}_window_invalid`,
  );
  exactKeys(policy, ["not_before", "max_duration_seconds"], `fixture_acceptance_${input.label}_window_invalid`);
  const authorizedAt = dateTime(
    governance,
    "authorized_at",
    `fixture_acceptance_${input.label}_authorized_at_invalid`,
  );
  const authorityNotBefore = dateTime(policy, "not_before", `fixture_acceptance_${input.label}_not_before_invalid`);
  const authorityExpiresAt = dateTime(
    governance,
    "expires_at",
    `fixture_acceptance_${input.label}_expires_at_invalid`,
  );
  if (governance.owner !== "portfolio_os" || authorizedAt > authorityNotBefore ||
      authorityNotBefore >= authorityExpiresAt ||
      authority.source_plan_hash !== posValueSha256(requests)) {
    throw new Error(`fixture_acceptance_${input.label}_window_invalid`);
  }
  return {
    binding: artifact.binding,
    offlineFixtures,
    sourceRequests: requests,
    notBefore: authorityNotBefore,
    expiresAt: authorityExpiresAt,
  };
}

async function verifyStageReceipts(value: unknown, root: string, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error(`fixture_acceptance_${label}_receipts_invalid`);
  }
  const receipts: Array<{ binding: ArtifactBinding; value: unknown }> = [];
  for (let index = 0; index < value.length; index += 1) {
    receipts.push(await verifyArtifactBinding(value[index], root, `${label}_receipt_${index}`, { json: true }));
  }
  if (new Set(receipts.map((receipt) =>
    `${receipt.binding.path}:${receipt.binding.sha256}`)).size !== receipts.length) {
    throw new Error(`fixture_acceptance_${label}_receipt_duplicate`);
  }
  return receipts;
}

async function verifyIteration(value: unknown, root: string, expectedIteration: 1 | 2) {
  const iteration = asRecord(value, `fixture_acceptance_iteration_${expectedIteration}_invalid`);
  exactKeys(iteration, ["iteration", "research_intake", "evidence_normalization"],
    `fixture_acceptance_iteration_${expectedIteration}_keys_invalid`);
  if (iteration.iteration !== expectedIteration) throw new Error("fixture_acceptance_iteration_sequence_invalid");

  const research = asRecord(iteration.research_intake, `fixture_acceptance_iteration_${expectedIteration}_research_invalid`);
  exactKeys(research, ["stage_run_id", "state", "owner_plane", "raw_evidence", "receipts"],
    `fixture_acceptance_iteration_${expectedIteration}_research_keys_invalid`);
  const normalization = asRecord(
    iteration.evidence_normalization,
    `fixture_acceptance_iteration_${expectedIteration}_normalization_invalid`,
  );
  exactKeys(normalization, ["stage_run_id", "state", "owner_plane", "ledger", "receipts"],
    `fixture_acceptance_iteration_${expectedIteration}_normalization_keys_invalid`);
  if (research.state !== "succeeded" || research.owner_plane !== "portfolio_os" ||
      normalization.state !== "succeeded" || normalization.owner_plane !== "portfolio_os") {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_not_succeeded`);
  }
  const researchStageRunId = safeId(
    research,
    "stage_run_id",
    `fixture_acceptance_iteration_${expectedIteration}_research_id_invalid`,
  );
  const normalizationStageRunId = safeId(
    normalization,
    "stage_run_id",
    `fixture_acceptance_iteration_${expectedIteration}_normalization_id_invalid`,
  );
  if (researchStageRunId === normalizationStageRunId) {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_stage_identity_duplicate`);
  }
  const rawEvidence = await verifyArtifactBinding(
    research.raw_evidence,
    root,
    `iteration_${expectedIteration}_raw_evidence`,
    { json: true },
  );
  const ledger = (await verifyArtifactBinding(
    normalization.ledger,
    root,
    `iteration_${expectedIteration}_ledger`,
  )).binding;
  const researchReceipts = await verifyStageReceipts(
    research.receipts,
    root,
    `iteration_${expectedIteration}_research`,
  );
  const normalizationReceipts = await verifyStageReceipts(
    normalization.receipts,
    root,
    `iteration_${expectedIteration}_normalization`,
  );
  const stageReceipts = [...researchReceipts, ...normalizationReceipts];
  if (stageReceipts.length < 2 || stageReceipts.length > 10) {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_receipt_count_invalid`);
  }
  const rawManifest = asRecord(
    rawEvidence.value,
    `fixture_acceptance_iteration_${expectedIteration}_raw_manifest_invalid`,
  );
  if (rawManifest.schema_version !== "pos.raw_evidence_manifest.v2") {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_raw_manifest_invalid`);
  }
  if (!researchReceipts.some((receipt) =>
    receipt.binding.path === rawEvidence.binding.path &&
    receipt.binding.sha256 === rawEvidence.binding.sha256)) {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_raw_receipt_binding_missing`);
  }
  const sourceRunBinding = asRecord(
    rawManifest.source_run_receipt,
    `fixture_acceptance_iteration_${expectedIteration}_source_run_binding_invalid`,
  );
  exactKeys(sourceRunBinding, ["path", "sha256"],
    `fixture_acceptance_iteration_${expectedIteration}_source_run_binding_invalid`);
  const sourceRun = researchReceipts.find((receipt) =>
    receipt.binding.path === sourceRunBinding.path &&
    receipt.binding.sha256 === sourceRunBinding.sha256);
  if (!sourceRun) {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_source_run_binding_missing`);
  }
  const sourceRunValue = asRecord(
    sourceRun.value,
    `fixture_acceptance_iteration_${expectedIteration}_source_run_invalid`,
  );
  if (sourceRunValue.schema_version !== "pos.source_run_receipt.v2") {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_source_run_invalid`);
  }
  const sourcePlan = asRecord(
    sourceRunValue.plan,
    `fixture_acceptance_iteration_${expectedIteration}_source_plan_invalid`,
  );
  if (sourcePlan.schema_version !== "pos.paperclip_research_execution_plan.v1" ||
      sourcePlan.target_repo !== rawManifest.target_repo ||
      sourcePlan.source_registry_sha256 !== rawManifest.source_registry_sha256 ||
      !Array.isArray(sourcePlan.source_requests) || sourcePlan.source_requests.length < 1) {
    throw new Error(`fixture_acceptance_iteration_${expectedIteration}_source_plan_invalid`);
  }
  return {
    summary: {
      iteration: expectedIteration,
      research_stage_run_id: researchStageRunId,
      normalization_stage_run_id: normalizationStageRunId,
      raw_evidence_hash: rawEvidence.binding.sha256,
      ledger_hash: ledger.sha256,
      stage_receipts: stageReceipts.map((receipt) => receipt.binding),
    },
    sourcePlan,
  };
}

async function verifyCycleEvidence(evidencePath: string, expectedSha256: string) {
  const evidenceArtifact = await readTrustedJsonFile(
    evidencePath,
    "fixture_acceptance_cycle_evidence",
    { maxBytes: 16 * 1024 * 1024 },
  );
  if (evidenceArtifact.sha256 !== expectedSha256) throw new Error("fixture_acceptance_cycle_evidence_hash_mismatch");
  const evidence = evidenceArtifact.value;
  exactKeys(evidence, [
    "schema_version", "mode", "isolation_root", "identity", "runtime_guard", "iterations",
    "continuation", "next_research", "invariants", "completed_at",
  ], "fixture_acceptance_cycle_evidence_keys_invalid");
  if (evidence.schema_version !== EVIDENCE_SCHEMA || evidence.mode !== "fixture") {
    throw new Error("fixture_acceptance_cycle_evidence_schema_invalid");
  }
  const isolationRoot = await requireTrustedDirectory(
    requiredString(evidence, "isolation_root", "fixture_acceptance_isolation_root_invalid"),
    "fixture_acceptance_isolation_root",
  );
  if (!pathWithin(isolationRoot, evidenceArtifact.path)) {
    throw new Error("fixture_acceptance_evidence_outside_isolation_root");
  }

  const identity = asRecord(evidence.identity, "fixture_acceptance_identity_invalid");
  exactKeys(identity, ["company_id", "workflow_id", "run_id", "correlation_id", "target_repo"],
    "fixture_acceptance_identity_keys_invalid");
  const companyId = safeId(identity, "company_id", "fixture_acceptance_company_id_invalid");
  const workflowId = safeId(identity, "workflow_id", "fixture_acceptance_workflow_id_invalid");
  const runId = safeId(identity, "run_id", "fixture_acceptance_run_id_invalid");
  const correlationId = safeId(identity, "correlation_id", "fixture_acceptance_correlation_id_invalid");
  const targetRepo = requiredString(identity, "target_repo", "fixture_acceptance_target_repo_invalid");
  if (!targetRepo.startsWith("fixture/") || targetRepo.split("/").length !== 2) {
    throw new Error("fixture_acceptance_live_target_forbidden");
  }

  const guard = asRecord(evidence.runtime_guard, "fixture_acceptance_runtime_guard_invalid");
  exactKeys(guard, [
    "network_access", "provider_calls", "external_mutations", "input_tokens", "output_tokens", "cost_usd",
  ], "fixture_acceptance_runtime_guard_keys_invalid");
  if (guard.network_access !== false || guard.provider_calls !== 0 || guard.external_mutations !== 0 ||
      guard.input_tokens !== 0 || guard.output_tokens !== 0 || guard.cost_usd !== 0) {
    throw new Error("fixture_acceptance_spend_or_live_side_effect_forbidden");
  }

  if (!Array.isArray(evidence.iterations) || evidence.iterations.length !== 2) {
    throw new Error("fixture_acceptance_exactly_two_iterations_required");
  }
  const firstIteration = await verifyIteration(evidence.iterations[0], isolationRoot, 1);
  const secondIteration = await verifyIteration(evidence.iterations[1], isolationRoot, 2);
  if (firstIteration.summary.raw_evidence_hash === secondIteration.summary.raw_evidence_hash) {
    throw new Error("fixture_acceptance_raw_evidence_hash_unchanged");
  }
  if (firstIteration.summary.ledger_hash === secondIteration.summary.ledger_hash) {
    throw new Error("fixture_acceptance_ledger_hash_unchanged");
  }
  const allStageIds = [
    firstIteration.summary.research_stage_run_id,
    firstIteration.summary.normalization_stage_run_id,
    secondIteration.summary.research_stage_run_id,
    secondIteration.summary.normalization_stage_run_id,
  ];
  if (new Set(allStageIds).size !== allStageIds.length) throw new Error("fixture_acceptance_stage_identity_duplicate");

  const continuation = asRecord(evidence.continuation, "fixture_acceptance_continuation_invalid");
  exactKeys(continuation, [
    "learning_output_hash", "authority", "not_before", "expires_at", "due_claimed_at",
    "reconciliation_interval_ms", "manual_consumer_invocations",
  ], "fixture_acceptance_continuation_keys_invalid");
  const learningOutputHash = sha256(continuation, "learning_output_hash", "fixture_acceptance_learning_hash_invalid");
  const notBefore = dateTime(continuation, "not_before", "fixture_acceptance_not_before_invalid");
  const expiresAt = dateTime(continuation, "expires_at", "fixture_acceptance_expires_at_invalid");
  const dueClaimedAt = dateTime(continuation, "due_claimed_at", "fixture_acceptance_due_claimed_at_invalid");
  const reconciliationIntervalMs = integer(
    continuation,
    "reconciliation_interval_ms",
    "fixture_acceptance_reconciliation_interval_invalid",
  );
  if (reconciliationIntervalMs < 1_000 || continuation.manual_consumer_invocations !== 0 ||
      notBefore >= expiresAt || dueClaimedAt < notBefore ||
      dueClaimedAt.getTime() - notBefore.getTime() > reconciliationIntervalMs * 2) {
    throw new Error("fixture_acceptance_autonomous_continuation_invalid");
  }
  const continuationAuthority = await verifyFixtureAuthority(continuation.authority, {
    root: isolationRoot,
    targetRepo,
    iteration: 2,
    label: "iteration_2_authority",
  });
  const sourcePlanContinuation = asRecord(
    secondIteration.sourcePlan.continuation,
    "fixture_acceptance_iteration_2_source_plan_continuation_invalid",
  );
  const sourcePlanAuthorization = asRecord(
    sourcePlanContinuation.authorization,
    "fixture_acceptance_iteration_2_source_plan_authorization_invalid",
  );
  exactKeys(sourcePlanAuthorization, ["schema_version", "path", "sha256"],
    "fixture_acceptance_iteration_2_source_plan_authorization_invalid");
  if (continuationAuthority.notBefore.getTime() !== notBefore.getTime() ||
      continuationAuthority.expiresAt.getTime() !== expiresAt.getTime() ||
      sourcePlanContinuation.iteration !== 2 ||
      sourcePlanContinuation.prior_raw_evidence_sha256 !== firstIteration.summary.raw_evidence_hash ||
      sourcePlanAuthorization.schema_version !== "pos.next_research_authorization.v2" ||
      sourcePlanAuthorization.path !== continuationAuthority.binding.path ||
      sourcePlanAuthorization.sha256 !== continuationAuthority.binding.sha256 ||
      posStableJson(secondIteration.sourcePlan.source_requests) !==
        posStableJson(continuationAuthority.sourceRequests)) {
    throw new Error("fixture_acceptance_iteration_2_authority_lineage_invalid");
  }

  const nextResearch = asRecord(evidence.next_research, "fixture_acceptance_next_research_invalid");
  exactKeys(nextResearch, [
    "iteration", "stage_run_id", "state", "owner_plane", "event_count", "authority",
    "manual_consumer_invocations",
  ], "fixture_acceptance_next_research_keys_invalid");
  if (nextResearch.iteration !== 3 || nextResearch.state !== "pending" ||
      nextResearch.owner_plane !== "portfolio_os" || nextResearch.event_count !== 1 ||
      nextResearch.manual_consumer_invocations !== 0) {
    throw new Error("fixture_acceptance_next_research_not_queued");
  }
  const nextResearchStageRunId = safeId(
    nextResearch,
    "stage_run_id",
    "fixture_acceptance_next_research_stage_id_invalid",
  );
  if (allStageIds.includes(nextResearchStageRunId)) throw new Error("fixture_acceptance_next_research_stage_duplicate");
  const nextResearchAuthority = await verifyFixtureAuthority(nextResearch.authority, {
    root: isolationRoot,
    targetRepo,
    iteration: 3,
    label: "iteration_3_authority",
  });
  const secondFixtureHashes = new Set(
    continuationAuthority.offlineFixtures.map((binding) => binding.sha256),
  );
  if (nextResearchAuthority.offlineFixtures.some((binding) =>
    secondFixtureHashes.has(binding.sha256))) {
    throw new Error("fixture_acceptance_iteration_3_changed_hash_trigger_missing");
  }

  const invariants = asRecord(evidence.invariants, "fixture_acceptance_invariants_invalid");
  exactKeys(invariants, [
    "same_workflow", "same_correlation_lineage", "duplicate_stage_count", "duplicate_release_count",
    "orphan_lease_count", "all_receipts_verified",
  ], "fixture_acceptance_invariant_keys_invalid");
  if (invariants.same_workflow !== true || invariants.same_correlation_lineage !== true ||
      invariants.duplicate_stage_count !== 0 || invariants.duplicate_release_count !== 0 ||
      invariants.orphan_lease_count !== 0 || invariants.all_receipts_verified !== true) {
    throw new Error("fixture_acceptance_invariant_failed");
  }
  const completedAt = dateTime(evidence, "completed_at", "fixture_acceptance_completed_at_invalid");
  if (completedAt < dueClaimedAt) throw new Error("fixture_acceptance_completion_time_invalid");

  const closeout = {
    schema_version: CLOSEOUT_SCHEMA,
    mode: "fixture",
    company_id: companyId,
    workflow_id: workflowId,
    run_id: runId,
    correlation_id: correlationId,
    first_iteration: firstIteration.summary,
    continuation: {
      learning_output_hash: learningOutputHash,
      authority: continuationAuthority.binding,
      not_before: notBefore.toISOString(),
      expires_at: expiresAt.toISOString(),
      due_claimed_at: dueClaimedAt.toISOString(),
      reconciliation_interval_ms: reconciliationIntervalMs,
      manual_consumer_invocations: 0,
    },
    second_iteration: secondIteration.summary,
    next_research: {
      iteration: 3,
      stage_run_id: nextResearchStageRunId,
      state: "pending",
      owner_plane: "portfolio_os",
      event_count: 1,
      authority: nextResearchAuthority.binding,
      manual_consumer_invocations: 0,
    },
    invariants: {
      same_workflow: true,
      same_correlation_lineage: true,
      raw_evidence_hash_changed: true,
      ledger_hash_changed: true,
      duplicate_stage_count: 0,
      duplicate_release_count: 0,
      orphan_lease_count: 0,
      all_receipts_verified: true,
    },
    generated_at: completedAt.toISOString(),
  };
  return {
    closeout,
    completedAt,
    isolationRoot,
    identity: { companyId, workflowId, runId, correlationId, targetRepo },
    evidence: { path: evidenceArtifact.path, sha256: evidenceArtifact.sha256 },
  };
}

async function installOrVerifyReceipt(receiptPath: string, value: unknown, label: string) {
  const existing = await lstat(receiptPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return writeImmutableJsonReceipt(receiptPath, value);
  const artifact = await readTrustedJsonFile(receiptPath, label, { maxBytes: 32 * 1024 * 1024 });
  if (factoryCanonicalJsonSha256(artifact.value) !== factoryCanonicalJsonSha256(value)) {
    throw new Error(`fixture_acceptance_${label}_conflict`);
  }
  return artifact.sha256;
}

export async function runProfitFlywheelFixtureAcceptance(options: FixtureAcceptanceOptions) {
  const receiptDir = await prepareTrustedReceiptDirectory(
    options.receiptDir,
    "fixture_acceptance_receipt_dir",
  );
  const manifestArtifact = await readTrustedJsonFile(
    options.manifestPath,
    "fixture_acceptance_manifest",
    { maxBytes: 4 * 1024 * 1024 },
  );
  const manifest = manifestArtifact.value;
  exactKeys(manifest, ["schema_version", "required_consecutive_cycles", "cycles"],
    "fixture_acceptance_manifest_keys_invalid");
  if (manifest.schema_version !== MANIFEST_SCHEMA || manifest.required_consecutive_cycles !== REQUIRED_CYCLES ||
      !Array.isArray(manifest.cycles) || manifest.cycles.length !== REQUIRED_CYCLES) {
    throw new Error("fixture_acceptance_requires_exactly_20_cycles");
  }

  const cycleIds = new Set<string>();
  const workflowIds = new Set<string>();
  const runIds = new Set<string>();
  const correlationIds = new Set<string>();
  const isolationRoots: string[] = [];
  const cycles: Array<Record<string, unknown>> = [];
  let latestCompletedAt = new Date(0);
  for (let index = 0; index < manifest.cycles.length; index += 1) {
    const entry = asRecord(manifest.cycles[index], "fixture_acceptance_manifest_cycle_invalid");
    exactKeys(entry, ["cycle_id", "evidence"], "fixture_acceptance_manifest_cycle_keys_invalid");
    const cycleId = safeId(entry, "cycle_id", "fixture_acceptance_cycle_id_invalid");
    if (cycleIds.has(cycleId)) throw new Error("fixture_acceptance_cycle_id_duplicate");
    cycleIds.add(cycleId);
    const binding = asRecord(entry.evidence, "fixture_acceptance_evidence_binding_invalid");
    exactKeys(binding, ["path", "sha256"], "fixture_acceptance_evidence_binding_invalid");
    const cycle = await verifyCycleEvidence(
      requiredString(binding, "path", "fixture_acceptance_evidence_path_invalid"),
      sha256(binding, "sha256", "fixture_acceptance_evidence_sha256_invalid"),
    );
    if (isolationRoots.some((root) => root === cycle.isolationRoot || pathWithin(root, cycle.isolationRoot) ||
        pathWithin(cycle.isolationRoot, root))) {
      throw new Error("fixture_acceptance_isolation_root_reused");
    }
    if (pathWithin(cycle.isolationRoot, receiptDir) || pathWithin(receiptDir, cycle.isolationRoot) ||
        cycle.isolationRoot === receiptDir) {
      throw new Error("fixture_acceptance_receipt_dir_not_isolated");
    }
    if (workflowIds.has(cycle.identity.workflowId) || runIds.has(cycle.identity.runId) ||
        correlationIds.has(cycle.identity.correlationId)) {
      throw new Error("fixture_acceptance_cycle_identity_reused");
    }
    workflowIds.add(cycle.identity.workflowId);
    runIds.add(cycle.identity.runId);
    correlationIds.add(cycle.identity.correlationId);
    isolationRoots.push(cycle.isolationRoot);
    if (cycle.completedAt < latestCompletedAt) throw new Error("fixture_acceptance_cycles_not_consecutive");
    latestCompletedAt = cycle.completedAt;
    const closeoutPath = path.join(
      receiptDir,
      `${String(index + 1).padStart(2, "0")}-${cycleId}-two-iteration-closeout.json`,
    );
    const closeoutSha256 = await installOrVerifyReceipt(
      closeoutPath,
      cycle.closeout,
      `cycle_${index + 1}_closeout`,
    );
    cycles.push({
      sequence: index + 1,
      cycle_id: cycleId,
      isolation_root: cycle.isolationRoot,
      target_repo: cycle.identity.targetRepo,
      company_id: cycle.identity.companyId,
      workflow_id: cycle.identity.workflowId,
      run_id: cycle.identity.runId,
      correlation_id: cycle.identity.correlationId,
      evidence: cycle.evidence,
      closeout: { path: closeoutPath, sha256: closeoutSha256 },
      status: "passed",
    });
  }

  const aggregate = {
    schema_version: ACCEPTANCE_SCHEMA,
    mode: "fixture",
    manifest: { path: manifestArtifact.path, sha256: manifestArtifact.sha256 },
    required_consecutive_cycles: REQUIRED_CYCLES,
    passed_consecutive_cycles: cycles.length,
    cycles,
    invariants: {
      isolated_roots: true,
      exactly_two_completed_iterations_per_cycle: true,
      next_research_queued_per_cycle: true,
      manual_consumer_invocations: 0,
      network_access: false,
      provider_calls: 0,
      external_mutations: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      duplicate_stage_count: 0,
      duplicate_release_count: 0,
      orphan_lease_count: 0,
      all_receipts_verified: true,
    },
    generated_at: latestCompletedAt.toISOString(),
  };
  const receiptPath = path.join(receiptDir, "fixture-20-cycle-acceptance.json");
  const receiptSha256 = await installOrVerifyReceipt(receiptPath, aggregate, "aggregate_receipt");
  return {
    status: "passed" as const,
    passedCycles: cycles.length,
    receiptPath,
    receiptSha256,
    receipt: aggregate,
  };
}

export function parseFixtureAcceptanceCliArgs(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values: Partial<FixtureAcceptanceOptions> = {};
  const flags: Record<string, keyof FixtureAcceptanceOptions> = {
    "--manifest": "manifestPath",
    "--receipt-dir": "receiptDir",
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const key = flags[flag];
    const value = args[index + 1];
    if (!key || flag.includes("=") || values[key] !== undefined || !value || value.startsWith("--")) {
      throw new Error("fixture_acceptance_argument_invalid");
    }
    values[key] = value;
    index += 1;
  }
  if (!values.manifestPath) throw new Error("fixture_acceptance_manifest_required");
  if (!values.receiptDir) throw new Error("fixture_acceptance_receipt_dir_required");
  return values as FixtureAcceptanceOptions;
}

function usage() {
  return "Usage: pnpm ops:profit-flywheel-fixture-acceptance -- --manifest <absolute-json> --receipt-dir <absolute-directory>";
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(usage());
    return;
  }
  const result = await runProfitFlywheelFixtureAcceptance(parseFixtureAcceptanceCliArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    status: result.status,
    passed_cycles: result.passedCycles,
    receipt_path: result.receiptPath,
    receipt_sha256: result.receiptSha256,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      blocker: error instanceof Error ? error.message : "fixture_acceptance_unknown_failure",
    }));
    process.exit(1);
  });
}
