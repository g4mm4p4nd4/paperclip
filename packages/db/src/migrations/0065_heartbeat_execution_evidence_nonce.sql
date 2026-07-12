ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_evidence_nonce" text;
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_execution_evidence_nonce_ck"
  CHECK ("execution_evidence_nonce" IS NULL OR "execution_evidence_nonce" ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX "heartbeat_runs_execution_evidence_nonce_uq"
  ON "heartbeat_runs" ("execution_evidence_nonce")
  WHERE "execution_evidence_nonce" IS NOT NULL;

ALTER TABLE "profit_flywheel_workflows" ADD COLUMN "portfolio_os_executor_agent_id" uuid;
CREATE UNIQUE INDEX IF NOT EXISTS "agents_id_company_uq" ON "agents" ("id", "company_id");
UPDATE "profit_flywheel_workflows" AS workflow
SET "portfolio_os_executor_agent_id" = (
  SELECT MIN(agent."id"::text)::uuid
  FROM "agents" AS agent
  WHERE agent."company_id" = workflow."company_id"
    AND agent."name" = 'Portfolio OS Orchestrator'
    AND agent."status" NOT IN ('terminated', 'paused', 'pending_approval')
  HAVING COUNT(*) = 1
)
WHERE workflow."portfolio_os_executor_agent_id" IS NULL;
ALTER TABLE "profit_flywheel_workflows"
  ADD CONSTRAINT "profit_flywheel_workflows_portfolio_os_executor_company_fk"
  FOREIGN KEY ("portfolio_os_executor_agent_id", "company_id") REFERENCES "agents"("id", "company_id") ON DELETE RESTRICT;
CREATE INDEX "profit_flywheel_workflows_portfolio_os_executor_agent_idx"
  ON "profit_flywheel_workflows" ("portfolio_os_executor_agent_id");
