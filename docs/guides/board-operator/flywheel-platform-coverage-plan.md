# Autonomous Software Factory Flywheel Coverage Plan

Last updated: 2026-06-21

This report extends the skill-context/cache tokenomics report by turning its
cost controls into an execution coverage contract. The missing layer was not
another provider cap; it was an explicit map of which platform owns each stage,
what evidence each stage must produce, and which stations are allowed to spend
model tokens.

## What Was Missed

1. **Run QA Sweep had no deterministic station.** The cockpit seeds `Run QA
   Sweep`, but the default routine adapter only covered dispatch polling,
   evidence backfill, release gate, and skill inventory. That left QA free to
   spend model tokens just to resolve dispatch paths, target surfaces, and
   artifact locations. This pass adds
   `scripts/process-runbooks/run-qa-sweep-runner.mjs` and defaults
   `routine_key: "run-qa-sweep"` to the process adapter.

2. **The reports optimized token spend but did not define complete station
   coverage.** Token caps are necessary, but they do not prove the factory
   delivered the finished product. The durable measure has to be final
   deliverables with receipts: research evidence, dispatch artifact, build
   result, QA report, screenshots, regression notes, release gate result, and
   learning sync.

3. **Tool capabilities were documented as available, not required.** ScrapeGraphAI,
   Graphify, GStack, GBrain, and context packs need station-level contracts.
   Otherwise they are suggestions that agents can skip under context pressure.

4. **Provider capabilities were not encoded as lane policy.** Claude Code,
   Gemini CLI/API, MiniMax, OpenAI/Codex, Hermes, and process adapters have
   different quota, cache, context-window, and tool-interaction shapes. Routing
   should select the cheapest platform that can produce the required receipt,
   not the first provider that is currently online.

5. **Codex-side research can fail without entering the cockpit ledger.** If
   portfolio-os research runs in Codex but does not write a digest or receipt
   into the Paperclip flywheel, downstream Paperclip/Hermes runs either miss
   the insight or reload excessive history.

6. **Context-pack freshness was advisory.** Map/delta/core packs exist, but
   every model-bearing stage should hard-record which pack was used, its age,
   and why a larger pack was needed.

## Platform Capability Matrix

| Platform | Best Use | Required Receipt |
| --- | --- | --- |
| Portfolio OS | Source-of-truth research, freeze, dispatch, Internet Pipes evidence | Immutable dispatch JSON, selection snapshot, authority hashes |
| Paperclip Cockpit | Governance, scheduling, actionability, context ledger, provider routing | Issue, routine run, adapter result JSON, context ledger rows |
| Paperclip Process Adapter | Deterministic work with scriptable acceptance | `PAPERCLIP_ADAPTER_RESULT_JSON`, issue `done`/`blocked`, zero provider tokens |
| Hermes Agent | Model-bearing implementation and judgment when deterministic scripts cannot finish | Result path, execution log, token usage, changed files, issue update |
| GStack | QA, review, ship, POS artifact interpretation | `qa_report.md`, screenshots, regression notes, review/ship report |
| ScrapeGraphAI | Structured external evidence extraction | JSON extraction receipt with source URLs, timestamps, schema version |
| Graphify | Repo and dependency graph intelligence | Graph report, symbol/dependency map, source commit hash |
| GBrain | Semantic memory and prior-learning lookup | Indexed-state receipt, query summary, cited memory ids |
| Repomix/context packs | Low-cost repo context transfer | Map/delta/core pack path, age, profile, estimated tokens |
| Claude Code | Subscription-backed short and medium code/review tasks; Sonnet/Haiku selection by complexity | Claude Code transcript or result path, model, cache status |
| Gemini CLI/API | Subscription/OAuth fallback for normal CLI tasks; API/Vertex lane for explicit cache-heavy long context | Gemini run transcript, quota/cache source, model |
| MiniMax | High-throughput subscription lane while quota is open | Quota window, model, run session id, token usage |
| OpenAI/Codex | Architecture, adversarial review, high-judgment planning, cross-system synthesis | Codex transcript/report, prompt-cache usage where available |

Provider capability notes:

- Anthropic prompt caching is strongest when the stable prefix is kept unchanged
  and cacheable blocks are ordered before volatile content:
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code uses prompt caching automatically, but subagents can invalidate
  cache benefits when they carry divergent context:
  https://code.claude.com/docs/en/prompt-caching
- Gemini CLI token caching is available for API-key and Vertex AI flows, while
  OAuth personal subscription flows do not expose the same explicit cache path:
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/token-caching.md
- Gemini API explicit caching is a separate API capability for long-context
  repeated inputs:
  https://ai.google.dev/gemini-api/docs/caching
