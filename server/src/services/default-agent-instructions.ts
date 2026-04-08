import fs from "node:fs/promises";

const DEFAULT_AGENT_PROFILES = {
  default: {
    files: ["AGENTS.md"],
    desiredSkills: ["paperclip-product-scope"],
  },
  ceo: {
    files: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
    desiredSkills: [
      "paperclip-create-agent",
      "paperclip-product-scope",
      "paperclip-go-to-market",
      "para-memory-files",
    ],
  },
  cto: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-backend-api-security",
      "paperclip-frontend-experience",
      "paperclip-integration-engineer",
      "paperclip-create-agent",
      "paperclip-create-plugin",
    ],
  },
  cmo: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-go-to-market",
      "para-memory-files",
    ],
  },
  cfo: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-go-to-market",
      "para-memory-files",
    ],
  },
  engineer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-frontend-experience",
      "paperclip-backend-api-security",
      "paperclip-integration-engineer",
      "paperclip-create-plugin",
    ],
  },
  integration_engineer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-backend-api-security",
      "paperclip-integration-engineer",
    ],
  },
  designer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-frontend-experience",
      "paperclip-product-scope",
      "para-memory-files",
    ],
  },
  pm: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-go-to-market",
      "para-memory-files",
    ],
  },
  qa: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-frontend-experience",
      "paperclip-backend-api-security",
    ],
  },
  devops: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-backend-api-security",
      "paperclip-integration-engineer",
    ],
  },
  researcher: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclip-product-scope",
      "paperclip-go-to-market",
      "para-memory-files",
    ],
  },
  general: {
    files: ["AGENTS.md"],
    desiredSkills: ["paperclip-product-scope", "para-memory-files"],
  },
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_PROFILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_PROFILES[role].files;
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role in DEFAULT_AGENT_PROFILES
    ? role as DefaultAgentBundleRole
    : "default";
}

export function resolveDefaultAgentDesiredSkills(role: string): string[] {
  const resolvedRole = resolveDefaultAgentInstructionsBundleRole(role);
  return [...DEFAULT_AGENT_PROFILES[resolvedRole].desiredSkills];
}
