ALTER TABLE "context_ledger_entries" ADD COLUMN "response_class" text DEFAULT 'compact_status' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "output_budget_version" text DEFAULT 'output-economy.legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "estimated_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "output_budget_status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "output_budget_limit_tokens" integer;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "final_response_chars" integer;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "final_response_sentence_count" integer;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "final_response_sha256" text;--> statement-breakpoint
ALTER TABLE "context_ledger_entries" ADD COLUMN "final_response_artifact_refs" jsonb;
