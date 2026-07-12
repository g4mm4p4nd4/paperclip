import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  agents,
  profitFlywheelProviderHealth,
  type Db,
} from "@paperclipai/db";
import { issueService } from "./issues.js";
import { notifyProfitFlywheelReconciliation } from "./profit-flywheel-reconcile-signal.js";
import {
  buildProviderPolicyRouteCore,
  buildResolvedProviderRoute,
  type ProviderCatalogEvidenceBinding,
  type ProviderPolicyRoute,
  type ProviderPolicyV2,
  resolveProviderAlias,
} from "./provider-policy.js";
import { providerPolicyRouteCoreSha256 } from "./provider-route-hash.js";
import { verifyHermesCompletionCanaryReceiptArtifact } from "./hermes-canary-receipt.js";
import { verifyHermesExternalAdapterBinding } from "./provider-source-binding.js";
import type { ProfitFlywheelCapabilityAlias } from "@paperclipai/shared";
import { redactCurrentUserText } from "../log-redaction.js";

export const PROVIDER_CREDENTIAL_BLOCKER_TITLE = "[provider-policy.v2] Human credential blockers";
const DEFAULT_RECEIPT_ROOT = fileURLToPath(new URL("../../../data/ops/provider-canaries/runs", import.meta.url));
const MAX_CANARY_RECEIPT_BYTES = 1024 * 1024;

export type ProviderCanaryFailureClass =
  | "provider_auth"
  | "provider_billing"
  | "provider_capability_mismatch"
  | "provider_malformed_response"
  | "provider_quota"
  | "provider_rate_limit"
  | "provider_security_compromise"
  | "transient_network"
  | "process_lost";

export type ProviderCanaryExecutionResult = {
  exitCode: number | null;
  finalResponse: string | null;
  expectedNonce: string;
  resolvedModel: string | null;
  resolvedVersion: string | null;
  receiptPath: string | null;
  receiptSha256: string | null;
  receiptSchemaVersion?: string | null;
  policyRouteCoreSha256?: string | null;
  resolvedRouteSha256?: string | null;
  catalogEvidence?: ProviderCatalogEvidenceBinding | null;
  failureClass?: ProviderCanaryFailureClass | null;
  failureDetail?: string | null;
  details?: Record<string, unknown>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
    accountingMode: "booked" | "telemetry_only";
  } | null;
  securityCompromised?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function spanId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function traceId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function modelValue(route: ProviderPolicyRoute) {
  return route.model.kind === "exact" ? route.model.value : null;
}

function stableDiscovery(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

const SECRET_LIKE_REPLACE = /(?:bearer\s+[a-z0-9._-]+|(?:api[_-]?key|token|auth(?:orization)?|secret|password|credential|cookie|journal[_-]?key)\s*[=:]\s*[^\s,;]+)/ig;
const SECRET_LIKE_TEST = /(?:bearer\s+[a-z0-9._-]+|(?:api[_-]?key|token|auth(?:orization)?|secret|password|credential|cookie|journal[_-]?key)\s*[=:]\s*[^\s,;]+)/i;

function safeDiagnosticText(value: string | null | undefined, maxLength = 1000) {
  if (!value) return null;
  return redactCurrentUserText(value).replace(SECRET_LIKE_REPLACE, "[REDACTED]").slice(0, maxLength);
}

function safeIdentifier(value: string | null | undefined, field: string) {
  if (!value?.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > 500 || SECRET_LIKE_TEST.test(normalized) || /[?&](?:key|token|secret|password)=/i.test(normalized)) {
    throw new Error(`${field} contains secret-like or oversized data`);
  }
  return normalized;
}

export function classifyProviderCanaryExecutionException(error: unknown): ProviderCanaryFailureClass {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.toLowerCase()
    : "";
  const text = error instanceof Error ? error.message : String(error);
  if (
    errorCode === "provider_security_compromise" ||
    errorCode === "provider_runtime_closure_mismatch" ||
    errorCode === "provider_source_binding_mismatch" ||
    /(?:does not match its pinned clean source binding|runtime source revision\/tree\/critical-module hash is dirty or does not match policy|active .* adapter provenance does not match|active .* adapter module bytes do not match|active adapter changed while resolving policy-owned execution provenance|policy route adapter mapping mismatch|requires (?:the )?(?:pinned external|in-tree) .* adapter, but active provenance)/i.test(text)
  ) return "provider_security_compromise";
  if (/(?:company secret .* (?:missing|unavailable)|credential(?:s)? (?:missing|invalid|unavailable)|not logged in|login required|oauth)/i.test(text)) return "provider_auth";
  if (/(?:billing|payment required|subscription expired)/i.test(text)) return "provider_billing";
  if (/(?:quota|capacity exhausted|usage limit)/i.test(text)) return "provider_quota";
  if (/(?:rate.?limit|too many requests|http 429)/i.test(text)) return "provider_rate_limit";
  if (/(?:model not found|unsupported model|model access|capability mismatch)/i.test(text)) return "provider_capability_mismatch";
  if (/(?:econnreset|econnrefused|enotfound|dns|network unreachable|socket hang up|tls handshake)/i.test(text)) return "transient_network";
  return "process_lost";
}

function normalizedDetails(result: ProviderCanaryExecutionResult) {
  const source = result.details ?? {};
  const allowed: Record<string, unknown> = {};
  for (const key of ["httpStatus", "errorCode", "retryAfterSeconds", "quotaWindow", "accountPurpose"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) allowed[key] = value;
    else if (typeof value === "boolean") allowed[key] = value;
    else if (typeof value === "string") allowed[key] = safeDiagnosticText(value, 300);
  }
  if (result.usage) {
    allowed.usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUsd: result.usage.costUsd,
      accountingMode: result.usage.accountingMode,
    };
  }
  return allowed;
}

