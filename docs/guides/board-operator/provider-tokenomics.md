# Provider Tokenomics Guardrails

## Profit Flywheel v2 provider authority

This section is the authoritative July 2026 contract. The June operational
history below remains useful evidence, but its fleet-local fallback lists,
heartbeat tuning, and provider assumptions do not override v2.

Paperclip has one provider-policy authority:

- policy: `config/provider-policy.v2.json`
- schema: `config/provider-policy.v2.schema.json`
- loader and semantic validator: `server/src/services/provider-policy.ts`
- route-core hash implementation: `server/src/services/provider-route-hash.ts`
- bounded canary runner: `server/src/ops/provider-policy-canary.ts`

Both files are pinned by SHA-256 in `provider-policy.ts`. Every inference-backed
stage stores the policy hash, schema hash, route ID, provider family, exact
model/version, route-core hash, resolved-route hash, and route snapshot.
V2-conformant live agent JSON keeps only a binding to this policy and its
capability alias. It must not carry a second tier list, fallback model, budget
override, or provider selection.

The immutable policy rules are:

- Paperclip selects and escalates routes; Hermes fallback is disabled.
- A route change starts a fresh transcript from artifact checkpoints.
- Ordered aliases use the cheapest capable, currently healthy route first.
- Independent review uses a provider family different from the builder.
- Emergency/free routes are emergency-only and cannot approve release.
- Runtime command realpath, binary hash, version, and, for Hermes, source
  revision/tree/module hashes must match the policy before a canary is healthy.
  The command alone is not sufficient: its complete policy-pinned runtime
  closure must also verify before either a canary or a work process can spawn.
- A Hermes route canary must advertise `--max-total-tokens` before provider
  spawn. Paperclip passes the signed input ceiling as its stricter whole-run
  ceiling and requires state-backed input and total usage to remain within it.
- Provider auth, billing, quota, rate limit, capability mismatch, malformed
  response, transient network failure, process loss, and credential compromise
  remain distinct failure classes. Do not flatten them into `provider_failed`.

### Issue-scoped deterministic adapter overrides

Provider-policy bindings govern normal model-routed agent execution. They do not
globally replace an issue's explicit `assigneeAdapterOverrides.adapterType`
execution contract. When a routine creates a local deterministic issue with an
issue-scoped adapter switch such as `adapterType: "process"` plus its runbook
config, that explicit adapter switch is terminal for that issue's assignment
wake, manual issue wake, timer-pinned wake, and one-shot stale process-loss
retry. An `adapterConfig` overlay without an explicit `adapterType` is not
terminal authority and cannot bypass provider-policy validation or provider
backoff. The agent's provider-policy binding must remain configured and
frozen-byte validated for its next model-routed issue, but the deterministic
issue executes through the issue-owned adapter, records `executionAdapterType:
"process"`, and must not book provider tokens or provider cost events.

Current capability aliases and budgets are:

| Alias | Ordered role | Budget |
| --- | --- | --- |
| `research_fast` | OpenCode Go, Gemini Flash, MiniMax | `research_normal` |
| `research_deep` | OpenCode Go, Gemini Pro, Claude, Codex | `research_escalated` |
| `code_fast` | OpenCode Go, MiniMax, Codex | `implementation` |
| `code_deep` | OpenCode Go, Claude, MiniMax, Codex | `implementation` |
| `multimodal_qa` | Gemini Pro, Claude | `review` |
| `independent_review` | OpenCode Zen free (explicit emergency reviewer), MiniMax, Gemini Pro, Claude, Codex | `review` |
| `summarization` | OpenCode Go, Gemini Flash, Claude | `maintenance` |
| `emergency_free` | OpenCode Zen free only | `status_no_work`; never release |

| Budget class | Turns | Context chars | Output chars | Total tokens | Escalations |
| --- | ---: | ---: | ---: | ---: | ---: |
| `status_no_work` | 4 | 8,000 | 1,200 | 8,000 | 0 |
| `maintenance` | 6 | 12,000 | 1,800 | 20,000 | 1 |
| `research_normal` | 10 | 24,000 | 4,000 | 40,000 | 1 |
| `research_escalated` | 10 | 24,000 | 4,000 | 160,000 | 1 |
| `implementation` | 48 | 32,000 | 6,000 | 160,000 | 1 |
| `review` | 24 | 24,000 | 4,000 | 60,000 | 1 |

Status, maintenance, and research use a 16,000-byte / 320-line / 1,000-character
tool-output ceiling. Review uses 32 KiB / 640 lines / 16 KiB per line;
implementation uses 512 KiB / 4,096 lines / 16 KiB per line. The larger
work-bearing envelopes are still hard limits, but leave enough room to inspect,
test, commit, review, and write the required immutable receipts.

### Direct subscription CLI budget enforcement

Codex-local, Claude-local, and Gemini-local receive the resolved policy budget
as immutable adapter configuration. They enforce it independently of the
prompt contract and the heartbeat's post-run defense-in-depth check:

- Context is checked before provider spawn. Claude and Gemini first shrink only
  safely truncatable prompt sections and then reject an irreducibly oversized
  prompt with `provider_context_budget_exceeded`; Codex rejects its assembled
  prompt at the same boundary. A context rejection spends no provider turn.
- Claude receives its effective turn ceiling through the native `--max-turns`
  flag. Gemini receives `model.maxSessionTurns` through a per-run, mode-`0600`
  system-settings overlay selected by `GEMINI_CLI_SYSTEM_SETTINGS_PATH`; the
  overlay preserves eligible existing system settings and is deleted after the
  attempt. Codex `exec` has no native max-turn flag. Paperclip must not invent
  or pass one: invocation metadata records that limitation, while the remaining
  token, tool-output, final-output, and process-time limits stay hard failures.
- After a provider result is observed, input plus output tokens above
  `maxTotalTokens` fail with `provider_total_token_budget_exceeded`, and final
  response characters above `outputMaxChars` fail with
  `provider_output_budget_exceeded`. Either failure clears the resumable session
  so a later run cannot continue beyond the exhausted budget.
- Tool-output enforcement is live. The shared child-process layer observes
  complete structured JSONL events across arbitrary stdout chunk boundaries,
  recognizes Codex command/MCP results, Claude tool-result blocks, and Gemini
  nested or top-level completed tool results, and aggregates UTF-8 bytes, lines,
  and per-line character length. Crossing any ceiling terminates the process
  group with `SIGTERM` followed by bounded `SIGKILL` escalation and returns
  `provider_tool_output_budget_exceeded`. It does not truncate or rewrite the
  provider protocol, and it does not count model text or tool-call inputs as
  tool output.
