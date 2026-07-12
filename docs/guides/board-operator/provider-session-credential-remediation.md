# Provider-session credential remediation

This offline command removes JWT-shaped provider/Paperclip session credentials from historical heartbeat run logs and the audited database surfaces without discarding run-log integrity evidence.

It is intentionally not part of server startup or a scheduler. The operator must stop Paperclip writers, run a dry-run, approve that exact plan hash, and then apply it during the same maintenance window.

## Safety contract

- `DATABASE_URL` is accepted only through the environment. A connection string on argv is rejected.
- The CLI opens a named maintenance connection and appends `statement_timeout=0` and `idle_in_transaction_session_timeout=0` to the PostgreSQL startup options for every pooled connection. The full historical scan can exceed the request-traffic timeout, and the serializable table lock intentionally spans filesystem installation; the exclusive maintenance acknowledgement, zero-client fence, bounded file reads, and database locks bound these maintenance-only exceptions.
- The planner loads lightweight rows participating in the `log_ref` contract and affected row ids, then fetches each complete payload row individually for fingerprinting/counting. It never materializes either the multi-GiB historical corpus or the affected payload corpus in process memory.
- The command requires `PAPERCLIP_CREDENTIAL_REMEDIATION_MAINTENANCE=I_HAVE_STOPPED_PAPERCLIP_WRITERS` and independently refuses queued/running heartbeat work, running agents, or another database client. It repeats that proof after taking the filesystem lock and before every post-commit cleanup/postcheck boundary.
- The server supervisor, launch agent, watchdog, and scheduler must be disabled—not merely stopped once—until the final receipt is durable. The command's lock excludes other remediation processes; it is not a substitute for disabling process auto-restart. During apply, a serializable table lock spans the first production file replacement through the database CAS commit so a reconnecting writer cannot cross that boundary.
- The active root, legacy root, and receipt/staging root must be canonical non-symlink directories on the same filesystem device. The plan SHA and every phase receipt bind SHA-256 identities for all three canonical root paths; byte-identical clones or an alternate receipt root cannot reuse an approval. The receipt root, each run directory, the retained lock, and the ciphertext envelope must be owned by the remediation user and inaccessible to group/other users.
- An O_EXCL process lock prevents concurrent remediation. Its file is synced before the receipt-root directory entry is fsynced; new run-directory names and every lock deletion are likewise directory-fsynced before the next phase or successful return. A lock retained after mutation means **roll forward** with `--resume-id`; do not delete the lock or restore credential-bearing bytes to production.
- Run-log replacements use a same-byte-length ASCII marker. Plain and gzip NDJSON are decoded, validated, redacted, revalidated, and hashed before installation.
- Database planning is descriptor-only and bounded-memory. It retains affected IDs, occurrence aggregates, and deterministic old/next fingerprints—not `stdout_excerpt`, `stderr_excerpt`, `result_json`, event messages, or event payloads. Complete values are fetched one row at a time; apply streams each original/successor pair directly into the encrypted envelope, then re-fetches and sanitizes one locked row at a time in the serializable CAS transaction.
- A verified AES-256-GCM rollback envelope is written without a plaintext temporary file. Initial capture requires every source file to match the scan's exact `oldBytes` and `oldSha256`; a file already changed to its planned successor is rejected rather than mislabeled as a rollback original. Envelope verification requires canonical bounded base64 and proves each decoded original's byte length and SHA-256 against that scanned identity. The ciphertext file and its parent directory are fsynced before `backup_prepared`; mutation cannot begin from a page-cache-only or semantically false backup. The key reference must be an owner-only regular file outside the repository.
- Database updates run under `SERIALIZABLE`, lock both heartbeat tables, and compare the frozen old row before updating. Already-applied next state is accepted only during replay.
- Missing `log_ref` rows are fingerprinted and preserved. The command does not null or invent missing historical evidence.
- Phase receipts are written and fsynced under an ignored temporary name, atomically hard-linked create-exclusive into the chain, and then fixed at mode 0444. The chain validates phase ordering, all three frozen root identities, approved-plan ancestry, and invariant rollback-envelope metadata before any append. Credential values and per-row old/next fingerprints are never included; the receipt exposes only the aggregate composite plan SHA required for exact-plan approval.

## Prepare the maintenance window

1. Deploy the sink-redaction fix first.
2. Disable the Paperclip watchdog/supervisor and schedulers, then stop the Paperclip server and every process that can enqueue or write heartbeat runs. Verify the supervisor stays disabled and only PostgreSQL remains available. If anything reconnects, stop and restart the maintenance proof; never rely on the acknowledgement variable alone.
3. Create an owner-only receipt directory outside both run-log roots.
4. Create or select a 32-byte rollback encryption key outside the repository and restrict it to mode 0600. Store its reference in your approved secrets/key-management boundary; never paste the key into argv, logs, or receipts.
5. Export the database connection only in `DATABASE_URL`.

