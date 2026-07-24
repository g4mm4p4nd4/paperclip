import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_SECRET_NAME,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
} from "../services/deployment-target-policy.js";
import {
  PINNED_PROVIDER_POLICY_SCHEMA_SHA256,
  PINNED_PROVIDER_POLICY_SHA256,
} from "../services/provider-policy.js";
import {
  classifyTriggerUpdate,
  classifyStaleTriggerUpdate,
  collectPortfolioOsActionabilityHashes,
  deriveRoutineActionabilityContract,
  extractPortfolioDispatchContract,
  isPortfolioControlPlaneRoutine,
  normalizeAgentConfigForFactoryRouting,
  planInternetPipesGapGuard,
  planResolvedDuplicateLoopGuardIssues,
  planResolvedWorkspaceGuardIssues,
  routineConcurrencyPolicyForContract,
  routineFamilyTitle,
  upsertActionabilityContract,
  type FactoryActionabilityContract,
} from "../ops/unattended-factory-configuration.js";

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    companyId: "company-1",
    companyName: "Portfolio Venture Factory :: g4mm4p4nd4/YT-Synth",
    issuePrefix: "PORA",
    projectId: "project-1",
    projectName: "Run 20260503T193357Z :: g4mm4p4nd4/YT-Synth",
    goalId: null,
    title: "[run_id:20260503T193357Z] Release Gate Reconciler",
    description: null,
    status: "active",
    priority: "high",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    workspaceCwd: "/tmp/yt-synth",
    ...overrides,
  } as any;
}

