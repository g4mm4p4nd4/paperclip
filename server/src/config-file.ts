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

const MAX_FACTORY_PAUSE_CONFIG_BYTES = 1024n * 1024n;

function currentUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function sameConfigMetadata(left: fs.BigIntStats, right: fs.BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.uid === right.uid && left.mode === right.mode && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertSafeFactoryPauseConfig(metadata: fs.BigIntStats) {
  const uid = currentUid();
  if (uid === null || !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== BigInt(uid) ||
      (metadata.mode & 0o7777n) !== 0o600n || metadata.size <= 0n ||
      metadata.size > MAX_FACTORY_PAUSE_CONFIG_BYTES) {
    throw new Error("factory_pause_config_unsafe");
  }
}

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
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("factory_pause_config_no_follow_unavailable");
  let descriptor: number | null = null;
  let bytes: Buffer | null = null;
  try {
    // Do not lstat then reopen by pathname: a same-UID actor could replace and
    // restore the leaf between those calls. Every byte hashed below comes from
    // this one O_NOFOLLOW descriptor, then the pathname is rebound to it.
    descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertSafeFactoryPauseConfig(before);
    const byteLength = Number(before.size);
    const buffer = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("factory_pause_config_short_read");
      offset += bytesRead;
    }
    const overflowProbe = Buffer.alloc(1);
    const overflow = fs.readSync(descriptor, overflowProbe, 0, 1, byteLength);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (overflow !== 0 || !sameConfigMetadata(after, before)) {
      throw new Error("factory_pause_config_changed_during_read");
    }
    const rebound = fs.lstatSync(configPath, { bigint: true });
    const canonicalPath = fs.realpathSync(configPath);
    const canonical = fs.lstatSync(canonicalPath, { bigint: true });
    if (!sameConfigMetadata(rebound, before) || !sameConfigMetadata(canonical, before) ||
        rebound.isSymbolicLink() || canonical.isSymbolicLink()) {
      throw new Error("factory_pause_config_path_changed");
    }
    bytes = buffer;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("factory_pause_config_")) throw error;
    throw new Error("factory_pause_config_unavailable", { cause: error });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  if (bytes === null) throw new Error("factory_pause_config_unavailable");
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
