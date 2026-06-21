import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function createRuntimeSkill(root: string, runtimeName: string, required = false) {
  const source = path.join(root, `skill-${runtimeName}`);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${runtimeName}\n---\n# ${runtimeName}\n`, "utf8");
  return {
    key: `paperclip/${runtimeName}`,
    runtimeName,
    source,
    required,
  };
}

describe("claude execute", () => {
  it("adaptively limits mounted Paperclip skills and records skill budget metrics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skill-budget-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

    let promptMetrics: Record<string, unknown> = {};
    try {
      const runtimeSkills = await Promise.all([
        createRuntimeSkill(root, "paperclip", true),
        createRuntimeSkill(root, "paperclip-go-to-market"),
        createRuntimeSkill(root, "paperclip-product-scope"),
        createRuntimeSkill(root, "product-launch"),
        createRuntimeSkill(root, "distribution-spine"),
        createRuntimeSkill(root, "analytics-tracking"),
        createRuntimeSkill(root, "long-form-sales-letter"),
        createRuntimeSkill(root, "b2b-case-study-journalist"),
      ]);

      const result = await execute({
        runId: "run-skill-budget",
        agent: {
          id: "agent-cmo",
          companyId: "company-1",
          name: "CMO",
          role: "cmo",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          paperclipRuntimeSkills: runtimeSkills,
          paperclipSkillSync: {
            desiredSkills: runtimeSkills.map((entry) => entry.key),
          },
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Build the GTM launch channel pack.",
        },
        context: {
          paperclipWake: {
            issue: {
              title: "Reissue GTM as community-channel launch pack gated to v0.4.0",
            },
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
      };
      const addDirIndex = capture.argv.indexOf("--add-dir");
      const addDir = addDirIndex >= 0 ? capture.argv[addDirIndex + 1] : "";
      const mountedSkills = await fs.readdir(path.join(addDir, ".claude", "skills"));
      expect(mountedSkills.length).toBeLessThanOrEqual(8);
      expect(mountedSkills).toEqual(expect.arrayContaining([
        "paperclip",
        "paperclip-go-to-market",
        "paperclip-product-scope",
        "product-launch",
        "distribution-spine",
      ]));
      expect(mountedSkills).not.toContain("long-form-sales-letter");
      expect(mountedSkills).not.toContain("b2b-case-study-journalist");
      expect(promptMetrics.skillBudget).toMatchObject({
        mode: "adaptive",
        maxSkills: 8,
        skippedCount: 2,
      });
      await fs.rm(addDir, { recursive: true, force: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("caps the prompt sent to Claude and records truncated sections", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-budget-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

    let promptMetrics: Record<string, unknown> = {};
    try {
      const result = await execute({
        runId: "run-budget",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          contextMaxChars: 1_700,
          outputMaxChars: 640,
          outputMaxSentences: 3,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: `Follow the paperclip heartbeat.\n${"large context ".repeat(1_000)}`,
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        prompt: string;
      };
      expect(capture.prompt.length).toBeLessThanOrEqual(1_700);
      expect(capture.prompt).toContain("## Paperclip Output Contract");
      expect(capture.prompt).toContain("3 sentences, 640 characters");
      expect(capture.prompt).toContain("[Paperclip truncated heartbeat_prompt for prompt budget.]");
      expect(promptMetrics.contextMaxChars).toBe(1_700);
      expect(promptMetrics.promptTruncatedSections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "heartbeat_prompt" }),
        ]),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs HOME, CLAUDE_CONFIG_DIR, and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    const claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(loggedCommand).toBe(commandPath);
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume or replay handoff text for no-handoff timer runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-shaping-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

    let promptClass: string | undefined;
    let promptMetrics: Record<string, unknown> = {};
    try {
      const result = await execute({
        runId: "run-no-handoff",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "claude-stale-session",
          sessionParams: { sessionId: "claude-stale-session", cwd: workspace },
          sessionDisplayId: "claude-stale-session",
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          maxTurnsPerRun: 12,
          contextMaxChars: 24_000,
          outputMaxChars: 3_200,
          outputMaxSentences: 12,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          wakeReason: "heartbeat_timer",
          wakeSource: "timer",
          wakeTriggerDetail: "system",
          paperclipSessionHandoffMarkdown: "STALE CLAUDE SESSION HANDOFF",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          promptClass = meta.promptClass;
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        argv: string[];
        prompt: string;
      };
      expect(capture.argv).not.toContain("--resume");
      expect(capture.argv).not.toContain("claude-stale-session");
      expect(capture.argv).toEqual(expect.arrayContaining(["--max-turns", "4"]));
      expect(capture.prompt).toContain("## Paperclip Request Shaping");
      expect(capture.prompt).toContain("- mode: bounded_status");
      expect(capture.prompt).toContain("Default answer to the prior-run value question: no.");
      expect(capture.prompt).not.toContain("STALE CLAUDE SESSION HANDOFF");
      expect(promptClass).toBe("bootstrap");
      expect(promptMetrics).toMatchObject({
        requestShapingMode: "bounded_status",
        requestShapingAllowSessionResume: false,
        requestShapingDroppedSessionHandoff: true,
        sessionHandoffChars: 0,
        contextMaxChars: 8_000,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
