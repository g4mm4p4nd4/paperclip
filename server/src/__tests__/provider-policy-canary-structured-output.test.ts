import { describe, expect, it } from "vitest";
import os from "node:os";
import {
  buildProviderCanaryIsolatedEnv,
  boundedProviderCanaryExec,
  parseProviderPolicyCanaryCliArgs,
  parseProviderCanaryStructuredOutput,
} from "../ops/provider-policy-canary.js";

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
      execute: true,
      routeIds: ["route-a", "route-b"],
      receiptRoot: undefined,
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
