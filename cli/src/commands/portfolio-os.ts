import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

const DEFAULT_PORTFOLIO_OS_ROOT = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_HERMES_BIN = "/Users/mnm/Documents/Github/Hermes-Agent/bin/hermes";
const DEFAULT_COMPANY_NAME = "Portfolio Ventures Lab";
const HERMES_TASK_BUNDLE_SCHEMA_VERSION = "pos.hermes_task_bundle.v1";
const PAPERCLIP_CONTEXT_SCHEMA_VERSION = "paperclip.portfolio_os_context.v1";
const PAPERCLIP_EXECUTION_SCHEMA_VERSION = "paperclip.portfolio_os_execution.v1";
const FORBIDDEN_OPERATIONS = ["delete_repo", "rewrite_history", "remove_license", "commit_secrets"];

type JsonObject = Record<string, unknown>;

interface PortfolioOsOptions {
  portfolioRoot?: string;
  mandatePath?: string;
  companyName?: string;
  hermesBin?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNumberLike(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asPipeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value.split("|").map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return [];
}

function internetPipesFromOpportunity(opportunity: JsonObject): JsonObject {
  const nested = asObject(opportunity.internet_pipes);
  const source = Object.keys(nested).length > 0 ? nested : opportunity;
  return {
    score: Math.round(asNumberLike(source.score ?? source.internet_pipes_score) * 100) / 100,
    readiness: asString(source.readiness ?? source.internet_pipes_readiness),
    missing_stations: asPipeStringArray(source.missing_stations ?? source.internet_pipes_missing_stations),
    recommendations: asPipeStringArray(source.recommendations ?? source.internet_pipes_recommendations),
  };
}

function internetPipesTaskContext(opportunity: JsonObject): string {
  const internetPipes = internetPipesFromOpportunity(opportunity);
  const score = asNumberLike(internetPipes.score);
  const readiness = asString(internetPipes.readiness) || "unscored";
  const missingStations = asPipeStringArray(internetPipes.missing_stations);
  const recommendations = asPipeStringArray(internetPipes.recommendations);
  if (score <= 0 && readiness === "unscored" && missingStations.length === 0 && recommendations.length === 0) {
    return "";
  }
  const missingLabel = missingStations.length > 0 ? missingStations.join(", ") : "none";
  const nextStep = recommendations[0] || "preserve current proof chain";
  return `Internet Pipes completeness: score=${score.toFixed(2)}, readiness=${readiness}, missing_stations=${missingLabel}, next_station_work=${nextStep}.`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "portfolio-os";
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath: string): JsonObject {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Expected JSON object at ${filePath}`);
  }
  return payload as JsonObject;
}

function writeJson(filePath: string, payload: JsonObject): string {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function resolvePortfolioRoot(options: PortfolioOsOptions): string {
  return path.resolve(options.portfolioRoot || process.env.PORTFOLIO_OS_ROOT || DEFAULT_PORTFOLIO_OS_ROOT);
}

function defaultMandatePath(portfolioRoot: string): string {
  return path.join(portfolioRoot, "data", "execution_mandate.json");
}

function contextPath(portfolioRoot: string, runId: string): string {
  return path.join(portfolioRoot, "data", "paperclip_context", `${runId}.json`);
}

function latestContextPath(portfolioRoot: string): string {
  return path.join(portfolioRoot, "data", "paperclip_context", "latest.json");
}

function bundlePath(portfolioRoot: string, runId: string): string {
  return path.join(portfolioRoot, "data", "hermes_task_bundles", `${runId}.json`);
}

function seedBundlePath(portfolioRoot: string): string {
  return path.join(portfolioRoot, "data", "hermes_task_bundle.seed.json");
}

function paperclipExecutionPath(portfolioRoot: string, runId: string): string {
  return path.join(portfolioRoot, "data", "execution_results", `${runId}.paperclip.json`);
}

function hermesResultPath(portfolioRoot: string, runId: string): string {
  return path.join(portfolioRoot, "data", "hermes_results", `${runId}.json`);
}

function requireRunId(mandate: JsonObject): string {
  const runId = asString(asObject(mandate.run).run_id).trim();
  if (!runId) {
    throw new Error("Execution mandate is missing run.run_id");
  }
  return runId;
}

function requireMandateType(mandate: JsonObject): string {
  const mandateType = asString(asObject(mandate.mandate).mandate_type).trim();
  if (!mandateType) {
    throw new Error("Execution mandate is missing mandate.mandate_type");
  }
  return mandateType;
}

function validateExecutionMandate(mandate: JsonObject): string[] {
  const errors: string[] = [];
  if (mandate.schema_version !== "pos.execution_mandate.v1") {
    errors.push("schema_version must equal pos.execution_mandate.v1");
  }
  if (!asString(asObject(mandate.run).run_id).trim()) {
    errors.push("run.run_id is required");
  }
  if (!asString(asObject(mandate.target).repo_full_name).trim()) {
    errors.push("target.repo_full_name is required");
  }
  if (!asString(asObject(mandate.mandate).mandate_type).trim()) {
    errors.push("mandate.mandate_type is required");
  }
  return errors;
}

function validateHermesTaskBundle(bundle: JsonObject): string[] {
  const errors: string[] = [];
  if (bundle.schema_version !== HERMES_TASK_BUNDLE_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${HERMES_TASK_BUNDLE_SCHEMA_VERSION}`);
  }
  if (!asString(asObject(bundle.run).run_id).trim()) {
    errors.push("run.run_id is required");
  }
  if (!asString(asObject(bundle.target).repo_full_name).trim()) {
    errors.push("target.repo_full_name is required");
  }
  if (!asString(asObject(bundle.target).local_repo_path).trim()) {
    errors.push("target.local_repo_path is required");
  }
  const tasks = Array.isArray(bundle.tasks) ? bundle.tasks : [];
  if (tasks.length === 0) {
    errors.push("tasks must not be empty");
  }
  const seen = new Set<string>();
  for (const [index, rawTask] of tasks.entries()) {
    const task = asObject(rawTask);
    const id = asString(task.id).trim();
    if (!id) {
      errors.push(`tasks[${index}].id is required`);
    } else if (seen.has(id)) {
      errors.push(`duplicate task id: ${id}`);
    }
    seen.add(id);
    const taskText = stableJson(task).toLowerCase();
    for (const forbidden of FORBIDDEN_OPERATIONS) {
      if (taskText.includes(forbidden)) {
        errors.push(`tasks[${index}] references forbidden operation ${forbidden}`);
      }
    }
  }
  const safety = asObject(bundle.safety);
  if (safety.destructive_ops_allowed !== false) {
    errors.push("safety.destructive_ops_allowed must be false");
  }
  if (safety.secrets_scan_required !== true) {
    errors.push("safety.secrets_scan_required must be true");
  }
  for (const forbidden of FORBIDDEN_OPERATIONS) {
    if (!asStringArray(safety.forbidden_operations).includes(forbidden)) {
      errors.push(`safety.forbidden_operations missing ${forbidden}`);
    }
  }
  const outputs = asObject(bundle.outputs);
  for (const key of ["result_path", "patch_plan_path", "execution_log_path"]) {
    if (!asString(outputs[key]).trim()) {
      errors.push(`outputs.${key} is required`);
    }
  }
  return errors;
}

