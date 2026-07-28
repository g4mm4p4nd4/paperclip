---
title: Secure Profit Flywheel Fixture Promotion
summary: Promote the built-in Portfolio OS canary through a loopback, least-privilege credential broker
---

# Secure Profit Flywheel Fixture Promotion

For run-bound project setup, canonical implementation object hashing,
read-only closeout, and guarded post-canary re-pause, see
[Profit Flywheel work-bearing canary](./profit-flywheel-work-bearing-canary.md).

Use this operator command to promote the built-in
`fixture/profit-canary` dispatch into the Paperclip-watched outbox and observe
its exact workflow. This is the only supported built-in promotion path when the
company API key is stored by Paperclip.

The command resolves the active company `PAPERCLIP_API_KEY` from the
`local_encrypted` provider **inside the Paperclip process**. It never exports
the real bearer, puts it on argv, forwards it to Portfolio OS, or writes it to
logs or receipts. A run-scoped broker listens on `127.0.0.1` and gives the
Python child a random sentinel that is valid only for these two GET requests:

- `/api/projects/<receipt-project-id>`
- `/api/companies/<receipt-company-id>/profit-flywheel/workflows` with only the
  exact receipt-bound `correlation_id` and `limit=10` query

The broker replaces the sentinel with the real bearer only for the confined
upstream request. The child environment is allowlisted and does not inherit
`DATABASE_URL`, provider credentials, shell startup state, or the parent
`PAPERCLIP_API_KEY`. On POSIX, `python3` owns a detached process group; timeout,
interrupt, output overflow, and normal completion terminate the entire group
with bounded `TERM` then `KILL`, so a grandchild cannot outlive the operator.
The broker closes on every outcome.

## Preconditions

1. Apply Profit Flywheel runtime provisioning for the receipt-bound company.
   Its latest `PAPERCLIP_API_KEY` version must be active, fingerprint-valid,
   and use `local_encrypted`.
   The CLI loads the same live config selected by `PAPERCLIP_HOME` and
   `PAPERCLIP_INSTANCE_ID`, requires its configured master-key file to already
   exist as an owner-read/owner-only mode-`0400` or `0600` regular file, and
   binds that exact path only while decrypting. It will not auto-create or
   replace a missing/invalid key, and rejects inline
   `PAPERCLIP_SECRETS_MASTER_KEY` material for this operation.
2. Run Paperclip on credential-free loopback HTTP, for example
   `http://127.0.0.1:3100`. Remote origins, hostnames, URL credentials, paths,
   queries, fragments, and HTTPS are rejected by this local operator boundary.
3. Generate and validate the immutable Portfolio OS v2 canary receipt. The
   receipt company must exactly match `--company-id`; it must also state
   `e2e_proof=false` and `execution_authority=paperclip_control_plane` before a
   credential is resolved or broker listener is opened.
4. Pre-create the outbox, promotion-receipt, and aggregate-receipt directories.
   Each path must be absolute and canonical. Every directory component is
   snapshotted and revalidated as root/current-owner controlled with unsafe
   group/world writes rejected (the standard root-owned sticky ancestors are
   the only exception). Input and result artifacts must be current-owner,
   read-only regular files.
5. Bind the operator to the intended instance with `--home` and
   `--instance-id`. The operator installs the exact derived `PAPERCLIP_CONFIG`
   path before loading config and rejects conflicting environment values; it
   never falls back to `~/.paperclip`. For the canonical embedded instance, do
   not supply a connection string: the command derives
   `127.0.0.1:<embeddedPostgresPort>` from that exact live config.
   An external PostgreSQL deployment may supply `DATABASE_URL` only through the
   environment. Credential and connection-string argv flags are rejected,
   including `--flag=value` forms.

## Run

```bash
cd /Users/mnm/Documents/Github/paperclip

install -d -m 0700 \
  /absolute/profit-canary/promotion-receipts \
  /absolute/profit-canary/operator-receipts

pnpm ops:profit-flywheel-fixture-promotion -- \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --home /absolute/paperclip-home \
  --instance-id default \
  --portfolio-os-root /Users/mnm/Documents/Github/portfolio-os \
  --receipt /absolute/profit-canary/run/canary_receipt.json \
  --outbox-dir /absolute/paperclip-watched-dispatch-outbox \
  --promotion-receipt-dir /absolute/profit-canary/promotion-receipts \
  --aggregate-receipt-dir /absolute/profit-canary/operator-receipts \
  --paperclip-api-url http://127.0.0.1:3100 \
  --wait-seconds 120 \
  --poll-seconds 2
```

Arguments are passed to `python3 -m pos.profit_canary run-live` as an argv
array with `shell: false`. Receipt, outbox, promotion, wait, and poll values are
never interpolated into a shell command. Wait must be between 0 and 900
seconds; poll must be between 0.05 and 60 seconds. The operator timeout is the
bounded wait plus a 60-second shutdown allowance.