- MiniMax token plans expose subscription-token behavior and plan-window
  constraints that should be treated as routing capacity, not infinite spend:
  https://platform.minimax.io/docs/token-plan/intro
- OpenAI prompt caching applies automatically for prompts over the caching
  threshold and should be measured through cached token usage:
  https://developers.openai.com/api/docs/guides/prompt-caching

## Flywheel Coverage Contract

Every flywheel stage should be represented as a contract row with these fields:

| Field | Meaning |
| --- | --- |
| `stage` | `research`, `evidence`, `dispatch`, `implementation`, `qa`, `release`, `learning` |
| `owner_plane` | Portfolio OS, Paperclip, process adapter, Hermes, GStack, Codex, Gemini, Claude |
| `trigger_signal` | The file, issue, timer, approval, or user action that starts the stage |
| `minimal_context` | Exact authority files, context pack profile, or memory query allowed |
| `allowed_tools` | Named tools/skills required or allowed for the stage |
| `provider_policy` | Deterministic first, then cheapest capable subscription/API lane |
| `receipt_paths` | Files or DB rows that prove completion |
| `pass_fail_rule` | Concrete done/blocked criteria |
| `token_budget` | Expected ceiling plus the condition that allows escalation |

## Company Go-Live Progress Contract

The runtime now treats "success" as company-specific go-live progress, not a
generic completed agent turn. Every model-bearing adapter prompt asks agents to
emit:

- `finalDisposition`: `advanced_vision`, `maintenance`, `blocked`, `noop`, or
  `misaligned`, plus `nextActionOwner` when another owner must act.
- `goLiveDelta`: `milestone_progress`, `artifact_delivery`, `handoff`,
  `truthful_blocker`, `maintenance`, `noop`, or `misaligned`, plus the company
  milestone, artifact receipt, handoff target, or blocker owner that proves the
  delta.

The context ledger stores both the raw `goLiveDelta` and a normalized
`goLiveDeltaEvaluation`. Tokenomics only counts ledger-backed final deliverables
when the entry is issue-bound, artifact-backed, outcome-successful, and has a
valuable go-live delta. Mission traces flag agents whose runs succeed but fail
to close any company go-live gap.

Future Portfolio OS dispatch companies inherit a
`company_vision_contract` in their portfolio dispatch metadata. The contract
defines the go-live target, current milestones, role missions, expected handoff
edges, progress signals, and blocker routing defaults for the created company.

Board-owned blockers now route into approvals instead of only becoming issues:

- Credential and provider-capacity blockers create/reuse
  `factory_blocker_routing` approvals with route `request_board_approval`.
- Duplicate routine loops create/reuse approvals with route `refactor_decision`
  linked to the kept issue after duplicates are cancelled.
- Workspace and implementation blockers remain agent-owned issue work unless
  they are escalated by an explicit approval request.

## Coverage Structure

### 1. Research and Opportunity Discovery

- Portfolio OS owns source authority: research outputs, freeze inputs, market
  signals, and dispatch candidates.
- Codex/OpenAI should be used for architecture-level synthesis only when the
  output is a committed or ingested report, not an isolated chat conclusion.
- ScrapeGraphAI must write structured evidence receipts for external pages.
- GBrain should answer "has this been learned before?" with citations before a
  large model context is built.

Acceptance:

- Research cannot advance unless the cockpit has an issue-linked receipt path.
- Any Codex-side insight must be summarized into the Paperclip context ledger or
  a Portfolio OS artifact before downstream Hermes work begins.

### 2. Dispatch and Actionability

- Portfolio OS emits immutable dispatch and selection snapshot artifacts.
- Paperclip ingests the artifacts and creates issue contracts with hashes,
  routine keys, blocker class, owner, and minimal context references.
- Process adapter handles dispatch parity checks before model work.

Acceptance:

- Hash mismatch, missing source artifact, or missing issue linkage blocks the
  lane before any provider call.

### 3. Implementation

- Process adapter owns deterministic build steps, validators, formatters, and
  scripted reconciliations.
- Hermes owns code changes that require judgment and repository interaction.
- Graphify should provide symbol/dependency context before broad file reads.
- Repomix map/delta packs must be attempted before core packs.

Acceptance:

- Implementation is not complete until it produces changed files, tests, docs
  when user-facing, and a result receipt tied to the issue/run id.

### 4. QA

