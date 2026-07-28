import { describe, expect, it } from "vitest";
import {
  buildLeadForgeQuarantinePlan,
  isExactLeadForgeCompanyName,
  parseFactoryLeadForgeQuarantineArgs,
} from "../ops/factory-leadforge-quarantine.js";

const leadForgeCompany = {
  id: "company-leadforge",
  name: "Portfolio Venture Factory :: Glitch-Cipher-Syndicate/LeadForge",
};

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    trigger_id: "trigger-1",
    routine_id: "routine-1",
    company_id: leadForgeCompany.id,
    company_name: leadForgeCompany.name,
    routine_title: "Recurring reconciler",
    routine_status: "active",
    trigger_kind: "schedule",
    enabled: true,
    cron_expression: "*/15 * * * *",
    timezone: "America/New_York",
    next_run_at: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("LeadForge recurring trigger quarantine", () => {
  it("matches only the exact excluded repository suffix", () => {
    expect(isExactLeadForgeCompanyName(leadForgeCompany.name)).toBe(true);
    expect(isExactLeadForgeCompanyName("Glitch-Cipher-Syndicate/LeadForge")).toBe(true);
    expect(isExactLeadForgeCompanyName("LeadForge")).toBe(false);
    expect(isExactLeadForgeCompanyName("Portfolio :: LeadForge staging")).toBe(false);
    expect(isExactLeadForgeCompanyName("Portfolio :: Glitch-Cipher-Syndicate/LeadForge-copy")).toBe(false);
  });

  it("plans only enabled schedule triggers and preserves every row", () => {
    const plan = buildLeadForgeQuarantinePlan({
      companies: [
        leadForgeCompany,
        { id: "company-other", name: "Portfolio Venture Factory :: owner/other" },
      ],
      triggers: [
        trigger(),
        trigger({ trigger_id: "trigger-disabled", enabled: false }),
        trigger({ trigger_id: "trigger-api", trigger_kind: "api" }),
        trigger({ trigger_id: "trigger-other", company_id: "company-other" }),
      ],
    });
    expect(plan.company_ids).toEqual([leadForgeCompany.id]);
    expect(plan.state).toHaveLength(3);
    expect(plan.candidates.map((entry) => entry.trigger_id)).toEqual(["trigger-1"]);
    expect(plan.changes).toEqual([{
      trigger_id: "trigger-1",
      routine_id: "routine-1",
      company_id: leadForgeCompany.id,
      before: { enabled: true, next_run_at: "2026-07-28T12:00:00.000Z" },
      after: { enabled: false, next_run_at: null },
    }]);
  });

  it("is deterministic regardless of source row order", () => {
    const rows = [trigger({ trigger_id: "b" }), trigger({ trigger_id: "a" })];
    const left = buildLeadForgeQuarantinePlan({
      companies: [leadForgeCompany],
      triggers: rows,
    });
    const right = buildLeadForgeQuarantinePlan({
      companies: [leadForgeCompany],
      triggers: [...rows].reverse(),
    });
    expect(left.state_sha256).toBe(right.state_sha256);
    expect(left.candidates.map((entry) => entry.trigger_id)).toEqual(["a", "b"]);
  });

  it("requires immutable rollback provenance and forbids database URLs in argv", () => {
    expect(() => parseFactoryLeadForgeQuarantineArgs([
      "--receipt-dir", "/tmp/receipts",
      "--rollback-receipt", "/tmp/apply.json",
    ])).toThrow("--rollback-sha256 is required");
    expect(() => parseFactoryLeadForgeQuarantineArgs([
      "--receipt-dir", "/tmp/receipts",
      "--apply",
      "--rollback-receipt", "/tmp/apply.json",
      "--rollback-sha256", "a".repeat(64),
    ])).toThrow("mutually exclusive");
    expect(() => parseFactoryLeadForgeQuarantineArgs([
      "--connection-string", "postgres://secret",
    ])).toThrow("database_url_argv_forbidden");
  });
});
