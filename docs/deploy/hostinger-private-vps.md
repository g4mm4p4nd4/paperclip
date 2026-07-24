---
title: Hostinger Private VPS Deployments
summary: Hostinger-first live deployment path for Paperclip factory runs
---

Paperclip factory deploy lanes default to Hostinger VPS. Fly.io credentials are legacy input: if a routine still asks for `FLY_API_TOKEN`, Paperclip normalizes that blocker into the Hostinger deployment contract.

## Required Hostinger Contract

Deploy, release, and ship lanes require these values before an unattended agent is allowed to spend tokens on deployment work:

| Name | Purpose |
|------|---------|
| `HOSTINGER_API_KEY` | Required encrypted company secret containing the Hostinger API key. |
| `HOSTINGER_VM_ID` | Hostinger VPS virtual machine ID. |
| `HOSTINGER_FIREWALL_ID` | Hostinger firewall ID to update and sync. |
| `HOSTINGER_ALLOWED_CLIENT_IP` | Single client IP/CIDR allowed to reach the deployed endpoint. Use the current network public IP unless an approved VPN/tailnet IP is used. |

The API key itself must not be committed or persisted in agent configuration.
Create `HOSTINGER_API_KEY` through Paperclip's encrypted company-secret surface.
`HOSTINGER_API_KEY_FILE` remains available only as an explicitly configured
legacy bridge to a non-empty local file; Paperclip does not search for a key
file or assume a default location.

## Hostinger Deploy Operator

Deployment target provisioning is owned by the `Hostinger Deploy Operator` agent
using the bundled `hostinger-deploy-operator` skill. Run this bootstrap whenever
companies are created or deployment ownership looks stale:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/hostinger-deploy-operator-bootstrap.ts
```

The bootstrap creates or repairs one operator per active company, assigns the
Hostinger skill, points the agent at the company's primary product workspace, and
retargets open Hostinger deployment issues to that operator. The
`hostinger-deploy-operator` skill is written to `paperclipSkillSync.requiredSkills`
as well as `desiredSkills`, so adaptive skill pruning must not remove it from
Hostinger deployment runs.

## Network Rule

The deployed endpoint must be private-by-default:

1. Create or reuse a Hostinger VPS firewall.
2. Add allow rules only for required service ports from `HOSTINGER_ALLOWED_CLIENT_IP`.
3. Keep default inbound policy closed for all other sources.
4. Sync the firewall to `HOSTINGER_VM_ID` after rule changes.
5. Record the deployed URL, VM ID, firewall ID, allowed IP, and verification receipt in the issue or context ledger.

Hostinger's API supports VPS firewall rule creation, firewall activation, firewall sync, and VM listing. Use those APIs or the official Hostinger VPS deploy action when the deployment is driven from CI.

The operator must use inventory/configure mode before provisioning new paid
infrastructure. `POST /api/vps/v1/virtual-machines` purchases/setup VPS capacity,
so use it only when the issue or board approval explicitly authorizes spending.

## CI Shape

For GitHub Actions based deploys, use the official `hostinger/deploy-on-vps` action with:

- `api-key`: `HOSTINGER_API_KEY`
- `virtual-machine`: `HOSTINGER_VM_ID`
- `project-name`: stable Paperclip company/project name
- `docker-compose-path`: the production compose file

For local Paperclip-driven deploys, use the injected `HOSTINGER_API_KEY` and do
not echo it into logs. Use `HOSTINGER_API_KEY_FILE` only when an operator has
explicitly configured that legacy bridge.

## Failure Behavior

If `HOSTINGER_VM_ID` or `HOSTINGER_FIREWALL_ID` is missing, the routine should
route the deployment target issue to the `Hostinger Deploy Operator`. If the
operator receives a Hostinger 401/403, zero-resource inventory, or an action that
would purchase infrastructure without approval, it must block once with the exact
endpoint/status receipt and assign the issue to the board. It must not keep
waking agents to rediscover the same missing deployment configuration.
