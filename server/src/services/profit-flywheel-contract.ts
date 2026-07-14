import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePortfolioOsProfitFlywheelContractV2,
  type PortfolioOsProfitFlywheelContractV2,
} from "@paperclipai/shared";

const DEFAULT_CONTRACT_PATH = fileURLToPath(
  new URL("../../../../portfolio-os/contracts/profit-flywheel.v2.json", import.meta.url),
);

export const PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256 =
  "9222ed478724c230731ebcced6809ff6b4a4bb7dc934fddb2882ae7c92501723";
export const PINNED_PROFIT_FLYWHEEL_SCHEMA_SHA256 =
  "6ac1af81be0de807f51dbba786b73897f114244c1616abee5b3f41a6dbfac09b";
export const PINNED_PROFIT_FLYWHEEL_RUN_SCHEMA_SHA256 =
  "ba26611e26941535a29e7faf431e04da3fd05367b2d93e6b8398bebc73872481";
export const PINNED_POS_DISPATCH_SCHEMA_SHA256 =
  "1e9a0f8bc76a0d0f3e54c4144ccfadc9907daf59a815480711497188f05340a6";
export const PINNED_POS_LEARNING_SCHEMA_SHA256 =
  "e63c3700eae9baa2d75b31d2a222cc7df474d8fbb72165ecddf03d9211ecf267";
export const PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256 =
  "8ff5e8b0cad03f4639db23cb994353542493cb6ad3a4c041311b2b374b2bbed7";
export const PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256 =
  "88faae2962f76f4bf2bfce022cf25b14d9891e836a2b68cea533b3d749f111f4";
export const PINNED_STAGE_WORK_RESULT_SCHEMA_SHA256 =
  "beff2e8e4d31413329a73e6891d1c9104e004a2a4e621192d39845ff08019fba";
export const PINNED_STAGE_EXECUTION_SCHEMA_SHA256 =
  "fb080707e7d65bb17664e494dea765fa4c7018c42a9317d188da8da6be03b6b2";
export const PINNED_TEST_EXECUTION_RESULT_SCHEMA_SHA256 =
  "3896d169ef45baae7c19dba9cfb0bc1d2fee18cbc2018d3c734ef23815f896d2";
export const PINNED_INDEPENDENT_REVIEW_RESULT_SCHEMA_SHA256 =
  "d90769477297810c8536624068fc3af1864d059a6b6d658e9648a0ae53c941af";
export const PINNED_EXECUTION_GOLDEN_VECTORS_SHA256 =
  "4ad38f8e0174f1acd0d370837a6c6cdfc61f3bc7f32b7a63c085b973e66eb272";

const EXECUTION_MIRROR_ROOT = fileURLToPath(new URL("../../../contracts/profit-flywheel/", import.meta.url));

export type LoadedProfitFlywheelContract = {
  contract: PortfolioOsProfitFlywheelContractV2;
  path: string;
  sha256: string;
  schemaPath: string;
  schemaSha256: string;
  runSchemaPath: string;
  runSchemaSha256: string;
  dispatchSchemaPath: string;
  dispatchSchemaSha256: string;
  learningSchemaPath: string;
  learningSchemaSha256: string;
  nextResearchAuthoritySchemaPath: string;
  nextResearchAuthoritySchemaSha256: string;
  researchPlanSchemaPath: string;
  researchPlanSchemaSha256: string;
  loadedAt: string;
};

export class ProfitFlywheelContractError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProfitFlywheelContractError";
    this.code = code;
    this.details = details;
  }
}

export function resolveProfitFlywheelContractPath(env: NodeJS.ProcessEnv = process.env) {
  return path.resolve(env.PAPERCLIP_PROFIT_FLYWHEEL_CONTRACT_PATH ?? DEFAULT_CONTRACT_PATH);
}

