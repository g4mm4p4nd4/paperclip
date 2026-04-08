import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX, DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { companyService } from "./companies.js";
import { projectService } from "./projects.js";
import { agentService } from "./agents.js";
import { agentRoleDefaultsService } from "./agent-role-defaults.js";
import { issueService } from "./issues.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { heartbeatService } from "./heartbeat.js";
import { routineService } from "./routines.js";

const execFile = promisify(execFileCallback);

const DEFAULT_POS_DIR = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_PAPERCLIP_DIR = "/Users/mnm/Documents/Github/paperclip";
const DEFAULT_GSTACK_DIR = "/Users/mnm/Documents/Github/gstack";
const DEFAULT_DISPATCH_OUTBOX = `${DEFAULT_POS_DIR}/data/dispatch/outbox`;
const DEFAULT_DISPATCH_LEDGER_PATH = path.resolve(
  resolvePaperclipInstanceRoot(),
  "data",
  "portfolio-os-dispatch-ledger.json",
);
const DEFAULT_GSTACK_SKILL_LINK = path.resolve(os.homedir(), ".codex", "skills", "gstack");
const DEFAULT_DISPATCH_POLL_INTERVAL_MS = 15_000;

type DispatchTask = {
  function?: string;
  ticket_title?: string;
  summary?: string;
  acceptance_criteria?: string[];
  requires_approval_before_merge?: boolean;
  requires_approval_before_deploy?: boolean;
  repo_target?: {
    target_repo_full_name?: string;
    target_repo_branch?: string;
    target_repo_clone_path_hint?: string | null;
    suggested_branch_name?: string;
    repo_url?: string;
  };
};

type PortfolioDispatchPayload = {
  schema_version?: string;
  run_id?: string;
  generated_at?: string;
  selection_snapshot_hash?: string;
  selection_snapshot_path?: string;
  packet_snapshot_path?: string;
  target_repo_full_name?: string;
  target_repo_branch?: string;
  target_repo_clone_path_hint?: string | null;
  execution_manifest?: {
    repo_target?: DispatchTask["repo_target"];
    task_groups?: Record<string, DispatchTask[]>;
  };
  selection_snapshot?: {
    launch_target?: {
      repo?: string;
      repo_url?: string;
      robust_branch?: string;
      launch_packet_slug?: string;
      strongest_wedge?: string;
      recommended_offer_angle?: string;
    };
    artifacts?: {
      scaffold_dir?: string | null;
      launch_packet_path?: string | null;
      daily_report_path?: string | null;
      business_report_path?: string | null;
      council_report_path?: string | null;
    };
  };
  cockpit?: {
    portfolio_os_dir?: string;
    paperclip_dir?: string;
    gstack_dir?: string;
  };
};

type DispatchLedgerEntry = {
  dispatchHash: string;
  runId: string;
  selectionSnapshotHash: string;
  dispatchPath: string;
  companyId: string;
  projectId: string;
  issueIds: string[];
  approvalIds: string[];
  routineIds?: string[];
  ingestedAt: string;
};

type DispatchLedger = {
  ingested: Record<string, DispatchLedgerEntry>;
};

type PortfolioCompany = {
  id: string;
  name: string;
  description: string | null;
};

type PortfolioProject = {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  workspaces?: Array<{
    id: string;
    name: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    isPrimary: boolean;
  }>;
};

type PortfolioAgent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsTo: string | null;
};

type PortfolioIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  title: string;
};

type PortfolioApproval = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
};

type PortfolioRoutine = {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  triggers: Array<{
    id: string;
    kind: string;
    label: string | null;
    enabled: boolean;
  }>;
};

