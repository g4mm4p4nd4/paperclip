# Role Skill Gap Assessment

Date: 2026-04-07
Status: Working operating model for role-aligned Paperclip skill coverage

## 1. Goal

Raise the quality of work completed by Paperclip agents by:

- giving each role a sharper operating model
- bundling safe internal skills for common high-value work
- identifying vetted external skills worth importing into company libraries
- making remaining gaps explicit so future sourcing is faster and less ad hoc

## 2. What Was Added

### Safe bundled Paperclip skills

- `paperclip`
- `paperclip-create-agent`
- `para-memory-files`
- `paperclip-product-scope`
- `paperclip-frontend-experience`
- `paperclip-backend-api-security`
- `paperclip-integration-engineer`
- `paperclip-go-to-market`

### Role-specific managed instruction bundles

- `ceo`
- `cto`
- `cmo`
- `engineer`
- `integration_engineer`
- `designer`
- `pm`
- `qa`
- `devops`
- `researcher`

## 3. Recommended Org Shape

### Executive layer

| Role | Primary job | Core bundled skills | Vetted external candidates |
|---|---|---|---|
| CEO | strategy, prioritization, org design, delegation | `paperclip`, `paperclip-create-agent`, `para-memory-files`, `paperclip-product-scope` | `openai/skills/create-plan` |
| CTO | technical strategy, architecture, sequencing, engineering quality | `paperclip`, `paperclip-product-scope`, `paperclip-backend-api-security`, `paperclip-integration-engineer` | `getsentry/skills/security-review`, `trailofbits/skills/differential-review`, `supabase/agent-skills/supabase-postgres-best-practices`, `openai/skills/security-ownership-map`, `openai/skills/create-plan` |
| CMO | message, launch, growth, distribution | `paperclip`, `paperclip-go-to-market`, `paperclip-product-scope` | `refoundai/lenny-skills/launch-marketing`, `refoundai/lenny-skills/scoping-cutting` |

### Core execution layer

| Role | Primary job | Core bundled skills | Vetted external candidates |
|---|---|---|---|
| Engineer | full-stack implementation | `paperclip`, `paperclip-frontend-experience`, `paperclip-backend-api-security`, `paperclip-integration-engineer` | `vercel-labs/agent-skills/web-design-guidelines`, `vercel-labs/agent-browser/agent-browser`, `getsentry/skills/security-review`, `supabase/agent-skills/supabase-postgres-best-practices` |
| Integration Engineer | third-party systems, vendors, sync flows, webhooks | `paperclip`, `paperclip-integration-engineer`, `paperclip-backend-api-security`, `paperclip-product-scope` | provider-specific skills after manual review |
| Designer | visual system, interaction design, asset direction | `paperclip`, `paperclip-frontend-experience`, `paperclip-product-scope` | `vercel-labs/agent-skills/web-design-guidelines`, `google-labs-code/stitch-skills/design-md` |
| PM | problem definition, scope, acceptance criteria | `paperclip`, `paperclip-product-scope`, `para-memory-files` | `openai/skills/create-plan`, `refoundai/lenny-skills/scoping-cutting` |
| QA | release confidence, browser regressions, repros | `paperclip`, `paperclip-frontend-experience`, `paperclip-backend-api-security` | `vercel-labs/agent-browser/agent-browser`, `vercel-labs/agent-skills/web-design-guidelines`, `getsentry/skills/security-review` |
| DevOps | deployment, runtime, release safety | `paperclip`, `paperclip-backend-api-security`, `paperclip-integration-engineer`, `paperclip-product-scope` | infra-specific skills after manual review |
| Researcher | evidence gathering, synthesis, source-backed recommendations | `paperclip`, `para-memory-files`, `paperclip-product-scope` | research-specific sourcing still needed |

## 4. Suggested Specialist Agents And Subagents

These should usually be represented as titled agents under the broader role families rather than exploding the core role enum further.

### Under CTO

- Frontend Experience Engineer
- Backend Platform Engineer
- Integration Engineer
- QA / Release Engineer
- DevOps / Runtime Engineer

### Under CMO

- Product Marketing Lead
- Growth / Distribution Operator
- Content / Launch Writer

### Under PM / Design / Research

- Product Manager
- UX Designer
- Market Researcher
- Customer Insight Researcher

## 5. Current Skill Gaps

### Engineering gaps

