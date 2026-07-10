import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService.list", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-service-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists skills without exposing markdown content", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heavy-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Heavy Skill\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      description: "Large skill used for list projection regression coverage.",
      markdown: `# Heavy Skill\n\n${"x".repeat(250_000)}`,
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const listed = await svc.list(companyId);
    const skill = listed.find((entry) => entry.id === skillId);

    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty("markdown");
    expect(skill).toMatchObject({
      id: skillId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      sourceType: "local_path",
      sourceLocator: skillDir,
      attachedAgentCount: 0,
      sourceBadge: "local",
      editable: true,
    });
  });

  it("rejects skill inventory refresh for a missing company", async () => {
    await expect(svc.list(randomUUID())).rejects.toMatchObject({
      status: 404,
      message: "Company not found",
    });
  });

  it("projects imported skills from other companies without overwriting local ownership", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceSkillId = randomUUID();
    const sourceSkillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-source-skill-"));
    cleanupDirs.add(sourceSkillDir);
    await fs.writeFile(path.join(sourceSkillDir, "SKILL.md"), "# Portfolio OS Analyst\n", "utf8");

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Portfolio OS Orchestrator",
        issuePrefix: `S${sourceCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Target Company",
        issuePrefix: `T${targetCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(companySkills).values({
      id: sourceSkillId,
      companyId: sourceCompanyId,
      key: "local/portfolio-os/orchestrator-analyst",
      slug: "orchestrator-analyst",
      name: "Portfolio OS Analyst",
      description: "Selects commercialization skills.",
      markdown: "# Portfolio OS Analyst\n",
      sourceType: "local_path",
      sourceLocator: sourceSkillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "project_scan", projectName: "Portfolio OS Orchestrator" },
    });

    const listed = await svc.list(targetCompanyId);
    const shared = listed.find((entry) => entry.key === "local/portfolio-os/orchestrator-analyst");

    expect(shared).toMatchObject({
      companyId: targetCompanyId,
      slug: "orchestrator-analyst",
      name: "Portfolio OS Analyst",
      sourceLocator: sourceSkillDir,
    });

    const [persisted] = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, targetCompanyId), eq(companySkills.key, "local/portfolio-os/orchestrator-analyst")));
    expect(persisted?.metadata).toMatchObject({
      sharedAcrossCompanies: true,
      sharedFromCompanyId: sourceCompanyId,
      sharedFromSkillId: sourceSkillId,
      sourceKind: "project_scan",
    });
  });

  it("does not overwrite a company's own skill when another company has the same key", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceSkillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-source-skill-"));
    const targetSkillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-target-skill-"));
    cleanupDirs.add(sourceSkillDir);
    cleanupDirs.add(targetSkillDir);
    await fs.writeFile(path.join(sourceSkillDir, "SKILL.md"), "# Source Skill\n", "utf8");
    await fs.writeFile(path.join(targetSkillDir, "SKILL.md"), "# Target Skill\n", "utf8");

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Company",
        issuePrefix: `S${sourceCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Target Company",
        issuePrefix: `T${targetCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(companySkills).values([
      {
        companyId: sourceCompanyId,
        key: "company/custom/review",
        slug: "review",
        name: "Source Review",
        description: null,
        markdown: "# Source Skill\n",
        sourceType: "local_path",
        sourceLocator: sourceSkillDir,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "project_scan" },
      },
      {
        companyId: targetCompanyId,
        key: "company/custom/review",
        slug: "review",
        name: "Target Review",
        description: null,
        markdown: "# Target Skill\n",
        sourceType: "local_path",
        sourceLocator: targetSkillDir,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: { sourceKind: "managed_local" },
      },
    ]);

    await svc.list(targetCompanyId);

    const [persisted] = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, targetCompanyId), eq(companySkills.key, "company/custom/review")));
    expect(persisted?.name).toBe("Target Review");
    expect(persisted?.sourceLocator).toBe(targetSkillDir);
    expect(persisted?.metadata).not.toMatchObject({ sharedAcrossCompanies: true });
  });
});
