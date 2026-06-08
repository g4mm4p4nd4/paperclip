import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentContextCursors,
  agents,
  companies,
  contextLedgerComponents,
  contextLedgerEntries,
  createDb,
  heartbeatRuns,
  issues,
  promptBudgetPolicies,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contextLedgerService } from "../services/context-ledger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping context ledger service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("context ledger service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-context-ledger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(contextLedgerComponents);
    await db.delete(contextLedgerEntries);
    await db.delete(agentContextCursors);
    await db.delete(promptBudgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "running",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship context economy",
      identifier: "POR-2507",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });

    return { companyId, agentId, issueId, runId };
  }

  it("records redacted prompt metrics, components, pack refs, artifacts, and final receipts", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);

    await ledger.recordPreSpawn({
      ...ids,
      taskKey: "issue-context-economy",
      adapterType: "hermes_local",
      adapterVersion: "0.1.0",
      branch: "codex/context-economy",
      sessionIdBefore: "session-before",
      meta: {
        adapterType: "hermes_local",
        adapterVersion: "0.1.0",
        command: "hermes",
        cwd: "/repo",
        prompt: "raw prompt must not be persisted",
        promptClass: "failure_recovery",
        promptBudgetVersion: "context-economy.v1",
        runtimeProvenance: {
          paperclipServerVersion: "0.3.1",
          paperclipServerGitSha: "a1c26a81",
          hermesStateSchemaVersion: "7",
          adapterVersion: "0.1.0",
        },
        promptMetrics: {
          totalChars: 800,
          estimatedPromptTokens: 200,
          evidenceSliceCount: 6,
          internetPipes: {
            present: true,
            readiness: "needs_backfill",
            score: 64,
            missingStations: ["differentiation", "recommendation"],
            recommendations: ["Backfill station proof before dispatch"],
            sourcePaths: ["/tmp/portfolio-os/internet-pipes/latest.json"],
          },
          components: [
            {
              name: "evidence",
              sha256: "a".repeat(64),
              chars: 400,
              estimatedTokens: 100,
              truncated: false,
              evidenceSliceCount: 6,
            },
          ],
          artifactHashes: [
            {
              kind: "rawLog",
              path: "/tmp/receipt.json",
              sha256: "b".repeat(64),
            },
          ],
        },
      },
      context: {
        paperclipExecutionRouting: {
          state: "degraded",
          source: "tiered_execution_policy",
          reason: "provider_billing_failure",
          originalAdapterType: "hermes_local",
          selectedAdapterType: "hermes_local",
          selectedLane: "hermes_openrouter",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
        },
        paperclipProviderReliabilityGate: {
          status: "rerouted",
          source: "recent_run_provider_failure",
          sourceRunId: "run-opencode-balance",
          failureKind: "provider_billing",
          reason: "provider_billing_failure",
          selectedLane: "hermes_openrouter",
        },
        paperclipWake: {
          commentCursor: {
            latestCommentId: randomUUID(),
            timestamp: "2026-06-03T10:00:00.000Z",
          },
        },
        contextPackEnvelope: {
          repoSlug: "portfolio-os",
          selectedProfile: "map",
          packSha: "c".repeat(64),
          manifestSha: "d".repeat(64),
          freshnessStatus: "fresh",
        },
      },
    });

    await ledger.finalizeRun({
      runId: ids.runId,
      outcome: "failed",
      blocker: "pytest failed",
      sessionIdAfter: "session-after",
      usage: { inputTokens: 220, cachedInputTokens: 20, outputTokens: 40 },
      resultJson: { receiptPath: "/tmp/receipt.json" },
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.promptClass).toBe("failure_recovery");
    expect(entries[0]?.adapterVersion).toBe("0.1.0");
    expect(entries[0]?.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[0]?.metadata?.adapterInvocation).toMatchObject({
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptChars: "raw prompt must not be persisted".length,
      promptMetrics: {
        internetPipes: {
          readiness: "needs_backfill",
          missingStations: ["differentiation", "recommendation"],
          recommendations: ["Backfill station proof before dispatch"],
          sourcePaths: ["/tmp/portfolio-os/internet-pipes/latest.json"],
        },
      },
    });
    expect((entries[0]?.metadata?.adapterInvocation as Record<string, unknown>).prompt).toBeUndefined();
    expect(entries[0]?.metadata?.executionRouting).toMatchObject({
      state: "degraded",
      reason: "provider_billing_failure",
      selectedLane: "hermes_openrouter",
    });
    expect(entries[0]?.metadata?.providerReliabilityGate).toMatchObject({
      status: "rerouted",
      sourceRunId: "run-opencode-balance",
      failureKind: "provider_billing",
    });
    expect(entries[0]?.metadata?.runtimeProvenance).toMatchObject({
      paperclipServerGitSha: "a1c26a81",
      hermesStateSchemaVersion: "7",
      adapterVersion: "0.1.0",
    });
    expect(entries[0]?.components[0]).toMatchObject({
      name: "evidence",
      contentSha256: "a".repeat(64),
      evidenceSliceCount: 6,
    });
    expect(entries[0]?.artifactRefs?.[0]).toMatchObject({ kind: "rawLog", sha256: "b".repeat(64) });
    expect(entries[0]?.contextPackRefs?.[0]).toMatchObject({
      repoSlug: "portfolio-os",
      selectedProfile: "map",
      freshnessStatus: "fresh",
    });
    expect(entries[0]?.sessionIdAfter).toBe("session-after");
    expect(entries[0]?.receiptPaths).toContain("/tmp/receipt.json");
    expect(entries[0]?.finalBlocker).toContain("pytest failed");

    const issueEntries = await ledger.listForIssue(ids.companyId, ids.issueId);
    expect(issueEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  it("records and blocks before adapter spawn when a prompt budget policy is exceeded", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);
    await db.insert(promptBudgetPolicies).values({
      companyId: ids.companyId,
      scopeType: "company",
      scopeId: ids.companyId,
      maxPromptTokens: 50,
      warnPromptTokens: 40,
      hardStopEnabled: true,
      isActive: true,
    });

    await expect(
      ledger.recordPreSpawn({
        ...ids,
        adapterType: "hermes_local",
        meta: {
          adapterType: "hermes_local",
          command: "hermes",
          cwd: "/repo",
          promptClass: "resume_delta",
          promptBudgetVersion: "context-economy.v1",
          promptMetrics: {
            totalChars: 1_000,
            estimatedPromptTokens: 250,
          },
        },
        context: {},
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Prompt budget exceeded before adapter spawn",
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.budgetStatus).toBe("hard_stop");
    expect(entries[0]?.budgetLimitTokens).toBe(50);
  });

  it("records blocked provider preflight attempts as finalized ledger evidence", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);
    const gate = {
      status: "blocked",
      source: "pre_spawn_provider_preflight",
      reason: "provider_quota_failure",
      failureKind: "provider_quota",
      selectedLane: "hermes_local",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    };

    const entry = await ledger.recordPreSpawn({
      ...ids,
      taskKey: "provider-preflight",
      adapterType: "hermes_local",
      sessionIdBefore: "session-before",
      meta: {
        adapterType: "hermes_local",
        command: "provider_reliability_preflight",
        cwd: "/repo",
        commandArgs: ["opencode-go", "deepseek-v4-flash"],
        commandNotes: ["adapter spawn blocked before model invocation"],
        promptClass: "failure_recovery",
        promptBudgetVersion: "context-economy.v1",
        promptMetrics: {
          totalChars: 1_200,
          estimatedPromptTokens: 300,
          evidenceSliceCount: 2,
          components: [
            {
              name: "provider_reliability_preflight",
              type: "evidence_slice",
              chars: 1_200,
              estimatedTokens: 300,
              evidenceSliceCount: 2,
              provider: "opencode-go",
              model: "deepseek-v4-flash",
              lane: "hermes_local",
              status: "degraded",
              reason: "provider_quota_failure",
              failureKind: "provider_quota",
            },
          ],
        },
        evidenceSliceCount: 2,
      },
      context: {
        paperclipProviderReliabilityGate: gate,
        paperclipExecutionRouting: {
          preflightAttempts: [
            { status: "degraded", reason: "provider_quota_failure", target: { provider: "opencode-go" } },
          ],
        },
      },
    });

    await ledger.finalizeRun({
      runId: ids.runId,
      outcome: "failed",
      blocker: "Provider preflight blocked adapter spawn for opencode-go/deepseek-v4-flash: provider_quota_failure",
      sessionIdAfter: null,
      usage: null,
      resultJson: {
        errorCode: "provider_reliability_preflight_failed",
        finalBlocker: "Provider preflight blocked adapter spawn for opencode-go/deepseek-v4-flash: provider_quota_failure",
      },
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(entry.id);
    expect(entries[0]?.promptClass).toBe("failure_recovery");
    expect(entries[0]?.promptBudgetVersion).toBe("context-economy.v1");
    expect(entries[0]?.budgetStatus).toBe("ok");
    expect(entries[0]?.metadata?.providerReliabilityGate).toMatchObject(gate);
    expect(entries[0]?.components[0]).toMatchObject({
      name: "provider_reliability_preflight",
      componentType: "evidence_slice",
      chars: 1_200,
      estimatedTokens: 300,
      evidenceSliceCount: 2,
    });
    expect(entries[0]?.finalOutcome).toBe("failed");
    expect(entries[0]?.finalBlocker).toContain("provider_quota_failure");
  });

  it("projects codex-local flat prompt metrics, pack refs, receipts, and actual usage warnings into ledger readback", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);

    await ledger.recordPreSpawn({
      ...ids,
      taskKey: "POR-2507",
      adapterType: "codex_local",
      adapterVersion: "0.3.1",
      branch: "main",
      meta: {
        adapterType: "codex_local",
        adapterVersion: "0.3.1",
        command: "codex",
        cwd: "/Users/mnm/Documents/Github/LeadForge",
        promptClass: "bootstrap",
        promptBudgetVersion: "context-economy.v1",
        runtimeProvenance: {
          adapterType: "codex_local",
          adapterVersion: "0.3.1",
          promptBudgetVersion: "context-economy.v1",
        },
        promptMetrics: {
          promptClass: "bootstrap",
          promptBudgetVersion: "context-economy.v1",
          promptChars: 9658,
          totalChars: 9658,
          instructionsChars: 8631,
          wakePromptChars: 938,
          contextEconomyPromptChars: 87,
          heartbeatPromptChars: 0,
          estimatedPromptTokens: 2415,
        },
      },
      context: {
        paperclipContextEconomy: {
          mode: "map_first",
          repoKey: "leadforge",
          contextPacks: {
            manifest: "/packs/latest.json",
          },
          packs: {
            map: "/packs/leadforge-map-latest.md",
            core: "/packs/leadforge-core-latest.md",
          },
          packShas: {
            map: "a".repeat(64),
            core: "b".repeat(64),
          },
        },
      },
    });

    await ledger.finalizeRun({
      runId: ids.runId,
      outcome: "succeeded",
      blocker: "Success text should not become a blocker",
      usage: {
        inputTokens: 1_185_667,
        cachedInputTokens: 1_074_560,
        outputTokens: 10_073,
      },
      resultJson: {
        stdout:
          "{\"type\":\"command_execution\",\"log\":\"raw output mentioned /ops/runs/20260603T193747Z and should not become a receipt path\"}\n" +
          "Previous receipt .tmp/context-economy-canary/POR-2519-receipt.json should remain historical evidence only.\n" +
          "Context pack /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/context-packs/packs/hermes-agent-map-latest.md should not become a receipt.\n" +
          "Verification passed. Receipt written to .tmp/context-economy-canary/POR-2507-receipt.json",
        summary: "Implemented and verified the canary.",
      },
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.adapterType).toBe("codex_local");
    expect(entries[0]?.adapterVersion).toBe("0.3.1");
    expect(entries[0]?.promptBudgetVersion).toBe("context-economy.v1");
    expect(entries[0]?.finalOutcome).toBe("succeeded");
    expect(entries[0]?.finalBlocker).toBeNull();
    expect(entries[0]?.receiptPaths).toContain(".tmp/context-economy-canary/POR-2507-receipt.json");
    expect(entries[0]?.receiptPaths).not.toContain(".tmp/context-economy-canary/POR-2519-receipt.json");
    expect(entries[0]?.receiptPaths?.some((entry) => entry.includes("context-packs/packs"))).toBe(false);
    expect(entries[0]?.receiptPaths?.some((entry) => entry.includes("\n") || entry.length >= 500)).toBe(false);
    expect(entries[0]?.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "receipt",
          path: ".tmp/context-economy-canary/POR-2507-receipt.json",
        }),
      ]),
    );
    const contextPackRefs = entries[0]?.contextPackRefs ?? [];
    expect(contextPackRefs).toHaveLength(1);
    expect(contextPackRefs.some((ref) => ref.selectedProfile === "core")).toBe(false);
    expect(contextPackRefs.some((ref) => !ref.selectedProfile && !ref.packPath && !ref.packSha)).toBe(false);
    expect(contextPackRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repoSlug: "leadforge",
          selectedProfile: "map",
          manifestPath: "/packs/latest.json",
          packPath: "/packs/leadforge-map-latest.md",
          packSha: "a".repeat(64),
        }),
      ]),
    );
    expect(entries[0]?.components.map((component) => component.name)).toEqual(
      expect.arrayContaining([
        "managed_agent_instructions",
        "paperclip_wake",
        "context_pack_manifest",
      ]),
    );
    expect(entries[0]?.componentHashes).toMatchObject({
      managed_agent_instructions: expect.stringMatching(/^[a-f0-9]{64}$/),
      paperclip_wake: expect.stringMatching(/^[a-f0-9]{64}$/),
      context_pack_manifest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(entries[0]?.budgetStatus).toBe("warning");
    expect(entries[0]?.actualInputTokens).toBe(1_185_667);
    expect(entries[0]?.cachedInputTokens).toBe(1_074_560);
    expect(entries[0]?.actualOutputTokens).toBe(10_073);
    expect(entries[0]?.responseClass).toBe("verbose_unjustified");
    expect(entries[0]?.outputBudgetVersion).toBe("output-economy.v1");
    expect(entries[0]?.outputBudgetStatus).toBe("warning");
    expect(entries[0]?.outputBudgetLimitTokens).toBe(700);
    expect(entries[0]?.finalResponseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[0]?.metadata?.actualUsageBudget).toMatchObject({
      uncachedInputTokens: 111_107,
      budgetLimitTokens: 60_000,
      warning: true,
    });
    expect(entries[0]?.metadata?.outputUsageBudget).toMatchObject({
      responseClass: "verbose_unjustified",
      outputBudgetStatus: "warning",
      actualOutputTokens: 10_073,
      outputBudgetLimitTokens: 700,
    });
  });

  it("keeps compact final responses green while recording response hashes and estimates", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);

    await ledger.recordPreSpawn({
      ...ids,
      adapterType: "codex_local",
      meta: {
        adapterType: "codex_local",
        command: "codex",
        cwd: "/repo",
        promptClass: "resume_delta",
        promptBudgetVersion: "context-economy.v1",
        outputBudgetVersion: "output-economy.v1",
        promptMetrics: {
          promptClass: "resume_delta",
          promptBudgetVersion: "context-economy.v1",
          outputBudgetVersion: "output-economy.v1",
          totalChars: 2_000,
          estimatedPromptTokens: 500,
        },
      },
      context: {},
    });

    await ledger.finalizeRun({
      runId: ids.runId,
      outcome: "succeeded",
      usage: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 90 },
      resultJson: {
        summary: "Implemented the ledger fields. Tests: pnpm vitest run context-ledger-service.test.ts. Receipt: .tmp/output-budget/POR-2600-receipt.json",
      },
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.responseClass).toBe("compact_success");
    expect(entries[0]?.outputBudgetStatus).toBe("ok");
    expect(entries[0]?.outputBudgetLimitTokens).toBe(700);
    expect(entries[0]?.estimatedOutputTokens).toBeGreaterThan(0);
    expect(entries[0]?.finalResponseChars).toBeGreaterThan(0);
    expect(entries[0]?.finalResponseSentenceCount).toBeLessThanOrEqual(7);
    expect(entries[0]?.finalResponseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[0]?.receiptPaths).toContain(".tmp/output-budget/POR-2600-receipt.json");
  });

  it("preserves receipt paths already recorded before run finalization", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);
    await ledger.recordPreSpawn({
      companyId: ids.companyId,
      runId: ids.runId,
      agentId: ids.agentId,
      issueId: ids.issueId,
      adapterType: "gemini_local",
      meta: {
        adapterType: "gemini_local",
        command: "gemini",
        cwd: "/repo",
        promptClass: "bootstrap",
        promptBudgetVersion: "context-economy.v1",
        promptMetrics: {
          promptClass: "bootstrap",
          promptBudgetVersion: "context-economy.v1",
          totalChars: 80,
          estimatedPromptTokens: 20,
        },
      },
      context: null,
    });
    await db
      .update(contextLedgerEntries)
      .set({
        receiptPaths: [".tmp/context-economy-canary/POR-2507-receipt.json"],
        artifactRefs: [{ kind: "receipt", path: ".tmp/context-economy-canary/POR-2507-receipt.json" }],
      })
      .where(eq(contextLedgerEntries.runId, ids.runId));

    await ledger.finalizeRun({
      runId: ids.runId,
      outcome: "succeeded",
      resultJson: {
        status: "success",
        stats: {
          input_tokens: 321_240,
          cached: 266_699,
          output_tokens: 3_170,
        },
      },
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries[0]?.receiptPaths).toContain(".tmp/context-economy-canary/POR-2507-receipt.json");
    expect(entries[0]?.actualInputTokens).toBe(321_240);
    expect(entries[0]?.cachedInputTokens).toBe(266_699);
    expect(entries[0]?.actualOutputTokens).toBe(3_170);
    expect(entries[0]?.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        path: ".tmp/context-economy-canary/POR-2507-receipt.json",
      }),
    ]));
  });

  it("enforces production default prompt budget SLOs before adapter spawn", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);

    await expect(
      ledger.recordPreSpawn({
        ...ids,
        adapterType: "hermes_local",
        meta: {
          adapterType: "hermes_local",
          command: "hermes",
          cwd: "/repo",
          promptClass: "resume_delta",
          promptBudgetVersion: "context-economy.v1",
          promptMetrics: {
            totalChars: 110_000,
            estimatedPromptTokens: 26_000,
          },
        },
        context: {},
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Prompt budget exceeded before adapter spawn",
    });

    const entries = await ledger.listForRun(ids.runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.promptClass).toBe("resume_delta");
    expect(entries[0]?.budgetStatus).toBe("hard_stop");
    expect(entries[0]?.budgetLimitTokens).toBe(25_000);
    expect(entries[0]?.metadata?.budgetPolicyId).toBe("context-economy.slo.v1");
  });

  it("keeps comment cursors monotonic while preserving the highest wake count", async () => {
    const ids = await seedRun();
    const ledger = contextLedgerService(db);
    const newerCommentId = randomUUID();
    const olderCommentId = randomUUID();

    await ledger.recordPreSpawn({
      ...ids,
      taskKey: "issue-context-economy",
      adapterType: "hermes_local",
      meta: {
        adapterType: "hermes_local",
        command: "hermes",
        cwd: "/repo",
        promptClass: "comment_delta",
        promptBudgetVersion: "context-economy.v1",
        promptMetrics: { estimatedPromptTokens: 10 },
      },
      context: {
        paperclipWake: {
          commentCursor: { latestCommentId: newerCommentId, timestamp: "2026-06-03T12:00:00.000Z" },
          wakeCount: 4,
        },
      },
    });

    await ledger.recordPreSpawn({
      ...ids,
      taskKey: "issue-context-economy",
      adapterType: "hermes_local",
      meta: {
        adapterType: "hermes_local",
        command: "hermes",
        cwd: "/repo",
        promptClass: "comment_delta",
        promptBudgetVersion: "context-economy.v1",
        promptMetrics: { estimatedPromptTokens: 10 },
      },
      context: {
        paperclipWake: {
          commentCursor: { latestCommentId: olderCommentId, timestamp: "2026-06-03T11:00:00.000Z" },
          wakeCount: 2,
        },
      },
    });

    const cursor = await db
      .select()
      .from(agentContextCursors)
      .where(eq(agentContextCursors.agentId, ids.agentId))
      .then((rows) => rows[0]);

    expect(cursor?.latestCommentId).toBe(newerCommentId);
    expect(cursor?.commentCursor).toMatchObject({ latestCommentId: newerCommentId });
    expect(cursor?.wakeCount).toBe(4);
  });
});
