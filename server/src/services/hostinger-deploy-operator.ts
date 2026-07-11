import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agents,
  companies,
  issues,
  projectWorkspaces,
  projects,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { agentService } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import {
  DEFAULT_HOSTINGER_API_KEY_FILE,
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_FILE_SECRET_NAME,
  HOSTINGER_FIREWALL_ID_SECRET_NAME,
  HOSTINGER_VM_ID_SECRET_NAME,
  resolveHostingerApiKeyFilePath,
} from "./deployment-target-policy.js";

export const HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME = "Hostinger Deploy Operator";
export const HOSTINGER_DEPLOY_OPERATOR_ROLE = "devops";
export const HOSTINGER_DEPLOY_OPERATOR_TITLE = "Hostinger Deployment Specialist";
export const HOSTINGER_DEPLOY_OPERATOR_SKILL_SLUG = "hostinger-deploy-operator";
export const HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY = `paperclipai/paperclip/${HOSTINGER_DEPLOY_OPERATOR_SKILL_SLUG}`;
export const HOSTINGER_DEPLOY_OPERATOR_BOOTSTRAP_VERSION = "hostinger-deploy-operator.v1";

export const HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS = [
  "paperclipai/paperclip/paperclip",
  "paperclipai/paperclip/paperclip-integration-engineer",
  HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
  "paperclipai/paperclip/ponytail",
] as const;

export const HOSTINGER_DEPLOY_OPERATOR_REQUIRED_SKILLS = [
  HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
] as const;

type JsonRecord = Record<string, unknown>;

export type HostingerDeployOperatorBootstrapResult = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  agentId: string;
  agentName: string;
  action: "created" | "updated" | "unchanged";
  cwd: string;
  reportsTo: string | null;
  desiredSkills: string[];
  requiredSkills: string[];
  missingSkillKeys: string[];
  retargetedIssueIdentifiers: string[];
  retargetedRoutineIds: string[];
};

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function mergeDesiredSkills(adapterConfig: JsonRecord, skillKeys: readonly string[]) {
  const current = readPaperclipSkillSyncPreference(adapterConfig).desiredSkills;
  return unique([...current, ...skillKeys]);
}

export function buildHostingerDeployOperatorCapabilities() {
  return [
    "Owns Hostinger VPS deployment target inventory, provisioning, firewall hardening, and deployment receipts.",
    `Produces and maintains ${HOSTINGER_VM_ID_SECRET_NAME}, ${HOSTINGER_FIREWALL_ID_SECRET_NAME}, and ${HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME} evidence for Paperclip deploy lanes.`,
    "Uses Hostinger API read/configure paths first and requires explicit board approval before any purchase or destructive infrastructure action.",
    "Blocks with exact HTTP endpoint/status evidence instead of retrying authorization or quota failures.",
  ].join(" ");
}

export function buildHostingerDeployOperatorInstructions(companyName: string, issuePrefix: string) {
  return [
    `You are the Hostinger Deploy Operator for ${companyName} (${issuePrefix}).`,
    "",
    "Your job is to produce cake: a reachable, private-by-default Hostinger deployment target with receipts.",
    "",
    "Rules:",
    "- Use the `hostinger-deploy-operator` skill for every Hostinger VPS, firewall, or endpoint task.",
    "- Read the Hostinger API key only from `HOSTINGER_API_KEY_FILE`; never print, paste, commit, or summarize the key value.",
    "- First inventory existing VPS and firewall resources. Reuse a correct target when one exists.",
    "- Create or purchase infrastructure only when the issue explicitly authorizes spending or the board has approved it.",
    "- Configure firewalls to deny inbound traffic by default and allow only `HOSTINGER_ALLOWED_CLIENT_IP` for required ports.",
    "- After firewall rule changes, activate or sync the firewall to the VM and record the receipt.",
    "- Close work only with VM ID, firewall ID, endpoint/IP, firewall rule inventory, health check, and rollback receipts.",
    "- If Hostinger returns 401/403/zero inventory that prevents progress, block once with endpoint/status evidence and assign to the board.",
  ].join("\n");
}

