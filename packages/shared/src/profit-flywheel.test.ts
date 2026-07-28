import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parsePortfolioOsProfitFlywheelContractV2,
  portfolioOsProfitFlywheelContractV2Schema,
} from "./validators/profit-flywheel.js";
import { PROFIT_FLYWHEEL_RUN_STATES, PROFIT_FLYWHEEL_STAGES } from "./types/profit-flywheel.js";

const contractPath = new URL("../../../../portfolio-os/contracts/profit-flywheel.v2.json", import.meta.url);

async function canonicalContract() {
  return JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
}

describe("canonical Profit Flywheel v2 contract", () => {
  it("parses the current cross-language authority and exposes only the canonical nine states", async () => {
    const parsed = parsePortfolioOsProfitFlywheelContractV2(await canonicalContract());
    expect(Object.keys(parsed.stages)).toEqual(PROFIT_FLYWHEEL_STAGES);
    expect(PROFIT_FLYWHEEL_RUN_STATES).toEqual([
      "pending", "running", "retry", "blocked", "degraded", "succeeded", "failed", "cancelled", "safely_skipped",
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/retry_wait|orphaned|failed_terminal|"ready"/);
  });

  it("rejects missing schema binding, authority floor, and max escalation budget", async () => {
    const base = await canonicalContract();
    const missingSchemaBinding = structuredClone(base) as any;
    missingSchemaBinding.provider_policy_binding.required_fields = ["path", "sha256", "schema_version"];
    expect(portfolioOsProfitFlywheelContractV2Schema.safeParse(missingSchemaBinding).success).toBe(false);

    const missingAuthority = structuredClone(base) as any;
    delete missingAuthority.commercial_policy.minimum_authority_signals;
    expect(portfolioOsProfitFlywheelContractV2Schema.safeParse(missingAuthority).success).toBe(false);

    const missingEscalation = structuredClone(base) as any;
    delete missingEscalation.stages.implementation.budgets.max_escalations;
    expect(portfolioOsProfitFlywheelContractV2Schema.safeParse(missingEscalation).success).toBe(false);
  });

  it("rejects unknown legacy and alternate run-state projections", async () => {
    const alternate = structuredClone(await canonicalContract()) as any;
    alternate.stages.implementation.accepts = ["ready"];
    expect(portfolioOsProfitFlywheelContractV2Schema.safeParse(alternate).success).toBe(false);

    const unknown = structuredClone(await canonicalContract()) as any;
    unknown.compatibility.unknown_versions = "accept";
    expect(portfolioOsProfitFlywheelContractV2Schema.safeParse(unknown).success).toBe(false);
  });
});
