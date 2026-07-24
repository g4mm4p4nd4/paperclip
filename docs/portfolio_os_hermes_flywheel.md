# Portfolio-OS Hermes Flywheel

## Profit Flywheel v2 authority

Profit Flywheel v2 is the authoritative live path. It is a database-backed,
completion-event state machine governed by the canonical Portfolio OS contract
at `/Users/mnm/Documents/Github/portfolio-os/contracts/profit-flywheel.v2.json`.
Paperclip pins the contract, schema, execution schemas, and provider policy by
path and SHA-256 before it accepts work.

The authority boundary is strict:

| Plane | Authority |
| --- | --- |
| Portfolio OS | Commercial evidence, hard gates, next-research authorization, dispatch, observation, and learning artifacts. |
| Paperclip | Workflows, events, issues, leases, retries, provider route selection, receipts, outbox delivery, and terminal state. |
| Hermes and local adapters | Execution only, through the exact Paperclip manifest and selected provider route. |
| Target repository | Implementation, test, review, and release artifacts under the manifest's workspace and git authority. |

`provider-policy.v2` is also the executable supply-chain lock. Every Hermes
route binds the canonical Hermes launcher, source revision/tree, and critical
module digest, plus the external `hermes-paperclip-adapter` revision/tree and
the combined digest of `index.js` and `receipt-contract.js`. Paperclip verifies
both clean Git identities before loading the adapter receipt contract, again
before/after a bounded canary, and before a Hermes work spawn. A mutable,
symlinked, dirty, or hash-drifted runtime fails closed before provider work.

The ten stages are:

1. `research_intake`
2. `evidence_normalization`
3. `commercial_validation`
4. `council_decision`
5. `dispatch`
6. `implementation`
7. `qa`
8. `release`
9. `commercial_observation`
10. `learning`

Only the Market Sweep and VOC Sweep initiate on the twice-daily cron. Every
later edge is driven by a persisted completion event and changed immutable
hash. The transition chain is:

| Edge | Trigger | Guard |
| --- | --- | --- |
| research intake -> evidence normalization | `validated_artifact_completion` | `raw_evidence_hash_changed` |
| evidence normalization -> commercial validation | `validated_artifact_completion` | `ledger_hash_changed` |
| commercial validation -> council decision | `validated_artifact_completion` | `all_commercial_floors_passed` |
| council decision -> dispatch | `validated_artifact_completion` | `explicit_recommendation_and_validation_step` |
| dispatch -> implementation | `issue_created` | `issue_backed_and_dispatch_hash_matches` |
| implementation -> QA | `validated_artifact_completion` | `mutation_and_final_response_present` |
| QA -> implementation | `product_test_failure` | `retry_budget_remaining` |
| QA -> release | `validated_artifact_completion` | `qa_passed_and_artifact_backed` |
| release -> commercial observation | `validated_artifact_completion` | `release_artifact_hash_present` |
| commercial observation -> learning | `validated_artifact_completion` | `measured_external_or_operational_evidence_present` |
| learning -> research intake | `new_observation_changes_hash` | `next_validation_authorized` |

Each stage is uniquely coalesced by
`{company}+{run_id}+{stage}+{input_hash}`. Paperclip stores the source-stage and
output-hash lineage, holds stage/repository/provider/agent leases, retries only
contract-listed failures, and recovers orphaned runs from immutable artifact
checkpoints. A blocked stage is not a status string alone. It must persist
`blocker_code`, `blocker_detail`, `next_owner`, and `resume_condition`; the
resume call must bind the same workflow, stage run, input hash, outbox event,
and expected blocker code.

Provider-like execution failures also persist the failed route ID on the stage.
Every later claim excludes all routes that already failed that stage, so a
checkpoint retry must escalate from route A to a different fresh healthy route
B. If no non-excluded policy-valid route remains, the stage blocks with
`provider_policy_no_capable_route`; it never reselects route A and then rejects
its own checkpoint for failing to escalate.

