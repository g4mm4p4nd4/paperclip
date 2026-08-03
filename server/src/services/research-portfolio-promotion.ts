import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  researchPortfolioPromotionDecisions,
  type Db,
  type ResearchPortfolioPromotionDecision,
} from "@paperclipai/db";
import { hashProfitFlywheelValue } from "./profit-flywheel.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DECISION_SCHEMA_VERSION = "paperclip.research_portfolio_promotion_decision.v1" as const;

export class ResearchPortfolioPromotionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ResearchPortfolioPromotionError";
  }
}

export type RecordResearchPortfolioPromotionInput = {
  companyId: string;
  portfolioRunId: string;
  portfolioArtifactPath: string;
  portfolioSha256: string;
  decision: ResearchPortfolioPromotionDecision;
};

function fail(code: string, message: string): never {
  throw new ResearchPortfolioPromotionError(code, message);
}

function validateInput(input: RecordResearchPortfolioPromotionInput) {
  if (!SAFE_ID_RE.test(input.portfolioRunId) || input.portfolioRunId.length > 200) {
    fail("research_portfolio_promotion_run_id_invalid", "Portfolio run id is invalid");
  }
  if (!path.isAbsolute(input.portfolioArtifactPath) || path.resolve(input.portfolioArtifactPath) !== input.portfolioArtifactPath) {
    fail("research_portfolio_promotion_artifact_path_invalid", "Portfolio artifact path must be canonical and absolute");
  }
  if (!SHA256_RE.test(input.portfolioSha256)) {
    fail("research_portfolio_promotion_portfolio_hash_invalid", "Portfolio artifact hash is invalid");
  }
  const decision = input.decision;
  if (decision.schema_version !== DECISION_SCHEMA_VERSION) {
    fail("research_portfolio_promotion_schema_invalid", "Promotion decision schema is invalid");
  }
  if (decision.disposition !== "research_only" && decision.disposition !== "no_go") {
    fail("research_portfolio_promotion_disposition_invalid", "Promotion decision must remain research_only or no_go");
  }
  if (decision.winner_count !== 0 && decision.winner_count !== 1) {
    fail("research_portfolio_promotion_winner_count_invalid", "Promotion decision may contain at most one winner");
  }
  if ((decision.winner_count === 0) !== (decision.winner_lane_id === null)) {
    fail("research_portfolio_promotion_winner_binding_invalid", "Winner count and lane id do not agree");
  }
  if (decision.winner_lane_id != null && (!SAFE_ID_RE.test(decision.winner_lane_id) || decision.winner_lane_id.length > 200)) {
    fail("research_portfolio_promotion_winner_lane_invalid", "Winner lane id is invalid");
  }
  if (!Array.isArray(decision.reasons) || decision.reasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
    fail("research_portfolio_promotion_reasons_invalid", "Promotion decision reasons are invalid");
  }
  if (!decision.non_compensating_gates_complete && decision.winner_count !== 0) {
    fail("research_portfolio_promotion_incomplete_gate_winner", "Incomplete non-compensating gates require zero winners");
  }
  if (decision.disposition === "no_go" && decision.winner_count !== 0) {
    fail("research_portfolio_promotion_no_go_winner", "A no-go decision cannot select a winner");
  }
}

export function researchPortfolioPromotionService(db: Db) {
  return {
    record: async (input: RecordResearchPortfolioPromotionInput) => {
      validateInput(input);
      const inputHash = hashProfitFlywheelValue({
        schema_version: "paperclip.research_portfolio_promotion_input.v1",
        company_id: input.companyId,
        portfolio_run_id: input.portfolioRunId,
        portfolio_artifact_path: input.portfolioArtifactPath,
        portfolio_sha256: input.portfolioSha256,
      });
      const decisionHash = hashProfitFlywheelValue({
        schema_version: DECISION_SCHEMA_VERSION,
        input_hash: inputHash,
        decision: input.decision,
      });

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [created] = await tx
          .insert(researchPortfolioPromotionDecisions)
          .values({
            companyId: input.companyId,
            portfolioRunId: input.portfolioRunId,
            portfolioArtifactPath: input.portfolioArtifactPath,
            portfolioSha256: input.portfolioSha256,
            inputHash,
            decisionSchemaVersion: DECISION_SCHEMA_VERSION,
            decisionHash,
            decision: input.decision,
            disposition: input.decision.disposition,
            winnerCount: input.decision.winner_count,
            winnerLaneId: input.decision.winner_lane_id,
          })
          .onConflictDoNothing({
            target: [
              researchPortfolioPromotionDecisions.companyId,
              researchPortfolioPromotionDecisions.portfolioRunId,
            ],
          })
          .returning();
        if (created) return { row: created, replayed: false, inputHash, decisionHash };

        const existing = await tx
          .select()
          .from(researchPortfolioPromotionDecisions)
          .where(and(
            eq(researchPortfolioPromotionDecisions.companyId, input.companyId),
            eq(researchPortfolioPromotionDecisions.portfolioRunId, input.portfolioRunId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!existing) {
          fail("research_portfolio_promotion_conflict_unresolved", "Promotion insert conflicted without an existing run decision");
        }
        if (
          existing.inputHash !== inputHash ||
          existing.decisionHash !== decisionHash ||
          existing.portfolioSha256 !== input.portfolioSha256 ||
          existing.portfolioArtifactPath !== input.portfolioArtifactPath
        ) {
          fail("research_portfolio_promotion_idempotency_conflict", "Portfolio run already has a different immutable promotion decision");
        }
        return { row: existing, replayed: true, inputHash, decisionHash };
      });
    },
  };
}
