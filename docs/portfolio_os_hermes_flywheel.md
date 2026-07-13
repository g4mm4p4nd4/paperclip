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

An active workflow may span a canonical provider-policy revision. Before an
unclaimed stage takes a lease, Paperclip may rebind the workflow only when the
persisted binding still points to the same absolute `provider-policy.v2` and
schema paths, the schema version and schema hash remain exact, and the prior
policy hash is well formed. The workflow row is locked, the current canonical
hash is loaded from the pinned policy, and the change is recorded in both the
append-only `provider_policy_rebindings` history and a
`provider_policy_rebound` event. Missing, structurally changed, or raced
bindings continue to fail closed; running stages are never rebound.

## Portfolio OS research, deterministic stage, and return planes

Portfolio OS remains the research authority. After learning, it writes an
immutable `pos.next_research_authorization.v1` artifact. Paperclip verifies its
schema, file hash, payload hash, target, source-registry binding, normalized
source-plan hash, legal metadata, and bounded collection-window policy. It then
relays those exact authorized fields into `paperclip.research_plan.v2` and adds
only the fresh collection window. The next `research_intake` input binds:

- `source_registry_hash`
- `selection_hash`
- `research_plan_hash`

Paperclip never selects an unapproved source or expands the authorization. The
research outbox includes the exact plan and remains pending until the dedicated
Portfolio OS research consumer validates, executes, receipts, and acknowledges
it. Observation and learning use the separate return-plane consumer.

```sh
cd /Users/mnm/Documents/Github/portfolio-os
./bin/pos paperclip-research-plane --company-id "$PAPERCLIP_COMPANY_ID"
./bin/pos paperclip-stage-plane --company-id "$PAPERCLIP_COMPANY_ID"
./bin/pos paperclip-return-plane --company-id "$PAPERCLIP_COMPANY_ID"
```

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
