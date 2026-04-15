# Evals And Reliability

## Purpose

Turn today's failures into cheap regressions that fail before cockpit runtime noise.

## Required Checks

### Portfolio-OS

Command:

```sh
pytest /Users/mnm/Documents/Github/portfolio-os/tests/test_execution_readiness_cli.py -q
```

What it catches:

- dispatch payloads missing dossier fields
- dossier artifact emission for immutable outbox writes
- board-key preference for cross-company routing
- fail-fast behavior when only an agent-scoped key is present
- route issue creation/update behavior

### Paperclip

Command:

```sh
pnpm exec vitest run server/src/__tests__/portfolio-dispatch.test.ts server/src/__tests__/routines-service.test.ts
```

What it catches:

- legacy dispatch compatibility when dossier fields are absent
- dossier gate and freshness enforcement
- dispatch-created engineer execution policies
- routine-family coalescing and WIP enforcement

## Real-File Smoke Target

At least one current outbox file must ingest under a stubbed Paperclip environment without schema errors. The session proof run used:

- `/Users/mnm/Documents/Github/portfolio-os/data/dispatch/outbox/dispatch_20260410T005324Z.json`

Expected outcome:

- ingest result status is `ingested`
- a sibling `selected_repo_dossier.json` exists beside the selection snapshot
- the in-memory ingest ledger records the dispatch hash

## Acceptance Rubric

- Pass:
  - both targeted suites pass
  - at least one real legacy dispatch ingests without dossier-field errors
  - engineer issues carry review/approval stages
  - routine siblings coalesce
- Fail:
  - any route action still silently returns `None` after a permission error
  - any current dispatch still throws `missing selected_repo_dossier_path`
  - any routine family creates overlapping live execution issues