describe("unattended factory configuration helpers", () => {
  async function writeFrozenSelection(root: string, payload: Record<string, unknown>) {
    const frozenPath = path.join(root, "data/frozen_selection.json");
    await mkdir(path.dirname(frozenPath), { recursive: true });
    await writeFile(frozenPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async function writePortfolioInput(root: string, relativePath: string, content: string) {
    const targetPath = path.join(root, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  it("preserves existing Portfolio Dispatch Contract metadata while adding actionability", () => {
    const contract: FactoryActionabilityContract = {
      contractVersion: "paperclip.actionability.v1",
      lane: "release",
      state: "ready_to_ship",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: "release_gate",
      requiredSecretNames: [],
      upstreamArtifactHash: "dispatch:selection",
      requireUpstreamChange: true,
      cadenceGroup: "release",
      minCadenceMinutes: 120,
      minIntervalMinutes: 120,
      requiresCleanWorkspace: true,
      requireCleanWorkspace: true,
      workspaceCwd: "/tmp/repo",
      allowDirtyPathPrefixes: [],
      standingIssueKey: "factory:yt:release",
      shipCaptain: true,
      blockerFingerprint: "run:release",
    };
    const description = [
      "Existing routine body.",
      "",
      "## Portfolio Dispatch Contract",
      "```json",
      JSON.stringify({ run_id: "20260503T193357Z", dispatch_hash: "abc" }, null, 2),
      "```",
    ].join("\n");

    const next = upsertActionabilityContract(description, contract);
    const metadata = extractPortfolioDispatchContract(next);

    expect(metadata.run_id).toBe("20260503T193357Z");
    expect(metadata.dispatch_hash).toBe("abc");
    expect(metadata.paperclip_actionability).toMatchObject({
      lane: "release",
      state: "ready_to_ship",
      shipCaptain: true,
    });
    expect(next).toContain("Existing routine body.");
  });

  it("marks release-gate routines as clean-workspace ship-captain lanes", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine());

    expect(nextStatus).toBe("active");
    expect(contract).toMatchObject({
      lane: "release",
      state: "ready_to_ship",
      blockerClass: "release_gate",
      requireCleanWorkspace: true,
      requiresCleanWorkspace: true,
      workspaceCwd: "/tmp/yt-synth",
      shipCaptain: true,
      minCadenceMinutes: 120,
      requiredSecretNames: [],
    });
    expect(contract.upstreamArtifactHash).toMatch(/^factory:/);
  });

  it("marks live deployment routines as Hostinger-gated ship-captain lanes", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      title: "LeadForge durable public endpoint reprovision + health proof",
      companyName: "Portfolio Venture Factory :: Glitch-Cipher-Syndicate/LeadForge",
      workspaceCwd: "/tmp/leadforge",
    }));

    expect(nextStatus).toBe("active");
    expect(contract).toMatchObject({
      lane: "deploy",
      state: "ready_to_ship",
      blockerClass: "hostinger_deploy",
      requireCleanWorkspace: true,
      requiresCleanWorkspace: true,
      workspaceCwd: "/tmp/leadforge",
      shipCaptain: true,
      requiredSecretNames: [
        HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
        HOSTINGER_API_KEY_SECRET_NAME,
        HOSTINGER_FIREWALL_ID_SECRET_NAME,
        HOSTINGER_VM_ID_SECRET_NAME,
      ],
      deploymentTarget: {
        provider: "hostinger",
        networkPolicy: "allowlist_single_client_ip",
      },
    });
    expect(contract.upstreamArtifactHash).toMatch(/^factory:/);
    expect(contract.requiredSecretNames).not.toContain("FLY_API_TOKEN");
  });

  it("adds YT-Synth distribution credential blockers to evidence backfill lanes", () => {
    const { contract } = deriveRoutineActionabilityContract(routine({
      title: "[run_id:20260503T193357Z] Evidence Backfill Reconciler",
    }));

    expect(contract).toMatchObject({
      lane: "distribution",
      blockerClass: "distribution_credentials",
      requiredSecretNames: ["YT_SYNTH_EMAIL_CREDENTIALS", "YT_SYNTH_SOCIAL_CREDENTIALS"],
    });
  });

  it("requires a clean Portfolio OS workspace for research-boundary evidence intake", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Signal Desk :: Evidence Intake Gate",
      projectName: "Signal Desk",
      workspaceCwd: "/Users/mnm/Documents/Github/portfolio-os",
    }));

    expect(nextStatus).toBe("active");
    expect(contract).toMatchObject({
      lane: "evidence",
      blockerClass: "research_boundary",
      requireCleanWorkspace: true,
      requiresCleanWorkspace: true,
      workspaceCwd: "/Users/mnm/Documents/Github/portfolio-os",
    });
  });

  it("uses canonical Portfolio OS evidence files for control-plane actionability hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pos-hash-"));
    await writePortfolioInput(root, "inputs/market_signals/latest.csv", "signal_id,problem\nM1,alpha\n");
    await writePortfolioInput(root, "inputs/voc/latest.csv", "signal_id,quote\nV1,beta\n");
    await writeFrozenSelection(root, { run_id: "20260704T190000Z", repo: "owner/repo" });

    const firstHashes = await collectPortfolioOsActionabilityHashes(root);
    const liveRoutine = routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Signal Desk :: Market Sweep",
      projectName: "Signal Desk",
      workspaceCwd: null,
    });
    const first = deriveRoutineActionabilityContract(liveRoutine, {
      portfolioOsHashes: firstHashes,
    }).contract;

    await writePortfolioInput(root, "inputs/market_signals/latest.csv", "signal_id,problem\nM1,alpha\nM2,gamma\n");
    const secondHashes = await collectPortfolioOsActionabilityHashes(root);
    const second = deriveRoutineActionabilityContract(liveRoutine, {
      portfolioOsHashes: secondHashes,
    }).contract;

    expect(first.upstreamArtifactHash).toMatch(/^pos:/);
    expect(second.upstreamArtifactHash).toMatch(/^pos:/);
    expect(first.upstreamArtifactHash).not.toBe(second.upstreamArtifactHash);
    expect(first.blockerFingerprint).not.toBe(second.blockerFingerprint);
  });

  it("uses combined market, VOC, and frozen-selection hashes for the evidence intake gate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pos-boundary-hash-"));
    await writePortfolioInput(root, "inputs/market_signals/latest.csv", "signal_id,problem\nM1,alpha\n");
    await writePortfolioInput(root, "inputs/voc/latest.csv", "signal_id,quote\nV1,beta\n");
    await writeFrozenSelection(root, { run_id: "20260704T190000Z", repo: "owner/repo" });

    const firstHashes = await collectPortfolioOsActionabilityHashes(root);
    const liveRoutine = routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Signal Desk :: Evidence Intake Gate",
      projectName: "Signal Desk",
      workspaceCwd: "/tmp/portfolio-os",
    });
    const first = deriveRoutineActionabilityContract(liveRoutine, {
      portfolioOsHashes: firstHashes,
    }).contract;

    await writePortfolioInput(root, "inputs/voc/latest.csv", "signal_id,quote\nV1,beta\nV2,delta\n");
    const secondHashes = await collectPortfolioOsActionabilityHashes(root);
    const second = deriveRoutineActionabilityContract(liveRoutine, {
      portfolioOsHashes: secondHashes,
    }).contract;

    expect(first.upstreamArtifactHash).toBe(firstHashes.evidenceBoundary);
    expect(second.upstreamArtifactHash).toBe(secondHashes.evidenceBoundary);
    expect(first.upstreamArtifactHash).not.toBe(second.upstreamArtifactHash);
  });

  it("recognizes Portfolio OS control-plane routines that must resume the flywheel", () => {
    expect(isPortfolioControlPlaneRoutine("Portfolio OS Orchestrator", "Council Chamber :: Existing Venture Gate")).toBe(true);
    expect(isPortfolioControlPlaneRoutine("Portfolio OS Orchestrator", "Venture Graduation :: Route Or Graduate")).toBe(true);
    expect(isPortfolioControlPlaneRoutine("Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm", "Venture Graduation :: Route Or Graduate")).toBe(false);

    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Council Chamber :: Council Triage",
      projectName: "Council Chamber",
    }));

    expect(nextStatus).toBe("active");
    expect(contract).toMatchObject({
      lane: "product_execution",
      blockerClass: "council_triage",
      nextActionOwner: "agent",
      requireUpstreamChange: false,
      councilEvidenceGate: {
        promoteScoreThreshold: 70,
        scoring: {
          vocSignal: 25,
          marketSizeAndTrajectory: 20,
          repoFeasibility: 20,
          competitiveGap: 20,
          councilConfidence: 15,
        },
      },
      councilIssuePolicy: {
        createSeparateChildIssuesImmediately: true,
        assignChildIssuesBeforeRoutineCompletion: true,
        wakeAssignedChildIssuesOnRoutineCompletion: true,
        defaultChildIssueOwnerFallback: "creator_or_routine_assignee",
        allowParallelCompetingHypotheses: true,
      },
      scratchPersistence: {
        paperclipIssueDocumentKey: "council-hypothesis-ledger",
        portfolioOsMirrorRoot: "data/council_hypotheses/paperclip",
      },
    });
    expect(contract.councilIdeationMandate).toContain("score >= 70");
    expect(routineConcurrencyPolicyForContract(routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Council Chamber :: Council Triage",
      projectName: "Council Chamber",
    }), contract)).toBe("always_enqueue");
  });

  it("keeps agency-swarm operating-contract maintenance active", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      companyName: "Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm",
      title: "Operating Contract Drift Monitor",
      workspaceCwd: "/tmp/agency-swarm",
    }));

    expect(nextStatus).toBe("active");
    expect(contract).toMatchObject({
      lane: "maintenance",
      state: "maintenance_due",
      blockerOwner: "agent",
      nextActionOwner: "agent",
      blockerClass: "governance_drift",
    });
  });

  it("keeps agency-swarm run-scoped execution routines paused without a mandate", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      companyName: "Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm",
      title: "[run_id:20260420T210900Z] Release Gate Reconciler",
      workspaceCwd: "/tmp/agency-swarm",
    }));

    expect(nextStatus).toBe("paused");
    expect(contract).toMatchObject({
      lane: "maintenance",
      state: "waiting_for_human_credential",
      blockerOwner: "board",
      nextActionOwner: "board",
      blockerClass: "execution_mandate",
    });
  });

  it("normalizes Hermes agents to OpenCode Go with MiniMax-only degraded routing", () => {
    const normalized = normalizeAgentConfigForFactoryRouting({
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/repo",
        model: "deepseek-v4-flash",
        provider: "auto",
        quotaMode: "opencode-go-with-zen-free-fallback",
      },
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.nextAdapterConfig).toMatchObject({
      cwd: "/tmp/repo",
      model: "deepseek-v4-flash",
      provider: "opencode-go",
      disableFallbackModel: true,
      tieredExecution: {
        enabled: true,
        minimaxPrimary: true,
        adapterOrder: ["hermes_minimax"],
        allowPostMiniMaxFallbacks: false,
        allowPaidSubscriptionFallbacks: false,
        hermes_minimax: {
          provider: "minimax",
          model: "MiniMax-M3",
        },
      },
    });
    expect(normalized.nextAdapterConfig).not.toHaveProperty("quotaMode");
  });

  it("accepts a content-pinned provider policy from an immutable runtime closure", () => {
    const normalized = normalizeAgentConfigForFactoryRouting({
      adapterType: "hermes_local",
      adapterConfig: {
        providerPolicy: {
          schemaVersion: "provider-policy.v2",
          path: "/immutable/paperclip-closure/config/provider-policy.v2.json",
          sha256: PINNED_PROVIDER_POLICY_SHA256,
          schemaPath: "/immutable/paperclip-closure/config/provider-policy.v2.schema.json",
          schemaSha256: PINNED_PROVIDER_POLICY_SCHEMA_SHA256,
          capabilityAlias: "code_deep",
          budgetClass: "implementation",
        },
        tieredExecution: { enabled: true },
      },
    });

    expect(normalized.changed).toBe(true);
    expect(normalized.nextAdapterConfig).not.toHaveProperty("tieredExecution");
    expect(normalized.nextAdapterConfig).toMatchObject({
      disableFallbackModel: true,
      providerPolicy: {
        path: "/immutable/paperclip-closure/config/provider-policy.v2.json",
        sha256: PINNED_PROVIDER_POLICY_SHA256,
      },
    });
  });

  it("strips run ids for routine family coalescing", () => {
    expect(routineFamilyTitle("[run_id:20260503T193357Z] Dispatch Poller")).toBe("Dispatch Poller");
    expect(routineFamilyTitle("Operating Contract Drift Monitor")).toBe("Operating Contract Drift Monitor");
  });

  it("disables enabled triggers attached to non-active routines", () => {
    const update = classifyStaleTriggerUpdate({
      id: "trigger-1",
      routineId: "routine-1",
      kind: "schedule",
      label: "Every 30 minutes",
      enabled: true,
      cronExpression: "*/30 * * * *",
      timezone: "America/New_York",
      lastResult: null,
      companyName: "Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm",
      issuePrefix: "PORAAA",
      routineTitle: "[run_id:20260420T210900Z] Dispatch Poller",
      routineStatus: "paused",
    } as any);

    expect(update).toMatchObject({
      nextEnabled: false,
      nextCronExpression: "*/30 * * * *",
      nextLabel: "Every 30 minutes",
      nextRunAt: null,
      reason: "non_active_routine_trigger_disabled:paused",
    });
  });

  it("restores disabled active execution schedules instead of preserving unschedulable state", () => {
    const now = new Date("2026-06-30T17:45:00.000Z");
    const preservedFutureRun = new Date("2026-06-30T23:30:00.000Z");
    const liveRoutine = routine({
      companyName: "Portfolio OS Orchestrator",
      title: "Asset Composition Lab :: Venture Composition",
      projectName: "Asset Composition Lab",
      workspaceCwd: null,
    });
    const { contract, nextStatus } = deriveRoutineActionabilityContract(liveRoutine);

    const update = classifyTriggerUpdate({
      id: "trigger-asset-composition",
      routineId: liveRoutine.id,
      kind: "schedule",
      label: null,
      enabled: false,
      cronExpression: "30 10,19 * * *",
      timezone: "America/New_York",
      nextRunAt: preservedFutureRun,
      lastResult: "preserve_execution_trigger",
    }, {
      routine: liveRoutine,
      contract,
      nextDescription: "Asset composition contract",
      nextStatus,
      nextConcurrencyPolicy: "coalesce_if_active",
    } as any, true, now, false);

    expect(update).toMatchObject({
      nextEnabled: true,
      nextCronExpression: "30 10,19 * * *",
      nextLabel: null,
      nextRunAt: preservedFutureRun,
      reason: "active_execution_trigger_restored",
    });
  });

  it("keeps the first maintenance schedule even when an api trigger is listed first", () => {
    const now = new Date("2026-06-30T17:45:00.000Z");
    const liveRoutine = routine({
      title: "Operating Contract Drift Monitor",
      projectName: "Operations",
      workspaceCwd: null,
    });
    const { contract, nextStatus } = deriveRoutineActionabilityContract(liveRoutine);
    const routineUpdate = {
      routine: liveRoutine,
      contract,
      nextDescription: "Maintenance contract",
      nextStatus,
      nextConcurrencyPolicy: "coalesce_if_active",
    } as any;

    const apiUpdate = classifyTriggerUpdate({
      id: "trigger-api",
      routineId: liveRoutine.id,
      kind: "api",
      label: null,
      enabled: false,
      cronExpression: null,
      timezone: null,
      nextRunAt: null,
      lastResult: "duplicate_maintenance_trigger_disabled",
    }, routineUpdate, false, now, false);
    const scheduleUpdate = classifyTriggerUpdate({
      id: "trigger-schedule",
      routineId: liveRoutine.id,
      kind: "schedule",
      label: "Every 6 hours",
      enabled: false,
      cronExpression: "5 */6 * * *",
      timezone: "America/New_York",
      nextRunAt: null,
      lastResult: "duplicate_maintenance_trigger_disabled",
    }, routineUpdate, true, now, false);

    expect(apiUpdate).toMatchObject({
      nextEnabled: false,
      reason: "duplicate_maintenance_trigger_disabled",
    });
    expect(scheduleUpdate).toMatchObject({
      nextEnabled: true,
      nextCronExpression: "17 */12 * * *",
      nextLabel: "Every 12 hours (factory maintenance cadence)",
      reason: "lower_frequency_maintenance_cadence",
    });
  });

  it("resolves workspace guard issues whose dirty fingerprint is no longer active", () => {
    const plans = planResolvedWorkspaceGuardIssues([
      {
        id: "stale-issue",
        companyId: "company-1",
        companyName: "Portfolio OS Orchestrator",
        issuePrefix: "PORA",
        identifier: "PORA-1857",
        originId: "workspace_cleanup:workspace:old",
        cwd: "/Users/mnm/Documents/Github/portfolio-os",
        fingerprint: "workspace:old",
      },
      {
        id: "active-issue",
        companyId: "company-2",
        companyName: "Portfolio Venture Factory :: LeadForge",
        issuePrefix: "POR",
        identifier: "POR-2721",
        originId: "workspace_cleanup:workspace:active",
        cwd: "/Users/mnm/Documents/Github/LeadForge",
        fingerprint: "workspace:active",
      },
    ], new Set(["workspace:active"]));

    expect(plans).toEqual([
      {
        issue: expect.objectContaining({ id: "stale-issue", identifier: "PORA-1857" }),
        reason: "workspace_cleanliness_resolved",
      },
    ]);
  });

  it("resolves duplicate-loop guards when their origin is no longer active", () => {
    const plans = planResolvedDuplicateLoopGuardIssues([
      {
        id: "stale-loop",
        companyId: "company-1",
        companyName: "Portfolio OS Orchestrator",
        issuePrefix: "PORA",
        identifier: "PORA-1848",
        originId: "duplicate_loop:stale",
      },
      {
        id: "active-loop",
        companyId: "company-1",
        companyName: "Portfolio OS Orchestrator",
        issuePrefix: "PORA",
        identifier: "PORA-1849",
        originId: "duplicate_loop:active",
      },
    ], new Set(["duplicate_loop:active"]));

    expect(plans).toEqual([
      {
        issue: expect.objectContaining({ id: "stale-loop", identifier: "PORA-1848" }),
        reason: "duplicate_loop_not_active",
      },
    ]);
  });

  it("plans an Orchestrator Internet Pipes guard for the current frozen research gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-internet-pipes-gap-"));
    await writeFrozenSelection(root, {
      run_id: "20260629T071119Z",
      decision_status: "research_only",
      research_target: {
        repo: "g4mm4p4nd4/agency-swarm",
        internet_pipes_readiness: "insufficient",
        internet_pipes_score: "36.00",
        internet_pipes_missing_stations: "evaluation | differentiation | visualization | recommendation",
        internet_pipes_recommendations: "Add competitive evidence. | Add a visual proof packet.",
        missing_evidence: "No region evidence found.",
      },
    });

    const guard = await planInternetPipesGapGuard({
      portfolioCompany: { id: "company-1", name: "Portfolio OS Orchestrator", issuePrefix: "PORA" },
      portfolioOsRoot: root,
    });

    expect(guard).toMatchObject({
      companyId: "company-1",
      companyName: "Portfolio OS Orchestrator",
      issuePrefix: "PORA",
      runId: "20260629T071119Z",
      repo: "g4mm4p4nd4/agency-swarm",
      decisionStatus: "research_only",
      readiness: "insufficient",
      score: 36,
      missingStations: ["evaluation", "differentiation", "visualization", "recommendation"],
      recommendations: ["Add competitive evidence.", "Add a visual proof packet."],
      missingEvidence: "No region evidence found.",
    });
    expect(guard?.originId).toContain("internet_pipes_gap:internet_pipes:g4mm4p4nd4-agency-swarm:20260629t071119z");
    expect(guard?.sourcePath).toBe(path.join(root, "data/frozen_selection.json"));
  });

  it("skips Internet Pipes guard planning when the frozen target is dispatch ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-internet-pipes-ready-"));
    await writeFrozenSelection(root, {
      run_id: "20260629T080000Z",
      decision_status: "launch_ready",
      launch_target: {
        repo: "owner/repo",
        internet_pipes_readiness: "factory_ready",
        internet_pipes_score: 92,
        internet_pipes_missing_stations: "",
      },
    });

    await expect(planInternetPipesGapGuard({
      portfolioCompany: { id: "company-1", name: "Portfolio OS Orchestrator", issuePrefix: "PORA" },
      portfolioOsRoot: root,
    })).resolves.toBeNull();
  });
});
