import { createHash } from "node:crypto";
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

export type FactoryPauseAuthoritySnapshot = {
  /** True means the selected instance remains fail-closed for new factory work. */
  paused: boolean;
  /** Hash of the exact, race-checked config bytes that supplied `paused`. */
  generation: string;
};

/**
 * Read the pause switch from the selected instance at the point it is used.
 *
 * A retirement is deliberately not allowed to inherit a startup-time config
 * value: the operator must observe the same on-disk authority immediately
 * before a non-compensable mutation.  The byte hash is a generation token that
 * lets callers fail closed when the authority changed during an operation.
 */
export function readFactoryPauseAuthoritySnapshot(): FactoryPauseAuthoritySnapshot {
  const configPath = resolvePaperclipConfigPath();
  let before: fs.Stats;
  let bytes: Buffer;
  try {
    before = fs.lstatSync(configPath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("factory_pause_config_unsafe");
    bytes = fs.readFileSync(configPath);
  } catch (error) {
    throw new Error("factory_pause_config_unavailable", { cause: error });
  }
  let after: fs.Stats;
  try {
    after = fs.lstatSync(configPath);
  } catch (error) {
    throw new Error("factory_pause_config_unavailable", { cause: error });
  }
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("factory_pause_config_changed_during_read");
  }
  let parsed: PaperclipConfig;
  try {
    parsed = paperclipConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("factory_pause_config_invalid", { cause: error });
  }
  return {
    // This mirrors loadConfig's safe default: absent factory configuration is
    // a pause, not permission to start or retire work.
    paused: parsed.factory?.pauseNewWork ?? true,
    generation: createHash("sha256").update(bytes).digest("hex"),
  };
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
