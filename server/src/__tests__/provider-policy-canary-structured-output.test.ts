import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import {
  buildProviderCanaryIsolatedEnv,
  boundedProviderCanaryExec,
  classifyProviderCanaryFailureText,
  ensureHermesModelsDevCatalogFresh,
  ModelsDevCatalogRefreshError,
  parseProviderPolicyCanaryCliArgs,
  parseProviderCanaryStructuredOutput,
  resolveProviderPolicyCanaryExternalTarget,
  resolveProviderPolicyCanaryDatabaseConnection,
  resolveProviderPolicyCanaryInstanceTarget,
} from "../ops/provider-policy-canary.js";
import { parseProviderRuntimeIdentityArgs } from "../ops/provider-runtime-identity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider policy canary structured CLI evidence", () => {
  const nonce = "PAPERCLIP_CANARY_EVENT_FIXTURE_OK";

  it("classifies a retired subscription CLI tier as a capability mismatch, not bad auth", () => {
    expect(classifyProviderCanaryFailureText(
      "Error authenticating: IneligibleTierError: This client is no longer supported; migrate to the Antigravity suite",
    )).toBe("provider_capability_mismatch");
    expect(classifyProviderCanaryFailureText("HTTP 401 authentication required")).toBe("provider_auth");
  });

  async function modelsDevRefreshFixture() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-models-dev-refresh-")));
    roots.push(root);
    const repoRoot = path.join(root, "hermes-agent");
    const runtimeRoot = path.join(root, "pinned-hermes-runtime");
    const hermesHome = path.join(root, "hermes-home");
    const commandRealpath = path.join(runtimeRoot, "venv/bin/hermes");
    const rawCatalogPath = path.join(hermesHome, "models_dev_cache.json");
    await Promise.all([
      mkdir(path.dirname(commandRealpath), { recursive: true }),
      mkdir(hermesHome, { recursive: true }),
    ]);
    return { repoRoot, hermesHome, commandRealpath, rawCatalogPath };
  }

  it("does not invoke Hermes when the signed models.dev input remains fresh", async () => {
    const fixture = await modelsDevRefreshFixture();
    const now = new Date("2026-07-14T16:00:00.000Z");
    await writeFile(fixture.rawCatalogPath, "{}\n");
    await utimes(fixture.rawCatalogPath, now, now);
    let executions = 0;
    const result = await ensureHermesModelsDevCatalogFresh({
      ...fixture,
      refreshSeconds: 1_800,
      timeoutSeconds: 20,
    }, {
      now: () => now,
      exec: async () => {
        executions += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toMatchObject({ rawCatalogPath: fixture.rawCatalogPath, refreshed: false });
    expect(executions).toBe(0);
  });

  it.each(["stale", "missing"])("refreshes a %s catalog through the pinned Hermes Python boundary", async (state) => {
    const fixture = await modelsDevRefreshFixture();
    const now = new Date("2026-07-14T16:00:00.000Z");
    if (state === "stale") {
      await writeFile(fixture.rawCatalogPath, "{}\n");
      const stale = new Date(now.getTime() - 3_600_000);
      await utimes(fixture.rawCatalogPath, stale, stale);
    }
    const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number }> = [];
    const result = await ensureHermesModelsDevCatalogFresh({
      ...fixture,
      refreshSeconds: 1_800,
      timeoutSeconds: 20,
    }, {
      now: () => now,
      exec: async (command, args, input) => {
        calls.push({ command, args, ...input });
        await writeFile(fixture.rawCatalogPath, "{\"opencode\":{}}\n");
        await utimes(fixture.rawCatalogPath, now, now);
        return { exitCode: 0, stdout: "untrusted output is ignored", stderr: "" };
      },
    });
    expect(result.refreshed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: path.join(path.dirname(fixture.commandRealpath), "python"),
      cwd: fixture.repoRoot,
      timeoutSeconds: 20,
    });
    expect(calls[0]?.args).toEqual([
      "-c",
      "from agent.models_dev import fetch_models_dev, _get_cache_path; p = _get_cache_path(); before = p.stat().st_mtime_ns if p.exists() else None; data = fetch_models_dev(force_refresh=True); after = p.stat().st_mtime_ns if p.exists() else None; raise SystemExit(0 if data and after is not None and after != before else 75)",
    ]);
    expect(calls[0]?.env).toMatchObject({
      HOME: fixture.hermesHome,
      HERMES_HOME: fixture.hermesHome,
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    });
  });

  it("coalesces concurrent refreshes for the same raw catalog", async () => {
    const fixture = await modelsDevRefreshFixture();
    const now = new Date("2026-07-14T16:00:00.000Z");
    let executions = 0;
    const input = { ...fixture, refreshSeconds: 1_800, timeoutSeconds: 20 };
    const deps = {
      now: () => now,
      exec: async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(fixture.rawCatalogPath, "{}\n");
        await utimes(fixture.rawCatalogPath, now, now);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const results = await Promise.all([
      ensureHermesModelsDevCatalogFresh(input, deps),
      ensureHermesModelsDevCatalogFresh(input, deps),
      ensureHermesModelsDevCatalogFresh(input, deps),
    ]);
    expect(executions).toBe(1);
    expect(results.every((result) => result.refreshed)).toBe(true);
  });

  it("fails closed with a bounded failure class when refresh cannot reach models.dev", async () => {
    const fixture = await modelsDevRefreshFixture();
    const now = new Date("2026-07-14T16:00:00.000Z");
    let failure: unknown;
    try {
      await ensureHermesModelsDevCatalogFresh({
        ...fixture,
        refreshSeconds: 1_800,
        timeoutSeconds: 20,
      }, {
        now: () => now,
        exec: async () => ({ exitCode: 75, stdout: "", stderr: "" }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelsDevCatalogRefreshError);
    expect((failure as ModelsDevCatalogRefreshError).failureClass).toBe("transient_network");
    await expect(stat(fixture.rawCatalogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["separate argv value", ["--company-id", "company-1", "--connection-string", "postgres://argv.invalid/db"]],
    ["equals argv value", ["--company-id", "company-1", "--connection-string=postgres://argv.invalid/db"]],
  ])("rejects a database credential supplied through %s", (_label, args) => {
    expect(() => parseProviderPolicyCanaryCliArgs(args, {
      DATABASE_URL: "postgres://environment.invalid/db",
    })).toThrow("provider_policy_canary_database_url_argv_forbidden");
  });

  it("never reflects credential-bearing unknown argv and bounds route identifiers", () => {
    let message = "";
    try {
      parseProviderPolicyCanaryCliArgs([
        "--company-id", "company-1", "--api-key=do-not-echo-this",
      ], { DATABASE_URL: "postgres://environment.invalid/db" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("provider_policy_canary_argument_invalid");
    expect(message).not.toContain("do-not-echo-this");
    expect(() => parseProviderPolicyCanaryCliArgs([
      "--company-id", "company-1", "--routes", "route-a,unsafe=value",
    ], { DATABASE_URL: "postgres://environment.invalid/db" })).toThrow(
      "provider_policy_canary_routes_invalid",
    );
  });

  it("parses only bounded credential-free runtime identity routes", () => {
    expect(parseProviderRuntimeIdentityArgs([
      "--routes", "opencode_go_flash,codex_fast",
    ])).toEqual({
      help: false,
      routeIds: ["opencode_go_flash", "codex_fast"],
    });
    expect(() => parseProviderRuntimeIdentityArgs([
      "--routes", "opencode_go_flash,unsafe=value",
    ])).toThrow("provider_runtime_identity_routes_invalid");
    expect(() => parseProviderRuntimeIdentityArgs([
      "--api-key=do-not-echo",
    ])).toThrow("provider_runtime_identity_argument_invalid");
  });

  it("accepts the database connection only from DATABASE_URL", () => {
    expect(parseProviderPolicyCanaryCliArgs([
      "--company-id",
      "company-1",
      "--routes",
      "route-a,route-b",
      "--execute",
    ], {
      DATABASE_URL: "postgres://environment.invalid/db",
    })).toEqual({
      companyId: "company-1",
      connectionString: "postgres://environment.invalid/db",
      homeDir: undefined,
      instanceId: undefined,
      execute: true,
      routeIds: ["route-a", "route-b"],
      receiptRoot: undefined,
    });
  });

  it("selects an embedded instance without accepting a database credential on argv", () => {
    expect(parseProviderPolicyCanaryCliArgs([
      "--company-id", "company-1",
      "--home", "/tmp/paperclip-home",
      "--instance-id", "default",
    ], {})).toEqual({
      companyId: "company-1",
      connectionString: undefined,
      homeDir: "/tmp/paperclip-home",
      instanceId: "default",
      execute: false,
      routeIds: undefined,
      receiptRoot: undefined,
    });
    expect(resolveProviderPolicyCanaryDatabaseConnection(undefined, {
      databaseMode: "embedded-postgres",
      embeddedPostgresPort: 54329,
    })).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
    expect(() => parseProviderPolicyCanaryCliArgs([
      "--company-id", "company-1",
    ], {})).toThrow("provider_policy_canary_database_target_required");
    expect(() => parseProviderPolicyCanaryCliArgs([
      "--company-id", "company-1", "--home", "/tmp/paperclip-home",
    ], {})).toThrow("provider_policy_canary_instance_target_incomplete");
    expect(() => parseProviderPolicyCanaryCliArgs([
      "--company-id", "company-1",
      "--home", "/tmp/paperclip-home",
      "--instance-id", "default",
    ], { DATABASE_URL: "postgres://environment.invalid/db" })).toThrow(
      "provider_policy_canary_database_target_conflict",
    );
  });

  it("binds instance database, key, and receipts to one explicit config authority", async () => {
    const homeDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-provider-canary-target-")));
    roots.push(homeDir);
    const instanceRoot = path.join(homeDir, "instances/default");
    const keyPath = path.join(instanceRoot, "secrets/master.key");
    const customReceiptRoot = path.join(instanceRoot, "data/ops/provider-canaries/custom");
    await Promise.all([
      mkdir(path.dirname(keyPath), { recursive: true }),
      mkdir(customReceiptRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(keyPath, Buffer.alloc(32, 4).toString("base64"), { mode: 0o600 }),
      writeFile(path.join(instanceRoot, "config.json"), JSON.stringify({
        database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
        secrets: { provider: "local_encrypted", localEncrypted: { keyFilePath: keyPath } },
      }), { mode: 0o644 }),
    ]);
    await expect(resolveProviderPolicyCanaryInstanceTarget({
      homeDir,
      instanceId: "default",
      receiptRoot: customReceiptRoot,
      environment: {},
    })).resolves.toEqual({
      instanceRoot,
      configPath: path.join(instanceRoot, "config.json"),
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      masterKeyFilePath: keyPath,
      receiptRoot: customReceiptRoot,
    });
    await expect(resolveProviderPolicyCanaryInstanceTarget({
      homeDir,
      instanceId: "default",
      environment: { PAPERCLIP_CONFIG: "/tmp/other-config.json" },
    })).rejects.toThrow("provider_policy_canary_instance_environment_conflict:PAPERCLIP_CONFIG");
    await expect(resolveProviderPolicyCanaryInstanceTarget({
      homeDir,
      instanceId: "default",
      receiptRoot: path.join(homeDir, "outside"),
      environment: {},
    })).rejects.toThrow("provider_policy_canary_receipt_root_outside_instance");
    const outside = path.join(homeDir, "outside-receipts");
    const linked = path.join(instanceRoot, "data/ops/provider-canaries/linked");
    await mkdir(outside);
    await symlink(outside, linked);
    await expect(resolveProviderPolicyCanaryInstanceTarget({
      homeDir,
      instanceId: "default",
      receiptRoot: linked,
      environment: {},
    })).rejects.toThrow(/receipt_root_not_canonical|receipt_root_symlink_hierarchy/);
  });

  it("requires explicit key and receipt authorities for external PostgreSQL", async () => {
    await expect(resolveProviderPolicyCanaryExternalTarget({
      connectionString: "postgres://environment.invalid/db",
      environment: {},
    })).rejects.toThrow("provider_policy_canary_external_master_key_file_required");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-provider-canary-external-")));
    roots.push(root);
    const receiptRoot = path.join(root, "receipts");
    await mkdir(receiptRoot);
    await expect(resolveProviderPolicyCanaryExternalTarget({
      connectionString: "postgres://environment.invalid/db",
      receiptRoot,
      environment: { PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(root, "master.key") },
    })).resolves.toEqual({
      connectionString: "postgres://environment.invalid/db",
      masterKeyFilePath: path.join(root, "master.key"),
      receiptRoot,
    });
  });

  it("parses the real Codex exec JSON event family", () => {
    const output = [
      { type: "thread.started", thread_id: "fixture-thread" },
      { type: "item.completed", item: { id: "item-1", type: "agent_message", text: nonce } },
      { type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 0, output_tokens: 7 } },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(parseProviderCanaryStructuredOutput(output, nonce)).toEqual({
      finalResponse: nonce,
      model: null,
      version: null,
      usage: { inputTokens: 101, outputTokens: 7, totalTokens: 108, costUsd: null, accountingMode: "telemetry_only" },
    });
  });

  it("closes child stdin so subscription CLIs cannot hang waiting for extra prompt input", async () => {
    const result = await boundedProviderCanaryExec(process.execPath, [
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('stdin-closed'))",
    ], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH },
      timeoutSeconds: 2,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "stdin-closed", stderr: "" });
  });

  it("uses an isolated HOME and carries only the explicitly bound credential", () => {
    const env = buildProviderCanaryIsolatedEnv({
      root: "/tmp/paperclip-canary-root",
      profile: "/tmp/paperclip-canary-root/profile",
      credential: { name: "MINIMAX_API_KEY", value: "sentinel-provider-credential" },
    });
    expect(env.HOME).toBe("/tmp/paperclip-canary-root/profile");
    expect(env.HOME).not.toBe(os.homedir());
    expect(env.MINIMAX_API_KEY).toBe("sentinel-provider-credential");
    expect(env.PAPERCLIP_RETURN_PLANE_JOURNAL_KEY).toBeUndefined();
    expect(env.PAPERCLIP_RESEARCH_PLANE_JOURNAL_KEY).toBeUndefined();
    expect(env.PAPERCLIP_STAGE_PLANE_JOURNAL_KEY).toBeUndefined();
  });

  it("parses the real Claude print JSON result family", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: nonce,
      usage: { input_tokens: 83, output_tokens: 3 },
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 83, outputTokens: 3 } },
    });
    expect(parseProviderCanaryStructuredOutput(output, nonce)).toEqual({
      finalResponse: nonce,
      model: null,
      version: null,
      usage: { inputTokens: 83, outputTokens: 3, totalTokens: 86, costUsd: null, accountingMode: "telemetry_only" },
    });
  });

  it("parses Gemini stream-json init, final, model, and nested token stats", () => {
    const output = [
      { type: "init", session_id: "fixture-session", model: "gemini-3-flash-preview" },
      { type: "message", role: "assistant", content: nonce },
      {
        type: "result",
        response: nonce,
        stats: { models: { "gemini-3-flash-preview": { tokens: { input: 72, output: 4, cached: 0 } } } },
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(parseProviderCanaryStructuredOutput(output, nonce)).toEqual({
      finalResponse: nonce,
      model: "gemini-3-flash-preview",
      version: null,
      usage: { inputTokens: 72, outputTokens: 4, totalTokens: 76, costUsd: null, accountingMode: "telemetry_only" },
    });
  });

  it("rejects a nonce that appears only in tool output or nested tool arguments", () => {
    const output = [
      { type: "item.completed", item: { type: "mcp_tool_call", result: { text: nonce } } },
      { type: "assistant", message: { content: [{ type: "tool_use", input: { response: nonce } }] } },
      { type: "tool_result", role: "tool", content: nonce },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 2 } },
    ].map((value) => JSON.stringify(value)).join("\n");

    expect(parseProviderCanaryStructuredOutput(output, nonce)).toMatchObject({
      finalResponse: null,
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    });
  });
});
