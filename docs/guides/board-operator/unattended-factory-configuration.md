---
title: Unattended Factory Configuration
summary: Apply the live cockpit routine/actionability migration after board approval
---

# Unattended Factory Configuration

Use this runbook after approving `docs/plans/unattended-factory-configuration-plan.md`.
The migration is live-state configuration: it mutates the cockpit database, writes
a pre-apply database backup, and emits an immutable JSON receipt.

## Command

Dry run:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/unattended-factory-configuration.ts --dry-run
```

Apply to the default Portfolio OS cockpit:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/unattended-factory-configuration.ts --apply
```

The script defaults to:

- Paperclip home: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit`
- Instance id: `default`
- Database: `postgres://paperclip:paperclip@127.0.0.1:<embeddedPostgresPort>/paperclip`
- Receipt dir: `instances/default/data/ops/unattended-factory-configuration/runs`

## Applied Contract

The migration attaches a `paperclip_actionability` object to each active routine's
`## Portfolio Dispatch Contract` JSON block. The contract includes lane, state,
blocker owner, required secrets, upstream artifact hash, cadence group, minimum
cadence, clean-workspace requirement, standing issue key, and ship-captain flag.

It also:

- Temporarily freezes enabled routine triggers during the migration.
- Restores execution triggers and lowers governance/maintenance triggers to a
  12-hour cadence.
- Pauses agency-swarm's active routine unless an execution mandate is approved.
- Normalizes Hermes/OpenCode agents to OpenCode Go normal routing with MiniMax as
  the only automatic degraded lane.
- Leaves post-MiniMax paid/subscription fallbacks disabled.
- Creates or reuses factory guard issues for missing credentials, dirty release
  workspaces, and degraded provider capacity.
- Cancels duplicate open routine-execution issues while preserving their rows and
  adding `executionState.unattendedFactoryCollapse` evidence.

## Verification

After applying, run:

```bash
/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/bin/ensure-paperclip-main.sh
```

Use the newest immutable receipt under
`instances/default/data/ops/paperclip-guard/runs/` if `latest.json` omits a
receipt path. Treat the migration as configured, not operational, until a fresh
flywheel canary has issue closure, a context-ledger row, receipt path, passing
test evidence, changed-file evidence, context-pack refs, and no provider hard
stop.

For the tokenomics objective, do not use a quiet watch window as proof of
factory improvement. `latest-tokenomics-watch.json` must show:

- `evaluation.tokenReductionStatus=pass` for the 50 percent token-reduction
  target.
- `evaluation.optimizationStatus=pass` for the 90 percent valuable-or-safe wake
  decision target.
- `evaluation.valuableOutputStatus=pass` before claiming the 90 percent
  valuable-output lift. If it is `warn`, the window was too idle to prove output
  improvement. If it is `fail`, work ran but did not produce enough final
  deliverables: completed issues or successful artifact-backed context-ledger
  entries tied to an issue. Logs, accepted patches, build runs, and PR activity
  are supporting evidence until they close or materially deliver issue-scoped
  work.
- `hermes-tokenomics-analysis.ts --days 5` should show the largest savings class
  as no-issue/no-final-deliverable timer/manual work, with request shaping
  enabled. The June 17, 2026 post all-planes receipt estimated 56.99 percent
  total raw token savings by shaping only that class to bounded status mode while
  preserving issue-tied assignment work.
- Bounded status mode must suppress stale provider session resume for
  Hermes-local, Claude-local, and Gemini-local. Explicit issue/comment/approval
  handoffs can resume matching sessions; no-handoff timer/manual runs cannot
  pass `--resume` or replay `paperclipSessionHandoffMarkdown`.
- Hermes-local fresh sessions must be run-owned (`--session-id
  paperclip_<runId>`) and the adapter must parse quiet-mode `session_id` from
  stderr before any state-db latest-session fallback. Repeated session ids across
  unrelated concurrent runs indicate attribution drift and invalidate tokenomics
  receipts until fixed.
- Hermes-local fresh sessions must include adaptive skill and tool-output budget
  metrics in the context ledger. The expected default is
  `skillBudget.mode=adaptive`, `skillBudget.maxSkills=6`, and
  `hermesToolOutputBudget.maxBytes=16000`. For issue-bound work, the selected
  skills should match the role and issue text; for no-handoff status checks, the
  selected set should be minimal. Set `paperclipSkillBudgetMode=all` only for
  deliberate broad specialist runs.
- Hermes-local runs must produce a meaningful final assistant response. Quiet
  Hermes output that only contains `session_id: ...` is protocol metadata, not a
  deliverable. The adapter may recover the final answer from Hermes `state.db`,
  but if neither process output nor state DB has a real assistant response, the
  run must fail with `missing_final_response` and must not post a success
  comment.
- Timer wakes with assigned open work must be issue-bound before adapter launch.
  A healthy post-cutover run has `context_snapshot.issueId`,
  `context_snapshot.taskId`, `context_snapshot.taskKey`, and
  `wakeReason=assigned_work_timer`. Generic no-issue timer runs with assigned
  work are a regression because they spend provider context without creating
  issue-scoped final-deliverable credit.
- Running work whose referenced issue becomes terminal must not stay active
  indefinitely. After the shutdown grace period, the heartbeat reaper finalizes
  done issues as succeeded and cancelled/hidden/non-executable issues as
  cancelled, then frees the execution slot.
- The run is not operationally successful just because a patch was accepted, a
  build passed, or a PR exists. Those are ingredients. The production proof is a
  closed issue or a successful issue-tied artifact delivery recorded in the
  context ledger and counted by `finalDeliverableUnits`.

## MiniMax Recovery Proof

Provider-capacity guards are historical safety rails, not proof that MiniMax is
currently exhausted. Before keeping or resolving an execution-capacity guard,
take a fresh MiniMax canary through the same recommended Token Plan path:

- Use the Token Plan Subscription Key (`sk-cp...`) for Token Plan quota. Do not
  substitute a pay-as-you-go key unless the board explicitly approves that spend
  mode.
- Use the Anthropic-compatible endpoint for the Hermes MiniMax lane:
  `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`.
- Use `MiniMax-M3` for the canary and require an exact deterministic response
  such as `MINIMAX_CANARY_OK`.
- If SDK clients fail with `nodename nor servname provided`, `ENOTFOUND`, or
  `Could not resolve host`, check host DNS before treating the provider as
  exhausted. On macOS, `dig api.minimax.io` can succeed while Python, Node, and
  curl fail if the primary network service lacks working DNS servers.

When a fresh MiniMax canary passes, close stale provider-capacity guards with a
receipt that includes the canary result, DNS state, the newest guard receipt,
and a 30-minute query proving no current `provider_degraded_backoff` rows remain.
The routine actionability gate also re-preflights the approved recovery lane
before honoring historical provider backoff, so recovered MiniMax capacity does
not keep unattended routines suppressed.

The preferred first check is now the Token Plan capacity poll recorded in
`latest-tokenomics-watch.json` under `providerCapacity.minimax`. If
`status=available`, Paperclip will clear stale `hermes_minimax` quota backoff on
the next wake/preflight. If `status=exhausted`, use `expiresAt` and the
`quota.currentIntervalEndsAt` or `quota.currentWeeklyEndsAt` fields to decide
when to probe again without spending a full agent run.
