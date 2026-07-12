import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/provider-tokenomics/runs";
const ANALYSIS_VERSION = "hermes-tokenomics-analysis.v1";
const TARGET_NO_ISSUE_RAW_TOKENS_PER_RUN = 30_000;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type AnalysisOptions = {
  days?: number;
  connectionString?: string;
  homeDir?: string;
  instanceId?: string;
  receiptDir?: string;
};

export type BurnClass =
  | "cost_without_run"
  | "no_issue_no_deliverable_timer_or_manual"
  | "no_issue_no_deliverable_other"
  | "issue_tied_delivery_or_evidence"
  | "issue_context_without_completed_delivery";

export type BurnClassInput = {
  heartbeatRunId?: string | null;
  invocationSource?: string | null;
  hasContextIssue?: boolean;
  executionIssues?: number;
  completedIssues?: number;
  issueTiedSuccessfulLedgerEntries?: number;
};

export type BurnClassSummary = {
  class: BurnClass;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawTokens: number;
  rawPercent: number;
};

type ProviderSummary = {
  provider: string;
  model: string;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawTokens: number;
};

type AgentSourceSummary = {
  agentName: string;
  agentRole: string;
  invocationSource: string | null;
  runs: number;
  rawTokens: number;
  avgRawTokens: number;
};

type TopRunSummary = {
  heartbeatRunId: string | null;
  agentName: string;
  agentRole: string;
  providers: string | null;
  invocationSource: string | null;
  triggerDetail: string | null;
  status: string | null;
  errorCode: string | null;
  hasContextIssue: boolean;
  executionIssues: number;
  completedIssues: number;
  ledgerEntries: number;
  ledgerIssueRefs: number;
  issueTiedSuccessfulLedgerEntries: number;
  contextChars: number;
  maxPromptChars: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawTokens: number;
};

export type TokenomicsAnalysisReceipt = {
  version: string;
  generatedAt: string;
  windowDays: number;
  connectionSource: string;
  totals: {
    runs: number;
    rawTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  burnClasses: BurnClassSummary[];
  providerBreakdown: ProviderSummary[];
  agentSourceBreakdown: AgentSourceSummary[];
  topRuns: TopRunSummary[];
  deterministicRequestCandidates: Array<{
    class: BurnClass;
    observedRuns: number;
    observedRawTokens: number;
    targetRawTokensPerRun: number;
    estimatedTargetRawTokens: number;
    estimatedSavingsTokens: number;
    estimatedSavingsRatioOfTotal: number;
    requestShape: string;
    requiredPromptQuestion: string;
    policy: Record<string, unknown>;
  }>;
  recommendations: string[];
  receiptPath: string | null;
};

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|1|yes)$/i.test(value.trim());
  return false;
}

export function classifyBurnClass(input: BurnClassInput): BurnClass {
  if (!input.heartbeatRunId) return "cost_without_run";
  const executionIssues = asNumber(input.executionIssues);
  const completedIssues = asNumber(input.completedIssues);
  const issueTiedLedger = asNumber(input.issueTiedSuccessfulLedgerEntries);
  const hasIssueContext = input.hasContextIssue === true;
  if (completedIssues > 0 || issueTiedLedger > 0) return "issue_tied_delivery_or_evidence";
  if (!hasIssueContext && executionIssues === 0) {
    return input.invocationSource === "timer" || input.invocationSource === "on_demand"
      ? "no_issue_no_deliverable_timer_or_manual"
      : "no_issue_no_deliverable_other";
  }
  return "issue_context_without_completed_delivery";
}

function normalizeBurnClassRows(rows: unknown[]): BurnClassSummary[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      class: String(record.class) as BurnClass,
      runs: asNumber(record.runs),
      inputTokens: asNumber(record.input_tokens ?? record.inputTokens),
      cachedInputTokens: asNumber(record.cached_input_tokens ?? record.cachedInputTokens),
      outputTokens: asNumber(record.output_tokens ?? record.outputTokens),
      rawTokens: asNumber(record.raw_tokens ?? record.rawTokens),
      rawPercent: asNumber(record.raw_percent ?? record.rawPercent),
    };
  });
}

