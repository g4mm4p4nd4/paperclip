import { describe, expect, it } from "vitest";
import {
  buildBalancedHermesAgentConfig,
  classifyHermesTokenomicsProfile,
  PONYTAIL_SKILL_KEY,
  receiptFilePath,
} from "../ops/hermes-tokenomics-balance.js";

describe("Hermes tokenomics balance policy", () => {
  it("includes process identity in receipt filenames to avoid same-timestamp collisions", () => {
    const now = new Date("2026-06-17T05:10:49.123Z");
    const first = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 111);
    const second = receiptFilePath("/tmp/paperclip-home", "default", undefined, now, 222);

    expect(first).not.toBe(second);
    expect(first).toContain("20260617T051049123Z-111-hermes-tokenomics-balance.json");
    expect(second).toContain("20260617T051049123Z-222-hermes-tokenomics-balance.json");
  });

  it("keeps implementation agents on enough context while attaching Ponytail", () => {
    const result = buildBalancedHermesAgentConfig({
      role: "engineer",
      name: "Hermes Builder",
      adapterConfig: {
        cwd: "/Users/mnm/Documents/Github/hermes-agent",
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
        tieredExecution: {
          hermes_minimax: {
            provider: "minimax",
            model: "MiniMax-M3",
            contextMaxChars: 8_000,
            outputMaxChars: 1_000,
            outputMaxSentences: 5,
          },
        },
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
        },
      },
    });

    expect(result.profile).toBe("factory_build");
    expect(result.nextAdapterConfig.tieredExecution).toMatchObject({
      adapterOrder: ["hermes_minimax", "gemini_local", "claude_local"],
      hermes_minimax: {
        contextMaxChars: 24_000,
        outputMaxChars: 3_200,
        outputMaxSentences: 12,
        maxTurnsPerRun: 12,
      },
      gemini_local: {
        authMode: "subscription",
        model: "gemini-3-flash-preview",
        contextMaxChars: 24_000,
        outputMaxChars: 3_200,
        outputMaxSentences: 12,
        timeoutSec: 1_800,
      },
      claude_local: {
        authMode: "subscription",
        model: "claude-sonnet-4-6",
        contextMaxChars: 24_000,
        outputMaxChars: 3_200,
        outputMaxSentences: 12,
        timeoutSec: 1_800,
      },
    });
    expect(result.nextAdapterConfig).toMatchObject({
      contextMaxChars: 24_000,
      outputMaxChars: 3_200,
      outputMaxSentences: 12,
      timeoutSec: 1_800,
      tokenomics: {
        balanceVersion: "hermes-tokenomics-balance.v3",
        requestShaping: {
          enabled: true,
          noIssueContextMaxChars: 8_000,
          noIssueMaxTurnsPerRun: 4,
          priorRunValueQuestion: "Does this session's prior runs provide any value to this current run?",
        },
        subscriptionFallbackBudget: {
          contextMaxChars: 24_000,
          outputMaxChars: 3_200,
          outputMaxSentences: 12,
          timeoutSec: 1_800,
        },
      },
    });
    expect(result.nextAdapterConfig.paperclipSkillSync).toMatchObject({
      desiredSkills: [
        "paperclipai/paperclip/paperclip",
        "paperclipai/paperclip/paperclip-product-scope",
        "paperclipai/paperclip/paperclip-frontend-experience",
        "paperclipai/paperclip/paperclip-backend-api-security",
        "paperclipai/paperclip/paperclip-integration-engineer",
        "paperclipai/paperclip/paperclip-create-plugin",
        PONYTAIL_SKILL_KEY,
      ],
    });
    expect(result.nextAdapterConfig.requestShaping).toMatchObject({
      enabled: true,
      noIssueOutputMaxChars: 1_200,
      noIssueOutputMaxSentences: 6,
    });
    expect(result.nextRuntimeConfig.heartbeat).toMatchObject({
      intervalSec: 1_800,
      maxConcurrentRuns: 1,
      idleAssignmentPreflight: true,
      sessionCompaction: {
        maxSessionRuns: 12,
        maxRawInputTokens: 250_000,
        maxSessionAgeHours: 8,
      },
    });
    expect(result.nextRuntimeConfig.factoryLoop).toMatchObject({
      upstreamTruthPlane: "portfolio-os",
      controlPlane: "paperclip-cockpit",
      executionPlane: "hermes-agent via Paperclip adapter",
    });
  });

  it("uses pro-class Gemini for research synthesis instead of shrinking context", () => {
    const result = buildBalancedHermesAgentConfig({
      role: "researcher",
      name: "Research Lead",
      adapterConfig: {
        cwd: "/Users/mnm/Documents/Github/portfolio-os",
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 3_600,
        },
      },
    });

    expect(result.profile).toBe("research_synthesis");
    expect(result.nextAdapterConfig.tieredExecution).toMatchObject({
      hermes_minimax: {
        contextMaxChars: 28_000,
        outputMaxChars: 4_000,
        outputMaxSentences: 14,
        maxTurnsPerRun: 14,
      },
      gemini_local: {
        model: "gemini-3.1-pro-preview",
        contextMaxChars: 28_000,
        outputMaxChars: 4_000,
      },
    });
    expect(result.nextRuntimeConfig.heartbeat).toMatchObject({
      intervalSec: 3_600,
      sessionCompaction: {
        maxSessionRuns: 10,
        maxRawInputTokens: 350_000,
        maxSessionAgeHours: 8,
      },
    });
    expect(result.nextAdapterConfig.paperclipSkillSync).toMatchObject({
      desiredSkills: expect.arrayContaining([
        "paperclipai/paperclip/paperclip-product-scope",
        "paperclipai/paperclip/paperclip-go-to-market",
        "paperclipai/paperclip/para-memory-files",
        PONYTAIL_SKILL_KEY,
      ]),
    });
  });

  it("classifies low-context support work separately from the recursive factory loop", () => {
    expect(classifyHermesTokenomicsProfile({
      role: "support",
      name: "Inbox Helper",
      adapterConfig: { cwd: "/tmp/helpdesk" },
    })).toBe("maintenance_light");

    const result = buildBalancedHermesAgentConfig({
      role: "support",
      name: "Inbox Helper",
      adapterConfig: {},
      runtimeConfig: {},
    });
    expect(result.nextAdapterConfig.tieredExecution).toMatchObject({
      hermes_minimax: {
        contextMaxChars: 12_000,
        outputMaxChars: 1_400,
        maxTurnsPerRun: 8,
      },
      gemini_local: {
        model: "gemini-3.1-flash-lite",
        contextMaxChars: 12_000,
        outputMaxChars: 1_400,
      },
      claude_local: {
        model: "claude-haiku-4-5-20251001",
        maxTurnsPerRun: 12,
        contextMaxChars: 12_000,
        outputMaxChars: 1_400,
      },
    });
    expect(result.nextRuntimeConfig.heartbeat).toMatchObject({
      sessionCompaction: {
        maxSessionRuns: 8,
        maxRawInputTokens: 120_000,
        maxSessionAgeHours: 6,
      },
    });
  });
});
