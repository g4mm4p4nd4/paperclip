import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  profitFlywheelProviderHealth,
  profitFlywheelWorkflows,
  projects,
} from "@paperclipai/db";
import { createHealthGatedFactoryLaunchAuthority } from "../services/factory-health-launch-authority.js";
import { PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256 } from "../services/profit-flywheel-contract.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const managedProviderPolicyAuthority = {
  path: "/managed/paperclip-runtime/authorities/provider-policy/test-authority.json",
  sha256: "f".repeat(64),
};

async function verifyManagedProviderPolicyAuthority(input: { expectedBinding: typeof managedProviderPolicyAuthority }) {
  return { binding: input.expectedBinding } as never;
}

describeDb("health-gated factory launch authority", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const roots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-factory-launch-health-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelProviderHealth);
    await db.delete(profitFlywheelWorkflows);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => tempDb?.cleanup());

  async function baselinePointer(
    availableBytes: number,
    companyId: string,
    capturedAt = new Date().toISOString(),
    promotionReady = false,
    promotionBlockers: string[] = [],
  ) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-launch-health-")));
    roots.push(root);
    const receipt = {
      schema_version: "paperclip.profit_flywheel_factory_baseline.v1",
      company_id: companyId,
      captured_at: capturedAt,
      target_workflow: null,
      stage_counts: [],
      blocker_counts: [],
      provider_policy: { sha256: null, schema_sha256: null, routes: [] },
      repositories: [
        { name: "portfolio-os", path: "/repos/portfolio-os", head: "a".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "paperclip", path: "/repos/paperclip", head: "b".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-agent", path: "/repos/hermes-agent", head: "c".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
        { name: "hermes-paperclip-adapter", path: "/repos/adapter", head: "d".repeat(40), branch: "main", upstream: "origin/main", tracked_changes: 0, untracked_changes: 0, tree_clean: true },
      ],
      adapter: {
        package_name: "@henkey/hermes-paperclip-adapter",
        package_version: "0.2.0",
        plugin_store_version: "0.2.0",
        plugin_store_mode: "immutable_bundle",
        git_commit: "d".repeat(40),
        git_branch: "main",
        file_manifest_sha256: "e".repeat(64),
      },
      resources: {
        disk: { path: "/System/Volumes/Data", total_bytes: 100 * 1024 ** 3, free_bytes: availableBytes, available_bytes: availableBytes, free_percent: 20 },
        database_bytes: 0,
        ops_bytes: 0,
        backup_bytes: 0,
        log_bytes: 0,
        factory_browser_processes: { count: 0, rss_bytes: 0 },
      },
      tokenomics: promotionReady
        ? {
            receipt_path: "/receipts/tokenomics-pass.json",
            generated_at: capturedAt,
            status: "pass",
            age_seconds: 0,
            fresh: true,
          }
        : { receipt_path: null, generated_at: null, status: null, age_seconds: null, fresh: false },
      constraints: {
        live_pos_checkout_preserved: true,
        leadforge_excluded: true,
        secrets_redacted: true,
        promotion_blockers: promotionBlockers,
      },
    };
    const bytes = `${JSON.stringify(receipt)}\n`;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const receiptPath = path.join(root, `${digest}.json`);
    await writeFile(receiptPath, bytes, { mode: 0o444 });
    await chmod(receiptPath, 0o444);
    const pointerPath = path.join(root, "latest.json");
    await writeFile(pointerPath, `${JSON.stringify({
      schema_version: "paperclip.profit_flywheel_factory_baseline_pointer.v1",
      receipt_path: receiptPath,
      receipt_sha256: digest,
    })}\n`, { mode: 0o444 });
    await chmod(pointerPath, 0o444);
    return pointerPath;
  }

  async function decision(availableBytes: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Factory ${availableBytes}`,
      issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(availableBytes, companyId),
    });
    return authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId,
      targetRepo: "fixture/disk-boundary",
      workflowId: randomUUID(),
      runId: "disk-boundary",
      inputHash: "1".repeat(64),
      stage: "implementation",
    });
  }

  it("enforces the exact 30 GiB launch boundary, including the 25-30 GiB warning band", async () => {
    await expect(decision(29 * 1024 ** 3)).resolves.toMatchObject({
      allowed: false,
      code: "factory_disk_hard_stop",
    });
    await expect(decision(30 * 1024 ** 3)).resolves.toMatchObject({
      allowed: true,
      code: "factory_fixture_authorized",
    });
  });

  it("rejects a stale baseline before fixture admission", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stale factory",
      issuePrefix: `S${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    const pointerPath = await baselinePointer(30 * 1024 ** 3, companyId, "2026-07-14T00:00:00.000Z");

    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: pointerPath,
    });
    await expect(authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId,
      targetRepo: "fixture/stale",
      workflowId: randomUUID(),
      runId: "stale",
      inputHash: "1".repeat(64),
      stage: "implementation",
    })).resolves.toMatchObject({ allowed: false, code: "factory_health_snapshot_stale" });
  });

  it("rejects a fresh baseline issued for another company", async () => {
    const sourceCompanyId = randomUUID();
    const requestedCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: sourceCompanyId, name: "Source company", issuePrefix: `A${sourceCompanyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
      { id: requestedCompanyId, name: "Requested company", issuePrefix: `B${requestedCompanyId.slice(0, 5)}`, requireBoardApprovalForNewAgents: false },
    ]);
    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "fixture",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(30 * 1024 ** 3, sourceCompanyId),
    });
    await expect(authority.claim({
      kind: "paperclip_stage_dispatch",
      mode: "fixture",
      pauseNewWork: false,
      companyId: requestedCompanyId,
      targetRepo: "fixture/cross-company",
      workflowId: randomUUID(),
      runId: "cross-company",
      inputHash: "1".repeat(64),
      stage: "implementation",
    })).resolves.toMatchObject({ allowed: false, code: "factory_health_snapshot_stale" });
  });

  it("admits a quiet root dispatch only after the internal gate verifies the configured managed POS runtime", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const now = new Date();
    const historical = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const policySha256 = createHash("sha256").update("root-provider-policy").digest("hex");
    const policySchemaSha256 = createHash("sha256").update("root-provider-schema").digest("hex");
    const hermesClosureSha256 = createHash("sha256").update("root-hermes-closure").digest("hex");
    const posClosureSha256 = createHash("sha256").update("root-pos-closure").digest("hex");
    const aliases = [
      "research_fast",
      "research_deep",
      "code_fast",
      "code_deep",
      "multimodal_qa",
      "independent_review",
    ] as const;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const providerPolicyLoader = async () => ({
      sha256: policySha256,
      schemaSha256: policySchemaSha256,
      policy: {
        aliases: Object.fromEntries([
          ...aliases.map((alias) => [alias, { orderedRouteIds: [`root_${alias}`] }]),
          ["summarization", { orderedRouteIds: [] }],
          ["emergency_free", { orderedRouteIds: [] }],
        ]),
        routes: Object.fromEntries(aliases.map((alias) => [`root_${alias}`, {
          id: `root_${alias}`,
          providerFamily: alias === "independent_review" ? "family-beta" : "family-alpha",
          ...(alias === "code_deep" ? {
            runtimeBinding: {
              adapterType: "hermes_local",
              runtimeClosureSha256: hermesClosureSha256,
              expectedVersion: "hermes-root",
            },
          } : {}),
        }])),
      },
    }) as Awaited<ReturnType<NonNullable<Parameters<typeof createHealthGatedFactoryLaunchAuthority>[1]["providerPolicyLoader"]>>>;

    await db.insert(companies).values({
      id: companyId,
      name: "Quiet root factory",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Quiet root project" });
    await db.insert(profitFlywheelWorkflows).values({
      id: workflowId,
      companyId,
      projectId,
      runId: "historical-root",
      state: "succeeded",
      currentStage: "learning",
      sourceSchemaVersion: "pos.dispatch.v2",
      sourceDispatchPath: "/tmp/historical-root.json",
      sourceDispatchHash: digest("historical-root-dispatch"),
      targetRepo: "owner/historical-value",
      targetWorkspaceRoot: "/tmp",
      contractPath: "/tmp/profit-flywheel.v2.json",
      contractSha256: PINNED_PROFIT_FLYWHEEL_CONTRACT_SHA256,
      contractSnapshot: { schema_version: "profit-flywheel.v2" },
      correlationId: "historical-root",
      traceId: digest("historical-root-trace").slice(0, 32),
      createdAt: historical,
      updatedAt: historical,
      completedAt: historical,
    });
    for (const alias of aliases) {
      await db.insert(profitFlywheelProviderHealth).values({
        companyId,
        routeId: `root_${alias}`,
        policySha256,
        policySchemaSha256,
        provider: `provider-${alias}`,
        providerFamily: alias === "independent_review" ? "family-beta" : "family-alpha",
        status: "healthy",
        resolvedModel: `model-${alias}`,
        resolvedVersion: "v1",
        policyRouteCoreSha256: digest(`root-core:${alias}`),
        resolvedRouteSha256: digest(`root-resolved:${alias}`),
        receiptPath: `/tmp/root-${alias}.json`,
        receiptSha256: digest(`root-receipt:${alias}`),
        receiptSchemaVersion: alias === "code_deep"
          ? "hermes-completion-canary-receipt.v1"
          : "paperclip.provider_canary.v1",
        canaryKind: "minimal_token",
        observedAt: new Date(now.getTime() - 1_000),
        expiresAt: new Date(now.getTime() + 60_000),
        correlationId: "root-provider-readiness",
        traceId: digest("root-provider-trace").slice(0, 32),
        spanId: digest(`root-provider-span:${alias}`).slice(0, 16),
        details: {},
      });
    }

    const liveAuthority = {
      claim: vi.fn().mockResolvedValue({
        allowed: true,
        code: "factory_workflow_root_approval_consumed",
        detail: "Exact approval consumed.",
        terminal: false,
      }),
    };
    const managedPortfolioOsRuntimeResolver = vi.fn().mockResolvedValue({
      current: {
        runtime_id: "portfolio-os-root",
        closure_sha256: posClosureSha256,
      },
      providerPolicyAuthority: managedProviderPolicyAuthority,
    });
    const authority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "shadow",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(
        50 * 1024 ** 3,
        companyId,
        now.toISOString(),
        true,
      ),
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
      managedPortfolioOsRuntimeResolver: managedPortfolioOsRuntimeResolver as NonNullable<
        Parameters<typeof createHealthGatedFactoryLaunchAuthority>[1]["managedPortfolioOsRuntimeResolver"]
      >,
      providerPolicyLoader,
      providerPolicyAuthorityVerifier: verifyManagedProviderPolicyAuthority,
      liveAuthority,
    });
    const input = {
      kind: "portfolio_dispatch" as const,
      mode: "shadow" as const,
      pauseNewWork: false,
      companyId,
      targetRepo: "owner/value-repository",
      runId: "shadow-root-20260715",
      inputHash: digest("shadow-root-dispatch"),
    };

    await expect(authority.claim(input)).resolves.toMatchObject({
      allowed: true,
      code: "factory_workflow_root_approval_consumed",
    });
    expect(managedPortfolioOsRuntimeResolver).toHaveBeenCalledWith({
      runtimeRoot: "/managed/portfolio-os",
    });
    expect(liveAuthority.claim).toHaveBeenCalledOnce();
    expect(liveAuthority.claim).toHaveBeenCalledWith(input);

    const constrainedAuthority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "shadow",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(
        50 * 1024 ** 3,
        companyId,
        now.toISOString(),
        true,
        ["mutable_adapter_runtime"],
      ),
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
      managedPortfolioOsRuntimeResolver: managedPortfolioOsRuntimeResolver as NonNullable<
        Parameters<typeof createHealthGatedFactoryLaunchAuthority>[1]["managedPortfolioOsRuntimeResolver"]
      >,
      providerPolicyLoader,
      providerPolicyAuthorityVerifier: verifyManagedProviderPolicyAuthority,
      liveAuthority,
    });
    await expect(constrainedAuthority.claim(input)).resolves.toMatchObject({
      allowed: false,
      code: "factory_health_not_healthy",
    });
    expect(liveAuthority.claim).toHaveBeenCalledOnce();

    const staleAuthority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "shadow",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(
        50 * 1024 ** 3,
        companyId,
        now.toISOString(),
        true,
      ),
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
      managedPortfolioOsRuntimeResolver: managedPortfolioOsRuntimeResolver as NonNullable<
        Parameters<typeof createHealthGatedFactoryLaunchAuthority>[1]["managedPortfolioOsRuntimeResolver"]
      >,
      providerPolicyLoader,
      providerPolicyAuthorityVerifier: async () => {
        throw new Error("Provider policy authority descriptor does not equal the active Paperclip policy path/schema pins");
      },
      liveAuthority,
    });
    await expect(staleAuthority.claim(input)).resolves.toMatchObject({
      allowed: false,
      code: "factory_health_not_healthy",
    });
    expect(liveAuthority.claim).toHaveBeenCalledOnce();

    const verifierThatDriftsAfterHealth = vi.fn()
      .mockResolvedValueOnce({ binding: managedProviderPolicyAuthority } as never)
      .mockRejectedValueOnce(new Error("active Paperclip provider policy advanced after health observation"));
    const admissionDriftAuthority = createHealthGatedFactoryLaunchAuthority(db, {
      mode: "shadow",
      pauseNewWork: false,
      baselinePointerPath: await baselinePointer(
        50 * 1024 ** 3,
        companyId,
        now.toISOString(),
        true,
      ),
      portfolioOsRuntimeRoot: "/managed/portfolio-os",
      managedPortfolioOsRuntimeResolver: managedPortfolioOsRuntimeResolver as NonNullable<
        Parameters<typeof createHealthGatedFactoryLaunchAuthority>[1]["managedPortfolioOsRuntimeResolver"]
      >,
      providerPolicyLoader,
      providerPolicyAuthorityVerifier: verifierThatDriftsAfterHealth as never,
      liveAuthority,
    });
    await expect(admissionDriftAuthority.claim(input)).resolves.toMatchObject({
      allowed: false,
      code: "factory_provider_policy_authority_unverified",
    });
    expect(verifierThatDriftsAfterHealth).toHaveBeenCalledTimes(2);
    expect(liveAuthority.claim).toHaveBeenCalledOnce();
  });
});
