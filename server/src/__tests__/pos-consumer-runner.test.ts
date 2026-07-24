import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPosConsumerAttempt,
  posConsumerCrashJournalSchema,
  posConsumerEnvelopeSchema,
  runPosConsumerAttempt,
  type PosConsumerEnvelope,
} from "../services/pos-consumer-runner.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const execFile = promisify(execFileCallback);
const roots: string[] = [];
const API_KEY = "api-key-value-that-is-long-and-distinct";
const JOURNAL_KEY = "journal-value-that-is-long-and-distinct";
const originalProviderPolicyEnvironment = {
  path: process.env.PAPERCLIP_PROVIDER_POLICY_PATH,
  schemaPath: process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH,
  sha256: process.env.PAPERCLIP_PROVIDER_POLICY_SHA256,
  schemaSha256: process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256,
};

function restoreEnvironmentValue(name: keyof typeof originalProviderPolicyEnvironment) {
  const value = originalProviderPolicyEnvironment[name];
  const environmentName = name === "path" ? "PAPERCLIP_PROVIDER_POLICY_PATH"
    : name === "schemaPath" ? "PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH"
      : name === "sha256" ? "PAPERCLIP_PROVIDER_POLICY_SHA256"
        : "PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256";
  if (value === undefined) delete process.env[environmentName];
  else process.env[environmentName] = value;
}

function asciiJsonString(value: string) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return asciiJsonString(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${asciiJsonString(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("unsupported fixture JSON");
}

function canonicalJson(value: unknown) {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, canonicalize(child)]));
    }
    return entry;
  };
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
}

async function createProviderPolicyAuthority(root: string) {
  const packageId = "f".repeat(64);
  const managedRuntimeRoot = path.join(root, "managed-paperclip-runtime");
  const configDirectory = path.join(managedRuntimeRoot, "packages", packageId, "config");
  const policyPath = path.join(configDirectory, "provider-policy.v2.json");
  const schemaPath = path.join(configDirectory, "provider-policy.v2.schema.json");
  const [policyBytes, schemaBytes] = await Promise.all([
    readFile(path.resolve(process.cwd(), "config/provider-policy.v2.json")),
    readFile(path.resolve(process.cwd(), "config/provider-policy.v2.schema.json")),
  ]);
  const historyPath = path.join(configDirectory, "provider-policy-history", `${sha256(policyBytes)}.json`);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(policyPath, policyBytes, { mode: 0o600 });
  await writeFile(schemaPath, schemaBytes, { mode: 0o600 });
  await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  await writeFile(historyPath, policyBytes, { mode: 0o600 });
  await Promise.all([chmod(policyPath, 0o444), chmod(schemaPath, 0o444), chmod(historyPath, 0o444)]);
  const descriptor = {
    authority: "paperclip_control_plane",
    provider_policy: {
      path: policyPath,
      schema_path: schemaPath,
      schema_sha256: sha256(schemaBytes),
      schema_version: "provider-policy.v2",
      sha256: sha256(policyBytes),
    },
    schema_version: "pos.paperclip_provider_policy_authority.v1",
  };
  const descriptorBytes = canonicalJson(descriptor);
  const authorityDirectory = path.join(managedRuntimeRoot, "authorities", "provider-policy");
  const authorityPath = path.join(authorityDirectory, `${sha256(descriptorBytes)}.json`);
  await mkdir(authorityDirectory, { recursive: true, mode: 0o700 });
  await writeFile(authorityPath, descriptorBytes, { mode: 0o600 });
  await chmod(authorityPath, 0o444);
  process.env.PAPERCLIP_PROVIDER_POLICY_PATH = policyPath;
  process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_PATH = schemaPath;
  process.env.PAPERCLIP_PROVIDER_POLICY_SHA256 = sha256(policyBytes);
  process.env.PAPERCLIP_PROVIDER_POLICY_SCHEMA_SHA256 = sha256(schemaBytes);
  return { path: authorityPath, sha256: sha256(descriptorBytes) };
}

