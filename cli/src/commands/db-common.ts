import { readConfig } from "../config/store.js";

export type DatabaseConnectionResolution = {
  value: string;
  source: string;
};

export function resolveDatabaseConnectionString(configPath?: string): DatabaseConnectionResolution {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return {
      value: config.database.connectionString.trim(),
      source: "config.database.connectionString",
    };
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return {
    value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

