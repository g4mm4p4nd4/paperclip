import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES,
  crossCompanyAgentMembershipService,
} from "../services/cross-company-agent-memberships.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-company membership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(seed: string) {
  return `T${seed.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("crossCompanyAgentMembershipService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-memberships-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reconciles configured agent memberships into every non-archived company", async () => {
    const policy = CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES[0];
    const homeCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const archivedCompanyId = randomUUID();

    await db.insert(companies).values([
      { id: homeCompanyId, name: "Portfolio OS", issuePrefix: issuePrefix(homeCompanyId), status: "active" },
      { id: targetCompanyId, name: "Venture", issuePrefix: issuePrefix(targetCompanyId), status: "paused" },
      { id: archivedCompanyId, name: "Archived", issuePrefix: issuePrefix(archivedCompanyId), status: "archived" },
    ]);

    await db.insert(agents).values({
      id: policy.agentId,
      companyId: homeCompanyId,
      name: policy.title,
      role: "pm",
      title: policy.title,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(companyMemberships).values({
      companyId: targetCompanyId,
      principalType: "agent",
      principalId: policy.agentId,
      status: "suspended",
      membershipRole: "old_role",
    });

    const result = await crossCompanyAgentMembershipService(db).ensureForAllCompanies();

    expect(result.companyIds).toEqual(expect.arrayContaining([homeCompanyId, targetCompanyId]));
    expect(result.companyIds).not.toContain(archivedCompanyId);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skippedMissingAgents).toBe(2);

    const rows = await db
      .select({
        companyId: companyMemberships.companyId,
        principalId: companyMemberships.principalId,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, policy.agentId),
          inArray(companyMemberships.companyId, [homeCompanyId, targetCompanyId, archivedCompanyId]),
        ),
      );

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: homeCompanyId,
        principalId: policy.agentId,
        status: "active",
        membershipRole: policy.membershipRole,
      }),
      expect.objectContaining({
        companyId: targetCompanyId,
        principalId: policy.agentId,
        status: "active",
        membershipRole: policy.membershipRole,
      }),
    ]));
    expect(rows.some((row) => row.companyId === archivedCompanyId)).toBe(false);
  });

  it("seeds a single newly created company for the configured agents", async () => {
    const policy = CROSS_COMPANY_AGENT_MEMBERSHIP_POLICIES[0];
    const homeCompanyId = randomUUID();
    const newCompanyId = randomUUID();

    await db.insert(companies).values([
      { id: homeCompanyId, name: "Portfolio OS", issuePrefix: issuePrefix(homeCompanyId) },
      { id: newCompanyId, name: "New Venture", issuePrefix: issuePrefix(newCompanyId) },
    ]);

    await db.insert(agents).values({
      id: policy.agentId,
      companyId: homeCompanyId,
      name: policy.title,
      role: "pm",
      title: policy.title,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await crossCompanyAgentMembershipService(db).ensureForCompany(newCompanyId);

    expect(result).toMatchObject({
      companyIds: [newCompanyId],
      inserted: 1,
      updated: 0,
      skippedMissingAgents: 1,
    });

    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, newCompanyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, policy.agentId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(membership).toMatchObject({
      status: "active",
      membershipRole: policy.membershipRole,
    });
  });
});
