import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/agent-mission-performance/runs";
const DEFAULT_HTML_OUT = "/Users/mnm/Documents/Github/paperclip/docs/reports/agent-mission-performance-dashboard.html";
const DEFAULT_MARKDOWN_OUT = "/Users/mnm/Documents/Github/paperclip/docs/reports/agent-mission-performance-deep-dive.md";
const VERSION = "agent-mission-performance-trace.v1";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MIN_AGENTS_PER_COMPANY = 6;

type JsonRecord = Record<string, unknown>;
type Db = ReturnType<typeof createDb>;
type DbWithClient = Db & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type CompanyRow = {
  id: string;
  name: string;
  description: string | null;
  issue_prefix: string | null;
  budget_monthly_cents: number | string | null;
  spent_monthly_cents: number | string | null;
};

export type AgentCandidate = {
  id: string;
  company_id: string;
  company_name: string;
  issue_prefix: string | null;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapter_type: string;
  last_heartbeat_at: Date | string | null;
  desired_skill_count: number | string | null;
  recent_runs: number | string | null;
  failed_runs: number | string | null;
  process_lost_runs: number | string | null;
  adapter_failed_runs: number | string | null;
  succeeded_runs: number | string | null;
  open_assigned_issues: number | string | null;
  blocked_assigned_issues: number | string | null;
  stale_in_progress_issues: number | string | null;
  completed_issues: number | string | null;
  ledger_entries: number | string | null;
  explicit_dispositions: number | string | null;
  default_success_dispositions: number | string | null;
  blocked_dispositions: number | string | null;
  verbose_unjustified: number | string | null;
  compact_success: number | string | null;
  missing_skill_budget_runs: number | string | null;
  raw_tokens: number | string | null;
  cost_cents: number | string | null;
  last_run_at: Date | string | null;
  latest_failure: string | null;
};

type GoalRow = {
  slug: string | null;
  title: string;
  status: string;
  level: string;
  owner_agent_name: string | null;
};

type ProjectRow = {
  name: string;
  status: string;
  lead_agent_name: string | null;
};

type IssueStatusRow = {
  status: string;
  count: number | string;
};

type RunDetail = {
  run_id: string;
  status: string;
  error_code: string | null;
  issue_identifier: string | null;
  issue_status: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_seconds: number | string | null;
  provider: string | null;
  model: string | null;
  raw_tokens: number | string | null;
  cost_cents: number | string | null;
  prompt_class: string | null;
  response_class: string | null;
  disposition_source: string | null;
  disposition_classification: string | null;
  final_outcome: string | null;
  final_blocker: string | null;
  skill_selected_count: number | string | null;
  skill_skipped_count: number | string | null;
  command: string | null;
  skipped_flags: string[] | null;
};

type IssueDetail = {
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updated_at: Date | string | null;
  age_days: number | string | null;
};

type CommentDetail = {
  issue_identifier: string | null;
  body_excerpt: string;
  created_at: Date | string | null;
};

type ProblemCode =
  | "hermes_cli_flag_incompatibility"
  | "process_loss"
  | "adapter_failures"
  | "wake_churn_without_closure"
  | "weak_success_disposition"
  | "output_contract_drift"
  | "idle_with_assigned_work"
  | "stale_in_progress"
  | "paused_with_open_work"
  | "skill_budget_missing"
  | "blocked_work"
  | "low_recent_signal";

type Severity = "ok" | "info" | "warning" | "critical";

export type AgentProblem = {
  code: ProblemCode;
  severity: Exclude<Severity, "ok">;
  evidence: string;
  fixable: boolean;
};

export type AgentDeepTrace = {
  agentId: string;
  companyId: string;
  companyName: string;
  issuePrefix: string | null;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapterType: string;
  lastHeartbeatAt: string | null;
  sampleRank: number;
  sampleScore: number;
  sampleReasons: string[];
  metrics: {
    desiredSkillCount: number;
    recentRuns: number;
    succeededRuns: number;
    failedRuns: number;
    successRate: number | null;
    processLostRuns: number;
    adapterFailedRuns: number;
    openAssignedIssues: number;
    blockedAssignedIssues: number;
    staleInProgressIssues: number;
    completedIssues: number;
    ledgerEntries: number;
    explicitDispositions: number;
    defaultSuccessDispositions: number;
    blockedDispositions: number;
    verboseUnjustified: number;
    compactSuccess: number;
    missingSkillBudgetRuns: number;
    rawTokens: number;
    costCents: number;
    weakSuccessRate: number | null;
    tokenPerCompletedIssue: number | null;
  };
  problems: AgentProblem[];
  severity: Severity;
  recentRuns: RunDetail[];
  assignedIssues: IssueDetail[];
  recentComments: CommentDetail[];
};

type CompanyDeepTrace = {
  companyId: string;
  name: string;
  description: string | null;
  issuePrefix: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  activeAgentCount: number;
  sampledAgentCount: number;
  minimumSampleMet: boolean;
  statusLabel: "advancing" | "maintaining" | "blocked" | "misaligned" | "needs_decision";
  goals: GoalRow[];
  projects: ProjectRow[];
  issueStatusCounts: IssueStatusRow[];
  systemicProblems: Array<{
    code: ProblemCode;
    severity: Exclude<Severity, "ok">;
    affectedAgents: number;
    sampleShare: number;
    evidence: string;
  }>;
  sampledAgents: AgentDeepTrace[];
};

type TraceReport = {
  version: string;
  generatedAt: string;
  status: "trace_only" | "applied";
  connectionSource: string;
  lookbackDays: number;
  minAgentsPerCompany: number;
  receiptPath: string;
  htmlPath: string;
  markdownPath: string;
  summary: {
    companies: number;
    sampledAgents: number;
    minSamplePerCompanyMet: boolean;
    criticalAgents: number;
    warningAgents: number;
    hermesCliFlagFailures: number;
    processLossAgents: number;
    weakSuccessAgents: number;
    staleWorkAgents: number;
    recentRuns: number;
    failedRuns: number;
    rawTokens: number;
    costCents: number;
    appliedFixes: number;
  };
  companies: CompanyDeepTrace[];
  appliedFixes: Array<{
    agentId: string;
    issuePrefix: string | null;
    agentName: string;
    action: string;
    reason: string;
  }>;
  findings: Array<{
    severity: Exclude<Severity, "ok">;
    title: string;
    detail: string;
  }>;
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : [];
}

