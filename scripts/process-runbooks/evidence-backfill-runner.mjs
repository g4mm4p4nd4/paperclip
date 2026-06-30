#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";
const DEFAULT_RUN_ID = "20260503T193357Z";
const DEFAULT_PORTFOLIO_OS_DIR = "/Users/mnm/Documents/Github/portfolio-os";
const DEFAULT_DISPATCH_PATH = `${DEFAULT_PORTFOLIO_OS_DIR}/data/dispatch/outbox/dispatch_${DEFAULT_RUN_ID}.json`;
const ROLE_KEYS = [
  "launch_target",
  "execution_target",
  "execution_candidate",
  "selected_opportunity",
  "business_choice",
  "research_target",
  "ingredient_asset_target",
  "internal_leverage_target",
  "reskin_target",
  "reskin_candidate",
];

const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || "";
const issueId = process.env.PAPERCLIP_ISSUE_ID || process.env.PAPERCLIP_TASK_ID || "";
const portfolioOsDir = process.env.PORTFOLIO_OS_DIR || DEFAULT_PORTFOLIO_OS_DIR;
const runId = process.env.EVIDENCE_RUN_ID || DEFAULT_RUN_ID;
const writeDocs = process.env.EVIDENCE_BACKFILL_WRITE_DOCS !== "0";