Example path variables (paths are illustrative and must be reviewed for the target instance):

```bash
export ACTIVE_RUN_LOG_ROOT=/absolute/active-instance/data/run-logs
export LEGACY_RUN_LOG_ROOT=/absolute/legacy-instance/data/run-logs
export REMEDIATION_RECEIPT_ROOT=/absolute/secure/credential-remediation-receipts
export PAPERCLIP_CREDENTIAL_REMEDIATION_KEY_FILE=/absolute/outside-repo/provider-session-remediation.key
export PAPERCLIP_CREDENTIAL_REMEDIATION_MAINTENANCE=I_HAVE_STOPPED_PAPERCLIP_WRITERS
export DATABASE_URL='postgresql://<redacted-env-only>'
```

## Dry-run

Dry-run acquires the exclusive lock, performs the complete filesystem/database scan, writes immutable aggregate phase receipts, and makes no run-log or database mutation. Its resident database payload is bounded by the largest affected row rather than the total affected corpus; the plan itself contains descriptors only.

```bash
pnpm ops:provider-session-credential-remediation -- \
  --dry-run \
  --active-root "$ACTIVE_RUN_LOG_ROOT" \
  --legacy-root "$LEGACY_RUN_LOG_ROOT" \
  --receipt-root "$REMEDIATION_RECEIPT_ROOT"
```

Capture `remediationId` and `planSha256` from the count-only JSON result. Review the aggregate counts, especially:

- active-only, legacy-only, duplicate-root, and unresolved-missing references;
- affected mapped and orphan files;
- affected run/event surface counts;
- metadata updates and null-metadata backfills.

Any root collision, unsafe path/symlink, malformed NDJSON, partial metadata pair, or existing hash/byte mismatch aborts normal apply.

For the 2026-07-12 live repair, do not approve the plan unless the aggregate result reconciles exactly to this frozen inventory. Any receipt/plan SHA produced before canonical active/legacy/receipt-root binding is obsolete by design and must not be applied; run a fresh dry-run with this implementation and approve only its new receipt and plan SHA:

| Field | Required value |
|---|---:|
| `dbLogRefs` | 25,147 |
| `activeFiles` | 413 |
| `legacyFiles` | 11,193 |
| `liveOnlyRefs` | 413 |
| `legacyOnlyRefs` / `mappedFilesToMigrate` | 7,349 / 7,349 |
| `unresolvedMissingRefs` | 17,385 |
| `affectedLegacyFiles` / `affectedOrphanFiles` | 786 / 2 (784 mapped) |
| `affectedActiveFiles` / `fileOccurrences` | 0 / 1,113 |
| `runRowsToUpdate` / `eventRowsToUpdate` | 2,780 / 0 |
| stdout rows / occurrences | 283 / 298 |
| stderr rows / occurrences | 7 / 7 |
| result rows / occurrences | 2,140 / 3,051 |
| event message/payload rows / occurrences | 0 / 0 |
| `logMetadataRowsToUpdate` | 1,323 |
| `nullLogMetadataRowsToBackfill` | 620 |

The final-code dry-run for this maintenance window is frozen to the following immutable identity. Apply must use this exact remediation id, plan SHA, canonical roots, and receipt chain; the earlier `live-provider-session-remediation-20260712`, `live-provider-session-remediation-v3-20260712`, and `live-provider-session-remediation-v4-20260712` chains are superseded and must not be applied. The v3 apply failed closed with `plan_approval_mismatch` before mutation after 75 credential-free, database-unreferenced test run-log files (61,281 aggregate bytes) appeared in the legacy root. V4 included that harmless inventory drift, then failed before `backup_prepared` or mutation because chunk-local UTF-8 decoding corrupted a split multibyte character during encrypted-envelope verification; its ciphertext and lock were durably removed. V5 uses stateful UTF-8 decoding, is covered by a boundary-split regression, and preserves the same database, missing-reference, credential-match, and planned-mutation counts.

| Approval field | Frozen value |
|---|---|
| Remediation id | `live-provider-session-remediation-v5-20260712` |
| Approved plan SHA-256 | `18585db900bc22e4252a0ffa2f0c6194368319d0c1a769a7fac01b2dadc054e8` |
| Verified dry-run receipt | `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/provider-session-credential-remediation/runs/live-provider-session-remediation-v5-20260712/01-verified.json` |
| Verified receipt file SHA-256 | `094405ef27e328c4b1248a74209c370dc88e7f4c2002fe155659bc0c53a50fcd` |
| Active-root identity SHA-256 | `aa46524620bcaae4638e7b287a299cfb5e37c8cbadc5a947675648fe98249d39` |
| Legacy-root identity SHA-256 | `18b3b7eb385da6ca5dffa3d8c2cdd1f1f96b65dbc038a693ec5aa08b5a93397a` |
| Receipt-root identity SHA-256 | `5f47fe661e1969ac8cef2d49618aaf5d3c5d7f911d5d1ca3e4c299e85ee95328` |

