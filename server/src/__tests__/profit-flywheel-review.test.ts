import { describe, expect, it } from "vitest";
import { validateIndependentReviewResult } from "../services/profit-flywheel.js";

const expected = {
  qaStageRunId: "11111111-1111-4111-8111-111111111111",
  implementationStageRunId: "22222222-2222-4222-8222-222222222222",
  implementationGitObject: "a".repeat(40),
  implementationArtifactHash: "b".repeat(64),
  builderProviderFamily: "openai",
  reviewerProviderFamily: "anthropic",
  reviewerModel: "claude-review",
  reviewerVersion: "2026-07-11",
  providerPolicySha256: "c".repeat(64),
  providerPolicySchemaSha256: "d".repeat(64),
};

function validReview() {
  return {
    schema_version: "paperclip.independent_review_result.v1",
    state: "succeeded",
    final_disposition: "passed",
    qa_stage_run_id: expected.qaStageRunId,
    implementation_stage_run_id: expected.implementationStageRunId,
    implementation_git_object: expected.implementationGitObject,
    implementation_artifact_hash: expected.implementationArtifactHash,
    reviewer_provider_family: expected.reviewerProviderFamily,
    reviewer_model: expected.reviewerModel,
    reviewer_version: expected.reviewerVersion,
    provider_policy_sha256: expected.providerPolicySha256,
    provider_policy_schema_sha256: expected.providerPolicySchemaSha256,
    summary: "Independent review passed with no release blocker.",
    findings: [],
  };
}

describe("strict independent review result", () => {
  it("accepts only an exact cross-family passed result", () => {
    expect(validateIndependentReviewResult(validReview(), expected)).toMatchObject({
      state: "succeeded",
      finalDisposition: "passed",
    });
  });

  it("rejects a rehashed artifact whose explicit disposition failed", () => {
    expect(() => validateIndependentReviewResult({
      ...validReview(),
      state: "failed",
      final_disposition: "changes_required",
    }, expected)).toThrow("state=succeeded and final_disposition=passed");
  });

  it("rejects same-family review and arbitrary implementation lineage", () => {
    expect(() => validateIndependentReviewResult(validReview(), {
      ...expected,
      reviewerProviderFamily: expected.builderProviderFamily,
    })).toThrow("must differ from the exact implementation builder family");
    expect(() => validateIndependentReviewResult({
      ...validReview(),
      implementation_stage_run_id: "33333333-3333-4333-8333-333333333333",
    }, expected)).toThrow("does not bind the exact QA route and implementation artifact");
  });

  it("rejects a passed wrapper containing an unresolved high or release-blocking finding", () => {
    expect(() => validateIndependentReviewResult({
      ...validReview(),
      findings: [{ id: "F-1", severity: "critical", status: "open", summary: "Remote release is unverified", release_blocking: true }],
    }, expected)).toThrow("cannot pass with unresolved critical or release-blocking finding F-1");
  });

  it.each([
    "secretValue", "tokenValue", "authToken", "sessionCookie", "clientSecret",
    "privateKey", "apiKey", "recoveryCode", "verificationToken", "phoneNumber",
    "secretMaterial", "authCredential", "apiKeyValue", "refreshTokenValue",
    "webhookSecret", "passwordHash", "privateKeyPem",
  ])("rejects nested receipt secret key %s", (secretKey) => {
    expect(() => validateIndependentReviewResult({
      ...validReview(),
      findings: [{ [secretKey]: "OPAQUE_MATERIAL_Z9X8Y7" }],
    }, expected)).toThrow(`Receipt key ${secretKey} is forbidden`);
  });
});
