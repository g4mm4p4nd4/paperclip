#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";
const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || "";
const issueId = process.env.PAPERCLIP_ISSUE_ID || process.env.PAPERCLIP_TASK_ID || "";
const writeDocs = process.env.DISPATCH_POLLER_WRITE_DOCS !== "0";

function fail(message, exitCode = 1) {
  const result = {
    summary: `Dispatch poller process failed: ${message}`,
    error: message,
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

function readText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function normalizeApprovalsResponse(response) {
  if (Array.isArray(response)) return response;
  if (response && typeof response === "object" && Array.isArray(response.approvals)) {
    return response.approvals;
  }
  return [];
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
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

function localBranchExists(cwd, branch) {
  if (!branch) return false;
  return runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).ok;
}

function remoteBranchExists(cwd, branch) {
  if (!branch) return false;
  const normalized = branch.startsWith("origin/") ? branch : `origin/${branch}`;
  return runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/${normalized}`], { allowFailure: true }).ok;
}

function maybeRev(cwd, ref) {
  if (!ref) return null;
  const result = runGit(cwd, ["rev-parse", "--verify", ref], { allowFailure: true });
  return result.ok ? result.stdout : null;
}

function aheadBehind(cwd, leftRef, rightRef) {
  if (!leftRef || !rightRef) return { ahead: null, behind: null };
  const result = runGit(cwd, ["rev-list", "--left-right", "--count", `${rightRef}...${leftRef}`], { allowFailure: true });
  if (!result.ok) return { ahead: null, behind: null };
  const [behind, ahead] = result.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

function selectApprovalContract(approvals) {
  if (!Array.isArray(approvals)) return null;
  for (const approval of approvals) {
    const payload = approval?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const dispatchHash = readText(payload.dispatch_hash) ?? readText(payload.dispatchHash);
    const selectionHash = readText(payload.selection_snapshot_hash) ?? readText(payload.selectionSnapshotHash);
    if (!dispatchHash || !selectionHash) continue;
    return {
      source: "approval",
      approvalId: readText(approval.id),
      dispatchHash,
      selectionSnapshotHash: selectionHash,
      selectedRepoDossierHash:
        readText(payload.selected_repo_dossier_hash) ?? readText(payload.selectedRepoDossierHash),
    };
  }
  return null;
}

function issueContractSource(contract) {
  const dispatchHash = readText(contract.dispatch_hash) ?? readText(contract.dispatchHash);
  const selectionHash = readText(contract.selection_snapshot_hash) ?? readText(contract.selectionSnapshotHash);
  if (!dispatchHash || !selectionHash) {
    return {
      source: "missing",
      dispatchHash: null,
      selectionSnapshotHash: null,
      selectedRepoDossierHash: null,
    };
  }
  return {
    source: "issue_contract",
    dispatchHash,
    selectionSnapshotHash: selectionHash,
    selectedRepoDossierHash:
      readText(contract.selected_repo_dossier_hash) ?? readText(contract.selectedRepoDossierHash),
  };
}

function nextIterationPath(targetClone, runId) {
  const dir = path.join(targetClone, "docs", "dispatch-poller", runId);
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

function renderReport(input) {
  const {
    issue,
    contract,
    canonical,
    invariant,
    branchTelemetry,
    hashChecks,
    pollerState,
    statusAction,
  } = input;
  return [
    `# Dispatch Poller ${contract.run_id || process.env.PAPERCLIP_RUN_ID || "unknown"}`,
    "",
    `Issue: ${issue.identifier || issue.id}`,
    `Poller state: ${pollerState}`,
    `Issue action: ${statusAction}`,
    "",
    "## Canonical Source",
    "",
    `- source: ${canonical.source}`,
    `- dispatch_hash: ${canonical.dispatchHash || "missing"}`,
    `- selection_snapshot_hash: ${canonical.selectionSnapshotHash || "missing"}`,
    `- selected_repo_dossier_hash: ${canonical.selectedRepoDossierHash || "missing"}`,
    "",
    "## dispatch_parity_invariant",
    "",
    "```json",
    JSON.stringify(invariant, null, 2),
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
  ].join("\n");
}

async function main() {
  requireEnv();

  const issue = normalizeIssueResponse(await apiJson("GET", `/api/issues/${issueId}`));
  const approvals = normalizeApprovalsResponse(
    await apiJson("GET", `/api/issues/${issueId}/approvals`).catch(() => []),
  );
  const description = issue.description || "";
  const contract = extractContract(description);
  const approvalCanonical = selectApprovalContract(approvals);
  const issueCanonical = issueContractSource(contract);
  const canonical = approvalCanonical ?? issueCanonical;
  const runId = readText(contract.run_id) ?? process.env.DISPATCH_RUN_ID ?? process.env.PAPERCLIP_RUN_ID ?? "unknown";
  const dispatchPath =
    readText(contract.source_dispatch_path) ??
    extractLine(description, "Dispatch file");
  const targetClone =
    process.env.DISPATCH_POLLER_TARGET_CLONE ??
    extractLine(description, "Target clone") ??
    readText(contract.target_repo_clone_path_hint);
  const expectedBranch =
    readText(contract.suggested_branch_name) ??
    extractLine(description, "Expected run branch");
  const targetRepoRef = readText(contract.target_repo_ref) ?? "main";
  const selectedRepoDossierPath = readText(contract.selected_repo_dossier_path);
  const selectionSnapshotPath = readText(contract.selection_snapshot_path);

  if (!dispatchPath) throw new Error("dispatch path missing from issue contract");
  if (!targetClone) throw new Error("target clone missing from issue contract");

  const dispatch = readJson(dispatchPath);
  const observedDispatchHash = sha256File(dispatchPath);
  const embeddedSelectionHash = readText(dispatch.selection_snapshot_hash);
  const embeddedDossierHash =
    readText(dispatch.selected_repo_dossier_hash) ??
    readText(dispatch.dossier_contract?.selected_repo_dossier?.dossier_hash);
  const rawSelectionHash = selectionSnapshotPath && existsSync(selectionSnapshotPath)
    ? sha256File(selectionSnapshotPath)
    : null;
  const rawDossierHash = selectedRepoDossierPath && existsSync(selectedRepoDossierPath)
    ? sha256File(selectedRepoDossierPath)
    : null;

  const hashChecks = [
    {
      name: "canonical dispatch hash vs source dispatch bytes",
      expected: canonical.dispatchHash,
      observed: observedDispatchHash,
      match: canonical.dispatchHash === observedDispatchHash,
    },
    {
      name: "embedded selection_snapshot_hash vs canonical",
      expected: canonical.selectionSnapshotHash,
      observed: embeddedSelectionHash,
      match: canonical.selectionSnapshotHash === embeddedSelectionHash,
    },
    {
      name: "embedded selected_repo_dossier_hash vs canonical",
      expected: canonical.selectedRepoDossierHash,
      observed: embeddedDossierHash,
      match: !canonical.selectedRepoDossierHash || canonical.selectedRepoDossierHash === embeddedDossierHash,
    },
    {
      name: "selection_snapshot file bytes vs canonical",
      expected: canonical.selectionSnapshotHash,
      observed: rawSelectionHash,
      match: !rawSelectionHash || rawSelectionHash === canonical.selectionSnapshotHash,
    },
    {
      name: "selected_repo_dossier file bytes vs canonical",
      expected: canonical.selectedRepoDossierHash,
      observed: rawDossierHash,
      match: !rawDossierHash || !canonical.selectedRepoDossierHash || rawDossierHash === canonical.selectedRepoDossierHash,
    },
  ];

  const missingCanonical = !canonical.dispatchHash || !canonical.selectionSnapshotHash;
  const canonicalLinkageMismatch = hashChecks
    .filter((check) => check.name.startsWith("embedded"))
    .some((check) => !check.match);
  const artifactDrift = Boolean(canonical.dispatchHash && canonical.dispatchHash !== observedDispatchHash);
  const pollerState = missingCanonical
    ? "missing contract source"
    : canonicalLinkageMismatch
      ? "contract mismatch"
      : artifactDrift
        ? "artifact drift"
        : "artifact drift";
  const parityStatus = missingCanonical
    ? "missing_contract_source"
    : canonicalLinkageMismatch
      ? "contract_mismatch"
      : artifactDrift
        ? "artifact_drift"
        : "match";

  const observedBranch = runGit(targetClone, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  const observedHeadSha = runGit(targetClone, ["rev-parse", "HEAD"]).stdout;
  const originRef = `origin/${targetRepoRef}`;
  const originSha = maybeRev(targetClone, originRef);
  const counts = aheadBehind(targetClone, observedBranch, originRef);
  const branchTelemetry = {
    run_id: runId,
    workspace_id: null,
    workspace_source: process.env.PAPERCLIP_WORKSPACE_SOURCE || "project_primary",
    branch_owner: "unknown",
    expected_branch: expectedBranch,
    expected_branch_local_exists: localBranchExists(targetClone, expectedBranch),
    expected_branch_origin_exists: remoteBranchExists(targetClone, expectedBranch),
    observed_branch: observedBranch,
    observed_head_ref: observedBranch,
    observed_head_sha: observedHeadSha,
    origin_main_sha: targetRepoRef === "main" ? originSha : null,
    origin_target_sha: originSha,
    main_vs_origin_ahead: targetRepoRef === "main" ? counts.ahead : null,
    main_vs_origin_behind: targetRepoRef === "main" ? counts.behind : null,
    target_vs_origin_ahead: counts.ahead,
    target_vs_origin_behind: counts.behind,
    merge_policy: "fast",
    shared_workspace_warning: true,
  };
  const invariant = {
    run_id: runId,
    dispatch_path: dispatchPath,
    canonical_hash: canonical.dispatchHash,
    observed_hash: observedDispatchHash,
    parity_status: parityStatus,
    poller_state: pollerState,
  };

  const statusAction = pollerState === "contract mismatch" || pollerState === "missing contract source"
    ? "blocked"
    : "done";
  const report = renderReport({
    issue,
    contract: { ...contract, run_id: runId },
    canonical,
    invariant,
    branchTelemetry,
    hashChecks,
    pollerState,
    statusAction,
  });

  let reportPath = null;
  let payloadPath = null;
  if (writeDocs) {
    reportPath = nextIterationPath(targetClone, runId);
    payloadPath = path.join(targetClone, "docs", `poller_parity_payload_${issue.identifier || issue.id}.json`);
    mkdirSync(path.dirname(payloadPath), { recursive: true });
    writeFileSync(reportPath, report);
    writeFileSync(payloadPath, `${JSON.stringify({
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      generatedAt: new Date().toISOString(),
      invariant,
      branchTelemetry,
      hashChecks,
      canonicalSource: canonical,
    }, null, 2)}\n`);
  }

  await apiJson("PATCH", `/api/issues/${issueId}`, { status: statusAction });

  const summary = [
    `Dispatch Poller process complete for ${issue.identifier || issue.id} (${runId}).`,
    `- Poller state: ${pollerState}; parity_status=${parityStatus}; issue_status=${statusAction}`,
    `- Canonical source: ${canonical.source}${canonical.approvalId ? ` (${canonical.approvalId})` : ""}`,
    `- dispatch_parity_invariant: canonical=${canonical.dispatchHash || "missing"} observed=${observedDispatchHash}`,
    `- Branch telemetry: observed=${observedBranch}@${observedHeadSha.slice(0, 12)} expected=${expectedBranch || "missing"} local=${branchTelemetry.expected_branch_local_exists} origin=${branchTelemetry.expected_branch_origin_exists}`,
    ...(reportPath ? [`- Report: ${reportPath}`, `- Payload: ${payloadPath}`] : []),
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");

  const result = {
    summary,
    runId,
    issueId,
    identifier: issue.identifier ?? null,
    pollerState,
    parityStatus,
    statusAction,
    invariant,
    branchTelemetry,
    hashChecks,
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
