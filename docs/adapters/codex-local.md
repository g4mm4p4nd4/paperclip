---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- Either `OPENAI_API_KEY` set in the environment/agent config, or a local Codex CLI login that can run `codex exec`

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Model Catalog And Normalization

Paperclip records both the configured model and the effective runtime model in adapter metadata and the context ledger. The local Codex catalog includes the current `gpt-5.4` family, `gpt-5.3-codex` effort variants (`low`, `high`, `xhigh`, and `*-fast`), spark variants (`gpt-5.3-codex-spark`, `gpt-5.3-codex-spark-preview`), `gpt-5.2-codex` effort variants, `gpt-5.1-codex` variants, and compact fallbacks such as `codex-mini-latest`.

When the Codex CLI is using local ChatGPT/subscription auth, Paperclip preserves those Codex model ids and passes `modelReasoningEffort` as configured. Non-Codex provider ids such as `deepseek-v4-flash` are still normalized before preflight or spawn to the adapter default `gpt-5.4`. The spawned command, run result, and runtime provenance carry the effective model while preserving the original model as audit evidence. API-key runs are not rewritten by this subscription-specific guard.

During tiered recovery, implementation-heavy work starts at `gpt-5.4` with high reasoning. If that lane reports a model-access failure, Paperclip advances into the Codex effort/spark catalog instead of retrying the same model or collapsing every Codex candidate back to `gpt-5.4`.

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Context And Output Economy

Paperclip classifies each prompt as `bootstrap`, `resume_delta`,
`timer_delta`, `comment_delta`, or `failure_recovery` and records hashed prompt
components in the context ledger. Resume deltas keep the current wake evidence
and output contract while avoiding full managed-instruction replay.

The adapter injects the `output-economy.v1` contract on every run. Ordinary
final responses should stay within 7 sentences, 1200 characters, or about 700
output tokens. Longer responses must start with `Expansion reason:` and cite
receipts/artifacts instead of pasting raw logs.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `codex exec` on every run.

This is separate from any workspace-level instruction discovery that Codex itself performs in the run `cwd`. Paperclip does not disable Codex-native repo instruction files, so a repo-local `AGENTS.md` may still be loaded by Codex in addition to the Paperclip-managed agent instructions.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
