import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFactoryPauseAuthoritySnapshot } from "../config-file.js";

const ORIGINAL_CONFIG = process.env.PAPERCLIP_CONFIG;
const roots: string[] = [];

function configValue(paused: boolean) {
  return {
    $meta: { version: 1, updatedAt: "2026-07-24T12:00:00.000Z", source: "configure" },
    database: {},
    logging: { mode: "file" },
    server: {},
    telemetry: {},
    factory: { mode: "fixture", pauseNewWork: paused },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pause-authority-"));
  roots.push(root);
  const configPath = path.join(root, "config.json");
  const bytes = Buffer.from(`${JSON.stringify(configValue(true))}\n`, "utf8");
  await writeFile(configPath, bytes, { mode: 0o600 });
  await chmod(configPath, 0o600);
  process.env.PAPERCLIP_CONFIG = configPath;
  return { root, configPath, bytes };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_CONFIG === undefined) delete process.env.PAPERCLIP_CONFIG;
  else process.env.PAPERCLIP_CONFIG = ORIGINAL_CONFIG;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live factory pause authority snapshot", () => {
  it("hashes a bounded owner-only 0600 selected config through one descriptor", async () => {
    const { bytes } = await fixture();
    expect(readFactoryPauseAuthoritySnapshot()).toEqual({
      paused: true,
      generation: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("rejects a symlink or a non-owner-only config mode", async () => {
    const { root, configPath } = await fixture();
    await chmod(configPath, 0o644);
    expect(() => readFactoryPauseAuthoritySnapshot()).toThrow("factory_pause_config_unsafe");
    await chmod(configPath, 0o600);
    const linkPath = path.join(root, "config-link.json");
    await symlink(configPath, linkPath);
    process.env.PAPERCLIP_CONFIG = linkPath;
    expect(() => readFactoryPauseAuthoritySnapshot()).toThrow("factory_pause_config_unavailable");
  });

  it("rejects a pathname swap after descriptor read rather than accepting restored path state", async () => {
    const { root, configPath } = await fixture();
    const parkedPath = path.join(root, "original-config.json");
    let swapped = false;
    const originalReadSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const bytesRead = originalReadSync(...args);
      if (!swapped) {
        swapped = true;
        fs.renameSync(configPath, parkedPath);
        fs.writeFileSync(configPath, `${JSON.stringify(configValue(false))}\n`, { mode: 0o600 });
        fs.chmodSync(configPath, 0o600);
      }
      return bytesRead;
    }) as typeof fs.readSync);
    // In-place changes are caught by descriptor fstat; a pathname-only swap is
    // caught by the final lstat/realpath rebind to that descriptor's inode.
    expect(() => readFactoryPauseAuthoritySnapshot())
      .toThrow(/factory_pause_config_(?:changed_during_read|path_changed)/);
  });
});
