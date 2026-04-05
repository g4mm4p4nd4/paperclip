---
title: Portfolio OS Cockpit
summary: Run Paperclip as the execution runtime for Portfolio OS dispatches
---

Paperclip can run as the execution cockpit for Portfolio OS. Portfolio OS remains the truth plane: it writes immutable dispatch artifacts, and Paperclip ingests them to stand up a venture team, prepare the target repository, and wake the right agents.

## Start the cockpit

Run Paperclip with an isolated data directory:

```bash
pnpm paperclipai run --data-dir /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit
```

This keeps the cockpit state, ledger, database, and managed Codex home separate from your default Paperclip instance.

## Expected local layout

- `portfolio-os`: `/Users/mnm/Documents/Github/portfolio-os`
- `paperclip`: `/Users/mnm/Documents/Github/paperclip`
- `gstack`: `/Users/mnm/Documents/Github/gstack`
- target clones: `/Users/mnm/Documents/Github/<repo_name>`
- dispatch outbox: `/Users/mnm/Documents/Github/portfolio-os/data/dispatch/outbox`
- evidence inbox: `/Users/mnm/Documents/Github/portfolio-os/data/dispatch/inbox`

## Dispatch ingest flow

1. Portfolio OS runs `research`, `council`, `execution-scaffold`, and `dispatch`.
2. Portfolio OS writes `dispatch_<run_id>.json` into the outbox.
3. Paperclip polls the outbox on normal server boot.
4. On first ingest of a dispatch hash, Paperclip:
   - reuses or creates a venture company keyed to the launch target repo
   - creates one project per `run_id`
   - provisions the target repo as the primary workspace and `portfolio-os`, `paperclip`, and `gstack` as secondary workspaces
   - ensures the target clone exists locally
   - creates or checks out `run/<run_id>/bootstrap`
   - creates role-scoped issues from the dispatch execution manifest
   - creates a `launch_execution` approval for the release path
   - wakes the assigned agents

Dispatch files are immutable. Paperclip records an ingest ledger in its data directory and skips any dispatch hash it has already processed.

## Venture org chart

Each venture company gets this default team:

- CEO
- CTO
- CMO
- Engineer-1
- Engineer-2
- Designer/Copy
- QA
- Release Manager
- Growth/Distribution

All execution agents use `codex_local` with persistent sessions and the target repository as their default working directory.

## Skill handling

Paperclip keeps injecting its required Codex skills, but it does not overwrite an existing live `~/.codex/skills/gstack` install. If `gstack` is missing, the cockpit links it from the local clone.

## Approval policy

- Inner loop: agents can operate with their configured local execution bypasses.
- Merge gate: release issues are linked to a `launch_execution` approval.
- Deploy gate: production deploy work remains approval-required.

## Rollback switch

To stop ingest and downstream execution without breaking the Portfolio OS truth loop, start Paperclip with:

```bash
PAPERCLIP_POS_DISPATCH_INGEST_ENABLED=false pnpm paperclipai run --data-dir /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit
```

Portfolio OS can continue generating research, council, scaffold, and dispatch artifacts while Paperclip stays passive.