type PortfolioDispatchIngestDeps = {
  readFile(pathValue: string): Promise<string>;
  readDispatchLedger(): Promise<DispatchLedger>;
  writeDispatchLedger(ledger: DispatchLedger): Promise<void>;
  ensureGstackSkillLink(): Promise<void>;
  ensureRepoClone(input: {
    repoFullName: string;
    repoUrl: string;
    clonePathHint: string;
    baseBranch: string;
    runBranch: string;
  }): Promise<{ clonePath: string; runBranch: string }>;
  listCompanies(): Promise<PortfolioCompany[]>;
  createCompany(input: {
    name: string;
    description: string;
  }): Promise<PortfolioCompany>;
  listProjects(companyId: string): Promise<PortfolioProject[]>;
  createProject(companyId: string, input: {
    name: string;
    description: string;
    status: "planned";
  }): Promise<PortfolioProject>;
  createWorkspace(projectId: string, input: {
    name: string;
    cwd: string;
    repoUrl: string;
    repoRef: string;
    defaultRef: string;
    isPrimary: boolean;
  }): Promise<void>;
  listAgents(companyId: string): Promise<PortfolioAgent[]>;
  createAgent(companyId: string, input: {
    name: string;
    role: string;
    title: string;
    reportsTo: string | null;
    capabilities: string;
    adapterType: "codex_local";
    adapterConfig: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<PortfolioAgent>;
  listIssues(companyId: string, projectId: string): Promise<PortfolioIssue[]>;
  createIssue(companyId: string, input: {
    projectId: string;
    title: string;
    description: string;
    status: "todo";
    priority: "high" | "medium";
    assigneeAgentId: string | null;
  }): Promise<PortfolioIssue>;
  listApprovals(companyId: string): Promise<PortfolioApproval[]>;
  createApproval(companyId: string, input: {
    type: "launch_execution";
    requestedByAgentId: string | null;
    payload: Record<string, unknown>;
  }): Promise<PortfolioApproval>;
  linkApprovalToIssues(approvalId: string, issueIds: string[]): Promise<void>;
  listRoutines(companyId: string): Promise<PortfolioRoutine[]>;
  createRoutine(companyId: string, input: {
    projectId: string;
    title: string;
    description: string;
    assigneeAgentId: string;
    priority: "high" | "medium";
    status: "active";
    concurrencyPolicy: "coalesce_if_active";
    catchUpPolicy: "skip_missed";
    variables: [];
    parentIssueId?: string | null;
  }): Promise<PortfolioRoutine>;
  createRoutineTrigger(routineId: string, input: {
    kind: "schedule";
    label: string;
    enabled: boolean;
    cronExpression: string;
    timezone: string;
  }): Promise<void>;
  wakeAgent(agentId: string, issueId: string, projectId: string, runId: string, projectWorkspaceId?: string | null): Promise<void>;
  logInfo(message: string, details?: Record<string, unknown>): void;
  logWarn(message: string, details?: Record<string, unknown>): void;
  logError(message: string, details?: Record<string, unknown>): void;
};

type DispatchIngestResult = {
  status: "ingested" | "skipped";
  dispatchHash: string;
  runId: string;
  companyId?: string;
  projectId?: string;
  issueIds?: string[];
  approvalIds?: string[];
  routineIds?: string[];
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDispatchLedger(input: unknown): DispatchLedger {
  if (
    typeof input === "object"
    && input !== null
    && "ingested" in input
    && typeof (input as { ingested?: unknown }).ingested === "object"
    && (input as { ingested?: unknown }).ingested !== null
  ) {
    return {
      ingested: { ...((input as { ingested: Record<string, DispatchLedgerEntry> }).ingested ?? {}) },
    };
  }
  return { ingested: {} };
}

function normalizeRepoUrl(repoFullName: string, candidate: string | null | undefined) {
  const trimmed = candidate?.trim() ?? "";
  if (trimmed.length > 0) {
    if (trimmed.endsWith(".git")) return trimmed;
    if (trimmed.includes("github.com/")) return `${trimmed.replace(/\/+$/, "")}.git`;
    return trimmed;
  }
  return `https://github.com/${repoFullName}.git`;
}

function deriveVentureCompanyName(repoFullName: string) {
  return `Portfolio Venture Factory :: ${repoFullName}`;
}

function deriveRunProjectName(runId: string, repoFullName: string) {
  return `Run ${runId} :: ${repoFullName}`;
}

function buildMetadataContract(input: {
  runId: string;
  dispatchHash: string;
  selectionSnapshotHash: string;
  targetRepoFullName: string;
  targetRepoRef: string;
  suggestedBranchName: string;
  sourceDispatchPath: string;
}) {
  return {
    run_id: input.runId,
    dispatch_hash: input.dispatchHash,
    selection_snapshot_hash: input.selectionSnapshotHash,
    target_repo_full_name: input.targetRepoFullName,
    target_repo_ref: input.targetRepoRef,
    suggested_branch_name: input.suggestedBranchName,
    source_dispatch_path: input.sourceDispatchPath,
  };
}

function renderMetadataBlock(metadata: Record<string, unknown>) {
  return [
    "## Portfolio Dispatch Contract",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
  ].join("\n");
}

function issueDescriptionFromTask(input: {
  task: DispatchTask;
  metadata: Record<string, unknown>;
}) {
  const acceptanceCriteria = input.task.acceptance_criteria ?? [];
  return [
    input.task.summary?.trim() || "Execute the assigned dispatch task.",
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria.map((line) => `- ${line}`),
    "",
    renderMetadataBlock(input.metadata),
  ].join("\n");
}

function projectDescriptionFromDispatch(input: {
  payload: PortfolioDispatchPayload;
  metadata: Record<string, unknown>;
}) {
  const launchTarget = input.payload.selection_snapshot?.launch_target;
  const artifacts = input.payload.selection_snapshot?.artifacts;
  return [
    `Paperclip cockpit project for run \`${input.metadata.run_id}\`.`,
    "",
    launchTarget?.strongest_wedge ? `Wedge: ${launchTarget.strongest_wedge}` : "",
    launchTarget?.recommended_offer_angle ? `Offer angle: ${launchTarget.recommended_offer_angle}` : "",
    artifacts?.scaffold_dir ? `Scaffold dir: ${artifacts.scaffold_dir}` : "",
    artifacts?.launch_packet_path ? `Launch packet: ${artifacts.launch_packet_path}` : "",
    "",
    renderMetadataBlock(input.metadata),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function parseDispatchPayload(raw: string): PortfolioDispatchPayload {
  const parsed = JSON.parse(raw) as PortfolioDispatchPayload;
  if (!parsed.run_id || !parsed.target_repo_full_name) {
    throw new Error("Dispatch payload is missing required run or repo fields.");
  }
  return parsed;
}

function taskGroupEntries(payload: PortfolioDispatchPayload) {
  return Object.entries(payload.execution_manifest?.task_groups ?? {});
}

function dispatchTargetLocator(payload: PortfolioDispatchPayload) {
  return payload.execution_manifest?.repo_target ?? {
    target_repo_full_name: payload.target_repo_full_name,
    target_repo_branch: payload.target_repo_branch,
    target_repo_clone_path_hint: payload.target_repo_clone_path_hint,
  };
}

const AGENT_BLUEPRINTS = [
  {
    key: "CEO",
    name: "CEO",
    role: "ceo",
    title: "CEO",
    reportsTo: null,
    capabilities: "Strategy, wedge acceptance, and launch execution governance.",
  },
  {
    key: "CTO",
    name: "CTO",
    role: "cto",
    title: "CTO",
    reportsTo: "CEO",
    capabilities: "Architecture planning, branch strategy, and engineering milestones.",
  },
  {
    key: "CMO",
    name: "CMO",
    role: "cmo",
    title: "CMO",
    reportsTo: "CEO",
    capabilities: "Positioning, launch messaging, and demand creation.",
  },
  {
    key: "Engineer-1",
    name: "Engineer-1",
    role: "engineer",
    title: "Engineer-1",
    reportsTo: "CTO",
    capabilities: "Primary implementation owner for the target repository.",
  },
  {
    key: "Engineer-2",
    name: "Engineer-2",
    role: "engineer",
    title: "Engineer-2",
    reportsTo: "CTO",
    capabilities: "Parallel implementation and support for the target repository.",
  },
  {
    key: "Designer/Copy",
    name: "Designer/Copy",
    role: "designer",
    title: "Designer/Copy",
    reportsTo: "CMO",
    capabilities: "Landing pages, copy, and creative execution assets.",
  },
  {
    key: "QA",
    name: "QA",
    role: "qa",
    title: "QA",
    reportsTo: "CTO",
    capabilities: "Browser QA, regression checks, and release verification.",
  },
  {
    key: "Release Manager",
    name: "Release Manager",
    role: "devops",
    title: "Release Manager",
    reportsTo: "CTO",
    capabilities: "Push-on-green discipline, merge gating, and release notes.",
  },
  {
    key: "Growth/Distribution",
    name: "Growth/Distribution",
    role: "general",
    title: "Growth/Distribution",
    reportsTo: "CMO",
    capabilities: "Distribution, outreach, and launch amplification.",
  },
];

const ISSUE_ASSIGNEE_BY_FUNCTION: Record<string, string> = {
  CEO: "CEO",
  CTO: "CTO",
  Engineer: "Engineer-1",
  QA: "QA",
  Marketing: "CMO",
  Release: "Release Manager",
};

const PORTFOLIO_ROUTINE_TIME_ZONE = "America/New_York";

type RoutineBlueprint = {
  key: string;
  title: string;
  assigneeName: string;
  priority: "high" | "medium";
  cronExpression: string;
  triggerLabel: string;
  parentIssueFunction?: string;
  description(input: {
    payload: PortfolioDispatchPayload;
    metadata: Record<string, unknown>;
    clonePath: string;
    runBranch: string;
    approvalId: string;
  }): string;
};

const ROUTINE_BLUEPRINTS: RoutineBlueprint[] = [
  {
    key: "dispatch-poller",
    title: "Dispatch Poller",
    assigneeName: "Release Manager",
    priority: "medium",
    cronExpression: "*/30 * * * *",
    triggerLabel: "Every 30 minutes",
    parentIssueFunction: "Release",
    description: ({ metadata, clonePath, runBranch }) => [
      "Reconcile this run against the immutable Portfolio OS dispatch contract.",
      "",
      `Dispatch file: ${metadata.source_dispatch_path}`,
      `Dispatch hash: ${metadata.dispatch_hash}`,
      `Target clone: ${clonePath}`,
      `Expected run branch: ${runBranch}`,
      "",
      "Confirm that the dispatch has been ingested, the project metadata still matches the contract, the target repo remains on the run branch, and the seeded issues and approval links still exist.",
      "If drift appears, repair it or record the blocker precisely. Do not rewrite the dispatch artifact.",
      "",
      renderMetadataBlock({ ...metadata, routine_key: "dispatch-poller" }),
    ].join("\n"),
  },
  {
    key: "run-qa-sweep",
    title: "Run QA Sweep",
    assigneeName: "QA",
    priority: "high",
    cronExpression: "15 */4 * * *",
    triggerLabel: "Every 4 hours",
    parentIssueFunction: "QA",
    description: ({ payload, metadata }) => [
      "Run a QA sweep for the current Portfolio OS dispatch using gstack.",
      "",
      `Primary artifact: ${metadata.source_dispatch_path}`,
      payload.selection_snapshot_path ? `Selection snapshot: ${payload.selection_snapshot_path}` : "",
      payload.selection_snapshot?.artifacts?.scaffold_dir ? `Scaffold dir: ${payload.selection_snapshot.artifacts.scaffold_dir}` : "",
      "",
      "Use `/pos-run-qa` first, then use `/qa` or `/review` if the flow needs a narrower regression pass.",
      "Write `qa_report.md`, screenshots, and regression notes into the target repo or scaffold outputs for this run.",
      "",
      renderMetadataBlock({ ...metadata, routine_key: "run-qa-sweep" }),
    ].filter((line) => line !== "").join("\n"),
  },
  {
    key: "evidence-backfill-reconciler",
    title: "Evidence Backfill Reconciler",
    assigneeName: "Growth/Distribution",
    priority: "medium",
    cronExpression: "45 9,15,21 * * *",
    triggerLabel: "Three times daily",
    parentIssueFunction: "Marketing",
    description: ({ payload, metadata }) => [
      "Backfill any missing evidence that still blocks this run.",
      "",
      `Primary artifact: ${payload.selection_snapshot_path ?? metadata.source_dispatch_path}`,
      "Use `/pos-evidence-backfill` with the current dispatch or selection snapshot.",
      "Write `evidence_<run_id>.json` into Portfolio OS inbox and link any new citations back to the active work.",
      "",
      renderMetadataBlock({ ...metadata, routine_key: "evidence-backfill-reconciler" }),
    ].join("\n"),
  },
  {
    key: "release-gate-reconciler",
    title: "Release Gate Reconciler",
    assigneeName: "Release Manager",
    priority: "high",
    cronExpression: "0 */2 * * *",
    triggerLabel: "Every 2 hours",
    parentIssueFunction: "Release",
    description: ({ metadata, clonePath, runBranch, approvalId }) => [
      "Reconcile merge readiness, approval state, and ship discipline for this run.",
      "",
      `Target clone: ${clonePath}`,
      `Expected run branch: ${runBranch}`,
      `launch_execution approval: ${approvalId}`,
      "",
      "Inspect open implementation, QA, and evidence issues. Use `/review` before merge movement and `/ship` when the branch is ready to land.",
      "If merge or deploy remains blocked, record the exact blocker and approval status instead of claiming progress.",
      "",
      renderMetadataBlock({ ...metadata, routine_key: "release-gate-reconciler", approval_id: approvalId }),
    ].join("\n"),
  },
];

function deriveRoutineTitle(runId: string, title: string) {
  return `[run_id:${runId}] ${title}`;
}

async function ensureGstackSkillLinkFromFs(options?: {
  sourceDir?: string;
  linkPath?: string;
}) {
  const sourceDir = options?.sourceDir ?? process.env.PAPERCLIP_POS_GSTACK_DIR ?? DEFAULT_GSTACK_DIR;
  const linkPath = options?.linkPath ?? DEFAULT_GSTACK_SKILL_LINK;
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const existing = await fs.lstat(linkPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const target = await fs.realpath(linkPath).catch(() => null);
      if (target) return;
      await fs.unlink(linkPath).catch(() => {});
    } else {
      return;
    }
  }
  await fs.symlink(sourceDir, linkPath);
}

export async function ensureTargetRepoCloneAndRunBranch(input: {
  repoFullName: string;
  repoUrl: string;
  clonePathHint: string;
  baseBranch: string;
  runBranch: string;
}) {
  const clonePath = path.resolve(input.clonePathHint);
  const gitDir = path.join(clonePath, ".git");
  const exists = await fs.stat(clonePath).then(() => true).catch(() => false);
  if (!exists) {
    await fs.mkdir(path.dirname(clonePath), { recursive: true });
    await execFile("git", ["clone", input.repoUrl, clonePath]);
  } else {
    const hasGit = await fs.stat(gitDir).then((entry) => entry.isDirectory()).catch(() => false);
    if (!hasGit) {
      throw new Error(`Target clone path exists but is not a git checkout: ${clonePath}`);
    }
  }

  await execFile("git", ["-C", clonePath, "fetch", "origin"]);

  const localBranchExists = await execFile("git", ["-C", clonePath, "rev-parse", "--verify", input.runBranch])
    .then(() => true)
    .catch(() => false);
  if (localBranchExists) {
    await execFile("git", ["-C", clonePath, "checkout", input.runBranch]);
    return { clonePath, runBranch: input.runBranch };
  }

  const remoteBase = `origin/${input.baseBranch}`;
  const baseRefExists = await execFile("git", ["-C", clonePath, "rev-parse", "--verify", remoteBase])
    .then(() => true)
    .catch(() => false);
  await execFile("git", [
    "-C",
    clonePath,
    "checkout",
    "-b",
    input.runBranch,
    baseRefExists ? remoteBase : input.baseBranch,
  ]);
  return { clonePath, runBranch: input.runBranch };
}

async function readDispatchLedgerFromFs(ledgerPath: string) {
  const raw = await fs.readFile(ledgerPath, "utf8").catch(() => "{\"ingested\":{}}");
  try {
    return normalizeDispatchLedger(JSON.parse(raw));
  } catch {
    return { ingested: {} };
  }
}

async function writeDispatchLedgerToFs(ledgerPath: string, ledger: DispatchLedger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export async function ingestPortfolioDispatchFile(
  dispatchPath: string,
  deps: PortfolioDispatchIngestDeps,
): Promise<DispatchIngestResult> {
  const raw = await deps.readFile(dispatchPath);
  const dispatchHash = sha256(raw);
  const ledger = await deps.readDispatchLedger();
  const existingEntry = ledger.ingested[dispatchHash];
  if (existingEntry) {
    return {
      status: "skipped",
      dispatchHash,
      runId: existingEntry.runId,
      companyId: existingEntry.companyId,
      projectId: existingEntry.projectId,
      issueIds: existingEntry.issueIds,
      approvalIds: existingEntry.approvalIds,
    };
  }

  const payload = parseDispatchPayload(raw);
  const runId = payload.run_id!;
  const repoLocator = dispatchTargetLocator(payload);
  const targetRepoFullName = repoLocator.target_repo_full_name?.trim() || payload.target_repo_full_name!.trim();
  const targetRepoRef = repoLocator.target_repo_branch?.trim() || payload.target_repo_branch?.trim() || "main";
  const clonePathHint = repoLocator.target_repo_clone_path_hint?.trim()
    || payload.target_repo_clone_path_hint?.trim()
    || path.resolve("/Users/mnm/Documents/Github", targetRepoFullName.split("/").pop() ?? targetRepoFullName);
  const suggestedBranchName = repoLocator.suggested_branch_name?.trim() || `run/${runId}/bootstrap`;
  const repoUrl = normalizeRepoUrl(targetRepoFullName, repoLocator.repo_url);
  const selectionSnapshotHash = payload.selection_snapshot_hash?.trim() || sha256(JSON.stringify(payload.selection_snapshot ?? {}));
  const metadataContract = buildMetadataContract({
    runId,
    dispatchHash,
    selectionSnapshotHash,
    targetRepoFullName,
    targetRepoRef,
    suggestedBranchName,
    sourceDispatchPath: path.resolve(dispatchPath),
  });

  await deps.ensureGstackSkillLink();
  const clone = await deps.ensureRepoClone({
    repoFullName: targetRepoFullName,
    repoUrl,
    clonePathHint,
    baseBranch: targetRepoRef,
    runBranch: suggestedBranchName,
  });

  const companies = await deps.listCompanies();
  const companyName = deriveVentureCompanyName(targetRepoFullName);
  let company = companies.find((entry) => entry.name === companyName) ?? null;
  if (!company) {
    company = await deps.createCompany({
      name: companyName,
      description: `Autonomous venture company for ${targetRepoFullName}.`,
    });
  }

  const projects = await deps.listProjects(company.id);
  const projectName = deriveRunProjectName(runId, targetRepoFullName);
  let project = projects.find((entry) => entry.name === projectName) ?? null;
  if (!project) {
    project = await deps.createProject(company.id, {
      name: projectName,
      description: projectDescriptionFromDispatch({
        payload,
        metadata: metadataContract,
      }),
      status: "planned",
    });
  }

  const workspaceSpecs = [
    {
      name: "Target Repo",
      cwd: clone.clonePath,
      repoUrl,
      repoRef: suggestedBranchName,
      defaultRef: suggestedBranchName,
      isPrimary: true,
    },
    {
      name: "portfolio-os",
      cwd: payload.cockpit?.portfolio_os_dir?.trim() || DEFAULT_POS_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/portfolio-os.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
    {
      name: "paperclip",
      cwd: payload.cockpit?.paperclip_dir?.trim() || DEFAULT_PAPERCLIP_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/paperclip.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
    {
      name: "gstack",
      cwd: payload.cockpit?.gstack_dir?.trim() || DEFAULT_GSTACK_DIR,
      repoUrl: "https://github.com/g4mm4p4nd4/gstack.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: false,
    },
  ];
  const existingWorkspaces = project.workspaces ?? [];
  for (const workspace of workspaceSpecs) {
    const exists = existingWorkspaces.some((entry) => entry.cwd === workspace.cwd || entry.name === workspace.name);
    if (!exists) {
      await deps.createWorkspace(project.id, workspace);
    }
  }

  const agents = await deps.listAgents(company.id);
  const agentByName = new Map(agents.map((entry) => [entry.name, entry]));
  for (const blueprint of AGENT_BLUEPRINTS) {
    if (agentByName.has(blueprint.name)) continue;
    const managerId = blueprint.reportsTo ? agentByName.get(blueprint.reportsTo)?.id ?? null : null;
    const created = await deps.createAgent(company.id, {
      name: blueprint.name,
      role: blueprint.role,
      title: blueprint.title,
      reportsTo: managerId,
      capabilities: blueprint.capabilities,
      adapterType: "codex_local",
      adapterConfig: {
        cwd: clone.clonePath,
        model: DEFAULT_CODEX_LOCAL_MODEL,
        dangerouslyBypassApprovalsAndSandbox: DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
      },
      metadata: {
        portfolioDispatch: metadataContract,
        ventureTargetRepo: targetRepoFullName,
      },
    });
    agentByName.set(created.name, created);
  }

  const existingIssues = await deps.listIssues(company.id, project.id);
  const createdOrExistingIssues: PortfolioIssue[] = [];
  for (const [functionName, tasks] of taskGroupEntries(payload)) {
    const assigneeName = ISSUE_ASSIGNEE_BY_FUNCTION[functionName] ?? null;
    const assigneeId = assigneeName ? agentByName.get(assigneeName)?.id ?? null : null;
    for (const task of tasks) {
      const title = task.ticket_title?.trim() || `[run_id:${runId}] ${functionName}`;
      const existingIssue = existingIssues.find((issue) => issue.title === title);
      if (existingIssue) {
        createdOrExistingIssues.push(existingIssue);
        continue;
      }
      const issue = await deps.createIssue(company.id, {
        projectId: project.id,
        title,
        description: issueDescriptionFromTask({
          task,
          metadata: {
            ...metadataContract,
            functional_owner: functionName,
          },
        }),
        status: "todo",
        priority: functionName === "Engineer" || functionName === "Release" ? "high" : "medium",
        assigneeAgentId: assigneeId,
      });
      createdOrExistingIssues.push(issue);
      if (assigneeId) {
        await deps.wakeAgent(assigneeId, issue.id, project.id, runId, null);
      }
    }
  }

  const approvals = await deps.listApprovals(company.id);
  const existingApproval = approvals.find((approval) => {
    const payloadValue = approval.payload ?? {};
    return approval.type === "launch_execution" && payloadValue.run_id === runId;
  });
  const releaseIssueIds = createdOrExistingIssues
    .filter((issue) => issue.title.includes("Release"))
    .map((issue) => issue.id);
  const approval = existingApproval ?? await deps.createApproval(company.id, {
    type: "launch_execution",
    requestedByAgentId: agentByName.get("CEO")?.id ?? null,
    payload: {
      ...metadataContract,
      company_name: companyName,
      project_name: projectName,
    },
  });
  if (releaseIssueIds.length > 0) {
    await deps.linkApprovalToIssues(approval.id, releaseIssueIds);
  }

  const existingRoutines = (await deps.listRoutines(company.id))
    .filter((routine) => routine.projectId === project.id);
  const parentIssueByFunction = new Map<string, string>();
  for (const issue of createdOrExistingIssues) {
    for (const [functionName] of taskGroupEntries(payload)) {
      if (issue.title.includes(functionName) && !parentIssueByFunction.has(functionName)) {
        parentIssueByFunction.set(functionName, issue.id);
      }
    }
  }

  const provisionedRoutines: PortfolioRoutine[] = [];
  for (const blueprint of ROUTINE_BLUEPRINTS) {
    const title = deriveRoutineTitle(runId, blueprint.title);
    const assignee = agentByName.get(blueprint.assigneeName);
    if (!assignee) continue;

    let routine = existingRoutines.find((entry) => entry.title === title) ?? null;
    if (!routine) {
      routine = await deps.createRoutine(company.id, {
        projectId: project.id,
        title,
        description: blueprint.description({
          payload,
          metadata: metadataContract,
          clonePath: clone.clonePath,
          runBranch: suggestedBranchName,
          approvalId: approval.id,
        }),
        assigneeAgentId: assignee.id,
        priority: blueprint.priority,
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
        parentIssueId: blueprint.parentIssueFunction
          ? parentIssueByFunction.get(blueprint.parentIssueFunction) ?? null
          : null,
      });
    }

    const hasTrigger = routine.triggers.some(
      (trigger) => trigger.kind === "schedule" && trigger.label === blueprint.triggerLabel,
    );
    if (!hasTrigger) {
      await deps.createRoutineTrigger(routine.id, {
        kind: "schedule",
        label: blueprint.triggerLabel,
        enabled: true,
        cronExpression: blueprint.cronExpression,
        timezone: PORTFOLIO_ROUTINE_TIME_ZONE,
      });
    }
    provisionedRoutines.push(routine);
  }

  ledger.ingested[dispatchHash] = {
    dispatchHash,
    runId,
    selectionSnapshotHash,
    dispatchPath: path.resolve(dispatchPath),
    companyId: company.id,
    projectId: project.id,
    issueIds: createdOrExistingIssues.map((issue) => issue.id),
    approvalIds: [approval.id],
    routineIds: provisionedRoutines.map((routine) => routine.id),
    ingestedAt: new Date().toISOString(),
  };
  await deps.writeDispatchLedger(ledger);

  return {
    status: "ingested",
    dispatchHash,
    runId,
    companyId: company.id,
    projectId: project.id,
    issueIds: createdOrExistingIssues.map((issue) => issue.id),
    approvalIds: [approval.id],
    routineIds: provisionedRoutines.map((routine) => routine.id),
  };
}

function buildPortfolioDispatchDeps(db: Db, options?: {
  ledgerPath?: string;
  gstackDir?: string;
}) : PortfolioDispatchIngestDeps {
  const companies = companyService(db);
  const projects = projectService(db);
  const agents = agentService(db);
  const roleDefaults = agentRoleDefaultsService(db);
  const issues = issueService(db);
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);
  const heartbeat = heartbeatService(db);
  const routines = routineService(db);
  const ledgerPath = options?.ledgerPath ?? process.env.PAPERCLIP_POS_DISPATCH_LEDGER_PATH ?? DEFAULT_DISPATCH_LEDGER_PATH;
  const gstackDir = options?.gstackDir ?? process.env.PAPERCLIP_POS_GSTACK_DIR ?? DEFAULT_GSTACK_DIR;
  const workerLog = logger.child({ service: "portfolio-dispatch" });

  return {
    readFile: (pathValue) => fs.readFile(pathValue, "utf8"),
    readDispatchLedger: () => readDispatchLedgerFromFs(ledgerPath),
    writeDispatchLedger: (ledger) => writeDispatchLedgerToFs(ledgerPath, ledger),
    ensureGstackSkillLink: () => ensureGstackSkillLinkFromFs({ sourceDir: gstackDir }),
    ensureRepoClone: (input) => ensureTargetRepoCloneAndRunBranch(input),
    listCompanies: async () => {
      const rows = await companies.list();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? null,
      }));
    },
    createCompany: async (input) => {
      const row = await companies.create({
        name: input.name,
        description: input.description,
        status: "active",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
      });
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
      };
    },
    listProjects: async (companyId) => {
      const rows = await projects.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description ?? null,
        workspaces: row.workspaces?.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          repoUrl: workspace.repoUrl ?? null,
          repoRef: workspace.repoRef ?? null,
          isPrimary: workspace.isPrimary,
        })) ?? [],
      }));
    },
    createProject: async (companyId, input) => {
      const row = await projects.create(companyId, {
        name: input.name,
        description: input.description,
        status: input.status,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description ?? null,
        workspaces: row.workspaces?.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          repoUrl: workspace.repoUrl ?? null,
          repoRef: workspace.repoRef ?? null,
          isPrimary: workspace.isPrimary,
        })) ?? [],
      };
    },
    createWorkspace: async (projectId, input) => {
      await projects.createWorkspace(projectId, input);
    },
    listAgents: async (companyId) => {
      const rows = await agents.list(companyId, { includeTerminated: true });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        role: row.role,
        reportsTo: row.reportsTo ?? null,
      }));
    },
    createAgent: async (companyId, input) => {
      const desiredSkillAssignment = await roleDefaults.resolveDesiredSkillAssignment(
        companyId,
        input.role,
        input.adapterType,
        input.adapterConfig,
        undefined,
      );
      const row = await agents.create(companyId, {
        name: input.name,
        role: input.role,
        title: input.title,
        reportsTo: input.reportsTo,
        capabilities: input.capabilities,
        adapterType: input.adapterType,
        adapterConfig: desiredSkillAssignment.adapterConfig,
        budgetMonthlyCents: 0,
        metadata: input.metadata,
        status: "idle",
        spentMonthlyCents: 0,
        permissions: input.role === "ceo" ? { canCreateAgents: true } : undefined,
        lastHeartbeatAt: null,
      });
      const { agent } = await roleDefaults.materializeDefaultInstructionsBundleForAgent(row);
      return {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        role: agent.role,
        reportsTo: agent.reportsTo ?? null,
      };
    },
    listIssues: async (companyId, projectId) => {
      const rows = await issues.list(companyId, { projectId });
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        title: row.title,
      }));
    },
    createIssue: async (companyId, input) => {
      const row = await issues.create(companyId, {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId ?? null,
        title: row.title,
      };
    },
    listApprovals: async (companyId) => {
      const rows = await approvals.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        type: row.type,
        status: row.status,
        payload: (row.payload as Record<string, unknown>) ?? {},
      }));
    },
    createApproval: async (companyId, input) => {
      const row = await approvals.create(companyId, {
        type: input.type,
        requestedByAgentId: input.requestedByAgentId,
        payload: input.payload,
      });
      return {
        id: row.id,
        companyId: row.companyId,
        type: row.type,
        status: row.status,
        payload: (row.payload as Record<string, unknown>) ?? {},
      };
    },
    linkApprovalToIssues: async (approvalId, issueIds) => {
      if (issueIds.length === 0) return;
      await issueApprovals.linkManyForApproval(approvalId, issueIds);
    },
    listRoutines: async (companyId) => {
      const rows = await routines.list(companyId);
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId,
        title: row.title,
        triggers: (row.triggers ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled,
        })),
      }));
    },
    createRoutine: async (companyId, input) => {
      const row = await routines.create(companyId, {
        projectId: input.projectId,
        parentIssueId: input.parentIssueId ?? null,
        title: input.title,
        description: input.description,
        assigneeAgentId: input.assigneeAgentId,
        priority: input.priority,
        status: input.status,
        concurrencyPolicy: input.concurrencyPolicy,
        catchUpPolicy: input.catchUpPolicy,
        variables: input.variables,
      }, {});
      return {
        id: row.id,
        companyId: row.companyId,
        projectId: row.projectId,
        title: row.title,
        triggers: [],
      };
    },
    createRoutineTrigger: async (routineId, input) => {
      await routines.createTrigger(routineId, {
        kind: input.kind,
        label: input.label,
        enabled: input.enabled,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
      }, {});
    },
    wakeAgent: async (agentId, issueId, projectId, runId) => {
      await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: "portfolio_dispatch_ingest",
        requestedByActorType: "system",
        requestedByActorId: "portfolio_dispatch",
        contextSnapshot: {
          issueId,
          projectId,
          runId,
          source: "portfolio_dispatch",
        },
        payload: {
          issueId,
          projectId,
          runId,
          source: "portfolio_dispatch",
        },
      });
    },
    logInfo: (message, details) => workerLog.info(details ?? {}, message),
    logWarn: (message, details) => workerLog.warn(details ?? {}, message),
    logError: (message, details) => workerLog.error(details ?? {}, message),
  };
}

