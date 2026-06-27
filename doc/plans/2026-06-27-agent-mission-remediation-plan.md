# Agent Mission Remediation Plan

Date: 2026-06-27

## Decision

Further traces and spot checks are required. The first deep dive fixed the
Hermes adapter failure class, but the post-fix trace still shows control-plane
and work-state problems that cannot be safely inferred from the 7-day aggregate
alone.

Evidence used:

- 7-day trace receipt: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T181944365Z-agent-mission-performance-trace.json`
- 24-hour trace receipt: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T181945390Z-agent-mission-performance-trace.json`
- post-fix trace receipt: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T181946370Z-agent-mission-performance-trace.json`
- reports:
  - `docs/reports/agent-mission-performance-deep-dive.md`
  - `docs/reports/agent-mission-performance-deep-dive-24h.md`
  - `docs/reports/agent-mission-performance-deep-dive-postfix.md`

## Current Read

The adapter-level failure class is materially improved in the post-fix window:

- Hermes CLI unsupported flag failures: 0
- process-loss agents: 0
- failed runs: 0
- raw tokens in sampled post-fix window: 686,278

The remaining failures are real but different:

- timer wake churn on unchanged assigned issues
- deterministic process-runbook success being recorded as default success
- stale or paused ownership of open work
- output drift on some Hermes timer runs

## Fixes Executed In This Pass

1. Trace repeatability
   - Use millisecond receipt timestamps so parallel traces do not collide.
   - Resolve custom output paths relative to the repo root, not the filtered package cwd.
   - Allow fractional-day lookbacks for post-fix traces.

2. Trace classification
   - Count missing `promptMetrics.skillBudget` only for `hermes_local` agents.
   - Do not classify deterministic process scripts as Hermes skill-routing failures.

3. Timer wake churn control
   - Treat latest same-agent final dispositions of `noop`, `blocked`, or handoff-style `maintenance`/`misaligned` as no-new-signal receipts for timer-pinned assigned work.
   - Skip the next timer wake before adapter invocation when the issue has not changed after that receipt.

4. Evidence backfill runbook
   - Emit explicit `finalDisposition: blocked; nextActionOwner: operator`.
   - Emit structured `paperclipNoNewSignal` so repeated timer wakes wait for external signal instead of re-running the deterministic backfill lane.

## Repair Queue

### POR LeadForge

Status: needs decision.

Problem:

- No post-fix runs in the sampled window.
- Multiple idle agents still own open work.
- Several issues are stale by 11-20 days.

Execution plan:

1. Run the post-fix trace again after the next scheduler cycle.
2. Create a manager repair issue for the CEO or Chief of Staff to triage idle-owned LeadForge work.
3. Split stale deployment/security work into one of:
   - still valid and assigned to an active agent
   - blocked with a named next owner
   - cancelled as obsolete
4. Do not auto-close or auto-reassign from the trace tool because V1 recovery is manual/explicit.

Stop condition:

- POR post-fix trace has no idle-owned stale work older than 7 days, or each stale item is explicitly blocked with a next owner.

### PORA Portfolio OS Orchestrator

Status: maintaining.

Problem:

- Evidence Custodian produced explicit dispositions but still had output-contract drift.

Execution plan:

1. Keep the final-disposition parser and prompt contract active.
2. Run a 24-hour trace after the next two Evidence Custodian timer cycles.
3. If verbose output continues, tighten the agent-specific output cap or convert the Evidence Custodian lane to a deterministic process receipt.

Stop condition:

- Evidence Custodian post-fix runs are `compact_success` or include a valid expansion reason.

### PORAA YT-Synth

Status: maintaining, with active churn.

Problem:

- Growth/Distribution ran the deterministic evidence backfill 24 times in the post-fix window.
- CMO ran 12 timer wakes against the same GTM issue.
- Chief of Staff ran 6 timer wakes against the same operating-contract issue.

Execution plan:

1. Deploy timer no-new-signal disposition detection.
2. Deploy structured no-new-signal output from `evidence-backfill-runner.mjs`.
3. Rerun a fractional post-fix trace after one scheduler interval.
4. If CMO/Chief still churn, inspect latest issue comments and context-ledger rows for missing `createdByRunId` or issue `updated_at` changes that reset the skip gate.
5. If the evidence backfill issue remains open because it is truly recurring, move it to an explicit routine contract or blocked state instead of keeping it as an always-open assigned issue.

Stop condition:

- No more than one timer run per unchanged timer-pinned issue within the no-new-signal TTL.
- Growth/Distribution process-runbook runs show explicit final disposition instead of `default_success`.

### PORAAA agency-swarm

Status: needs decision.

Problem:

- Paused agents still own open work.
- Chief of Staff and CEO have stale/idle-owned work.

Execution plan:

1. Create a manager repair issue to decide whether the company remains paused or should be reactivated.
2. For each paused-owned open issue, either:
   - unpause the owner with explicit board intent,
   - reassign via a manager issue,
   - or mark blocked/cancelled with a comment.
3. Do not auto-unpause from trace code; that is a governance decision.

Stop condition:

- No paused agent owns open work unless the issue is explicitly blocked and the pause is intentional.

## Trace Schedule

Run these in order after each repair batch:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts --lookback-days 1 --html-out docs/reports/agent-mission-performance-dashboard-24h.html --markdown-out docs/reports/agent-mission-performance-deep-dive-24h.md
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts --lookback-days 0.5 --html-out docs/reports/agent-mission-performance-dashboard-postfix.html --markdown-out docs/reports/agent-mission-performance-deep-dive-postfix.md
```

Use the 7-day trace for historical regression, the 24-hour trace for current
operational health, and the fractional trace for whether newly deployed fixes
are actually active.

## Escalation Rules

- Adapter/process failures: fix globally in code first, then apply safe status resets only when the trace proves the old blocker.
- Wake churn: fix timer admission/skip rules before spending more model runs.
- Stale work: create manager triage; do not silently close or reassign.
- Paused work: require governance decision before unpausing or transferring ownership.
- Weak success: require explicit final disposition and receipt/artifact evidence.

## Next Verification

After restart:

1. Confirm `/api/health` is healthy.
2. Confirm active `hermes_local` external adapter override is loaded.
3. Run the post-fix fractional trace again after the next scheduler interval.
4. Confirm:
   - `hermesCliFlagFailures=0`
   - `processLossAgents=0`
   - process-runbook default-success rows decline
   - repeated timer wakes on unchanged issues are skipped before adapter invocation

## Validation Notes

Completed before commit:

- `pnpm -r typecheck` passed.
- `pnpm build` passed.
- Targeted trace tests passed:
  - `pnpm --filter @paperclipai/server exec vitest run src/__tests__/agent-mission-performance-trace.test.ts`
  - `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-process-recovery.test.ts --testNamePattern "skips timer-pinned assigned work"`
- Full `pnpm test:run` exposed parallel-suite failures in unrelated process-runbook, DB backup, and heartbeat quota-backoff tests. Each failed file or test passed when rerun in isolation, so the current evidence points to suite concurrency/timeout pressure rather than this patch.
- Live `/api/health` was healthy after restart. No live `heartbeat.no_new_issue_signal` skips were present in the last 30 minutes immediately after restart; this requires the next matching scheduler wake to prove in production data.
