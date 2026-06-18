# Skill Context And Provider Cache Tokenomics Report

Date: 2026-06-18

## Executive Summary

The highest-value missing cutover item was not another global token cap. It was that Hermes-local had adaptive Paperclip skill selection, while Claude-local and Gemini-local could still inherit broad Paperclip skill libraries. That left the fallback planes exposed to the same context bloat the Hermes lane had already fixed.

This report accompanies the cutover implementation that centralizes runtime skill selection in `@paperclipai/adapter-utils` and applies it across Hermes-local, Claude-local, and Gemini-local. The default policy remains adaptive and bounded to six runtime skills unless a run explicitly opts into `paperclipSkillBudgetMode=all`. Gemini-local also prunes stale Paperclip-managed skill symlinks from its persistent `~/.gemini/skills` directory, preventing old selections from silently remaining active across later runs.

Live Paperclip evidence from the embedded instance on `127.0.0.1:54329` shows why this matters:

- Company skill libraries are large: 4 companies, 118 minimum skills, 129 maximum skills, 121.3 average skills.
- Recent Hermes-local prompt metrics already show the desired runtime shape: 106 measured runs over the last five days, every measured run capped at `maxSkills=6`, with 11.9 skipped skills on average.
- Provider usage over the same window shows MiniMax still dominating, but not alone: MiniMax 448 runs, Google 25 runs, Anthropic 34 runs, and OpenCode-Go 10 runs.
- Cached input is already materially working: MiniMax reported 252,537,819 cached input tokens versus 135,092,288 fresh input tokens; Google reported 19,083,971 cached input tokens versus 4,011,714 fresh input tokens; Anthropic reported 1,658,051 cached input tokens.

The operational answer is therefore: keep the full autonomous software-factory loop, but enforce bounded runtime context at every adapter boundary and prefer deterministic process-plane work for mechanical maintenance.

## Implemented Cutover

The cutover is now code, not a recommendation:

- `packages/adapter-utils/src/server-utils.ts` exports `selectPaperclipRuntimeSkillsForRun`.
- `server/src/adapters/hermes-local/execute.ts` now uses the shared selector instead of a Hermes-only private copy.
- `packages/adapters/claude-local/src/server/execute.ts` mounts only selected Paperclip skills into the temporary `.claude/skills` directory and records `promptMetrics.skillBudget`.
- `packages/adapters/gemini-local/src/server/execute.ts` injects only selected Paperclip skills, removes stale Paperclip-managed Gemini symlinks, and records `promptMetrics.skillBudget`.
- Tests cover the shared selector plus Claude and Gemini runtime behavior.

This keeps the existing valuable Hermes/Paperclip upgrades intact: session-keyed continuity, prompt shaping, provider fallback, MiniMax quota preflight, process-plane runbooks, and the Portfolio OS to Paperclip to Hermes execution loop.

## Provider Cache Findings

### MiniMax

MiniMax supports passive prompt caching for repeated context and Anthropic-compatible explicit caching through `cache_control` on the Anthropic-compatible endpoint:

- Passive caching: <https://platform.minimax.io/docs/api-reference/text-prompt-caching>
- Explicit Anthropic-compatible caching: <https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache>
- Token Plan quota status endpoint: <https://platform.minimax.io/docs/token-plan/faq>

Production caveat: MiniMax Token Plan is explicitly described as individual interactive developer usage with 5-hour and weekly quota windows. The API endpoint `https://www.minimax.io/v1/token_plan/remains` is the right low-friction quota poll. Paperclip should keep using that poll as a preflight and should not launch MiniMax-backed Hermes work when the five-hour or weekly window is exhausted.

Action: keep MiniMax first for high-value Hermes work when quota exists, but never spend MiniMax on empty timer wakes, no-inbound triage, status-only checks, or deterministic maintenance.

### Anthropic / Claude API And Claude Code

Anthropic supports automatic and explicit prompt caching. The API caches prompt prefixes across `tools`, `system`, and `messages`; default TTL is five minutes; one-hour TTL is available at higher write cost; cache reads are priced at 0.1x base input in the API pricing model:

- Claude API prompt caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Claude Code prompt caching: <https://code.claude.com/docs/en/prompt-caching>

Claude Code subscription behavior is more favorable than the earlier cautious assumption: current Claude Code docs say subscription mode requests one-hour TTL automatically, while API-key and third-party provider modes default to five minutes unless `ENABLE_PROMPT_CACHING_1H=1` is set.

Production caveat: Claude Code cache scope depends on stable working directory, model, permission mode, tools, commands, and prefix. Subagents start their own cache. Invoking skills and commands appends instructions as user messages, which preserves earlier prefix cache, but broad skill injection still adds avoidable fresh context. This makes the shared six-skill Paperclip selector important even when Claude Code caching is healthy.

Action: use Sonnet and Haiku subscription lanes for smaller or short-context work, but keep skill injection bounded and preserve stable prefixes.

### Gemini API And Gemini CLI

Gemini API supports implicit caching on Gemini 2.5+ and explicit caching with a default one-hour TTL when using API-key based SDK/API flows:

- Gemini API context caching: <https://ai.google.dev/gemini-api/docs/caching>

Gemini CLI is different. Its token caching documentation says caching is available for Gemini API key and Vertex AI users, but not for OAuth users such as Google Personal or Enterprise accounts because the Code Assist API does not support cached content creation:

- Gemini CLI token caching: <https://geminicli.com/docs/cli/token-caching/>
- Gemini CLI FAQ: <https://google-gemini.github.io/gemini-cli/docs/faq.html>

