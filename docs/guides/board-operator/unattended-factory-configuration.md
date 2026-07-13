---
title: Unattended Factory Configuration
summary: Apply or roll back the Profit Flywheel v2 fleet cutover with immutable receipts
---

# Unattended Factory Configuration

## Profit Flywheel v2 cutover

This is the authoritative unattended-factory cutover. It replaces generic
provider-backed heartbeats with the durable Profit Flywheel v2 event machine,
binds every live agent to the single provider policy, and installs the Portfolio
OS research, deterministic stage, and return-plane authorities. The older actionability migration is
preserved later in this page for historical fleet maintenance; it does not by
itself establish v2.

### Preconditions

Before apply:

1. Preserve the dirty checkout and record the current branch/HEAD. Do not clean
   or reset unrelated operator work.
2. Confirm no agent is `running`, no heartbeat run is `queued` or `running`, no
   flywheel stage is `running` or `retry`, and no flywheel lease exists. The
   migration checks again under a database lock and aborts on a race.
3. Apply database migrations `0064_profit_flywheel_v2.sql` and
   `0065_heartbeat_execution_evidence_nonce.sql` with the normal DB migrator.
   Migration 0065 keeps the execution-intent nonce database-only and pins the
   unique Portfolio OS executor identity per workflow/company.
4. Validate the pinned Portfolio OS contract, research schemas, source-registry
   authority, `config/paperclip_routines.json`, provider policy, and the pinned
   read-only live-fleet audit receipt.
5. Provision encrypted company-secret references for the `Portfolio OS
   Orchestrator`. All four must exist, be active latest versions, belong to the
   same company, have different values, and remain out of git, agent JSON, logs,
   receipts, and command arguments:
   - `PAPERCLIP_API_KEY`
   - `PAPERCLIP_RETURN_PLANE_JOURNAL_KEY`
   - `PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY`
   - `PAPERCLIP_STAGE_PLANE_JOURNAL_KEY`
6. Replace any revoked or quarantined provider credential through the encrypted
   company-secret service. The migration never copies a plaintext credential
   into its plan or rollback snapshot.

Run the workspace-link preflight and focused tests before the fleet mutation.
Take a database backup before applying the schema migration:

```bash
cd /Users/mnm/Documents/Github/paperclip
pnpm --filter @paperclipai/server run preflight:workspace-links
pnpm exec vitest run \
  packages/shared/src/profit-flywheel.test.ts \
  server/src/__tests__/profit-flywheel-v2-migration.test.ts \
  server/src/__tests__/profit-flywheel-outbox.test.ts \
  server/src/__tests__/profit-flywheel-context-sync.test.ts \
  server/src/__tests__/provider-policy.test.ts \
  server/src/__tests__/provider-canaries.test.ts
pnpm --filter @paperclipai/server typecheck
pnpm db:backup
pnpm db:migrate
```

For an embedded local instance, select the instance with `--home` and
`--instance-id`; the CLI lazily loads that instance config and derives the local
connection in-process. An external PostgreSQL deployment may still inject
`DATABASE_URL` through the operator environment. Never put a connection string
on argv or in a receipt.

### Generate and pin the fleet audit

Generate the fleet audit only after runtime provisioning has converged. The
operation is database-read-only: it selects every plan-semantic agent field and
the routine/trigger fields used for schedule classification and compare-and-set
validation. It does not query a company-secret table or invoke a secret
provider. Config objects are hashed in memory and are never serialized into the
receipt.

```bash
pnpm ops:profit-flywheel-v2 -- \
  --home /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit \
  --instance-id default \
  --generate-fleet-audit
```

The command writes a create-exclusive, file-and-directory-fsynced mode-`0444`
receipt under
`instances/default/data/ops/flywheel-repair/runs/`. Its JSON output includes
`receiptPath`, `receiptSha256`, and a `pin.argv` array containing the exact
`--audit-path` / `--audit-sha256` pair. Preserve those two non-secret values:

```bash
export PROFIT_FLYWHEEL_AUDIT_PATH='<receiptPath>'
export PROFIT_FLYWHEEL_AUDIT_SHA256='<receiptSha256>'
```

The v4 audit and migration validator share one implementation for
live/terminated/status counts, adapter membership, the sorted
`id`/`companyId`/`name`/`role`/`status`/`adapterType`/config projection, and the
complete routine-trigger classification projection. The validator recognizes
already-pinned v2/v3 receipts only for non-mutating compatibility reads; apply
requires an explicit v4 path/SHA pair. Any agent semantic change, routine title
or kind change, trigger-to-routine relink, or configuration/status change after
the audit makes apply fail closed. Re-run the generator and review the new
immutable receipt instead of editing an existing receipt. `--apply` is
explicitly forbidden with `--generate-fleet-audit`, as are company/agent
filters.

### Dry run

```bash
pnpm ops:profit-flywheel-v2 -- \
  --home /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit \
  --instance-id default \
  --dry-run \
  --audit-path "$PROFIT_FLYWHEEL_AUDIT_PATH" \
  --audit-sha256 "$PROFIT_FLYWHEEL_AUDIT_SHA256"
```

The dry run writes an immutable receipt under
`instances/default/data/ops/flywheel-repair/runs/`. Inspect, at minimum:

