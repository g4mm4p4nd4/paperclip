import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOSTINGER_API_KEY_FILE,
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_FILE_SECRET_NAME,
  hostingerDeploymentTargetMetadata,
} from "../services/deployment-target-policy.js";
import {
  HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
  HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS,
  HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
  buildHostingerDeployOperatorAdapterConfig,
  buildHostingerDeployOperatorCapabilities,
  buildHostingerDeployOperatorInstructions,
  buildHostingerDeployOperatorRuntimeConfig,
} from "../services/hostinger-deploy-operator.js";

describe("Hostinger deploy operator", () => {
  it("records the operator owner in deployment target metadata", () => {
    expect(hostingerDeploymentTargetMetadata()).toMatchObject({
      provider: "hostinger",
      operatorAgentName: HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
      operatorRole: "devops",
      operatorSkillKey: HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
      networkPolicy: "allowlist_single_client_ip",
    });
  });

  it("builds an adapter config with the Hostinger skill and safe runtime env", () => {
    const config = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/Users/mnm/Documents/Github/LeadForge",
      allowedClientIp: "99.76.32.196",
      existingAdapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
      },
    }) as {
      cwd: string;
      env: Record<string, string>;
      paperclipSkillSync: { desiredSkills: string[] };
    };

    expect(config.cwd).toBe("/Users/mnm/Documents/Github/LeadForge");
    expect(config.env[HOSTINGER_API_KEY_FILE_SECRET_NAME]).toBe(DEFAULT_HOSTINGER_API_KEY_FILE);
    expect(config.env[HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME]).toBe("99.76.32.196");
    expect(config.env).not.toHaveProperty("HOSTINGER_API_KEY");
    for (const key of HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS) {
      expect(config.paperclipSkillSync.desiredSkills).toContain(key);
    }
  });

  it("keeps the operator heartbeat enabled and wakeable", () => {
    expect(buildHostingerDeployOperatorRuntimeConfig({
      heartbeat: {
        intervalSec: 900,
      },
    })).toMatchObject({
      heartbeat: {
        enabled: true,
        wakeOnDemand: true,
        intervalSec: 900,
      },
    });
  });

  it("instructs the operator to produce deployment receipts and avoid unapproved purchases", () => {
    const instructions = buildHostingerDeployOperatorInstructions("Portfolio Venture Factory :: LeadForge", "POR");
    expect(instructions).toContain("VM ID");
    expect(instructions).toContain("firewall ID");
    expect(instructions).toContain("board has approved it");
    expect(instructions).toContain("health check");
    expect(buildHostingerDeployOperatorCapabilities()).toContain("deployment receipts");
  });
});
