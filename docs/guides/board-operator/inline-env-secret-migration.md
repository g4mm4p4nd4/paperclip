---
title: Canonical inline environment secret migration
description: Dry-run, approve, and atomically replace inline agent credentials with company-scoped encrypted secret references.
---

# Canonical inline environment secret migration

`pnpm secrets:migrate-inline-env` repairs legacy agent configurations that persist
credential values directly in `adapterConfig.env`. The command is dry-run by
default and canonicalizes every value to one exact, case-sensitive secret identity:

```text
(company_id, environment variable name)
```

It never prefixes a secret with an agent id and never lowercases the environment
key. Two agents in one company using the same key and value therefore share one
encrypted secret/version. The same key in two companies remains isolated.

## Safety contract

- All agents are scanned, including terminated agents. Empty values and
  non-sensitive settings are left unchanged.
- Sensitive-key recognition is boundary-aware. It recognizes snake case,
  camel case, collapsed names, token/secret/password families, and credential
  connection keys, including `BEARER`, `PASSWD`, `PASSPHRASE`, `PGPASSWORD`,
  `PGPASSFILE`, and credential-context `*_PWD` aliases, without treating harmless
  names such as `tokenomics`, `passwordless`, or the shell's bare `PWD` as secrets.
- Multiple plaintext values for one company/key stop the entire run. No value is
  selected implicitly.
- An existing canonical secret is reused only when its active latest encrypted
  version has the same internal fingerprint. Mismatch, revocation, a missing
  latest version, or a non-`local_encrypted` provider fails closed.
- The optional process-environment import path can rotate a mismatched canonical
  secret only with `--rotate-imported-secrets`. A matching value is always reused,
  so retrying a completed command cannot grow versions.
- Receipts and stdout never contain plaintext or value fingerprints. Per-secret
  receipt entries contain only company id, canonical name, id, version, and action.
- Apply requires the exact secret-safe plan SHA from a fresh dry run. The approval
  SHA covers the complete fleet and each agent's secret-redacted adapter-config
  SHA. Plaintext equality is separately rechecked with a private in-memory CAS.
- Apply re-reads the complete fleet after taking advisory/table locks. A new agent,
  new binding, changed config, changed secret, active affected heartbeat, or any
  other plan drift aborts before writes.
- Secret creation/rotation and validated `secret_ref` replacement commit in one
  serializable transaction. The migration writes no `activity_log` row or other
  tenant-visible recovery marker.
- Before the transaction, apply writes an authenticated, sanitized precommit
  recovery receipt beside the intent receipt. The receipt directory is owned by
  the operator, mode `0700`, and rejects symlinked or group/world-writable path
  components. Receipt directory entries are synced before database commit.

## Preconditions

1. Stop and disable the API server, scheduler, watchdog, and other writers. Confirm
   no affected agent or heartbeat is running.
2. Apply every repository database migration with `pnpm db:migrate`. Apply refuses
   a database with pending migrations.
3. Confirm the configured `local_encrypted` master key already exists. A migration
   never creates a missing key. File-backed keys must be bounded regular,
   non-symlink files owned and readable by the current uid, with no execute or
   group/other permission bits. The file identity and contents are revalidated
   immediately before the transaction and again before commit. Encryption uses
   only the already-opened in-memory key; the key buffer is zeroed on exit. This
   live operator intentionally rejects
   inline `PAPERCLIP_SECRETS_MASTER_KEY` material; use the configured key file.
4. For the embedded instance, leave `DATABASE_URL` unset; the wrapper derives the
   connection from the active `PAPERCLIP_HOME`/`PAPERCLIP_INSTANCE_ID` config. For
   external PostgreSQL only, provide the connection through the normal environment
   or Paperclip config—never argv.

## Dry run and approval

The base dry run scans all inline agent environment bindings:

```bash
pnpm secrets:migrate-inline-env --dry-run
```

To import a canonical secret that is not currently present inline, export its value
in the current process and pass only its name. Values are never accepted through
argv, a dotenv path, or a command option:

```bash
export OPENCODE_GO_API_KEY

pnpm secrets:migrate-inline-env --dry-run \
  --company-id '<company-uuid>' \
  --import-env OPENCODE_GO_API_KEY
```

The command prints one JSON object. Save `planSha256` from that output. The dry-run
receipt is installed as a synced, immutable `0444` file below
`instances/<instance>/data/ops/inline-env-secret-migration/runs/`.

## Apply

Use the exact same import names and current-process values as the approved dry run:

```bash
export PAPERCLIP_INLINE_SECRET_MIGRATION_MAINTENANCE=I_HAVE_STOPPED_PAPERCLIP_WRITERS

pnpm secrets:migrate-inline-env --apply \
  --expected-plan-sha256 '<dry-run-plan-sha256>' \
  --company-id '<company-uuid>' \
  --import-env OPENCODE_GO_API_KEY
```

Apply creates a complete compressed database backup before any database write.
It verifies the backup is a current-uid-owned regular file directly inside the
trusted backup directory, then changes its mode to `0400`, hashes and syncs it
through the same file descriptor, and records its path/hash/size in an immutable
intent receipt. The final immutable receipt is written only after commit.

The maintenance acknowledgment and explicitly named import values are captured
from the process environment before Paperclip loads dynamic configuration. Values
or acknowledgments introduced later by dotenv loading are not accepted.

If an explicitly imported current-process value must replace a different canonical
value, first review a dry run and add the rotation flag to both dry run and apply:

```bash
pnpm secrets:migrate-inline-env --dry-run \
  --company-id '<company-uuid>' \
  --import-env OPENCODE_GO_API_KEY \
  --rotate-imported-secrets

pnpm secrets:migrate-inline-env --apply \
  --expected-plan-sha256 '<rotation-plan-sha256>' \
  --company-id '<company-uuid>' \
  --import-env OPENCODE_GO_API_KEY \
  --rotate-imported-secrets
```

Rotation never applies to an unimported inline conflict. Resolve those source values
explicitly instead of using a fleet-wide implicit winner.

## Crash recovery and rollback

The database transaction is all-or-nothing. A crash before commit leaves no secret,
version, agent-config, or tenant-visible metadata mutation. A crash after commit but
before the final receipt leaves the private HMAC-authenticated precommit recovery
receipt. Rerun the same `--apply --expected-plan-sha256 ...` command with the same
named imports. It validates the recovery schema/HMAC, immutable intent and backup,
import approval, and exact expected database poststate before reconstructing the
byte-identical final receipt without another backup, rotation, or agent write.
Tampered recovery authority fails closed.

The pre-apply backup is break-glass rollback authority. Restoring it also restores
the legacy inline plaintext that prompted this migration. Keep it `0400`, restrict
access, and immediately rerun the migration after any restore before enabling
Paperclip writers.

Common blocker strings are intentionally value-free:

- `inline_secret_plaintext_collision`
- `inline_secret_fingerprint_mismatch`
- `inline_secret_plan_approval_mismatch`
- `inline_secret_full_plan_changed_under_lock`
- `inline_secret_active_execution`
- `inline_secret_pending_database_migrations`
- `inline_secret_master_key_invalid`
- `inline_secret_master_key_changed`
- `inline_secret_operator_root_invalid`
- `inline_secret_backup_escaped_root`
- `inline_secret_recovery_receipt_invalid`
