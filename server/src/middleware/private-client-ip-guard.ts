import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";

function normalizeClientIp(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const withoutBrackets = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (withoutBrackets.startsWith("::ffff:")) {
    return withoutBrackets.slice("::ffff:".length);
  }
  return withoutBrackets;
}

function isLoopbackClientIp(ip: string | null): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}

function parseIpv4(value: string): number | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
}

function ipv4CidrContains(cidr: string, ip: string): boolean {
  const [networkRaw, prefixRaw] = cidr.split("/", 2);
  if (!networkRaw || !prefixRaw) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const network = parseIpv4(networkRaw);
  const candidate = parseIpv4(ip);
  if (network === null || candidate === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (network & mask) === (candidate & mask);
}

function normalizeAllowedClientIps(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

function requestClientIp(req: Request): string | null {
  return normalizeClientIp(req.socket.remoteAddress);
}

export function isClientIpAllowed(rawClientIp: string | null | undefined, allowedClientIps: string[]): boolean {
  const clientIp = normalizeClientIp(rawClientIp);
  if (!clientIp) return false;
  if (isLoopbackClientIp(clientIp)) return true;

  for (const allowed of normalizeAllowedClientIps(allowedClientIps)) {
    if (allowed.includes("/")) {
      if (ipv4CidrContains(allowed, clientIp)) return true;
      continue;
    }
    if (normalizeClientIp(allowed) === clientIp.toLowerCase()) return true;
  }

  return false;
}

function blockedClientIpMessage(clientIp: string): string {
  return `Client IP '${clientIp}' is not allowed for this Paperclip instance.`;
}

export function privateClientIpGuard(opts: {
  enabled: boolean;
  allowedClientIps: string[];
}): RequestHandler {
  if (!opts.enabled || opts.allowedClientIps.length === 0) {
    return (_req, _res, next) => next();
  }

  const allowedClientIps = normalizeAllowedClientIps(opts.allowedClientIps);

  return (req, res, next) => {
    const clientIp = requestClientIp(req);
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (isClientIpAllowed(clientIp, allowedClientIps)) {
      next();
      return;
    }

    const error = blockedClientIpMessage(clientIp ?? "unknown");
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
