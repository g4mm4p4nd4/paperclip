#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";
const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || "";
const issueId = process.env.PAPERCLIP_ISSUE_ID || process.env.PAPERCLIP_TASK_ID || "";
const writeKeywords = process.env.SKILL_INVENTORY_WRITE_KEYWORDS !== "0";
const updateIssue = process.env.SKILL_INVENTORY_UPDATE_ISSUE !== "0";
const curatorCommand = process.env.SKILL_CURATOR_COMMAND || "python3 scripts/skill_curator.py";
const skillRootRel = process.env.SKILL_INVENTORY_SKILL_ROOT || ".agents/skills";
const reportPathRel = process.env.SKILL_INVENTORY_REPORT_PATH || "reports/skills/latest.md";

const STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "also",
  "and",
  "any",
  "app",
  "apps",
  "are",
  "audit",
  "based",
  "before",
  "can",
  "create",
  "creating",
  "docs",
  "does",
  "for",
  "from",
  "has",
  "help",
  "into",
  "its",
  "keep",
  "make",
  "marketing",
  "needs",
  "not",
  "only",
  "project",
  "should",
  "that",
  "the",
  "their",
  "this",
  "through",
  "use",
  "user",
  "using",
  "wants",
  "when",
  "with",
  "work",
  "workflow",
]);

