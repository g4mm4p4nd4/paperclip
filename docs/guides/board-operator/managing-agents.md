---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

Agents are the employees of your autonomous company. As the board operator, you have full control over their lifecycle.

## Agent States

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive work |
| `idle` | Active but no current heartbeat running |
| `running` | Currently executing a heartbeat |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-paused |
| `terminated` | Permanently deactivated (irreversible) |

## Creating Agents

Create agents from the Agents page. Each agent requires:

- **Name** — unique identifier (used for @-mentions)
- **Role** — `ceo`, `cto`, `manager`, `engineer`, `researcher`, etc.
- **Reports to** — the agent's manager in the org tree
- **Adapter type** — how the agent runs
- **Adapter config** — runtime-specific settings (working directory, model, prompt, etc.)
- **Capabilities** — short description of what this agent does

Common adapter choices:
- `claude_local` / `codex_local` / `opencode_local` for local coding agents
- `openclaw_gateway` / `http` for webhook-based external agents
- `process` for generic local command execution

For `opencode_local`, configure an explicit `adapterConfig.model` (`provider/model`).
Paperclip validates the selected model against live `opencode models` output.
Paperclip's OpenCode Go defaults are role based:

| Role | Default model | Variant |
| --- | --- | --- |
| `engineer`, `integration_engineer`, `devops`, `qa`, `researcher` | `opencode-go/deepseek-v4-flash` | `high` |
| `ceo`, `cto`, `cfo` | `opencode-go/deepseek-v4-pro` | `high` |
| `pm`, `designer`, `cmo` | `opencode-go/kimi-k2.6` | `high` |
| `skill_curator` | `opencode-go/qwen3.5-plus` | `medium` |
| `general` / `default` | `opencode-go/deepseek-v4-flash` | `medium` |

Hermes agents using OpenCode Go store the bare model id, such as `deepseek-v4-flash`, and pin `adapterConfig.provider` to `opencode-go`. Manual paid model choices must stay on OpenCode Go rather than inheriting Hermes' global free-model fallback. `qwen3.7-max` is currently rejected by the OpenCode Go OpenAI-compatible transport, so Hermes routes that selection to `deepseek-v4-pro` to preserve the paid 1M-context lane.

When OpenCode Go quota is exhausted, Paperclip routes recent OpenCode/Hermes quota failures through the configured tiered recovery order. MiniMax is the first automatic recovery lane; post-MiniMax fallbacks require explicit approval. Gemini CLI recovery uses real Gemini model ids: CEO/chief-of-staff/executive, research, QA, and design work starts on `gemini-3.1-pro`, while implementation/support work starts on `gemini-3.5-flash`. Claude recovery strips parent Claude/Codex harness markers before spawning the native `claude` CLI. Codex recovery preserves the full Codex catalog, including spark and effort-suffixed ids such as `gpt-5.3-codex-high` and `gpt-5.3-codex-spark`. Executive and strategic work skips low-intelligence free lanes such as Zen free/GPT-OSS-style recovery models even when post-MiniMax fallback is approved. If no recovery lane remains available, automatic wakes are skipped with `provider_degraded_backoff` evidence for the recovery window instead of creating another failed run; manual/on-demand wakes still act as recovery probes. Once a newer normal OpenCode/Hermes run completes cleanly, Paperclip clears the recent stall signal and resumes role-appropriate OpenCode Go routing; if fallback keeps succeeding but no normal run has happened, Paperclip allows a normal recovery probe after a 30-minute degraded cooldown. If a fallback lane reports its own auth, billing, quota, rate-limit, or preflight failure, Paperclip records that lane and advances to the next lane instead of retrying it. Model-access failures are the only failure class where Paperclip may retry the same lane after the candidate model changes. The default Zen free model is `opencode-zen/deepseek-v4-flash-free`; the OpenRouter lane maps the agent's intended OpenCode Go model to the matching OpenRouter id, such as `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `moonshotai/kimi-k2.6`, or `qwen/qwen3.7-max`.

Provider reliability is enforced before adapter spawn. Paperclip runs adapter environment checks for provider-backed lanes and treats failed preflight checks as degraded, so a known-bad Claude, Codex, OpenRouter, OpenCode, or Gemini lane should be skipped or blocked before burning a run. The run ledger records `providerReliabilityGate`, selected lane, failure kind, preflight attempts, prompt class, prompt hash, and budget status for audit.

Routine execution conflicts are terminalized instead of stranded. If a queued routine run is claimed and the lazy issue execution lock hits `issues_open_routine_execution_uq`, Paperclip finalizes the run as `cancelled` with `routine_execution_conflict`, cancels the wakeup, and keeps the agent available for the next queued run. For unattended routine sources (`schedule`, `api`, and `webhook`), an existing open routine execution issue is also treated as WIP even when the heartbeat has already exited. The next run is linked to that issue as `coalesced` or `skipped`, and Paperclip does not create another issue or burn another wakeup until the operator/agent closes the open work.

Routine actionability is enforced before issue creation. Provider-capacity backoff, missing credentials, human-owned states, maintenance cadence, unchanged upstream artifact hashes, and dirty release/QA/deploy workspaces finalize the routine run as `skipped` with `paperclipActionabilityPreflight` evidence instead of waking an agent. Board-owned blockers create one reusable `factory_guard` issue; workspace blockers create one cleanup issue; the third identical blocker fingerprint pauses the routine so the factory cannot spin on the same failure.

Use one ship-captain lane per venture run. The seeded Portfolio-OS `Release Gate Reconciler` is marked as the ship-captain routine; Dispatch Poller, QA, and Evidence Backfill feed state into that lane rather than independently polling forever.

Keep prompts compact during incidents. Paperclip injects context-pack hints when `latest.json`, Repomix packs, and TOON/TSV indexes exist under `PAPERCLIP_HOME/instances/<id>/data/ops/context-packs` or `PAPERCLIP_CONTEXT_PACKS_DIR`. Agents should read map/compact indexes first, use delta packs for recent dirty-tree context, and reserve core packs for tasks that truly need broad context.

Keep final responses compact as well. Local adapters inject an output contract
that caps ordinary final responses at 7 sentences, 1200 characters, or about 700
output tokens. Longer replies must begin with `Expansion reason:` and are
reserved for explicit operator requests, unresolved blockers, failed
verification, review/security findings, regulated-risk explanations, or unsafe
handoffs. Receipt paths, hashes, changed files, and test commands should be in
the concise response; raw logs and long explanations belong in run artifacts and
the context ledger.

Every final result should include a structured disposition: `advanced_vision`, `maintenance`, `blocked`, `noop`, or `misaligned`, plus `nextActionOwner` when follow-up is not owned by the same agent. The context ledger records explicit dispositions when present and infers a conservative fallback from outcome/result metadata when absent.

## Flywheel Readiness Gate

Do not judge unattended engineering health from "run succeeded" alone. A fully
operational agentic engineering loop must show ready canaries in the hourly
flywheel health report:

- issue-linked succeeded run
- issue marked `done`
- context ledger row with prompt class, budget status, hashes, and context pack refs
- output budget status that is `ok` or has an explicit expansion reason
- receipt path
- passing test evidence
- changed-file evidence
- provider failure avoided or rerouted successfully

Read the current gate with `GET /api/companies/{companyId}/flywheel-health?hours=1`
or from the agent detail page's latest hourly flywheel report. The
`canaryReadiness.readyCount` value is the number of completed issue runs that
meet the full proof bar. `canaryReadiness.missing` lists successful-looking runs
that still lack required evidence such as `receipt_path`, `passing_tests`,
`changed_files`, or `context_pack_ref`.

Use `outputBudgetViolations` and `outputTokensByResponseClass` in the same
report to find agents that finish useful work but spend excessive output tokens.
Treat `verbose_unjustified` as an agent-instruction or adapter-contract problem
to fix, not as a reason to remove decisive input evidence.

Use `POST /api/companies/{companyId}/flywheel-health/context-economy-canaries`
to create missing context-economy canary issues. The endpoint skips repos that
already have ready proof; send `force: true` only when you need a fresh
re-certification run through the normal issue assignment and heartbeat path.

## Agent Hiring via Governance

Agents can request to hire subordinates. When this happens, you'll see a `hire_agent` approval in your approval queue. Review the proposed agent config and approve or reject.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Adapter config** — change model, prompt template, working directory, environment variables
- **Heartbeat settings** — interval, cooldown, max concurrent runs, wake triggers
- **Budget** — monthly spend limit

Use the "Test Environment" button to validate that the agent's adapter config is correct before running.

## Pausing and Resuming

Pause an agent to temporarily stop heartbeats:

```
POST /api/agents/{agentId}/pause
```

Resume to restart:

```
POST /api/agents/{agentId}/resume
```

Agents are also auto-paused when they hit 100% of their monthly budget.

## Terminating Agents

Termination is permanent and irreversible:

```
POST /api/agents/{agentId}/terminate
```

Only terminate agents you're certain you no longer need. Consider pausing first.