export function buildHostingerDeployOperatorAdapterConfig(input: {
  existingAdapterConfig?: unknown;
  cwd: string;
  allowedClientIp?: string | null;
  apiKeyFile?: string | null;
}) {
  const existing = asRecord(input.existingAdapterConfig);
  const env = {
    ...asRecord(existing.env),
    [HOSTINGER_API_KEY_FILE_SECRET_NAME]: input.apiKeyFile || resolveHostingerApiKeyFilePath(),
    ...(input.allowedClientIp
      ? { [HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME]: input.allowedClientIp }
      : {}),
  };
  const desiredSkills = mergeDesiredSkills(existing, HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS);
  const next = {
    ...existing,
    cwd: input.cwd,
    yolo: existing.yolo ?? true,
    source: existing.source ?? "paperclip",
    search: existing.search ?? true,
    provider: existing.provider ?? "opencode-go",
    model: existing.model ?? "deepseek-v4-pro",
    command: existing.command ?? "/Users/mnm/.local/bin/hermes",
    hermesCommand: existing.hermesCommand ?? existing.command ?? "/Users/mnm/.local/bin/hermes",
    timeoutSec: existing.timeoutSec ?? 1800,
    outputMaxChars: existing.outputMaxChars ?? 3200,
    contextMaxChars: existing.contextMaxChars ?? 24000,
    outputMaxSentences: existing.outputMaxSentences ?? 12,
    disableFallbackModel: existing.disableFallbackModel ?? true,
    checkpoints: existing.checkpoints ?? true,
    env,
  };
  return writePaperclipSkillSyncPreference(next, desiredSkills, [...HOSTINGER_DEPLOY_OPERATOR_REQUIRED_SKILLS]);
}

export function buildHostingerDeployOperatorRuntimeConfig(existingRuntimeConfig?: unknown) {
  return {
    ...asRecord(existingRuntimeConfig),
    heartbeat: {
      enabled: true,
      intervalSec: 300,
      wakeOnDemand: true,
      ...asRecord(asRecord(existingRuntimeConfig).heartbeat),
    },
  };
}

async function findCompany(db: Db, companyId: string) {
  return db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
}

async function findExistingOperator(db: Db, companyId: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
  const targetKey = normalizeAgentUrlKey(HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME);
  return rows.find((row) => normalizeAgentUrlKey(row.name) === targetKey) ?? null;
}

async function findManagerAgentId(db: Db, companyId: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
  const preferredRoles = ["cto", "ceo", "pm", "devops"];
  for (const role of preferredRoles) {
    const match = rows.find((agent) => agent.role === role && agent.name !== HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME);
    if (match) return match.id;
  }
  return null;
}

export async function resolveHostingerDeployOperatorCwd(db: Db, companyId: string) {
  const rows = await db
    .select({
      cwd: projectWorkspaces.cwd,
    })
    .from(projectWorkspaces)
    .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
    .where(and(
      eq(projectWorkspaces.companyId, companyId),
      sql`${projectWorkspaces.cwd} is not null and ${projectWorkspaces.cwd} <> ''`,
    ))
    .orderBy(
      sql`case when ${projectWorkspaces.isPrimary} then 0 else 1 end`,
      sql`case ${projects.status} when 'in_progress' then 0 when 'planned' then 1 when 'backlog' then 2 else 3 end`,
      desc(projects.updatedAt),
      desc(projectWorkspaces.updatedAt),
    )
    .limit(1);

  return rows[0]?.cwd ?? "/Users/mnm/Documents/Github/paperclip";
}

export async function retargetHostingerDeploymentIssues(db: Db, companyId: string, agentId: string) {
  const openStatuses = ["backlog", "todo", "in_progress", "blocked"];
  const rows = await db
    .update(issues)
    .set({
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: sql`case when ${issues.status} = 'blocked' then 'todo' else ${issues.status} end`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.status, openStatuses),
      sql`(
        ${issues.title} ilike '%Hostinger%'
        or ${issues.description} ilike '%Hostinger%'
        or ${issues.executionState}::text ilike '%hostinger_deployment_target_blocked%'
      )`,
    ))
    .returning({
      identifier: issues.identifier,
    });
  return rows
    .map((row) => row.identifier)
    .filter((value): value is string => Boolean(value));
}

export async function retargetHostingerDeploymentRoutines(db: Db, companyId: string, agentId: string) {
  const rows = await db
    .update(routines)
    .set({
      assigneeAgentId: agentId,
      status: sql`case when ${routines.status} = 'paused' then 'active' else ${routines.status} end`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(routines.companyId, companyId),
      inArray(routines.status, ["active", "paused"]),
      sql`(
        ${routines.title} ilike '%deploy%'
        or ${routines.title} ilike '%deployment%'
        or ${routines.title} ilike '%public endpoint%'
        or ${routines.title} ilike '%live endpoint%'
        or ${routines.title} ilike '%production endpoint%'
        or ${routines.description} ilike '%\"lane\": \"deploy\"%'
        or ${routines.description} ilike '%\"provider\": \"hostinger\"%'
      )`,
    ))
    .returning({ id: routines.id });
  return rows.map((row) => row.id);
}

