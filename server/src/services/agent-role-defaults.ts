import type { Db } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { companySkillService } from "./company-skills.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
  resolveDefaultAgentSkillPolicy,
} from "./default-agent-instructions.js";
import { resolveAgentOpenCodeGoRoleRouting } from "./agent-model-routing.js";

const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "droid_local",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

const ADAPTERS_REQUIRING_MATERIALIZED_RUNTIME_SKILLS = new Set([
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

type AgentLike = {
  id: string;
  companyId: string;
  role: string;
  adapterType: string;
  adapterConfig: unknown;
  name: string;
};

type ResolveDesiredSkillAssignmentOptions = {
  includeRoleDefaults?: boolean;
};

type RepairAgentRoleDefaultsOptions = {
  overwriteManagedInstructions?: boolean;
  repairModelRouting?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
  return ADAPTERS_REQUIRING_MATERIALIZED_RUNTIME_SKILLS.has(adapterType);
}

function resolveSkillReferenceKey(
  skills: Array<{ id: string; key: string; slug: string }>,
  reference: string,
): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) return byId.key;

  const normalizedKey = normalizeSkillKey(trimmed);
  if (normalizedKey) {
    const byKey = skills.find((skill) => skill.key === normalizedKey);
    if (byKey) return byKey.key;
  }

  const normalizedSlug = normalizeSkillSlug(trimmed);
  if (!normalizedSlug) return null;

  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length !== 1) return null;
  return bySlug[0]?.key ?? null;
}

