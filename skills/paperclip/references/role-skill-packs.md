# Role Skill Packs

Use this reference when the board, CEO, or manager asks which skills should support each role, or when you need to assess whether the current org has enough skill coverage.

## Safe Bundled Skills

These Paperclip skills ship in the repo and are safe markdown-only defaults for local adapters:

- `paperclip`
- `paperclip-create-agent`
- `para-memory-files`
- `paperclip-product-scope`
- `paperclip-frontend-experience`
- `paperclip-backend-api-security`
- `paperclip-integration-engineer`
- `paperclip-go-to-market`

## Role Mapping

### CEO

- Core: `paperclip`, `paperclip-create-agent`, `para-memory-files`, `paperclip-product-scope`
- Optional vetted imports: `openai/skills/create-plan`

### CTO

- Core: `paperclip`, `paperclip-product-scope`, `paperclip-backend-api-security`, `paperclip-integration-engineer`
- Optional vetted imports: `getsentry/skills/security-review`, `trailofbits/skills/differential-review`, `supabase/agent-skills/supabase-postgres-best-practices`, `openai/skills/security-ownership-map`, `openai/skills/create-plan`

### Engineer

- Core: `paperclip`, `paperclip-frontend-experience`, `paperclip-backend-api-security`, `paperclip-integration-engineer`
- Optional vetted imports: `vercel-labs/agent-skills/web-design-guidelines`, `vercel-labs/agent-browser/agent-browser`, `getsentry/skills/security-review`, `supabase/agent-skills/supabase-postgres-best-practices`

### Integration Engineer

- Core: `paperclip`, `paperclip-integration-engineer`, `paperclip-backend-api-security`, `paperclip-product-scope`
- Optional vetted imports: Stripe- or CRM-specific best-practice skills after manual review

### Designer

- Core: `paperclip`, `paperclip-frontend-experience`, `paperclip-product-scope`
- Optional vetted imports: `vercel-labs/agent-skills/web-design-guidelines`, `google-labs-code/stitch-skills/design-md`

### PM

- Core: `paperclip`, `paperclip-product-scope`, `para-memory-files`
- Optional vetted imports: `openai/skills/create-plan`, `refoundai/lenny-skills/scoping-cutting`

### QA

- Core: `paperclip`, `paperclip-frontend-experience`, `paperclip-backend-api-security`
- Optional vetted imports: `vercel-labs/agent-browser/agent-browser`, `vercel-labs/agent-skills/web-design-guidelines`, `getsentry/skills/security-review`

### CMO / Growth

- Core: `paperclip`, `paperclip-go-to-market`, `paperclip-product-scope`
- Optional vetted imports: `refoundai/lenny-skills/launch-marketing`, `refoundai/lenny-skills/scoping-cutting`

### Researcher

- Core: `paperclip`, `para-memory-files`, `paperclip-product-scope`

## Security Gate

Before recommending or installing external skills, inspect:

- trust level: prefer markdown-only skills first
- required tools: browser automation, MCP servers, scripts, and remote fetches increase risk
- source provenance: official org or well-maintained repo beats anonymous one-off repos
- operational blast radius: auth state, secrets, filesystem access, and network automation need approval

Do not auto-install risky external skills without the board's approval.
