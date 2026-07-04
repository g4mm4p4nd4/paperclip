# Already-Owned Venture Gate

Portfolio OS may produce `ROUTE_TO_EXISTING_VENTURE` gate artifacts when a repo already has an active Paperclip company. Those gates are often useful as research receipts, but they must not automatically spend agent budget.

## Production Rule

Default existing-venture gates are suppressed at ingest time:

- no issue creation
- no issue update
- no child station fan-out
- no agent wakeup
- receipt status: `skipped`
- receipt reason: `already_owned_venture_suppressed`, `already_owned_venture_backlog_suppressed`, or `already_owned_venture_missing_action_provenance`

The ingest worker logs `portfolio existing venture gate suppressed` with the company, project, and reason so operators can prove that duplicate spend was intentionally avoided.

## Actionable Exceptions

Paperclip may route an existing-venture gate into live work only when the payload declares a concrete request such as:

- `request_type: feature_delta`
- `request_type: remediation`
- `route_type: feature_delta`
- `route_type: remediation`
- an operator or board approval plus a source request path, affected workflow, or explicit insufficient-reason field

`route_backlog_only: true` remains suppressed. Backlog captures should be cheap receipts until a human or council process promotes them into a concrete delta.

## Cutover Impact

This prevents already-owned repos from repeatedly consuming Hermes, MiniMax, Claude, or Gemini quota for duplicate validation issue fan-out. It also keeps the older parent and station issue reconciliation behavior available for approved feature deltas and remediations, preserving operational continuity when the existing company truly needs work.
