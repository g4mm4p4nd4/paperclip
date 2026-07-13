import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { PROFIT_FLYWHEEL_CAPABILITY_ALIASES, type ProfitFlywheelCapabilityAlias } from "@paperclipai/shared";
import {
  canonicalProviderRouteJson,
  completionCanaryRouteSha256,
  providerPolicyRouteCoreSha256,
} from "./provider-route-hash.js";

const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../../config/provider-policy.v2.json", import.meta.url));
const DEFAULT_POLICY_SCHEMA_PATH = fileURLToPath(new URL("../../../config/provider-policy.v2.schema.json", import.meta.url));
export const PINNED_PROVIDER_POLICY_SHA256 = "9621358193a61aab2f04e27ac502fc5df1bcd5c81842a841d8db8c138187fce6";
export const PINNED_PROVIDER_POLICY_SCHEMA_SHA256 = "e9bec66fb5863ce8490c16b26e29da7f2ed8576ed96936fd12eb566c1f74a12a";
const TRANSPORTS = new Set(["hermes", "direct_api", "subscription_cli"]);
const BILLING_MODES = new Set(["free", "subscription", "metered"]);
const ADAPTER_TYPES = new Set(["hermes_local", "codex_cli", "claude_cli", "gemini_cli", "direct_api"]);
const REQUIRED_PROVIDER_ROLES = [
  { provider: "opencode-go", adapterType: "hermes_local" },
  { provider: "opencode-zen", adapterType: "hermes_local" },
  { provider: "minimax", adapterType: "hermes_local" },
  { provider: "google-gemini", adapterType: "gemini_cli" },
  { provider: "openai-codex", adapterType: "codex_cli" },
  { provider: "anthropic-claude", adapterType: "claude_cli" },
] as const;

export type ProviderPolicyRoute = {
  id: string;
  provider: string;
  providerFamily: string;
  model: { kind: "exact"; value: string; version: string } | { kind: "selector"; family: string; selector: string; version: string };
  modelFamily: string;
  transport: "hermes" | "direct_api" | "subscription_cli";
  runtimeBinding: {
    adapterType: "hermes_local" | "codex_cli" | "claude_cli" | "gemini_cli" | "direct_api";
    commandRealpath: string;
    commandSha256: string;
    expectedVersion: string;
    versionArgs: string[];
    credentialEnvNames: string[];
    isolatedCanaryCwd: true;
    isolatedCanaryProfile: true;
    hiddenFallbackDisabled: true;
    maxCanaryInputTokens: number;
    runtimeClosureId: string;
    runtimeClosureSha256: string;
    runtimeClosure: ProviderRuntimeClosureBinding;
    repoRoot?: string;
    gitRevision?: string;
    gitTree?: string;
    criticalModules?: string[];
    criticalModulesSha256?: string;
    requireCleanTree?: true;
    externalAdapter?: ProviderPolicySourceBinding;
  };
  capabilities: string[];
  costRank: number;
  billingMode: "free" | "subscription" | "metered";
  credentialRef: string;
  releaseAllowed: boolean;
  emergencyOnly: boolean;
  discovery: {
    authority: "models.dev" | "runtime_cli";
    method: string;
    catalogProviderKey: string;
    requiredStatus: "active";
    versionSource: "verified_catalog" | "runtime_cli_model_id";
    selectedEntrySchema: "provider-catalog-selected-entry.v1" | "runtime-model-selected-entry.v1";
    refreshSeconds: number;
    requireExactVersion: true;
  };
  canary: { kind: "zero_token" | "minimal_token" | "work_bearing"; maxTokens: number; timeoutSeconds: number; successCriteria: string[] };
  rollback: { action: "return_to_alias_resolution"; cooldownSeconds: number; failureThreshold: number; requirePreviousRevision: true };
};

export type ProviderRuntimeFileBinding = {
  path: string;
  sha256: string;
};

export type ProviderRuntimeDirectoryManifestBinding = {
  root: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  rejectSymlinks: true;
  rejectWritable?: true;
};

export type ProviderRuntimeInterpreterBinding = {
  invocationPath: string;
  realpath: string;
  sha256: string;
  expectedVersion: string;
  versionArgs: string[];
  shebang: string;
  pathCommand?: string;
};

export type ProviderRuntimeClosureBinding = {
  schemaVersion: "provider-runtime-closure.v1";
  kind: "native_binary" | "node_bundle" | "python_venv";
  interpreter?: ProviderRuntimeInterpreterBinding;
  files: ProviderRuntimeFileBinding[];
  directories: ProviderRuntimeDirectoryManifestBinding[];
};

export type ProviderPolicySourceBinding = {
  repoRoot: string;
  gitRevision: string;
  gitTree: string;
  criticalModules: string[];
  criticalModulesSha256: string;
  requireCleanTree: true;
};

