---
name: ponytail
description: >
  Use for token-efficient implementation inside Paperclip autonomous factory runs:
  prefer deletion, reuse, standard library, existing tools, context packs, and
  focused receipts over speculative scaffolding or raw context replay.
license: MIT
---

# Ponytail For Paperclip

This is a bounded, markdown-only Paperclip adaptation of DietrichGebert/ponytail
at commit `99139a25d07e3523d3f6871419798dda600db49a`. The upstream runtime hooks
are intentionally not installed. Paperclip remains the control plane.

## Priority

Ponytail optimizes implementation shape, not mission scope. Do not simplify away:

- the assigned issue acceptance criteria
- Paperclip checkout, comment, and status requirements
- tests, documentation, receipts, and live validation explicitly required by the task
- security, privacy, authorization, input validation, or data-loss protections
- the Portfolio OS to Paperclip to Hermes factory loop

If Paperclip or the issue requires the complete thing, ship the complete thing.
Ponytail decides how little waste is needed to get there.

## Ladder

Stop at the first rung that works:

1. Does this need to run at all? No assignment, no mention handoff, no approval, no open assigned work: exit.
2. Does an existing artifact answer it? Use receipts, context packs, graph reports, dispatch ledgers, or issue context before raw replay.
3. Does the platform already do it? Use Paperclip issue locks, routine gates, context ledgers, and adapter routing instead of duplicating control logic.
4. Does a local tool already do it? Prefer `gstack`, Graphify, ScrapeGraphAI receipts, gbrain, Repomix/context packs, and existing repo scripts over hand-rolled scanners.
5. Does a dependency already exist in the repo? Use it instead of adding another one.
6. Then write the smallest durable code, test, and doc change that satisfies the issue.

## Factory Loop Rules

- Portfolio OS research and dispatch artifacts are upstream truth.
- Paperclip cockpit is the governed scheduler, issue, routine, approval, and receipt plane.
- Hermes and local adapters are execution lanes, not source-of-truth schedulers.
- `gstack` is invoked for QA/dogfooding evidence, not as a second recurring scheduler.
- Graphify is used for graph-backed recall or architecture maps when `graphify-out` exists.
- ScrapeGraphAI is used for structured extraction receipts when a web/local corpus must become durable research data.
- gbrain is used for semantic memory/code lookup when configured and indexed; otherwise fall back to direct source reads.

## Output Discipline

Keep run comments concise, but not incomplete:

- status line
- changed files or receipts
- tests run
- blocker and owner, if blocked
- next action, if not done

Avoid progress theatre. Do not emit long "I will now..." logs. Spend tokens on artifacts and verification.

## Tests

Any non-trivial change leaves one focused runnable check. Use the repo's own test command first. A small targeted test is enough when the blast radius is small; broaden only when shared contracts or production routing changed.