- Policy-owned runs set `isolateParentEnvironment=true`. The child receives only
  the selected adapter environment plus the minimal platform path; unrelated
  parent-provider credentials cannot affect auth, billing classification, or
  execution. Paperclip creates a mode-`0700`, per-company runtime home. Codex
  uses its existing company-managed `CODEX_HOME`; Gemini receives only verified
  symlinks to its credential files inside that managed home. Claude uses the
  same symlink boundary when `.credentials.json` exists. On macOS, current
  Claude Code stores subscription OAuth in the `Claude Code-credentials`
  Keychain item instead; Paperclip reads that exact item at run preparation and
  atomically materializes only its bounded JSON into the disposable mode-`0600`
  run profile. It never copies the user's broader configuration, and the
  materialized credential is removed with the run profile. Hermes receives an
  empty managed `HERMES_HOME`, disables project dotenv/fallback loading, and is
  launched with `--ignore-user-config --ignore-rules`. Gemini reads a parent
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` only when parent inheritance is enabled; an
  isolated run uses its explicit or operating-system system path.

### Crash-safe managed profile lifecycle

Managed provider homes are disposable run state, but their credential boundary
is strict. Before Codex, Claude, or Gemini receives an approved credential-file
symlink, Paperclip opens the JSON source with no-follow semantics, requires an
owner-only regular file, and bounds it to 1 MiB, 16 JSON levels, and 4,096 leaf
values. The macOS Claude Keychain fallback applies the same JSON byte, depth,
leaf, and redaction bounds before its create-exclusive temporary file is
fsynced and atomically renamed into the private run profile. Every nontrivial
string leaf is retained only in the run's in-memory
`exactRedactionValues` set. Credential values and that set are never logged,
hashed, copied into a receipt, or persisted as profile metadata. A preparation
failure transactionally quarantines and removes the partial run home; if safe
rollback cannot be proven, execution fails closed.

Gemini CLI OAuth eligibility is distinct from credential validity. If Google's
runtime returns `IneligibleTierError`, `no longer supported`, or an equivalent
retired-client response, the canary records `provider_capability_mismatch` and
quarantines that route. It must not tell an operator to repeat OAuth login, and
ordered capability aliases must continue through the next healthy provider.

Server startup performs profile recovery synchronously in this order: reap
orphaned heartbeat runs, no-follow scan the managed profile tree, then resume
queued work only after the scan is clean. Profiles for `queued` or `running`
runs are preserved. A terminal run is also preserved while its recorded PID or
process group is still live. Only profiles with no heartbeat run, or terminal
runs with no live process owner, are quarantined and removed. A quarantine left
by a crash is retried after five minutes. Repeating startup recovery is safe and
removes nothing after the tree is clean.

Every scan writes a mode-`0444`, create-exclusive receipt under
`data/ops/provider-runtime-profile-cleanup/runs/`. The receipt contains only
timestamps, status, aggregate counts, failure-code counts, a safe instance ID,
and a hash of the instance root. It contains no company or run identifiers,
filesystem paths, credential values, credential hashes, or redaction values.
A symlink, non-directory ancestor, unstable entry, authority lookup failure, or
cleanup failure is preserved rather than followed and produces the count-only
`provider_runtime_profile_cleanup_failed` blocker. The next owner is
`paperclip_runtime_owner`; queued provider work may resume only after the
managed root is repaired and a fresh immutable aggregate receipt verifies. A
runtime cleanup failure or an inability to persist route quarantine also pauses
the affected agent durably; periodic queue drivers cannot admit its next run,
and the operator must verify the cleanup/backoff receipt before resuming it.

### Pinned runtime dependency closures

`runtimeClosures` in `provider-policy.v2.json` is the executable supply-chain
authority. Every route names one closure, and the canonical closure digest is
part of the route core. `verifyProviderPolicyRuntimeClosure()` re-hashes it at
the final pre-spawn boundary; any missing file, symlink substitution, mode or
byte drift, interpreter mismatch, version mismatch, PATH shadowing, or manifest
count/size mismatch fails closed before provider traffic.

- Codex executes the pinned native arm64 binary directly, not the mutable npm
  JavaScript launcher. Claude likewise pins its native executable.
- Gemini pins the launcher bytes and exact shebang, the resolved Node binary,
  `node` PATH resolution, Node version, the complete Gemini npm package tree,
  and Node's recursively loaded Homebrew dynamic-library files.
- Hermes pins the launcher and exact shebang, resolved Python interpreter and
  version, `uv.lock`, the complete virtualenv `site-packages` tree (including
  executable `.pth` files and distribution `RECORD` metadata), plus the clean
  repository revision/tree and critical source-module digest.

Runtime upgrades are an explicit policy operation. Recompute every affected
file/directory manifest, review the dependency delta, update the closure ID,
regenerate route-core goldens, update the pinned policy hash, and run the host
closure test. Never update only the command hash to make a drift failure green.

### Scheduling boundary

There is no generic 300-second provider-backed heartbeat in v2. The fleet
migration sets agent heartbeat `enabled=false`, `intervalSec=0`,
`maxConcurrentRuns=1`, and `triggerMode=event_only`. Only twice-daily Market
Sweep and VOC Sweep remain cron-initiated. Downstream stages start from persisted
completion events, assignments, comments, approvals, or explicit on-demand
wakes.

Provider canaries are bounded health evidence, not agent polling. Policy route
freshness is at least 1,800 seconds, and a healthy row requires an immutable
canary receipt with exact model/version, route hashes, complete final response,
and usage. After HTTP listen readiness, Paperclip's canary scheduler checks
once per minute for receipts nearing their route-specific expiry; it deduplicates
by company/policy/route, runs at most two companies concurrently, and refreshes
only due routes. Passing results signal the durable flywheel reconciler so an
exact provider-availability blocker can self-heal. Missing credentials remain
fail-closed and create the human credential blocker; the scheduler never copies
or logs credential values. The historical tokenomics watch may
sample Paperclip's database every 300 seconds because it is deterministic and
does not invoke a provider; it is an observer, not an execution trigger.

### Provider blocker contract

Any route or stage blocker must preserve four fields:

- `blocker_code`
- `blocker_detail`
- `next_owner`
- `resume_condition`

OpenCode Zen free may satisfy `independent_review` only as an explicit,
fresh-canary, different-family QA route. Its signed catalog must prove
reasoning, tool calls, and structured output. It remains `releaseAllowed=false`;
the release stage can never select it, even when every premium route is down.

Use `paperclip_provider_operator` for missing capable routes or canary-owned
provider recovery. Use the credential owner for missing, revoked, or compromised
company-secret references. Provider failover starts from the same immutable
stage input and artifact checkpoint with a fresh transcript. Release waits when
no release-capable route remains; it never falls through to `emergency_free`.

### Honest token and value SLOs

Do not turn silence into a pass. Token reduction is meaningful only over a
seven-day or explicitly bounded work-bearing comparison window. The release
claims are:

- raw provider tokens per comparable work opportunity reduced by at least 50%
- valuable or safely skipped decisions at least 90%
- artifact-backed completion for actionable runs at least 90%

Report the numerator, denominator, sample size, time window, and baseline. A
quiet window, empty provider canary, startup health check, zero-token safe skip,
or guard receipt can prove low spend or safety, but not valuable output. When a
denominator is zero or provider receipts lack normalized token/cost evidence,
report `insufficient_data` or `warn`, never `pass`. The company flywheel ops
receipt follows the same rule by returning `status=measured` with `sample_size`
or `status=insufficient_data` with a reason.

### Operator commands

The Hermes Python dependency closure is fail-closed and read-only. Its pinned
directory has `rejectWritable: true`; every directory and file must have all
write bits removed before its manifest is recorded. This prevents normal Python
imports from creating new bytecode after runtime identity was verified:

```sh
HERMES_SITE_PACKAGES=/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/runtimes/hermes-agent-v0.18.2-d171681c1c70-fleet-repair/venv/lib/python3.12/site-packages
find "$HERMES_SITE_PACKAGES" -type f -exec chmod a-w {} +
find "$HERMES_SITE_PACKAGES" -type d -exec chmod a-w {} +
```

For an intentional dependency upgrade, temporarily restore owner write access,
perform the locked install, run Hermes validation, freeze the directory again,
and publish a new provider-policy revision with the new directory manifest. Do
not reuse the prior revision after any writable maintenance window.

Paperclip-managed Hermes launches set `HERMES_API_MAX_RETRIES=1`. Provider
quota and billing walls therefore return after one provider attempt to the
Paperclip failover plane, which quarantines the failed route and starts a fresh
transcript on another capable provider. Hermes internal retries remain
configurable for unmanaged use; they are deliberately disabled at this
orchestration boundary so a provider's long `Retry-After` cannot capture the
stage lease or suppress cross-provider recovery.

Validate the policy pins and route-core hashes without spending provider tokens:

```sh
cd /Users/mnm/Documents/Github/paperclip
shasum -a 256 config/provider-policy.v2.json config/provider-policy.v2.schema.json
pnpm --filter @paperclipai/server exec tsx src/ops/provider-policy-route-cores.ts
env -u OPENROUTER_API_KEY -u MINIMAX_API_KEY -u OPENCODE_GO_API_KEY \
  -u OPENCODE_ZEN_API_KEY -u NOUS_API_KEY \
  pnpm ops:provider-runtime-identity -- --routes opencode_go_flash
pnpm --filter @paperclipai/server exec tsx src/ops/provider-policy-canary.ts \
  --home /Users/mnm/.paperclip-local/portfolio-os-cockpit \
  --instance-id default \
  --company-id "$PAPERCLIP_COMPANY_ID"
```

Execute only the bounded routes needed for a fresh health decision:

```sh
pnpm --filter @paperclipai/server exec tsx src/ops/provider-policy-canary.ts \
  --home /Users/mnm/.paperclip-local/portfolio-os-cockpit \
  --instance-id default \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --routes opencode_go_flash,minimax_m3,gemini_flash,codex_fast,claude_sonnet \
  --execute
```

For `models.dev` routes, the canary runner owns freshness of the raw Hermes
catalog input. Before signing catalog evidence it checks the cache against the
route's `discovery.refreshSeconds` with enough lead time to finish the bounded
canary. A stale or missing cache is refreshed once through the Python runtime
adjacent to the already-verified Hermes command, with the pinned clean Hermes
repository as `cwd`, an explicit `HERMES_HOME`, user-site imports disabled, and
no provider credentials in the child environment. Concurrent company and route
canaries coalesce on the same cache path. A network error, timeout, non-file or
symlink cache, or a successful process that does not produce a fresh file fails
closed with a bounded provider failure class; Paperclip never reuses stale
catalog bytes and never records the refresh subprocess output in the blocker.

The selected instance supplies the embedded database port and configured
`local_encrypted` master-key file in-process. The CLI rejects database URLs and
credentials on argv, rejects inline master-key material, and secret resolution
never creates a missing replacement key. External PostgreSQL may still provide
`DATABASE_URL` through the operator environment; omit `--home`/`--instance-id`
only in that mode and also supply an absolute
`PAPERCLIP_SECRETS_MASTER_KEY_FILE` plus an absolute `--receipt-root`. Instance
mode rejects ambient database, config, key-file, and receipt-root overrides so
one invocation cannot silently span two Paperclip instances.

Run focused validation after policy or canary changes:

```sh
pnpm exec vitest run \
  server/src/__tests__/provider-policy.test.ts \
  server/src/__tests__/provider-route-hash.test.ts \
  server/src/__tests__/provider-runtime-closure.test.ts \
  server/src/__tests__/provider-runtime-profile.test.ts \
  server/src/__tests__/provider-canaries.test.ts \
  server/src/__tests__/profit-flywheel-review.test.ts
