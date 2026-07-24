# Software Factory operator guide

The company-level **Factory** page is the server-owned operating view for the
Portfolio OS → Paperclip → Hermes Profit Flywheel. It is deliberately
fail-closed: absent, stale, mutable, or unverifiable evidence never becomes a
green state.

## Configure posture and runtime separately

Behavioral settings belong in `config.json`/`config.yaml`, never `.env`:

```yaml
factory:
  mode: fixture
  pauseNewWork: true
  baselinePointerPath: /absolute/path/to/factory-baseline/latest.json
  tokenomicsWatch:
    enabled: true
    intervalSeconds: 300
    baselineHours: 360
    receiptDir: /absolute/path/to/data/ops/tokenomics-watch
    applyBalanceOnDrift: false

factoryRuntime:
  portfolioOsRuntimeRoot: /absolute/path/to/data/ops/managed-pos-runtime
  posAttemptReceiptDir: /absolute/path/to/data/ops/pos-consumer-attempts
```

`factory` is the operator posture. `factoryRuntime` is the executable trust
boundary. Omitting the posture defaults to `fixture` with new work paused.
Omitting the runtime prevents POS consumer execution and produces a typed,
resumable blocker; it never falls back to a developer checkout.

Provider-policy bindings stored on agents must use absolute policy and schema
paths and must match the server-pinned SHA-256 values. The paths may resolve
inside a verified immutable Paperclip runtime closure; they are not required to
point at a mutable developer checkout. A different byte hash, schema hash,
capability alias, or budget class still fails closed.

Every managed POS D6 package additionally pins one immutable Paperclip D7
`provider_policy_authority` descriptor in both its package and runtime
manifest. Paperclip publishes it from the active managed policy with
`pnpm ops:provider-policy-authority`; the consumer rechecks the descriptor’s
policy path/hash and schema path/hash before launching, and passes its path
only as `--provider-policy-authority` (never through the child environment).
Before publishing, the sealed D7 package must already contain the active
policy's immutable, mode-`0444`, byte-identical history copy at
`<policy-config-directory>/provider-policy-history/<policy-sha256>.json`.
Missing or mismatched history is a typed publication failure; Paperclip never
writes or repairs that archive while serving work. Legacy v1 POS closures can
be resolved only as migration/rollback evidence and are never admitted to the
managed consumer runner.
Factory health resolves that same active POS descriptor and verifies it against
the current D7 policy before showing the POS identity as verified. A
structurally valid descriptor for an older policy degrades health rather than
being treated as reusable provenance.

The baseline pointer may be mutable so an atomic writer can advance it, but it
must be current-user-owned and non-group/world-writable. The referenced receipt
must be read-only, content addressed, and match its declared SHA-256.

## Read the Factory page

Open `/<company-prefix>/factory` or use **Work → Factory** in the sidebar.
The page refreshes protected server data without reusing a failed request as a
healthy snapshot.

- **Truth bar** shows fixture/shadow/production mode, overall state, refresh
  time, and verified contract/policy/adapter/POS/Hermes identities.
- **Pipeline** shows all ten canonical stages in order. Select a stage to filter
  blockers and active work; select it again to clear the filter.
- **Needs attention** shows the exact persisted blocker, owner, declared resume
  condition, retry timing, and immutable receipt binding. Terminal blockers are
  sorted before retryable work.
- **Active work** shows the route, provider family, lease/heartbeat, elapsed
  time, budget, and last useful persisted action.
- **Provider readiness** requires fresh policy-bound evidence. Work routes do
  not count as independently reviewed unless a healthy review route uses a
  different provider family.
- **Outcome economics** reports only measured, work-bearing samples. Missing
  samples remain “Not measured.”
- **Host durability** separates disk, database, log, archive, and factory-owned
  browser evidence.
- **Approval gates** keep retention apply, real-repository shadow work,
  credentials, spend, merge, publish, and deploy authority explicit.

All status meaning is text-labelled. Pipeline controls, blocker rows, active
work, and the detail sheet are keyboard reachable. Tables include accessible
captions and narrow layouts use cards where dense tabular rows would clip.

## State semantics

