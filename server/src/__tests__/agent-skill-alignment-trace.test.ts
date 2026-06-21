import { describe, expect, it } from "vitest";
import { buildAgentTrace } from "../ops/agent-skill-alignment-trace.js";

const company = {
  id: "company-1",
  name: "Factory Co",
  issue_prefix: "FAC",
};

const skills = [
  { id: "skill-paperclip", company_id: "company-1", key: "paperclipai/paperclip/paperclip", slug: "paperclip", name: "Paperclip", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-product", company_id: "company-1", key: "paperclipai/paperclip/paperclip-product-scope", slug: "paperclip-product-scope", name: "Product Scope", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-gtm", company_id: "company-1", key: "paperclipai/paperclip/paperclip-go-to-market", slug: "paperclip-go-to-market", name: "Go To Market", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-memory", company_id: "company-1", key: "paperclipai/paperclip/para-memory-files", slug: "para-memory-files", name: "Memory", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-distribution", company_id: "company-1", key: "local/distribution-spine", slug: "distribution-spine", name: "Distribution Spine", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-launch", company_id: "company-1", key: "local/product-launch", slug: "product-launch", name: "Product Launch", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-analytics", company_id: "company-1", key: "local/analytics-tracking", slug: "analytics-tracking", name: "Analytics", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
  { id: "skill-long-form", company_id: "company-1", key: "local/long-form-sales-letter", slug: "long-form-sales-letter", name: "Long Form Sales Letter", source_type: "local", trust_level: "trusted", compatibility: "runtime" },
];

function agent(overrides: Record<string, unknown>) {
  return {
    id: "agent-1",
    company_id: "company-1",
    name: "CMO",
    role: "cmo",
    title: null,
    status: "active",
    adapter_type: "hermes_local",
    adapter_config: {},
    runtime_config: {},
    last_heartbeat_at: null,
    ...overrides,
  };
}

describe("agent skill alignment trace", () => {
  it("prunes CMO context-only desired skills while preserving task-scoped eligibility", () => {
    const trace = buildAgentTrace(company, skills, agent({
      adapter_config: {
        paperclipSkillSync: {
          desiredSkills: [
            "paperclipai/paperclip/paperclip",
            "paperclipai/paperclip/paperclip-go-to-market",
            "paperclipai/paperclip/paperclip-product-scope",
            "paperclipai/paperclip/para-memory-files",
            "local/long-form-sales-letter",
          ],
        },
      },
    }) as never);

    expect(trace.prunedContextOnlyDesiredSkills).toEqual(["local/long-form-sales-letter"]);
    expect(trace.afterRepairDesiredSkills).not.toContain("local/long-form-sales-letter");
    expect(trace.eligibleOptionalSkills).toContain("local/long-form-sales-letter");
    expect(trace.simulatedSelection.selected).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/paperclip-product-scope",
    ]));
    expect(trace.simulatedSelection.selected).not.toContain("local/long-form-sales-letter");
  });

  it("surfaces Growth and Distribution skills even when persistent desiredSkills is sparse", () => {
    const trace = buildAgentTrace(company, skills, agent({
      id: "agent-growth",
      name: "Growth/Distribution",
      adapter_config: {
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
      },
    }) as never);

    expect(trace.missingRoleSkills).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/paperclip-product-scope",
    ]));
    expect(trace.afterRepairDesiredSkills).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip-go-to-market",
      "paperclipai/paperclip/paperclip-product-scope",
    ]));
    expect(trace.simulatedSelection.selected).toEqual(expect.arrayContaining([
      "local/distribution-spine",
      "local/product-launch",
      "local/analytics-tracking",
    ]));
  });
});