function normalizeProviderRows(rows: unknown[]): ProviderSummary[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      runs: asNumber(record.runs),
      inputTokens: asNumber(record.input_tokens),
      cachedInputTokens: asNumber(record.cached_input_tokens),
      outputTokens: asNumber(record.output_tokens),
      rawTokens: asNumber(record.raw_tokens),
    };
  });
}

function normalizeAgentSourceRows(rows: unknown[]): AgentSourceSummary[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      agentName: String(record.agent_name ?? "unknown"),
      agentRole: String(record.agent_role ?? "unknown"),
      invocationSource: asString(record.invocation_source),
      runs: asNumber(record.runs),
      rawTokens: asNumber(record.raw_tokens),
      avgRawTokens: asNumber(record.avg_raw_tokens),
    };
  });
}

function normalizeTopRunRows(rows: unknown[]): TopRunSummary[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      heartbeatRunId: asString(record.heartbeat_run_id),
      agentName: String(record.agent_name ?? "unknown"),
      agentRole: String(record.agent_role ?? "unknown"),
      providers: asString(record.providers),
      invocationSource: asString(record.invocation_source),
      triggerDetail: asString(record.trigger_detail),
      status: asString(record.status),
      errorCode: asString(record.error_code),
      hasContextIssue: asBoolean(record.has_context_issue),
      executionIssues: asNumber(record.execution_issues),
      completedIssues: asNumber(record.completed_issues),
      ledgerEntries: asNumber(record.ledger_entries),
      ledgerIssueRefs: asNumber(record.ledger_issue_refs),
      issueTiedSuccessfulLedgerEntries: asNumber(record.issue_tied_successful_ledger_entries),
      contextChars: asNumber(record.context_chars),
      maxPromptChars: asNumber(record.max_prompt_chars),
      inputTokens: asNumber(record.input_tokens),
      cachedInputTokens: asNumber(record.cached_input_tokens),
      outputTokens: asNumber(record.output_tokens),
      rawTokens: asNumber(record.raw_tokens),
    };
  });
}