pnpm --filter @paperclipai/server typecheck
```

LiteLLM is not a second router in v2. It may be evaluated later as transport
behind a policy-owned `direct_api` route, but it may not add its own provider
order, retry semantics, budget authority, or hidden failover. Langfuse is also
observer-only: a future self-hosted instance may consume trace/receipt metadata,
but Paperclip state and immutable receipts remain authoritative if it is absent.

## Historical June 2026 tokenomics record

The remainder records the June 16, 2026 Hermes/Paperclip tokenomics fix and its
live receipts. Preserve it as before/after evidence; use the v2 section above for
current routing and scheduling decisions.

## Root Cause

Gemini fallback was not absent. It was invisible in cost accounting because the current Gemini CLI reports usage in `result.stats`, while Paperclip only read `usage` and `usageMetadata`. Those runs therefore stored zero usage even when Gemini ran successfully.

MiniMax burn came from three combined issues:

- Hermes agents were allowed to carry sessions with no Paperclip rotation thresholds.
- Several high-output agents were running every 300-600 seconds with `maxConcurrentRuns` unset.
- MiniMax token-plan exhaustion was treated like a 30-minute stall unless the provider emitted an explicit reset string, even though the plan window is five hours.

The live four-day cost-event view showed MiniMax at about 277.7M booked tokens. The larger multi-billion runtime totals were cumulative agent runtime counters, not a four-day provider bill.

## Code Controls

- Gemini parser reads `result.stats` and current `init`/`message` stream events.
- Hermes session compaction is role-aware. The first blunt fleet cap of 25 runs,
  500k raw input tokens, and 12 hours was too aggressive for the recursive
  factory loop, because it could save tokens by dropping useful cross-run
  continuity. The later live trace showed the opposite leak in subscription
  fallback: Gemini and Claude could inherit huge cached sessions. The current
  balance keeps enough task context but rotates sessions before replay grows.
- Token-plan quota errors infer a five-hour recovery window plus grace when no reset string is present.
- MiniMax Token Plan capacity is polled through
  `https://www.minimax.io/v1/token_plan/remains` before a MiniMax-backed Hermes
  run is spawned. The poll reads the same subscription key Hermes uses
  (`MINIMAX_API_KEY`, `MINIMAX_SUBSCRIPTION_KEY`, or `MINIMAX_TOKEN_PLAN_KEY`)
  from adapter env, process env, or `HERMES_HOME/.env`.
- When the MiniMax usage poll reports zero remaining 5-hour or weekly quota,
  Paperclip records a degraded preflight with the reset/release ETA instead of
  spending a full agent run. When the poll later reports quota available,
  Paperclip clears only the `hermes_minimax` stalled lane and routes work back
  to MiniMax without waiting for the conservative five-hour backoff to expire.
- Provider preflight evidence is capped at 4,000 chars to avoid repeated oversized failure-recovery context.
- Timer wakes with no explicit issue, comment, or approval context are skipped
  before adapter invocation when the agent has no open assigned work. This is
  the largest no-loss savings lever because the Paperclip skill already says
  no assignment plus no valid mention handoff means exit.
- Blank manual/on-demand wakes follow the same work gate. If the wake has no
  issue, task key, comment, approval, payload, prompt, or explicit reason, it
  is not work. Paperclip either pins it to the next open issue already assigned
  to the agent or records a `heartbeat.idle_no_assignment` skipped wake before
  any provider-backed adapter can start.
- Timer and blank manual wakes that do have open assigned work are pinned to
  the next assigned issue before adapter launch. The run context, task id,
  wakeup payload, and context ledger therefore carry the issue id instead of
  producing generic status summaries that cannot count as final deliverables.
- Timer-pinned issue continuations now run a no-new-signal preflight before
  adapter launch. If the latest issue comment is a recent same-agent receipt,
  has no later external signal, and explicitly records no state change, no work
  product, and a skip-until-new-state instruction, Paperclip records
  `heartbeat.no_new_issue_signal` instead of launching Hermes. Future adapter
  results can make this deterministic with `paperclipNoNewSignal.action:
  "skip_timer_until_external_signal"`; the compatibility detector exists only
  for already-posted receipts that predate the structured marker.
- The no-new-signal compatibility detector also recognizes expensive
  "context loading only" receipts. If a same-agent timer receipt says no
  Paperclip API mutations, no status change, no subtask/comment work product,
  and "resume in the next timer", the next automatic timer wake is skipped
  until a newer external signal exists.
- Timer-pinned `blocked` issues now have a deterministic blocker fingerprint
  preflight. If the issue is still `blocked`, the latest comment is the assigned
  agent's blocker receipt, and no newer user/agent comment or issue update exists,
  Paperclip records `heartbeat.blocked_issue_no_new_signal` with
  `paperclipBlockedIssueNoNewSignalTimerSkip.blockerFingerprint` instead of
  launching Hermes. A newer external comment, status/update timestamp, or a
  provider-capacity recovery path reopens execution.
- Timer-pinned triage/intake issues now run a no-inbound-signal preflight before
  adapter launch. If the issue is an assigned triage/intake/chamber queue item,
  has no user comment, no external agent comment, and no wake payload/comment
  handoff, Paperclip closes it with a deterministic comment and records
  `heartbeat.no_inbound_triage_signal`. This is the control-plane answer to the
  Ponytail question: a model does not need prior session context, repo context,
  or provider tokens to decide that an empty timer wake has no inbound triage
  input.
- Timer-pinned assigned work that ends with a same-agent "budget exhausted" or
  "stop calling tools" receipt and no deliverable now requires an explicit
  handoff before the next automatic timer wake can launch an adapter. Paperclip
  records `heartbeat.timer_budget_exhausted_requires_handoff` and leaves the
  issue `in_progress` so a board/user comment, approval event, manual issue
  wake, different execution lane, or newer issue update can resume real work
  without recursively spending another large provider call on the same partial
  state.
- Running local-agent work is reconciled when the referenced issue becomes
  terminal. A one-minute grace period lets the adapter exit normally after
  marking an issue done/cancelled; if it stays active after that, the reaper
  finalizes it as `succeeded` for `done` issues or `cancelled` for
  cancelled/hidden/non-executable issues and terminates the child process.
- Hermes-local runs are assigned a run-owned `hermes chat --session-id
  paperclip_<runId>` for fresh sessions. The adapters parse `session_id` from
  stdout or stderr before falling back to global state-db discovery. This avoids
  attributing concurrent Paperclip runs to the newest unrelated Hermes session
  and prevents inflated per-run token accounting.
- Local agent session resume is now signal-keyed, not just issue-keyed.
  Hermes-local, Claude-local, Gemini-local, Codex-local, OpenCode-local,
  Cursor-local, and Pi-local persist `workKey`, `issueId`, `taskKey`,
  `approvalId`, `commentId`, and context fingerprint when available. A later run
  may resume only when the stored work key still matches the current issue/task,
  the cwd still matches, the same comment signal is being continued, and any
  current prompt fingerprint matches the saved session fingerprint. A current
  fingerprint with no saved fingerprint is treated as an unsafe pre-fix session
  and starts fresh. Hermes process-loss recovery starts a fresh run-owned session
  even on the same issue, because the lost process is failure evidence, not proof
  that a large prior Hermes transcript is valuable. Legacy sessions without a
  work key are treated as context rot by default: explicit issue work starts a
  fresh run-owned session while preserving the full build/research budget;
  no-handoff status checks suppress resume and use bounded status mode.
- Model-backed local adapters preload Paperclip-managed runtime skills
  adaptively by default instead of passing every assigned or available skill on
  every run. Hermes-local, Claude-local, Gemini-local, Codex-local,
  OpenCode-local, Cursor-local, and Pi-local share the same selector from
  `@paperclipai/adapter-utils`. Approved company skills are candidates; only the
  scored run-specific subset is mounted or passed to the adapter. This means a
  CMO can keep launch/copy/content skills available without loading
  `long-form-sales-letter` into a generic marketing-strategy run, while a
  Growth/Distribution agent with sparse persistent `desiredSkills` can still
  select distribution, launch, and analytics skills when the task calls for
  them.
- Runtime skill caps are role-aware rather than one fixed fleet value. CMO, PM,
  QA, and Designer default to five selected skills; Growth/Distribution,
  Engineer, CTO, CEO, and DevOps default to six; Researcher defaults to seven
  because evidence, VOC, source extraction, and opportunity analysis often need
  to be present together. Set `paperclipSkillBudgetMode=all` only for
  explicitly broad specialist runs where all skills are truly part of the task.
- `promptMetrics.skillBudget` now records `selectionPolicyVersion`,
  `candidatePool`, `selectedCount`, `availableCount`, selected/skipped skills,
  and a bounded score trace. Missing skill-budget metrics on any local adapter
  are a context-bloat regression.
- Gemini-local stores skills in a persistent `~/.gemini/skills` directory, so it
  also prunes stale Paperclip-managed symlinks when the adaptive selector no
  longer chooses those skills. User-installed Gemini skills are intentionally
  left alone.
- Hermes-local adapters pass per-run tool-output ceilings into the Hermes
  process: `HERMES_TOOL_OUTPUT_MAX_BYTES=16000`,
  `HERMES_TOOL_OUTPUT_MAX_LINES=320`, and
  `HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH=1000`. Hermes reads these environment
  values before user config defaults, so Paperclip can bound `read_file`,
  terminal, and similar replay-heavy tool results without editing
  `~/.hermes/config.yaml`.