function task(
  id: string,
  title: string,
  type: string,
  instructions: string,
  priority: number,
  filesExpected: string[],
  assignedRole: string,
  acceptanceCriteria: string[],
): JsonObject {
  return {
    id,
    title,
    type,
    instructions,
    files_expected: filesExpected,
    acceptance_criteria: acceptanceCriteria,
    dependencies: [],
    priority,
    assigned_role: assignedRole,
    assigned_agent: assignedRole === "Hermes Execution Adapter" ? "hermes-agent" : `paperclip-${slug(assignedRole)}`,
  };
}

function tasksForMandate(mandateType: string, target: JsonObject, opportunity: JsonObject): JsonObject[] {
  const repo = asString(target.repo_full_name, "target repo");
  const niche = asString(opportunity.niche, "the frozen niche") || "the frozen niche";
  const wedge = asString(opportunity.strongest_wedge, "the strongest frozen wedge") || "the strongest frozen wedge";
  const internetPipesContext = internetPipesTaskContext(opportunity);
  const tasks: JsonObject[] = [
    task(
      "business-plan",
      "Write the commercialization business plan",
      "business_plan",
      `Create a concise business plan for ${repo} around ${wedge} for ${niche}. Preserve existing repo content.`,
      10,
      ["docs/business_plan.md"],
      "CEO / Operator",
      ["Plan states confidence, assumptions, missing evidence, and stop/go criteria plainly."],
    ),
    task(
      "validation-plan",
      "Create the validation sprint plan",
      "validation_plan",
      "Define buyer validation actions, evidence gaps, acceptance criteria, and the smallest measurable proof sprint."
        + (internetPipesContext ? ` ${internetPipesContext}` : ""),
      20,
      ["docs/validation_plan.md"],
      "Product Manager",
      ["Plan includes concrete validation actions and measurable acceptance criteria."],
    ),
    task(
      "landing-copy",
      "Draft the landing page copy",
      "landing_page",
      `Draft evidence-qualified landing copy for ${niche}; do not overstate unvalidated claims.`,
      30,
      ["docs/landing_page_copy.md"],
      "Copywriter",
      ["Copy includes headline, offer, proof, CTA, and evidence caveats."],
    ),
    task(
      "pricing",
      "Draft the pricing hypothesis",
      "pricing",
      "Create a pricing hypothesis with plan boundaries, validation questions, and explicit assumptions.",
      40,
      ["docs/pricing.md"],
      "Finance / Pricing Strategist",
      ["Pricing distinguishes facts from assumptions."],
    ),
    task(
      "trust-packet",
      "Create the trust packet",
      "trust_packet",
      "Create proof, safety, credibility, and delivery-risk notes for buyer review."
        + (internetPipesContext ? ` ${internetPipesContext}` : ""),
      50,
      ["docs/trust_packet.md"],
      "GTM Lead",
      ["Trust packet records proof assets and missing proof plainly."],
    ),
    task(
      "readme-value",
      "Append README business value section",
      "README",
      "Append, do not overwrite, a business-value section that makes the repo easier to evaluate commercially.",
      60,
      ["README.md"],
      "Engineering Lead",
      ["Existing README content is preserved."],
    ),
    task(
      "qa",
      "Verify changed artifacts",
      "QA",
      "Run available tests/builds when practical and record verification in the Hermes result artifact."
        + (internetPipesContext ? " Confirm Internet Pipes station blockers are either resolved or recorded as explicit release blockers." : ""),
      90,
      [],
      "QA / Launch Readiness",
      ["Verification result is recorded with exact command status."],
    ),
  ];

  if (mandateType === "launch_execution") {
    tasks.splice(
      3,
      0,
      task(
        "proof-feature",
        "Ship the smallest safe proof feature",
        "code_change",
        "If the framework and safe change are detectable, implement the smallest proof feature. Otherwise write docs/issue_plan.md with exact implementation steps.",
        35,
        ["docs/issue_plan.md"],
        "Engineering Lead",
        ["A safe proof feature or exact issue plan exists."],
      ),
    );
  } else {
    tasks.splice(
      4,
      0,
      task(
        "gtm-strategy",
        "Draft GTM validation motion",
        "GTM",
        "Create the validation-channel plan, outreach angle, ICP, and buyer-language checklist.",
        45,
        ["docs/gtm_strategy.md"],
        "Growth Marketer",
        ["GTM plan includes channel, persona, and evidence capture loop."],
      ),
    );
  }

  return tasks;
}