QA and release manifests also carry field-level authoritative copy rules for
receipt lineage. In particular, QA must copy the implementation stage id, Git
object, and implementation-receipt artifact hash from `manifest.lineage`
exactly. A file, tree, patch, review, or recomputed commit hash is a distinct
artifact and is rejected rather than silently substituted.

A pre-lease `provider_policy_no_capable_route` result is terminal for the
current provider-health snapshot, not a 30-second retry. Paperclip atomically
blocks the exact stage, workflow, and linked issue, clears the dispatch claim,
and records `paperclip_provider_operator` plus the required capability alias.
When a later bounded canary makes a policy-valid route healthy, the provider
canary signal runs reconciliation, compare-and-set resumes that same stage and
input hash, and the normal dispatcher emits exactly one new heartbeat.

Portfolio OS plane launch failures use a separate bounded counter from stage
execution attempts. On exhaustion, Paperclip persists the exact final
sanitized launcher failure in the stage, workflow, outbox event, and blocker
issue; a generic “retries exhausted” summary must not erase the repair target.
The terminal counter includes the final launch, while stage `attempt_count`
remains reserved for server-issued execution claims. Explicit repair/resume
atomically increments the outbox event's durable launcher-retry generation and
resets only that generation's launcher counter. Block/resume events dedupe on
the generation and counter, not wall-clock timestamps, so the same blocker can
safely exhaust, recur, and be repaired again without colliding with an older
append-only lifecycle event.

An active workflow may span a canonical provider-policy revision. Before an
unclaimed stage takes a lease, Paperclip may rebind the workflow only when the
persisted binding still points to the same absolute `provider-policy.v2` and
schema paths, the schema version and schema hash remain exact, and the prior
policy hash is well formed. The workflow row is locked, the current canonical
hash is loaded from the pinned policy, and the change is recorded in both the
append-only `provider_policy_rebindings` history and a
`provider_policy_rebound` event. Missing, structurally changed, or raced
bindings continue to fail closed; running stages are never rebound.

Every published policy revision is also stored at
`config/provider-policy-history/<policy-sha256>.json`. Historical Portfolio OS
dispatch and closeout verification uses the stage's persisted route snapshot
and this content-addressed archive; it never reinterprets completed work under
the mutable current policy. A policy update must add the new current bytes to
the archive in the same change.

## Portfolio OS research, deterministic stage, and return planes

Portfolio OS remains the research authority. The first iteration may use the
legacy immutable `pos.next_research_authorization.v1` artifact. Iterated runs
use `pos.next_research_authorization.v2`; Paperclip verifies its
schema, file hash, payload hash, target, source-registry binding, normalized
source-plan hash, legal metadata, and bounded collection-window policy. It then
combines those frozen fields with the just-acknowledged learning output, prior
raw-evidence hash, exact workflow/correlation identity, and bounded window in
`paperclip.research_continuation.v1`. That wrapper is validated before it is
embedded in `paperclip.research_plan.v3`. Fixture continuations require an
immutable offline fixture path/hash on every source; live continuations reject
all offline fixture bindings. The next `research_intake` input binds:

- `source_registry_hash`
- `selection_hash`
- `research_plan_hash`

Paperclip never selects an unapproved source or expands the authorization. The
research outbox includes the exact plan and remains pending until the dedicated
Portfolio OS research consumer validates, executes, receipts, and acknowledges
it. Observation and learning use the separate return-plane consumer.

Every v2 envelope carries the dispatch-only identity and authoring-authority
slots. They are populated only for `dispatch` and are explicitly `null` on the
research and return planes. QA and release bindings on observation/learning
also carry the exact workflow, trace, attempt, input, execution-manifest, and
work-result lineage; the consumer rejects the legacy short binding.