- `Run QA Sweep` is now a process-plane default for the standard POS surface
  sweep.
- The runbook resolves the dispatch contract with gstack, creates the QA
  verification artifact, selects a local HTML surface or explicit target URL,
  captures desktop/mobile screenshots, writes `qa_report.md`, writes
  `regression_notes.md`, and patches the issue `done` or `blocked`.
- GStack remains the human/agent workflow for deeper exploratory QA when the
  deterministic sweep finds a product-specific flow that cannot be scripted.

Acceptance:

- No screenshot and report means no QA pass.
- No target surface means `blocked`, not "success".
- Internet Pipes gaps block release readiness even if browser checks pass.

### 5. Release

- Process adapter owns release-gate reconciliation when the target repo has a
  scriptable gate.
- Ship-capable model lanes are only used after process gates prove what is still
  missing.

Acceptance:

- Approval state, branch state, release-gate command, hashes, and dirty paths are
  recorded in the release report.

### 6. Learning and Recursion

- Paperclip writes final outcome, provider usage, context ledger, and artifact
  references.
- GBrain stores reusable learning only after the final deliverable is verified.
- Context packs are refreshed when older than 24 hours, after branch changes, or
  before large-context handoff.

Acceptance:

- The next run gets a compact digest and artifact pointers, not full prior
  conversation history.

## Implementation Checklist

Implemented in this pass:

- Added `scripts/process-runbooks/run-qa-sweep-runner.mjs`.
- Added default `run_qa_sweep` process-adapter routing in
  `server/src/services/routines.ts`.
- Added regression coverage for routine routing and runbook success/block
  behavior.
- Added `config/flywheel_coverage.json` as the machine-readable station
  contract for research, dispatch, evidence, implementation, QA, release, and
  learning.
- Dispatch provisioning now validates seeded Portfolio OS routines against the
  flywheel coverage manifest before creating work.
- Added deterministic `evidence-backfill-reconciler` process-adapter routing so
  the evidence station does not default to model spend.
- Hardened the evidence station runbook so Paperclip reconciles dispatch,
  selection, and dossier artifacts internally before spending provider tokens or
  depending on target-repo scripts.
- Updated routine actionability so repeated system-owned cadence and
  upstream-artifact waits reschedule within a one-hour recovery window up to
  three times per fingerprint, create one self-healing guard at cap, and keep
  Portfolio OS strategic flywheel routines active.
- Reconciler passes now restore disabled active execution schedules that are not
  owned by a workspace, paused-routine, or duplicate-maintenance guard, so a
  routine cannot remain active but unschedulable because of a stale trigger flag.
- Added a Council Ideation Mandate for Portfolio OS council triage so the
  council evaluates repositories as products, reskins, standalone offers, and
  combined solutions instead of waiting indefinitely for a perfect launch target.
  Council routines now branch distinct hypotheses into child issues, use a
  score >= 70 evidence gate, persist scratch output in the
  `council-hypothesis-ledger` issue document, and mirror durable copies into
  Portfolio OS `data/council_hypotheses/paperclip/`.
- The tokenomics watch now emits `activeRunFlywheelCoverage`, which groups
  queued/running work by stage, routine contract, provider lane, context-pack
  profile, and pending receipts.
- Adapter results now support a stable `providerLane` envelope for cache mode,
  cache tokens, quota source/status, context-pack profile, selected lane, and
  escalation reason. Process runbooks can promote this metadata through
  `PAPERCLIP_ADAPTER_RESULT_JSON`.
- Flywheel health now reports manifest-backed `stageCoverage` so completed
  issue-linked runs are evaluated as station receipts, not just raw run
  successes.

Next hardening work:

- Add executable validators for ScrapeGraphAI, Graphify, and GBrain receipt
  schemas so the cockpit can enforce evidence and memory usage rather than
  relying on prompt guidance.
- Add a Codex research ingest command that writes Codex-side findings into the
  Paperclip context ledger and Portfolio OS artifact index.
- Add a flywheel health board that groups work by stage and flags runs that
  produce ingredients without a final deliverable.

## Operating Rule

The factory should route each station in this order:

1. Deterministic process adapter when a receipt can be produced by code.
2. Existing artifact/context pack/memory lookup when the question is already
   answered.
3. Cheapest subscription-capable model lane that can finish the receipt.
4. Highest-judgment model only when the required deliverable cannot be produced
   by lower lanes.

The output target is the final deliverable on the table: shipped artifact,
verified QA evidence, release decision, or compact learning receipt. Runs,
patches, and model responses are only ingredients unless they produce that
receipt.
