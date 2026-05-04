# Upstream Upgrade Runbook

This runbook is for upgrading a live Paperclip checkout from a local fork to a tagged upstream release without losing source patches, runtime configuration, or company data.

## 1. Asset Classes

Preserve these independently before changing code or running migrations:

- Source state: current branch, remotes, SHAs, tags, worktrees, dirty paths, bundles, and patch archives.
- Runtime configuration: `.paperclip`, `.env*`, config JSON, secrets metadata, adapter plugin manifests, watchdog files, and cockpit service files.
- Live data: database backup, storage, attachments, company Codex homes, workspaces, logs, and backup directories.

Never treat a code checkout as a sufficient backup of a live instance.

## 2. Preflight

From the live checkout:

```sh
git status --short
git remote -v
git worktree list --porcelain
git rev-parse HEAD
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:3100/api/companies
```

Create immutable source recovery points:

```sh
git tag backup/paperclip-pre-upgrade-YYYYMMDD-<sha> <sha>
git bundle create /path/to/backup/paperclip-pre-upgrade-all-YYYYMMDD.bundle --all
```

For every dirty Paperclip worktree, archive a patch instead of rewriting or pruning it:

```sh
git -C /path/to/worktree diff --binary > /path/to/backup/worktrees/<name>.diff
git -C /path/to/worktree diff --cached --binary > /path/to/backup/worktrees/<name>.staged.diff
```

Create a logical database backup that includes the migration journal, then snapshot runtime files:

```sh
NODE_OPTIONS=--max-old-space-size=12288 pnpm paperclipai db:backup \
  --include-migration-journal \
  --dir /path/to/backup/db-backups \
  --filename-prefix pre-upgrade \
  --json
```

```sh
rsync -a --relative \
  /path/to/live/.paperclip \
  /path/to/live/.env \
  /path/to/paperclip-home/instances/default/config.json \
  /path/to/paperclip-home/instances/default/data/storage \
  /path/to/paperclip-home/instances/default/data/workspaces \
  /path/to/paperclip-home/instances/default/data/companies \
  /path/to/snapshot-root/
```

## 3. Code Integration

Create the integration branch from the upstream stable tag, then replay local commits intentionally:

```sh
git fetch upstream --tags
git switch -c codex/paperclip-upgrade-vYYYY-MDD upstream/vYYYY.MDD.P
git log --first-parent --reverse <merge-base>..<local-main-sha>
git cherry-pick <commit>
```

Preserve fork behavior explicitly when upstream has not superseded it:

- External-only Hermes adapter loading: core must not depend on
  `hermes-paperclip-adapter` or register `hermes_local` as built-in.
- Generic adapter config-schema and UI parser loading.
- Transcript `stderr_group` and `tool_group` rendering.
- Dashboard excerpt behavior.
- Cockpit routines and repo-backed operating contracts.
- Local adapter recovery and stale-session patches.

Do not carry old fork deletions of upstream migrations, plugin/runtime packages, MCP server, environment tables, or sandbox provider files unless a current local requirement proves the deletion is still correct.

If local schema patches remain, generate a new migration and make it safe for existing data:

```sh
pnpm db:generate
pnpm -r typecheck
```

## 4. Restore CLI

The CLI supports explicit restores:

```sh
pnpm paperclipai db:restore --file /path/to/backup.sql.gz --yes
pnpm paperclipai db:restore --file /path/to/backup.sql --yes --json
```

`--yes` is required because restore overwrites the configured database. Use `--data-dir` or `--config` to point at a canary instance before restoring.

## 5. Canary

Create a canary runtime home beside the live home. Do not point canary config at the live database.

```sh
export PAPERCLIP_HOME=/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit-canary-v2026-428
export PAPERCLIP_INSTANCE_ID=default
export HEARTBEAT_SCHEDULER_ENABLED=false
```

Use a separate server port and database port, for example:

- API/UI: `127.0.0.1:3110`
- Embedded Postgres: a port not used by live

Restore the SQL backup into canary, copy non-DB runtime assets, then start the upgraded branch:

```sh
pnpm paperclipai db:restore --data-dir "$PAPERCLIP_HOME" --file /path/to/pre-upgrade.sql.gz --yes
HEARTBEAT_SCHEDULER_ENABLED=false pnpm dev
```

Acceptance checks:

```sh
curl -fsS http://127.0.0.1:3110/api/health
curl -fsS http://127.0.0.1:3110/api/companies
```

Also verify dashboard rendering, company switching, adapter manager plugin visibility, existing attachments, secrets metadata without secret value exposure, and that routines do not fire while scheduler is disabled.

## 6. Cutover

Cut over only after canary passes.

1. Stop the live managed dev runner.
2. Take a final database backup with `--include-migration-journal`.
3. Snapshot live runtime files again.
4. Switch live code to the integration branch.
5. Start upgraded live on `127.0.0.1:3100`.
6. Repeat health, companies, dashboard, adapter, attachment, and backup checks.

## 7. Rollback

Keep rollback simple and tested:

```sh
pnpm dev:stop
git switch main
git reset --hard backup/paperclip-pre-upgrade-YYYYMMDD-<sha>
pnpm paperclipai db:restore --file /path/to/final-pre-cutover.sql.gz --yes
rsync -a /path/to/final-filesystem-snapshot/ /path/to/live-home/
pnpm dev
```

Use rollback if health fails, company counts drift unexpectedly, attachments are unreadable, adapter plugins do not load, secrets are exposed, or the scheduler begins firing unexpectedly.
