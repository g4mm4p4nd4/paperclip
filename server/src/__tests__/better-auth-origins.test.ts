import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { deriveAuthTrustedOrigins } from "../auth/better-auth.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    host: "0.0.0.0",
    port: 3100,
    allowedHostnames: ["192.168.50.28"],
    allowedClientIps: ["192.168.50.77"],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/paperclip-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: true,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 3,
    databaseBackupDir: "/tmp/paperclip-backups",
    serveUi: true,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-secrets/master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: undefined,
    feedbackExportBackendToken: undefined,
    heartbeatSchedulerEnabled: true,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    telemetryEnabled: true,
    ...overrides,
  };
}

describe("deriveAuthTrustedOrigins", () => {
  it("trusts private allowed hostnames with the configured Paperclip port", () => {
    expect(deriveAuthTrustedOrigins(baseConfig())).toContain("http://192.168.50.28:3100");
  });

  it("always trusts local browser origins in authenticated private mode", () => {
    const origins = deriveAuthTrustedOrigins(baseConfig());

    expect(origins).toContain("http://localhost:3100");
    expect(origins).toContain("http://127.0.0.1:3100");
    expect(origins).toContain("http://[::1]:3100");
  });

  it("uses the active configured port for local browser origins", () => {
    const origins = deriveAuthTrustedOrigins(baseConfig({ port: 3206 }));

    expect(origins).toContain("http://localhost:3206");
    expect(origins).toContain("http://127.0.0.1:3206");
  });
});
