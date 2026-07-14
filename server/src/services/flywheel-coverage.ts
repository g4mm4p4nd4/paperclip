import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
  resolveProfitFlywheelContractPath,
} from "./profit-flywheel-contract.js";
import { PINNED_PROVIDER_POLICY_SHA256 } from "./provider-policy.js";

type JsonRecord = Record<string, unknown>;

export type FlywheelCoverageManifest = {
  schema_version: string;
  authority: {
    profit_flywheel_contract: { schema_version: string; sha256: string };
    provider_policy: { schema_version: string; sha256: string };
  };
  stages: JsonRecord[];
  routine_coverage: JsonRecord[];
  tool_receipt_schemas?: JsonRecord[];
};

const FLYWHEEL_COVERAGE_SCHEMA_VERSION = "paperclip.flywheel_coverage.v2";
const DEFAULT_PROVIDER_POLICY_PATH = fileURLToPath(new URL("../../../config/provider-policy.v2.json", import.meta.url));

function repoRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function defaultFlywheelCoverageManifestPath() {
  return path.join(repoRootFromModule(), "config", "flywheel_coverage.json");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonEmptyStringArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  const strings = value.map(nonEmptyString).filter((entry): entry is string => Boolean(entry));
  return strings.length > 0 && strings.length === value.length ? strings : null;
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function exactStringArray(value: unknown, label: string) {
  const parsed = nonEmptyStringArray(value);
  if (!parsed) throw new Error(`flywheel coverage ${label} must be a non-empty string array`);
  return parsed;
}

export function parseFlywheelCoverageManifest(raw: unknown): FlywheelCoverageManifest {
  if (!isRecord(raw)) throw new Error("flywheel coverage manifest must be a JSON object");
  const schemaVersion = nonEmptyString(raw.schema_version);
  if (schemaVersion !== FLYWHEEL_COVERAGE_SCHEMA_VERSION) {
    throw new Error(`flywheel coverage manifest schema_version must be ${FLYWHEEL_COVERAGE_SCHEMA_VERSION}`);
  }
  const authority = isRecord(raw.authority) ? raw.authority : null;
  const contract = authority && isRecord(authority.profit_flywheel_contract)
    ? authority.profit_flywheel_contract
    : null;
  const policy = authority && isRecord(authority.provider_policy) ? authority.provider_policy : null;
  if (!contract || contract.schema_version !== "profit-flywheel.v2" ||
      !/^[a-f0-9]{64}$/.test(String(contract.sha256 ?? "")) ||
      !policy || policy.schema_version !== "provider-policy.v2" ||
      !/^[a-f0-9]{64}$/.test(String(policy.sha256 ?? ""))) {
    throw new Error("flywheel coverage manifest must pin profit-flywheel.v2 and provider-policy.v2 authority");
  }
  if (!Array.isArray(raw.stages) || raw.stages.length === 0 || !raw.stages.every(isRecord)) {
    throw new Error("flywheel coverage manifest must declare non-empty stages");
  }
  if (!Array.isArray(raw.routine_coverage) || raw.routine_coverage.length === 0 || !raw.routine_coverage.every(isRecord)) {
    throw new Error("flywheel coverage manifest must declare non-empty routine_coverage");
  }
  if (raw.tool_receipt_schemas !== undefined &&
      (!Array.isArray(raw.tool_receipt_schemas) || !raw.tool_receipt_schemas.every(isRecord))) {
    throw new Error("flywheel coverage manifest tool_receipt_schemas must be an array when present");
  }
  return {
    schema_version: schemaVersion,
    authority: {
      profit_flywheel_contract: {
        schema_version: String(contract.schema_version),
        sha256: String(contract.sha256),
      },
      provider_policy: { schema_version: String(policy.schema_version), sha256: String(policy.sha256) },
    },
    stages: raw.stages,
    routine_coverage: raw.routine_coverage,
    tool_receipt_schemas: Array.isArray(raw.tool_receipt_schemas) ? raw.tool_receipt_schemas : undefined,
  };
}

export function assertFlywheelCoverageAuthority(input: {
  manifest: FlywheelCoverageManifest;
  contract: unknown;
  contractSha256: string;
  providerPolicy: unknown;
  providerPolicySha256: string;
}) {
  const { manifest } = input;
  if (input.contractSha256 !== PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256 ||
      input.contractSha256 !== manifest.authority.profit_flywheel_contract.sha256) {
    throw new Error("flywheel coverage profit-flywheel.v2 authority hash mismatch");
  }
  if (input.providerPolicySha256 !== PINNED_PROVIDER_POLICY_SHA256 ||
      input.providerPolicySha256 !== manifest.authority.provider_policy.sha256) {
    throw new Error("flywheel coverage provider-policy.v2 authority hash mismatch");
  }
  const contract = isRecord(input.contract) ? input.contract : {};
  const policy = isRecord(input.providerPolicy) ? input.providerPolicy : {};
  if (contract.schema_version !== "profit-flywheel.v2" || policy.schemaVersion !== "provider-policy.v2") {
    throw new Error("flywheel coverage authority schema mismatch");
  }
  const contractStages = isRecord(contract.stages) ? contract.stages : {};
  const policyAliases = isRecord(policy.aliases) ? policy.aliases : {};
  const budgetClasses = isRecord(policy.budgetClasses) ? policy.budgetClasses : {};
  const manifestByStage = new Map<string, JsonRecord>();
  for (const entry of manifest.stages) {
    const stage = nonEmptyString(entry.stage);
    if (!stage || manifestByStage.has(stage)) throw new Error(`flywheel coverage stage is missing or duplicated: ${stage ?? "missing"}`);
    manifestByStage.set(stage, entry);
  }
  const canonicalStageNames = Object.keys(contractStages).sort();
  if (JSON.stringify([...manifestByStage.keys()].sort()) !== JSON.stringify(canonicalStageNames)) {
    throw new Error("flywheel coverage stages must exactly match profit-flywheel.v2");
  }
  for (const stage of canonicalStageNames) {
    const canonical = isRecord(contractStages[stage]) ? contractStages[stage] : {};
    const coverage = manifestByStage.get(stage)!;
    const ownerPlane = nonEmptyString(canonical.owner_plane);
    const capabilityAlias = nonEmptyString(canonical.provider_capability_class);
    if (coverage.owner_plane !== ownerPlane || coverage.provider_capability_alias !== capabilityAlias) {
      throw new Error(`flywheel coverage stage ${stage} owner or provider capability differs from profit-flywheel.v2`);
    }
    if (JSON.stringify(exactStringArray(coverage.receipt_paths, `stage ${stage} receipt_paths`)) !==
        JSON.stringify(exactStringArray(canonical.required_receipts, `canonical stage ${stage} required_receipts`))) {
      throw new Error(`flywheel coverage stage ${stage} receipts differ from profit-flywheel.v2`);
    }
    if (capabilityAlias === "deterministic") {
      if (coverage.budget_class !== null || coverage.expected_max_provider_tokens !== 0) {
        throw new Error(`flywheel coverage deterministic stage ${stage} must have a zero provider budget`);
      }
      continue;
    }
    const aliasCandidate = policyAliases[capabilityAlias!];
    const alias: JsonRecord | null = isRecord(aliasCandidate) ? aliasCandidate : null;
    const budgetClass = alias ? nonEmptyString(alias.budgetClass) : null;
    const budgetCandidate = budgetClass ? budgetClasses[budgetClass] : null;
    const budget: JsonRecord | null = isRecord(budgetCandidate) ? budgetCandidate : null;
    if (!alias || !budget || coverage.budget_class !== budgetClass ||
        coverage.expected_max_provider_tokens !== budget.maxTotalTokens) {
      throw new Error(`flywheel coverage stage ${stage} budget differs from provider-policy.v2`);
    }
  }
  return manifest;
}

export function loadFlywheelCoverageManifest(filePath = process.env.PAPERCLIP_FLYWHEEL_COVERAGE_MANIFEST_PATH ||
  defaultFlywheelCoverageManifestPath()) {
  const manifest = parseFlywheelCoverageManifest(JSON.parse(readFileSync(filePath, "utf8")));
  const contractBytes = readFileSync(resolveProfitFlywheelContractPath());
  const policyPath = path.resolve(process.env.PAPERCLIP_PROVIDER_POLICY_PATH ?? DEFAULT_PROVIDER_POLICY_PATH);
  const policyBytes = readFileSync(policyPath);
  return assertFlywheelCoverageAuthority({
    manifest,
    contract: JSON.parse(contractBytes.toString("utf8")),
    contractSha256: sha256(contractBytes),
    providerPolicy: JSON.parse(policyBytes.toString("utf8")),
    providerPolicySha256: sha256(policyBytes),
  });
}

export function assertRoutineCoverage(routineKeys: string[], manifest = loadFlywheelCoverageManifest()) {
  const stageNames = new Set(manifest.stages.map((stage) => nonEmptyString(stage.stage)).filter((stage): stage is string => Boolean(stage)));
  const seen = new Map<string, JsonRecord>();
  for (const entry of manifest.routine_coverage) {
    const routineKey = nonEmptyString(entry.routine_key);
    if (!routineKey) throw new Error("flywheel coverage manifest routine_coverage entry missing routine_key");
    if (seen.has(routineKey)) throw new Error(`flywheel coverage manifest has duplicate routine_key: ${routineKey}`);
    const stage = nonEmptyString(entry.stage);
    const stageEntry = stage ? manifest.stages.find((candidate) => candidate.stage === stage) : null;
    const ownerPlane = nonEmptyString(entry.owner_plane);
    const providerPolicy = nonEmptyString(entry.provider_policy);
    const passFailRule = nonEmptyString(entry.pass_fail_rule);
    const requiredReceipts = nonEmptyStringArray(entry.required_receipts);
    if (!stage || !stageNames.has(stage)) throw new Error(`flywheel coverage manifest routine ${routineKey} references unknown stage: ${stage ?? "missing"}`);
    if (!ownerPlane || ownerPlane !== stageEntry?.owner_plane) throw new Error(`flywheel coverage manifest routine ${routineKey} owner_plane differs from canonical stage`);
    if (entry.execution_mode !== "legacy_deterministic_runbook" || providerPolicy !== "deterministic" ||
        entry.budget_class !== null || entry.expected_max_provider_tokens !== 0) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} must remain an explicit zero-provider legacy bridge`);
    }
    if (!passFailRule) throw new Error(`flywheel coverage manifest routine ${routineKey} missing pass_fail_rule`);
    if (!requiredReceipts) throw new Error(`flywheel coverage manifest routine ${routineKey} missing required_receipts`);
    seen.set(routineKey, entry);
  }
  const missing = routineKeys.filter((routineKey) => !seen.has(routineKey));
  if (missing.length > 0) throw new Error(`flywheel coverage manifest missing routine coverage for: ${missing.join(", ")}`);
  return routineKeys.map((routineKey) => seen.get(routineKey)!);
}
