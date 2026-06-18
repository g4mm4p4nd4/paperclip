---
title: OpenCode Local
summary: Configure Paperclip agents that run through the local OpenCode CLI.
---

# OpenCode Local

`opencode_local` runs the local `opencode` CLI and requires an explicit model in `provider/model` format.

## OpenCode Go Routing

Paperclip's balanced production defaults use OpenCode Go for cheap durable loops first, escalating only for harder calls. Store the model in `adapterConfig.model` as `opencode-go/<model-id>` and the reasoning effort in `adapterConfig.variant`.

| Paperclip role | Primary model | Variant |
| --- | --- | --- |
| `engineer` | `opencode-go/deepseek-v4-flash` | `high` |
| `integration_engineer` | `opencode-go/deepseek-v4-flash` | `high` |
| `devops` | `opencode-go/deepseek-v4-flash` | `high` |
| `qa` | `opencode-go/deepseek-v4-flash` | `high` |
| `cto` | `opencode-go/deepseek-v4-pro` | `high` |
| `ceo` | `opencode-go/deepseek-v4-pro` | `high` |
| `pm` | `opencode-go/kimi-k2.6` | `high` |
| `designer` | `opencode-go/kimi-k2.6` | `high` |
| `researcher` | `opencode-go/deepseek-v4-flash` | `high` |
| `skill_curator` | `opencode-go/qwen3.5-plus` | `medium` |
| `cmo` | `opencode-go/kimi-k2.6` | `high` |
| `cfo` | `opencode-go/deepseek-v4-pro` | `high` |
| `general` / `default` | `opencode-go/deepseek-v4-flash` | `medium` |

Hermes agents that use the same OpenCode Go provider store the bare model id such as `deepseek-v4-flash` and pin `adapterConfig.provider` to `opencode-go`. The Hermes Paperclip adapter also disables Hermes' global `fallback_model` by default, so manual long-context paid choices do not silently downgrade into OpenCode Zen free models. `qwen3.7-max` is currently rejected by the OpenCode Go OpenAI-compatible transport, so Hermes routes that selection to `deepseek-v4-pro` to preserve a paid 1M-context lane.

## OpenCode Zen Free Emergency Mode

When OpenCode Go quota is exhausted, Paperclip can advertise explicit Zen free model ids for reduced-frequency recovery work:

- `opencode-zen/deepseek-v4-flash-free` - first fallback for coding agents when tools are needed and Go is capped.
- `opencode-zen/mimo-v2.5-free` - long-context fallback for large repo or spec reads.
- `opencode-zen/nemotron-3-super-free` - general free fallback when DeepSeek/MiMo are unavailable.
- `opencode-zen/big-pickle` - last-resort free fallback.

Use these as emergency selections, not normal role-routing defaults. During free-mode incidents, lower heartbeat frequency, cap concurrent runs, and send compact task-specific context. Prefer targeted file reads, `rg`, `git diff`, and scoped Repomix-style digests over full repository payloads.

For a bounded repository digest, start from explicit paths and compression:

```sh
npx repomix@latest --include "src/**/*.ts,docs/**/*.md" --ignore "**/*.test.ts,dist/**,coverage/**" --compress -o /tmp/paperclip-context.xml
```

## Tiered Recovery Routing

The heartbeat harness treats recent OpenCode/Hermes quota failures as a routing signal. If an `opencode_local` or OpenCode-backed `hermes_local` agent has a recent quota, rate-limit, auth, billing, or model-access failure, Paperclip checks the local host for recovery harnesses and switches to `hermes_minimax` by default. This lane runs Hermes through the direct MiniMax provider with `MiniMax-M3`; model-access failures rotate to `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, and lower MiniMax fallbacks before Paperclip considers the MiniMax lane exhausted.

MiniMax exposes both OpenAI-compatible and Anthropic-compatible protocols. Paperclip's `hermes_minimax` lane must keep `provider` set to `minimax` or `minimax-cn`; do not configure it as Anthropic/Claude. If an external Claude-compatible tool is configured separately, its base URL must be MiniMax's compatible endpoint such as `https://api.minimax.io/anthropic`, not Anthropic's API host. OpenAI-compatible tools should use `https://api.minimax.io/v1`.

