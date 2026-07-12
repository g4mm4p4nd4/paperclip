import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionResult } from "../adapters/index.js";
import { containsSecretLikeText } from "../redaction.js";
import {
  buildProviderPolicyRouteCore,
  type ProviderPolicyRoute,
  type ProviderPolicyV2,
} from "./provider-policy.js";
import {
  completionCanaryRouteSha256,
  providerPolicyRouteCoreSha256,
} from "./provider-route-hash.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_SCHEMA = "paperclip.provider-result-receipt.v1";
export const PROVIDER_RESULT_RECEIPT_TTL_MS = 5 * 60_000;

export type VerifiedProviderRuntimeIdentity = {
  commandRealpath: string;
  commandSha256: string;
  observedVersion: string;
  runtimeClosureSha256: string;
  repoRoot?: string;
  gitRevision?: string;
  gitTree?: string;
  criticalModulesSha256?: string;
  dirty?: boolean;
};

type CanonicalUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compromise(message: string): never {
  const error = new Error(`provider_security_compromise: ${message}`);
  (error as Error & { code: string }).code = "provider_security_compromise";
  throw error;
}

function expectedModel(route: ProviderPolicyRoute) {
  return route.model.kind === "exact" ? route.model.value : route.model.selector;
}

function exactNonNegativeInteger(value: unknown, field: string, fallback?: number) {
  const candidate = value == null && fallback !== undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0) {
    compromise(`provider usage ${field} is missing, fractional, negative, or non-numeric`);
  }
  return candidate;
}

function canonicalUsage(value: unknown): CanonicalUsage {
  const usage = record(value);
  const inputTokens = exactNonNegativeInteger(usage.inputTokens, "inputTokens");
  const outputTokens = exactNonNegativeInteger(usage.outputTokens, "outputTokens");
  const cachedInputTokens = exactNonNegativeInteger(usage.cachedInputTokens, "cachedInputTokens", 0);
  const reasoningTokens = exactNonNegativeInteger(usage.reasoningTokens, "reasoningTokens", 0);
  const totalTokens = inputTokens + outputTokens;
  if (cachedInputTokens > inputTokens) {
    compromise("provider usage cachedInputTokens exceeds inputTokens");
  }
  if (outputTokens === 0 || totalTokens === 0) {
    compromise("successful provider usage must prove at least one output token and a non-zero total");
  }
  if (usage.totalTokens != null && exactNonNegativeInteger(usage.totalTokens, "totalTokens") !== totalTokens) {
    compromise("provider usage totalTokens does not equal inputTokens + outputTokens");
  }
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens };
}

export function providerBudgetTokens(usage: Pick<CanonicalUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">) {
  return Math.max(0, usage.inputTokens - usage.cachedInputTokens) + usage.outputTokens;
}

function usageMatches(receiptValue: unknown, expected: CanonicalUsage) {
  const observed = canonicalUsage(receiptValue);
  return Object.entries(expected).every(([key, value]) => observed[key as keyof CanonicalUsage] === value);
}

function containsExactSecret(value: string, exactValues: Iterable<string> | undefined) {
  if (!exactValues) return false;
  for (const secret of exactValues) {
    if (secret.length >= 8 && value.includes(secret)) return true;
  }
  return false;
}

function assertSafeFinalResponse(summary: string, exactValues: Iterable<string> | undefined) {
  if (containsSecretLikeText(summary) || containsExactSecret(summary, exactValues)) {
    compromise("unsafe_final_response_secret: final response contained credential material and was refused before artifact creation");
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ensureCanonicalDirectory(directory: string, create: boolean) {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory) || directory.includes("\0")) compromise("provider result directory must be an absolute safe path");
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let observed = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!observed && create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      observed = await lstat(current);
    }
    if (!observed) compromise("provider result directory is missing");
    if (!observed.isDirectory() || observed.isSymbolicLink()) compromise("provider result path contains a symlink or non-directory ancestor");
    if (await realpath(current) !== current) compromise("provider result path is not canonical");
  }
  return resolved;
}

