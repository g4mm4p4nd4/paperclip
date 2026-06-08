# Portfolio-OS Hermes Flywheel

Paperclip can now act as the coordination bridge between a Portfolio-OS
execution mandate and Hermes-Agent execution without requiring a live Paperclip
server. The bridge is intentionally file-first: it reads the Portfolio-OS
mandate, writes deterministic Paperclip context, creates the Hermes task bundle,
dispatches Hermes when requested, and records the execution result back into the
Portfolio-OS artifact tree.

## Commands

```sh
paperclipai portfolio-os ingest --mandate /Users/mnm/Documents/Github/portfolio-os/data/execution_mandate.json
paperclipai portfolio-os plan-hermes --run-id <run_id>
paperclipai portfolio-os execute --run-id <run_id>
paperclipai portfolio-os status --run-id <run_id>
```

Useful overrides:

- `--portfolio-root <path>` points at a non-default Portfolio-OS checkout.
- `--company-name <name>` changes deterministic Paperclip company context.
- `--hermes-bin <path>` points at a non-default Hermes adapter binary.

## Artifacts

`ingest` writes:

- `data/paperclip_context/<run_id>.json`
- `data/paperclip_context/latest.json`

`plan-hermes` writes:

- `data/hermes_task_bundles/<run_id>.json`
- `data/hermes_task_bundle.seed.json`

Both `ingest` and `plan-hermes` preserve Portfolio OS Internet Pipes
completeness when it is present on the execution mandate. The normalized
contract is written into Paperclip context, Hermes `opportunity`, Hermes
`evidence`, and the validation/trust/QA task instructions so file-first Hermes
execution does not drop station gaps that the live cockpit would see.
When Hermes local adapter prompts carry `promptMetrics.internetPipes`, Paperclip
context-ledger readback keeps that compact station gate and flywheel health
blocks canary readiness until readiness is `alpha_ready`/`factory_ready` and no
missing stations remain.

`execute` writes:

- `data/execution_results/<run_id>.paperclip.json`
- Hermes writes `data/hermes_results/<run_id>.json` when dispatch completes.

`status` reads all of those artifacts and reports the next required action.

## Safety Boundary

Paperclip does not mutate target repositories from this bridge. Target writes,
commits, pushes, and PR creation remain Hermes-Agent responsibilities and must
be governed by the task bundle `target.write_policy`, `target.push_policy`, and
`safety` sections.

The generated bundle always includes:

- `safety.destructive_ops_allowed: false`
- `safety.secrets_scan_required: true`
- forbidden operations for repo deletion, history rewrite, license removal, and
  secret commits

When a launch gate is blocked, the bridge preserves the validation-sprint
mandate instead of pretending the target is launch-ready.
