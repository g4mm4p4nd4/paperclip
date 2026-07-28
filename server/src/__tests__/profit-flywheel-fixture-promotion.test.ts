import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  profitFlywheelWorkflows,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  configureSecureProfitCanaryRuntimeEnvironment,
  parseSecureProfitCanaryPromotionCliArgs,
  profitCanaryBrokerAllowedRequests,
  requireExistingConfiguredMasterKey,
  resolveSecureProfitCanaryDatabaseConnection,
  resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey,
  runSecureProfitCanaryPromotion,
  spawnProfitCanaryChild,
  verifyPersistedProfitCanaryWorkflow,
} from "../ops/profit-flywheel-fixture-promotion.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { ManagedPosRuntimeInvocationDescriptor } from "../services/managed-pos-runtime.js";
import { createRunScopedPaperclipApiBroker } from "../services/run-scoped-paperclip-api-broker.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const COMPANY_ID = "216897d4-0f94-4736-9b6b-a20c8e48d694";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "fixture-secure-promotion";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const REAL_BEARER = "pcp_real_bearer_that_must_stay_in_process_123456789";

async function fixtureRoot(receiptOverrides: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-secure-promotion-")));
  const portfolioOsRoot = path.join(root, "portfolio-os");
  const runtimePackageRoot = path.join(root, "managed-pos-package");
  const outboxDir = path.join(root, "outbox");
  const promotionReceiptDir = path.join(root, "promotion");
  const aggregateReceiptDir = path.join(root, "aggregate");
  const runRoot = path.join(portfolioOsRoot, "data", "canary_runs", RUN_ID);
  const targetWorkspacePath = path.join(runRoot, "target", "profit-canary");
  const targetOriginPath = path.join(runRoot, "target", "origin.git");
  await Promise.all([
    mkdir(path.join(runtimePackageRoot, "pos"), { recursive: true }),
    mkdir(path.join(runtimePackageRoot, ".venv", "bin"), { recursive: true }),
    mkdir(targetWorkspacePath, { recursive: true }),
    mkdir(targetOriginPath, { recursive: true }),
    mkdir(outboxDir),
    mkdir(promotionReceiptDir),
    mkdir(aggregateReceiptDir),
  ]);
  const targetWorkspace = await realpath(targetWorkspacePath);
  const targetOrigin = await realpath(targetOriginPath);
  await writeFile(path.join(runtimePackageRoot, "pos", "__init__.py"), "", "utf8");
  const runtimeModule = path.join(runtimePackageRoot, "pos", "profit_canary.py");
  await writeFile(runtimeModule, "# fixture\n", { mode: 0o444 });
  await chmod(runtimeModule, 0o444);
  const runtimePython = path.join(runtimePackageRoot, ".venv", "bin", "python");
  await writeFile(runtimePython, "#!/bin/sh\nexec python3 \"$@\"\n", { mode: 0o555 });
  await chmod(runtimePython, 0o555);
  const runtimeSha = "a".repeat(64);
  const managedPosRuntime: ManagedPosRuntimeInvocationDescriptor = {
    schemaVersion: "paperclip.managed_pos_runtime_invocation.v1",
    generation: 1,
    selector: { path: path.join(root, "active.json"), sha256: "b".repeat(64) },
    pointerSet: { path: path.join(root, "pointer.json"), sha256: "c".repeat(64) },
    providerPolicyAuthority: {
      path: path.join(root, "provider-policy-authority.json"),
      sha256: "d".repeat(64),
    },
    migrationOnly: false,
    current: {
      runtime_id: `portfolio-os-${runtimeSha}`,
      closure_sha256: runtimeSha,
      package_root: runtimePackageRoot,
      package: { path: path.join(runtimePackageRoot, ".runtime", "package.json"), sha256: "e".repeat(64) },
      runtime_manifest: {
        path: path.join(runtimePackageRoot, ".runtime", "runtime-manifest.json"),
        sha256: "f".repeat(64),
      },
    },
    previous: null,
    command: {
      executablePath: path.join(runtimePackageRoot, "bin", "pos"),
      cwd: runtimePackageRoot,
      runtimeManifestPath: path.join(runtimePackageRoot, ".runtime", "runtime-manifest.json"),
      runtimeManifestArgs: [
        "--runtime-manifest",
        path.join(runtimePackageRoot, ".runtime", "runtime-manifest.json"),
      ],
    },
    writableRoots: {
      cache: path.join(root, "cache"),
      output: path.join(root, "output"),
    },
    toolchain: {
      interpreter_path: runtimePython,
      version: "3.13.0",
      implementation: "cpython",
      cache_tag: "cpython-313",
      platform: "test",
      identity_sha256: "1".repeat(64),
      binary_sha256: "2".repeat(64),
      dependencies: [
        { name: "jsonschema", version: "1", files_sha256: "3".repeat(64) },
        { name: "PyYAML", version: "1", files_sha256: "4".repeat(64) },
        { name: "referencing", version: "1", files_sha256: "5".repeat(64) },
      ],
    },
  };
  const sourceDispatchRawPath = path.join(runRoot, "source-dispatch.json");
  const sourceDispatchBytes = Buffer.from(`${JSON.stringify({
    schema_version: "pos.dispatch.v2",
    run_id: RUN_ID,
    correlation_id: `profit-canary:${RUN_ID}`,
    paperclip: { company_id: COMPANY_ID, project_id: PROJECT_ID },
    target_repo_full_name: "fixture/profit-canary",
    target_repo_clone_path_hint: targetWorkspace,
    execution_manifest: {
      repo_target: {
        target_repo_full_name: "fixture/profit-canary",
        target_repo_clone_path_hint: targetWorkspace,
        repo_url: pathToFileURL(targetOrigin).href,
      },
    },
  })}\n`, "utf8");
  await writeFile(sourceDispatchRawPath, sourceDispatchBytes, { mode: 0o444 });
  await chmod(sourceDispatchRawPath, 0o444);
  const sourceDispatchPath = await realpath(sourceDispatchRawPath);
  const sourceDispatchSha256 = createHash("sha256").update(sourceDispatchBytes).digest("hex");
  const canaryReceiptPath = path.join(runRoot, "canary_receipt.json");
  await writeFile(canaryReceiptPath, `${JSON.stringify({
    schema_version: "pos.profit_flywheel_canary.v3",
    state: "dispatch_ready",
    mode: "offline_fixture_only",
    immutable: true,
    e2e_proof: false,
    execution_authority: "paperclip_control_plane",
    target_repo: "fixture/profit-canary",
    run_id: RUN_ID,
    correlation_id: `profit-canary:${RUN_ID}`,
    target_workspace: targetWorkspace,
    target_origin: targetOrigin,
    paperclip: { company_id: COMPANY_ID, project_id: PROJECT_ID },
    artifacts: {
      dispatch: { path: sourceDispatchPath, sha256: sourceDispatchSha256 },
    },
    ...receiptOverrides,
  })}\n`, { mode: 0o444 });
  await chmod(canaryReceiptPath, 0o444);
  return {
    root,
    portfolioOsRoot,
    runtimePackageRoot,
    runtimePython,
    managedPosRuntime,
    outboxDir,
    promotionReceiptDir,
    aggregateReceiptDir,
    canaryReceiptPath,
    sourceDispatchPath,
    sourceDispatchBytes,
    sourceDispatchSha256,
    targetWorkspace,
    targetOrigin,
  };
}

