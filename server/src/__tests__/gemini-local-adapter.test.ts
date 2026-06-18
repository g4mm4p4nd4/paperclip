import { describe, expect, it, vi } from "vitest";
import { isGeminiUnknownSessionError, parseGeminiJsonl } from "@paperclipai/adapter-gemini-local/server";
import { parseGeminiStdoutLine } from "@paperclipai/adapter-gemini-local/ui";
import { printGeminiStreamEvent } from "@paperclipai/adapter-gemini-local/cli";
import { stripGeminiStderrNoise } from "../../../packages/adapters/gemini-local/src/server/noise.js";

describe("gemini_local parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-1", model: "gemini-2.5-pro" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "gemini-session-1",
        usage: {
          promptTokenCount: 12,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 7,
        },
        total_cost_usd: 0.00123,
        result: "done",
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("gemini-session-1");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(parsed.costUsd).toBeCloseTo(0.00123, 6);
    expect(parsed.errorMessage).toBe("model access denied");
  });

  it("extracts structured questions", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "output_text", text: "I have a question." },
            {
              type: "question",
              prompt: "Which model?",
              choices: [
                { key: "pro", label: "Gemini Pro", description: "Better" },
                { key: "flash", label: "Gemini Flash" },
              ],
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.summary).toBe("I have a question.");
    expect(parsed.question).toEqual({
      prompt: "Which model?",
      choices: [
        { key: "pro", label: "Gemini Pro", description: "Better" },
        { key: "flash", label: "Gemini Flash", description: undefined },
      ],
    });
  });

  it("extracts token usage from Gemini CLI result stats without double-counting cached input", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "gemini-session-stats",
      stats: {
        input: 344400,
        cached: 1934051,
        input_tokens: 2278451,
        output_tokens: 2338,
        total_tokens: 2287161,
      },
      result: "done",
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("gemini-session-stats");
    expect(parsed.usage).toEqual({
      inputTokens: 344400,
      cachedInputTokens: 1934051,
      outputTokens: 2338,
    });
  });

  it("parses current Gemini CLI init/message/result stream shape", () => {
    const stdout = [
      JSON.stringify({
        type: "init",
        timestamp: "2026-06-16T22:17:41.178Z",
        session_id: "gemini-current-session",
        model: "gemini-2.5-flash",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-16T22:17:42.850Z",
        role: "assistant",
        content: "ok",
        delta: true,
      }),
      JSON.stringify({
        type: "result",
        timestamp: "2026-06-16T22:17:42.879Z",
        status: "success",
        stats: {
          total_tokens: 10086,
          input_tokens: 10034,
          output_tokens: 1,
          cached: 0,
          input: 10034,
        },
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("gemini-current-session");
    expect(parsed.summary).toBe("ok");
    expect(parsed.usage).toEqual({
      inputTokens: 10034,
      cachedInputTokens: 0,
      outputTokens: 1,
    });
    expect(parsed.errorMessage).toBeNull();
  });
});

describe("gemini_local stale session detection", () => {
  it("treats missing session messages as an unknown session error", () => {
    expect(isGeminiUnknownSessionError("", "unknown session id abc")).toBe(true);
    expect(isGeminiUnknownSessionError("", "checkpoint latest not found")).toBe(true);
    expect(isGeminiUnknownSessionError("", 'Error resuming session: Invalid session identifier "019da127".')).toBe(true);
  });
});

describe("gemini_local stderr noise filtering", () => {
  it("drops duplicated YOLO banners and keeps the real failure text", () => {
    const input = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      'Error resuming session: Invalid session identifier "019da127-b140-7551-9782-4ca82233b9d0".',
    ].join("\n");

    expect(stripGeminiStderrNoise(input)).toBe(
      'Error resuming session: Invalid session identifier "019da127-b140-7551-9782-4ca82233b9d0".',
    );
  });
});

describe("gemini_local ui stdout parser", () => {
  it("parses assistant, thinking, and result events", () => {
    const ts = "2026-03-08T00:00:00.000Z";

    expect(
      parseGeminiStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "output_text", text: "I checked the repo." },
              { type: "thinking", text: "Reviewing adapter registry" },
              { type: "tool_call", name: "shell", input: { command: "ls -1" } },
              { type: "tool_result", tool_use_id: "tool_1", output: "AGENTS.md\n", status: "ok" },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I checked the repo." },
      { kind: "thinking", ts, text: "Reviewing adapter registry" },
      { kind: "tool_call", ts, name: "shell", input: { command: "ls -1" } },
      { kind: "tool_result", ts, toolUseId: "tool_1", content: "AGENTS.md\n", isError: false },
    ]);

    expect(
      parseGeminiStdoutLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            cachedContentTokenCount: 2,
          },
          total_cost_usd: 0.00042,
          is_error: false,
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.00042,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("parses result token usage from stats events", () => {
    const ts = "2026-03-08T00:00:00.000Z";

    expect(
      parseGeminiStdoutLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          stats: {
            input: 344400,
            cached: 1934051,
            input_tokens: 2278451,
            output_tokens: 2338,
          },
          total_cost_usd: 0,
          is_error: false,
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 344400,
        outputTokens: 2338,
        cachedTokens: 1934051,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("parses current init and message events", () => {
    const ts = "2026-06-16T22:17:41.178Z";

    expect(
      parseGeminiStdoutLine(
        JSON.stringify({
          type: "init",
          session_id: "gemini-current-session",
          model: "gemini-2.5-flash",
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "gemini-2.5-flash",
        sessionId: "gemini-current-session",
      },
    ]);

    expect(
      parseGeminiStdoutLine(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "ok",
          delta: true,
        }),
        ts,
      ),
    ).toEqual([{ kind: "assistant", ts, text: "ok" }]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("gemini_local cli formatter", () => {
  it("prints init, assistant, result, and error events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printGeminiStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-1", model: "gemini-2.5-pro" }),
        false,
      );
      printGeminiStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "output_text", text: "hello" }] },
        }),
        false,
      );
      printGeminiStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            cachedContentTokenCount: 2,
          },
          total_cost_usd: 0.00042,
        }),
        false,
      );
      printGeminiStreamEvent(
        JSON.stringify({ type: "error", message: "boom" }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Gemini init");
    expect(joined).toContain("assistant: hello");
    expect(joined).toContain("tokens: in=10 out=5 cached=2 cost=$0.000420");
    expect(joined).toContain("error: boom");
  });

  it("prints result token usage from stats events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printGeminiStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          stats: {
            input: 344400,
            cached: 1934051,
            input_tokens: 2278451,
            output_tokens: 2338,
          },
          total_cost_usd: 0,
        }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("tokens: in=344400 out=2338 cached=1934051 cost=$0.000000");
  });

  it("prints current init and message events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printGeminiStreamEvent(
        JSON.stringify({
          type: "init",
          session_id: "gemini-current-session",
          model: "gemini-2.5-flash",
        }),
        false,
      );
      printGeminiStreamEvent(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "ok",
          delta: true,
        }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Gemini init");
    expect(joined).toContain("assistant: ok");
  });
});
