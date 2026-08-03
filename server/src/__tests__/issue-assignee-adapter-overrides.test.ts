import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIssueSchema } from "@paperclipai/shared";
import {
  applyIssueAssigneeAdapterOverridesToAgent,
  parseIssueAssigneeAdapterOverrides,
  providerPolicyExcludedRouteIds,
  verifyScheduledProviderPolicyFamilyExclusionLineage,
} from "../services/heartbeat.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";

describe("issue assignee adapter overrides", () => {
  it("accepts adapter type overrides in the shared issue contract", () => {
    const parsed = createIssueSchema.parse({
      title: "Run deterministic reconciler",
      assigneeAdapterOverrides: {
        adapterType: "process",
        adapterConfig: {
          command: "/bin/zsh",
          args: ["-lc", "echo done"],
        },
        useProjectWorkspace: true,
      },
    });

    expect(parsed.assigneeAdapterOverrides).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
      },
      useProjectWorkspace: true,
    });
  });

  it("applies issue-owned adapter type and config before provider routing", () => {
    const agent = {
      id: "agent_test",
      companyId: "company_test",
      name: "Builder",
      role: "engineering",
      adapterType: "hermes_local",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
        cwd: "/tmp/hermes",
      },
    };

    const resolved = applyIssueAssigneeAdapterOverridesToAgent(agent, {
      adapterType: "process",
      adapterConfig: {
        command: "/bin/zsh",
        args: ["-lc", "pnpm test"],
        cwd: "/tmp/process",
      },
      useProjectWorkspace: null,
      providerPolicyExcludedFamilies: [],
    });

    expect(resolved).toMatchObject({
      adapterType: "process",
      adapterConfig: {
        provider: "minimax",
        model: "MiniMax-M3",
        command: "/bin/zsh",
        args: ["-lc", "pnpm test"],
        cwd: "/tmp/process",
      },
    });
    expect(agent.adapterType).toBe("hermes_local");
  });

  it("accepts canonical provider-family exclusions without creating an adapter override", () => {
    const parsedIssue = createIssueSchema.parse({
      title: "Run different-family review",
      assigneeAdapterOverrides: {
        providerPolicyExcludedFamilies: ["opencode", "minimax"],
      },
    });
    const parsed = parseIssueAssigneeAdapterOverrides(
      parsedIssue.assigneeAdapterOverrides,
    );

    expect(parsed).toEqual({
      adapterType: null,
      adapterConfig: null,
      useProjectWorkspace: null,
      providerPolicyExcludedFamilies: ["opencode", "minimax"],
    });
  });

  it("rejects family exclusions combined with an execution override", () => {
    expect(() => createIssueSchema.parse({
      title: "Invalid mixed authority",
      assigneeAdapterOverrides: {
        adapterType: "process",
        providerPolicyExcludedFamilies: ["opencode"],
      },
    })).toThrow(/cannot be combined/i);
    expect(() => parseIssueAssigneeAdapterOverrides({
      adapterConfig: { model: "unowned-model" },
      providerPolicyExcludedFamilies: ["opencode"],
    })).toThrow(/cannot be combined/i);
  });

  it("derives every excluded route from the pinned provider-family catalog", async () => {
    const loaded = await loadProviderPolicyV2();
    const routeIds = providerPolicyExcludedRouteIds(
      loaded.policy,
      ["opencode", "minimax"],
    );

    expect(routeIds.length).toBeGreaterThan(0);
    expect(routeIds).toEqual([...routeIds].sort());
    expect(routeIds.every((routeId) =>
      ["opencode", "minimax"].includes(loaded.policy.routes[routeId]!.providerFamily),
    )).toBe(true);
    expect(() => providerPolicyExcludedRouteIds(loaded.policy, ["invented-family"]))
      .toThrow(/absent from the pinned policy/i);
  });

  it("binds family exclusions to the exact scheduled routine-run lineage", () => {
    const companyId = "company-test";
    const issueId = "issue-test";
    const routineId = "routine-test";
    const routineRunId = "routine-run-test";
    const logicalKey = {
      company_id: companyId,
      portfolio_run_id: "portfolio-wave-test",
      stage: "cross-review",
      input_hash: "a".repeat(64),
    };
    const idempotencyKey = `schedule.v1.${createHash("sha256")
      .update(JSON.stringify(logicalKey))
      .digest("hex")}`;
    const issue = {
      id: issueId,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
    };
    const routineRun = {
      id: routineRunId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      linkedIssueId: issueId,
      triggerPayload: {
        schedule_identity: {
          schema_version: "paperclip.routine_schedule_identity.v1",
          ...logicalKey,
          idempotency_key: idempotencyKey,
        },
        paperclipActionabilityPreflight: {
          status: "passed",
          reason: "agent_actionable",
          providerPolicyExcludedFamilies: ["opencode", "minimax"],
        },
      },
    };

    expect(verifyScheduledProviderPolicyFamilyExclusionLineage({
      companyId,
      families: ["opencode", "minimax"],
      issue,
      routineRun,
    })).toEqual({
      routineRunId,
      routineId,
      issueId,
      scheduleIdempotencyKey: idempotencyKey,
      excludedFamilies: ["opencode", "minimax"],
    });

    for (const invalid of [
      { ...routineRun, source: "api" },
      { ...routineRun, linkedIssueId: "other-issue" },
      {
        ...routineRun,
        triggerPayload: {
          ...routineRun.triggerPayload,
          schedule_identity: {
            ...routineRun.triggerPayload.schedule_identity,
            idempotency_key: `schedule.v1.${"0".repeat(64)}`,
          },
        },
      },
      {
        ...routineRun,
        triggerPayload: {
          ...routineRun.triggerPayload,
          paperclipActionabilityPreflight: {
            ...routineRun.triggerPayload.paperclipActionabilityPreflight,
            providerPolicyExcludedFamilies: ["opencode"],
          },
        },
      },
    ]) {
      expect(() => verifyScheduledProviderPolicyFamilyExclusionLineage({
        companyId,
        families: ["opencode", "minimax"],
        issue,
        routineRun: invalid,
      })).toThrow(/scheduled routine-run authority/i);
    }
  });
});