async function writeRuntimeModule(
  fixture: { runtimePackageRoot: string },
  source: string,
) {
  const modulePath = path.join(fixture.runtimePackageRoot, "pos", "profit_canary.py");
  await chmod(modulePath, 0o600);
  await writeFile(modulePath, source, "utf8");
  await chmod(modulePath, 0o444);
}

async function writeTerminalFixtureArtifacts(
  fixture: Awaited<ReturnType<typeof fixtureRoot>>,
  input: {
    outputWorkflowId: string;
    observationWorkflowId?: string;
    publishedBytes?: Buffer;
  },
) {
  const publishedRaw = path.join(fixture.outboxDir, `dispatch_${RUN_ID}.json`);
  const promotionRaw = path.join(fixture.promotionReceiptDir, `${RUN_ID}-promotion.json`);
  const observationRaw = path.join(fixture.promotionReceiptDir, `${RUN_ID}-workflow-observation.json`);
  const publishedBytes = input.publishedBytes ?? fixture.sourceDispatchBytes;
  await writeFile(publishedRaw, publishedBytes, { mode: 0o444 });
  await chmod(publishedRaw, 0o444);
  const published = await realpath(publishedRaw);
  const publishedSha256 = createHash("sha256").update(publishedBytes).digest("hex");
  const canaryReceipt = await realpath(fixture.canaryReceiptPath);
  const canarySha256 = createHash("sha256").update(await readFile(canaryReceipt)).digest("hex");
  await writeFile(promotionRaw, `${JSON.stringify({
    schema_version: "pos.profit_flywheel_canary_promotion.v1",
    state: "published",
    run_id: RUN_ID,
    company_id: COMPANY_ID,
    project_id: PROJECT_ID,
    correlation_id: `profit-canary:${RUN_ID}`,
    published_path: published,
    published_sha256: publishedSha256,
    canary_receipt: { path: canaryReceipt, sha256: canarySha256 },
    source_dispatch: { path: fixture.sourceDispatchPath, sha256: fixture.sourceDispatchSha256 },
    published_dispatch: { path: published, sha256: publishedSha256 },
    immutable: true,
  })}\n`, { mode: 0o444 });
  await chmod(promotionRaw, 0o444);
  const promotion = await realpath(promotionRaw);
  const promotionSha256 = createHash("sha256").update(await readFile(promotion)).digest("hex");
  await writeFile(observationRaw, `${JSON.stringify({
    schema_version: "pos.profit_flywheel_canary_workflow_observation.v1",
    state: "workflow_observed",
    immutable: true,
    promotion_receipt: { path: promotion, sha256: promotionSha256 },
    published_dispatch: { path: published, sha256: publishedSha256 },
    workflow: {
      id: input.observationWorkflowId ?? input.outputWorkflowId,
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: `profit-canary:${RUN_ID}`,
      sourceDispatchPath: published,
      sourceDispatchHash: publishedSha256,
    },
  })}\n`, { mode: 0o444 });
  await chmod(observationRaw, 0o444);
  const observation = await realpath(observationRaw);
  return {
    published,
    promotion,
    observation,
    stdout: [
      "canary_status=workflow_observed",
      `published_dispatch=${published}`,
      `promotion_receipt=${promotion}`,
      `observation_receipt=${observation}`,
      `workflow_id=${input.outputWorkflowId}`,
    ].join("\n"),
  };
}