function readText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safePayloadName(issue) {
  return String(issue?.identifier || issue?.id || "issue").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function issueMarkdownLink(issue) {
  const identifier = readText(issue?.identifier);
  if (!identifier) return issue?.id || "issue";
  const prefix = identifier.split("-")[0] || identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

function tailText(value, maxChars = 12_000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function fail(message, exitCode = 1) {
  const result = {
    summary: `Skill inventory process failed before issue update: ${message}`,
    error: message,
    providerTokensSpent: 0,
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  process.exitCode = exitCode;
}

function defaultTargetRoot() {
  return path.resolve(process.cwd(), "..", "portfolio-os");
}

function extractLine(description, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(description || "").match(new RegExp(`^${escaped}:\\s*(.+)$`, "mi"));
  return readText(match?.[1]);
}

function normalizeIssueResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("issue API returned an invalid response");
  }
  const nestedIssue = response.issue;
  if (nestedIssue && typeof nestedIssue === "object" && !Array.isArray(nestedIssue)) {
    return nestedIssue;
  }
  return response;
}

async function apiJson(method, route, body) {
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(process.env.PAPERCLIP_RUN_ID ? { "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${route} failed with HTTP ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function runShell(cwd, command) {
  const startedAt = Date.now();
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command,
    cwd,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseCuratorSummary(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gitStatus(cwd, pathspecs = []) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...pathspecs], {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return {
      ok: false,
      paths: [],
      error: (result.stderr || result.stdout || `git status exited ${result.status}`).trim(),
    };
  }
  return {
    ok: true,
    paths: result.stdout.split(/\r?\n/).filter(Boolean),
    error: null,
  };
}

function splitFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const marker = text.indexOf("---", 3);
  if (marker < 0) return null;
  return {
    frontmatter: text.slice(3, marker),
    body: text.slice(marker + 3),
    end: marker,
  };
}

function unquoteYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function extractDescription(frontmatter) {
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  return match ? unquoteYamlScalar(match[1]) : "";
}

function extractTriggerText(body) {
  const match = String(body || "").match(/^##\s*Trigger\b([\s\S]*?)(?=\n##\s|(?![\s\S]))/m);
  return match?.[1] ?? "";
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .split(/[^a-z0-9+.#-]+/g)
    .map((token) => token.replace(/^[.#-]+|[.#-]+$/g, ""))
    .filter((token) => token.length >= 3 || ["ai", "3d", "qa", "ui", "ux", "js"].includes(token))
    .map((token) => token.replace(/[.#]+/g, ""))
    .filter((token) => token && !STOPWORDS.has(token));
}

function deriveKeywords(slug, description, triggerText) {
  const tokens = [
    ...slug.split(/[^a-zA-Z0-9]+/g),
    ...tokenize(description),
    ...tokenize(triggerText),
  ];
  const seen = new Set();
  const keywords = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (!normalized || STOPWORDS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    keywords.push(normalized);
    if (keywords.length >= 10) break;
  }
  return keywords.length > 0 ? keywords : [slug.toLowerCase()];
}

function insertKeywords(text, keywords) {
  const split = splitFrontmatter(text);
  if (!split) return null;
  if (/^keywords:/m.test(split.frontmatter)) return text;
  const line = `keywords: ${keywords.join(", ")}\n`;
  const descriptionMatch = split.frontmatter.match(/^description:.*(?:\r?\n|$)/m);
  let frontmatter;
  if (descriptionMatch?.index !== undefined) {
    const insertion = descriptionMatch.index + descriptionMatch[0].length;
    frontmatter = `${split.frontmatter.slice(0, insertion)}${line}${split.frontmatter.slice(insertion)}`;
  } else {
    frontmatter = `${split.frontmatter.replace(/\s*$/, "\n")}${line}`;
  }
  return `---${frontmatter}---${split.body}`;
}

function repairMissingKeywords(targetRoot) {
  const skillRoot = path.join(targetRoot, skillRootRel);
  if (!existsSync(skillRoot)) throw new Error(`skill root does not exist: ${skillRoot}`);
  const repaired = [];
  const skipped = [];
  for (const entry of readdirSync(skillRoot).sort()) {
    const skillPath = path.join(skillRoot, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const text = readFileSync(skillPath, "utf8");
    const split = splitFrontmatter(text);
    if (!split) {
      skipped.push({ name: entry, reason: "missing_frontmatter" });
      continue;
    }
    if (/^keywords:/m.test(split.frontmatter)) continue;
    const description = extractDescription(split.frontmatter);
    const triggerText = extractTriggerText(split.body);
    const keywords = deriveKeywords(entry, description, triggerText);
    const updated = insertKeywords(text, keywords);
    if (!updated || updated === text) continue;
    writeFileSync(skillPath, updated);
    repaired.push({
      name: entry,
      path: skillPath,
      keywords,
    });
  }
  return { repaired, skipped };
}

function statusComment(input) {
  const issueRef = issueMarkdownLink(input.issue);
  if (input.statusAction === "done") {
    return [
      "## Skill Inventory Complete",
      "",
      `${issueRef} was completed by the deterministic skill inventory runbook.`,
      "",
      `- Repaired missing \`keywords:\` frontmatter: ${input.repaired.length} skills`,
      `- Validator pass / fail: ${input.afterSummary?.pass ?? "unknown"} / ${input.afterSummary?.fail ?? "unknown"}`,
      `- Report: ${input.reportPath}`,
      "- Provider tokens: 0 (process adapter deterministic runbook).",
    ].join("\n");
  }
  return [
    "## Skill Inventory Blocked",
    "",
    `${issueRef} could not be completed by the deterministic skill inventory runbook.`,
    "",
    `- Repaired missing \`keywords:\` frontmatter: ${input.repaired.length} skills`,
    `- Validator exit: ${input.afterRun.exitCode}`,
    `- Validator pass / fail: ${input.afterSummary?.pass ?? "unknown"} / ${input.afterSummary?.fail ?? "unknown"}`,
    `- Report: ${input.reportPath}`,
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");
}

async function main() {
  if (updateIssue && !apiKey) throw new Error("PAPERCLIP_API_KEY is required");
  if (updateIssue && !issueId) throw new Error("PAPERCLIP_ISSUE_ID or PAPERCLIP_TASK_ID is required");

  const issue = updateIssue ? normalizeIssueResponse(await apiJson("GET", `/api/issues/${issueId}`)) : {};
  const targetRoot = path.resolve(
    process.env.SKILL_INVENTORY_ROOT ||
    extractLine(issue.description, "Target clone") ||
    defaultTargetRoot(),
  );
  if (!existsSync(targetRoot)) throw new Error(`target root does not exist: ${targetRoot}`);

  const beforeStatus = gitStatus(targetRoot, [skillRootRel, reportPathRel]);
  const beforeRun = runShell(targetRoot, curatorCommand);
  const beforeSummary = parseCuratorSummary(beforeRun.stdout);
  const repair = writeKeywords ? repairMissingKeywords(targetRoot) : { repaired: [], skipped: [] };
  const afterRun = runShell(targetRoot, curatorCommand);
  const afterSummary = parseCuratorSummary(afterRun.stdout);
  const afterStatus = gitStatus(targetRoot, [skillRootRel, reportPathRel]);
  const reportPath = path.join(targetRoot, reportPathRel);
  const statusAction = afterRun.exitCode === 0 ? "done" : "blocked";
  const comment = statusComment({
    issue,
    statusAction,
    repaired: repair.repaired,
    afterRun,
    afterSummary,
    reportPath,
  });

  if (updateIssue) {
    await apiJson("PATCH", `/api/issues/${issueId}`, { status: statusAction, comment });
  }

  const summary = [
    `Skill inventory process ${statusAction === "done" ? "complete" : "blocked"} for ${issue.identifier || issueId || "local run"}.`,
    `- Repaired missing keywords: ${repair.repaired.length}`,
    `- Validator before: exit ${beforeRun.exitCode}${beforeSummary ? `, pass/fail ${beforeSummary.pass}/${beforeSummary.fail}` : ""}`,
    `- Validator after: exit ${afterRun.exitCode}${afterSummary ? `, pass/fail ${afterSummary.pass}/${afterSummary.fail}` : ""}`,
    `- Report: ${reportPath}`,
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");

  const result = {
    summary,
    issueId: issue.id ?? (issueId || null),
    identifier: issue.identifier ?? null,
    targetRoot,
    skillRoot: path.join(targetRoot, skillRootRel),
    reportPath,
    statusAction,
    repairedCount: repair.repaired.length,
    repairedSkills: repair.repaired.map((entry) => ({
      name: entry.name,
      keywords: entry.keywords,
    })),
    skipped: repair.skipped,
    beforeSummary,
    afterSummary,
    beforeRun: {
      command: beforeRun.command,
      exitCode: beforeRun.exitCode,
      durationMs: beforeRun.durationMs,
      stdoutTail: tailText(beforeRun.stdout, 4000),
      stderrTail: tailText(beforeRun.stderr, 4000),
    },
    afterRun: {
      command: afterRun.command,
      exitCode: afterRun.exitCode,
      durationMs: afterRun.durationMs,
      stdoutTail: tailText(afterRun.stdout, 4000),
      stderrTail: tailText(afterRun.stderr, 4000),
    },
    gitStatus: {
      before: beforeStatus,
      after: afterStatus,
    },
    providerTokensSpent: 0,
    payloadName: safePayloadName(issue),
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  if (statusAction === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