export function buildPaperclipContext(
  mandate: JsonObject,
  options: PortfolioOsOptions = {},
): JsonObject {
  const runId = requireRunId(mandate);
  const target = asObject(mandate.target);
  const mandateInfo = asObject(mandate.mandate);
  const opportunity = asObject(mandate.opportunity);
  const companyName = options.companyName || process.env.PAPERCLIP_COMPANY_NAME || DEFAULT_COMPANY_NAME;
  const repoFullName = asString(target.repo_full_name);
  const repoSlug = slug(repoFullName.split("/").pop() || repoFullName || runId);
  const mandateType = requireMandateType(mandate);
  const companyId = deterministicId("company", companyName);
  const projectId = deterministicId("project", runId, repoFullName, mandateType);
  const workstreamId = deterministicId("workstream", runId, repoFullName, "execution");
  const paperclipExecutionId = deterministicId("pc-exec", runId, repoFullName, stableHash(mandate).slice(0, 16));
  const internetPipes = internetPipesFromOpportunity(opportunity);
  const roles = [
    "CEO / Operator",
    "Product Manager",
    "Engineering Lead",
    "Copywriter",
    "Finance / Pricing Strategist",
    "Growth Marketer",
    "GTM Lead",
    "QA / Launch Readiness",
    "Hermes Execution Adapter",
  ];
  const issueIds = roles.map((role) => deterministicId("issue", runId, repoFullName, role));
  const roleAssignments = Object.fromEntries(
    roles.map((role) => [role, role === "Hermes Execution Adapter" ? "hermes-agent" : `paperclip-${slug(role)}`]),
  );
  return {
    schema_version: PAPERCLIP_CONTEXT_SCHEMA_VERSION,
    generated_at: nowIso(),
    run_id: runId,
    paperclip_execution_id: paperclipExecutionId,
    company_id: companyId,
    company_name: companyName,
    project_id: projectId,
    project_name: `${repoSlug} commercialization sprint`,
    workstream_id: workstreamId,
    workstream_ids: [workstreamId],
    issue_ids: issueIds,
    approval_ids: [],
    role_assignments: roleAssignments,
    roles: roles.map((role, index) => ({
      role,
      agent: roleAssignments[role],
      issue_id: issueIds[index],
    })),
    mandate: {
      type: mandateType,
      evidence_gate_status: asString(mandateInfo.evidence_gate_status, "unknown"),
      launch_gates_clear: mandateInfo.launch_gates_clear === true,
      blockers: asStringArray(mandateInfo.blockers),
    },
    target: {
      repo_full_name: repoFullName,
      local_repo_path: asString(target.local_repo_path),
      working_branch: asString(target.working_branch),
    },
    opportunity: {
      niche: asString(opportunity.niche),
      strongest_wedge: asString(opportunity.strongest_wedge),
      missing_evidence: asStringArray(opportunity.missing_evidence),
      internet_pipes: internetPipes,
    },
    next_action:
      mandateType === "launch_execution"
        ? "Plan and dispatch Hermes launch execution."
        : "Plan and dispatch Hermes validation sprint while preserving evidence caveats.",
  };
}