export type ProviderPolicyV2 = {
  schemaVersion: "provider-policy.v2";
  policyId: string;
  revision: number;
  updatedAt: string;
  runtimeClosures: Record<string, ProviderRuntimeClosureBinding>;
  aliases: Record<ProfitFlywheelCapabilityAlias, { orderedRouteIds: string[]; budgetClass: string; capabilities: string[] }>;
  routes: Record<string, ProviderPolicyRoute>;
  budgetClasses: Record<string, {
    maxTurns: number;
    maxContextChars: number;
    maxOutputChars: number;
    maxTotalTokens: number;
    maxEscalations: number;
    toolOutput: { maxBytes: number; maxLines: number; maxLineLength: number };
  }>;
  invariants: {
    paperclipOwnsEscalation: true;
    hermesFallback: false;
    freshTranscriptOnRouteChange: true;
    independentReviewDifferentProviderFamily: true;
    emergencyFreeReleaseAllowed: false;
  };
};

export type ProviderCatalogEvidenceBinding = {
  policyRouteCoreSha256: string;
  catalogProviderKey: string;
  receiptPath: string;
  receiptSha256: string;
  catalogPath: string;
  catalogSha256: string;
  catalogModelDate: string;
  rawCatalogPath: string;
  rawCatalogSha256: string;
  rawCatalogObservedAt: string;
};

export function buildProviderPolicyRouteCore(input: {
  routeId: string;
  route: ProviderPolicyRoute;
}) {
  const { routeId, route } = input;
  return {
    routeId,
    provider: route.provider,
    providerFamily: route.providerFamily,
    model: route.model.kind === "exact" ? route.model.value : route.model.selector,
    modelVersion: route.model.version,
    modelVersionSource: route.discovery.versionSource,
    transport: route.transport === "hermes" ? "hermes_cli" : route.transport,
    credentialRef: route.credentialRef,
    discovery: route.discovery,
    runtimeBinding: route.runtimeBinding,
    canary: {
      kind: route.canary.kind,
      maxInputTokens: route.runtimeBinding.maxCanaryInputTokens,
      maxOutputTokens: route.canary.maxTokens,
      timeoutSeconds: route.canary.timeoutSeconds,
      successCriteria: route.canary.successCriteria,
    },
  };
}

export function buildResolvedProviderRoute(input: {
  policy: ProviderPolicyV2;
  policySha256: string;
  policySchemaSha256: string;
  routeId: string;
  catalogEvidence?: ProviderCatalogEvidenceBinding | null;
}) {
  const route = input.policy.routes[input.routeId];
  if (!route) throw new ProviderPolicyError("provider_policy_unknown_route", `Unknown provider policy route ${input.routeId}`);
  const core = buildProviderPolicyRouteCore({ routeId: input.routeId, route });
  const policyRouteCoreSha256 = providerPolicyRouteCoreSha256(core);
  if (input.catalogEvidence && input.catalogEvidence.policyRouteCoreSha256 !== policyRouteCoreSha256) {
    throw new ProviderPolicyError("provider_policy_catalog_evidence_route_mismatch", "Catalog evidence does not bind the exact policy route core", {
      routeId: input.routeId,
      expected: policyRouteCoreSha256,
      observed: input.catalogEvidence.policyRouteCoreSha256,
    });
  }
  const routeWithProofs = {
    ...core,
    ...(input.catalogEvidence ? { catalogEvidence: input.catalogEvidence } : {}),
    policyId: input.policy.policyId,
    policyRevision: String(input.policy.revision),
    providerPolicySha256: input.policySha256,
    providerPolicySchemaSha256: input.policySchemaSha256,
  };
  return {
    ...routeWithProofs,
    policyRouteCoreSha256,
    resolvedRouteSha256: completionCanaryRouteSha256(routeWithProofs),
  };
}

export class ProviderPolicyError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProviderPolicyError";
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProviderPolicyError("provider_policy_invalid", `${field} must be a non-empty string`);
  return value.trim();
}

function finiteInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ProviderPolicyError("provider_policy_invalid", `${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ProviderPolicyError("provider_policy_invalid", `${field} must be a non-empty array`);
  const parsed = value.map((entry, index) => nonEmptyString(entry, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new ProviderPolicyError("provider_policy_invalid", `${field} must not contain duplicates`);
  return parsed;
}

function absolutePath(value: unknown, field: string) {
  const parsed = nonEmptyString(value, field);
  if (!path.isAbsolute(parsed) || parsed.includes("\0") || path.resolve(parsed) !== parsed) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} must be a canonical absolute path`);
  }
  return parsed;
}