export function createPortfolioDispatchIngestWorker(db: Db, options?: {
  outboxDir?: string;
  pollIntervalMs?: number;
  ledgerPath?: string;
  gstackDir?: string;
}) {
  const enabled = process.env.PAPERCLIP_POS_DISPATCH_INGEST_ENABLED !== "false";
  const outboxDir = options?.outboxDir ?? process.env.PAPERCLIP_POS_DISPATCH_OUTBOX ?? DEFAULT_DISPATCH_OUTBOX;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_DISPATCH_POLL_INTERVAL_MS;
  const deps = buildPortfolioDispatchDeps(db, options);
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tickOnce = async () => {
    if (!enabled || running) return [];
    running = true;
    try {
      const entries = await fs.readdir(outboxDir, { withFileTypes: true }).catch(() => []);
      const dispatchFiles = entries
        .filter((entry) => entry.isFile() && /^dispatch_.*\.json$/i.test(entry.name))
        .map((entry) => path.resolve(outboxDir, entry.name))
        .sort();
      const results: DispatchIngestResult[] = [];
      for (const dispatchPath of dispatchFiles) {
        try {
          const result = await ingestPortfolioDispatchFile(dispatchPath, deps);
          results.push(result);
          if (result.status === "ingested") {
            deps.logInfo("portfolio dispatch ingested", {
              dispatchPath,
              runId: result.runId,
              companyId: result.companyId,
              projectId: result.projectId,
            });
          }
        } catch (error) {
          deps.logError("portfolio dispatch ingest failed", {
            dispatchPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    } finally {
      running = false;
    }
  };

  return {
    enabled,
    start() {
      if (!enabled || timer) return;
      void tickOnce();
      timer = setInterval(() => {
        void tickOnce();
      }, pollIntervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tickOnce,
  };
}
