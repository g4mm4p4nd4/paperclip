---
title: Retire superseded fixture Profit Flywheel canaries
summary: Safely terminalize abandoned fixture/profit-canary workflow rows after a newer immutable closeout
---

# Retire superseded fixture Profit Flywheel canaries

This is a narrow repair operator for a specific control-plane failure: an old
`fixture/profit-canary` workflow remains `blocked`, `degraded`, `pending`, or
`retry` after a newer canary has completed a work-bearing cycle and written an
immutable closeout. Those old non-terminal rows remain visible to Factory
health forever unless they are explicitly and safely terminalized.

The operator is not a general workflow cancellation tool. It never selects a
“latest” receipt, does not unpause the Factory, does not start or resume work,
and does not change production, shadow, or non-fixture repositories.

## Preconditions

Before planning, all of the following must be true:

1. The selected embedded Paperclip instance has `factory.pauseNewWork: true`.
   The command reads the selected instance's config live, binds its exact bytes
   to a generation hash, and rechecks that same paused authority after intent
   creation and under the mutation locks. Do not treat a paused UI while a
   different instance is selected as sufficient.
2. You have an exact mode-`0444` successful closeout receipt for the newer
   fixture canary. Provide its absolute path and byte SHA-256. The receipt must
   be `paperclip.profit_flywheel_canary_closeout.v1`, have outcome
   `work_bearing_cycle_closed_next_research_pending`, and bind the replacement
   workflow currently in `running` / `research_intake`. Retirement reruns the
   canonical read-only closeout verifier against that exact existing
   `<run-id>-canary-closeout.json`; a hand-authored header, unrelated issue, or
   missing stage/receipt/proof lineage cannot authorize retirement.
3. You have chosen one canonical UTC cutoff. Only fixture workflows created
   strictly before that timestamp are candidates. The replacement closeout must
   have been generated strictly after it.
4. The receipt directory already exists, is owned by the current user, and is
   not group/world writable. The operator verifies every ancestor and writes
   create-exclusive immutable receipts there.

The command accepts no database URL, connection string, credential, API key,
or token on argv. It derives the embedded connection internally from the
selected Paperclip instance.

## Plan first

Set explicit non-secret inputs. Do not use a glob, `latest` symlink, or an
unhashed path for the replacement closeout.

```bash
export PAPERCLIP_HOME=/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit
export PAPERCLIP_INSTANCE_ID=default

COMPANY_ID='<company-uuid>'
CUTOFF_AT='2026-07-24T00:00:00.000Z'
REPLACEMENT_CLOSEOUT='/absolute/trusted/path/replacement-canary-closeout.json'
REPLACEMENT_CLOSEOUT_SHA256='<64-lowercase-hex-byte-sha256>'
RECEIPT_DIR="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/data/ops/flywheel-repair/runs"

pnpm ops:profit-flywheel-stale-canary-retirement -- plan \
  --company-id "$COMPANY_ID" \
  --cutoff-at "$CUTOFF_AT" \
  --replacement-closeout "$REPLACEMENT_CLOSEOUT" \
  --replacement-closeout-sha256 "$REPLACEMENT_CLOSEOUT_SHA256" \
  --receipt-dir "$RECEIPT_DIR"
```

The plan command writes an immutable plan receipt and prints its exact path and
SHA-256. Read it before applying. It contains the full candidate set, every
non-terminal stage proposed for cancellation, terminal stages that will remain
untouched, pending outbox events that will be drained, deterministic linked
issues that may be cancelled, and unverified linked issues that will remain
unchanged.

`ready: false` is a hard stop, not a partial plan. In particular, the operator
stops when it finds any older matching workflow/stage that is `running`, has a
lease/heartbeat/dispatch claim, has an active linked issue, or cannot make the
frozen-contract transition to `cancelled`.

## Apply the pinned plan

Copy the plan values exactly. Apply refuses a path or SHA different from the
computed immutable plan name, so a new dry run cannot silently replace the
reviewed plan.

