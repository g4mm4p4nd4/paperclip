import fs from "node:fs/promises";

type DefaultAgentProfile = {
  files: string[];
  desiredSkills: string[];
  optionalDesiredSkills: string[];
};

const DEFAULT_AGENT_PROFILES = {
  default: {
    files: ["AGENTS.md"],
    desiredSkills: ["paperclipai/paperclip/paperclip-product-scope"],
    optionalDesiredSkills: [
      "investigate",
      "checkpoint",
    ],
  },
  ceo: {
    files: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "analytics-tracking",
      "autoplan",
      "business-forced-choice",
      "evidence-factory",
      "market-signal-scout",
      "office-hours",
      "opportunity-council",
      "plan-ceo-review",
      "repo-opportunity-analyst",
      "repo-opportunity-thesis",
      "trust-packet",
      "voc-research-miner",
    ],
  },
  cto: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-integration-engineer",
      "paperclipai/paperclip/paperclip-create-agent",
      "paperclipai/paperclip/paperclip-create-plugin",
    ],
    optionalDesiredSkills: [
      "benchmark",
      "checkpoint",
      "health",
      "investigate",
      "plan-eng-review",
      "repo-clean-sync",
      "review",
    ],
  },
  cmo: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "analytics-tracking",
      "b2b-case-study-journalist",
      "brand-manifesto",
      "business-forced-choice",
      "distribution-spine",
      "evidence-factory",
      "long-form-sales-letter",
      "marketing-psychology",
      "product-launch",
      "seo-article-architect",
      "thought-leadership-ghostwriter",
      "trust-packet",
    ],
  },
  cfo: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "analytics-tracking",
      "business-forced-choice",
      "checkpoint",
      "evidence-factory",
      "trust-packet",
    ],
  },
  engineer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-integration-engineer",
      "paperclipai/paperclip/paperclip-create-plugin",
    ],
    optionalDesiredSkills: [
      "benchmark",
      "browse",
      "checkpoint",
      "health",
      "investigate",
      "repo-clean-sync",
      "review",
    ],
  },
  integration_engineer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-integration-engineer",
    ],
    optionalDesiredSkills: [
      "browse",
      "checkpoint",
      "health",
      "investigate",
      "repo-clean-sync",
      "review",
    ],
  },
  designer: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "3d-web-experience",
      "design-consultation",
      "design-guide",
      "design-html",
      "design-review",
      "design-shotgun",
      "frontend-design",
      "gold-standard-website",
      "interaction-choreography",
      "interaction-design",
      "visual-alchemist",
      "web-animation",
    ],
  },
  pm: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "autoplan",
      "business-forced-choice",
      "checkpoint",
      "evidence-factory",
      "market-signal-scout",
      "office-hours",
      "plan-ceo-review",
      "plan-design-review",
      "plan-devex-review",
      "plan-eng-review",
      "repo-opportunity-analyst",
      "repo-opportunity-thesis",
      "trust-packet",
      "voc-research-miner",
    ],
  },
  qa: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-frontend-experience",
      "paperclipai/paperclip/paperclip-backend-api-security",
    ],
    optionalDesiredSkills: [
      "benchmark",
      "browse",
      "canary",
      "checkpoint",
      "investigate",
      "qa",
      "qa-only",
      "review",
      "setup-browser-cookies",
    ],
  },
  devops: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-backend-api-security",
      "paperclipai/paperclip/paperclip-integration-engineer",
    ],
    optionalDesiredSkills: [
      "canary",
      "careful",
      "checkpoint",
      "document-release",
      "guard",
      "health",
      "land-and-deploy",
      "release",
      "release-changelog",
      "review",
      "setup-deploy",
      "ship",
    ],
  },
  researcher: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "checkpoint",
      "evidence-factory",
      "market-signal-scout",
      "opportunity-lab",
      "repo-inventory-auditor",
      "repo-opportunity-analyst",
      "repo-opportunity-thesis",
      "trust-packet",
      "voc-research-miner",
      "voc-scout",
      "web-content-extractor",
    ],
  },
  skill_curator: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "checkpoint",
      "health",
      "investigate",
      "review",
    ],
  },
  general: {
    files: ["AGENTS.md"],
    desiredSkills: [
      "paperclipai/paperclip/paperclip-product-scope",
      "paperclipai/paperclip/para-memory-files",
    ],
    optionalDesiredSkills: [
      "analytics-tracking",
      "brand-manifesto",
      "business-forced-choice",
      "distribution-spine",
      "evidence-factory",
      "market-signal-scout",
      "office-hours",
      "product-launch",
      "repo-opportunity-analyst",
      "thought-leadership-ghostwriter",
      "trust-packet",
      "voc-research-miner",
    ],
  },
} satisfies Record<string, DefaultAgentProfile>;

export type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_PROFILES;
export type DefaultAgentSkillPolicy = Pick<DefaultAgentProfile, "desiredSkills" | "optionalDesiredSkills">;
export const DEFAULT_AGENT_BUNDLE_ROLES = Object.freeze(
  Object.keys(DEFAULT_AGENT_PROFILES) as DefaultAgentBundleRole[],
);

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

export function resolveDefaultAgentSkillPolicy(role: string): DefaultAgentSkillPolicy {
  const resolvedRole = resolveDefaultAgentInstructionsBundleRole(role);
  return {
    desiredSkills: [...DEFAULT_AGENT_PROFILES[resolvedRole].desiredSkills],
    optionalDesiredSkills: [...DEFAULT_AGENT_PROFILES[resolvedRole].optionalDesiredSkills],
  };
}