export function buildTokenomicsAnalysisReceipt(input: {
  windowDays: number;
  connectionSource: string;
  generatedAt?: Date;
  burnClasses: BurnClassSummary[];
  providerBreakdown: ProviderSummary[];
  agentSourceBreakdown: AgentSourceSummary[];
  topRuns: TopRunSummary[];
  receiptPath?: string | null;
}): TokenomicsAnalysisReceipt {
  const totals = input.burnClasses.reduce(
    (acc, row) => ({
      runs: acc.runs + row.runs,
      rawTokens: acc.rawTokens + row.rawTokens,
      inputTokens: acc.inputTokens + row.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
    }),
    { runs: 0, rawTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  const noIssueTimerManual = input.burnClasses.find((row) => row.class === "no_issue_no_deliverable_timer_or_manual");
  const estimatedTargetRawTokens = (noIssueTimerManual?.runs ?? 0) * TARGET_NO_ISSUE_RAW_TOKENS_PER_RUN;
  const estimatedSavingsTokens = Math.max(0, (noIssueTimerManual?.rawTokens ?? 0) - estimatedTargetRawTokens);
  const estimatedSavingsRatioOfTotal = totals.rawTokens > 0 ? estimatedSavingsTokens / totals.rawTokens : 0;
  const deterministicRequestCandidates = noIssueTimerManual
    ? [
        {
          class: noIssueTimerManual.class,
          observedRuns: noIssueTimerManual.runs,
          observedRawTokens: noIssueTimerManual.rawTokens,
          targetRawTokensPerRun: TARGET_NO_ISSUE_RAW_TOKENS_PER_RUN,
          estimatedTargetRawTokens,
          estimatedSavingsTokens,
          estimatedSavingsRatioOfTotal,
          requestShape: "bounded_status_no_issue_handoff",
          requiredPromptQuestion: "Does this session's prior runs provide any value to this current run?",
          policy: {
            contextMaxChars: 8_000,
            outputMaxChars: 1_200,
            outputMaxSentences: 6,
            maxTurnsPerRun: 4,
            finalDeliverableGate: "completed issue or successful issue-tied artifact",
          },
        },
      ]
    : [];
  const recommendations = [
    estimatedSavingsRatioOfTotal >= 0.5
      ? "The no-issue/no-final-deliverable timer/manual class alone can meet the 50 percent token-reduction target when shaped to bounded status mode."
      : "No single waste class currently proves the 50 percent token-reduction target; keep request shaping and inspect issue-context-without-delivery runs next.",
    "Preserve issue-tied assignment/automation runs; those are the class most likely to produce final deliverables.",
    "Keep final-output reporting gated on completed issues or successful issue-tied context-ledger artifacts, not successful ledger rows without an issue.",
  ];
  return {
    version: ANALYSIS_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    windowDays: input.windowDays,
    connectionSource: input.connectionSource,
    totals,
    burnClasses: input.burnClasses,
    providerBreakdown: input.providerBreakdown,
    agentSourceBreakdown: input.agentSourceBreakdown,
    topRuns: input.topRuns,
    deterministicRequestCandidates,
    recommendations,
    receiptPath: input.receiptPath ?? null,
  };
}

async function readConfig(homeDir: string, instanceId: string): Promise<ConfigFile> {
  const configPath = path.join(homeDir, "instances", instanceId, "config.json");
  return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
}

function resolveConnectionString(config: ConfigFile, explicit?: string) {
  if (explicit?.trim()) return { connectionString: explicit.trim(), source: "explicit" };
  if (process.env.DATABASE_URL?.trim()) return { connectionString: process.env.DATABASE_URL.trim(), source: "DATABASE_URL" };
  if (config.database?.connectionString?.trim()) {
    return { connectionString: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }
  const port = config.database?.embeddedPostgresPort ?? 54329;
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

export function receiptFilePath(
  homeDir: string,
  instanceId: string,
  receiptDir?: string,
  now = new Date(),
  pid = process.pid,
) {
  const root = path.resolve(path.join(homeDir, "instances", instanceId), receiptDir ?? DEFAULT_RECEIPT_DIR);
  const stamp = `${now.toISOString().replace(/[-:.]/g, "")}-${pid}`;
  return path.join(root, `${stamp}-hermes-tokenomics-analysis.json`);
}

function intervalLiteral(days: number) {
  return `${Math.max(1, Math.min(30, Math.trunc(days)))} days`;
}

async function collectAnalysisRows(db: Db, days: number) {
  const interval = intervalLiteral(days);
  const burnClasses = await db.execute(sql.raw(`
with cost_by_run as (
  select heartbeat_run_id, agent_id,
    sum(input_tokens) as input_tokens,
    sum(cached_input_tokens) as cached_input_tokens,
    sum(output_tokens) as output_tokens,
    sum(input_tokens + output_tokens) as raw_tokens
  from cost_events
  where occurred_at >= now() - interval '${interval}'
  group by heartbeat_run_id, agent_id
), ledger_by_run as (
  select run_id,
    count(*) as ledger_entries,
    count(issue_id) as ledger_issue_refs,
    count(*) filter (where issue_id is not null and final_outcome ~* '^(done|success|succeeded|completed|shipped|verified|resolved)$') as issue_tied_successful_ledger_entries
  from context_ledger_entries
  where created_at >= now() - interval '${interval}'
  group by run_id
), issue_by_run as (
  select execution_run_id as run_id,
    count(*) as execution_issues,
    count(*) filter (where status = 'done' or completed_at is not null) as completed_issues
  from issues
  where execution_run_id is not null
  group by execution_run_id
), run_fact as (
  select c.*, hr.invocation_source, (hr.context_snapshot ? 'issueId') as has_context_issue,
    coalesce(i.execution_issues, 0) as execution_issues,
    coalesce(i.completed_issues, 0) as completed_issues,
    coalesce(l.issue_tied_successful_ledger_entries, 0) as issue_tied_successful_ledger_entries
  from cost_by_run c
  left join heartbeat_runs hr on hr.id = c.heartbeat_run_id
  left join ledger_by_run l on l.run_id = hr.id
  left join issue_by_run i on i.run_id = hr.id
), classified as (
  select *,
    case
      when heartbeat_run_id is null then 'cost_without_run'
      when completed_issues > 0 or issue_tied_successful_ledger_entries > 0 then 'issue_tied_delivery_or_evidence'
      when not has_context_issue and execution_issues = 0 and invocation_source in ('timer', 'on_demand') then 'no_issue_no_deliverable_timer_or_manual'
      when not has_context_issue and execution_issues = 0 then 'no_issue_no_deliverable_other'
      else 'issue_context_without_completed_delivery'
    end as class
  from run_fact
)
select class, count(*) as runs,
  sum(input_tokens) as input_tokens,
  sum(cached_input_tokens) as cached_input_tokens,
  sum(output_tokens) as output_tokens,
  sum(raw_tokens) as raw_tokens,
  round(100.0 * sum(raw_tokens) / nullif((select sum(raw_tokens) from classified), 0), 2) as raw_percent
from classified
group by class
order by raw_tokens desc
`));

  const providerBreakdown = await db.execute(sql.raw(`
select provider, model,
  count(distinct heartbeat_run_id) as runs,
  sum(input_tokens) as input_tokens,
  sum(cached_input_tokens) as cached_input_tokens,
  sum(output_tokens) as output_tokens,
  sum(input_tokens + output_tokens) as raw_tokens
from cost_events
where occurred_at >= now() - interval '${interval}'
group by provider, model
order by raw_tokens desc
`));

  const agentSourceBreakdown = await db.execute(sql.raw(`
with cost_by_run as (
  select heartbeat_run_id, agent_id,
    sum(input_tokens + output_tokens) as raw_tokens
  from cost_events
  where occurred_at >= now() - interval '${interval}'
  group by heartbeat_run_id, agent_id
)
select coalesce(a.name, 'unknown') as agent_name,
  coalesce(a.role, 'unknown') as agent_role,
  hr.invocation_source,
  count(*) as runs,
  sum(c.raw_tokens) as raw_tokens,
  avg(c.raw_tokens)::int as avg_raw_tokens
from cost_by_run c
left join heartbeat_runs hr on hr.id = c.heartbeat_run_id
left join agents a on a.id = c.agent_id
group by a.name, a.role, hr.invocation_source
order by raw_tokens desc
limit 30
`));

  const topRuns = await db.execute(sql.raw(`
with cost_by_run as (
  select heartbeat_run_id, agent_id,
    string_agg(distinct provider || '/' || model, ', ' order by provider || '/' || model) as providers,
    sum(input_tokens) as input_tokens,
    sum(cached_input_tokens) as cached_input_tokens,
    sum(output_tokens) as output_tokens,
    sum(input_tokens + output_tokens) as raw_tokens
  from cost_events
  where occurred_at >= now() - interval '${interval}'
  group by heartbeat_run_id, agent_id
), ledger_by_run as (
  select run_id,
    count(*) as ledger_entries,
    count(issue_id) as ledger_issue_refs,
    coalesce(max(prompt_chars), 0) as max_prompt_chars,
    count(*) filter (where issue_id is not null and final_outcome ~* '^(done|success|succeeded|completed|shipped|verified|resolved)$') as issue_tied_successful_ledger_entries
  from context_ledger_entries
  where created_at >= now() - interval '${interval}'
  group by run_id
), issue_by_run as (
  select execution_run_id as run_id,
    count(*) as execution_issues,
    count(*) filter (where status = 'done' or completed_at is not null) as completed_issues
  from issues
  where execution_run_id is not null
  group by execution_run_id
)
select c.heartbeat_run_id,
  coalesce(a.name, 'unknown') as agent_name,
  coalesce(a.role, 'unknown') as agent_role,
  c.providers,
  hr.invocation_source,
  hr.trigger_detail,
  hr.status,
  hr.error_code,
  (hr.context_snapshot ? 'issueId') as has_context_issue,
  coalesce(i.execution_issues, 0) as execution_issues,
  coalesce(i.completed_issues, 0) as completed_issues,
  coalesce(l.ledger_entries, 0) as ledger_entries,
  coalesce(l.ledger_issue_refs, 0) as ledger_issue_refs,
  coalesce(l.issue_tied_successful_ledger_entries, 0) as issue_tied_successful_ledger_entries,
  length(coalesce(hr.context_snapshot::text, '')) as context_chars,
  coalesce(l.max_prompt_chars, 0) as max_prompt_chars,
  c.input_tokens,
  c.cached_input_tokens,
  c.output_tokens,
  c.raw_tokens
from cost_by_run c
left join heartbeat_runs hr on hr.id = c.heartbeat_run_id
left join agents a on a.id = c.agent_id
left join ledger_by_run l on l.run_id = hr.id
left join issue_by_run i on i.run_id = hr.id
order by c.raw_tokens desc
limit 30
`));

  return {
    burnClasses: normalizeBurnClassRows(burnClasses as unknown[]),
    providerBreakdown: normalizeProviderRows(providerBreakdown as unknown[]),
    agentSourceBreakdown: normalizeAgentSourceRows(agentSourceBreakdown as unknown[]),
    topRuns: normalizeTopRunRows(topRuns as unknown[]),
  };
}

export async function runHermesTokenomicsAnalysis(options: AnalysisOptions = {}): Promise<TokenomicsAnalysisReceipt> {
  const homeDir = options.homeDir ?? DEFAULT_HOME;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const days = Math.max(1, Math.min(30, Math.trunc(options.days ?? 5)));
  const config = await readConfig(homeDir, instanceId);
  const connection = resolveConnectionString(config, options.connectionString);
  const db = createDb(connection.connectionString);
  try {
    const rows = await collectAnalysisRows(db, days);
    const outPath = receiptFilePath(homeDir, instanceId, options.receiptDir);
    const receipt = buildTokenomicsAnalysisReceipt({
      windowDays: days,
      connectionSource: connection.source,
      ...rows,
      receiptPath: outPath,
    });
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    const client = (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } }).$client;
    await client?.end?.({ timeout: 1 }).catch(() => undefined);
  }
}

function parseArgs(argv: string[]): AnalysisOptions {
  const options: AnalysisOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") options.days = Number(argv[++index]);
    else if (arg === "--connection-string") options.connectionString = argv[++index];
    else if (arg === "--home") options.homeDir = argv[++index];
    else if (arg === "--instance") options.instanceId = argv[++index];
    else if (arg === "--receipt-dir") options.receiptDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx server/src/ops/hermes-tokenomics-analysis.ts [--days <n>] [--connection-string <url>]");
      process.exit(0);
    }
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermesTokenomicsAnalysis(parseArgs(process.argv.slice(2))).then((receipt) => {
    const candidate = receipt.deterministicRequestCandidates[0] ?? null;
    console.log(JSON.stringify({
      version: receipt.version,
      windowDays: receipt.windowDays,
      totalRawTokens: receipt.totals.rawTokens,
      topWasteClass: receipt.burnClasses[0] ?? null,
      estimatedSavingsRatioOfTotal: candidate?.estimatedSavingsRatioOfTotal ?? 0,
      receiptPath: receipt.receiptPath,
    }, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
