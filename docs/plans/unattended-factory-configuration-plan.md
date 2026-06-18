# Unattended Factory Configuration Plan

Date: 2026-06-13

Status: approval package. This document is the operating plan to apply after CEO/board approval. It is not a receipt that the live cockpit has already been reconfigured.

## Source Of Truth

This plan uses Paperclip state and Paperclip docs as the source of truth:

- Paperclip live cockpit database under `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit`
- Paperclip routine, agent, issue, run, comment, secret, and context-ledger state
- `docs/course_correction/VISION_AND_GOALS.md`
- `docs/portfolio_os_cockpit.md`
- `docs/api/routines.md`
- `docs/adapters/opencode-local.md`
- `docs/adapters/context-ledger.md`
- `docs/guides/board-operator/managing-agents.md`
- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/scrapegraph-docs-context.json`
- `graphify-out/scrapegraph-docs-dry-run.json`
- `graphify-out/codex-openai-docs-extraction.json`

Repositories and file changes are supporting evidence only when they prove which runtime contract exists. The live cockpit configuration and durable Paperclip records determine what should run.

## Current Operating Reality

Paperclip's intended factory model is clear:

- Paperclip is the governed control plane.
- Portfolio OS is the deterministic truth plane.
- No routine should exist without an explicit success condition and artifact.
- Unattended work should produce reviewable closure, not just more tickets.
- Routine families must coalesce, skip, or pause under overlap instead of unbounded enqueue.
- Release and deploy remain approval-gated.
- Provider recovery is automatic only through MiniMax unless post-MiniMax approval is explicit.

The current live cockpit does not yet match that operating model. The active code now supports actionability preflight, duplicate-loop suppression, provider backoff, credential blockers, workspace gates, structured final dispositions, and ship-captain lanes, but the live cockpit database still needs migration/configuration to turn those contracts on for existing companies and routines.

Live state observed before this plan:

- 4 active companies.
- 60 agents.
- 73 routines total.
- 26 active routines.
- 0 active routines with a `paperclip_actionability` contract.
- 0 MiniMax-pinned agents.
- 0 company secrets.
- Live server was healthy on `http://127.0.0.1:3100/api/health`, but the observed server process predated the commit containing the new actionability implementation.
- Config and runtime port evidence diverged: config references port 3180, while the live server was on 3100.

## Company Snapshot

### Portfolio OS Orchestrator

Mandate: keep Portfolio OS as the canonical author of frozen selections, snapshots, scaffolds, and dispatch artifacts while Paperclip orchestrates review, approvals, and company-scoped execution.

Observed state:

- 24 agents.
- Agent statuses: 16 idle, 6 error, 2 terminated.
- 12 active routines out of 22.
- 0 of 12 active routines have actionability contracts.
- Open issue pressure includes 245 routine `in_progress` issues, 42 routine `todo` issues, and 2 routine `blocked` issues.
- Last-24-hour run pressure: 55 runs; 44 failed, 9 succeeded, 2 cancelled.
- Error families include connection errors, OpenCode monthly quota, spawn failures, token-plan quota, and provider preflight failures.

Primary configuration need: actionability on all active routines, lower-frequency governance lanes, artifact-hash suppression, and one open execution issue per routine family.

### YT-Synth

Mandate: move from Portfolio OS-selected venture execution into one shipped proof artifact and measured distribution move without losing release-gate evidence or credential control.

Observed state:

- 12 agents.
- Agent statuses: 7 error, 4 idle, 1 terminated.
- 9 active routines out of 9.
- 0 of 9 active routines have actionability contracts.
- Open issue pressure includes 709 routine `in_progress` issues, 580 routine `todo` issues, and 48 routine `blocked` issues.
- Duplicate routine families dominate: Dispatch Poller, Release Gate, Run QA, Evidence Backfill.
- Last-24-hour run pressure: 328 runs; 262 failed, 43 cancelled, 23 succeeded.
- Routine runs were creating issues more often than they were completing useful closures.

Primary configuration need: freeze duplicate pollers, collapse work into standing lane issues per run id, require credentials before outreach/deploy, use the Release Gate Reconciler as the ship-captain lane, and suppress unchanged artifact wakes.

### LeadForge

Mandate: execute release, QA, deploy, and evidence workflows only when credentials and workspaces are actually ready, while keeping LeadForge out of unrelated Portfolio OS selection work.

Observed state:

- 12 agents.
- Agent statuses: 7 error, 5 idle.
- 4 active routines out of 37.
- 0 of 4 active routines have actionability contracts.
- Open issue pressure includes 85 routine `in_progress` issues, 14 routine `todo` issues, and 8 routine `blocked` issues, plus manual blocked/in-review work.
- Duplicate routine families include Release Readiness Reconciler, QA Gate Reconciler, Operating Contract Drift Monitor, and Evidence and Distribution Reconciler.
- Last-24-hour run pressure: 37 runs; 30 failed, 7 succeeded.

Primary configuration need: treat the Fly.io deploy token as a board-owned credential blocker, collapse release/QA/evidence reconcilers into standing lanes, require clean release workspaces, and block deploy/outreach routines until secrets are present.

### agency-swarm

Mandate: either become a configured unattended execution lane with a real ship-captain path or remain paused so it does not consume factory attention.

Observed state:

- 12 agents.
- Agent statuses: 7 paused, 3 idle, 1 error, 1 terminated.
- 1 active routine out of 5.
- 0 of 1 active routines has an actionability contract.
- Open issue pressure is mostly routine `in_progress` governance drift plus a small number of manual issues.
- Last-24-hour run pressure: 11 runs; 9 failed, 2 succeeded.

Primary configuration need: keep paused/archive by default unless a real execution mandate, credential set, and ship-captain lane are approved.

## Graph Read

Graphify currently shows the core unattended-factory abstractions clustered around:

- Routine actionability preflight.
- Credential blockers.
- Duplicate-loop suppression.
- Workspace cleanliness gates.
- Provider routing and MiniMax-first recovery.
- Context ledger final disposition.
- Portfolio OS cockpit truth-plane boundaries.
- Release Gate Reconciler as ship captain.

The graph also exposes the current gaps:

- MiniMax-backed ScrapeGraphAI multi-source extraction failed with `Connection error`.
- Native Codex CLI/OpenAI extraction was needed to create usable docs context.
- The plan doc must be part of the graph so future operators do not rediscover the same operating contract from scattered docs.
- Runtime drift cannot be proven from docs alone; it needs a fresh live guard receipt after restart.

## Viability Reassessment

The recommended configuration changes remain viable with two important adjustments.

First, do not treat "routine created" or "run succeeded" as factory progress. The readiness proof must be a context-ledger-backed canary with issue closure, receipt path, changed-file evidence when applicable, passing tests when applicable, context-pack refs, and provider routing evidence.

Second, the system should not run more agents to discover a known blocker. Known blocker classes should become deterministic state rows and one standing guard issue:

- `waiting_for_human_credential`
- `waiting_for_security_fix`
- `waiting_for_clean_workspace`
- `waiting_for_provider_capacity`
- `waiting_for_artifact_change`
- `ready_for_qa`
- `ready_to_ship`
- `ready_for_distribution`

Agents should wake only in states where they can act.

## Target Configuration Contract

Every unattended routine must have a `paperclip_actionability` contract with at least:

- `lane`: product_execution, release, qa, deploy, distribution, evidence, governance, maintenance, or ship_captain.
- `state`: one of the explicit blocker or ready states.
- `blockerOwner`: agent, operator, board, provider, workspace_owner, or external.
- `requiredSecretNames`: required credential names for deploy/outreach lanes.
- `upstreamArtifactHash`: hash of the dispatch, gate, receipt, or workspace state the routine is reacting to.
- `cadenceGroup`: product, release, governance, or maintenance.
- `minCadenceMinutes`: lower frequency for governance and maintenance lanes.
- `requiresCleanWorkspace`: true for QA, release, deploy, ship, and outreach lanes.
- `standingIssueKey`: deterministic key for the lane/run/company blocker.
- `shipCaptain`: true only for the one lane that owns release sequencing for that run.

Provider routing must be:

- OpenCode Go role defaults for normal operation.
- MiniMax first automatic degraded lane through `hermes_minimax`.
- MiniMax model-access rotation inside MiniMax only.
- Hard stop after MiniMax unless explicit post-MiniMax approval flags are set.
- No low-intelligence free fallback for executive, strategy, PM, research, QA, or design work.

Credential configuration must be:

- LeadForge deploy: blocked until Fly.io token is present.
- YT-Synth distribution/outreach: blocked until social/email credentials are present.
- Company secrets are not optional for lanes that need them.
- Missing credentials create/reuse one board-owned factory guard issue and suppress repeat wakes.

Workspace configuration must be:

- Release, QA, deploy, ship, and outreach lanes run dirty-workspace classification before wake.
- Unrelated or unresolved dirty files create/reuse one cleanup issue.
- The release/QA polling routine stays skipped until the cleanup issue is done.