export async function ensureHostingerDeployOperatorForCompany(
  db: Db,
  companyId: string,
  options?: {
    allowedClientIp?: string | null;
    retargetIssues?: boolean;
  },
): Promise<HostingerDeployOperatorBootstrapResult | null> {
  const company = await findCompany(db, companyId);
  if (!company || company.status !== "active") return null;

  const skills = await companySkillService(db).listFull(companyId);
  const skillKeys = new Set(skills.map((skill) => skill.key));
  const missingSkillKeys = HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS
    .filter((key) => !skillKeys.has(key));
  const existing = await findExistingOperator(db, companyId);
  const cwd = await resolveHostingerDeployOperatorCwd(db, companyId);
  const reportsTo = await findManagerAgentId(db, companyId);
  const instructions = buildHostingerDeployOperatorInstructions(company.name, company.issuePrefix);
  const adapterConfig = {
    ...buildHostingerDeployOperatorAdapterConfig({
      existingAdapterConfig: existing?.adapterConfig,
      cwd,
      allowedClientIp: options?.allowedClientIp ?? process.env[HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME] ?? null,
      apiKeyFile: process.env[HOSTINGER_API_KEY_FILE_SECRET_NAME] || DEFAULT_HOSTINGER_API_KEY_FILE,
    }),
    promptTemplate: instructions,
  };
  const runtimeConfig = buildHostingerDeployOperatorRuntimeConfig(existing?.runtimeConfig);

  const agentSvc = agentService(db);
  let action: HostingerDeployOperatorBootstrapResult["action"] = "unchanged";
  const patch = {
    name: HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
    role: HOSTINGER_DEPLOY_OPERATOR_ROLE,
    title: HOSTINGER_DEPLOY_OPERATOR_TITLE,
    icon: "server",
    reportsTo,
    status: existing?.status === "pending_approval" ? existing.status : "idle",
    pauseReason: null,
    pausedAt: null,
    capabilities: buildHostingerDeployOperatorCapabilities(),
    adapterType: existing?.adapterType ?? "hermes_local",
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: existing?.budgetMonthlyCents ?? 0,
    metadata: {
      ...asRecord(existing?.metadata),
      managedBy: HOSTINGER_DEPLOY_OPERATOR_BOOTSTRAP_VERSION,
      deployProvider: "hostinger",
      requiredSecrets: [
        HOSTINGER_API_KEY_FILE_SECRET_NAME,
        HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
        HOSTINGER_VM_ID_SECRET_NAME,
        HOSTINGER_FIREWALL_ID_SECRET_NAME,
      ],
      instructions,
    },
  };

  const agent = existing
    ? await agentSvc.update(existing.id, patch, {
        recordRevision: { source: HOSTINGER_DEPLOY_OPERATOR_BOOTSTRAP_VERSION },
      }).then((updated) => {
        action = updated ? "updated" : "unchanged";
        return updated;
      })
    : await agentSvc.create(companyId, patch).then((created) => {
        action = "created";
        return created;
      });

  if (!agent) return null;
  const retargetedIssueIdentifiers = options?.retargetIssues === false
    ? []
    : await retargetHostingerDeploymentIssues(db, companyId, agent.id);
  const retargetedRoutineIds = options?.retargetIssues === false
    ? []
    : await retargetHostingerDeploymentRoutines(db, companyId, agent.id);
  const skillSyncPreference = readPaperclipSkillSyncPreference(agent.adapterConfig as JsonRecord);

  return {
    companyId,
    companyName: company.name,
    issuePrefix: company.issuePrefix,
    agentId: agent.id,
    agentName: agent.name,
    action,
    cwd,
    reportsTo,
    desiredSkills: skillSyncPreference.desiredSkills,
    requiredSkills: skillSyncPreference.requiredSkills,
    missingSkillKeys,
    retargetedIssueIdentifiers,
    retargetedRoutineIds,
  };
}

export async function ensureHostingerDeployOperatorsForActiveCompanies(
  db: Db,
  options?: {
    allowedClientIp?: string | null;
    retargetIssues?: boolean;
  },
) {
  const activeCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"))
    .orderBy(companies.createdAt);
  const results: HostingerDeployOperatorBootstrapResult[] = [];
  for (const company of activeCompanies) {
    const result = await ensureHostingerDeployOperatorForCompany(db, company.id, options);
    if (result) results.push(result);
  }
  return results;
}
