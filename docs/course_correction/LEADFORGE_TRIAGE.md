# LeadForge Triage

## Scope

This playbook applies to the LeadForge delivery lane and any Paperclip venture company created from Portfolio-OS dispatch ingest for `Glitch-Cipher-Syndicate/LeadForge`.

## Closure-First Rules

1. One active execution issue per routine family.
2. One execution lane: executor -> QA review -> release approval.
3. No new persona or support agents until the dispatch bridge and route-to-existing-venture path are proven on real artifacts.
4. A routine run is not useful unless it writes or updates one durable artifact:
   - dispatch parity note
   - QA report
   - evidence backfill receipt
   - release decision or merge reference

## Routine Family Policy

These families are allowed to stay active, but they must coalesce under overlap and skip catch-up backlog:

- `Dispatch Poller`
  - Trigger: schedule
  - Concurrency: `coalesce_if_active`
  - Catch-up: `skip_missed`
  - Closure artifact: dispatch parity note tied to `run_id`
- `Run QA Sweep`
  - Trigger: schedule
  - Concurrency: `coalesce_if_active`
  - Catch-up: `skip_missed`
  - Closure artifact: `qa_report.md` plus screenshots or blocker note
- `Evidence Backfill Reconciler`
  - Trigger: schedule
  - Concurrency: `coalesce_if_active`
  - Catch-up: `skip_missed`
  - Closure artifact: `evidence_<run_id>.json`
- `Release Gate Reconciler`
  - Trigger: schedule
  - Concurrency: `coalesce_if_active`
  - Catch-up: `skip_missed`
  - Closure artifact: approval state plus landed commit, PR, or explicit blocker

## Exact Runtime Enforcement

- Dispatch-created engineer issues receive a runtime `executionPolicy` with:
  - QA as review stage
  - Release Manager as approval stage
  - comment-required decisions
- Run-scoped routine siblings such as `[run_id:...] Dispatch Poller` now share a family lock and coalesce into the existing live execution issue instead of multiplying.

## Agent Posture

- Keep active: `Engineer-1`, `QA`, `Release Manager`, `CEO`, `CTO`, `CMO`, `Growth/Distribution`.
- Freeze expansion: `Engineer-2` and any new specialist/persona agents stay dormant unless the current issue set is empty or blocked on a genuinely parallel write surface.
- Do not create new routines to compensate for missing permissions or bad contracts.

## Success Condition

LeadForge is healthy when all are true:

1. A dispatch-created engineer issue cannot move to done without QA review and release approval.
2. Only one live issue exists per routine family.
3. Route-to-existing-venture work has a destination issue identifier, not just a handoff note.
4. Every open routine family can point to its latest closure artifact.