- The implementation budget class uses a 512 KiB cumulative structured-tool-output
  ceiling. The initial 16 KiB ceiling terminated the work-bearing Codex canary
  after 19,963 bytes across several individually bounded reads, before the first
  target mutation. Status, maintenance, research, and review remain at 16 KiB;
  the larger implementation ceiling is still bounded by 4,096 lines and 16,384
  characters per line. A sparse-workspace Codex run emitted 96,678 legitimate
  bytes during repository discovery before implementation. A later broad
  workspace convention search emitted 302,640 legitimate bytes before mutation,
  so 512 KiB preserves bounded headroom for code, tests, Git proof, and the final receipt.
  Work-bearing canaries proved that CLI JSONL tool results
  legitimately produce single records of 1,106, 6,651, and 10,345 characters
  while reading bounded inputs, including the system's own signed dispatch;
  16 KiB is therefore the bounded structured-record ceiling. A later canary observed 442 legitimate
  structured output lines. Later completions emitted 867, 1,094, and 1,778
  legitimate records; the last run completed code and tests before its bounded
  schema inspection crossed the former 1,536-line limit. The 4,096-line
  implementation/release ceiling preserves a bounded receipt-writing tail while
  the independent 512 KiB byte ceiling remains authoritative. Other budget
  classes retain their separately bounded ceilings.
- The OpenCode Go Deep health probe permits at most 256 output tokens. A live
  Deep canary used 167 tokens including provider-reported reasoning while still
  returning the exact nonce; the prior 128-token validator ceiling therefore
  produced a false quarantine. The probe remains minimal, independently
  nonce-bound, and capped far below normal task budgets.
- Work-bearing Hermes runs reconcile the state database's observed provider
  and model id with the same fresh, content-addressed catalog identity used by
  provider canaries. The state database does not store a dated model version;
  treating its model id as that version falsely quarantines otherwise valid
  OpenCode work after completion. No catalog overlay is accepted unless every
  signed evidence file, hash, freshness window, route core, and direct-health
  receipt verifies.
- Provider-result receipts use one five-minute TTL contract. Paperclip passes
  that TTL explicitly to policy-owned adapters and independently checks the
  adapter's observed/expiry ordering and bounded lifetime. Completion-canary
  receipts retain their separate 15-minute health window; reusing that longer
  TTL for a work-result receipt is rejected as a security-contract mismatch.
- Implementation and release allow 48 model turns. Two independent live
  work-bearing attempts exhausted the former 18-turn ceiling after producing
  substantive source/tests/docs but before the mandatory test, Git-object
  hash, and immutable work-result receipt sequence was complete. The increase
  is confined to work-bearing stages and remains bounded by 160k total tokens,
  512 KiB structured tool output, 4,096 lines, and one escalation. A revision 24
  work-bearing run completed code plus 18 tests and computed the exact canonical
  Git object hash, but approval-denied fallback attempts consumed the 32-turn
  tail before the immutable receipt write; 48 preserves a bounded receipt tail.
- Provider token budgets apply to uncached input plus output. Provider-reported
  cache-read input remains preserved in the signed raw usage receipt and cost
  ledger, but it is not charged again against the work budget on every cached
  Codex turn. Receipts that claim more cached input than total input fail closed.
- External and built-in Hermes adapters must both record
  `promptMetrics.skillBudget`, `promptMetrics.hermesToolOutputBudget`, and
  `sessionParams.sessionId`. A missing budget metric or a repeated unrelated
  session id means the run is not valid evidence for the tokenomics objective.
- Claude-local, Gemini-local, Codex-local, OpenCode-local, Cursor-local, and
  Pi-local must record `promptMetrics.skillBudget` as well. A fallback lane
  without that metric is a context-bloat regression until proven otherwise.
- Claude-local may normalize a null OS exit code to zero only when the captured
  protocol contains a non-empty `type=result`, `subtype=success` terminal with
  no error, failure stop reason, signal, or timeout. This preserves completed
  Claude work on runtimes that lose the numeric close code while keeping
  tool-call-only, max-turn, interrupted, and incomplete output fail-closed.
- Provider-policy Codex runs receive a server-authored, stage-bound execution
  authority. Only an exact `implementation` or `release` workflow/stage binding
  enables `--dangerously-bypass-approvals-and-sandbox`; review and unbound runs
  stay read-only. Agent JSON cannot inject this authority because provider-policy
  execution starts from the sealed adapter configuration.
- External and built-in Hermes adapters treat `session_id: ...` as protocol
  metadata, not a final deliverable. If quiet Hermes output contains only the
  session id, the adapter must recover the latest active assistant response from
  Hermes `state.db` and record `resultJson.finalResponseSource=hermes_state_db`.
  If no real final assistant response exists, the run must fail with
  `missing_final_response` instead of posting a false success comment.
- Skill Inventory maintenance is now a process-plane routine. The live
  `PORA-1801` Hermes run found that 43 Portfolio OS skills were missing
  `keywords:` frontmatter, reran `scripts/skill_curator.py`, and then stopped
  before applying the mechanical fix after spending 524,037 raw MiniMax tokens.
  `scripts/process-runbooks/skill-inventory-runner.mjs` now repairs missing
  keyword lines, reruns the curator, patches the issue to `done` or `blocked`,
  and emits `providerTokensSpent: 0`. Live process run
  `48299aab-5161-4051-b18c-dda3f50ed83e` closed `PORA-1801`, repaired all 43
  missing keyword lines, reran the Portfolio OS curator to `pass=53/fail=0`,
  and recorded `usageJson=null` with `providerTokensSpent=0`.

## Factory Loop Boundary

Do not optimize away the actual software-factory cycle:

1. Portfolio OS produces research, selection, dispatch, and freshness artifacts.
2. Paperclip cockpit ingests those artifacts and owns companies, issues,
   routines, approvals, context ledgers, and flywheel receipts.
3. Hermes and the local adapters execute assigned build/research tasks.
4. `scrapegraphai`, Graphify, `gstack`, gbrain, context packs, and Repomix are
   evidence tools that reduce raw replay and improve artifact quality.

Token savings should come from skipping empty control-plane wakes, using map
context packs before raw code, and eliminating run chatter. They should not come
from starving Portfolio OS research, Graphify/ScrapeGraphAI extraction receipts,
`gstack` QA evidence, gbrain lookup, or real Hermes implementation work.

## Ponytail Skill

`paperclipai/paperclip/ponytail` is a bounded, markdown-only Paperclip skill
vendored from DietrichGebert/ponytail at commit
`99139a25d07e3523d3f6871419798dda600db49a`.

Safety review outcome:

- Runtime hooks were not installed into Codex, Claude, OpenCode, or Gemini.
- The vendored skill contains no executable hook, network call, install script,
  or credential access path.
- The skill is attached through Paperclip `paperclipSkillSync`, so the cockpit
  remains the authority over which agents receive it.

The skill tells agents to prefer existing artifacts, standard libraries, local
tools, and focused tests over speculative scaffolding. It explicitly does not
override Paperclip issue contracts, tests, docs, receipts, security controls, or
the Portfolio OS to Paperclip to Hermes loop.

## Live Fleet Controls

Receipt:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260616T221521Z-hermes-tokenomics-guardrails.json`

Applied to the Hermes local-agent fleet:

- `tieredExecution.adapterOrder`: `["hermes_minimax", "gemini_local", "claude_local"]`
- `maxConcurrentRuns`: `1`
- recurring heartbeat minimum: `1800` seconds for enabled Hermes timers
- `heartbeat.idleAssignmentPreflight`: `true`
- Hermes MiniMax, Gemini, and Claude prompt caps are role-aware:
  - factory build: `contextMaxChars=24000`, `outputMaxChars=3200`, `outputMaxSentences=12`
  - research synthesis: `contextMaxChars=28000`, `outputMaxChars=4000`, `outputMaxSentences=14`
  - maintenance/light support: `contextMaxChars=12000`, `outputMaxChars=1400`, `outputMaxSentences=7`
- Hermes MiniMax turn caps are role-aware through `maxTurnsPerRun` and the
  adapter passes this as `hermes chat --max-turns`:
  - factory build: `12`
  - research synthesis: `14`
  - maintenance/light support: `8`
- Hermes skill preloading is adaptive by default:
  - `paperclipSkillBudgetMode=adaptive`
  - `paperclipSkillCandidatePool=approved_company`
  - role, issue, wake payload, and prompt keywords decide the selected skills
  - skipped skills are recorded in `promptMetrics.skillBudget.skipped`
  This is the operational version of the Ponytail question: "Does this run need
  this context to finish the current issue?" Skills that are useful in the
  company are not automatically useful in every Hermes model call.
- Hermes tool-output replay is bounded per run:
  - `hermesToolOutputMaxBytes=16000`
  - `hermesToolOutputMaxLines=320`
  - `hermesToolOutputMaxLineLength=1000`
  This targets the observed post-session-fix burn class where a compact
  Paperclip prompt still turned into hundreds of thousands of provider input
  tokens because Hermes replayed large `read_file` and terminal tool results
  through multiple model turns.
- Hermes request shaping is enabled fleet-wide. If a run has no explicit issue,
  comment, approval, or human prompt handoff, the adapter clamps it to bounded
  status mode:
  - `contextMaxChars=8000`
  - `outputMaxChars=1200`
  - `outputMaxSentences=6`
  - `maxTurnsPerRun=4`
  - required Ponytail-style question: “Does this session's prior runs provide
    any value to this current run?”
  In bounded status mode the agent may inspect Paperclip source-of-truth state,
  create/update a precise issue, or return a safe-skip/status receipt. It must
  not replay prior sessions, dump repository context, or mutate code unless the
  current run exposes an explicit issue handoff.
- Bounded status mode suppresses stale session resume across all local
  subscription/execution planes that can otherwise carry large prior context:
  Hermes-local, Claude-local, Gemini-local, Codex-local, OpenCode-local,
  Cursor-local, and Pi-local. Explicit issue/comment/approval handoffs can still
  resume only a matching signal-keyed session; no-handoff timer/manual runs,
  process-loss retries, fresh comment signals, prompt fingerprint changes, and
  pre-fix sessions missing a saved fingerprint cannot pass `--resume` and do not
  replay `paperclipSessionHandoffMarkdown`.
- Fresh Hermes-local runs must pass a deterministic `--session-id` and report
  the same id in `sessionParams.sessionId` unless Hermes rotates during
  compression. A repeated `sessionParams.sessionId` across unrelated concurrent
  runs is a regression unless the runs explicitly resumed the same issue session.
- `heartbeat.sessionCompaction` is role-aware:
  - factory build: 12 runs, 250k raw input tokens, 8 hours
  - research synthesis: 10 runs, 350k raw input tokens, 8 hours
  - maintenance/light support: 8 runs, 120k raw input tokens, 6 hours
- `paperclipai/paperclip/ponytail` attached through `paperclipSkillSync`
- LeadForge recurring timers disabled while preserving `wakeOnDemand=true`

## External Tokenomics Watch

The production watch is intentionally outside the heartbeat path:

```sh
pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-watch.ts --once --window-minutes 30 --baseline-hours 96
pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-watch.ts --watch --interval-seconds 300 --apply-balance-on-drift
pnpm --filter @paperclipai/server exec tsx src/ops/hermes-tokenomics-analysis.ts --days 5
```

Receipts are written under:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/`