export function ingestMandate(options: PortfolioOsOptions = {}): JsonObject {
  const portfolioRoot = resolvePortfolioRoot(options);
  const mandateFile = path.resolve(options.mandatePath || defaultMandatePath(portfolioRoot));
  const mandate = readJson(mandateFile);
  const errors = validateExecutionMandate(mandate);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  const runId = requireRunId(mandate);
  const context = {
    ...buildPaperclipContext(mandate, options),
    source_mandate_path: mandateFile,
    portfolio_os_root: portfolioRoot,
  };
  writeJson(contextPath(portfolioRoot, runId), context);
  writeJson(latestContextPath(portfolioRoot), context);
  return context;
}

export function buildHermesTaskBundle(
  mandate: JsonObject,
  context: JsonObject,
  portfolioRoot: string,
): JsonObject {
  const runId = requireRunId(mandate);
  const run = asObject(mandate.run);
  const target = asObject(mandate.target);
  const mandateInfo = asObject(mandate.mandate);
  const opportunity = asObject(mandate.opportunity);
  const policy = asObject(mandate.policy);
  const writePolicy = asObject(policy.write_policy);
  const pushPolicy = asObject(policy.push_policy);
  const mandateType = requireMandateType(mandate);
  const internetPipes = internetPipesFromOpportunity(opportunity);
  return {
    schema_version: HERMES_TASK_BUNDLE_SCHEMA_VERSION,
    run: {
      run_id: runId,
      generated_at: nowIso(),
      portfolio_os_commit: asString(run.portfolio_os_commit),
      paperclip_execution_id: asString(context.paperclip_execution_id),
      snapshot_hash: asString(run.snapshot_hash),
      mandate_hash: stableHash(mandate),
      execution_mandate_hash: asString(run.execution_mandate_hash),
    },
    target: {
      repo_full_name: asString(target.repo_full_name),
      local_repo_path: asString(target.local_repo_path),
      default_branch: asString(target.default_branch, "main") || "main",
      working_branch: asString(target.working_branch, `run/${runId}/portfolio-os-flywheel`),
      write_policy: {
        direct_main_allowed: writePolicy.direct_main_allowed === true,
        branch_then_pr: writePolicy.branch_then_pr !== false,
        local_only: writePolicy.local_only === true,
      },
      push_policy: {
        push_to_origin: pushPolicy.push_to_origin !== false,
        create_pr: pushPolicy.create_pr !== false,
        no_push: pushPolicy.no_push === true,
      },
    },
    opportunity: {
      mandate_type: mandateType,
      niche: asString(opportunity.niche),
      persona: asString(opportunity.persona),
      industry: asString(opportunity.industry),
      region: asString(opportunity.region),
      strongest_wedge: asString(opportunity.strongest_wedge),
      paired_repos: asStringArray(opportunity.paired_repos),
      evidence_gate_status: asString(mandateInfo.evidence_gate_status),
      internet_pipes: internetPipes,
    },
    paperclip: {
      company_id: asString(context.company_id),
      company_name: asString(context.company_name, DEFAULT_COMPANY_NAME),
      project_id: asString(context.project_id),
      project_name: asString(context.project_name),
      workstream_id: asString(context.workstream_id),
      workstream_ids: asStringArray(context.workstream_ids),
      issue_ids: asStringArray(context.issue_ids),
      approval_ids: asStringArray(context.approval_ids),
      role_assignments: asObject(context.role_assignments),
    },
    team: {
      company_name: asString(context.company_name, DEFAULT_COMPANY_NAME),
      project_name: asString(context.project_name),
      workstream_id: asString(context.workstream_id),
      assigned_role: "Hermes Execution Adapter",
      assigned_agent: "hermes-agent",
      paperclip_issue_id: asStringArray(context.issue_ids)[0] || "",
      paperclip_approval_id: asStringArray(context.approval_ids)[0] || "",
    },
    tasks: tasksForMandate(mandateType, target, opportunity),
    evidence: {
      market_signal_ids: asStringArray(opportunity.market_signal_ids),
      voc_ids: asStringArray(opportunity.voc_ids),
      proof_links: [],
      missing_evidence: asStringArray(opportunity.missing_evidence),
      confidence: asNumber(mandateInfo.commercialization_confidence),
      gate_status: asString(mandateInfo.evidence_gate_status),
      internet_pipes: internetPipes,
    },
    gstack: {
      evidence_backfill_path: path.join(portfolioRoot, "data", "gstack_results", `${runId}.evidence_backfill.json`),
      qa_verification_path: path.join(portfolioRoot, "data", "gstack_results", `${runId}.qa_verification.json`),
      patch_plan_path: path.join(portfolioRoot, "data", "gstack_results", `${runId}.patch_plan.json`),
    },
    safety: {
      forbidden_operations: FORBIDDEN_OPERATIONS,
      secrets_scan_required: true,
      destructive_ops_allowed: false,
    },
    outputs: {
      result_path: hermesResultPath(portfolioRoot, runId),
      patch_plan_path: path.join(portfolioRoot, "data", "hermes_patch_plans", `${runId}.json`),
      execution_log_path: path.join(portfolioRoot, "data", "hermes_logs", `${runId}.log`),
      files_changed: [],
      commit_sha: "",
      pushed_to_origin: false,
      qa_status: "pending",
      blockers: [],
      next_actions: [],
    },
  };
}

