import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyOperatingContracts,
  projectWorkspaces,
  projects as projectsTable,
} from "@paperclipai/db";
import type {
  CompanyPortabilityManifest,
  OperatingContractAction,
  OperatingContractActionGroup,
  OperatingContractApplyRequest,
  OperatingContractApplyResult,
  OperatingContractConfig,
  OperatingContractDashboardSummary,
  OperatingContractFindingCounts,
  OperatingContractOrgPolicy,
  OperatingContractPreviewResult,
  OperatingContractRemediationOwner,
  OperatingContractResolvedContract,
  OperatingContractReviewSummary,
  OperatingContractWorkspaceRef,
  UpdateOperatingContractConfigRequest,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { buildManifestFromPackageFiles } from "./company-portability.js";
import { companyService } from "./companies.js";
import { goalService } from "./goals.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

type ContractRow = typeof companyOperatingContracts.$inferSelect;

type JoinedConfigRow = {
  contract: ContractRow;
  workspaceId: string | null;
  workspaceProjectId: string | null;
  workspaceName: string | null;
  workspaceCwd: string | null;
  workspaceRepoUrl: string | null;
  workspaceIsPrimary: boolean | null;
  projectName: string | null;
};

type ResolvedContractSource = {
  configRow: ContractRow | null;
  workspace: OperatingContractWorkspaceRef | null;
  packageRootPath: string;
  companyPath: string | null;
  paperclipExtensionPath: string | null;
  sourceHash: string | null;
  manifest: CompanyPortabilityManifest | null;
};

type OperatingContractPreviewBuild = {
  source: ResolvedContractSource;
  config: OperatingContractConfig;
  preview: OperatingContractPreviewResult;
};

const REVIEW_PREVIEW_PATH = "/company/operating-contract";
const DEFAULT_PACKAGE_ROOT_PATH = ".";
const DEFAULT_DIRECT_REPORT_THRESHOLD = 8;
const DEFAULT_STALE_HEARTBEAT_HOURS = 72;
const DEFAULT_OPEN_WORK_STALE_DAYS = 7;
const MAX_PACKAGE_FILES = 2000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

type LiveAgentForOperatingContract = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  reportsTo: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
};

type OperatingContractLeadershipContext = {
  ceoSlug: string | null;
  liveCeo: LiveAgentForOperatingContract | null;
  directReports: LiveAgentForOperatingContract[];
  contractChiefOfStaff: CompanyPortabilityManifest["agents"][number] | null;
  liveChiefOfStaff: LiveAgentForOperatingContract | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePackageRootPath(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_PACKAGE_ROOT_PATH;
}

function isWithinBasePath(basePath: string, candidatePath: string) {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldCollectPackageFile(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  return (
    basename === "COMPANY.md"
    || basename === "AGENTS.md"
    || basename === "PROJECT.md"
    || basename === "TASK.md"
    || basename === "SKILL.md"
    || basename === ".paperclip.yaml"
    || basename === ".paperclip.yml"
  );
}

async function collectPackageFiles(rootDir: string) {
  const files = new Map<string, string>();
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!shouldCollectPackageFile(relativePath)) continue;
      files.set(relativePath, await fs.readFile(absolutePath, "utf8"));
      if (files.size > MAX_PACKAGE_FILES) {
        throw unprocessable("Operating contract package is too large to preview safely");
      }
    }
  }

  return Object.fromEntries(files.entries());
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

function parseStoredReviewSummary(value: unknown): OperatingContractReviewSummary | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.counts)) return null;
  return {
    status: value.status === "healthy" ? "healthy" : "warning",
    previewHash: typeof value.previewHash === "string" ? value.previewHash : "",
    counts: {
      companyMetadata: Number(value.counts.companyMetadata ?? 0),
      goals: Number(value.counts.goals ?? 0),
      projectGoalLinks: Number(value.counts.projectGoalLinks ?? 0),
      issueGoalBackfills: Number(value.counts.issueGoalBackfills ?? 0),
      agents: Number(value.counts.agents ?? 0),
      staffingRecommendations: Number(value.counts.staffingRecommendations ?? 0),
      warnings: Number(value.counts.warnings ?? 0),
      total: Number(value.counts.total ?? 0),
    },
  };
}

function emptyFindingCounts(): OperatingContractFindingCounts {
  return {
    companyMetadata: 0,
    goals: 0,
    projectGoalLinks: 0,
    issueGoalBackfills: 0,
    agents: 0,
    staffingRecommendations: 0,
    warnings: 0,
    total: 0,
  };
}

function buildPreviewHash(companyId: string, sourceHash: string, actions: OperatingContractAction[], counts: OperatingContractFindingCounts) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId,
        sourceHash,
        counts,
        actions: actions.map((action) => ({
          id: action.id,
          group: action.group,
          kind: action.kind,
          entityId: action.entityId,
          entitySlug: action.entitySlug,
          metadata: action.metadata,
        })),
      }),
    )
    .digest("hex");
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isOpenIssueStatus(status: string) {
  return status !== "done" && status !== "cancelled";
}

function isActiveProjectStatus(status: string) {
  return status !== "completed" && status !== "cancelled";
}

