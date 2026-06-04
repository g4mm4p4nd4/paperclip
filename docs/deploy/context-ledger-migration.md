# Context Ledger Migration And Rollback

Migration `0057_context_ledger.sql` adds first-class context accounting tables:

- `context_ledger_entries`
- `context_ledger_components`
- `agent_context_cursors`
- `prompt_budget_policies`

Migration `0059_output_budget.sql` extends `context_ledger_entries` with output
governance fields:

- `response_class`
- `output_budget_version`
- `estimated_output_tokens`
- `output_budget_status`
- `output_budget_limit_tokens`
- `final_response_chars`
- `final_response_sentence_count`
- `final_response_sha256`
- `final_response_artifact_refs`

## Apply

Run the normal database migration command for the deployment target. The migration
is additive and does not rewrite existing heartbeat, activity, issue, or agent
rows.

## Verify

1. Run a heartbeat with adapter metadata.
2. Confirm the run ledger route returns one entry.
3. Confirm raw prompt text is absent and `promptSha256` is present.
4. Confirm comment cursors only move forward.
5. Confirm a hard-stop budget policy prevents adapter spawn.
6. Confirm a completed run records `outputBudgetStatus`, `responseClass`, and
   `finalResponseSha256`.
7. Confirm a verbose summary without `Expansion reason:` is reported under
   `outputBudgetViolations` in flywheel health.

## Rollback

If rollback is required before downstream code depends on ledger data, drop the
four context-ledger tables in reverse dependency order:

```sql
DROP TABLE IF EXISTS context_ledger_components;
DROP TABLE IF EXISTS agent_context_cursors;
DROP TABLE IF EXISTS prompt_budget_policies;
DROP TABLE IF EXISTS context_ledger_entries;
```

Rollback removes prompt provenance readback and budget enforcement. Adapter
execution can continue, but operators lose the pre-spawn budget gate and ledger UI.

To roll back only the output-budget extension before dependent code is deployed,
drop the additive columns:

```sql
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS final_response_artifact_refs;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS final_response_sha256;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS final_response_sentence_count;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS final_response_chars;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS output_budget_limit_tokens;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS output_budget_status;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS estimated_output_tokens;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS output_budget_version;
ALTER TABLE context_ledger_entries DROP COLUMN IF EXISTS response_class;
```

This keeps prompt provenance intact but removes output-SLO readback and
flywheel-health output-violation reporting.