```sh
cd /Users/mnm/Documents/Github/portfolio-os
./bin/pos paperclip-research-plane --company-id "$PAPERCLIP_COMPANY_ID" --limit 1 --runtime-manifest /absolute/runtime/manifest.json --provider-policy-authority /absolute/managed-paperclip-runtime/authorities/provider-policy/<sha256>.json --artifact-root /absolute/writable/output/paperclip-consumer
./bin/pos paperclip-stage-plane --company-id "$PAPERCLIP_COMPANY_ID" --limit 1 --runtime-manifest /absolute/runtime/manifest.json --provider-policy-authority /absolute/managed-paperclip-runtime/authorities/provider-policy/<sha256>.json --artifact-root /absolute/writable/output/paperclip-consumer
./bin/pos paperclip-return-plane --company-id "$PAPERCLIP_COMPANY_ID" --limit 1 --runtime-manifest /absolute/runtime/manifest.json --provider-policy-authority /absolute/managed-paperclip-runtime/authorities/provider-policy/<sha256>.json --artifact-root /absolute/writable/output/paperclip-consumer
```

Paperclip never uses checkout constants for these commands. Configure the
managed runtime closure in the instance `config.json`:

```json
{
  "factory": {
    "mode": "shadow",
    "pauseNewWork": true,
    "baselinePointerPath": "/absolute/paperclip-instance/data/ops/factory-baseline-pointer.json"
  },
  "factoryRuntime": {
    "portfolioOsRuntimeRoot": "/absolute/runtime/managed-pos-runtime",
    "posAttemptReceiptDir": "/absolute/paperclip-instance/data/ops/pos-consumer-attempts"
  }
}
```

`factory` is the versioned operator posture (`fixture`, `shadow`, or
`production`) and fail-closed admission switch. `factoryRuntime` is a separate
verified executable binding; changing posture never changes executable
authority. When absent, the server defaults to `factoryMode=fixture` and
`factoryPauseNewWork=true`.

One server-owned launch authority governs all three new-work boundaries:
Paperclip stage dispatch/heartbeat creation, Portfolio OS consumer outbox
claims and subprocesses, and Portfolio OS dispatch-file ingestion. Pause is
checked before an authority call or database claim. Existing leases may drain
or checkpoint, and reconciliation/finalization continues, but no new lease,
claim, heartbeat, ingest, or child process is created. The health gate requires
a source-backed disk reading with at least 30 GiB available. Shadow and
production additionally require healthy verified runtime identities, fresh
policy-bound provider routes with different-family review capacity, and fresh
passing tokenomics. The built-in live authority is deliberately default-deny;
an injected DB authority must atomically consume the exact typed
`profit_flywheel_shadow_launch` or `profit_flywheel_production_launch` approval
before returning allowed. The generic `launch_execution` approval is never a
factory promotion authority.

The manifest itself must be mode `0444`, bind a clean exact source commit/tree,
the executable, interpreter identity, dependency lock, source registry, and all
required contracts. Paperclip re-hashes that closure before every launch; POS
re-verifies it again before claiming an event. Missing configuration blocks the
event with an explicit runtime owner and never falls back to a development
checkout.

Each subprocess is fenced by a short database claim transaction, runs entirely
outside a transaction, then finalizes through the claim nonce hash. Exactly one
`paperclip.pos_consumer_attempt_receipt.v1` is linked from the database receipt,
source outbox event, stage feedback, workflow feedback, and append-only attempt
log event. Nonzero exit code `2` is compatible with a valid typed final envelope;
the envelope and exact event/stage acknowledgement determine the outcome.
Missing/malformed output, spawn errors, signals, timeouts, provenance mismatch,
credential preconditions, and acknowledgement mismatch remain distinct typed
classifications. Stream hashes and byte counts cover the captured bytes; inline
text is bounded and redacted, while overflow is stored as a read-only compressed
redacted diagnostic artifact.

The `Portfolio OS Orchestrator` agent needs four distinct encrypted company
secret references. Values never belong in agent JSON, issue comments, command
arguments, logs, receipts, or git:

- `PAPERCLIP_API_KEY`
- `PAPERCLIP_RETURN_PLANE_JOURNAL_KEY`
- `PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY`
- `PAPERCLIP_STAGE_PLANE_JOURNAL_KEY`

The three journal keys are stable company-scoped HMAC authorities, at least 32
characters, pairwise distinct, and different from the API key. Prepared
acknowledgements signed with an old key must reconcile before that key is
retired.

Receipt storage preserves both the parsed `timestamptz` and the producer's raw
ISO-8601 spelling. This is required for exact cross-language content-hash
verification because PostgreSQL normalizes offsets and sub-millisecond
precision. An exact replay of a torn acknowledgement may restore a missing raw
timestamp binding, but any semantic body, artifact, or content-hash difference
remains a receipt-type conflict.

## Execution proof: manifest, work result, server observation

For `implementation`, `qa`, and `release`, success requires three exact layers
of evidence:

1. Paperclip writes an immutable mode-`0444` execution manifest under the
   target repository's `.paperclip/manifests/` directory. It binds company,
   workflow, stage run, issue, attempt, input hash, correlation/trace IDs,
   workspace root, base object, run branch, origin/ref, provider route and
   policy hashes, exact test commands, lineage, and the required receipt path.
2. The adapter writes
   `paperclip.profit_flywheel_stage_work_result.v1` to that exact receipt path
   before its final response. The work result repeats the manifest hashes and
   identity. Implementation must create a commit on the manifest-pinned run
   branch, declare that exact branch `HEAD` as its target git object, declare
   exactly the base-to-target changed files, and leave no worktree changes
   outside `.paperclip`; an index tree or staged-but-uncommitted result is not
   valid completion evidence. Context-ledger receipt candidates are canonicalized
   through `realpath` and deduplicated by that resolved identity before validation,
   so absolute and workspace-relative references to the same immutable file count
   exactly once. QA must bind the implementation plus an independent-review
   artifact; release must bind the QA lineage and published git object.
   The manifest also pins the exact work-result JSON Schema path/hash and a
   minimal stage-specific shape. Executors must read that schema before
   writing; `additionalProperties: false` means narrative summaries, timestamps,
   test outputs, exit codes, and other invented evidence are rejected.
3. Paperclip, not the agent, validates the heartbeat run, issue, context-ledger
   row, working directory, complete final-response hash, provider route, and
   token accounting. It reruns every manifest test command non-interactively,
   writes immutable `paperclip.test_execution_result.v1` observations, re-reads
   the manifest and work result to detect test-time drift, and synthesizes
   `paperclip.profit_flywheel_stage_execution.v2`.

Process exit zero is never completion evidence. A tool-call-only answer,
missing final response, missing work-result artifact, unlisted test, dirty
workspace, changed git HEAD during tests, output overflow, hash drift, or stale
provider binding leaves the stage incomplete or blocked with a precise owner
and resume condition.

Provider-canary recovery never exceeds a stage's immutable retry limit. An
exhausted provider-blocked stage remains blocked, and dispatch independently
converts any exhausted pending/retry row into
`profit_flywheel_retry_exhausted` instead of creating an impossible heartbeat
attempt. Further work requires an explicitly governed replacement stage or a
new dispatch iteration.

Paperclip sets Hermes `--yolo` only for the manifest-bound Profit Flywheel
execution override. This prevents interactive approval timeouts during
unattended implementation, QA, and release inside the exact company-owned
workspace; it does not change ordinary agent wakes, widen the workspace, or
disable Hermes' hardline command blocklist.

The server's execution-intent nonce remains database-only. Immutable
adjudication, workspace, and checkpoint artifacts carry distinct
`server_observation_proof` values computed as HMAC-SHA-256 over the artifact
kind and canonical body. The raw nonce never enters an adapter context, API
response, log, issue, or receipt, so a detached process cannot reuse a proof
from one artifact kind to forge another after a crash.

