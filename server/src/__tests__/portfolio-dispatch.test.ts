import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ingestPortfolioDispatchFile } from "../services/portfolio-dispatch.js";

const DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION_ENV = "PAPERCLIP_POS_DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION";

function dispatchHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
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
  return {
    schema_version: "pos.dispatch.v1",
    run_id: "20260405T123000Z",
    selection_snapshot_hash: "snapshot-hash-1",
    selection_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-05/idea/selection_snapshot.json",
    packet_snapshot_path: "/Users/mnm/Documents/Github/portfolio-os/docs/launch_packets/2026-04-05/idea.selection_snapshot.json",
    selected_repo_dossier_path: "/Users/mnm/Documents/Github/portfolio-os/data/repo_inventory_detail/g4mm4p4nd4__idea-spark.json",
    selected_repo_dossier_hash: "dossier-hash-1",
    target_repo_full_name: "g4mm4p4nd4/idea-spark",
    target_repo_branch: "main",
    target_repo_clone_path_hint: "/Users/mnm/Documents/Github/idea-spark",
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

function makeDeps(raw: string, dossier = sampleDossier()) {
  const ledger = { ingested: {} as Record<string, any> };
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
          id: randomUUID(),
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
      listRoutines: async () => [],
      createRoutine: async (_companyId: string, input: Record<string, unknown>) => {
        calls.createRoutine.push(input);
        routineCounter += 1;
        return {
          id: `routine-${routineCounter}`,
          companyId: "company-1",
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
    const engineerIssue = calls.createIssue.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Engineer ship first milestone",
    );
    expect(engineerIssue?.executionPolicy).toMatchObject({
      commentRequired: true,
      stages: [
        { type: "review" },
        { type: "approval" },
      ],
    });
    expect(calls.createApproval).toEqual([
      expect.objectContaining({ type: "launch_execution" }),
    ]);
    expect(calls.createRoutine.map((entry) => entry.title)).toEqual(
      expect.arrayContaining([
        "[run_id:20260405T123000Z] Dispatch Poller",
        "[run_id:20260405T123000Z] Run QA Sweep",
        "[run_id:20260405T123000Z] Evidence Backfill Reconciler",
        "[run_id:20260405T123000Z] Release Gate Reconciler",
      ]),
    );
    const dispatchPollerRoutine = calls.createRoutine.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Dispatch Poller",
    );
    const dispatchPollerDescription = String(dispatchPollerRoutine?.description ?? "");
    expect(dispatchPollerDescription).toContain("Canonical contract hash source order");
    expect(dispatchPollerDescription).toContain("Approved `launch_execution` payload fields");
    expect(dispatchPollerDescription).toContain("Never treat local dispatch artifact bytes as the canonical hash source");
    expect(dispatchPollerDescription).toContain("Invariant (required for every run, including `20260410T005324Z`)");
    expect(dispatchPollerDescription).toContain("compare canonical dispatch hash against SHA-256 of `source_dispatch_path`");
    expect(dispatchPollerDescription).toContain("Emit an actionable `dispatch_parity_invariant` payload with keys");
    expect(dispatchPollerDescription).toContain("`run_id`, `dispatch_path`, `canonical_hash`, `observed_hash`, `parity_status`, `poller_state`");
    expect(dispatchPollerDescription).toContain("`contract mismatch`");
    expect(dispatchPollerDescription).toContain("`artifact drift`");
    expect(dispatchPollerDescription).toContain("`missing contract source`");
    expect(dispatchPollerDescription).toContain("`artifact drift` alone must not block release gating");
    expect(dispatchPollerDescription).toContain("Validate expected branch in an isolated workspace context");
    expect(dispatchPollerDescription).toContain("PAPERCLIP_WORKSPACE_SOURCE != project_primary");
    expect(dispatchPollerDescription).toContain("project.codebase.repoRef");
    expect(dispatchPollerDescription).toContain("suggested_branch_name");
    expect(dispatchPollerDescription).toContain("shared-workspace warning");
    expect(dispatchPollerDescription).toContain("Emit deterministic branch telemetry with keys");
    expect(dispatchPollerDescription).toContain("`run_id`, `workspace_id`, `workspace_source`, `branch_owner`");
    expect(dispatchPollerDescription).toContain("`expected_branch`, `observed_branch`, `observed_head_ref`, `observed_head_sha`");
    expect(dispatchPollerDescription).toContain("log `branch_owner=unknown` and escalate as a blocker");
    expect(dispatchPollerDescription).toContain("Preserve mismatch surfacing with remediation links");
    expect(dispatchPollerDescription).toContain("Do not force branch switching inside shared dirty workspaces");
    expect(dispatchPollerDescription).not.toContain("target repo remains on the run branch");
    expect(calls.createRoutineTrigger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Every 30 minutes", timezone: "America/New_York" }),
        expect.objectContaining({ label: "Every 4 hours", timezone: "America/New_York" }),
        expect.objectContaining({ label: "Three times daily", timezone: "America/New_York" }),
        expect.objectContaining({ label: "Every 2 hours", timezone: "America/New_York" }),
      ]),
    );
    const qaRoutine = calls.createRoutine.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Run QA Sweep",
    );
    const qaRoutineDescription = String(qaRoutine?.description ?? "");
    expect(qaRoutineDescription).toContain("Release target branch: main");
    expect(qaRoutineDescription).toContain(
      "State explicitly whether the validated batch is ready to land to the release target branch",
    );
    const releaseRoutine = calls.createRoutine.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Release Gate Reconciler",
    );
    const releaseRoutineDescription = String(releaseRoutine?.description ?? "");
    expect(releaseRoutineDescription).toContain("Release target branch: main");
    expect(releaseRoutineDescription).toContain("Treat the run branch as a staging lane only");
    expect(releaseRoutineDescription).toContain(
      "QA-cleared work is not done until it lands on the release target branch locally and the matching origin branch is updated",
    );
    expect(releaseRoutineDescription).toContain(
      "Do not leave the latest good state only on a run branch or only on the local machine",
    );
    expect(releaseRoutineDescription).toContain(
      "verify the shipped commit is reachable from both the local release target branch and the matching origin branch",
    );
    expect(releaseRoutineDescription).toContain(
      "If the local release target branch and the matching origin branch diverge, treat that as a blocker",
    );
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
    expect(ingestedEntry.routineIds).toHaveLength(4);
  });

  it("uses legacy shared-checkout poller guidance when isolation feature flag is off", async () => {
    const raw = JSON.stringify(sampleDispatch());
    const { deps, calls } = makeDeps(raw);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "portfolio-dispatch-"));
    const dispatchPath = path.join(tempDir, "dispatch_20260405T123000Z.json");
    await fs.writeFile(dispatchPath, raw, "utf8");

    await withDispatchPollerIsolationFlag("false", async () => {
      const result = await ingestPortfolioDispatchFile(dispatchPath, deps as any);
      expect(result.status).toBe("ingested");
    });

    const dispatchPollerRoutine = calls.createRoutine.find(
      (entry) => entry.title === "[run_id:20260405T123000Z] Dispatch Poller",
    );
    const dispatchPollerDescription = String(dispatchPollerRoutine?.description ?? "");
    expect(dispatchPollerDescription).toContain(
      "Branch validation mode: legacy_shared_checkout (PAPERCLIP_POS_DISPATCH_POLLER_ISOLATED_BRANCH_VALIDATION=false).",
    );
    expect(dispatchPollerDescription).toContain("target repo remains on the run branch");
    expect(dispatchPollerDescription).toContain("may mutate shared clone branch state via checkout/switch operations");
    expect(dispatchPollerDescription).not.toContain("PAPERCLIP_WORKSPACE_SOURCE != project_primary");
    expect(dispatchPollerDescription).not.toContain("do not checkout/switch/reset in-place");
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
    expect(calls.createRoutine).toHaveLength(0);
  });

  it("preserves canonical run hash when dispatch bytes drift for the same run", async () => {
    const canonicalRaw = JSON.stringify(sampleDispatch());
    const driftRaw = JSON.stringify({
      ...sampleDispatch(),
      selection_snapshot_hash: "snapshot-hash-drift",
    });
    const canonicalHash = dispatchHash(canonicalRaw);

    const { deps, calls, ledger } = makeDeps(driftRaw);
    ledger.ingested[canonicalHash] = {
      dispatchHash: canonicalHash,
      runId: "20260405T123000Z",
      selectionSnapshotHash: "snapshot-hash-1",
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-1"],
      approvalIds: ["approval-1"],
      ingestedAt: "2026-04-05T12:30:00.000Z",
    };

    const result = await ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any);

    expect(result.status).toBe("skipped");
    expect(result.dispatchHash).toBe(canonicalHash);
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toHaveLength(0);
    expect(deps.logWarn).toHaveBeenCalledWith(
      "portfolio dispatch run hash drift ignored",
      expect.objectContaining({
        runId: "20260405T123000Z",
        canonicalDispatchHash: canonicalHash,
        observedDispatchHash: dispatchHash(driftRaw),
        sourceDispatchPath: "/tmp/dispatch.json",
      }),
    );
  });

  it("prunes duplicate run ledger hashes and keeps earliest canonical entry", async () => {
    const canonicalRaw = JSON.stringify(sampleDispatch());
    const driftRaw = JSON.stringify({
      ...sampleDispatch(),
      selection_snapshot_hash: "snapshot-hash-drift",
    });
    const canonicalHash = dispatchHash(canonicalRaw);
    const driftHash = dispatchHash(driftRaw);
    const { deps, calls, ledger } = makeDeps(driftRaw);

    ledger.ingested[driftHash] = {
      dispatchHash: driftHash,
      runId: "20260405T123000Z",
      selectionSnapshotHash: "snapshot-hash-drift",
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
      selectionSnapshotHash: "snapshot-hash-1",
      dispatchPath: "/tmp/dispatch.json",
      companyId: "company-1",
      projectId: "project-1",
      issueIds: ["issue-canonical"],
      approvalIds: ["approval-canonical"],
      ingestedAt: "2026-04-05T12:30:00.000Z",
    };

    const result = await ingestPortfolioDispatchFile("/tmp/dispatch.json", deps as any);

    expect(result.status).toBe("skipped");
    expect(result.dispatchHash).toBe(canonicalHash);
    expect(ledger.ingested[canonicalHash]).toBeTruthy();
    expect(ledger.ingested[driftHash]).toBeUndefined();
    expect(calls.createCompany).toHaveLength(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createIssue).toHaveLength(0);
    expect(calls.createApproval).toHaveLength(0);
    expect(calls.createRoutine).toHaveLength(0);
    expect(deps.logWarn).toHaveBeenCalledWith(
      "portfolio dispatch run ledger duplicates pruned",
      expect.objectContaining({
        runId: "20260405T123000Z",
        canonicalDispatchHash: canonicalHash,
        removedDispatchHashes: [driftHash],
      }),
    );
    expect(deps.logWarn).toHaveBeenCalledWith(
      "portfolio dispatch run hash drift ignored",
      expect.objectContaining({
        runId: "20260405T123000Z",
        canonicalDispatchHash: canonicalHash,
        observedDispatchHash: driftHash,
      }),
    );
  });
});
