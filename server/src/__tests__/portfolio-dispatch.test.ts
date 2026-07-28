import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  ensureTargetRepoCloneAndRunBranch,
  ingestExistingVentureGateFile,
  ingestPortfolioDispatchFile,
  readDispatchLedgerFromFs,
  writeDispatchLedgerToFs,
} from "../services/portfolio-dispatch.js";
import {
  loadPortfolioOsResearchRegistryAuthority,
} from "../services/profit-flywheel.js";
import { loadProfitFlywheelContract } from "../services/profit-flywheel-contract.js";
import { loadProviderPolicyV2 } from "../services/provider-policy.js";

const execFile = promisify(execFileCallback);

const DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV = "PAPERCLIP_POS_DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION";
const BOUND_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const BOUND_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function dispatchHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function selectionSnapshotHash(value: unknown) {
  return dispatchHash(stableJson(value));
}

async function withDispatchPollerIsolationFlag(
  value: string | undefined,
  fn: () => Promise<void>,
) {
  const previous = process.env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV];
  if (value === undefined) {
    delete process.env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV];
  } else {
    process.env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV] = value;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV];
    } else {
      process.env[DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV] = previous;
    }
  }
}

function sampleDossier(gateStatus = "APPROVED_NO_CONFLICT", freshnessStatus = "fresh") {
  return {
    identity: { full_name: "g4mm4p4nd4/idea-spark" },
    stage_0_gate_receipt: { gate_status: gateStatus },
    inventory_summary: { freshness_status: freshnessStatus },
  };
}

function sampleDispatch() {
  const paperclipDispatchGate = {
    schema_version: "pos.paperclip_dispatch_gate.v1",
    status: "APPROVED_DISTINCT_RESKIN",
    internet_pipes_score: 86.5,
    internet_pipes_readiness: "alpha_ready",
    internet_pipes_missing_stations: [],
    internet_pipes_recommendations: ["Preserve visual proof and recommendation citations through QA."],
  };
  const selectionSnapshot = {
    launch_target: {
      repo: "g4mm4p4nd4/idea-spark",
      repo_url: "https://github.com/g4mm4p4nd4/idea-spark",
      robust_branch: "main",
      strongest_wedge: "AI idea generation with proof-first landing loops",
      recommended_offer_angle: "Ship an idea validation assistant for creators.",
    },
    paperclip: {
      company_id: BOUND_COMPANY_ID,
      project_id: BOUND_PROJECT_ID,
      issue_ids: [],
      approval_ids: [],
      dispatch_gate: paperclipDispatchGate,
    },
    artifacts: {
      scaffold_dir: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-05/idea-spark-main",
      launch_packet_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_packets/2026-04-05/idea-spark-main.md",
    },
  };
  return {
    schema_version: "pos.dispatch.v2",
    run_id: "20260405T123000Z",
    correlation_id: "profit-flywheel:20260405T123000Z:idea-spark",
    selection_snapshot_hash: selectionSnapshotHash(selectionSnapshot),
    selection_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-05/idea/selection_snapshot.json",
    packet_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_packets/2026-04-05/idea.selection_snapshot.json",
    selected_repo_dossier_path: "/Users/mnm/Documents/Github/portfolio-os/data/repo_inventory_detail/g4mm4p4nd4__idea-spark.json",
    selected_repo_dossier_hash: "dossier-hash-1",
    target_repo_full_name: "g4mm4p4nd4/idea-spark",
    target_repo_branch: "main",
    target_repo_clone_path_hint: "/Users/mnm/Documents/Github/idea-spark",
    target: {
      repo: "g4mm4p4nd4/idea-spark",
      branch: "run/20260405T123000Z/bootstrap",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      workspace_fingerprint: "fixture-workspace-fingerprint",
      dirty_work_policy: "preserve_existing_intent",
    },
    dossier_contract: {
      selected_repo_dossier: {
        repo: "g4mm4p4nd4/idea-spark",
        dossier_path: "/Users/mnm/Documents/Github/portfolio-os/data/repo_inventory_detail/g4mm4p4nd4__idea-spark.json",
        dossier_hash: "dossier-hash-1",
      },
      pending_semantic_review: false,
      gate_statuses: { "g4mm4p4nd4/idea-spark": "APPROVED_NO_CONFLICT" },
      freshness_statuses: { "g4mm4p4nd4/idea-spark": "fresh" },
    },
    cockpit: {
      portfolio_os_dir: "/Users/mnm/Documents/Github/portfolio-os",
      paperclip_dir: "/Users/mnm/Documents/Github/paperclip",
      gstack_dir: "/Users/mnm/Documents/Github/gstack",
    },
    selection_snapshot: selectionSnapshot,
    paperclip: {
      company_id: BOUND_COMPANY_ID,
      project_id: BOUND_PROJECT_ID,
      binding_manifest_path: "/tmp/profit-flywheel-binding.json",
      binding_manifest_sha256: "a".repeat(64),
      dispatch_gate: paperclipDispatchGate,
    },
    execution_manifest: {
      repo_target: {
        target_repo_full_name: "g4mm4p4nd4/idea-spark",
        target_repo_branch: "main",
        target_repo_clone_path_hint: "/Users/mnm/Documents/Github/idea-spark",
        suggested_branch_name: "run/20260405T123000Z/bootstrap",
        repo_url: "https://github.com/g4mm4p4nd4/idea-spark",
      },
      task_groups: {
        CEO: [
          {
            function: "CEO",
            ticket_title: "[run_id:20260405T123000Z] CEO accept wedge",
            summary: "Approve the wedge and success criteria.",
            acceptance_criteria: ["Wedge accepted", "Milestone accepted"],
            requires_approval_before_merge: false,
            requires_approval_before_deploy: true,
          },
        ],
        Engineer: [
          {
            function: "Engineer",
            ticket_title: "[run_id:20260405T123000Z] Engineer ship first milestone",
            summary: "Implement the first proof-first milestone.",
            acceptance_criteria: ["Code changed", "Tests green"],
            requires_approval_before_merge: false,
            requires_approval_before_deploy: true,
          },
        ],
        Release: [
          {
            function: "Release",
            ticket_title: "[run_id:20260405T123000Z] Release land run branch",
            summary: "Merge on green with approval.",
            acceptance_criteria: ["Checks pass", "Approval linked"],
            requires_approval_before_merge: true,
            requires_approval_before_deploy: true,
          },
        ],
      },
    },
  };
}

