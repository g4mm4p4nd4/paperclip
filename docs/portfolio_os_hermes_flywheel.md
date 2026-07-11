# Portfolio-OS Hermes Flywheel

Paperclip can now act as the coordination bridge between a Portfolio-OS
execution mandate and Hermes-Agent execution without requiring a live Paperclip
server. The bridge is intentionally file-first: it reads the Portfolio-OS
mandate, writes deterministic Paperclip context, creates the Hermes task bundle,
dispatches Hermes when requested, and records the execution result back into the
Portfolio-OS artifact tree.

## Commands

```sh
paperclipai portfolio-os ingest --mandate /Users/mnm/Documents/Github/portfolio-os/data/execution_mandate.json
paperclipai portfolio-os plan-hermes --run-id <run_id>
paperclipai portfolio-os execute --run-id <run_id>
paperclipai portfolio-os status --run-id <run_id>
```

Useful overrides:

- `--portfolio-root <path>` points at a non-default Portfolio-OS checkout.
- `--company-name <name>` changes deterministic Paperclip company context.
- `--hermes-bin <path>` points at a non-default Hermes adapter binary.

## Artifacts

`ingest` writes:

- `data/paperclip_context/<run_id>.json`
- `data/paperclip_context/latest.json`

`plan-hermes` writes:

- `data/hermes_task_bundles/<run_id>.json`
- `data/hermes_task_bundle.seed.json`

Both `ingest` and `plan-hermes` preserve Portfolio OS Internet Pipes
completeness when it is present on the execution mandate. The normalized
contract is written into Paperclip context, Hermes `opportunity`, Hermes
`evidence`, and the validation/trust/QA task instructions so file-first Hermes
execution does not drop station gaps that the live cockpit would see.
When Hermes local adapter prompts carry `promptMetrics.internetPipes`, Paperclip
context-ledger readback keeps that compact station gate and flywheel health
blocks canary readiness until readiness is `alpha_ready`/`factory_ready` and no
missing stations remain.

`execute` writes:

- `data/execution_results/<run_id>.paperclip.json`
- Hermes writes `data/hermes_results/<run_id>.json` when dispatch completes.

`status` reads all of those artifacts and reports the next required action.

## Safety Boundary

Paperclip does not mutate target repositories from this bridge. Target writes,
commits, pushes, and PR creation remain Hermes-Agent responsibilities and must
be governed by the task bundle `target.write_policy`, `target.push_policy`, and
`safety` sections.

The generated bundle always includes:

- `safety.destructive_ops_allowed: false`
- `safety.secrets_scan_required: true`
- forbidden operations for repo deletion, history rewrite, license removal, and
  secret commits

When a launch gate is blocked, the bridge preserves the validation-sprint
mandate instead of pretending the target is launch-ready.

## Context And Tool Economy

The flywheel is not a generic agent heartbeat loop. The intended cycle is:

1. Codex/Portfolio OS research produces selection, freshness, dispatch, and
   council artifacts in `/Users/mnm/Documents/Github/portfolio-os`.
2. Paperclip cockpit ingests those artifacts, creates governed issues/routines,
   and records context-ledger/flywheel receipts.
3. Hermes receives the assigned build task through the Paperclip adapter and
   writes implementation artifacts back to the target repo and Portfolio OS
   result paths.

Token controls must preserve that cycle. Agents should use the smallest useful
context surface first:

- Portfolio OS authority files and dispatch receipts before broad repo scans.
- Paperclip issue heartbeat context and context-ledger receipts before replaying
  full comment threads.
- Context packs in map, then delta, then core order.
- Graphify reports/queries when `graphify-out` exists.
- ScrapeGraphAI JSON receipts for structured web or local-corpus extraction.
- `gstack` for QA/dogfooding screenshots and responsive/user-flow evidence.
- gbrain semantic lookup when configured and indexed.

Empty timer wakes with no assigned open work are control-plane waste and should
be skipped before Hermes starts. Assignment, automation, comment, approval, and
on-demand wakes remain the valuable path and must keep enough context budget to
produce tests, docs, receipts, and shippable changes.

Timer wakes pinned to already-blocked issues are also skipped before Hermes when
the latest issue signal is the same assigned agent's blocker receipt and no newer
external comment or issue update exists. These low-cost skips are recorded as
`heartbeat.blocked_issue_no_new_signal` with a blocker fingerprint, so repeated
credential/workspace/human-owned blockers preserve tokens without hiding the
exact condition needed to resume execution.

When the acceptance path is already deterministic, use the Paperclip `process`
adapter before Hermes. Current examples are Dispatch Poller, Release Gate
Reconciler, Evidence Backfill Reconciler, and Skill Inventory. For Skill
Inventory, Paperclip can repair missing Portfolio OS skill `keywords:`, rerun
`scripts/skill_curator.py`, and patch the issue without a model call; Hermes
should be reserved for cases where the skill instructions themselves need
judgment, redesign, or safety review. Live run
`48299aab-5161-4051-b18c-dda3f50ed83e` closed `PORA-1801` this way, moving the
Portfolio OS curator from `pass=10/fail=43` to `pass=53/fail=0` with zero
provider tokens.

The external tokenomics watch keeps that balance honest in production:

```sh
pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-watch.ts --watch --interval-seconds 300 --apply-balance-on-drift
```

Its receipt target is 50 percent or better token reduction against baseline and
90 percent or better valuable/safely-skipped wake decisions, with failures for
high-burn provider events, no-issue timer launches, or Hermes budget drift.

## Completion and run-state invariants

A successful process exit is transport evidence, not completion evidence.
Hermes, the external adapter, the built-in adapter, and the heartbeat summary
backstop must reject complete, malformed, or truncated XML/DSML and JSON
tool-call envelopes when they are the entire proposed final response. The
adapter records `missing_final_response` when neither Hermes state nor process
output contains real user-facing prose. Text that merely discusses tool-call
markup remains a valid final response.

Local Hermes execution resolves through `/Users/mnm/.local/bin/hermes`. That
stable indirection may move only after its new target passes the focused and
full regression contracts and a rollback target is recorded; agent and service
configuration should not pin transient checkout paths.

Agent status is a projection of durable heartbeat runs. A non-paused,
non-terminated agent may remain `running` only while it has a queued or running
heartbeat run. Orphan maintenance reconciles stale `running` projections to
`error` after a failed or timed-out latest run, and to `idle` after a successful,
cancelled, provider-reliability, or absent latest run. The reconciliation update
uses an atomic no-active-run predicate so a concurrently queued run cannot be
overwritten by maintenance.
