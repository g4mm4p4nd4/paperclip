import { createDb } from "../packages/db/src/index.js";
import {
  INLINE_SECRET_MIGRATION_MAINTENANCE_ACK,
  INLINE_SECRET_MIGRATION_MAINTENANCE_ENV,
  INLINE_ENV_SECRET_MIGRATION_USAGE,
  parseInlineEnvSecretMigrationArgs,
  runInlineEnvSecretMigration,
} from "../server/src/ops/inline-env-secret-migration.js";

async function main() {
  const cli = parseInlineEnvSecretMigrationArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(INLINE_ENV_SECRET_MIGRATION_USAGE);
    return;
  }
  // Capture only the environment inherited by this process before Paperclip's
  // config loader has any opportunity to load dotenv files. Import values are
  // never read from argv or a file path.
  const inheritedMaintenanceAcknowledged =
    process.env[INLINE_SECRET_MIGRATION_MAINTENANCE_ENV] === INLINE_SECRET_MIGRATION_MAINTENANCE_ACK;
  const importEnvironment = Object.fromEntries(
    cli.importEnvNames.map((name) => [name, process.env[name]]),
  );
  if (cli.homeDir) process.env.PAPERCLIP_HOME = cli.homeDir;
  if (cli.instanceId) process.env.PAPERCLIP_INSTANCE_ID = cli.instanceId;
  const { loadConfig } = await import("../server/src/config.js");
  const config = loadConfig();
  const connectionString = config.databaseUrl ??
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(connectionString);
  try {
    const result = await runInlineEnvSecretMigration(db, {
      apply: cli.apply,
      connectionString,
      homeDir: cli.homeDir,
      instanceId: cli.instanceId,
      receiptDir: cli.receiptDir,
      backupDir: cli.backupDir ?? config.databaseBackupDir,
      masterKeyFilePath: config.secretsMasterKeyFilePath,
      importCompanyId: cli.importCompanyId,
      importEnvNames: cli.importEnvNames,
      environment: importEnvironment,
      rotateImportedSecrets: cli.rotateImportedSecrets,
      expectedPlanSha256: cli.expectedPlanSha256,
      maintenanceAcknowledged: inheritedMaintenanceAcknowledged,
    });
    console.log(JSON.stringify({
      status: result.status,
      mode: result.mode,
      summary: result.summary,
      planSha256: result.planSha256,
      receiptPath: result.receiptPath,
      receiptSha256: result.receiptSha256,
    }));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
