import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  approvals,
  profitFlywheelWorkflows,
  type Db,
} from "@paperclipai/db";
import {
  FACTORY_LAUNCH_APPROVAL_TYPES,
  factoryLaunchApprovalPayloadSchema,
  type FactoryLaunchApprovalPayload,
} from "@paperclipai/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  factoryCanonicalJsonBytes,
  factoryCanonicalJsonSha256,
  factoryCanonicalJsonValue,
} from "../ops/factory-canonical-json.js";
import { writeImmutableJsonReceipt } from "../ops/immutable-json-receipt.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedJsonFile,
} from "../ops/trusted-receipt-directory.js";
import type {
  FactoryLaunchAuthority,
  FactoryLaunchAuthorityDecision,
  FactoryLaunchAuthorityInput,
} from "./factory-launch-authority.js";

const CONSUMPTION_SCHEMA = "paperclip.factory_launch_consumption.v1";
const CONSUMPTION_KEY = "factory_launch_consumption";
const EXCLUDED_TARGET = "glitch-cipher-syndicate/leadforge";
const SHA256 = /^[0-9a-f]{64}$/;

type ApprovalRow = typeof approvals.$inferSelect;
type WorkflowRow = typeof profitFlywheelWorkflows.$inferSelect;
type ConsumptionBinding = {
  schema_version: typeof CONSUMPTION_SCHEMA;
  receipt_path: string;
  receipt_sha256: string;
  consumed_at: string;
};

export interface DbFactoryLaunchAuthorityOptions {
  receiptDir: string;
  /** Re-resolve every source-backed hash before an approval can authorize work. */
  verifyBindings: (payload: FactoryLaunchApprovalPayload) => Promise<boolean>;
  now?: () => Date;
}