function sha256String(value: unknown, field: string) {
  const parsed = nonEmptyString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} must be a lowercase SHA-256`);
  }
  return parsed;
}

function parseRuntimeClosure(value: unknown, field: string): ProviderRuntimeClosureBinding {
  const closure = record(value);
  if (closure.schemaVersion !== "provider-runtime-closure.v1") {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field}.schemaVersion must be provider-runtime-closure.v1`);
  }
  const kind = nonEmptyString(closure.kind, `${field}.kind`);
  if (!new Set(["native_binary", "node_bundle", "python_venv"]).has(kind)) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field}.kind is unsupported`);
  }
  if (!Array.isArray(closure.files) || !Array.isArray(closure.directories)) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} must declare files and directories arrays`);
  }
  const files = closure.files.map((entry, index): ProviderRuntimeFileBinding => {
    const file = record(entry);
    return {
      path: absolutePath(file.path, `${field}.files[${index}].path`),
      sha256: sha256String(file.sha256, `${field}.files[${index}].sha256`),
    };
  });
  const directories = closure.directories.map((entry, index): ProviderRuntimeDirectoryManifestBinding => {
    const directory = record(entry);
    if (directory.rejectSymlinks !== true) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `${field}.directories[${index}] must reject symlinks`,
      );
    }
    return {
      root: absolutePath(directory.root, `${field}.directories[${index}].root`),
      manifestSha256: sha256String(
        directory.manifestSha256,
        `${field}.directories[${index}].manifestSha256`,
      ),
      fileCount: finiteInteger(directory.fileCount, `${field}.directories[${index}].fileCount`, 1),
      totalBytes: finiteInteger(directory.totalBytes, `${field}.directories[${index}].totalBytes`, 1),
      rejectSymlinks: true,
      ...(directory.rejectWritable === true ? { rejectWritable: true as const } : {}),
    };
  });
  const uniquePaths = [...files.map((entry) => entry.path), ...directories.map((entry) => entry.root)];
  if (new Set(uniquePaths).size !== uniquePaths.length) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} contains duplicate closure paths`);
  }
  let interpreter: ProviderRuntimeInterpreterBinding | undefined;
  if (closure.interpreter !== undefined) {
    const rawInterpreter = record(closure.interpreter);
    const pathCommand = typeof rawInterpreter.pathCommand === "string"
      ? nonEmptyString(rawInterpreter.pathCommand, `${field}.interpreter.pathCommand`)
      : undefined;
    if (pathCommand && !/^[A-Za-z0-9._-]+$/.test(pathCommand)) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field}.interpreter.pathCommand is invalid`);
    }
    interpreter = {
      invocationPath: absolutePath(rawInterpreter.invocationPath, `${field}.interpreter.invocationPath`),
      realpath: absolutePath(rawInterpreter.realpath, `${field}.interpreter.realpath`),
      sha256: sha256String(rawInterpreter.sha256, `${field}.interpreter.sha256`),
      expectedVersion: nonEmptyString(rawInterpreter.expectedVersion, `${field}.interpreter.expectedVersion`),
      versionArgs: stringArray(rawInterpreter.versionArgs, `${field}.interpreter.versionArgs`),
      shebang: nonEmptyString(rawInterpreter.shebang, `${field}.interpreter.shebang`),
      ...(pathCommand ? { pathCommand } : {}),
    };
    if (!interpreter.shebang.startsWith("#!") || interpreter.shebang.includes("\n") || interpreter.shebang.includes("\r")) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field}.interpreter.shebang must be one exact shebang line`);
    }
  }
  if (kind === "native_binary" && (interpreter || directories.length > 0)) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} native closure cannot declare an interpreter or directory manifest`);
  }
  if (kind === "node_bundle" && (!interpreter || interpreter.pathCommand !== "node" || directories.length === 0)) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} node closure requires a PATH-resolved node interpreter and package manifest`);
  }
  if (
    kind === "python_venv" &&
    (!interpreter ||
      interpreter.pathCommand ||
      directories.length === 0 ||
      directories.some((entry) => entry.rejectWritable !== true) ||
      !files.some((entry) => path.basename(entry.path).endsWith(".lock")))
  ) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} Python closure requires an absolute interpreter, read-only dependency manifest, and lock file`);
  }
  return {
    schemaVersion: "provider-runtime-closure.v1",
    kind: kind as ProviderRuntimeClosureBinding["kind"],
    ...(interpreter ? { interpreter } : {}),
    files,
    directories,
  };
}

function runtimeClosureSha256(binding: ProviderRuntimeClosureBinding) {
  return createHash("sha256").update(canonicalProviderRouteJson(binding), "utf8").digest("hex");
}