function signRecord(body: Record<string, unknown>) {
  return {
    ...body,
    authentication_tag: createHmac("sha256", JOURNAL_KEY)
      .update(`portfolio-os-return-plane-v2\0${stableJson(body)}`, "utf8")
      .digest("hex"),
  };
}

async function rewriteReadOnlyJson(file: string, value: unknown) {
  await chmod(file, 0o600);
  await writeFile(file, `${JSON.stringify(value)}\n`);
  await chmod(file, 0o444);
}

function successEnvelope(overrides: Partial<PosConsumerEnvelope> = {}): PosConsumerEnvelope {
  return {
    schema_version: "pos.paperclip_consumer_envelope.v1",
    plane: "research",
    protocol_state: "succeeded",
    company_id: "11111111-1111-4111-8111-111111111111",
    observed_at: "2026-07-15T04:00:00.000Z",
    runtime: {
      mode: "managed",
      verified: true,
      source_commit: "a".repeat(40),
      manifest: { path: "/runtime/manifest.json", sha256: "b".repeat(64) },
      provider_policy_authority: { path: "/runtime/provider-policy-authority.json", sha256: "e".repeat(64) },
    },
    summary: {
      result_schema_version: "pos.paperclip_research_plane_run.v2",
      fetched_count: 1,
      processed_count: 1,
      blocked_count: 0,
      failed_count: 0,
      superseded_count: 0,
    },
    acknowledgements: [{
      event_id: "22222222-2222-4222-8222-222222222222",
      stage_run_id: "33333333-3333-4333-8333-333333333333",
      state: "succeeded",
      prepared_ack: { path: "/artifacts/prepared-ack.json", sha256: "c".repeat(64) },
      ack_response: { path: "/artifacts/ack-response.json", sha256: "d".repeat(64) },
    }],
    diagnostics: null,
    ...overrides,
  };
}