function classifyCanaryResult(route: ProviderPolicyRoute, result: ProviderCanaryExecutionResult) {
  if (result.securityCompromised || result.failureClass === "provider_security_compromise") {
    return { status: "quarantined" as const, failureClass: "provider_security_compromise" as const, failureDetail: result.failureDetail ?? "Credential exposure requires rotation" };
  }
  if (result.failureClass) {
    return { status: "failed" as const, failureClass: result.failureClass, failureDetail: safeDiagnosticText(result.failureDetail ?? result.failureClass) };
  }
  if (result.exitCode !== 0) {
    return { status: "failed" as const, failureClass: "process_lost" as const, failureDetail: result.failureDetail ?? `canary exit code ${result.exitCode ?? "missing"}` };
  }
  const finalResponse = result.finalResponse?.trim() ?? "";
  if (!finalResponse || finalResponse !== result.expectedNonce) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: "Canary did not return the exact nonce in a complete final response",
    };
  }
  const expectedModel = modelValue(route);
  if (expectedModel && result.resolvedModel !== expectedModel) {
    return {
      status: "failed" as const,
      failureClass: "provider_capability_mismatch" as const,
      failureDetail: `Resolved model ${result.resolvedModel ?? "missing"} does not match policy model ${expectedModel}`,
    };
  }
  if (!result.resolvedVersion) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: "Canary receipt is missing resolved model version",
    };
  }
  if (result.resolvedVersion !== route.model.version) {
    return {
      status: "failed" as const,
      failureClass: "provider_capability_mismatch" as const,
      failureDetail: `Resolved version ${result.resolvedVersion} does not match policy version ${route.model.version}`,
    };
  }
  try {
    safeIdentifier(result.resolvedModel, "resolvedModel");
    safeIdentifier(result.resolvedVersion, "resolvedVersion");
    safeIdentifier(result.receiptPath, "receiptPath");
  } catch (error) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result.receiptPath?.trim()) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: "Canary success is missing an immutable receipt path",
    };
  }
  if (!result.receiptSha256 || !/^[a-f0-9]{64}$/.test(result.receiptSha256)) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: "Canary success is missing a verified immutable receipt SHA-256",
    };
  }
  if (
    !result.usage ||
    !Number.isFinite(result.usage.inputTokens) || result.usage.inputTokens < 0 ||
    !Number.isFinite(result.usage.outputTokens) || result.usage.outputTokens < 0 ||
    (route.canary.kind !== "zero_token" && result.usage.inputTokens <= 0) ||
    (route.canary.kind !== "zero_token" && result.usage.outputTokens <= 0) ||
    !Number.isFinite(result.usage.totalTokens) || result.usage.totalTokens !== result.usage.inputTokens + result.usage.outputTokens ||
    result.usage.inputTokens > route.runtimeBinding.maxCanaryInputTokens ||
    result.usage.outputTokens > route.canary.maxTokens ||
    !["booked", "telemetry_only"].includes(result.usage.accountingMode)
  ) {
    return {
      status: "failed" as const,
      failureClass: "provider_malformed_response" as const,
      failureDetail: "Canary success is missing normalized usage/accounting",
    };
  }
  return { status: "healthy" as const, failureClass: null, failureDetail: null };
}

