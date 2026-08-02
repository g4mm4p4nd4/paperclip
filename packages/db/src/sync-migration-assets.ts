import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MigrationAssetEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MigrationAssetSyncResult {
  sourceDir: string;
  targetDir: string;
  entries: MigrationAssetEntry[];
  manifestSha256: string;
}

function sha256(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationAssetManifest(root: string): MigrationAssetEntry[] {
  const entries: MigrationAssetEntry[] = [];

  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const observed = fs.lstatSync(absolute);
      if (observed.isSymbolicLink()) {
        throw new Error(`Migration assets cannot contain symlinks: ${absolute}`);
      }
      if (observed.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!observed.isFile()) {
        throw new Error(`Migration asset is not a regular file: ${absolute}`);
      }
      const bytes = fs.readFileSync(absolute);
      entries.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: observed.size,
        sha256: sha256(bytes),
      });
    }
  }

  visit(root);
  return entries;
}

export function syncMigrationAssets(sourceDir: string, targetDir: string): MigrationAssetSyncResult {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Migration source is not a canonical directory: ${source}`);
  }
  if (target === source || target.startsWith(`${source}${path.sep}`)) {
    throw new Error(`Migration target must not overlap its source: ${target}`);
  }

  const sourceEntries = migrationAssetManifest(source);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });

  const targetEntries = migrationAssetManifest(target);
  if (JSON.stringify(targetEntries) !== JSON.stringify(sourceEntries)) {
    throw new Error("Built migration assets do not exactly match their source");
  }

  const manifestBytes = `${JSON.stringify(sourceEntries)}\n`;
  return {
    sourceDir: source,
    targetDir: target,
    entries: sourceEntries,
    manifestSha256: sha256(manifestBytes),
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = syncMigrationAssets(
    path.join(packageRoot, "src", "migrations"),
    path.join(packageRoot, "dist", "migrations"),
  );
  process.stdout.write(
    `${JSON.stringify({
      sourceDir: result.sourceDir,
      targetDir: result.targetDir,
      entryCount: result.entries.length,
      manifestSha256: result.manifestSha256,
    })}\n`,
  );
}
