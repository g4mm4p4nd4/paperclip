CREATE INDEX IF NOT EXISTS "heartbeat_runs_wakeup_request_idx" ON "heartbeat_runs" USING btree ("wakeup_request_id");
