---
title: Portfolio OS Cockpit
summary: Run Paperclip as the execution runtime for Portfolio OS dispatches
---

Paperclip can run as the execution cockpit for Portfolio OS. Portfolio OS remains the truth plane: it writes immutable dispatch artifacts, and Paperclip ingests them to stand up a venture team, prepare the target repository, and wake the right agents.

## Start the cockpit

Run Paperclip with an isolated data directory:

```bash
pnpm paperclipai run --data-dir /Users/mnm/.paperclip-local/portfolio-os-cockpit
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
4. On first ingest of a dispatch hash, Paperclip first validates the attached repo dossier pointer, verifies the dossier gate allow-state, and refuses ingest when freshness is not `fresh` or semantic review is still pending. If validation passes, Paperclip:
   - reuses or creates a venture company keyed to the launch target repo
   - creates one project per `run_id`
   - provisions the target repo as the primary workspace and `portfolio-os`, `paperclip`, and `gstack` as secondary workspaces
   - ensures the target clone exists locally
   - creates or checks out `run/<run_id>/bootstrap`
   - carries the Internet Pipes completeness contract from the dispatch gate or selection snapshot into the project, issue descriptions, agent metadata, and durable stage input
   - creates role-scoped issues from the dispatch execution manifest
   - starts or resumes the receipt-backed Profit Flywheel stages without adding fixed-clock duplicate routines
   - leaves approval creation to genuine human-owned blocker routes; v2 dispatch does not create a detached `launch_execution` request

Dispatch files are immutable. Paperclip records an ingest ledger in its data directory and skips any dispatch hash it has already processed.

## Internet Pipes Contract

Paperclip treats Portfolio OS as the source of truth for Internet Pipes evidence completeness. During dispatch ingest it reads the first available completeness block from:

The `selection_snapshot_hash` contract is SHA-256 over recursively key-sorted,
compact UTF-8 JSON (arrays retain order). Paperclip recomputes that canonical
form from the embedded snapshot and from advisory snapshot files; ordinary
JavaScript insertion-order serialization is not hash authority. This keeps the
ingest check byte-compatible with Portfolio OS `selection_snapshot_hash()`.

- `selection_snapshot.frozen_bundle` target records
- `selection_snapshot.launch_target`, `selection_snapshot.business_choice`, `selection_snapshot.execution_candidate`, `selection_snapshot.selected_opportunity`, or `selection_snapshot.research_target`
- `paperclip.dispatch_gate`
- `selection_snapshot.paperclip.dispatch_gate`

When present, Paperclip stores the normalized score, readiness label, missing stations, recommendation, and source path in the Portfolio dispatch contract. The same block is rendered into seeded issues and durable stage input so evidence gaps remain visible after the run enters Paperclip.

Runs whose Internet Pipes readiness is below `alpha_ready` or `factory_ready`, or that still name missing stations, must stay in evidence backfill instead of being treated as release-ready.

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

## Durable stage scheduling

`pos.dispatch.v2` does not seed fixed-clock per-run routines. The boot-time ingest worker creates or resumes the durable Profit Flywheel, whose content-addressed stage runs own implementation, QA, release, commercialization observation, learning, and the next bounded research window. Replaying the same dispatch hash is a no-op; retrying an interrupted stage reuses its run identity and input hash.

Paperclip remains the scheduler for the durable stage flow. gstack is invoked by agents when a stage requires it, but it does not carry a second recurring scheduler for the same work.

## Skill handling

Paperclip keeps injecting its required Codex skills, but it does not overwrite an existing live `~/.codex/skills/gstack` install. If `gstack` is missing, the cockpit links it from the local clone.

Use gstack here as an invoked workflow surface:

- `/office-hours`
- `/plan-eng-review`
- `/review`
- `/qa`
- `/ship`
- `/pos-run-qa`
- `/pos-evidence-backfill`

## Approval policy

- Inner loop: agents can operate with their configured local execution bypasses.
- Merge gate: the durable QA and release stage receipts are authoritative.
- Deploy gate: production deploy work remains approval-required.
- Human-owned credentials, budgets, and other explicit board blockers continue to create typed approvals.

## Rollback switch

To stop ingest and downstream execution without breaking the Portfolio OS truth loop, start Paperclip with:

```bash
PAPERCLIP_POS_DISPATCH_INGEST_ENABLED=false pnpm paperclipai run --data-dir /Users/mnm/.paperclip-local/portfolio-os-cockpit
```

Portfolio OS can continue generating research, council, scaffold, and dispatch artifacts while Paperclip stays passive.
