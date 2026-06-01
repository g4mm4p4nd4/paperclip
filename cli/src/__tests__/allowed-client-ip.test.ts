import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { addAllowedClientIp } from "../commands/allowed-client-ip.js";

function createTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-allowed-client-ip-"));
  return path.join(dir, "config.json");
}

function writeBaseConfig(configPath: string) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      allowedClientIps: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("allowed-client-ip command", () => {
  it("adds and normalizes client IP allowlist entries", async () => {
    const configPath = createTempConfigPath();
    writeBaseConfig(configPath);

    await addAllowedClientIp(" 192.168.50.77 ", { config: configPath });
    await addAllowedClientIp("192.168.50.77", { config: configPath });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as PaperclipConfig;
    expect(raw.server.allowedClientIps).toEqual(["192.168.50.77"]);
  });
});