QA is independent by contract. Its provider family must differ from the exact
implementation builder family. The immutable
`paperclip.independent_review_result.v1` must bind the implementation git object,
artifact hash, reviewer model/version, provider-policy hashes, findings, and
final disposition. Release accepts only a passing QA lineage and verifies the
authorized origin/ref with `git ls-remote`.

The company-scoped MiniMax M3 route is eligible for independent review only
after its catalog, direct-health, native Hermes, model, usage, and encrypted
secret bindings all pass. A host-level credential alone never satisfies the
route, and MiniMax remains ineligible for release approval. The frozen Hermes
closure includes the exact `anthropic==0.87.0` provider transport required by
MiniMax's Anthropic-compatible endpoint; the closure remains read-only and is
rehash-verified before every managed spawn.

OpenCode Zen free is also an explicit emergency `independent_review` route when
its fresh signed catalog and direct-health canary prove reasoning, tool calls,
and structured output. This exception is limited to different-family QA:
`releaseAllowed=false` remains authoritative, so release approval never falls
through to the free route.

## Operations and verification

Apply the database schema before the fleet cutover, then use the dedicated
migration runbook in
`docs/guides/board-operator/unattended-factory-configuration.md`:

```sh
cd /Users/mnm/Documents/Github/paperclip
pnpm db:migrate
pnpm --filter @paperclipai/server typecheck
pnpm exec vitest run \
  packages/shared/src/profit-flywheel.test.ts \
  server/src/__tests__/profit-flywheel-context-sync.test.ts \
  server/src/__tests__/profit-flywheel-dispatch.test.ts \
  server/src/__tests__/profit-flywheel-execution-contract.test.ts \
  server/src/__tests__/profit-flywheel-outbox.test.ts \
  server/src/__tests__/profit-flywheel-review.test.ts \
  server/src/__tests__/profit-flywheel-tenant-integrity.test.ts \
  server/src/__tests__/profit-flywheel-v2-migration.test.ts
```

Read workflow state and honest, sample-qualified operations metrics through the
company-scoped API:

```sh
curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/profit-flywheel/workflows"
curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/profit-flywheel/ops-receipt"
```

Ratio metrics report either `status=measured` with `sample_size`, or
`status=insufficient_data` with a reason. Zero work is not a passing SLO.
Token-reduction and valuable-output claims also require a work-bearing window;
a quiet guard, health check, or provider watch is supporting evidence only.

## Substrate decisions

- Temporal was evaluated and rejected for v2. Paperclip already persists the
  event queue, transition attempts, next-attempt timestamps, leases,
  concurrency slots, idempotency keys, blocker issues, receipts, and rollback
  state. A second worker/service and retry authority would duplicate state and
  add deployment and secret failure modes without removing this code. Revisit
  only if measured timer durability, recovery latency, or throughput exceeds
  the current database-backed design.
- Classified Profit Flywheel routines are normalized to
  `coalesce_if_active` with `skip_missed`, while trigger enablement remains
  stage-specific. Live adapters also receive explicit execution timeouts
  (`codex_local=3600`, `hermes_local=1800` when absent). The fleet audit hashes
  these values and the migration rollback snapshot restores them exactly.
- Langfuse is observer-only and is not enabled as a workflow dependency. A
  future self-hosted deployment may consume OpenTelemetry-compatible spans and
  receipt metadata, but it may not schedule work, select providers, mutate
  workflow state, satisfy a receipt, or gate completion. Paperclip DB state and
  immutable files remain authoritative when an observer is unavailable.

## Legacy file-first bridge

The commands below remain useful for offline compatibility and development
without a live Paperclip server. They read a Portfolio OS mandate, write
deterministic Paperclip context, create a Hermes task bundle, optionally invoke
Hermes, and record the execution result back into the Portfolio OS artifact
tree. They do not create the v2 database workflow, issue leases, provider route
receipt, return-plane outbox, or server-observed completion proof.

### Commands

