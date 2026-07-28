import { describe, expect, it } from "vitest";
import {
  assertProductionFactoryLiveMode,
  factoryConfigSchema,
  factoryRuntimeConfigSchema,
  paperclipConfigSchema,
} from "./config-schema.js";

const baseConfig = {
  $meta: {
    version: 1,
    updatedAt: "2026-07-28T00:00:00.000Z",
    source: "configure",
  },
  database: {
    mode: "embedded-postgres",
    embeddedPostgresDataDir: "/tmp/paperclip/db",
    embeddedPostgresPort: 54329,
  },
  logging: {
    mode: "file",
    logDir: "/tmp/paperclip/logs",
  },
  server: {
    deploymentMode: "authenticated",
    exposure: "private",
    bind: "lan",
    host: "0.0.0.0",
    port: 3100,
    serveUi: true,
  },
} as const;

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
        baselineHours: 96,
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

  it("preserves factory posture and immutable runtime bindings in a whole config", () => {
    const parsed = paperclipConfigSchema.parse({
      ...baseConfig,
      factory: {
        mode: "fixture",
        pauseNewWork: true,
        baselinePointerPath: "/tmp/paperclip/baseline.json",
        baselineRefresh: {
          enabled: true,
          intervalSeconds: 60,
          companyId: "216897d4-0f94-4736-9b6b-a20c8e48d694",
          workflowRunId: "profit-flywheel-e2e-20260714T144320Z",
          instanceRoot: "/tmp/paperclip/instance",
          pluginStorePath: "/tmp/paperclip/adapter-plugins.json",
          repositories: {
            portfolioOs: "/tmp/portfolio-os-runtime",
            paperclip: "/tmp/paperclip-runtime",
            hermesAgent: "/tmp/hermes-runtime",
            hermesPaperclipAdapter: "/tmp/hermes-adapter-runtime",
          },
        },
        tokenomicsWatch: {
          enabled: true,
          intervalSeconds: 300,
          receiptDir: "/tmp/paperclip/provider-tokenomics",
        },
      },
      factoryRuntime: {
        portfolioOsRuntimeRoot: "/tmp/portfolio-os-runtime",
        posAttemptReceiptDir: "/tmp/paperclip/pos-attempts",
      },
    });

    expect(parsed.factory?.baselineRefresh?.repositories.paperclip).toBe("/tmp/paperclip-runtime");
    expect(parsed.factory?.tokenomicsWatch).toMatchObject({
      baselineHours: 96,
      applyBalanceOnDrift: false,
    });
    expect(parsed.factoryRuntime?.portfolioOsRuntimeRoot).toBe("/tmp/portfolio-os-runtime");
  });

  it("rejects factory runtime config without an immutable POS runtime binding", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        ...baseConfig,
        factoryRuntime: {
          posAttemptReceiptDir: "/tmp/paperclip/pos-attempts",
        },
      }),
    ).toThrow(/factoryRuntime requires portfolioOsRuntimeRoot/);
  });

  it.each([24, 360, 24 * 30])(
    "accepts an operator-selected bounded tokenomics baseline of %i hours",
    (baselineHours) => {
      expect(factoryConfigSchema.parse({
        mode: "fixture",
        pauseNewWork: true,
        tokenomicsWatch: {
          enabled: true,
          intervalSeconds: 300,
          baselineHours,
        },
      }).tokenomicsWatch?.baselineHours).toBe(baselineHours);
    },
  );

  it.each([
    { mode: "live", pauseNewWork: false },
    { mode: "production" },
    { mode: "fixture", pauseNewWork: false, unexpected: true },
    { mode: "fixture", pauseNewWork: false, baselinePointerPath: "   " },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 59 } },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 300, baselineHours: 23 } },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 300, baselineHours: 24 * 30 + 1 } },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 300, baselineHours: 360.5 } },
    { mode: "fixture", pauseNewWork: false, tokenomicsWatch: { enabled: true, intervalSeconds: 300, unknown: true } },
    { mode: "fixture", pauseNewWork: false, baselineRefresh: { enabled: true, intervalSeconds: 91 } },
  ])("rejects an invalid or expanded posture: %j", (value) => {
    expect(() => factoryConfigSchema.parse(value)).toThrow();
  });

  it("accepts production live mode only when new work is unpaused", () => {
    const parsed = paperclipConfigSchema.parse({
      ...baseConfig,
      factory: {
        mode: "production",
        pauseNewWork: false,
      },
    });

    expect(() => assertProductionFactoryLiveMode(parsed)).not.toThrow();
  });

  it("rejects fixture factory mode for live deployments", () => {
    const parsed = paperclipConfigSchema.parse({
      ...baseConfig,
      factory: {
        mode: "fixture",
        pauseNewWork: false,
      },
    });

    expect(() => assertProductionFactoryLiveMode(parsed)).toThrow(/factory\.mode must be production/);
  });

  it("rejects paused production mode for live deployments", () => {
    const parsed = paperclipConfigSchema.parse({
      ...baseConfig,
      factory: {
        mode: "production",
        pauseNewWork: true,
      },
    });

    expect(() => assertProductionFactoryLiveMode(parsed)).toThrow(/factory\.pauseNewWork must be false/);
  });
});
