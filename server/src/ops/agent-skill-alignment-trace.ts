import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseEnvFileContents } from "dotenv";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { resolveDefaultAgentSkillPolicy } from "../services/default-agent-instructions.js";

const DEFAULT_HOME = "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit";
const DEFAULT_INSTANCE_ID = "default";
const DEFAULT_RECEIPT_DIR = "data/ops/agent-skill-alignment/runs";
const DEFAULT_HTML_OUT = "/Users/mnm/Documents/Github/paperclip/docs/reports/agent-skill-alignment-dashboard.html";
const VERSION = "agent-skill-alignment-trace.v1";
const REQUIRED_SKILL = "paperclipai/paperclip/paperclip";

type JsonRecord = Record<string, unknown>;

type ConfigFile = {
  database?: {
    connectionString?: string;
    embeddedPostgresPort?: number;
  };
};

type Db = ReturnType<typeof createDb>;
type DbWithClient = Db & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

type CompanyRow = {
  id: string;
  name: string;
  issue_prefix: string | null;
};

type AgentRow = {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapter_type: string;
  adapter_config: JsonRecord | null;
  runtime_config: JsonRecord | null;
  last_heartbeat_at: Date | string | null;
};

type SkillRow = {
  id: string;
  company_id: string;
  key: string;
  slug: string;
  name: string;
  source_type: string;
  trust_level: string;
  compatibility: string;
};

type RunTraceRow = {
  issue_prefix: string | null;
  company_name: string;
  agent_id: string;
  agent_name: string;
  role: string;
  adapter_type: string;
  run_id: string;
  status: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  skill_budget: JsonRecord | null;
  selected_adapter_type: string | null;
  provider: string | null;
  model: string | null;
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : [];
}

type AgentTrace = {
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
  desiredSkills: string[];
  desiredCount: number;
  expectedRoleSkills: string[];
  missingRoleSkills: string[];
  afterRepairDesiredSkills: string[];
  afterRepairDesiredCount: number;
  changedByRepair: boolean;
  risk: "ok" | "warning" | "critical";
  riskReasons: string[];
};

type CompanyTrace = {
  companyId: string;
  name: string;
  issuePrefix: string | null;
  skillCount: number;
  agents: AgentTrace[];
};

type TraceReport = {
  version: string;
  generatedAt: string;
  status: "trace_only" | "applied";
  connectionSource: string;
  htmlPath: string;
  receiptPath: string;
  summary: {
    companies: number;
    agents: number;
    hermesAgents: number;
    undercoveredAgents: number;
    changedAgents: number;
    recentRuns: number;
    recentRunsWithSkillBudget: number;
    recentRunsMissingSkillBudget: number;
  };
  companies: CompanyTrace[];
  recentRunTraces: RunTraceRow[];
  findings: Array<{
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
  }>;
};

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
    source: "embedded_default",
  };
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)));
}

