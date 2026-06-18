ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_seq" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_stream" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_bytes" bigint;
