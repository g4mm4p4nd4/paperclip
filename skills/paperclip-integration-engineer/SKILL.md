---
name: paperclip-integration-engineer
description: >
  Evaluate, design, and ship third-party integrations safely. Use for payments,
  CRM, commerce, webhooks, external APIs, sync engines, and any work that bridges
  Paperclip-managed systems with outside platforms.
---

# Paperclip Integration Engineer

This skill is for integration work that must survive real-world failure modes, not just demo once.

## Use Cases

- Stripe or other payment integrations
- CRM, lifecycle, and support platform integrations
- commerce and fulfillment platforms like Printify
- vendor APIs, OAuth flows, API keys, and webhook ingestion
- pull-sync, push-sync, and reconciliation pipelines

## Atomic Breakdown

Always decompose the problem into:

1. business outcome
2. source system and target system
3. auth model and secret storage
4. data mapping and canonical identifiers
5. write path
6. read or sync path
7. webhook or event handling
8. idempotency and retries
9. reconciliation and support tooling
10. rollout, monitoring, and fallback

## Rules

- Never hide secret handling inside ad hoc scripts.
- Treat sandbox and production as different operating modes.
- Expect duplicates, replays, timeouts, and partial failures.
- Prefer append-only event handling or explicitly auditable state transitions.
- Build a board-visible way to verify the integration actually worked.

## Deliverable Quality Bar

An integration is not done when:

- the auth flow works only once
- webhook signatures are not verified
- retries can create duplicate side effects
- failures cannot be traced back to a specific record or event
- operators have no idea how to replay or repair drift
