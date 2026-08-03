import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type ResearchPortfolioPromotionDecision = {
  schema_version: "paperclip.research_portfolio_promotion_decision.v1";
  disposition: "research_only" | "no_go";
  winner_count: 0 | 1;
  winner_lane_id: string | null;
  reasons: string[];
  non_compensating_gates_complete: boolean;
};

export const researchPortfolioPromotionDecisions = pgTable(
  "research_portfolio_promotion_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    portfolioRunId: text("portfolio_run_id").notNull(),
    portfolioArtifactPath: text("portfolio_artifact_path").notNull(),
    portfolioSha256: text("portfolio_sha256").notNull(),
    inputHash: text("input_hash").notNull(),
    decisionSchemaVersion: text("decision_schema_version").notNull(),
    decisionHash: text("decision_hash").notNull(),
    decision: jsonb("decision").$type<ResearchPortfolioPromotionDecision>().notNull(),
    disposition: text("disposition").notNull(),
    winnerCount: integer("winner_count").notNull(),
    winnerLaneId: text("winner_lane_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityCk: check(
      "research_portfolio_promotion_decisions_identity_ck",
      sql`length(btrim(${table.portfolioRunId})) between 1 and 200 and ${table.portfolioRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'`,
    ),
    artifactPathCk: check(
      "research_portfolio_promotion_decisions_artifact_path_ck",
      sql`${table.portfolioArtifactPath} like '/%' and ${table.portfolioArtifactPath} not like '%/../%'`,
    ),
    hashCk: check(
      "research_portfolio_promotion_decisions_hash_ck",
      sql`${table.portfolioSha256} ~ '^[0-9a-f]{64}$' and ${table.inputHash} ~ '^[0-9a-f]{64}$' and ${table.decisionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    schemaCk: check(
      "research_portfolio_promotion_decisions_schema_ck",
      sql`${table.decisionSchemaVersion} = 'paperclip.research_portfolio_promotion_decision.v1'`,
    ),
    dispositionCk: check(
      "research_portfolio_promotion_decisions_disposition_ck",
      sql`${table.disposition} in ('research_only','no_go')`,
    ),
    winnerCk: check(
      "research_portfolio_promotion_decisions_winner_ck",
      sql`(${table.winnerCount} = 0 and ${table.winnerLaneId} is null) or (${table.winnerCount} = 1 and length(btrim(${table.winnerLaneId})) > 0)`,
    ),
    companyRunUq: uniqueIndex("research_portfolio_promotion_decisions_company_run_uq").on(
      table.companyId,
      table.portfolioRunId,
    ),
    companyInputUq: uniqueIndex("research_portfolio_promotion_decisions_company_input_uq").on(
      table.companyId,
      table.inputHash,
    ),
  }),
);
