#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const runId = process.env.EVIDENCE_RUN_ID || "20260503T193357Z";
const portfolioOsDir = process.env.PORTFOLIO_OS_DIR || "/Users/mnm/Documents/Github/portfolio-os";
const receiptPath =
  process.env.EVIDENCE_RECEIPT_PATH ||
  path.join(portfolioOsDir, "data/dispatch/inbox", `evidence_${runId}.json`);
const dispatchPath =
  process.env.EVIDENCE_DISPATCH_PATH ||
  path.join(portfolioOsDir, "data/dispatch/outbox", `dispatch_${runId}.json`);
const reconcilerCommand =
  process.env.EVIDENCE_RECONCILER_COMMAND ||
  "npx tsx scripts/evidence-backfill-reconciler.ts";
const testCommand =
  process.env.EVIDENCE_TEST_COMMAND ||
  "npx vitest run server/__tests__/evidence-backfill-reconciler.test.ts";

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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

try {
  const reconciler = runShell("reconciler", reconcilerCommand);
  const tests = runShell("tests", testCommand);
  const receipt = readJson(receiptPath);
  const dispatch = readJson(dispatchPath);
  const primaryGaps = receipt.conclusion?.primary_target_gaps ?? null;
  const blocksRun = receipt.conclusion?.blocks_run ?? null;
  const otherGaps = receipt.conclusion?.other_bundle_gaps_noted ?? null;
  const sourceCount = Array.isArray(receipt.evidence_sources_verified)
    ? receipt.evidence_sources_verified.length
    : null;
  const taskLabel = process.env.PAPERCLIP_TASK_ID || process.env.PAPERCLIP_ISSUE_ID || "issue";
  const summary = [
    `${taskLabel} deterministic evidence backfill complete.`,
    `- Reconciler: ${reconciler.command} exit ${reconciler.exitCode}`,
    `- Receipt refreshed: ${receiptPath} (${receipt.last_reconciled_at ?? receipt.generated_at ?? "timestamp unavailable"})`,
    `- Primary gaps: ${primaryGaps}; blocks_run: ${blocksRun}; other bundle gaps: ${otherGaps}; evidence sources: ${sourceCount}`,
    `- Dispatch artifact: evidence_backfill_status=${dispatch.evidence_backfill_status ?? "unknown"}, last_run=${dispatch.evidence_backfill_last_run ?? "unknown"}`,
    `- Tests: ${tests.command} passed`,
    "- Issue remains in_progress for the recurring timer-pinned routine; upstream distribution_credentials blocker is outside this lane.",
  ].join("\n");
  const result = {
    summary,
    runId,
    receiptPath,
    dispatchPath,
    primaryTargetGaps: primaryGaps,
    blocksRun,
    otherBundleGapsNoted: otherGaps,
    evidenceSourcesVerified: sourceCount,
    dispatchBackfillStatus: dispatch.evidence_backfill_status ?? null,
    dispatchBackfillLastRun: dispatch.evidence_backfill_last_run ?? null,
    commands: { reconciler, tests },
  };
  console.log(`PAPERCLIP_ADAPTER_RESULT_JSON=${JSON.stringify(result)}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[paperclip-process] failed: ${message}`);
  console.log(`PAPERCLIP_ADAPTER_RESULT_JSON=${JSON.stringify({ summary: `Evidence backfill process failed: ${message}`, error: message })}`);
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) || 1 : 1;
}
