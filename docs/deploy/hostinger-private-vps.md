---
title: Hostinger Private VPS Deployments
summary: Hostinger-first live deployment path for Paperclip factory runs
---

Paperclip factory deploy lanes default to Hostinger VPS. Fly.io credentials are legacy input: if a routine still asks for `FLY_API_TOKEN`, Paperclip normalizes that blocker into the Hostinger deployment contract.

## Required Hostinger Contract

Deploy, release, and ship lanes require these values before an unattended agent is allowed to spend tokens on deployment work:

| Name | Purpose |
|------|---------|
| `HOSTINGER_API_KEY_FILE` | Local path to the Hostinger API key. The default is `/Users/mnm/Documents/Github/hosty.txt`. |
| `HOSTINGER_VM_ID` | Hostinger VPS virtual machine ID. |
| `HOSTINGER_FIREWALL_ID` | Hostinger firewall ID to update and sync. |
| `HOSTINGER_ALLOWED_CLIENT_IP` | Single client IP/CIDR allowed to reach the deployed endpoint. Use the current network public IP unless an approved VPN/tailnet IP is used. |

The API key itself must not be committed. In this workstation deployment, keep it in `/Users/mnm/Documents/Github/hosty.txt`; Paperclip treats a non-empty file there as satisfying `HOSTINGER_API_KEY_FILE`.

## Hostinger Deploy Operator

Deployment target provisioning is owned by the `Hostinger Deploy Operator` agent
using the bundled `hostinger-deploy-operator` skill. Run this bootstrap whenever
companies are created or deployment ownership looks stale:

```bash
pnpm --filter @paperclipai/server exec tsx src/ops/hostinger-deploy-operator-bootstrap.ts
```

The bootstrap creates or repairs one operator per active company, assigns the
Hostinger skill, points the agent at the company's primary product workspace, and
retargets open Hostinger deployment issues to that operator.

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

For local Paperclip-driven deploys, read the API key from `HOSTINGER_API_KEY_FILE` and do not echo it into logs.

## Failure Behavior

If `HOSTINGER_VM_ID` or `HOSTINGER_FIREWALL_ID` is missing, the routine should
route the deployment target issue to the `Hostinger Deploy Operator`. If the
operator receives a Hostinger 401/403, zero-resource inventory, or an action that
would purchase infrastructure without approval, it must block once with the exact
endpoint/status receipt and assign the issue to the board. It must not keep
waking agents to rediscover the same missing deployment configuration.
