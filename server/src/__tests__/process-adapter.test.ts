import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { execute } from "../adapters/process/execute.js";
import { processAdapter } from "../adapters/process/index.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run_process_test",
    agent: {
      id: "agent_process_test",
      companyId: "company_process_test",
      name: "Process Test Agent",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("process adapter", () => {
  it("injects Paperclip run auth and promotes structured stdout into the adapter result", async () => {
    const script = [
      "const result = {",
      "  summary: 'deterministic deliverable complete',",
      "  runId: process.env.PAPERCLIP_RUN_ID,",
      "  taskId: process.env.PAPERCLIP_TASK_ID,",
      "  issueId: process.env.PAPERCLIP_ISSUE_ID,",
      "  hasApiKey: process.env.PAPERCLIP_API_KEY === 'jwt-token'",
      "};",
      "console.log('PAPERCLIP_ADAPTER_RESULT_JSON=' + JSON.stringify(result));",
    ].join("\n");

    const result = await execute(makeCtx({
      authToken: "jwt-token",
      context: {
        issueId: "issue_process_test",
        taskId: "issue_process_test",
        wakeReason: "assigned_work_timer",
      },
      config: {
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
      },
    }));

    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("deterministic deliverable complete");
    expect(result.resultJson).toMatchObject({
      summary: "deterministic deliverable complete",
      runId: "run_process_test",
      taskId: "issue_process_test",
      issueId: "issue_process_test",
      hasApiKey: true,
    });
    expect(String(result.resultJson?.stdout)).toContain("PAPERCLIP_ADAPTER_RESULT_JSON=");
  });

  it("forwards child process spawn metadata for liveness tracking", async () => {
    const spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];

    const result = await execute(makeCtx({
      onSpawn: async (meta) => {
        spawns.push(meta);
      },
      config: {
        command: process.execPath,
        args: ["-e", "console.log('spawn tracked')"],
        cwd: process.cwd(),
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.pid).toBeGreaterThan(0);
    expect(spawns[0]?.startedAt).toMatch(/T/);
  });
});
