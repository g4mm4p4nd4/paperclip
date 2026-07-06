import "../config.js";
import { createDb } from "@paperclipai/db";
import {
  HOSTINGER_DEPLOY_OPERATOR_BOOTSTRAP_VERSION,
  ensureHostingerDeployOperatorsForActiveCompanies,
} from "../services/hostinger-deploy-operator.js";
import { HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME } from "../services/deployment-target-policy.js";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function resolveConnectionString() {
  const explicit = argValue("--connection-string") ?? process.env.DATABASE_URL ?? null;
  if (explicit) return { connectionString: explicit, source: "explicit" };
  return {
    connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
    source: "embedded-postgres@54329",
  };
}

async function main() {
  const { connectionString, source } = resolveConnectionString();
  const db = createDb(connectionString) as ReturnType<typeof createDb> & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };
  const allowedClientIp =
    argValue("--allowed-client-ip") ??
    process.env[HOSTINGER_ALLOWED_CLIENT_IP_SECRET_NAME] ??
    null;
  const retargetIssues = !process.argv.includes("--no-retarget");

  try {
    const results = await ensureHostingerDeployOperatorsForActiveCompanies(db, {
      allowedClientIp,
      retargetIssues,
    });
    console.log(JSON.stringify({
      version: HOSTINGER_DEPLOY_OPERATOR_BOOTSTRAP_VERSION,
      connectionSource: source,
      retargetIssues,
      allowedClientIp,
      companyCount: results.length,
      results,
    }, null, 2));
  } finally {
    await db.$client?.end?.({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
