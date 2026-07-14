import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  execute,
  listSkills,
  sessionCodec,
  syncSkills,
  testEnvironment,
} from "../adapters/hermes-local/execute.ts";
import type { AdapterExecutionContext } from "../adapters/types.js";

async function makeFakeHermes(dir: string) {
  const command = path.join(dir, "hermes-fake.mjs");
  const argsPath = path.join(dir, "args.json");
  const envPath = path.join(dir, "env.json");
  await fsp.writeFile(
    command,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({`,
      "  HERMES_SESSION_SOURCE: process.env.HERMES_SESSION_SOURCE || '',",
      "  HERMES_DISABLE_FALLBACK_MODEL: process.env.HERMES_DISABLE_FALLBACK_MODEL || '',",
      "  HERMES_OUTPUT_MAX_SENTENCES: process.env.HERMES_OUTPUT_MAX_SENTENCES || '',",
      "  HERMES_OUTPUT_MAX_CHARS: process.env.HERMES_OUTPUT_MAX_CHARS || '',",
      "  HERMES_TOOL_OUTPUT_MAX_BYTES: process.env.HERMES_TOOL_OUTPUT_MAX_BYTES || '',",
      "  HERMES_TOOL_OUTPUT_MAX_LINES: process.env.HERMES_TOOL_OUTPUT_MAX_LINES || '',",
      "  HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH: process.env.HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH || '',",
      "  PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID || '',",
      "  PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY || '',",
      "  HOME: process.env.HOME || '',",
      "  PAPERCLIP_PARENT_SENTINEL: process.env.PAPERCLIP_PARENT_SENTINEL || ''",
      "}));",
      "if (process.argv.includes('--version')) { console.log('Hermes Agent v0.16.0'); process.exit(0); }",
      "if (process.argv[2] === 'chat' && process.argv.includes('--help')) {",
      "  console.log('usage: hermes chat [-q QUERY] [-m MODEL] [--provider PROVIDER] [--source SOURCE] [--disable-fallback-model] [--resume SESSION_ID] [--session-id SESSION_ID] [--max-turns N] [--checkpoints] [--yolo] [--pass-session-id]');",
      "  process.exit(0);",
      "}",
      "if (process.argv.includes('doctor')) { console.log('doctor ok'); process.exit(0); }",
      "console.log('CANARY_OK');",
      "console.log('session_id: fake-session-123');",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(command, 0o755);
  return { command, argsPath, envPath };
}

function initHermesStateDb(hermesHome: string) {
  fs.mkdirSync(hermesHome, { recursive: true });
  const dbPath = path.join(hermesHome, "state.db");
  const sql = [
    "CREATE TABLE sessions (",
    "id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,",
    "input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,",
    "billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,",
    "cost_status TEXT, cost_source TEXT",
    ");",
    "INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, billing_base_url, billing_mode, estimated_cost_usd, cost_status, cost_source)",
    `VALUES ('fake-session-123', 'paperclip-test', 'MiniMax-M3', ${Date.now() / 1000}, 100, 7, 3, 0, 0, 'minimax', 'https://api.minimax.io/anthropic', 'unknown', 0.0, 'unknown', 'none');`,
  ].join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite3 failed");
}

function sqlString(value: string) {
  return value.replaceAll("'", "''");
}

function seedHermesFinalMessage(hermesHome: string, sessionId: string, content: string) {
  fs.mkdirSync(hermesHome, { recursive: true });
  const dbPath = path.join(hermesHome, "state.db");
  const now = Date.now() / 1000;
  const sql = [
    "CREATE TABLE IF NOT EXISTS sessions (",
    "id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,",
    "input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,",
    "billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,",
    "cost_status TEXT, cost_source TEXT",
    ");",
    "CREATE TABLE IF NOT EXISTS messages (",
    "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1",
    ");",
    "INSERT OR REPLACE INTO sessions (id, source, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, billing_base_url, billing_mode, estimated_cost_usd, cost_status, cost_source)",
    `VALUES ('${sqlString(sessionId)}', 'paperclip-test', 'MiniMax-M3', ${now}, 100, 7, 3, 0, 0, 'minimax', 'https://api.minimax.io/anthropic', 'unknown', 0.0, 'unknown', 'none');`,
    "INSERT INTO messages (session_id, role, content, timestamp, active)",
    `VALUES ('${sqlString(sessionId)}', 'assistant', '${sqlString(content)}', ${now + 1}, 1);`,
  ].join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite3 failed");
}

describe("Hermes local compatibility adapter", () => {
  it("launches Hermes with Paperclip source, fallback disabled, managed skills, and state-db usage", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-compat-"));
    const { command, argsPath, envPath } = await makeFakeHermes(dir);
    const hermesHome = path.join(dir, "hermes-home");
    initHermesStateDb(hermesHome);
    const skillSource = path.join(dir, "paperclip-skill");
    await fsp.mkdir(skillSource, { recursive: true });
    await fsp.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\n---\n# Paperclip\n", "utf-8");

    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const ctx: AdapterExecutionContext = {
      runId: "run_test",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        disableFallbackModel: true,
        isolateParentEnvironment: true,
        env: { HOME: dir, HERMES_HOME: hermesHome },
        maxTurnsPerRun: 8,
        outputMaxSentences: 1,
        outputMaxChars: 100,
        promptTemplate: "Test prompt for {{agent.name}} in {{cwd}}",
        paperclipRuntimeSkills: [
          {
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
            required: true,
          },
        ],
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
      },
      context: {
        issueId: "issue_test",
        wakeReason: "issue_assigned",
        paperclipWake: {
          issue: { id: "issue_test", identifier: "PAP-1", title: "Ship the thing" },
        },
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
      authToken: "run-jwt",
    };

    const previousSentinel = process.env.PAPERCLIP_PARENT_SENTINEL;
    process.env.PAPERCLIP_PARENT_SENTINEL = "must-not-cross";
    const result = await execute(ctx).finally(() => {
      if (previousSentinel === undefined) delete process.env.PAPERCLIP_PARENT_SENTINEL;
      else process.env.PAPERCLIP_PARENT_SENTINEL = previousSentinel;
    });
    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    const env = JSON.parse(await fsp.readFile(envPath, "utf-8"));
    const prompt = args[args.indexOf("-q") + 1];

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({
      sessionId: "fake-session-123",
      cwd: dir,
      source: "paperclip-test",
      workKey: "issue:issue_test",
      issueId: "issue_test",
      taskKey: "PAP-1",
    });
    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 7,
      cachedInputTokens: 3,
    });
    expect(result.resultJson?.usage).toMatchObject({
      billingProvider: "minimax",
      billingBaseUrl: "https://api.minimax.io/anthropic",
      source: "hermes_state_db",
    });
    expect(args).toEqual(expect.arrayContaining([
      "chat",
      "-Q",
      "-q",
      "--source",
      "paperclip-test",
      "-m",
      "MiniMax-M3",
      "--provider",
      "minimax",
      "--max-turns",
      "8",
      "--disable-fallback-model",
      "-s",
      "paperclip/paperclip",
      "--session-id",
      "paperclip_run_test",
      "--pass-session-id",
    ]));
    expect(prompt).toContain("Request shaping:");
    expect(prompt).toContain("explicit work handoff detected");
    expect(env).toMatchObject({
      HERMES_SESSION_SOURCE: "paperclip-test",
      HERMES_DISABLE_FALLBACK_MODEL: "1",
      HERMES_OUTPUT_MAX_SENTENCES: "1",
      HERMES_OUTPUT_MAX_CHARS: "100",
      HERMES_TOOL_OUTPUT_MAX_BYTES: "16000",
      HERMES_TOOL_OUTPUT_MAX_LINES: "320",
      HERMES_TOOL_OUTPUT_MAX_LINE_LENGTH: "1000",
      PAPERCLIP_RUN_ID: "run_test",
      PAPERCLIP_API_KEY: "run-jwt",
      HOME: dir,
      PAPERCLIP_PARENT_SENTINEL: "",
    });
    expect(await fsp.realpath(path.join(hermesHome, "skills", "paperclip", "paperclip"))).toBe(
      await fsp.realpath(skillSource),
    );
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("CANARY_OK"))).toBe(true);
    expect(metas[0]).toMatchObject({
      adapterType: "hermes_local",
      adapterVersion: "paperclip-compat-2026.06.15",
      command,
      cwd: dir,
      commandArgs: expect.arrayContaining(["--source", "paperclip-test"]),
      promptBudgetVersion: "context-economy.v1",
      promptMetrics: expect.objectContaining({
        requestShapingMode: "deliverable_work",
        requestShapingReason: "explicit_issue_comment_approval_or_prompt",
        requestedSessionId: "paperclip_run_test",
        workIdentity: expect.objectContaining({
          workKey: "issue:issue_test",
          issueId: "issue_test",
        }),
        hermesToolOutputBudget: expect.objectContaining({
          maxBytes: 16_000,
          maxLines: 320,
          maxLineLength: 1_000,
        }),
        hermesCliCapabilities: expect.objectContaining({
          source: "detected",
          skippedFlags: [],
          supportedFlags: expect.arrayContaining(["--max-turns", "--session-id"]),
        }),
        requestedSessionIdEffective: true,
      }),
    });
  });

  it("skips flags unsupported by the configured Hermes binary", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-legacy-"));
    const command = path.join(dir, "hermes-legacy.mjs");
    const argsPath = path.join(dir, "args.json");
    const hermesHome = path.join(dir, "hermes-home");
    seedHermesFinalMessage(hermesHome, "legacy-session-123", "Legacy Hermes completed.");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "if (process.argv[2] === 'chat' && process.argv.includes('--help')) {",
        "  console.log('usage: hermes chat [-q QUERY] [-m MODEL] [--provider PROVIDER] [--source SOURCE] [--disable-fallback-model] [--resume SESSION_ID] [--checkpoints] [--yolo] [--pass-session-id]');",
        "  process.exit(0);",
        "}",
        "console.log('session_id: legacy-session-123');",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const metas: unknown[] = [];
    const logs: Array<[string, string]> = [];
    const result = await execute({
      runId: "run_legacy",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Legacy Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        maxTurnsPerRun: 12,
        promptTemplate: "Test prompt",
      },
      context: {
        issueId: "issue_test",
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("legacy-session-123");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--session-id");
    expect(args).toEqual(expect.arrayContaining([
      "chat",
      "-Q",
      "-q",
      "--source",
      "paperclip-test",
      "-m",
      "MiniMax-M3",
      "--provider",
      "minimax",
      "--disable-fallback-model",
      "--pass-session-id",
    ]));
    expect(logs.some(([, chunk]) => chunk.includes("skipped unsupported flags"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        requestedSessionId: "paperclip_run_legacy",
        requestedSessionIdEffective: false,
        hermesCliCapabilities: expect.objectContaining({
          source: "detected",
          skippedFlags: expect.arrayContaining(["--max-turns", "--session-id"]),
          supportedFlags: expect.not.arrayContaining(["--max-turns", "--session-id"]),
        }),
      }),
    });
  });

  it("reports and syncs Hermes-visible Paperclip skills", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-skills-"));
    const hermesHome = path.join(dir, "hermes-home");
    const paperclipSkill = path.join(dir, "paperclip-skill");
    const researchSkill = path.join(dir, "research-skill");
    await fsp.mkdir(paperclipSkill, { recursive: true });
    await fsp.mkdir(researchSkill, { recursive: true });
    await fsp.writeFile(path.join(paperclipSkill, "SKILL.md"), "---\nname: paperclip\n---\n# Paperclip\n", "utf-8");
    await fsp.writeFile(path.join(researchSkill, "SKILL.md"), "---\nname: voc-research-miner\n---\n# VOC\n", "utf-8");

    const config = {
      hermesHome,
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source: paperclipSkill,
          required: true,
        },
        {
          key: "local/voc-research-miner",
          runtimeName: "voc-research-miner",
          source: researchSkill,
        },
      ],
      paperclipSkillSync: {
        desiredSkills: ["local/voc-research-miner"],
      },
    };
    const ctx = {
      agentId: "agent_test",
      companyId: "company_test",
      adapterType: "hermes_local",
      config,
    };

    const before = await listSkills(ctx);
    expect(before.desiredSkills).toEqual([
      "paperclipai/paperclip/paperclip",
      "local/voc-research-miner",
    ]);
    expect(before.entries.find((entry) => entry.runtimeName === "voc-research-miner")?.state).toBe("missing");

    const after = await syncSkills(ctx, before.desiredSkills);
    expect(after.entries.find((entry) => entry.runtimeName === "paperclip")?.state).toBe("installed");
    expect(after.entries.find((entry) => entry.runtimeName === "voc-research-miner")?.state).toBe("installed");
    expect(await fsp.realpath(path.join(hermesHome, "skills", "paperclip", "voc-research-miner"))).toBe(
      await fsp.realpath(researchSkill),
    );
  });

  it("recovers session-id-only Hermes output from the state db final assistant response", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-state-final-"));
    const hermesHome = path.join(dir, "hermes-home");
    const command = path.join(dir, "hermes-fake.mjs");
    seedHermesFinalMessage(hermesHome, "db-session-123", "Recovered final answer from Hermes state.");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "console.error('session_id: db-session-123');",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_state_final",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { issueId: "issue_test", wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("Recovered final answer from Hermes state.");
    expect(result.resultJson?.finalResponseSource).toBe("hermes_state_db");
  });

  it("rejects an unfinished tool-call envelope from the state db", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-state-tool-call-"));
    const hermesHome = path.join(dir, "hermes-home");
    const command = path.join(dir, "hermes-fake.mjs");
    seedHermesFinalMessage(
      hermesHome,
      "tool-call-session-123",
      '<tool_calls><invoke name="terminal"><parameter name="command">curl /api/health</parameter></invoke></tool_calls>',
    );
    await fsp.writeFile(
      command,
      ["#!/usr/bin/env node", "console.error('session_id: tool-call-session-123');", ""].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_state_tool_call",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { issueId: "issue_test", wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("missing_final_response");
    expect(result.summary).toBeNull();
    expect(result.resultJson?.finalResponseSource).toBeNull();
  });

  it("prefers Hermes state final over tool progress output", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-progress-final-"));
    const hermesHome = path.join(dir, "hermes-home");
    const command = path.join(dir, "hermes-fake.mjs");
    seedHermesFinalMessage(hermesHome, "progress-final-session", "Real deliverable from Hermes state.");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "console.log('diff --git a/tmp/progress.txt b/tmp/progress.txt');",
        "console.log('index 1111111..2222222 100644');",
        "console.log('--- a/tmp/progress.txt');",
        "console.log('+++ b/tmp/progress.txt');",
        "console.log('@@ -0,0 +1 @@');",
        "console.log('+tool progress only');",
        "console.error('session_id: progress-final-session');",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_progress_final",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { issueId: "issue_test", wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("Real deliverable from Hermes state.");
    expect(result.resultJson?.finalResponseSource).toBe("hermes_state_db");
  });

  it("fails tool progress output when no final response exists", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-progress-only-"));
    const hermesHome = path.join(dir, "hermes-home");
    await fsp.mkdir(hermesHome, { recursive: true });
    const command = path.join(dir, "hermes-fake.mjs");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "console.log('diff --git a/tmp/progress.txt b/tmp/progress.txt');",
        "console.log('index 1111111..2222222 100644');",
        "console.log('--- a/tmp/progress.txt');",
        "console.log('+++ b/tmp/progress.txt');",
        "console.log('@@ -0,0 +1 @@');",
        "console.log('+tool progress only');",
        "console.error('session_id: progress-only-session');",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_progress_only",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { issueId: "issue_test", wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("missing_final_response");
    expect(result.summary).toBeNull();
    expect(result.resultJson?.finalResponseSource).toBeNull();
  });

  it("fails session-id-only Hermes output when no final response exists", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-missing-final-"));
    const hermesHome = path.join(dir, "hermes-home");
    await fsp.mkdir(hermesHome, { recursive: true });
    const command = path.join(dir, "hermes-fake.mjs");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "console.error('session_id: missing-final-session');",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_missing_final",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { issueId: "issue_test", wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
      authToken: "run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("missing_final_response");
    expect(result.errorMessage).toContain("without a final assistant response");
    expect(result.summary).toBeNull();
    expect(result.resultJson?.finalResponseSource).toBeNull();
  });

  it("adaptively limits managed Hermes skill preloads", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-skill-budget-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const hermesHome = path.join(dir, "hermes-home");
    const metas: unknown[] = [];

    async function makeSkill(runtimeName: string) {
      const source = path.join(dir, `runtime-${runtimeName}`);
      await fsp.mkdir(source, { recursive: true });
      await fsp.writeFile(path.join(source, "SKILL.md"), `---\nname: ${runtimeName}\n---\n# ${runtimeName}\n`, "utf-8");
      return {
        key: `local/${runtimeName}`,
        runtimeName,
        source,
        required: runtimeName === "paperclip",
      };
    }

    const runtimeSkills = await Promise.all([
      "paperclip",
      "paperclip-go-to-market",
      "paperclip-product-scope",
      "product-launch",
      "distribution-spine",
      "analytics-tracking",
      "long-form-sales-letter",
      "seo-article-architect",
      "b2b-case-study-journalist",
      "ponytail",
    ].map(makeSkill));

    const result = await execute({
      runId: "run_skill_budget",
      agent: {
        id: "agent_cmo",
        companyId: "company_test",
        name: "CMO",
        role: "cmo",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        hermesHome,
        source: "paperclip-test",
        promptTemplate: "Test prompt",
        paperclipRuntimeSkills: runtimeSkills,
        paperclipSkillSync: {
          desiredSkills: runtimeSkills.map((entry) => entry.key),
        },
      },
      context: {
        paperclipWake: {
          issue: {
            title: "Reissue GTM as community-channel pack gated to v0.4.0 tag",
          },
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    const selectedSkills = args
      .map((arg: string, index: number) => arg === "-s" ? args[index + 1] : null)
      .filter(Boolean);
    expect(result.exitCode).toBe(0);
    expect(selectedSkills.length).toBeLessThanOrEqual(5);
    expect(selectedSkills).toEqual(expect.arrayContaining([
      "paperclip/paperclip",
      "paperclip/paperclip-go-to-market",
      "paperclip/product-launch",
      "paperclip/distribution-spine",
    ]));
    expect(selectedSkills).not.toContain("paperclip/long-form-sales-letter");
    expect(selectedSkills).not.toContain("paperclip/b2b-case-study-journalist");
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        skillBudget: expect.objectContaining({
          maxSkills: 5,
          skippedCount: expect.any(Number),
        }),
      }),
    });
    expect(((metas[0] as any).promptMetrics.skillBudget.skippedCount as number)).toBeGreaterThan(0);
  });

  it("bounds no-handoff Hermes runs to deterministic status mode", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-shaping-"));
    const { command, argsPath, envPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_no_handoff",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-session-456",
        sessionParams: { sessionId: "stale-session-456", cwd: dir, source: "paperclip-test" },
        sessionDisplayId: "stale-session-456",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        maxTurnsPerRun: 12,
        contextMaxChars: 24_000,
        outputMaxSentences: 12,
        outputMaxChars: 3_200,
        promptTemplate: "No handoff prompt for {{agent.name}}\n{{context.json}}",
      },
      context: {
        wakeSource: "timer",
        wakeTriggerDetail: "system",
        paperclipExecutionRouting: { detail: "x".repeat(20_000) },
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    const env = JSON.parse(await fsp.readFile(envPath, "utf-8"));
    const prompt = args[args.indexOf("-q") + 1];

    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "4"]));
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_no_handoff"]));
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("stale-session-456");
    expect(env).toMatchObject({
      HERMES_OUTPUT_MAX_SENTENCES: "6",
      HERMES_OUTPUT_MAX_CHARS: "1200",
    });
    expect(prompt.length).toBeLessThan(10_000);
    expect(prompt).toContain("no explicit issue, comment, approval, or human prompt was provided");
    expect(prompt).toContain("Does this session's prior runs provide any value to this current run?");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("Request shaping: bounded_status"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptClass: "bootstrap",
      promptMetrics: expect.objectContaining({
        contextMaxChars: 8_000,
        requestShapingMode: "bounded_status",
        requestShapingReason: "no_issue_comment_approval_or_prompt_handoff",
        requestShapingAllowSessionResume: false,
        requestShapingDroppedSessionHandoff: true,
        sessionIdBefore: "stale-session-456",
        requestedSessionId: "paperclip_run_no_handoff",
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "request_shaping_bounded_status",
        outputMaxSentences: 6,
        outputMaxChars: 1_200,
      }),
    });
  });

  it("keeps timer-pinned assigned work on a bounded deliverable budget when there is no new external signal", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-timer-budget-"));
    const { command, argsPath, envPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_timer_budget",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "prior-issue-session",
        sessionParams: {
          sessionId: "prior-issue-session",
          cwd: dir,
          source: "paperclip-test",
          workKey: "issue:issue-timer",
          issueId: "issue-timer",
        },
        sessionDisplayId: "prior-issue-session",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        maxTurnsPerRun: 12,
        contextMaxChars: 24_000,
        outputMaxSentences: 12,
        outputMaxChars: 3_200,
        promptTemplate: "Timer prompt for {{agent.name}}\n{{context.json}}",
      },
      context: {
        issueId: "issue-timer",
        taskId: "issue-timer",
        wakeSource: "timer",
        wakeReason: "assigned_work_timer",
        paperclipTimerPinnedIssue: {
          issueId: "issue-timer",
          identifier: "PAP-22",
          status: "in_progress",
          reason: "timer_open_assignment_pinned",
        },
        paperclipWake: {
          reason: "assigned_work_timer",
          issue: {
            id: "issue-timer",
            identifier: "PAP-22",
            title: "Timer-pinned issue",
          },
          comments: [],
          commentIds: [],
        },
        paperclipExecutionRouting: { detail: "x".repeat(20_000) },
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    const env = JSON.parse(await fsp.readFile(envPath, "utf-8"));
    const prompt = args[args.indexOf("-q") + 1];

    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_timer_budget", "--max-turns", "6"]));
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("prior-issue-session");
    expect(env).toMatchObject({
      HERMES_OUTPUT_MAX_SENTENCES: "6",
      HERMES_OUTPUT_MAX_CHARS: "1400",
    });
    expect(prompt.length).toBeLessThan(14_000);
    expect(prompt).toContain("timer-pinned assigned work has no new external signal");
    expect(prompt).toContain("Keep exploration bounded unless the current issue exposes a new actionable acceptance criterion");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("Request shaping: deliverable_work"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        contextMaxChars: 12_000,
        requestShapingMode: "deliverable_work",
        requestShapingReason: "timer_assigned_work_without_external_signal",
        requestShapingAllowSessionResume: false,
        requestShapingDroppedSessionHandoff: true,
        sessionIdBefore: "prior-issue-session",
        requestedSessionId: "paperclip_run_timer_budget",
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "request_shaping_deliverable_work",
        outputMaxSentences: 6,
        outputMaxChars: 1_400,
      }),
    });
  });

  it("preserves the provider-policy turn budget for a timer-woken Profit Flywheel stage", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-flywheel-budget-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_flywheel_budget",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        maxTurnsPerRun: 48,
        requestShaping: { timerAssignedMaxTurnsPerRun: 6 },
      },
      context: {
        issueId: "issue-flywheel",
        wakeSource: "timer",
        wakeReason: "assigned_work_timer",
        paperclipTimerPinnedIssue: {
          issueId: "issue-flywheel",
          reason: "timer_open_assignment_pinned",
        },
        profitFlywheelStageRunId: "stage-flywheel",
        paperclipProfitFlywheelExecutionManifest: {
          stage_run_id: "stage-flywheel",
          attempt: 1,
        },
      },
      onLog: async () => undefined,
      onMeta: async (meta) => { metas.push(meta); },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "48"]));
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        requestShapingReason: "explicit_issue_comment_approval_or_prompt",
      }),
    });
  });

  it("starts a fresh run-owned Hermes session when legacy session metadata cannot prove the same issue", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-session-guard-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_guard",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "legacy-session",
        sessionParams: { sessionId: "legacy-session", cwd: dir, source: "paperclip-test" },
        sessionDisplayId: "legacy-session",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        maxTurnsPerRun: 12,
      },
      context: {
        issueId: "issue-new",
        wakeReason: "timer_tick",
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    const prompt = args[args.indexOf("-q") + 1];
    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_guard", "--max-turns", "12"]));
    expect(args).not.toContain("--resume");
    expect(prompt).toContain("explicit work handoff detected");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("missing_saved_work_key"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        requestShapingMode: "deliverable_work",
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "missing_saved_work_key",
        workIdentity: expect.objectContaining({
          workKey: "issue:issue-new",
          issueId: "issue-new",
        }),
      }),
    });
    expect(result.sessionParams).toEqual({
      sessionId: "fake-session-123",
      cwd: dir,
      source: "paperclip-test",
      workKey: "issue:issue-new",
      issueId: "issue-new",
    });
  });

  it("starts a fresh run-owned Hermes session for a new comment signal on the same issue", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-new-comment-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_new_comment",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "prior-same-issue-session",
        sessionParams: {
          sessionId: "prior-same-issue-session",
          cwd: dir,
          source: "paperclip-test",
          workKey: "issue:issue-same",
          issueId: "issue-same",
          commentId: "old-comment",
        },
        sessionDisplayId: "prior-same-issue-session",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
      },
      context: {
        issueId: "issue-same",
        wakeCommentId: "new-comment",
        wakeReason: "issue_comment_mentioned",
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_new_comment"]));
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("prior-same-issue-session");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("comment_signal_mismatch"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptClass: "comment_delta",
      promptMetrics: expect.objectContaining({
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "comment_signal_mismatch",
        workIdentity: expect.objectContaining({
          workKey: "issue:issue-same",
          issueId: "issue-same",
          commentId: "new-comment",
        }),
        savedWorkIdentity: expect.objectContaining({
          workKey: "issue:issue-same",
          issueId: "issue-same",
          commentId: "old-comment",
        }),
      }),
    });
  });

  it("starts a fresh run-owned Hermes session for process-loss recovery on the same issue", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-process-loss-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_process_loss",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "prior-same-issue-session",
        sessionParams: {
          sessionId: "prior-same-issue-session",
          cwd: dir,
          source: "paperclip-test",
          workKey: "issue:issue-same",
          issueId: "issue-same",
          commentId: "same-comment",
        },
        sessionDisplayId: "prior-same-issue-session",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
      },
      context: {
        issueId: "issue-same",
        wakeCommentId: "same-comment",
        wakeReason: "process_lost_retry",
        retryReason: "process_lost",
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_process_loss"]));
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("prior-same-issue-session");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("process_lost_retry_fresh_session"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptClass: "comment_delta",
      promptMetrics: expect.objectContaining({
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "process_lost_retry_fresh_session",
        workIdentity: expect.objectContaining({
          workKey: "issue:issue-same",
          issueId: "issue-same",
          commentId: "same-comment",
        }),
      }),
    });
  });

  it("starts a fresh run-owned Hermes session when the current prompt is fingerprinted but the saved session is not", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-fingerprint-"));
    const { command, argsPath } = await makeFakeHermes(dir);
    const logs: Array<[string, string]> = [];
    const metas: unknown[] = [];
    const result = await execute({
      runId: "run_fingerprint",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "prior-same-issue-session",
        sessionParams: {
          sessionId: "prior-same-issue-session",
          cwd: dir,
          source: "paperclip-test",
          workKey: "issue:issue-same",
          issueId: "issue-same",
        },
        sessionDisplayId: "prior-same-issue-session",
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
      },
      context: {
        issueId: "issue-same",
        paperclipContextLedger: { promptFingerprint: "prompt-fingerprint-new" },
      },
      onLog: async (stream, chunk) => {
        logs.push([stream, chunk]);
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
    });

    const args = JSON.parse(await fsp.readFile(argsPath, "utf-8"));
    expect(result.exitCode).toBe(0);
    expect(args).toEqual(expect.arrayContaining(["--session-id", "paperclip_run_fingerprint"]));
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("prior-same-issue-session");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk.includes("missing_saved_context_fingerprint"))).toBe(true);
    expect(metas[0]).toMatchObject({
      promptMetrics: expect.objectContaining({
        sessionResumeSuppressed: true,
        sessionResumeSuppressedReason: "missing_saved_context_fingerprint",
      }),
    });
    expect(result.sessionParams).toMatchObject({
      workKey: "issue:issue-same",
      issueId: "issue-same",
      contextFingerprint: "prompt-fingerprint-new",
    });
  });

  it("preserves stdout provider failures when stderr only has session id", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-provider-failure-"));
    const command = path.join(dir, "hermes-fake.mjs");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "console.log('API call failed after 3 retries: HTTP 429: Token Plan rate limit reached: Upgrade your Token Plan or switch to pay-as-you-go API usage. (2062)');",
        "console.error('session_id: failed-session-123');",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const result = await execute({
      runId: "run_provider_failure",
      agent: {
        id: "agent_test",
        companyId: "company_test",
        name: "Hermes Test",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command,
        cwd: dir,
        model: "MiniMax-M3",
        provider: "minimax",
        source: "paperclip-test",
        promptTemplate: "Test prompt",
      },
      context: { wakeReason: "test" },
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBe("failed-session-123");
    expect(result.errorCode).toBe("provider_quota_failure");
    expect(result.errorMessage).toContain("Token Plan rate limit reached");
    expect(result.errorMessage).not.toMatch(/^session_id:/);
  });

  it("keeps Hermes session params portable across cwd and source", () => {
    const params = { sessionId: "abc123", cwd: "/tmp/project", source: "paperclip", workKey: "issue:1", issueId: "1" };
    expect(sessionCodec.deserialize(params)).toEqual(params);
    expect(sessionCodec.serialize(params)).toEqual(params);
    expect(sessionCodec.getDisplayId?.(params)).toBe("abc123");
  });

  it("reports environment status for the configured Hermes command", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-env-"));
    const { command } = await makeFakeHermes(dir);
    const result = await testEnvironment({
      companyId: "company_test",
      adapterType: "hermes_local",
      config: {
        command,
        provider: "minimax",
        model: "MiniMax-M3",
        disableFallbackModel: true,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "version", level: "info" }),
        expect.objectContaining({ code: "doctor", level: "info" }),
        expect.objectContaining({ code: "routing_configured", level: "info" }),
        expect.objectContaining({ code: "fallback_disabled", level: "info" }),
      ]),
    );
  });

  it("never runs the synchronous Hermes doctor during bounded provider preflight", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-bounded-env-"));
    const command = path.join(dir, "hermes-bounded-fake.mjs");
    const doctorMarker = path.join(dir, "doctor-was-called");
    await fsp.writeFile(
      command,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "if (process.argv.includes('--version')) { console.log('Hermes Agent v0.16.0'); process.exit(0); }",
        `if (process.argv.includes('doctor')) { fs.writeFileSync(${JSON.stringify(doctorMarker)}, 'called'); setTimeout(() => process.exit(0), 60_000); }`,
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(command, 0o755);

    const startedAt = Date.now();
    const result = await testEnvironment({
      companyId: "company_test",
      adapterType: "hermes_local",
      config: {
        command,
        provider: "minimax",
        model: "MiniMax-M3",
        paperclipEnvironmentProbe: {
          mode: "provider_reliability_preflight",
          skipDoctor: true,
          timeoutMs: 2_000,
        },
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "version", level: "info" }),
      expect.objectContaining({ code: "doctor_skipped_bounded_preflight", level: "info" }),
    ]));
    expect(fs.existsSync(doctorMarker)).toBe(false);
  });
});
