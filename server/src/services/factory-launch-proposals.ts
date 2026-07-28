import {
  companySecrets,
  companySecretVersions,
  profitFlywheelReceipts,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import { factoryLaunchApprovalPayloadSchema } from "@paperclipai/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { readTrustedJsonFile } from "../ops/trusted-receipt-directory.js";
import { getAdapterPluginByType } from "./adapter-plugin-store.js";
import { approvalService } from "./approvals.js";
import { verifyManagedAdapterPluginRecord } from "./managed-adapter-bundle.js";
import {
  PINNED_EXECUTION_GOLDEN_VECTORS_SHA256,
} from "./profit-flywheel-contract.js";
import { loadManagedProfitFlywheelAuthority } from "./managed-profit-flywheel-authority.js";
import { providerPolicyRouteCoreSha256 } from "./provider-route-hash.js";

export interface FactoryLaunchProposalInput {
  companyId: string;
  requestedMode: "shadow" | "production";
  targetRepo: string;
  runId: string;
  inputHash: string;
  workflowId?: string;
  expiresInSeconds: number;
  requestedByUserId: string;
  portfolioOsRuntimeRoot: string;
  now?: Date;
}

async function currentCredentialEpochHashes(db: Db, companyId: string) {
  const rows = await db.select({
    name: companySecrets.name,
    version: companySecretVersions.version,
    valueSha256: companySecretVersions.valueSha256,
  }).from(companySecrets).innerJoin(companySecretVersions, and(
    eq(companySecretVersions.secretId, companySecrets.id),
    eq(companySecretVersions.version, companySecrets.latestVersion),
  )).where(and(eq(companySecrets.companyId, companyId), isNull(companySecretVersions.revokedAt)));
  return shaMap(rows.map((row) => [`${row.name}@${row.version}`, row.valueSha256]));
}

export async function verifyFactoryLaunchProposalBindings(
  db: Db,
  payload: ReturnType<typeof factoryLaunchApprovalPayloadSchema.parse>,
  portfolioOsRuntimeRoot: string,
) {
  const [managedAuthority, credentialEpochHashes] = await Promise.all([
    loadManagedProfitFlywheelAuthority({ runtimeRoot: portfolioOsRuntimeRoot }),
    currentCredentialEpochHashes(db, payload.company_id),
  ]);
  const { runtime: posRuntime, contract, providerPolicyAuthority: verifiedAuthority } = managedAuthority;
  const policy = verifiedAuthority.providerPolicy;
  const adapterRecord = getAdapterPluginByType("hermes_local");
  if (!adapterRecord || adapterRecord.installKind !== "managed_immutable_bundle") return false;
  const adapter = await verifyManagedAdapterPluginRecord(adapterRecord);
  const posManifest = await readTrustedJsonFile(posRuntime.current.runtime_manifest.path,
    "factory_launch_proposal_pos_manifest", { maxBytes: 4 * 1024 * 1024 });
  const posSource = (posManifest.value.source && typeof posManifest.value.source === "object" &&
    !Array.isArray(posManifest.value.source)) ? posManifest.value.source as Record<string, unknown> : {};
  const expectedContracts = shaMap([
    ["profit_flywheel_contract", contract.sha256],
    ["profit_flywheel_schema", contract.schemaSha256],
    ["dispatch_schema", contract.dispatchSchemaSha256],
    ["learning_schema", contract.learningSchemaSha256],
  ]);
  const expectedRoutes = shaMap(Object.entries(policy.policy.routes).map(([id, route]) =>
    [id, providerPolicyRouteCoreSha256(route)]));
  if (!isDeepStrictEqual(payload.contract_hashes, expectedContracts) ||
      !isDeepStrictEqual(payload.vector_hashes, { execution: PINNED_EXECUTION_GOLDEN_VECTORS_SHA256 }) ||
      !isDeepStrictEqual(payload.provider_route_hashes, expectedRoutes) ||
      !isDeepStrictEqual(payload.credential_epoch_hashes, credentialEpochHashes) ||
      payload.pos_runtime.manifest_path !== posRuntime.current.runtime_manifest.path ||
      payload.pos_runtime.manifest_sha256 !== posRuntime.current.runtime_manifest.sha256 ||
      payload.pos_runtime.source_commit !== posSource.commit ||
      payload.adapter_bundle.manifest_sha256 !== adapter.manifestSha256 ||
      payload.adapter_bundle.archive_sha256 !== adapter.bundleSha256 ||
      payload.adapter_bundle.version !== adapter.packageVersion ||
      payload.adapter_bundle.source_commit !== adapter.sourceGitHead) return false;
  if (payload.requested_mode === "production") {
    const receipts = await db.select({
      receiptType: profitFlywheelReceipts.receiptType,
      contentHash: profitFlywheelReceipts.contentHash,
    }).from(profitFlywheelReceipts).where(and(
      eq(profitFlywheelReceipts.companyId, payload.company_id),
      eq(profitFlywheelReceipts.status, "valid"),
    ));
    if (!receipts.some((row) => row.receiptType === "profit_flywheel_shadow_closeout" &&
        row.contentHash === payload.shadow_closeout_receipt_sha256) ||
        !receipts.some((row) => row.receiptType === "profit_flywheel_canary_closeout" &&
        row.contentHash === payload.canary_receipt_sha256)) return false;
  }
  return true;
}

function shaMap(entries: Array<[string, string]>) {
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right, "en")));
}