- the pinned fleet-audit, provider-policy, policy-schema, and runtime-plane hashes;
- canonical before/after fleet hashes;
- every non-terminated agent's capability alias and budget class;
- `secretsToCreate` is empty before apply;
- legacy fallback/budget fields are removed and hidden fallback is disabled;
- retired `autonomyRecovery.previousHeartbeat` state is removed without
  retaining an empty `autonomyRecovery` object, so migration and tokenomics
  balancing converge on the same canonical live JSON;
- heartbeat becomes `enabled=false`, `intervalSec=0`,
  `maxConcurrentRuns=1`, `triggerMode=event_only`;
- only Market Sweep and VOC Sweep retain `30 8,17 * * *`; every downstream
  fixed-clock trigger is disabled;
- there are no plaintext credential findings, retired 300-second polling
  fields, or concurrency values above one.

Dry run is evidence of the proposed mutation, not evidence that the live fleet
changed.

### Apply

Apply creates a compressed pre-migration database backup by default, writes an
immutable apply-intent receipt before mutation, stores a secure rollback
snapshot in `profit_flywheel_migration_runs`, then updates agents, routine
triggers, compromised-secret revocations, and migration state in one locked
transaction with a full under-lock audit revalidation and deterministic plan
recomputation before any mutation.

```bash
pnpm ops:profit-flywheel-v2 -- \
  --home /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit \
  --instance-id default \
  --apply \
  --audit-path "$PROFIT_FLYWHEEL_AUDIT_PATH" \
  --audit-sha256 "$PROFIT_FLYWHEEL_AUDIT_SHA256"
```

Do not use `--no-backup` for a live cutover. Record the returned
`migrationRunId`, `planSha256`, intent receipt path/SHA, backup receipt,
provider-policy hashes, and canonical fleet hash transition. Re-running the
same apply is idempotent: it reconciles the committed migration only when the
live fleet, schedules, policy pins, and security revocations still match.

### Rollback

Rollback is exposed as
`rollbackProfitFlywheelV2Migration(db, { migrationRunId })` in
`server/src/ops/profit-flywheel-v2-migration.ts`; there is intentionally no
ambiguous `--rollback latest` flag. Invoke it only with the exact apply
`migrationRunId` through the loaded server operator environment.

```ts
import { createDb } from "@paperclipai/db";
import { rollbackProfitFlywheelV2Migration } from "./src/ops/profit-flywheel-v2-migration.js";

const db = createDb(process.env.DATABASE_URL!);
try {
  console.log(await rollbackProfitFlywheelV2Migration(db, {
    migrationRunId: process.env.MIGRATION_RUN_ID!,
  }));
} finally {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}
```

The operator wrapper must load that code from the same built Paperclip revision
used for apply. Rollback refuses active execution and uses the stored
post-migration hashes as compare-and-set preconditions. It restores agent and
routine configuration and writes an immutable rollback-intent receipt.
Compromised secret versions are non-compensable: they remain revoked and emit
`profit_flywheel_compromised_credential_replacement_required` with owner
`paperclip_board_operator`. Restore the database backup only if the
database-level rollback cannot run.

### Post-cutover proof

After apply, restart the canonical Paperclip listener and verify:

```bash
curl -fsS "$PAPERCLIP_API_URL/api/health"

DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @paperclipai/server exec tsx src/ops/provider-policy-canary.ts \
  --company-id "$PAPERCLIP_COMPANY_ID"

curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/profit-flywheel/ops-receipt"
```

The provider-canary command without `--execute` is a no-spend route plan. Use
`--execute --routes <comma-separated-route-ids>` only for the bounded fresh
health evidence needed by the cutover.

The cutover is operational only after a work-bearing canary begins with real
evidence, creates and closes the authoritative issue, changes target files,
runs Paperclip-observed tests, records cross-family independent review, verifies
release, produces commercial/operational measurement, writes learning back to
Portfolio OS, and advances a newly authorized research iteration. Startup
health, a quiet guard, a zero-token window, or a dry-run receipt is not enough.

Every blocked path must include `blocker_code`, `blocker_detail`, `next_owner`,
and `resume_condition`. The canonical failure classes keep provider auth,
billing, quota, rate limit, capability mismatch, malformed response, transient
network, process loss, artifact missing/invalid/stale, contract mismatch,
human decision, and non-retryable failure separate. Human-owned credentials,
approval, MFA, or terms decisions create a precise blocked issue and do not spin.

SLOs are sample-qualified. A ratio is either measured with a numerator,
denominator, window, and sample size, or it is `insufficient_data`. Do not claim
the 50% token reduction, 90% valuable-or-safe decisions, or 90%
artifact-backed actionable completion target from an idle window.

Temporal is not part of the cutover: Paperclip's persisted event queue,
next-attempt timestamps, leases, idempotency keys, blocker issues, and receipts
already provide the required durable semantics without a second workflow
authority. Langfuse is also not required for health. A future self-hosted
instance may observe OpenTelemetry-compatible metadata, but it cannot schedule,
route, mutate, or complete a stage.

## Legacy actionability migration

Use the section below only when maintaining the earlier routine/actionability
configuration after approving
`docs/plans/unattended-factory-configuration-plan.md`. That migration mutates
the cockpit database, writes a pre-apply database backup, and emits an immutable
JSON receipt, but it is not a substitute for the Profit Flywheel v2 migration.

### Legacy command

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

### Legacy applied contract

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

### Legacy verification

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

### Legacy MiniMax recovery proof

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
