import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, createDb, profitFlywheelProviderHealth, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { providerCanaryService, type ProviderCanaryExecutionResult, type ProviderCanaryFailureClass } from "../services/provider-canaries.js";
import {
  buildProviderPolicyRouteCore,
  buildResolvedProviderRoute,
  loadProviderPolicyV2,
  type ProviderPolicyRoute,
  type ProviderPolicyV2,
} from "../services/provider-policy.js";
import { providerPolicyRouteCoreSha256 } from "../services/provider-route-hash.js";
import { secretService } from "../services/secrets.js";
import {
  generateHermesProviderCatalogEvidence,
  hashHermesCompletionCanaryRoute,
  runHermesCompletionCanary,
} from "../services/hermes-canary-receipt.js";
import { verifyHermesExternalAdapterBinding } from "../services/provider-source-binding.js";
import { verifyProviderPolicyRuntimeClosure } from "../services/provider-runtime-closure.js";
import { prepareProviderRuntimeProfile } from "../services/provider-runtime-profile.js";
import {
  prepareTrustedReceiptDirectory,
  readTrustedFile,
  requireTrustedDirectory,
} from "./trusted-receipt-directory.js";

const PERSONAL_CONTEXT_MARKER = /(?:\.codex\/memories|MEMORY\.md|AGENTS\.md|personal memory|David)/i;
const CODEX_DISABLED_FEATURES = [
  "apps", "browser_use", "browser_use_external", "computer_use", "goals", "hooks", "image_generation",
  "in_app_browser", "multi_agent", "plugin_sharing", "plugins", "skill_mcp_dependency_install",
  "tool_suggest", "workspace_dependencies",
] as const;

type Usage = NonNullable<ProviderCanaryExecutionResult["usage"]>;
type RuntimeIdentity = {
  commandRealpath: string;
  commandSha256: string;
  observedVersion: string;
  runtimeClosureId: string;
  runtimeClosureSha256: string;
  repoRoot?: string;
  gitRevision?: string;
  gitTree?: string;
  criticalModulesSha256?: string;
  dirty?: boolean;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonLines(text: string): unknown[] {
  return text.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }).filter((value) => value !== null);
}

function walk(value: unknown, visitor: (record: Record<string, unknown>) => void) {
  if (Array.isArray(value)) return value.forEach((entry) => walk(entry, visitor));
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visitor(record);
  Object.values(record).forEach((entry) => walk(entry, visitor));
}

function terminalCanaryNonce(document: unknown, nonce: string): string | null {
  const record = asRecord(document);
  if (record.type === "item.completed") {
    const item = asRecord(record.item);
    return item.type === "agent_message" && item.text === nonce ? nonce : null;
  }
  if (record.type === "result" && record.subtype === "success" && record.result === nonce) {
    return nonce;
  }
  if (record.type === "message" && record.role === "assistant" && record.content === nonce) {
    return nonce;
  }
  if (record.type === "result" && record.response === nonce && asRecord(record.stats).models) {
    return nonce;
  }
  return null;
}

export function parseProviderCanaryStructuredOutput(stdout: string, nonce: string): {
  finalResponse: string | null;
  model: string | null;
  version: string | null;
  usage: Usage | null;
} {
  const documents = parseJsonLines(stdout);
  if (documents.length === 0) {
    try { documents.push(JSON.parse(stdout) as unknown); } catch { /* plain CLI output */ }
  }
  const parsed: {
    finalResponse: string | null;
    model: string | null;
    version: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  } = {
    finalResponse: null,
    model: null,
    version: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
  for (const document of documents) {
    if (!parsed.finalResponse) parsed.finalResponse = terminalCanaryNonce(document, nonce);
    walk(document, (record) => {
      for (const key of ["model", "model_name", "modelName"]) {
        if (!parsed.model && typeof record[key] === "string") parsed.model = String(record[key]);
      }
      for (const key of ["model_version", "modelVersion", "resolved_version", "resolvedVersion"]) {
        if (!parsed.version && typeof record[key] === "string") parsed.version = String(record[key]);
      }
      for (const key of ["input_tokens", "inputTokens", "promptTokenCount", "input"]) {
        const value = number(record[key]);
        if (value !== null) parsed.inputTokens = Math.max(parsed.inputTokens ?? 0, value);
      }
      for (const key of ["output_tokens", "outputTokens", "candidatesTokenCount", "output"]) {
        const value = number(record[key]);
        if (value !== null) parsed.outputTokens = Math.max(parsed.outputTokens ?? 0, value);
      }
      for (const key of ["cost_usd", "costUsd", "total_cost_usd"]) {
        const value = number(record[key]);
        if (value !== null) parsed.costUsd = value;
      }
    });
  }
  const usage: Usage | null = parsed.inputTokens !== null && parsed.outputTokens !== null
    ? { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, totalTokens: parsed.inputTokens + parsed.outputTokens, costUsd: parsed.costUsd, accountingMode: "telemetry_only" }
    : null;
  return { finalResponse: parsed.finalResponse, model: parsed.model, version: parsed.version, usage };
}

export async function boundedProviderCanaryExec(command: string, args: string[], input: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number }) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFileCallback(command, args, {
      cwd: input.cwd,
      env: input.env,
      timeout: input.timeoutSeconds * 1000,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      const candidate = error as Error & { code?: string | number };
      resolve({
        exitCode: typeof candidate.code === "number" ? candidate.code : null,
        stdout: stdout ?? "",
        stderr: stderr || candidate.message,
      });
    });
    // Subscription CLIs probe stdin even when the complete prompt is supplied
    // on argv.  An unclosed pipe makes a bounded canary hang until timeout.
    child.stdin?.end();
  });
}