| State | Meaning |
| --- | --- |
| `healthy` | Required identities, aliases, monitors, and host gates are verified. |
| `degraded` | Work exists, but a non-terminal readiness/economics/provenance gate is incomplete. |
| `blocked` | A persisted workflow blocker or disk hard-stop prevents safe progress. |
| `paused` | Operator posture stops new work while active work drains or checkpoints. |
| `unknown` | No authoritative work/evidence exists. Unknown is never treated as healthy. |

Disk is a hard stop below 25 GiB. New dispatch pauses, while reconciliation,
verified archive, approved retention review, and operator access remain
available. Production promotion remains blocked below 30 GiB even after the
hard-stop clears.

When an older `fixture/profit-canary` workflow remains non-terminal after a
newer immutable work-bearing closeout, do not suppress its health signal or
delete rows. Use the narrowly scoped, backup-backed
[stale fixture-canary retirement operator](./profit-flywheel-stale-canary-retirement.md)
while the Factory is paused. It terminalizes only proven superseded fixture
work and preserves receipts and audit history.

## Attempt receipts and retries

Every managed POS launch has a fenced attempt identity. The server records a
content-addressed `paperclip.pos_consumer_attempt_receipt.v1` containing:

- exact event/workflow/stage/input/attempt bindings;
- verified runtime/contract/provider-policy identities, including the exact
  immutable provider-policy-authority path and SHA-256;
- executable, arguments, allowlisted environment names, and secret references
  by name/version/fingerprint only;
- process exit/signal/timeout and raw-stream hashes;
- redacted bounded excerpts or a compressed immutable diagnostic artifact;
- final envelope/acknowledgement bindings and typed retry classification.

The receipt is linked from the database receipt, original outbox event, stage,
workflow, audit event, ops snapshot, log, and Factory page. Deterministic or
terminal acknowledgements are not retried. Transient retries use the persisted
attempt count and next-attempt time. A lost claim cannot finalize another
worker’s attempt.

`Resume same input` is exposed only for the deterministic assignment blockers
`profit_flywheel_stage_agent_missing` and
`profit_flywheel_linked_issue_missing`. Each block creates a hashed database
receipt whose body binds company, workflow, stage, input, blocker, owner,
condition, and observation time. Resume sends the latest receipt id/hash; under
the stage row lock the server re-hashes that receipt, verifies that it remains
valid/current, rechecks the linked issue and invokable assignee, and CASes the
unchanged blocker/input. A stale receipt, changed blocker/input, different
principal replay, or unsatisfied condition is rejected without mutation.

`Pause new work` is an instance-admin action. Paperclip fsyncs
`factory.pauseNewWork: true` through an atomic config rename before changing the
live posture. All in-process dispatch, POS-consumer, and Paperclip-stage claim
paths read that same live control, so active leases can drain while no new work
starts. A persistence failure leaves the live posture unchanged. Resuming the
whole factory remains an explicit configuration/restart decision; the blocker
button does not unpause global dispatch.

The tokenomics watcher is a supervised deterministic service. It starts only
when `factory.tokenomicsWatch.enabled` is true, prevents overlapping runs,
reports freshness/failure state through `/api/health`, and keeps balance
application disabled unless the non-secret config explicitly opts in.
`factory.tokenomicsWatch.baselineHours` is an integer from 24 through 720;
omitting it preserves the historical 96-hour comparator. Set it to `360` when
the normal work-bearing baseline spans fifteen days. This changes only the
comparison window: it does not lower token-reduction, optimization, or output
thresholds.

Portfolio dispatch, reconciliation, provider canaries, tokenomics watch, and
baseline refresh start only from the HTTP server's listen-ready callback. A
restart therefore cannot claim new work while its own API is still guaranteed
to refuse the downstream consumer connection.

## Live launch approval authority

Shadow and production launches use the normal Paperclip approval queue, but
their payloads cannot be typed or uploaded by an operator. An authenticated
instance admin submits only launch intent to the factory proposal endpoint:

```json
{
  "requestedMode": "shadow",
  "targetRepo": "owner/isolated-shadow-repo",
  "runId": "shadow-2026-07-17-1",
  "inputHash": "<64 lowercase hex characters>",
  "expiresInSeconds": 900
}
```

