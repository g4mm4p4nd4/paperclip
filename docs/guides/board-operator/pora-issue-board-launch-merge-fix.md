# PORA Issue Board And Launch Merge Fix

Date: 2026-07-06

## Symptoms

- `/PORA/issues` failed to load real issue values under production PORA data volume.
- Issue detail work requests on `/PORA/issues/PORA-1982` could surface `Assignee agent not found` even though the stored assignee existed.
- Markdown in issue threads caused noisy issue lookups for workflow labels such as `DAY-14`, `ITERATION-1`, and `UTF-8`.
- CE had two similar `launch_execution` approvals. The approved canonical request was `f3ecdec3-b2c8-4f9a-bb3a-85afdbf06131`; the duplicate request was `02d29f1d-4e4c-454d-9336-6a35cf373757`.

## Root Causes

- The issue list sorted unbounded board loads with per-row correlated subqueries over `issue_comments` and `activity_log`. PORA had hundreds of thousands of rows in both tables, so the list query could hit statement timeout.
- Issue detail agent choices were loaded from the app shell's selected company instead of the loaded issue's company. Direct links could therefore show or submit agents from the wrong company context.
- The markdown issue-reference linkifier treated any `PREFIX-123` token as a live issue lookup, including planning labels that were not Paperclip issue IDs.
- Launch execution creation had no business-key idempotency for repo/source/routing/venture duplicates.

## Fixes

- `issues.updated_at` is now the maintained issue recency field for board ordering.
- Non-local issue activity updates `issues.updated_at`; local inbox/read activity does not.
- Migration `0063_pora_issue_recency_indexes.sql` adds issue, activity, and heartbeat indexes and backfills historical issue recency from comments/activity.
- Issue detail uses the loaded issue company for agent choices and uploads.
- Issue markdown can pass an active issue-prefix allow-list so only same-company issue identifiers trigger live lookups.
- Duplicate `launch_execution` requests merge into an existing pending, revision-requested, or approved canonical approval when repo/source/routing/venture signals match.
- Profit Flywheel v2 requests use the immutable `run_id + dispatch_hash + selection_snapshot_hash` identity. Creation and merge share one transaction guarded by a company-scoped PostgreSQL advisory lock, so concurrent submissions of the same identity cannot race into duplicate rows.
- The REST approval route uses the transactional upsert, and any integration that explicitly requests `launch_execution` must use that service instead of the raw insert path.
- `pos.dispatch.v2` ingestion does not create `launch_execution` approvals. The durable Profit Flywheel's receipt-backed QA and release stages are the only workflow authority; the former dispatch approval was detached from those transitions and created misleading approval work.

## Retry Identity

- A retry of an interrupted or timed-out Profit Flywheel canary reuses the exact same run receipt, including `run_id` and project identity.
- Generating a new run or project ID declares new workflow authority. It is not a retry under the v2 stage idempotency key `{company}+{run_id}+{stage}+{input_hash}`.
- A fresh run ID or changed dispatch/selection hash creates distinct workflow authority, even for the same repository. If a non-v2 integration explicitly creates launch approvals for those accidental retries, consolidate them as superseded history; never silently reuse an old approval for new workflow authority.

## Live Repair

- Applied migration 0063 to the embedded Paperclip database on port 54329.
- Backfilled 1,810 issue rows.
- Merged duplicate CE approval `02d29f1d-4e4c-454d-9336-6a35cf373757` into approved canonical approval `f3ecdec3-b2c8-4f9a-bb3a-85afdbf06131`.
- Added audit comments to the affected approvals and PORA issues with marker:
  `CE-LAUNCH-MERGE:f3ecdec3-b2c8-4f9a-bb3a-85afdbf06131:02d29f1d-4e4c-454d-9336-6a35cf373757`
- Rebuilt static UI assets and restarted Paperclip on port 3100.

## Verification Receipts

- `PORA` issue list shape query returned 50 rows in 3.8 ms.
- PORA live-runs fallback query returned 4 rows in 0.53 ms.
- `PORA-1982` assignee remains valid: Evidence Custodian, idle, issue status done.
- All four new indexes exist in the live database.
- Paperclip health endpoint returned OK on `http://127.0.0.1:3100/api/health`.
- Served UI bundle after restart: `/assets/index-XDnihhB7.js`.