export function classifyProviderCanaryFailureText(text: string): ProviderCanaryFailureClass {
  if (/ineligible.?tier|no longer supported|unsupported (?:client|tier)|migrate to .*suite/i.test(text)) {
    return "provider_capability_mismatch";
  }
  if (/auth|unauthori[sz]ed|credential|login|sign.?in|401/i.test(text)) return "provider_auth";
  if (/billing|payment|subscription|credit/i.test(text)) return "provider_billing";
  if (/quota|capacity|usage limit/i.test(text)) return "provider_quota";
  if (/rate.?limit|429/i.test(text)) return "provider_rate_limit";
  if (/model not found|unsupported model|does not have access|capability/i.test(text)) return "provider_capability_mismatch";
  if (/timeout|timed out|network|ECONN|DNS|resolve host/i.test(text)) return "transient_network";
  return "process_lost";
}

async function criticalModulesSha256(repoRoot: string, modules: string[]) {
  const hash = createHash("sha256");
  for (const relativePath of [...modules].sort()) {
    hash.update(relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(await readFile(path.join(repoRoot, relativePath)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export async function verifyProviderRuntimeIdentity(
  route: ProviderPolicyRoute,
  options: { cwd?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<RuntimeIdentity> {
  const environment = options.environment ?? {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    LANG: process.env.LANG,
  };
  const verified = await verifyProviderPolicyRuntimeClosure(route, {
    cwd: options.cwd ?? os.tmpdir(),
    environment,
  });
  const identity: RuntimeIdentity = {
    commandRealpath: verified.commandRealpath,
    commandSha256: verified.commandSha256,
    observedVersion: verified.observedVersion,
    runtimeClosureId: verified.runtimeClosureId,
    runtimeClosureSha256: verified.runtimeClosureSha256,
  };
  if (route.runtimeBinding.repoRoot) {
    const repoRoot = await realpath(route.runtimeBinding.repoRoot);
    const [gitRevision, gitTree, status] = await Promise.all([
      boundedProviderCanaryExec("git", ["-C", repoRoot, "rev-parse", "HEAD"], { cwd: repoRoot, env: { PATH: environment.PATH }, timeoutSeconds: 10 }),
      boundedProviderCanaryExec("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], { cwd: repoRoot, env: { PATH: environment.PATH }, timeoutSeconds: 10 }),
      boundedProviderCanaryExec("git", ["-C", repoRoot, "status", "--porcelain"], { cwd: repoRoot, env: { PATH: environment.PATH }, timeoutSeconds: 10 }),
    ]);
    Object.assign(identity, {
      repoRoot,
      gitRevision: gitRevision.stdout.trim(),
      gitTree: gitTree.stdout.trim(),
      criticalModulesSha256: await criticalModulesSha256(repoRoot, route.runtimeBinding.criticalModules ?? []),
      dirty: Boolean(status.stdout.trim()),
    });
    if (
      identity.gitRevision !== route.runtimeBinding.gitRevision || identity.gitTree !== route.runtimeBinding.gitTree ||
      identity.criticalModulesSha256 !== route.runtimeBinding.criticalModulesSha256 || identity.dirty
    ) {
      throw new Error("Runtime source revision/tree/critical-module hash is dirty or does not match policy");
    }
  }
  return identity;
}

async function resolveCredential(db: Db, companyId: string, route: ProviderPolicyRoute) {
  if (!route.credentialRef.startsWith("company-secret://")) return null;
  const name = route.credentialRef.slice("company-secret://".length);
  const svc = secretService(db);
  const secret = await svc.getByName(companyId, name);
  if (!secret) throw new Error(`Company secret ${name} is missing`);
  return { name, value: await svc.resolveSecretValue(companyId, secret.id, "latest") };
}

export function buildProviderCanaryIsolatedEnv(input: {
  root: string;
  profile: string;
  credential: { name: string; value: string } | null;
  runtimeEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  if (!path.isAbsolute(input.root) || !path.isAbsolute(input.profile)) {
    throw new Error("Provider canary root and profile must be absolute");
  }
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: input.root,
    HOME: input.profile,
    ...input.runtimeEnv,
    ...(input.credential ? { [input.credential.name]: input.credential.value } : {}),
  };
}

function redactExactValues(text: string, exactValues: ReadonlySet<string>) {
  let redacted = text;
  for (const value of exactValues) redacted = redacted.split(value).join("[REDACTED]");
  return redacted;
}

function exactModel(route: ProviderPolicyRoute) {
  if (route.model.kind !== "exact") throw new Error("Bounded canaries require an exact model route");
  return route.model.value;
}

function normalizedHermesCanaryFailure(value: unknown): ProviderCanaryFailureClass {
  const failure = typeof value === "string" ? value : "provider_malformed_response";
  if (new Set<ProviderCanaryFailureClass>([
    "provider_auth", "provider_billing", "provider_capability_mismatch", "provider_malformed_response",
    "provider_quota", "provider_rate_limit", "provider_security_compromise", "transient_network", "process_lost",
  ]).has(failure as ProviderCanaryFailureClass)) return failure as ProviderCanaryFailureClass;
  return failure === "canary_input_budget_exceeded" || failure === "canary_usage_unverified"
    ? "provider_malformed_response"
    : classifyProviderCanaryFailureText(failure);
}

async function executeHermesRoute(db: Db, input: {
  companyId: string;
  routeId: string;
  route: ProviderPolicyRoute;
  nonce: string;
  correlationId: string;
  policySha256: string;
  policySchemaSha256: string;
  policy: ProviderPolicyV2;
  receiptRoot: string;
}): Promise<Omit<ProviderCanaryExecutionResult, "expectedNonce">> {
  const adapterIdentity = await verifyHermesExternalAdapterBinding(input.route);
  const adapterRoot = adapterIdentity.repoRoot;
  const credential = await resolveCredential(db, input.companyId, input.route);
  const credentialEnvName = input.route.runtimeBinding.credentialEnvNames[0];
  const config = credential && credentialEnvName
    ? { env: { [credentialEnvName]: credential.value } }
    : { env: {} };
  let resolvedRoute = buildResolvedProviderRoute({
    policy: input.policy,
    policySha256: input.policySha256,
    policySchemaSha256: input.policySchemaSha256,
    routeId: input.routeId,
  });
  let catalogEvidence: ProviderCanaryExecutionResult["catalogEvidence"] = null;
  if (input.route.discovery.authority === "models.dev") {
    await verifyHermesExternalAdapterBinding(input.route);
    const evidence = await generateHermesProviderCatalogEvidence({
      route: resolvedRoute,
      policyRouteCoreSha256: resolvedRoute.policyRouteCoreSha256,
      rawCatalogPath: process.env.HERMES_MODELS_DEV_CACHE ?? path.join(os.homedir(), ".hermes", "models_dev_cache.json"),
      nonce: `${input.nonce}_CATALOG`,
      correlationId: `${input.correlationId}-catalog`,
      receiptRoot: input.receiptRoot,
      timeoutMs: input.route.canary.timeoutSeconds * 1000,
      ttlMs: input.route.discovery.refreshSeconds * 1000,
      config,
    }, adapterRoot);
    if (evidence.ok !== true || !evidence.catalogEvidence) {
      return {
        exitCode: 1,
        finalResponse: null,
        resolvedModel: null,
        resolvedVersion: null,
        receiptPath: null,
        receiptSha256: null,
        failureClass: normalizedHermesCanaryFailure(evidence.failureClass),
        failureDetail: "Hermes catalog/direct-health evidence did not pass",
      };
    }
    catalogEvidence = evidence.catalogEvidence as NonNullable<ProviderCanaryExecutionResult["catalogEvidence"]>;
    resolvedRoute = buildResolvedProviderRoute({
      policy: input.policy,
      policySha256: input.policySha256,
      policySchemaSha256: input.policySchemaSha256,
      routeId: input.routeId,
      catalogEvidence,
    });
  }
  await verifyHermesExternalAdapterBinding(input.route);
  const adapterRouteHash = await hashHermesCompletionCanaryRoute(resolvedRoute, adapterRoot);
  if (adapterRouteHash !== resolvedRoute.resolvedRouteSha256) {
    throw new Error("Paperclip and the external Hermes adapter disagree on the resolved route hash");
  }
  await verifyHermesExternalAdapterBinding(input.route);
  const result = await runHermesCompletionCanary({
    command: input.route.runtimeBinding.commandRealpath,
    route: resolvedRoute,
    resolvedRouteSha256: resolvedRoute.resolvedRouteSha256,
    providerPolicySha256: input.policySha256,
    providerPolicySchemaSha256: input.policySchemaSha256,
    nonce: input.nonce,
    correlationId: input.correlationId,
    receiptRoot: input.receiptRoot,
    timeoutMs: input.route.canary.timeoutSeconds * 1000,
    ttlMs: input.route.discovery.refreshSeconds * 1000,
    config,
  }, adapterRoot);
  await verifyHermesExternalAdapterBinding(input.route);
  const receipt = asRecord(result.receipt);
  const artifact = asRecord(result.artifact);
  const processOutcome = asRecord(receipt.processOutcome);
  const rawUsage = asRecord(receipt.usage);
  const inputTokens = number(rawUsage.inputTokens);
  const outputTokens = number(rawUsage.outputTokens);
  const usage = inputTokens !== null && outputTokens !== null
    ? {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: number(rawUsage.costUsd),
        accountingMode: "telemetry_only" as const,
      }
    : null;
  const healthy = result.ok === true;
  return {
    exitCode: number(processOutcome.exitCode),
    finalResponse: healthy && receipt.finalResponseComplete === true ? input.nonce : null,
    resolvedModel: typeof receipt.model === "string" ? receipt.model : null,
    resolvedVersion: typeof receipt.modelVersion === "string" ? receipt.modelVersion : null,
    receiptPath: typeof artifact.path === "string" ? artifact.path : null,
    receiptSha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
    receiptSchemaVersion: typeof receipt.schemaVersion === "string" ? receipt.schemaVersion : null,
    catalogEvidence,
    usage,
    failureClass: healthy ? null : normalizedHermesCanaryFailure(result.failureClass ?? receipt.failureClass),
    failureDetail: healthy ? null : "Verified native Hermes canary did not satisfy the signed route",
  };
}

export async function executeProviderPolicyRoute(db: Db, input: {
  companyId: string;
  routeId: string;
  route: ProviderPolicyRoute;
  nonce: string;
  correlationId: string;
  policySha256: string;
  policySchemaSha256: string;
  policy: ProviderPolicyV2;
  receiptRoot: string;
}): Promise<Omit<ProviderCanaryExecutionResult, "expectedNonce">> {
  const identity = await verifyProviderRuntimeIdentity(input.route);
  if (input.route.runtimeBinding.adapterType === "hermes_local") {
    return executeHermesRoute(db, input);
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `paperclip-canary-${input.routeId}-`)));
  const cwd = path.join(root, "cwd");
  await mkdir(cwd);
  try {
    const credential = await resolveCredential(db, input.companyId, input.route);
    const preparedProfile = await prepareProviderRuntimeProfile({
      companyId: input.companyId,
      executionId: input.correlationId,
      route: input.route,
      instanceRoot: root,
      environment: process.env,
    });
    const profile = preparedProfile.env.HOME;
    if (!profile) throw new Error("Managed provider runtime profile did not provide an isolated HOME");
    const env = buildProviderCanaryIsolatedEnv({
      root,
      profile,
      credential,
      runtimeEnv: preparedProfile.env,
    });
    const model = exactModel(input.route);
    const prompt = `Return exactly ${input.nonce} as your complete final response. Do not call tools, add punctuation, add formatting, or include any other text.`;
    let args: string[];
    if (input.route.runtimeBinding.adapterType === "codex_cli") {
      args = ["exec", "--model", model, "-c", "model_reasoning_effort=\"low\"", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]), prompt];
    } else if (input.route.runtimeBinding.adapterType === "claude_cli") {
      args = ["--print", "--model", model, "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--mcp-config", "{\"mcpServers\":{}}", "--strict-mcp-config", "--permission-mode", "plan", prompt];
    } else if (input.route.runtimeBinding.adapterType === "gemini_cli") {
      if (input.route.credentialRef !== "runtime-auth://gemini-cli") throw new Error("Gemini route lacks the explicit runtime auth reference");
      const geminiHome = path.join(profile, ".gemini");
      await writeFile(
        path.join(geminiHome, "settings.json"),
        `${JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      args = ["--output-format", "stream-json", "--model", model, "--approval-mode", "plan", "--sandbox=none", "--skip-trust", "--prompt", prompt];
    } else {
      throw new Error(`No concrete bounded canary transport for ${input.route.runtimeBinding.adapterType}`);
    }
    const executed = await boundedProviderCanaryExec(identity.commandRealpath, args, { cwd, env, timeoutSeconds: input.route.canary.timeoutSeconds });
    const stdout = redactExactValues(executed.stdout, preparedProfile.exactRedactionValues);
    const stderr = redactExactValues(executed.stderr, preparedProfile.exactRedactionValues);
    const combined = `${stdout}\n${stderr}`;
    if (executed.exitCode !== 0) {
      const failureClass = classifyProviderCanaryFailureText(combined);
      return {
        exitCode: executed.exitCode,
        finalResponse: null,
        resolvedModel: null,
        resolvedVersion: null,
        receiptPath: null,
        receiptSha256: null,
        failureClass,
        failureDetail: `Bounded ${input.route.runtimeBinding.adapterType} canary failed (${failureClass})`,
      };
    }
    const parsed = parseProviderCanaryStructuredOutput(stdout, input.nonce);
    const runtimeReportedModel = parsed.model?.includes("/") ? parsed.model.split("/").at(-1)! : parsed.model;
    const normalizedModel = runtimeReportedModel ?? model;
    if (!parsed.version && input.route.discovery.versionSource === "runtime_cli_model_id") parsed.version = normalizedModel;
    if (!parsed.finalResponse || normalizedModel !== model || !parsed.version || parsed.version !== input.route.model.version || !parsed.usage || PERSONAL_CONTEXT_MARKER.test(combined)) {
      const failureClass: ProviderCanaryFailureClass = PERSONAL_CONTEXT_MARKER.test(combined)
        ? "provider_security_compromise"
        : classifyProviderCanaryFailureText(combined);
      return {
        exitCode: 0,
        finalResponse: parsed.finalResponse,
        resolvedModel: normalizedModel,
        resolvedVersion: parsed.version,
        receiptPath: null,
        receiptSha256: null,
        usage: parsed.usage,
        failureClass,
        failureDetail: PERSONAL_CONTEXT_MARKER.test(combined)
          ? "Personal context marker appeared in isolated canary output"
          : `Canary lacks exact final/model/usage evidence (${failureClass})`,
      };
    }
    const policyCore = buildProviderPolicyRouteCore({ routeId: input.routeId, route: input.route });
    const resolvedRoute = buildResolvedProviderRoute({
      policy: input.policy,
      policySha256: input.policySha256,
      policySchemaSha256: input.policySchemaSha256,
      routeId: input.routeId,
    });
    const receipt = {
      schema_version: "paperclip.provider_canary_receipt.v2",
      route_id: input.routeId,
      provider: input.route.provider,
      provider_family: input.route.providerFamily,
      policy_sha256: input.policySha256,
      policy_schema_sha256: input.policySchemaSha256,
      policy_route_core_sha256: providerPolicyRouteCoreSha256(policyCore),
      resolved_route_sha256: resolvedRoute.resolvedRouteSha256,
      correlation_id: input.correlationId,
      expected_nonce: input.nonce,
      final_response: parsed.finalResponse,
      final_response_complete: true,
      resolved_model: normalizedModel,
      resolved_version: parsed.version,
      model_attestation: {
        method: runtimeReportedModel ? "runtime_event" : "exact_cli_argument",
        requested_model: model,
        runtime_reported_model: runtimeReportedModel,
        hidden_fallback_disabled: input.route.runtimeBinding.hiddenFallbackDisabled,
        isolated_user_config: true,
      },
      runtime_binding: {
        command_realpath: identity.commandRealpath,
        command_sha256: identity.commandSha256,
        observed_version: identity.observedVersion,
        runtime_closure_id: identity.runtimeClosureId,
        runtime_closure_sha256: identity.runtimeClosureSha256,
        binding_complete: true,
        isolated_cwd: true,
        isolated_profile: true,
        ...(identity.repoRoot ? { repo_root: identity.repoRoot } : {}),
        ...(identity.gitRevision ? { git_revision: identity.gitRevision } : {}),
        ...(identity.gitTree ? { git_tree: identity.gitTree } : {}),
        ...(identity.criticalModulesSha256 ? { critical_modules_sha256: identity.criticalModulesSha256 } : {}),
        ...(identity.dirty !== undefined ? { dirty: identity.dirty } : {}),
      },
      personal_context_markers_absent: true,
      discovery_contract: input.route.discovery,
      usage: {
        input_tokens: parsed.usage.inputTokens,
        output_tokens: parsed.usage.outputTokens,
        total_tokens: parsed.usage.totalTokens,
        cost_usd: parsed.usage.costUsd,
        accounting_mode: parsed.usage.accountingMode,
      },
    };
    const bytes = `${stableJson(receipt)}\n`;
    await mkdir(input.receiptRoot, { recursive: true });
    const receiptPath = path.join(input.receiptRoot, `${new Date().toISOString().replace(/[-:.]/g, "")}-${input.routeId}-${input.correlationId}.json`);
    await writeFile(receiptPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o444 });
    await chmod(receiptPath, 0o444);
    return {
      exitCode: 0,
      finalResponse: parsed.finalResponse,
      resolvedModel: normalizedModel,
      resolvedVersion: parsed.version,
      receiptPath,
      receiptSha256: createHash("sha256").update(bytes).digest("hex"),
      usage: parsed.usage,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runProviderPolicyCanaries(db: Db, input: {
  companyId: string;
  execute?: boolean;
  routeIds?: string[];
  receiptRoot?: string;
}) {
  const loaded = await loadProviderPolicyV2();
  const routeIds = input.routeIds ?? Object.keys(loaded.policy.routes);
  if (!input.execute) {
    return {
      schemaVersion: "paperclip.provider_canary_plan.v2",
      mode: "dry_run",
      companyId: input.companyId,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      policy: loaded.policy,
      routes: routeIds.map((routeId) => ({ routeId, route: loaded.policy.routes[routeId]?.provider, adapterType: loaded.policy.routes[routeId]?.runtimeBinding.adapterType })),
    };
  }
  const receiptRoot = path.resolve(
    input.receiptRoot ??
    process.env.PAPERCLIP_PROVIDER_CANARY_RECEIPT_ROOT ??
    path.join(
      process.env.PAPERCLIP_HOME ?? path.join(os.homedir(), ".paperclip"),
      "instances",
      process.env.PAPERCLIP_INSTANCE_ID ?? "default",
      "data/ops/provider-canaries/runs",
    ),
  );
  const trustedReceiptRoot = await prepareTrustedReceiptDirectory(
    receiptRoot,
    "provider_policy_canary_receipt_root",
  );
  return providerCanaryService(db, { receiptRoot: trustedReceiptRoot }).runBoundedCanaries({
    companyId: input.companyId,
    policy: loaded.policy,
    policySha256: loaded.sha256,
    policySchemaSha256: loaded.schemaSha256,
    routeIds,
    execute: (routeId, route, nonce, correlationId) => executeProviderPolicyRoute(db, {
      companyId: input.companyId,
      routeId,
      route,
      nonce,
      correlationId,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      policy: loaded.policy,
      receiptRoot: trustedReceiptRoot,
    }),
  });
}

type ProviderCanarySchedulerHealth = {
  routeId: string;
  expiresAt: Date;
};

export function createProviderPolicyCanaryScheduler(db: Db, deps: {
  intervalMs?: number;
  maxConcurrency?: number;
  now?: () => Date;
  listCompanyIds?: () => Promise<string[]>;
  listHealth?: (companyId: string, policySha256: string, policySchemaSha256: string) => Promise<ProviderCanarySchedulerHealth[]>;
  runCanaries?: typeof runProviderPolicyCanaries;
  onRefresh?: (input: { companyId: string; routeIds: string[]; results: unknown }) => Promise<void> | void;
} = {}) {
  const intervalMs = Math.max(30_000, deps.intervalMs ?? 60_000);
  const maxConcurrency = Math.max(1, Math.min(8, Math.trunc(deps.maxConcurrency ?? 2)));
  const now = deps.now ?? (() => new Date());
  const runCanaries = deps.runCanaries ?? runProviderPolicyCanaries;
  const listCompanyIds = deps.listCompanyIds ?? (async () => {
    const rows = await db.select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig, status: agents.status }).from(agents);
    return [...new Set(rows.filter((row) => {
      if (["terminated", "paused", "pending_approval"].includes(row.status)) return false;
      const providerPolicy = asRecord(asRecord(row.adapterConfig).providerPolicy);
      return providerPolicy.schemaVersion === "provider-policy.v2";
    }).map((row) => row.companyId))].sort();
  });
  const listHealth = deps.listHealth ?? (async (companyId, policySha256, policySchemaSha256) => db
    .select({ routeId: profitFlywheelProviderHealth.routeId, expiresAt: profitFlywheelProviderHealth.expiresAt })
    .from(profitFlywheelProviderHealth)
    .where(and(
      eq(profitFlywheelProviderHealth.companyId, companyId),
      eq(profitFlywheelProviderHealth.policySha256, policySha256),
      eq(profitFlywheelProviderHealth.policySchemaSha256, policySchemaSha256),
    )));
  const activeCompanies = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickPromise: Promise<unknown> | null = null;

  const tickOnce = async () => {
    const loaded = await loadProviderPolicyV2();
    const observedAt = now();
    const companyIds = [...new Set(await listCompanyIds())].sort();
    const jobs: Array<{ companyId: string; routeIds: string[] }> = [];
    for (const companyId of companyIds) {
      if (activeCompanies.has(companyId)) continue;
      const health = await listHealth(companyId, loaded.sha256, loaded.schemaSha256);
      const healthByRoute = new Map(health.map((row) => [row.routeId, row]));
      const routeIds = Object.entries(loaded.policy.routes).filter(([routeId, route]) => {
        const row = healthByRoute.get(routeId);
        const refreshLeadMs = Math.min(5 * 60 * 1000, Math.max(30_000, route.discovery.refreshSeconds * 200));
        return !row || row.expiresAt.getTime() <= observedAt.getTime() + refreshLeadMs;
      }).map(([routeId]) => routeId);
      if (routeIds.length > 0) jobs.push({ companyId, routeIds });
    }
    let cursor = 0;
    const refreshed: Array<{ companyId: string; routeIds: string[]; ok: boolean; error?: string }> = [];
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (!job || activeCompanies.has(job.companyId)) continue;
        activeCompanies.add(job.companyId);
        try {
          const results = await runCanaries(db, {
            companyId: job.companyId,
            execute: true,
            routeIds: job.routeIds,
          });
          await deps.onRefresh?.({ companyId: job.companyId, routeIds: job.routeIds, results });
          refreshed.push({ ...job, ok: true });
        } catch (error) {
          refreshed.push({
            ...job,
            ok: false,
            error: error instanceof Error ? error.message : "Provider canary refresh failed",
          });
        } finally {
          activeCompanies.delete(job.companyId);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, jobs.length) }, () => worker()));
    return { companies: companyIds.length, dueCompanies: jobs.length, refreshed };
  };

  const requestRun = () => {
    if (tickPromise) return tickPromise;
    tickPromise = tickOnce().finally(() => { tickPromise = null; });
    return tickPromise;
  };

  return {
    tickOnce,
    start() {
      if (timer) return;
      void requestRun();
      timer = setInterval(() => { void requestRun(); }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function parseProviderPolicyCanaryCliArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
) {
  if (args.some((arg) => arg === "--connection-string" || arg.startsWith("--connection-string="))) {
    throw new Error("provider_policy_canary_database_url_argv_forbidden: set DATABASE_URL in the environment");
  }
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const valueFlags = new Set(["--company-id", "--routes", "--receipt-root", "--home", "--instance-id"]);
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const flag = normalized[index]!;
    if (flag === "--execute") {
      if (execute) throw new Error("provider_policy_canary_argument_duplicate:--execute");
      execute = true;
      continue;
    }
    if (!valueFlags.has(flag) || flag.includes("=") || values.has(flag)) {
      throw new Error("provider_policy_canary_argument_invalid");
    }
    const value = normalized[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`provider_policy_canary_argument_missing:${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  const companyId = values.get("--company-id")?.trim();
  const connectionString = env.DATABASE_URL?.trim();
  const homeDir = values.get("--home");
  const instanceId = values.get("--instance-id");
  if (!companyId) throw new Error("provider_policy_canary_company_id_required");
  if (Boolean(homeDir) !== Boolean(instanceId)) {
    throw new Error("provider_policy_canary_instance_target_incomplete: --home and --instance-id are required together");
  }
  if (connectionString && homeDir && instanceId) {
    throw new Error("provider_policy_canary_database_target_conflict: select DATABASE_URL or --home/--instance-id, not both");
  }
  if (!connectionString && (!homeDir || !instanceId)) {
    throw new Error("provider_policy_canary_database_target_required: use --home/--instance-id or environment-only DATABASE_URL");
  }
  if (homeDir && (!path.isAbsolute(homeDir) || path.resolve(homeDir) !== homeDir)) {
    throw new Error("provider_policy_canary_home_invalid");
  }
  if (instanceId && !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
    throw new Error("provider_policy_canary_instance_id_invalid");
  }
  const routeIds = values.get("--routes")?.split(",").filter(Boolean);
  if (values.has("--routes") && (!routeIds?.length ||
      routeIds.some((routeId) => !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(routeId)) ||
      new Set(routeIds).size !== routeIds.length)) {
    throw new Error("provider_policy_canary_routes_invalid");
  }
  return {
    companyId,
    connectionString,
    homeDir,
    instanceId,
    execute,
    routeIds,
    receiptRoot: values.get("--receipt-root"),
  };
}

export function resolveProviderPolicyCanaryDatabaseConnection(
  environmentConnectionString: string | undefined,
  config: {
    databaseMode: "embedded-postgres" | "postgres";
    databaseUrl?: string;
    embeddedPostgresPort: number;
  },
) {
  if (environmentConnectionString) return environmentConnectionString;
  if (config.databaseMode === "postgres") {
    if (!config.databaseUrl?.trim()) {
      throw new Error("provider_policy_canary_database_url_missing");
    }
    return config.databaseUrl.trim();
  }
  const port = Number(config.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("provider_policy_canary_embedded_port_invalid");
  }
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function requireContainedPath(root: string, value: unknown, label: string) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value ||
      /[\r\n\0]/.test(value)) {
    throw new Error(`provider_policy_canary_${label}_invalid`);
  }
  const relative = path.relative(root, value);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`provider_policy_canary_${label}_outside_instance`);
  }
  return value;
}

const INSTANCE_MODE_FORBIDDEN_ENV = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_PROVIDER_CANARY_RECEIPT_ROOT",
] as const;

export async function resolveProviderPolicyCanaryInstanceTarget(input: {
  homeDir: string;
  instanceId: string;
  receiptRoot?: string;
  environment?: Record<string, string | undefined>;
}) {
  const environment = input.environment ?? process.env;
  for (const name of INSTANCE_MODE_FORBIDDEN_ENV) {
    if (environment[name]?.trim()) {
      throw new Error(`provider_policy_canary_instance_environment_conflict:${name}`);
    }
  }
  const instanceRoot = path.join(input.homeDir, "instances", input.instanceId);
  const configPath = path.join(instanceRoot, "config.json");
  const configArtifact = await readTrustedFile(
    configPath,
    "provider_policy_canary_instance_config",
    { maxBytes: 1024 * 1024, requireReadOnly: false, requireCurrentOwner: true },
  );
  let config: Record<string, unknown>;
  try {
    config = asRecord(JSON.parse(configArtifact.bytes.toString("utf8")));
  } catch {
    throw new Error("provider_policy_canary_instance_config_invalid_json");
  }
  const database = asRecord(config.database);
  if (database.mode !== "embedded-postgres") {
    throw new Error("provider_policy_canary_instance_embedded_postgres_required");
  }
  const port = Number(database.embeddedPostgresPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("provider_policy_canary_embedded_port_invalid");
  }
  const secrets = asRecord(config.secrets);
  const localEncrypted = asRecord(secrets.localEncrypted);
  if (secrets.provider !== "local_encrypted") {
    throw new Error("provider_policy_canary_instance_local_encrypted_required");
  }
  const masterKeyFilePath = requireContainedPath(
    instanceRoot,
    localEncrypted.keyFilePath,
    "master_key_path",
  );
  const receiptBase = path.join(instanceRoot, "data/ops/provider-canaries");
  const lexicalReceiptRoot = input.receiptRoot
    ? requireContainedPath(receiptBase, input.receiptRoot, "receipt_root")
    : path.join(receiptBase, "runs");
  const [canonicalReceiptBase, receiptRoot] = await Promise.all([
    requireTrustedDirectory(receiptBase, "provider_policy_canary_receipt_base"),
    prepareTrustedReceiptDirectory(lexicalReceiptRoot, "provider_policy_canary_receipt_root"),
  ]);
  requireContainedPath(canonicalReceiptBase, receiptRoot, "receipt_root");
  return {
    instanceRoot,
    configPath,
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    masterKeyFilePath,
    receiptRoot,
  };
}

export async function resolveProviderPolicyCanaryExternalTarget(input: {
  connectionString: string;
  receiptRoot?: string;
  environment?: Record<string, string | undefined>;
}) {
  const environment = input.environment ?? process.env;
  if (environment.PAPERCLIP_SECRETS_MASTER_KEY?.trim()) {
    throw new Error("provider_policy_canary_inline_master_key_forbidden");
  }
  const masterKeyFilePath = environment.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim();
  if (!masterKeyFilePath || !path.isAbsolute(masterKeyFilePath) ||
      path.resolve(masterKeyFilePath) !== masterKeyFilePath || /[\r\n\0]/.test(masterKeyFilePath)) {
    throw new Error("provider_policy_canary_external_master_key_file_required");
  }
  if (!input.receiptRoot || !path.isAbsolute(input.receiptRoot) ||
      path.resolve(input.receiptRoot) !== input.receiptRoot || /[\r\n\0]/.test(input.receiptRoot)) {
    throw new Error("provider_policy_canary_external_receipt_root_required");
  }
  const receiptRoot = await prepareTrustedReceiptDirectory(
    input.receiptRoot,
    "provider_policy_canary_receipt_root",
  );
  return {
    connectionString: input.connectionString,
    masterKeyFilePath,
    receiptRoot,
  };
}

async function main() {
  const parsed = parseProviderPolicyCanaryCliArgs(process.argv.slice(2));
  const target = parsed.homeDir && parsed.instanceId
    ? await resolveProviderPolicyCanaryInstanceTarget({
        homeDir: parsed.homeDir,
        instanceId: parsed.instanceId,
        receiptRoot: parsed.receiptRoot,
      })
    : await resolveProviderPolicyCanaryExternalTarget({
        connectionString: parsed.connectionString!,
        receiptRoot: parsed.receiptRoot,
      });
  if (parsed.homeDir) process.env.PAPERCLIP_HOME = parsed.homeDir;
  if (parsed.instanceId) process.env.PAPERCLIP_INSTANCE_ID = parsed.instanceId;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = target.masterKeyFilePath;
  const { companyId } = parsed;
  const db = createDb(target.connectionString);
  try {
    console.log(JSON.stringify(await runProviderPolicyCanaries(db, {
      companyId,
      execute: parsed.execute,
      routeIds: parsed.routeIds,
      receiptRoot: target.receiptRoot,
    }), null, 2));
  } finally {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
