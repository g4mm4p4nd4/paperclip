create index if not exists activity_log_company_issue_run_idx
  on activity_log (company_id, entity_type, entity_id, run_id);

create index if not exists heartbeat_runs_company_context_issue_idx
  on heartbeat_runs (company_id, ((context_snapshot ->> 'issueId')), created_at);

create index if not exists issues_company_checkout_run_idx
  on issues (company_id, checkout_run_id);

create index if not exists issues_company_execution_run_idx
  on issues (company_id, execution_run_id);
