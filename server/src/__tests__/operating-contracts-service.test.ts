import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyOperatingContracts,
  createDb,
  goals,
  issues,
  projectGoals,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { operatingContractService } from "../services/operating-contracts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping operating contract service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("operating contract service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operating-contracts-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyOperatingContracts);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(Array.from(tempDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createContractSource(companyName: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-contract-source-"));
    tempDirs.add(root);
    await fs.writeFile(
      path.join(root, "COMPANY.md"),
      [
        "---",
        'schema: "agentcompanies/v1"',
        `name: "${companyName}"`,
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    return root;
  }

  function hashPackageFiles(files: Record<string, string>) {
    const hash = createHash("sha256");
    for (const filePath of Object.keys(files).sort((left, right) => left.localeCompare(right))) {
      hash.update(filePath);
      hash.update("\n");
      hash.update(files[filePath] ?? "");
      hash.update("\n---\n");
    }
    return hash.digest("hex");
  }

  it("previews issue-goal drift from a lean open-issue scan", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const goalId = randomUUID();
    const ceoId = randomUUID();
    const openIssueId = randomUUID();
    const routineIssueId = randomUUID();
    const doneIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    const workspaceRoot = await createContractSource("Portfolio OS Orchestrator");

    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio OS Orchestrator",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      slug: "portfolio-health",
      title: "Portfolio Health",
      level: "company",
      status: "active",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Portfolio OS",
      status: "in_progress",
      goalId,
    });
    await db.insert(projectGoals).values({ companyId, projectId, goalId });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Contract Source",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    await db.insert(companyOperatingContracts).values({
      companyId,
      projectWorkspaceId: workspaceId,
      packageRootPath: ".",
    });
    await db.insert(issues).values([
      {
        id: openIssueId,
        companyId,
        projectId,
        title: "Open issue missing goal",
        status: "todo",
        priority: "high",
        assigneeAgentId: ceoId,
        identifier: "POR-1",
      },
      {
        id: routineIssueId,
        companyId,
        projectId,
        title: "Routine issue missing goal",
        status: "todo",
        priority: "high",
        assigneeAgentId: ceoId,
        identifier: "POR-2",
        originKind: "routine_execution",
      },
      {
        id: doneIssueId,
        companyId,
        projectId,
        title: "Done issue missing goal",
        status: "done",
        priority: "high",
        assigneeAgentId: ceoId,
        identifier: "POR-3",
      },
      {
        id: hiddenIssueId,
        companyId,
        projectId,
        title: "Hidden issue missing goal",
        status: "todo",
        priority: "high",
        assigneeAgentId: ceoId,
        identifier: "POR-4",
        hiddenAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);

    const preview = await operatingContractService(db).preview(companyId);

    const issueBackfills = preview.actions.filter((action) => action.group === "issue_goal_backfills");
    expect(issueBackfills).toHaveLength(1);
    expect(issueBackfills[0]).toEqual(expect.objectContaining({
      entityId: openIssueId,
      entitySlug: "POR-1",
      metadata: expect.objectContaining({
        issueId: openIssueId,
        goalSlug: "portfolio-health",
      }),
    }));
    expect(preview.actions.some((action) => action.entityId === routineIssueId)).toBe(false);
    expect(preview.actions.some((action) => action.entityId === doneIssueId)).toBe(false);
    expect(preview.actions.some((action) => action.entityId === hiddenIssueId)).toBe(false);

    await operatingContractService(db).apply(companyId, {
      previewHash: preview.previewHash,
      selectedActionGroups: ["issue_goal_backfills"],
    });
    const persistedIssues = await db
      .select({
        id: issues.id,
        goalId: issues.goalId,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    const goalIdByIssueId = new Map(persistedIssues.map((issue) => [issue.id, issue.goalId]));
    expect(goalIdByIssueId.get(openIssueId)).toBe(goalId);
    expect(goalIdByIssueId.get(routineIssueId)).toBeNull();
    expect(goalIdByIssueId.get(doneIssueId)).toBeNull();
    expect(goalIdByIssueId.get(hiddenIssueId)).toBeNull();
  });

  it("hashes operating-contract sources relative to the configured package root", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const ceoId = randomUUID();
    const workspaceRoot = await createContractSource("Portfolio OS Orchestrator");
    const packageRoot = path.join(workspaceRoot, "paperclip", "operating-contract");

    await fs.mkdir(path.join(packageRoot, "agents", "chief-of-staff"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "COMPANY.md"),
      [
        "---",
        'schema: "agentcompanies/v1"',
        'name: "Portfolio OS Orchestrator"',
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(packageRoot, ".paperclip.yaml"),
      [
        'schema: "paperclip/v1"',
        "agents:",
        "  chief-of-staff:",
        '    role: "pm"',
        '    capabilities: "Own operating-contract drift and remediation follow-through."',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(packageRoot, "agents", "chief-of-staff", "AGENTS.md"),
      "# Chief of Staff\n",
      "utf8",
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio OS Orchestrator",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Portfolio OS",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Contract Source",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    await db.insert(companyOperatingContracts).values({
      companyId,
      projectWorkspaceId: workspaceId,
      packageRootPath: "paperclip/operating-contract",
    });

    const preview = await operatingContractService(db).preview(companyId);
    const expectedFiles = {
      ".paperclip.yaml": await fs.readFile(path.join(packageRoot, ".paperclip.yaml"), "utf8"),
      "COMPANY.md": await fs.readFile(path.join(packageRoot, "COMPANY.md"), "utf8"),
      "agents/chief-of-staff/AGENTS.md": await fs.readFile(path.join(packageRoot, "agents", "chief-of-staff", "AGENTS.md"), "utf8"),
    };
    const repoRelativeFiles = {
      "paperclip/operating-contract/.paperclip.yaml": expectedFiles[".paperclip.yaml"],
      "paperclip/operating-contract/COMPANY.md": expectedFiles["COMPANY.md"],
      "paperclip/operating-contract/agents/chief-of-staff/AGENTS.md": expectedFiles["agents/chief-of-staff/AGENTS.md"],
    };

    expect(preview.source.packageRootPath).toBe("paperclip/operating-contract");
    expect(preview.sourceHash).toBe(hashPackageFiles(expectedFiles));
    expect(preview.sourceHash).not.toBe(hashPackageFiles(repoRelativeFiles));
  });

  it("exempts paused direct reports from stale heartbeat warnings", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const ceoId = randomUUID();
    const activeReportId = randomUUID();
    const pausedReportId = randomUUID();
    const workspaceRoot = await createContractSource("Portfolio OS Orchestrator");

    await db.insert(companies).values({
      id: companyId,
      name: "Portfolio OS Orchestrator",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: new Date("2026-06-04T09:00:00Z"),
      },
      {
        id: activeReportId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "active",
        reportsTo: ceoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: null,
      },
      {
        id: pausedReportId,
        companyId,
        name: "CMO",
        role: "cmo",
        status: "paused",
        reportsTo: ceoId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: null,
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Portfolio OS",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Contract Source",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    await db.insert(companyOperatingContracts).values({
      companyId,
      projectWorkspaceId: workspaceId,
      packageRootPath: ".",
    });

    const preview = await operatingContractService(db).preview(companyId);

    const staleWarnings = preview.warnings.filter((warning) => warning.kind === "stale_direct_report");
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0]).toEqual(expect.objectContaining({
      entityId: activeReportId,
      entitySlug: "cto",
    }));
    expect(staleWarnings.some((warning) => warning.entityId === pausedReportId)).toBe(false);
  });
});
