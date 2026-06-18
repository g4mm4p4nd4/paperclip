import { describe, expect, it } from "vitest";
import { actorHasCompanyAccess, assertCompanyAccess } from "../routes/authz.js";

function requestWithActor(actor: Express.Request["actor"]) {
  return { actor } as Express.Request;
}

describe("company access authorization", () => {
  it("allows agent access through active membership company ids", () => {
    const req = requestWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "home-company",
      companyIds: ["home-company", "target-company"],
      source: "agent_key",
    });

    expect(actorHasCompanyAccess(req, "target-company")).toBe(true);
    expect(() => assertCompanyAccess(req, "target-company")).not.toThrow();
  });

  it("keeps denying agent access outside the home company and membership set", () => {
    const req = requestWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "home-company",
      companyIds: ["home-company"],
      source: "agent_key",
    });

    expect(actorHasCompanyAccess(req, "other-company")).toBe(false);
    expect(() => assertCompanyAccess(req, "other-company")).toThrow("Agent key cannot access another company");
  });
});