Post-MiniMax fallbacks are approval-gated. By default, once `hermes_minimax` is stalled, automatic heartbeats and routine wakes are persisted as `skipped` with `provider_degraded_backoff` evidence instead of creating more failed runs. A run context or adapter policy must explicitly set `allowPostMiniMaxFallbacks`, `approvePostMiniMaxFallback`, `allowPaidSubscriptionFallbacks`, or `approvePaidSubscriptionFallback` before Paperclip may move into any later lane.

When explicit post-MiniMax approval is present, Paperclip can continue through the configured recovery lanes:

1. `hermes_opencode_zen_free` through `hermes_local`, using `opencode-zen/deepseek-v4-flash-free` unless overridden. This lane is only eligible for implementation/support roles; executive and strategic roles such as CEO, chief-of-staff, PM, research, QA, and design skip it even when post-MiniMax fallback is approved.
2. `gemini_local` using Gemini CLI subscription/OAuth auth with locally verified Gemini model ids: executive/research/QA/design work starts on Pro-tier models such as `gemini-3.1-pro-preview`, implementation work starts on Flash-tier models such as `gemini-3-flash-preview`, and support work can use Flash Lite. Rejected stable aliases such as `gemini-3.1-pro`, `gemini-3.5-flash`, and Gemini 2.0 ids are intentionally omitted.
3. `claude_local` using native Claude Code CLI (`claude --print`) with parent Claude/Codex harness markers stripped before spawn. Under the Pro subscription policy, Claude fallback uses Sonnet 4.6 for high-intelligence work and Haiku 4.5 for lightweight work; Opus is only used when explicitly configured.
4. `codex_local` using `gpt-5.4` with high reasoning for implementation-heavy work, then Codex effort/spark candidates such as `gpt-5.3-codex-high`, `gpt-5.3-codex-spark`, and `gpt-5.3-codex-spark-preview` after model-access failures.
5. `hermes_openrouter` through `hermes_local` only when explicitly configured, mapping the agent's intended OpenCode Go model to the matching OpenRouter id, for example `deepseek-v4-flash` -> `deepseek/deepseek-v4-flash`, `kimi-k2.6` -> `moonshotai/kimi-k2.6`, and `qwen3.7-max` -> `qwen/qwen3.7-max`, unless overridden.

The switch is per run. It preserves portable execution config such as `cwd`, `instructionsFilePath`, prompt templates, environment, workspace strategy, and runtime settings, but starts adapter-specific sessions under the selected adapter so OpenCode sessions are not mixed with Codex, Claude, or Gemini sessions. Hermes API fallback lanes also start fresh Hermes sessions, so an OpenCode Go session is not resumed under Zen free or OpenRouter.

Operators can override the order and model defaults in `adapterConfig.tieredExecution`:

```json
{
  "tieredExecution": {
    "adapterOrder": [
      "hermes_minimax",
      "hermes_opencode_zen_free",
      "gemini_local",
      "claude_local",
      "codex_local"
    ],
    "hermes_minimax": { "model": "MiniMax-M3", "provider": "minimax" },
    "hermes_opencode_zen_free": { "model": "deepseek-v4-flash-free" },
    "hermes_openrouter": { "model": "moonshotai/kimi-k2.6" },
    "codex_local": { "model": "gpt-5.4", "modelReasoningEffort": "high" },
    "claude_local": { "authMode": "subscription", "model": "claude-sonnet-4-6", "effort": "high" },
    "gemini_local": { "authMode": "subscription", "model": "gemini-3.1-pro-preview" }
  }
}
```

If MiniMax, Gemini, Claude, or Codex fails only because the selected model is unavailable, the next run may retry the same lane with the next role-appropriate model instead of skipping the provider entirely. Auth, billing, quota, rate-limit, and generic preflight failures stall the whole lane. Without explicit post-MiniMax approval, that stall stops automatic recovery at MiniMax.

