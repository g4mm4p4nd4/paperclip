# Paperclip Agent Mission Performance Deep Dive

Generated: 2026-06-27T23:43:57.092Z
Status: trace_only
Receipt: /Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/agent-mission-performance/runs/20260627T234356912Z-agent-mission-performance-trace.json
HTML: /Users/mnm/Documents/Github/paperclip/docs/reports/agent-mission-performance-dashboard-live-followup.html

## Summary

- Companies: 4
- Sampled agents: 38
- Minimum sample met: true
- Critical agents: 3
- Warning agents: 12
- High-token no-closure agents: 2
- Recent runs: 5
- Failed runs: 0
- Raw tokens: 3696330
- Applied fixes: 0

## Findings

- **WARNING High token use is not converting into completed work:** 2 sampled agent(s) spent at least 250,000 raw tokens in the lookback window without completing assigned issues. These agents are now guaranteed into the deep-dive sample so token waste cannot stay hidden behind low behavioral scores.
- **WARNING Open work is stale or owned by idle agents:** 10 sampled agent(s) have stale in-progress issues or no recent execution despite assigned work. These need manager triage, not more blind wakeups.

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
Evidence Custodian | pm | idle | warning | 45 | 1 | 0 | 0 | 1 | 802837 | output_contract_drift, high_tokens_without_closure
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
Chief of Staff | pm | idle | critical | 65 | 1 | 0 | 0 | 1 | 2893493 | output_contract_drift, high_tokens_without_closure
CMO | cmo | idle | warning | 45 | 0 | 0 | 0 | 1 | 0 | idle_with_assigned_work
Growth/Distribution | general | idle | warning | 12 | 3 | 0 | 0 | 2 | 0 | skill_budget_missing
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

