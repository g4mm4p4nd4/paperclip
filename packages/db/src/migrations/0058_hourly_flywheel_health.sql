CREATE TABLE "flywheel_health_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"window_hours" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'scheduler' NOT NULL,
	"report_json" jsonb NOT NULL,
	"tasks_attempted" integer DEFAULT 0 NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	"provider_failure_count" integer DEFAULT 0 NOT NULL,
	"ledger_completeness_percent" integer DEFAULT 0 NOT NULL,
	"artifact_coverage_percent" integer DEFAULT 0 NOT NULL,
	"receipts_produced" integer DEFAULT 0 NOT NULL,
	"tests_passed" integer DEFAULT 0 NOT NULL,
	"tests_failed" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flywheel_health_reports" ADD CONSTRAINT "flywheel_health_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flywheel_health_reports_company_window_uq" ON "flywheel_health_reports" USING btree ("company_id","window_start","window_end");--> statement-breakpoint
CREATE INDEX "flywheel_health_reports_company_generated_idx" ON "flywheel_health_reports" USING btree ("company_id","generated_at");
