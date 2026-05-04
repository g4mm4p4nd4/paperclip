# Paperclip v2026.428.0 Upgrade Execution Note

Date: 2026-05-03

## Target

- Live checkout: `/Users/mnm/Documents/Github/paperclip`
- Runtime home: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit`
- Source before upgrade: `main` at `948302f9dae1c0e9c2757a13b05e499d11c6bd5d`
- Upstream release: `v2026.428.0`
- Upstream tag SHA: `3494e84a2920f3e2bc5f627f916da29e224086dc`
- Integration branch: `codex/paperclip-upgrade-v2026-428`

## Preservation

The upgrade preserves three asset classes separately:

- Source patches and worktrees through a backup tag, all-ref bundle, and per-worktree patch archives.
- Runtime config, secrets metadata, adapter plugin configuration, watchdog/cockpit files, and repo-local `.paperclip` through a filesystem snapshot.
- Live company data through a logical SQL backup plus storage/workspace/company filesystem snapshots.

Initial backup root:

```text
/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/upgrade-backups/20260503-v2026-428
```

Recorded recovery artifacts:

- `code/paperclip-pre-upgrade-all-20260503.bundle`
- `worktrees/*.diff`
- `runtime/db-backups/pre-upgrade-v2026-428-largeheap-20260503-183823.sql`
- `runtime/filesystem-snapshot`
- `runtime/live-health-before.json`
- `runtime/live-companies-before.json`
- `preflight-manifest.txt`

## Integration

The integration branch was created from upstream `v2026.428.0`. Local commits from the fork were replayed intentionally, skipping superseded bulk regression commits and preserving still-current behavior:

- External-only Hermes adapter story: `hermes_local` is available only after
  installing an external adapter package through the adapter manager.
- Generic adapter config-schema and UI parser loading.
- Transcript grouping for `stderr_group` and non-terminal `tool_group` events.
- Dashboard latest-run excerpt behavior.
- Cockpit routines and repo-backed operating contracts.
- Local adapter session recovery and stale-session hardening.

Upstream release migrations `0057` through `0074`, plugin/runtime packages, MCP server, environment tables, and sandbox provider files were retained.

## Local Schema Patch

The replay retained repo-backed operating contracts, which require:

- `company_operating_contracts`
- `goals.slug`
- `goals_company_slug_idx`

Migration `0075_last_the_stranger.sql` was generated and then made data-safe for live upgrade by:

- Creating `company_operating_contracts` only if missing.
- Adding `goals.slug` only if missing.
- Backfilling deterministic slugs from existing goal titles before `NOT NULL`.
- Creating constraints and indexes idempotently.

## CLI Restore

This upgrade adds:

```sh
pnpm paperclipai db:restore --file <backup.sql|backup.sql.gz> --yes [--json]
```

The restore command uses the same config resolution as backup and delegates to `runDatabaseRestore`. `--yes` is mandatory to prevent accidental overwrite.

The backup command also accepts:

```sh
pnpm paperclipai db:backup --include-migration-journal
```

Use this for canary and final pre-cutover backups so restored databases preserve migration history.

## Canary Acceptance

Canary path:

```text
/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit-canary-v2026-428
```

Canary must run with:

- `server.port=3110`
- a database port not used by live
- `HEARTBEAT_SCHEDULER_ENABLED=false`

Required checks:

- `GET /api/health`
- `GET /api/companies`
- dashboard render and company selector
- existing attachments readable
- secrets metadata visible without secret values
- routines not firing
- adapter manager shows external plugins
- migrated columns and indexes exist
- browser acceptance for dashboard and one representative company detail flow

## Cutover Gate

Live cutover is allowed only after canary passes. The live cutover sequence is:

1. Stop live runner.
2. Take final SQL backup with `--include-migration-journal`.
3. Take final filesystem snapshot.
4. Switch live checkout to `codex/paperclip-upgrade-v2026-428`.
5. Start upgraded live on `127.0.0.1:3100`.
6. Repeat health/dashboard/company/plugin/attachment checks.

Rollback remains the pre-upgrade backup tag plus final pre-cutover SQL and filesystem snapshots.
