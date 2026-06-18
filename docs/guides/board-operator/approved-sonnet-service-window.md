# Approved Sonnet Service Window

Use this runbook when MiniMax remains the first automatic lane, but an operator has explicitly approved local subscription fallbacks for a bounded Paperclip service window.

## Command

Run from the Paperclip repo:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/approved-sonnet-service-window.ts \
  --apply \
  --duration-minutes 60 \
  --tick-seconds 60 \
  --drain-timeout-minutes 20 \
  --drain-poll-seconds 5 \
  --recover-lookback-minutes 30 \
  --model role_default \
  --command /opt/homebrew/bin/claude \
  --gemini-command /opt/homebrew/bin/gemini
```

The helper writes a receipt under:

```text
/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/sonnet-service-window/runs/
```

## Routing Contract

- Scope is limited to invokable `hermes_local` agents with heartbeat enabled and due inside the service window.
- MiniMax remains first in `tieredExecution.adapterOrder`.
- `gemini_local` and `claude_local` are added only as explicitly approved post-MiniMax fallbacks.
- Gemini uses local CLI login/OAuth subscription auth and role-selected Pro/Flash models.
- Claude uses local Claude Code subscription auth and role-selected Sonnet/Haiku models; Opus is not selected automatically under the current Pro limitation.
- The helper loads the instance `.env` before starting so local agent JWT injection works.
- At the dispatch deadline, the helper stops enqueueing work, drains runs created during the window, and only then restores temporary adapter overlays.
- If active window runs exceed `--drain-timeout-minutes`, the helper cancels those runs, records the cancellation in `receipt.drain`, restores overlays, and exits failed instead of claiming a clean completion.
- Temporary adapter overlays are restored at normal completion, errors, or handled interrupts after the drain/cancel path has run.

## Stop Conditions

Stop the service window instead of continuing to enqueue runs when any approved lane returns hard quota exhaustion:

- MiniMax `provider_quota_failure`
- Claude Code `session limit`
- Gemini CLI quota/session-limit output
- repeated provider preflight quota failures on restored default routing

After stopping, verify:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/approved-sonnet-service-window.ts \
  --restore-receipt <receipt-path> \
  --mark-failed-reason "Interrupted after provider quota/session limit; temporary overlays restored."
```

Then confirm:

- no `queued` or `running` heartbeat runs remain unexpectedly;
- no temporary `claude_local` overlay remains on `hermes_local` agents;
- the receipt has `restoreSucceeded == overlaysChanged` and `restoreFailed == 0`.
- the receipt has `drain.status` of `completed` for a clean run, or `cancelled`/`timed_out` with explicit run ids when the helper had to stop active children.

## Caveats

Claude Code preflight can pass and the real run can still fail later with a subscription session limit. Treat that as provider capacity exhaustion and stop the window; do not keep ticking.

Wrapper-level interrupts can bypass a child process signal handler. The helper now runs a short drain/cancel path on `SIGINT`/`SIGTERM`, but if a receipt remains `running`, use `--restore-receipt` as the authoritative recovery path instead of manually editing agent configs.

Do not run short service windows without a drain budget. Local Gemini and Claude subscription calls can still be active at the dispatch deadline; restoring overlays and closing the DB while those children are live causes lost log writes and can strand the run as `running`.