function fail(message, exitCode = 1) {
  const result = {
    summary: `Evidence backfill process failed: ${message}`,
    error: message,
    providerTokensSpent: 0,
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  process.exitCode = exitCode;
}

function readText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getPath(value, keys) {
  return keys.reduce((current, key) => toObject(current)[key], value);
}

function stringValue(value, fallback = "") {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function numberValue(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return fallback;
}

function splitPipeList(value) {
  return stringValue(value)
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stableJson(value), "utf8");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function repoShortName(repo) {
  return repo.split("/").at(-1) || repo;
}

function isoTimestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
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
  if (!apiKey) throw new Error("PAPERCLIP_API_KEY is required for Paperclip issue updates");
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

async function loadIssue() {
  if (!issueId || !apiKey) return null;
  return normalizeIssueResponse(await apiJson("GET", `/api/issues/${issueId}`));
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

function collectCandidates(selectionSnapshot) {
  const candidates = [];
  for (const role of ROLE_KEYS) {
    const direct = toObject(selectionSnapshot[role]);
    if (Object.keys(direct).length > 0) candidates.push({ role, candidate: direct });

    const frozen = toObject(getPath(selectionSnapshot, ["frozen_bundle", role]));
    if (Object.keys(frozen).length > 0) candidates.push({ role: `frozen_bundle.${role}`, candidate: frozen });
  }

  const deduped = new Map();
  for (const entry of candidates) {
    const repo = stringValue(entry.candidate.repo);
    const key = `${entry.role}:${repo || JSON.stringify(entry.candidate).slice(0, 120)}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }
  return [...deduped.values()];
}

function findPrimaryTarget(selectionSnapshot, targetRepo) {
  const candidates = collectCandidates(selectionSnapshot);
  const repoMatch = candidates.find((entry) => stringValue(entry.candidate.repo) === targetRepo);
  if (repoMatch) return repoMatch;

  for (const role of ["launch_target", "execution_target", "selected_opportunity", "execution_candidate", "research_target"]) {
    const candidate = toObject(selectionSnapshot[role]);
    if (Object.keys(candidate).length > 0) return { role, candidate };
  }
  throw new Error(`Unable to find primary evidence target for ${targetRepo}.`);
}

function buildPrimaryTargetState(candidate) {
  return {
    evidence_ready: booleanValue(candidate.evidence_ready),
    missing_evidence: stringValue(candidate.missing_evidence),
    commercialization_confidence: numberValue(candidate.commercialization_confidence),
    primary_supporting_evidence_count: numberValue(candidate.primary_supporting_evidence_count),
    shared_supporting_evidence_count: numberValue(candidate.shared_supporting_evidence_count),
    market_signal_count: numberValue(candidate.market_signal_count),
    voc_count: numberValue(candidate.voc_count),
    launch_eligible: booleanValue(candidate.launch_eligible),
    hard_gate_status: stringValue(candidate.hard_gate_status),
    internet_pipes_readiness: stringValue(candidate.internet_pipes_readiness),
    internet_pipes_score: numberValue(candidate.internet_pipes_score),
    internet_pipes_missing_stations: splitPipeList(candidate.internet_pipes_missing_stations),
  };
}

function buildEvidenceSources(candidate) {
  const sources = [];
  const pushSource = (source) => {
    const hasEvidence = source.id || source.summary || source.url || source.urls?.length;
    if (!hasEvidence) return;
    const key = `${source.source_type}:${source.id || ""}:${source.url || ""}:${source.urls?.join(",") || ""}`;
    if (!sources.some((entry) => `${entry.source_type}:${entry.id || ""}:${entry.url || ""}:${entry.urls?.join(",") || ""}` === key)) {
      sources.push(source);
    }
  };

  pushSource({
    source_type: "matched_signal",
    id: stringValue(candidate.matched_signal_id),
    summary: stringValue(candidate.matched_signal_summary),
    url: stringValue(candidate.signal_evidence_url),
  });
  pushSource({
    source_type: "matched_voc",
    id: stringValue(candidate.matched_voc_id),
    summary: stringValue(candidate.matched_voc_summary),
    url: stringValue(candidate.voc_source),
  });
  pushSource({
    source_type: "adjacent_signal",
    id: stringValue(candidate.adjacent_signal_id),
    summary: stringValue(candidate.adjacent_signal_summary),
    url: stringValue(candidate.adjacent_signal_evidence_url),
  });
  pushSource({
    source_type: "adjacent_voc",
    id: stringValue(candidate.adjacent_voc_id),
    summary: stringValue(candidate.adjacent_voc_summary),
    url: stringValue(candidate.adjacent_voc_source),
  });

  const proofLinks = splitPipeList(candidate.proof_of_progress_links);
  if (proofLinks.length > 0) pushSource({ source_type: "proof_of_progress", urls: proofLinks });
  return sources;
}

function buildInventory(selectionSnapshot, targetRepo, primaryRole) {
  const byRepo = new Map();
  for (const { role, candidate } of collectCandidates(selectionSnapshot)) {
    const repo = stringValue(candidate.repo);
    if (!repo) continue;

    const evidenceReady = booleanValue(candidate.evidence_ready);
    const missingEvidence = stringValue(candidate.missing_evidence);
    const isPrimaryRepo = repo === targetRepo;
    const isPrimary = isPrimaryRepo && role === primaryRole;
    const status = isPrimary
      ? evidenceReady && !missingEvidence ? "complete" : "missing_evidence"
      : evidenceReady && !missingEvidence ? "complete" : "not_blocking_run";

    const entry = {
      repo,
      role,
      evidence_ready: evidenceReady,
      focus_lane: stringValue(candidate.focus_lane),
      status,
      missing_evidence: missingEvidence,
      internet_pipes_missing_stations: splitPipeList(candidate.internet_pipes_missing_stations),
      action_taken: isPrimary
        ? evidenceReady && !missingEvidence
          ? "verified primary dispatch target has no blocking evidence gaps"
          : "primary dispatch target still has blocking evidence gaps"
        : missingEvidence
          ? "noted as non-primary bundle evidence gap; not blocking this dispatch run"
          : "verified non-primary bundle entry",
    };

    if (isPrimaryRepo) {
      if (isPrimary) byRepo.set(repo, entry);
      continue;
    }

    const existing = byRepo.get(repo);
    if (!existing) {
      byRepo.set(repo, entry);
      continue;
    }
    const existingMissing = existing.missing_evidence ? existing.missing_evidence.split(";").length : 0;
    const currentMissing = entry.missing_evidence ? entry.missing_evidence.split(";").length : 0;
    if (currentMissing > existingMissing) byRepo.set(repo, entry);
  }
  return [...byRepo.values()];
}

function countPrimaryGaps(state) {
  let gaps = 0;
  if (!state.evidence_ready) gaps += 1;
  if (state.missing_evidence) gaps += state.missing_evidence.split(";").filter((entry) => entry.trim()).length || 1;
  if (!state.launch_eligible) gaps += 1;
  if (state.hard_gate_status && state.hard_gate_status !== "clear") gaps += 1;
  if (state.internet_pipes_readiness && !["alpha_ready", "factory_ready", "ready"].includes(state.internet_pipes_readiness)) {
    gaps += Math.max(1, state.internet_pipes_missing_stations.length);
  }
  return gaps;
}

function resolveTargetRepo(dispatchArtifact, selectionSnapshot) {
  return (
    stringValue(dispatchArtifact.target_repo_full_name) ||
    stringValue(getPath(dispatchArtifact, ["execution_manifest", "repo_target", "target_repo_full_name"])) ||
    stringValue(getPath(selectionSnapshot, ["execution_target", "repo"])) ||
    stringValue(getPath(selectionSnapshot, ["launch_target", "repo"])) ||
    stringValue(getPath(selectionSnapshot, ["research_target", "repo"]))
  );
}

function resolveSelectionPath(dispatchArtifact, override) {
  return (
    override ||
    stringValue(dispatchArtifact.selection_snapshot_path) ||
    stringValue(getPath(dispatchArtifact, ["artifacts", "scaffold_snapshot_path"]))
  );
}

function resolveDossierPath(dispatchArtifact, override) {
  return (
    override ||
    stringValue(dispatchArtifact.selected_repo_dossier_path) ||
    stringValue(getPath(dispatchArtifact, ["dossier_contract", "selected_repo_dossier", "dossier_path"]))
  );
}

function buildReceipt({ dispatchPath, selectionSnapshotPath, dossierPath, now }) {
  const dispatchArtifact = readJson(dispatchPath);
  const selectionSnapshot = readJson(selectionSnapshotPath);
  const dossierArtifact = readJson(dossierPath);
  const resolvedRunId = stringValue(dispatchArtifact.run_id) || stringValue(selectionSnapshot.run_id) || runId;
  const targetRepo = resolveTargetRepo(dispatchArtifact, selectionSnapshot);
  if (!targetRepo) throw new Error("Unable to resolve dispatch target repository.");

  const primaryTarget = findPrimaryTarget(selectionSnapshot, targetRepo);
  const primaryTargetState = buildPrimaryTargetState(primaryTarget.candidate);
  const primaryTargetGaps = countPrimaryGaps(primaryTargetState);
  const inventory = buildInventory(selectionSnapshot, targetRepo, primaryTarget.role);
  const otherBundleGaps = inventory.filter((entry) => entry.repo !== targetRepo && entry.missing_evidence).length;
  const generatedAt = isoTimestamp(now);
  const targetName = repoShortName(targetRepo);
  const dossierGateStatus =
    stringValue(getPath(dossierArtifact, ["stage_0_gate_receipt", "gate_status"])) ||
    stringValue(getPath(dossierArtifact, ["stage_0_gate_receipt", "decision", "status"]));

  const dispatchArtifactCopy = { ...dispatchArtifact };
  const embeddedDispatchHash = stringValue(dispatchArtifactCopy.dispatch_hash, null);
  delete dispatchArtifactCopy.dispatch_hash;
  const calculatedDispatchHash = createHash("sha256").update(stableJson(dispatchArtifactCopy)).digest("hex");
  const dispatchHashMatch = embeddedDispatchHash !== null && embeddedDispatchHash === calculatedDispatchHash;

  return {
    schema_version: "pos.evidence_backfill_reconciler.v1",
    run_id: resolvedRunId,
    generated_at: generatedAt,
    last_reconciled_at: generatedAt,
    source_artifact_path: dispatchPath,
    selection_snapshot_path: selectionSnapshotPath,
    selected_repo_dossier_path: dossierPath,
    reconciler_type: "paperclip-evidence-backfill-runner",
    dispatch_target_repo: targetRepo,
    primary_target_state: primaryTargetState,
    evidence_inventory: inventory,
    evidence_sources_verified: buildEvidenceSources(primaryTarget.candidate),
    artifact_hashes: {
      dispatch_sha256: calculatedDispatchHash,
      selection_snapshot_sha256: sha256File(selectionSnapshotPath),
      selected_repo_dossier_sha256: sha256File(dossierPath),
      embedded_dispatch_hash: embeddedDispatchHash,
      dispatch_hash_match: dispatchHashMatch,
    },
    conclusion: {
      primary_target_gaps: primaryTargetGaps,
      other_bundle_gaps_noted: otherBundleGaps,
      blocks_run: primaryTargetGaps > 0,
      recommendation: primaryTargetGaps > 0
        ? `Backfill primary ${targetName} evidence before closing the dispatch run.`
        : dispatchHashMatch
          ? `Primary target (${targetName}) evidence complete. ${otherBundleGaps} non-primary bundle gaps noted but do not block this dispatch run.`
          : `Primary target (${targetName}) evidence complete. WARNING: Artifact hash mismatch detected. ${otherBundleGaps} non-primary bundle gaps noted but do not block this dispatch run.`,
    },
    note:
      `Reconciled ${targetRepo} from current dispatch, selection snapshot, and dossier artifacts. ` +
      `Dossier gate: ${dossierGateStatus || "unknown"}. Primary role: ${primaryTarget.role}.` +
      (dispatchHashMatch ? "" : ` WARNING: Dispatch artifact hash mismatch (embedded: ${embeddedDispatchHash || "null"}, calculated: ${calculatedDispatchHash}).`),
  };
}

function updateDispatchBackfillMetadata(dispatchPath, receipt, evidencePath) {
  const dispatchArtifact = readJson(dispatchPath);
  const portfolioRoot = dispatchPath.includes("/data/dispatch/outbox/")
    ? dispatchPath.split("/data/dispatch/outbox/")[0]
    : path.dirname(path.dirname(path.dirname(dispatchPath)));
  const relativeEvidencePath = path.relative(portfolioRoot, evidencePath);
  const targetName = repoShortName(receipt.dispatch_target_repo);
  const date = receipt.last_reconciled_at.slice(0, 10);

  dispatchArtifact.evidence_backfill_last_run = receipt.last_reconciled_at;
  dispatchArtifact.evidence_backfill_status = receipt.conclusion.blocks_run ? "blocked" : "complete";
  dispatchArtifact.evidence_backfill_path = relativeEvidencePath;
  dispatchArtifact.evidence_backfill_summary = receipt.conclusion.blocks_run
    ? `Primary target (${targetName}) still has ${receipt.conclusion.primary_target_gaps} evidence gap(s) after ${date} reconciliation.`
    : `Primary target (${targetName}) complete - re-reconciled ${date}. 0 new primary gaps. Evidence receipt refreshed.`;
  writeJson(dispatchPath, dispatchArtifact);
}

function buildMarkdownReport(receipt, evidencePath) {
  const sources = receipt.evidence_sources_verified
    .map((source) => {
      const link = source.url ? ` - ${source.url}` : source.urls?.length ? ` - ${source.urls.join(" | ")}` : "";
      return `- ${source.source_type}${source.id ? `: ${source.id}` : ""}${link}`;
    })
    .join("\n");
  const inventory = receipt.evidence_inventory
    .map((entry) => `| ${entry.role} | ${entry.repo} | ${entry.status} | ${entry.missing_evidence || "none"} | ${entry.internet_pipes_missing_stations?.join(", ") || "none"} |`)
    .join("\n");
  return [
    `# Evidence Backfill Reconciler - ${receipt.run_id}`,
    "",
    `Generated: ${receipt.generated_at}`,
    `Target repo: ${receipt.dispatch_target_repo}`,
    `Inbox receipt: ${evidencePath}`,
    "",
    "## Verdict",
    "",
    `- Primary target gaps: ${receipt.conclusion.primary_target_gaps}`,
    `- Blocks run: ${receipt.conclusion.blocks_run ? "yes" : "no"}`,
    `- Recommendation: ${receipt.conclusion.recommendation}`,
    "",
    "## Verified Sources",
    "",
    sources || "- none",
    "",
    "## Inventory",
    "",
    "| Role | Repo | Status | Missing evidence | Internet Pipes missing stations |",
    "| --- | --- | --- | --- | --- |",
    inventory,
    "",
  ].join("\n");
}

function resolveRunInputs(issue) {
  const description = String(issue?.description || "");
  const contract = extractContract(description);
  const dispatchPath =
    process.env.EVIDENCE_DISPATCH_PATH ||
    process.env.SOURCE_DISPATCH_PATH ||
    readText(contract.source_dispatch_path) ||
    readText(contract.dispatch_path) ||
    extractLine(description, "Dispatch file") ||
    path.join(portfolioOsDir, "data/dispatch/outbox", `dispatch_${readText(contract.run_id) || runId}.json`) ||
    DEFAULT_DISPATCH_PATH;
  return { contract, dispatchPath };
}

function reconcileEvidence(input) {
  const dispatchArtifact = readJson(input.dispatchPath);
  const selectionSnapshotPath = resolveSelectionPath(dispatchArtifact, process.env.EVIDENCE_SELECTION_SNAPSHOT_PATH || readText(input.contract.selection_snapshot_path));
  const dossierPath = resolveDossierPath(dispatchArtifact, process.env.EVIDENCE_DOSSIER_PATH || readText(input.contract.selected_repo_dossier_path));
  if (!selectionSnapshotPath) throw new Error("Missing selection snapshot path.");
  if (!dossierPath) throw new Error("Missing selected repo dossier path.");

  const receipt = buildReceipt({
    dispatchPath: input.dispatchPath,
    selectionSnapshotPath,
    dossierPath,
    now: input.now || new Date(),
  });
  const inboxDir =
    process.env.EVIDENCE_INBOX_DIR ||
    stringValue(getPath(dispatchArtifact, ["cockpit", "dispatch_inbox_dir"])) ||
    path.join(portfolioOsDir, "data/dispatch/inbox");
  const evidencePath = process.env.EVIDENCE_RECEIPT_PATH || path.join(inboxDir, `evidence_${receipt.run_id}.json`);
  writeJson(evidencePath, receipt);
  updateDispatchBackfillMetadata(input.dispatchPath, receipt, evidencePath);

  const reportPath = process.env.EVIDENCE_REPORT_PATH || (
    writeDocs && readText(input.contract.target_repo_clone_path_hint)
      ? path.join(readText(input.contract.target_repo_clone_path_hint), "docs", "evidence-backfill-reconciler", receipt.run_id, "latest.md")
      : null
  );
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buildMarkdownReport(receipt, evidencePath), "utf8");
  }
  return { receipt, evidencePath, reportPath, dispatchPath: input.dispatchPath };
}

function runShell(label, command) {
  console.log(`[paperclip-process] ${label}: ${command}`);
  const startedAt = Date.now();
  const result = spawnSync("/bin/zsh", ["-lc", command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const durationMs = Date.now() - startedAt;
  if (result.status !== 0) {
    const error = new Error(`${label} failed with exit ${result.status ?? "signal"} after ${durationMs}ms`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return { label, command, exitCode: result.status ?? 0, durationMs };
}

async function patchIssue(result) {
  if (!issueId || !apiKey) return null;
  const status = result.receipt.conclusion.blocks_run ? "blocked" : "done";
  await apiJson("PATCH", `/api/issues/${issueId}`, { status });
  return status;
}

try {
  let commandResult = null;
  let result = null;
  if (process.env.EVIDENCE_RECONCILER_COMMAND) {
    commandResult = runShell("reconciler", process.env.EVIDENCE_RECONCILER_COMMAND);
    const dispatchPath = process.env.EVIDENCE_DISPATCH_PATH || process.env.SOURCE_DISPATCH_PATH || DEFAULT_DISPATCH_PATH;
    result = reconcileEvidence({ contract: {}, dispatchPath });
  } else {
    const issue = await loadIssue();
    const inputs = resolveRunInputs(issue);
    result = reconcileEvidence(inputs);
  }

  let tests = null;
  if (process.env.EVIDENCE_TEST_COMMAND || process.env.EVIDENCE_RUNBOOK_RUN_TESTS === "1") {
    tests = runShell(
      "tests",
      process.env.EVIDENCE_TEST_COMMAND || "npx vitest run server/src/__tests__/evidence-backfill-runbook.test.ts",
    );
  }

  const statusAction = await patchIssue(result);
  const taskLabel = process.env.PAPERCLIP_TASK_ID || process.env.PAPERCLIP_ISSUE_ID || "issue";
  const summary = [
    `${taskLabel} deterministic evidence backfill complete.`,
    `- Receipt refreshed: ${result.evidencePath} (${result.receipt.last_reconciled_at})`,
    `- Primary gaps: ${result.receipt.conclusion.primary_target_gaps}; blocks_run: ${result.receipt.conclusion.blocks_run}; other bundle gaps: ${result.receipt.conclusion.other_bundle_gaps_noted}; evidence sources: ${result.receipt.evidence_sources_verified.length}`,
    `- Dispatch artifact: evidence_backfill_status=${result.receipt.conclusion.blocks_run ? "blocked" : "complete"}, dispatch=${result.dispatchPath}`,
    statusAction ? `- Paperclip issue status: ${statusAction}` : "- Paperclip issue status: not patched outside API heartbeat context",
    "- Provider tokens spent: 0",
  ].join("\n");
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify({
    summary,
    runId: result.receipt.run_id,
    receiptPath: result.evidencePath,
    reportPath: result.reportPath,
    dispatchPath: result.dispatchPath,
    primaryTargetGaps: result.receipt.conclusion.primary_target_gaps,
    blocksRun: result.receipt.conclusion.blocks_run,
    otherBundleGapsNoted: result.receipt.conclusion.other_bundle_gaps_noted,
    evidenceSourcesVerified: result.receipt.evidence_sources_verified.length,
    dispatchBackfillStatus: result.receipt.conclusion.blocks_run ? "blocked" : "complete",
    statusAction,
    providerTokensSpent: 0,
    commands: { reconciler: commandResult, tests },
    finalDisposition: {
      classification: result.receipt.conclusion.blocks_run ? "blocked" : "done",
      nextActionOwner: result.receipt.conclusion.blocks_run ? "agent" : "system",
      reason: result.receipt.conclusion.recommendation,
    },
    paperclipNoNewSignal: {
      action: result.receipt.conclusion.blocks_run ? "wait_for_evidence_change" : "issue_closed",
      detectorVersion: "paperclip-process-evidence-backfill.v2",
      signals: [
        "deterministic_evidence_backfill_complete",
        result.receipt.conclusion.blocks_run ? "primary_evidence_gaps_remain" : "primary_evidence_complete",
      ],
    },
  })}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) || 1 : 1);
}
