import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runbookPath = path.resolve(process.cwd(), "..", "scripts/process-runbooks/dispatch-poller-runner.mjs");
const tempDirs = new Set<string>();
const servers = new Set<http.Server>();

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dispatch-poller-"));
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

function initRepo(repoDir: string) {
  fs.mkdirSync(repoDir, { recursive: true });
  run("git", ["init", "-b", "main"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  run("git", ["add", "README.md"], repoDir);
  run("git", ["-c", "user.name=Paperclip", "-c", "user.email=paperclip@example.test", "commit", "-m", "init"], repoDir);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  run("git", ["update-ref", "refs/remotes/origin/main", head], repoDir);
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
      if (req.method === "GET" && req.url === `/api/issues/${issue.id}/approvals`) {
        res.end(JSON.stringify([]));
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

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("dispatch poller process runbook", () => {
  it("emits parity payload, patches the issue done, and reports zero provider tokens", async () => {
    const tempDir = mkTempDir();
    const repoDir = path.join(tempDir, "target");
    const portfolioDir = path.join(tempDir, "portfolio-os");
    initRepo(repoDir);
    fs.mkdirSync(path.join(portfolioDir, "data/dispatch/outbox"), { recursive: true });
    fs.mkdirSync(path.join(portfolioDir, "snapshots"), { recursive: true });
    const selectionHash = "733797fda64a21adb7414ac6db974c80278903013ade3d40f4fae753cb919252";
    const dossierHash = "4eae1f180cddd7e3760a50d293fc8268960424315bff88928c6c8feacdfbe068";
    const dispatchPath = path.join(portfolioDir, "data/dispatch/outbox/dispatch_20260503T193357Z.json");
    const selectionPath = path.join(portfolioDir, "snapshots/selection.json");
    const dossierPath = path.join(portfolioDir, "snapshots/dossier.json");
    fs.writeFileSync(selectionPath, JSON.stringify({ fixture: "selection" }));
    fs.writeFileSync(dossierPath, JSON.stringify({ fixture: "dossier" }));
    fs.writeFileSync(dispatchPath, JSON.stringify({
      run_id: "20260503T193357Z",
      selection_snapshot_hash: selectionHash,
      selected_repo_dossier_hash: dossierHash,
    }, null, 2));
    const observedDispatchHash = sha256File(dispatchPath);
    const canonicalDispatchHash = observedDispatchHash.replace(/^./, observedDispatchHash[0] === "a" ? "b" : "a");
    const issue = {
      id: "issue-dispatch-poller",
      identifier: "PORAA-3181",
      description: [
        "Reconcile this run against the immutable Portfolio OS dispatch contract.",
        "",
        `Dispatch file: ${dispatchPath}`,
        `Target clone: ${repoDir}`,
        "Expected run branch: run/20260503T193357Z/bootstrap",
        "",
        "## Portfolio Dispatch Contract",
        "```json",
        JSON.stringify({
          run_id: "20260503T193357Z",
          routine_key: "dispatch-poller",
          dispatch_hash: canonicalDispatchHash,
          selection_snapshot_hash: selectionHash,
          selected_repo_dossier_hash: dossierHash,
          target_repo_ref: "main",
          suggested_branch_name: "run/20260503T193357Z/bootstrap",
          source_dispatch_path: dispatchPath,
          selection_snapshot_path: selectionPath,
          selected_repo_dossier_path: dossierPath,
        }, null, 2),
        "```",
      ].join("\n"),
    };

    await withApiServer(issue, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: path.resolve(process.cwd(), ".."),
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-dispatch-poller",
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
        pollerState: "artifact drift",
        parityStatus: "artifact_drift",
        statusAction: "done",
        providerTokensSpent: 0,
      });
      expect(payload.reportPath).toContain("docs/dispatch-poller/20260503T193357Z/iteration-1.md");
      expect(fs.existsSync(payload.reportPath)).toBe(true);
      expect(fs.existsSync(payload.payloadPath)).toBe(true);
      expect(calls).toContainEqual({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        body: { status: "done" },
      });
    });
  });
});
