# Token Spike Harness Pinhole Remediation

Date: 2026-07-05

## Executive Summary

The local Paperclip ledger shows a MiniMax raw-token spike, not a proportional
dollar-cost spike. In the last five-day database window, 10 MiniMax cost events
recorded 6,261,230 raw tokens: 589,771 input, 5,623,760 cached input, and
47,699 output. Cached input represented 89.82% of the observed token volume.

The spend was not anonymous idle chatter. It was issue-tied work, but the
harness allowed automatic assignment and timer wakes to continue spending tokens
against issues that were already blocked, done, skipped, coalesced, or waiting
on system-owned self-heal state. That is the pinhole: Paperclip treated
system-maintenance waits and repeated issue refreshes as agent-actionable work,
then passed enough context to Hermes/MiniMax to spend large cached-input token
volumes without a corresponding cake artifact.

## Observed Spike

Window: `now() - interval '5 days'` from database time
`2026-07-05T21:52:33Z`.

Provider/model:

| Provider | Model | Events | Raw tokens | Cached share |
| --- | --- | ---: | ---: | ---: |
| MiniMax | MiniMax-M3 | 10 | 6,261,230 | 89.82% |

Largest hours:

| Hour UTC | Raw tokens | Runs |
| --- | ---: | ---: |
| 2026-07-04 14:00 | 2,123,613 | 3 |
| 2026-07-04 20:00 | 1,299,002 | 2 |
| 2026-07-02 08:00 | 1,143,484 | 2 |
| 2026-07-05 13:00 | 970,979 | 1 |

Top invocation sources:

| Source | Runs | Raw tokens | Share |
| --- | ---: | ---: | ---: |
| assignment | 6 | 4,393,594 | 70.17% |
| timer | 4 | 1,867,636 | 29.83% |

Top agents:

| Agent | Raw tokens |
| --- | ---: |
| Evidence Custodian | 1,850,564 |
| VOC Researcher | 1,533,438 |
| Portfolio Cartographer | 970,979 |
| Community/OSS Distribution | 724,152 |
| Chief of Staff | 591,922 |
| Asset Composer | 590,175 |

Notable high-token issue/routine rows included `Council Chamber :: Existing
Venture Gate`, `Operating Contract Drift Monitor`, `Routine self-heal
exhausted`, and `Signal Desk :: Evidence Intake Gate`.

## Root Cause

1. Timer-pinned assigned work without a new external signal still used the base
   deliverable budget in Hermes-local and adapter-utils. Session resume was
   disabled, but the prompt/output/turn budget stayed too large.
2. System-owned routine self-heal exhaustion could become a `factory_guard`
   issue and wake the assignee, even though the correct action was to keep the
   routine active and wait for the natural cadence or upstream fingerprint
   change.
3. Old or leaked system self-heal guard issues could still be assignment-woken
   into heartbeat runs.
4. Finalized ledger receipts and artifact refs were not automatically promoted
   into `issue_work_products`, so already-produced cake remained invisible to
   later agents and health checks.
5. Receipt extraction treated a whole summary sentence ending in a receipt path
   as a direct receipt path, creating duplicate artifact identities downstream.

## Five Plans For The Bad Class

### Plan 1: Bound Automatic Timer-Assigned Work

Add a timer-assigned no-external-signal budget. Keep the run issue-scoped, but
cap context, output, and turns to a low-cost deliverable/status envelope unless
the issue contains a new comment, approval, or user prompt.

Status: implemented.

### Plan 2: Stop System Self-Heal From Becoming Agent Work

Keep `maintenance_lane_cadence` and `upstream_artifact_unchanged`
system-owned blockers in routine run state only. Do not create or wake a
factory-guard issue at the self-heal cap.

Status: implemented.

### Plan 3: Add Heartbeat Defense For Leaked Factory Guards

Skip automatic assignment wakes for existing `factory_guard` issues whose
execution state says the guard is system-owned self-heal. This protects against
legacy rows and future accidental issue creation.

Status: implemented.

### Plan 4: Promote Finalized Artifacts To Work Products

During context-ledger finalization, register issue-linked result receipts and
explicit artifact refs as deduped `issue_work_products`. Include compact work
products in heartbeat context so future agents see delivered outputs and avoid
redoing them.

Status: implemented.

### Plan 5: Reconcile Cost Events With Context Ledger