Recovery is automatic only up to MiniMax. A clean newer normal OpenCode/Hermes run clears older stall evidence inside the recovery window, so agents return to the role-appropriate OpenCode Go model instead of staying pinned to fallback lanes. While the stall is active, routed runs are marked as `degraded`; after a 30-minute cooldown Paperclip allows a normal recovery probe even if fallback runs kept succeeding. Manual and on-demand wakes also re-probe providers immediately, but post-MiniMax inference still requires one of the explicit approval flags above. A successful run that still contains provider-limit text, such as Hermes switching internally after `HTTP 429`, remains a stall signal until the cooldown passes or a later normal run completes cleanly. If a fallback lane itself reports a quota or usage stall, Paperclip records that lane and advances only when the next lane is inside the approved boundary.

If no approved fallback harness is available after a recent provider stall, automatic wakes are persisted as `skipped` with `provider_degraded_backoff` evidence for the recovery window instead of producing another failed run.

## Context Economy

When context packs are present under the active Paperclip instance, heartbeat runs inject a compact context-economy note into Codex, Claude Code, Gemini, and OpenCode prompts. Agents are told to read the map or compact index first, use delta packs for dirty-tree context, reserve core packs for broad-context tasks, and avoid pasting entire repositories or transcripts into messages.

Paperclip also injects the `output-economy.v1` contract on every local adapter
run. Ordinary final responses should stay within 7 sentences, 1200 characters,
or about 700 output tokens. Longer responses must start with `Expansion reason:`
and cite receipts/artifacts instead of pasting raw logs. Flywheel health reports
surface `verbose_unjustified` responses as output-budget violations even when the
run completed useful work.

The injected paths include:

- `latest.json`, `latest.compact.md`, `latest.tsv`, and `latest.toon`
- `CONTEXT_ECONOMY.md`
- repo-specific Repomix packs such as `paperclip-map-latest.md`, `paperclip-delta-latest.md`, and `paperclip-core-latest.md`

Set `PAPERCLIP_CONTEXT_PACKS_DIR` to override the pack directory. Otherwise Paperclip uses `PAPERCLIP_HOME/instances/<id>/data/ops/context-packs`.

## Model Policy

- Use `deepseek-v4-flash` as the default loop model.
- Preserve `deepseek-v4-pro` for high-stakes 1M-context planning, synthesis, and architecture work.
- Do not route executive or strategic work to low-intelligence free fallback lanes such as Zen free/GPT-OSS-style recovery models; use MiniMax, Gemini Pro, Claude Opus/Sonnet, or high-reasoning Codex lanes that match the assignment.
- Treat `deepseek-v4-flash`, `mimo-v2.5`, and `qwen3.7-max` as 1M-context alternatives when intelligence/cost tradeoffs fit the task. For Hermes/OpenAI-compatible OpenCode Go runs, `qwen3.7-max` is normalized to `deepseek-v4-pro` until native Qwen transport support is available.
- During quota failures, use `opencode-zen/deepseek-v4-flash-free` or `opencode-zen/mimo-v2.5-free` before weaker free fallbacks.
- Reserve `glm-5.1` and `mimo-v2.5-pro` for fewer harder calls.
- Prefer `kimi-k2.6` for multimodal, design, PM, and creative work, with fallbacks for reliability issues.
- Treat `kimi-k2.5`, `glm-5`, `mimo-v2-pro`, and `mimo-v2-omni` as fallback/specialty models.
- Prefer direct MiniMax `MiniMax-M3` for Hermes autonomous development, coding, and long-context recovery work; use `MiniMax-M2.7`/`MiniMax-M2.7-highspeed` as MiniMax fallbacks or when throughput/cost constraints explicitly outweigh M3 capacity. For OpenCode Go catalog entries, prefer `minimax-m2.7` over `minimax-m2.5`; keep M2.5 only for cheap/light noncritical passes.
- Use `qwen3.5-plus` for cheap classification and coordination; use `qwen3.6-plus` when multimodal structure matters; evaluate `hy3-preview` before assigning it production traffic.

## Current Catalog

Paperclip tracks these OpenCode Go ids:

`minimax-m2.7`, `minimax-m2.5`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.1`, `glm-5`, `deepseek-v4-pro`, `deepseek-v4-flash`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2.5-pro`, `mimo-v2.5`, `hy3-preview`.

Paperclip also advertises these OpenCode Zen free ids:

`deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-super-free`, `big-pickle`.

Refresh `opencode models` before applying these defaults in production because OpenCode Go and Zen availability can change.
