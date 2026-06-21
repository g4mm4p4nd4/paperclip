# Agent Skill Alignment Trace

Use this report when agent work quality or token usage suggests that role skills
are either undercovered or overloaded.

## Goal

Persistent agent skills should be a small role baseline. Approved company
skills should stay available for adaptive runtime selection, but they should not
all be injected into every model call.

The trace separates four states:

| State | Meaning |
| --- | --- |
| `desiredSkills` | Persistent role baseline and explicitly kept custom skills |
| `eligibleOptionalSkills` | Company-approved skills the runtime selector may use when task context matches |
| `prunedContextOnlyDesiredSkills` | Optional skills that should leave persistent desired config but remain selectable |
| `promptMetrics.skillBudget` | Per-run selected/skipped/reason trace emitted by local adapters |

## Runbook

Dry-run:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-skill-alignment-trace.ts
```

Apply baseline repairs:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/agent-skill-alignment-trace.ts --apply
```

The command writes:

- JSON receipt under `.paperclip/.../data/ops/agent-skill-alignment/runs/`
- HTML dashboard at `docs/reports/agent-skill-alignment-dashboard.html`

## Success Metrics

- `undercoveredAgents = 0`: every active agent has the Paperclip coordination
  skill and its core role baseline.
- `overloadedAgents = 0`: no agent persistently carries optional
  context-triggered skills such as `long-form-sales-letter` when those skills can
  be selected at runtime.
- `recentRunsWithSkillBudget = recentRuns`: every local adapter invocation emits
  selected/skipped/reason metrics.
- CMO marketing-strategy traces select go-to-market/product skills and skip
  direct-response content skills unless the issue explicitly asks for that
  artifact.
- Growth/Distribution traces select distribution, launch, and analytics skills
  when the task mentions channels, launch, or conversion metrics.

## Caveat

This is not a security bypass. The adaptive candidate pool is the approved
company skill catalog already visible to Paperclip. Risky external skills still
require the normal company skill review before they enter that catalog.