```sh
paperclipai portfolio-os ingest --mandate /Users/mnm/Documents/Github/portfolio-os/data/execution_mandate.json
paperclipai portfolio-os plan-hermes --run-id <run_id>
paperclipai portfolio-os execute --run-id <run_id>
paperclipai portfolio-os status --run-id <run_id>
```

Useful overrides:

- `--portfolio-root <path>` points at a non-default Portfolio-OS checkout.
- `--company-name <name>` changes deterministic Paperclip company context.
- `--hermes-bin <path>` points at a non-default Hermes adapter binary.

## Artifacts

`ingest` writes:

- `data/paperclip_context/<run_id>.json`
- `data/paperclip_context/latest.json`

`plan-hermes` writes:

- `data/hermes_task_bundles/<run_id>.json`
- `data/hermes_task_bundle.seed.json`

Both `ingest` and `plan-hermes` preserve Portfolio OS Internet Pipes
completeness when it is present on the execution mandate. The normalized
contract is written into Paperclip context, Hermes `opportunity`, Hermes
`evidence`, and the validation/trust/QA task instructions so file-first Hermes
execution does not drop station gaps that the live cockpit would see.
When Hermes local adapter prompts carry `promptMetrics.internetPipes`, Paperclip
context-ledger readback keeps that compact station gate and flywheel health
blocks canary readiness until readiness is `alpha_ready`/`factory_ready` and no
missing stations remain.

`execute` writes:

- `data/execution_results/<run_id>.paperclip.json`
- Hermes writes `data/hermes_results/<run_id>.json` when dispatch completes.

`status` reads all of those artifacts and reports the next required action.

## Safety Boundary

Paperclip does not mutate target repositories from this bridge. Target writes,
commits, pushes, and PR creation remain Hermes-Agent responsibilities and must
be governed by the task bundle `target.write_policy`, `target.push_policy`, and
`safety` sections.

The generated bundle always includes:

- `safety.destructive_ops_allowed: false`
- `safety.secrets_scan_required: true`
- forbidden operations for repo deletion, history rewrite, license removal, and
  secret commits

When a launch gate is blocked, the bridge preserves the validation-sprint
mandate instead of pretending the target is launch-ready.

## Context And Tool Economy

The flywheel is not a generic agent heartbeat loop. The intended cycle is:

1. Codex/Portfolio OS research produces selection, freshness, dispatch, and
   council artifacts in `/Users/mnm/Documents/Github/portfolio-os`.
2. Paperclip cockpit ingests those artifacts, creates governed issues/routines,
   and records context-ledger/flywheel receipts.
3. Hermes receives the assigned build task through the Paperclip adapter and
   writes implementation artifacts back to the target repo and Portfolio OS
   result paths.

Token controls must preserve that cycle. Agents should use the smallest useful
context surface first:

- Portfolio OS authority files and dispatch receipts before broad repo scans.
- Paperclip issue heartbeat context and context-ledger receipts before replaying
  full comment threads.
- Context packs in map, then delta, then core order.
- Graphify reports/queries when `graphify-out` exists.
- ScrapeGraphAI JSON receipts for structured web or local-corpus extraction.
- `gstack` for QA/dogfooding screenshots and responsive/user-flow evidence.
- gbrain semantic lookup when configured and indexed.

Empty timer wakes with no assigned open work are control-plane waste and should
be skipped before Hermes starts. Assignment, automation, comment, approval, and
on-demand wakes remain the valuable path and must keep enough context budget to
produce tests, docs, receipts, and shippable changes.

Timer wakes pinned to already-blocked issues are also skipped before Hermes when
the latest issue signal is the same assigned agent's blocker receipt and no newer
external comment or issue update exists. These low-cost skips are recorded as
`heartbeat.blocked_issue_no_new_signal` with a blocker fingerprint, so repeated
credential/workspace/human-owned blockers preserve tokens without hiding the
exact condition needed to resume execution.

