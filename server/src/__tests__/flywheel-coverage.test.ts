import { describe, expect, it } from "vitest";
import {
  assertFlywheelCoverageAuthority,
  assertRoutineCoverage,
  loadFlywheelCoverageManifest,
  parseFlywheelCoverageManifest,
} from "../services/flywheel-coverage.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";

const seededRoutineKeys = [
  "dispatch-poller",
  "run-qa-sweep",
  "evidence-backfill-reconciler",
  "release-gate-reconciler",
];

describe("flywheel coverage manifest", () => {
  it("is an exact behavior bridge over canonical stages, owners, receipts, aliases, and budgets", async () => {
    const manifest = loadFlywheelCoverageManifest();
    const contract = await loadProfitFlywheelContract();
    const policy = await loadProviderPolicyV2();

    expect(assertFlywheelCoverageAuthority({
      manifest,
      contract: contract.contract,
      contractSha256: contract.sha256,
      providerPolicy: policy.policy,
      providerPolicySha256: policy.sha256,
    })).toBe(manifest);
    expect(manifest.schema_version).toBe("paperclip.flywheel_coverage.v2");
    expect(manifest.stages.map((entry) => entry.stage).sort())
      .toEqual(Object.keys(contract.contract.stages).sort());
    expect(manifest.stages.find((entry) => entry.stage === "implementation")).toMatchObject({
      owner_plane: "paperclip",
      provider_capability_alias: "code_deep",
      budget_class: "implementation",
      expected_max_provider_tokens: 160000,
    });
    expect(manifest.stages.find((entry) => entry.stage === "commercial_validation")).toMatchObject({
      owner_plane: "portfolio_os",
      provider_capability_alias: "deterministic",
      budget_class: null,
      expected_max_provider_tokens: 0,
    });
  });

  it("preserves seeded routine consumers only as explicit zero-provider legacy bridges", () => {
    const coverage = assertRoutineCoverage(seededRoutineKeys, loadFlywheelCoverageManifest());
    expect(coverage.map((entry) => entry.routine_key)).toEqual(seededRoutineKeys);
    expect(coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routine_key: "run-qa-sweep",
        stage: "qa",
        owner_plane: "paperclip",
        execution_mode: "legacy_deterministic_runbook",
        provider_policy: "deterministic",
        budget_class: null,
        expected_max_provider_tokens: 0,
      }),
      expect.objectContaining({
        routine_key: "evidence-backfill-reconciler",
        stage: "evidence_normalization",
        owner_plane: "portfolio_os",
      }),
    ]));
  });

  it("fails closed on stage owner, capability, receipt, or provider-budget drift", async () => {
    const manifest = loadFlywheelCoverageManifest();
    const contract = await loadProfitFlywheelContract();
    const policy = await loadProviderPolicyV2();
    const assertMutationRejected = (mutate: (copy: typeof manifest) => void, message: string) => {
      const copy = structuredClone(manifest);
      mutate(copy);
      expect(() => assertFlywheelCoverageAuthority({
        manifest: copy,
        contract: contract.contract,
        contractSha256: contract.sha256,
        providerPolicy: policy.policy,
        providerPolicySha256: policy.sha256,
      })).toThrow(message);
    };
    assertMutationRejected((copy) => { copy.stages[0]!.owner_plane = "paperclip"; }, "owner or provider capability differs");
    assertMutationRejected((copy) => { copy.stages[0]!.provider_capability_alias = "code_deep"; }, "owner or provider capability differs");
    assertMutationRejected((copy) => { copy.stages[0]!.receipt_paths = ["invented_receipt"]; }, "receipts differ");
    assertMutationRejected((copy) => { copy.stages[0]!.expected_max_provider_tokens = 1; }, "budget differs");
    const deterministicIndex = manifest.stages.findIndex((entry) => entry.provider_capability_alias === "deterministic");
    assertMutationRejected((copy) => { copy.stages[deterministicIndex]!.expected_max_provider_tokens = 1; }, "zero provider budget");
  });

  it("fails closed when a seeded routine is absent or escapes the deterministic bridge", () => {
    const manifest = loadFlywheelCoverageManifest();
    expect(() => assertRoutineCoverage([...seededRoutineKeys, "missing-routine"], manifest))
      .toThrow("flywheel coverage manifest missing routine coverage for: missing-routine");
    const mutated = structuredClone(manifest);
    mutated.routine_coverage[0]!.provider_policy = "code_deep";
    expect(() => assertRoutineCoverage(seededRoutineKeys, mutated))
      .toThrow("must remain an explicit zero-provider legacy bridge");
  });

  it("rejects v1 and unpinned v2 manifests", () => {
    expect(() => parseFlywheelCoverageManifest({
      schema_version: "paperclip.flywheel_coverage.v1",
      stages: [{}],
      routine_coverage: [{}],
    })).toThrow("schema_version must be paperclip.flywheel_coverage.v2");
    expect(() => parseFlywheelCoverageManifest({
      schema_version: "paperclip.flywheel_coverage.v2",
      authority: {},
      stages: [{}],
      routine_coverage: [{}],
    })).toThrow("must pin profit-flywheel.v2 and provider-policy.v2 authority");
  });
});