export function planHermes(options: PortfolioOsOptions & { runId?: string } = {}): JsonObject {
  const portfolioRoot = resolvePortfolioRoot(options);
  const mandateFile = path.resolve(options.mandatePath || defaultMandatePath(portfolioRoot));
  const mandate = readJson(mandateFile);
  const runId = options.runId || requireRunId(mandate);
  if (runId !== requireRunId(mandate)) {
    throw new Error(`run id ${runId} does not match mandate run id ${requireRunId(mandate)}`);
  }
  const contextFile = contextPath(portfolioRoot, runId);
  const context = fs.existsSync(contextFile) ? readJson(contextFile) : ingestMandate({ ...options, portfolioRoot });
  const bundle = buildHermesTaskBundle(mandate, context, portfolioRoot);
  const errors = validateHermesTaskBundle(bundle);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  writeJson(bundlePath(portfolioRoot, runId), bundle);
  writeJson(seedBundlePath(portfolioRoot), bundle);
  return bundle;
}

export function executeHermes(options: PortfolioOsOptions & { runId: string }): JsonObject {
  const portfolioRoot = resolvePortfolioRoot(options);
  const runId = options.runId;
  const bundleFile = bundlePath(portfolioRoot, runId);
  if (!fs.existsSync(bundleFile)) {
    throw new Error(`Missing Hermes task bundle: ${bundleFile}`);
  }
  const hermesBin = path.resolve(options.hermesBin || process.env.HERMES_BIN || DEFAULT_HERMES_BIN);
  const startedAt = nowIso();
  let status = "dispatch_pending";
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let blockers: string[] = [];
  if (!fs.existsSync(hermesBin)) {
    blockers = [`Hermes binary missing: ${hermesBin}`];
  } else {
    const proc = spawnSync(hermesBin, ["portfolio-os", "dispatch", "--bundle", bundleFile], {
      encoding: "utf8",
      cwd: path.dirname(hermesBin),
    });
    stdout = proc.stdout || "";
    stderr = proc.stderr || "";
    exitCode = typeof proc.status === "number" ? proc.status : null;
    if (proc.error) {
      status = "failed";
      blockers = [proc.error.message];
    } else if (proc.status === 0) {
      status = fs.existsSync(hermesResultPath(portfolioRoot, runId)) ? "completed" : "completed_without_result";
      if (status === "completed_without_result") {
        blockers = [`Hermes exited successfully but did not write ${hermesResultPath(portfolioRoot, runId)}`];
      }
    } else {
      status = "failed";
      blockers = [(stderr || stdout || `Hermes exited with ${proc.status}`).trim()];
    }
  }
  const artifact = {
    schema_version: PAPERCLIP_EXECUTION_SCHEMA_VERSION,
    generated_at: nowIso(),
    started_at: startedAt,
    run_id: runId,
    status,
    hermes_bin: hermesBin,
    bundle_path: bundleFile,
    hermes_result_path: hermesResultPath(portfolioRoot, runId),
    stdout,
    stderr,
    exit_code: exitCode,
    blockers,
    next_action:
      status === "completed"
        ? "Ingest Hermes result into Portfolio-OS reports."
        : "Resolve dispatch blocker, then rerun paperclipai portfolio-os execute.",
  };
  writeJson(paperclipExecutionPath(portfolioRoot, runId), artifact);
  return artifact;
}