async function fixture(scriptBody: string | null = null, options: { executableMode?: number; deleteExecutable?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-pos-consumer-")));
  roots.push(root);
  const repository = path.join(root, "repository");
  const binDirectory = path.join(repository, "bin");
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const receiptDirectory = path.join(root, "receipts");
  await mkdir(receiptDirectory, { mode: 0o700 });
  const interpreter = JSON.parse((await execFile("python3", [
    "-c",
    "import json,pathlib,sys;print(json.dumps({\"path\":pathlib.Path(sys.executable).resolve(strict=True).as_posix(),\"version\":sys.version.split()[0]}))",
  ])).stdout.trim()) as { path: string; version: string };
  const envelopePath = path.join(root, "envelope.json");
  const renderedScript = (scriptBody ?? [
    "import pathlib,sys",
    `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
  ].join("\n")).replace("__ENVELOPE_PATH__", envelopePath);
  const executablePath = path.join(binDirectory, "pos");
  const executableBytes = Buffer.from(`#!${interpreter.path}\n${renderedScript}\n`, "utf8");
  const executableMode = options.executableMode ?? 0o555;
  await writeFile(executablePath, executableBytes, { mode: (executableMode & 0o111) !== 0 ? 0o755 : 0o644 });

  const dependencyPath = path.join(repository, "requirements.lock");
  const registryPath = path.join(repository, "research-sources.json");
  const contractNames = [
    "paperclip.factory_runtime_manifest.v2.schema.json",
    "pos.managed_runtime_package.v2.schema.json",
    "pos.paperclip_consumer_envelope.v1.schema.json",
    "pos.paperclip_consumer_crash_journal.v1.schema.json",
    "pos.paperclip_provider_policy_authority.v1.schema.json",
    "profit-flywheel.v2.json",
    "profit-flywheel.v2.schema.json",
    "pos.next_research_authorization.v1.schema.json",
    "pos.next_research_authorization.v2.schema.json",
    "paperclip.research_plan.v2.schema.json",
    "paperclip.research_plan.v3.schema.json",
    "paperclip.research_continuation.v1.schema.json",
  ];
  await writeFile(dependencyPath, "fixture-lock-v1\n");
  await writeFile(registryPath, "{}\n");
  const contractPaths = await Promise.all(contractNames.map(async (name) => {
    const contractPath = path.join(repository, name);
    await writeFile(contractPath, `{"fixture":"${name}"}\n`);
    return contractPath;
  }));
  const contractPath = path.join(repository, "profit-flywheel.v2.json");
  const contractSha256 = sha256(await readFile(contractPath));
  await execFile("git", ["init", "-b", "main"], { cwd: repository });
  await execFile("git", ["config", "user.email", "runtime@example.invalid"], { cwd: repository });
  await execFile("git", ["config", "user.name", "Runtime Fixture"], { cwd: repository });
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "-m", "runtime closure"], { cwd: repository });
  const commit = await execFile("git", ["rev-parse", "HEAD"], { cwd: repository }).then(({ stdout }) => stdout.trim());
  const treeSha256 = await execFile("git", ["ls-tree", "-r", "--full-tree", commit], { cwd: repository })
    .then(({ stdout }) => sha256(Buffer.from(stdout, "utf8")));
  await Promise.all([
    chmod(executablePath, executableMode),
    chmod(dependencyPath, 0o444),
    chmod(registryPath, 0o444),
    ...contractPaths.map((value) => chmod(value, 0o444)),
  ]);
  const manifestPath = path.join(root, "runtime-manifest.json");
  const providerPolicyAuthority = await createProviderPolicyAuthority(root);
  const manifest = {
    schema_version: "paperclip.factory_runtime_manifest.v2",
    runtime_id: "portfolio-os-test-runtime",
    runtime_kind: "portfolio_os",
    source: { repository, commit, tree_sha256: treeSha256, clean: true },
    executable: { path: executablePath, sha256: sha256(executableBytes) },
    interpreter: {
      path: interpreter.path,
      version: interpreter.version,
      identity_sha256: sha256(`${interpreter.path}\0${interpreter.version}\n`),
    },
    dependency_lock: { path: dependencyPath, sha256: sha256(await readFile(dependencyPath)) },
    contracts: await Promise.all(contractPaths.map(async (value) => ({
      path: value, sha256: sha256(await readFile(value)),
    }))),
    provider_policy_authority: providerPolicyAuthority,
    source_registry: { path: registryPath, sha256: sha256(await readFile(registryPath)) },
    writable_roots: [root],
    built_at: "2026-07-15T04:00:00.000Z",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await chmod(manifestPath, 0o444);
  const manifestBinding = { path: manifestPath, sha256: sha256(await readFile(manifestPath)) };

  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  const preparedPath = path.join(artifacts, "prepared-ack.json");
  const responsePath = path.join(artifacts, "ack-response.json");
  const ack = {
    event_id: "22222222-2222-4222-8222-222222222222",
    workflow_id: "44444444-4444-4444-8444-444444444444",
    stage_run_id: "33333333-3333-4333-8333-333333333333",
    stage: "research_intake", input_hash: "1".repeat(64), attempt: 1,
    state: "succeeded", output_hash: "9".repeat(64),
  };
  const identity = {
    company_id: "11111111-1111-4111-8111-111111111111",
    event_id: ack.event_id, workflow_id: ack.workflow_id, stage_run_id: ack.stage_run_id,
    stage: ack.stage, input_hash: ack.input_hash, attempt: ack.attempt,
    correlation_id: "profit:fixture", trace_id: "8".repeat(32),
  };
  await writeFile(preparedPath, `${JSON.stringify(signRecord({
    schema_version: "pos.paperclip_research_plane_prepared_ack.v1",
    ...identity, event_sha256: "7".repeat(64), ack,
    prepared_at: "2026-07-15T04:00:00.000Z", immutable: true,
  }))}\n`);
  await chmod(preparedPath, 0o444);
  const preparedBinding = { path: preparedPath, sha256: sha256(await readFile(preparedPath)) };
  await writeFile(responsePath, `${JSON.stringify(signRecord({
    schema_version: "pos.paperclip_research_plane_ack_response.v1",
    ...identity, prepared_ack: preparedBinding,
    paperclip_response: {
      status: "acknowledged", eventId: ack.event_id, stageRunId: ack.stage_run_id, outputHash: ack.output_hash,
    },
    acknowledged_at: "2026-07-15T04:00:00.000Z", immutable: true,
  }))}\n`);
  await chmod(responsePath, 0o444);
  const responseBinding = { path: responsePath, sha256: sha256(await readFile(responsePath)) };
  const envelope = successEnvelope({
    runtime: {
      mode: "managed",
      verified: true,
      source_commit: commit,
      manifest: manifestBinding,
      provider_policy_authority: providerPolicyAuthority,
    },
    acknowledgements: [{
      event_id: ack.event_id, stage_run_id: ack.stage_run_id, state: "succeeded",
      prepared_ack: preparedBinding, ack_response: responseBinding,
    }],
  });
  await writeFile(envelopePath, `${JSON.stringify(envelope)}\n`);
  await chmod(envelopePath, 0o444);
  if (options.deleteExecutable) await unlink(executablePath);
  return {
    root, repository, receiptDirectory, manifestPath, contractSha256, envelopePath,
    dependencyPath, registryPath, executablePath, preparedPath, responsePath, envelope,
    providerPolicyAuthority,
  };
}

function attemptInput(runtime: Awaited<ReturnType<typeof fixture>>) {
  return {
    attemptId: randomUUID(),
    plane: "research" as const,
    companyId: "11111111-1111-4111-8111-111111111111",
    event: {
      eventId: "22222222-2222-4222-8222-222222222222",
      workflowId: "44444444-4444-4444-8444-444444444444",
      stageRunId: "33333333-3333-4333-8333-333333333333",
      stage: "research_intake",
      inputHash: "1".repeat(64),
      attempt: 1,
      idempotencyKey: "company+run+research_intake+input",
      claimNonceSha256: "2".repeat(64),
    },
    runtimeManifestPath: runtime.manifestPath,
    providerPolicyAuthorityPath: runtime.providerPolicyAuthority.path,
    receiptDirectory: runtime.receiptDirectory,
    contractSha256: runtime.contractSha256,
    providerPolicySha256: null,
    apiUrl: "http://127.0.0.1:3100",
    environment: {
      PAPERCLIP_API_KEY: API_KEY,
      PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY: JOURNAL_KEY,
    },
    secretReferences: [
      { name: "PAPERCLIP_API_KEY", version: "7", fingerprint: sha256(API_KEY) },
      { name: "PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY", version: "11", fingerprint: sha256(JOURNAL_KEY) },
    ],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  restoreEnvironmentValue("path");
  restoreEnvironmentValue("schemaPath");
  restoreEnvironmentValue("sha256");
  restoreEnvironmentValue("schemaSha256");
});

describe("POS consumer protocol and attempt runner", () => {
  it("accepts every exact shared valid golden vector and rejects every invalid vector", async () => {
    const vectors = JSON.parse(await readFile(path.resolve(
      process.cwd(),
      "contracts/profit-flywheel/consumer-protocol-golden-vectors.v1.json",
    ), "utf8")) as { valid: Record<string, unknown>; invalid: Record<string, unknown> };
    for (const value of Object.values(vectors.valid)) {
      expect(posConsumerEnvelopeSchema.safeParse(value).success).toBe(true);
    }
    for (const value of Object.values(vectors.invalid)) {
      expect(posConsumerEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each([
    ["timeout", { exitCode: null, signal: "SIGKILL", timedOut: true, overflowed: false, spawnError: null }, "missing", "pos_consumer_timeout"],
    ["signal", { exitCode: null, signal: "SIGTERM", timedOut: false, overflowed: false, spawnError: null }, "missing", "pos_consumer_launch_failed"],
    ["missing", { exitCode: 0, signal: null, timedOut: false, overflowed: false, spawnError: null }, "missing", "pos_consumer_protocol_invalid"],
    ["malformed", { exitCode: 2, signal: null, timedOut: false, overflowed: false, spawnError: null }, "invalid", "pos_consumer_protocol_invalid"],
  ] as const)("classifies %s deterministically", (_label, process, protocolState, code) => {
    expect(classifyPosConsumerAttempt({
      process,
      envelope: null,
      protocolState,
      eventId: "event",
      stageRunId: "stage",
      now: new Date("2026-07-15T04:00:00Z"),
      attempt: 1,
    }).code).toBe(code);
  });

  it("rejects a succeeded envelope paired with a nonzero process exit", async () => {
    const runtime = await fixture([
      "import pathlib,sys",
      `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
      "sys.exit(2)",
    ].join("\n"));
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.classification.code).toBe("pos_consumer_protocol_invalid");
    expect(result.process.exitCode).toBe(2);
    expect(result.receipt.protocol.state).toBe("succeeded");
    expect(result.receiptBinding.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(result.receiptBinding.path, "utf8")).toContain(result.receipt.attempt_id);
  });

  it("parses POS exit 2 as a truthful typed source failure without inventing an acknowledgement", async () => {
    const runtime = await fixture([
      "import pathlib,sys",
      `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
      "sys.exit(2)",
    ].join("\n"));
    await rewriteReadOnlyJson(runtime.envelopePath, {
      ...runtime.envelope,
      protocol_state: "failed",
      summary: {
        ...runtime.envelope.summary,
        processed_count: 0,
        failed_count: 1,
      },
      acknowledgements: [],
      diagnostics: {
        code: "paperclip_claim_failed",
        detail: "The exact event claim was rejected.",
        next_owner: "portfolio_os_consumer_owner",
        resume_condition: "Repair the typed claim failure before replaying this event.",
        crash_journal: null,
      },
    });
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.process.exitCode).toBe(2);
    expect(result.receipt.protocol.state).toBe("failed");
    expect(result.classification).toMatchObject({ code: "pos_consumer_source_failed", retryable: false });
  });

  it("does not let a typed nonzero failure envelope conceal tampered acknowledgement evidence", async () => {
    const runtime = await fixture([
      "import pathlib,sys",
      `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
      "sys.exit(2)",
    ].join("\n"));
    await rewriteReadOnlyJson(runtime.envelopePath, {
      ...runtime.envelope,
      protocol_state: "failed",
      summary: { ...runtime.envelope.summary, processed_count: 0, failed_count: 1 },
      diagnostics: {
        code: "paperclip_ack_failed",
        detail: "The exact acknowledgement failed.",
        next_owner: "portfolio_os_consumer_owner",
        resume_condition: "Repair the acknowledgement evidence.",
        crash_journal: null,
      },
    });
    const prepared = JSON.parse(await readFile(runtime.preparedPath, "utf8"));
    prepared.input_hash = "0".repeat(64);
    await rewriteReadOnlyJson(runtime.preparedPath, prepared);
    expect((await runPosConsumerAttempt(attemptInput(runtime))).classification.code)
      .toBe("pos_consumer_ack_failed");
  });

  it("accepts only a zero-exit envelope with exact runtime and authenticated acknowledgement evidence", async () => {
    const runtime = await fixture();
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.classification.code).toBe("succeeded");
    expect(result.process.exitCode).toBe(0);
    expect(result.receipt.command.args).toEqual([
      "paperclip-research-plane",
      "--company-id", "11111111-1111-4111-8111-111111111111",
      "--limit", "1",
      "--runtime-manifest", runtime.manifestPath,
      "--provider-policy-authority", runtime.providerPolicyAuthority.path,
      "--artifact-root", runtime.root,
    ]);
    expect(result.receipt.protocol).toMatchObject({
      state: "succeeded",
      acknowledgement: expect.objectContaining({ path: expect.stringContaining("prepared-ack.json") }),
      ack_response: expect.objectContaining({ path: expect.stringContaining("ack-response.json") }),
    });
    expect(result.envelope?.runtime.provider_policy_authority).toEqual(runtime.providerPolicyAuthority);
    expect(result.receipt.runtime.provider_policy_authority).toEqual(runtime.providerPolicyAuthority);
    expect(result.receipt.command.allowlisted_environment_names)
      .not.toContain("PAPERCLIP_PROVIDER_POLICY_AUTHORITY");
  });

  it("blocks missing or mismatched provider-policy authority before spawning a POS child", async () => {
    const runtime = await fixture();
    const missing = await runPosConsumerAttempt({
      ...attemptInput(runtime),
      providerPolicyAuthorityPath: "",
    });
    expect(missing.classification.code).toBe("pos_consumer_runtime_provenance_mismatch");
    expect(missing.process.exitCode).toBeNull();
    expect(missing.receipt.process.stderr.excerpt).toContain("pos_consumer_provider_policy_authority_missing");

    const mismatch = await runPosConsumerAttempt({
      ...attemptInput(runtime),
      providerPolicyAuthorityPath: `${runtime.providerPolicyAuthority.path}.drift`,
    });
    expect(mismatch.classification.code).toBe("pos_consumer_runtime_provenance_mismatch");
    expect(mismatch.process.exitCode).toBeNull();
    expect(mismatch.receipt.process.stderr.excerpt).toContain("pos_consumer_provider_policy_authority_mismatch");
  });

  it("rejects a launcher artifact root outside the verified runtime writable roots", async () => {
    const runtime = await fixture();
    const result = await runPosConsumerAttempt({
      ...attemptInput(runtime),
      artifactRoot: path.join(path.dirname(runtime.root), "untrusted-output"),
    });
    expect(result.classification.code).toBe("pos_consumer_runtime_provenance_mismatch");
    expect(result.process.exitCode).toBeNull();
    expect(result.receipt.command.args).toContain(path.join(path.dirname(runtime.root), "untrusted-output"));
  });

  it("rejects launcher-owned environment overrides before any subprocess can start", async () => {
    const runtime = await fixture();
    const input = attemptInput(runtime);
    await expect(runPosConsumerAttempt({
      ...input,
      environment: { ...input.environment, PATH: "/attacker/bin" },
    })).rejects.toThrow("pos_consumer_secret_environment_invalid");
    await expect(runPosConsumerAttempt({
      ...input,
      environment: { ...input.environment, PAPERCLIP_API_URL: "https://attacker.invalid" },
    })).rejects.toThrow("pos_consumer_secret_environment_invalid");
    await expect(runPosConsumerAttempt({
      ...input,
      attemptId: "../receipt-escape",
    })).rejects.toThrow("pos_consumer_attempt_binding_invalid");
  });

  it("fails closed when a runtime closure file regains owner write permission", async () => {
    const runtime = await fixture();
    await chmod(runtime.dependencyPath, 0o644);
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.classification.code).toBe("pos_consumer_runtime_provenance_mismatch");
    expect(result.process.exitCode).toBeNull();
  });

  it("fails closed on interpreter, envelope-runtime, provider-policy authority, and acknowledgement tampering", async () => {
    const interpreterRuntime = await fixture();
    const manifest = JSON.parse(await readFile(interpreterRuntime.manifestPath, "utf8"));
    manifest.interpreter.identity_sha256 = "0".repeat(64);
    await rewriteReadOnlyJson(interpreterRuntime.manifestPath, manifest);
    expect((await runPosConsumerAttempt(attemptInput(interpreterRuntime))).classification.code)
      .toBe("pos_consumer_runtime_provenance_mismatch");

    const envelopeRuntime = await fixture();
    const driftedEnvelope = structuredClone(envelopeRuntime.envelope);
    driftedEnvelope.runtime.manifest!.sha256 = "0".repeat(64);
    await rewriteReadOnlyJson(envelopeRuntime.envelopePath, driftedEnvelope);
    expect((await runPosConsumerAttempt(attemptInput(envelopeRuntime))).classification.code)
      .toBe("pos_consumer_protocol_invalid");

    for (const [label, mutate] of [
      ["path", (runtime: Record<string, unknown>) => {
        runtime.provider_policy_authority = {
          ...(runtime.provider_policy_authority as Record<string, unknown>),
          path: "/runtime/provider-policy-authority.drift.json",
        };
      }],
      ["hash", (runtime: Record<string, unknown>) => {
        runtime.provider_policy_authority = {
          ...(runtime.provider_policy_authority as Record<string, unknown>),
          sha256: "0".repeat(64),
        };
      }],
      ["omission", (runtime: Record<string, unknown>) => {
        delete runtime.provider_policy_authority;
      }],
    ] as const) {
      const authorityRuntime = await fixture();
      const tamperedEnvelope = structuredClone(authorityRuntime.envelope);
      mutate(tamperedEnvelope.runtime as unknown as Record<string, unknown>);
      await rewriteReadOnlyJson(authorityRuntime.envelopePath, tamperedEnvelope);
      const result = await runPosConsumerAttempt(attemptInput(authorityRuntime));
      expect(result.classification.code, label).toBe("pos_consumer_protocol_invalid");
      expect(result.receipt.protocol.state, label).toBe("invalid");
    }

    const ackRuntime = await fixture();
    const prepared = JSON.parse(await readFile(ackRuntime.preparedPath, "utf8"));
    prepared.input_hash = "0".repeat(64);
    await rewriteReadOnlyJson(ackRuntime.preparedPath, prepared);
    const tampered = await runPosConsumerAttempt(attemptInput(ackRuntime));
    expect(tampered.classification.code).toBe("pos_consumer_ack_failed");
    expect(tampered.receipt.protocol.acknowledgement).toBeNull();
    expect(tampered.receipt.protocol.ack_response).toBeNull();
  });

  it("accepts only an immutable crash journal whose authority binding exactly matches the managed envelope", async () => {
    const runtime = await fixture([
      "import pathlib,sys",
      `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
      "sys.exit(2)",
    ].join("\n"));
    const crashPath = path.join(runtime.root, "artifacts", "crash-journal.json");
    const crashJournal = {
      schema_version: "pos.paperclip_consumer_crash_journal.v1",
      plane: "research",
      company_id: "11111111-1111-4111-8111-111111111111",
      observed_at: "2026-07-15T04:00:00.000Z",
      runtime: structuredClone(runtime.envelope.runtime),
      error: {
        code: "paperclip_claim_failed",
        detail: "The exact event claim was rejected.",
        exception_type: "RuntimeError",
        traceback: "Traceback (most recent call last): RuntimeError: claim failed",
      },
      immutable: true,
    };
    expect(posConsumerCrashJournalSchema.safeParse(crashJournal).success).toBe(true);
    const writeCrash = async (value: Record<string, unknown>) => {
      await chmod(crashPath, 0o600).catch(() => undefined);
      await writeFile(crashPath, `${JSON.stringify(value)}\n`);
      await chmod(crashPath, 0o444);
      return { path: crashPath, sha256: sha256(await readFile(crashPath)) };
    };
    const bindCrash = async (value: Record<string, unknown>) => {
      const crashBinding = await writeCrash(value);
      await rewriteReadOnlyJson(runtime.envelopePath, {
        ...runtime.envelope,
        protocol_state: "failed",
        summary: { ...runtime.envelope.summary, processed_count: 0, failed_count: 1 },
        acknowledgements: [],
        diagnostics: {
          code: "paperclip_claim_failed",
          detail: "The exact event claim was rejected.",
          next_owner: "portfolio_os_consumer_owner",
          resume_condition: "Repair the typed claim failure before replaying this event.",
          crash_journal: crashBinding,
        },
      });
    };
    await bindCrash(crashJournal);
    expect((await runPosConsumerAttempt(attemptInput(runtime))).classification.code)
      .toBe("pos_consumer_source_failed");

    for (const [label, mutate] of [
      ["path", (journal: Record<string, unknown>) => {
        const binding = journal.runtime as Record<string, unknown>;
        binding.provider_policy_authority = {
          ...(binding.provider_policy_authority as Record<string, unknown>),
          path: "/runtime/provider-policy-authority.drift.json",
        };
      }],
      ["hash", (journal: Record<string, unknown>) => {
        const binding = journal.runtime as Record<string, unknown>;
        binding.provider_policy_authority = {
          ...(binding.provider_policy_authority as Record<string, unknown>),
          sha256: "0".repeat(64),
        };
      }],
      ["omission", (journal: Record<string, unknown>) => {
        delete (journal.runtime as Record<string, unknown>).provider_policy_authority;
      }],
    ] as const) {
      const tampered = structuredClone(crashJournal) as Record<string, unknown>;
      mutate(tampered);
      // Path/hash substitutions remain structurally valid by design; the
      // runner's exact manifest/envelope comparison is the security boundary.
      expect(posConsumerCrashJournalSchema.safeParse(tampered).success, label)
        .toBe(label !== "omission");
      await bindCrash(tampered);
      const result = await runPosConsumerAttempt(attemptInput(runtime));
      expect(result.classification.code, label).toBe("pos_consumer_protocol_invalid");
      expect(result.receipt.protocol.state, label).toBe("invalid");
    }
  });

  it("rejects a schema-valid acknowledgement whose response binding is null", async () => {
    const runtime = await fixture();
    const envelope = structuredClone(runtime.envelope);
    envelope.acknowledgements[0]!.ack_response = null;
    await rewriteReadOnlyJson(runtime.envelopePath, envelope);
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.classification.code).toBe("pos_consumer_ack_failed");
    expect(result.receipt.protocol.acknowledgement).toBeNull();
  });

  it("records missing and non-executable managed executables as truthful immutable attempts", async () => {
    const missingRuntime = await fixture("import sys; sys.exit(0)", { deleteExecutable: true });
    const missing = await runPosConsumerAttempt(attemptInput(missingRuntime));
    expect(missing.classification.code).toBe("pos_consumer_runtime_provenance_mismatch");
    expect(missing.process.exitCode).toBeNull();
    const spawnRuntime = await fixture("import sys; sys.exit(0)", { executableMode: 0o444 });
    const spawnFailure = await runPosConsumerAttempt(attemptInput(spawnRuntime));
    expect(spawnFailure.classification.code).toBe("pos_consumer_launch_failed");
    expect(spawnFailure.receipt.process.stderr.excerpt).not.toBe("");
  });

  it("records malformed, absent, and timed-out envelopes without throwing", async () => {
    const malformedRuntime = await fixture("import sys; sys.stdout.write('not-json'); sys.exit(2)");
    expect((await runPosConsumerAttempt(attemptInput(malformedRuntime))).classification.code)
      .toBe("pos_consumer_protocol_invalid");
    const absentRuntime = await fixture("import sys; sys.exit(0)");
    expect((await runPosConsumerAttempt(attemptInput(absentRuntime))).receipt.protocol.state).toBe("missing");
    const timeoutRuntime = await fixture("import time; time.sleep(5)");
    expect((await runPosConsumerAttempt({ ...attemptInput(timeoutRuntime), timeoutMs: 1_000 })).classification.code)
      .toBe("pos_consumer_timeout");
  }, 10_000);

  it("redacts bounded excerpts and writes an immutable compressed overflow diagnostic", async () => {
    const secret = API_KEY;
    const stderr = `${secret}:${"x".repeat(20_000)}`;
    const runtime = await fixture([
      "import pathlib,sys",
      `sys.stderr.write(${JSON.stringify(stderr)})`,
      `sys.stdout.write(pathlib.Path(${JSON.stringify("__ENVELOPE_PATH__")}).read_text(encoding="utf-8"))`,
    ].join("\n"));
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    expect(result.receipt.redaction.redacted).toBe(true);
    expect(result.receipt.process.stderr.excerpt).not.toContain(secret);
    expect(result.receipt.process.stderr.artifact?.path).toMatch(/\.json\.gz$/);
    expect(result.receipt.process.stderr.artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const mode = (await import("node:fs/promises")).stat(result.receipt.process.stderr.artifact!.path)
      .then((value) => value.mode & 0o777);
    expect(await mode).toBe(0o444);
  });

  it("emits attempt receipts that satisfy the mirrored JSON schema", async () => {
    const runtime = await fixture();
    const result = await runPosConsumerAttempt(attemptInput(runtime));
    const schema = JSON.parse(await readFile(
      path.resolve(process.cwd(), "contracts/profit-flywheel/pos-consumer-attempt-receipt.v1.schema.json"),
      "utf8",
    ));
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(result.receipt), validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("\n"))
      .toBe(true);
  });
});
