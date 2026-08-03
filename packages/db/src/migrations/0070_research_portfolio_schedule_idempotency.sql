ALTER TABLE "routine_triggers" ADD COLUMN "schedule_identity" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_scheduled_idempotency_uq" ON "routine_runs" ("company_id", "idempotency_key") WHERE "source" = 'schedule' AND "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "research_portfolio_promotion_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "portfolio_run_id" text NOT NULL,
  "portfolio_artifact_path" text NOT NULL,
  "portfolio_sha256" text NOT NULL,
  "input_hash" text NOT NULL,
  "decision_schema_version" text NOT NULL,
  "decision_hash" text NOT NULL,
  "decision" jsonb NOT NULL,
  "disposition" text NOT NULL,
  "winner_count" integer NOT NULL,
  "winner_lane_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "research_portfolio_promotion_decisions_identity_ck" CHECK (length(btrim("portfolio_run_id")) BETWEEN 1 AND 200 AND "portfolio_run_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'),
  CONSTRAINT "research_portfolio_promotion_decisions_artifact_path_ck" CHECK ("portfolio_artifact_path" LIKE '/%' AND "portfolio_artifact_path" NOT LIKE '%/../%'),
  CONSTRAINT "research_portfolio_promotion_decisions_hash_ck" CHECK ("portfolio_sha256" ~ '^[0-9a-f]{64}$' AND "input_hash" ~ '^[0-9a-f]{64}$' AND "decision_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "research_portfolio_promotion_decisions_schema_ck" CHECK ("decision_schema_version" = 'paperclip.research_portfolio_promotion_decision.v1'),
  CONSTRAINT "research_portfolio_promotion_decisions_disposition_ck" CHECK ("disposition" IN ('research_only','no_go')),
  CONSTRAINT "research_portfolio_promotion_decisions_winner_ck" CHECK (("winner_count" = 0 AND "winner_lane_id" IS NULL) OR ("winner_count" = 1 AND length(btrim("winner_lane_id")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "research_portfolio_promotion_decisions_company_run_uq" ON "research_portfolio_promotion_decisions" ("company_id", "portfolio_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "research_portfolio_promotion_decisions_company_input_uq" ON "research_portfolio_promotion_decisions" ("company_id", "input_hash");
