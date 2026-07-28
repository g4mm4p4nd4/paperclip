import { describe, expect, it } from "vitest";
import {
  buildFleetRepairAudit,
  extractProviderPolicyBinding,
  parseFactoryFleetRepairAuditArgs,
  type FleetRepairAuditRows,
} from "../ops/factory-fleet-repair-audit.js";

const POLICY = {
  revision: 44,
  path: "/runtime/package/config/provider-policy.v2.json",
  sha256: "a".repeat(64),
  schemaPath: "/runtime/package/config/provider-policy.v2.schema.json",
  schemaSha256: "b".repeat(64),
};

function emptyRows(): FleetRepairAuditRows {
  return {
    companies: [],
    agents: [],
    secrets: [],
    issues: [],
    routines: [],
    routineRuns: [],
    heartbeats: [],
    wakeups: [],
    workflows: [],
    stageRuns: [],
    leases: [],
  };
}

function boundAgent(overrides: Partial<FleetRepairAuditRows["agents"][number]> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Researcher",
    role: "researcher",
    status: "idle",
    adapterType: "hermes_local",
    adapterConfig: {
      providerPolicy: {
        revision: POLICY.revision,
        path: POLICY.path,
        sha256: POLICY.sha256,
        schemaPath: POLICY.schemaPath,
        schemaSha256: POLICY.schemaSha256,
        capabilityAlias: "research_deep",
        commandRealpath: "/runtime/hermes",
        commandSha256: "c".repeat(64),
        hiddenFallbackDisabled: true,
        runtimeAuthority: { authoritySha256: "d".repeat(64) },
      },
      env: {
        PROVIDER_TOKEN: { type: "secret_ref", secretId: "opaque-id", version: "latest" },
      },
    },
    runtimeConfig: {},
    pauseReason: null,
    lastHeartbeatAt: null,
    ...overrides,
  };
}

