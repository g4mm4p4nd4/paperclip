import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbRestoreCommand } from "../commands/db-restore.js";

const runDatabaseRestore = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/db")>();
  return {
    ...actual,
    runDatabaseRestore,
  };
});

const ORIGINAL_ENV = { ...process.env };
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-restore-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  runDatabaseRestore.mockReset();
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dbRestoreCommand", () => {
  it("requires explicit --yes confirmation", async () => {
    const dir = makeTempDir();
    const backupFile = path.join(dir, "backup.sql");
    fs.writeFileSync(backupFile, "SELECT 1;\n");

    await expect(
      dbRestoreCommand({ file: backupFile }),
    ).rejects.toThrow("Refusing to restore without --yes");

    expect(runDatabaseRestore).not.toHaveBeenCalled();
  });

  it("runs restore against the resolved database connection", async () => {
    const dir = makeTempDir();
    const backupFile = path.join(dir, "backup.sql.gz");
    fs.writeFileSync(backupFile, "fake backup");

    await dbRestoreCommand({
      file: backupFile,
      yes: true,
      connectTimeoutSeconds: 11,
      json: true,
    });

    expect(runDatabaseRestore).toHaveBeenCalledWith({
      connectionString: process.env.DATABASE_URL,
      backupFile,
      connectTimeoutSeconds: 11,
    });
  });
});

