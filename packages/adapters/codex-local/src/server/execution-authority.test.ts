import { describe, expect, it } from "vitest";
import { resolveCodexApprovalBypass } from "./execute.js";

const policyConfig = {
  providerPolicyBinding: { routeId: "codex_deep", policySha256: "a".repeat(64) },
};

describe("Codex provider-policy execution authority", () => {
  it("enables unattended workspace writes only for an exactly bound implementation stage", () => {
    const binding = {
      schemaVersion: "paperclip.provider_policy_execution_authority.v1",
      workflowId: "workflow-1",
      stageRunId: "stage-1",
      stage: "implementation",
      workspaceWriteAllowed: true,
    };
    expect(resolveCodexApprovalBypass(
      { ...policyConfig, paperclipExecutionAuthority: binding },
      { paperclipProfitFlywheel: { workflowId: "workflow-1", stageRunId: "stage-1", stage: "implementation" } },
    )).toBe(true);
    expect(resolveCodexApprovalBypass(
      { ...policyConfig, paperclipExecutionAuthority: binding },
      { paperclipProfitFlywheel: { workflowId: "workflow-1", stageRunId: "different", stage: "implementation" } },
    )).toBe(false);
  });

  it("keeps review stages read-only and ignores agent-authored bypass flags under policy control", () => {
    expect(resolveCodexApprovalBypass(
      {
        ...policyConfig,
        dangerouslyBypassApprovalsAndSandbox: true,
        paperclipExecutionAuthority: {
          schemaVersion: "paperclip.provider_policy_execution_authority.v1",
          workflowId: "workflow-1",
          stageRunId: "stage-1",
          stage: "qa",
          workspaceWriteAllowed: false,
        },
      },
      { paperclipProfitFlywheel: { workflowId: "workflow-1", stageRunId: "stage-1", stage: "qa" } },
    )).toBe(false);
  });

  it("preserves explicit bypass behavior outside provider-policy runs", () => {
    expect(resolveCodexApprovalBypass({ dangerouslyBypassApprovalsAndSandbox: true }, {})).toBe(true);
    expect(resolveCodexApprovalBypass({}, {})).toBe(false);
  });
});