describe("factory fleet repair audit", () => {
  it("extracts the exact immutable policy/runtime binding without environment values", () => {
    expect(extractProviderPolicyBinding(boundAgent())).toEqual({
      revision: 44,
      path: POLICY.path,
      sha256: POLICY.sha256,
      schema_path: POLICY.schemaPath,
      schema_sha256: POLICY.schemaSha256,
      capability_alias: "research_deep",
      command_realpath: "/runtime/hermes",
      command_sha256: "c".repeat(64),
      runtime_authority_sha256: "d".repeat(64),
      hidden_fallback_disabled: true,
    });
  });

  it("audits stale bindings, secret-reference metadata, exclusions, duplicates, and orphans", () => {
    const rows = emptyRows();
    rows.companies.push(
      { id: "company-1", name: "Portfolio Venture Factory", status: "active" },
      {
        id: "company-leadforge",
        name: "Portfolio Venture Factory :: Glitch-Cipher-Syndicate/LeadForge",
        status: "active",
      },
    );
    rows.agents.push(
      boundAgent({
        status: "error",
        pauseReason: "provider-policy runtime hash mismatch token=must-not-survive",
      }),
      boundAgent({
        id: "agent-stale",
        adapterConfig: {
          providerPolicy: {
            revision: 43,
            path: "/stale/policy.json",
            sha256: "e".repeat(64),
            schemaPath: POLICY.schemaPath,
            schemaSha256: POLICY.schemaSha256,
            hiddenFallbackDisabled: true,
          },
        },
      }),
    );
    rows.secrets.push({
      id: "secret-1",
      companyId: "company-1",
      name: "PROVIDER_TOKEN",
      provider: "local_encrypted",
      latestVersion: 2,
      latestVersionId: "version-2",
      latestVersionRevokedAt: null,
    });
    rows.issues.push(
      {
        id: "issue-1",
        companyId: "company-1",
        identifier: "POR-1",
        title: "[provider-policy.v2] credential blocker token=must-not-survive",
        status: "blocked",
        originKind: "routine_execution",
        originId: "routine:tick",
        executionRunId: "run-1",
        updatedAt: "2026-07-28T08:00:00.000Z",
      },
      {
        id: "issue-2",
        companyId: "company-1",
        identifier: "POR-2",
        title: "Duplicate routine work",
        status: "todo",
        originKind: "routine_execution",
        originId: "routine:tick",
        executionRunId: "run-2",
        updatedAt: "2026-07-28T08:00:01.000Z",
      },
    );
    rows.routines.push({
      id: "leadforge-routine",
      companyId: "company-leadforge",
      title: "LeadForge recurring work",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      assigneeAgentId: null,
      triggerId: "leadforge-trigger",
      triggerKind: "schedule",
      triggerEnabled: true,
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: "2026-07-28T09:00:00.000Z",
      lastResult: null,
    });
    rows.routines.push({
      id: "leadforge-disabled-routine",
      companyId: "company-leadforge",
      title: "Disabled historical trigger",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      assigneeAgentId: null,
      triggerId: "leadforge-disabled-trigger",
      triggerKind: "schedule",
      triggerEnabled: false,
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: null,
      lastResult: "disabled",
    });
    rows.heartbeats.push({
      id: "heartbeat-orphan",
      companyId: "company-1",
      agentId: "agent-1",
      status: "running",
      wakeupRequestId: null,
      processPid: 999_999_999,
      startedAt: "2026-07-28T07:00:00.000Z",
      updatedAt: "2026-07-28T07:00:00.000Z",
    });
    rows.wakeups.push({
      id: "wakeup-orphan",
      companyId: "company-1",
      agentId: "agent-1",
      status: "claimed",
      runId: null,
      idempotencyKey: "fixture",
      requestedAt: "2026-07-28T07:00:00.000Z",
      updatedAt: "2026-07-28T07:00:00.000Z",
    });
    rows.stageRuns.push({
      id: "stage-exhausted",
      companyId: "company-1",
      workflowId: "workflow-1",
      stage: "research_intake",
      state: "blocked",
      attemptCount: 3,
      maxAttempts: 3,
      providerFamily: "opencode",
      providerPolicySha256: "e".repeat(64),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: "2026-07-28T07:00:00.000Z",
    });
    rows.leases.push({
      id: "lease-expired",
      companyId: "company-1",
      stageRunId: "stage-exhausted",
      scopeType: "provider",
      scopeKey: "opencode",
      slot: 0,
      leaseOwner: "worker",
      expiresAt: "2026-07-28T07:00:00.000Z",
    });

    const audit = buildFleetRepairAudit(rows, {
      observedAt: new Date("2026-07-28T08:30:00.000Z"),
      expectedPolicy: POLICY,
    });

    expect(audit.fleet.stale_policy_binding_count).toBe(1);
    expect(audit.fleet.policy_caused_error_agent_count).toBe(1);
    expect(audit.credentials.value_material_included).toBe(false);
    expect(audit.credentials.active_non_excluded_companies).toHaveLength(1);
    expect(audit.credentials.active_non_excluded_companies[0]!.referenced_environment_names)
      .toEqual(["PROVIDER_TOKEN"]);
    expect(JSON.stringify(audit)).not.toContain("opaque-id");
    expect(JSON.stringify(audit)).not.toContain("must-not-survive");
    expect(audit.exact_exclusions.recurring_new_work_triggers_requiring_quarantine)
      .toHaveLength(1);
    expect(audit.schedules.exact_duplicate_open_routine_issues).toHaveLength(1);
    expect(audit.execution.orphan_heartbeat_count).toBe(1);
    expect(audit.execution.orphan_wakeup_count).toBe(1);
    expect(audit.execution.expired_lease_count).toBe(1);
    expect(audit.execution.retry_exhausted_stage_runs).toHaveLength(1);
    expect(audit.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires an absolute receipt directory and forbids connection strings on argv", () => {
    expect(parseFactoryFleetRepairAuditArgs([
      "--receipt-dir",
      "/tmp/fleet-repair",
      "--home",
      "/tmp/paperclip",
      "--instance-id",
      "default",
    ])).toEqual({
      help: false,
      receiptDir: "/tmp/fleet-repair",
      homeDir: "/tmp/paperclip",
      instanceId: "default",
    });
    expect(() => parseFactoryFleetRepairAuditArgs(["--receipt-dir", "relative"]))
      .toThrow("--receipt-dir must be an absolute");
    expect(() => parseFactoryFleetRepairAuditArgs(["--connection-string", "postgres://secret"]))
      .toThrow("database_url_argv_forbidden");
  });
});
