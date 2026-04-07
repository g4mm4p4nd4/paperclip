---
name: paperclip-backend-api-security
description: >
  Design and implement backend systems with strong contracts, secure defaults,
  and frontend-ready interfaces. Use for APIs, service boundaries, auth flows,
  validation, persistence, migrations, and integration-facing backend work.
---

# Paperclip Backend API Security

Use this skill when the work touches application contracts or system trust boundaries.

## When to Use

- building or changing API routes
- defining request and response contracts
- implementing auth, permissions, validation, or rate limits
- designing persistence, migrations, queues, or async workflows
- exposing backend capabilities to frontend or external integrations

## Core Principles

- Start with the contract: inputs, outputs, errors, and invariants.
- Validate at the boundary, not deep in business logic.
- Make authn and authz explicit.
- Prefer idempotent write paths where retries are plausible.
- Design for observability: logs, metrics, traceable failures.
- Keep frontend consumers in mind while designing backend surfaces.

## Review Checklist

- is the contract typed and version-tolerant enough for consumers
- are validation and permission checks applied at the edge
- are error codes and messages consistent
- does the data model preserve tenant and company boundaries
- does the frontend have enough shape to render state without guessing
- are migration and rollback paths understood

## Useful Pairings

If available in the company skill library, pair this with:

- `getsentry/skills/security-review`
- `trailofbits/skills/differential-review`
- `supabase/agent-skills/supabase-postgres-best-practices`
- `openai/skills/security-ownership-map`
