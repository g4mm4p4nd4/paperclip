import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ingestPortfolioDispatchFile } from "../services/portfolio-dispatch.js";

function dispatchHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function sampleDispatch() {
  return {
    schema_version: "pos.dispatch.v1",
    run_id: "20260405T123000Z",
    selection_snapshot_hash: "snapshot-hash-1",
    selection_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-05/idea/selection_snapshot.json",
    packet_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_packets/2026-04-05/idea.selection_snapshot.json",
    target_repo_full_name: "g4mm4p4nd4/idea-spark",
    target_repo_branch: "main",
    target_repo_clone_path_hint: "/Users/mnm/Documents/Github/idea-spark",
    cockpit: {
      portfolio_os_dir: "/Users/mnm/Documents/Github/portfolio-os",
      paperclip_dir: "/Users/mnm/Documents/Github/paperclip",
      gstack_dir: "/Users/mnm/Documents/Github/gstack",
    },
    selection_snapshot: {
      launch_target: {
        repo: "g4mm4p4nd4/idea-spark",
        repo_url: "https://github.com/g4mm4p4nd4/idea-spark",
        robust_branch: "main",
        strongest_wedge: "AI idea generation with proof-first landing loops",
        recommended_offer_angle: "Ship an idea validation assistant for creators.",
      },
      artifacts: {
        scaffold_dir: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-05/idea-spark-main",
        launch_packet_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_packets/2026-04-05/idea-spark-main.md",
      },
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

function makeDeps(raw: string) {
  const ledger = { ingested: {} as Record<string, any> };
  const calls = {
    createCompany: [] as Array<Record<string, unknown>>,
    createProject: [] as Array<Record<string, unknown>>,
    createWorkspace: [] as Array<Record<string, unknown>>,
    createAgent: [] as Array<Record<string, unknown>>,
    createIssue: [] as Array<Record<string, unknown>>,
    createApproval: [] as Array<Record<string, unknown>>,
    wakeAgent: [] as Array<Record<string, unknown>>,
    linkApprovalToIssues: [] as Array<Record<string, unknown>>,
    ensureRepoClone: [] as Array<Record<string, unknown>>,
  };

  let issueCounter = 0;
  return {
    ledger,
    calls,
    deps: {
      readFile: async () => raw,
      readDispatchLedger: async () => ledger,
      writeDispatchLedger: async (next: typeof ledger) => {
        ledger.ingested = { ...next.ingested };
      },
      ensureGstackSkillLink: vi.fn(async () => {}),
      ensureRepoClone: vi.fn(async (input: Record<string, unknown>) => {
        calls.ensureRepoClone.push(input);
        return {
          clonePath: "/Users/mnm/Documents/Github/idea-spark",
          runBranch: "run/20260405T123000Z/bootstrap",
        };
      }),
      listCompanies: async () => [],
      createCompany: async (input: Record<string, unknown>) => {
        calls.createCompany.push(input);
        return {
          id: "company-1",
          name: String(input.name),
          description: (input.description as string | undefined) ?? null,
        };
      },
      listProjects: async () => [],
      createProject: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createProject.push(input);
        return {
          id: "project-1",
          companyId: "company-1",
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
          id: `agent-${calls.createAgent.length}`,
          companyId: "company-1",
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
          companyId: "company-1",
          projectId: String(input.projectId),
          title: String(input.title),
        };
      },
      listApprovals: async () => [],
      createApproval: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createApproval.push(input);
        return {
          id: "approval-1",
          companyId: "company-1",
          type: String(input.type),
          status: "pending",
          payload: (input.payload as Record<string, unknown>) ?? {},
        };
      },
      linkApprovalToIssues: async (approvalId: string, issueIds: string[]) => {
        calls.linkApprovalToIssues.push({ approvalId, issueIds });
      },
      wakeAgent: async (agentId: string, issueId: string, projectId: string, runId: string) => {
        calls.wakeAgent.push({ agentId, issueId, projectId, runId });
      },
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    },
  };
}

describe("portfolio dispatch ingest", () => {
  it("provisions company, project, workspaces, agents, issues, approval, and wakeups", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls, ledger } = makeDeps(raw);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);

    expect(result.status).toBe("ingested");
    expect(calls.createCompany).toHaveLength(1);
    expect(calls.createProject).toHaveLength(1);
    expect(calls.createWorkspace).toHaveLength(4);
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
    expect(calls.createApproval).toEqual([
      expect.objectContaining({ type: "launch_execution" }),
    ]);
    expect(calls.ensureRepoClone).toEqual([
      expect.objectContaining({
        repoFullName: "g4mm4p4nd4/idea-spark",
        runBranch: "run/20260405T123000Z/bootstrap",
      }),
    ]);
    expect(calls.wakeAgent).toHaveLength(3);

    const ingestedEntry = ledger.ingested[dispatchHash(raw)];
    expect(ingestedEntry.projectId).toBe("project-1");
    expect(ingestedEntry.issueIds).toHaveLength(3);
    expect(ingestedEntry.approvalIds).toEqual(["approval-1"]);
  });

  it("skips already ingested dispatch hashes", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls, ledger } = makeDeps(raw);
    const hash = dispatchHash(raw);
    ledger.ingested[hash] = {
      dispatchHash: hash,
      runId: "20260405T123000Z",
      selectionSnapshotHash: "snapshot-hash-1",
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
  });
});