| Gap | Why it matters | Current mitigation | Recommended next move |
|---|---|---|---|
| Frontend conversion-quality skill depth | Landing pages and forms need stronger persuasion and polish than generic engineering prompts produce | `paperclip-frontend-experience` | import `vercel-labs/agent-skills/web-design-guidelines`; source more animation and conversion-focused skills |
| Backend API hardening depth | Engineers need reusable guidance for secure service design beyond "write the route" | `paperclip-backend-api-security` | import `getsentry/skills/security-review`, `trailofbits/skills/differential-review`, `supabase/agent-skills/supabase-postgres-best-practices` |
| Provider-specific integration playbooks | Stripe, CRM, fulfillment, support, analytics each have domain-specific traps | `paperclip-integration-engineer` | source vetted provider-specific skills one provider at a time after review |
| Release and performance discipline | Ship quality depends on browser QA, regression checks, and perf budgets | role instructions only | prioritize QA/perf skill sourcing next |

### Product and strategy gaps

| Gap | Why it matters | Current mitigation | Recommended next move |
|---|---|---|---|
| Structured product planning depth | Better plans improve every downstream agent | `paperclip-product-scope` | import `openai/skills/create-plan` |
| Stronger roadmap and scoping heuristics | Teams otherwise overbuild | `paperclip-product-scope` | import `refoundai/lenny-skills/scoping-cutting` for PM/CMO use |
| Durable market research workflow | Research quality drifts without a stronger method | `para-memory-files` + Researcher bundle | source a vetted research-analysis skill set |

### GTM and marketing gaps

| Gap | Why it matters | Current mitigation | Recommended next move |
|---|---|---|---|
| Narrow, high-trust GTM skill ecosystem | Community GTM skills are weaker and less standardized than engineering ones | `paperclip-go-to-market` | keep GTM imports manual and review-heavy |
| Launch asset systemization | Marketing output needs consistent message-to-asset decomposition | `paperclip-go-to-market` | create or source skills for channel-specific launch asset production |
| Demand-gen analytics integration | GTM agents need better measurement wiring | none | prioritize integration + analytics skill sourcing |

## 6. External Skills To Consider Safe-First

These are the highest-signal candidates from current research, but import should still follow company-level approval for anything with meaningful operational blast radius.

| Skill | Source | Primary value | Risk notes |
|---|---|---|---|
| `openai/skills/create-plan` | OpenAI | planning quality | review prompt content before import |
| `openai/skills/security-ownership-map` | OpenAI | ownership and security topology | low operational risk, but review scope and outputs |
| `vercel-labs/agent-skills/web-design-guidelines` | Vercel | frontend and UX review | fetches remote guidelines on use; review before adoption |
| `vercel-labs/agent-browser/agent-browser` | Vercel | browser QA and automation | higher risk because it touches auth state, browser sessions, and live sites |
| `getsentry/skills/security-review` | Sentry | high-confidence security review | review references and reporting format |
| `trailofbits/skills/differential-review` | Trail of Bits | security-focused diff review | review workflow complexity and expectations |
| `supabase/agent-skills/supabase-postgres-best-practices` | Supabase | Postgres and schema quality | useful when database work is frequent |
| `google-labs-code/stitch-skills/design-md` | Google Labs | design-system extraction | useful for design-heavy teams, but depends on Stitch workflow |
| `refoundai/lenny-skills/launch-marketing` | Refound | GTM execution | community skill, lower trust than first-party engineering skills |
| `refoundai/lenny-skills/scoping-cutting` | Refound | scope discipline | community skill, but useful for PM/CMO planning |

## 7. Security And Approval Model

### Safe to move fast on

- bundled markdown-only Paperclip skills
- external markdown-oriented skills from official or strongly maintained orgs after content review

### Approval required before import

- skills that execute scripts or ship helper binaries
- skills that require browser auth state, remote browser control, or credential vaults
- skills that fetch remote guidance at runtime
- skills that assume MCP connectors or external APIs with broad permissions
- provider-specific operational skills for billing, CRM, fulfillment, or production infrastructure

## 8. Sourcing Checklist For Future Skills

Before adopting a new skill, answer:

1. Which role or titled subagent owns this workflow?
2. Is the gap strategic, operational, or provider-specific?
3. Is the skill markdown-only, asset-bearing, or script-executing?
4. Does it touch browser state, secrets, network access, or live systems?
5. Does it come from an official org, a known maintained repo, or an unknown source?
6. Is there already a broader bundled Paperclip skill that should cover 80 percent of the need?
7. Should the capability be encoded as a role instruction, a bundled internal skill, or a company-imported external skill?

## 9. Immediate Next Steps

1. Pilot the bundled role-aware Paperclip skills with CTO, Engineer, CMO, and Integration Engineer agents.
2. Import one planning skill and one frontend review skill into a test company and validate behavior.
3. Review provider-specific integration skills one provider at a time, starting with Stripe.
4. Add performance and release-quality skill sourcing as the next gap-closure track.