Unify `cost_events` and `context_ledger_entries` into one board-facing
tokenomics report. Cost events showed 6.26M raw MiniMax tokens, while the
context ledger previously showed much larger prompt/cache/output volume under
`verbose_unjustified`. The system needs one authoritative view that explains
provider quota impact, cached input, biller, invocation source, issue status,
and cake output.

Status: planned follow-on. The present patch creates the controls and product
visibility needed for the report to become meaningful.

## Five Plans For The Self-Heal Design Flaw

### Plan 1: Routine-State-Only System Waits

System waits are telemetry and scheduler state, not assignee work. Store the
self-heal decision and duplicate count in the routine run payload.

Status: implemented.

### Plan 2: Explicit Assignment Policy

Add an explicit `assignmentPolicy` or `wakePolicy` to actionability blocks so
ownership strings never implicitly decide whether a guard wakes an agent.

Status: not implemented in this patch because the root system-wait issue is now
routine-state-only and the heartbeat defense covers leaked rows.

### Plan 3: Board Decision Guard

For genuine governance blockers, create one unassigned board guard or approval
instead of agent work. Use this for credentials, provider quota exhaustion, and
operator decisions that cannot self-heal.

Status: existing pattern retained; not expanded here.

### Plan 4: Heartbeat Skip Gate

Before adapter invocation, skip system self-heal guard assignment wakes and
write a skipped wakeup receipt.

Status: implemented.

### Plan 5: Natural-Cadence Reschedule With Fingerprint Reset

Keep system-owned routines active after the cap, only reschedule up to three
times per fingerprint, and let a new upstream fingerprint reset the decision.

Status: pre-existing behavior retained and protected from waking agents.

## Simulated-Agent Findings

Three read-only agents validated the assumptions:

- Token-spike investigator: confirmed the MiniMax spike was assignment/timer
  driven, cached-input heavy, and concentrated on issue-tied work that was often
  already done, blocked, skipped, or coalesced.
- Bad-solution planner: identified five durable fixes around work-product
  registration, flywheel health, POS artifact classification, dirty deliverable
  preservation, and evidence/API truthfulness.
- Design-flaw planner: identified the routine actionability flaw where
  system-owned self-heal exhaustion became assignable `factory_guard` work, and
  recommended creation-time and heartbeat defense fixes.

## Shipped Changes

- Added timer-assigned no-external-signal budgets in both shared adapter-utils
  and Hermes-local:
  - context max chars: 12,000
  - output max chars: 1,400
  - output max sentences: 6
  - max turns per run: 6
- Kept timer-pinned work in `deliverable_work` mode while suppressing session
  resume and stale handoff context.
- Stopped system-owned self-heal exhaustion from creating/waking factory-guard
  issues.
- Added heartbeat skip defense for leaked system self-heal factory guards.
- Added idempotent work-product registration from finalized context-ledger
  receipt paths and explicit result artifact refs.
- Added compact work products to issue heartbeat context.
- Fixed receipt extraction so summary prose does not become a duplicate receipt
  path.

## Verification

Passed:

```bash
pnpm vitest run server/src/__tests__/routines-service.test.ts
pnpm vitest run server/src/__tests__/heartbeat-process-recovery.test.ts
pnpm vitest run server/src/__tests__/context-ledger-service.test.ts
pnpm vitest run packages/adapter-utils/src/server-utils.test.ts server/src/__tests__/hermes-local-compat-adapter.test.ts server/src/__tests__/work-products.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/server typecheck
pnpm vitest run server/src/__tests__/work-products.test.ts
```

One combined Vitest command failed before the disk cleanup because multiple
embedded-Postgres suites contended for test database startup and the host was
temporarily out of space. The same suites passed when rerun serially after disk
space was restored.

## Remaining Follow-On

1. Build the authoritative tokenomics report joining cost events, context
   ledger, wakeups, routine runs, issue status, and work products.
2. Extend flywheel health from binary `0/7` coverage to
   `ready/partial/active/missing/stale` with work-product and receipt evidence.
3. Add POS evidence dirty-state classification so expected generated evidence
   artifacts do not block intake while unrelated mutations still do.
4. Add dirty venture deliverable preservation to workspace close readiness.
5. Add evidence/VOC validators and API-access truthfulness checks to ledger
   metadata and mission traces.