The command prints one compact JSON result containing only `status`, `run_id`,
the structured blocker (if any), and the aggregate receipt path/SHA-256. Exit
code `0` means the exact workflow was observed. Exit code `2` means an
immutable blocker receipt was written; it is not success. Exit code `1` is a
pre-receipt CLI/database or receipt-install failure that requires operator
repair.

Authority inputs are bounded and consumed from one `O_NOFOLLOW` file
descriptor. The operator compares the descriptor metadata before and after the
read, rechecks the pathname and complete parent hierarchy, and parses the exact
bytes it hashed. It never performs a separate hash read followed by a second
JSON read, so a rename, symlink substitution, owner/mode drift, or oversized
artifact fails closed rather than creating a mixed receipt.

## Aggregate receipt

Every execution that reaches the validated aggregate-receipt directory writes
a create-exclusive, file-and-directory-fsynced mode-`0444` receipt. It binds:

- company, project, run, immutable input receipt, and canonical directories;
- the exact Paperclip home, instance root, instance ID, and config path selected
  before config or secret resolution;
- the immutable source dispatch path/SHA and exact byte equality of the
  published dispatch (an expected filename with different bytes is blocked);
- the local-encrypted secret id/version/value fingerprint, never its material;
- exact broker method/path authority and in-process upstream authorization;
- child exit/signal/timeout state and redacted-output digests;
- published dispatch, promotion receipt, observation receipt, and workflow id;
- one precise `blocker_code`, `blocker_detail`, `next_owner`, and
  `resume_condition` when the workflow is not observed.

Do not edit or replace an existing receipt. Replay the same immutable canary
identity; each attempt gets a new aggregate receipt while Portfolio OS reuses
or validates its exact immutable promotion artifacts.

For an observed workflow, `workflow_id` must be a canonical UUID and must
exactly equal the id inside the immutable observation payload. The same payload
must bind the receipt company, project, run, and `profit-canary:<run-id>`
correlation identity plus the exact published dispatch path/SHA. The promotion
receipt independently binds the canary receipt, source dispatch, published
dispatch, and all four identities. Finally, Paperclip queries
`profit_flywheel_workflows` directly and requires exactly one row matching the
UUID, company, project, run, correlation, and source path/hash. Child-authored
JSON alone is never proof; a text label, mismatched UUID, changed byte, or
missing database row is blocked, never recorded as success.

## Blocker ownership

Common blocker families are intentionally distinct:

| Blocker | Owner | Resume condition |
|---|---|---|
| `profit_canary_api_key_missing` | `paperclip_board_operator` | Apply company runtime provisioning, then replay |
| `profit_canary_api_key_provider_invalid` / `*_inactive` / `*_decryption_failed` / `*_integrity_failed` | `paperclip_security_owner` | Repair or rotate the active local-encrypted secret, then replay |
| `profit_canary_master_key_missing` / `*_permissions_unsafe` / `*_invalid` | `paperclip_security_owner` | Restore the exact configured instance key; never generate a replacement for existing ciphertext |
| `profit_canary_instance_binding_required` / `*_binding_mismatch` / `*_home_must_be_absolute` | `paperclip_board_operator` | Supply one exact home/instance binding and remove conflicting config environment values |
| `profit_canary_api_origin_not_loopback` | `paperclip_board_operator` | Use credential-free `http://127.0.0.1:<port>` |
| `profit_canary_python_spawn_failed` | `paperclip_host_runtime_owner` | Restore `python3` on the trusted PATH |
| `profit_canary_child_timeout` / `*_failed` / `*_output_*` | `portfolio_os_canary_owner` | Repair the exact run-live failure and replay the same identity |
| `profit_canary_workflow_wait_timeout` | `paperclip_control_plane_owner` | Enable/repair dispatch ingest, then replay the same identity |
| `profit_canary_broker_close_failed` | `paperclip_security_owner` | Confirm the ephemeral loopback listener is gone before replay |

The timeout receipt proves only that the immutable dispatch was published and
not observed within the bounded window. It does not prove end-to-end canary
success. Final acceptance still requires the work-bearing workflow to close
its issue, bind changed-file/test/review/release evidence, write learning back,
and advance the next research iteration.

## Verification

```bash
pnpm exec vitest run \
  server/src/__tests__/profit-flywheel-fixture-promotion.test.ts \
  server/src/__tests__/heartbeat-api-broker.test.ts
pnpm --filter @paperclipai/server typecheck
```

The focused integration test starts a fake loopback Paperclip origin and a real
Python child. It proves the exact broker allowlist, real-bearer substitution,
sentinel-only child capability, parent-environment isolation, broker shutdown,
immutable aggregate receipt, and redaction on both success and failure without
calling a live API or database.
