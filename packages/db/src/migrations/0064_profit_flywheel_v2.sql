ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_adapter_type" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "provider_route_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "provider_route_sha256" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_provider_route_sha256_ck" CHECK ("provider_route_sha256" IS NULL OR "provider_route_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

CREATE UNIQUE INDEX "projects_id_company_uq" ON "projects" ("id", "company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_id_company_uq" ON "issues" ("id", "company_id");--> statement-breakpoint

CREATE TABLE "profit_flywheel_workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE RESTRICT,
  "run_id" text NOT NULL,
  "state" text DEFAULT 'running' NOT NULL,
  "current_stage" text DEFAULT 'dispatch' NOT NULL,
  "source_schema_version" text NOT NULL,
  "source_dispatch_path" text NOT NULL,
  "source_dispatch_hash" text NOT NULL,
  "target_repo" text NOT NULL,
  "target_workspace_root" text NOT NULL,
  "contract_path" text NOT NULL,
  "contract_sha256" text NOT NULL,
  "contract_snapshot" jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "feedback" jsonb,
  "blocker_code" text,
  "blocker_detail" text,
  "next_owner" text,
  "resume_condition" text,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_workflows_state_ck" CHECK ("state" IN ('pending','running','retry','blocked','degraded','succeeded','failed','cancelled','safely_skipped')),
  CONSTRAINT "profit_flywheel_workflows_stage_ck" CHECK ("current_stage" IN ('research_intake','evidence_normalization','commercial_validation','council_decision','dispatch','implementation','qa','release','commercial_observation','learning')),
  CONSTRAINT "profit_flywheel_workflows_dispatch_hash_ck" CHECK ("source_dispatch_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_workflows_contract_hash_ck" CHECK ("contract_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_workflows_identity_ck" CHECK (length(btrim("run_id")) BETWEEN 1 AND 200 AND length(btrim("correlation_id")) BETWEEN 1 AND 200 AND "correlation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND "trace_id" ~ '^[0-9a-f]{32}$' AND length(btrim("target_repo")) > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "profit_flywheel_workflows_company_run_uq" ON "profit_flywheel_workflows" ("company_id", "run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_workflows_id_company_uq" ON "profit_flywheel_workflows" ("id", "company_id");--> statement-breakpoint
CREATE INDEX "profit_flywheel_workflows_company_state_idx" ON "profit_flywheel_workflows" ("company_id", "state", "updated_at");--> statement-breakpoint
CREATE INDEX "profit_flywheel_workflows_correlation_idx" ON "profit_flywheel_workflows" ("correlation_id");--> statement-breakpoint
ALTER TABLE "profit_flywheel_workflows" ADD CONSTRAINT "profit_flywheel_workflows_project_company_fk" FOREIGN KEY ("project_id", "company_id") REFERENCES "projects"("id", "company_id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE TABLE "profit_flywheel_stage_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "profit_flywheel_workflows"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "stage" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "owner_plane" text NOT NULL,
  "input_schema_version" text NOT NULL,
  "input_hash" text NOT NULL,
  "source_hashes" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer NOT NULL,
  "retry_at" timestamptz,
  "linked_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "provider_capability_class" text NOT NULL,
  "provider_route_id" text,
  "provider_family" text,
  "provider_model" text,
  "provider_model_version" text,
  "provider_policy_sha256" text,
  "provider_route_core_sha256" text,
  "provider_route_sha256" text,
  "provider_route_snapshot" jsonb,
  "transition_source_stage_run_id" uuid,
  "transition_source_output_hash" text,
  "dispatch_claim_id" uuid,
  "dispatch_claimed_at" timestamptz,
  "concurrency_key" text NOT NULL,
  "concurrency_limit" integer NOT NULL,
  "required_receipts" jsonb NOT NULL,
  "completion_evidence" jsonb NOT NULL,
  "artifact_checkpoint" jsonb,
  "feedback" jsonb,
  "blocker_code" text,
  "blocker_detail" text,
  "next_owner" text,
  "resume_condition" text,
  "lease_owner" text,
  "lease_actor_type" text,
  "lease_actor_id" text,
  "lease_expires_at" timestamptz,
  "heartbeat_at" timestamptz,
  "correlation_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_stage_runs_stage_ck" CHECK ("stage" IN ('research_intake','evidence_normalization','commercial_validation','council_decision','dispatch','implementation','qa','release','commercial_observation','learning')),
  CONSTRAINT "profit_flywheel_stage_runs_state_ck" CHECK ("state" IN ('pending','running','retry','blocked','degraded','succeeded','failed','cancelled','safely_skipped')),
  CONSTRAINT "profit_flywheel_stage_runs_owner_ck" CHECK ("owner_plane" IN ('portfolio_os','paperclip','hermes')),
  CONSTRAINT "profit_flywheel_stage_runs_input_hash_ck" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_stage_runs_policy_hash_ck" CHECK ("provider_policy_sha256" IS NULL OR "provider_policy_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_stage_runs_route_hash_ck" CHECK ((("provider_route_core_sha256" IS NULL AND "provider_route_sha256" IS NULL AND "provider_route_snapshot" IS NULL) OR ("provider_route_core_sha256" ~ '^[0-9a-f]{64}$' AND "provider_route_sha256" ~ '^[0-9a-f]{64}$' AND "provider_route_snapshot" IS NOT NULL)) AND ("transition_source_output_hash" IS NULL OR "transition_source_output_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "profit_flywheel_stage_runs_attempt_ck" CHECK ("attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"),
  CONSTRAINT "profit_flywheel_stage_runs_concurrency_ck" CHECK ("concurrency_limit" > 0),
  CONSTRAINT "profit_flywheel_stage_runs_actor_ck" CHECK (("lease_actor_type" IS NULL AND "lease_actor_id" IS NULL) OR ("lease_actor_type" IN ('agent','board','system') AND "lease_actor_id" IS NOT NULL)),
  CONSTRAINT "profit_flywheel_stage_runs_lease_ck" CHECK (("lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "lease_actor_type" IS NULL AND "lease_actor_id" IS NULL AND "heartbeat_at" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "lease_actor_type" IS NOT NULL AND "lease_actor_id" IS NOT NULL AND "heartbeat_at" IS NOT NULL AND "state" = 'running')),
  CONSTRAINT "profit_flywheel_stage_runs_dispatch_claim_ck" CHECK (("dispatch_claim_id" IS NULL AND "dispatch_claimed_at" IS NULL) OR ("dispatch_claim_id" IS NOT NULL AND "dispatch_claimed_at" IS NOT NULL AND "state" = 'pending' AND "owner_plane" = 'paperclip')),
  CONSTRAINT "profit_flywheel_stage_runs_identity_ck" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 1000 AND length(btrim("concurrency_key")) BETWEEN 1 AND 500 AND length(btrim("correlation_id")) BETWEEN 1 AND 200 AND "correlation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND "trace_id" ~ '^[0-9a-f]{32}$' AND "span_id" ~ '^[0-9a-f]{16}$')
);--> statement-breakpoint

ALTER TABLE "profit_flywheel_stage_runs" ADD CONSTRAINT "profit_flywheel_stage_runs_transition_source_fk" FOREIGN KEY ("transition_source_stage_run_id") REFERENCES "profit_flywheel_stage_runs"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "profit_flywheel_stage_runs_company_idempotency_uq" ON "profit_flywheel_stage_runs" ("company_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_stage_runs_workflow_stage_input_uq" ON "profit_flywheel_stage_runs" ("workflow_id", "stage", "input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_stage_runs_id_company_uq" ON "profit_flywheel_stage_runs" ("id", "company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_stage_runs_id_workflow_company_uq" ON "profit_flywheel_stage_runs" ("id", "workflow_id", "company_id");--> statement-breakpoint
ALTER TABLE "profit_flywheel_stage_runs" ADD CONSTRAINT "profit_flywheel_stage_runs_workflow_company_fk" FOREIGN KEY ("workflow_id", "company_id") REFERENCES "profit_flywheel_workflows"("id", "company_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profit_flywheel_stage_runs" ADD CONSTRAINT "profit_flywheel_stage_runs_linked_issue_company_fk" FOREIGN KEY ("linked_issue_id", "company_id") REFERENCES "issues"("id", "company_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "profit_flywheel_stage_runs" ADD CONSTRAINT "profit_flywheel_stage_runs_transition_source_lineage_fk" FOREIGN KEY ("transition_source_stage_run_id", "workflow_id", "company_id") REFERENCES "profit_flywheel_stage_runs"("id", "workflow_id", "company_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "profit_flywheel_stage_runs_workflow_state_idx" ON "profit_flywheel_stage_runs" ("workflow_id", "state", "updated_at");--> statement-breakpoint
CREATE INDEX "profit_flywheel_stage_runs_issue_idx" ON "profit_flywheel_stage_runs" ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "profit_flywheel_stage_runs_lease_idx" ON "profit_flywheel_stage_runs" ("state", "lease_expires_at");--> statement-breakpoint

CREATE TABLE "profit_flywheel_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "profit_flywheel_workflows"("id") ON DELETE CASCADE,
  "stage_run_id" uuid NOT NULL REFERENCES "profit_flywheel_stage_runs"("id") ON DELETE CASCADE,
  "receipt_type" text NOT NULL,
  "schema_version" text NOT NULL,
  "content_hash" text NOT NULL,
  "artifact_ref" text,
  "status" text DEFAULT 'valid' NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "attributes" jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_receipts_hash_ck" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_receipts_status_ck" CHECK ("status" IN ('valid','invalid','expired','revoked','quarantined')),
  CONSTRAINT "profit_flywheel_receipts_expiry_ck" CHECK ("expires_at" IS NULL OR "expires_at" > "observed_at")
);--> statement-breakpoint

CREATE UNIQUE INDEX "profit_flywheel_receipts_stage_type_hash_uq" ON "profit_flywheel_receipts" ("stage_run_id", "receipt_type", "content_hash");--> statement-breakpoint
CREATE INDEX "profit_flywheel_receipts_workflow_type_idx" ON "profit_flywheel_receipts" ("workflow_id", "receipt_type", "created_at");--> statement-breakpoint
ALTER TABLE "profit_flywheel_receipts" ADD CONSTRAINT "profit_flywheel_receipts_stage_lineage_fk" FOREIGN KEY ("stage_run_id", "workflow_id", "company_id") REFERENCES "profit_flywheel_stage_runs"("id", "workflow_id", "company_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profit_flywheel_receipts" ADD CONSTRAINT "profit_flywheel_receipts_workflow_company_fk" FOREIGN KEY ("workflow_id", "company_id") REFERENCES "profit_flywheel_workflows"("id", "company_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE TABLE "profit_flywheel_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "profit_flywheel_workflows"("id") ON DELETE CASCADE,
  "stage_run_id" uuid REFERENCES "profit_flywheel_stage_runs"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "from_state" text,
  "to_state" text,
  "correlation_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text,
  "payload" jsonb NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_events_from_state_ck" CHECK ("from_state" IS NULL OR "from_state" IN ('pending','running','retry','blocked','degraded','succeeded','failed','cancelled','safely_skipped')),
  CONSTRAINT "profit_flywheel_events_to_state_ck" CHECK ("to_state" IS NULL OR "to_state" IN ('pending','running','retry','blocked','degraded','succeeded','failed','cancelled','safely_skipped')),
  CONSTRAINT "profit_flywheel_events_attempt_ck" CHECK ("attempt_count" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "profit_flywheel_events_workflow_dedupe_uq" ON "profit_flywheel_events" ("workflow_id", "dedupe_key");--> statement-breakpoint
CREATE INDEX "profit_flywheel_events_pending_idx" ON "profit_flywheel_events" ("processed_at", "next_attempt_at", "created_at");--> statement-breakpoint
ALTER TABLE "profit_flywheel_events" ADD CONSTRAINT "profit_flywheel_events_workflow_company_fk" FOREIGN KEY ("workflow_id", "company_id") REFERENCES "profit_flywheel_workflows"("id", "company_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profit_flywheel_events" ADD CONSTRAINT "profit_flywheel_events_stage_lineage_fk" FOREIGN KEY ("stage_run_id", "workflow_id", "company_id") REFERENCES "profit_flywheel_stage_runs"("id", "workflow_id", "company_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE TABLE "profit_flywheel_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "stage_run_id" uuid NOT NULL REFERENCES "profit_flywheel_stage_runs"("id") ON DELETE CASCADE,
  "scope_type" text NOT NULL,
  "scope_key" text NOT NULL,
  "slot" integer NOT NULL,
  "lease_owner" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_leases_scope_ck" CHECK ("scope_type" IN ('stage','repo','provider','agent')),
  CONSTRAINT "profit_flywheel_leases_slot_ck" CHECK ("slot" >= 0),
  CONSTRAINT "profit_flywheel_leases_owner_ck" CHECK (length(btrim("lease_owner")) > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "profit_flywheel_leases_scope_slot_uq" ON "profit_flywheel_leases" ("scope_type", "scope_key", "slot");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_leases_stage_scope_uq" ON "profit_flywheel_leases" ("stage_run_id", "scope_type", "scope_key");--> statement-breakpoint
CREATE INDEX "profit_flywheel_leases_expiry_idx" ON "profit_flywheel_leases" ("expires_at");
--> statement-breakpoint
ALTER TABLE "profit_flywheel_leases" ADD CONSTRAINT "profit_flywheel_leases_stage_company_fk" FOREIGN KEY ("stage_run_id", "company_id") REFERENCES "profit_flywheel_stage_runs"("id", "company_id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE TABLE "profit_flywheel_provider_health" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "route_id" text NOT NULL,
  "policy_sha256" text NOT NULL,
  "policy_schema_sha256" text NOT NULL,
  "provider" text NOT NULL,
  "provider_family" text NOT NULL,
  "status" text NOT NULL,
  "failure_class" text,
  "failure_detail" text,
  "resolved_model" text,
  "resolved_version" text,
  "policy_route_core_sha256" text NOT NULL,
  "resolved_route_sha256" text,
  "receipt_path" text,
  "receipt_sha256" text,
  "receipt_schema_version" text,
  "catalog_evidence" jsonb,
  "canary_kind" text NOT NULL,
  "canary_nonce" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "backoff_until" timestamptz,
  "correlation_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text NOT NULL,
  "details" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_provider_health_status_ck" CHECK ("status" IN ('healthy','failed','quarantined')),
  CONSTRAINT "profit_flywheel_provider_health_policy_hash_ck" CHECK ("policy_sha256" ~ '^[0-9a-f]{64}$' AND "policy_schema_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_provider_health_receipt_hash_ck" CHECK ("receipt_sha256" IS NULL OR "receipt_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "profit_flywheel_provider_health_route_hash_ck" CHECK ("policy_route_core_sha256" ~ '^[0-9a-f]{64}$' AND ("resolved_route_sha256" IS NULL OR "resolved_route_sha256" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "profit_flywheel_provider_health_failure_class_ck" CHECK ("failure_class" IS NULL OR "failure_class" IN ('provider_auth','provider_billing','provider_capability_mismatch','provider_malformed_response','provider_quota','provider_rate_limit','provider_security_compromise','transient_network','process_lost')),
  CONSTRAINT "profit_flywheel_provider_health_healthy_evidence_ck" CHECK ("status" <> 'healthy' OR ("failure_class" IS NULL AND "resolved_model" IS NOT NULL AND "resolved_version" IS NOT NULL AND "resolved_route_sha256" IS NOT NULL AND "receipt_path" IS NOT NULL AND "receipt_sha256" IS NOT NULL AND "receipt_schema_version" IS NOT NULL)),
  CONSTRAINT "profit_flywheel_provider_health_canary_ck" CHECK ("canary_kind" IN ('zero_token','minimal_token','work_bearing')),
  CONSTRAINT "profit_flywheel_provider_health_failures_ck" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "profit_flywheel_provider_health_expiry_ck" CHECK ("expires_at" > "observed_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_provider_health_route_policy_uq" ON "profit_flywheel_provider_health" ("company_id", "route_id", "policy_sha256", "policy_schema_sha256");--> statement-breakpoint
CREATE INDEX "profit_flywheel_provider_health_freshness_idx" ON "profit_flywheel_provider_health" ("company_id", "status", "expires_at", "backoff_until");
--> statement-breakpoint
CREATE TABLE "profit_flywheel_migration_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "migration_version" text NOT NULL,
  "state" text NOT NULL,
  "plan_sha256" text NOT NULL,
  "intent_receipt_path" text NOT NULL,
  "intent_receipt_sha256" text NOT NULL,
  "provider_policy_sha256" text NOT NULL,
  "provider_policy_schema_sha256" text NOT NULL,
  "rollback_snapshot" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "applied_at" timestamptz,
  "rolled_back_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "profit_flywheel_migration_runs_state_ck" CHECK ("state" IN ('applied','rolled_back')),
  CONSTRAINT "profit_flywheel_migration_runs_hash_ck" CHECK ("plan_sha256" ~ '^[0-9a-f]{64}$' AND "intent_receipt_sha256" ~ '^[0-9a-f]{64}$' AND "provider_policy_sha256" ~ '^[0-9a-f]{64}$' AND "provider_policy_schema_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "profit_flywheel_migration_runs_plan_uq" ON "profit_flywheel_migration_runs" ("plan_sha256");
