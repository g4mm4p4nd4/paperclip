import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const ORIGINAL_CONFIG = process.env.PAPERCLIP_CONFIG;
const roots: string[] = [];

function configValue(tokenomicsWatch?: Record<string, unknown>) {
  return {
    $meta: { version: 1, updatedAt: "2026-07-24T12:00:00.000Z", source: "configure" },
    database: {},
    logging: { mode: "file" },
    server: {},
    telemetry: {},
    factory: {
      mode: "fixture",
      pauseNewWork: true,
      ...(tokenomicsWatch ? { tokenomicsWatch } : {}),
    },
  };
}

async function writeConfig(value: ReturnType<typeof configValue>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-tokenomics-watch-config-"));
  roots.push(root);
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(value)}\n`, "utf8");
  process.env.PAPERCLIP_CONFIG = configPath;
}

afterEach(async () => {
  if (ORIGINAL_CONFIG === undefined) delete process.env.PAPERCLIP_CONFIG;
  else process.env.PAPERCLIP_CONFIG = ORIGINAL_CONFIG;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("factory tokenomics watch configuration", () => {
  it("loads an explicit supervised baseline window from the non-secret factory config", async () => {
    await writeConfig(configValue({ enabled: true, intervalSeconds: 300, baselineHours: 360 }));

    expect(loadConfig().factoryTokenomicsWatchBaselineHours).toBe(360);
  });

  it("preserves the historical 96-hour baseline when the setting is omitted", async () => {
    await writeConfig(configValue({ enabled: true, intervalSeconds: 300 }));

    expect(loadConfig().factoryTokenomicsWatchBaselineHours).toBe(96);
  });
});
