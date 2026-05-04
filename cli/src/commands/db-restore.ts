import { existsSync } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { runDatabaseRestore } from "@paperclipai/db";
import { expandHomePrefix } from "../config/home.js";
import { resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { resolveDatabaseConnectionString } from "./db-common.js";

type DbRestoreOptions = {
  config?: string;
  file?: string;
  yes?: boolean;
  connectTimeoutSeconds?: number;
  json?: boolean;
};

function normalizeConnectTimeoutSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid connect timeout '${String(value)}'. Use a positive integer.`);
  }
  return value;
}

function resolveBackupFile(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error("Missing required --file <backup.sql|backup.sql.gz>.");
  }
  const backupFile = path.resolve(expandHomePrefix(value));
  if (!existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }
  return backupFile;
}

export async function dbRestoreCommand(opts: DbRestoreOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip db:restore ")));

  if (opts.yes !== true) {
    throw new Error("Refusing to restore without --yes. Database restore overwrites the configured database.");
  }

  const configPath = resolveConfigPath(opts.config);
  const connection = resolveDatabaseConnectionString(opts.config);
  const backupFile = resolveBackupFile(opts.file);
  const connectTimeoutSeconds = normalizeConnectTimeoutSeconds(opts.connectTimeoutSeconds);

  p.log.message(pc.dim(`Config: ${configPath}`));
  p.log.message(pc.dim(`Connection source: ${connection.source}`));
  p.log.message(pc.dim(`Backup file: ${backupFile}`));

  const spinner = p.spinner();
  spinner.start("Restoring database backup...");
  try {
    await runDatabaseRestore({
      connectionString: connection.value,
      backupFile,
      connectTimeoutSeconds,
    });
    spinner.stop("Restore completed.");

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            backupFile,
            connectionSource: connection.source,
          },
          null,
          2,
        ),
      );
    }
    p.outro(pc.green("Database restored."));
  } catch (err) {
    spinner.stop(pc.red("Restore failed."));
    throw err;
  }
}