function parseSourceBinding(value: unknown, field: string): ProviderPolicySourceBinding {
  const binding = record(value);
  const repoRoot = absolutePath(binding.repoRoot, `${field}.repoRoot`);
  const gitRevision = nonEmptyString(binding.gitRevision, `${field}.gitRevision`).toLowerCase();
  const gitTree = nonEmptyString(binding.gitTree, `${field}.gitTree`).toLowerCase();
  const criticalModules = stringArray(binding.criticalModules, `${field}.criticalModules`);
  const criticalModulesSha256 = nonEmptyString(
    binding.criticalModulesSha256,
    `${field}.criticalModulesSha256`,
  ).toLowerCase();
  if (
    !/^[a-f0-9]{40}$/.test(gitRevision) ||
    !/^[a-f0-9]{40}$/.test(gitTree) ||
    !/^[a-f0-9]{64}$/.test(criticalModulesSha256)
  ) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} source hashes are invalid`);
  }
  for (const relativePath of criticalModules) {
    const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
    if (
      relativePath.includes("\0") || path.isAbsolute(relativePath) ||
      normalized === ".." || normalized.startsWith("../") ||
      normalized.split("/").includes("..")
    ) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `${field}.criticalModules must contain bounded repo-relative paths`,
      );
    }
  }
  if (binding.requireCleanTree !== true) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `${field} must require a clean source tree`);
  }
  return {
    repoRoot,
    gitRevision,
    gitTree,
    criticalModules,
    criticalModulesSha256,
    requireCleanTree: true,
  };
}

export function parseProviderPolicy(value: unknown): ProviderPolicyV2 {
  const input = record(value);
  if (input.schemaVersion !== "provider-policy.v2") throw new ProviderPolicyError("provider_policy_unknown_version", "Expected provider-policy.v2");
  const runtimeClosuresInput = record(input.runtimeClosures);
  if (Object.keys(runtimeClosuresInput).length === 0) {
    throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", "runtimeClosures must be a non-empty keyed object");
  }
  const runtimeClosures = Object.fromEntries(
    Object.entries(runtimeClosuresInput).map(([closureId, rawClosure]) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(closureId)) {
        throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `Runtime closure id ${closureId} is invalid`);
      }
      return [closureId, parseRuntimeClosure(rawClosure, `runtimeClosures.${closureId}`)];
    }),
  );
  const routesInput = record(input.routes);
  if (Object.keys(routesInput).length === 0) throw new ProviderPolicyError("provider_policy_invalid", "routes must be a non-empty keyed object");
  const routes: Record<string, ProviderPolicyRoute> = Object.fromEntries(Object.entries(routesInput).map(([routeId, rawRoute], index): [string, ProviderPolicyRoute] => {
    const route = record(rawRoute);
    const transport = nonEmptyString(route.transport, `routes[${index}].transport`);
    const billingMode = nonEmptyString(route.billingMode, `routes[${index}].billingMode`);
    if (!TRANSPORTS.has(transport)) throw new ProviderPolicyError("provider_policy_invalid", `Unsupported transport ${transport}`);
    if (!BILLING_MODES.has(billingMode)) throw new ProviderPolicyError("provider_policy_invalid", `Unsupported billingMode ${billingMode}`);
    const model = record(route.model);
    const modelKind = nonEmptyString(model.kind, `routes[${index}].model.kind`);
    const parsedModel = modelKind === "exact"
      ? { kind: "exact" as const, value: nonEmptyString(model.value, `routes[${index}].model.value`), version: nonEmptyString(model.version, `routes[${index}].model.version`) }
      : modelKind === "selector"
        ? { kind: "selector" as const, family: nonEmptyString(model.family, `routes[${index}].model.family`), selector: nonEmptyString(model.selector, `routes[${index}].model.selector`), version: nonEmptyString(model.version, `routes[${index}].model.version`) }
        : (() => { throw new ProviderPolicyError("provider_policy_invalid", `Unsupported model kind ${modelKind}`); })();
    const discovery = record(route.discovery);
    const canary = record(route.canary);
    const rollback = record(route.rollback);
    const runtimeBinding = record(route.runtimeBinding);
    const adapterType = nonEmptyString(runtimeBinding.adapterType, `routes[${index}].runtimeBinding.adapterType`);
    if (!ADAPTER_TYPES.has(adapterType)) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `Unsupported adapterType ${adapterType}`);
    }
    const expectedAdapterTypes = transport === "hermes"
      ? new Set(["hermes_local"])
      : transport === "direct_api"
        ? new Set(["direct_api"])
        : new Set(["codex_cli", "claude_cli", "gemini_cli"]);
    if (!expectedAdapterTypes.has(adapterType)) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `Adapter ${adapterType} is incompatible with transport ${transport}`);
    }
    const commandRealpath = absolutePath(
      runtimeBinding.commandRealpath,
      `routes[${index}].runtimeBinding.commandRealpath`,
    );
    const commandSha256 = nonEmptyString(runtimeBinding.commandSha256, `routes[${index}].runtimeBinding.commandSha256`).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(commandSha256)) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}].runtimeBinding.commandSha256 must be lowercase SHA-256`);
    }
    const runtimeClosureId = nonEmptyString(
      runtimeBinding.runtimeClosureId,
      `routes[${index}].runtimeBinding.runtimeClosureId`,
    );
    const runtimeClosure = runtimeClosures[runtimeClosureId];
    if (!runtimeClosure) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `routes[${index}] references unknown runtime closure ${runtimeClosureId}`,
      );
    }
    const expectedClosureKind = adapterType === "hermes_local"
      ? "python_venv"
      : adapterType === "gemini_cli"
        ? "node_bundle"
        : "native_binary";
    if (runtimeClosure.kind !== expectedClosureKind) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `routes[${index}] adapter ${adapterType} requires a ${expectedClosureKind} runtime closure`,
      );
    }
    if (
      runtimeClosure.kind === "native_binary" &&
      !runtimeClosure.files.some((entry) => entry.path === commandRealpath && entry.sha256 === commandSha256)
    ) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `routes[${index}] native runtime closure must pin the exact command bytes`,
      );
    }
    if (adapterType === "codex_cli" && path.extname(commandRealpath).toLowerCase() === ".js") {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `routes[${index}] Codex must execute its pinned native binary directly`,
      );
    }
    if (runtimeBinding.isolatedCanaryCwd !== true || runtimeBinding.isolatedCanaryProfile !== true || runtimeBinding.hiddenFallbackDisabled !== true) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}] must isolate canary cwd/profile and disable hidden fallback`);
    }
    if (adapterType === "hermes_local") {
      const gitRevision = nonEmptyString(runtimeBinding.gitRevision, `routes[${index}].runtimeBinding.gitRevision`);
      const gitTree = nonEmptyString(runtimeBinding.gitTree, `routes[${index}].runtimeBinding.gitTree`);
      const criticalModulesSha256 = nonEmptyString(runtimeBinding.criticalModulesSha256, `routes[${index}].runtimeBinding.criticalModulesSha256`);
      if (!/^[a-f0-9]{40}$/.test(gitRevision) || !/^[a-f0-9]{40}$/.test(gitTree) || !/^[a-f0-9]{64}$/.test(criticalModulesSha256)) {
        throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}] Hermes source hashes are invalid`);
      }
      if (runtimeBinding.requireCleanTree !== true) {
        throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}] Hermes runtime must require a clean source tree`);
      }
      parseSourceBinding(runtimeBinding.externalAdapter, `routes[${index}].runtimeBinding.externalAdapter`);
    } else if (runtimeBinding.externalAdapter !== undefined) {
      throw new ProviderPolicyError(
        "provider_policy_invalid_runtime_binding",
        `routes[${index}] only Hermes routes may bind an external adapter contract`,
      );
    }
    const canaryKind = nonEmptyString(canary.kind, `routes[${index}].canary.kind`);
    if (!new Set(["zero_token", "minimal_token", "work_bearing"]).has(canaryKind)) throw new ProviderPolicyError("provider_policy_invalid", `Unsupported canary kind ${canaryKind}`);
    const canaryMaxTokens = finiteInteger(canary.maxTokens, `routes[${index}].canary.maxTokens`);
    if (canaryKind !== "zero_token" && canaryMaxTokens === 0) {
      throw new ProviderPolicyError("provider_policy_invalid_canary", `routes[${index}] ${canaryKind} canary requires maxTokens > 0`);
    }
    if (rollback.action !== "return_to_alias_resolution" || rollback.requirePreviousRevision !== true) {
      throw new ProviderPolicyError("provider_policy_invalid", `routes[${index}].rollback must return to alias resolution and require a previous revision`);
    }
    const credentialRef = nonEmptyString(route.credentialRef, `routes[${index}].credentialRef`);
    if (!/^(company-secret|runtime-auth):\/\/[A-Za-z0-9_./-]+$/.test(credentialRef)) {
      throw new ProviderPolicyError("provider_policy_secret_literal", `routes[${index}].credentialRef must be an opaque secret reference`);
    }
    const credentialEnvNames = Array.isArray(runtimeBinding.credentialEnvNames)
      ? runtimeBinding.credentialEnvNames.map((entry, envIndex) => nonEmptyString(entry, `routes[${index}].runtimeBinding.credentialEnvNames[${envIndex}]`))
      : (() => { throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}].runtimeBinding.credentialEnvNames must be an array`); })();
    if (new Set(credentialEnvNames).size !== credentialEnvNames.length || credentialEnvNames.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
      throw new ProviderPolicyError("provider_policy_invalid_runtime_binding", `routes[${index}].runtimeBinding.credentialEnvNames is invalid`);
    }
    const companySecretName = credentialRef.startsWith("company-secret://") ? credentialRef.slice("company-secret://".length) : null;
    if (companySecretName ? credentialEnvNames.length !== 1 || credentialEnvNames[0] !== companySecretName : credentialEnvNames.length !== 0) {
      throw new ProviderPolicyError("provider_policy_credential_scope_mismatch", `routes[${index}] credential env allowlist must exactly match credentialRef`);
    }
    const refreshSeconds = finiteInteger(discovery.refreshSeconds, `routes[${index}].discovery.refreshSeconds`, 1800);
    if (discovery.requireExactVersion !== true) {
      throw new ProviderPolicyError("provider_policy_version_not_exact", `routes[${index}] must require exact model/version discovery`);
    }
    const authority = nonEmptyString(discovery.authority, `routes[${index}].discovery.authority`);
    const method = nonEmptyString(discovery.method, `routes[${index}].discovery.method`);
    const versionSource = nonEmptyString(discovery.versionSource, `routes[${index}].discovery.versionSource`);
    const selectedEntrySchema = nonEmptyString(discovery.selectedEntrySchema, `routes[${index}].discovery.selectedEntrySchema`);
    if (!new Set(["models.dev", "runtime_cli"]).has(authority) || discovery.requiredStatus !== "active") {
      throw new ProviderPolicyError("provider_policy_invalid_discovery", `routes[${index}] discovery authority/status is invalid`);
    }
    if (authority === "models.dev" && (versionSource !== "verified_catalog" || selectedEntrySchema !== "provider-catalog-selected-entry.v1")) {
      throw new ProviderPolicyError("provider_policy_invalid_discovery", `routes[${index}] models.dev discovery must use verified catalog evidence`);
    }
    if (authority === "runtime_cli" && (versionSource !== "runtime_cli_model_id" || selectedEntrySchema !== "runtime-model-selected-entry.v1")) {
      throw new ProviderPolicyError("provider_policy_invalid_discovery", `routes[${index}] runtime discovery must use an exact CLI model id`);
    }
    const expectedCatalogProviderKey = route.provider === "opencode-go"
      ? "opencode-go"
      : route.provider === "opencode-zen"
        ? "opencode"
        : route.provider === "minimax"
          ? "minimax"
          : null;
    if (expectedCatalogProviderKey && discovery.catalogProviderKey !== expectedCatalogProviderKey) {
      throw new ProviderPolicyError(
        "provider_policy_catalog_provider_mismatch",
        `routes[${index}] provider ${route.provider} must bind models.dev catalog key ${expectedCatalogProviderKey}`,
      );
    }
    if (canaryKind === "work_bearing" && refreshSeconds < 86_400) {
      throw new ProviderPolicyError("provider_policy_periodic_work_canary", `routes[${index}] work-bearing canary cannot run on a sub-daily freshness cadence`);
    }
    const parsedRoute: ProviderPolicyRoute = {
      id: nonEmptyString(routeId, `routes key ${index}`),
      provider: nonEmptyString(route.provider, `routes[${index}].provider`),
      providerFamily: nonEmptyString(route.providerFamily, `routes[${index}].providerFamily`),
      model: parsedModel,
      modelFamily: nonEmptyString(route.modelFamily, `routes[${index}].modelFamily`),
      transport: transport as ProviderPolicyRoute["transport"],
      runtimeBinding: {
        adapterType: adapterType as ProviderPolicyRoute["runtimeBinding"]["adapterType"],
        commandRealpath,
        commandSha256,
        expectedVersion: nonEmptyString(runtimeBinding.expectedVersion, `routes[${index}].runtimeBinding.expectedVersion`),
        versionArgs: stringArray(runtimeBinding.versionArgs, `routes[${index}].runtimeBinding.versionArgs`),
        credentialEnvNames,
        isolatedCanaryCwd: true,
        isolatedCanaryProfile: true,
        hiddenFallbackDisabled: true,
        maxCanaryInputTokens: finiteInteger(runtimeBinding.maxCanaryInputTokens, `routes[${index}].runtimeBinding.maxCanaryInputTokens`, 1),
        runtimeClosureId,
        runtimeClosureSha256: runtimeClosureSha256(runtimeClosure),
        runtimeClosure,
        ...(typeof runtimeBinding.repoRoot === "string" ? { repoRoot: nonEmptyString(runtimeBinding.repoRoot, `routes[${index}].runtimeBinding.repoRoot`) } : {}),
        ...(typeof runtimeBinding.gitRevision === "string" ? { gitRevision: nonEmptyString(runtimeBinding.gitRevision, `routes[${index}].runtimeBinding.gitRevision`) } : {}),
        ...(typeof runtimeBinding.gitTree === "string" ? { gitTree: nonEmptyString(runtimeBinding.gitTree, `routes[${index}].runtimeBinding.gitTree`) } : {}),
        ...(Array.isArray(runtimeBinding.criticalModules) ? { criticalModules: stringArray(runtimeBinding.criticalModules, `routes[${index}].runtimeBinding.criticalModules`) } : {}),
        ...(typeof runtimeBinding.criticalModulesSha256 === "string" ? { criticalModulesSha256: nonEmptyString(runtimeBinding.criticalModulesSha256, `routes[${index}].runtimeBinding.criticalModulesSha256`) } : {}),
        ...(runtimeBinding.requireCleanTree === true ? { requireCleanTree: true as const } : {}),
        ...(runtimeBinding.externalAdapter !== undefined
          ? { externalAdapter: parseSourceBinding(runtimeBinding.externalAdapter, `routes[${index}].runtimeBinding.externalAdapter`) }
          : {}),
      },
      capabilities: stringArray(route.capabilities, `routes[${index}].capabilities`),
      costRank: finiteInteger(route.costRank, `routes[${index}].costRank`),
      billingMode: billingMode as ProviderPolicyRoute["billingMode"],
      credentialRef,
      releaseAllowed: route.releaseAllowed === true,
      emergencyOnly: route.emergencyOnly === true,
      discovery: {
        authority: authority as ProviderPolicyRoute["discovery"]["authority"],
        method,
        catalogProviderKey: nonEmptyString(discovery.catalogProviderKey, `routes[${index}].discovery.catalogProviderKey`),
        requiredStatus: "active",
        versionSource: versionSource as ProviderPolicyRoute["discovery"]["versionSource"],
        selectedEntrySchema: selectedEntrySchema as ProviderPolicyRoute["discovery"]["selectedEntrySchema"],
        refreshSeconds,
        requireExactVersion: true,
      },
      canary: {
        kind: canaryKind as ProviderPolicyRoute["canary"]["kind"],
        maxTokens: canaryMaxTokens,
        timeoutSeconds: finiteInteger(canary.timeoutSeconds, `routes[${index}].canary.timeoutSeconds`, 1),
        successCriteria: stringArray(canary.successCriteria, `routes[${index}].canary.successCriteria`),
      },
      rollback: {
        action: "return_to_alias_resolution",
        cooldownSeconds: finiteInteger(rollback.cooldownSeconds, `routes[${index}].rollback.cooldownSeconds`),
        failureThreshold: finiteInteger(rollback.failureThreshold, `routes[${index}].rollback.failureThreshold`, 1),
        requirePreviousRevision: true,
      },
    };
    return [routeId, parsedRoute];
  }));
  const routeById = new Map(Object.entries(routes));
  for (const required of REQUIRED_PROVIDER_ROLES) {
    if (!Object.values(routes).some((route) => route.provider === required.provider && route.runtimeBinding.adapterType === required.adapterType)) {
      throw new ProviderPolicyError(
        "provider_policy_required_role_missing",
        `Provider policy requires ${required.provider} through ${required.adapterType}`,
      );
    }
  }

  const budgetsInput = record(input.budgetClasses);
  const budgetClasses: ProviderPolicyV2["budgetClasses"] = {};
  for (const [key, rawBudget] of Object.entries(budgetsInput)) {
    const budget = record(rawBudget);
    const toolOutput = record(budget.toolOutput);
    budgetClasses[key] = {
      maxTurns: finiteInteger(budget.maxTurns, `budgetClasses.${key}.maxTurns`, 1),
      maxContextChars: finiteInteger(budget.maxContextChars, `budgetClasses.${key}.maxContextChars`, 1),
      maxOutputChars: finiteInteger(budget.maxOutputChars, `budgetClasses.${key}.maxOutputChars`, 1),
      maxTotalTokens: finiteInteger(budget.maxTotalTokens, `budgetClasses.${key}.maxTotalTokens`, 1),
      maxEscalations: finiteInteger(budget.maxEscalations, `budgetClasses.${key}.maxEscalations`),
      toolOutput: {
        maxBytes: finiteInteger(toolOutput.maxBytes, `budgetClasses.${key}.toolOutput.maxBytes`, 1),
        maxLines: finiteInteger(toolOutput.maxLines, `budgetClasses.${key}.toolOutput.maxLines`, 1),
        maxLineLength: finiteInteger(toolOutput.maxLineLength, `budgetClasses.${key}.toolOutput.maxLineLength`, 1),
      },
    };
  }

  const aliasesInput = record(input.aliases);
  const aliases = {} as ProviderPolicyV2["aliases"];
  for (const alias of PROFIT_FLYWHEEL_CAPABILITY_ALIASES) {
    const rawAlias = record(aliasesInput[alias]);
    const orderedRouteIds = stringArray(rawAlias.orderedRouteIds, `aliases.${alias}.orderedRouteIds`);
    const budgetClass = nonEmptyString(rawAlias.budgetClass, `aliases.${alias}.budgetClass`);
    if (!budgetClasses[budgetClass]) throw new ProviderPolicyError("provider_policy_unknown_budget", `Alias ${alias} references unknown budget ${budgetClass}`);
    for (const routeId of orderedRouteIds) {
      if (!routeById.has(routeId)) throw new ProviderPolicyError("provider_policy_unknown_route", `Alias ${alias} references unknown route ${routeId}`);
    }
    const capabilities = stringArray(rawAlias.capabilities, `aliases.${alias}.capabilities`);
    let previousCostRank = -1;
    for (const routeId of orderedRouteIds) {
      const route = routeById.get(routeId)!;
      const missingCapabilities = capabilities.filter((capability) => !route.capabilities.includes(capability));
      if (missingCapabilities.length > 0) {
        throw new ProviderPolicyError(
          "provider_policy_capability_mismatch",
          `Route ${routeId} cannot satisfy alias ${alias}: missing ${missingCapabilities.join(", ")}`,
        );
      }
      if (route.costRank < previousCostRank) {
        throw new ProviderPolicyError(
          "provider_policy_cost_order_violation",
          `Alias ${alias} must order capable routes by nondecreasing costRank`,
        );
      }
      previousCostRank = route.costRank;
    }
    aliases[alias] = { orderedRouteIds, budgetClass, capabilities };
  }

  const invariants = record(input.invariants);
  if (
    invariants.paperclipOwnsEscalation !== true || invariants.hermesFallback !== false ||
    invariants.freshTranscriptOnRouteChange !== true || invariants.independentReviewDifferentProviderFamily !== true ||
    invariants.emergencyFreeReleaseAllowed !== false
  ) {
    throw new ProviderPolicyError("provider_policy_invariant_violation", "Provider policy control-plane invariants are immutable");
  }
  for (const routeId of aliases.emergency_free.orderedRouteIds) {
    const route = routeById.get(routeId)!;
    if (!route.emergencyOnly || route.releaseAllowed) throw new ProviderPolicyError("provider_policy_emergency_release", "Emergency/free routes must be emergency-only and release-disallowed");
  }
  const reviewFamilies = new Set(aliases.independent_review.orderedRouteIds.map((routeId) => routeById.get(routeId)!.providerFamily));
  if (reviewFamilies.size < 2) throw new ProviderPolicyError("provider_policy_review_independence", "Independent review requires at least two provider families");
  for (const alias of PROFIT_FLYWHEEL_CAPABILITY_ALIASES) {
    if (alias === "emergency_free") continue;
    const families = new Set(aliases[alias].orderedRouteIds.map((routeId) => routeById.get(routeId)!.providerFamily));
    if (families.size < 2) {
      throw new ProviderPolicyError("provider_policy_single_family", `Alias ${alias} requires capable routes from at least two provider families`);
    }
  }

  const updatedAt = nonEmptyString(input.updatedAt, "updatedAt");
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(updatedAt)) {
    throw new ProviderPolicyError("provider_policy_invalid_timestamp", "updatedAt must be an RFC3339 UTC timestamp");
  }

  return {
    schemaVersion: "provider-policy.v2",
    policyId: nonEmptyString(input.policyId, "policyId"),
    revision: finiteInteger(input.revision, "revision", 1),
    updatedAt,
    runtimeClosures,
    aliases,
    routes,
    budgetClasses,
    invariants: {
      paperclipOwnsEscalation: true,
      hermesFallback: false,
      freshTranscriptOnRouteChange: true,
      independentReviewDifferentProviderFamily: true,
      emergencyFreeReleaseAllowed: false,
    },
  };
}

