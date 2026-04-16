# Staged Backlog Audit

Date: 2026-04-15

## Scope

This audit covers the staged backlog in the primary local checkout at [`/Users/mnm/Documents/Github/paperclip`](/Users/mnm/Documents/Github/paperclip:1).

- Total staged paths at audit time: `427`
- Kept in current merge scope: `132`
- Deferred from current merge scope: `295`

## Age

The backlog is recent, not abandoned archaeology.

- `ui/`: median upstream file recency `5` days, max `16` days
- `server/`: median upstream file recency `4` days, max `9` days
- `packages/`: median upstream file recency `6` days, max `16` days
- Overall interpretation:
  - most of the work was touched within the last one to two weeks
  - the cleanup decision is therefore based on present fit, not age alone

## Keep Now

These slices directly support the repaired venture-factory/control-plane path:

1. Dispatch ingest and route closure
   - [`server/src/services/portfolio-dispatch.ts`](/Users/mnm/Documents/Github/paperclip/server/src/services/portfolio-dispatch.ts:1)
   - [`server/src/__tests__/portfolio-dispatch.test.ts`](/Users/mnm/Documents/Github/paperclip/server/src/__tests__/portfolio-dispatch.test.ts:1)
   - Why:
     - converts Portfolio-OS dispatches into durable Paperclip issues
     - preserves legacy dossier compatibility
     - keeps the route-to-existing-venture handoff auditable

2. Execution policy and approval enforcement
   - [`server/src/services/issue-execution-policy.ts`](/Users/mnm/Documents/Github/paperclip/server/src/services/issue-execution-policy.ts:1)
   - [`server/src/routes/issues.ts`](/Users/mnm/Documents/Github/paperclip/server/src/routes/issues.ts:1)
   - [`server/src/routes/approvals.ts`](/Users/mnm/Documents/Github/paperclip/server/src/routes/approvals.ts:1)
   - [`packages/db/src/schema/issue_execution_decisions.ts`](/Users/mnm/Documents/Github/paperclip/packages/db/src/schema/issue_execution_decisions.ts:1)
   - [`packages/db/src/schema/issue_relations.ts`](/Users/mnm/Documents/Github/paperclip/packages/db/src/schema/issue_relations.ts:1)
   - [`packages/shared/src/types/issue.ts`](/Users/mnm/Documents/Github/paperclip/packages/shared/src/types/issue.ts:1)
   - [`packages/shared/src/validators/issue.ts`](/Users/mnm/Documents/Github/paperclip/packages/shared/src/validators/issue.ts:1)
   - [`ui/src/components/ApprovalCard.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/components/ApprovalCard.tsx:1)
   - [`ui/src/components/ApprovalPayload.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/components/ApprovalPayload.tsx:1)
   - [`ui/src/pages/Approvals.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/Approvals.tsx:1)
   - Why:
     - blocks silent completion without review
     - records approval and changes-requested decisions as first-class artifacts
     - gives the UI a governed execution surface instead of implicit completion

3. Routine anti-proliferation and draft support
   - [`server/src/services/routines.ts`](/Users/mnm/Documents/Github/paperclip/server/src/services/routines.ts:1)
   - [`server/src/routes/routines.ts`](/Users/mnm/Documents/Github/paperclip/server/src/routes/routines.ts:1)
   - [`packages/db/src/schema/routines.ts`](/Users/mnm/Documents/Github/paperclip/packages/db/src/schema/routines.ts:1)
   - [`packages/shared/src/routine-variables.ts`](/Users/mnm/Documents/Github/paperclip/packages/shared/src/routine-variables.ts:1)
   - [`packages/shared/src/types/routine.ts`](/Users/mnm/Documents/Github/paperclip/packages/shared/src/types/routine.ts:1)
   - [`packages/shared/src/validators/routine.ts`](/Users/mnm/Documents/Github/paperclip/packages/shared/src/validators/routine.ts:1)
   - [`ui/src/pages/Routines.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/Routines.tsx:1)
   - [`ui/src/pages/RoutineDetail.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/RoutineDetail.tsx:1)
   - Why:
     - enables coalesce-if-active semantics
     - makes draft/no-default-agent routines explicit instead of implicit failure
     - reduces duplicate descendants in routine families

4. Inbox and issue-detail triage
   - [`packages/db/src/schema/inbox_dismissals.ts`](/Users/mnm/Documents/Github/paperclip/packages/db/src/schema/inbox_dismissals.ts:1)
   - [`server/src/routes/inbox-dismissals.ts`](/Users/mnm/Documents/Github/paperclip/server/src/routes/inbox-dismissals.ts:1)
   - [`server/src/services/inbox-dismissals.ts`](/Users/mnm/Documents/Github/paperclip/server/src/services/inbox-dismissals.ts:1)
   - [`ui/src/pages/Inbox.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/Inbox.tsx:1)
   - [`ui/src/lib/inbox.ts`](/Users/mnm/Documents/Github/paperclip/ui/src/lib/inbox.ts:1)
   - [`ui/src/components/IssueFiltersPopover.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/components/IssueFiltersPopover.tsx:1)
   - [`ui/src/components/IssueColumns.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/components/IssueColumns.tsx:1)
   - [`ui/src/pages/IssueDetail.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/IssueDetail.tsx:1)
   - [`ui/src/components/IssueChatThread.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/components/IssueChatThread.tsx:1)
   - Why:
     - reduces operator noise
     - makes active execution, approval state, and related context easier to act on
     - supports closure-first prioritization in the UI