The server resolves and stores the current contract and golden-vector hashes,
provider-route core hashes, active credential-version fingerprints, complete
managed POS manifest/source identity, and verified immutable Hermes adapter
bundle. Production proposals additionally bind the latest valid shadow and
canary closeout receipts. Direct creation of either factory launch approval
type through the generic approval endpoint is rejected.

Proposal creation and every later approval-binding check independently resolve
the current POS descriptor and call the D7 provider-policy authority verifier.
If the descriptor is missing, differs by path or SHA-256, or is structurally
valid but names an older active-policy map, creation or verification is
rejected. Live admission repeats this check immediately before the
approval-consuming transaction, so a descriptor that drifts after a health
snapshot cannot consume approval authority.

The proposal remains `pending` until resolved through the ordinary approval
workflow. On initial portfolio dispatch, the approved pre-workflow root is
consumed once under a database row lock and sealed in a content-addressed,
read-only `paperclip.factory_launch_consumption.v1` receipt. The proposal omits
`workflowId` before ingest because no workflow row exists yet. Later Paperclip
and POS stage claims can reuse that one receipt only after the database proves
that the persisted workflow has the same company, run, target repository, and
root `sourceDispatchHash`; an optional workflow-bound proposal must also match
the exact workflow id.

Every claim re-resolves the source-backed launch bindings. Runtime, contract,
route, credential-epoch, adapter, or production-evidence drift stops the
workflow with `factory_live_approval_binding_drift`; a new server-generated
proposal is then required. Expiry prevents first consumption, while a valid
consumed root receipt remains the authorization record for the already-bound
workflow. `Glitch-Cipher-Syndicate/LeadForge` is rejected before lookup or
consumption.

## Archive and retention

Archive is non-destructive:

1. stream a current-user-owned factory artifact through trusted `zstd`;
2. install a read-only object under the uncompressed SHA-256;
3. decompress and re-hash it;
4. write a content-addressed manifest with ownership and restore bindings;
5. leave the source untouched.

Retention is dry-run-only in the automated path. Active leases, blocked work,
rollback evidence, the only verified copy, missing ownership tokens, and
retention-window artifacts are protected. The first destructive apply requires
separate human approval and a newly verified dry-run receipt.

## Immutable adapter install and rollback

Managed Hermes adapter mutation is instance-global and therefore requires an
instance-admin session. Installation accepts only the exact
`@henkey/hermes-paperclip-adapter` package, absolute content-addressed install
receipt path/hash, and an optimistic-lock `expectedCurrentBundleSha256` (`null`
for the first install). Paperclip copies the verified closure into its own
content-addressed root, loads it, writes a transition receipt, then atomically
swaps the plugin-store pointer. Concurrent or stale requests receive `409`.
Every transition receipt binds the initiating user and UTC occurrence time.
Paperclip also writes company-visible `authorized` and `completed` activity
events for the instance-global transition. Failure to write the authorization
event prevents the pointer swap; a later completion-fanout failure cannot turn
an already completed, immutably receipted swap into a false HTTP failure.

Rollback accepts the exact active and historical bundle hashes plus explicit
confirmation. The prior target is fully re-verified before the pointer swap.
If the active object's bytes are corrupted, its stored pointer metadata still
provides the fencing token: the active verification failure is recorded in the
transition receipt, the corrupt bundle is not added to future verified history,
and a verified historical target can restore service without database or JSON
surgery. Managed install and rollback never accept a local checkout fallback.
The Factory page exposes this as **Rollback runtime** only when the active
`hermes_local` adapter is managed and at least one historical bundle is
recorded, and only when the server projects instance-admin capability. Ordinary
board users do not receive rollback candidates. The confirmation dialog shows the complete current, target, and
manifest hashes; the server still requires instance-admin authority and
re-verifies the selected bytes at click time. A successful swap reports its
immutable transition-receipt hash in the page.

Managed immutable runtimes cannot use the legacy override pause/resume, reload,
or npm reinstall endpoints. Those sibling mutation paths require instance-admin
authority and then reject with `409`; managed runtime changes must use an exact,
confirmed install or rollback transition. This prevents a board-level adapter
control from bypassing bundle verification, optimistic locking, and receipts.

