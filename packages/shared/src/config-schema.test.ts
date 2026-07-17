import { describe, expect, it } from "vitest";
import { factoryConfigSchema, factoryRuntimeConfigSchema } from "./config-schema.js";

describe("factory config contracts", () => {
  it("accepts the versioned operator posture independently of runtime bindings", () => {
    expect(factoryConfigSchema.parse({
      mode: "shadow",
      pauseNewWork: true,
      baselinePointerPath: "~/.paperclip/instances/default/data/ops/factory-baseline.json",
      baselineRefresh: {
        enabled: true,
        intervalSeconds: 60,
        companyId: "10000000-0000-4000-8000-000000000001",
        workflowRunId: "factory-fixture-1",
        instanceRoot: "/paperclip/instance",
        pluginStorePath: "/paperclip/adapter-plugins.json",
        repositories: {
          portfolioOs: "/runtime/portfolio-os",
          paperclip: "/runtime/paperclip",
          hermesAgent: "/runtime/hermes-agent",
          hermesPaperclipAdapter: "/runtime/hermes-paperclip-adapter",
        },
      },
      tokenomicsWatch: {
        enabled: true,
        intervalSeconds: 300,
      },
    })).toEqual({
      mode: "shadow",
      pauseNewWork: true,
      baselinePointerPath: "~/.paperclip/instances/default/data/ops/factory-baseline.json",
      baselineRefresh: {
        enabled: true,
        intervalSeconds: 60,
        companyId: "10000000-0000-4000-8000-000000000001",
        workflowRunId: "factory-fixture-1",
        instanceRoot: "/paperclip/instance",
        pluginStorePath: "/paperclip/adapter-plugins.json",
        repositories: {
          portfolioOs: "/runtime/portfolio-os",
          paperclip: "/runtime/paperclip",
          hermesAgent: "/runtime/hermes-agent",
          hermesPaperclipAdapter: "/runtime/hermes-paperclip-adapter",
        },
      },
      tokenomicsWatch: {
        enabled: true,
        intervalSeconds: 300,
        applyBalanceOnDrift: false,
      },
    });
    expect(factoryRuntimeConfigSchema.parse({
      portfolioOsRuntimeRoot: "/runtime/portfolio-os",
    })).toEqual({
      portfolioOsRuntimeRoot: "/runtime/portfolio-os",
    });
    expect(() => factoryRuntimeConfigSchema.parse({})).toThrow();
  });

  it.each([
    { mode: "live", pauseNewWork: false },
    { mode: "production" },
    { mode: "fixture", pauseNewWork: false, unexpected: true },
    { mode: "fixture", pauseNewWork: false, baselinePointerPath: "   " },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 59 } },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 300, unknown: true } },
    { mode: "fixture", pauseNewWork: false, baselineRefresh: { enabled: true, intervalSeconds: 91 } },
  ])("rejects an invalid or expanded posture: %j", (value) => {
    expect(() => factoryConfigSchema.parse(value)).toThrow();
  });
});
