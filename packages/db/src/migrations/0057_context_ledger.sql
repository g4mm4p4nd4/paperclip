CREATE TABLE "context_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"issue_id" uuid,
	"task_key" text,
	"cwd" text,
	"branch" text,
	"adapter_type" text NOT NULL,
	"adapter_version" text,
	"prompt_class" text NOT NULL,
	"prompt_budget_version" text NOT NULL,
	"prompt_fingerprint" text NOT NULL,
	"prompt_chars" integer DEFAULT 0 NOT NULL,
	"estimated_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"component_hashes" jsonb,
	"artifact_refs" jsonb,
	"context_pack_refs" jsonb,
	"session_id_before" text,
	"session_id_after" text,
	"comment_cursor" jsonb,
	"wake_cursor" jsonb,
	"estimated_input_tokens" integer,
	"actual_input_tokens" integer,
	"actual_output_tokens" integer,
	"cached_input_tokens" integer,
	"budget_status" text DEFAULT 'ok' NOT NULL,
	"budget_limit_tokens" integer,
	"final_outcome" text,
	"final_blocker" text,
	"receipt_paths" jsonb,
	"redaction_applied" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_ledger_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"component_type" text DEFAULT 'prompt_component' NOT NULL,
	"content_sha256" text NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"estimated_tokens" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"evidence_slice_count" integer DEFAULT 0 NOT NULL,
	"artifact_ref" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_context_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"task_key" text DEFAULT '' NOT NULL,
	"latest_comment_id" uuid,
	"comment_cursor" jsonb,
	"wake_cursor" jsonb,
	"wake_count" integer DEFAULT 0 NOT NULL,
	"last_run_id" uuid,
	"session_display_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'company' NOT NULL,
	"scope_id" uuid NOT NULL,
	"max_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"warn_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"hard_stop_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD CONSTRAINT "context_ledger_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD CONSTRAINT "context_ledger_entries_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD CONSTRAINT "context_ledger_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD CONSTRAINT "context_ledger_entries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_ledger_components" ADD CONSTRAINT "context_ledger_components_entry_id_context_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."context_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_ledger_components" ADD CONSTRAINT "context_ledger_components_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_cursors" ADD CONSTRAINT "agent_context_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_cursors" ADD CONSTRAINT "agent_context_cursors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_cursors" ADD CONSTRAINT "agent_context_cursors_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_budget_policies" ADD CONSTRAINT "prompt_budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_ledger_entries_company_run_idx" ON "context_ledger_entries" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "context_ledger_entries_company_issue_idx" ON "context_ledger_entries" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "context_ledger_entries_company_agent_created_idx" ON "context_ledger_entries" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "context_ledger_entries_prompt_fingerprint_idx" ON "context_ledger_entries" USING btree ("prompt_fingerprint");--> statement-breakpoint
CREATE INDEX "context_ledger_components_entry_idx" ON "context_ledger_components" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "context_ledger_components_company_hash_idx" ON "context_ledger_components" USING btree ("company_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_cursors_company_agent_task_uq" ON "agent_context_cursors" USING btree ("company_id","agent_id","task_key");--> statement-breakpoint
CREATE INDEX "agent_context_cursors_company_issue_idx" ON "agent_context_cursors" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "prompt_budget_policies_company_scope_active_idx" ON "prompt_budget_policies" USING btree ("company_id","scope_type","scope_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_budget_policies_company_scope_uq" ON "prompt_budget_policies" USING btree ("company_id","scope_type","scope_id");
