# Dirty Session Preservation Ledger

Run this before any manual or automated git worktree prune, execution workspace cleanup, or disk-pressure cleanup that might remove Paperclip, Hermes, or execution worktree directories.

The ledger is read-only. It runs git inspection commands, records dirty tracked and untracked paths, marks missing or prunable git worktree registrations, and writes timestamped JSON and Markdown receipts. It does not delete worktrees, prune git metadata, reset branches, remove files, or close execution workspace records.

## Command

```sh
pnpm ops:dirty-session-preservation
```

By default the command inspects:

- this Paperclip checkout
- the sibling Hermes checkout at `/Users/mnm/Documents/Github/hermes-agent`
- execution workspace repositories discovered from the active cockpit database, when the cockpit config and database are reachable

If cockpit DB discovery is unavailable, the ledger still completes for the repos it can inspect and records the DB discovery failure under `discovery.warnings`.

## Output

When the Paperclip cockpit data area exists, receipts are written under:

```text
<PAPERCLIP_HOME>/instances/<PAPERCLIP_INSTANCE_ID>/data/ops/dirty-session-preservation/runs/
```

On this host, the default path is:

```text
/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/dirty-session-preservation/runs/
```

If the cockpit data area is not available, receipts fall back to:

```text
docs/ops/dirty-session-preservation/runs/
```

Every run writes a matching pair:

- `<timestamp>-<pid>-dirty-session-preservation.json`
- `<timestamp>-<pid>-dirty-session-preservation.md`

## Options

```sh
pnpm ops:dirty-session-preservation -- --no-cockpit-db
pnpm ops:dirty-session-preservation -- --execution-root /path/to/repo
pnpm ops:dirty-session-preservation -- --repo execution:portfolio-os:/Users/mnm/Documents/Github/portfolio-os
pnpm ops:dirty-session-preservation -- --output-dir /tmp/paperclip-ledgers
```

Use `--no-cockpit-db` when you only want filesystem/git inspection. Use `--execution-root` or `--repo role:name:path` to add repos that are not registered in the cockpit database.

## Reading The Ledger

Treat these statuses as blockers for destructive cleanup until reviewed:

- `dirty_preserve`: tracked or untracked state exists and should be preserved before cleanup
- `inspect_failed`: git status could not be read, so the worktree needs manual review
- `missing`: the registered worktree path is missing but Git did not mark it prunable

Treat these as prune candidates only after review:

- `missing_prunable`
- `prunable`

The script reports those states as `eligible_for_git_prune_after_review`; it never performs the prune itself.
