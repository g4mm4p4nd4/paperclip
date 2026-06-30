import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runbookPath = path.resolve(repoRoot, "scripts/process-runbooks/evidence-backfill-runner.mjs");
const tempDirs = new Set<string>();
const servers = new Set<http.Server>();

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-evidence-backfill-"));
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

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("evidence backfill process runbook", () => {
  it("reconciles evidence artifacts, patches the issue, and reports zero provider tokens", async () => {
    const tempDir = mkTempDir();
    const portfolioDir = path.join(tempDir, "portfolio-os");
    const targetRepoDir = path.join(tempDir, "yt-synth");
    const dispatchPath = path.join(portfolioDir, "data/dispatch/outbox/dispatch_20260503T193357Z.json");
    const selectionPath = path.join(portfolioDir, "snapshots/selection.json");
    const dossierPath = path.join(portfolioDir, "snapshots/dossier.json");
    const inboxDir = path.join(portfolioDir, "data/dispatch/inbox");
    fs.mkdirSync(targetRepoDir, { recursive: true });

    writeJson(dispatchPath, {
      run_id: "20260503T193357Z",
      target_repo_full_name: "g4mm4p4nd4/YT-Synth",
      selection_snapshot_path: selectionPath,
      selected_repo_dossier_path: dossierPath,
      cockpit: {
        dispatch_inbox_dir: inboxDir,
      },
    });
    writeJson(selectionPath, {
      run_id: "20260503T193357Z",
      launch_target: {
        repo: "g4mm4p4nd4/YT-Synth",
        focus_lane: "next",
        evidence_ready: "true",
        missing_evidence: "",
        commercialization_confidence: "88.13",
        primary_supporting_evidence_count: "6",
        shared_supporting_evidence_count: "9",
        market_signal_count: "3",
        voc_count: "3",
        launch_eligible: "true",
        hard_gate_status: "clear",
        internet_pipes_readiness: "factory_ready",
        matched_signal_id: "sig-ytsynth",
        matched_signal_summary: "Video-first publishing rewards reusable audio workflows.",
        signal_evidence_url: "https://example.com/signal",
        matched_voc_id: "voc-ytsynth",
        matched_voc_summary: "Editing and promo consume most cycle time.",
        voc_source: "https://example.com/voc",
      },
      business_choice: {
        repo: "g4mm4p4nd4/other",
        evidence_ready: "false",
        missing_evidence: "Need market signals.",
      },
    });
    writeJson(dossierPath, {
      stage_0_gate_receipt: {
        gate_status: "APPROVED_DISTINCT_RESKIN",
      },
    });

    const issue = {
      id: "issue-evidence-backfill",
      identifier: "PORAA-3187",
      description: [
        "Backfill any missing evidence that still blocks this run.",
        "",
        `Primary artifact: ${selectionPath}`,
        "",
        "## Portfolio Dispatch Contract",
        "```json",
        JSON.stringify({
          run_id: "20260503T193357Z",
          routine_key: "evidence-backfill-reconciler",
          source_dispatch_path: dispatchPath,
          selection_snapshot_path: selectionPath,
          selected_repo_dossier_path: dossierPath,
          target_repo_clone_path_hint: targetRepoDir,
        }, null, 2),
        "```",
      ].join("\n"),
    };

    await withApiServer(issue, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-evidence-backfill",
          EVIDENCE_BACKFILL_WRITE_DOCS: "1",
        },
      });

      expect(result.status).toBe(0);
      const marker = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PAPERCLIP_ADAPTER_RESULT_JSON="));
      expect(marker).toBeTruthy();
      const payload = JSON.parse(marker!.slice("PAPERCLIP_ADAPTER_RESULT_JSON=".length));
      expect(payload).toMatchObject({
        blocksRun: false,
        dispatchBackfillStatus: "complete",
        providerTokensSpent: 0,
        statusAction: "done",
      });
      expect(fs.existsSync(payload.receiptPath)).toBe(true);
      expect(fs.existsSync(path.join(targetRepoDir, "docs/evidence-backfill-reconciler/20260503T193357Z/latest.md"))).toBe(true);
      const dispatch = readJson(dispatchPath);
      expect(dispatch.evidence_backfill_status).toBe("complete");
      expect(dispatch.evidence_backfill_path).toBe("data/dispatch/inbox/evidence_20260503T193357Z.json");
      expect(calls).toContainEqual({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        body: { status: "done" },
      });
    });
  });
});
