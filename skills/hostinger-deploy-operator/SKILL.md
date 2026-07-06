---
name: hostinger-deploy-operator
description: >
  Provision, inspect, and harden Hostinger VPS deployment targets for Paperclip
  ventures. Use when a task needs a Hostinger VM ID, firewall ID, private
  endpoint allowlist, Docker deployment target, or deployment receipt.
---

# Hostinger Deploy Operator

This skill owns the Hostinger deployment path for Paperclip ventures. The job is
to produce a working, private-by-default deployment target and deployment
receipts, not just notes about deployment.

## Required Inputs

- `HOSTINGER_API_KEY_FILE` points to the local API key file. Default:
  `/Users/mnm/Documents/Github/hosty.txt`.
- `HOSTINGER_ALLOWED_CLIENT_IP` is the single public client IP or CIDR allowed to
  reach the deployed endpoint.
- `HOSTINGER_VM_ID` and `HOSTINGER_FIREWALL_ID` are optional at the start; this
  skill is responsible for finding or creating them when the Hostinger account
  and permissions allow it.

Never print, paste, commit, or copy the API key value. Read it only from
`HOSTINGER_API_KEY_FILE`.

## Operating Modes

Use the least destructive mode that can produce cake:

1. **Inventory**: list visible VPS instances and firewalls, identify existing
   usable targets, and report exact IDs.
2. **Configure**: create or update firewall rules, activate/sync the firewall,
   and write IDs back into the issue or company deployment contract.
3. **Provision**: purchase/setup a new VPS only when the issue explicitly asks
   for new infrastructure or the board has approved spending.
4. **Deploy**: run Docker/Compose deployment to the Hostinger target and verify
   health from the allowed network.

## Hostinger API Endpoints

Use `https://developers.hostinger.com` as the base.

- VPS inventory: `GET /api/vps/v1/virtual-machines`
- VPS create/purchase: `POST /api/vps/v1/virtual-machines`
- VPS setup purchased instance: `POST /api/vps/v1/virtual-machines/{virtualMachineId}/setup`
- VPS details: `GET /api/vps/v1/virtual-machines/{virtualMachineId}`
- Templates: `GET /api/vps/v1/templates`
- Public keys: `GET /api/vps/v1/public-keys`, `POST /api/vps/v1/public-keys`,
  `POST /api/vps/v1/public-keys/attach/{virtualMachineId}`
- Firewall list: `GET /api/vps/v1/firewall`
- Firewall create: `POST /api/vps/v1/firewall`
- Firewall details: `GET /api/vps/v1/firewall/{firewallId}`
- Firewall rule create/update/delete:
  `POST /api/vps/v1/firewall/{firewallId}/rules`,
  `PUT /api/vps/v1/firewall/{firewallId}/rules/{ruleId}`,
  `DELETE /api/vps/v1/firewall/{firewallId}/rules/{ruleId}`
- Firewall activate/sync:
  `POST /api/vps/v1/firewall/{firewallId}/activate/{virtualMachineId}`,
  `POST /api/vps/v1/firewall/{firewallId}/sync/{virtualMachineId}`
- Actions: `GET /api/vps/v1/virtual-machines/{virtualMachineId}/actions`

## Private Endpoint Rules

- The firewall must deny inbound traffic by default.
- Add allow rules only for required service ports from
  `HOSTINGER_ALLOWED_CLIENT_IP`.
- Add SSH access only if the deployment path needs it, and restrict SSH to the
  same allowed IP.
- After any firewall rule change, activate or sync the firewall to the VM and
  record the action ID or response receipt.

## Deployment Receipts

Every completed task must leave these receipts in the issue comment or issue
document:

- Hostinger VM ID and firewall ID.
- VPS public IP/hostname, with secret values redacted.
- Current allowed client IP/CIDR.
- Firewall rule inventory for the exposed ports.
- Firewall activate/sync receipt.
- Deployment command or Hostinger action used.
- Health check command and result from the allowed network.
- Rollback command or recovery path.

If the account cannot list or create VPS/firewall resources, block the issue
with the exact HTTP status and endpoint, then assign it to the board. Do not
spend model tokens retrying an authorization failure.
