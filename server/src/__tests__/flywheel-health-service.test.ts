import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  contextLedgerEntries,
  createDb,
  flywheelHealthReports,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { flywheelHealthService } from "../services/flywheel-health.js";
import { contextEconomyLiveCanaryService } from "../services/context-economy-live-canary.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping flywheel health service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("flywheel health service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flywheel-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(flywheelHealthReports);
    await db.delete(contextLedgerEntries);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("summarizes attempts, completions, provider failures, ledger coverage, receipts, and tests", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runFailed = randomUUID();
    const runSucceeded = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-06-03T18:00:00.000Z");
    const manifestDir = await mkdtemp(path.join(tmpdir(), "paperclip-context-pack-matrix-"));
    tempDirs.push(manifestDir);
    const manifestPath = path.join(manifestDir, "latest.json");
    await writeFile(manifestPath, JSON.stringify({
      generatedAt: "2999-01-01T00:00:00.000Z",
      policy: { staleAfterHours: 24 },
      repos: {
        paperclip: {
          repoState: { cwd: manifestDir, head: "" },
          profiles: {
            map: {
              status: "ok",
              latestPath: path.join(manifestDir, "paperclip-map-latest.md"),
              sha256: "p".repeat(64),
              estimatedTokens: 321,
              finishedAt: "2999-01-01T00:00:00.000Z",
            },
          },
        },
      },
    }), "utf8");
    const previousManifestPath = process.env.PAPERCLIP_CONTEXT_PACK_MANIFEST_PATH;
    process.env.PAPERCLIP_CONTEXT_PACK_MANIFEST_PATH = manifestPath;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
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
      title: "Canary",
      identifier: "PAP-901",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: new Date("2026-06-03T17:45:00.000Z"),
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runFailed,
        companyId,
        agentId,
        invocationSource: "timer",
        status: "failed",
        createdAt: new Date("2026-06-03T17:10:00.000Z"),
        errorCode: "adapter_failed",
        stderrExcerpt: "AuthenticationError [HTTP 401]\nHTTP 401: Insufficient balance",
      },
      {
        id: runSucceeded,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date("2026-06-03T17:30:00.000Z"),
        resultJson: {
          summary: "completed",
          testsPassed: 12,
          testsFailed: 0,
          changedFiles: ["server/src/services/flywheel-health.ts"],
        },
      },
    ]);
    await db.insert(contextLedgerEntries).values([
      {
        companyId,
        runId: runFailed,
        agentId,
        issueId,
        adapterType: "hermes_local",
        promptClass: "resume_delta",
        promptBudgetVersion: "context-economy.v1",
        promptFingerprint: "a".repeat(64),
        promptChars: 60_000,
        estimatedPromptTokens: 15_000,
        componentHashes: { evidence: "b".repeat(64) },
        artifactRefs: [{ kind: "rawLog", sha256: "c".repeat(64) }],
        receiptPaths: [
          "/tmp/failed-receipt.json",
          "{\"type\":\"item.completed\",\"text\":\"raw log should not count as a receipt\"}\n",
        ],
        metadata: {
          providerReliabilityGate: {
            status: "rerouted",
            failureKind: "provider_billing",
            reason: "provider_billing_failure",
          },
        },
      },
      {
        companyId,
        runId: runSucceeded,
        agentId,
        issueId,
        adapterType: "hermes_local",
        promptClass: "resume_delta",
        promptBudgetVersion: "context-economy.v1",
        promptFingerprint: "d".repeat(64),
        promptChars: 40_000,
        estimatedPromptTokens: 10_000,
        componentHashes: { evidence: "e".repeat(64) },
        cachedInputTokens: 2_000,
        responseClass: "verbose_unjustified",
        actualOutputTokens: 2_200,
        estimatedOutputTokens: 2_100,
        outputBudgetStatus: "warning",
        outputBudgetLimitTokens: 700,
        finalResponseChars: 8_400,
        finalResponseSha256: "7".repeat(64),
        contextPackRefs: [{
          repoSlug: "paperclip",
          profile: "map",
          path: "/packs/paperclip-map-latest.md",
          sha256: "f".repeat(64),
          manifestPath: "/packs/latest.json",
          freshnessStatus: "fresh",
        }],
        receiptPaths: ["/tmp/succeeded-receipt.json"],
        metadata: {
          providerReliabilityGate: {
            status: "rerouted",
            failureKind: "provider_auth",
            reason: "provider_auth_failure",
            selectedAdapterType: "gemini_local",
            selectedLane: "free_local",
          },
        },
      },
    ]);

    let report: Awaited<ReturnType<ReturnType<typeof flywheelHealthService>["summarize"]>>;
    try {
      report = await flywheelHealthService(db).summarize(companyId, { now, windowHours: 1 });
    } finally {
      if (previousManifestPath === undefined) delete process.env.PAPERCLIP_CONTEXT_PACK_MANIFEST_PATH;
      else process.env.PAPERCLIP_CONTEXT_PACK_MANIFEST_PATH = previousManifestPath;
    }

    expect(report.tasksAttempted).toBe(2);
    expect(report.tasksCompleted).toBe(1);
    expect(report.issuesCompleted).toBe(1);
    expect(report.providerFailures).toMatchObject({
      count: 1,
      recent: [{ runId: runFailed, kind: "provider_billing" }],
    });
    expect(report.canaryReadiness.examples[0]?.contextPackRefs).toEqual([
      expect.objectContaining({
        repoSlug: "paperclip",
        selectedProfile: "map",
        packPath: "/packs/paperclip-map-latest.md",
        packSha: "f".repeat(64),
      }),
    ]);
    expect(report.promptTokensByClass[0]).toMatchObject({
      promptClass: "resume_delta",
      count: 2,
      meanEstimatedTokens: 12_500,
      p95EstimatedTokens: 15_000,
    });
    expect(report.outputTokensByResponseClass).toEqual([
      expect.objectContaining({
        responseClass: "compact_status",
        count: 1,
        meanOutputTokens: 0,
      }),
      expect.objectContaining({
        responseClass: "verbose_unjustified",
        count: 1,
        meanOutputTokens: 2_200,
        p95OutputTokens: 2_200,
      }),
    ]);
    expect(report.cachedInputTokens).toBe(2_000);
    expect(report.totalOutputTokens).toBe(2_200);
    expect(report.outputBudgetViolations).toMatchObject({
      count: 1,
      examples: [
        {
          runId: runSucceeded,
          responseClass: "verbose_unjustified",
          outputBudgetStatus: "warning",
          actualOutputTokens: 2_200,
          outputBudgetLimitTokens: 700,
          finalResponseSha256: "7".repeat(64),
        },
      ],
    });
    expect(report.artifactCoverage.percent).toBe(100);
    expect(report.ledgerCompleteness.percent).toBe(100);
    expect(report.receipts.paths).toEqual(["/tmp/failed-receipt.json", "/tmp/succeeded-receipt.json"]);
    expect(report.canaryReadiness).toMatchObject({
      contextPackMatrix: [
        expect.objectContaining({ repoSlug: "paperclip", ok: true, reasons: [] }),
        expect.objectContaining({ repoSlug: "hermes-agent", ok: false, reasons: ["context_pack_envelope"] }),
        expect.objectContaining({ repoSlug: "portfolio-os", ok: false, reasons: ["context_pack_envelope"] }),
        expect.objectContaining({ repoSlug: "gstack", ok: false, reasons: ["context_pack_envelope"] }),
      ],
      targetCompletionMatrix: [
        expect.objectContaining({ repoSlug: "paperclip", ok: true, readyCount: 1, reasons: [] }),
        expect.objectContaining({ repoSlug: "hermes-agent", ok: false, readyCount: 0, reasons: ["live_canary_receipt"] }),
        expect.objectContaining({ repoSlug: "portfolio-os", ok: false, readyCount: 0, reasons: ["live_canary_receipt"] }),
        expect.objectContaining({ repoSlug: "gstack", ok: false, readyCount: 0, reasons: ["live_canary_receipt"] }),
      ],
      issueLinkedSucceededRuns: 1,
      completedIssuesWithLedger: 1,
      completedIssueRunsWithReceipts: 1,
      completedIssueRunsWithTests: 1,
      completedIssueRunsWithChangedFiles: 1,
      completedIssueRunsWithContextPacks: 1,
      providerReroutedSuccesses: 1,
      outputSloViolations: 1,
      readyCount: 1,
    });
    expect(report.canaryReadiness.examples[0]).toMatchObject({
      runId: runSucceeded,
      issueIdentifier: "PAP-901",
      changedFiles: ["server/src/services/flywheel-health.ts"],
      receiptPaths: ["/tmp/succeeded-receipt.json"],
      providerGate: {
        status: "rerouted",
        selectedAdapterType: "gemini_local",
      },
    });
    expect(report.canaryReadiness.missing).toEqual([]);
    expect(report.tests).toEqual({ passed: 12, failed: 0 });
  });

  it("creates missing repo canary issues and provisions the target workspace", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const existingWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Strike Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Context Economy Proof",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: existingWorkspaceId,
      companyId,
      projectId,
      name: "paperclip",
      sourceType: "local_path",
      cwd: "/Users/mnm/Documents/Github/paperclip",
      isPrimary: false,
    });

    const result = await contextEconomyLiveCanaryService(db).ensure(
      companyId,
      {
        packMatrix: [
          { repoSlug: "paperclip", ok: true, proof: null, reasons: [] },
          { repoSlug: "hermes-agent", ok: true, proof: null, reasons: [] },
        ],
        targetCompletionMatrix: [
          {
            repoSlug: "paperclip",
            ok: true,
            readyCount: 1,
            issueIdentifiers: ["POR-2516"],
            runIds: ["run-1"],
            reasons: [],
          },
          {
            repoSlug: "hermes-agent",
            ok: false,
            readyCount: 0,
            issueIdentifiers: [],
            runIds: [],
            reasons: ["live_canary_receipt"],
          },
        ],
      },
      {
        repoSlugs: ["paperclip", "hermes-agent"],
        createMissingWorkspaces: true,
        requestedAt: new Date("2026-06-04T01:00:00.000Z"),
      },
    );

    expect(result.plans).toEqual([
      expect.objectContaining({
        repoSlug: "paperclip",
        action: "skip_proven",
        issueIdentifier: "POR-2516",
      }),
      expect.objectContaining({
        repoSlug: "hermes-agent",
        action: "create_issue",
        assigneeAgentId: agentId,
      }),
    ]);
    expect(result.createdIssues).toHaveLength(1);
    expect(result.createdIssues[0]).toMatchObject({
      repoSlug: "hermes-agent",
      assigneeAgentId: agentId,
    });

    const createdWorkspace = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.cwd, "/Users/mnm/Documents/Github/hermes-agent"))
      .then((rows) => rows[0]);
    expect(createdWorkspace).toMatchObject({
      companyId,
      projectId,
      name: "hermes-agent",
      isPrimary: false,
    });

    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, result.createdIssues[0]!.issueId))
      .then((rows) => rows[0]);
    expect(createdIssue).toMatchObject({
      companyId,
      projectId,
      projectWorkspaceId: createdWorkspace.id,
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      billingCode: "context-economy-canary",
    });
    expect(createdIssue.assigneeAdapterOverrides).toMatchObject({
      useProjectWorkspace: true,
      contextEconomyCanary: {
        repoSlug: "hermes-agent",
        cwd: "/Users/mnm/Documents/Github/hermes-agent",
        packProfile: "map",
      },
    });
    expect(createdIssue.description ?? "").toContain("Context-economy live canary for repo: hermes-agent");
    expect(createdIssue.description ?? "").toContain(
      `.tmp/context-economy-canary/${createdIssue.identifier}-receipt.json`,
    );
    expect(createdIssue.description ?? "").toContain(`"issueId": "${createdIssue.id}"`);
  });

  it("does not route a repo canary through a name-matched workspace with the wrong cwd", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const wrongWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio Venture Factory",
      issuePrefix: "POR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Context Economy Proof",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: wrongWorkspaceId,
      companyId,
      projectId,
      name: "paperclip",
      sourceType: "local_path",
      cwd: "/Users/mnm/Documents/Github/LeadForge",
      isPrimary: false,
    });
    await db.insert(issues).values({
      companyId,
      projectId,
      projectWorkspaceId: wrongWorkspaceId,
      title: "Context economy live canary: paperclip evidence replay proof 2026-06-04T01:00:00.000Z",
      description: "Context-economy live canary for repo: paperclip\nTarget cwd: /Users/mnm/Documents/Github/paperclip",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      billingCode: "context-economy-canary",
      identifier: `POR-${companyId.replace(/-/g, "").slice(0, 6)}`,
    });

    const result = await contextEconomyLiveCanaryService(db).ensure(
      companyId,
      {
        packMatrix: [{ repoSlug: "paperclip", ok: true, proof: null, reasons: [] }],
        targetCompletionMatrix: [],
      },
      {
        repoSlugs: ["paperclip"],
        force: true,
        createMissingWorkspaces: true,
        requestedAt: new Date("2026-06-04T02:00:00.000Z"),
      },
    );

    expect(result.createdIssues).toHaveLength(1);
    expect(result.createdIssues[0]).toMatchObject({
      repoSlug: "paperclip",
      assigneeAgentId: agentId,
    });
    expect(result.createdIssues[0]?.projectWorkspaceId).not.toBe(wrongWorkspaceId);

    const createdWorkspace = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, result.createdIssues[0]!.projectWorkspaceId!))
      .then((rows) => rows[0]);
    expect(createdWorkspace).toMatchObject({
      companyId,
      projectId,
      name: "paperclip",
      cwd: "/Users/mnm/Documents/Github/paperclip",
    });
  });

  it("uses bounded receipt JSON proof without treating raw transcript text as a receipt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runSucceeded = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-06-03T18:00:00.000Z");
    const receiptDir = await mkdtemp(path.join(tmpdir(), "paperclip-flywheel-receipt-"));
    tempDirs.push(receiptDir);
    const receiptPath = path.join(receiptDir, "POR-903-receipt.json");
    await writeFile(receiptPath, JSON.stringify({
      testsRun: [{ command: "pnpm test client/src/lib/flywheel-canary.test.ts", exitCode: 0 }],
      filesChanged: ["client/src/lib/flywheel-canary.ts", "client/src/lib/flywheel-canary.test.ts"],
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Receipt-backed canary",
      identifier: "PAP-903",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: new Date("2026-06-03T17:45:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runSucceeded,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
      resultJson: {
        stdout: `raw transcript line\nReceipt written to ${receiptPath}\n`,
      },
    });
    await db.insert(contextLedgerEntries).values({
      companyId,
      runId: runSucceeded,
      agentId,
      issueId,
      adapterType: "codex_local",
      promptClass: "bootstrap",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "6".repeat(64),
      promptChars: 1_200,
      estimatedPromptTokens: 300,
      componentHashes: { evidence: "5".repeat(64) },
      contextPackRefs: [{
        repoSlug: "leadforge",
        selectedProfile: "map",
        packPath: "/packs/leadforge-map-latest.md",
        packSha: "4".repeat(64),
        manifestPath: "/packs/latest.json",
      }],
      receiptPaths: [`raw transcript line\nReceipt written to ${receiptPath}\n`],
    });

    const report = await flywheelHealthService(db).summarize(companyId, { now, windowHours: 1 });

    expect(report.receipts.paths).toEqual([receiptPath]);
    expect(report.canaryReadiness.readyCount).toBe(1);
    expect(report.canaryReadiness.examples[0]).toMatchObject({
      issueIdentifier: "PAP-903",
      issueStatus: "done",
      receiptPaths: [receiptPath],
      testsPassed: 1,
      testsFailed: 0,
      changedFiles: [
        "client/src/lib/flywheel-canary.test.ts",
        "client/src/lib/flywheel-canary.ts",
      ],
    });
    expect(report.canaryReadiness.missing).toEqual([]);
  });

  it("blocks canary readiness when Internet Pipes stations are still missing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runSucceeded = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-06-03T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Portfolio OS Engineer",
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
      title: "Internet Pipes gated canary",
      identifier: "PAP-905",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: new Date("2026-06-03T17:45:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runSucceeded,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
      resultJson: {
        testsPassed: 3,
        testsFailed: 0,
        changedFiles: ["server/src/services/portfolio-dispatch.ts"],
      },
    });
    await db.insert(contextLedgerEntries).values({
      companyId,
      runId: runSucceeded,
      agentId,
      issueId,
      adapterType: "hermes_local",
      promptClass: "resume_delta",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "2".repeat(64),
      promptChars: 1_200,
      estimatedPromptTokens: 300,
      componentHashes: { evidence: "3".repeat(64) },
      contextPackRefs: [{
        repoSlug: "portfolio-os",
        selectedProfile: "map",
        packPath: "/packs/portfolio-os-map-latest.md",
        packSha: "4".repeat(64),
        manifestPath: "/packs/latest.json",
      }],
      receiptPaths: ["/tmp/PAP-905-receipt.json"],
      metadata: {
        adapterInvocation: {
          promptMetrics: {
            internetPipes: {
              present: true,
              readiness: "needs_backfill",
              score: 64,
              missingStations: ["differentiation", "recommendation"],
              recommendations: ["Backfill differentiation proof before dispatch"],
              sourcePaths: ["/tmp/portfolio-os/internet-pipes/latest.json"],
            },
          },
        },
      },
    });

    const report = await flywheelHealthService(db).summarize(companyId, { now, windowHours: 1 });

    expect(report.canaryReadiness.readyCount).toBe(0);
    expect(report.canaryReadiness.internetPipesGatedRuns).toBe(1);
    expect(report.canaryReadiness.internetPipesBlockedRuns).toBe(1);
    expect(report.canaryReadiness.missing).toEqual([
      {
        runId: runSucceeded,
        issueId,
        issueIdentifier: "PAP-905",
        issueStatus: "done",
        missing: ["internet_pipes_readiness", "internet_pipes_station_gaps"],
        internetPipes: [
          expect.objectContaining({
            readiness: "needs_backfill",
            missingStations: ["differentiation", "recommendation"],
            recommendations: ["Backfill differentiation proof before dispatch"],
            sourcePaths: ["/tmp/portfolio-os/internet-pipes/latest.json"],
          }),
        ],
      },
    ]);
  });

  it("reports missing proof when a succeeded issue run lacks canary evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runSucceeded = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-06-03T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Incomplete canary",
      identifier: "PAP-902",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: new Date("2026-06-03T17:45:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runSucceeded,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
      resultJson: {
        summary: "declared complete without verifiable work evidence",
      },
    });
    await db.insert(contextLedgerEntries).values({
      companyId,
      runId: runSucceeded,
      agentId,
      issueId,
      adapterType: "codex_local",
      promptClass: "resume_delta",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "9".repeat(64),
      promptChars: 1_200,
      estimatedPromptTokens: 300,
      componentHashes: { evidence: "8".repeat(64) },
    });

    const report = await flywheelHealthService(db).summarize(companyId, { now, windowHours: 1 });

    expect(report.canaryReadiness).toMatchObject({
      issueLinkedSucceededRuns: 1,
      completedIssuesWithLedger: 1,
      completedIssueRunsWithReceipts: 0,
      completedIssueRunsWithTests: 0,
      completedIssueRunsWithChangedFiles: 0,
      completedIssueRunsWithContextPacks: 0,
      readyCount: 0,
    });
    expect(report.canaryReadiness.missing).toEqual([
      {
        runId: runSucceeded,
        issueId,
        issueIdentifier: "PAP-902",
        issueStatus: "done",
        missing: ["receipt_path", "passing_tests", "changed_files", "context_pack_ref"],
      },
    ]);
  });

  it("treats ledger provider blockers as fatal even when a run row was marked succeeded", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runSucceeded = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-06-03T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
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
      title: "False success provider blocker",
      identifier: "PAP-904",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: new Date("2026-06-03T17:45:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runSucceeded,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
      resultJson: {
        testsPassed: 1,
        testsFailed: 0,
        changedFiles: ["client/src/lib/flywheel-canary.ts"],
      },
    });
    await db.insert(contextLedgerEntries).values({
      companyId,
      runId: runSucceeded,
      agentId,
      issueId,
      adapterType: "hermes_local",
      promptClass: "failure_recovery",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "7".repeat(64),
      promptChars: 1_200,
      estimatedPromptTokens: 300,
      componentHashes: { evidence: "6".repeat(64) },
      contextPackRefs: [{
        repoSlug: "leadforge",
        selectedProfile: "map",
        packPath: "/packs/leadforge-map-latest.md",
        packSha: "5".repeat(64),
        manifestPath: "/packs/latest.json",
      }],
      receiptPaths: ["/tmp/PAP-904-receipt.json"],
      finalOutcome: "failed",
      finalBlocker: "AuthenticationError [HTTP 401]: Insufficient balance",
    });

    const report = await flywheelHealthService(db).summarize(companyId, { now, windowHours: 1 });

    expect(report.providerFailures).toMatchObject({
      count: 1,
      recent: [expect.objectContaining({ runId: runSucceeded, kind: "provider_billing" })],
    });
    expect(report.canaryReadiness.readyCount).toBe(0);
    expect(report.canaryReadiness.missing).toEqual([
      {
        runId: runSucceeded,
        issueId,
        issueIdentifier: "PAP-904",
        issueStatus: "done",
        missing: ["provider_failure"],
      },
    ]);
  });

  it("persists one idempotent hourly report per active company and window", async () => {
    const companyId = randomUUID();
    const inactiveCompanyId = randomUUID();
    const agentId = randomUUID();
    const runSucceeded = randomUUID();
    const now = new Date("2026-06-03T18:37:00.000Z");

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: inactiveCompanyId,
        name: "Paused",
        status: "paused",
        issuePrefix: `H${inactiveCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runSucceeded,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
      resultJson: { testsPassed: 3, testsFailed: 0 },
    });
    await db.insert(contextLedgerEntries).values({
      companyId,
      runId: runSucceeded,
      agentId,
      adapterType: "hermes_local",
      promptClass: "resume_delta",
      promptBudgetVersion: "context-economy.v1",
      promptFingerprint: "f".repeat(64),
      promptChars: 20_000,
      estimatedPromptTokens: 5_000,
      componentHashes: { evidence: "7".repeat(64) },
      receiptPaths: ["/tmp/hourly-receipt.json"],
      createdAt: new Date("2026-06-03T17:30:00.000Z"),
    });

    const svc = flywheelHealthService(db);
    const first = await svc.persistHourlyReports({ now, source: "manual" });
    const second = await svc.persistHourlyReports({ now, source: "scheduler" });
    const reports = await svc.listReports(companyId, { limit: 5 });

    expect(first).toMatchObject({
      source: "manual",
      windowStart: "2026-06-03T17:00:00.000Z",
      windowEnd: "2026-06-03T18:00:00.000Z",
      companies: 1,
      reportsWritten: 1,
    });
    expect(second.reportsWritten).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      companyId,
      source: "scheduler",
      tasksAttempted: 1,
      tasksCompleted: 1,
      receiptsProduced: 1,
      testsPassed: 3,
      testsFailed: 0,
      ledgerCompletenessPercent: 100,
      artifactCoveragePercent: 100,
    });
    expect((reports[0]?.reportJson as Record<string, unknown>).receipts).toMatchObject({
      paths: ["/tmp/hourly-receipt.json"],
    });
  });
});
