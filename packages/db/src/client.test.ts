import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-client-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("applyPendingMigrations", () => {
  it(
    "applies an inserted earlier migration without replaying later legacy migrations",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const richMagnetoHash = await migrationHash("0030_rich_magneto.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${richMagnetoHash}'`,
        );
        await sql.unsafe(`DROP TABLE "company_logos"`);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0030_rich_magneto.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('company_logos', 'execution_workspaces')
            ORDER BY table_name
          `,
        );
        expect(rows.map((row) => row.table_name)).toEqual([
          "company_logos",
          "execution_workspaces",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0044 safely when its schema changes already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const illegalToadHash = await migrationHash("0044_illegal_toad.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${illegalToadHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'instance_settings'
              AND column_name = 'general'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0044_illegal_toad.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "enforces a unique board_api_keys.key_hash after migration 0044",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`
          INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
          VALUES ('user-1', 'User One', 'user@example.com', true, now(), now())
        `);
        await sql.unsafe(`
          INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
          VALUES ('00000000-0000-0000-0000-000000000001', 'user-1', 'Key One', 'dup-hash', now())
        `);
        await expect(
          sql.unsafe(`
            INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
            VALUES ('00000000-0000-0000-0000-000000000002', 'user-1', 'Key Two', 'dup-hash', now())
          `),
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0046 safely when document revision columns already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const smoothSentinelsHash = await migrationHash("0046_smooth_sentinels.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${smoothSentinelsHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toHaveLength(2);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0046_smooth_sentinels.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "format",
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "title",
            is_nullable: "YES",
          }),
        ]);
        expect(columns[0]?.column_default).toContain("'markdown'");
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0047 safely when feedback tables and run columns already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const overjoyedGrootHash = await migrationHash("0047_overjoyed_groot.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${overjoyedGrootHash}'`,
        );

        const tables = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('feedback_exports', 'feedback_votes')
            ORDER BY table_name
          `,
        );
        expect(tables.map((row) => row.table_name)).toEqual([
          "feedback_exports",
          "feedback_votes",
        ]);

        const columns = await sql.unsafe<{ table_name: string; column_name: string }[]>(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name = 'companies' AND column_name IN (
                  'feedback_data_sharing_enabled',
                  'feedback_data_sharing_consent_at',
                  'feedback_data_sharing_consent_by_user_id',
                  'feedback_data_sharing_terms_version'
                ))
                OR (table_name = 'document_revisions' AND column_name = 'created_by_run_id')
                OR (table_name = 'issue_comments' AND column_name = 'created_by_run_id')
              )
            ORDER BY table_name, column_name
          `,
        );
        expect(columns).toHaveLength(6);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0047_overjoyed_groot.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const constraints = await verifySql.unsafe<{ conname: string }[]>(
          `
            SELECT conname
            FROM pg_constraint
            WHERE conname IN (
              'feedback_exports_company_id_companies_id_fk',
              'feedback_exports_feedback_vote_id_feedback_votes_id_fk',
              'feedback_exports_issue_id_issues_id_fk',
              'feedback_votes_company_id_companies_id_fk',
              'feedback_votes_issue_id_issues_id_fk'
            )
            ORDER BY conname
          `,
        );
        expect(constraints.map((row) => row.conname)).toEqual([
          "feedback_exports_company_id_companies_id_fk",
          "feedback_exports_feedback_vote_id_feedback_votes_id_fk",
          "feedback_exports_issue_id_issues_id_fk",
          "feedback_votes_company_id_companies_id_fk",
          "feedback_votes_issue_id_issues_id_fk",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0048 safely when routines.variables already exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const flashyMarrowHash = await migrationHash("0048_flashy_marrow.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${flashyMarrowHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0048_flashy_marrow.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; data_type: string }[]>(
          `
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "variables",
            is_nullable: "NO",
            data_type: "jsonb",
          }),
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "bridges legacy secret key and fingerprint columns without weakening modern encrypted-secret inserts",
    async () => {
      const connectionString = await createTempDatabase();
      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      let companyId = "";
      try {
        const companyRows = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO companies (name, issue_prefix) VALUES ('Secret compatibility fixture', 'SCF') RETURNING id`,
        );
        companyId = companyRows[0]!.id;
        await sql.unsafe(`ALTER TABLE company_secrets ADD COLUMN key text NOT NULL`);
        const migrationHashValue = await migrationHash("0066_company_secret_legacy_key_compat.sql");
        const updateSyncMigrationHash = await migrationHash("0068_company_secret_compat_update_sync.sql");
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash IN ('${migrationHashValue}', '${updateSyncMigrationHash}')`,
        );
      } finally {
        await sql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [
          "0066_company_secret_legacy_key_compat.sql",
          "0068_company_secret_compat_update_sync.sql",
        ],
      });
      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      let modernSecretId = "";
      try {
        const modernRows = await verifySql.unsafe<{ id: string; name: string; key: string }[]>(
          `INSERT INTO company_secrets (company_id, name, provider, latest_version)
           VALUES ($1, 'MODERN_SECRET', 'local_encrypted', 1)
           RETURNING id, name, key`,
          [companyId],
        );
        modernSecretId = modernRows[0]!.id;
        expect(modernRows[0]).toMatchObject({ name: "MODERN_SECRET", key: "MODERN_SECRET" });

        const legacyRows = await verifySql.unsafe<{ id: string; name: string; key: string }[]>(
          `INSERT INTO company_secrets (company_id, key, provider, latest_version)
           VALUES ($1, 'LEGACY_SECRET', 'local_encrypted', 1)
           RETURNING id, name, key`,
          [companyId],
        );
        expect(legacyRows).toEqual([
          expect.objectContaining({ name: "LEGACY_SECRET", key: "LEGACY_SECRET" }),
        ]);

        const modernRename = await verifySql.unsafe<{ name: string; key: string }[]>(
          `UPDATE company_secrets SET name = 'MODERN_SECRET_RENAMED' WHERE id = $1 RETURNING name, key`,
          [modernSecretId],
        );
        expect(modernRename).toEqual([{
          name: "MODERN_SECRET_RENAMED",
          key: "MODERN_SECRET_RENAMED",
        }]);

        const legacyRename = await verifySql.unsafe<{ name: string; key: string }[]>(
          `UPDATE company_secrets SET key = 'LEGACY_SECRET_RENAMED' WHERE id = $1 RETURNING name, key`,
          [legacyRows[0]!.id],
        );
        expect(legacyRename).toEqual([{
          name: "LEGACY_SECRET_RENAMED",
          key: "LEGACY_SECRET_RENAMED",
        }]);

        await expect(verifySql.unsafe(
          `UPDATE company_secrets SET name = 'CONFLICTING_NAME', key = 'CONFLICTING_KEY' WHERE id = $1`,
          [modernSecretId],
        )).rejects.toThrow(/company_secrets_name_key_mismatch/);

        await expect(verifySql.unsafe(
          `INSERT INTO company_secrets (company_id, name, key, provider, latest_version)
           VALUES ($1, 'NAME_A', 'KEY_B', 'local_encrypted', 1)`,
          [companyId],
        )).rejects.toThrow(/company_secrets_name_key_mismatch/);
      } finally {
        await verifySql.end();
      }

      const fingerprintSetupSql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await fingerprintSetupSql.unsafe(
          `ALTER TABLE company_secret_versions ADD COLUMN fingerprint_sha256 text NOT NULL`,
        );
        const migrationHashValue = await migrationHash("0067_company_secret_version_fingerprint_compat.sql");
        const updateSyncMigrationHash = await migrationHash("0068_company_secret_compat_update_sync.sql");
        await fingerprintSetupSql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash IN ('${migrationHashValue}', '${updateSyncMigrationHash}')`,
        );
      } finally {
        await fingerprintSetupSql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [
          "0067_company_secret_version_fingerprint_compat.sql",
          "0068_company_secret_compat_update_sync.sql",
        ],
      });
      await applyPendingMigrations(connectionString);

      const versionSql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const modernVersions = await versionSql.unsafe<{ value_sha256: string; fingerprint_sha256: string }[]>(
          `INSERT INTO company_secret_versions (secret_id, version, material, value_sha256)
           VALUES ($1, 1, '{}'::jsonb, $2)
           RETURNING value_sha256, fingerprint_sha256`,
          [modernSecretId, "a".repeat(64)],
        );
        expect(modernVersions).toEqual([{
          value_sha256: "a".repeat(64),
          fingerprint_sha256: "a".repeat(64),
        }]);

        const legacyVersions = await versionSql.unsafe<{ value_sha256: string; fingerprint_sha256: string }[]>(
          `INSERT INTO company_secret_versions (secret_id, version, material, fingerprint_sha256)
           VALUES ($1, 2, '{}'::jsonb, $2)
           RETURNING value_sha256, fingerprint_sha256`,
          [modernSecretId, "b".repeat(64)],
        );
        expect(legacyVersions).toEqual([{
          value_sha256: "b".repeat(64),
          fingerprint_sha256: "b".repeat(64),
        }]);

        const modernHashUpdate = await versionSql.unsafe<{ value_sha256: string; fingerprint_sha256: string }[]>(
          `UPDATE company_secret_versions SET value_sha256 = $2
           WHERE secret_id = $1 AND version = 1
           RETURNING value_sha256, fingerprint_sha256`,
          [modernSecretId, "e".repeat(64)],
        );
        expect(modernHashUpdate).toEqual([{
          value_sha256: "e".repeat(64),
          fingerprint_sha256: "e".repeat(64),
        }]);

        const legacyHashUpdate = await versionSql.unsafe<{ value_sha256: string; fingerprint_sha256: string }[]>(
          `UPDATE company_secret_versions SET fingerprint_sha256 = $2
           WHERE secret_id = $1 AND version = 2
           RETURNING value_sha256, fingerprint_sha256`,
          [modernSecretId, "f".repeat(64)],
        );
        expect(legacyHashUpdate).toEqual([{
          value_sha256: "f".repeat(64),
          fingerprint_sha256: "f".repeat(64),
        }]);

        await expect(versionSql.unsafe(
          `UPDATE company_secret_versions
           SET value_sha256 = $2, fingerprint_sha256 = $3
           WHERE secret_id = $1 AND version = 1`,
          [modernSecretId, "1".repeat(64), "2".repeat(64)],
        )).rejects.toThrow(/company_secret_versions_hash_mismatch/);

        await expect(versionSql.unsafe(
          `INSERT INTO company_secret_versions
             (secret_id, version, material, value_sha256, fingerprint_sha256)
           VALUES ($1, 3, '{}'::jsonb, $2, $3)`,
          [modernSecretId, "c".repeat(64), "d".repeat(64)],
        )).rejects.toThrow(/company_secret_versions_hash_mismatch/);
      } finally {
        await versionSql.end();
      }

      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");
    },
    20_000,
  );
});
