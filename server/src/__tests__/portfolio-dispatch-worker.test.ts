import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createPortfolioDispatchIngestWorker } from "../services/portfolio-dispatch.js";
import { logger } from "../middleware/logger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("portfolio dispatch worker retry isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-portfolio-dispatch-worker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
    for (const root of tempRoots) await rm(root, { recursive: true, force: true });
    tempRoots.clear();
  });

  afterAll(async () => tempDb?.cleanup());

  it("quarantines an unchanged failed gate and retries only after its content hash changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-dispatch-worker-retry-"));
    tempRoots.add(root);
    const outboxDir = path.join(root, "outbox");
    const gatePath = path.join(root, "paperclip_dispatch_gate.json");
    await mkdir(outboxDir);
    const companyId = randomUUID();
    const payload = {
      schema_version: "pos.paperclip_dispatch_gate.v1",
      status: "ROUTE_TO_EXISTING_VENTURE",
      route_type: "feature_delta",
      request_type: "feature_delta",
      route_backlog_only: false,
      approved_by: "board",
      source_request_path: "/authority/feature-delta.json",
      affected_workflow: "profit flywheel worker retry",
      existing_venture_insufficient_reason: "A fresh immutable request requires execution.",
      existing_company_id: companyId,
      existing_project_id: "",
      repo: "fixture/unchanged-gate",
      recommended_owner: "Venture Factory Liaison",
      internet_pipes_readiness: "factory_ready",
      internet_pipes_missing_stations: [],
      internet_pipes_recommendations: [],
    };
    await writeFile(gatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const ledgerPath = path.join(root, "dispatch-ledger.json");
    const worker = createPortfolioDispatchIngestWorker(db, { outboxDir, gatePath, ledgerPath, pollIntervalMs: 15_000 });

    await expect(worker.tickOnce()).resolves.toEqual([]);
    expect(await db.select().from(issues)).toHaveLength(0);

    await db.insert(companies).values({
      id: companyId,
      name: "Unchanged gate tenant",
      issuePrefix: `UG${companyId.replaceAll("-", "").slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await expect(worker.tickOnce()).resolves.toEqual([]);
    await writeFile(gatePath, `${JSON.stringify({ ...payload, affected_workflow: "profit flywheel worker retry authorized resume" }, null, 2)}\n`, "utf8");
    await expect(worker.tickOnce()).resolves.toEqual([
      expect.objectContaining({ status: "created", companyId }),
    ]);
    const persisted = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      originKind: "portfolio_existing_venture_gate",
      status: "todo",
    });

    await expect(worker.tickOnce()).resolves.toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });

  it("does not cache an unchanged malformed dispatch as successfully processed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-dispatch-worker-malformed-"));
    tempRoots.add(root);
    const outboxDir = path.join(root, "outbox");
    await mkdir(outboxDir);
    const dispatchPath = path.join(outboxDir, "dispatch_poison.json");
    await writeFile(dispatchPath, "{\"schema_version\":", "utf8");
    const childLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const childSpy = vi.spyOn(logger, "child").mockReturnValue(childLog as any);
    try {
      const worker = createPortfolioDispatchIngestWorker(db, {
        outboxDir,
        gatePath: path.join(root, "missing-gate.json"),
        ledgerPath: path.join(root, "dispatch-ledger.json"),
        pollIntervalMs: 15_000,
      });
      await expect(worker.tickOnce()).resolves.toEqual([]);
      await expect(worker.tickOnce()).resolves.toEqual([]);
      const restarted = createPortfolioDispatchIngestWorker(db, {
        outboxDir,
        gatePath: path.join(root, "missing-gate.json"),
        ledgerPath: path.join(root, "dispatch-ledger.json"),
        pollIntervalMs: 15_000,
      });
      await expect(restarted.tickOnce()).resolves.toEqual([]);
      expect(childLog.error.mock.calls.filter((call) => call[1] === "portfolio dispatch ingest failed"))
        .toHaveLength(1);
      await writeFile(dispatchPath, "{\"schema_version\": ", "utf8");
      await expect(restarted.tickOnce()).resolves.toEqual([]);
      expect(childLog.error.mock.calls.filter((call) => call[1] === "portfolio dispatch ingest failed"))
        .toHaveLength(2);
    } finally {
      childSpy.mockRestore();
    }
  });
});
