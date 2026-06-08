# Context Ledger

Paperclip stores prompt provenance before adapter spawn. The ledger is not a raw
prompt archive; raw prompt text is redacted and represented by fingerprints,
component hashes, artifact references, and evidence-slice counts.

## Tables

- `context_ledger_entries`: one row per adapter prompt attempt. Captures company,
  run, agent, issue/task key, cwd, branch, adapter type/version, prompt class,
  prompt fingerprint, session ids, cursors, budget decision, token usage, final
  outcome/blocker, receipt paths, response class, output-budget status, final
  response size, and final response hash.
- `context_ledger_components`: per-component chars/tokens/hash/truncation flags.
- `agent_context_cursors`: monotonic comment and wake cursors per company/agent.
- `prompt_budget_policies`: scoped policy rows used before adapter spawn.

## Budget Enforcement

Heartbeat creates the ledger entry from adapter metadata before invoking the
adapter process. A hard-stop policy rejects the spawn with `prompt_budget_exceeded`.
Soft policies record budget status and allow the run to proceed.

Output budgets are evaluated at run finalization. They do not kill completed
work, but they classify the response as `compact_success`, `compact_failure`,
`compact_status`, an allowed expanded class, or `verbose_unjustified`. Ledger
rows store `outputBudgetVersion`, `outputBudgetStatus`, `outputBudgetLimitTokens`,
`estimatedOutputTokens`, `actualOutputTokens` when available,
`finalResponseChars`, `finalResponseSentenceCount`, and `finalResponseSha256`.
The raw final text remains in the heartbeat run result/log path; the ledger keeps
the bounded hash and size evidence.

## Provider Reliability Gate

Provider-backed lanes are checked before spawn. The ledger metadata records
`providerReliabilityGate` and `executionRouting` so operators can see the source
run, failure kind, skipped lanes, selected lane, preflight attempts, and final
adapter/model. Auth, billing, quota, rate-limit, and failed preflight results are
treated as lane-wide failures during the degraded window; model-access failures
may be retried only when the candidate model changes.

## Local Adapter Prompt Contract

Local adapters emit the same context-economy metadata before spawn:

- `promptClass`: `bootstrap`, `resume_delta`, `timer_delta`, `comment_delta`, or
  `failure_recovery`.
- `promptBudgetVersion`: currently `context-economy.v1`.
- `outputBudgetVersion`: currently `output-economy.v1`.
- `components`: hashed prompt slices for managed instructions, bootstrap prompt,
  Paperclip wake evidence, context-pack manifest, session handoff, runtime note,
  output contract, and heartbeat prompt when present.
- `evidenceSliceCount`: count of decisive evidence slices included in the prompt.
- `promptMetrics.internetPipes`: when a Portfolio-OS/Hermes run includes
  Internet Pipes gates, the sanitized adapter invocation keeps readiness,
  missing stations, recommendations, and source paths so flywheel health can
  audit the station contract without persisting the raw prompt.

The `output_contract` component tells agents to keep ordinary final responses to
7 sentences, 1200 characters, or about 700 output tokens. Longer responses must
start with `Expansion reason: <reason>` and are allowed only for explicit
operator requests, unresolved blockers, failed verification, code-review or
security findings, legal/financial risk, or unsafe handoff compression. Bulky
proof belongs in receipts/artifacts with cited paths and hashes, not pasted back
into the final response.

On wake-delta resumes, local adapters must not reinject full managed
instructions or generic heartbeat boilerplate. They keep the current wake,
context-pack manifest, and handoff evidence, and they record skipped components in
component metadata. This applies across Codex, Gemini, OpenCode, Claude, Cursor,
and Pi local adapters.

Timer resumes are covered even when there is no inline issue/comment wake
payload. In that case adapters emit a compact `## Paperclip Resume Delta` with
the wake reason/source/run id and any task/comment cursors available, classify it
as `timer_delta`, and keep managed instructions, runtime notes, and generic
heartbeat prompt text out of the replay payload.

## Readback

- `GET /api/heartbeat-runs/:runId/context-ledger`
- `GET /api/issues/:issueId/context-ledger`
- `GET /api/companies/:companyId/flywheel-health?hours=1`
- `GET /api/companies/:companyId/flywheel-health/reports`
- `POST /api/companies/:companyId/flywheel-health/context-economy-canaries`

The UI run log shows prompt class, prompt budget status, output response class,
output budget status, prompt fingerprint, component hashes, pack refs, artifact
refs, receipt paths, final response hash/size, and extracted evidence counts.

Flywheel health reports include `canaryReadiness`. A run counts as a ready
canary only when it is issue-linked, succeeded, the issue is done, the run has a
ledger row, receipt path, passing test evidence, changed-file evidence, context
pack refs, and no hard-stop prompt budget or provider failure. Successful runs
that lack any of those fields appear under `canaryReadiness.missing` with the
specific evidence gaps, such as `receipt_path`, `passing_tests`,
`changed_files`, or `context_pack_ref`.

Operators should treat `tasksCompleted` alone as insufficient. The remediation
gate for unattended engineering is `canaryReadiness.readyCount` plus the example
payload showing prompt class, adapter type, budget status, receipt paths,
changed files, context pack refs, and provider reroute status.

Flywheel health also reports `outputTokensByResponseClass`, `totalOutputTokens`,
and `outputBudgetViolations`. Use those fields to find agents that complete real
work but waste output tokens in verbose final messages. That is a quality/cost
regression, not a reason to starve decisive context.

The context-economy canary endpoint creates missing canary issues by default and
skips repos that already have ready proof. Use request body `force: true` only
for an explicit re-certification run; it still refuses targets without a fresh
map-pack envelope and still enqueues the resulting issue through the normal
heartbeat wakeup path.

## Redaction

The service stores prompt SHA-256 and prompt character count, not raw prompt
content. Sensitive component previews are omitted. Artifact and context-pack refs
are preserved as pointers plus hashes so auditability remains intact.

Receipt paths can be extracted from ordinary stdout/stderr text, not only from
dedicated `receiptPath` fields. Successful runs must not turn summary text into a
`finalBlocker`; actual token usage that exceeds the pre-spawn policy is recorded
as a warning in ledger metadata. Verbose final summaries are compacted before
issue-comment replay so future prompts receive the decisive lead/evidence lines
instead of paragraphs of already-audited narration.
