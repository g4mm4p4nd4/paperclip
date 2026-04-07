import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC,
  clampAgentHeartbeatIntervalSec,
  createAgentSchema,
  normalizeAgentRuntimeConfig,
  updateAgentSchema,
} from "./index.js";

describe("agent runtime config normalization", () => {
  it("caps heartbeat intervals at two hours", () => {
    expect(clampAgentHeartbeatIntervalSec(999999)).toBe(DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC);
    expect(clampAgentHeartbeatIntervalSec(-10)).toBe(0);
  });

  it("normalizes raw runtime configs", () => {
    expect(
      normalizeAgentRuntimeConfig({
        heartbeat: {
          enabled: true,
          intervalSec: 999999,
        },
      }),
    ).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC,
      },
    });
  });

  it("clamps heartbeat intervals in create and update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "Clamped Agent",
        adapterType: "claude_local",
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 999999,
          },
        },
      }).runtimeConfig,
    ).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC,
      },
    });

    expect(
      updateAgentSchema.parse({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 999999,
          },
        },
      }).runtimeConfig,
    ).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: DEFAULT_AGENT_HEARTBEAT_INTERVAL_SEC,
      },
    });
  });
});
