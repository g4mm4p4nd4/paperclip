import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runbookPath = path.resolve(repoRoot, "scripts/process-runbooks/run-qa-sweep-runner.mjs");
const tempDirs = new Set<string>();
const servers = new Set<http.Server>();

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-qa-sweep-"));
  tempDirs.add(dir);
  return dir;
}

async function runChild(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  return await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`child timed out after ${options.timeoutMs ?? 10_000}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, options.timeoutMs ?? 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (status, signal) => {
        clearTimeout(timeout);
        resolve({ status, signal, stdout, stderr });
      });
    },
  );
}

async function withApiServer(issue: Record<string, unknown>, run: (baseUrl: string, calls: unknown[]) => Promise<void>) {
  const calls: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : null;
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === `/api/issues/${issue.id}`) {
        res.end(JSON.stringify({
          payloadClass: "agent_issue_snapshot",
          issue,
        }));
        return;
      }
      if (req.method === "PATCH" && req.url === `/api/issues/${issue.id}`) {
        res.end(JSON.stringify({ ...issue, ...body }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }
}

function writeFakeGstackBin(root: string, opts?: { includeSurface?: boolean }) {
  const binPath = path.join(root, "fake-gstack-pos-build-qa.mjs");
  const includeSurface = opts?.includeSurface !== false;
  fs.writeFileSync(binPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const bundleIndex = process.argv.indexOf("--bundle");
const outputIndex = process.argv.indexOf("--output");
const artifactPath = process.argv[bundleIndex + 1];
const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const outputPath = outputIndex >= 0
  ? process.argv[outputIndex + 1]
  : path.join(path.dirname(artifactPath), "qa_verification.json");
const qaRoot = path.join(path.dirname(artifactPath), "qa-output");
const artifact = {
  schema_version: "gstack.pos_qa_verification.v1",
  generated_at: new Date().toISOString(),
  input_kind: "dispatch",
  input_path: artifactPath,
  run_id: payload.run_id || "run-qa-test",
  target_repo_full_name: "example/repo",
  target_repo_branch: "main",
  target_repo_clone_path: null,
  qa_output_root: qaRoot,
  qa_report_path: path.join(qaRoot, "qa_report.md"),
  screenshots_dir: path.join(qaRoot, "screenshots"),
  regression_notes_path: path.join(qaRoot, "regression_notes.md"),
  local_html_candidates: ${includeSurface ? "[path.join(path.dirname(artifactPath), \"index.html\")]" : "[]"},
  internet_pipes: {
    score: 1,
    readiness: "factory_ready",
    missing_stations: [],
    recommendations: [],
    source: "test",
  },
  checks: [{ id: "target-repo-present", status: "not_applicable" }],
  status: "ready_for_qa",
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\\n");
console.log(JSON.stringify({ artifact_path: outputPath, artifact }, null, 2));
`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function writeDispatchFixture(root: string) {
  const dispatchPath = path.join(root, "dispatch_run-qa-test.json");
  fs.writeFileSync(dispatchPath, JSON.stringify({
    schema_version: "pos.dispatch.v1",
    run_id: "run-qa-test",
  }, null, 2));
  fs.writeFileSync(path.join(root, "index.html"), [
    "<!doctype html>",
    "<html>",
    "<head><title>QA fixture</title></head>",
    "<body>",
    "<main>",
    "<h1>Factory-ready launch page</h1>",
    "<p>This page has enough deterministic text for the bounded QA sweep to verify layout, copy, and launch readiness signals.</p>",
    "<a href=\"/signup\">Start now</a>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n"));
  return dispatchPath;
}

function issueDescription(dispatchPath: string) {
  return [
    "Run a QA sweep for the current Portfolio OS dispatch using gstack.",
    "",
    `Primary artifact: ${dispatchPath}`,
    "",
    "## Portfolio Dispatch Contract",
    "```json",
    JSON.stringify({
      run_id: "run-qa-test",
      routine_key: "run-qa-sweep",
      source_dispatch_path: dispatchPath,
      paperclip_actionability: {
        lane: "qa",
        state: "ready_for_qa",
        blockerClass: "qa_gate",
      },
    }, null, 2),
    "```",
  ].join("\n");
}

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("run QA sweep process runbook", () => {
  it("generates QA evidence, patches the issue done, and reports zero provider tokens", async () => {
    const repoDir = mkTempDir();
    const fakeBin = writeFakeGstackBin(repoDir);
    const dispatchPath = writeDispatchFixture(repoDir);
    const issue = {
      id: "issue-run-qa-sweep",
      identifier: "PORA-2201",
      description: issueDescription(dispatchPath),
    };

    await withApiServer(issue, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-qa-test",
          RUN_QA_SWEEP_GSTACK_BIN: fakeBin,
          GSTACK_DIR: repoDir,
          RUN_QA_SWEEP_BROWSER_MODE: "stub",
        },
        timeoutMs: 10_000,
      });

      expect(result.status).toBe(0);
      const marker = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PAPERCLIP_ADAPTER_RESULT_JSON="));
      expect(marker).toBeTruthy();
      const payload = JSON.parse(marker!.slice("PAPERCLIP_ADAPTER_RESULT_JSON=".length));
      expect(payload).toMatchObject({
        statusAction: "done",
        qaArtifactStatus: "ready_for_qa",
        providerTokensSpent: 0,
      });
      expect(payload.browser.status).toBe("passed");
      expect(fs.existsSync(path.join(repoDir, "qa-output/qa_report.md"))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, "qa-output/regression_notes.md"))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, "qa-output/screenshots/desktop.png"))).toBe(true);
      expect(calls).toContainEqual(expect.objectContaining({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        body: expect.objectContaining({
          status: "done",
          comment: expect.stringContaining("Provider tokens: 0"),
        }),
      }));
    });
  });

  it("blocks truthfully when no QA target surface is available", async () => {
    const repoDir = mkTempDir();
    const fakeBin = writeFakeGstackBin(repoDir, { includeSurface: false });
    const dispatchPath = writeDispatchFixture(repoDir);
    fs.rmSync(path.join(repoDir, "index.html"), { force: true });
    const issue = {
      id: "issue-run-qa-sweep-blocked",
      identifier: "PORA-2202",
      description: issueDescription(dispatchPath),
    };

    await withApiServer(issue, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-qa-test",
          RUN_QA_SWEEP_GSTACK_BIN: fakeBin,
          GSTACK_DIR: repoDir,
          RUN_QA_SWEEP_BROWSER_MODE: "stub",
        },
        timeoutMs: 10_000,
      });

      expect(result.status).toBe(2);
      const marker = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PAPERCLIP_ADAPTER_RESULT_JSON="));
      expect(marker).toBeTruthy();
      const payload = JSON.parse(marker!.slice("PAPERCLIP_ADAPTER_RESULT_JSON=".length));
      expect(payload).toMatchObject({
        statusAction: "blocked",
        qaArtifactStatus: "ready_for_qa",
        providerTokensSpent: 0,
      });
      expect(payload.browser.status).toBe("blocked");
      expect(payload.browser.findings[0].id).toBe("target-surface");
      expect(calls).toContainEqual(expect.objectContaining({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        body: expect.objectContaining({
          status: "blocked",
          comment: expect.stringContaining("Run QA Sweep Blocked"),
        }),
      }));
    });
  });
});
