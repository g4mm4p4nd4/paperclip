# Graph Report - /Users/mnm/Documents/Github/paperclip  (2026-06-14)

## Corpus Check
- 23 files · ~5,871 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 342 nodes · 647 edges · 20 communities detected
- Extraction: 50% EXTRACTED · 50% INFERRED · 0% AMBIGUOUS · INFERRED: 326 edges (avg confidence: 0.58)
- Token cost: 83,999 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `Context ledger` - 58 edges
2. `Native Codex CLI OpenAI extraction` - 23 edges
3. `ingestPortfolioDispatchFile()` - 21 edges
4. `docs/api/routines.md` - 18 edges
5. `asNonEmptyString()` - 17 edges
6. `extractPortfolioDispatchContract()` - 16 edges
7. `readString()` - 16 edges
8. `asRecord()` - 14 edges
9. `docs/guides/board-operator/managing-agents.md` - 14 edges
10. `Unattended Factory Configuration Plan` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Expected local layout` --rationale_for--> `extractPortfolioDispatchContract()`  [INFERRED]
  docs/portfolio_os_cockpit.md → server/src/services/routines.ts
- `Rollback switch` --rationale_for--> `extractPortfolioDispatchContract()`  [INFERRED]
  docs/portfolio_os_cockpit.md → server/src/services/routines.ts
- `Ship Captain Lane` --rationale_for--> `extractPortfolioDispatchContract()`  [INFERRED]
  docs/portfolio_os_cockpit.md → server/src/services/routines.ts
- `Non-Negotiables` --rationale_for--> `extractPortfolioDispatchContract()`  [INFERRED]
  docs/course_correction/VISION_AND_GOALS.md → server/src/services/routines.ts
- `Success Metrics For This Session` --rationale_for--> `extractPortfolioDispatchContract()`  [INFERRED]
  docs/course_correction/VISION_AND_GOALS.md → server/src/services/routines.ts

## Communities

### Community 0 - "asNonEmptyString() / asRecord()"
Cohesion: 0.07
Nodes (75): adapterSupportsOpenCodeGoRoleRouting(), adapterSupportsTieredExecutionFallback(), asNonEmptyString(), asRecord(), asStringArray(), buildClaudeFallbackConfig(), buildCodexFallbackConfig(), buildFallbackConfig() (+67 more)

### Community 1 - "Context ledger / readString()"
Cohesion: 0.08
Nodes (46): Context ledger, artifactRefKey(), asArray(), asRecord(), classifyOutputBudget(), collectContextPackProfiles(), cursorTimestamp(), extractContextPackRefs() (+38 more)

### Community 2 - "extractRoutineActionabilityContract() / Routine Actionability Preflight"
Cohesion: 0.06
Nodes (39): Credential Blocker, Duplicate Loop Suppression, Routine Actionability Preflight, Workspace Cleanliness Gate, Credential Blocker, Routine Actionability Preflight, Workspace Cleanliness Gate, Credential Blocker (+31 more)

### Community 3 - "ingestPortfolioDispatchFile() / ensureLegacyDispatchDossierCompatibility()"
Cohesion: 0.09
Nodes (41): asRecord(), buildMetadataContract(), buildPortfolioDispatchDeps(), compatibilityDossierFreshnessStatus(), compatibilityDossierGateStatus(), createPortfolioDispatchIngestWorker(), deriveRoutineTitle(), deriveRunProjectName() (+33 more)

### Community 4 - "Native Codex CLI OpenAI extraction / Unattended Factory Configuration Plan"
Cohesion: 0.06
Nodes (36): Approve pausing or suppressing active unattended scheduled wakes during migration before live mutation., Do not approve deletion of historical issues, comments, runs, or logs., Keep release/merge tied to launch_execution approval and production deploy approval-required., Require board-capable authority for cross-company route-to-existing-venture actions or fail with a blocking artifact., Approve snapshotting the cockpit database before mutation., Approve restarting the cockpit onto current Paperclip code and verifying exactly one intended listener, /api/health, and a fresh runtime drift guard receipt., Approve mutating active routine contracts in the live cockpit database., Approve creating or reusing board-owned factory_guard issues for missing credentials and provider capacity. (+28 more)

### Community 5 - "extractPortfolioDispatchContract() / Create Routine"
Cohesion: 0.1
Nodes (28): Create Routine, Daily Cadence, Non-Negotiables, Success Metrics For This Session, Vision, docs/course_correction/VISION_AND_GOALS.md, Weekly Cadence, Agent Hiring via Governance (+20 more)

### Community 6 - "Add Trigger / Agent Access Rules"
Cohesion: 0.15
Nodes (13): Add Trigger, Agent Access Rules, Delete Trigger, Fire Public Trigger, Get Routine, List Routines, List Runs, Manual Run (+5 more)

### Community 7 - "Routine actionability preflight / Provider reliability gate"
Cohesion: 0.17
Nodes (12): Credential blocker, Duplicate-loop suppression, Hermes MiniMax degraded lane, Live cockpit database, Lower-frequency maintenance lane, OpenCode Go role defaults, Post-MiniMax approval boundary, Provider reliability gate (+4 more)

### Community 8 - "Immutable Portfolio OS dispatch artifact / Internet Pipes readiness contract"
Cohesion: 0.33
Nodes (6): Immutable Portfolio OS dispatch artifact, Internet Pipes readiness contract, Launch execution approval, Paperclip governed control plane, Portfolio OS truth plane, Release Gate Reconciler ship-captain lane

### Community 9 - "ScrapeGraph receipt scrapegraph-docs-context.json: ERROR / MiniMax OpenAI endpoint connection er"
Cohesion: 0.5
Nodes (4): MiniMax OpenAI endpoint connection error, ScrapeGraph model minimax/MiniMax-M3, ScrapeGraph receipt scrapegraph-docs-context.json: ERROR, ScrapeGraph status ERROR

### Community 10 - "ScrapeGraph receipt scrapegraph-docs-dry-run.json: OK / ScrapeGraph model minimax/MiniMax-M3"
Cohesion: 0.67
Nodes (3): ScrapeGraph model minimax/MiniMax-M3, ScrapeGraph receipt scrapegraph-docs-dry-run.json: OK, ScrapeGraph status OK

### Community 11 - "context_ledger_entries.ts"
Cohesion: 1.0
Nodes (0): 

### Community 12 - "heartbeat_runs.ts"
Cohesion: 1.0
Nodes (0): 

### Community 13 - "agent_wakeup_requests.ts"
Cohesion: 1.0
Nodes (0): 

### Community 14 - "agents.ts"
Cohesion: 1.0
Nodes (0): 

### Community 15 - "issues.ts"
Cohesion: 1.0
Nodes (0): 

### Community 16 - "company_secrets.ts"
Cohesion: 1.0
Nodes (0): 

### Community 17 - "cost_events.ts"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "flywheel_health_reports.ts"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "Factory guard issue"
Cohesion: 1.0
Nodes (1): Factory guard issue

## Knowledge Gaps
- **68 isolated node(s):** `List Routines`, `Get Routine`, `Update Routine`, `Add Trigger`, `Update Trigger` (+63 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `context_ledger_entries.ts`** (1 nodes): `context_ledger_entries.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `heartbeat_runs.ts`** (1 nodes): `heartbeat_runs.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `agent_wakeup_requests.ts`** (1 nodes): `agent_wakeup_requests.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `agents.ts`** (1 nodes): `agents.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `issues.ts`** (1 nodes): `issues.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `company_secrets.ts`** (1 nodes): `company_secrets.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `cost_events.ts`** (1 nodes): `cost_events.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `flywheel_health_reports.ts`** (1 nodes): `flywheel_health_reports.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Factory guard issue`** (1 nodes): `Factory guard issue`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Context ledger` connect `Context ledger / readString()` to `extractPortfolioDispatchContract() / Create Routine`, `Routine actionability preflight / Provider reliability gate`?**
  _High betweenness centrality (0.212) - this node is a cross-community bridge._
- **Why does `Create Routine` connect `extractPortfolioDispatchContract() / Create Routine` to `asNonEmptyString() / asRecord()`, `Context ledger / readString()`, `extractRoutineActionabilityContract() / Routine Actionability Preflight`, `Add Trigger / Agent Access Rules`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `Creating Agents` connect `extractPortfolioDispatchContract() / Create Routine` to `asNonEmptyString() / asRecord()`, `Context ledger / readString()`, `extractRoutineActionabilityContract() / Routine Actionability Preflight`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Are the 15 inferred relationships involving `Context ledger` (e.g. with `Create Routine` and `Structured Final Disposition`) actually correct?**
  _`Context ledger` has 15 INFERRED edges - model-reasoned connections that need verification._
- **Are the 20 inferred relationships involving `ingestPortfolioDispatchFile()` (e.g. with `sha256()` and `dispatchLedgerEntriesForRun()`) actually correct?**
  _`ingestPortfolioDispatchFile()` has 20 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `asNonEmptyString()` (e.g. with `shouldReprobeProviderStallsForRun()` and `selectFallbackModel()`) actually correct?**
  _`asNonEmptyString()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **What connects `List Routines`, `Get Routine`, `Update Routine` to the rest of the system?**
  _68 weakly-connected nodes found - possible documentation gaps or missing edges._

## Scoped Build Note

This graph is scoped to unattended-factory behavior. It includes Graphify AST extraction for the relevant Paperclip implementation files, deterministic local documentation extraction, the approval plan doc, MiniMax ScrapeGraphAI receipts, and the successful native Codex CLI/OpenAI extraction receipt. The MiniMax multi-source ScrapeGraphAI receipt remains in the graph as blocker evidence because it failed with `Connection error`; the native Codex/OpenAI receipt is the current successful docs-context extraction.