function resolveOrgPolicy(manifest: CompanyPortabilityManifest): OperatingContractOrgPolicy {
  const contractCeoSlug = manifest.agents.find((agent) => agent.role === "ceo")?.slug ?? null;
  const chiefOfStaff = manifest.operatingContract?.orgPolicy?.chiefOfStaff ?? null;
  return {
    chiefOfStaff: {
      enabled: chiefOfStaff?.enabled ?? true,
      ceoSlug: chiefOfStaff?.ceoSlug ?? contractCeoSlug,
      directReportThreshold: chiefOfStaff?.directReportThreshold ?? DEFAULT_DIRECT_REPORT_THRESHOLD,
      role: "pm",
      title: "Chief of Staff",
    },
    staleHeartbeatThresholdHours:
      manifest.operatingContract?.orgPolicy?.staleHeartbeatThresholdHours ?? DEFAULT_STALE_HEARTBEAT_HOURS,
    openWorkStaleDays:
      manifest.operatingContract?.orgPolicy?.openWorkStaleDays ?? DEFAULT_OPEN_WORK_STALE_DAYS,
  };
}

function buildResolvedContract(manifest: CompanyPortabilityManifest): OperatingContractResolvedContract {
  return {
    companyName: manifest.company?.name ?? "Operating Contract",
    companyDescription: manifest.company?.description ?? null,
    companySlug: manifest.company?.slug ?? null,
    goals: manifest.goals,
    orgPolicy: resolveOrgPolicy(manifest),
  };
}

function workspaceRefFromRow(row: JoinedConfigRow | null): OperatingContractWorkspaceRef | null {
  if (!row?.workspaceId || !row.workspaceProjectId || !row.workspaceName || !row.projectName) return null;
  return {
    id: row.workspaceId,
    projectId: row.workspaceProjectId,
    projectName: row.projectName,
    workspaceName: row.workspaceName,
    cwd: row.workspaceCwd ?? null,
    repoUrl: row.workspaceRepoUrl ?? null,
    isPrimary: row.workspaceIsPrimary ?? false,
  };
}

function defaultRemediationOwner(): OperatingContractRemediationOwner {
  return {
    role: "pm",
    title: "Chief of Staff",
    soleOwner: true,
    status: "missing",
    agentId: null,
    agentSlug: null,
    agentName: null,
  };
}

function resolveLeadershipContext(
  manifest: CompanyPortabilityManifest | null,
  liveAgents: LiveAgentForOperatingContract[],
): OperatingContractLeadershipContext {
  const activeLiveAgents = liveAgents.filter((agent) => agent.status !== "terminated");
  const liveAgentBySlug = new Map(
    activeLiveAgents.map((agent) => [normalizeAgentUrlKey(agent.name) ?? agent.id, agent]),
  );
  const contractCeoSlug =
    manifest?.operatingContract?.orgPolicy?.chiefOfStaff?.ceoSlug
    ?? manifest?.agents.find((agent) => agent.role === "ceo")?.slug
    ?? null;
  const liveCeo = contractCeoSlug
    ? liveAgentBySlug.get(contractCeoSlug) ?? activeLiveAgents.find((agent) => agent.role === "ceo") ?? null
    : activeLiveAgents.find((agent) => agent.role === "ceo") ?? null;
  const ceoSlug = contractCeoSlug ?? (liveCeo ? (normalizeAgentUrlKey(liveCeo.name) ?? liveCeo.id) : null);
  const contractChiefOfStaff =
    manifest?.agents.find((agent) =>
      agent.role === "pm"
      && agent.title === "Chief of Staff"
      && (!ceoSlug || agent.reportsToSlug === ceoSlug),
    )
    ?? manifest?.agents.find((agent) => agent.role === "pm" && agent.title === "Chief of Staff")
    ?? null;
  const liveChiefOfStaff =
    activeLiveAgents.find((agent) =>
      agent.role === "pm"
      && agent.title === "Chief of Staff"
      && (!liveCeo || agent.reportsTo === liveCeo.id),
    )
    ?? activeLiveAgents.find((agent) => agent.role === "pm" && agent.title === "Chief of Staff")
    ?? null;
  return {
    ceoSlug,
    liveCeo,
    directReports: liveCeo
      ? activeLiveAgents.filter((agent) => agent.reportsTo === liveCeo.id)
      : [],
    contractChiefOfStaff,
    liveChiefOfStaff,
  };
}

function buildRemediationOwner(
  context: OperatingContractLeadershipContext,
): OperatingContractRemediationOwner {
  if (!context.contractChiefOfStaff && !context.liveChiefOfStaff) {
    return defaultRemediationOwner();
  }

  return {
    role: "pm",
    title: "Chief of Staff",
    soleOwner: true,
    status: context.liveChiefOfStaff ? "assigned" : "missing",
    agentId: context.liveChiefOfStaff?.id ?? null,
    agentSlug:
      context.contractChiefOfStaff?.slug
      ?? (context.liveChiefOfStaff
        ? (normalizeAgentUrlKey(context.liveChiefOfStaff.name) ?? context.liveChiefOfStaff.id)
        : null),
    agentName: context.liveChiefOfStaff?.name ?? context.contractChiefOfStaff?.name ?? null,
  };
}

