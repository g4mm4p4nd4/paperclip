---
title: Gemini Local
summary: Gemini CLI local adapter setup and configuration
---

The `gemini_local` adapter runs Google's Gemini CLI locally. It supports session persistence with `--resume`, skills injection, and structured `stream-json` output parsing.

## Prerequisites

- Gemini CLI installed (`gemini` command available)
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` set, or local Gemini CLI auth configured

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Gemini CLI model to use. Defaults to `auto`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `yolo` | boolean | No | Pass `--approval-mode yolo` for unattended operation |

## Context-Aligned Model Options

The adapter keeps current Gemini CLI tiered models in its selectable model list so tiered recovery can stay aligned to the task and agent role instead of falling back to one generic Gemini model.

| Model id | Display label | Typical use |
| --- | --- | --- |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Executive, chief-of-staff, research, QA, and design synthesis |
| `gemini-3-pro` | Gemini 3 Pro | Strategic work that needs Pro-level reasoning |
| `gemini-3-pro-preview` | Gemini 3 Pro Preview | Pro recovery when the stable Pro ids are unavailable |
| `gemini-3.5-flash` | Gemini 3.5 Flash | First Flash-tier recovery for implementation and operations loops |
| `gemini-3-flash` | Gemini 3 Flash | Implementation and operations loops |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | Flash recovery when the stable Flash id is unavailable |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Older Pro fallback after Gemini 3 model-access failures |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Older Flash fallback for implementation/support work |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | Lightweight support fallback |
| `gemini-2.0-flash` | Gemini 2.0 Flash | Legacy Flash fallback |
| `gemini-2.0-flash-lite` | Gemini 2.0 Flash Lite | Last-resort lightweight Gemini fallback |

Non-Gemini provider ids such as Claude, GPT-OSS, OpenRouter, and OpenCode models are intentionally not advertised by `gemini_local`; those belong on their native fallback lanes. If Gemini reports a model-access failure, Paperclip rotates to the next role-appropriate Gemini id instead of retrying the same unavailable model.

## Session Persistence

The adapter persists Gemini session IDs between heartbeats. On the next wake, it resumes the existing conversation with `--resume` so the agent retains context.

Session resume is cwd-aware: if the working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

When a Gemini session is resumed, Paperclip sends only the current wake delta
instead of prepending the full managed instructions and heartbeat template again.
Comment wakes use the inline comment batch. Timer wakes with no inline issue or
comment payload use a compact `## Paperclip Resume Delta` containing the wake
reason, source, run id, and available cursors. This keeps unattended timer
heartbeats from replaying the full agent instruction pack on every resume.

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

The adapter symlinks Paperclip skills into the Gemini global skills directory (`~/.gemini/skills`). Existing user skills are not overwritten.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Gemini CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth hints (`GEMINI_API_KEY` or `GOOGLE_API_KEY`)
- A live hello probe (`gemini --output-format json "Respond with hello."`) to verify CLI readiness