The watch fails the window when:

- token use per wake/run opportunity is not at least 50 percent below baseline
- fewer than 90 percent of wake decisions are issue-bound work or safe skips
- a work-bearing window spends tokens or finishes runs without enough final
  deliverables to beat the baseline issue-delivery rate by 90 percent
- any high-burn provider event crosses the configured threshold
- timer wakes launch adapters without issue context
- Hermes agent configs drift away from the balance policy

Canonical `inputTokens` already includes the cached-input subset. Raw-token
metrics therefore use `inputTokens + outputTokens`; `cachedInputTokens` is
reported separately and is subtracted only for provider-budget enforcement.
Adding cached input to input again double-counts cache hits and creates false
high-burn events.

Claude Code reports three mutually exclusive input buckets:
`input_tokens`, `cache_creation_input_tokens`, and
`cache_read_input_tokens`. The `claude_local` adapter normalizes their sum to
canonical `inputTokens` and preserves `cache_read_input_tokens` as
`cachedInputTokens`. Do not pass Claude's raw `input_tokens` through as the
canonical total: on a healthy long-lived session the cache-read bucket can be
much larger than the uncached delta, which would otherwise be rejected as
impossible usage after the work has already completed.

The watch receipt now includes `activeRunFlywheelCoverage` as a top-level
section, separate from the spend window. It inspects currently queued/running
runs, links them to issues and routine-run origins, infers the flywheel stage
from `routine_key`, actionability preflight, or provider-lane metadata, and
compares the run against `config/flywheel_coverage.json`. The v2 coverage file
is a fail-closed bridge: its stage set, owner planes, receipt names, capability
aliases, and maximum provider-token budgets must exactly match the pinned
`profit-flywheel.v2` and `provider-policy.v2` authorities. The four older
routine keys remain available only as named `legacy_deterministic_runbook`
bridges with zero provider budget; they do not redefine canonical stage
ownership or satisfy canonical completion receipts. Active runs with no
stage/routine contract increment `missingContractRuns` and produce a
recommendation before another provider-heavy window is allowed to drift.

Heartbeat persistence now writes a stable `providerLane` envelope into both
`usageJson.providerLane` and `resultJson.providerLane` when a run completes.
The envelope records selected lane, original/selected adapter type, provider,
biller, model, billing type, cache mode/source, cached input tokens when
reported, quota source/status, context-pack profile/repo/manifest hash,
escalation reason/source, and failure kind. Existing adapters are inferred by
the heartbeat normalizer; deterministic process runbooks may explicitly promote
the same metadata through `PAPERCLIP_ADAPTER_RESULT_JSON`.

Idle windows are intentionally reported as cheap but not sufficient proof of the
90 percent valuable-output target. In those windows
`evaluation.valuableOutputStatus` is `warn`, and the recommendation says to keep
the watch running through a work-bearing window before claiming the output lift.

The June 17, 2026 timer issue-pinning cutover produced a work-bearing pass
receipt after restart:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T052744759Z-39827-hermes-tokenomics-watch.json`

That receipt had `status=pass`, `tokenReductionRatio=1`,
`currentRawTokens=0`, `highBurnEvents=0`, `finalDeliverableUnits=2`, and
`valuableOutputStatus=pass`. The live run table also showed post-restart timer
wakes pinned to issues such as `PORA-1831`, `PORAA-3181`, `PORAA-3187`,
`PORAA-3198`, and `PORAA-502` rather than launching no-issue timer work.

The later run-owned-session canary proved the attribution fix but exposed the
next real burn source. Run `ff711d16-dd73-481e-ba5b-fa3a15448a09` launched
Hermes with `--session-id
paperclip_ff711d16-dd73-481e-ba5b-fa3a15448a09` and completed with matching
requested, persisted, and result session ids. Its Paperclip prompt was compact
at about 5,335 estimated tokens, but Hermes still booked roughly 294k input
tokens plus 4.34M cached input tokens because the fresh session accumulated
large `read_file`, terminal, and patch tool messages. That is why the adaptive
skill budget and per-run Hermes tool-output ceilings are part of the production
fix rather than cosmetic tuning.

The Evidence Backfill Reconciler canary then proved the deterministic
process-plane cutover for routine work that already has a scriptable acceptance
path. The previous Hermes execution for `PORAA-3187` completed useful work but
still consumed about 60k input tokens plus 419k cached input tokens. The
cutover changed the routine and open issue to use an issue-level
`assigneeAdapterOverrides.adapterType=process` override that runs
`scripts/process-runbooks/evidence-backfill-runner.mjs` directly.

The Release Gate Reconciler is also a process-plane routine. The Hermes run
`bd240e51-b927-4eac-827e-1b467380ac68` claimed success for `PORAA-2821` but
only produced an interim plan after spending 127,010 fresh input tokens,
608,206 cached input tokens, and 7,192 output tokens. The cutover routes
`routine_key: "release-gate-reconciler"` to
`scripts/process-runbooks/release-gate-runner.mjs`, which verifies approval,
runs the target repo's `npm run release:gate`, writes a release-gate report and
payload, patches the issue `done` or `blocked`, and emits
`providerTokensSpent: 0`.

Live evidence:

- Paperclip run `8a446626-05e0-49dd-adaf-51dc1dc7253b` closed `PORAA-2821`
  through the process adapter with `usageJson=null` and `providerTokensSpent=0`.
- YT-Synth release gate passed on `main` after commit
  `23e70213fb3a76dbbd0e2f96c9d6c71d53e19967`, which excluded operational
  `memory/` receipts from `tsc --noEmit` and allowed recurring factory docs and
  release-gate artifacts as non-blocking dirty paths.
- The release-gate artifact is
  `/Users/mnm/Documents/Github/YT-Synth/docs/release-gate-reconciler/20260504T004042Z/iteration-2.md`.

The Run QA Sweep routine now has the same deterministic first-pass treatment.
The previous coverage plan had a seeded `run-qa-sweep` routine, but no default
process adapter mapping. The cutover routes `routine_key: "run-qa-sweep"` to
`scripts/process-runbooks/run-qa-sweep-runner.mjs`. That runbook resolves the
Portfolio OS artifact with gstack, writes the QA verification artifact, selects
a local HTML surface or explicit target URL, runs a bounded desktop/mobile
browser sweep, writes `qa_report.md`, screenshots, and `regression_notes.md`,
then patches the issue `done` or `blocked` with `providerTokensSpent=0`.

Coverage model:

- no target surface means `blocked`, not a successful run
- Internet Pipes incompleteness blocks release readiness even when browser checks
  pass
- product-specific exploratory QA can still escalate to GStack/Hermes, but the
  deterministic path handles the repeatable station setup and standard surface
  checks first

The Council triage timer exposed the next control-plane skip class. Run
`b5368eb6-17c0-48f0-bd6b-7dbade86d7ca` on `PORA-1548` correctly used the
run-owned Hermes session and compact prompt, but still spent 54,624 fresh input
tokens, 490,608 cached input tokens, and 5,677 output tokens to conclude
`NO_NEW_TRIAGE_INPUT`. The final issue disposition was useful, but the model
call was unnecessary: there was no inbound user/comment payload to triage. The
new `heartbeat.no_inbound_triage_signal` gate closes that class before adapter
spawn while preserving full execution for any triage issue that has a user
comment or external signal.

The next red-team pass showed that issue-bound timers can still be expensive
when the model reaches heartbeat budget without the cake on the table. The
strict watch at
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T113118984Z-78754-hermes-tokenomics-watch.json`
had good output accounting (`valuableOutputStatus=pass`,
`finalDeliverableUnits=7`) but failed token reduction because four MiniMax
issue-bound timer runs spent 2,712,444 raw tokens in the 30-minute window:

- `31e4658e-ed59-4d0b-97cd-f658a046f928`, Market Pulse Researcher, 881,044 raw
  tokens, ended with heartbeat budget exhausted and no market-sweep deliverable.