function buildConfigModel(
  companyId: string,
  row: ContractRow | null,
  workspace: OperatingContractWorkspaceRef | null,
  sourceChangedSinceReview: boolean,
): OperatingContractConfig {
  return {
    companyId,
    projectWorkspaceId: row?.projectWorkspaceId ?? null,
    packageRootPath: normalizePackageRootPath(row?.packageRootPath),
    workspace,
    lastReviewedAt: row?.lastReviewedAt ?? null,
    lastReviewSourceHash: row?.lastReviewSourceHash ?? null,
    lastReviewSummary: parseStoredReviewSummary(row?.lastReviewedSnapshot ?? null),
    sourceChangedSinceReview,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function readJoinedConfigRow(db: Db, companyId: string): Promise<JoinedConfigRow | null> {
  return db
    .select({
      contract: companyOperatingContracts,
      workspaceId: projectWorkspaces.id,
      workspaceProjectId: projectWorkspaces.projectId,
      workspaceName: projectWorkspaces.name,
      workspaceCwd: projectWorkspaces.cwd,
      workspaceRepoUrl: projectWorkspaces.repoUrl,
      workspaceIsPrimary: projectWorkspaces.isPrimary,
      projectName: projectsTable.name,
    })
    .from(companyOperatingContracts)
    .leftJoin(projectWorkspaces, eq(companyOperatingContracts.projectWorkspaceId, projectWorkspaces.id))
    .leftJoin(projectsTable, eq(projectWorkspaces.projectId, projectsTable.id))
    .where(eq(companyOperatingContracts.companyId, companyId))
    .then((rows) => rows[0] ?? null);
}

async function resolveContractSource(db: Db, companyId: string): Promise<ResolvedContractSource> {
  const joined = await readJoinedConfigRow(db, companyId);
  const row = joined?.contract ?? null;
  const workspace = workspaceRefFromRow(joined);
  const packageRootPath = normalizePackageRootPath(row?.packageRootPath);

  if (!row?.projectWorkspaceId || !workspace || !workspace.cwd) {
    return {
      configRow: row,
      workspace,
      packageRootPath,
      companyPath: null,
      paperclipExtensionPath: null,
      sourceHash: null,
      manifest: null,
    };
  }

  const workspaceRoot = path.resolve(workspace.cwd);
  const packageRoot = path.resolve(workspaceRoot, packageRootPath);
  if (!isWithinBasePath(workspaceRoot, packageRoot)) {
    throw unprocessable("Package root path must stay within the selected workspace");
  }

  const files = await collectPackageFiles(packageRoot);
  const parsed = buildManifestFromPackageFiles(files);
  const sourceHash = hashPackageFiles(files);
  return {
    configRow: row,
    workspace,
    packageRootPath,
    companyPath: Object.keys(files).find((filePath) => filePath === "COMPANY.md" || filePath.endsWith("/COMPANY.md")) ?? null,
    paperclipExtensionPath: Object.keys(files).find(
      (filePath) => filePath === ".paperclip.yaml" || filePath === ".paperclip.yml" || filePath.endsWith("/.paperclip.yaml") || filePath.endsWith("/.paperclip.yml"),
    ) ?? null,
    sourceHash,
    manifest: parsed.manifest,
  };
}

export function operatingContractService(db: Db) {
  const companies = companyService(db);
  const agents = agentService(db);
  const goals = goalService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const access = accessService(db);
  const secrets = secretService(db);

  async function getRemediationOwner(
    companyId: string,
    sourceOverride?: ResolvedContractSource,
  ): Promise<OperatingContractRemediationOwner> {
    const source = sourceOverride ?? await resolveContractSource(db, companyId);
    const liveAgents = await agents.list(companyId, { includeTerminated: true });
    return buildRemediationOwner(resolveLeadershipContext(source.manifest, liveAgents));
  }

  async function getConfig(companyId: string): Promise<OperatingContractConfig> {
    const source = await resolveContractSource(db, companyId);
    const sourceChangedSinceReview = Boolean(
      source.configRow?.lastReviewSourceHash
      && source.sourceHash
      && source.configRow.lastReviewSourceHash !== source.sourceHash,
    );
    return buildConfigModel(companyId, source.configRow, source.workspace, sourceChangedSinceReview);
  }

  async function updateConfig(companyId: string, input: UpdateOperatingContractConfigRequest) {
    const packageRootPath = normalizePackageRootPath(input.packageRootPath);

    if (input.projectWorkspaceId) {
      const workspace = await db
        .select({
          id: projectWorkspaces.id,
          companyId: projectWorkspaces.companyId,
        })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, input.projectWorkspaceId))
        .then((rows) => rows[0] ?? null);
      if (!workspace || workspace.companyId !== companyId) {
        throw notFound("Project workspace not found");
      }
    }

    const now = new Date();
    await db
      .insert(companyOperatingContracts)
      .values({
        companyId,
        projectWorkspaceId: input.projectWorkspaceId,
        packageRootPath,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: companyOperatingContracts.companyId,
        set: {
          projectWorkspaceId: input.projectWorkspaceId,
          packageRootPath,
          updatedAt: now,
        },
      });

    return getConfig(companyId);
  }

  async function persistReviewSnapshot(
    companyId: string,
    source: ResolvedContractSource,
    summary: OperatingContractReviewSummary,
  ) {
    if (!source.configRow) return;
    const now = new Date();
    await db
      .update(companyOperatingContracts)
      .set({
        lastReviewSourceHash: source.sourceHash,
        lastReviewedSnapshot: summary as unknown as Record<string, unknown>,
        lastReviewedAt: now,
        updatedAt: now,
      })
      .where(eq(companyOperatingContracts.companyId, companyId));
  }

  async function buildPreview(companyId: string): Promise<OperatingContractPreviewBuild> {
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const source = await resolveContractSource(db, companyId);
    const config = buildConfigModel(
      companyId,
      source.configRow,
      source.workspace,
      Boolean(source.configRow?.lastReviewSourceHash && source.sourceHash && source.configRow.lastReviewSourceHash !== source.sourceHash),
    );

    if (!source.configRow?.projectWorkspaceId || !source.workspace || !source.manifest || !source.sourceHash) {
      throw unprocessable("Operating contract is unconfigured");
    }

    const contract = buildResolvedContract(source.manifest);
    const liveGoals = await goals.list(companyId);
    const liveProjects = await projects.list(companyId);
    const liveAgents = await agents.list(companyId, { includeTerminated: true });
    const liveIssues = await issues.list(companyId);

    const liveGoalBySlug = new Map(liveGoals.map((goal) => [goal.slug, goal]));
    const liveGoalById = new Map(liveGoals.map((goal) => [goal.id, goal]));
    const liveAgentBySlug = new Map(liveAgents.map((agent) => [normalizeAgentUrlKey(agent.name) ?? agent.id, agent]));
    const liveAgentSlugById = new Map(liveAgents.map((agent) => [agent.id, normalizeAgentUrlKey(agent.name) ?? agent.id]));
    const liveProjectBySlug = new Map(liveProjects.map((project) => [project.urlKey, project]));
    const leadershipContext = resolveLeadershipContext(source.manifest, liveAgents);
    const remediationOwner = buildRemediationOwner(leadershipContext);

    const actions: OperatingContractAction[] = [];
    const warnings: OperatingContractPreviewResult["warnings"] = [];

    if (
      company.name !== contract.companyName
      || (company.description ?? null) !== (contract.companyDescription ?? null)
    ) {
      actions.push({
        id: "company:metadata",
        group: "company_metadata",
        kind: "update_company_metadata",
        title: "Align company metadata",
        description: "Update the company name and description to match the operating contract.",
        entityType: "company",
        entityId: company.id,
        entitySlug: contract.companySlug,
        metadata: {
          name: contract.companyName,
          description: contract.companyDescription,
        },
      });
    }

    for (const contractGoal of contract.goals) {
      const liveGoal = liveGoalBySlug.get(contractGoal.slug) ?? null;
      const liveParentSlug = liveGoal?.parentId ? (liveGoalById.get(liveGoal.parentId)?.slug ?? null) : null;
      const liveOwnerSlug = liveGoal?.ownerAgentId ? (liveAgentSlugById.get(liveGoal.ownerAgentId) ?? null) : null;
      const metadata = {
        slug: contractGoal.slug,
        title: contractGoal.title,
        description: contractGoal.description,
        level: contractGoal.level,
        status: contractGoal.status,
        parentSlug: contractGoal.parentSlug,
        ownerAgentSlug: contractGoal.ownerAgentSlug,
      };
      if (!liveGoal) {
        actions.push({
          id: `goal:create:${contractGoal.slug}`,
          group: "goals",
          kind: "create_goal",
          title: `Create goal ${contractGoal.title}`,
          description: "Create the contract goal in the live company.",
          entityType: "goal",
          entityId: null,
          entitySlug: contractGoal.slug,
          metadata,
        });
        continue;
      }
      if (
        liveGoal.title !== contractGoal.title
        || (liveGoal.description ?? null) !== (contractGoal.description ?? null)
        || liveGoal.level !== contractGoal.level
        || liveGoal.status !== contractGoal.status
        || liveParentSlug !== contractGoal.parentSlug
        || liveOwnerSlug !== contractGoal.ownerAgentSlug
      ) {
        actions.push({
          id: `goal:update:${contractGoal.slug}`,
          group: "goals",
          kind: "update_goal",
          title: `Update goal ${contractGoal.title}`,
          description: "Bring the live goal definition back in sync with the contract.",
          entityType: "goal",
          entityId: liveGoal.id,
          entitySlug: contractGoal.slug,
          metadata,
        });
      }
    }

    for (const contractAgent of source.manifest.agents) {
      const liveAgent = liveAgentBySlug.get(contractAgent.slug) ?? null;
      const expectedManagerSlug = contractAgent.reportsToSlug ?? null;
      const liveManagerSlug = liveAgent?.reportsTo ? (liveAgentSlugById.get(liveAgent.reportsTo) ?? null) : null;
      const metadata = {
        slug: contractAgent.slug,
        name: contractAgent.name,
        role: contractAgent.role,
        title: contractAgent.title,
        capabilities: contractAgent.capabilities,
        reportsToSlug: expectedManagerSlug,
        adapterType: contractAgent.adapterType,
        adapterConfig: contractAgent.adapterConfig,
        runtimeConfig: contractAgent.runtimeConfig,
        permissions: contractAgent.permissions,
        budgetMonthlyCents: contractAgent.budgetMonthlyCents,
        metadata: contractAgent.metadata,
      };
      if (!liveAgent) {
        actions.push({
          id: `agent:create:${contractAgent.slug}`,
          group: "agents",
          kind: "create_agent",
          title: `Create agent ${contractAgent.name}`,
          description: "Create the missing contract agent in the live company.",
          entityType: "agent",
          entityId: null,
          entitySlug: contractAgent.slug,
          metadata,
        });
        continue;
      }
      if (
        liveAgent.name !== contractAgent.name
        || liveAgent.role !== contractAgent.role
        || (liveAgent.title ?? null) !== (contractAgent.title ?? null)
        || (liveAgent.capabilities ?? null) !== (contractAgent.capabilities ?? null)
        || liveManagerSlug !== expectedManagerSlug
        || liveAgent.adapterType !== contractAgent.adapterType
        || !jsonEqual(liveAgent.adapterConfig, contractAgent.adapterConfig)
        || !jsonEqual(liveAgent.runtimeConfig, contractAgent.runtimeConfig)
        || !jsonEqual(liveAgent.permissions, contractAgent.permissions)
        || liveAgent.budgetMonthlyCents !== contractAgent.budgetMonthlyCents
        || !jsonEqual(liveAgent.metadata, contractAgent.metadata)
      ) {
        actions.push({
          id: `agent:update:${contractAgent.slug}`,
          group: "agents",
          kind: "update_agent",
          title: `Update agent ${contractAgent.name}`,
          description: "Bring the live agent definition back in sync with the contract.",
          entityType: "agent",
          entityId: liveAgent.id,
          entitySlug: contractAgent.slug,
          metadata,
        });
      }
    }

    const desiredGoalSlugsByProjectSlug = new Map(source.manifest.projects.map((project) => [project.slug, project.goalSlugs]));
    for (const project of liveProjects.filter((entry) => !entry.archivedAt && isActiveProjectStatus(entry.status))) {
      const desiredGoalSlugs = desiredGoalSlugsByProjectSlug.get(project.urlKey) ?? [];
      const currentGoalSlugs = project.goalIds
        .map((goalId) => liveGoalById.get(goalId)?.slug ?? null)
        .filter((goalSlug): goalSlug is string => Boolean(goalSlug));
      if (desiredGoalSlugs.length > 0 && !arraysEqual(currentGoalSlugs, desiredGoalSlugs)) {
        actions.push({
          id: `project:goal-links:${project.id}`,
          group: "project_goal_links",
          kind: "repair_project_goal_links",
          title: `Repair goal links for ${project.name}`,
          description: "Update the live project goal links to match the contract.",
          entityType: "project",
          entityId: project.id,
          entitySlug: project.urlKey,
          metadata: {
            projectId: project.id,
            projectSlug: project.urlKey,
            goalSlugs: desiredGoalSlugs,
          },
        });
      } else if (currentGoalSlugs.length === 0) {
        warnings.push({
          kind: "project_missing_goal_link",
          title: `Project ${project.name} has no contract goal link`,
          description: "Active projects should link to at least one goal from the operating contract.",
          entityType: "project",
          entityId: project.id,
          entitySlug: project.urlKey,
          metadata: {
            projectId: project.id,
            projectSlug: project.urlKey,
          },
        });
      }
    }

    for (const issue of liveIssues.filter((entry) => !entry.hiddenAt && isOpenIssueStatus(entry.status))) {
      if (issue.goalId) continue;
      const project = issue.projectId ? liveProjectBySlug.get(liveProjects.find((candidate) => candidate.id === issue.projectId)?.urlKey ?? "") ?? null : null;
      const desiredGoalSlugs = project ? desiredGoalSlugsByProjectSlug.get(project.urlKey) ?? [] : [];
      const currentProjectGoalSlugs = issue.projectId
        ? (liveProjects.find((candidate) => candidate.id === issue.projectId)?.goalIds ?? [])
            .map((goalId) => liveGoalById.get(goalId)?.slug ?? null)
            .filter((goalSlug): goalSlug is string => Boolean(goalSlug))
        : [];
      const candidateGoalSlug =
        desiredGoalSlugs.length === 1
          ? desiredGoalSlugs[0]
          : currentProjectGoalSlugs.length === 1
            ? currentProjectGoalSlugs[0]
            : null;
      if (candidateGoalSlug) {
        actions.push({
          id: `issue:goal-backfill:${issue.id}`,
          group: "issue_goal_backfills",
          kind: "backfill_issue_goal",
          title: `Backfill goal on ${issue.identifier ?? issue.title}`,
          description: "Assign the unambiguous project goal to the open issue.",
          entityType: "issue",
          entityId: issue.id,
          entitySlug: issue.identifier ?? null,
          metadata: {
            issueId: issue.id,
            goalSlug: candidateGoalSlug,
          },
        });
      } else {
        warnings.push({
          kind: "ambiguous_issue_goal",
          title: `Issue ${issue.identifier ?? issue.title} needs a goal`,
          description: "No unambiguous contract goal could be inferred for this open issue.",
          entityType: "issue",
          entityId: issue.id,
          entitySlug: issue.identifier ?? null,
          metadata: {
            issueId: issue.id,
            projectId: issue.projectId,
          },
        });
      }
    }

    const ceoSlug = leadershipContext.ceoSlug;
    const chiefOfStaffPolicy = contract.orgPolicy.chiefOfStaff;
    const liveCeo = leadershipContext.liveCeo;
    const contractChiefOfStaffExists = Boolean(leadershipContext.contractChiefOfStaff);
    const liveChiefOfStaffExists = Boolean(leadershipContext.liveChiefOfStaff);
    const directReports = leadershipContext.directReports;
    if (
      liveCeo
      && chiefOfStaffPolicy?.enabled !== false
      && directReports.length > (chiefOfStaffPolicy?.directReportThreshold ?? DEFAULT_DIRECT_REPORT_THRESHOLD)
      && !contractChiefOfStaffExists
      && !liveChiefOfStaffExists
    ) {
      actions.push({
        id: `staffing:chief-of-staff:${liveCeo.id}`,
        group: "staffing_recommendations",
        kind: "recommend_chief_of_staff",
        title: "Hire a Chief of Staff",
        description: "The CEO span exceeds the configured threshold. Recommend a PM-titled Chief of Staff to own operating-contract remediation and leadership follow-through.",
        entityType: "agent",
        entityId: liveCeo.id,
        entitySlug: ceoSlug,
        metadata: {
          ceoId: liveCeo.id,
          ceoSlug,
          directReportCount: directReports.length,
          directReportThreshold: chiefOfStaffPolicy?.directReportThreshold ?? DEFAULT_DIRECT_REPORT_THRESHOLD,
          title: "Chief of Staff",
          role: "pm",
        },
      });
    }

    const staleHeartbeatCutoff = Date.now() - contract.orgPolicy.staleHeartbeatThresholdHours * 60 * 60 * 1000;
    const staleOpenWorkCutoff = Date.now() - contract.orgPolicy.openWorkStaleDays * 24 * 60 * 60 * 1000;
    for (const report of directReports) {
      if (!report.lastHeartbeatAt || report.lastHeartbeatAt.getTime() < staleHeartbeatCutoff) {
        warnings.push({
          kind: "stale_direct_report",
          title: `${report.name} looks stale`,
          description: "This CEO direct report has no recent heartbeat activity.",
          entityType: "agent",
          entityId: report.id,
          entitySlug: normalizeAgentUrlKey(report.name),
          metadata: {
            lastHeartbeatAt: report.lastHeartbeatAt?.toISOString() ?? null,
          },
        });
      }
      const staleAssignedWork = liveIssues.filter((issue) =>
        !issue.hiddenAt
        && isOpenIssueStatus(issue.status)
        && issue.assigneeAgentId === report.id
        && issue.updatedAt.getTime() < staleOpenWorkCutoff,
      );
      if (staleAssignedWork.length > 0) {
        warnings.push({
          kind: "stale_open_work",
          title: `${report.name} has stale open work`,
          description: "This direct report owns open issues with no recent activity.",
          entityType: "agent",
          entityId: report.id,
          entitySlug: normalizeAgentUrlKey(report.name),
          metadata: {
            issueCount: staleAssignedWork.length,
          },
        });
      }
    }

    for (const issue of liveIssues.filter((entry) => !entry.hiddenAt && isOpenIssueStatus(entry.status))) {
      if (issue.assigneeAgentId || issue.assigneeUserId) continue;
      warnings.push({
        kind: "unowned_open_work",
        title: `${issue.identifier ?? issue.title} is unowned`,
        description: "This open issue has no current owner.",
        entityType: "issue",
        entityId: issue.id,
        entitySlug: issue.identifier ?? null,
        metadata: {
          issueId: issue.id,
        },
      });
    }

    const counts = actions.reduce<OperatingContractFindingCounts>((summary, action) => {
      if (action.group === "company_metadata") summary.companyMetadata += 1;
      if (action.group === "goals") summary.goals += 1;
      if (action.group === "project_goal_links") summary.projectGoalLinks += 1;
      if (action.group === "issue_goal_backfills") summary.issueGoalBackfills += 1;
      if (action.group === "agents") summary.agents += 1;
      if (action.group === "staffing_recommendations") summary.staffingRecommendations += 1;
      return summary;
    }, emptyFindingCounts());
    counts.warnings = warnings.length;
    counts.total =
      counts.companyMetadata
      + counts.goals
      + counts.projectGoalLinks
      + counts.issueGoalBackfills
      + counts.agents
      + counts.staffingRecommendations
      + counts.warnings;

    const previewHash = buildPreviewHash(companyId, source.sourceHash, actions, counts);
    const status = counts.total === 0 ? "healthy" : "warning";
    return {
      source,
      config: {
        ...config,
        lastReviewSummary: parseStoredReviewSummary(source.configRow?.lastReviewedSnapshot ?? null),
      },
      preview: {
        companyId,
        config,
        previewHash,
        sourceHash: source.sourceHash,
        status,
        source: {
          workspaceId: source.workspace.id,
          packageRootPath: source.packageRootPath,
          companyPath: source.companyPath ?? "COMPANY.md",
          paperclipExtensionPath: source.paperclipExtensionPath,
        },
        contract,
        remediationOwner,
        counts,
        actions,
        warnings,
      },
    };
  }

  async function preview(companyId: string) {
    const built = await buildPreview(companyId);
    const summary: OperatingContractReviewSummary = {
      status: built.preview.status,
      counts: built.preview.counts,
      previewHash: built.preview.previewHash,
    };
    await persistReviewSnapshot(companyId, built.source, summary);
    const config = await getConfig(companyId);
    return {
      ...built.preview,
      config,
    };
  }

  async function apply(companyId: string, input: OperatingContractApplyRequest): Promise<OperatingContractApplyResult> {
    const built = await buildPreview(companyId);
    if (built.preview.previewHash !== input.previewHash) {
      throw conflict("Operating contract preview is stale. Run preview again before applying.");
    }

    const selectedGroups = new Set(input.selectedActionGroups);
    const selectedActions = built.preview.actions.filter((action) => selectedGroups.has(action.group));
    const appliedCounts: Partial<Record<OperatingContractActionGroup, number>> = {};

    const createdOrUpdatedAgentsBySlug = new Map<string, string>();

    for (const action of selectedActions.filter((entry) => entry.group === "company_metadata")) {
      if (action.kind !== "update_company_metadata" || !isPlainRecord(action.metadata)) continue;
      await companies.update(companyId, {
        name: typeof action.metadata.name === "string" ? action.metadata.name : undefined,
        description: typeof action.metadata.description === "string" || action.metadata.description === null
          ? action.metadata.description
          : undefined,
      });
      appliedCounts.company_metadata = (appliedCounts.company_metadata ?? 0) + 1;
    }

    for (const action of selectedActions.filter((entry) => entry.group === "agents")) {
      if (!isPlainRecord(action.metadata) || typeof action.metadata.slug !== "string" || typeof action.metadata.name !== "string") {
        continue;
      }
      const agentSlug = action.metadata.slug;
      const liveAgent = action.entitySlug ? (await agents.list(companyId, { includeTerminated: true })).find(
        (agent) => (normalizeAgentUrlKey(agent.name) ?? agent.id) === action.entitySlug,
      ) ?? null : null;
      const reportsToSlug = typeof action.metadata.reportsToSlug === "string" ? action.metadata.reportsToSlug : null;
      const allAgents = await agents.list(companyId, { includeTerminated: true });
      const managerId = reportsToSlug
        ? createdOrUpdatedAgentsBySlug.get(reportsToSlug)
          ?? allAgents.find((agent) => (normalizeAgentUrlKey(agent.name) ?? agent.id) === reportsToSlug)?.id
          ?? null
        : null;
      const adapterConfig = await secrets.normalizeAdapterConfigForPersistence(
        companyId,
        writePaperclipSkillSyncPreference(
          isPlainRecord(action.metadata.adapterConfig) ? action.metadata.adapterConfig : {},
          [],
        ),
        { strictMode: true },
      );
      const patch = {
        name: action.metadata.name,
        role: typeof action.metadata.role === "string" ? action.metadata.role : "general",
        title: typeof action.metadata.title === "string" || action.metadata.title === null ? action.metadata.title : null,
        capabilities:
          typeof action.metadata.capabilities === "string" || action.metadata.capabilities === null
            ? action.metadata.capabilities
            : null,
        reportsTo: managerId,
        adapterType: typeof action.metadata.adapterType === "string" ? action.metadata.adapterType : "process",
        adapterConfig,
        runtimeConfig: isPlainRecord(action.metadata.runtimeConfig) ? action.metadata.runtimeConfig : {},
        budgetMonthlyCents: typeof action.metadata.budgetMonthlyCents === "number" ? action.metadata.budgetMonthlyCents : 0,
        permissions: isPlainRecord(action.metadata.permissions) ? action.metadata.permissions : {},
        metadata: isPlainRecord(action.metadata.metadata) ? action.metadata.metadata : null,
      };
      if (liveAgent) {
        const updated = await agents.update(liveAgent.id, patch);
        if (updated) {
          createdOrUpdatedAgentsBySlug.set(agentSlug, updated.id);
        }
      } else {
        const created = await agents.create(companyId, patch);
        await access.ensureMembership(companyId, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(companyId, "agent", created.id, "tasks:assign", true, null);
        createdOrUpdatedAgentsBySlug.set(agentSlug, created.id);
      }
      appliedCounts.agents = (appliedCounts.agents ?? 0) + 1;
    }

    for (const action of selectedActions.filter((entry) => entry.group === "staffing_recommendations")) {
      if (action.kind !== "recommend_chief_of_staff" || !isPlainRecord(action.metadata)) continue;
      const ceoId = typeof action.metadata.ceoId === "string" ? action.metadata.ceoId : null;
      const existingChiefOfStaff = (await agents.list(companyId, { includeTerminated: true })).find((agent) =>
        agent.role === "pm"
        && agent.title === "Chief of Staff"
        && (!ceoId || agent.reportsTo === ceoId),
      );
      if (!existingChiefOfStaff) {
        const created = await agents.create(companyId, {
          name: "Chief of Staff",
          role: "pm",
          title: "Chief of Staff",
          reportsTo: ceoId,
          capabilities: "Solely own operating-contract remediation, coordinate leadership cadence, and unblock direct reports.",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          permissions: {},
          metadata: null,
        });
        await access.ensureMembership(companyId, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(companyId, "agent", created.id, "tasks:assign", true, null);
      }
      appliedCounts.staffing_recommendations = (appliedCounts.staffing_recommendations ?? 0) + 1;
    }

    const goalActions = selectedActions.filter((entry) => entry.group === "goals" && isPlainRecord(entry.metadata));
    for (const action of goalActions) {
      const metadata = action.metadata as Record<string, unknown>;
      const slug = typeof metadata.slug === "string" ? metadata.slug : null;
      const title = typeof metadata.title === "string" ? metadata.title : null;
      if (!slug || !title) continue;
      const existingGoal = await goals.getBySlug(companyId, slug);
      const ownerAgentSlug = typeof metadata.ownerAgentSlug === "string" ? metadata.ownerAgentSlug : null;
      const ownerAgentId = ownerAgentSlug
        ? createdOrUpdatedAgentsBySlug.get(ownerAgentSlug)
          ?? (await agents.list(companyId, { includeTerminated: true })).find(
              (agent) => (normalizeAgentUrlKey(agent.name) ?? agent.id) === ownerAgentSlug,
            )?.id
          ?? null
        : null;
      if (existingGoal) {
        await goals.update(existingGoal.id, {
          slug,
          title,
          description: typeof metadata.description === "string" || metadata.description === null ? metadata.description : null,
          level: typeof metadata.level === "string" ? metadata.level : undefined,
          status: typeof metadata.status === "string" ? metadata.status : undefined,
          ownerAgentId,
        });
      } else {
        await goals.create(companyId, {
          slug,
          title,
          description: typeof metadata.description === "string" || metadata.description === null ? metadata.description : null,
          level: typeof metadata.level === "string" ? metadata.level : "company",
          status: typeof metadata.status === "string" ? metadata.status : "planned",
          ownerAgentId,
          parentId: null,
        });
      }
      appliedCounts.goals = (appliedCounts.goals ?? 0) + 1;
    }
    for (const action of goalActions) {
      const metadata = action.metadata as Record<string, unknown>;
      const slug = typeof metadata.slug === "string" ? metadata.slug : null;
      const parentSlug = typeof metadata.parentSlug === "string" ? metadata.parentSlug : null;
      if (!slug || !parentSlug) continue;
      const goal = await goals.getBySlug(companyId, slug);
      const parentGoal = await goals.getBySlug(companyId, parentSlug);
      if (goal && parentGoal) {
        await goals.update(goal.id, { parentId: parentGoal.id });
      }
    }

    for (const action of selectedActions.filter((entry) => entry.group === "project_goal_links")) {
      if (!isPlainRecord(action.metadata) || typeof action.metadata.projectId !== "string" || !Array.isArray(action.metadata.goalSlugs)) {
        continue;
      }
      const goalIds = (
        await Promise.all(
          action.metadata.goalSlugs
            .filter((goalSlug): goalSlug is string => typeof goalSlug === "string")
            .map(async (goalSlug) => (await goals.getBySlug(companyId, goalSlug))?.id ?? null),
        )
      ).filter((goalId): goalId is string => Boolean(goalId));
      await projects.update(action.metadata.projectId, { goalIds });
      appliedCounts.project_goal_links = (appliedCounts.project_goal_links ?? 0) + 1;
    }

    for (const action of selectedActions.filter((entry) => entry.group === "issue_goal_backfills")) {
      if (!isPlainRecord(action.metadata) || typeof action.metadata.issueId !== "string" || typeof action.metadata.goalSlug !== "string") {
        continue;
      }
      const goal = await goals.getBySlug(companyId, action.metadata.goalSlug);
      if (!goal) continue;
      await issues.update(action.metadata.issueId, { goalId: goal.id });
      appliedCounts.issue_goal_backfills = (appliedCounts.issue_goal_backfills ?? 0) + 1;
    }

    const refreshedPreview = await preview(companyId);
    return {
      companyId,
      appliedActionGroups: input.selectedActionGroups,
      appliedCounts,
      preview: refreshedPreview,
    };
  }

  async function dashboardSummary(companyId: string): Promise<OperatingContractDashboardSummary> {
    const source = await resolveContractSource(db, companyId);
    const sourceChangedSinceReview = Boolean(
      source.configRow?.lastReviewSourceHash
      && source.sourceHash
      && source.configRow.lastReviewSourceHash !== source.sourceHash,
    );
    const config = buildConfigModel(companyId, source.configRow, source.workspace, sourceChangedSinceReview);
    const remediationOwner = await getRemediationOwner(companyId, source);
    if (!config.projectWorkspaceId) {
      return {
        status: "unconfigured",
        sourceChangedSinceReview: false,
        lastReviewedAt: null,
        previewPath: REVIEW_PREVIEW_PATH,
        remediationOwner,
        counts: null,
      };
    }
    if (!config.lastReviewSummary) {
      return {
        status: "needs_review",
        sourceChangedSinceReview: config.sourceChangedSinceReview,
        lastReviewedAt: config.lastReviewedAt,
        previewPath: REVIEW_PREVIEW_PATH,
        remediationOwner,
        counts: null,
      };
    }
    return {
      status: config.lastReviewSummary.status,
      sourceChangedSinceReview: config.sourceChangedSinceReview,
      lastReviewedAt: config.lastReviewedAt,
      previewPath: REVIEW_PREVIEW_PATH,
      remediationOwner,
      counts: config.lastReviewSummary.counts,
    };
  }

  return {
    getConfig,
    getRemediationOwner,
    updateConfig,
    preview,
    apply,
    dashboardSummary,
  };
}