function normalizeRef(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function displaySkill(skill: string) {
  const last = skill.split("/").filter(Boolean).pop() ?? skill;
  return last.replace(/--[a-f0-9]{8,}$/i, "");
}

function resolveOptionalSkillKeys(skills: SkillRow[], refs: string[]) {
  const byKey = new Map(skills.map((skill) => [normalizeRef(skill.key), skill.key]));
  const bySlug = new Map<string, string[]>();
  for (const skill of skills) {
    const normalized = normalizeRef(skill.slug);
    const rows = bySlug.get(normalized) ?? [];
    rows.push(skill.key);
    bySlug.set(normalized, rows);
  }
  return refs
    .map((ref) => {
      const key = byKey.get(normalizeRef(ref));
      if (key) return key;
      const slug = normalizeRef(ref.split("/").filter(Boolean).pop() ?? ref);
      const matches = bySlug.get(slug) ?? [];
      return matches.length === 1 ? matches[0] ?? null : null;
    })
    .filter((value): value is string => Boolean(value));
}

function buildAgentTrace(company: CompanyRow, skills: SkillRow[], agent: AgentRow): AgentTrace {
  const adapterConfig = asRecord(agent.adapter_config);
  const skillSync = asRecord(adapterConfig.paperclipSkillSync);
  const desiredSkills = stringArray(skillSync.desiredSkills);
  const policy = resolveDefaultAgentSkillPolicy(agent.role);
  const optionalSkills = resolveOptionalSkillKeys(skills, policy.optionalDesiredSkills);
  const expectedRoleSkills = unique([
    REQUIRED_SKILL,
    ...policy.desiredSkills,
    ...optionalSkills,
  ]);
  const missingRoleSkills = expectedRoleSkills.filter((skill) => !desiredSkills.includes(skill));
  const afterRepairDesiredSkills = unique([...desiredSkills, ...expectedRoleSkills]);
  const riskReasons: string[] = [];
  if (desiredSkills.length <= 1) riskReasons.push("desired skill set has one or zero entries");
  if (!desiredSkills.includes(REQUIRED_SKILL)) riskReasons.push("required Paperclip coordination skill is absent from desiredSkills");
  if (missingRoleSkills.length > 0) riskReasons.push(`${missingRoleSkills.length} role-aligned skills missing`);
  const risk = desiredSkills.length <= 1 || !desiredSkills.includes(REQUIRED_SKILL)
    ? "critical"
    : missingRoleSkills.length > 0
      ? "warning"
      : "ok";
  return {
    agentId: agent.id,
    companyId: company.id,
    companyName: company.name,
    issuePrefix: company.issue_prefix,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    adapterType: agent.adapter_type,
    lastHeartbeatAt: agent.last_heartbeat_at ? new Date(agent.last_heartbeat_at).toISOString() : null,
    desiredSkills,
    desiredCount: desiredSkills.length,
    expectedRoleSkills,
    missingRoleSkills,
    afterRepairDesiredSkills,
    afterRepairDesiredCount: afterRepairDesiredSkills.length,
    changedByRepair: JSON.stringify(desiredSkills) !== JSON.stringify(afterRepairDesiredSkills),
    risk,
    riskReasons,
  };
}

async function applyRepairs(db: Db, agents: AgentTrace[]) {
  for (const agent of agents.filter((row) => row.changedByRepair)) {
    const existing = rows<AgentRow>(await db.execute(sql`
      select adapter_config
      from agents
      where id = ${agent.agentId}
    `));
    const current = asRecord(existing[0]?.adapter_config);
    const currentSync = asRecord(current.paperclipSkillSync);
    const nextConfig = {
      ...current,
      paperclipSkillSync: {
        ...currentSync,
        desiredSkills: agent.afterRepairDesiredSkills,
      },
    };
    await db.execute(sql`
      update agents
      set adapter_config = ${JSON.stringify(nextConfig)}::jsonb,
          updated_at = now()
      where id = ${agent.agentId}
    `);
  }
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function renderList(values: string[], limit = 8) {
  if (values.length === 0) return "<span class=\"muted\">None</span>";
  const shown = values.slice(0, limit).map((value) => `<span class="pill">${htmlEscape(displaySkill(value))}</span>`).join("");
  const extra = values.length > limit ? `<span class="pill muted">+${values.length - limit}</span>` : "";
  return shown + extra;
}

function renderHtml(report: TraceReport) {
  const agents = report.companies.flatMap((company) => company.agents);
  const riskClass = (risk: AgentTrace["risk"]) => risk === "critical" ? "bad" : risk === "warning" ? "warn" : "ok";
  const companyRows = report.companies.map((company) => {
    const critical = company.agents.filter((agent) => agent.risk === "critical").length;
    const warning = company.agents.filter((agent) => agent.risk === "warning").length;
    return `<tr><td>${htmlEscape(company.issuePrefix)}</td><td>${htmlEscape(company.name)}</td><td>${company.agents.length}</td><td>${company.skillCount}</td><td>${critical}</td><td>${warning}</td></tr>`;
  }).join("\n");
  const agentRows = agents.map((agent) => `
    <tr>
      <td>${htmlEscape(agent.issuePrefix)}</td>
      <td>${htmlEscape(agent.name)}</td>
      <td>${htmlEscape(agent.role)}</td>
      <td>${htmlEscape(agent.adapterType)}</td>
      <td><span class="status ${riskClass(agent.risk)}">${agent.risk}</span></td>
      <td>${agent.desiredCount}</td>
      <td>${agent.afterRepairDesiredCount}</td>
      <td>${renderList(agent.missingRoleSkills)}</td>
      <td>${htmlEscape(agent.riskReasons.join("; "))}</td>
    </tr>`).join("\n");
  const runRows = report.recentRunTraces.slice(0, 80).map((run) => {
    const budget = asRecord(run.skill_budget);
    const selected = stringArray(budget.selected);
    const skipped = stringArray(budget.skipped);
    return `
      <tr>
        <td>${htmlEscape(run.issue_prefix)}</td>
        <td>${htmlEscape(run.agent_name)}</td>
        <td>${htmlEscape(run.role)}</td>
        <td>${htmlEscape(run.status)}</td>
        <td>${htmlEscape(run.started_at ? new Date(run.started_at).toISOString() : "")}</td>
        <td>${selected.length}</td>
        <td>${skipped.length}</td>
        <td>${renderList(selected, 6)}</td>
        <td>${renderList(skipped, 6)}</td>
      </tr>`;
  }).join("\n");
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
  <title>Paperclip Agent Skill Alignment Trace</title>
  <style>
    :root { color-scheme: light; --ink:#152025; --muted:#66767f; --line:#d8e0e4; --bg:#f7f9fa; --panel:#fff; --bad:#9f1d1d; --warn:#a05b00; --ok:#1f6b3a; --blue:#205c8a; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
    header { padding:28px 32px 20px; background:#12313f; color:white; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    h2 { margin:28px 0 12px; font-size:18px; }
    h3 { margin:0 0 6px; font-size:15px; }
    main { padding:24px 32px 40px; }
    .meta { color:#d3e2e8; font-size:13px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px; }
    .card, .finding { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .metric { font-size:28px; font-weight:700; }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:9px 10px; font-size:13px; vertical-align:top; }
    th { background:#eaf0f3; font-size:12px; color:#30434d; }
    tr:last-child td { border-bottom:0; }
    .status, .pill { display:inline-block; border-radius:999px; padding:2px 8px; margin:1px 3px 1px 0; font-size:12px; border:1px solid var(--line); background:#f2f5f6; }
    .bad { color:var(--bad); border-color:#e2b7b7; background:#fff1f1; }
    .warn { color:var(--warn); border-color:#e4c48f; background:#fff7e8; }
    .ok { color:var(--ok); border-color:#b4d4c0; background:#edf8f0; }
    .muted { color:var(--muted); }
    .finding.critical { border-left:4px solid var(--bad); }
    .finding.warning { border-left:4px solid var(--warn); }
    .finding.info { border-left:4px solid var(--blue); }
  </style>
</head>
<body>
  <header>
    <h1>Paperclip Agent Skill Alignment Trace</h1>
    <div class="meta">Generated ${htmlEscape(report.generatedAt)} | Status ${htmlEscape(report.status)} | Receipt ${htmlEscape(report.receiptPath)}</div>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="label">Companies</div><div class="metric">${report.summary.companies}</div></div>
      <div class="card"><div class="label">Agents</div><div class="metric">${report.summary.agents}</div></div>
      <div class="card"><div class="label">Hermes Agents</div><div class="metric">${report.summary.hermesAgents}</div></div>
      <div class="card"><div class="label">Undercovered</div><div class="metric">${report.summary.undercoveredAgents}</div></div>
      <div class="card"><div class="label">Changed By Repair</div><div class="metric">${report.summary.changedAgents}</div></div>
      <div class="card"><div class="label">Runs With Skill Trace</div><div class="metric">${report.summary.recentRunsWithSkillBudget}/${report.summary.recentRuns}</div></div>
    </section>

    <h2>Findings</h2>
    <section class="grid">${findingCards}</section>

    <h2>Company Coverage</h2>
    <table><thead><tr><th>Prefix</th><th>Company</th><th>Agents</th><th>Installed Skills</th><th>Critical</th><th>Warnings</th></tr></thead><tbody>${companyRows}</tbody></table>

    <h2>Agent Role Alignment</h2>
    <table><thead><tr><th>Prefix</th><th>Agent</th><th>Role</th><th>Adapter</th><th>Risk</th><th>Before</th><th>After</th><th>Missing Role Skills</th><th>Evidence</th></tr></thead><tbody>${agentRows}</tbody></table>

    <h2>Recent Hermes Runtime Skill Selection</h2>
    <table><thead><tr><th>Prefix</th><th>Agent</th><th>Role</th><th>Run Status</th><th>Started</th><th>Selected</th><th>Skipped</th><th>Selected Skills</th><th>Skipped Skills</th></tr></thead><tbody>${runRows}</tbody></table>
  </main>
</body>
</html>`;
}

async function collectCompanyTraces(db: Db): Promise<CompanyTrace[]> {
  const companies = rows<CompanyRow>(await db.execute(sql`
    select id, name, issue_prefix
    from companies
    where status = 'active'
    order by issue_prefix
  `));
  const companyTraces: CompanyTrace[] = [];
  for (const company of companies) {
    const skills = rows<SkillRow>(await db.execute(sql`
      select id, company_id, key, slug, name, source_type, trust_level, compatibility
      from company_skills
      where company_id = ${company.id}
      order by slug
    `));
    const agents = rows<AgentRow>(await db.execute(sql`
      select id, company_id, name, role, title, status, adapter_type, adapter_config, runtime_config, last_heartbeat_at
      from agents
      where company_id = ${company.id}
        and status <> 'terminated'
      order by role, name
    `));
    companyTraces.push({
      companyId: company.id,
      name: company.name,
      issuePrefix: company.issue_prefix,
      skillCount: skills.length,
      agents: agents.map((agent) => buildAgentTrace(company, skills, agent)),
    });
  }
  return companyTraces;
}

async function buildReport(options: { apply: boolean; htmlPath: string; receiptPath: string; connectionString: string; connectionSource: string }) {
  const db = createDb(options.connectionString);
  try {
    const preRepairCompanyTraces = await collectCompanyTraces(db);
    const preRepairAgents = preRepairCompanyTraces.flatMap((company) => company.agents);
    const changedAgents = preRepairAgents.filter((agent) => agent.changedByRepair).length;
    if (options.apply) await applyRepairs(db, preRepairAgents);
    const companyTraces = options.apply ? await collectCompanyTraces(db) : preRepairCompanyTraces;
    const allAgents = companyTraces.flatMap((company) => company.agents);
    const recentRunTraces = rows<RunTraceRow>(await db.execute(sql.raw(
      `select c.issue_prefix,
              c.name as company_name,
              a.id as agent_id,
              a.name as agent_name,
              a.role,
              a.adapter_type,
              hr.id as run_id,
              hr.status,
              hr.started_at,
              hr.finished_at,
              hre.payload->'promptMetrics'->'skillBudget' as skill_budget,
              hr.usage_json->'providerLane'->>'selectedAdapterType' as selected_adapter_type,
              hr.usage_json->>'provider' as provider,
              hr.usage_json->>'model' as model
         from heartbeat_run_events hre
         join heartbeat_runs hr on hr.id=hre.run_id
         join agents a on a.id=hr.agent_id
         join companies c on c.id=hr.company_id
        where hre.event_type='adapter.invoke'
          and hr.started_at > now() - interval '7 days'
        order by hr.started_at desc
        limit 500`,
    )));
    const undercoveredAgents = allAgents.filter((agent) => agent.risk === "critical").length;
    const recentRunsWithSkillBudget = recentRunTraces.filter((run) => run.skill_budget).length;
    const findings: TraceReport["findings"] = [
      {
        severity: undercoveredAgents > 0 ? "critical" : "info",
        title: "Live desired skill drift",
        detail: undercoveredAgents > 0
          ? `${undercoveredAgents} active-company agents had one or zero desired skills or lacked the required Paperclip coordination skill.`
          : "No active-company agent is missing the required Paperclip coordination skill after the trace calculation.",
      },
      {
        severity: "warning",
        title: "Hermes adaptive selector was too name-driven",
        detail: "Recent Hermes traces show role-relevant specialty skills skipped while only core product/market/memory/Ponytail skills were selected. The code fix makes selection role-aware and adds keyword triggers for research, PM, QA, design, and release skills.",
      },
      {
        severity: "warning",
        title: "Historical Hermes skill snapshots were not inspectable",
        detail: "The Hermes adapter previously returned an empty skill snapshot even though execution symlinked skills and passed -s arguments. The adapter now reports and syncs ~/.hermes/skills/paperclip links.",
      },
    ];
    const report: TraceReport = {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      status: options.apply ? "applied" : "trace_only",
      connectionSource: options.connectionSource,
      htmlPath: options.htmlPath,
      receiptPath: options.receiptPath,
      summary: {
        companies: companyTraces.length,
        agents: allAgents.length,
        hermesAgents: allAgents.filter((agent) => agent.adapterType === "hermes_local").length,
        undercoveredAgents,
        changedAgents,
        recentRuns: recentRunTraces.length,
        recentRunsWithSkillBudget,
        recentRunsMissingSkillBudget: recentRunTraces.length - recentRunsWithSkillBudget,
      },
      companies: companyTraces,
      recentRunTraces,
      findings,
    };
    await mkdir(path.dirname(options.receiptPath), { recursive: true });
    await mkdir(path.dirname(options.htmlPath), { recursive: true });
    await writeFile(options.receiptPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(options.htmlPath, renderHtml(report), "utf8");
    return report;
  } finally {
    await (db as DbWithClient).$client?.end?.({ timeout: 1 });
  }
}

export async function main() {
  const homeDir = argValue("--home", DEFAULT_HOME) ?? DEFAULT_HOME;
  const instanceId = argValue("--instance", DEFAULT_INSTANCE_ID) ?? DEFAULT_INSTANCE_ID;
  const apply = hasFlag("--apply");
  const htmlPath = path.resolve(argValue("--html-out", DEFAULT_HTML_OUT) ?? DEFAULT_HTML_OUT);
  const now = timestampForPath();
  const receiptPath = path.resolve(
    argValue("--receipt-out") ??
      path.join(homeDir, "instances", instanceId, DEFAULT_RECEIPT_DIR, `${now}-agent-skill-alignment-trace.json`),
  );
  const { connectionString, source } = await resolveConnectionString(homeDir, instanceId);
  const report = await buildReport({
    apply,
    htmlPath,
    receiptPath,
    connectionString,
    connectionSource: source,
  });
  console.log(JSON.stringify({
    status: report.status,
    summary: report.summary,
    receiptPath: report.receiptPath,
    htmlPath: report.htmlPath,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