Governance configuration must be:

- Operating-contract drift, skill sync, health checks, and graph refresh run on lower-frequency maintenance lanes.
- Maintenance lanes do not compete with release, QA, deploy, customer-signal, or distribution lanes.

Final disposition configuration must be:

- Every agent final result must include one of `advanced_vision`, `maintenance`, `blocked`, `noop`, or `misaligned`.
- Every final result must include `nextActionOwner` when follow-up belongs to another owner.
- Missing dispositions are treated as a configuration defect and inferred conservatively by the context ledger.

## Execution Plan After Approval

1. Freeze scheduled churn.
   - Disable or pause active unattended routine wakes while migration is running.
   - Keep manual operator actions available.
   - Snapshot the cockpit database before mutation.

2. Restart onto the current code.
   - Ensure the live cockpit process is running the commit that contains actionability preflight.
   - Verify exactly one intended listener.
   - Verify `/api/health`.
   - Verify runtime drift with a fresh guard receipt.

3. Attach actionability contracts to all active routines.
   - Portfolio OS Orchestrator: all 12 active routines.
   - YT-Synth: all 9 active routines.
   - LeadForge: all 4 active routines.
   - agency-swarm: the 1 active routine, or pause/archive it if no mandate is approved.

4. Collapse duplicate routine families.
   - Convert repeated Dispatch Poller, Release Gate, Run QA, Evidence Backfill, QA Gate, Release Readiness, and Operating Contract Drift loops into standing lane issues.
   - Preserve history; do not delete audit evidence.
   - New issue only when blocker class or run id changes.

5. Configure provider routing.
   - Keep OpenCode Go role defaults.
   - Add or verify MiniMax degraded lane.
   - Do not enable post-MiniMax fallbacks without explicit board approval.
   - Create one portfolio-level execution-capacity issue if provider capacity is degraded.

6. Configure credential blockers.
   - Create board-owned factory guard issues for LeadForge Fly.io and YT-Synth distribution credentials.
   - Add `requiredSecretNames` to affected routines.
   - Keep deploy/outreach routines skipped until the required secrets exist.

7. Configure workspace cleanliness gates.
   - Enable dirty-workspace classification for QA/release/deploy/ship/outreach lanes.
   - Create one cleanup issue per affected company/workspace.
   - Suppress release polling until cleanup is resolved.

8. Separate product execution from maintenance.
   - Move drift/skill/health/graph checks into lower-frequency maintenance cadence.
   - Keep product, release, QA, deploy, and customer-signal lanes prioritized.

9. Enforce structured final dispositions.
   - Require final disposition fields in local adapter prompts and run finalization.
   - Validate that portfolio reporting can aggregate `advanced_vision`, `maintenance`, `blocked`, `noop`, and `misaligned` without manual interpretation.

10. Verify with bounded live tests.
    - Trigger one routine per blocker class and confirm deterministic skip rather than agent wake.
    - Trigger one ready lane and confirm one issue-linked run with context-ledger evidence.
    - Confirm duplicate-loop suppression pauses after the configured fingerprint threshold.
    - Confirm flywheel-health canary evidence before declaring the unattended factory operational.

## Company-Specific Next Highest-Leverage Action

Portfolio OS Orchestrator: restart onto current code, attach actionability contracts to the 12 active routines, and lower the maintenance cadence so governance does not crowd out dispatch closure.

YT-Synth: freeze duplicate pollers and migrate to one standing release-gate issue per run id, with the Release Gate Reconciler as ship captain.

LeadForge: create the Fly.io credential guard and make deploy/release routines skip deterministically until the token exists.

agency-swarm: keep paused/archive unless a concrete execution mandate is approved; otherwise attach a minimal actionability contract and low-frequency maintenance state.

## Approval Requested

Approve the following before live mutation:

- Pause/suppress active unattended scheduled wakes during migration.
- Snapshot the cockpit database.
- Restart the cockpit onto the current Paperclip code.
- Mutate active routine contracts in the live cockpit database.
- Create or reuse board-owned factory guard issues for missing credentials and provider capacity.
- Collapse duplicate routine families into standing lane issues without deleting audit history.
- Keep post-MiniMax fallback disabled unless separately approved.
- Run bounded live verification after migration.

## Non-Goals Until Approved

- Do not execute production deploys.
- Do not send outbound outreach.
- Do not enable post-MiniMax paid fallback lanes.
- Do not delete historical issues, comments, runs, or logs.
- Do not infer runtime health from docs or graph artifacts; require a fresh guard receipt.