```bash
PLAN_PATH='<printed-plan-path>'
PLAN_SHA256='<printed-plan-sha256>'

pnpm ops:profit-flywheel-stale-canary-retirement -- apply \
  --company-id "$COMPANY_ID" \
  --cutoff-at "$CUTOFF_AT" \
  --replacement-closeout "$REPLACEMENT_CLOSEOUT" \
  --replacement-closeout-sha256 "$REPLACEMENT_CLOSEOUT_SHA256" \
  --receipt-dir "$RECEIPT_DIR" \
  --plan-path "$PLAN_PATH" \
  --plan-sha256 "$PLAN_SHA256"
```

Apply takes a mandatory backup of the selected embedded database before any
row mutation. It seals the backup mode to `0400`, hashes its exact bytes
through the same verified file descriptor used to chmod and fsync it, rebinds
the pathname to that inode afterward, and
records path, SHA-256, size, mode, compression, and pruning count in the
intent/result receipts. If that evidence is missing, mutable, or byte-drifted
on replay, the operator fails closed.

It then writes a mode-`0444` intent receipt before opening its serializable
transaction. Under table and row locks it validates the complete versioned plan
schema, recomputes its target snapshot, requires the current locked candidate
set to be exactly equal to the plan, and mutates that locked set rather than a
stale caller copy. It also rechecks the replacement workflow, active leases,
stage contract transitions, issue activity, and event state. Each
workflow/stage/issue/event change has a compare-and-set predicate.
The operation cancels only the planned non-terminal stages and workflows;
already terminal stages and all database receipts stay intact.

For every retired workflow it:

- changes eligible `pending`, `retry`, `blocked`, or `degraded` stages to
  terminal `cancelled` only when that transition is present in the persisted
  frozen contract;
- drains the exact planned unprocessed events by marking them processed while
  retaining their rows and appends processed retirement audit events;
- cancels a linked issue only when its company/project/origin/run/description
  exactly match Paperclip's deterministic dispatch-issue identity; and
- leaves a non-deterministic linked issue untouched and lists it as retained in
  the result receipt, preserving an already terminal issue's exact terminal
  state and timestamps rather than pretending it was an open issue.

Audit dedupe keys are not trusted merely because they exist. A conflicting key
must match the exact event type, transition, correlation/trace/span, payload,
timestamps, and processed state or the whole transaction rolls back.

The final immutable result receipt uses
`paperclip.profit_flywheel_stale_canary_retirement_result.v1`. Its schema is
frozen at
[`contracts/profit-flywheel/stale-canary-retirement.v1.schema.json`](../../../contracts/profit-flywheel/stale-canary-retirement.v1.schema.json).

## Replay and recovery

Re-run the identical apply command after a process interruption. If intent
exists but the final receipt does not, Paperclip proves the terminal database
postcondition and installs the same result receipt without another backup or a
second mutation. If a result already exists, replay still verifies the sealed
backup and every cancelled workflow/stage, drained event, required audit event,
and deterministic issue state. A receipt alone is never treated as proof that
the database still matches it.

## Rollback is intentionally non-compensable

There is no row-level `rollback` command. `cancelled` is terminal in the frozen
Profit Flywheel contract, and changing an explicitly superseded workflow back
to a non-terminal state could reanimate stale work. The result receipt records
this as `non_compensable` and points to the mandatory pre-retirement backup.

If recovery is genuinely required, stop and make an explicit instance-wide
recovery decision, then restore that exact sealed embedded PostgreSQL backup.
Do not edit cancelled rows directly, do not delete audit history, and do not
unpause the factory as a substitute for recovery.

## Focused verification

```bash
PAPERCLIP_PROFIT_FLYWHEEL_CONTRACT_PATH=/absolute/path/to/portfolio-os/contracts/profit-flywheel.v2.json \
  pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/profit-flywheel-stale-canary-retirement.test.ts
pnpm --filter @paperclipai/server typecheck
git diff --check
```
