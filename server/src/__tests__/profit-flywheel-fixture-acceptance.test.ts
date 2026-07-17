import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFixtureAcceptanceCliArgs,
  runProfitFlywheelFixtureAcceptance,
} from "../ops/profit-flywheel-fixture-acceptance.js";

type JsonRecord = Record<string, unknown>;

const roots: string[] = [];

function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonRecord).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as JsonRecord)[key])}`).join(",")}}`;
  }
  throw new Error("invalid test fixture value");
}

async function immutableFile(filePath: string, value: string) {
  const bytes = Buffer.from(value, "utf8");
  await writeFile(filePath, bytes, { mode: 0o400 });
  await chmod(filePath, 0o444);
  return { path: filePath, sha256: digest(bytes) };
}

async function immutableJson(filePath: string, value: unknown) {
  return immutableFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function authority(input: {
  iteration: number;
  targetRepo: string;
  offlineFixture: { path: string; sha256: string };
  sourceRegistry: { path: string; sha256: string };
  now: Date;
}) {
  const sourceRequests = [{
    source_id: "fixture-voc",
    source_kind: "forum",
    authority_class: "registry",
    evidence_families: ["voc"],
    query_families: ["voc"],
    query: `fixture iteration ${input.iteration}`,
    url_template: "file://{absolute_fixture_path}",
    template_values: { absolute_fixture_path: input.offlineFixture.path },
    approved_domains: [],
    approved_file_roots: [path.dirname(input.offlineFixture.path)],
    legal: {
      permitted_use: "synthetic fixture",
      robots_policy: "not_applicable",
      terms_status: "approved",
      approval_owner: "portfolio_os",
      runtime_approval: {
        status: "registry_approved",
        owner: "portfolio_os",
        approved_at: null,
        expires_at: null,
        artifact_ref: null,
        artifact_sha256: null,
      },
    },
    authentication: {
      requirement: "none",
      runtime_ref_name: null,
      allowed_header_names: [],
    },
    extractor: "json_fixture",
    freshness_sla_hours: 24,
    offline_fixture: input.offlineFixture,
  }];
  return {
    schema_version: "pos.next_research_authorization.v2",
    mode: "fixture",
    iteration: input.iteration,
    target_repo: input.targetRepo,
    source_registry: {
      ...input.sourceRegistry,
      schema_version: "pos.research_sources.v2",
    },
    evidence_families: ["voc"],
    query_families: ["voc"],
    query: `fixture iteration ${input.iteration}`,
    source_requests: sourceRequests,
    governance: {
      owner: "portfolio_os",
      authorized_at: input.now.toISOString(),
      expires_at: new Date(input.now.getTime() + 3_600_000).toISOString(),
      collection_window_policy: {
        not_before: input.now.toISOString(),
        max_duration_seconds: 3_600,
      },
    },
    source_plan_hash: digest(stableJson(sourceRequests)),
    immutable: true,
  };
}

async function createCycle(
  base: string,
  sequence: number,
  mutate?: (evidence: JsonRecord) => void,
) {
  const cycleId = `cycle-${String(sequence).padStart(2, "0")}`;
  const root = path.join(base, cycleId);
  await mkdir(root, { mode: 0o700 });
  const now = new Date(Date.UTC(2026, 6, 17, 12, sequence, 0));
  const targetRepo = "fixture/profit-canary";
  const input1 = await immutableJson(path.join(root, "input-1.json"), { iteration: 1, signal: "alpha" });
  const input2 = await immutableJson(path.join(root, "input-2.json"), { iteration: 2, signal: "beta" });
  const input3 = await immutableJson(path.join(root, "input-3.json"), { iteration: 3, signal: "gamma" });
  const sourceRegistry = await immutableJson(path.join(root, "registry.json"), {
    schema_version: "pos.research_sources.v2",
    sources: ["fixture-voc"],
  });
  const ledger1 = await immutableJson(path.join(root, "ledger-1.json"), { iteration: 1, score: 1 });
  const ledger2 = await immutableJson(path.join(root, "ledger-2.json"), { iteration: 2, score: 2 });
  const normalizationReceipt1 = await immutableJson(path.join(root, "normalization-receipt-1.json"), { passed: true });
  const normalizationReceipt2 = await immutableJson(path.join(root, "normalization-receipt-2.json"), { passed: true });
  const iteration2AuthorityValue = authority({
    iteration: 2,
    targetRepo,
    offlineFixture: input2,
    sourceRegistry,
    now,
  });
  const iteration2Authority = await immutableJson(
    path.join(root, "iteration-2-authority.json"),
    iteration2AuthorityValue,
  );
  const iteration3Authority = await immutableJson(
    path.join(root, "iteration-3-authority.json"),
    authority({ iteration: 3, targetRepo, offlineFixture: input3, sourceRegistry, now }),
  );
  const sourceRun1 = await immutableJson(path.join(root, "source-run-1.json"), {
    schema_version: "pos.source_run_receipt.v2",
    plan: {
      schema_version: "pos.paperclip_research_execution_plan.v1",
      target_repo: targetRepo,
      source_registry_sha256: sourceRegistry.sha256,
      source_requests: (iteration2AuthorityValue.source_requests as unknown[]),
    },
  });
  const raw1 = await immutableJson(path.join(root, "raw-1.json"), {
    schema_version: "pos.raw_evidence_manifest.v2",
    target_repo: targetRepo,
    source_registry_sha256: sourceRegistry.sha256,
    source_run_receipt: sourceRun1,
    fixture_input: input1,
  });
  const sourceRun2 = await immutableJson(path.join(root, "source-run-2.json"), {
    schema_version: "pos.source_run_receipt.v2",
    plan: {
      schema_version: "pos.paperclip_research_execution_plan.v1",
      target_repo: targetRepo,
      source_registry_sha256: sourceRegistry.sha256,
      source_requests: (iteration2AuthorityValue.source_requests as unknown[]),
      continuation: {
        iteration: 2,
        prior_raw_evidence_sha256: raw1.sha256,
        authorization: {
          schema_version: "pos.next_research_authorization.v2",
          ...iteration2Authority,
        },
      },
    },
  });
  const raw2 = await immutableJson(path.join(root, "raw-2.json"), {
    schema_version: "pos.raw_evidence_manifest.v2",
    target_repo: targetRepo,
    source_registry_sha256: sourceRegistry.sha256,
    source_run_receipt: sourceRun2,
    fixture_input: input2,
  });
  const evidence: JsonRecord = {
    schema_version: "paperclip.profit_flywheel_two_iteration_evidence.v1",
    mode: "fixture",
    isolation_root: root,
    identity: {
      company_id: `company-${sequence}`,
      workflow_id: `workflow-${sequence}`,
      run_id: `run-${sequence}`,
      correlation_id: `profit-canary:run-${sequence}`,
      target_repo: targetRepo,
    },
    runtime_guard: {
      network_access: false,
      provider_calls: 0,
      external_mutations: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    },
    iterations: [
      {
        iteration: 1,
        research_intake: {
          stage_run_id: `research-${sequence}-1`,
          state: "succeeded",
          owner_plane: "portfolio_os",
          raw_evidence: raw1,
          receipts: [sourceRun1, raw1],
        },
        evidence_normalization: {
          stage_run_id: `normalization-${sequence}-1`,
          state: "succeeded",
          owner_plane: "portfolio_os",
          ledger: ledger1,
          receipts: [normalizationReceipt1],
        },
      },
      {
        iteration: 2,
        research_intake: {
          stage_run_id: `research-${sequence}-2`,
          state: "succeeded",
          owner_plane: "portfolio_os",
          raw_evidence: raw2,
          receipts: [sourceRun2, raw2],
        },
        evidence_normalization: {
          stage_run_id: `normalization-${sequence}-2`,
          state: "succeeded",
          owner_plane: "portfolio_os",
          ledger: ledger2,
          receipts: [normalizationReceipt2],
        },
      },
    ],
    continuation: {
      learning_output_hash: "c".repeat(64),
      authority: iteration2Authority,
      not_before: now.toISOString(),
      expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      due_claimed_at: new Date(now.getTime() + 1_000).toISOString(),
      reconciliation_interval_ms: 1_000,
      manual_consumer_invocations: 0,
    },
    next_research: {
      iteration: 3,
      stage_run_id: `research-${sequence}-3`,
      state: "pending",
      owner_plane: "portfolio_os",
      event_count: 1,
      authority: iteration3Authority,
      manual_consumer_invocations: 0,
    },
    invariants: {
      same_workflow: true,
      same_correlation_lineage: true,
      duplicate_stage_count: 0,
      duplicate_release_count: 0,
      orphan_lease_count: 0,
      all_receipts_verified: true,
    },
    completed_at: new Date(now.getTime() + 3_000).toISOString(),
  };
  mutate?.(evidence);
  const evidenceBinding = await immutableJson(path.join(root, "evidence.json"), evidence);
  return { cycle_id: cycleId, evidence: evidenceBinding };
}

async function createHarness(
  cycleCount = 20,
  mutate?: (evidence: JsonRecord) => void,
) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-fixture-acceptance-")));
  roots.push(base);
  const cycleRoot = path.join(base, "cycles");
  const receiptDir = path.join(base, "receipts");
  await mkdir(cycleRoot, { mode: 0o700 });
  await mkdir(receiptDir, { mode: 0o700 });
  const cycles = [];
  for (let index = 1; index <= cycleCount; index += 1) {
    cycles.push(await createCycle(cycleRoot, index, index === 1 ? mutate : undefined));
  }
  const manifest = await immutableJson(path.join(base, "manifest.json"), {
    schema_version: "paperclip.profit_flywheel_fixture_acceptance_manifest.v1",
    required_consecutive_cycles: 20,
    cycles,
  });
  return { manifestPath: manifest.path, receiptDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Profit Flywheel two-iteration fixture acceptance", () => {
  it("seals exactly 20 isolated no-spend cycles and is idempotent", async () => {
    const harness = await createHarness();
    const first = await runProfitFlywheelFixtureAcceptance(harness);
    const replay = await runProfitFlywheelFixtureAcceptance(harness);

    expect(first).toMatchObject({ status: "passed", passedCycles: 20 });
    expect(replay.receiptSha256).toBe(first.receiptSha256);
    expect((first.receipt.cycles as unknown[])).toHaveLength(20);
    expect(first.receipt.invariants).toMatchObject({
      exactly_two_completed_iterations_per_cycle: true,
      next_research_queued_per_cycle: true,
      manual_consumer_invocations: 0,
      network_access: false,
      provider_calls: 0,
      external_mutations: 0,
      cost_usd: 0,
    });
    expect((await stat(first.receiptPath)).mode & 0o777).toBe(0o444);
    const closeout = JSON.parse(await readFile(
      path.join(harness.receiptDir, "01-cycle-01-two-iteration-closeout.json"),
      "utf8",
    ));
    expect(closeout).toMatchObject({
      schema_version: "paperclip.profit_flywheel_two_iteration_closeout.v1",
      mode: "fixture",
      first_iteration: { iteration: 1 },
      second_iteration: { iteration: 2 },
      next_research: { iteration: 3, state: "pending", event_count: 1 },
    });
    const schema = JSON.parse(await readFile(
      path.resolve(process.cwd(), "contracts/profit-flywheel/two-iteration-closeout.v1.schema.json"),
      "utf8",
    ));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(closeout), JSON.stringify(validate.errors)).toBe(true);
  });

  it("fails closed when the target is not fixture-only", async () => {
    const harness = await createHarness(20, (evidence) => {
      (evidence.identity as JsonRecord).target_repo = "real/live-repo";
    });
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_live_target_forbidden");
  });

  it("fails closed when the third research intake is not uniquely queued", async () => {
    const harness = await createHarness(20, (evidence) => {
      (evidence.next_research as JsonRecord).event_count = 2;
    });
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_next_research_not_queued");
  });

  it("fails closed when the second raw evidence hash does not advance", async () => {
    const harness = await createHarness(20, (evidence) => {
      const iterations = evidence.iterations as JsonRecord[];
      const firstResearch = iterations[0]!.research_intake as JsonRecord;
      const secondResearch = iterations[1]!.research_intake as JsonRecord;
      secondResearch.raw_evidence = firstResearch.raw_evidence;
      secondResearch.receipts = firstResearch.receipts;
    });
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_raw_evidence_hash_unchanged");
  });

  it("fails closed when a manual consumer invocation is claimed", async () => {
    const harness = await createHarness(20, (evidence) => {
      (evidence.continuation as JsonRecord).manual_consumer_invocations = 1;
    });
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_autonomous_continuation_invalid");
  });

  it("fails closed when a bound artifact becomes mutable", async () => {
    const harness = await createHarness();
    const manifest = JSON.parse(await readFile(harness.manifestPath, "utf8"));
    const evidence = JSON.parse(await readFile(manifest.cycles[0].evidence.path, "utf8"));
    await chmod(evidence.iterations[0].research_intake.raw_evidence.path, 0o644);
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_iteration_1_raw_evidence_unsafe_file");
  });

  it("rejects partial acceptance runs instead of lowering the 20-cycle gate", async () => {
    const harness = await createHarness(19);
    await expect(runProfitFlywheelFixtureAcceptance(harness))
      .rejects.toThrow("fixture_acceptance_requires_exactly_20_cycles");
  });

  it("accepts only the two path flags and rejects inline or duplicate values", () => {
    expect(parseFixtureAcceptanceCliArgs([
      "--manifest", "/tmp/manifest.json", "--receipt-dir", "/tmp/receipts",
    ])).toEqual({ manifestPath: "/tmp/manifest.json", receiptDir: "/tmp/receipts" });
    expect(() => parseFixtureAcceptanceCliArgs(["--manifest=/tmp/manifest.json"]))
      .toThrow("fixture_acceptance_argument_invalid");
    expect(() => parseFixtureAcceptanceCliArgs(["--manifest", "/tmp/manifest.json"]))
      .toThrow("fixture_acceptance_receipt_dir_required");
  });
});