- `4c57ab2d-fc13-49bb-8d45-4fe26ad15ced`, Asset Composer, 744,124 raw tokens,
  completed a useful issue disposition.
- `532f9130-42e7-4065-9d5f-a0214249aa9b`, Venture Factory Liaison, 628,734 raw
  tokens, ended with "I have to stop calling tools" while the issue remained
  `in_progress`.
- `b8f954ca-857d-43f3-9473-e4d912c004b0`, Truth Boundary Steward, 458,542 raw
  tokens, completed a useful issue disposition.

The scalable fix is not to cap all issue-bound work lower. Two of the four
runs delivered final value. The fix is to stop automatic timer recursion after
the partial class: if the latest same-agent receipt says heartbeat budget was
exhausted, a deliverable is not written, or the agent must stop calling tools,
Paperclip skips the next timer wake with
`heartbeat.timer_budget_exhausted_requires_handoff`. That keeps full budgets for
fresh issue-bound work while requiring a deliberate handoff for continuation
runs that would otherwise replay partial context.

The next observed same-agent timer receipt was an even narrower no-progress
class. Chief of Staff run `6d3dcd5c-1412-434f-bac7-b0c3dd7b1650` on
`PORAA-3211` spent 509,585 raw tokens and completed successfully according to
the run table, but the issue comment said the heartbeat was consumed by context
loading only, made no Paperclip API mutations, and should resume on the next
timer. The no-new-signal detector now treats this as a skip-until-new-signal
receipt so the next timer cannot spend another provider call replaying context.

The Skill Curator timer exposed the matching deterministic-deliverable class.
Run `fba116d1-3bd7-4a1e-a4ec-75af1ffe044d` on `PORA-1801` spent 524,037 raw
tokens, reran `/Users/mnm/Documents/Github/portfolio-os/scripts/skill_curator.py`,
found exactly 43 skills missing `keywords:`, and then stopped before adding the
lines or closing the issue. That is not a budget-cap problem; the issue already
had a complete mechanical acceptance path. The cutover routes the live
`Skill Inventory :: Curate And Sync` routine, identified by its `skill_sync`
actionability contract, to
`scripts/process-runbooks/skill-inventory-runner.mjs`. The runbook preserves
the useful output by adding deterministic keywords from each skill slug,
description, and trigger section, rerunning the curator report, and posting a
final Paperclip disposition with zero provider tokens.

Live cutover proof on June 17, 2026:

- Process run `48299aab-5161-4051-b18c-dda3f50ed83e` closed `PORA-1801`.
- `usageJson=null`, `providerTokensSpent=0`, `repairedCount=43`.
- Curator before/after: `pass=10/fail=43` to `pass=53/fail=0`.
- Independent Portfolio OS validation command passed:
  `/Users/mnm/Documents/Github/portfolio-os/.venv/bin/python scripts/skill_curator.py`
- Post-cutover tokenomics watch passed with `currentRawTokens=0`,
  `highBurnEvents=0`, `tokenReductionRatio=1`, and
  `valuableOrSafelySkippedRatio=1`:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T121243268Z-92567-hermes-tokenomics-watch.json`

Process-runner observability is part of the same cutover. The process adapter
now forwards child-spawn metadata to the heartbeat service so future deterministic
runs can persist `processPid`/`processGroupId` and be reaped like other local
execution planes.

Live validation:

- Run `2f1e3183-c754-446b-9728-05c49f75ef44`
- Adapter provenance: `paperclipRuntimeProvenance.adapterType=process`
- Override provenance: `paperclipIssueAdapterOverride.baseAdapterType=hermes_local`
  and `adapterType=process`
- `usageJson=null`, `currentRawTokens=0`, `highBurnEvents=0`
- Reconciler command passed and refreshed
  `/Users/mnm/Documents/Github/portfolio-os/data/dispatch/inbox/evidence_20260503T193357Z.json`
- Validation command passed:
  `npx vitest run server/__tests__/evidence-backfill-reconciler.test.ts`
- Paperclip posted issue comment `9134ed2d-d754-4a39-8f22-ed390c605a2f`

The Dispatch Poller was the next issue-bound high-burn class. Run
`8a785eaf-ad2d-49ca-8f8a-b79a36b23ce3` was valuable work, not waste: it closed
`PORAA-3181` and posted a final parity comment. It still consumed 885,875 raw
MiniMax tokens because deterministic dispatch hash, branch telemetry, and
artifact-drift checks ran through Hermes.

That class now has a process-plane runbook:

`scripts/process-runbooks/dispatch-poller-runner.mjs`

Routine creation recognizes Portfolio Dispatch Contracts with
`routine_key: "dispatch-poller"` and automatically materializes an
issue-level `assigneeAdapterOverrides.adapterType=process` override unless the
contract explicitly supplies a different deterministic adapter. The runbook
uses the existing issue contract, linked approval payloads when available,
local dispatch artifacts, and git metadata to emit the required
`dispatch_parity_invariant` plus branch telemetry. It patches the issue to
`done` for non-blocking artifact drift or `blocked` for missing/mismatched
canonical contract sources, and it emits structured
`PAPERCLIP_ADAPTER_RESULT_JSON` so Paperclip posts the final summary comment.

Existing open Dispatch Poller issues are upgraded too. A scheduled or API
routine run that coalesces into open routine WIP now backfills the deterministic
override before returning, so pre-cutover issues do not keep spending Hermes
tokens just because they were created before the process-plane rule existed.

Expected effect: future Dispatch Poller issues preserve final deliverables and
reduce provider usage for that class from hundreds of thousands of raw tokens
per run to zero.
- Five-minute post-cutover watch receipt passed:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T090225385Z-11013-hermes-tokenomics-watch.json`
- Live coalesced-WIP canary passed after restart. `PORAA-3194` started with
  `assigneeAdapterOverrides=null`; the canary routine run coalesced into that
  issue, wrote `adapterType=process`, and created no heartbeat/provider run:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T094836Z-dispatch-poller-process-coalesce-live-canary.json`
- Live process execution canary then completed the same open issue. The first
  execution attempt exposed a production API-shape bug: agent issue reads return
  a compact wrapper (`agent_issue_snapshot.issue`), while the runbook expected a
  flat issue object. The runbook now normalizes both response shapes. The retry
  closed `PORAA-3194`, posted the final parity comment, wrote
  `/Users/mnm/Documents/Github/YT-Synth/docs/dispatch-poller/20260504T004042Z/iteration-206.md`
  and `/Users/mnm/Documents/Github/YT-Synth/docs/poller_parity_payload_PORAA-3194.json`,
  and recorded `usageJson=null` with `providerTokensSpent=0`:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T095412Z-dispatch-poller-process-execution-live-canary.json`
- Post-restart five-minute watch receipt showed `currentRawTokens=0`,
  `highBurnEvents=0`, `tokenReductionRatio=1`, and MiniMax still available:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T094932812Z-30749-hermes-tokenomics-watch.json`
- Restart log for the loaded production process:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T094656Z-paperclip-restart.log`

Residual red-team finding: the next five-minute watch failed even though
valuable-output accounting passed. The failure was one issue-bound CMO timer
run, `b61c4c99-79d4-4ab7-9dff-4ebe84ad062b` on `PORAA-3207`, which spent
640,882 raw MiniMax tokens and then reported no state change, no issue
transition, no comment, and no file edit. The balancer dry-run reported zero
pending fleet config changes, so this was not drift from the current caps.
The production fix is the timer-continuation no-new-signal gate: Paperclip now
checks the latest same-agent issue receipt, the linked run marker when present,
the receipt age, and whether any newer external comment or issue update exists.
Only then does it skip with `heartbeat.no_new_issue_signal`; explicit comment,
approval, assignment, manual, or newer-signal wakes still run.

Failing receipt that proves the residual class:
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T095447808Z-34544-hermes-tokenomics-watch.json`

After that high-burn CMO run aged out of the five-minute window, the clean
post-window watch passed with `currentRawTokens=0`, `highBurnEvents=0`,
`tokenReductionRatio=1`, and `valuableOutputStatus=pass`:
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T095853583Z-37626-hermes-tokenomics-watch.json`

The no-new-signal timer gate was then live-canaried against the same CMO issue,
`PORAA-3207`. Paperclip pinned the timer wake to the issue, detected the latest
same-agent no-progress receipt plus linked run evidence, created a skipped
wakeup with `reason=heartbeat.no_new_issue_signal`, returned no heartbeat run,
and kept active runs at zero:
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T101430Z-no-new-signal-timer-canary.json`

A follow-up five-minute watch with no work-bearing output showed the expected
conservative status: `status=warn` because there were no final deliverables in
that short window, but `tokenReductionRatio=1`,
`valuableOrSafelySkippedRatio=1`, `currentRawTokens=0`,
`highBurnEvents=0`, and MiniMax available:
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T101717483Z-48914-hermes-tokenomics-watch.json`

