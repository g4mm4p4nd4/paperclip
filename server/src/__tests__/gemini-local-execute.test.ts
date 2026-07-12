import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";

async function writeFakeGeminiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const budgetScenario = process.env.PAPERCLIP_TEST_BUDGET_SCENARIO || "success";
let maxSessionTurns = null;
let systemSettingsMarker = null;
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
if (settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    maxSessionTurns = settings.model?.maxSessionTurns ?? null;
    systemSettingsMarker = settings.paperclipTestMarker ?? null;
  } catch {}
}
const payload = {
  argv: process.argv.slice(2),
  maxSessionTurns,
  systemSettingsMarker,
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "gemini-session-1",
  model: "gemini-2.5-pro",
}));
if (budgetScenario.startsWith("tool-output")) {
  console.log(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    tool_call: { run_shell_command: { result: "one\\ntwo\\nthree" } },
  }));
} else {
  const text = budgetScenario === "output" ? "x".repeat(32) : "hello";
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "output_text", text }] },
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    status: budgetScenario === "max-turns" ? "turn_limit" : "success",
    session_id: "gemini-session-1",
    result: text,
    usage: budgetScenario === "tokens"
      ? { input_tokens: 8, output_tokens: 5 }
      : { input_tokens: 1, output_tokens: 1 },
  }));
}
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

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
  maxSessionTurns?: number | null;
  systemSettingsMarker?: string | null;
  geminiApiKey?: string | null;
};