describe("secure Profit Flywheel fixture promotion CLI", () => {
  it("binds the broker to every and only run-live HTTP request", () => {
    expect(profitCanaryBrokerAllowedRequests({
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    })).toEqual([
      { method: "GET", pathname: `/api/projects/${PROJECT_ID}`, search: "" },
      {
        method: "GET",
        pathname: `/api/companies/${COMPANY_ID}/profit-flywheel/workflows`,
        search: `?correlation_id=profit-canary%3A${RUN_ID}&limit=10`,
      },
    ]);
  });

  it("accepts only non-secret operator arguments and environment-only DATABASE_URL", () => {
    const parsed = parseSecureProfitCanaryPromotionCliArgs([
      "--",
      "--company-id", COMPANY_ID,
      "--portfolio-os-root", "/safe/portfolio-os",
      "--receipt", "/safe/canary.json",
      "--outbox-dir", "/safe/outbox",
      "--promotion-receipt-dir", "/safe/promotion",
      "--aggregate-receipt-dir", "/safe/aggregate",
      "--home", "/live/paperclip",
      "--instance-id", "default",
      "--wait-seconds", "30",
      "--poll-seconds", "0.5",
    ], { DATABASE_URL: "postgres://operator:redacted@127.0.0.1:5432/paperclip" });

    expect(parsed.options).toMatchObject({
      companyId: COMPANY_ID,
      waitSeconds: 30,
      pollSeconds: 0.5,
      paperclipApiUrl: "http://127.0.0.1:3100",
    });
    expect(parsed.runtime).toEqual({
      homeDir: "/live/paperclip",
      instanceId: "default",
    });
  });

  it("requires and installs one exact Paperclip instance binding before config import", () => {
    const environment: NodeJS.ProcessEnv = {};
    expect(configureSecureProfitCanaryRuntimeEnvironment({
      homeDir: "/live/paperclip",
      instanceId: "default",
    }, environment)).toEqual({
      homeDir: "/live/paperclip",
      instanceId: "default",
      instanceRoot: "/live/paperclip/instances/default",
      configPath: "/live/paperclip/instances/default/config.json",
    });
    expect(environment).toMatchObject({
      PAPERCLIP_HOME: "/live/paperclip",
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_CONFIG: "/live/paperclip/instances/default/config.json",
    });
  });

  it("fails closed instead of silently loading the default user instance", () => {
    expect(() => configureSecureProfitCanaryRuntimeEnvironment({}, {}))
      .toThrow("profit_canary_instance_binding_required");
    expect(() => configureSecureProfitCanaryRuntimeEnvironment({
      homeDir: "/live/paperclip",
      instanceId: "default",
    }, {
      PAPERCLIP_CONFIG: "/Users/operator/.paperclip/instances/default/config.json",
    })).toThrow("profit_canary_config_binding_mismatch");
  });

  it("derives the canonical embedded connection from live config when DATABASE_URL is absent", () => {
    const parsed = parseSecureProfitCanaryPromotionCliArgs([
      "--",
      "--company-id", COMPANY_ID,
      "--portfolio-os-root", "/safe/portfolio-os",
      "--receipt", "/safe/canary.json",
      "--outbox-dir", "/safe/outbox",
      "--promotion-receipt-dir", "/safe/promotion",
      "--aggregate-receipt-dir", "/safe/aggregate",
    ], {});
    expect(parsed.connectionString).toBeNull();
    expect(resolveSecureProfitCanaryDatabaseConnection(parsed.connectionString, {
      databaseMode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    })).toEqual({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      source: "embedded-postgres@54329",
    });
  });

  it.each([
    ["--connection-string", "postgres://forbidden"],
    ["--connection-string=postgres://forbidden"],
    ["--api-key", "forbidden"],
    ["--paperclip-api-key=forbidden"],
  ])("rejects credential-bearing argv (%s)", (...args) => {
    expect(() => parseSecureProfitCanaryPromotionCliArgs(args, { DATABASE_URL: "postgres://safe" }))
      .toThrow("profit_canary_credential_argv_forbidden");
  });
});

