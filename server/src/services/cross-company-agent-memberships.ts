import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, companyMemberships } from "@paperclipai/db";

export type CrossCompanyAgentMembershipPolicy = {
  agentId: string;
  title: string;
  membershipRole: string;
};

export const CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES: CrossCompanyAgentMembershipPolicy[] = [
  {
    agentId: "ac1d9767-0ca1-4599-9b33-ef85be8da46a",
    title: "Chief of Staff",
    membershipRole: "chief_of_staff",
  },
  {
    agentId: "7fffe74f-ed90-4025-ac4c-28d27e9f1ed2",
    title: "Venture Factory Liaison",
    membershipRole: "venture_factory_liaison",
  },
];

type ReconcileResult = {
  companyIds: string[];
  policyAgentIds: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  skippedMissingAgents: number;
};

function emptyResult(companyIds: string[]): ReconcileResult {
  return {
    companyIds,
    policyAgentIds: CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES.map((policy) => policy.agentId),
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skippedMissingAgents: 0,
  };
}

function isEligiblePolicyAgent(status: string | null | undefined) {
  return status !== "terminated" && status !== "pending_approval";
}

export function crossCompanyAgentMembershipService(db: Db) {
  async function listEligiblePolicyAgents() {
    const policyAgentIds = CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES.map((policy) => policy.agentId);
    if (policyAgentIds.length === 0) return new Set<string>();

    const rows = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, policyAgentIds));

    return new Set(
      rows
        .filter((row) => isEligiblePolicyAgent(row.status))
        .map((row) => row.id),
    );
  }

  async function ensureForCompany(companyId: string): Promise<ReconcileResult> {
    const company = await db
      .select({ id: companies.id, status: companies.status })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!company || company.status === "archived") {
      return emptyResult([]);
    }

    const result = emptyResult([company.id]);
    const eligibleAgentIds = await listEligiblePolicyAgents();

    for (const policy of CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES) {
      if (!eligibleAgentIds.has(policy.agentId)) {
        result.skippedMissingAgents += 1;
        continue;
      }

      const existing = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "agent"),
            eq(companyMemberships.principalId, policy.agentId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        await db
          .insert(companyMemberships)
          .values({
            companyId: company.id,
            principalType: "agent",
            principalId: policy.agentId,
            status: "active",
            membershipRole: policy.membershipRole,
          })
          .onConflictDoUpdate({
            target: [
              companyMemberships.companyId,
              companyMemberships.principalType,
              companyMemberships.principalId,
            ],
            set: {
              status: "active",
              membershipRole: policy.membershipRole,
              updatedAt: new Date(),
            },
          });
        result.inserted += 1;
        continue;
      }

      if (existing.status !== "active" || existing.membershipRole !== policy.membershipRole) {
        await db
          .update(companyMemberships)
          .set({
            status: "active",
            membershipRole: policy.membershipRole,
            updatedAt: new Date(),
          })
          .where(eq(companyMemberships.id, existing.id));
        result.updated += 1;
        continue;
      }

      result.unchanged += 1;
    }

    return result;
  }

  async function ensureForAllCompanies(): Promise<ReconcileResult> {
    const companyRows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(ne(companies.status, "archived"));

    const total = emptyResult(companyRows.map((company) => company.id));

    for (const company of companyRows) {
      const result = await ensureForCompany(company.id);
      total.inserted += result.inserted;
      total.updated += result.updated;
      total.unchanged += result.unchanged;
      total.skippedMissingAgents += result.skippedMissingAgents;
    }

    return total;
  }

  return {
    ensureForCompany,
    ensureForAllCompanies,
  };
}