async function runGeminiBudgetScenario(
  scenario: string,
  budgetConfig: Record<string, unknown>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-gemini-budget-${scenario}-`));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "gemini");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await writeFakeGeminiCommand(commandPath);

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let commandNotes: string[] = [];
  try {
    const result = await execute({
      runId: `run-budget-${scenario}`,
      agent: {
        id: "agent-budget",
        companyId: "company-budget",
        name: "Gemini Budget Agent",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "gemini-2.5-pro",
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          PAPERCLIP_TEST_BUDGET_SCENARIO: scenario,
        },
        promptTemplate: "Complete the bounded provider task.",
        ...budgetConfig,
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
      onMeta: async (meta) => {
        commandNotes = meta.commandNotes ?? [];
      },
    });
    const spawned = await fs.access(capturePath).then(() => true, () => false);
    const capture = spawned
      ? JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload
      : null;
    return { result, spawned, capture, commandNotes };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("gemini execute", () => {
  it("adaptively limits persistent Gemini skills and prunes stale Paperclip-managed links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-skill-budget-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

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
      const staleSkill = runtimeSkills.find((entry) => entry.runtimeName === "long-form-sales-letter");
      const skillsHome = path.join(root, ".gemini", "skills");
      await fs.mkdir(skillsHome, { recursive: true });
      await fs.symlink(staleSkill!.source, path.join(skillsHome, staleSkill!.runtimeName));

      const result = await execute({
        runId: "run-skill-budget",
        agent: {
          id: "agent-cmo",
          companyId: "company-1",
          name: "CMO",
          role: "cmo",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
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

      const installedSkills = await fs.readdir(skillsHome);
      expect(installedSkills.length).toBeLessThanOrEqual(5);
      expect(installedSkills).toEqual(expect.arrayContaining([
        "paperclip",
        "paperclip-go-to-market",
        "paperclip-product-scope",
        "product-launch",
        "distribution-spine",
      ]));
      expect(installedSkills).not.toContain("long-form-sales-letter");
      expect(installedSkills).not.toContain("b2b-case-study-journalist");
      expect(promptMetrics.skillBudget).toMatchObject({
        mode: "adaptive",
        maxSkills: 5,
        skippedCount: 3,
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes prompt via --prompt and injects paperclip env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--output-format");
      expect(capture.argv).toContain("stream-json");
      expect(capture.argv).toContain("--prompt");
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(promptArg).toContain("Follow the paperclip heartbeat.");
      expect(promptArg).toContain("Paperclip runtime note:");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(invocationPrompt).toContain("Paperclip runtime note:");
      expect(invocationPrompt).toContain("PAPERCLIP_API_URL");
      expect(invocationPrompt).toContain("Paperclip API access note:");
      expect(invocationPrompt).toContain("run_shell_command");
      expect(result.question).toBeNull();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("caps the prompt sent to Gemini and records truncated sections", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-budget-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let promptMetrics: Record<string, unknown> = {};
    try {
      const result = await execute({
        runId: "run-budget",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          contextMaxChars: 3_000,
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

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(promptArg.length).toBeLessThanOrEqual(3_000);
      expect(promptArg).toContain("## Paperclip Output Contract");
      expect(promptArg).toContain("3 sentences, 640 characters");
      expect(promptArg).toContain("[Paperclip truncated heartbeat_prompt for prompt budget.]");
      expect(promptMetrics.contextMaxChars).toBe(3_000);
      expect(promptMetrics.promptTruncatedSections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "heartbeat_prompt" }),
        ]),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("always passes --approval-mode yolo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-yolo-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-yolo",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(capture.argv).not.toContain("--policy");
      expect(capture.argv).not.toContain("--allow-all");
      expect(capture.argv).not.toContain("--allow-read");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a compact wake delta instead of the full heartbeat prompt when resuming a matching comment session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-resume-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-resume",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "gemini-session-1",
          sessionParams: {
            sessionId: "gemini-session-1",
            cwd: workspace,
            workKey: "issue:issue-1",
            issueId: "issue-1",
            commentId: "comment-2",
          },
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 1,
              includedCount: 1,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(capture.argv).toContain("--resume");
      expect(capture.argv).toContain("gemini-session-1");
      expect(promptArg).toContain("## Paperclip Resume Delta");
      expect(promptArg).toContain("Do not switch to another issue until you have handled this wake.");
      expect(promptArg).toContain("Second comment");
      expect(promptArg).not.toContain("Follow the paperclip heartbeat.");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume or replay handoff text for no-handoff timer runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-resume-timer-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);
    await fs.writeFile(instructionsPath, "You are managed instructions.\n", "utf8");

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let promptClass: string | undefined;
    let promptMetrics: Record<string, unknown> = {};
    try {
      const result = await execute({
        runId: "run-resume-timer",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "gemini-session-1",
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "gemini-2.5-pro",
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          wakeReason: "heartbeat_timer",
          wakeSource: "timer",
          wakeTriggerDetail: "system",
          paperclipSessionHandoffMarkdown: "STALE SESSION HANDOFF THAT SHOULD NOT BE REPLAYED",
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

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(capture.argv).not.toContain("--resume");
      expect(capture.argv).not.toContain("gemini-session-1");
      expect(promptArg).toContain("## Paperclip Request Shaping");
      expect(promptArg).toContain("- mode: bounded_status");
      expect(promptArg).toContain("Default answer to the prior-run value question: no.");
      expect(promptArg).toContain("## Paperclip Output Contract");
      expect(promptArg).not.toContain("STALE SESSION HANDOFF");
      expect(promptClass).toBe("bootstrap");
      expect(promptMetrics.requestShapingMode).toBe("bounded_status");
      expect(promptMetrics.requestShapingAllowSessionResume).toBe(false);
      expect(promptMetrics.requestShapingDroppedSessionHandoff).toBe(true);
      expect(promptMetrics.sessionHandoffChars).toBe(0);
      expect(promptMetrics.outputBudgetVersion).toBe("output-economy.v1");
      expect(promptMetrics.outputContractChars).toBeGreaterThan(0);
      expect(promptMetrics.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "output_contract",
            contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            metadata: expect.objectContaining({ outputBudgetVersion: "output-economy.v1" }),
          }),
        ]),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["output", { outputMaxChars: 10 }, "provider_output_budget_exceeded"],
    ["tokens", { maxTotalTokens: 10 }, "provider_total_token_budget_exceeded"],
    ["tool-output-bytes", { toolOutputMaxBytes: 5 }, "provider_tool_output_budget_exceeded"],
    ["tool-output-lines", { toolOutputMaxLines: 2 }, "provider_tool_output_budget_exceeded"],
    ["tool-output-line-length", { toolOutputMaxLineLength: 4 }, "provider_tool_output_budget_exceeded"],
  ] as const)("rejects %s budget overruns after observing the Gemini result", async (scenario, config, errorCode) => {
    const { result, spawned } = await runGeminiBudgetScenario(scenario, config);

    expect(spawned).toBe(true);
    expect(result.errorCode).toBe(errorCode);
    expect(result.errorMessage).toContain("exceed");
    expect(result.provider).toBe("google");
    expect(result.clearSession).toBe(true);
  });

  it("rejects an irreducibly oversized Gemini prompt before spawning the provider", async () => {
    const { result, spawned } = await runGeminiBudgetScenario("success", { contextMaxChars: 10 });

    expect(spawned).toBe(false);
    expect(result.errorCode).toBe("provider_context_budget_exceeded");
    expect(result.exitCode).toBeNull();
  });

  it("pins Gemini's native maxSessionTurns setting and rejects its structured turn-limit result", async () => {
    const { result, capture, commandNotes } = await runGeminiBudgetScenario("max-turns", {
      maxTurnsPerRun: 3,
    });

    expect(capture?.maxSessionTurns).toBe(3);
    expect(commandNotes.join("\n")).toContain("model.maxSessionTurns=3");
    expect(result.errorCode).toBe("provider_max_turns_exceeded");
    expect(result.clearSession).toBe(true);
  });

  it("preserves explicit parent system settings only when parent-environment inheritance is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-parent-settings-"));
    const parentSettingsPath = path.join(root, "settings.json");
    const previousSettingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = parentSettingsPath;
    try {
      await fs.writeFile(parentSettingsPath, JSON.stringify({ paperclipTestMarker: "parent-setting" }), "utf8");
      const inherited = await runGeminiBudgetScenario("success", { maxTurnsPerRun: 3 });
      expect(inherited.capture).toMatchObject({
        maxSessionTurns: 3,
        systemSettingsMarker: "parent-setting",
      });

      await fs.writeFile(parentSettingsPath, "not-json", "utf8");
      const isolated = await runGeminiBudgetScenario("success", {
        maxTurnsPerRun: 3,
        isolateParentEnvironment: true,
      });
      expect(isolated.result.errorMessage).toBeNull();
      expect(isolated.capture).toMatchObject({ maxSessionTurns: 3, systemSettingsMarker: null });
    } finally {
      if (previousSettingsPath === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previousSettingsPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit a parent Gemini credential when the provider environment is isolated", async () => {
    const previousApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "parent-gemini-key-must-not-cross";
    try {
      const { result, capture } = await runGeminiBudgetScenario("success", {
        isolateParentEnvironment: true,
      });
      expect(capture?.geminiApiKey).toBeNull();
      expect(result.billingType).toBe("subscription");
    } finally {
      if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousApiKey;
    }
  });

  it("rejects policy-owned Gemini extra args before they can override model or sandbox semantics", async () => {
    await expect(runGeminiBudgetScenario("success", {
      isolateParentEnvironment: true,
      providerPolicyBinding: { routeId: "gemini-route", policySha256: "a".repeat(64) },
      extraArgs: ["--model", "wrong-model"],
    })).rejects.toThrow(/provider_policy_config_conflict.*extraArgs/);
  });
});