function sampleExistingVentureGate() {
  return {
    schema_version: "pos.paperclip_dispatch_gate.v1",
    status: "ROUTE_TO_EXISTING_VENTURE",
    route_type: "existing_venture",
    repo: "g4mm4p4nd4/agency-swarm",
    assessment: "existing venture owns the frozen targets",
    reason: "The frozen bundle maps to an existing Venture Factory company.",
    required_next_step: "Route frozen bundle work to existing Venture Factory companies via Paperclip.",
    existing_venture_company: "agency-swarm ecosystem (company-venture)",
    existing_project_identity: "agency-swarm",
    existing_company_id: "company-venture",
    existing_project_id: "",
    existing_repo_project_identity: "g4mm4p4nd4/agency-swarm",
    recommended_owner: "Venture Factory Liaison",
    urgency: "medium",
    expected_impact: "Evidence gap closure continues without routing to a new-company dispatch path",
    internet_pipes_score: 36,
    internet_pipes_readiness: "insufficient",
    internet_pipes_missing_stations: ["evaluation", "differentiation", "visualization", "recommendation"],
    internet_pipes_recommendations: [
      "Add competitive and market mechanics evidence.",
      "Add explicit differentiation evidence.",
      "Add a visual proof packet.",
      "Add a recommendation artifact.",
    ],
  };
}

function sampleActionableExistingVentureGate(overrides: Record<string, unknown> = {}) {
  return {
    ...sampleExistingVentureGate(),
    route_type: "feature_delta",
    request_type: "feature_delta",
    route_backlog_only: false,
    approved_by: "board",
    source_request_path: "/Users/mnm/Documents/Github/portfolio-os/data/paperclip_requests/feature-delta.json",
    affected_workflow: "voice-of-customer validation and revenue proof",
    existing_venture_insufficient_reason: "Fresh VOC and market evidence identify a concrete feature delta for the existing company.",
    ...overrides,
  };
}

function makeDeps(raw: string, dossier = sampleDossier()) {
  const ledger = {
    ingested: {} as Record<string, any>,
    conflicts: {} as Record<string, any>,
  };
  const dispatchPayload = JSON.parse(raw);
  const dossierPath = String(dispatchPayload.selected_repo_dossier_path ?? "");
  const dossierRaw = JSON.stringify(dossier);
  const calls = {
    createCompany: [] as Array<Record<string, unknown>>,
    createProject: [] as Array<Record<string, unknown>>,
    createWorkspace: [] as Array<Record<string, unknown>>,
    createAgent: [] as Array<Record<string, unknown>>,
    createIssue: [] as Array<Record<string, unknown>>,
    createApproval: [] as Array<Record<string, unknown>>,
    createRoutine: [] as Array<Record<string, unknown>>,
    createRoutineTrigger: [] as Array<Record<string, unknown>>,
    wakeAgent: [] as Array<Record<string, unknown>>,
    linkApprovalToIssues: [] as Array<Record<string, unknown>>,
    ensureRepoClone: [] as Array<Record<string, unknown>>,
    startProfitFlywheel: [] as Array<Record<string, unknown>>,
    blockIssue: [] as Array<Record<string, unknown>>,
  };

  let issueCounter = 0;
  let routineCounter = 0;
  return {
    ledger,
    calls,
    deps: {
      readFile: async (pathValue: string) => {
        if (pathValue === dossierPath) return dossierRaw;
        if (pathValue === "/tmp/dispatch.json") return raw;
        return fs.readFile(pathValue, "utf8");
      },
      readDispatchLedger: async () => ledger,
      writeDispatchLedger: async (next: typeof ledger) => {
        ledger.ingested = { ...next.ingested };
        ledger.conflicts = { ...(next.conflicts ?? {}) };
      },
      ensureGstackSkillLink: vi.fn(async () => {}),
      ensureRepoClone: vi.fn(async (input: Record<string, unknown>) => {
        calls.ensureRepoClone.push(input);
        return {
          clonePath: "/Users/mnm/Documents/Github/idea-spark",
          runBranch: "run/20260405T123000Z/bootstrap",
        };
      }),
      listCompanies: async () => [{
        id: BOUND_COMPANY_ID,
        name: "Idea Spark",
        description: "Bound fixture company",
      }],
      createCompany: async (input: Record<string, unknown>) => {
        calls.createCompany.push(input);
        return {
          id: BOUND_COMPANY_ID,
          name: String(input.name),
          description: (input.description as string | undefined) ?? null,
        };
      },
      listProjects: async () => [{
        id: BOUND_PROJECT_ID,
        companyId: BOUND_COMPANY_ID,
        name: "Idea Spark Launch",
        description: "Bound fixture project",
        status: "planned",
        workspaces: [{
          id: "workspace-target",
          name: "Target Repo",
          cwd: "/Users/mnm/Documents/Github/idea-spark",
          repoUrl: "https://github.com/g4mm4p4nd4/idea-spark.git",
          repoRef: "run/20260405T123000Z/bootstrap",
          isPrimary: true,
        }],
      }],
      createProject: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createProject.push(input);
        return {
          id: BOUND_PROJECT_ID,
          companyId: BOUND_COMPANY_ID,
          name: String(input.name),
          description: (input.description as string | undefined) ?? null,
          workspaces: [],
        };
      },
      createWorkspace: async (_projectId: string, input: Record<string, unknown>) => {
        calls.createWorkspace.push(input);
      },
      listAgents: async () => [],
      createAgent: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createAgent.push(input);
        return {
          id: randomUUID(),
          companyId: BOUND_COMPANY_ID,
          name: String(input.name),
          role: String(input.role),
          reportsTo: (input.reportsTo as string | null | undefined) ?? null,
        };
      },
      listIssues: async () => [],
      createIssue: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createIssue.push(input);
        issueCounter += 1;
        return {
          id: `issue-${issueCounter}`,
          companyId: BOUND_COMPANY_ID,
          projectId: String(input.projectId),
          title: String(input.title),
          assigneeAgentId: (input.assigneeAgentId as string | null | undefined) ?? null,
        };
      },
      listApprovals: async () => [],
      createApproval: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createApproval.push(input);
        return {
          id: "approval-1",
          companyId: BOUND_COMPANY_ID,
          type: String(input.type),
          status: "pending",
          payload: (input.payload as Record<string, unknown>) ?? {},
        };
      },
      linkApprovalToIssues: async (approvalId: string, issueIds: string[]) => {
        calls.linkApprovalToIssues.push({ approvalId, issueIds });
      },
      listRoutines: async () => [],
      createRoutine: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createRoutine.push(input);
        routineCounter += 1;
        return {
          id: `routine-${routineCounter}`,
          companyId: BOUND_COMPANY_ID,
          projectId: String(input.projectId),
          title: String(input.title),
          triggers: [],
        };
      },
      createRoutineTrigger: async (routineId: string, input: Record<string, unknown>) => {
        calls.createRoutineTrigger.push({ routineId, ...input });
      },
      wakeAgent: async (agentId: string, issueId: string, projectId: string, runId: string) => {
        calls.wakeAgent.push({ agentId, issueId, projectId, runId });
      },
      startProfitFlywheel: async (input: Record<string, unknown>) => {
        calls.startProfitFlywheel.push(input);
        return { implementationStageRunId: "stage-run-implementation-1" };
      },
      blockIssue: async (issueId: string, blocker: Record<string, unknown>) => {
        calls.blockIssue.push({ issueId, ...blocker });
      },
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    },
  };
}