function safeRunSegment(runId: string) {
  const segment = runId.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (!segment || segment === "." || segment === ".." || segment.length > 200) compromise("provider result run id is unsafe");
  return segment;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareProviderResultArtifactRoot(root: string, runId: string) {
  const artifactRoot = await ensureCanonicalDirectory(root, true);
  await chmod(artifactRoot, 0o700);
  const runRoot = await ensureCanonicalDirectory(path.join(artifactRoot, safeRunSegment(runId)), true);
  if (!isWithin(artifactRoot, runRoot) || runRoot === artifactRoot) compromise("provider result run directory escaped its root");
  await chmod(runRoot, 0o700);
  await syncDirectory(artifactRoot);
  return { artifactRoot, runRoot };
}

async function readBoundedCanonicalFile(filePath: string, maxBytes: number) {
  const resolved = path.resolve(filePath);
  const parent = await ensureCanonicalDirectory(path.dirname(resolved), false);
  if (parent !== path.dirname(resolved)) compromise("provider result file parent is not canonical");
  const before = await lstat(resolved).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    compromise("provider result artifact is missing, non-regular, symlinked, or oversized");
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
      compromise("provider result artifact changed while being opened");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) compromise("provider result artifact changed while being read");
    if (await realpath(resolved) !== resolved) compromise("provider result artifact is not canonical");
    return { bytes, observed: opened, path: resolved };
  } finally {
    await handle.close();
  }
}

async function persistDirectFinalArtifact(root: string, runId: string, summary: string, maxBytes: number) {
  const { artifactRoot, runRoot } = await prepareProviderResultArtifactRoot(root, runId);
  const bytes = Buffer.from(summary, "utf8");
  if (bytes.length > maxBytes) compromise("direct provider final artifact exceeds its signed output budget");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactPath = path.join(runRoot, `${sha256}.txt`);
  const handle = await open(
    artifactPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    return null;
  });
  if (handle) {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(runRoot);
  }
  const persisted = await readBoundedCanonicalFile(artifactPath, maxBytes);
  if (!persisted.bytes.equals(bytes)) compromise("existing direct provider artifact differs from the content-addressed response");
  if (process.platform !== "win32" && (persisted.observed.mode & 0o777) !== 0o400) {
    compromise("direct provider final artifact is not mode 0400");
  }
  if (!isWithin(artifactRoot, persisted.path)) compromise("direct provider artifact escaped its server-owned root");
  return { kind: "content_addressed_final_response", path: persisted.path, sha256, bytes: bytes.length, mode: "0400" };
}

async function verifyFinalArtifact(root: string, runId: string, value: unknown, expectedSummary: string, maxBytes: number) {
  const artifact = record(value);
  const artifactRoot = await ensureCanonicalDirectory(root, false);
  const artifactPath = text(artifact.path);
  const expectedSha256 = text(artifact.sha256);
  if (!artifactPath || !expectedSha256 || !SHA256.test(expectedSha256)) compromise("final artifact path/hash is missing");
  const resolvedPath = path.resolve(artifactPath);
  const expectedRunRoot = path.join(artifactRoot, safeRunSegment(runId));
  if (!isWithin(expectedRunRoot, resolvedPath) || resolvedPath === expectedRunRoot) {
    compromise("final artifact escapes the server-owned run receipt root");
  }
  const persisted = await readBoundedCanonicalFile(resolvedPath, maxBytes);
  if (process.platform !== "win32" && (persisted.observed.mode & 0o777) !== 0o400) compromise("final artifact is not mode 0400");
  if (
    artifact.kind !== "content_addressed_final_response" ||
    artifact.mode !== "0400" ||
    Number(artifact.bytes) !== persisted.bytes.length ||
    createHash("sha256").update(persisted.bytes).digest("hex") !== expectedSha256
  ) {
    compromise("final artifact contract, byte count, mode, or digest mismatch");
  }
  if (persisted.bytes.toString("utf8") !== expectedSummary) compromise("final artifact does not contain the accepted final response");
  return { ...artifact, path: persisted.path, sha256: expectedSha256, bytes: persisted.bytes.length, mode: "0400" };
}

function providerAliases(adapterType: string, routeProvider: string) {
  if (adapterType === "codex_local") return new Set([routeProvider, "openai"]);
  if (adapterType === "claude_local") return new Set([routeProvider, "anthropic"]);
  if (adapterType === "gemini_local") return new Set([routeProvider, "google"]);
  return new Set([routeProvider]);
}