/** Build and persist a pending proposal exclusively from server-verified state. */
export async function createFactoryLaunchProposal(db: Db, input: FactoryLaunchProposalInput) {
  const now = input.now ?? new Date();
  const workflow = input.workflowId
    ? await db.select().from(profitFlywheelWorkflows).where(and(
        eq(profitFlywheelWorkflows.id, input.workflowId),
        eq(profitFlywheelWorkflows.companyId, input.companyId),
      )).then((rows) => rows[0] ?? null)
    : null;
  if (input.workflowId && (!workflow || workflow.runId !== input.runId || workflow.targetRepo !== input.targetRepo ||
      workflow.sourceDispatchHash !== input.inputHash)) {
    throw new Error("factory_launch_proposal_workflow_root_mismatch");
  }
  const [managedAuthority, credentialEpochHashes] = await Promise.all([
    loadManagedProfitFlywheelAuthority({ runtimeRoot: input.portfolioOsRuntimeRoot }),
    currentCredentialEpochHashes(db, input.companyId),
  ]);
  const { runtime: posRuntime, contract, providerPolicyAuthority: verifiedAuthority } = managedAuthority;
  const policy = verifiedAuthority.providerPolicy;
  if (Object.keys(credentialEpochHashes).length === 0) throw new Error("factory_launch_proposal_credentials_unavailable");
  const adapterRecord = getAdapterPluginByType("hermes_local");
  if (!adapterRecord || adapterRecord.installKind !== "managed_immutable_bundle") {
    throw new Error("factory_launch_proposal_adapter_unmanaged");
  }
  const adapter = await verifyManagedAdapterPluginRecord(adapterRecord);
  const posManifest = await readTrustedJsonFile(
    posRuntime.current.runtime_manifest.path,
    "factory_launch_proposal_pos_manifest",
    { maxBytes: 4 * 1024 * 1024 },
  );
  if (posManifest.sha256 !== posRuntime.current.runtime_manifest.sha256) {
    throw new Error("factory_launch_proposal_pos_manifest_mismatch");
  }
  const posSource = (posManifest.value.source && typeof posManifest.value.source === "object" &&
    !Array.isArray(posManifest.value.source)) ? posManifest.value.source as Record<string, unknown> : {};
  if (typeof posSource.commit !== "string" || !/^[0-9a-f]{40}$/.test(posSource.commit)) {
    throw new Error("factory_launch_proposal_pos_source_invalid");
  }
  const productionReceipts = input.requestedMode === "production"
    ? await db.select().from(profitFlywheelReceipts).where(and(
        eq(profitFlywheelReceipts.companyId, input.companyId),
        eq(profitFlywheelReceipts.status, "valid"),
      )).orderBy(desc(profitFlywheelReceipts.createdAt))
    : [];
  const shadowCloseout = productionReceipts.find((row) => row.receiptType === "profit_flywheel_shadow_closeout");
  const canaryCloseout = productionReceipts.find((row) => row.receiptType === "profit_flywheel_canary_closeout");
  if (input.requestedMode === "production" && (!shadowCloseout || !canaryCloseout)) {
    throw new Error("factory_launch_proposal_production_evidence_missing");
  }
  const payload = factoryLaunchApprovalPayloadSchema.parse({
    schema_version: "paperclip.factory_launch_approval.v1",
    company_id: input.companyId,
    target_repo: input.targetRepo,
    ...(input.workflowId ? { workflow_id: input.workflowId } : {}),
    run_id: input.runId,
    input_hash: input.inputHash,
    contract_hashes: shaMap([
      ["profit_flywheel_contract", contract.sha256],
      ["profit_flywheel_schema", contract.schemaSha256],
      ["dispatch_schema", contract.dispatchSchemaSha256],
      ["learning_schema", contract.learningSchemaSha256],
    ]),
    vector_hashes: { execution: PINNED_EXECUTION_GOLDEN_VECTORS_SHA256 },
    provider_route_hashes: shaMap(Object.entries(policy.policy.routes).map(([id, route]) =>
      [id, providerPolicyRouteCoreSha256(route)])),
    credential_epoch_hashes: credentialEpochHashes,
    pos_runtime: {
      manifest_path: posRuntime.current.runtime_manifest.path,
      manifest_sha256: posRuntime.current.runtime_manifest.sha256,
      source_commit: posSource.commit,
    },
    adapter_bundle: {
      manifest_sha256: adapter.manifestSha256,
      archive_sha256: adapter.bundleSha256,
      version: adapter.packageVersion,
      source_commit: adapter.sourceGitHead,
    },
    requested_mode: input.requestedMode,
    expires_at: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
    excluded_target_checked: true,
    fixture_bindings_absent: true,
    ...(shadowCloseout ? { shadow_closeout_receipt_sha256: shadowCloseout.contentHash } : {}),
    ...(canaryCloseout ? { canary_receipt_sha256: canaryCloseout.contentHash } : {}),
  });
  const approval = await approvalService(db).create(input.companyId, {
    type: input.requestedMode === "shadow"
      ? "profit_flywheel_shadow_launch"
      : "profit_flywheel_production_launch",
    payload,
    requestedByUserId: input.requestedByUserId,
    requestedByAgentId: null,
    status: "pending",
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    updatedAt: now,
  });
  return approval;
}