export async function loadProfitFlywheelContract(input: {
  path?: string;
  expectedSha256?: string | null;
  expectedSchemaSha256?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<LoadedProfitFlywheelContract> {
  const contractPath = path.resolve(input.path ?? resolveProfitFlywheelContractPath(input.env));
  let raw: string;
  try {
    raw = await readFile(contractPath, "utf8");
  } catch (error) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_contract_unreadable",
      `Unable to read canonical Profit Flywheel contract at ${contractPath}`,
      { contractPath, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const expectedSha256 = (
    input.expectedSha256 ??
    input.env?.PAPERCLIP_PROFIT_FLYWHEEL_CONTRACT_SHA256 ??
    process.env.PAPERCLIP_PROFIT_FLYWHEEL_CONTRACT_SHA256 ??
    PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256
  ).trim().toLowerCase();
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_contract_hash_mismatch",
      "Canonical Profit Flywheel contract hash does not match the approved pin",
      { contractPath, expectedSha256, observedSha256: sha256, nextOwner: "portfolio_os_contract_owner" },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_contract_invalid_json",
      "Canonical Profit Flywheel contract is not valid JSON",
      { contractPath, sha256, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const schemaRef = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).$schema
    : null;
  if (schemaRef !== "./profit-flywheel.v2.schema.json") {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_schema_reference_invalid",
      "Canonical Profit Flywheel contract must reference the approved sibling schema",
      { contractPath, schemaRef },
    );
  }
  const schemaPath = path.resolve(path.dirname(contractPath), schemaRef);
  const schemaRaw = await readFile(schemaPath, "utf8").catch((error) => {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_schema_unreadable",
      `Unable to read canonical Profit Flywheel schema at ${schemaPath}`,
      { schemaPath, cause: error instanceof Error ? error.message : String(error) },
    );
  });
  const schemaSha256 = createHash("sha256").update(schemaRaw).digest("hex");
  const expectedSchemaSha256 = (
    input.expectedSchemaSha256 ??
    input.env?.PAPERCLIP_PROFIT_FLYWHEEL_SCHEMA_SHA256 ??
    process.env.PAPERCLIP_PROFIT_FLYWHEEL_SCHEMA_SHA256 ??
    PINNED_PROFIT_FLYWHEEL_SCHEMA_SHA256
  ).trim().toLowerCase();
  if (expectedSchemaSha256 && schemaSha256 !== expectedSchemaSha256) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_schema_hash_mismatch",
      "Canonical Profit Flywheel schema hash does not match the approved pin",
      { schemaPath, expectedSchemaSha256, observedSchemaSha256: schemaSha256, nextOwner: "portfolio_os_contract_owner" },
    );
  }
  const siblingSchemas = [
    { key: "run", file: "profit-flywheel.run.v2.schema.json", expected: PINNED_PROFIT_FLYWHEEL_RUN_SCHEMA_SHA256 },
    { key: "dispatch", file: "pos.dispatch.v2.schema.json", expected: PINNED_POS_DISPATCH_SCHEMA_SHA256 },
    { key: "learning", file: "pos.learning_receipt.v2.schema.json", expected: PINNED_POS_LEARNING_SCHEMA_SHA256 },
    { key: "next_research_authority", file: "pos.next_research_authorization.v1.schema.json", expected: PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256 },
    { key: "research_plan", file: "paperclip.research_plan.v2.schema.json", expected: PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256 },
    { key: "stage_work_result", file: "stage-work-result.v1.schema.json", expected: PINNED_STAGE_WORK_RESULT_SCHEMA_SHA256, mirror: "stage-work-result.v1.schema.json" },
    { key: "stage_execution", file: "stage-execution.v2.schema.json", expected: PINNED_STAGE_EXECUTION_SCHEMA_SHA256, mirror: "stage-execution.v2.schema.json" },
    { key: "test_execution_result", file: "test-execution-result.v1.schema.json", expected: PINNED_TEST_EXECUTION_RESULT_SCHEMA_SHA256, mirror: "test-execution-result.v1.schema.json" },
    { key: "independent_review_result", file: "independent-review-result.v1.schema.json", expected: PINNED_INDEPENDENT_REVIEW_RESULT_SCHEMA_SHA256, mirror: "independent-review-result.v1.schema.json" },
    { key: "execution_vectors", file: "execution-golden-vectors.v1.json", expected: PINNED_EXECUTION_GOLDEN_VECTORS_SHA256, mirror: "execution-golden-vectors.v1.json" },
  ] as const;
  const verifiedSchemas = await Promise.all(siblingSchemas.map(async ({ key, file, expected, ...authority }) => {
    const siblingPath = path.resolve(path.dirname(contractPath), file);
    const siblingRaw = await readFile(siblingPath).catch((error) => {
      throw new ProfitFlywheelContractError(
        `profit_flywheel_${key}_schema_unreadable`,
        `Unable to read canonical ${key} schema at ${siblingPath}`,
        { path: siblingPath, cause: error instanceof Error ? error.message : String(error) },
      );
    });
    const observed = createHash("sha256").update(siblingRaw).digest("hex");
    if (observed !== expected) {
      throw new ProfitFlywheelContractError(
        `profit_flywheel_${key}_schema_hash_mismatch`,
        `Canonical ${key} schema hash does not match the approved pin`,
        { path: siblingPath, expectedSha256: expected, observedSha256: observed, nextOwner: "portfolio_os_contract_owner" },
      );
    }
    if ("mirror" in authority) {
      const mirrorPath = path.join(EXECUTION_MIRROR_ROOT, authority.mirror);
      const mirrorRaw = await readFile(mirrorPath).catch((error) => {
        throw new ProfitFlywheelContractError(
          `profit_flywheel_${key}_mirror_unreadable`,
          `Paperclip ${key} mirror is unavailable`,
          { path: mirrorPath, cause: error instanceof Error ? error.message : String(error) },
        );
      });
      if (!mirrorRaw.equals(siblingRaw) || createHash("sha256").update(mirrorRaw).digest("hex") !== expected) {
        throw new ProfitFlywheelContractError(
          `profit_flywheel_${key}_mirror_mismatch`,
          `Paperclip ${key} mirror is not byte-identical to the frozen Portfolio OS authority`,
          { canonicalPath: siblingPath, mirrorPath, expectedSha256: expected },
        );
      }
    }
    return { key, path: siblingPath, sha256: observed };
  }));
  const verifiedByKey = {
    run: verifiedSchemas.find((entry) => entry.key === "run")!,
    dispatch: verifiedSchemas.find((entry) => entry.key === "dispatch")!,
    learning: verifiedSchemas.find((entry) => entry.key === "learning")!,
    nextResearchAuthority: verifiedSchemas.find((entry) => entry.key === "next_research_authority")!,
    researchPlan: verifiedSchemas.find((entry) => entry.key === "research_plan")!,
  };
  const contractRecord = parsed as Record<string, unknown>;
  const artifactSchemas = contractRecord.artifact_schemas && typeof contractRecord.artifact_schemas === "object" && !Array.isArray(contractRecord.artifact_schemas)
    ? contractRecord.artifact_schemas as Record<string, unknown>
    : {};
  for (const [key, expectedPath, expectedHash] of [
    ["run_receipt", "contracts/profit-flywheel.run.v2.schema.json", PINNED_PROFIT_FLYWHEEL_RUN_SCHEMA_SHA256],
    ["dispatch", "contracts/pos.dispatch.v2.schema.json", PINNED_POS_DISPATCH_SCHEMA_SHA256],
    ["learning_receipt", "contracts/pos.learning_receipt.v2.schema.json", PINNED_POS_LEARNING_SCHEMA_SHA256],
    ["next_research_authority", "contracts/pos.next_research_authorization.v1.schema.json", PINNED_POS_NEXT_RESEARCH_AUTHORITY_SCHEMA_SHA256],
    ["research_plan", "contracts/paperclip.research_plan.v2.schema.json", PINNED_POS_RESEARCH_PLAN_SCHEMA_SHA256],
    ["stage_work_result", "contracts/stage-work-result.v1.schema.json", PINNED_STAGE_WORK_RESULT_SCHEMA_SHA256],
    ["stage_execution", "contracts/stage-execution.v2.schema.json", PINNED_STAGE_EXECUTION_SCHEMA_SHA256],
    ["test_execution_result", "contracts/test-execution-result.v1.schema.json", PINNED_TEST_EXECUTION_RESULT_SCHEMA_SHA256],
    ["independent_review_result", "contracts/independent-review-result.v1.schema.json", PINNED_INDEPENDENT_REVIEW_RESULT_SCHEMA_SHA256],
  ] as const) {
    const binding = artifactSchemas[key] && typeof artifactSchemas[key] === "object" && !Array.isArray(artifactSchemas[key])
      ? artifactSchemas[key] as Record<string, unknown>
      : {};
    if (binding.path !== expectedPath || binding.sha256 !== expectedHash) {
      throw new ProfitFlywheelContractError(
        "profit_flywheel_artifact_schema_binding_mismatch",
        `Contract ${key} schema binding does not match the frozen artifact`,
        { key, expectedPath, expectedHash, observed: binding },
      );
    }
  }
  const artifactVectors = contractRecord.artifact_vectors && typeof contractRecord.artifact_vectors === "object" && !Array.isArray(contractRecord.artifact_vectors)
    ? contractRecord.artifact_vectors as Record<string, unknown>
    : {};
  const vectorBinding = artifactVectors.execution;
  if (!vectorBinding || typeof vectorBinding !== "object" || Array.isArray(vectorBinding) ||
      (vectorBinding as Record<string, unknown>).path !== "contracts/execution-golden-vectors.v1.json" ||
      (vectorBinding as Record<string, unknown>).sha256 !== PINNED_EXECUTION_GOLDEN_VECTORS_SHA256) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_artifact_vector_binding_mismatch",
      "Contract execution golden-vector binding does not match the frozen artifact",
    );
  }
  try {
    return {
      contract: parsePortfolioOsProfitFlywheelContractV2(parsed),
      path: contractPath,
      sha256,
      schemaPath,
      schemaSha256,
      runSchemaPath: verifiedByKey.run.path,
      runSchemaSha256: verifiedByKey.run.sha256,
      dispatchSchemaPath: verifiedByKey.dispatch.path,
      dispatchSchemaSha256: verifiedByKey.dispatch.sha256,
      learningSchemaPath: verifiedByKey.learning.path,
      learningSchemaSha256: verifiedByKey.learning.sha256,
      nextResearchAuthoritySchemaPath: verifiedByKey.nextResearchAuthority.path,
      nextResearchAuthoritySchemaSha256: verifiedByKey.nextResearchAuthority.sha256,
      researchPlanSchemaPath: verifiedByKey.researchPlan.path,
      researchPlanSchemaSha256: verifiedByKey.researchPlan.sha256,
      loadedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_contract_validation_failed",
      "Canonical Profit Flywheel contract failed Paperclip compatibility validation",
      { contractPath, sha256, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export function migrateLegacyProfitFlywheelArtifact(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfitFlywheelContractError("profit_flywheel_legacy_invalid", "Legacy artifact must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = typeof record.schema_version === "string" ? record.schema_version : null;
  if (schemaVersion !== "pos.dispatch.v1" && schemaVersion !== "pos.selection_snapshot.v1") {
    throw new ProfitFlywheelContractError(
      "profit_flywheel_legacy_unknown_version",
      `Unsupported legacy flywheel artifact version: ${schemaVersion ?? "missing"}`,
      { schemaVersion, nextOwner: "portfolio_os_contract_owner" },
    );
  }
  const runId = typeof record.run_id === "string" ? record.run_id.trim() : "";
  if (!runId) {
    throw new ProfitFlywheelContractError("profit_flywheel_legacy_missing_run_id", "Legacy artifact is missing run_id");
  }
  return {
    sourceSchemaVersion: schemaVersion,
    runId,
    migratedBy: "paperclip.profit_flywheel_legacy_reader.v2",
    immutableSource: value,
  };
}