async function verifyImmutableReceipt(input: {
  routeId: string;
  route: ProviderPolicyRoute;
  policy: ProviderPolicyV2;
  policySha256: string;
  policySchemaSha256: string;
  expectedNonce: string;
  expectedCorrelationId: string;
  result: ProviderCanaryExecutionResult;
  receiptPath: string | null;
  receiptSha256: string | null;
  receiptRoot: string;
}) {
  const receiptPath = safeIdentifier(input.receiptPath, "receiptPath");
  const receiptSha256 = safeIdentifier(input.receiptSha256, "receiptSha256")?.toLowerCase() ?? null;
  if (!receiptPath || !receiptSha256 || !/^[a-f0-9]{64}$/.test(receiptSha256)) {
    throw new Error("Canary success requires receiptPath and lowercase receiptSha256");
  }
  const configuredRoot = path.resolve(input.receiptRoot);
  const root = await realpath(configuredRoot);
  const resolved = path.resolve(receiptPath);
  const configuredRelative = path.relative(configuredRoot, resolved);
  const canonicalRelative = path.relative(root, resolved);
  const configuredContains = !configuredRelative.startsWith("..") && !path.isAbsolute(configuredRelative);
  const canonicalContains = !canonicalRelative.startsWith("..") && !path.isAbsolute(canonicalRelative);
  if (!configuredContains && !canonicalContains) {
    throw new Error("Canary receipt is outside the allowlisted immutable receipt root");
  }
  const expectedRealpath = configuredContains ? path.resolve(root, configuredRelative) : resolved;
  const observedRealpath = await realpath(resolved);
  const relative = path.relative(root, observedRealpath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Canary receipt is outside the allowlisted immutable receipt root");
  }
  if (observedRealpath !== expectedRealpath) throw new Error("Canary receipt path must not traverse a symlink below the allowlisted root");
  const receiptHandle = await open(observedRealpath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let receiptBytes: Buffer;
  try {
    const beforeRead = await receiptHandle.stat();
    if (!beforeRead.isFile() || (beforeRead.mode & 0o222) !== 0) {
      throw new Error("Canary receipt must be a read-only regular file");
    }
    if (beforeRead.size > MAX_CANARY_RECEIPT_BYTES) {
      throw new Error("Canary receipt exceeds the maximum verified size");
    }
    receiptBytes = await receiptHandle.readFile();
    const afterRead = await receiptHandle.stat();
    const pathAfterRead = await lstat(observedRealpath).catch(() => null);
    if (
      !pathAfterRead || pathAfterRead.isSymbolicLink() || !pathAfterRead.isFile() ||
      beforeRead.dev !== afterRead.dev || beforeRead.ino !== afterRead.ino ||
      beforeRead.size !== afterRead.size || beforeRead.mtimeMs !== afterRead.mtimeMs || beforeRead.ctimeMs !== afterRead.ctimeMs ||
      pathAfterRead.dev !== afterRead.dev || pathAfterRead.ino !== afterRead.ino ||
      receiptBytes.byteLength !== afterRead.size
    ) {
      throw new Error("Canary receipt changed while it was being verified");
    }
  } finally {
    await receiptHandle.close();
  }
  const observedSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  if (observedSha256 !== receiptSha256) throw new Error("Canary receipt SHA-256 does not match its immutable content");
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Canary receipt must be stable JSON");
  }
  if (input.route.runtimeBinding.adapterType === "hermes_local" && receipt.schemaVersion !== "hermes-completion-canary-receipt.v1") {
    throw new Error("Hermes routes require the canonical native Hermes completion receipt");
  }
  const policyCore = buildProviderPolicyRouteCore({ routeId: input.routeId, route: input.route });
  const policyRouteCoreSha256 = providerPolicyRouteCoreSha256(policyCore);
  if (receipt.schemaVersion === "hermes-completion-canary-receipt.v1") {
    if (input.route.runtimeBinding.adapterType !== "hermes_local") {
      throw new Error("Native Hermes receipt cannot satisfy a non-Hermes route");
    }
    if (input.route.discovery.authority === "models.dev" && !input.result.catalogEvidence) {
      throw new Error("Catalog-backed Hermes route is missing its exact immutable evidence binding");
    }
    const resolvedRoute = buildResolvedProviderRoute({
      policy: input.policy,
      policySha256: input.policySha256,
      policySchemaSha256: input.policySchemaSha256,
      routeId: input.routeId,
      catalogEvidence: input.result.catalogEvidence ?? null,
    });
    const adapterIdentity = await verifyHermesExternalAdapterBinding(input.route);
    const verified = await verifyHermesCompletionCanaryReceiptArtifact(
      { path: observedRealpath, sha256: observedSha256 },
      {
        route: resolvedRoute,
        providerPolicySha256: input.policySha256,
        providerPolicySchemaSha256: input.policySchemaSha256,
        correlationId: input.expectedCorrelationId,
        nonce: input.expectedNonce,
      },
      undefined,
      adapterIdentity.repoRoot,
    );
    await verifyHermesExternalAdapterBinding(input.route);
    const summary = asRecord(verified.summary);
    const routeSummary = asRecord(summary.route);
    const usageSummary = asRecord(summary.usage);
    const nativeReceipt = asRecord(verified.receipt);
    return {
      receiptPath: observedRealpath,
      receiptSha256: observedSha256,
      receiptSchemaVersion: "hermes-completion-canary-receipt.v1",
      policyRouteCoreSha256,
      resolvedRouteSha256: String(routeSummary.resolvedRouteSha256),
      catalogEvidence: input.result.catalogEvidence ?? null,
      finalResponse: input.expectedNonce,
      resolvedModel: typeof routeSummary.observedModel === "string" ? routeSummary.observedModel : null,
      resolvedVersion: typeof routeSummary.observedModelVersion === "string" ? routeSummary.observedModelVersion : null,
      usage: {
        inputTokens: Number(usageSummary.inputTokens),
        outputTokens: Number(usageSummary.outputTokens),
        totalTokens: Number(usageSummary.totalTokens),
        costUsd: null,
        accountingMode: "telemetry_only" as const,
      },
      nativeStatus: nativeReceipt.status,
      failureClass: typeof nativeReceipt.failureClass === "string"
        ? nativeReceipt.failureClass as ProviderCanaryFailureClass
        : null,
      failureDetail: typeof nativeReceipt.failureClass === "string" ? `Verified native Hermes failure: ${nativeReceipt.failureClass}` : null,
      exitCode: asRecord(nativeReceipt.processOutcome).exitCode === 0 ? 0 : null,
    };
  }
  const usage = receipt.usage && typeof receipt.usage === "object" && !Array.isArray(receipt.usage)
    ? receipt.usage as Record<string, unknown>
    : {};
  const runtime = receipt.runtime_binding && typeof receipt.runtime_binding === "object" && !Array.isArray(receipt.runtime_binding)
    ? receipt.runtime_binding as Record<string, unknown>
    : {};
  const modelAttestation = receipt.model_attestation && typeof receipt.model_attestation === "object" && !Array.isArray(receipt.model_attestation)
    ? receipt.model_attestation as Record<string, unknown>
    : {};
  const model = input.route.model.kind === "exact" ? input.route.model.value : null;
  const resolvedRoute = buildResolvedProviderRoute({
    policy: input.policy,
    policySha256: input.policySha256,
    policySchemaSha256: input.policySchemaSha256,
    routeId: input.routeId,
  });
  const expectedUsage = input.result.usage;
  const mismatches = [
    receipt.schema_version !== "paperclip.provider_canary_receipt.v2" && "schema_version",
    receipt.route_id !== input.routeId && "route_id",
    receipt.provider !== input.route.provider && "provider",
    receipt.provider_family !== input.route.providerFamily && "provider_family",
    receipt.policy_sha256 !== input.policySha256 && "policy_sha256",
    receipt.policy_schema_sha256 !== input.policySchemaSha256 && "policy_schema_sha256",
    receipt.policy_route_core_sha256 !== policyRouteCoreSha256 && "policy_route_core_sha256",
    receipt.resolved_route_sha256 !== resolvedRoute.resolvedRouteSha256 && "resolved_route_sha256",
    receipt.correlation_id !== input.expectedCorrelationId && "correlation_id",
    receipt.expected_nonce !== input.expectedNonce && "expected_nonce",
    receipt.final_response !== input.expectedNonce && "final_response",
    receipt.final_response_complete !== true && "final_response_complete",
    model !== null && receipt.resolved_model !== model && "resolved_model",
    receipt.resolved_version !== input.route.model.version && "resolved_version",
    !["runtime_event", "exact_cli_argument"].includes(String(modelAttestation.method ?? "")) && "model_attestation.method",
    modelAttestation.requested_model !== model && "model_attestation.requested_model",
    modelAttestation.method === "runtime_event" && modelAttestation.runtime_reported_model !== model && "model_attestation.runtime_reported_model",
    modelAttestation.hidden_fallback_disabled !== true && "model_attestation.hidden_fallback_disabled",
    modelAttestation.isolated_user_config !== true && "model_attestation.isolated_user_config",
    runtime.command_realpath !== input.route.runtimeBinding.commandRealpath && "runtime.command_realpath",
    runtime.command_sha256 !== input.route.runtimeBinding.commandSha256 && "runtime.command_sha256",
    runtime.observed_version !== input.route.runtimeBinding.expectedVersion && "runtime.observed_version",
    runtime.runtime_closure_id !== input.route.runtimeBinding.runtimeClosureId && "runtime.runtime_closure_id",
    runtime.runtime_closure_sha256 !== input.route.runtimeBinding.runtimeClosureSha256 && "runtime.runtime_closure_sha256",
    runtime.binding_complete !== true && "runtime.binding_complete",
    runtime.isolated_cwd !== true && "runtime.isolated_cwd",
    runtime.isolated_profile !== true && "runtime.isolated_profile",
    input.route.runtimeBinding.repoRoot && runtime.repo_root !== input.route.runtimeBinding.repoRoot && "runtime.repo_root",
    input.route.runtimeBinding.gitRevision && runtime.git_revision !== input.route.runtimeBinding.gitRevision && "runtime.git_revision",
    input.route.runtimeBinding.gitTree && runtime.git_tree !== input.route.runtimeBinding.gitTree && "runtime.git_tree",
    input.route.runtimeBinding.criticalModulesSha256 && runtime.critical_modules_sha256 !== input.route.runtimeBinding.criticalModulesSha256 && "runtime.critical_modules_sha256",
    input.route.runtimeBinding.requireCleanTree && runtime.dirty !== false && "runtime.dirty",
    receipt.personal_context_markers_absent !== true && "personal_context_markers_absent",
    stableDiscovery(receipt.discovery_contract) !== stableDiscovery(input.route.discovery) && "discovery_contract",
    !expectedUsage && "usage",
    expectedUsage && usage.input_tokens !== expectedUsage.inputTokens && "usage.input_tokens",
    expectedUsage && usage.output_tokens !== expectedUsage.outputTokens && "usage.output_tokens",
    expectedUsage && usage.total_tokens !== expectedUsage.totalTokens && "usage.total_tokens",
    expectedUsage && usage.cost_usd !== expectedUsage.costUsd && "usage.cost_usd",
    expectedUsage && usage.accounting_mode !== expectedUsage.accountingMode && "usage.accounting_mode",
  ].filter((value): value is string => typeof value === "string");
  if (mismatches.length > 0) {
    throw new Error(`Canary receipt does not match verified execution fields: ${mismatches.join(", ")}`);
  }
  return {
    receiptPath: observedRealpath,
    receiptSha256: observedSha256,
    receiptSchemaVersion: "paperclip.provider_canary_receipt.v2",
    policyRouteCoreSha256,
    resolvedRouteSha256: resolvedRoute.resolvedRouteSha256,
    catalogEvidence: null,
  };
}