Production caveat: if Paperclip uses Gemini CLI through the Google AI Pro/Ultra subscription/OAuth path, it should not assume cache creation is available even though subscription quota is available. The local adapter can still parse cached-token stats when the CLI emits them, but cache economics are more predictable through API key or Vertex AI.

Action: Gemini subscription/OAuth remains useful as a quota lane, but for cache-heavy autonomous factory work, prefer Gemini API key or Vertex AI if the goal is deterministic cache savings.

### OpenAI / Codex

OpenAI prompt caching is available for prompts of at least 1,024 tokens, and usage includes `cached_tokens` in prompt token details:

- OpenAI prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>

Hermes already adds a `prompt_cache_key` for OpenAI Responses usage where applicable. Codex subscription usage can be valuable for high-reasoning research and planning, but subscription harnesses do not always expose the same billing telemetry as API lanes.

Action: keep Codex/GPT-class work for high-leverage research, architecture, review, and plan synthesis. Do not use it for deterministic maintenance if a process-plane runner can produce the same final artifact.

## Red-Team Caveats

The remaining production cutover risks are concrete:

- Adapter drift: any future adapter that bypasses `selectPaperclipRuntimeSkillsForRun` can reintroduce broad skill preloads.
- Persistent Gemini state: Gemini-local now removes stale Paperclip-managed symlinks, but it intentionally does not delete user-installed Gemini skills. A polluted user skill directory can still add context outside Paperclip's control.
- Prefix instability: provider caches are prefix-based. Dynamic timestamps, changing tool lists, changing cwd, changed permission modes, broad injected prior-run logs, and model switching can turn cached workloads back into fresh-token workloads.
- Subscription telemetry: Claude Code and Gemini CLI subscription lanes are useful quota sources, but API-key and Vertex/API flows expose more explicit cache and usage accounting.
- Library size: 118-129 company skills is acceptable only if runtime selection stays bounded. The library itself still needs periodic curation so role packs do not become noisy.
- Cached token accounting: cached input tokens are not free. They reduce cost and latency, but subscription windows and some provider usage bars can still be consumed by repeated cached work.
- Output-value accounting: accepted patches, closed runs, and PRs are ingredients. The factory success metric must be final deliverables: shipped fixes, validated reports, operational receipts, refreshed research artifacts, and resolved production issues.

## Operational Cutover Plan

1. Keep Paperclip as the cockpit for companies, issues, approvals, routines, context ledgers, and flywheel receipts.
2. Keep Hermes as the build executor for software work, but route mechanical tasks through deterministic process-plane runbooks when available.
3. Preserve the recursive loop: Portfolio OS research and dispatch artifacts flow into Paperclip, Paperclip scopes the work, adapters invoke Hermes or local CLIs, and evidence tools such as ScrapeGraphAI, Graphify, GStack, GBrain, context packs, and Repomix provide bounded inputs and receipts.
4. Enforce `promptMetrics.skillBudget` on every model-backed local adapter. Missing metrics should be treated as invalid tokenomics evidence.
5. Keep `paperclipSkillBudgetMode=adaptive` as the default fleet setting. Use `all` only for explicitly broad specialist tasks where every skill is part of the deliverable.
6. Prefer provider quota in this order when available and appropriate: MiniMax for high-value Hermes work, Gemini subscription/API lane when MiniMax is exhausted, Claude Sonnet/Haiku subscription for bounded work, Codex/GPT-class lanes for high-leverage research or architectural synthesis.
7. Poll MiniMax `token_plan/remains` before MiniMax runs and record reset/release context so the scheduler does not wait blindly while quota is available.
8. For Gemini, decide per lane whether subscription quota or cache economics matter more. Use OAuth/subscription for quota availability; use API key or Vertex when cached-token economics are the objective.
9. Continue skipping empty timer wakes, no-inbound triage, no-new-signal issue continuations, and budget-exhausted loops before adapter launch.
10. Require final deliverable receipts, not just runs, as the output metric.

## Verification

Code verification completed:

- `pnpm --filter @paperclipai/adapter-utils typecheck`
- `pnpm --filter @paperclipai/adapter-claude-local typecheck`
- `pnpm --filter @paperclipai/adapter-gemini-local typecheck`
- `pnpm --filter @paperclipai/server typecheck`
- `pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts`
- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/agent-live-run-routes.test.ts`
- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-process-recovery.test.ts`
- `pnpm --filter @paperclipai/server exec vitest run --testTimeout=15000`

The default full server suite run with the stock 5-second timeout had two unrelated parallel-load timeouts, then both tests passed in isolation and the full suite passed with a 15-second timeout: 157 test files, 1010 tests passed, 1 skipped.

Runtime verification completed:

- Paperclip health endpoint returned `status=ok`, version `0.3.1`, authenticated private deployment, auth ready.
- Live embedded Postgres showed skill libraries of 118-129 company skills and recent adaptive skill budgets capped at six selected skills.
- Last five days of usage show traffic across MiniMax, Google, Anthropic, and OpenCode-Go rather than MiniMax-only routing.

## Acceptance Standard

This cutover should be considered operational only when all of the following remain true in fresh receipts:

- Every model-backed adapter reports skill budget metrics.
- Runtime-selected Paperclip skills stay at or below six by default.
- Empty control-plane wakes do not launch model calls.
- Provider usage records fresh input, cached input, output, provider, model, and session identity when the provider exposes them.
- MiniMax quota recovery is polled rather than guessed.
- Gemini subscription usage is separated from Gemini API/Vertex cache economics.
- Final deliverables are tracked separately from intermediate build runs.
