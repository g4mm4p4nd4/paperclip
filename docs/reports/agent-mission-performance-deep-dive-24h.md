# Paperclip Agent Mission Performance Deep Dive

Generated: 2026-06-27T18:19:45.507Z
Status: trace_only
Receipt: /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T181945390Z-agent-mission-performance-trace.json
HTML: /Users/mnm/Documents/Github/paperclip/docs/reports/agent-mission-performance-dashboard-24h.html

## Summary

- Companies: 4
- Sampled agents: 37
- Minimum sample met: true
- Critical agents: 6
- Warning agents: 10
- Recent runs: 88
- Failed runs: 3
- Raw tokens: 12280747
- Applied fixes: 0

## Findings

- **CRITICAL Hermes adapter flag compatibility was breaking live agents:** 1 sampled agent(s) showed Hermes CLI unsupported-flag failures. The adapter fix is capability-aware; 0 stuck error agent(s) were safe-reset to idle in apply mode.
- **WARNING Success is overclaimed when finalDisposition is implicit:** 6 sampled agent(s) had mostly default_success advanced_vision ledger rows. Treat those as weak progress until agents explicitly emit finalDisposition and receipts.
- **CRITICAL Wake churn is replacing deliverable closure:** 3 sampled agent(s) had heavy recent run volume without closing assigned issues. This is the strongest underperformance signal and should drive routine/issue consolidation.
- **WARNING Open work is stale or owned by idle agents:** 5 sampled agent(s) have stale in-progress issues or no recent execution despite assigned work. These need manager triage, not more blind wakeups.

## Company Trace

### POR Portfolio Venture Factory :: Glitch-Cipher-Syndicate/LeadForge

Status: misaligned
Sample: 10/12

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
Chief of Staff | pm | idle | critical | 227 | 3 | 3 | 0 | 2 | 0 | hermes_cli_flag_incompatibility, adapter_failures
Release Manager | devops | idle | warning | 88 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work, stale_in_progress
CTO | cto | idle | warning | 59 | 1 | 0 | 0 | 4 | 885609 | weak_success_disposition, output_contract_drift, stale_in_progress
Codex Strike Engineer | engineer | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
CEO | ceo | idle | warning | 31 | 2 | 0 | 0 | 1 | 1020634 | weak_success_disposition, output_contract_drift
Growth/Distribution | general | idle | warning | 6 | 2 | 0 | 0 | 1 | 772896 | weak_success_disposition, output_contract_drift
Designer/Copy | designer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
QA | qa | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
CMO | cmo | idle | warning | 0 | 1 | 0 | 1 | 0 | 570219 | weak_success_disposition, output_contract_drift
Skill Curator | skill_curator | idle | warning | 0 | 1 | 0 | 0 | 0 | 110058 | weak_success_disposition, output_contract_drift

### PORA Portfolio OS Orchestrator

Status: maintaining
Sample: 8/22

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
Evidence Custodian | pm | idle | warning | 12 | 4 | 0 | 0 | 1 | 993512 | output_contract_drift
Akio Morita | researcher | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Asset Composer | pm | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Chief of Staff | pm | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Codex Strike Engineer | engineer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Council Chair | ceo | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Skill Curator | skill_curator | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Truth Boundary Steward | cto | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal

### PORAA Portfolio Venture Factory :: g4mm4p4nd4/YT-Synth

Status: blocked
Sample: 9/11

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
CMO | cmo | idle | critical | 102 | 21 | 0 | 0 | 1 | 2705915 | wake_churn_without_closure, output_contract_drift
Growth/Distribution | general | idle | critical | 94 | 42 | 0 | 0 | 2 | 0 | wake_churn_without_closure, weak_success_disposition, skill_budget_missing
Chief of Staff | pm | idle | critical | 90 | 11 | 0 | 0 | 1 | 5221904 | wake_churn_without_closure, output_contract_drift
CEO | ceo | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Codex Strike Engineer | engineer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
CTO | cto | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
QA | qa | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Release Manager | devops | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Skill Curator | skill_curator | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal

### PORAAA Portfolio Venture Factory :: g4mm4p4nd4/agency-swarm

Status: needs_decision
Sample: 10/11

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
Growth/Distribution | general | paused | critical | 140 | 0 | 0 | 0 | 1 | 0 | paused_with_open_work, blocked_work
Engineer-2 | engineer | paused | critical | 115 | 0 | 0 | 0 | 1 | 0 | paused_with_open_work
Chief of Staff | pm | idle | warning | 88 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work, stale_in_progress
CEO | ceo | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
CMO | cmo | paused | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Codex Strike Engineer | engineer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
CTO | cto | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Designer/Copy | designer | paused | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
QA | qa | paused | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Release Manager | devops | paused | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal

