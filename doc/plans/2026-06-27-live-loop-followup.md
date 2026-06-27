# Live Loop Follow-Up Trace

Date: 2026-06-27

Baseline commit: `f5066752b73c19bda1f3427f2a27837bea01ae6a`

Follow-up trace receipt:

- `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T234356912Z-agent-mission-performance-trace.json`

Reports:

- `docs/reports/agent-mission-performance-deep-dive-live-followup.md`
- `docs/reports/agent-mission-performance-dashboard-live-followup.html`

## Working Definition Of Improvement

For this pass, improvement means:

- fewer timer wakes that invoke model/adapters without new issue signal
- lower raw token burn, including subscription and unknown-billing usage
- more explicit final dispositions and next owners
- fewer stale assigned issues left to blind timer retries
- trace reports that expose the real operating cost and failure surface

## Live Findings

1. The no-new-signal skip fix is working.

   Since `f5066752b`, PORAA CMO, Chief of Staff, and Growth/Distribution timer wakes were skipped before adapter invocation when their latest same-agent receipt explicitly said there was no new signal.

2. Trace token accounting was undercounting subscription/unknown-billing Hermes usage.

   `cost_events` was empty for the post-fix Hermes runs where billing type was `unknown` and usage confidence was pending. The usage was present in `context_ledger_entries`, so the mission-performance report previously missed this class of token burn.

3. A timer refresh still resumed a very large Hermes session.

   PORA Evidence Custodian ran after the six-hour no-new-signal TTL expired and resumed `paperclip_43e8d158-6aa1-40a2-8da7-f2415723461d`.

   Observed usage:

   - estimated prompt: 4,285 tokens
   - actual input: 53,818 tokens
   - cached input: 740,736 tokens
   - output: 8,283 tokens
   - final disposition: `noop`

   The agent did the right thing at the work layer, but the harness allowed prior-session context to dominate a timer-only refresh.

4. The 6-hour live follow-up trace now exposes 3,696,330 raw sampled tokens.

   The largest sampled source was PORAA Chief of Staff at 2,893,493 raw tokens in the same window. After adding high-token/no-closure sampling, PORA Evidence Custodian is also guaranteed into the sample at 802,837 raw tokens.

5. Startup logs expose operational drift outside the agent loop.

   - portfolio dispatch hash drift is still ignored for `20260420T210900Z`, `20260503T193357Z`, and `20260504T004042Z`
   - Hermes doctor reports `~/.hermes/config.yaml` at config v10 while Hermes expects v29
   - Hermes doctor reports Gemini OAuth and MiniMax OAuth as not logged in even though provider routing expects those subscription lanes
   - context-pack manifest in live Evidence Custodian context was generated on 2026-06-19 and marked stale

6. Post-restart live polling showed expected pre-adapter suppression, not lost events.

   Since the persistent restart at `2026-06-27T23:37:43Z`, Paperclip recorded six timer wakeups, zero spawned heartbeat runs, zero heartbeat events, and zero ledger entries. Five wakeups were `heartbeat.idle_no_assignment` skips, and one was a `heartbeat.no_new_issue_signal` skip for `PORAA-3187`.

## Fixes Applied

1. Suppressed session resume for timer-pinned assigned work without a fresh external signal.

   This was applied in:

   - live external adapter: `/Users/mnm/Documents/Github/hermes-paperclip-adapter/index.js`
   - shared Paperclip adapter utils: `packages/adapter-utils/src/server-utils.ts`
   - built-in Hermes adapter path: `server/src/adapters/hermes-local/execute.ts`

   Behavior:

   - assigned issue still runs when the no-new-signal TTL expires
   - prior Hermes session is not resumed unless there is a comment, approval, human prompt, or inbound wake payload
   - the run starts with a fresh session ID and current compact Paperclip context

2. Tightened final-disposition text parsing for no-new-signal receipts.

   The parser now reads `nextActionOwner` from the raw line before whitespace normalization and caps the value. This prevents concatenated run output from becoming a giant telemetry signal.

3. Updated mission-performance token accounting.

   Agent raw tokens now use:

   - `cost_events` tokens when available
   - context-ledger actual/cached/output tokens when cost events are absent
   - `greatest(cost_event_tokens, context_ledger_tokens)` to avoid undercounting without double-counting normal metered paths

4. Added high-token/no-closure as a first-class trace problem.

   Agents with at least 250,000 raw lookback tokens and zero completed assigned issues now:

   - receive `high_tokens_without_closure`
   - are guaranteed into the deep-dive sample
   - appear in the summary and findings

   This fixed the blind spot where expensive no-op/no-closure runs could be visible in aggregate but absent from the trace detail.

5. Restarted live Paperclip under a persistent detached screen session.

   Session:

   - `paperclip-dev-agent-followup`

   Health:

   - `http://127.0.0.1:3100/api/health` returned healthy after restart
   - external `hermes_local` adapter override was reloaded from `/Users/mnm/Documents/Github/hermes-paperclip-adapter`

## Remaining Problems To Fix Next

1. High raw token runs still need an execution-time guardrail.

   The trace now exposes and samples them, but it does not yet prevent a single timer refresh from spending millions of raw tokens if a provider reports huge cached context. Add an admission rule or adapter result gate for timer-only runs whose estimated prompt is small but prior-session usage would exceed a threshold.

2. Expected skips are stored with human-readable text in `agent_wakeup_requests.error`.

   The status is `skipped`, but dashboards or ad hoc queries can misread these as errors. A cleaner shape would move expected skip explanations into payload and reserve `error` for actual failure.

3. Dispatch hash drift is still being ignored.

   Startup reports three dispatch hash drift warnings. The loop should either reconcile those immutable receipts or promote them to explicit operator issues instead of repeating startup warnings.

4. Subscription provider auth is not aligned with routing expectations.

   Hermes doctor says MiniMax and Gemini OAuth are not logged in. If these lanes are intended to absorb subscription work, provider capacity checks should fail loudly or route around them before a run is spawned.

5. Context packs are stale.

   Live context showed context packs generated on 2026-06-19. The loop should refresh packs automatically on startup if stale or before large timer-run dispatch.

## Educated Questions

1. Should timer-only assigned work with a prior explicit `blocked` or `noop` disposition skip indefinitely until a comment/status/assignment changes, rather than waking every six hours?
2. Should the flywheel enforce a hard raw-token ceiling per timer run, with manual escalation when estimated prompt tokens are small but resumed/cached session tokens would be large?
3. Should dispatch hash drift be treated as a production blocker issue, or is hash drift expected during current portfolio-os operation?
4. Should MiniMax/Gemini OAuth absence be considered a failed provider lane even when API connectivity checks pass for other providers?
