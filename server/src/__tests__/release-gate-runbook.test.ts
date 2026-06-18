import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runbookPath = path.resolve(process.cwd(), "..", "scripts/process-runbooks/release-gate-runner.mjs");
const tempDirs = new Set<string>();
const servers = new Set<http.Server>();

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-release-gate-"));
  tempDirs.add(dir);
  return dir;
}

function sha256File(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
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

function initRepo(repoDir: string, gateScript: string) {
  fs.mkdirSync(repoDir, { recursive: true });
  run("git", ["init", "-b", "main"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      "release:gate": gateScript,
    },
  }, null, 2));
  run("git", ["add", "README.md", "package.json"], repoDir);
  run("git", ["-c", "user.name=Paperclip", "-c", "user.email=paperclip@example.test", "commit", "-m", "init"], repoDir);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  run("git", ["update-ref", "refs/remotes/origin/main", head], repoDir);
}

async function withApiServer(
  issue: Record<string, unknown>,
  approval: Record<string, unknown>,
  run: (baseUrl: string, calls: unknown[]) => Promise<void>,
) {
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
      if (req.method === "GET" && req.url === `/api/approvals/${approval.id}`) {
        res.end(JSON.stringify({ approval }));
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

function releaseGateIssue(input: {
  repoDir: string;
  dispatchPath: string;
  dispatchHash: string;
  approvalId: string;
}) {
  return {
    id: "issue-release-gate",
    identifier: "PORAA-2821",
    description: [
      "Reconcile merge readiness, approval state, and ship discipline for this run.",
      "",
      `Target clone: ${input.repoDir}`,
      "Release target branch: main",
      `launch_execution approval: ${input.approvalId}`,
      "",
      "## Portfolio Dispatch Contract",
      "```json",
      JSON.stringify({
        run_id: "20260504T004042Z",
        routine_key: "release-gate-reconciler",
        dispatch_hash: input.dispatchHash,
        target_repo_ref: "main",
        source_dispatch_path: input.dispatchPath,
        approval_id: input.approvalId,
      }, null, 2),
      "```",
    ].join("\n"),
  };
}

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("release gate process runbook", () => {
  it("runs the release gate, patches the issue done, writes artifacts, and reports zero provider tokens", async () => {
    const tempDir = mkTempDir();
    const repoDir = path.join(tempDir, "target");
    const portfolioDir = path.join(tempDir, "portfolio-os");
    initRepo(repoDir, "node -e \"console.log('release gate ok')\"");
    fs.mkdirSync(path.join(portfolioDir, "data/dispatch/outbox"), { recursive: true });
    const dispatchPath = path.join(portfolioDir, "data/dispatch/outbox/dispatch_20260504T004042Z.json");
    fs.writeFileSync(dispatchPath, JSON.stringify({ run_id: "20260504T004042Z" }, null, 2));
    const approval = { id: "approval-ok", status: "approved", approvedAt: "2026-05-04T00:40:42.000Z" };
    const dispatchHash = sha256File(dispatchPath);
    const driftedDispatchHash = dispatchHash.replace(/^./, dispatchHash[0] === "0" ? "1" : "0");
    const issue = releaseGateIssue({
      repoDir,
      dispatchPath,
      dispatchHash: driftedDispatchHash,
      approvalId: approval.id,
    });

    await withApiServer(issue, approval, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: path.resolve(process.cwd(), ".."),
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-release-gate",
        },
        timeoutMs: 15_000,
      });

      expect(result.status).toBe(0);
      const marker = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PAPERCLIP_ADAPTER_RESULT_JSON="));
      expect(marker).toBeTruthy();
      const payload = JSON.parse(marker!.slice("PAPERCLIP_ADAPTER_RESULT_JSON=".length));
      expect(payload).toMatchObject({
        statusAction: "done",
        releaseGateStatus: "passed",
        providerTokensSpent: 0,
      });
      expect(payload.hashChecks[0]).toMatchObject({
        match: false,
        required: false,
      });
      expect(payload.reportPath).toContain("docs/release-gate-reconciler/20260504T004042Z/iteration-1.md");
      expect(fs.existsSync(payload.reportPath)).toBe(true);
      expect(fs.existsSync(payload.payloadPath)).toBe(true);
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

  it("patches the issue blocked when the release gate command fails", async () => {
    const tempDir = mkTempDir();
    const repoDir = path.join(tempDir, "target");
    const portfolioDir = path.join(tempDir, "portfolio-os");
    initRepo(repoDir, "node -e \"process.exit(1)\"");
    fs.mkdirSync(path.join(portfolioDir, "data/dispatch/outbox"), { recursive: true });
    const dispatchPath = path.join(portfolioDir, "data/dispatch/outbox/dispatch_20260504T004042Z.json");
    fs.writeFileSync(dispatchPath, JSON.stringify({ run_id: "20260504T004042Z" }, null, 2));
    const approval = { id: "approval-ok", status: "approved" };
    const issue = releaseGateIssue({
      repoDir,
      dispatchPath,
      dispatchHash: sha256File(dispatchPath),
      approvalId: approval.id,
    });

    await withApiServer(issue, approval, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: path.resolve(process.cwd(), ".."),
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-release-gate",
        },
        timeoutMs: 15_000,
      });

      expect(result.status).toBe(2);
      const marker = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PAPERCLIP_ADAPTER_RESULT_JSON="));
      const payload = JSON.parse(marker!.slice("PAPERCLIP_ADAPTER_RESULT_JSON=".length));
      expect(payload).toMatchObject({
        statusAction: "blocked",
        releaseGateStatus: "failed",
        providerTokensSpent: 0,
      });
      expect(calls).toContainEqual(expect.objectContaining({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        body: expect.objectContaining({
          status: "blocked",
          comment: expect.stringContaining("Release Gate Blocked"),
        }),
      }));
    });
  });
});
