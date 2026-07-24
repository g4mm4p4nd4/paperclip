import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME,
  HOSTINGER_API_KEY_SECRET_NAME,
  HOSTINGER_API_KEY_FILE_SECRET_NAME,
  hostingerDeploymentTargetMetadata,
} from "../services/deployment-target-policy.js";
import {
  HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
  HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS,
  HOSTINGER_DEPLOY_OPERATOR_REQUIRED_SKILLS,
  HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
  HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND,
  buildHostingerDeployOperatorAdapterConfig,
  buildHostingerDeployOperatorCapabilities,
  buildHostingerDeployOperatorInstructions,
  buildHostingerDeployOperatorRuntimeConfig,
  ensureHostingerDeployOperatorForCompany,
  resolveHostingerDeployOperatorCwd,
} from "../services/hostinger-deploy-operator.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("Hostinger deploy operator", () => {
  it("records the operator owner in deployment target metadata", () => {
    expect(hostingerDeploymentTargetMetadata()).toMatchObject({
      provider: "hostinger",
      operatorAgentName: HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
      operatorRole: "devops",
      operatorSkillKey: HOSTINGER_DEPLOY_OPERATOR_SKILL_KEY,
      apiKeySecretName: HOSTINGER_API_KEY_SECRET_NAME,
      networkPolicy: "allowlist_single_client_ip",
    });
  });

  it("builds an adapter config with the Hostinger skill and safe runtime env", () => {
    const config = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/workspace/LeadForge",
      allowedClientIp: "99.76.32.196",
      existingAdapterConfig: {
        env: {
          HOSTINGER_API_KEY_FILE: "/stale/legacy-hostinger-api-key",
          PRESERVED_RUNTIME_VALUE: "preserve-me",
        },
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
      },
    }) as {
      cwd: string;
      env: Record<string, unknown>;
      paperclipSkillSync: { desiredSkills: string[]; requiredSkills: string[] };
    };

    expect(config.cwd).toBe("/workspace/LeadForge");
    expect(config.env).not.toHaveProperty(HOSTINGER_API_KEY_FILE_SECRET_NAME);
    expect(config.env.PRESERVED_RUNTIME_VALUE).toBe("preserve-me");
    expect(config.env[HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME]).toBe("99.76.32.196");
    expect(config.env).not.toHaveProperty("HOSTINGER_API_KEY");
    expect(config).not.toHaveProperty("command");
    expect(config).not.toHaveProperty("hermesCommand");
    for (const key of HOSTINGER_DEPLOY_OPERATOR_DESIRED_SKILLS) {
      expect(config.paperclipSkillSync.desiredSkills).toContain(key);
    }
    for (const key of HOSTINGER_DEPLOY_OPERATOR_REQUIRED_SKILLS) {
      expect(config.paperclipSkillSync.requiredSkills).toContain(key);
    }
  });

  it("replaces plaintext Hostinger credentials with a canonical encrypted secret reference", () => {
    const secretId = randomUUID();
    const config = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/workspace/LeadForge",
      apiKeySecretId: secretId,
      existingAdapterConfig: {
        env: {
          HOSTINGER_API_KEY: "stale-plaintext-hostinger-key",
          SAFE_SETTING: "preserved",
        },
      },
    }) as {
      env: Record<string, unknown>;
    };

    expect(config.env[HOSTINGER_API_KEY_SECRET_NAME]).toEqual({
      type: "secret_ref",
      secretId,
      version: "latest",
    });
    expect(config.env.SAFE_SETTING).toBe("preserved");
    expect(JSON.stringify(config.env)).not.toContain("stale-plaintext-hostinger-key");
  });

  it("removes only the exact v1 Hermes defaults while preserving custom runtime commands", () => {
    const legacy = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/workspace/LeadForge",
      existingAdapterConfig: {
        command: HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND,
        hermesCommand: HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND,
      },
    }) as Record<string, unknown>;
    expect(legacy).not.toHaveProperty("command");
    expect(legacy).not.toHaveProperty("hermesCommand");

    const custom = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/workspace/LeadForge",
      existingAdapterConfig: {
        command: `${HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND}-custom`,
        hermesCommand: "/opt/hermes/bin/hermes",
      },
    }) as Record<string, unknown>;
    expect(custom.command).toBe(`${HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND}-custom`);
    expect(custom.hermesCommand).toBe("/opt/hermes/bin/hermes");
  });

  it("carries an explicitly configured legacy file bridge and preserves existing runtime commands", () => {
    const config = buildHostingerDeployOperatorAdapterConfig({
      cwd: "/workspace/LeadForge",
      apiKeyFile: "/run/secrets/hostinger-api-key",
      existingAdapterConfig: {
        command: "/opt/hermes/bin/hermes",
        hermesCommand: "/opt/hermes/bin/hermes",
        env: {
          HOSTINGER_API_KEY_FILE: "/stale/legacy-hostinger-api-key",
        },
      },
    }) as {
      command?: string;
      hermesCommand?: string;
      env: Record<string, string>;
    };

    expect(config.env[HOSTINGER_API_KEY_FILE_SECRET_NAME]).toBe("/run/secrets/hostinger-api-key");
    expect(config.command).toBe("/opt/hermes/bin/hermes");
    expect(config.hermesCommand).toBe("/opt/hermes/bin/hermes");
  });

  it("falls back to the canonical Paperclip instance root when no workspace exists", async () => {
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [],
              }),
            }),
          }),
        }),
      }),
    };

    await expect(resolveHostingerDeployOperatorCwd(db as never, "company-1"))
      .resolves.toBe(resolvePaperclipInstanceRoot());
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
    expect(instructions).toContain(HOSTINGER_API_KEY_SECRET_NAME);
    expect(instructions).toContain(HOSTINGER_API_KEY_FILE_SECRET_NAME);
    expect(buildHostingerDeployOperatorCapabilities()).toContain("deployment receipts");
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("Hostinger deploy operator encrypted credential bootstrap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const priorApiKeyFile = process.env.HOSTINGER_API_KEY_FILE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hostinger-operator-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
    delete process.env.HOSTINGER_API_KEY_FILE;
  }, 20_000);

  afterAll(async () => {
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    if (priorApiKeyFile === undefined) delete process.env.HOSTINGER_API_KEY_FILE;
    else process.env.HOSTINGER_API_KEY_FILE = priorApiKeyFile;
    vi.unstubAllEnvs();
    await tempDb?.cleanup();
  });

  it("binds only a same-company secret and resolves it into the heartbeat runtime env", async () => {
    const companyId = randomUUID();
    const foreignCompanyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Hostinger operator fixture",
        issuePrefix: `HO${companyId.replaceAll("-", "").slice(0, 4)}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: foreignCompanyId,
        name: "Foreign secret fixture",
        issuePrefix: `HF${foreignCompanyId.replaceAll("-", "").slice(0, 4)}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: HOSTINGER_DEPLOY_OPERATOR_AGENT_NAME,
      role: "devops",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {
        command: HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND,
        hermesCommand: HOSTINGER_DEPLOY_OPERATOR_V1_HERMES_COMMAND,
        env: {
          HOSTINGER_API_KEY: "stale-plaintext-hostinger-key",
          HOSTINGER_API_KEY_FILE: "/stale/legacy-hostinger-key",
          SAFE_SETTING: "preserved",
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const secrets = secretService(db);
    await secrets.create(foreignCompanyId, {
      name: HOSTINGER_API_KEY_SECRET_NAME,
      provider: "local_encrypted",
      value: "foreign-company-hostinger-value",
    });

    await ensureHostingerDeployOperatorForCompany(db, companyId, { retargetIssues: false });
    let operator = await db.select().from(agents).where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    let env = operator.adapterConfig.env as Record<string, unknown>;
    expect(env).not.toHaveProperty(HOSTINGER_API_KEY_SECRET_NAME);
    expect(env).not.toHaveProperty(HOSTINGER_API_KEY_FILE_SECRET_NAME);
    expect(env.SAFE_SETTING).toBe("preserved");
    expect(operator.adapterConfig).not.toHaveProperty("command");
    expect(operator.adapterConfig).not.toHaveProperty("hermesCommand");
    expect(JSON.stringify(operator.adapterConfig)).not.toContain("stale-plaintext-hostinger-key");

    const hostingerValue = "same-company-hostinger-value";
    const secret = await secrets.create(companyId, {
      name: HOSTINGER_API_KEY_SECRET_NAME,
      provider: "local_encrypted",
      value: hostingerValue,
    });
    await db.update(agents).set({
      adapterConfig: {
        ...operator.adapterConfig,
        command: "/opt/hermes/custom-command",
        hermesCommand: "/opt/hermes/custom-command",
        env: {
          ...env,
          HOSTINGER_API_KEY: { type: "plain", value: "new-stale-plaintext" },
        },
      },
    }).where(eq(agents.id, agentId));

    await ensureHostingerDeployOperatorForCompany(db, companyId, { retargetIssues: false });
    operator = await db.select().from(agents).where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    env = operator.adapterConfig.env as Record<string, unknown>;
    expect(env[HOSTINGER_API_KEY_SECRET_NAME]).toEqual({
      type: "secret_ref",
      secretId: secret.id,
      version: "latest",
    });
    expect(operator.adapterConfig.command).toBe("/opt/hermes/custom-command");
    expect(operator.adapterConfig.hermesCommand).toBe("/opt/hermes/custom-command");
    expect(JSON.stringify(operator.adapterConfig)).not.toContain("new-stale-plaintext");

    const runtime = await secrets.resolveAdapterConfigForRuntime(
      companyId,
      operator.adapterConfig,
    );
    expect(runtime.config.env).toMatchObject({
      [HOSTINGER_API_KEY_SECRET_NAME]: hostingerValue,
      SAFE_SETTING: "preserved",
    });
    expect(runtime.secretKeys).toContain(HOSTINGER_API_KEY_SECRET_NAME);
  });
});
