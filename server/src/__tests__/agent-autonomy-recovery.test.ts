import { describe, expect, it } from "vitest";
import {
  planAgentAutonomyRecovery,
  type RecoveryAgentInput,
} from "../ops/agent-autonomy-recovery.js";

function agent(overrides: Partial<RecoveryAgentInput> = {}): RecoveryAgentInput {
  return {
    id: "agent-1",
    companyId: "company-1",
    issuePrefix: "PORA",
    companyName: "Portfolio OS Orchestrator",
    name: "Researcher",
    role: "researcher",
    status: "error",
    runtimeConfig: {
      heartbeat: {
        enabled: false,
        intervalSec: 14_400,
        maxConcurrentRuns: 1,
      },
    },
    activeRoutineCount: 1,
    ...overrides,
  };
}

describe("agent autonomy recovery planning", () => {
  it("resets stale error agents and enables positive-interval timer heartbeats", () => {
    const [planned] = planAgentAutonomyRecovery([agent()]);

    expect(planned).toMatchObject({
      agentId: "agent-1",
      previousStatus: "error",
      nextStatus: "idle",
      reasons: ["stale_error_status_reset", "timer_heartbeat_enabled", "timer_baseline_reset"],
      nextHeartbeat: {
        enabled: true,
        intervalSec: 14_400,
        maxConcurrentRuns: 1,
      },
    });
  });

  it("enables timer heartbeat for idle agents with missing enabled flag", () => {
    const [planned] = planAgentAutonomyRecovery([
      agent({
        status: "idle",
        runtimeConfig: { heartbeat: { intervalSec: 7_200, wakeOnDemand: true } },
      }),
    ]);

    expect(planned).toMatchObject({
      previousStatus: "idle",
      nextStatus: "idle",
      reasons: ["timer_heartbeat_enabled", "timer_baseline_reset"],
      nextHeartbeat: {
        enabled: true,
        intervalSec: 7_200,
        wakeOnDemand: true,
      },
    });
  });

  it("does not enable interval-zero or active-routine-missing agents", () => {
    const planned = planAgentAutonomyRecovery([
      agent({
        id: "interval-zero",
        status: "idle",
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true } },
      }),
      agent({
        id: "archived-company-agent",
        activeRoutineCount: 0,
      }),
    ]);

    expect(planned).toHaveLength(0);
  });

  it("skips obvious synthetic test agents", () => {
    const planned = planAgentAutonomyRecovery([
      agent({
        id: "test-agent",
        name: "cross-company-test",
        status: "idle",
      }),
    ]);

    expect(planned).toHaveLength(0);
  });

  it("leaves paused and terminated agents alone by default", () => {
    const planned = planAgentAutonomyRecovery([
      agent({ id: "paused-agent", status: "paused" }),
      agent({ id: "terminated-agent", status: "terminated" }),
    ]);

    expect(planned).toHaveLength(0);
  });

  it("can include paused agents when explicitly requested", () => {
    const [planned] = planAgentAutonomyRecovery([
      agent({ id: "paused-agent", status: "paused" }),
    ], { includePaused: true });

    expect(planned).toMatchObject({
      agentId: "paused-agent",
      previousStatus: "paused",
      nextStatus: "paused",
      reasons: ["timer_heartbeat_enabled", "timer_baseline_reset"],
    });
  });

  it("resets timer baselines for already-enabled agents in active companies", () => {
    const [planned] = planAgentAutonomyRecovery([
      agent({
        status: "idle",
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3_600 } },
      }),
    ]);

    expect(planned).toMatchObject({
      previousStatus: "idle",
      nextStatus: "idle",
      reasons: ["timer_baseline_reset"],
      nextHeartbeat: {
        enabled: true,
        intervalSec: 3_600,
      },
    });
  });
});