When the acceptance path is already deterministic, use the Paperclip `process`
adapter before Hermes. Current examples are Dispatch Poller, Release Gate
Reconciler, Evidence Backfill Reconciler, and Skill Inventory. For Skill
Inventory, Paperclip can repair missing Portfolio OS skill `keywords:`, rerun
`scripts/skill_curator.py`, and patch the issue without a model call; Hermes
should be reserved for cases where the skill instructions themselves need
judgment, redesign, or safety review. Live run
`48299aab-5161-4051-b18c-dda3f50ed83e` closed `PORA-1801` this way, moving the
Portfolio OS curator from `pass=10/fail=43` to `pass=53/fail=0` with zero
provider tokens.

The external tokenomics watch is deterministic and observe-only. It does not
wake agents or poll a provider. Prefer a one-shot work-bearing evaluation when
collecting release evidence:

```sh
pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-watch.ts --once --window-minutes 30 --baseline-hours 96
```

Its receipt target is 50 percent or better token reduction against baseline and
90 percent or better valuable/safely-skipped wake decisions, with failures for
high-burn provider events, no-issue timer launches, or Hermes budget drift.

## Recovery baseline receipt

Before changing runtime or workflow state, freeze a redacted baseline with the
dedicated read-only operation:

```sh
PAPERCLIP_CONFIG=/absolute/instance/config.json \
pnpm ops:zero-touch-factory-baseline -- \
  --company-id <company-uuid> \
  --workflow-run-id <run-id> \
  --instance-root <absolute-instance-root> \
  --plugin-store <absolute-adapter-plugins.json> \
  --tokenomics-receipt <absolute-latest-tokenomics-watch.json> \
  --portfolio-os-repo <absolute-live-pos-checkout> \
  --paperclip-repo <absolute-paperclip-checkout> \
  --hermes-repo <absolute-hermes-checkout> \
  --adapter-repo <absolute-adapter-checkout>
```

The command rejects database URL overrides, does not claim or mutate workflow
state, does not run a POS consumer, and records no environment values. It
captures repository identity and dirt counts, stage/blocker counts, the named
workflow's latest event, provider-health expiry, adapter package/store/runtime
drift, tokenomics freshness, disk/database/ops/backup/log sizes, and only
factory-owned browser-process counts.

Receipts use
`paperclip.profit_flywheel_factory_baseline.v1` and are installed at:

```text
<instance-root>/data/ops/factory-baseline/sha256/<prefix>/<receipt-sha256>.json
```

The receipt is mode `0444`. `factory-baseline/latest.json` is only an atomic
pointer containing the receipt path, hash, schema, and generation time. Never
replace the immutable receipt bytes with an expanded mutable `latest` report.

## Archive and retention boundary

`factory-archive-retention.ts` implements the permanent non-destructive half of
factory retention:

- a source must be a current-user-owned regular file under an explicit trusted
  root; symlinks and group/world-writable sources fail closed;
- the source is streamed through a trusted zstd executable while its SHA-256 is
  computed;
- source inode metadata must remain stable for the full compression;
- the compressed object is installed read-only under its uncompressed content
  hash and then decompressed and re-hashed;
- `paperclip.factory_archive_manifest.v1` binds source, object, ownership token,
  receipt references, compressed hash, and decompressed hash;
- archiving never removes or modifies the source.

Retention inventory uses `paperclip.factory_retention_dry_run.v1`. A candidate
is protected when it lacks a factory ownership token, its lease is active, an
active/blocked/rollback-eligible workflow references it, it is the only
referenced copy, or its retention window is still active. An expired
factory-owned source is only `eligible_after_approval` when its archive manifest
and decompressed object re-verify. Otherwise it is `archive_then_review`.

There is deliberately no automatic delete entry point in the initial recovery.
The first destructive application to existing data requires explicit human
approval of the immutable dry-run inventory. Database files, user browser
profiles, unrelated worktrees, and files without a factory ownership token are
never inferred as cleanup candidates.
