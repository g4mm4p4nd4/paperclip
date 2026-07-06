CREATE INDEX IF NOT EXISTS "issues_company_hidden_updated_idx" ON "issues" USING btree ("company_id","hidden_at","updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx" ON "heartbeat_runs" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_created_idx" ON "heartbeat_runs" USING btree ("company_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_entity_created_idx" ON "activity_log" USING btree ("company_id","entity_type","entity_id","created_at" DESC);--> statement-breakpoint
WITH latest_issue_activity AS (
  SELECT issue_id, MAX(last_activity_at) AS last_activity_at
  FROM (
    SELECT
      "issue_id" AS issue_id,
      MAX("created_at") AS last_activity_at
    FROM "issue_comments"
    GROUP BY "issue_id"
    UNION ALL
    SELECT
      "entity_id"::uuid AS issue_id,
      MAX("created_at") AS last_activity_at
    FROM "activity_log"
    WHERE "entity_type" = 'issue'
      AND "entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "action" NOT IN (
        'issue.read_marked',
        'issue.read_unmarked',
        'issue.inbox_archived',
        'issue.inbox_unarchived'
      )
    GROUP BY "entity_id"
  ) activity
  GROUP BY issue_id
)
UPDATE "issues"
SET "updated_at" = latest_issue_activity.last_activity_at
FROM latest_issue_activity
WHERE "issues"."id" = latest_issue_activity.issue_id
  AND latest_issue_activity.last_activity_at > "issues"."updated_at";
