#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";
const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || "";
const issueId = process.env.PAPERCLIP_ISSUE_ID || process.env.PAPERCLIP_TASK_ID || "";
const writeDocs = process.env.RELEASE_GATE_WRITE_DOCS !== "0";
const releaseGateCommand = process.env.RELEASE_GATE_COMMAND || "npm run release:gate";
const requireSourceHashMatch = process.env.RELEASE_GATE_REQUIRE_SOURCE_HASH_MATCH === "1";

function readText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tailText(value, maxChars = 12_000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function fail(message, exitCode = 1) {
  const result = {
    summary: `Release gate process failed before issue update: ${message}`,
    error: message,
    providerTokensSpent: 0,
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  process.exitCode = exitCode;
}

function requireEnv() {
  if (!apiKey) throw new Error("PAPERCLIP_API_KEY is required");
  if (!issueId) throw new Error("PAPERCLIP_ISSUE_ID or PAPERCLIP_TASK_ID is required");
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

function normalizeApprovalResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const nested = response.approval;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  return response;
}

function extractContract(description) {
  const match = String(description || "").match(/## Portfolio Dispatch Contract\s*```json\s*([\s\S]*?)```/i);
  if (!match?.[1]) return {};
  const parsed = JSON.parse(match[1]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function extractLine(description, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(description || "").match(new RegExp(`^${escaped}:\\s*(.+)$`, "mi"));
  return readText(match?.[1]);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runGit(cwd, args, opts = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (opts.allowFailure) {
    return { ok: result.status === 0, stdout, stderr, status: result.status ?? 1 };
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || stdout || `exit ${result.status}`}`);
  }
  return { ok: true, stdout, stderr, status: 0 };
}

function maybeGit(cwd, args) {
  const result = runGit(cwd, args, { allowFailure: true });
  return result.ok ? result.stdout : null;
}

function aheadBehind(cwd, leftRef, rightRef) {
  if (!leftRef || !rightRef) return { ahead: null, behind: null };
  const result = runGit(cwd, ["rev-list", "--left-right", "--count", `${leftRef}...${rightRef}`], {
    allowFailure: true,
  });
  if (!result.ok) return { ahead: null, behind: null };
  const [aheadRaw, behindRaw] = result.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    ahead: Number.isFinite(aheadRaw) ? aheadRaw : null,
    behind: Number.isFinite(behindRaw) ? behindRaw : null,
  };
}

function runShell(cwd, command, env = {}) {
  const startedAt = Date.now();
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd,
    env: { ...process.env, ...env },
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

function nextIterationPath(targetClone, runId) {
  const dir = path.join(targetClone, "docs", "release-gate-reconciler", runId);
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(dir)
    ? readdirSync(dir)
      .map((name) => /^iteration-(\d+)\.md$/.exec(name)?.[1])
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite)
    : [];
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return path.join(dir, `iteration-${next}.md`);
}

function safePayloadName(issue) {
  return String(issue.identifier || issue.id || "issue").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function issueMarkdownLink(issue) {
  const identifier = readText(issue.identifier);
  if (!identifier) return issue.id || "issue";
  const prefix = identifier.split("-")[0] || identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

function approvalState(approvalId, approval) {
  if (!approvalId) {
    return { approvalId: null, status: "not_required", ok: true, source: "contract" };
  }
  if (!approval) {
    return { approvalId, status: "unverified", ok: false, source: "api" };
  }
  const status = readText(approval.status) ?? readText(approval.state) ?? "unknown";
  return {
    approvalId,
    status,
    ok: status.toLowerCase() === "approved",
    source: "api",
    approvedAt: readText(approval.approvedAt) ?? readText(approval.resolvedAt) ?? null,
  };
}

function buildBranchTelemetry(targetClone, releaseTargetBranch) {
  const fetch = runGit(targetClone, ["fetch", "origin", releaseTargetBranch], { allowFailure: true });
  const currentBranch = maybeGit(targetClone, ["branch", "--show-current"]);
  const headSha = maybeGit(targetClone, ["rev-parse", "HEAD"]);
  const originSha = maybeGit(targetClone, ["rev-parse", "--verify", `origin/${releaseTargetBranch}`]);
  const targetSha = maybeGit(targetClone, ["rev-parse", "--verify", releaseTargetBranch]);
  const dirty = runGit(targetClone, ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  return {
    fetchOriginTargetOk: fetch.ok,
    fetchOriginTargetError: fetch.ok ? null : fetch.stderr || fetch.stdout || `exit ${fetch.status}`,
    releaseTargetBranch,
    currentBranch,
    headSha,
    originTargetSha: originSha,
    localTargetSha: targetSha,
    headVsOriginTarget: aheadBehind(targetClone, "HEAD", `origin/${releaseTargetBranch}`),
    targetVsOriginTarget: aheadBehind(targetClone, releaseTargetBranch, `origin/${releaseTargetBranch}`),
    dirtyPaths: dirty.ok ? dirty.stdout.split(/\r?\n/).filter(Boolean) : [],
  };
}

function renderReport(input) {
  const {
    issue,
    runId,
    targetClone,
    releaseTargetBranch,
    sourceDispatchPath,
    releaseGate,
    statusAction,
    approval,
    hashChecks,
    branchTelemetry,
  } = input;
  return [
    `# Release Gate Reconciler ${runId}`,
    "",
    `Issue: ${issue.identifier || issue.id}`,
    `Issue action: ${statusAction}`,
    `Target clone: ${targetClone}`,
    `Release target branch: ${releaseTargetBranch}`,
    `Source dispatch: ${sourceDispatchPath || "missing"}`,
    "",
    "## Approval",
    "",
    "```json",
    JSON.stringify(approval, null, 2),
    "```",
    "",
    "## Release Gate Command",
    "",
    "```json",
    JSON.stringify({
      command: releaseGate.command,
      cwd: releaseGate.cwd,
      exitCode: releaseGate.exitCode,
      signal: releaseGate.signal,
      durationMs: releaseGate.durationMs,
    }, null, 2),
    "```",
    "",
    "## Branch Telemetry",
    "",
    "```json",
    JSON.stringify(branchTelemetry, null, 2),
    "```",
    "",
    "## Hash Checks",
    "",
    "| Check | Expected | Observed | Result |",
    "| --- | --- | --- | --- |",
    ...hashChecks.map((check) =>
      `| ${check.name} | ${check.expected || "missing"} | ${check.observed || "missing"} | ${check.match ? "PASS" : "FAIL"} |`
    ),
    "",
    "## Stdout Tail",
    "",
    "```text",
    tailText(releaseGate.stdout, 12_000),
    "```",
    "",
    "## Stderr Tail",
    "",
    "```text",
    tailText(releaseGate.stderr, 12_000),
    "```",
    "",
  ].join("\n");
}

function statusComment(input) {
  const {
    issue,
    runId,
    statusAction,
    releaseGate,
    approval,
    hashChecks,
    reportPath,
    payloadPath,
  } = input;
  const failedChecks = hashChecks.filter((check) => !check.match);
  const issueRef = issueMarkdownLink(issue);
  if (statusAction === "done") {
    return [
      "## Release Gate Complete",
      "",
      `${issueRef} passed deterministic release reconciliation for run ${runId}.`,
      "",
      `- Release gate: \`${releaseGate.command}\` exited 0 in ${releaseGate.durationMs}ms`,
      `- Approval: ${approval.status}${approval.approvalId ? ` (${approval.approvalId})` : ""}`,
      "- Dispatch/hash checks: passed",
      `- Report: ${reportPath || "not written"}`,
      `- Payload: ${payloadPath || "not written"}`,
      "- Provider tokens: 0 (process adapter deterministic runbook).",
    ].join("\n");
  }
  return [
    "## Release Gate Blocked",
    "",
    `${issueRef} was moved to blocked by deterministic release reconciliation for run ${runId}.`,
    "",
    `- Release gate exit: ${releaseGate.exitCode}`,
    `- Approval: ${approval.status}${approval.approvalId ? ` (${approval.approvalId})` : ""}`,
    `- Failed checks: ${failedChecks.length > 0 ? failedChecks.map((check) => check.name).join(", ") : "release gate command"}`,
    `- Report: ${reportPath || "not written"}`,
    `- Payload: ${payloadPath || "not written"}`,
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");
}

async function main() {
  requireEnv();

  const issue = normalizeIssueResponse(await apiJson("GET", `/api/issues/${issueId}`));
  const description = issue.description || "";
  const contract = extractContract(description);
  const runId = readText(contract.run_id) ?? process.env.DISPATCH_RUN_ID ?? process.env.PAPERCLIP_RUN_ID ?? "unknown";
  const targetClone =
    process.env.RELEASE_GATE_TARGET_CLONE ??
    extractLine(description, "Target clone") ??
    readText(contract.target_repo_clone_path_hint);
  const releaseTargetBranch =
    process.env.RELEASE_TARGET_BRANCH ??
    extractLine(description, "Release target branch") ??
    readText(contract.target_repo_ref) ??
    "main";
  const sourceDispatchPath =
    readText(contract.source_dispatch_path) ??
    extractLine(description, "Dispatch file");
  const approvalId =
    readText(contract.approval_id) ??
    readText(contract.approvalId) ??
    extractLine(description, "launch_execution approval");

  if (!targetClone) throw new Error("target clone missing from issue contract");
  if (!existsSync(targetClone)) throw new Error(`target clone does not exist: ${targetClone}`);

  const approval = approvalState(
    approvalId,
    approvalId
      ? await apiJson("GET", `/api/approvals/${approvalId}`).then(normalizeApprovalResponse).catch(() => null)
      : null,
  );

  const expectedDispatchHash = readText(contract.dispatch_hash) ?? readText(contract.dispatchHash);
  const observedDispatchHash = sourceDispatchPath && existsSync(sourceDispatchPath)
    ? sha256File(sourceDispatchPath)
    : null;
  const selectedRepoDossierPath = readText(contract.selected_repo_dossier_path);
  const expectedDossierHash = readText(contract.selected_repo_dossier_hash);
  const observedDossierHash = selectedRepoDossierPath && existsSync(selectedRepoDossierPath)
    ? sha256File(selectedRepoDossierPath)
    : null;
  const hashChecks = [
    {
      name: "source dispatch bytes vs contract dispatch_hash",
      expected: expectedDispatchHash,
      observed: observedDispatchHash,
      match: Boolean(expectedDispatchHash && observedDispatchHash && expectedDispatchHash === observedDispatchHash),
      required: requireSourceHashMatch,
    },
    {
      name: "selected repo dossier bytes vs contract selected_repo_dossier_hash",
      expected: expectedDossierHash,
      observed: observedDossierHash,
      match: !expectedDossierHash || Boolean(observedDossierHash && expectedDossierHash === observedDossierHash),
      required: requireSourceHashMatch && Boolean(expectedDossierHash),
    },
  ];

  const branchTelemetryBefore = buildBranchTelemetry(targetClone, releaseTargetBranch);
  const releaseGate = runShell(targetClone, releaseGateCommand, {
    RELEASE_TARGET_BRANCH: releaseTargetBranch,
  });
  const branchTelemetryAfter = buildBranchTelemetry(targetClone, releaseTargetBranch);
  const branchTelemetry = {
    before: branchTelemetryBefore,
    after: branchTelemetryAfter,
  };
  const requiredHashChecksPass = hashChecks.every((check) => !check.required || check.match);
  const releaseGatePassed = releaseGate.exitCode === 0;
  const statusAction = releaseGatePassed && requiredHashChecksPass && approval.ok ? "done" : "blocked";

  let reportPath = null;
  let payloadPath = null;
  if (writeDocs) {
    reportPath = nextIterationPath(targetClone, runId);
    payloadPath = path.join(targetClone, "docs", `release_gate_payload_${safePayloadName(issue)}.json`);
    mkdirSync(path.dirname(payloadPath), { recursive: true });
    const report = renderReport({
      issue,
      runId,
      targetClone,
      releaseTargetBranch,
      sourceDispatchPath,
      releaseGate,
      statusAction,
      approval,
      hashChecks,
      branchTelemetry,
    });
    writeFileSync(reportPath, report);
    writeFileSync(payloadPath, `${JSON.stringify({
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      generatedAt: new Date().toISOString(),
      runId,
      targetClone,
      releaseTargetBranch,
      statusAction,
      approval,
      hashChecks,
      branchTelemetry,
      releaseGate: {
        command: releaseGate.command,
        cwd: releaseGate.cwd,
        exitCode: releaseGate.exitCode,
        signal: releaseGate.signal,
        durationMs: releaseGate.durationMs,
      },
      providerTokensSpent: 0,
    }, null, 2)}\n`);
  }

  const comment = statusComment({
    issue,
    runId,
    statusAction,
    releaseGate,
    approval,
    hashChecks,
    reportPath,
    payloadPath,
  });
  await apiJson("PATCH", `/api/issues/${issueId}`, { status: statusAction, comment });

  const summary = [
    `Release gate process ${statusAction === "done" ? "complete" : "blocked"} for ${issue.identifier || issue.id} (${runId}).`,
    `- Release gate: ${releaseGate.command} exit ${releaseGate.exitCode}`,
    `- Approval: ${approval.status}${approval.approvalId ? ` (${approval.approvalId})` : ""}`,
    `- Required hash checks: ${requiredHashChecksPass ? "passed" : "failed"}`,
    ...(reportPath ? [`- Report: ${reportPath}`, `- Payload: ${payloadPath}`] : []),
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");

  const result = {
    summary,
    runId,
    issueId,
    identifier: issue.identifier ?? null,
    statusAction,
    releaseGateStatus: releaseGatePassed ? "passed" : "failed",
    approval,
    hashChecks,
    branchTelemetry,
    reportPath,
    payloadPath,
    providerTokensSpent: 0,
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  if (statusAction === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
