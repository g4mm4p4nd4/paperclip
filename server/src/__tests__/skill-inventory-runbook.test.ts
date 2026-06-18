import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runbookPath = path.resolve(process.cwd(), "..", "scripts/process-runbooks/skill-inventory-runner.mjs");
const tempDirs = new Set<string>();
const servers = new Set<http.Server>();

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-skill-inventory-"));
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

function writeSkill(repoDir: string, name: string, frontmatter: string, body: string) {
  const dir = path.join(repoDir, ".agents/skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter.trim()}\n---\n\n${body.trim()}\n`);
}

function writeCuratorFixture(repoDir: string) {
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "scripts/skill_curator.py"), String.raw`#!/usr/bin/env python3
import json, os, re, sys
root = os.getcwd()
skill_root = os.path.join(root, ".agents/skills")
rows = []
for name in sorted(os.listdir(skill_root)):
    path = os.path.join(skill_root, name, "SKILL.md")
    if not os.path.isfile(path):
        continue
    text = open(path).read()
    fm_end = text.find("---", 3)
    fm = text[3:fm_end] if fm_end > 0 else ""
    body = text[fm_end + 3:] if fm_end > 0 else text
    ok = bool(re.search(r"^keywords:", fm, re.M)) and bool(re.search(r"^##\s*Trigger", body, re.M)) and bool(re.search(r"do not use", body, re.I))
    rows.append((name, ok))
report = os.path.join(root, "reports/skills/latest.md")
os.makedirs(os.path.dirname(report), exist_ok=True)
with open(report, "w") as f:
    f.write("# Skill Inventory Report (Curator)\n\n")
    f.write(f"**Total skills:** {len(rows)}  \n")
    f.write(f"**Validator pass / fail:** {sum(1 for _, ok in rows if ok)} / {sum(1 for _, ok in rows if not ok)}  \n")
summary = {"total": len(rows), "pass": sum(1 for _, ok in rows if ok), "fail": sum(1 for _, ok in rows if not ok), "kw_missing": sum(1 for name, ok in rows if not ok and "keywords:" not in open(os.path.join(skill_root, name, "SKILL.md")).read()), "report": report}
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["fail"] == 0 and summary["kw_missing"] == 0 else 1)
`);
  fs.chmodSync(path.join(repoDir, "scripts/skill_curator.py"), 0o755);
}

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("skill inventory process runbook", () => {
  it("repairs missing keyword frontmatter, reruns the curator, patches the issue done, and reports zero provider tokens", async () => {
    const repoDir = mkTempDir();
    writeCuratorFixture(repoDir);
    writeSkill(
      repoDir,
      "repo-opportunity-analyst",
      [
        "name: repo-opportunity-analyst",
        "description: Use when analyzing repositories for commercialization, launch paths, and execution readiness.",
      ].join("\n"),
      [
        "# Repo Opportunity Analyst",
        "",
        "## Trigger",
        "",
        "Use this for repo thesis, launch readiness, and opportunity analysis.",
        "",
        "Do not use when no repository context is available.",
      ].join("\n"),
    );
    writeSkill(
      repoDir,
      "analytics-tracking",
      [
        "name: analytics-tracking",
        "description: Use when auditing analytics tracking.",
        "keywords: analytics, tracking, measurement",
      ].join("\n"),
      [
        "# Analytics Tracking",
        "",
        "## Trigger",
        "",
        "Use for GA4 and measurement work.",
        "",
        "Do not use for unrelated product copy.",
      ].join("\n"),
    );
    const issue = {
      id: "issue-skill-inventory",
      identifier: "PORA-1801",
      description: `Keep company skills current.\n\nTarget clone: ${repoDir}`,
    };

    await withApiServer(issue, async (baseUrl, calls) => {
      const result = await runChild(process.execPath, [runbookPath], {
        cwd: path.resolve(process.cwd(), ".."),
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "test-token",
          PAPERCLIP_ISSUE_ID: String(issue.id),
          PAPERCLIP_RUN_ID: "run-skill-inventory",
          SKILL_INVENTORY_ROOT: repoDir,
          SKILL_CURATOR_COMMAND: "python3 scripts/skill_curator.py",
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
        repairedCount: 1,
        afterSummary: {
          total: 2,
          pass: 2,
          fail: 0,
          kw_missing: 0,
        },
        providerTokensSpent: 0,
      });
      const repairedSkill = fs.readFileSync(
        path.join(repoDir, ".agents/skills/repo-opportunity-analyst/SKILL.md"),
        "utf8",
      );
      expect(repairedSkill).toContain("keywords: repo, opportunity, analyst");
      expect(fs.existsSync(path.join(repoDir, "reports/skills/latest.md"))).toBe(true);
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
});