export function providerCanaryService(db: Db, options: { receiptRoot?: string } = {}) {
  const receiptRoot = path.resolve(options.receiptRoot ?? process.env.PAPERCLIP_PROVIDER_CANARY_RECEIPT_ROOT ?? DEFAULT_RECEIPT_ROOT);

  async function verifyHealthyRow(input: {
    row: typeof profitFlywheelProviderHealth.$inferSelect;
    routeId: string;
    route: ProviderPolicyRoute;
    policy: ProviderPolicyV2;
    policySha256: string;
    policySchemaSha256: string;
    now: Date;
  }) {
    const { row, route, routeId, now } = input;
    const expectedModel = route.model.kind === "exact" ? route.model.value : null;
    const coreHash = providerPolicyRouteCoreSha256(buildProviderPolicyRouteCore({ routeId, route }));
    if (
      row.status !== "healthy" || row.expiresAt <= now || (row.backoffUntil && row.backoffUntil > now) ||
      row.policyRouteCoreSha256 !== coreHash || !row.resolvedRouteSha256 ||
      !row.receiptPath || !row.receiptSha256 || !row.receiptSchemaVersion || !row.canaryNonce ||
      (expectedModel !== null && row.resolvedModel !== expectedModel) || row.resolvedVersion !== route.model.version
    ) return false;
    const detailsUsage = asRecord(asRecord(row.details).usage);
    const catalogEvidence = row.catalogEvidence && typeof row.catalogEvidence === "object" && !Array.isArray(row.catalogEvidence)
      ? row.catalogEvidence as ProviderCatalogEvidenceBinding
      : null;
    try {
      const verified = await verifyImmutableReceipt({
        routeId,
        route,
        policy: input.policy,
        policySha256: input.policySha256,
        policySchemaSha256: input.policySchemaSha256,
        expectedNonce: row.canaryNonce,
        expectedCorrelationId: row.correlationId,
        result: {
          exitCode: 0,
          finalResponse: row.canaryNonce,
          expectedNonce: row.canaryNonce,
          resolvedModel: row.resolvedModel,
          resolvedVersion: row.resolvedVersion,
          receiptPath: row.receiptPath,
          receiptSha256: row.receiptSha256,
          receiptSchemaVersion: row.receiptSchemaVersion,
          policyRouteCoreSha256: row.policyRouteCoreSha256,
          resolvedRouteSha256: row.resolvedRouteSha256,
          catalogEvidence,
          usage: {
            inputTokens: Number(detailsUsage.inputTokens),
            outputTokens: Number(detailsUsage.outputTokens),
            totalTokens: Number(detailsUsage.totalTokens),
            costUsd: typeof detailsUsage.costUsd === "number" ? detailsUsage.costUsd : null,
            accountingMode: detailsUsage.accountingMode === "booked" ? "booked" : "telemetry_only",
          },
        },
        receiptPath: row.receiptPath,
        receiptSha256: row.receiptSha256,
        receiptRoot,
      });
      return verified.policyRouteCoreSha256 === row.policyRouteCoreSha256 &&
        verified.resolvedRouteSha256 === row.resolvedRouteSha256 &&
        verified.receiptSchemaVersion === row.receiptSchemaVersion;
    } catch {
      return false;
    }
  }

  async function upsertCredentialBlocker(input: {
    companyId: string;
    now: Date;
    policySha256: string;
    policySchemaSha256?: string;
    policy?: ProviderPolicyV2;
  }) {
    const activeAuthFailures = await db
      .select()
      .from(profitFlywheelProviderHealth)
      .where(and(
        eq(profitFlywheelProviderHealth.companyId, input.companyId),
        eq(profitFlywheelProviderHealth.policySha256, input.policySha256),
        ...(input.policySchemaSha256 ? [eq(profitFlywheelProviderHealth.policySchemaSha256, input.policySchemaSha256)] : []),
        inArray(profitFlywheelProviderHealth.status, ["failed", "quarantined"]),
        inArray(profitFlywheelProviderHealth.failureClass, ["provider_auth", "provider_security_compromise"]),
      ));
    const svc = issueService(db);
    const existing = (await svc.list(input.companyId, { q: PROVIDER_CREDENTIAL_BLOCKER_TITLE, limit: 20 }))
      .find((issue) => issue.title === PROVIDER_CREDENTIAL_BLOCKER_TITLE) ?? null;
    if (activeAuthFailures.length === 0) {
      if (!input.policy || !input.policySchemaSha256) return existing;
      const healthRows = await db
        .select()
        .from(profitFlywheelProviderHealth)
        .where(and(
          eq(profitFlywheelProviderHealth.companyId, input.companyId),
          eq(profitFlywheelProviderHealth.policySha256, input.policySha256),
          eq(profitFlywheelProviderHealth.policySchemaSha256, input.policySchemaSha256),
        ));
      const byRoute = new Map(healthRows.map((row) => [row.routeId, row]));
      let completeFreshCoverage = true;
      for (const [routeId, route] of Object.entries(input.policy.routes)) {
        const row = byRoute.get(routeId);
        if (!row || !await verifyHealthyRow({
          row,
          routeId,
          route,
          policy: input.policy,
          policySha256: input.policySha256,
          policySchemaSha256: input.policySchemaSha256,
          now: input.now,
        })) {
          completeFreshCoverage = false;
          break;
        }
      }
      if (completeFreshCoverage && existing && !["done", "cancelled"].includes(existing.status)) {
        await svc.update(existing.id, {
          status: "done",
          description: `${existing.description ?? ""}\n\nResolved at ${input.now.toISOString()}: every route in the active policy revision has a fresh healthy, content-addressed superseding canary.`,
        });
      }
      return existing;
    }

    const orchestrator = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.name, "Portfolio OS Orchestrator")))
      .then((rows) => rows[0] ?? null);
    const hasCompromise = activeAuthFailures.some((row) => row.failureClass === "provider_security_compromise");
    const blocker = {
      schema_version: "paperclip.provider_credential_blocker.v2",
      blocker_code: hasCompromise ? "provider_credentials_compromised" : "provider_credentials_required",
      blocker_detail: activeAuthFailures.map((row) => ({
        route_id: row.routeId,
        provider: row.provider,
        detail: safeDiagnosticText(row.failureDetail),
        receipt_path: row.receiptPath,
        observed_at: row.observedAt.toISOString(),
      })),
      next_owner: "human_security_owner",
      resume_condition: "Rotate or re-authenticate the referenced credential without exposing it, then rerun the bounded route canary until a complete nonce final and usage receipt pass.",
      policy_sha256: activeAuthFailures[0]?.policySha256 ?? null,
      updated_at: input.now.toISOString(),
    };
    const description = [
      "Provider routes are fail-closed because human-owned credentials require repair.",
      "",
      "```json",
      JSON.stringify(blocker, null, 2),
      "```",
    ].join("\n");
    if (existing) {
      return svc.update(existing.id, {
        status: "blocked",
        priority: "critical",
        assigneeAgentId: orchestrator?.id ?? existing.assigneeAgentId,
        description,
      });
    }
    return svc.create(input.companyId, {
      title: PROVIDER_CREDENTIAL_BLOCKER_TITLE,
      description,
      status: "blocked",
      priority: "critical",
      assigneeAgentId: orchestrator?.id ?? null,
    });
  }

  async function recordResult(input: {
    companyId: string;
    routeId: string;
    route: ProviderPolicyRoute;
    policySha256: string;
    policySchemaSha256: string;
    policy: ProviderPolicyV2;
    result: ProviderCanaryExecutionResult;
    now?: Date;
    correlationId?: string;
    reconcileBlocker?: boolean;
  }) {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? `provider-canary-${randomUUID()}`;
    let effectiveResult = input.result;
    const shouldVerifySuppliedReceipt = Boolean(input.result.receiptPath && input.result.receiptSha256) && (
      input.route.runtimeBinding.adapterType === "hermes_local" ||
      (!input.result.failureClass && input.result.exitCode === 0)
    );
    if (shouldVerifySuppliedReceipt) {
      try {
        const verified = await verifyImmutableReceipt({
          routeId: input.routeId,
          route: input.route,
          policy: input.policy,
          policySha256: input.policySha256,
          policySchemaSha256: input.policySchemaSha256,
          expectedNonce: input.result.expectedNonce,
          expectedCorrelationId: correlationId,
          result: input.result,
          receiptPath: input.result.receiptPath,
          receiptSha256: input.result.receiptSha256,
          receiptRoot,
        });
        effectiveResult = { ...input.result, ...verified };
      } catch (error) {
        effectiveResult = {
          ...input.result,
          receiptPath: null,
          receiptSha256: null,
          failureClass: "provider_malformed_response",
          failureDetail: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (input.result.failureClass || input.result.exitCode !== 0) {
      // Failure artifacts have a different trust contract. Until a dedicated
      // failure-receipt schema is verified, never persist caller-supplied paths
      // or hashes as though they were immutable canary evidence.
      effectiveResult = { ...input.result, receiptPath: null, receiptSha256: null };
    }
    const classification = classifyCanaryResult(input.route, effectiveResult);
    const consecutiveFailures = classification.status === "healthy" ? 0 : 1;
    const expiresAt = new Date(now.getTime() + input.route.discovery.refreshSeconds * 1000);
    const backoffUntil = classification.status === "healthy"
      ? null
      : new Date(now.getTime() + input.route.rollback.cooldownSeconds * 1000);
    const status = classification.status === "quarantined"
      ? "quarantined"
      : classification.status === "failed" && input.route.rollback.failureThreshold <= 1
      ? "quarantined"
      : classification.status;
    const policyCore = buildProviderPolicyRouteCore({ routeId: input.routeId, route: input.route });
    const policyRouteCoreSha256 = providerPolicyRouteCoreSha256(policyCore);
    const values = {
      companyId: input.companyId,
      routeId: input.routeId,
      policySha256: input.policySha256,
      policySchemaSha256: input.policySchemaSha256,
      provider: input.route.provider,
      providerFamily: input.route.providerFamily,
      status,
      failureClass: classification.failureClass,
      failureDetail: safeDiagnosticText(classification.failureDetail),
      resolvedModel: safeIdentifier(effectiveResult.resolvedModel, "resolvedModel"),
      resolvedVersion: safeIdentifier(effectiveResult.resolvedVersion, "resolvedVersion"),
      policyRouteCoreSha256,
      resolvedRouteSha256: safeIdentifier(effectiveResult.resolvedRouteSha256, "resolvedRouteSha256"),
      receiptPath: safeIdentifier(effectiveResult.receiptPath, "receiptPath"),
      receiptSha256: safeIdentifier(effectiveResult.receiptSha256, "receiptSha256"),
      receiptSchemaVersion: safeIdentifier(effectiveResult.receiptSchemaVersion, "receiptSchemaVersion"),
      catalogEvidence: effectiveResult.catalogEvidence ?? null,
      canaryKind: input.route.canary.kind,
      canaryNonce: effectiveResult.expectedNonce,
      consecutiveFailures,
      observedAt: now,
      expiresAt,
      backoffUntil,
      correlationId,
      traceId: traceId(correlationId),
      spanId: spanId(`${correlationId}:${input.routeId}`),
      details: normalizedDetails(effectiveResult),
      updatedAt: now,
    };
    const updateValues = {
      ...values,
      status: classification.status === "healthy"
        ? "healthy"
        : classification.status === "quarantined"
          ? "quarantined"
          : sql<string>`case
              when ${profitFlywheelProviderHealth.consecutiveFailures} + 1 >= ${input.route.rollback.failureThreshold}
                then 'quarantined'
              else 'failed'
            end`,
      consecutiveFailures: classification.status === "healthy"
        ? 0
        : sql<number>`${profitFlywheelProviderHealth.consecutiveFailures} + 1`,
    };
    const row = await db
      .insert(profitFlywheelProviderHealth)
      .values(values)
      .onConflictDoUpdate({
        target: [
          profitFlywheelProviderHealth.companyId,
          profitFlywheelProviderHealth.routeId,
          profitFlywheelProviderHealth.policySha256,
          profitFlywheelProviderHealth.policySchemaSha256,
        ],
        set: updateValues,
        setWhere: lte(profitFlywheelProviderHealth.observedAt, now),
      })
      .returning()
      .then((rows) => rows[0]);
    const effectiveRow = row ?? await db.select().from(profitFlywheelProviderHealth).where(and(
      eq(profitFlywheelProviderHealth.companyId, input.companyId),
      eq(profitFlywheelProviderHealth.routeId, input.routeId),
      eq(profitFlywheelProviderHealth.policySha256, input.policySha256),
      eq(profitFlywheelProviderHealth.policySchemaSha256, input.policySchemaSha256),
    )).then((rows) => rows[0]);
    if (input.reconcileBlocker !== false) {
      await upsertCredentialBlocker({
        companyId: input.companyId,
        now,
        policySha256: input.policySha256,
        policySchemaSha256: input.policySchemaSha256,
        policy: input.policy,
      });
    }
    if (effectiveRow?.status === "healthy") notifyProfitFlywheelReconciliation();
    return effectiveRow;
  }

  async function runBoundedCanaries(input: {
    companyId: string;
    policy: ProviderPolicyV2;
    policySha256: string;
    policySchemaSha256: string;
    execute: (routeId: string, route: ProviderPolicyRoute, nonce: string, correlationId: string) => Promise<Omit<ProviderCanaryExecutionResult, "expectedNonce">>;
    routeIds?: string[];
    now?: Date;
  }) {
    const routeIds = input.routeIds ?? Object.keys(input.policy.routes);
    const results = [];
    for (const routeId of routeIds) {
      const route = input.policy.routes[routeId];
      if (!route) throw new Error(`Unknown provider policy route ${routeId}`);
      const nonce = `PAPERCLIP_CANARY_${randomUUID()}`;
      const correlationId = `provider-canary-${randomUUID()}`;
      let execution: Omit<ProviderCanaryExecutionResult, "expectedNonce">;
      try {
        execution = await input.execute(routeId, route, nonce, correlationId);
      } catch (error) {
        execution = {
          exitCode: null,
          finalResponse: null,
          resolvedModel: null,
          resolvedVersion: null,
          receiptPath: null,
          receiptSha256: null,
          failureClass: classifyProviderCanaryExecutionException(error),
          failureDetail: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(await recordResult({
        companyId: input.companyId,
        routeId,
        route,
        policySha256: input.policySha256,
        policySchemaSha256: input.policySchemaSha256,
        policy: input.policy,
        result: { ...execution, expectedNonce: nonce },
        now: input.now,
        correlationId,
        reconcileBlocker: false,
      }));
    }
    await upsertCredentialBlocker({
      companyId: input.companyId,
      now: input.now ?? new Date(),
      policySha256: input.policySha256,
      policySchemaSha256: input.policySchemaSha256,
      policy: input.policy,
    });
    return results;
  }

  async function resolveHealthyAlias(input: {
    companyId: string;
    policy: ProviderPolicyV2;
    policySha256: string;
    policySchemaSha256: string;
    alias: ProfitFlywheelCapabilityAlias;
    excludedProviderFamily?: string | null;
    release?: boolean;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const healthRows = await db
      .select()
      .from(profitFlywheelProviderHealth)
      .where(and(
        eq(profitFlywheelProviderHealth.companyId, input.companyId),
        eq(profitFlywheelProviderHealth.policySha256, input.policySha256),
        eq(profitFlywheelProviderHealth.policySchemaSha256, input.policySchemaSha256),
      ));
    const healthy = new Map<string, typeof profitFlywheelProviderHealth.$inferSelect>();
    for (const row of healthRows) {
      const route = input.policy.routes[row.routeId];
      if (route && await verifyHealthyRow({
        row,
        routeId: row.routeId,
        route,
        policy: input.policy,
        policySha256: input.policySha256,
        policySchemaSha256: input.policySchemaSha256,
        now,
      })) healthy.set(row.routeId, row);
    }
    const unavailable = Object.keys(input.policy.routes).filter((routeId) => {
      const row = healthy.get(routeId);
      if (!row) return true;
      const route = input.policy.routes[routeId];
      return route.model.kind === "exact" && row.resolvedModel !== route.model.value;
    });
    const resolved = resolveProviderAlias({
      policy: input.policy,
      alias: input.alias,
      unavailableRouteIds: unavailable,
      excludedProviderFamily: input.excludedProviderFamily,
      release: input.release,
    });
    return { ...resolved, health: healthy.get(resolved.route.id)! };
  }

  return {
    recordResult,
    runBoundedCanaries,
    resolveHealthyAlias,
    upsertCredentialBlocker,
  };
}