After the pre-fix CMO burn aged out, the 30-minute post-cutover proof window
passed. This is the current production proof for the tokenomics goal:
`status=pass`, `tokenReductionRatio=1`, `valuableOrSafelySkippedRatio=1`,
`valuableOutputStatus=pass`, `valuableOutputGainRatio=1.7472527472527473`,
`currentRawTokens=0`, `highBurnEvents=0`, `driftedAgents=0`,
`finalDeliverableUnits=1`, `verifiedOutputUnits=4`, and MiniMax Token Plan
available with 100 percent of the current five-hour interval and 19 percent of
the weekly quota remaining:
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T102450066Z-52211-hermes-tokenomics-watch.json`

The corresponding 30-minute watch at
`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T090207234Z-10962-hermes-tokenomics-watch.json`
still failed because its window included the pre-cutover Hermes canary. Keep
that receipt as historical evidence of the eliminated burn class; do not use it
to judge the process-plane canary.

Operational rule: when the current issue can be completed by a deterministic
runner that emits `PAPERCLIP_ADAPTER_RESULT_JSON`, route it through the
`process` adapter. Use Hermes, Gemini, Claude, or Codex only when the run needs
model judgment, repo exploration, code synthesis, review, or research
synthesis. This preserves final deliverables while avoiding context replay for
work that is already a commandable factory step.

Do not treat receipts that include runs before the skill/tool-output cutover as
proof that the newest controls failed. They are valid red signals for the fleet
window, but they mix old and new behavior. A clean post-cutover proof needs a
work-bearing run whose context ledger includes `promptMetrics.skillBudget`,
`promptMetrics.hermesToolOutputBudget`, a run-owned session id, and final
deliverable credit. A run whose issue comment is only `session_id: ...` is a
failed evidence artifact even when the child process exit code is zero.

Each receipt includes `providerCapacity.minimax`. Important fields:

- `status`: `available`, `exhausted`, `unknown`, or `not_applicable`
- `quota.currentIntervalRemainingPercent`: remaining 5-hour Token Plan quota
- `quota.currentWeeklyRemainingPercent`: remaining weekly Token Plan quota
- `quota.limitingWindow`: `interval` or `weekly` when MiniMax is exhausted
- `expiresAt`: the next useful capacity probe time; for exhausted quota this is
  the provider reset/release time plus a short grace period

The receipt explicitly accounts for the recursive factory loop:

- Codex/Portfolio OS is the truth plane for research, dispatch, and authority.
- Paperclip cockpit is the control plane for routines, issues, wakeups,
  context-ledger receipts, and run/cost events.
- Hermes Agent is the execution plane through the Paperclip adapters.
- `scrapegraphai`, Graphify, `gstack`, gbrain, context packs, and Ponytail are
  optimizer tools, not optional decorations.

Each receipt also includes `current.output` and `baseline.output` so operators can
separate productive throughput from silence:

- `completedIssues`: issues completed in the window.
- `succeededIssueBoundRuns`: successful Hermes/Paperclip runs with issue context.
- `artifactBackedLedgerEntries`: context-ledger entries with artifact, context
  pack, final-response artifact, or receipt evidence.
- `receiptBackedLedgerEntries`: context-ledger entries with receipt paths.
- `successfulLedgerOutcomes`: context-ledger entries with successful final
  outcomes such as `completed`, `verified`, or `shipped`.
- `verifiedOutputUnits`: de-duplicated evidence units from completed issues,
  issue-bound runs, artifact-backed ledger entries, and successful ledger
  outcomes. This is supporting evidence, not the output-lift gate.
- `verifiedOutputUnitsPerDecision`: `verifiedOutputUnits` divided by wake/run
  decision units.
- `finalDeliverableUnits`: completed issues plus successful artifact-backed
  context-ledger entries tied to an issue. Timer summaries, preflight logs,
  accepted patches, build runs, and PR activity without issue delivery do not
  satisfy this metric.
- `finalDeliverableUnitsPerDecision`: `finalDeliverableUnits` divided by
  wake/run decision units. The watch compares this rate to the baseline and
  stores the lift in `evaluation.valuableOutputGainRatio`.

## Five-Day Burn Analysis

The repeatable analysis op classifies recent provider usage by run shape and
emits a receipt. The June 17, 2026 receipt:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T045052Z-hermes-tokenomics-analysis.json`

Key finding:

- `no_issue_no_deliverable_timer_or_manual`: 271 runs, 189,691,316 raw tokens,
  59.02 percent of the five-day raw token burn.
- Estimated savings from shaping only that class to 30,000 raw tokens per run:
  181,561,316 raw tokens, or 56.49 percent of total burn in the receipt.

The post all-planes session-resume fix receipt:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T050451Z-hermes-tokenomics-analysis.json`

Key finding:

- `no_issue_no_deliverable_timer_or_manual`: 274 runs, 193,680,052 raw tokens,
  59.52 percent of the five-day raw token burn.
- Estimated savings from shaping only that class to 30,000 raw tokens per run:
  185,460,052 raw tokens, or 56.99 percent of total burn in the receipt.

That class is the primary savings lever because it does not contain explicit
issue handoffs or final deliverables. Do not use this finding to shrink
issue-tied assignment work; the watch keeps those runs separate as
`issue_tied_delivery_or_evidence`.

The current post-restart five-day classifier:

`/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T110905998Z-76128-hermes-tokenomics-analysis.json`

Key finding:

- `no_issue_no_deliverable_timer_or_manual`: 276 runs, 200,910,211 raw tokens,
  53.75 percent of the five-day raw token burn.
- Estimated savings ratio from shaping that class: 51.54 percent of total burn.

This keeps the 50 percent reduction target grounded in observed waste rather
than arbitrary caps. The no-new-signal, no-inbound-triage, idle/manual skip,
system self-heal factory-guard skip, process-runbook, session isolation, and
tool-output controls are the production cutovers that target this class while
preserving issue-tied delivery budgets.

System-owned factory-guard issues, such as `maintenance_lane_cadence` or
`upstream_artifact_unchanged`, are not agent work. Timer wakes now exclude those
issues from assigned-work pinning and idle-assignment counts. A direct assignment
wake against one of those guard issues still records
`heartbeat.system_self_heal_guard_no_agent_action` without launching an adapter,
and the tokenomics watch counts that reason as a safe low-cost decision. This
keeps self-heal receipts visible without letting a guard issue suppress useful
Council or venture-factory work.

## Validation

- Focused all-planes request-shaping tests passed on June 17, 2026:
  - `hermes-local-compat-adapter.test.ts`
  - `gemini-local-execute.test.ts`
  - `claude-local-execute.test.ts`
  - `hermes-tokenomics-balance.test.ts`
  - `hermes-tokenomics-watch.test.ts`
  - `hermes-tokenomics-analysis.test.ts`
  - `provider-capacity.test.ts`
  - `opencode-go-role-routing.test.ts`
- Focused adaptive Hermes budget tests passed on June 17, 2026:
  - external adapter: `npm test` in
    `/Users/mnm/Documents/Github/hermes-paperclip-adapter`
  - built-in adapter: `hermes-local-compat-adapter.test.ts`
  - Hermes limits: `tests/tools/test_tool_output_limits.py`
- Typechecks passed for `@paperclipai/adapter-utils`,
  `@paperclipai/adapter-gemini-local`, `@paperclipai/adapter-claude-local`, and
  `@paperclipai/server`.
- No-new-signal timer gate validation passed on June 17, 2026:
  - `heartbeat-process-recovery.test.ts`
  - `hermes-tokenomics-watch.test.ts`
  - `@paperclipai/server` typecheck
  - live `PORAA-3207` canary receipt:
    `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T101430Z-no-new-signal-timer-canary.json`
- No-inbound-triage gate validation passed on June 17, 2026:
  - `heartbeat-process-recovery.test.ts`
  - `hermes-tokenomics-watch.test.ts`
  - `hermes-tokenomics-balance.test.ts`
  - `@paperclipai/server` typecheck
  - full server suite: `155` files passed, `1004` tests passed, `1` skipped
- Timer-budget-exhausted handoff gate validation passed on June 17, 2026:
  - `heartbeat-process-recovery.test.ts`
  - The regression proves a repeated timer wake after a same-agent
    `heartbeat-budget exhausted` receipt creates no heartbeat run, does not call
    the adapter, leaves the issue `in_progress`, and records
    `heartbeat.timer_budget_exhausted_requires_handoff`.
  - `hermes-tokenomics-watch.test.ts`
  - `hermes-tokenomics-balance.test.ts`
  - `@paperclipai/server` typecheck
  - full server suite: `155` files passed, `1004` tests passed, `1` skipped
- Context-loading-only no-new-signal validation passed on June 17, 2026:
  - `heartbeat-process-recovery.test.ts`
  - The regression proves a timer-pinned assigned issue with the same-agent
    "context loading only / no Paperclip API mutations / resume next timer"
    receipt launches no adapter and records `heartbeat.no_new_issue_signal`.
- System self-heal factory-guard timer validation passed on July 6, 2026:
  - `heartbeat-process-recovery.test.ts`
  - `hermes-tokenomics-watch.test.ts`
  - The regressions prove timer wakes ignore system-owned factory-guard issues
    for assigned-work pinning, still run the next actionable assignment when one
    exists, and count existing `heartbeat.system_self_heal_guard_no_agent_action`
    rows as safe low-cost wake decisions.
- Skill Inventory process-plane validation passed on June 17, 2026:
  - `skill-inventory-runbook.test.ts`
  - `routines-service.test.ts`
  - The runbook test proves missing `keywords:` frontmatter is repaired, the
    curator reruns to `pass=2/fail=0`, the issue is patched `done`, and the
    structured result reports `providerTokensSpent=0`.
  - The routine tests prove new and coalesced `Skill Inventory :: Curate And
    Sync` routine issues receive `assigneeAdapterOverrides.adapterType=process`
    and run `scripts/process-runbooks/skill-inventory-runner.mjs`.
  - Live run `48299aab-5161-4051-b18c-dda3f50ed83e` proved the same path against
    `PORA-1801`: `pass=53/fail=0`, issue `done`, active runs `0`, and zero
    provider tokens.
- Run QA Sweep process-plane validation was added on June 21, 2026:
  - `run-qa-sweep-runbook.test.ts`
  - `routines-service.test.ts`
  - The runbook tests prove the deterministic lane writes QA evidence, patches
    the issue `done`, reports `providerTokensSpent=0`, and truthfully patches
    `blocked` when no QA target surface exists.
  - The routine test proves `routine_key: "run-qa-sweep"` receives
    `assigneeAdapterOverrides.adapterType=process` and runs
    `scripts/process-runbooks/run-qa-sweep-runner.mjs`.
- The heartbeat execution drain now tracks both adapter execution and heartbeat
  maintenance/reaper work. This fixed the full-suite cleanup race where
  orphan-run recovery could append `heartbeat_run_events` after tests thought
  execution had drained.
- Paperclip was restarted on port `3100` with the all-planes request-shaping fix
  loaded. Health returned `ok`, screen sessions were running for
  `paperclip-cockpit-cutover` and `paperclip-tokenomics-watch`, and there was no
  listener on `3101`.
- Paperclip was restarted again after the no-inbound-triage cutover. The loaded
  listener was PID `75357`, `/api/health` returned `ok`, and the restart log was:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T110300Z-paperclip-restart.log`
