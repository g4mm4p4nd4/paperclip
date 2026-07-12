import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  profitFlywheelProviderHealth,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  buildProviderPolicyRouteCore,
  buildResolvedProviderRoute,
  loadProviderPolicyV2,
  type ProviderPolicyRoute,
  type ProviderPolicyV2,
} from "../services/provider-policy.js";
import { providerPolicyRouteCoreSha256 } from "../services/provider-route-hash.js";
import {
  classifyProviderCanaryExecutionException,
  defaultProviderCanaryReceiptRoot,
  providerCanaryService,
  PROVIDER_CREDENTIAL_BLOCKER_TITLE,
} from "../services/provider-canaries.js";

describe("provider canary receipt paths", () => {
  it("defaults under the active Paperclip instance root", () => {
    expect(defaultProviderCanaryReceiptRoot("/tmp/paperclip/instances/flywheel-canary")).toBe(
      "/tmp/paperclip/instances/flywheel-canary/data/ops/provider-canaries/runs",
    );
  });
});

describe("provider canary execution exception classification", () => {
  it("classifies missing company-secret references as auth failures instead of process loss", () => {
    expect(classifyProviderCanaryExecutionException(new Error("Company secret OPENCODE_GO_API_KEY is missing"))).toBe("provider_auth");
    expect(classifyProviderCanaryExecutionException(new Error("ECONNREFUSED upstream"))).toBe("transient_network");
  });

  it("classifies runtime-closure and source-provenance mismatches as security compromises", () => {
    const closureMismatch = Object.assign(new Error("command SHA-256 does not match policy"), {
      code: "provider_runtime_closure_mismatch",
    });
    expect(classifyProviderCanaryExecutionException(closureMismatch)).toBe("provider_security_compromise");
    expect(classifyProviderCanaryExecutionException(
      new Error("Hermes external adapter does not match its pinned clean source binding: gitTree"),
    )).toBe("provider_security_compromise");
    expect(classifyProviderCanaryExecutionException(
      new Error("Active Hermes adapter provenance does not match the pinned external adapter root and entry point"),
    )).toBe("provider_security_compromise");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("provider canary persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let receiptRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-canary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    receiptRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-provider-receipts-"));
  });

  afterEach(async () => {
    await db.delete(profitFlywheelProviderHealth);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (receiptRoot) await rm(receiptRoot, { recursive: true, force: true });
    receiptRoot = "";
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Canary Co", issuePrefix: `C${companyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ companyId, name: "Portfolio OS Orchestrator", role: "orchestrator", status: "idle", adapterType: "hermes_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    return companyId;
  }

  async function writeReceipt(input: {
    routeId: string;
    route: ProviderPolicyRoute;
    nonce: string;
    correlationId: string;
    policySha256: string;
    schemaSha256: string;
    policy: ProviderPolicyV2;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number | null; accountingMode: "booked" | "telemetry_only" };
  }) {
    const usage = input.usage ?? { inputTokens: 10, outputTokens: 1, totalTokens: 11, costUsd: null, accountingMode: "telemetry_only" as const };
    const core = buildProviderPolicyRouteCore({ routeId: input.routeId, route: input.route });
    const resolved = buildResolvedProviderRoute({ policy: input.policy, policySha256: input.policySha256, policySchemaSha256: input.schemaSha256, routeId: input.routeId });
    const receipt = {
      schema_version: "paperclip.provider_canary_receipt.v2",
      route_id: input.routeId,
      provider: input.route.provider,
      provider_family: input.route.providerFamily,
      policy_sha256: input.policySha256,
      policy_schema_sha256: input.schemaSha256,
      policy_route_core_sha256: providerPolicyRouteCoreSha256(core),
      resolved_route_sha256: resolved.resolvedRouteSha256,
      correlation_id: input.correlationId,
      expected_nonce: input.nonce,
      final_response: input.nonce,
      final_response_complete: true,
      resolved_model: input.route.model.kind === "exact" ? input.route.model.value : null,
      resolved_version: input.route.model.version,
      model_attestation: {
        method: "runtime_event",
        requested_model: input.route.model.kind === "exact" ? input.route.model.value : null,
        runtime_reported_model: input.route.model.kind === "exact" ? input.route.model.value : null,
        hidden_fallback_disabled: true,
        isolated_user_config: true,
      },
      runtime_binding: {
        command_realpath: input.route.runtimeBinding.commandRealpath,
        command_sha256: input.route.runtimeBinding.commandSha256,
        observed_version: input.route.runtimeBinding.expectedVersion,
        runtime_closure_id: input.route.runtimeBinding.runtimeClosureId,
        runtime_closure_sha256: input.route.runtimeBinding.runtimeClosureSha256,
        binding_complete: true,
        isolated_cwd: true,
        isolated_profile: true,
        ...(input.route.runtimeBinding.repoRoot ? { repo_root: input.route.runtimeBinding.repoRoot } : {}),
        ...(input.route.runtimeBinding.gitRevision ? { git_revision: input.route.runtimeBinding.gitRevision } : {}),
        ...(input.route.runtimeBinding.gitTree ? { git_tree: input.route.runtimeBinding.gitTree } : {}),
        ...(input.route.runtimeBinding.criticalModulesSha256 ? { critical_modules_sha256: input.route.runtimeBinding.criticalModulesSha256 } : {}),
        ...(input.route.runtimeBinding.requireCleanTree ? { dirty: false } : {}),
      },
      personal_context_markers_absent: true,
      discovery_contract: input.route.discovery,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
        cost_usd: usage.costUsd,
        accounting_mode: usage.accountingMode,
      },
    };
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPath = path.join(receiptRoot, `${input.routeId}-${randomUUID()}.json`);
    await writeFile(receiptPath, bytes, { mode: 0o444 });
    await chmod(receiptPath, 0o444);
    return { receiptPath, receiptSha256: createHash("sha256").update(bytes).digest("hex"), usage };
  }

  it("requires content-addressed exact receipts and enforces both token ceilings", async () => {
    const companyId = await seedCompany();
    const loaded = await loadProviderPolicyV2();
    const routeId = "codex_deep";
    const route = loaded.policy.routes[routeId];
    const nonce = "PAPERCLIP_CANARY_EXACT_NONCE";
    const correlationId = "provider-canary-test";
    const receipt = await writeReceipt({ routeId, route, nonce, correlationId, policySha256: loaded.sha256, schemaSha256: loaded.schemaSha256, policy: loaded.policy });
    const svc = providerCanaryService(db, { receiptRoot });
    const healthy = await svc.recordResult({
      companyId, routeId, route, policy: loaded.policy, policySha256: loaded.sha256, policySchemaSha256: loaded.schemaSha256, correlationId,
      result: {
        exitCode: 0, finalResponse: nonce, expectedNonce: nonce,
        resolvedModel: route.model.kind === "exact" ? route.model.value : null,
        resolvedVersion: route.model.version,
        receiptPath: receipt.receiptPath, receiptSha256: receipt.receiptSha256, usage: receipt.usage,
      },
    });
    expect(healthy.status).toBe("healthy");
    expect(healthy.receiptSha256).toBe(receipt.receiptSha256);

    const oversizedUsage = {
      inputTokens: route.runtimeBinding.maxCanaryInputTokens + 1,
      outputTokens: route.canary.maxTokens + 1,
      totalTokens: route.runtimeBinding.maxCanaryInputTokens + route.canary.maxTokens + 2,
      costUsd: null,
      accountingMode: "telemetry_only" as const,
    };
    const oversizedReceipt = await writeReceipt({ routeId, route, nonce, correlationId, policySha256: loaded.sha256, schemaSha256: loaded.schemaSha256, policy: loaded.policy, usage: oversizedUsage });
    const rejected = await svc.recordResult({
      companyId, routeId, route, policy: loaded.policy, policySha256: loaded.sha256, policySchemaSha256: loaded.schemaSha256, correlationId,
      result: {
        exitCode: 0, finalResponse: nonce, expectedNonce: nonce,
        resolvedModel: route.model.kind === "exact" ? route.model.value : null,
        resolvedVersion: route.model.version,
        receiptPath: oversizedReceipt.receiptPath, receiptSha256: oversizedReceipt.receiptSha256, usage: oversizedUsage,
      },
    });
    expect(rejected.status).not.toBe("healthy");

    const zeroUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
      accountingMode: "telemetry_only" as const,
    };
    const zeroReceipt = await writeReceipt({
      routeId,
      route,
      nonce,
      correlationId,
      policySha256: loaded.sha256,
      schemaSha256: loaded.schemaSha256,
      policy: loaded.policy,
      usage: zeroUsage,
    });
    const zeroRejected = await svc.recordResult({
      companyId, routeId, route, policy: loaded.policy, policySha256: loaded.sha256, policySchemaSha256: loaded.schemaSha256, correlationId,
      result: {
        exitCode: 0, finalResponse: nonce, expectedNonce: nonce,
        resolvedModel: route.model.kind === "exact" ? route.model.value : null,
        resolvedVersion: route.model.version,
        receiptPath: zeroReceipt.receiptPath, receiptSha256: zeroReceipt.receiptSha256, usage: zeroUsage,
      },
    });
    expect(zeroRejected.status).not.toBe("healthy");
    expect(zeroRejected.failureClass).toBe("provider_malformed_response");
  });

  it("rejects a receipt that changes after the verified handle reads it", async () => {
    const companyId = await seedCompany();
    const loaded = await loadProviderPolicyV2();
    const routeId = "codex_deep";
    const route = loaded.policy.routes[routeId];
    const nonce = "PAPERCLIP_CANARY_RACE_NONCE";
    const correlationId = "provider-canary-race-test";
    const receipt = await writeReceipt({
      routeId,
      route,
      nonce,
      correlationId,
      policySha256: loaded.sha256,
      schemaSha256: loaded.schemaSha256,
      policy: loaded.policy,
    });
    const probe = await open(receipt.receiptPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      readFile: (this: unknown, ...args: unknown[]) => Promise<Buffer | string>;
    };
    await probe.close();
    const originalReadFile = fileHandlePrototype.readFile;
    let replaced = false;
    fileHandlePrototype.readFile = async function (this: unknown, ...args: unknown[]) {
      const bytes = await originalReadFile.apply(this, args);
      if (!replaced) {
        replaced = true;
        await chmod(receipt.receiptPath, 0o644);
        await writeFile(receipt.receiptPath, "{}\n");
        await chmod(receipt.receiptPath, 0o444);
      }
      return bytes;
    };

    try {
      const row = await providerCanaryService(db, { receiptRoot }).recordResult({
        companyId,
        routeId,
        route,
        policy: loaded.policy,
        policySha256: loaded.sha256,
        policySchemaSha256: loaded.schemaSha256,
        correlationId,
        reconcileBlocker: false,
        result: {
          exitCode: 0,
          finalResponse: nonce,
          expectedNonce: nonce,
          resolvedModel: route.model.kind === "exact" ? route.model.value : null,
          resolvedVersion: route.model.version,
          receiptPath: receipt.receiptPath,
          receiptSha256: receipt.receiptSha256,
          usage: receipt.usage,
        },
      });

      expect(replaced).toBe(true);
      expect(row).toMatchObject({
        status: "failed",
        failureClass: "provider_malformed_response",
      });
      expect(row?.failureDetail).toContain("changed while it was being verified");
      expect(row?.receiptPath).toBeNull();
      expect(row?.receiptSha256).toBeNull();
    } finally {
      fileHandlePrototype.readFile = originalReadFile;
    }
  });

  it("keeps auth blocker open until every route has fresh healthy coverage", async () => {
    const companyId = await seedCompany();
    const loaded = await loadProviderPolicyV2();
    const svc = providerCanaryService(db, { receiptRoot });
    const coveragePolicy = {
      ...loaded.policy,
      routes: {
        codex_deep: loaded.policy.routes.codex_deep,
        claude_sonnet: loaded.policy.routes.claude_sonnet,
      },
    };
    const failedRoute = coveragePolicy.routes.codex_deep;
    await svc.recordResult({
      companyId,
      routeId: failedRoute.id,
      route: failedRoute,
      policy: coveragePolicy,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      result: {
        exitCode: 1, finalResponse: null, expectedNonce: "AUTH_FAIL", resolvedModel: null, resolvedVersion: null,
        receiptPath: null, receiptSha256: null, failureClass: "provider_auth", failureDetail: "authentication required",
      },
    });
    expect(await db.select().from(issues)).toEqual(expect.arrayContaining([expect.objectContaining({ title: PROVIDER_CREDENTIAL_BLOCKER_TITLE, status: "blocked" })]));

    await svc.runBoundedCanaries({
      companyId,
      policy: coveragePolicy,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      execute: async (routeId, route, nonce, correlationId) => {
        const receipt = await writeReceipt({ routeId, route, nonce, correlationId, policySha256: loaded.sha256, schemaSha256: loaded.schemaSha256, policy: loaded.policy });
        return {
          exitCode: 0,
          finalResponse: nonce,
          resolvedModel: route.model.kind === "exact" ? route.model.value : null,
          resolvedVersion: route.model.version,
          receiptPath: receipt.receiptPath,
          receiptSha256: receipt.receiptSha256,
          usage: receipt.usage,
        };
      },
    });
    expect((await db.select().from(issues)).find((issue) => issue.title === PROVIDER_CREDENTIAL_BLOCKER_TITLE)?.status).toBe("done");
  });

  it("immediately quarantines an attested runtime-security mismatch", async () => {
    const companyId = await seedCompany();
    const loaded = await loadProviderPolicyV2();
    const routeId = "codex_deep";
    const route = loaded.policy.routes[routeId];
    expect(route.rollback.failureThreshold).toBeGreaterThan(1);

    const row = await providerCanaryService(db, { receiptRoot }).recordResult({
      companyId,
      routeId,
      route,
      policy: loaded.policy,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      reconcileBlocker: false,
      result: {
        exitCode: null,
        finalResponse: null,
        expectedNonce: "SECURITY_FAILURE",
        resolvedModel: null,
        resolvedVersion: null,
        receiptPath: null,
        receiptSha256: null,
        failureClass: "provider_security_compromise",
        failureDetail: "Runtime closure does not match policy",
      },
    });

    expect(row).toMatchObject({
      status: "quarantined",
      failureClass: "provider_security_compromise",
      consecutiveFailures: 1,
    });
  });

  it("atomically increments concurrent route failures through the quarantine threshold", async () => {
    const companyId = await seedCompany();
    const loaded = await loadProviderPolicyV2();
    const routeId = "codex_deep";
    const route = loaded.policy.routes[routeId];
    expect(route.rollback.failureThreshold).toBe(2);
    const svc = providerCanaryService(db, { receiptRoot });
    const observedAt = new Date("2026-07-12T12:00:00.000Z");

    await Promise.all(Array.from({ length: route.rollback.failureThreshold }, (_, index) => svc.recordResult({
      companyId,
      routeId,
      route,
      policy: loaded.policy,
      policySha256: loaded.sha256,
      policySchemaSha256: loaded.schemaSha256,
      now: observedAt,
      correlationId: `concurrent-failure-${index}`,
      reconcileBlocker: false,
      result: {
        exitCode: 1,
        finalResponse: null,
        expectedNonce: `FAILURE_${index}`,
        resolvedModel: null,
        resolvedVersion: null,
        receiptPath: null,
        receiptSha256: null,
        failureClass: "process_lost",
        failureDetail: "Provider process exited",
      },
    })));

    const [row] = await db.select().from(profitFlywheelProviderHealth);
    expect(row).toMatchObject({
      status: "quarantined",
      consecutiveFailures: route.rollback.failureThreshold,
    });
  });
});
