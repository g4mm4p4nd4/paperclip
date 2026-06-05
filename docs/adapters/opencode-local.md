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

The heartbeat harness now treats recent OpenCode/Hermes quota failures as a routing signal. If an `opencode_local` or OpenCode-backed `hermes_local` agent has a recent quota or usage-limit failure, Paperclip checks the local host for fallback harnesses and switches the run in this order by default:

1. `hermes_openrouter` through `hermes_local`, mapping the agent's intended OpenCode Go model to the matching OpenRouter id, for example `deepseek-v4-flash` -> `deepseek/deepseek-v4-flash`, `kimi-k2.6` -> `moonshotai/kimi-k2.6`, and `qwen3.7-max` -> `qwen/qwen3.7-max`, unless overridden.
2. `hermes_opencode_zen_free` through `hermes_local`, using `opencode-zen/deepseek-v4-flash-free` unless overridden.
3. `gemini_local` using Gemini CLI, with Pro for research/QA/design and Flash for lighter implementation loops.
4. `claude_local` using native Claude Code CLI (`claude --print`) with Opus for CEO/CTO synthesis and Sonnet for most implementation.
5. `codex_local` using `gpt-5.4` with high reasoning for implementation-heavy work. `gpt-5.4-mini` is valid for lower-cost explicit overrides.

The switch is per run. It preserves portable execution config such as `cwd`, `instructionsFilePath`, prompt templates, environment, workspace strategy, and runtime settings, but starts adapter-specific sessions under the selected adapter so OpenCode sessions are not mixed with Codex, Claude, or Gemini sessions. Hermes API fallback lanes also start fresh Hermes sessions, so an OpenCode Go session is not resumed under Zen free or OpenRouter.

Operators can override the order and model defaults in `adapterConfig.tieredExecution`:

```json
{
  "tieredExecution": {
    "adapterOrder": [
      "hermes_openrouter",
      "hermes_opencode_zen_free",
      "gemini_local",
      "claude_local",
      "codex_local"
    ],
    "hermes_opencode_zen_free": { "model": "deepseek-v4-flash-free" },
    "hermes_openrouter": { "model": "moonshotai/kimi-k2.6" },
    "codex_local": { "model": "gpt-5.4", "modelReasoningEffort": "high" },
    "claude_local": { "model": "claude-sonnet-4-6", "effort": "high" },
    "gemini_local": { "model": "gemini-2.5-pro" }
  }
}
```

Recovery is automatic. A clean newer normal OpenCode/Hermes run clears older stall evidence inside the recovery window, so agents return to the role-appropriate OpenCode Go model instead of staying pinned to fallback lanes. While the stall is active, routed runs are marked as `degraded`; after a 30-minute cooldown Paperclip allows a normal recovery probe even if fallback runs kept succeeding. Manual and on-demand wakes also re-probe providers immediately, which lets an operator restore OpenRouter credits and validate recovery without waiting for the timer cooldown. A successful run that still contains provider-limit text, such as Hermes switching internally after `HTTP 429`, remains a stall signal until the cooldown passes or a later normal run completes cleanly. If a fallback lane itself reports a quota or usage stall, Paperclip records that lane and advances to the next configured lane instead of retrying it forever.

If no fallback harness is available after a recent quota stall, timer heartbeats back off for the recovery window instead of repeatedly spending free API calls on likely failures.

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
- Treat `deepseek-v4-flash`, `mimo-v2.5`, and `qwen3.7-max` as 1M-context alternatives when intelligence/cost tradeoffs fit the task. For Hermes/OpenAI-compatible OpenCode Go runs, `qwen3.7-max` is normalized to `deepseek-v4-pro` until native Qwen transport support is available.
- During quota failures, use `opencode-zen/deepseek-v4-flash-free` or `opencode-zen/mimo-v2.5-free` before weaker free fallbacks.
- Reserve `glm-5.1` and `mimo-v2.5-pro` for fewer harder calls.
- Prefer `kimi-k2.6` for multimodal, design, PM, and creative work, with fallbacks for reliability issues.
- Treat `kimi-k2.5`, `glm-5`, `mimo-v2-pro`, and `mimo-v2-omni` as fallback/specialty models.
- Prefer `minimax-m2.7` over `minimax-m2.5`; keep M2.5 only for cheap/light noncritical passes.
- Use `qwen3.5-plus` for cheap classification and coordination; use `qwen3.6-plus` when multimodal structure matters; evaluate `hy3-preview` before assigning it production traffic.

## Current Catalog

Paperclip tracks these OpenCode Go ids:

`minimax-m2.7`, `minimax-m2.5`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.1`, `glm-5`, `deepseek-v4-pro`, `deepseek-v4-flash`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2.5-pro`, `mimo-v2.5`, `hy3-preview`.

Paperclip also advertises these OpenCode Zen free ids:

`deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-super-free`, `big-pickle`.

Refresh `opencode models` before applying these defaults in production because OpenCode Go and Zen availability can change.