- Paperclip was restarted again after the timer-budget-exhausted handoff gate.
  The loaded listener was PID `82794`, `/api/health` returned `ok`, there were
  zero queued/running heartbeat runs, no listener on port `3101`, and the restart
  log was:
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T113823Z-paperclip-restart.log`
- The immediate five-minute post-restart tokenomics receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T113852408Z-83020-hermes-tokenomics-watch.json`
  showed `currentRawTokens=0`, `highBurnEvents=0`, `tokenReductionRatio=1`,
  `valuableOrSafelySkippedRatio=1`, `driftedAgents=0`, and MiniMax available.
  It reported `status=warn` only because the short window had no final
  deliverable units; keep the watch running through the next work-bearing window
  before claiming a fresh output-lift pass.
- Fresh balance receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T050452Z-hermes-tokenomics-balance.json`
  showed `56` candidates, `0` drifted changes needed, Ponytail attached to all
  `56`, and request shaping enabled.
- Post-restart balance receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T110429870Z-75612-hermes-tokenomics-balance.json`
  again showed `56` candidates, `0` changes needed, Ponytail attached to all
  `56`, with `36` factory profiles and `20` research-synthesis profiles.
- Post-restart five-minute watch receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T110735287Z-75901-hermes-tokenomics-watch.json`
  passed with `currentRawTokens=0`, `highBurnEvents=0`,
  `tokenReductionRatio=1`, `valuableOrSafelySkippedRatio=1`,
  `valuableOutputStatus=pass`, `valuableOutputGainRatio=18.68503937007874`,
  `finalDeliverableUnits=1`, `verifiedOutputUnits=3`, and MiniMax available
  with `98` percent of the current five-hour interval and `19` percent of the
  weekly quota remaining.
- The 30-minute post-restart receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T110430791Z-75613-hermes-tokenomics-watch.json`
  still failed because the window included the pre-fix Council run
  `b5368eb6-17c0-48f0-bd6b-7dbade86d7ca` at `550,909` raw tokens. Treat it as
  historical evidence of the eliminated empty-triage class until it ages out of
  the 30-minute window.
- After that high-burn event aged out, the strict 30-minute receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T112358863Z-76584-hermes-tokenomics-watch.json`
  showed the token side clean (`currentRawTokens=0`, `highBurnEvents=0`,
  `tokenReductionRatio=1`, `valuableOrSafelySkippedRatio=1`, `driftedAgents=0`)
  but failed the output-lift side (`valuableOutputGainRatio=0.7755681818181819`)
  because the window had only one final-deliverable unit across eleven
  decisions. This is not a tokenomics regression; it is a throughput proof gap.
- Agent autonomy recovery dry-run
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/agent-autonomy-recovery/runs/20260617T1126476Z.json`
  found one stale `error` agent (`POR` CTO) and 41 timer-baseline resets, but it
  was not applied because the broad plan would re-enable 11 timer heartbeats,
  including LeadForge timers that were intentionally disabled. Apply recovery
  only through a narrower issue-bound or company-allowlisted path.
- Fresh watch receipt
  `/Users/mnm/.paperclip-local/portfolio-os-cockpit/instances/default/data/ops/provider-tokenomics/runs/20260617T050856Z-hermes-tokenomics-watch.json`
  still failed because the 30-minute window included pre-fix high-burn MiniMax
  events and no final deliverable units. This is a valid red signal: do not claim
  the 90 percent valuable-output target until a clean post-fix work-bearing
  window records completed issues or successful issue-tied artifact deliveries.
- Gemini direct canary succeeded with `gemini-2.5-flash` and reported nonzero `stats`.
- Focused tests passed:
  - `gemini-local-adapter.test.ts`
  - `heartbeat-workspace-session.test.ts`
  - `opencode-go-role-routing.test.ts`
- Typechecks passed for `@paperclipai/adapter-gemini-local` and `@paperclipai/server`.
- Paperclip restarted on port `3100`; `/api/health` returned `ok`.
- Post-restart database validation showed zero active runs, routed Hermes agents,
  concurrency-capped agents, session-compaction configs, and no enabled Hermes
  timer below 1800 seconds.
- Realtime tokenomics validation is provided by
  `latest-tokenomics-watch.json` in the provider-tokenomics receipt directory.

## Caveats

- Session rotation reduces cross-run carryover, but it cannot prevent a single fresh Hermes run from spending heavily if the underlying task loops or pulls large context.
- Gemini subscription routing is now observable, but subscription CLIs can still lose a local process if the desktop app or CLI session exits. Treat `process_lost` as infrastructure evidence, not success.
- Idle timer preflight only skips when there is no explicit wake context and no
  open assigned work. It does not skip assignment, automation, comment,
  approval, or on-demand wakes.
- LeadForge recurring timers were stopped because that company is excluded from POS selection work. Manual/on-demand wakes still work.
- Runtime counters in `agent_runtime_state` are cumulative. Use `cost_events.occurred_at` windows for recent token-burn analysis.
- The no-new-signal gate is intentionally narrow. It does not infer staleness
  from generic language alone; a timer wake must be pinned by Paperclip to open
  assigned work, the newest issue comment must be by the same agent, the receipt
  must be recent, and no later external signal may exist.
- The timer-budget-exhausted handoff gate is also intentionally narrow. It does
  not block comment, approval, assignment, manual issue, or newer-signal wakes.
  It only prevents Paperclip from automatically respawning a timer continuation
  from the same exhausted same-agent receipt without a deliverable.
- The Skill Inventory process runbook intentionally does not blindly commit the
  Portfolio OS working tree. It may repair `.agents/skills/*/SKILL.md` and
  regenerate `reports/skills/latest.md`, but a repo with broad unrelated dirty
  files must keep commit/stage decisions under a separate explicit release gate.
  The deliverable is the repaired skill inventory plus Paperclip issue
  disposition, not a broad auto-stage of the entire Portfolio OS checkout.
Profit Flywheel stages are server-authorized, issue-backed deliverables. Their
versioned provider-policy turn budget takes precedence over the generic
timer-assigned status cap, even when the stage dispatcher wakes the assigned
agent through a timer-shaped request. The small recurring-status budget must
never truncate implementation, independent QA, or release before its required
immutable receipt is written.

# Profit Flywheel credential audit

Before a Profit Flywheel cutover is accepted, run the repository-wide credential
audit rather than treating an empty local forbidden-token list as proof. The
audit scans every tracked file at each current HEAD, every changed blob in the
task commit range, and the supplied runtime receipt/log/context-pack roots. It
never writes matched values to its receipt.

Known synthetic fixtures, documentation examples, and captured public security
fixtures are reviewable only through
`config/profit-flywheel-secret-audit.v1.json`. Git reviews are pinned to exact
blob or tree object IDs. Historical suppression requires the exact same match
to remain in that reviewed current scope, unless an operator separately reviews
and pins the exact historical revision, path, and blob object. Runtime reviews
are pinned to exact SHA-256 values. Any changed fixture, new provider-shaped
value, unreviewed removed historical value, or unreviewed runtime match fails
closed.

```bash
pnpm audit:profit-flywheel-secrets -- \
  --policy config/profit-flywheel-secret-audit.v1.json \
  --repo paperclip=/path/to/paperclip \
  --repo portfolio-os=/path/to/portfolio-os \
  --repo hermes-agent=/path/to/hermes-agent \
  --repo hermes-paperclip-adapter=/path/to/hermes-paperclip-adapter \
  --repo gstack=/path/to/gstack \
  --runtime-root flywheel-repair=/path/to/data/ops/flywheel-repair \
  --runtime-root provider-tokenomics=/path/to/data/ops/provider-tokenomics \
  --runtime-root paperclip-guard=/path/to/data/ops/paperclip-guard \
  --runtime-root context-packs=/path/to/data/ops/context-packs \
  --receipt-dir /path/to/data/ops/flywheel-repair/runs
```

Acceptance requires `status=verified` and `summary.unsuppressed=0`. A reviewed
non-secret count is expected because redaction tests must contain synthetic
credential shapes; it is not a secret count.
