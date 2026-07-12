import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES,
  validateIndependentReviewResult,
  validateProfitFlywheelStageExecutionEnvelope,
  validateProfitFlywheelStageWorkResult,
  validateProfitFlywheelTestExecutionResult,
} from "../services/profit-flywheel.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";

const vectorsPath = fileURLToPath(new URL("../../../contracts/profit-flywheel/execution-golden-vectors.v1.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  valid: {
    independent_review_result: Record<string, unknown>;
    test_execution_result: Record<string, unknown>;
    stage_work_results: Array<Record<string, unknown>>;
    stage_execution_envelope: Record<string, unknown>;
  };
  invalid: {
    agent_work_result_with_fabricated_provider_result: Record<string, unknown>;
    test_execution_false_success: Record<string, unknown>;
  };
};

describe("pinned Profit Flywheel execution contracts", () => {
  it("pins every schema authority to exact bytes", () => {
    for (const authority of Object.values(PROFIT_FLYWHEEL_EXECUTION_SCHEMA_AUTHORITIES)) {
      expect(createHash("sha256").update(readFileSync(authority.path)).digest("hex")).toBe(authority.sha256);
    }
  });

  it("mirrors the exact canonical POS execution-vector bytes bound by the frozen contract", async () => {
    const contract = await loadProfitFlywheelContract();
    const binding = contract.contract.artifact_vectors.execution;
    const localBytes = readFileSync(vectorsPath);
    const canonicalPath = path.resolve(path.dirname(contract.path), "..", binding.path);
    expect(createHash("sha256").update(localBytes).digest("hex")).toBe(binding.sha256);
    expect(localBytes.equals(readFileSync(canonicalPath))).toBe(true);
  });

  it("accepts the cross-language golden work-result and server-envelope vectors", () => {
    for (const workResult of vectors.valid.stage_work_results) {
      expect(validateProfitFlywheelStageWorkResult(workResult)).toBe(workResult);
    }
    expect(validateProfitFlywheelStageExecutionEnvelope(vectors.valid.stage_execution_envelope))
      .toBe(vectors.valid.stage_execution_envelope);
    expect(validateProfitFlywheelTestExecutionResult(vectors.valid.test_execution_result))
      .toBe(vectors.valid.test_execution_result);
  });

  it("rejects a false-success server-test result whose exit code is nonzero", () => {
    expect(() => validateProfitFlywheelTestExecutionResult(vectors.invalid.test_execution_false_success))
      .toThrow("does not satisfy its pinned JSON Schema");
  });

  it("rejects agent-authored provider/final/usage evidence", () => {
    expect(() => validateProfitFlywheelStageWorkResult(
      vectors.invalid.agent_work_result_with_fabricated_provider_result,
    )).toThrow("does not satisfy its pinned JSON Schema");
  });

  it("validates the independent-review golden through schema and semantic lineage", () => {
    const review = vectors.valid.independent_review_result;
    expect(validateIndependentReviewResult(review, {
      qaStageRunId: String(review.qa_stage_run_id),
      implementationStageRunId: String(review.implementation_stage_run_id),
      implementationGitObject: String(review.implementation_git_object),
      implementationArtifactHash: String(review.implementation_artifact_hash),
      builderProviderFamily: "openai",
      reviewerProviderFamily: String(review.reviewer_provider_family),
      reviewerModel: String(review.reviewer_model),
      reviewerVersion: String(review.reviewer_version),
      providerPolicySha256: String(review.provider_policy_sha256),
      providerPolicySchemaSha256: String(review.provider_policy_schema_sha256),
    })).toMatchObject({ state: "succeeded", finalDisposition: "passed" });
  });
});