function expectedServerAdapter(route: ProviderPolicyRoute) {
  switch (route.runtimeBinding.adapterType) {
    case "codex_cli": return "codex_local";
    case "claude_cli": return "claude_local";
    case "gemini_cli": return "gemini_local";
    default: return route.runtimeBinding.adapterType;
  }
}

function runtimeReceiptFields(identity: VerifiedProviderRuntimeIdentity, route: ProviderPolicyRoute) {
  return {
    runtimeVersion: identity.observedVersion,
    commandRealpath: identity.commandRealpath,
    commandSha256: identity.commandSha256,
    runtimeClosureId: route.runtimeBinding.runtimeClosureId,
    runtimeClosureSha256: identity.runtimeClosureSha256,
    repoRoot: identity.repoRoot ?? null,
    gitRevision: identity.gitRevision ?? null,
    gitTree: identity.gitTree ?? null,
    gitDirty: identity.dirty ?? false,
    criticalModules: [...(route.runtimeBinding.criticalModules ?? [])].sort(),
    criticalModulesSha256: identity.criticalModulesSha256 ?? null,
  };
}

export async function attestPolicyOwnedSuccessfulResult(input: {
  runId: string;
  adapterType: string;
  routeId: string;
  route: ProviderPolicyRoute;
  resolvedRoute: Record<string, unknown>;
  providerPolicySha256: string;
  providerPolicySchemaSha256: string;
  resolvedRouteSha256: string;
  expectedRouteCoreSha256: string;
  transcriptEpoch: number;
  budget: ProviderPolicyV2["budgetClasses"][string];
  runtimeIdentity: VerifiedProviderRuntimeIdentity;
  result: AdapterExecutionResult;
  artifactRoot: string;
  exactRedactionValues?: Iterable<string>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const result = input.result;
  if (input.adapterType !== expectedServerAdapter(input.route)) {
    compromise("active adapter type does not match the policy runtime binding");
  }
  const summary = text(result.summary);
  if (result.exitCode !== 0 || result.signal || result.timedOut || result.errorCode || result.errorMessage || !summary) {
    compromise("a non-successful or incomplete adapter result cannot be attested");
  }
  assertSafeFinalResponse(summary, input.exactRedactionValues);
  if (summary.length > input.budget.maxOutputChars) compromise("final response exceeds the signed output budget");
  const summaryBytesLimit = Math.max(input.budget.maxOutputChars * 4, 1);

  const expectedCore = providerPolicyRouteCoreSha256(buildProviderPolicyRouteCore({
    routeId: input.routeId,
    route: input.route,
  }));
  if (expectedCore !== input.expectedRouteCoreSha256 || providerPolicyRouteCoreSha256(input.resolvedRoute) !== expectedCore) {
    compromise("policy route core hash does not recompute from both policy and resolved route");
  }
  if (completionCanaryRouteSha256(input.resolvedRoute) !== input.resolvedRouteSha256) {
    compromise("resolved provider route hash does not recompute");
  }

  const model = expectedModel(input.route);
  if (text(result.model) !== model || !providerAliases(input.adapterType, input.route.provider).has(text(result.provider) ?? "")) {
    compromise("observed provider/model does not match the resolved route");
  }
  const expectedUsage = canonicalUsage(result.usage);
  if (providerBudgetTokens(expectedUsage) > input.budget.maxTotalTokens) {
    compromise("uncached usage is above the signed token budget");
  }
  const usageSource = text(record(result.usage).source) ?? "adapter_result";
  const finalResponseSha256 = createHash("sha256").update(summary, "utf8").digest("hex");
  const runtimeFields = runtimeReceiptFields(input.runtimeIdentity, input.route);

  let receipt = record(result.providerResultReceipt);
  if (input.adapterType !== "hermes_local") {
    const artifact = await persistDirectFinalArtifact(input.artifactRoot, input.runId, summary, summaryBytesLimit);
    const observedAt = now.toISOString();
    receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      routeId: input.routeId,
      provider: input.route.provider,
      providerFamily: input.route.providerFamily,
      model,
      modelVersion: input.route.model.version,
      observedProvider: result.provider,
      observedModel: result.model,
      observedModelVersion: input.route.model.version,
      observedModelVersionSource: input.route.discovery.versionSource,
      providerPolicySha256: input.providerPolicySha256,
      providerPolicySchemaSha256: input.providerPolicySchemaSha256,
      policyRouteCoreSha256: input.expectedRouteCoreSha256,
      resolvedRouteSha256: input.resolvedRouteSha256,
      ...runtimeFields,
      runtimeIdentityVerified: true,
      runtimeBindingMatched: true,
      runtimeBindingMismatches: [],
      routeIdentityMatched: true,
      routeIdentityMismatches: [],
      transcriptEpoch: input.transcriptEpoch,
      status: "succeeded",
      failureClass: null,
      usage: expectedUsage,
      usageScope: usageSource,
      observedAt,
      expiresAt: new Date(now.getTime() + PROVIDER_RESULT_RECEIPT_TTL_MS).toISOString(),
      finalResponseComplete: true,
      finalResponseSha256,
      finalResponseChars: summary.length,
      finalResponseSource: "adapter_result",
      finalResponseArtifact: artifact,
    };
  }

  const mismatches: string[] = [];
  const expected: Array<[string, unknown]> = [
    ["schemaVersion", RECEIPT_SCHEMA],
    ["routeId", input.routeId],
    ["provider", input.route.provider],
    ["providerFamily", input.route.providerFamily],
    ["model", model],
    ["modelVersion", input.route.model.version],
    ["providerPolicySha256", input.providerPolicySha256],
    ["providerPolicySchemaSha256", input.providerPolicySchemaSha256],
    ["policyRouteCoreSha256", input.expectedRouteCoreSha256],
    ["resolvedRouteSha256", input.resolvedRouteSha256],
    ...Object.entries(runtimeFields),
    ["transcriptEpoch", input.transcriptEpoch],
    ["status", "succeeded"],
    ["failureClass", null],
    ["usageScope", usageSource],
    ["finalResponseComplete", true],
    ["finalResponseSha256", finalResponseSha256],
    ["finalResponseChars", summary.length],
    ["runtimeIdentityVerified", true],
    ["runtimeBindingMatched", true],
    ["routeIdentityMatched", true],
  ];
  for (const [field, value] of expected) {
    const observed = receipt[field];
    const matched = value && typeof value === "object"
      ? JSON.stringify(observed) === JSON.stringify(value)
      : observed === value;
    if (!matched) mismatches.push(field);
  }
  if (!Array.isArray(receipt.runtimeBindingMismatches) || receipt.runtimeBindingMismatches.length) mismatches.push("runtimeBindingMismatches");
  if (!Array.isArray(receipt.routeIdentityMismatches) || receipt.routeIdentityMismatches.length) mismatches.push("routeIdentityMismatches");
  if (!providerAliases(input.adapterType, input.route.provider).has(text(receipt.observedProvider) ?? "")) mismatches.push("observedProvider");
  if (text(receipt.observedModel) !== model) mismatches.push("observedModel");
  if (text(receipt.observedModelVersion) !== input.route.model.version) mismatches.push("observedModelVersion");
  if (!text(receipt.observedModelVersionSource)) mismatches.push("observedModelVersionSource");
  if (!text(receipt.finalResponseSource)) mismatches.push("finalResponseSource");
  try {
    if (!usageMatches(receipt.usage, expectedUsage)) mismatches.push("usage");
  } catch {
    mismatches.push("usage");
  }
  const observedAt = Date.parse(text(receipt.observedAt) ?? "");
  const expiresAt = Date.parse(text(receipt.expiresAt) ?? "");
  if (!Number.isFinite(observedAt) || observedAt > now.getTime() + 60_000 || now.getTime() - observedAt > PROVIDER_RESULT_RECEIPT_TTL_MS) mismatches.push("observedAt");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt <= observedAt || expiresAt - observedAt > PROVIDER_RESULT_RECEIPT_TTL_MS + 60_000) mismatches.push("expiresAt");
  if (mismatches.length) compromise(`provider result receipt mismatch: ${Array.from(new Set(mismatches)).join(", ")}`);
  const artifact = await verifyFinalArtifact(input.artifactRoot, input.runId, receipt.finalResponseArtifact, summary, summaryBytesLimit);
  if (receipt.finalResponseSha256 !== artifact.sha256) compromise("receipt final-response hash differs from its immutable artifact");
  return { receipt: { ...receipt, finalResponseArtifact: artifact }, observedAt: new Date(observedAt).toISOString() };
}
