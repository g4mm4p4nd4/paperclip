import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncMigrationAssets } from "./sync-migration-assets.js";

const temporaryRoots: string[] = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-migration-assets-"));
  temporaryRoots.push(root);
  return root;
}

function write(relativeRoot: string, relativePath: string, value: string) {
  const target = path.join(relativeRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("syncMigrationAssets", () => {
  it("replaces stale output instead of nesting the current migration tree", () => {
    const root = temporaryRoot();
    const source = path.join(root, "src", "migrations");
    const target = path.join(root, "dist", "migrations");
    write(source, "0069_previous.sql", "select 69;\n");
    write(source, "0070_current.sql", "select 70;\n");
    write(source, "meta/_journal.json", '{"entries":[{"idx":70,"tag":"0070_current"}]}\n');

    write(target, "0069_previous.sql", "stale\n");
    write(target, "meta/_journal.json", '{"entries":[{"idx":69}]}\n');
    write(target, "migrations/meta/_journal.json", '{"entries":[{"idx":70}]}\n');
    write(target, "obsolete.sql", "select 'obsolete';\n");

    const first = syncMigrationAssets(source, target);

    expect(fs.readFileSync(path.join(target, "meta", "_journal.json"), "utf8")).toContain(
      '"idx":70',
    );
    expect(fs.existsSync(path.join(target, "migrations"))).toBe(false);
    expect(fs.existsSync(path.join(target, "obsolete.sql"))).toBe(false);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "0069_previous.sql",
      "0070_current.sql",
      "meta/_journal.json",
    ]);

    write(source, "0071_next.sql", "select 71;\n");
    const second = syncMigrationAssets(source, target);

    expect(second.entries.map((entry) => entry.path)).toContain("0071_next.sql");
    expect(fs.existsSync(path.join(target, "migrations"))).toBe(false);
    expect(second.manifestSha256).not.toBe(first.manifestSha256);
  });
});