function argValue(name: string, fallback: string | null = null) {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? fallback;
  return fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function dateIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

async function loadInstanceEnvFile(homeDir: string, instanceId: string) {
  const envPath = path.join(homeDir, "instances", instanceId, ".env");
  const contents = await readFile(envPath, "utf8").catch(() => "");
  return parseEnvFileContents(contents);
}

async function resolveConnectionString(homeDir: string, instanceId: string) {
  const explicit = argValue("--connection-string") ?? process.env.DATABASE_URL ?? null;
  if (explicit) return { connectionString: explicit, source: "explicit" };
  const env = await loadInstanceEnvFile(homeDir, instanceId);
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, source: "instance_env" };
  const config = await readConfig(homeDir, instanceId);
  if (config.database?.connectionString) {
    return { connectionString: config.database.connectionString, source: "instance_config" };
  }
  const port = config.database?.embeddedPostgresPort ?? 54329;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded_default_${port}`,
  };
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function percent(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function includesHermesUnsupportedFlagFailure(text: string | null) {
  return Boolean(text && /unrecognized arguments:.*(?:--max-turns|--session-id)/is.test(text));
}

export function scoreAgentCandidate(candidate: AgentCandidate) {
  const recentRuns = numberValue(candidate.recent_runs);
  const failedRuns = numberValue(candidate.failed_runs);
  const processLostRuns = numberValue(candidate.process_lost_runs);
  const adapterFailedRuns = numberValue(candidate.adapter_failed_runs);
  const openAssignedIssues = numberValue(candidate.open_assigned_issues);
  const blockedAssignedIssues = numberValue(candidate.blocked_assigned_issues);
  const staleInProgressIssues = numberValue(candidate.stale_in_progress_issues);
  const completedIssues = numberValue(candidate.completed_issues);
  const defaultSuccessDispositions = numberValue(candidate.default_success_dispositions);
  const verboseUnjustified = numberValue(candidate.verbose_unjustified);
  const missingSkillBudgetRuns = numberValue(candidate.missing_skill_budget_runs);
  const rawTokens = numberValue(candidate.raw_tokens);
  const status = String(candidate.status ?? "").toLowerCase();
  const latestFailure = candidate.latest_failure ?? "";
  let score = 0;
  const reasons: string[] = [];

  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (status === "error") add(80, "agent_status_error");
  if (status === "paused" && openAssignedIssues > 0) add(70, "paused_with_open_work");
  if (includesHermesUnsupportedFlagFailure(latestFailure)) add(120, "hermes_cli_flag_incompatibility");
  if (processLostRuns > 0) add(55 + processLostRuns * 10, "process_lost");
  if (adapterFailedRuns > 0) add(45 + adapterFailedRuns * 8, "adapter_failed");
  if (failedRuns > 0) add(20 + failedRuns * 6, "recent_failures");
  if (staleInProgressIssues > 0) add(35 + staleInProgressIssues * 8, "stale_in_progress");
  if (blockedAssignedIssues > 0) add(20 + blockedAssignedIssues * 5, "blocked_assigned_work");
  if (openAssignedIssues > 0 && recentRuns === 0) add(45, "idle_with_assigned_work");
  if (recentRuns >= 10 && completedIssues === 0) add(35, "wake_churn_without_closure");
  if (defaultSuccessDispositions >= 3) add(Math.min(35, defaultSuccessDispositions * 3), "default_success_dispositions");
  if (verboseUnjustified >= 2) add(Math.min(30, verboseUnjustified * 3), "verbose_unjustified_outputs");
  if (missingSkillBudgetRuns > 0) add(Math.min(24, missingSkillBudgetRuns * 4), "missing_skill_budget");
  if (rawTokens > 1_000_000 && completedIssues === 0) add(25, "high_tokens_without_closure");
  if (recentRuns === 0 && openAssignedIssues === 0) add(2, "low_recent_signal");
  return { score, reasons };
}

export function selectDeepDiveAgents(candidates: AgentCandidate[], minimum: number) {
  const byId = new Map<string, { candidate: AgentCandidate; score: number; reasons: string[] }>();
  const ranked = candidates
    .map((candidate) => ({ candidate, ...scoreAgentCandidate(candidate) }))
    .sort((left, right) => right.score - left.score || String(left.candidate.name).localeCompare(String(right.candidate.name)));

  for (const entry of ranked.slice(0, minimum)) byId.set(entry.candidate.id, entry);

  const byRole = new Map<string, typeof ranked>();
  for (const entry of ranked) {
    const role = entry.candidate.role || "general";
    const entries = byRole.get(role) ?? [];
    entries.push(entry);
    byRole.set(role, entries);
  }
  for (const entries of byRole.values()) {
    const top = entries[0];
    if (top) byId.set(top.candidate.id, top);
  }

  return Array.from(byId.values())
    .sort((left, right) => right.score - left.score || String(left.candidate.name).localeCompare(String(right.candidate.name)));
}

export function classifyAgentProblems(candidate: AgentCandidate): AgentProblem[] {
  const recentRuns = numberValue(candidate.recent_runs);
  const failedRuns = numberValue(candidate.failed_runs);
  const processLostRuns = numberValue(candidate.process_lost_runs);
  const adapterFailedRuns = numberValue(candidate.adapter_failed_runs);
  const openAssignedIssues = numberValue(candidate.open_assigned_issues);
  const blockedAssignedIssues = numberValue(candidate.blocked_assigned_issues);
  const staleInProgressIssues = numberValue(candidate.stale_in_progress_issues);
  const completedIssues = numberValue(candidate.completed_issues);
  const ledgerEntries = numberValue(candidate.ledger_entries);
  const defaultSuccessDispositions = numberValue(candidate.default_success_dispositions);
  const verboseUnjustified = numberValue(candidate.verbose_unjustified);
  const missingSkillBudgetRuns = numberValue(candidate.missing_skill_budget_runs);
  const status = String(candidate.status ?? "").toLowerCase();
  const problems: AgentProblem[] = [];
  const latestFailure = candidate.latest_failure ?? "";

  if (includesHermesUnsupportedFlagFailure(latestFailure)) {
    problems.push({
      code: "hermes_cli_flag_incompatibility",
      severity: "critical",
      evidence: "Recent Hermes failure rejected --max-turns or --session-id for the configured Hermes binary.",
      fixable: true,
    });
  }
  if (processLostRuns > 0) {
    problems.push({
      code: "process_loss",
      severity: "critical",
      evidence: `${processLostRuns} recent run(s) lost the child process.`,
      fixable: false,
    });
  }
  if (adapterFailedRuns > 0 || (failedRuns > 0 && problems.length === 0)) {
    problems.push({
      code: "adapter_failures",
      severity: failedRuns >= 3 ? "critical" : "warning",
      evidence: `${failedRuns} recent failed run(s), ${adapterFailedRuns} adapter_failed.`,
      fixable: false,
    });
  }
  if (recentRuns >= 10 && completedIssues === 0) {
    problems.push({
      code: "wake_churn_without_closure",
      severity: "critical",
      evidence: `${recentRuns} recent run(s) with zero completed assigned issues in the lookback window.`,
      fixable: false,
    });
  }
  if (ledgerEntries > 0 && defaultSuccessDispositions / ledgerEntries >= 0.6) {
    problems.push({
      code: "weak_success_disposition",
      severity: "warning",
      evidence: `${defaultSuccessDispositions}/${ledgerEntries} ledger rows defaulted to advanced_vision instead of explicit finalDisposition.`,
      fixable: false,
    });
  }
  if (ledgerEntries > 0 && verboseUnjustified / ledgerEntries >= 0.35) {
    problems.push({
      code: "output_contract_drift",
      severity: "warning",
      evidence: `${verboseUnjustified}/${ledgerEntries} ledger rows exceeded compact output budget without expansion reason.`,
      fixable: false,
    });
  }
  if (openAssignedIssues > 0 && recentRuns === 0 && status !== "paused") {
    problems.push({
      code: "idle_with_assigned_work",
      severity: "warning",
      evidence: `${openAssignedIssues} open assigned issue(s) but no recent runs.`,
      fixable: false,
    });
  }
  if (staleInProgressIssues > 0) {
    problems.push({
      code: "stale_in_progress",
      severity: "warning",
      evidence: `${staleInProgressIssues} in-progress issue(s) stale for more than seven days.`,
      fixable: false,
    });
  }
  if (status === "paused" && openAssignedIssues > 0) {
    problems.push({
      code: "paused_with_open_work",
      severity: "critical",
      evidence: `Paused agent still owns ${openAssignedIssues} open issue(s).`,
      fixable: false,
    });
  }
  if (missingSkillBudgetRuns > 0) {
    problems.push({
      code: "skill_budget_missing",
      severity: "warning",
      evidence: `${missingSkillBudgetRuns} recent adapter.invoke run(s) lacked promptMetrics.skillBudget.`,
      fixable: false,
    });
  }
  if (blockedAssignedIssues > 0) {
    problems.push({
      code: "blocked_work",
      severity: "warning",
      evidence: `${blockedAssignedIssues} blocked assigned issue(s).`,
      fixable: false,
    });
  }
  if (recentRuns === 0 && openAssignedIssues === 0) {
    problems.push({
      code: "low_recent_signal",
      severity: "info",
      evidence: "No recent runs and no open assigned work in the lookback window.",
      fixable: false,
    });
  }
  return problems;
}

function severityOf(problems: AgentProblem[]): Severity {
  if (problems.some((problem) => problem.severity === "critical")) return "critical";
  if (problems.some((problem) => problem.severity === "warning")) return "warning";
  if (problems.some((problem) => problem.severity === "info")) return "info";
  return "ok";
}

async function collectCompanies(db: Db): Promise<CompanyRow[]> {
  return rows<CompanyRow>(await db.execute(sql`
    select id, name, description, issue_prefix, budget_monthly_cents, spent_monthly_cents
    from companies
    where status = 'active'
    order by issue_prefix
  `));
}

async function collectCompanyFacts(db: Db, companyId: string) {
  const goals = rows<GoalRow>(await db.execute(sql`
    select g.slug, g.title, g.status, g.level, a.name as owner_agent_name
    from goals g
    left join agents a on a.id = g.owner_agent_id
    where g.company_id = ${companyId}
      and g.status in ('planned', 'active', 'in_progress')
    order by g.level, g.updated_at desc
    limit 8
  `));
  const projects = rows<ProjectRow>(await db.execute(sql`
    select p.name, p.status, a.name as lead_agent_name
    from projects p
    left join agents a on a.id = p.lead_agent_id
    where p.company_id = ${companyId}
      and p.archived_at is null
      and p.status <> 'done'
    order by p.updated_at desc
    limit 8
  `));
  const issueStatusCounts = rows<IssueStatusRow>(await db.execute(sql`
    select status, count(*) as count
    from issues
    where company_id = ${companyId}
      and hidden_at is null
    group by status
    order by status
  `));
  return { goals, projects, issueStatusCounts };
}

async function collectCandidates(db: Db, company: CompanyRow, lookbackDays: number): Promise<AgentCandidate[]> {
  return rows<AgentCandidate>(await db.execute(sql.raw(`
    select a.id,
           a.company_id,
           ${sqlString(company.name)} as company_name,
           ${sqlString(company.issue_prefix ?? "")} as issue_prefix,
           a.name,
           a.role,
           a.title,
           a.status,
           a.adapter_type,
           a.last_heartbeat_at,
           coalesce(jsonb_array_length(coalesce(a.adapter_config->'paperclipSkillSync'->'desiredSkills', '[]'::jsonb)), 0) as desired_skill_count,
           coalesce((select count(*) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days'), 0) as recent_runs,
           coalesce((select count(*) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days' and hr.status = 'failed'), 0) as failed_runs,
           coalesce((select count(*) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days' and hr.error_code = 'process_lost'), 0) as process_lost_runs,
           coalesce((select count(*) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days' and hr.error_code = 'adapter_failed'), 0) as adapter_failed_runs,
           coalesce((select count(*) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days' and hr.status = 'succeeded'), 0) as succeeded_runs,
           coalesce((select count(*) from issues i where i.assignee_agent_id = a.id and i.hidden_at is null and i.status in ('todo','in_progress','in_review','blocked')), 0) as open_assigned_issues,
           coalesce((select count(*) from issues i where i.assignee_agent_id = a.id and i.hidden_at is null and i.status = 'blocked'), 0) as blocked_assigned_issues,
           coalesce((select count(*) from issues i where i.assignee_agent_id = a.id and i.hidden_at is null and i.status = 'in_progress' and i.updated_at < now() - interval '7 days'), 0) as stale_in_progress_issues,
           coalesce((select count(*) from issues i where i.assignee_agent_id = a.id and i.hidden_at is null and i.status = 'done' and i.completed_at > now() - interval '${lookbackDays} days'), 0) as completed_issues,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days'), 0) as ledger_entries,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days' and cle.metadata->'finalDisposition'->>'source' in ('explicit', 'explicit_final_response')), 0) as explicit_dispositions,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days' and cle.metadata->'finalDisposition'->>'source' = 'default_success'), 0) as default_success_dispositions,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days' and cle.metadata->'finalDisposition'->>'classification' = 'blocked'), 0) as blocked_dispositions,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days' and cle.response_class = 'verbose_unjustified'), 0) as verbose_unjustified,
           coalesce((select count(*) from context_ledger_entries cle where cle.agent_id = a.id and cle.created_at > now() - interval '${lookbackDays} days' and cle.response_class = 'compact_success'), 0) as compact_success,
           coalesce((select count(*) from heartbeat_run_events hre join heartbeat_runs hr on hr.id = hre.run_id where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days' and hre.event_type = 'adapter.invoke' and hre.payload->'promptMetrics'->'skillBudget' is null), 0) as missing_skill_budget_runs,
           coalesce((select sum(input_tokens + cached_input_tokens + output_tokens) from cost_events ce where ce.agent_id = a.id and ce.occurred_at > now() - interval '${lookbackDays} days'), 0) as raw_tokens,
           coalesce((select sum(cost_cents) from cost_events ce where ce.agent_id = a.id and ce.occurred_at > now() - interval '${lookbackDays} days'), 0) as cost_cents,
           (select max(hr.started_at) from heartbeat_runs hr where hr.agent_id = a.id and hr.started_at > now() - interval '${lookbackDays} days') as last_run_at,
           (select coalesce(cle.final_blocker, hr.error, hr.stderr_excerpt, hr.stdout_excerpt)
              from heartbeat_runs hr
              left join context_ledger_entries cle on cle.run_id = hr.id
             where hr.agent_id = a.id
               and hr.started_at > now() - interval '${lookbackDays} days'
               and hr.status = 'failed'
             order by hr.started_at desc
             limit 1) as latest_failure
      from agents a
     where a.company_id = '${escapeSql(company.id)}'
       and a.status <> 'terminated'
     order by a.role, a.name
  `)));
}

function sqlString(value: string) {
  return `'${escapeSql(value)}'`;
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}

async function collectRunDetails(db: Db, agentId: string, lookbackDays: number): Promise<RunDetail[]> {
  const rowsRaw = rows<RunDetail & { selected_skills: unknown; skipped_flags_raw: unknown }>(await db.execute(sql.raw(`
    select hr.id as run_id,
           hr.status,
           hr.error_code,
           i.identifier as issue_identifier,
           i.status as issue_status,
           hr.started_at,
           hr.finished_at,
           case when hr.started_at is not null and hr.finished_at is not null then extract(epoch from (hr.finished_at - hr.started_at))::int else null end as duration_seconds,
           coalesce(ce.provider, hr.usage_json->>'provider') as provider,
           coalesce(ce.model, hr.usage_json->>'model') as model,
           ce.raw_tokens,
           ce.cost_cents,
           cle.prompt_class,
           cle.response_class,
           cle.metadata->'finalDisposition'->>'source' as disposition_source,
           cle.metadata->'finalDisposition'->>'classification' as disposition_classification,
           cle.final_outcome,
           cle.final_blocker,
           coalesce(jsonb_array_length(coalesce(hre.payload->'promptMetrics'->'skillBudget'->'selected', '[]'::jsonb)), 0) as skill_selected_count,
           coalesce((hre.payload->'promptMetrics'->'skillBudget'->>'skippedCount')::int, 0) as skill_skipped_count,
           hre.payload->>'command' as command,
           hre.payload->'promptMetrics'->'hermesCliCapabilities'->'skippedFlags' as skipped_flags_raw
      from heartbeat_runs hr
      left join issues i on i.id::text = hr.context_snapshot->>'issueId'
      left join context_ledger_entries cle on cle.run_id = hr.id
      left join heartbeat_run_events hre on hre.run_id = hr.id and hre.event_type = 'adapter.invoke'
      left join lateral (
        select max(provider) as provider,
               max(model) as model,
               coalesce(sum(input_tokens + cached_input_tokens + output_tokens), 0)::int as raw_tokens,
               coalesce(sum(cost_cents), 0)::int as cost_cents
          from cost_events
         where heartbeat_run_id = hr.id
      ) ce on true
     where hr.agent_id = '${escapeSql(agentId)}'
       and hr.started_at > now() - interval '${lookbackDays} days'
     order by hr.started_at desc
     limit 12
  `)));
  return rowsRaw.map((row) => ({
    ...row,
    skipped_flags: asStringArray(row.skipped_flags_raw),
  }));
}

async function collectIssueDetails(db: Db, agentId: string): Promise<IssueDetail[]> {
  return rows<IssueDetail>(await db.execute(sql.raw(`
    select identifier,
           title,
           status,
           priority,
           updated_at,
           extract(day from (now() - updated_at))::int as age_days
      from issues
     where assignee_agent_id = '${escapeSql(agentId)}'
       and hidden_at is null
       and status in ('todo','in_progress','in_review','blocked')
     order by priority desc, updated_at desc
     limit 8
  `)));
}

async function collectCommentDetails(db: Db, agentId: string, lookbackDays: number): Promise<CommentDetail[]> {
  return rows<CommentDetail>(await db.execute(sql.raw(`
    select i.identifier as issue_identifier,
           left(regexp_replace(ic.body, '\\s+', ' ', 'g'), 360) as body_excerpt,
           ic.created_at
      from issue_comments ic
      left join issues i on i.id = ic.issue_id
     where ic.author_agent_id = '${escapeSql(agentId)}'
       and ic.created_at > now() - interval '${lookbackDays} days'
     order by ic.created_at desc
     limit 6
  `)));
}

async function buildAgentTrace(db: Db, candidate: AgentCandidate, sampleRank: number, sampleScore: number, sampleReasons: string[], lookbackDays: number): Promise<AgentDeepTrace> {
  const recentRuns = numberValue(candidate.recent_runs);
  const succeededRuns = numberValue(candidate.succeeded_runs);
  const failedRuns = numberValue(candidate.failed_runs);
  const completedIssues = numberValue(candidate.completed_issues);
  const ledgerEntries = numberValue(candidate.ledger_entries);
  const defaultSuccessDispositions = numberValue(candidate.default_success_dispositions);
  const rawTokens = numberValue(candidate.raw_tokens);
  const problems = classifyAgentProblems(candidate);
  return {
    agentId: candidate.id,
    companyId: candidate.company_id,
    companyName: candidate.company_name,
    issuePrefix: candidate.issue_prefix,
    name: candidate.name,
    role: candidate.role,
    title: candidate.title,
    status: candidate.status,
    adapterType: candidate.adapter_type,
    lastHeartbeatAt: dateIso(candidate.last_heartbeat_at),
    sampleRank,
    sampleScore,
    sampleReasons,
    metrics: {
      desiredSkillCount: numberValue(candidate.desired_skill_count),
      recentRuns,
      succeededRuns,
      failedRuns,
      successRate: percent(succeededRuns, recentRuns),
      processLostRuns: numberValue(candidate.process_lost_runs),
      adapterFailedRuns: numberValue(candidate.adapter_failed_runs),
      openAssignedIssues: numberValue(candidate.open_assigned_issues),
      blockedAssignedIssues: numberValue(candidate.blocked_assigned_issues),
      staleInProgressIssues: numberValue(candidate.stale_in_progress_issues),
      completedIssues,
      ledgerEntries,
      explicitDispositions: numberValue(candidate.explicit_dispositions),
      defaultSuccessDispositions,
      blockedDispositions: numberValue(candidate.blocked_dispositions),
      verboseUnjustified: numberValue(candidate.verbose_unjustified),
      compactSuccess: numberValue(candidate.compact_success),
      missingSkillBudgetRuns: numberValue(candidate.missing_skill_budget_runs),
      rawTokens,
      costCents: numberValue(candidate.cost_cents),
      weakSuccessRate: percent(defaultSuccessDispositions, ledgerEntries),
      tokenPerCompletedIssue: completedIssues > 0 ? Math.round(rawTokens / completedIssues) : null,
    },
    problems,
    severity: severityOf(problems),
    recentRuns: await collectRunDetails(db, candidate.id, lookbackDays),
    assignedIssues: await collectIssueDetails(db, candidate.id),
    recentComments: await collectCommentDetails(db, candidate.id, lookbackDays),
  };
}

function aggregateSystemicProblems(agents: AgentDeepTrace[]): CompanyDeepTrace["systemicProblems"] {
  const counts = new Map<ProblemCode, { severity: Exclude<Severity, "ok">; evidence: string[]; affected: number }>();
  for (const agent of agents) {
    for (const problem of agent.problems) {
      if (problem.severity === "info") continue;
      const current = counts.get(problem.code) ?? { severity: problem.severity, evidence: [], affected: 0 };
      current.affected += 1;
      if (problem.severity === "critical") current.severity = "critical";
      current.evidence.push(`${agent.name}: ${problem.evidence}`);
      counts.set(problem.code, current);
    }
  }
  const threshold = Math.max(2, Math.ceil(agents.length * 0.33));
  return Array.from(counts.entries())
    .filter(([, value]) => value.affected >= threshold)
    .map(([code, value]) => ({
      code,
      severity: value.severity,
      affectedAgents: value.affected,
      sampleShare: percent(value.affected, agents.length) ?? 0,
      evidence: value.evidence.slice(0, 3).join(" | "),
    }))
    .sort((left, right) => right.affectedAgents - left.affectedAgents);
}

function companyStatusLabel(agents: AgentDeepTrace[], systemicProblems: CompanyDeepTrace["systemicProblems"]): CompanyDeepTrace["statusLabel"] {
  if (systemicProblems.some((problem) => problem.severity === "critical")) return "blocked";
  if (systemicProblems.some((problem) => problem.code === "weak_success_disposition" || problem.code === "wake_churn_without_closure")) {
    return "misaligned";
  }
  if (agents.every((agent) => agent.metrics.recentRuns === 0)) return "needs_decision";
  if (agents.some((agent) => agent.severity === "warning")) return "maintaining";
  return "advancing";
}

async function applySafeFixes(db: Db, companies: CompanyDeepTrace[]) {
  const applied: TraceReport["appliedFixes"] = [];
  const fixable = companies.flatMap((company) =>
    company.sampledAgents
      .filter((agent) =>
        agent.status === "error" &&
        agent.problems.some((problem) => problem.code === "hermes_cli_flag_incompatibility" && problem.fixable),
      )
      .map((agent) => ({ company, agent })),
  );
  for (const { company, agent } of fixable) {
    await db.execute(sql`
      update agents
         set status = 'idle',
             pause_reason = null,
             paused_at = null,
             updated_at = now()
       where id = ${agent.agentId}
         and status = 'error'
    `);
    applied.push({
      agentId: agent.agentId,
      issuePrefix: company.issuePrefix,
      agentName: agent.name,
      action: "reset_agent_status_to_idle",
      reason: "Hermes CLI unsupported flag failure is fixed by capability-aware argument construction.",
    });
  }
  return applied;
}

async function collectCompanyTrace(db: Db, company: CompanyRow, lookbackDays: number, minimum: number): Promise<CompanyDeepTrace> {
  const facts = await collectCompanyFacts(db, company.id);
  const candidates = await collectCandidates(db, company, lookbackDays);
  const selected = selectDeepDiveAgents(candidates, minimum);
  const sampledAgents: AgentDeepTrace[] = [];
  for (const [index, entry] of selected.entries()) {
    sampledAgents.push(await buildAgentTrace(db, entry.candidate, index + 1, entry.score, entry.reasons, lookbackDays));
  }
  const systemicProblems = aggregateSystemicProblems(sampledAgents);
  return {
    companyId: company.id,
    name: company.name,
    description: company.description,
    issuePrefix: company.issue_prefix,
    budgetMonthlyCents: numberValue(company.budget_monthly_cents),
    spentMonthlyCents: numberValue(company.spent_monthly_cents),
    activeAgentCount: candidates.length,
    sampledAgentCount: sampledAgents.length,
    minimumSampleMet: sampledAgents.length >= Math.min(minimum, candidates.length),
    statusLabel: companyStatusLabel(sampledAgents, systemicProblems),
    goals: facts.goals,
    projects: facts.projects,
    issueStatusCounts: facts.issueStatusCounts,
    systemicProblems,
    sampledAgents,
  };
}

function buildFindings(companies: CompanyDeepTrace[], appliedFixes: TraceReport["appliedFixes"]): TraceReport["findings"] {
  const agents = companies.flatMap((company) => company.sampledAgents);
  const hermesFailures = agents.filter((agent) => agent.problems.some((problem) => problem.code === "hermes_cli_flag_incompatibility")).length;
  const weakSuccess = agents.filter((agent) => agent.problems.some((problem) => problem.code === "weak_success_disposition")).length;
  const churn = agents.filter((agent) => agent.problems.some((problem) => problem.code === "wake_churn_without_closure")).length;
  const stale = agents.filter((agent) => agent.problems.some((problem) => problem.code === "stale_in_progress" || problem.code === "idle_with_assigned_work")).length;
  const findings: TraceReport["findings"] = [];
  if (hermesFailures > 0) {
    findings.push({
      severity: "critical",
      title: "Hermes adapter flag compatibility was breaking live agents",
      detail: `${hermesFailures} sampled agent(s) showed Hermes CLI unsupported-flag failures. The adapter fix is capability-aware; ${appliedFixes.length} stuck error agent(s) were safe-reset to idle in apply mode.`,
    });
  }
  if (weakSuccess > 0) {
    findings.push({
      severity: "warning",
      title: "Success is overclaimed when finalDisposition is implicit",
      detail: `${weakSuccess} sampled agent(s) had mostly default_success advanced_vision ledger rows. Treat those as weak progress until agents explicitly emit finalDisposition and receipts.`,
    });
  }
  if (churn > 0) {
    findings.push({
      severity: "critical",
      title: "Wake churn is replacing deliverable closure",
      detail: `${churn} sampled agent(s) had heavy recent run volume without closing assigned issues. This is the strongest underperformance signal and should drive routine/issue consolidation.`,
    });
  }
  if (stale > 0) {
    findings.push({
      severity: "warning",
      title: "Open work is stale or owned by idle agents",
      detail: `${stale} sampled agent(s) have stale in-progress issues or no recent execution despite assigned work. These need manager triage, not more blind wakeups.`,
    });
  }
  if (findings.length === 0) {
    findings.push({
      severity: "info",
      title: "No systemic sampled failures detected",
      detail: "The sampled agents did not show critical adapter, process, churn, stale-work, or weak-success patterns.",
    });
  }
  return findings;
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function renderPills(values: string[], limit = 4) {
  if (values.length === 0) return "<span class=\"muted\">None</span>";
  const shown = values.slice(0, limit).map((value) => `<span class="pill">${htmlEscape(value)}</span>`).join("");
  const extra = values.length > limit ? `<span class="pill muted">+${values.length - limit}</span>` : "";
  return shown + extra;
}

function renderHtml(report: TraceReport) {
  const agentRows = report.companies.flatMap((company) => company.sampledAgents.map((agent) => `
    <tr>
      <td>${htmlEscape(agent.issuePrefix)}</td>
      <td>${htmlEscape(agent.name)}</td>
      <td>${htmlEscape(agent.role)}</td>
      <td>${htmlEscape(agent.status)}</td>
      <td><span class="status ${agent.severity}">${agent.severity}</span></td>
      <td>${agent.sampleScore}</td>
      <td>${agent.metrics.recentRuns}</td>
      <td>${agent.metrics.failedRuns}</td>
      <td>${agent.metrics.completedIssues}</td>
      <td>${agent.metrics.openAssignedIssues}</td>
      <td>${agent.metrics.rawTokens.toLocaleString()}</td>
      <td>${htmlEscape(agent.metrics.weakSuccessRate ?? "")}</td>
      <td>${renderPills(agent.problems.map((problem) => problem.code), 6)}</td>
      <td>${htmlEscape(agent.sampleReasons.join(", "))}</td>
    </tr>`)).join("\n");
  const companyRows = report.companies.map((company) => `
    <tr>
      <td>${htmlEscape(company.issuePrefix)}</td>
      <td>${htmlEscape(company.name)}</td>
      <td><span class="status ${company.statusLabel === "blocked" || company.statusLabel === "misaligned" ? "critical" : company.statusLabel === "maintaining" ? "warning" : "ok"}">${company.statusLabel}</span></td>
      <td>${company.sampledAgentCount}/${company.activeAgentCount}</td>
      <td>${renderPills(company.systemicProblems.map((problem) => `${problem.code} (${problem.affectedAgents})`), 5)}</td>
    </tr>`).join("\n");
  const findingCards = report.findings.map((finding) => `
    <section class="finding ${finding.severity}">
      <h3>${htmlEscape(finding.title)}</h3>
      <p>${htmlEscape(finding.detail)}</p>
    </section>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Paperclip Agent Mission Performance Deep Dive</title>
  <style>
    :root { color-scheme: light; --ink:#162228; --muted:#66757d; --line:#d9e1e5; --bg:#f7f9fa; --panel:#fff; --critical:#a32020; --warning:#9a5b00; --ok:#1d6938; --info:#235d86; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
    header { padding:28px 32px 20px; background:#132f3a; color:#fff; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    h2 { margin:28px 0 12px; font-size:18px; }
    h3 { margin:0 0 6px; font-size:15px; }
    main { padding:24px 32px 40px; }
    .meta { color:#d6e3e8; font-size:13px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px; }
    .card, .finding { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .metric { font-size:28px; font-weight:700; }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:9px 10px; font-size:13px; vertical-align:top; }
    th { background:#eaf0f3; font-size:12px; color:#30434d; }
    tr:last-child td { border-bottom:0; }
    .status, .pill { display:inline-block; border-radius:999px; padding:2px 8px; margin:1px 3px 1px 0; font-size:12px; border:1px solid var(--line); background:#f2f5f6; }
    .critical { color:var(--critical); border-color:#e2b7b7; background:#fff1f1; }
    .warning { color:var(--warning); border-color:#e4c48f; background:#fff7e8; }
    .ok { color:var(--ok); border-color:#b4d4c0; background:#edf8f0; }
    .info { color:var(--info); border-color:#b6cee0; background:#edf6fc; }
    .muted { color:var(--muted); }
    .finding.critical { border-left:4px solid var(--critical); }
    .finding.warning { border-left:4px solid var(--warning); }
    .finding.info { border-left:4px solid var(--info); }
  </style>
</head>
<body>
  <header>
    <h1>Paperclip Agent Mission Performance Deep Dive</h1>
    <div class="meta">Generated ${htmlEscape(report.generatedAt)} | ${report.status} | ${report.minAgentsPerCompany} min agents/company | ${htmlEscape(report.receiptPath)}</div>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="label">Companies</div><div class="metric">${report.summary.companies}</div></div>
      <div class="card"><div class="label">Sampled Agents</div><div class="metric">${report.summary.sampledAgents}</div></div>
      <div class="card"><div class="label">Critical Agents</div><div class="metric">${report.summary.criticalAgents}</div></div>
      <div class="card"><div class="label">Warning Agents</div><div class="metric">${report.summary.warningAgents}</div></div>
      <div class="card"><div class="label">Recent Runs</div><div class="metric">${report.summary.recentRuns}</div></div>
      <div class="card"><div class="label">Raw Tokens</div><div class="metric">${report.summary.rawTokens.toLocaleString()}</div></div>
      <div class="card"><div class="label">Applied Fixes</div><div class="metric">${report.summary.appliedFixes}</div></div>
    </section>
    <h2>Findings</h2>
    <section class="grid">${findingCards}</section>
    <h2>Company Status</h2>
    <table><thead><tr><th>Prefix</th><th>Company</th><th>Status</th><th>Sample</th><th>Systemic Problems</th></tr></thead><tbody>${companyRows}</tbody></table>
    <h2>Deep-Dive Agents</h2>
    <table><thead><tr><th>Prefix</th><th>Agent</th><th>Role</th><th>Status</th><th>Severity</th><th>Score</th><th>Runs</th><th>Failures</th><th>Completed</th><th>Open</th><th>Tokens</th><th>Weak Success %</th><th>Problems</th><th>Sample Reasons</th></tr></thead><tbody>${agentRows}</tbody></table>
  </main>
</body>
</html>`;
}

function markdownTableEscape(value: unknown) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function renderMarkdown(report: TraceReport) {
  const lines: string[] = [
    "# Paperclip Agent Mission Performance Deep Dive",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Receipt: ${report.receiptPath}`,
    `HTML: ${report.htmlPath}`,
    "",
    "## Summary",
    "",
    `- Companies: ${report.summary.companies}`,
    `- Sampled agents: ${report.summary.sampledAgents}`,
    `- Minimum sample met: ${report.summary.minSamplePerCompanyMet}`,
    `- Critical agents: ${report.summary.criticalAgents}`,
    `- Warning agents: ${report.summary.warningAgents}`,
    `- Recent runs: ${report.summary.recentRuns}`,
    `- Failed runs: ${report.summary.failedRuns}`,
    `- Raw tokens: ${report.summary.rawTokens}`,
    `- Applied fixes: ${report.summary.appliedFixes}`,
    "",
    "## Findings",
    "",
    ...report.findings.map((finding) => `- **${finding.severity.toUpperCase()} ${finding.title}:** ${finding.detail}`),
    "",
    "## Company Trace",
    "",
  ];
  for (const company of report.companies) {
    lines.push(
      `### ${company.issuePrefix ?? "N/A"} ${company.name}`,
      "",
      `Status: ${company.statusLabel}`,
      `Sample: ${company.sampledAgentCount}/${company.activeAgentCount}`,
      "",
      "| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
      ...company.sampledAgents.map((agent) => [
        markdownTableEscape(agent.name),
        markdownTableEscape(agent.role),
        markdownTableEscape(agent.status),
        markdownTableEscape(agent.severity),
        agent.sampleScore,
        agent.metrics.recentRuns,
        agent.metrics.failedRuns,
        agent.metrics.completedIssues,
        agent.metrics.openAssignedIssues,
        agent.metrics.rawTokens,
        markdownTableEscape(agent.problems.map((problem) => problem.code).join(", ") || "none"),
      ].join(" | ")),
      "",
    );
  }
  if (report.appliedFixes.length > 0) {
    lines.push(
      "## Applied Fixes",
      "",
      ...report.appliedFixes.map((fix) => `- ${fix.issuePrefix ?? "N/A"} ${fix.agentName}: ${fix.action} (${fix.reason})`),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function buildReport(options: {
  apply: boolean;
  homeDir: string;
  instanceId: string;
  connectionString: string;
  connectionSource: string;
  receiptPath: string;
  htmlPath: string;
  markdownPath: string;
  lookbackDays: number;
  minAgentsPerCompany: number;
}) {
  const db = createDb(options.connectionString);
  try {
    const companies = await collectCompanies(db);
    let companyTraces: CompanyDeepTrace[] = [];
    for (const company of companies) {
      companyTraces.push(await collectCompanyTrace(db, company, options.lookbackDays, options.minAgentsPerCompany));
    }
    const appliedFixes = options.apply ? await applySafeFixes(db, companyTraces) : [];
    if (appliedFixes.length > 0) {
      companyTraces = [];
      for (const company of companies) {
        companyTraces.push(await collectCompanyTrace(db, company, options.lookbackDays, options.minAgentsPerCompany));
      }
    }
    const sampledAgents = companyTraces.flatMap((company) => company.sampledAgents);
    const report: TraceReport = {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      status: options.apply ? "applied" : "trace_only",
      connectionSource: options.connectionSource,
      lookbackDays: options.lookbackDays,
      minAgentsPerCompany: options.minAgentsPerCompany,
      receiptPath: options.receiptPath,
      htmlPath: options.htmlPath,
      markdownPath: options.markdownPath,
      summary: {
        companies: companyTraces.length,
        sampledAgents: sampledAgents.length,
        minSamplePerCompanyMet: companyTraces.every((company) => company.minimumSampleMet),
        criticalAgents: sampledAgents.filter((agent) => agent.severity === "critical").length,
        warningAgents: sampledAgents.filter((agent) => agent.severity === "warning").length,
        hermesCliFlagFailures: sampledAgents.filter((agent) => agent.problems.some((problem) => problem.code === "hermes_cli_flag_incompatibility")).length,
        processLossAgents: sampledAgents.filter((agent) => agent.problems.some((problem) => problem.code === "process_loss")).length,
        weakSuccessAgents: sampledAgents.filter((agent) => agent.problems.some((problem) => problem.code === "weak_success_disposition")).length,
        staleWorkAgents: sampledAgents.filter((agent) => agent.problems.some((problem) => problem.code === "stale_in_progress" || problem.code === "idle_with_assigned_work")).length,
        recentRuns: sampledAgents.reduce((total, agent) => total + agent.metrics.recentRuns, 0),
        failedRuns: sampledAgents.reduce((total, agent) => total + agent.metrics.failedRuns, 0),
        rawTokens: sampledAgents.reduce((total, agent) => total + agent.metrics.rawTokens, 0),
        costCents: sampledAgents.reduce((total, agent) => total + agent.metrics.costCents, 0),
        appliedFixes: appliedFixes.length,
      },
      companies: companyTraces,
      appliedFixes,
      findings: buildFindings(companyTraces, appliedFixes),
    };
    await mkdir(path.dirname(options.receiptPath), { recursive: true });
    await mkdir(path.dirname(options.htmlPath), { recursive: true });
    await mkdir(path.dirname(options.markdownPath), { recursive: true });
    await writeFile(options.receiptPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(options.htmlPath, renderHtml(report), "utf8");
    await writeFile(options.markdownPath, renderMarkdown(report), "utf8");
    return report;
  } finally {
    await (db as DbWithClient).$client?.end?.({ timeout: 1 });
  }
}

export async function main() {
  const homeDir = argValue("--home", DEFAULT_HOME) ?? DEFAULT_HOME;
  const instanceId = argValue("--instance", DEFAULT_INSTANCE_ID) ?? DEFAULT_INSTANCE_ID;
  const apply = hasFlag("--apply");
  const lookbackDays = Math.max(1, Math.trunc(numberValue(argValue("--lookback-days"), DEFAULT_LOOKBACK_DAYS)));
  const minAgentsPerCompany = Math.max(1, Math.trunc(numberValue(argValue("--min-agents-per-company"), DEFAULT_MIN_AGENTS_PER_COMPANY)));
  const htmlPath = path.resolve(argValue("--html-out", DEFAULT_HTML_OUT) ?? DEFAULT_HTML_OUT);
  const markdownPath = path.resolve(argValue("--markdown-out", DEFAULT_MARKDOWN_OUT) ?? DEFAULT_MARKDOWN_OUT);
  const now = timestampForPath();
  const receiptPath = path.resolve(
    argValue("--receipt-out") ??
      path.join(homeDir, "instances", instanceId, DEFAULT_RECEIPT_DIR, `${now}-agent-mission-performance-trace.json`),
  );
  const { connectionString, source } = await resolveConnectionString(homeDir, instanceId);
  const report = await buildReport({
    apply,
    homeDir,
    instanceId,
    connectionString,
    connectionSource: source,
    receiptPath,
    htmlPath,
    markdownPath,
    lookbackDays,
    minAgentsPerCompany,
  });
  console.log(JSON.stringify({
    status: report.status,
    summary: report.summary,
    receiptPath: report.receiptPath,
    htmlPath: report.htmlPath,
    markdownPath: report.markdownPath,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
