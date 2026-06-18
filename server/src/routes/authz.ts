import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function actorHasCompanyAccess(req: Request, companyId: string) {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") {
    const allowedCompanyIds = new Set(
      [req.actor.companyId, ...(req.actor.companyIds ?? [])]
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    return allowedCompanyIds.has(companyId);
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return (req.actor.companyIds ?? []).includes(companyId);
}

export function assertCompanyAccess(req: Request, companyId: string) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent" && !actorHasCompanyAccess(req, companyId)) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && !actorHasCompanyAccess(req, companyId)) {
    throw forbidden("User does not have access to this company");
  }
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
