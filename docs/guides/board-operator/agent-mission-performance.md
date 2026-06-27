# Agent Mission Performance Deep Dive

Use this when agents look broken, busy-but-low-value, or misaligned with the
company mission. The trace samples at least six agents per active company, then
scores each sample against live Paperclip evidence:

- company mission inputs: description, goals, projects, issue status mix
- agent state: role, adapter, status, skill count, last heartbeat
- execution: recent heartbeat runs, adapter failures, process loss, token usage
- delivery: completed assigned issues, stale in-progress work, comments
- output quality: finalDisposition source, response class, receipt/artifact hints
- context economy: `promptMetrics.skillBudget` coverage

The trace intentionally treats `default_success` `advanced_vision` as weak
progress. It means the run exited successfully but the agent did not explicitly
classify the outcome. That should not be counted the same as a receipt-backed
deliverable.

## Trace Only

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts
```

Outputs:

- JSON receipt under `.paperclip/.../data/ops/agent-mission-performance/runs/`
- Markdown report at `docs/reports/agent-mission-performance-deep-dive.md`
- HTML dashboard at `docs/reports/agent-mission-performance-dashboard.html`

For post-fix checks, use a fractional-day lookback and separate output files:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts --lookback-days 0.5 --html-out docs/reports/agent-mission-performance-dashboard-postfix.html --markdown-out docs/reports/agent-mission-performance-deep-dive-postfix.md
```

Current remediation plan:

- `doc/plans/2026-06-27-agent-mission-remediation-plan.md`

## Apply Safe Fixes

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-mission-performance-trace.ts --apply
```

Apply mode is intentionally narrow. It only resets agents stuck in `error` when
the trace proves the recent failure was the Hermes CLI unsupported-flag bug. It
does not unpause companies, close stale issues, or reassign business work.

## Interpreting Status

- `blocked`: systemic critical adapter/process/churn failure in the sampled set
- `misaligned`: systemic weak-success or wake-churn pattern
- `maintaining`: warnings but no systemic critical failure
- `needs_decision`: no meaningful recent execution signal
- `advancing`: sampled agents show no critical or warning pattern

The dashboard is a diagnosis tool, not a replacement for receipts. A company is
not production-healthy until the blocker-specific receipts and issue outcomes
show completed work.
