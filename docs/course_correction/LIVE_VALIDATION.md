# Live Validation

Date: 2026-04-15
Environment:
- Paperclip code: `/Users/mnm/.codex/worktrees/65bb/paperclip`
- Cockpit data dir: `/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit`
- Portfolio-OS code: `/Users/mnm/Documents/Github/portfolio-os`

## Executed Checks

### 1. Cockpit Health

Command:

```sh
curl -sS http://127.0.0.1:3100/api/health
```

Expected:
- `status: ok`
- `deploymentMode: local_trusted`

### 2. Company Inventory

Command:

```sh
node <<'NODE'
(async()=>{ console.log(JSON.stringify(await (await fetch('http://127.0.0.1:3100/api/companies')).json(), null, 2)); })();
NODE
```

Expected:
- orchestrator company with issue prefix `PORA`
- LeadForge venture company with issue prefix `POR`

### 3. Legacy Dispatch Dossier Compatibility

Proof target:
- [`selected_repo_dossier.json`](/Users/mnm/Documents/Github/portfolio-os/docs/launch_scaffolds/2026-04-10/leadforge-run-20260408t153514z-bootstrap/selected_repo_dossier.json:1)

Why it matters:
- older dispatches that previously logged `missing selected_repo_dossier_path` now have a compatible dossier artifact

### 4. Cross-Company Route Read In Board Context

Command:

```sh
python3 - <<'PY'
from pos.paperclip_existing_venture import _request_json
result = _request_json(
    api_base_url='http://127.0.0.1:3100',
    method='GET',
    path='/api/companies/f18e6021-be98-4490-a0c0-31b3ad308232/issues',
)
print(type(result).__name__, len(result) if isinstance(result, list) else 'n/a')
PY
```

Observed:
- `list 93`

Why it matters:
- the previous dead-end was `403 Agent key cannot access another company`
- in this repaired `local_trusted` environment, the Portfolio-OS route helper can reach the destination company cleanly

### 5. Route Closure Proof

Validated issues:
- destination issue: `POR-1270` is `done`
- source blocker: `PORA-131` is now `done`

Why it matters:
- the existing-venture route is no longer stranded as a board-action markdown packet

### 6. Duplicate Family Cleanup

Runtime artifact:
- [`duplicate-cleanup-2026-04-15.json`](/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/course-correction/duplicate-cleanup-2026-04-15.json:1)

Observed after cleanup:
- `PORA`: `duplicateFamilies=0`, `openIssues=15`
- `POR`: `duplicateFamilies=0`, `openIssues=8`

Why it matters:
- the current routine-family backlog is back under a single-live-issue rule

## Repeatable Targeted Test Suites

Portfolio-OS:

```sh
pytest /Users/mnm/Documents/Github/portfolio-os/tests/test_execution_readiness_cli.py -q
```

Paperclip:

```sh
pnpm exec vitest run server/src/__tests__/portfolio-dispatch.test.ts server/src/__tests__/routines-service.test.ts
```