describe("secure Profit Flywheel fixture promotion runtime", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rejects an unsafe aggregate receipt hierarchy before resolving credentials", async () => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    await chmod(fixture.aggregateReceiptDir, 0o770);
    let secretResolutions = 0;
    await expect(runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
    }, {
      resolveCredential: async () => {
        secretResolutions += 1;
        throw new Error("must not resolve");
      },
    })).rejects.toThrow("profit_canary_aggregate_receipt_dir_unsafe_hierarchy");
    expect(secretResolutions).toBe(0);
  });

  it("terminates the detached child process group so a timed-out child cannot orphan descendants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-promotion-process-group-"));
    roots.push(root);
    const pidPath = path.join(root, "descendant.pid");

    const result = await spawnProfitCanaryChild({
      command: "/bin/sh",
      args: [
        "-c",
        'sleep 60 & descendant=$!; printf "%s" "$descendant" > "$1"; wait',
        "paperclip-process-group-test",
        pidPath,
      ],
      cwd: root,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      // Use only shell builtins before the descendant sleep so the PID is
      // durably published even under full-suite worker contention.
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
    let alive = true;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          alive = false;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
  }, 10_000);

  it.each([
    ["fabricated E2E proof", { e2e_proof: true }],
    ["wrong execution authority", { execution_authority: "portfolio_os" }],
    ["unsupported receipt schema", { schema_version: "pos.profit_flywheel_canary.v4" }],
  ])("rejects %s before resolving a credential or opening the broker", async (_label, receiptOverrides) => {
    const fixture = await fixtureRoot(receiptOverrides);
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    let secretResolutions = 0;
    let brokerStarts = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
    }, {
      resolveCredential: async () => {
        secretResolutions += 1;
        throw new Error("must not resolve");
      },
      createBroker: async () => {
        brokerStarts += 1;
        throw new Error("must not open");
      },
      now: () => new Date("2026-07-12T11:59:00.000Z"),
      randomId: () => "77777777-7777-4777-8777-777777777777",
    });

    expect(secretResolutions).toBe(0);
    expect(brokerStarts).toBe(0);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_receipt_contract_invalid" },
    });
  });

  it.each([
    ["migration-only", { migrationOnly: true }],
    ["authority-less", { providerPolicyAuthority: null }],
  ])("rejects a %s managed POS closure before resolving credentials", async (_label, override) => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    let secretResolutions = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: {
        ...fixture.managedPosRuntime,
        ...override,
      },
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
    }, {
      resolveCredential: async () => {
        secretResolutions += 1;
        throw new Error("must not resolve");
      },
      now: () => new Date("2026-07-12T11:59:00.000Z"),
      randomId: () => "77777777-7777-4777-8777-777777777775",
    });

    expect(secretResolutions).toBe(0);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_managed_pos_runtime_not_authoritative" },
    });
  });

  it("retains exact v2 receipt compatibility while v3 is current", async () => {
    const fixture = await fixtureRoot({ schema_version: "pos.profit_flywheel_canary.v2" });
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    let secretResolutions = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
    }, {
      resolveCredential: async () => {
        secretResolutions += 1;
        throw new Error("expected-v2-compatibility-probe");
      },
      now: () => new Date("2026-07-12T11:59:00.000Z"),
      randomId: () => "77777777-7777-4777-8777-777777777776",
    });

    expect(secretResolutions).toBe(1);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_api_key_resolution_failed" },
    });
  });

  it("rejects an outside/production target before resolving a credential or opening the broker", async () => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    const hostile = JSON.parse(await readFile(fixture.canaryReceiptPath, "utf8"));
    hostile.target_workspace = await realpath(fixture.portfolioOsRoot);
    await chmod(fixture.canaryReceiptPath, 0o600);
    await writeFile(fixture.canaryReceiptPath, `${JSON.stringify(hostile)}\n`, "utf8");
    await chmod(fixture.canaryReceiptPath, 0o444);
    let secretResolutions = 0;
    let brokerStarts = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
    }, {
      resolveCredential: async () => {
        secretResolutions += 1;
        throw new Error("must not resolve");
      },
      createBroker: async () => {
        brokerStarts += 1;
        throw new Error("must not open");
      },
      now: () => new Date("2026-07-12T11:59:30.000Z"),
      randomId: () => "abababab-abab-4bab-8bab-abababababab",
    });

    expect(secretResolutions).toBe(0);
    expect(brokerStarts).toBe(0);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_fixture_target_outside_canonical_run" },
    });
  });

  it("uses an exact-scope loopback broker and gives the child only a per-run sentinel", async () => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    const moduleSource = `
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--receipt", required=True)
parser.add_argument("--outbox-dir", required=True)
parser.add_argument("--promotion-receipt-dir", required=True)
parser.add_argument("--wait-seconds", required=True)
parser.add_argument("--poll-seconds", required=True)
args = parser.parse_args()
receipt = json.loads(Path(args.receipt).read_text())
company_id = receipt["paperclip"]["company_id"]
project_id = receipt["paperclip"]["project_id"]
run_id = receipt["run_id"]
base = os.environ["PAPERCLIP_API_URL"]
sentinel = os.environ["PAPERCLIP_API_KEY"]
headers = {"Authorization": "Bearer " + sentinel}
blocked_status = None
try:
    urlopen(Request(base + "/api/companies/" + company_id + "/issues", headers=headers))
except HTTPError as exc:
    blocked_status = exc.code
broadened_query_status = None
try:
    urlopen(Request(base + "/api/companies/" + company_id + "/profit-flywheel/workflows?correlation_id=profit-canary%3Aother&limit=10", headers=headers))
except HTTPError as exc:
    broadened_query_status = exc.code
urlopen(Request(base + "/api/projects/" + project_id, headers=headers)).read()
urlopen(Request(base + "/api/companies/" + company_id + "/profit-flywheel/workflows?correlation_id=profit-canary%3A" + run_id + "&limit=10", headers=headers)).read()
promotion_root = Path(args.promotion_receipt_dir)
(promotion_root / "child-env-report.json").write_text(json.dumps({
    "blocked_status": blocked_status,
    "broadened_query_status": broadened_query_status,
    "has_database_url": "DATABASE_URL" in os.environ,
    "has_parent_api_key": "UNRELATED_API_KEY" in os.environ,
    "sentinel_shape": sentinel.startswith("paperclip-broker-"),
    "env_keys": sorted(os.environ.keys()),
}))
published = Path(args.outbox_dir) / ("dispatch_" + run_id + ".json")
promotion = promotion_root / (run_id + "-promotion.json")
observation = promotion_root / (run_id + "-workflow-observation.json")
source_dispatch = receipt["artifacts"]["dispatch"]
source_bytes = Path(source_dispatch["path"]).read_bytes()
published.write_bytes(source_bytes)
published.chmod(0o444)
published_binding = {
    "path": str(published.resolve()),
    "sha256": hashlib.sha256(source_bytes).hexdigest(),
}
canary_bytes = Path(args.receipt).read_bytes()
promotion_payload = {
    "schema_version": "pos.profit_flywheel_canary_promotion.v1",
    "state": "published",
    "run_id": run_id,
    "company_id": company_id,
    "project_id": project_id,
    "correlation_id": "profit-canary:" + run_id,
    "published_path": published_binding["path"],
    "published_sha256": published_binding["sha256"],
    "canary_receipt": {
        "path": str(Path(args.receipt).resolve()),
        "sha256": hashlib.sha256(canary_bytes).hexdigest(),
    },
    "source_dispatch": source_dispatch,
    "published_dispatch": published_binding,
    "immutable": True,
}
promotion.write_text(json.dumps(promotion_payload) + "\\n")
promotion.chmod(0o444)
promotion_binding = {
    "path": str(promotion.resolve()),
    "sha256": hashlib.sha256(promotion.read_bytes()).hexdigest(),
}
observation_payload = {
    "schema_version": "pos.profit_flywheel_canary_workflow_observation.v1",
    "state": "workflow_observed",
    "immutable": True,
    "promotion_receipt": promotion_binding,
    "published_dispatch": published_binding,
    "workflow": {
        "id": "${WORKFLOW_ID}",
        "companyId": company_id,
        "projectId": project_id,
        "runId": run_id,
        "correlationId": "profit-canary:" + run_id,
        "sourceDispatchPath": published_binding["path"],
        "sourceDispatchHash": published_binding["sha256"],
    },
}
for artifact, payload in [(observation, observation_payload)]:
    artifact.write_text(json.dumps(payload) + "\\n")
    artifact.chmod(0o444)
print("canary_status=workflow_observed")
print("published_dispatch=" + str(published.resolve()))
print("promotion_receipt=" + str(promotion.resolve()))
print("observation_receipt=" + str(observation.resolve()))
print("workflow_id=${WORKFLOW_ID}")
`;
    await writeRuntimeModule(fixture, moduleSource);

    const seenAuthorization: string[] = [];
    const seenPaths: string[] = [];
    const upstream = createServer((request, response) => {
      seenAuthorization.push(request.headers.authorization ?? "");
      seenPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.startsWith(`/api/projects/${PROJECT_ID}`)
        ? JSON.stringify({ id: PROJECT_ID, companyId: COMPANY_ID, workspaces: [] })
        : "[]");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    let brokerClosed = false;
    let brokerSentinel = "";
    try {
      const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const outcome = await runSecureProfitCanaryPromotion({} as Db, {
        companyId: COMPANY_ID,
        portfolioOsRoot: fixture.portfolioOsRoot,
        managedPosRuntime: fixture.managedPosRuntime,
        canaryReceiptPath: fixture.canaryReceiptPath,
        outboxDir: fixture.outboxDir,
        promotionReceiptDir: fixture.promotionReceiptDir,
        aggregateReceiptDir: fixture.aggregateReceiptDir,
        paperclipApiUrl: upstreamUrl,
        waitSeconds: 0,
        pollSeconds: 0.05,
        paperclipRuntime: {
          homeDir: "/live/paperclip",
          instanceId: "default",
          instanceRoot: "/live/paperclip/instances/default",
          configPath: "/live/paperclip/instances/default/config.json",
        },
      }, {
        resolveCredential: async () => ({
          value: REAL_BEARER,
          binding: {
            secret_id: "22222222-2222-4222-8222-222222222222",
            version: 1,
            value_sha256: "a".repeat(64),
            provider: "local_encrypted",
          },
        }),
        createBroker: async (input) => {
          const created = await createRunScopedPaperclipApiBroker(input);
          brokerSentinel = created.childAuthToken;
          return {
            ...created,
            async close() {
              await created.close();
              brokerClosed = true;
            },
          };
        },
        verifyPersistedWorkflow: async (_db, input) => input,
        environment: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          DATABASE_URL: "postgres://must-not-reach-child",
          PAPERCLIP_API_KEY: REAL_BEARER,
          UNRELATED_API_KEY: "must-not-reach-child",
        },
        now: () => new Date("2026-07-12T12:00:00.000Z"),
        randomId: () => "33333333-3333-4333-8333-333333333333",
      });

      expect(outcome).toMatchObject({
        status: "succeeded",
        runId: RUN_ID,
        blocker: null,
        result: { state: "workflow_observed", workflow_id: WORKFLOW_ID },
      });
      expect(brokerClosed).toBe(true);
      expect(seenPaths).toEqual([
        `/api/projects/${PROJECT_ID}`,
        `/api/companies/${COMPANY_ID}/profit-flywheel/workflows?correlation_id=profit-canary%3A${RUN_ID}&limit=10`,
      ]);
      expect(seenAuthorization).toEqual([`Bearer ${REAL_BEARER}`, `Bearer ${REAL_BEARER}`]);
      const childReport = JSON.parse(await readFile(path.join(fixture.promotionReceiptDir, "child-env-report.json"), "utf8"));
      expect(childReport).toMatchObject({
        blocked_status: 403,
        broadened_query_status: 403,
        has_database_url: false,
        has_parent_api_key: false,
        sentinel_shape: true,
      });
      expect(childReport.env_keys).toEqual(expect.arrayContaining(["PAPERCLIP_API_KEY", "PAPERCLIP_API_URL"]));
      const aggregate = await readFile(outcome.receiptPath, "utf8");
      expect((await stat(outcome.receiptPath)).mode & 0o777).toBe(0o444);
      expect(aggregate).not.toContain(REAL_BEARER);
      expect(aggregate).not.toContain(brokerSentinel);
      expect(aggregate).not.toContain("must-not-reach-child");
      expect(aggregate).toContain('"secrets_in_argv": false');
      expect(aggregate).toContain('"real_paperclip_bearer_in_child_environment": false');
      expect(JSON.parse(aggregate).inputs.paperclip_runtime).toEqual({
        homeDir: "/live/paperclip",
        instanceId: "default",
        instanceRoot: "/live/paperclip/instances/default",
        configPath: "/live/paperclip/instances/default/config.json",
      });
      expect(JSON.parse(aggregate).inputs.managed_pos_runtime).toMatchObject({
        schema_version: "paperclip.managed_pos_runtime_invocation.v1",
        runtime_id: fixture.managedPosRuntime.current.runtime_id,
        closure_sha256: fixture.managedPosRuntime.current.closure_sha256,
        package_root: fixture.runtimePackageRoot,
        provider_policy_authority: fixture.managedPosRuntime.providerPolicyAuthority,
        python: { path: fixture.runtimePython },
      });
      expect(JSON.parse(aggregate).child.command).toBe(fixture.runtimePython);
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("closes the broker and emits a redacted immutable blocker receipt on child failure", async () => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    const sentinel = "paperclip-broker-abcdefghijklmnopqrstuvwxyz123456";
    let closed = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
      waitSeconds: 0,
      pollSeconds: 0.05,
    }, {
      resolveCredential: async () => ({
        value: REAL_BEARER,
        binding: {
          secret_id: "22222222-2222-4222-8222-222222222222",
          version: 1,
          value_sha256: "a".repeat(64),
          provider: "local_encrypted",
        },
      }),
      createBroker: async () => ({
        url: "http://127.0.0.1:49152",
        childAuthToken: sentinel,
        async close() { closed += 1; },
      }),
      runChild: async (input) => {
        expect(input.command).toBe(fixture.runtimePython);
        expect(input.cwd).toBe(fixture.runtimePackageRoot);
        expect(input.args).toContain("pos.profit_canary");
        expect(input.args.join(" ")).not.toContain(REAL_BEARER);
        expect(input.env.PAPERCLIP_API_KEY).toBe(sentinel);
        expect(input.env).not.toHaveProperty("DATABASE_URL");
        return {
          exitCode: 1,
          signal: null,
          stdout: sentinel,
          stderr: `Traceback origin accidentally echoed ${REAL_BEARER} and ${sentinel}\n${"stack frame ".repeat(80)}\nProfitCanaryError: terminal actionable cause`,
          timedOut: false,
          aborted: false,
          outputLimitExceeded: false,
          spawnErrorCode: null,
        };
      },
      now: () => new Date("2026-07-12T12:01:00.000Z"),
      randomId: () => "44444444-4444-4444-8444-444444444444",
    });

    expect(closed).toBe(1);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_child_failed", next_owner: "portfolio_os_canary_owner" },
    });
    const receipt = await readFile(outcome.receiptPath, "utf8");
    expect(receipt).not.toContain(REAL_BEARER);
    expect(receipt).not.toContain(sentinel);
    expect(receipt).toContain("***REDACTED***");
    expect(receipt).toContain("Traceback origin accidentally echoed");
    expect(receipt).toContain("ProfitCanaryError: terminal actionable cause");
    expect((await stat(outcome.receiptPath)).mode & 0o777).toBe(0o444);
  });

  it.each([
    ["non-UUID", "not-a-uuid", "not-a-uuid", "profit_canary_workflow_id_invalid"],
    [
      "observation-unbound UUID",
      WORKFLOW_ID,
      "66666666-6666-4666-8666-666666666666",
      "profit_canary_workflow_id_binding_mismatch",
    ],
  ])("refuses a %s workflow id", async (_label, outputWorkflowId, observationWorkflowId, blockerCode) => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    const artifacts = await writeTerminalFixtureArtifacts(fixture, {
      outputWorkflowId,
      observationWorkflowId,
    });
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
      waitSeconds: 0,
      pollSeconds: 0.05,
    }, {
      resolveCredential: async () => ({
        value: REAL_BEARER,
        binding: {
          secret_id: "22222222-2222-4222-8222-222222222222",
          version: 1,
          value_sha256: "a".repeat(64),
          provider: "local_encrypted",
        },
      }),
      createBroker: async () => ({
        url: "http://127.0.0.1:49153",
        childAuthToken: "paperclip-broker-abcdefghijklmnopqrstuvwxyz654321",
        async close() {},
      }),
      runChild: async () => ({
        exitCode: 0,
        signal: null,
        stdout: artifacts.stdout,
        stderr: "",
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        spawnErrorCode: null,
      }),
      now: () => new Date("2026-07-12T12:02:00.000Z"),
      randomId: () => "88888888-8888-4888-8888-888888888888",
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: blockerCode },
    });
  });

  it("blocks expected-path artifacts whose published bytes differ from the immutable source dispatch", async () => {
    const fixture = await fixtureRoot();
    roots.push(fixture.root);
    await writeRuntimeModule(fixture, "# fixture\n");
    const artifacts = await writeTerminalFixtureArtifacts(fixture, {
      outputWorkflowId: WORKFLOW_ID,
      publishedBytes: Buffer.from('{"hostile":"different-dispatch-bytes"}\n', "utf8"),
    });
    let persistedVerifications = 0;
    const outcome = await runSecureProfitCanaryPromotion({} as Db, {
      companyId: COMPANY_ID,
      portfolioOsRoot: fixture.portfolioOsRoot,
      managedPosRuntime: fixture.managedPosRuntime,
      canaryReceiptPath: fixture.canaryReceiptPath,
      outboxDir: fixture.outboxDir,
      promotionReceiptDir: fixture.promotionReceiptDir,
      aggregateReceiptDir: fixture.aggregateReceiptDir,
      waitSeconds: 0,
      pollSeconds: 0.05,
    }, {
      resolveCredential: async () => ({
        value: REAL_BEARER,
        binding: {
          secret_id: "22222222-2222-4222-8222-222222222222",
          version: 1,
          value_sha256: "a".repeat(64),
          provider: "local_encrypted",
        },
      }),
      createBroker: async () => ({
        url: "http://127.0.0.1:49154",
        childAuthToken: "paperclip-broker-abcdefghijklmnopqrstuvwxyz111111",
        async close() {},
      }),
      runChild: async () => ({
        exitCode: 0,
        signal: null,
        stdout: artifacts.stdout,
        stderr: "",
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        spawnErrorCode: null,
      }),
      verifyPersistedWorkflow: async (_db, input) => {
        persistedVerifications += 1;
        return input;
      },
      now: () => new Date("2026-07-12T12:03:00.000Z"),
      randomId: () => "99999999-9999-4999-8999-999999999999",
    });

    expect(persistedVerifications).toBe(0);
    expect(outcome).toMatchObject({
      status: "blocked",
      blocker: { blocker_code: "profit_canary_published_dispatch_bytes_mismatch" },
    });
  });

  it("never creates a missing or replacement master key during configured-key preflight", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-promotion-master-key-")));
    roots.push(root);
    const missingKey = path.join(root, "missing-master.key");
    await expect(requireExistingConfiguredMasterKey(missingKey))
      .rejects.toThrow("profit_canary_master_key_missing");
    await expect(access(missingKey)).rejects.toMatchObject({ code: "ENOENT" });

    const invalidKey = path.join(root, "invalid-master.key");
    await writeFile(invalidKey, "definitely-not-the-live-master-key\n", { mode: 0o600 });
    await chmod(invalidKey, 0o600);
    const before = await readFile(invalidKey);
    const priorInlineKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const priorKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    try {
      await expect(resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey(
        {} as Db,
        COMPANY_ID,
        invalidKey,
      )).rejects.toThrow("profit_canary_master_key_invalid");
    } finally {
      if (priorInlineKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorInlineKey;
      if (priorKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = priorKeyFile;
    }
    expect(await readFile(invalidKey)).toEqual(before);
    expect((await stat(invalidKey)).mode & 0o777).toBe(0o600);
  });
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedSupport.supported ? describe : describe.skip;

describeDb("secure Profit Flywheel fixture promotion secret resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const priorMasterKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  let masterKeyRoot = "";
  let masterKeyPath = "";

  beforeAll(async () => {
    masterKeyRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-promotion-key-")));
    masterKeyPath = path.join(masterKeyRoot, "master.key");
    await writeFile(masterKeyPath, `${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}\n`, { mode: 0o600 });
    await chmod(masterKeyPath, 0o600);
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = masterKeyPath;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secure-promotion-db-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(profitFlywheelWorkflows);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(masterKeyRoot, { recursive: true, force: true });
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    if (priorMasterKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = priorMasterKeyFile;
  });

  it("decrypts only the active local_encrypted company API key and verifies its fingerprint", async () => {
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Secure canary company",
      issuePrefix: `SC${randomUUID().replaceAll("-", "").slice(0, 4)}`,
    });
    const secretId = randomUUID();
    const prepared = await getSecretProvider("local_encrypted").createVersion({
      value: REAL_BEARER,
      externalRef: null,
    });
    await db.insert(companySecrets).values({
      id: secretId,
      companyId: COMPANY_ID,
      name: "PAPERCLIP_API_KEY",
      provider: "local_encrypted",
      latestVersion: 1,
    });
    await db.insert(companySecretVersions).values({
      secretId,
      version: 1,
      material: prepared.material,
      valueSha256: prepared.valueSha256,
    });

    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const resolved = await resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey(
      db,
      COMPANY_ID,
      masterKeyPath,
    );
    expect(resolved.value).toBe(REAL_BEARER);
    expect(resolved.binding).toEqual({
      secret_id: secretId,
      version: 1,
      value_sha256: prepared.valueSha256,
      provider: "local_encrypted",
    });
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE).toBeUndefined();
  });

  it("uses the validated in-memory key when the configured file is replaced after preflight", async () => {
    const encodedKey = `${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}\n`;
    await writeFile(masterKeyPath, encodedKey, { mode: 0o600 });
    await chmod(masterKeyPath, 0o600);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = masterKeyPath;
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Secure canary key-race company",
      issuePrefix: `KR${randomUUID().replaceAll("-", "").slice(0, 4)}`,
    });
    const secretId = randomUUID();
    const prepared = await getSecretProvider("local_encrypted").createVersion({
      value: REAL_BEARER,
      externalRef: null,
    });
    await db.insert(companySecrets).values({
      id: secretId,
      companyId: COMPANY_ID,
      name: "PAPERCLIP_API_KEY",
      provider: "local_encrypted",
      latestVersion: 1,
    });
    await db.insert(companySecretVersions).values({
      secretId,
      version: 1,
      material: prepared.material,
      valueSha256: prepared.valueSha256,
    });
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

    const resolved = await resolveProvisionedProfitCanaryApiKeyWithConfiguredMasterKey(
      db,
      COMPANY_ID,
      masterKeyPath,
      {
        afterMasterKeyRead: async () => {
          await rm(masterKeyPath);
          await writeFile(masterKeyPath, "not-the-instance-key\n", { mode: 0o600 });
        },
      },
    );
    expect(resolved.value).toBe(REAL_BEARER);
    expect(await readFile(masterKeyPath, "utf8")).toBe("not-the-instance-key\n");
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE).toBeUndefined();
  });

  it("independently requires exactly one persisted workflow with the full source binding", async () => {
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Persisted canary company",
      issuePrefix: `PW${randomUUID().replaceAll("-", "").slice(0, 4)}`,
    });
    await db.insert(projects).values({
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      name: "Persisted canary project",
    });
    const expected = {
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: `profit-canary:${RUN_ID}`,
      sourceDispatchPath: "/safe/outbox/dispatch_fixture-secure-promotion.json",
      sourceDispatchHash: "b".repeat(64),
      targetRepo: "fixture/profit-canary" as const,
      targetWorkspaceRoot: "/safe/target-workspace",
    };
    await db.insert(profitFlywheelWorkflows).values({
      ...expected,
      state: "running",
      currentStage: "dispatch",
      sourceSchemaVersion: "pos.dispatch.v2",
      contractPath: "/safe/profit-flywheel.v2.yaml",
      contractSha256: "c".repeat(64),
      contractSnapshot: {},
      traceId: "d".repeat(32),
    });

    await expect(verifyPersistedProfitCanaryWorkflow(db, expected)).resolves.toEqual(expected);
    await expect(verifyPersistedProfitCanaryWorkflow(db, {
      ...expected,
      sourceDispatchHash: "e".repeat(64),
    })).rejects.toThrow("profit_canary_workflow_db_binding_missing");
  });
});
