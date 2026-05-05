# Troubleshooting

## API health ok, dashboard run surfaces return 500

Observed on 2026-05-05 in the canonical checkout at
`/Users/mnm/Documents/Github/paperclip`.

Symptom:

- `GET /api/health` returns `200` with `{"status":"ok"}`.
- `GET /api/companies` returns the expected companies.
- Dashboard run surfaces fail because these endpoints return `500`:
  - `GET /api/companies/:companyId/heartbeat-runs?limit=5`
  - `GET /api/companies/:companyId/live-runs?minCount=4`
- Server logs show:

```text
TypeError: Cannot convert undefined or null to object
    at Object.entries (<anonymous>)
    at orderSelectedFields (.../drizzle-orm/.../utils.ts:77:16)
```

First-principles diagnosis:

1. Confirm the listener and source boundary:

```sh
pnpm dev:list
lsof -nP -iTCP:3100 -sTCP:LISTEN
lsof -a -p <listener-pid> -d cwd,txt
git status --short --branch
```

2. Reproduce the failing API surface directly:

```sh
curl -i http://127.0.0.1:3100/api/health
curl -i http://127.0.0.1:3100/api/companies
curl -i 'http://127.0.0.1:3100/api/companies/<company-id>/heartbeat-runs?limit=5'
curl -i 'http://127.0.0.1:3100/api/companies/<company-id>/live-runs?minCount=4'
```

3. Check whether Drizzle select maps reference missing schema exports. In the
2026-05-05 incident, the live database already had heartbeat run columns such
as `last_output_at`, `scheduled_retry_at`, and `liveness_state`, but the local
`packages/db/src/schema/heartbeat_runs.ts` source did not export the matching
`heartbeatRuns.lastOutputAt`, `heartbeatRuns.scheduledRetryAt`, and
`heartbeatRuns.livenessState` fields. Drizzle received `undefined` in a select
map and threw before issuing SQL.

4. Distinguish database drift from source drift:

```sh
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/db typecheck
```

If typecheck reports missing shared exports, missing schema columns, or plugin
contract mismatches across `packages/db`, `packages/shared`, and `server`, treat
the checkout as a partial reintegration rather than a runtime database problem.

Recovery pattern:

1. Preserve the dirty tree before any destructive cleanup:

```sh
git switch -c codex/paperclip-dirty-runtime-reintegration-YYYYMMDD
git add -A
git commit -m "chore: preserve dirty runtime reintegration state"
```

2. Restore canonical `main` to the known-good remote state:

```sh
git switch main
git fetch origin --prune
git reset --hard origin/main
git clean -nd
```

Only run `git clean -fd` if the dry run shows disposable files.

3. Restart from the coherent checkout, keeping the cockpit runtime data intact:

```sh
pnpm dev:stop
lsof -nP -iTCP:3100 -sTCP:LISTEN
pnpm dev
```

The runtime data directory should remain under
`/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default`.
Do not delete or reinitialize that directory to fix this class of issue.

4. Verify the repair with the same probes:

```sh
curl -i http://127.0.0.1:3100/api/health
curl -i http://127.0.0.1:3100/api/companies
curl -i 'http://127.0.0.1:3100/api/companies/<company-id>/heartbeat-runs?limit=5'
curl -i 'http://127.0.0.1:3100/api/companies/<company-id>/live-runs?minCount=4'
pnpm -r typecheck
pnpm test:run
pnpm build
```

Do not call the incident resolved until the run endpoints return `200`, the
listener cwd is the canonical checkout, and the checkout no longer contains
ambiguous partial reintegration changes on `main`.
