import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createBufferedTextFileWriter, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

function quoteIdentifierForTest(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "clears restrictive database statement and idle transaction timeouts for backup sessions",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-timeout-");
      const setupSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });

      try {
        await setupSql.unsafe(`
          CREATE TABLE "public"."backup_timeout_records" (
            "id" serial PRIMARY KEY,
            "payload" text NOT NULL
          );
        `);
        await setupSql.unsafe(`
          INSERT INTO "public"."backup_timeout_records" ("payload")
          SELECT repeat('x', 131072)
          FROM generate_series(1, 101);
        `);

        const currentDb = await setupSql<{ name: string }[]>`
          SELECT current_database() AS name
        `;
        await setupSql.unsafe(
          `ALTER DATABASE ${quoteIdentifierForTest(currentDb[0]!.name)} SET statement_timeout = '1ms'`,
        );
        await setupSql.unsafe(
          `ALTER DATABASE ${quoteIdentifierForTest(currentDb[0]!.name)} SET idle_in_transaction_session_timeout = '1ms'`,
        );
      } finally {
        await setupSql.end();
      }

      const constrainedSql = postgres(sourceConnectionString, {
        max: 1,
        fetch_types: false,
        onnotice: () => {},
      });
      try {
        const statementTimeout = await constrainedSql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
        const idleTimeout = await constrainedSql<{ idle_in_transaction_session_timeout: string }[]>`
          SHOW idle_in_transaction_session_timeout
        `;
        expect(statementTimeout[0]?.statement_timeout).toBe("1ms");
        expect(idleTimeout[0]?.idle_in_transaction_session_timeout).toBe("1ms");
      } finally {
        await constrainedSql.end();
      }

      const result = await runDatabaseBackup({
        connectionString: sourceConnectionString,
        backupDir,
        retentionDays: 7,
        filenamePrefix: "paperclip-test",
      });

      expect(fs.existsSync(result.backupFile)).toBe(true);
      expect(result.compression).toBe("gzip");
      expect(result.backupFile).toMatch(/\.sql\.gz$/);
      expect(gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8")).toContain(
        "backup_timeout_records",
      );
    },
    60_000,
  );

  it(
    "keeps only the newest local backups when keepLatestBackups is set",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });

      try {
        const now = new Date("2026-05-31T18:00:00.000Z").getTime();
        const staleA = path.join(backupDir, "paperclip-test-20260530-160000.sql");
        const staleB = path.join(backupDir, "paperclip-test-20260530-170000.sql");
        const staleC = path.join(backupDir, "paperclip-test-20260530-180000.sql.gz");
        for (const [index, file] of [staleA, staleB, staleC].entries()) {
          fs.writeFileSync(file, `stale-${index}\n`, "utf8");
          const mtime = now - (index + 3) * 60 * 60 * 1000;
          fs.utimesSync(file, mtime / 1000, mtime / 1000);
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retentionDays: 3650,
          keepLatestBackups: 2,
          filenamePrefix: "paperclip-test",
        });

        const remaining = fs
          .readdirSync(backupDir)
          .filter((name) => name.startsWith("paperclip-test-") && (name.endsWith(".sql") || name.endsWith(".sql.gz")))
          .sort();

        expect(result.prunedCount).toBe(2);
        expect(remaining).toEqual([
          path.basename(staleA),
          path.basename(result.backupFile),
        ].sort());
      } finally {
        await sourceSql.end();
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retentionDays: 7,
          filenamePrefix: "paperclip-test",
          compression: "gzip",
          dataBatchRows: 17,
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(10 * 1024);
        expect(fs.existsSync(result.backupFile)).toBe(true);
        const backupSql = gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
        expect(backupSql).toContain(
          'ALTER TABLE "public"."profit_flywheel_events" ADD CONSTRAINT "profit_flywheel_events_stage_lineage_fk" FOREIGN KEY ("stage_run_id", "workflow_id", "company_id") REFERENCES "public"."profit_flywheel_stage_runs" ("id", "workflow_id", "company_id") ON UPDATE NO ACTION ON DELETE CASCADE;',
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const restoredLineageConstraint = await restoreSql.unsafe<{ definition: string }[]>(`
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conname = 'profit_flywheel_events_stage_lineage_fk'
        `);
        expect(restoredLineageConstraint).toEqual([
          {
            definition:
              "FOREIGN KEY (stage_run_id, workflow_id, company_id) REFERENCES profit_flywheel_stage_runs(id, workflow_id, company_id) ON DELETE CASCADE",
          },
        ]);

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean };
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );
});