function denied(code: string, detail: string, terminal = false): FactoryLaunchAuthorityDecision {
  return { allowed: false, code, detail, terminal };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function approvalPayload(row: ApprovalRow): FactoryLaunchApprovalPayload | null {
  const { [CONSUMPTION_KEY]: _consumption, ...payload } = asRecord(row.payload);
  const parsed = factoryLaunchApprovalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function consumptionBinding(row: ApprovalRow): ConsumptionBinding | null {
  const value = asRecord(asRecord(row.payload)[CONSUMPTION_KEY]);
  if (value.schema_version !== CONSUMPTION_SCHEMA ||
      typeof value.receipt_path !== "string" || !path.isAbsolute(value.receipt_path) ||
      typeof value.receipt_sha256 !== "string" || !SHA256.test(value.receipt_sha256) ||
      typeof value.consumed_at !== "string" || !Number.isFinite(Date.parse(value.consumed_at))) return null;
  return value as ConsumptionBinding;
}

function matchesRoot(
  row: ApprovalRow,
  payload: FactoryLaunchApprovalPayload,
  input: FactoryLaunchAuthorityInput,
  rootInputHash: string | null,
) {
  const expectedType = input.mode === "shadow"
    ? "profit_flywheel_shadow_launch"
    : "profit_flywheel_production_launch";
  return row.type === expectedType && payload.requested_mode === input.mode &&
    payload.company_id === input.companyId && payload.target_repo === input.targetRepo &&
    payload.run_id === input.runId && payload.input_hash === rootInputHash;
}

async function persistedWorkflowRoot(
  queryDb: Db,
  input: FactoryLaunchAuthorityInput,
) {
  if (!input.companyId || !input.runId) return null;
  return queryDb.select().from(profitFlywheelWorkflows).where(and(
    eq(profitFlywheelWorkflows.companyId, input.companyId),
    eq(profitFlywheelWorkflows.runId, input.runId),
  )).then((rows) => rows[0] ?? null);
}

function verifyPersistedWorkflowRoot(
  workflow: WorkflowRow | null,
  payload: FactoryLaunchApprovalPayload,
  input: FactoryLaunchAuthorityInput,
) {
  if (!workflow || workflow.targetRepo !== payload.target_repo ||
      workflow.sourceDispatchHash !== payload.input_hash ||
      (input.workflowId !== undefined && workflow.id !== input.workflowId) ||
      (payload.workflow_id !== undefined && workflow.id !== payload.workflow_id)) return false;
  return true;
}

async function verifyConsumedReceipt(row: ApprovalRow, binding: ConsumptionBinding) {
  const artifact = await readTrustedJsonFile(binding.receipt_path, "factory_launch_consumption", {
    maxBytes: 4 * 1024 * 1024,
    requireCurrentOwner: true,
  });
  const receipt = asRecord(artifact.value);
  return artifact.sha256 === binding.receipt_sha256 &&
    receipt.schema_version === CONSUMPTION_SCHEMA && receipt.approval_id === row.id &&
    receipt.approval_payload_sha256 === factoryCanonicalJsonSha256(approvalPayload(row));
}

async function writeConsumptionReceipt(
  receiptDir: string,
  row: ApprovalRow,
  payload: FactoryLaunchApprovalPayload,
  input: FactoryLaunchAuthorityInput,
  consumedAt: Date,
) {
  const body = factoryCanonicalJsonValue({
    schema_version: CONSUMPTION_SCHEMA,
    approval_id: row.id,
    approval_type: row.type,
    company_id: payload.company_id,
    requested_mode: payload.requested_mode,
    target_repo: payload.target_repo,
    workflow_id: payload.workflow_id ?? null,
    run_id: payload.run_id,
    root_input_hash: payload.input_hash,
    approval_payload_sha256: factoryCanonicalJsonSha256(payload),
    decided_by_user_id: row.decidedByUserId,
    decided_at: row.decidedAt?.toISOString() ?? null,
    consumed_at: consumedAt.toISOString(),
    admission: {
      kind: input.kind,
      workflow_id: input.workflowId ?? null,
      stage: input.stage ?? null,
    },
  });
  const receiptSha256 = createHash("sha256").update(factoryCanonicalJsonBytes(body)).digest("hex");
  const directory = path.join(path.resolve(receiptDir), "sha256", receiptSha256.slice(0, 2));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await prepareTrustedReceiptDirectory(directory, "factory_launch_consumption_directory");
  const receiptPath = path.join(directory, `${receiptSha256}.json`);
  const installedSha256 = await writeImmutableJsonReceipt(receiptPath, body);
  if (installedSha256 !== receiptSha256) throw new Error("factory_launch_consumption_hash_mismatch");
  return { receiptPath, receiptSha256 };
}

/**
 * Consumes one approved launch at the workflow root and reuses only that
 * immutable consumption for later work whose persisted workflow still binds to
 * the approved run, repository and root dispatch hash.
 */
export function createDbFactoryLaunchAuthority(
  db: Db,
  options: DbFactoryLaunchAuthorityOptions,
): FactoryLaunchAuthority {
  const clock = options.now ?? (() => new Date());
  return {
    async claim(input) {
      if (input.mode === "fixture") {
        return denied("factory_live_authority_fixture_mode_invalid", "DB live authority cannot authorize fixture work.", true);
      }
      if (!input.companyId || !input.targetRepo || !input.runId || !input.inputHash) {
        return denied("factory_live_approval_binding_missing", "Live launch requires exact company, repository, run, and input bindings.", true);
      }
      if (input.targetRepo.toLowerCase() === EXCLUDED_TARGET) {
        return denied("factory_launch_target_excluded", "The requested repository is excluded from factory launch authority.", true);
      }
      const now = clock();
      try {
        return await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          const rows = await tx.select().from(approvals).where(and(
            eq(approvals.companyId, input.companyId!),
            eq(approvals.status, "approved"),
            inArray(approvals.type, [...FACTORY_LAUNCH_APPROVAL_TYPES]),
          )).orderBy(desc(approvals.decidedAt), desc(approvals.updatedAt)).for("update");
          const workflowRoot = input.kind === "portfolio_dispatch"
            ? null
            : await persistedWorkflowRoot(tx, input);
          // Every approval comparison uses the workflow-root hash. Dispatch
          // supplies it directly; later stage claims derive it from the
          // persisted workflow rather than confusing a stage input for the
          // approved root input.
          const rootInputHash = input.kind === "portfolio_dispatch"
            ? input.inputHash!
            : workflowRoot?.sourceDispatchHash ?? null;
          let bindingDrift = false;
          for (const row of rows) {
            const payload = approvalPayload(row);
            if (!payload || !matchesRoot(row, payload, input, rootInputHash)) continue;
            if (!await options.verifyBindings(payload)) {
              bindingDrift = true;
              continue;
            }
            const consumed = consumptionBinding(row);
            if (consumed) {
              if (input.kind !== "portfolio_dispatch" &&
                  !verifyPersistedWorkflowRoot(workflowRoot, payload, input)) continue;
              if (!await verifyConsumedReceipt(row, consumed)) {
                return denied("factory_launch_consumption_receipt_invalid", "The consumed launch approval no longer has a valid immutable receipt.", true);
              }
              return {
                allowed: true,
                code: "factory_workflow_root_authorized",
                detail: "Persisted workflow remains bound to the consumed live launch approval.",
                terminal: false,
                approvalId: row.id,
                consumptionReceipt: { path: consumed.receipt_path, sha256: consumed.receipt_sha256 },
              };
            }
            if (Date.parse(payload.expires_at) <= now.getTime()) continue;
            if (input.kind === "portfolio_dispatch") {
              if (payload.input_hash !== input.inputHash || payload.workflow_id !== undefined) continue;
            } else if (!verifyPersistedWorkflowRoot(workflowRoot, payload, input)) {
              continue;
            }
            const receipt = await writeConsumptionReceipt(options.receiptDir, row, payload, input, now);
            const binding: ConsumptionBinding = {
              schema_version: CONSUMPTION_SCHEMA,
              receipt_path: receipt.receiptPath,
              receipt_sha256: receipt.receiptSha256,
              consumed_at: now.toISOString(),
            };
            const updated = await tx.update(approvals).set({
              payload: { ...asRecord(row.payload), [CONSUMPTION_KEY]: binding },
              updatedAt: now,
            }).where(and(eq(approvals.id, row.id), eq(approvals.status, "approved"))).returning({ id: approvals.id });
            if (updated.length !== 1) throw new Error("factory_launch_approval_consumption_race");
            return {
              allowed: true,
              code: "factory_workflow_root_approval_consumed",
              detail: "Exact live launch approval consumed and sealed by immutable receipt.",
              terminal: false,
              approvalId: row.id,
              consumptionReceipt: { path: receipt.receiptPath, sha256: receipt.receiptSha256 },
            };
          }
          if (bindingDrift) {
            return denied(
              "factory_live_approval_binding_drift",
              "A matching launch approval exists, but its source-backed runtime, contract, route, credential, or evidence binding is no longer current.",
              true,
            );
          }
          return denied("factory_live_approval_required", "No unexpired exact approved launch authority matches this workflow root.");
        });
      } catch {
        return denied("factory_live_approval_unavailable", "DB-backed launch approval consumption failed closed.");
      }
    },
  };
}
