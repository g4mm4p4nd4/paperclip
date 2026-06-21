import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FlywheelCoverageManifest = {
  schema_version: string;
  stages: Array<Record<string, unknown>>;
  routine_coverage: Array<Record<string, unknown>>;
  tool_receipt_schemas?: Array<Record<string, unknown>>;
};

const FLYWHEEL_COVERAGE_SCHEMA_VERSION = "paperclip.flywheel_coverage.v1";

function repoRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function defaultFlywheelCoverageManifestPath() {
  return path.join(repoRootFromModule(), "config", "flywheel_coverage.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function parseFlywheelCoverageManifest(raw: unknown): FlywheelCoverageManifest {
  if (!isRecord(raw)) {
    throw new Error("flywheel coverage manifest must be a JSON object");
  }
  const schemaVersion = nonEmptyString(raw.schema_version);
  if (schemaVersion !== FLYWHEEL_COVERAGE_SCHEMA_VERSION) {
    throw new Error(`flywheel coverage manifest schema_version must be ${FLYWHEEL_COVERAGE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.stages) || raw.stages.length === 0 || !raw.stages.every(isRecord)) {
    throw new Error("flywheel coverage manifest must declare non-empty stages");
  }
  if (!Array.isArray(raw.routine_coverage) || raw.routine_coverage.length === 0 || !raw.routine_coverage.every(isRecord)) {
    throw new Error("flywheel coverage manifest must declare non-empty routine_coverage");
  }
  if (raw.tool_receipt_schemas !== undefined
    && (!Array.isArray(raw.tool_receipt_schemas) || !raw.tool_receipt_schemas.every(isRecord))) {
    throw new Error("flywheel coverage manifest tool_receipt_schemas must be an array when present");
  }
  return {
    schema_version: schemaVersion,
    stages: raw.stages,
    routine_coverage: raw.routine_coverage,
    tool_receipt_schemas: Array.isArray(raw.tool_receipt_schemas) ? raw.tool_receipt_schemas : undefined,
  };
}

export function loadFlywheelCoverageManifest(filePath = process.env.PAPERCLIP_FLYWHEEL_COVERAGE_MANIFEST_PATH
  || defaultFlywheelCoverageManifestPath()) {
  return parseFlywheelCoverageManifest(JSON.parse(readFileSync(filePath, "utf8")));
}

export function assertRoutineCoverage(routineKeys: string[], manifest = loadFlywheelCoverageManifest()) {
  const stageNames = new Set(
    manifest.stages
      .map((stage) => nonEmptyString(stage.stage))
      .filter((stage): stage is string => Boolean(stage)),
  );
  const seen = new Map<string, Record<string, unknown>>();
  for (const entry of manifest.routine_coverage) {
    const routineKey = nonEmptyString(entry.routine_key);
    if (!routineKey) {
      throw new Error("flywheel coverage manifest routine_coverage entry missing routine_key");
    }
    if (seen.has(routineKey)) {
      throw new Error(`flywheel coverage manifest has duplicate routine_key: ${routineKey}`);
    }
    const stage = nonEmptyString(entry.stage);
    const ownerPlane = nonEmptyString(entry.owner_plane);
    const providerPolicy = nonEmptyString(entry.provider_policy);
    const passFailRule = nonEmptyString(entry.pass_fail_rule);
    const requiredReceipts = nonEmptyStringArray(entry.required_receipts);
    if (!stage || !stageNames.has(stage)) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} references unknown stage: ${stage ?? "missing"}`);
    }
    if (!ownerPlane) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} missing owner_plane`);
    }
    if (!providerPolicy) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} missing provider_policy`);
    }
    if (!passFailRule) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} missing pass_fail_rule`);
    }
    if (!requiredReceipts) {
      throw new Error(`flywheel coverage manifest routine ${routineKey} missing required_receipts`);
    }
    seen.set(routineKey, entry);
  }
  const missing = routineKeys.filter((routineKey) => !seen.has(routineKey));
  if (missing.length > 0) {
    throw new Error(`flywheel coverage manifest missing routine coverage for: ${missing.join(", ")}`);
  }
  return routineKeys.map((routineKey) => seen.get(routineKey)!);
}