export function agentRoleDefaultsService(db: Db) {
  const agents = agentService(db);
  const instructions = agentInstructionsService();
  const companySkills = companySkillService(db);

  async function resolveAvailableOptionalSkillKeys(companyId: string, references: string[]) {
    if (references.length === 0) return [];
    const skills = await companySkills.listFull(companyId);
    return unique(
      references
        .map((reference) => resolveSkillReferenceKey(skills, reference))
        .filter((value): value is string => Boolean(value)),
    );
  }

  async function resolveExistingDesiredSkillKeys(companyId: string, adapterConfig: Record<string, unknown>) {
    const references = readPaperclipSkillSyncPreference(adapterConfig).desiredSkills;
    if (references.length === 0) return [];
    const skills = await companySkills.listFull(companyId);
    return unique(
      references
        .map((reference) => resolveSkillReferenceKey(skills, reference) ?? normalizeSkillKey(reference))
        .filter((value): value is string => Boolean(value)),
    );
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    role: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
    options?: ResolveDesiredSkillAssignmentOptions,
  ) {
    const policy = resolveDefaultAgentSkillPolicy(role);
    const availableOptionalSkillKeys = await resolveAvailableOptionalSkillKeys(
      companyId,
      policy.optionalDesiredSkills,
    );
    const roleDefaultDesiredSkills = unique([
      ...policy.desiredSkills,
      ...availableOptionalSkillKeys,
    ]);
    const requestedOrDefaultDesiredSkills = options?.includeRoleDefaults === false
      ? (requestedDesiredSkills ?? [])
      : requestedDesiredSkills === undefined
        ? roleDefaultDesiredSkills
        : requestedDesiredSkills.length === 0
          ? []
          : unique([...roleDefaultDesiredSkills, ...requestedDesiredSkills]);

    const resolvedRequestedSkills = await companySkills.resolveRequestedSkillKeys(
      companyId,
      requestedOrDefaultDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    const requiredSkills = runtimeSkillEntries
      .filter((entry) => entry.required)
      .map((entry) => entry.key);
    const desiredSkills = unique([...requiredSkills, ...resolvedRequestedSkills]);

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkills),
      desiredSkills,
      runtimeSkillEntries,
      availableOptionalSkillKeys,
    };
  }

  async function materializeDefaultInstructionsBundleForAgent<T extends AgentLike>(
    agent: T,
    options?: { replaceManaged?: boolean },
  ) {
    if (!DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(agent.adapterType)) {
      return {
        agent,
        changed: false,
        action: "skipped_unsupported" as const,
      };
    }

    const adapterConfig = asRecord(agent.adapterConfig);
    const bundle = await instructions.getBundle(agent);
    if (bundle.mode === "external") {
      return {
        agent,
        changed: false,
        action: "skipped_external" as const,
      };
    }

    const shouldReplaceManaged = bundle.mode === "managed" && options?.replaceManaged === true;
    const needsMaterializedBundle = bundle.mode === null || shouldReplaceManaged;
    if (!needsMaterializedBundle) {
      return {
        agent,
        changed: false,
        action: "unchanged" as const,
      };
    }

    const promptTemplate = typeof adapterConfig.promptTemplate === "string"
      ? adapterConfig.promptTemplate
      : "";
    const files = promptTemplate.trim().length === 0
      ? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role))
      : { "AGENTS.md": promptTemplate };
    const materialized = await instructions.materializeManagedBundle(
      { ...agent, adapterConfig },
      files,
      {
        entryFile: "AGENTS.md",
        replaceExisting: shouldReplaceManaged,
      },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;

    const updated = await agents.update(agent.id, { adapterConfig: nextAdapterConfig });
    return {
      agent: (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig },
      changed: true,
      action: shouldReplaceManaged ? "replaced_managed" as const : "created_managed" as const,
    };
  }

  async function repairAgentRoleDefaults(
    agentId: string,
    options?: RepairAgentRoleDefaultsOptions,
  ) {
    const existing = await agents.getById(agentId);
    if (!existing) {
      return null;
    }

    const existingAdapterConfig = asRecord(existing.adapterConfig);
    const existingDesiredSkills = await resolveExistingDesiredSkillKeys(
      existing.companyId,
      existingAdapterConfig,
    );
    const policy = resolveDefaultAgentSkillPolicy(existing.role);
    const availableOptionalSkillKeys = await resolveAvailableOptionalSkillKeys(
      existing.companyId,
      policy.optionalDesiredSkills,
    );
    const mergedDesiredReferences = unique([
      ...existingDesiredSkills,
      ...policy.desiredSkills,
      ...availableOptionalSkillKeys,
    ]);

    const skillAssignment = await resolveDesiredSkillAssignment(
      existing.companyId,
      existing.role,
      existing.adapterType,
      existingAdapterConfig,
      mergedDesiredReferences,
      { includeRoleDefaults: false },
    );

    const modelRouting = resolveAgentOpenCodeGoRoleRouting({
      role: existing.role,
      adapterType: existing.adapterType,
      adapterConfig: skillAssignment.adapterConfig,
      force: options?.repairModelRouting === true,
    });

    const updatedForSkills = await agents.update(existing.id, {
      adapterConfig: modelRouting.adapterConfig,
    });
    const skillUpdatedAgent = (updatedForSkills ?? {
      ...existing,
      adapterConfig: modelRouting.adapterConfig,
    }) as AgentLike;

    const instructionsResult = await materializeDefaultInstructionsBundleForAgent(
      skillUpdatedAgent,
      { replaceManaged: options?.overwriteManagedInstructions === true },
    );

    return {
      agent: instructionsResult.agent,
      desiredSkills: skillAssignment.desiredSkills,
      availableOptionalSkillKeys,
      instructionsAction: instructionsResult.action,
      modelRouting,
    };
  }

  async function repairCompanyAgents(
    companyId: string,
    options?: RepairAgentRoleDefaultsOptions,
  ) {
    const rows = await agents.list(companyId);
    const repaired = [];
    for (const agent of rows) {
      const result = await repairAgentRoleDefaults(agent.id, options);
      if (result) repaired.push(result);
    }
    return repaired;
  }

  return {
    resolveDesiredSkillAssignment,
    materializeDefaultInstructionsBundleForAgent,
    repairAgentRoleDefaults,
    repairCompanyAgents,
  };
}