The run-row update count is the exact union of 2,152 credential-bearing surface rows and 1,323 metadata-update rows: 695 overlap, leaving 628 metadata-only updates. The final postcheck for this inventory must report `active_referenced_files=7762`, `legacy_mapped_files=0`, `unresolved_missing_refs=17385`, `metadata_matched_rows=7762`, and zero file/database predicate counts.

## Apply the exact approved plan

Reuse the dry-run remediation id and pass its exact plan SHA:

```bash
pnpm ops:provider-session-credential-remediation -- \
  --apply \
  --remediation-id '<dry-run-remediation-id>' \
  --expected-plan-sha256 '<dry-run-plan-sha256>' \
  --active-root "$ACTIVE_RUN_LOG_ROOT" \
  --legacy-root "$LEGACY_RUN_LOG_ROOT" \
  --receipt-root "$REMEDIATION_RECEIPT_ROOT"
```

Apply performs these phases:

1. `scanned`
2. `backup_prepared`
3. `staged`
4. `files_installed`
5. `db_committed`
6. `source_deduped`
7. `verified`

The encrypted envelope contains the original affected database fields, original file bytes, remediation id, and approved plan identity needed for break-glass recovery. Its ciphertext hash, IV, authentication tag, key-reference hash, approved-plan hash, and aggregate entry counts are safe receipt metadata; the key and plaintext are not receipt data. The `db_committed` and later receipts also carry the serializable transaction id plus pre/post-commit WAL LSN evidence.

## Roll forward after interruption

If interruption occurs after the verified envelope is prepared, the primary lock remains and the command writes a `roll_forward_required` phase when possible. Do not start Paperclip and do not remove the primary lock.

Resume with the same paths and key reference:

```bash
pnpm ops:provider-session-credential-remediation -- \
  --apply \
  --resume-id '<remediation-id>' \
  --active-root "$ACTIVE_RUN_LOG_ROOT" \
  --legacy-root "$LEGACY_RUN_LOG_ROOT" \
  --receipt-root "$REMEDIATION_RECEIPT_ROOT"
```

Resume verifies the immutable receipt chain and encrypted envelope, including the envelope's remediation id and approved plan identity. Verification is bidirectional: every current plan mutation must belong to the envelope, and every encrypted run/event/file must still exist at its exact old or next fingerprint/byte identity. Mapped files may occupy only the explicit old-to-active transition states; orphan files may remain only in their original root. Safe-looking drift, deletion, coordinated database/file-metadata drift, and a rebuilt missing-reference baseline all fail closed even when they disappear from the forward plan. A new mutation still fails with `resume_plan_not_backed`; encrypted inventory drift uses the specific `resume_*_state_unbacked` blocker. Resume then commits remaining CAS updates, removes migrated legacy duplicates, and reruns all zero/integrity checks.

Receipt installation is crash-safe. A failed receipt write never consumes a chain sequence or leaves a parsed partial JSON receipt; after mutation, the command reloads the durable chain and appends `roll_forward_required` at the next proven sequence. Lock creation, new run-directory creation, lock deletion, and clean-state transitions are directory-fsynced; failure to prove one of those durability points fails the command rather than returning success. Ignore dot-prefixed temporary files only; never delete a numbered receipt.

After filesystem mutation, production recovery is roll-forward. A break-glass rollback must decrypt only into an isolated mode-0700 quarantine, sanitize before reinstalling anything, and use a new serializable/CAS database transaction. Never restore raw credential-bearing bytes into an active instance.

## Completion checks

The command returns `status: verified` only after proving:

- zero JWT-shaped matches across both run-log roots;
- zero matches in `heartbeat_runs.stdout_excerpt`, `stderr_excerpt`, and `result_json`;
- zero matches in `heartbeat_run_events.message` and `payload`;
- every surviving database-bound file matches `log_bytes`, `log_sha256`, and `log_compressed`;
- every surviving database-bound file is in the active root, no mapped file remains in the legacy root, and no database-bound reference is duplicated across roots;
- the exact preflight set of unresolved missing references is unchanged.
- the final receipt contains aggregate cleanup counts, exact active/legacy placement counts, the serializable transaction id, and pre/post-commit WAL LSN evidence.

Keep Paperclip stopped until the final `verified` receipt is present. Then start only the patched server, execute a work-bearing canary, and run a fresh count-only credential scan before closing the maintenance window.
