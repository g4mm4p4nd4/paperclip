import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import {
  buildProviderCanaryIsolatedEnv,
  boundedProviderCanaryExec,
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
