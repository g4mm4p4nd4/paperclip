import { describe, expect, it } from "vitest";
import {
  classifyStaleTriggerUpdate,
  deriveRoutineActionabilityContract,
  extractPortfolioDispatchContract,
  normalizeAgentConfigForFactoryRouting,
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
    });
    expect(contract.upstreamArtifactHash).toMatch(/^factory:/);
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

  it("blocks and pauses agency-swarm maintenance when no execution mandate is approved", () => {
    const { contract, nextStatus } = deriveRoutineActionabilityContract(routine({
      companyName: "Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm",
      title: "Operating Contract Drift Monitor",
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
});
