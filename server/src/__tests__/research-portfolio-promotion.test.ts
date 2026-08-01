import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  researchPortfolioPromotionDecisions,
  type ResearchPortfolioPromotionDecision,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ResearchPortfolioPromotionError,
  researchPortfolioPromotionService,
} from "../services/research-portfolio-promotion.js";
import {
  deriveResearchPortfolioPromotionDecision,
  parseResearchPortfolioPromotionArgs,
  runResearchPortfolioPromotion,
} from "../ops/research-portfolio-promotion.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("research portfolio promotion idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-research-promotion-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(researchPortfolioPromotionDecisions);
    await db.delete(companies);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: "Promotion canary",
      issuePrefix: `R${randomUUID().replaceAll("-", "").slice(0, 7)}`,
    }).returning();
    return company!;
  }

  function decision(overrides: Partial<ResearchPortfolioPromotionDecision> = {}): ResearchPortfolioPromotionDecision {
    return {
      schema_version: "paperclip.research_portfolio_promotion_decision.v1",
      disposition: "research_only",
      winner_count: 0,
      winner_lane_id: null,
      reasons: ["Evidence remains research-only"],
      non_compensating_gates_complete: false,
      ...overrides,
    };
  }

  it("reuses the exact database decision and rejects divergent replay or duplicate rows", async () => {
    const company = await seedCompany();
    const service = researchPortfolioPromotionService(db);
    const input = {
      companyId: company.id,
      portfolioRunId: "scheduler-canary.portfolio-001",
      portfolioArtifactPath: "/tmp/portfolio-os/scheduler-canary.portfolio-001.json",
      portfolioSha256: "a".repeat(64),
      decision: decision(),
    };

    const first = await service.record(input);
    expect(first.replayed).toBe(false);
    const replay = await service.record(input);
    expect(replay).toMatchObject({
      replayed: true,
      inputHash: first.inputHash,
      decisionHash: first.decisionHash,
    });
    expect(replay.row.id).toBe(first.row.id);
    expect(await db.select().from(researchPortfolioPromotionDecisions)).toHaveLength(1);

    await expect(service.record({
      ...input,
      decision: decision({ reasons: ["Divergent replay"] }),
    })).rejects.toMatchObject<Partial<ResearchPortfolioPromotionError>>({
      code: "research_portfolio_promotion_idempotency_conflict",
    });
    expect(await db.select().from(researchPortfolioPromotionDecisions)).toHaveLength(1);

    await expect(db.insert(researchPortfolioPromotionDecisions).values({
      companyId: company.id,
      portfolioRunId: input.portfolioRunId,
      portfolioArtifactPath: input.portfolioArtifactPath,
      portfolioSha256: "b".repeat(64),
      inputHash: "c".repeat(64),
      decisionSchemaVersion: "paperclip.research_portfolio_promotion_decision.v1",
      decisionHash: "d".repeat(64),
      decision: decision(),
      disposition: "research_only",
      winnerCount: 0,
      winnerLaneId: null,
    })).rejects.toThrow();
  });

  it("fails closed when incomplete gates attempt to select a winner", async () => {
    const company = await seedCompany();
    await expect(researchPortfolioPromotionService(db).record({
      companyId: company.id,
      portfolioRunId: "scheduler-canary.portfolio-002",
      portfolioArtifactPath: "/tmp/portfolio-os/scheduler-canary.portfolio-002.json",
      portfolioSha256: "e".repeat(64),
      decision: decision({
        winner_count: 1,
        winner_lane_id: "lane-exploit-1",
      }),
    })).rejects.toMatchObject<Partial<ResearchPortfolioPromotionError>>({
      code: "research_portfolio_promotion_incomplete_gate_winner",
    });
    expect(await db.select().from(researchPortfolioPromotionDecisions)).toHaveLength(0);
  });

  it("derives a research-only decision and rejects secret-bearing or promotion CLI input", () => {
    const portfolio = {
      schema_version: "pos.research_portfolio.v1",
      portfolio_run_id: "scheduled-research-portfolio-001",
      immutable: true,
      promotion_requested: false,
      disposition: "research_only",
      promoted_lane_id: null,
      lanes: Array.from({ length: 5 }, (_, index) => ({
        lane_id: `lane-v1-exploit-0${index + 1}`,
        outcome: { hard_gate_pass: false, failed_gates: ["demand"] },
      })),
    };

    expect(deriveResearchPortfolioPromotionDecision(portfolio)).toMatchObject({
      disposition: "research_only",
      winner_count: 0,
      winner_lane_id: null,
      non_compensating_gates_complete: false,
    });
    expect(() => deriveResearchPortfolioPromotionDecision({
      ...portfolio,
      disposition: "promote_one",
      promoted_lane_id: "lane-v1-exploit-01",
    })).toThrow("unsupported promotion");
    expect(() => parseResearchPortfolioPromotionArgs([
      "--company-id", randomUUID(),
      "--portfolio", "/tmp/portfolio.json",
      "--receipt", "/tmp/receipt.json",
      "--connection-string", "postgres://operator:secret@localhost/paperclip",
    ])).toThrow("Unknown argument: --connection-string");
  });

  it("records and replays one immutable database decision with duplicate absence", async () => {
    const company = await seedCompany();
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-research-promotion-operator-"));
    tempRoots.push(root);
    const portfolioPath = path.join(root, "portfolio.json");
    const portfolio = {
      schema_version: "pos.research_portfolio.v1",
      portfolio_run_id: "scheduled-research-portfolio-operator-001",
      immutable: true,
      promotion_requested: false,
      disposition: "no_go",
      promoted_lane_id: null,
      lanes: Array.from({ length: 5 }, (_, index) => ({
        lane_id: `lane-v1-exploit-0${index + 1}`,
        outcome: { hard_gate_pass: false, failed_gates: ["demand", "unit_economics"] },
      })),
    };
    await writeFile(portfolioPath, `${JSON.stringify(portfolio, null, 2)}\n`, { mode: 0o444 });
    await chmod(portfolioPath, 0o444);
    const baseOptions = {
      companyId: company.id,
      portfolioPath,
      homeDir: root,
      instanceId: "fixture",
      connectionString: tempDb!.connectionString,
    };

    const first = await runResearchPortfolioPromotion({
      ...baseOptions,
      receiptPath: path.join(root, "promotion-first.json"),
    });
    const replay = await runResearchPortfolioPromotion({
      ...baseOptions,
      receiptPath: path.join(root, "promotion-replay.json"),
    });

    expect(first.database).toMatchObject({ replayed: false, matching_row_count: 1, duplicate_rows_absent: true });
    expect(replay.database).toMatchObject({ replayed: true, matching_row_count: 1, duplicate_rows_absent: true });
    expect(replay.database.decision_id).toBe(first.database.decision_id);
    expect(replay.database.decision_hash).toBe(first.database.decision_hash);
    expect(await db.select().from(researchPortfolioPromotionDecisions)).toHaveLength(1);
    const receiptBytes = await readFile(path.join(root, "promotion-replay.json"), "utf8");
    expect(receiptBytes).not.toContain(tempDb!.connectionString);
    expect(receiptBytes).not.toContain("operator:secret");
  });
});