export async function loadProviderPolicyV2(input: {
  path?: string;
  schemaPath?: string;
  expectedSha256?: string | null;
  expectedSchemaSha256?: string | null;
} = {}) {
  const policyPath = path.resolve(input.path ?? process.env.PAPERCLIP_PROVIDER_POLICY_PATH ?? DEFAULT_POLICY_PATH);
  const schemaPath = path.resolve(input.schemaPath ?? process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH ?? DEFAULT_POLICY_SCHEMA_PATH);
  const raw = await readFile(policyPath, "utf8").catch((error) => {
    throw new ProviderPolicyError("provider_policy_unreadable", `Unable to read provider policy at ${policyPath}`, { cause: error instanceof Error ? error.message : String(error) });
  });
  const schemaRaw = await readFile(schemaPath, "utf8").catch((error) => {
    throw new ProviderPolicyError("provider_policy_schema_unreadable", `Unable to read provider policy schema at ${schemaPath}`, { cause: error instanceof Error ? error.message : String(error) });
  });
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const schemaSha256 = createHash("sha256").update(schemaRaw).digest("hex");
  const expected = input.expectedSha256 ?? process.env.PAPERCLIP_PROVIDER_POLICY_SHA256 ?? PINNED_PROVIDER_POLICY_SHA256;
  const expectedSchema = input.expectedSchemaSha256 ?? process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256 ?? PINNED_PROVIDER_POLICY_SCHEMA_SHA256;
  if (!expected || expected.toLowerCase() !== sha256) {
    throw new ProviderPolicyError("provider_policy_hash_mismatch", "Provider policy hash does not match the approved pin", { expectedSha256: expected, observedSha256: sha256, policyPath });
  }
  if (!expectedSchema || expectedSchema.toLowerCase() !== schemaSha256) {
    throw new ProviderPolicyError("provider_policy_schema_hash_mismatch", "Provider policy schema hash does not match the approved pin", { expectedSchemaSha256: expectedSchema, observedSchemaSha256: schemaSha256, schemaPath });
  }
  let value: unknown;
  let schema: object;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProviderPolicyError("provider_policy_invalid_json", "Provider policy is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    schema = JSON.parse(schemaRaw) as object;
  } catch (error) {
    throw new ProviderPolicyError("provider_policy_schema_invalid_json", "Provider policy schema is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
  try {
    // Ajv/ajv-formats publish CJS-shaped defaults under this TS module mode.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvCtor = (Ajv2020 as any).default ?? Ajv2020;
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFormats = (addFormats as any).default ?? addFormats;
    applyFormats(ajv);
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      throw new ProviderPolicyError("provider_policy_schema_validation_failed", "Provider policy failed its canonical JSON schema", { errors: validate.errors ?? [] });
    }
  } catch (error) {
    if (error instanceof ProviderPolicyError) throw error;
    throw new ProviderPolicyError("provider_policy_schema_compile_failed", "Provider policy schema could not be compiled", { cause: error instanceof Error ? error.message : String(error) });
  }
  return {
    policy: parseProviderPolicy(value),
    path: policyPath,
    sha256,
    schemaPath,
    schemaSha256,
    loadedAt: new Date().toISOString(),
  };
}

export function resolveProviderAlias(input: {
  policy: ProviderPolicyV2;
  alias: ProfitFlywheelCapabilityAlias;
  unavailableRouteIds?: Iterable<string>;
  excludedProviderFamily?: string | null;
  release?: boolean;
}) {
  const unavailable = new Set(input.unavailableRouteIds ?? []);
  const alias = input.policy.aliases[input.alias];
  const routeById = new Map(Object.entries(input.policy.routes));
  const route = alias.orderedRouteIds
    .map((routeId) => routeById.get(routeId)!)
    .find((candidate) =>
      !unavailable.has(candidate.id) &&
      (!input.excludedProviderFamily || candidate.providerFamily !== input.excludedProviderFamily) &&
      (!input.release || candidate.releaseAllowed) &&
      (!candidate.emergencyOnly || input.alias === "emergency_free" || input.alias === "independent_review"));
  if (!route) {
    throw new ProviderPolicyError("provider_policy_no_capable_route", `No capable route remains for alias ${input.alias}`, {
      alias: input.alias,
      unavailableRouteIds: [...unavailable],
      excludedProviderFamily: input.excludedProviderFamily ?? null,
      release: input.release === true,
      nextOwner: "paperclip_provider_operator",
    });
  }
  return { route, budget: input.policy.budgetClasses[alias.budgetClass], alias: input.alias };
}
