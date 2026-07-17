import fs from "node:fs";
import path from "node:path";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    return paperclipConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf-8")));
  } catch {
    return null;
  }
}

/** Persist the fail-safe factory pause before the live process adopts it. */
export function persistFactoryPauseNewWork(paused: true): void {
  const configPath = resolvePaperclipConfigPath();
  const current = readConfigFile();
  if (!current?.factory) throw new Error("factory_config_missing");
  const next = paperclipConfigSchema.parse({
    ...current,
    factory: { ...current.factory, pauseNewWork: paused },
  });
  const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, configPath);
  const directory = fs.openSync(path.dirname(configPath), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
