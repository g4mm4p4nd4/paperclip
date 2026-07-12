# Company-secret schema compatibility

Paperclip's current encrypted-secret contract names secret identities with
`company_secrets.name` and fingerprints secret versions with
`company_secret_versions.value_sha256`. Some long-lived local installations
also retain legacy, non-null `key` and `fingerprint_sha256` columns. A modern
insert cannot omit those legacy columns unless the database explicitly bridges
the two representations.

Migrations `0066_company_secret_legacy_key_compat.sql` and
`0067_company_secret_version_fingerprint_compat.sql` installed the original
insert bridge. Forward-only migration
`0068_company_secret_compat_update_sync.sql` replaces those trigger functions
without rewriting the applied migration history. The resulting `BEFORE`
triggers:

- copy `name` to `key`, or `key` to `name`, when exactly one is present;
- copy `value_sha256` to `fingerprint_sha256`, or the reverse, when exactly one
  is present;
- synchronize a legitimate name-only/key-only rename (and the equivalent
  one-sided fingerprint update) by comparing `OLD` with `NEW`;
- reject divergent pairs instead of choosing an authority silently;
- reject conflicting dual edits and refuse installation over existing divergent
  rows; and
- leave canonical installations without the legacy columns unchanged.

The bridge copies identifiers and one-way SHA-256 fingerprints only. It does
not read, decrypt, log, or duplicate secret material.

## Operator procedure

Take and verify a database backup, keep Paperclip writers stopped, then run:

```bash
DATABASE_URL="$DATABASE_URL" pnpm db:migrate
DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json
pnpm exec vitest run packages/db/src/client.test.ts
```

The status must be `upToDate` with no pending migrations. The client regression
creates both legacy columns in an isolated database, replays the compatibility
migrations, proves modern and legacy inserts and one-sided updates converge to
equal identifiers or fingerprints, and proves conflicting dual edits fail
closed.

Do not drop a legacy column or either compatibility trigger while any installed
tool still writes the legacy representation. For break-glass rollback, keep
Paperclip stopped and restore the verified pre-migration database backup; do
not hand-edit encrypted material or copy values into receipts.
