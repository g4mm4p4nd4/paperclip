import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runTimerBudgetExhaustedCanary } from "../ops/timer-budget-exhausted-canary.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping timer budget exhausted canary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("timer budget exhausted canary", () => {
  const tempDirs = new Set<string>();
  const tempDbs: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>[] = [];

  afterAll(async () => {
    for (const db of tempDbs) {
      await db.cleanup();
    }
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proves the live service skips exhausted timer continuations and cleans up the fixture", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-canary-");
    tempDbs.push(tempDb);
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-budget-canary-home-"));
    tempDirs.add(homeDir);

    const receipt = await runTimerBudgetExhaustedCanary({
      connectionString: tempDb.connectionString,
      homeDir,
      receiptDir: "receipts",
    });

    expect(receipt.status).toBe("pass");
    expect(receipt.observed).toMatchObject({
      runReturned: false,
      adapterCalled: false,
      wakeupStatus: "skipped",
      wakeupReason: "heartbeat.timer_budget_exhausted_requires_handoff",
      issueStatus: "in_progress",
      completedAt: null,
      activeRunsAfter: 0,
    });
    expect(receipt.observed.wakeupPayload).toMatchObject({
      paperclipTimerBudgetExhaustedSkip: {
        reason: "timer_budget_exhausted_requires_explicit_handoff",
        detectorVersion: "paperclip-timer-budget-exhausted.v1",
      },
    });
    expect(receipt.cleanup).toMatchObject({
      attempted: true,
      completed: true,
      error: null,
    });

    const receiptJson = JSON.parse(await readFile(receipt.receiptPath ?? "", "utf8"));
    expect(receiptJson.status).toBe("pass");

    const db = createDb(tempDb.connectionString);
    const companyRows = await db.select().from(companies).where(eq(companies.id, receipt.fixture.companyId));
    const issueRows = await db.select().from(issues).where(eq(issues.id, receipt.fixture.issueId));
    const wakeupRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, receipt.fixture.companyId));
    const runRows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, receipt.fixture.companyId));
    expect(companyRows).toHaveLength(0);
    expect(issueRows).toHaveLength(0);
    expect(wakeupRows).toHaveLength(0);
    expect(runRows).toHaveLength(0);
    const client = (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<unknown> } }).$client;
    await client?.end?.({ timeout: 0 });
  }, 20_000);
});
