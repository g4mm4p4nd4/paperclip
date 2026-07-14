import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { approvalService } from "../services/approvals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("launch execution approval business-key idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-launch-approval-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Launch approval ${companyId.slice(0, 6)}`,
      issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  function request(payload: Record<string, unknown>) {
    return approvalService(db).upsertLaunchExecution(companyId, {
      type: "launch_execution",
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload,
    });
  }

  it("merges an exact v2 run/hash replay into its canonical approval", async () => {
    await seedCompany();
    const first = await request({
      target_repo_full_name: "fixture/profit-canary",
      run_id: "v2-run",
      dispatch_hash: "d".repeat(64),
      selection_snapshot_hash: "s".repeat(64),
    });
    const second = await request({
      target_repo_full_name: "fixture/profit-canary",
      run_id: "v2-run",
      dispatch_hash: "d".repeat(64),
      selection_snapshot_hash: "s".repeat(64),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.approval.payload).toMatchObject({
      target_repo_full_name: "fixture/profit-canary",
      run_id: "v2-run",
      launch_execution_merge_state: "canonical",
    });
    expect(second.approval.payload.merged_launch_execution_requests).toEqual([
      expect.objectContaining({
        repo: "fixture/profit-canary",
        run_id: "v2-run",
        payload: expect.objectContaining({
          target_repo_full_name: "fixture/profit-canary",
          dispatch_hash: "d".repeat(64),
          selection_snapshot_hash: "s".repeat(64),
        }),
      }),
    ]);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("serializes concurrent v2 creates into one canonical approval", async () => {
    await seedCompany();
    const [left, right] = await Promise.all([
      request({
        target_repo_full_name: "fixture/profit-canary",
        run_id: "concurrent-run",
        dispatch_hash: "a".repeat(64),
        selection_snapshot_hash: "s".repeat(64),
      }),
      request({
        target_repo_full_name: "fixture/profit-canary",
        run_id: "concurrent-run",
        dispatch_hash: "a".repeat(64),
        selection_snapshot_hash: "s".repeat(64),
      }),
    ]);

    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.approval.id).toBe(right.approval.id);
    expect(await db.select().from(approvals)).toHaveLength(1);
  });

  it("keeps different v2 runs for the same target repository independent", async () => {
    await seedCompany();
    const left = await request({
      target_repo_full_name: "fixture/profit-canary",
      run_id: "left",
      dispatch_hash: "a".repeat(64),
      selection_snapshot_hash: "s".repeat(64),
    });
    const right = await request({
      target_repo_full_name: "fixture/profit-canary",
      run_id: "right",
      dispatch_hash: "b".repeat(64),
      selection_snapshot_hash: "t".repeat(64),
    });

    expect(left.created).toBe(true);
    expect(right.created).toBe(true);
    expect(right.approval.id).not.toBe(left.approval.id);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(2);
  });
});