function makeExistingVentureGateDeps(raw: string) {
  const calls = {
    createIssue: [] as Array<Record<string, unknown>>,
    updateIssue: [] as Array<Record<string, unknown>>,
    wakeAgent: [] as Array<Record<string, unknown>>,
  };
  const issues: Array<{
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    title: string;
    description: string | null;
    status: string;
    assigneeAgentId: string | null;
    originKind: string;
    originId: string;
    executionState: Record<string, unknown> | null;
  }> = [];
  let issueCounter = 0;

  return {
    calls,
    deps: {
      readFile: async (pathValue: string) => {
        if (pathValue === "/tmp/paperclip_dispatch_gate.json") return raw;
        return fs.readFile(pathValue, "utf8");
      },
      listProjects: async () => [
        {
          id: "project-agency",
          companyId: "company-venture",
          name: "agency-swarm",
          description: "Existing agency-swarm venture lane",
          status: "in_progress",
          workspaces: [
            {
              id: "workspace-agency",
              name: "Target Repo",
              cwd: "/Users/mnm/Documents/Github/agency-swarm",
              repoUrl: "https://github.com/g4mm4p4nd4/agency-swarm.git",
              repoRef: "main",
              isPrimary: true,
            },
          ],
        },
      ],
      listAgents: async () => [
        {
          id: "agent-paused-growth",
          companyId: "company-venture",
          name: "Growth/Distribution",
          role: "general",
          reportsTo: null,
          status: "paused",
        },
        {
          id: "agent-liaison",
          companyId: "company-venture",
          name: "Venture Factory Liaison",
          role: "general",
          reportsTo: null,
          status: "idle",
        },
      ],
      listIssuesByOrigin: async (_companyId: string, originKind: string, originId: string) =>
        issues.filter((issue) => issue.originKind === originKind && issue.originId === originId),
      createIssue: async (companyId: string, input: Record<string, unknown>) => {
        calls.createIssue.push(input);
        issueCounter += 1;
        const issue = {
          id: `existing-gate-issue-${issueCounter}`,
          companyId,
          projectId: (input.projectId as string | null | undefined) ?? null,
          parentId: (input.parentId as string | null | undefined) ?? null,
          title: String(input.title),
          description: String(input.description),
          status: String(input.status),
          assigneeAgentId: (input.assigneeAgentId as string | null | undefined) ?? null,
          originKind: String(input.originKind),
          originId: String(input.originId),
          executionState: (input.executionState as Record<string, unknown> | null | undefined) ?? null,
        };
        issues.push(issue);
        return issue;
      },
      updateIssue: async (issueId: string, input: Record<string, unknown>) => {
        calls.updateIssue.push({ issueId, ...input });
        const issue = issues.find((entry) => entry.id === issueId) ?? null;
        if (!issue) return null;
        Object.assign(issue, {
          projectId: (input.projectId as string | null | undefined) ?? issue.projectId,
          parentId: (input.parentId as string | null | undefined) ?? issue.parentId,
          title: (input.title as string | undefined) ?? issue.title,
          description: (input.description as string | undefined) ?? issue.description,
          status: (input.status as string | undefined) ?? issue.status,
          assigneeAgentId: (input.assigneeAgentId as string | null | undefined) ?? issue.assigneeAgentId,
          executionState: (input.executionState as Record<string, unknown> | null | undefined) ?? issue.executionState,
        });
        return issue;
      },
      wakeAgent: async (agentId: string, issueId: string, projectId: string | null, runId: string) => {
        calls.wakeAgent.push({ agentId, issueId, projectId, runId });
      },
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    },
    issues,
  };
}

