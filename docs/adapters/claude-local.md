---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- `ANTHROPIC_API_KEY` set in the environment or agent config, or local Claude Code subscription login configured

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-sonnet-4-6` or `claude-haiku-4-5-20251001`) |
| `authMode` | string | No | Set to `subscription` to force local Claude login/subscription auth by stripping inherited `ANTHROPIC_API_KEY` from the child process |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Parent Harness Isolation

Paperclip spawns `claude` as the native Claude Code CLI and strips parent Claude/Codex harness markers such as `CLAUDE_CODE_*`, `CLAUDECODE`, and inherited `CODEX_*` variables unless they were explicitly configured on the adapter. This prevents a server that was started from another coding harness from making the child Claude process look like a nested or externally controlled Claude session. Explicit adapter env, `ANTHROPIC_API_KEY`, and `CLAUDE_CONFIG_DIR` remain available.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness

## Tiered Subscription Fallback

When `claude_local` is selected by tiered recovery under the current Pro subscription policy, Paperclip sets `authMode: subscription` and chooses the model by role:

- Sonnet 4.6 for executive, strategic, research, QA, design, and implementation-heavy work
- Haiku 4.5 for lightweight/support-style roles

Opus remains available for explicitly configured agents, but it is not selected automatically for Pro subscription fallback because 1M Opus access is not included on the current Pro plan without usage credits.