5. Supporting migrations, exports, and evals
   - [`packages/db/src/migrations/0049_flawless_abomination.sql`](/Users/mnm/Documents/Github/paperclip/packages/db/src/migrations/0049_flawless_abomination.sql:1) through [`0055_kind_weapon_omega.sql`](/Users/mnm/Documents/Github/paperclip/packages/db/src/migrations/0055_kind_weapon_omega.sql:1)
   - [`tests/e2e/signoff-policy.spec.ts`](/Users/mnm/Documents/Github/paperclip/tests/e2e/signoff-policy.spec.ts:1)
   - [`docs/guides/execution-policy.md`](/Users/mnm/Documents/Github/paperclip/docs/guides/execution-policy.md:1)
   - [`docs/course_correction/`](/Users/mnm/Documents/Github/paperclip/docs/course_correction:1)
   - Why:
     - keeps schema, contracts, and runtime policy in sync
     - preserves the session repair ledger and evaluation path

## Defer From This Merge

These slices are recent, but they do not currently outrank closure-path work:

1. Adapter/runtime expansion
   - `packages/adapters/claude-local/**`
   - `packages/adapters/codex-local/**`
   - `packages/adapters/openclaw-gateway/**`
   - `packages/adapters/pi-local/**`
   - Why:
     - valuable, but not needed to prove dispatch -> execution -> review -> approval -> closure

2. Runtime/bootstrap plumbing
   - `cli/**`
   - `packages/shared/src/network-bind.ts`
   - `scripts/dev-runner*`
   - `scripts/ensure-workspace-package-links.ts`
   - `scripts/provision-worktree.sh`
   - `server/src/services/workspace-runtime.ts`
   - Why:
     - operationally useful
     - higher blast radius than the current control-plane wedge

3. MCP/package expansion
   - `packages/mcp-server/**`
   - Why:
     - promising as an external control surface
     - not required now that the route/dispatch bridge is already repaired

4. Speculative or duplicate UI/admin surfaces
   - [`ui/src/pages/IssueChatUxLab.tsx`](/Users/mnm/Documents/Github/paperclip/ui/src/pages/IssueChatUxLab.tsx:1)
   - `ui/src/adapters/**`
   - `ui/src/pages/ExecutionWorkspaceDetail.tsx`
   - `ui/src/pages/CompanySkills.tsx`
   - Why:
     - broadens the surface area without directly improving governed closure

5. Planning docs and backlog prose
   - `doc/plans/**`
   - `releases/v2026.410.0.md`
   - Why:
     - useful context, but not merge-critical artifacts for the current direction

## Decision Rule

The current merge scope is not trying to ship every recent idea.

It is intentionally biased toward:

- deterministic dispatch ingest
- durable route receipts into the right company
- review and approval gates as runtime policy
- coalesced routine families
- operator triage that reduces noise and accelerates closure