describe("portfolio dispatch ingest", () => {
  it("suppresses default existing-venture gates without creating issues or waking agents", async () => {
    const raw = JSON.stringify(sampleExistingVentureGate());
    const { deps, calls } = makeExistingVentureGateDeps(raw);

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);
    const second = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_suppressed",
      companyId: "company-venture",
      projectId: null,
      wakeQueued: false,
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(second).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_suppressed",
      companyId: "company-venture",
      projectId: null,
      wakeQueued: false,
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("does not update existing parent or child issues when a gate is suppressed", async () => {
    const raw = JSON.stringify(sampleExistingVentureGate());
    const { deps, calls, issues } = makeExistingVentureGateDeps(raw);
    issues.push({
      id: "open-gate",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: null,
      title: "Open existing gate",
      description: "Already open from a prior actionable request.",
      status: "blocked",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_gate",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm",
      executionState: {
        portfolioExistingVentureGate: {
          gateHash: "older-hash",
        },
      },
    });
    issues.push({
      id: "open-station",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: "open-gate",
      title: "Open station",
      description: "Prior child issue.",
      status: "todo",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_station",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:evaluation",
      executionState: {},
    });

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_suppressed",
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("suppresses explicit feature deltas that are missing operator provenance", async () => {
    const raw = JSON.stringify({
      ...sampleExistingVentureGate(),
      route_type: "feature_delta",
      request_type: "feature_delta",
      approved_by: "",
      source_request_path: "",
    });
    const { deps, calls } = makeExistingVentureGateDeps(raw);

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_missing_action_provenance",
      companyId: "company-venture",
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("suppresses backlog-only gates even when action fields are present", async () => {
    const raw = JSON.stringify(sampleActionableExistingVentureGate({ route_backlog_only: true }));
    const { deps, calls } = makeExistingVentureGateDeps(raw);

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_backlog_suppressed",
      companyId: "company-venture",
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("suppresses malformed default existing-venture gates before required routing fields throw", async () => {
    const raw = JSON.stringify({
      ...sampleExistingVentureGate(),
      repo: "",
      existing_company_id: "",
    });
    const { deps, calls } = makeExistingVentureGateDeps(raw);

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_owned_venture_suppressed",
      companyId: undefined,
      originId: undefined,
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("routes explicit existing-venture feature deltas into one owned validation issue", async () => {
    const raw = JSON.stringify(sampleActionableExistingVentureGate());
    const { deps, calls } = makeExistingVentureGateDeps(raw);

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);
    const second = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "created",
      companyId: "company-venture",
      projectId: "project-agency",
      issueId: "existing-gate-issue-1",
      assigneeAgentId: "agent-liaison",
      wakeQueued: true,
      childIssueCount: 4,
      childIssuesCreated: 4,
      childIssuesUpdated: 0,
      childWakeQueued: 4,
    });
    expect(second).toMatchObject({
      status: "skipped",
      reason: "existing_issue_up_to_date",
      issueId: "existing-gate-issue-1",
      childIssueCount: 4,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(calls.createIssue).toHaveLength(5);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: "agent-liaison",
        issueId: "existing-gate-issue-1",
        projectId: "project-agency",
      }),
    ]));
    expect(calls.wakeAgent).toHaveLength(5);
    const createdIssue = calls.createIssue.find(
      (entry) => entry.originKind === "portfolio_existing_venture_gate",
    );
    expect(createdIssue?.originKind).toBe("portfolio_existing_venture_gate");
    expect(createdIssue?.originId).toBe("existing_venture:company-venture:g4mm4p4nd4/agency-swarm");
    expect(createdIssue?.assigneeAgentId).toBe("agent-liaison");
    const description = String(createdIssue?.description ?? "");
    expect(description).toContain("## Cake Output Required");
    expect(description).toContain("## Internet Pipes Completeness");
    expect(description).toContain("- Missing stations: evaluation, differentiation, visualization, recommendation");
    expect(description).toContain("## Missing Evidence Stations");
    expect(description).toContain("## Source Contract");
    const stationIssues = calls.createIssue.filter(
      (entry) => entry.originKind === "portfolio_existing_venture_station",
    );
    expect(stationIssues).toHaveLength(4);
    expect(stationIssues.map((entry) => entry.parentId)).toEqual([
      "existing-gate-issue-1",
      "existing-gate-issue-1",
      "existing-gate-issue-1",
      "existing-gate-issue-1",
    ]);
    expect(stationIssues.map((entry) => entry.originId)).toEqual([
      "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:differentiation",
      "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:evaluation",
      "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:recommendation",
      "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:visualization",
    ]);
    expect(stationIssues.map((entry) => String(entry.title))).toEqual([
      "Close g4mm4p4nd4/agency-swarm Internet Pipes differentiation station",
      "Close g4mm4p4nd4/agency-swarm Internet Pipes evaluation station",
      "Close g4mm4p4nd4/agency-swarm Internet Pipes recommendation station",
      "Close g4mm4p4nd4/agency-swarm Internet Pipes visualization station",
    ]);
    for (const stationIssue of stationIssues) {
      const stationDescription = String(stationIssue.description ?? "");
      expect(stationIssue.assigneeAgentId).toBe("agent-liaison");
      expect(stationDescription).toContain("## Cake Output Required");
      expect(stationDescription).toContain("## Acceptance Criteria");
      expect(stationDescription).toContain("The output must be a durable artifact");
      expect(stationDescription).toContain("parent_issue_id");
      expect(stationDescription).toContain("station");
    }
  });

  it("does not reopen a completed existing-venture gate when the gate hash is unchanged", async () => {
    const raw = JSON.stringify(sampleActionableExistingVentureGate());
    const gateHash = dispatchHash(raw);
    const { deps, calls, issues } = makeExistingVentureGateDeps(raw);
    issues.push({
      id: "aaa-cancelled-duplicate-gate",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: null,
      title: "Cancelled duplicate replay",
      description: "Duplicate replay created after the completed gate.",
      status: "cancelled",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_gate",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm",
      executionState: {
        portfolioExistingVentureGate: {
          gateHash,
        },
      },
    });
    issues.push({
      id: "completed-gate",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: null,
      title: "Close existing-venture validation gaps for g4mm4p4nd4/agency-swarm",
      description: "Already completed with a no-go or next-action artifact.",
      status: "done",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_gate",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm",
      executionState: {
        portfolioExistingVentureGate: {
          gateHash,
        },
      },
    });

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "skipped",
      reason: "existing_terminal_issue_up_to_date",
      issueId: "completed-gate",
      wakeQueued: false,
      childIssueCount: 0,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue).toHaveLength(0);
    expect(calls.wakeAgent).toHaveLength(0);
  });

  it("does not reset or wake a completed existing-venture station when the station gate hash is unchanged", async () => {
    const payload = {
      ...sampleActionableExistingVentureGate(),
      internet_pipes_missing_stations: ["differentiation"],
      internet_pipes: {
        score: 71,
        readiness: "evidence_backfill",
        missing_stations: ["differentiation"],
        recommendations: ["Preserve completed differentiation artifact."],
      },
    };
    const raw = JSON.stringify(payload);
    const gateHash = dispatchHash(raw);
    const { deps, calls, issues } = makeExistingVentureGateDeps(raw);
    issues.push({
      id: "open-gate",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: null,
      title: "Close existing-venture validation gaps for g4mm4p4nd4/agency-swarm",
      description: "Open parent gate.",
      status: "todo",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_gate",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm",
      executionState: {
        portfolioExistingVentureGate: {
          gateHash,
        },
      },
    });
    issues.push({
      id: "completed-station",
      companyId: "company-venture",
      projectId: "project-agency",
      parentId: "open-gate",
      title: "Close g4mm4p4nd4/agency-swarm Internet Pipes differentiation station",
      description: "Completed differentiation artifact.",
      status: "done",
      assigneeAgentId: "agent-liaison",
      originKind: "portfolio_existing_venture_station",
      originId: "existing_venture:company-venture:g4mm4p4nd4/agency-swarm:station:differentiation",
      executionState: {
        portfolioExistingVentureStation: {
          gateHash,
        },
      },
    });

    const result = await ingestExistingVentureGateFile("/tmp/paperclip_dispatch_gate.json", deps as any);

    expect(result).toMatchObject({
      status: "updated",
      issueId: "open-gate",
      childIssueCount: 1,
      childIssuesCreated: 0,
      childIssuesUpdated: 0,
      childWakeQueued: 0,
    });
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.updateIssue.some((entry) => entry.issueId === "completed-station")).toBe(false);
    expect(calls.wakeAgent.some((entry) => entry.issueId === "completed-station")).toBe(false);
    expect(issues.find((issue) => issue.id === "completed-station")?.status).toBe("done");
  });

  it("ingests into the explicitly bound company/project and starts the event-only flywheel", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls, ledger } = makeDeps(raw);
    const managedAuthority = {
      contract: await loadProfitFlywheelContract(),
      policy: await loadProviderPolicyV2(),
      researchRegistryAuthority: await loadPortfolioOsResearchRegistryAuthority(),
      dispatchSchemaPath: path.resolve(
        "../portfolio-os/contracts/pos.dispatch.v2.schema.json",
      ),
    };
    const loadManagedRuntimeAuthority = vi.fn(async () => managedAuthority);
    (deps as typeof deps & {
      loadManagedRuntimeAuthority: typeof loadManagedRuntimeAuthority;
    }).loadManagedRuntimeAuthority = loadManagedRuntimeAuthority;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createWorkspace).toHaveLength(0);
    expect(calls.createAgent.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["CEO", "CTO", "CMO", "Engineer-1", "Engineer-2", "Designer/Copy", "QA", "Release Manager", "Growth/Distribution"]),
    );
    expect(calls.createIssue.map((entry) => entry.title)).toEqual(
      expect.arrayContaining([
        "[run_id:20260405T123000Z] CEO accept wedge",
        "[run_id:20260405T123000Z] Engineer ship first milestone",
        "[run_id:20260405T123000Z] Release land run branch",
      ]),
    );
    const engineerIssue = calls.createIssue.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Engineer ship first milestone",
    );
    expect(engineerIssue?.executionPolicy).toBeNull();
    const engineerDescription = String(engineerIssue?.description ?? "");
    expect(engineerDescription).toContain("## Internet Pipes Completeness");
    expect(engineerDescription).toContain("- Score: 86.50");
    expect(engineerDescription).toContain("- Readiness: `alpha_ready`");
    expect(engineerDescription).toContain("- Missing stations: none");
    expect(engineerDescription).toContain("- Source: payload.paperclip.dispatch_gate");
    expect(engineerDescription).toContain(
      "If readiness is not `alpha_ready` or `factory_ready`, or missing stations are present",
    );
    expect(engineerDescription).toContain("\"internet_pipes\"");
    const ceoAgent = calls.createAgent.find((entry) => entry.name === "CEO");
    expect(ceoAgent?.metadata).toMatchObject({
      portfolioDispatch: {
        internet_pipes: {
          score: 86.5,
          readiness: "alpha_ready",
          missing_stations: [],
          recommendations: ["Preserve visual proof and recommendation citations through QA."],
          source: "payload.paperclip.dispatch_gate",
        },
      },
    });
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toEqual([]);
    expect(calls.createRoutineTrigger).toEqual([]);
    expect(calls.ensureRepoClone).toEqual([
      expect.objectContaining({
        repoFullName: "g4mm4p4nd4/idea-spark",
        runBranch: "run/20260405T123000Z/bootstrap",
      }),
    ]);
    expect(calls.startProfitFlywheel).toEqual([
      expect.objectContaining({
        companyId: BOUND_COMPANY_ID,
        projectId: BOUND_PROJECT_ID,
        correlationId: "profit-flywheel:20260405T123000Z:idea-spark",
        sourceSchemaVersion: "pos.dispatch.v2",
        contract: managedAuthority.contract,
        policy: managedAuthority.policy,
        researchRegistryAuthority: managedAuthority.researchRegistryAuthority,
        dispatchSchemaPath: managedAuthority.dispatchSchemaPath,
      }),
    ]);
    expect(loadManagedRuntimeAuthority).toHaveBeenCalledTimes(1);
    expect(calls.wakeAgent).toHaveLength(0);

    const ingestedEntry = ledger.ingested[dispatchHash(raw)];
    expect(ingestedEntry.projectId).toBe(BOUND_PROJECT_ID);
    expect(ingestedEntry.issueIds).toHaveLength(3);
    expect(ingestedEntry.approvalIds).toEqual([]);
    expect(ingestedEntry.routineIds).toHaveLength(0);
  });

  it("hydrates Internet Pipes completeness from the selected opportunity fallback", async () => {
    const payload: any = sampleDispatch();
    delete payload.paperclip.dispatch_gate;
    delete payload.selection_snapshot.paperclip.dispatch_gate;
    payload.selection_snapshot.selected_opportunity = {
      internet_pipes: {
        score: "64.5",
        readiness: "promising",
        missing_stations: "evaluation | visualization",
        recommendations: ["Add competitive and market mechanics evidence."],
      },
    };
    payload.selection_snapshot_hash = selectionSnapshotHash(payload.selection_snapshot);
    const raw = JSON.stringify(payload);
    const { deps, calls } = makeDeps(raw);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    const engineerIssue = calls.createIssue.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Engineer ship first milestone",
    );
    const engineerDescription = String(engineerIssue?.description ?? "");
    expect(engineerDescription).toContain("- Score: 64.50");
    expect(engineerDescription).toContain("- Readiness: `promising`");
    expect(engineerDescription).toContain("- Missing stations: evaluation, visualization");
    expect(engineerDescription).toContain("- Source: selection_snapshot.selected_opportunity");
    expect(calls.createApproval).toHaveLength(0);
  });

  it("hydrates Internet Pipes completeness from the frozen business choice before dispatch gate fallbacks", async () => {
    const payload: any = sampleDispatch();
    payload.selection_snapshot.frozen_bundle = {
      business_choice: {
        internet_pipes_score: "48.25",
        internet_pipes_readiness: "promising",
        internet_pipes_missing_stations: "evaluation|visualization",
        internet_pipes_recommendations: ["Add competitive and market mechanics evidence."],
      },
    };
    payload.selection_snapshot_hash = selectionSnapshotHash(payload.selection_snapshot);
    const raw = JSON.stringify(payload);
    const { deps, calls } = makeDeps(raw);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    const engineerIssue = calls.createIssue.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Engineer ship first milestone",
    );
    const engineerDescription = String(engineerIssue?.description ?? "");
    expect(engineerDescription).toContain("- Score: 48.25");
    expect(engineerDescription).toContain("- Readiness: `promising`");
    expect(engineerDescription).toContain("- Missing stations: evaluation, visualization");
    expect(engineerDescription).toContain("- Source: selection_snapshot.frozen_bundle.business_choice");
    expect(calls.createApproval).toHaveLength(0);
  });

  it("uses only the explicitly bound canonical repo project", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls, ledger } = makeDeps(raw);
    deps.listProjects = async () => [
      {
        id: BOUND_PROJECT_ID,
        companyId: BOUND_COMPANY_ID,
        name: "LeadForge Core",
        description: "Canonical active venture lane.",
        status: "in_progress",
        workspaces: [
          {
            id: "workspace-target",
            name: "Target Repo",
            cwd: "/Users/mnm/Documents/Github/idea-spark",
            repoUrl: "https://github.com/g4mm4p4nd4/idea-spark.git",
            repoRef: "main",
            isPrimary: true,
          },
        ],
      },
    ];
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createWorkspace).toHaveLength(0);
    const targetWorkspace = calls.createWorkspace.find((entry) => entry.name === "Target Repo");
    expect(targetWorkspace).toBeUndefined();
    const engineerIssue = calls.createIssue.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Engineer ship first milestone",
    );
    expect(engineerIssue?.projectId).toBe(BOUND_PROJECT_ID);
    const ingestedEntry = ledger.ingested[dispatchHash(raw)];
    expect(ingestedEntry.projectId).toBe(BOUND_PROJECT_ID);
  });

  it("does not resurrect legacy shared-checkout polling when its old feature flag is off", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls } = makeDeps(raw);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    await withDispatchPollerIsolationFlag("false", async () => {
      const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);
      expect(result.status).toBe("ingested");
    });

    expect(calls.createRoutine).toEqual([]);
    expect(calls.createRoutineTrigger).toEqual([]);
    expect(calls.startProfitFlywheel).toHaveLength(1);
  });


  it("rejects dispatches when the dossier gate status is blocked", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps } = makeDeps(raw, sampleDossier("BLOCK_DUPLICATE", "fresh"));
    await expect(ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any)).rejects.toThrow(
      "Dispatch dossier gate status BLOCK_DUPLICATE is not allowed for Paperclip ingest.",
    );
  });

  it("rejects dispatches when dossier freshness is stale", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps } = makeDeps(raw, sampleDossier("APPROVED_NO_CONFLICT", "stale_inventory"));
    await expect(ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any)).rejects.toThrow(
      "Dispatch dossier freshness stale_inventory is not eligible for Paperclip ingest.",
    );
  });

  it("rejects dispatches when the dossier path is missing", async () => {
    const payload = sampleDispatch();
    delete payload.selected_repo_dossier_path;
    delete payload.selection_snapshot_path;
    delete payload.dossier_contract.selected_repo_dossier.dossier_path;
    const raw = JSON.stringify(payload);
    const { deps } = makeDeps(raw);
    await expect(ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any)).rejects.toThrow(
      "Dispatch payload is missing selected_repo_dossier_path.",
    );
  });

  it("synthesizes dossier compatibility for legacy dispatch payloads that omit dossier fields", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-legacy-"));
    const selectionSnapshotPath = path.join(tempDir, "selection_snapshot.json");
    const packetSnapshotPath = path.join(tempDir, "packet_snapshot.json");
    const payload = {
      ...sampleDispatch(),
      selection_snapshot_path: selectionSnapshotPath,
      packet_snapshot_path: packetSnapshotPath,
    };
    delete payload.selected_repo_dossier_path;
    delete payload.selected_repo_dossier_hash;
    delete payload.dossier_contract;

    await fs.writeFile(selectionSnapshotPath, JSON.stringify(payload.selection_snapshot, null, 2) + "\n", "utf8");
    await fs.writeFile(packetSnapshotPath, JSON.stringify(payload.selection_snapshot, null, 2) + "\n", "utf8");

    const raw = JSON.stringify(payload);
    const { deps, ledger } = makeDeps(raw);
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    const dossierPath = path.join(tempDir, "selected_repo_dossier.json");
    const dossier = JSON.parse(await fs.readFile(dossierPath, "utf8"));
    expect(dossier.identity.full_name).toBe("g4mm4p4nd4/idea-spark");
    expect(dossier.stage_0_gate_receipt.gate_status).toBe("APPROVED_NO_CONFLICT");
    expect(dossier.inventory_summary.freshness_status).toBe("fresh");
    expect(ledger.ingested[result.dispatchHash]).toBeTruthy();
  });

  it("skips already ingested dispatch hashes", async () => {
    const payload = sampleDispatch();
    const raw = JSON.stringify(payload);
    const { deps, calls, ledger } = makeDeps(raw);
    const hash = dispatchHash(raw);
    ledger.ingested[hash] = {
      dispatchHash: hash,
      runId: "20260405T123000Z",
      correlationId: payload.correlation_id,
      selectionSnapshotHash: payload.selection_snapshot_hash,
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-1"],
      approvalIds: ["approval-1"],
      ingestedAt: new Date().toISOString(),
    };

    const result = await ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any);

    expect(result.status).toBe("skipped");
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toHaveLength(0);
  });

  it("blocks and records immutable dispatch drift for an existing run", async () => {
    const canonicalPayload = sampleDispatch();
    const canonicalRaw = JSON.stringify(canonicalPayload);
    const driftRaw = JSON.stringify({
      ...canonicalPayload,
      generated_at: "2026-04-05T12:31:00.000Z",
    });
    const canonicalHash = dispatchHash(canonicalRaw);

    const { deps, calls, ledger } = makeDeps(driftRaw);
    ledger.ingested[canonicalHash] = {
      dispatchHash: canonicalHash,
      runId: "20260405T123000Z",
      correlationId: canonicalPayload.correlation_id,
      selectionSnapshotHash: canonicalPayload.selection_snapshot_hash,
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-1"],
      approvalIds: ["approval-1"],
      ingestedAt: "2026-04-05T12:30:00.000Z",
    };

    await expect(ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any)).rejects.toThrow(
      "conflicts with its canonical immutable hash/correlation",
    );

    expect(ledger.ingested[canonicalHash]).toBeTruthy();
    expect(Object.values(ledger.conflicts)).toEqual([
      expect.objectContaining({
        runId: "20260405T123000Z",
        canonicalDispatchHash: canonicalHash,
        observedDispatchHash: dispatchHash(driftRaw),
        blockerCode: "profit_flywheel_dispatch_replay_drift",
      }),
    ]);
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toHaveLength(0);
    expect(calls.blockIssue).toEqual([
      expect.objectContaining({
        issueId: "issue-1",
        blockerCode: "profit_flywheel_dispatch_replay_drift",
      }),
    ]);
    expect(deps.logError).toHaveBeenCalledWith(
      "portfolio dispatch replay drift blocked",
      expect.objectContaining({ canonicalDispatchHash: canonicalHash }),
    );
  });

  it("preserves conflicting ledger evidence instead of pruning it", async () => {
    const canonicalPayload = sampleDispatch();
    const canonicalRaw = JSON.stringify(canonicalPayload);
    const driftRaw = JSON.stringify({
      ...canonicalPayload,
      generated_at: "2026-04-05T12:31:00.000Z",
    });
    const canonicalHash = dispatchHash(canonicalRaw);
    const driftHash = dispatchHash(driftRaw);
    const { deps, calls, ledger } = makeDeps(driftRaw);

    ledger.ingested[driftHash] = {
      dispatchHash: driftHash,
      runId: "20260405T123000Z",
      correlationId: canonicalPayload.correlation_id,
      selectionSnapshotHash: canonicalPayload.selection_snapshot_hash,
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-drift"],
      approvalIds: ["approval-drift"],
      ingestedAt: "2026-04-05T14:00:00.000Z",
    };
    ledger.ingested[canonicalHash] = {
      dispatchHash: canonicalHash,
      runId: "20260405T123000Z",
      correlationId: canonicalPayload.correlation_id,
      selectionSnapshotHash: canonicalPayload.selection_snapshot_hash,
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-canonical"],
      approvalIds: ["approval-canonical"],
      ingestedAt: "2026-04-05T12:30:00.000Z",
    };

    await expect(ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any)).rejects.toThrow(
      "conflicts with its canonical immutable hash/correlation",
    );

    expect(ledger.ingested[canonicalHash]).toBeTruthy();
    expect(ledger.ingested[driftHash]).toBeTruthy();
    expect(Object.values(ledger.conflicts)).toEqual([
      expect.objectContaining({
        canonicalDispatchHash: canonicalHash,
        observedDispatchHash: driftHash,
        blockerCode: "profit_flywheel_dispatch_replay_drift",
      }),
    ]);
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toHaveLength(0);
    expect(calls.blockIssue).toEqual([
      expect.objectContaining({
        issueId: "issue-canonical",
        blockerCode: "profit_flywheel_dispatch_replay_drift",
      }),
    ]);
  });

  it("verifies the actual origin and remote base branch before accepting a prepared run workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dispatch-git-authority-"));
    try {
      const originPath = path.join(root, "origin.git");
      const otherOriginPath = path.join(root, "other-origin.git");
      const workspace = path.join(root, "workspace");
      await execFile("git", ["init", "--bare", "-b", "main", originPath]);
      await execFile("git", ["init", "-b", "main", workspace]);
      const canonicalWorkspace = await fs.realpath(workspace);
      await execFile("git", ["-C", workspace, "config", "user.email", "dispatch-authority@example.invalid"]);
      await execFile("git", ["-C", workspace, "config", "user.name", "Dispatch Authority"]);
      await fs.writeFile(path.join(workspace, "README.md"), "authorized base\n", "utf8");
      await execFile("git", ["-C", workspace, "add", "README.md"]);
      await execFile("git", ["-C", workspace, "commit", "-m", "authorized base"]);
      const baseSha = await execFile("git", ["-C", workspace, "rev-parse", "HEAD"])
        .then(({ stdout }) => stdout.trim());
      const originUrl = pathToFileURL(originPath).href;
      await execFile("git", ["-C", workspace, "remote", "add", "origin", originUrl]);
      await execFile("git", ["-C", workspace, "push", "-u", "origin", "main"]);
      const runBranch = "run/authority-fixture/bootstrap";
      await execFile("git", ["-C", workspace, "switch", "-c", runBranch]);

      await expect(ensureTargetRepoCloneAndRunBranch({
        repoFullName: "fixture/authorized",
        repoUrl: originUrl,
        clonePathHint: canonicalWorkspace,
        baseBranch: "main",
        runBranch,
        baseSha,
        dirtyWorkPolicy: "preserve_existing_intent",
      })).resolves.toMatchObject({ baseObject: baseSha, runBranch, workspaceSource: "bound_project_primary" });

      await execFile("git", ["init", "--bare", "-b", "main", otherOriginPath]);
      await execFile("git", ["-C", workspace, "remote", "set-url", "origin", pathToFileURL(otherOriginPath).href]);
      await expect(ensureTargetRepoCloneAndRunBranch({
        repoFullName: "fixture/authorized",
        repoUrl: originUrl,
        clonePathHint: canonicalWorkspace,
        baseBranch: "main",
        runBranch,
        baseSha,
        dirtyWorkPolicy: "preserve_existing_intent",
      })).rejects.toThrow("origin does not match");

      await execFile("git", ["-C", workspace, "remote", "set-url", "origin", originUrl]);
      await expect(ensureTargetRepoCloneAndRunBranch({
        repoFullName: "fixture/authorized",
        repoUrl: originUrl,
        clonePathHint: canonicalWorkspace,
        baseBranch: "main",
        runBranch,
        baseSha: "0".repeat(40),
        dirtyWorkPolicy: "preserve_existing_intent",
      })).rejects.toThrow("remote base branch no longer resolves");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a corrupt dispatch ledger and compare-and-set rejects a lost update", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dispatch-ledger-atomic-"));
    try {
      const ledgerPath = path.join(root, "dispatch-ledger.json");
      await fs.writeFile(ledgerPath, "{\"ingested\":", "utf8");
      await expect(readDispatchLedgerFromFs(ledgerPath)).rejects.toThrow("corrupt and must be repaired explicitly");

      await fs.unlink(ledgerPath);
      const left = await readDispatchLedgerFromFs(ledgerPath);
      const right = await readDispatchLedgerFromFs(ledgerPath);
      left.ingested.left = {
        dispatchHash: "a".repeat(64),
        runId: "left",
        correlationId: "left",
        selectionSnapshotHash: "b".repeat(64),
        dispatchPath: "/tmp/left.json",
        companyId: BOUND_COMPANY_ID,
        projectId: BOUND_PROJECT_ID,
        issueIds: [],
        approvalIds: [],
        ingestedAt: new Date().toISOString(),
      };
      right.ingested.right = {
        dispatchHash: "c".repeat(64),
        runId: "right",
        correlationId: "right",
        selectionSnapshotHash: "d".repeat(64),
        dispatchPath: "/tmp/right.json",
        companyId: BOUND_COMPANY_ID,
        projectId: BOUND_PROJECT_ID,
        issueIds: [],
        approvalIds: [],
        ingestedAt: new Date().toISOString(),
      };
      const writes = await Promise.allSettled([
        writeDispatchLedgerToFs(ledgerPath, left),
        writeDispatchLedgerToFs(ledgerPath, right),
      ]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
      const persisted = await readDispatchLedgerFromFs(ledgerPath);
      expect(persisted.revision).toBe(1);
      expect(Object.keys(persisted.ingested)).toHaveLength(1);
      expect((await fs.readdir(root)).some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
