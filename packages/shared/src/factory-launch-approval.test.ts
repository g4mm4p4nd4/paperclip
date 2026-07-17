import { describe, expect, it } from "vitest";
import { factoryLaunchApprovalPayloadSchema } from "./validators/factory-launch-approval.js";

const sha = (digit: string) => digit.repeat(64);

function validShadowApproval() {
  return {
    schema_version: "paperclip.factory_launch_approval.v1",
    company_id: "10000000-0000-4000-8000-000000000001",
    target_repo: "fixture/launch-target",
    workflow_id: "20000000-0000-4000-8000-000000000002",
    run_id: "factory-shadow-1",
    input_hash: sha("1"),
    contract_hashes: { profit_flywheel: sha("2") },
    vector_hashes: { consumer_protocol: sha("3") },
    provider_route_hashes: { code_deep: sha("4"), independent_review: sha("5") },
    credential_epoch_hashes: { paperclip_api: sha("6"), pos_journal: sha("7") },
    pos_runtime: {
      manifest_path: "/immutable/runtime-manifest.json",
      manifest_sha256: sha("8"),
      source_commit: "9".repeat(40),
    },
    adapter_bundle: {
      manifest_sha256: sha("a"),
      archive_sha256: sha("b"),
      version: "1.0.0-factory.1",
      source_commit: "c".repeat(40),
    },
    requested_mode: "shadow",
    expires_at: "2030-01-01T00:00:00.000Z",
    excluded_target_checked: true,
    fixture_bindings_absent: true,
  } as const;
}

describe("factory launch approval payload", () => {
  it("accepts an exact shadow binding without production authority", () => {
    expect(factoryLaunchApprovalPayloadSchema.parse(validShadowApproval())).toMatchObject({
      requested_mode: "shadow",
      target_repo: "fixture/launch-target",
    });
  });

  it("accepts a pre-workflow root binding so dispatch can consume authority before ingest", () => {
    const { workflow_id: _workflowId, ...rootApproval } = validShadowApproval();
    expect(factoryLaunchApprovalPayloadSchema.parse(rootApproval)).toMatchObject({
      run_id: "factory-shadow-1",
      input_hash: sha("1"),
    });
  });

  it("requires both shadow closeout and canary receipts for production", () => {
    const result = factoryLaunchApprovalPayloadSchema.safeParse({
      ...validShadowApproval(),
      requested_mode: "production",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["shadow_closeout_receipt_sha256", "canary_receipt_sha256"]),
      );
    }
  });

  it("rejects production closeout authority attached to a shadow approval", () => {
    expect(factoryLaunchApprovalPayloadSchema.safeParse({
      ...validShadowApproval(),
      shadow_closeout_receipt_sha256: sha("d"),
    }).success).toBe(false);
  });

  it("rejects unbound payload fields", () => {
    expect(factoryLaunchApprovalPayloadSchema.safeParse({
      ...validShadowApproval(),
      launch_execution_approval_id: "legacy-generic-approval",
    }).success).toBe(false);
  });
});
