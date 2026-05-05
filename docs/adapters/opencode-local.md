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

Hermes agents that use the same OpenCode Go provider are different: Hermes reads the provider from `~/.hermes/config.yaml`, so Paperclip stores the bare model id such as `deepseek-v4-flash` and leaves `adapterConfig.provider` as `auto`.

## Model Policy

- Use `deepseek-v4-flash` as the default loop model.
- Reserve `deepseek-v4-pro`, `glm-5.1`, and `mimo-v2.5-pro` for fewer harder calls.
- Prefer `kimi-k2.6` for multimodal, design, PM, and creative work, with fallbacks for reliability issues.
- Treat `kimi-k2.5`, `glm-5`, `mimo-v2-pro`, and `mimo-v2-omni` as fallback/specialty models.
- Prefer `minimax-m2.7` over `minimax-m2.5`; keep M2.5 only for cheap/light noncritical passes.
- Use `qwen3.5-plus` for cheap classification and coordination; use `qwen3.6-plus` when multimodal structure matters.

## Current Catalog

Paperclip tracks these OpenCode Go ids:

`minimax-m2.7`, `minimax-m2.5`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.1`, `glm-5`, `deepseek-v4-pro`, `deepseek-v4-flash`, `qwen3.6-plus`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2.5-pro`, `mimo-v2.5`.

Refresh `opencode models` before applying these defaults in production because OpenCode Go availability can change.
