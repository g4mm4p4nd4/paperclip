# Paperclip Agent Mission Performance Deep Dive

Generated: 2026-06-27T18:19:46.470Z
Status: trace_only
Receipt: /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T181946370Z-agent-mission-performance-trace.json
HTML: /Users/mnm/Documents/Github/paperclip/docs/reports/agent-mission-performance-dashboard-postfix.html

## Summary

- Companies: 4
- Sampled agents: 38
- Minimum sample met: true
- Critical agents: 4
- Warning agents: 11
- Recent runs: 44
- Failed runs: 0
- Raw tokens: 686278
- Applied fixes: 0

## Findings

- **WARNING Success is overclaimed when finalDisposition is implicit:** 1 sampled agent(s) had mostly default_success advanced_vision ledger rows. Treat those as weak progress until agents explicitly emit finalDisposition and receipts.
- **CRITICAL Wake churn is replacing deliverable closure:** 2 sampled agent(s) had heavy recent run volume without closing assigned issues. This is the strongest underperformance signal and should drive routine/issue consolidation.
- **WARNING Open work is stale or owned by idle agents:** 9 sampled agent(s) have stale in-progress issues or no recent execution despite assigned work. These need manager triage, not more blind wakeups.

## Company Trace

### POR Portfolio Venture Factory :: Glitch-Cipher-Syndicate/LeadForge

Status: needs_decision
Sample: 11/12

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
CTO | cto | idle | warning | 104 | 0 | 0 | 0 | 4 | 0 | idle_with_assigned_work, stale_in_progress
Release Manager | devops | idle | warning | 88 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work, stale_in_progress
CEO | ceo | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
Chief of Staff | pm | idle | warning | 45 | 0 | 0 | 0 | 2 | 0 | idle_with_assigned_work
Codex Strike Engineer | engineer | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
Engineer-2 | engineer | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
Growth/Distribution | general | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
CMO | cmo | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Designer/Copy | designer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
QA | qa | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Skill Curator | skill_curator | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal

### PORA Portfolio OS Orchestrator

Status: maintaining
Sample: 8/22

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
Evidence Custodian | pm | idle | warning | 6 | 2 | 0 | 0 | 1 | 223581 | output_contract_drift
Akio Morita | researcher | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Asset Composer | pm | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Chief of Staff | pm | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Codex Strike Engineer | engineer | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Council Chair | ceo | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Skill Curator | skill_curator | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal
Truth Boundary Steward | cto | idle | info | 2 | 0 | 0 | 0 | 0 | 0 | low_recent_signal

### PORAA Portfolio Venture Factory :: g4mm4p4nd4/YT-Synth

Status: maintaining
Sample: 9/11

| Agent | Role | Status | Severity | Score | Runs | Failed | Completed | Open | Raw Tokens | Problems |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
Growth/Distribution | general | idle | critical | 94 | 24 | 0 | 0 | 2 | 0 | wake_churn_without_closure, weak_success_disposition, skill_budget_missing
CMO | cmo | idle | critical | 65 | 12 | 0 | 0 | 1 | 0 | wake_churn_without_closure, output_contract_drift
Chief of Staff | pm | idle | warning | 15 | 6 | 0 | 0 | 1 | 462697 | output_contract_drift
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