export function statusForRun(options: PortfolioOsOptions & { runId: string }): JsonObject {
  const portfolioRoot = resolvePortfolioRoot(options);
  const runId = options.runId;
  const contextFile = contextPath(portfolioRoot, runId);
  const bundleFile = bundlePath(portfolioRoot, runId);
  const executionFile = paperclipExecutionPath(portfolioRoot, runId);
  const hermesFile = hermesResultPath(portfolioRoot, runId);
  const context = fs.existsSync(contextFile) ? readJson(contextFile) : {};
  const execution = fs.existsSync(executionFile) ? readJson(executionFile) : {};
  const hermesResult = fs.existsSync(hermesFile) ? readJson(hermesFile) : {};
  const status = asString(execution.status) || asString(hermesResult.status) || (fs.existsSync(bundleFile) ? "planned" : "missing");
  return {
    schema_version: "paperclip.portfolio_os_status.v1",
    generated_at: nowIso(),
    run_id: runId,
    status,
    company: {
      id: asString(context.company_id),
      name: asString(context.company_name),
    },
    project: {
      id: asString(context.project_id),
      name: asString(context.project_name),
    },
    workstreams: asStringArray(context.workstream_ids),
    issues: asStringArray(context.issue_ids),
    approvals: asStringArray(context.approval_ids),
    hermes: {
      bundle_path: bundleFile,
      bundle_exists: fs.existsSync(bundleFile),
      result_path: hermesFile,
      result_exists: fs.existsSync(hermesFile),
      result_status: asString(hermesResult.status),
    },
    paperclip_execution: {
      path: executionFile,
      exists: fs.existsSync(executionFile),
      status: asString(execution.status),
      blockers: asStringArray(execution.blockers),
    },
    next_action: nextActionForStatus(status, fs.existsSync(contextFile), fs.existsSync(bundleFile)),
  };
}