## Promotion gates

Fixture promotion requires twenty consecutive hermetic two-iteration cycles,
failure/restart/replay/provider/budget/archive tests, and both official visual
QA tools. Shadow mode additionally requires an explicit real repository choice
and approval; `Glitch-Cipher-Syndicate/LeadForge` is always excluded. A shadow
cycle stops before external mutation unless that repository’s authority already
permits an isolated non-production target.

Production is not permitted with a fixture-only closeout, stale monitor,
incomplete usage coverage, missing different-family review, low disk, a mutable
adapter/POS runtime, or a manually invoked second loop.

### Seal the 20-cycle fixture gate

The acceptance boundary consumes an immutable manifest with exactly twenty
ordered cycle-evidence bindings. Each evidence file must live inside a distinct
current-user-owned isolation root and use schema
`paperclip.profit_flywheel_two_iteration_evidence.v1`. It records:

- exactly two succeeded `research_intake` + `evidence_normalization` pairs;
- changed raw-evidence and ledger hashes between iterations;
- an iteration-two fixture-only POS authority claimed automatically within two
  reconciliation intervals;
- one pending iteration-three research event and fixture-only authority;
- zero manual consumer calls, network access, provider calls, external
  mutations, tokens, or cost; and
- zero duplicate stages/releases, orphan leases, or unverified receipts.

All evidence, authorities, offline fixtures, ledgers, and stage receipts must
be read-only absolute files under that cycle's isolation root. The verifier has
no database, HTTP, provider, or subprocess capability; it can only audit the
immutable artifacts and seal receipts:

```bash
cd /absolute/path/to/the/pinned/portfolio-os-runtime
python3 -m pos.profit_fixture_acceptance \
  --output-root /absolute/path/to/new-empty-fixture-run \
  --cycles 20 \
  --company-id <paperclip-company-uuid> \
  --project-id <paperclip-project-uuid>

cd /absolute/path/to/paperclip
mkdir -m 700 /absolute/path/to/precreated-receipt-directory
pnpm ops:profit-flywheel-fixture-acceptance -- \
  --manifest /absolute/path/to/new-empty-fixture-run/fixture-acceptance-manifest.json \
  --receipt-dir /absolute/path/to/precreated-receipt-directory
```

The generator uses the production POS research and normalization consumer
functions with a local claim/ACK transport that cannot perform network I/O. The
verifier proves iteration-two lineage through the source-run execution plan:
authority to offline input, execution plan to that authority, and raw manifest
to that source-run receipt. It never equates the offline input file hash with
the derived raw-manifest hash.

Success writes twenty immutable
`paperclip.profit_flywheel_two_iteration_closeout.v1` receipts and one
`fixture-20-cycle-acceptance.json` aggregate. Re-running identical inputs is
idempotent. A partial run, repeated/nested isolation root, live target, mutable
or hash-mismatched artifact, unchanged output hash, delayed/manual continuation,
or non-pending next research event fails closed and produces no success claim.

## Read API

Authenticated clients may fetch:

```text
GET /api/companies/:companyId/profit-flywheel/factory-health
POST /api/companies/:companyId/profit-flywheel/factory-pause {"confirm":true}
POST /api/companies/:companyId/profit-flywheel/factory-launch-proposals
POST /api/profit-flywheel/stages/:stageRunId/resume
GET /api/adapters
POST /api/adapters/hermes_local/managed-rollback
```

The response is validated as
`paperclip.profit_flywheel_factory_health.v1` from `@paperclipai/shared` and is
served with `Cache-Control: no-store`. Company access is checked before any
snapshot is returned.

## Verification commands

```bash
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/ui typecheck
pnpm exec vitest run \
  packages/shared/src/profit-flywheel-factory-health.test.ts \
  server/src/__tests__/software-factory-health.test.ts \
  ui/src/lib/software-factory.test.ts \
  ui/src/lib/company-routes.test.ts
```

For a worktree that deliberately shares dependencies with another checkout,
verify that workspace package links resolve back into the worktree before
treating a server test as evidence.