function nextActionForStatus(status: string, hasContext: boolean, hasBundle: boolean): string {
  if (!hasContext) {
    return "Run paperclipai portfolio-os ingest --mandate <path>.";
  }
  if (!hasBundle) {
    return "Run paperclipai portfolio-os plan-hermes --run-id <run_id>.";
  }
  if (status === "completed") {
    return "Run Portfolio-OS ingest-hermes-results to update reports and dashboard.";
  }
  return "Run paperclipai portfolio-os execute --run-id <run_id>.";
}

function printJson(payload: JsonObject, json = false): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

export function registerPortfolioOsCommands(program: Command): void {
  const command = program
    .command("portfolio-os")
    .description("Bridge Portfolio-OS mandates into Paperclip context and Hermes execution bundles");

  command
    .command("ingest")
    .description("Ingest a Portfolio-OS execution mandate into deterministic Paperclip context")
    .requiredOption("--mandate <path>", "Portfolio-OS execution mandate path")
    .option("--portfolio-root <path>", "Portfolio-OS repository root", DEFAULT_PORTFOLIO_OS_ROOT)
    .option("--company-name <name>", "Paperclip company name", DEFAULT_COMPANY_NAME)
    .option("--json", "Print JSON output", false)
    .action((opts) => {
      printJson(
        ingestMandate({
          mandatePath: opts.mandate,
          portfolioRoot: opts.portfolioRoot,
          companyName: opts.companyName,
        }),
        opts.json,
      );
    });

  command
    .command("plan-hermes")
    .description("Create the Hermes task bundle for a Portfolio-OS run")
    .requiredOption("--run-id <runId>", "Portfolio-OS run id")
    .option("--mandate <path>", "Portfolio-OS execution mandate path")
    .option("--portfolio-root <path>", "Portfolio-OS repository root", DEFAULT_PORTFOLIO_OS_ROOT)
    .option("--json", "Print JSON output", false)
    .action((opts) => {
      printJson(planHermes({ runId: opts.runId, mandatePath: opts.mandate, portfolioRoot: opts.portfolioRoot }), opts.json);
    });

  command
    .command("execute")
    .description("Dispatch the run's Hermes task bundle through the Hermes adapter")
    .requiredOption("--run-id <runId>", "Portfolio-OS run id")
    .option("--portfolio-root <path>", "Portfolio-OS repository root", DEFAULT_PORTFOLIO_OS_ROOT)
    .option("--hermes-bin <path>", "Hermes adapter binary", DEFAULT_HERMES_BIN)
    .option("--json", "Print JSON output", false)
    .action((opts) => {
      printJson(executeHermes({ runId: opts.runId, portfolioRoot: opts.portfolioRoot, hermesBin: opts.hermesBin }), opts.json);
    });

  command
    .command("status")
    .description("Print Paperclip/Hermes status for a Portfolio-OS run")
    .requiredOption("--run-id <runId>", "Portfolio-OS run id")
    .option("--portfolio-root <path>", "Portfolio-OS repository root", DEFAULT_PORTFOLIO_OS_ROOT)
    .option("--json", "Print JSON output", false)
    .action((opts) => {
      printJson(statusForRun({ runId: opts.runId, portfolioRoot: opts.portfolioRoot }), opts.json);
    });
}
