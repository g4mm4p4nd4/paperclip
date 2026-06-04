import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  contextLedgerEntries,
  flywheelHealthReports,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { classifyProviderReliabilityFailureText } from "./agent-model-routing.js";
import {
  buildContextEconomyCanaryMatrix,
  type ContextEconomyCanaryEnvelope,
} from "./context-economy-live-canary.js";

type JsonRecord = Record<string, unknown>;

const DEFAULT_CONTEXT_PACK_MANIFEST_PATH =
  "/Users/mnm/Documents/Github/.paperclip/portfolio-os-cockpit/instances/default/data/ops/context-packs/latest.json";
const FLYWHEEL_CANARY_REPO_SLUGS = ["paperclip", "hermes-agent", "portfolio-os", "gstack"] as const;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], pct: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeCurrentGitHead(cwd: string | null): string {
  if (!cwd) return "";
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

function contextPackFreshnessStatus(pack: JsonRecord, repo: JsonRecord, manifest: JsonRecord): string {
  const status = readString(pack.status) ?? readString(repo.status);
  if (status && status !== "ok") return status;
  const generatedAt =
    readString(pack.finishedAt) ??
    readString(pack.generatedAt) ??
    readString(repo.generatedAt) ??
    readString(manifest.generatedAt);
  if (!generatedAt) return "unknown";
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return "unknown";
  const policy = asRecord(manifest.policy);
  const staleAfterHours = readNumber(policy.staleAfterHours) || 24;
  const ageHours = Math.max(0, (Date.now() - generatedAtMs) / (60 * 60 * 1000));
  return ageHours > staleAfterHours ? "stale" : "fresh";
}

async function buildContextPackCanaryReadinessMatrix() {
  const manifestPath = process.env.PAPERCLIP_CONTEXT_PACK_MANIFEST_PATH || DEFAULT_CONTEXT_PACK_MANIFEST_PATH;
  let manifestText = "";
  let manifest: JsonRecord = {};
  try {
    manifestText = await readFile(manifestPath, "utf8");
    manifest = asRecord(JSON.parse(manifestText));
  } catch {
    return buildContextEconomyCanaryMatrix(
      FLYWHEEL_CANARY_REPO_SLUGS.map((repoSlug) => ({ repoSlug, envelope: null })),
    );
  }

  const manifestSha = sha256Text(manifestText);
  const repos = asRecord(manifest.repos);
  return buildContextEconomyCanaryMatrix(
    FLYWHEEL_CANARY_REPO_SLUGS.map((repoSlug) => {
      const repo = asRecord(repos[repoSlug]);
      const profiles = asRecord(repo.profiles);
      const mapProfile = asRecord(profiles.map);
      const repoState = asRecord(repo.repoState);
      if (Object.keys(repo).length === 0 || Object.keys(mapProfile).length === 0) {
        return { repoSlug, envelope: null };
      }
      const envelope: ContextEconomyCanaryEnvelope = {
        repoSlug,
        selectedProfile: "map",
        manifestPath,
        manifestSha,
        packPath: readString(mapProfile.latestPath) ?? readString(mapProfile.output) ?? "",
        packSha: readString(mapProfile.sha256) ?? "",
        estimatedTokens: readNumber(mapProfile.estimatedTokens),
        freshnessStatus: contextPackFreshnessStatus(mapProfile, repo, manifest),
        packHead: readString(repoState.head) ?? "",
        currentHead: safeCurrentGitHead(readString(repoState.cwd)),
      };
      return { repoSlug, envelope };
    }),
  );
}

function compactText(...values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(0, 2_000);
}

function extractTestCounts(value: unknown): { passed: number; failed: number } {
  if (Array.isArray(value)) {
    return value.reduce(
      (acc, entry) => {
        const record = asRecord(entry);
        const exitCode = "exitCode" in record ? readNumber(record.exitCode) : null;
        if (readString(record.command) && exitCode !== null && Number.isFinite(exitCode)) {
          if (exitCode === 0) acc.passed += 1;
          else acc.failed += 1;
        } else {
          const nested = extractTestCounts(entry);
          acc.passed += nested.passed;
          acc.failed += nested.failed;
        }
        return acc;
      },
      { passed: 0, failed: 0 },
    );
  }
  const record = asRecord(value);
  let passed = 0;
  let failed = 0;
  for (const [key, entry] of Object.entries(record)) {
    if (/tests?.*pass|passed.*tests?/i.test(key)) passed += readNumber(entry);
    if (/tests?.*fail|failed.*tests?|failures?/i.test(key)) failed += readNumber(entry);
    if (entry && typeof entry === "object") {
      const nested = extractTestCounts(entry);
      passed += nested.passed;
      failed += nested.failed;
    }
  }
  return { passed, failed };
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.flatMap((value) => {
    const trimmed = readString(value);
    return trimmed ? [trimmed] : [];
  }))].sort();
}

function collectPathishStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    const matches = value.match(/[A-Za-z0-9_@./-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*/g) ?? [];
    return matches.filter((entry) =>
      entry.length < 300 &&
      !entry.includes("://") &&
      !/^\d+(?:\.\d+)+$/.test(entry) &&
      !/[{}"'`]/.test(entry),
    );
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectPathishStrings(entry, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as JsonRecord;
  return [
    ...collectPathishStrings(record.path, depth + 1),
    ...collectPathishStrings(record.file, depth + 1),
    ...collectPathishStrings(record.filename, depth + 1),
    ...collectPathishStrings(record.filePath, depth + 1),
  ];
}

function extractChangedFiles(value: unknown, depth = 0, keyHint = ""): string[] {
  if (depth > 7 || value == null) return [];
  const changedFilesKey =
    /(changed|modified|updated|created|deleted|touched).*(files?|paths?)|files?.*(changed|modified|updated|created|deleted|touched)|changedFiles|modifiedFiles|filesChanged|changed_files|gitStatus/i;
  const direct = changedFilesKey.test(keyHint) ? collectPathishStrings(value) : [];
  if (Array.isArray(value)) {
    return uniqueStrings([
      ...direct,
      ...value.flatMap((entry) => extractChangedFiles(entry, depth + 1, keyHint)),
    ]);
  }
  if (typeof value !== "object") return uniqueStrings(direct);
  const record = value as JsonRecord;
  return uniqueStrings([
    ...direct,
    ...Object.entries(record).flatMap(([key, entry]) => extractChangedFiles(entry, depth + 1, key)),
  ]);
}

function isValidReceiptPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length < 500 &&
    !/[\r\n{}]/.test(value) &&
    /^[~./A-Za-z0-9_-]/.test(value);
}

function extractReceiptPathsFromValue(value: unknown): string[] {
  if (isValidReceiptPath(value) && /receipt/i.test(value)) return [value.trim()];
  if (typeof value !== "string") return [];
  return Array.from(
    value.matchAll(
      /(?:^|[`"'\s])((?:[~./A-Za-z0-9_-]+\/)?[~./A-Za-z0-9_./-]*receipt[~./A-Za-z0-9_.-]*\.(?:json|md|txt|log|ndjson))(?:$|[`"'\s,.)])/gi,
    ),
  )
    .map((match) => match[1])
    .filter((entry): entry is string => isValidReceiptPath(entry));
}

function uniqueReceiptPaths(entries: Array<typeof contextLedgerEntries.$inferSelect>) {
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const path of asArray(entry.receiptPaths)) {
      for (const extracted of extractReceiptPathsFromValue(path)) {
        paths.add(extracted);
      }
    }
  }
  return [...paths].sort();
}

type ReceiptProof = {
  changedFiles: string[];
  tests: { passed: number; failed: number };
};

async function readReceiptProof(
  entries: Array<typeof contextLedgerEntries.$inferSelect>,
  receiptPaths: string[],
  expectedIssueIdentifier?: string | null,
): Promise<ReceiptProof> {
  const changedFiles = new Set<string>();
  const tests = { passed: 0, failed: 0 };
  const expectedIdentifier = readString(expectedIssueIdentifier);
  for (const receiptPath of receiptPaths.slice(0, 10)) {
    if (!/\.json$/i.test(receiptPath)) continue;
    const candidates = uniqueStrings([
      path.isAbsolute(receiptPath) ? receiptPath : null,
      ...entries.map((entry) => entry.cwd ? path.resolve(entry.cwd, receiptPath) : null),
    ]);
    const filePath = candidates[0];
    if (!filePath) continue;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > 256_000) continue;
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      const parsedIdentifier = readString(asRecord(parsed).issueIdentifier);
      if (expectedIdentifier && parsedIdentifier && parsedIdentifier !== expectedIdentifier) continue;
      for (const file of extractChangedFiles(parsed)) changedFiles.add(file);
      const counts = extractTestCounts(parsed);
      tests.passed += counts.passed;
      tests.failed += counts.failed;
    } catch {
      // Receipt readback is best-effort; ledger rows remain authoritative.
    }
  }
  return {
    changedFiles: [...changedFiles].sort(),
    tests,
  };
}

function compactContextPackRefs(entries: Array<typeof contextLedgerEntries.$inferSelect>) {
  const refs = new Map<string, JsonRecord>();
  for (const entry of entries) {
    for (const raw of asArray(entry.contextPackRefs)) {
      const ref = asRecord(raw);
      if (Object.keys(ref).length === 0) continue;
      const compact = {
        repoSlug: readString(ref.repoSlug),
        selectedProfile: readString(ref.selectedProfile) ?? readString(ref.profile),
        packPath: readString(ref.packPath) ?? readString(ref.path),
        packSha: readString(ref.packSha) ?? readString(ref.sha256),
        manifestPath: readString(ref.manifestPath),
        freshnessStatus: readString(ref.freshnessStatus),
      };
      const key = JSON.stringify(compact);
      if (!refs.has(key)) refs.set(key, compact);
    }
  }
  return [...refs.values()].slice(0, 20);
}

function entryHasArtifactEvidence(entry: typeof contextLedgerEntries.$inferSelect) {
  return asArray(entry.artifactRefs).length > 0 || Object.keys(asRecord(entry.componentHashes)).length > 0;
}

function entryHasPromptSloViolation(entry: typeof contextLedgerEntries.$inferSelect) {
  const usageBudget = asRecord(asRecord(entry.metadata).actualUsageBudget);
  return entry.budgetStatus === "warning" ||
    entry.budgetStatus === "hard_stop" ||
    usageBudget.warning === true;
}

function entryHasOutputSloViolation(entry: typeof contextLedgerEntries.$inferSelect) {
  const usageBudget = asRecord(asRecord(entry.metadata).outputUsageBudget);
  return entry.outputBudgetStatus === "warning" ||
    entry.responseClass === "verbose_unjustified" ||
    usageBudget.outputBudgetStatus === "warning";
}

function extractProviderGate(
  run: typeof heartbeatRuns.$inferSelect,
  entries: Array<typeof contextLedgerEntries.$inferSelect>,
): JsonRecord | null {
  const fromEntry = entries
    .map((entry) => asRecord(asRecord(entry.metadata).providerReliabilityGate))
    .find((gate) => Object.keys(gate).length > 0);
  const gate = fromEntry && Object.keys(fromEntry).length > 0
    ? fromEntry
    : asRecord(asRecord(run.contextSnapshot).paperclipProviderReliabilityGate);
  if (Object.keys(gate).length === 0) return null;
  return {
    status: readString(gate.status),
    failureKind: readString(gate.failureKind),
    reason: readString(gate.reason),
    selectedAdapterType: readString(gate.selectedAdapterType),
    selectedLane: readString(gate.selectedLane),
    model: readString(gate.model),
  };
}

function isReroutedProviderGate(gate: JsonRecord | null) {
  return gate?.status === "rerouted" || Boolean(gate?.failureKind || gate?.reason);
}

function extractProviderFailure(
  run: typeof heartbeatRuns.$inferSelect,
  entries: Array<typeof contextLedgerEntries.$inferSelect>,
) {
  const gate = extractProviderGate(run, entries);
  const blockingText = compactText(
    run.error,
    run.errorCode,
    run.stderrExcerpt,
    run.stdoutExcerpt,
    ...entries.map((entry) => entry.finalBlocker),
  );
  const classified = classifyProviderReliabilityFailureText(blockingText);
  const gateStatus = readString(gate?.status);
  const gateFailureKind = readString(gate?.failureKind);
  const gateIsFatal =
    gateStatus === "blocked" ||
    gateStatus === "failed" ||
    (run.status !== "succeeded" && gateFailureKind !== null);
  const kind = classified?.kind ?? (gateIsFatal ? gateFailureKind : null);
  if (!kind) return null;
  return {
    runId: run.id,
    kind,
    reason:
      readString(gate?.reason) ??
      classified?.reason ??
      run.errorCode ??
      "provider_reliability_failure",
    adapterType: readString(gate?.selectedAdapterType),
    lane: readString(gate?.selectedLane),
    model: readString(gate?.model),
    createdAt: run.createdAt,
  };
}

function floorToHour(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  return next;
}

function readPercent(value: unknown): number {
  const record = asRecord(value);
  return readNumber(record.percent);
}

export function flywheelHealthService(db: Db) {
  async function summarize(companyId: string, opts: { now?: Date; windowHours?: number } = {}) {
    const now = opts.now ?? new Date();
    const windowHours =
      typeof opts.windowHours === "number" && Number.isFinite(opts.windowHours) && opts.windowHours > 0
        ? Math.min(24 * 30, opts.windowHours)
        : 1;
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    const [runs, ledgerEntries, completedIssues] = await Promise.all([
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since))),
      db
        .select()
        .from(contextLedgerEntries)
        .where(and(eq(contextLedgerEntries.companyId, companyId), gte(contextLedgerEntries.createdAt, since))),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since))),
    ]);

    const terminalRuns = runs.filter((run) => run.status !== "queued" && run.status !== "running");
    const completedRuns = runs.filter((run) => run.status === "succeeded");
    const runIds = runs.map((run) => run.id);
    const runIdSet = new Set(runIds);
    const linkedIssueIds = uniqueStrings(ledgerEntries.map((entry) => entry.issueId));
    const linkedIssues = linkedIssueIds.length > 0
      ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, linkedIssueIds)))
      : [];
    const ledgerRunIds = new Set(
      ledgerEntries
        .map((entry) => entry.runId)
        .filter((runId): runId is string => typeof runId === "string" && runIdSet.has(runId)),
    );

    const ledgerByRun = new Map<string, Array<typeof contextLedgerEntries.$inferSelect>>();
    for (const entry of ledgerEntries) {
      if (!entry.runId) continue;
      const entries = ledgerByRun.get(entry.runId) ?? [];
      entries.push(entry);
      ledgerByRun.set(entry.runId, entries);
    }
    const providerFailures = terminalRuns.flatMap((run) => {
      const failure = extractProviderFailure(run, ledgerByRun.get(run.id) ?? []);
      return failure ? [failure] : [];
    });
    const issueById = new Map(linkedIssues.map((issue) => [issue.id, issue]));
    const completedIssueById = new Map(linkedIssues.filter((issue) => issue.status === "done").map((issue) => [issue.id, issue]));
    const providerFailureRunIds = new Set(providerFailures.map((failure) => failure.runId));
    const promptSloViolationEntries = ledgerEntries.filter(entryHasPromptSloViolation);
    const issueLinkedSucceeded = (await Promise.all(completedRuns.map(async (run) => {
      const entries = ledgerByRun.get(run.id) ?? [];
      const issueIds = uniqueStrings(entries.map((entry) => entry.issueId));
      if (issueIds.length === 0) return [];
      const receiptPaths = uniqueReceiptPaths(entries);
      const runTestCounts = extractTestCounts(run.resultJson);
      const contextPackRefs = compactContextPackRefs(entries);
      const providerGate = extractProviderGate(run, entries);
      return Promise.all(issueIds.map(async (issueId) => {
        const issue = issueById.get(issueId) ?? null;
        const receiptProof = await readReceiptProof(entries, receiptPaths, issue?.identifier ?? null);
        const testCounts = {
          passed: runTestCounts.passed + receiptProof.tests.passed,
          failed: runTestCounts.failed + receiptProof.tests.failed,
        };
        const changedFiles = uniqueStrings([
          ...receiptProof.changedFiles,
          ...extractChangedFiles(run.resultJson),
          ...entries.flatMap((entry) => extractChangedFiles(entry.metadata)),
          ...entries.flatMap((entry) => extractChangedFiles(entry.artifactRefs)),
        ]);
        const issueDone = issue?.status === "done";
        const missing = [
          entries.length === 0 ? "context_ledger" : null,
          issueDone ? null : "issue_done",
          receiptPaths.length > 0 ? null : "receipt_path",
          testCounts.passed > 0 && testCounts.failed === 0 ? null : "passing_tests",
          changedFiles.length > 0 ? null : "changed_files",
          contextPackRefs.length > 0 ? null : "context_pack_ref",
          providerFailureRunIds.has(run.id) ? "provider_failure" : null,
          entries.some((entry) => entry.budgetStatus === "hard_stop") ? "prompt_budget_hard_stop" : null,
        ].filter((entry): entry is string => Boolean(entry));
        return {
          run,
          entries,
          issueId,
          issue,
          receiptPaths,
          testCounts,
          changedFiles,
          contextPackRefs,
          providerGate,
          missing,
        };
      }));
    }))).flat();
    const issueLinkedSucceededRuns = new Set(issueLinkedSucceeded.map((candidate) => candidate.run.id));
    const completedIssueRuns = issueLinkedSucceeded.filter((candidate) => candidate.issue);
    const providerReroutedSuccesses = issueLinkedSucceeded.filter((candidate) =>
      isReroutedProviderGate(candidate.providerGate),
    );
    const readyCanaries = issueLinkedSucceeded.filter((candidate) => candidate.missing.length === 0);
    const targetCompletionMatrix = FLYWHEEL_CANARY_REPO_SLUGS.map((repoSlug) => {
      const matches = readyCanaries.filter((candidate) =>
        candidate.contextPackRefs.some((ref) => readString(asRecord(ref).repoSlug) === repoSlug),
      );
      return {
        repoSlug,
        ok: matches.length > 0,
        readyCount: matches.length,
        runIds: uniqueStrings(matches.map((candidate) => candidate.run.id)).slice(0, 5),
        issueIdentifiers: uniqueStrings(matches.map((candidate) => candidate.issue?.identifier ?? null)).slice(0, 5),
        reasons: matches.length > 0 ? [] : ["live_canary_receipt"],
      };
    });

    const promptTokensByClass = Object.entries(
      ledgerEntries.reduce<Record<string, number[]>>((acc, entry) => {
        const key = entry.promptClass || "unknown";
        acc[key] = acc[key] ?? [];
        acc[key].push(entry.estimatedPromptTokens ?? 0);
        return acc;
      }, {}),
    ).map(([promptClass, values]) => ({
      promptClass,
      count: values.length,
      meanEstimatedTokens: mean(values),
      p95EstimatedTokens: percentile(values, 95),
    })).sort((a, b) => b.count - a.count || a.promptClass.localeCompare(b.promptClass));

    const outputTokensByResponseClass = Object.entries(
      ledgerEntries.reduce<Record<string, number[]>>((acc, entry) => {
        const key = entry.responseClass || "unknown";
        acc[key] = acc[key] ?? [];
        acc[key].push(entry.actualOutputTokens ?? entry.estimatedOutputTokens ?? 0);
        return acc;
      }, {}),
    ).map(([responseClass, values]) => ({
      responseClass,
      count: values.length,
      meanOutputTokens: mean(values),
      p95OutputTokens: percentile(values, 95),
    })).sort((a, b) => b.count - a.count || a.responseClass.localeCompare(b.responseClass));

    const artifactBackedEntries = ledgerEntries.filter(entryHasArtifactEvidence);
    const cachedInputTokens = ledgerEntries.reduce((sum, entry) => sum + (entry.cachedInputTokens ?? 0), 0);
    const totalOutputTokens = ledgerEntries.reduce(
      (sum, entry) => sum + (entry.actualOutputTokens ?? entry.estimatedOutputTokens ?? 0),
      0,
    );
    const outputSloViolationEntries = ledgerEntries.filter(entryHasOutputSloViolation);
    const tests = runs.reduce(
      (acc, run) => {
        const counts = extractTestCounts(run.resultJson);
        acc.passed += counts.passed;
        acc.failed += counts.failed;
        return acc;
      },
      { passed: 0, failed: 0 },
    );
    const receipts = uniqueReceiptPaths(ledgerEntries);

    return {
      companyId,
      window: {
        since: since.toISOString(),
        until: now.toISOString(),
        hours: windowHours,
      },
      tasksAttempted: terminalRuns.length,
      tasksCompleted: completedRuns.length,
      issuesCompleted: completedIssues.length,
      providerFailures: {
        count: providerFailures.length,
        recent: providerFailures.slice(0, 10),
      },
      promptTokensByClass,
      outputTokensByResponseClass,
      cachedInputTokens,
      totalOutputTokens,
      outputBudgetViolations: {
        count: outputSloViolationEntries.length,
        examples: outputSloViolationEntries.slice(0, 10).map((entry) => ({
          runId: entry.runId,
          issueId: entry.issueId,
          responseClass: entry.responseClass,
          outputBudgetStatus: entry.outputBudgetStatus,
          actualOutputTokens: entry.actualOutputTokens,
          estimatedOutputTokens: entry.estimatedOutputTokens,
          outputBudgetLimitTokens: entry.outputBudgetLimitTokens,
          finalResponseChars: entry.finalResponseChars,
          finalResponseSha256: entry.finalResponseSha256,
        })),
      },
      artifactCoverage: {
        entries: ledgerEntries.length,
        artifactBackedEntries: artifactBackedEntries.length,
        percent: ledgerEntries.length > 0
          ? Math.round((artifactBackedEntries.length / ledgerEntries.length) * 100)
          : 0,
      },
      ledgerCompleteness: {
        runs: runs.length,
        runsWithLedger: ledgerRunIds.size,
        percent: runs.length > 0 ? Math.round((ledgerRunIds.size / runs.length) * 100) : 0,
      },
      receipts: {
        count: receipts.length,
        paths: receipts.slice(0, 20),
      },
      canaryReadiness: {
        contextPackMatrix: await buildContextPackCanaryReadinessMatrix(),
        targetCompletionMatrix,
        issueLinkedSucceededRuns: issueLinkedSucceededRuns.size,
        completedIssuesWithLedger: new Set(
          ledgerEntries
            .map((entry) => entry.issueId)
            .filter((issueId): issueId is string => Boolean(issueId && completedIssueById.has(issueId))),
        ).size,
        completedIssueRunsWithReceipts: completedIssueRuns.filter((candidate) => candidate.receiptPaths.length > 0).length,
        completedIssueRunsWithTests: completedIssueRuns.filter((candidate) =>
          candidate.testCounts.passed > 0 && candidate.testCounts.failed === 0,
        ).length,
        completedIssueRunsWithChangedFiles: completedIssueRuns.filter((candidate) => candidate.changedFiles.length > 0).length,
        completedIssueRunsWithContextPacks: completedIssueRuns.filter((candidate) => candidate.contextPackRefs.length > 0).length,
        providerReroutedSuccesses: providerReroutedSuccesses.length,
        promptSloViolations: promptSloViolationEntries.length,
        outputSloViolations: outputSloViolationEntries.length,
        readyCount: readyCanaries.length,
        examples: readyCanaries.slice(0, 10).map((candidate) => ({
          runId: candidate.run.id,
          issueId: candidate.issueId,
          issueIdentifier: candidate.issue?.identifier ?? null,
          issueStatus: candidate.issue?.status ?? null,
          promptClass: uniqueStrings(candidate.entries.map((entry) => entry.promptClass)),
          adapterType: uniqueStrings(candidate.entries.map((entry) => entry.adapterType)),
          budgetStatus: uniqueStrings(candidate.entries.map((entry) => entry.budgetStatus)),
          receiptPaths: candidate.receiptPaths.slice(0, 5),
          testsPassed: candidate.testCounts.passed,
          testsFailed: candidate.testCounts.failed,
          changedFiles: candidate.changedFiles.slice(0, 10),
          contextPackRefs: candidate.contextPackRefs.slice(0, 5),
          providerGate: candidate.providerGate,
        })),
        missing: issueLinkedSucceeded
          .filter((candidate) => candidate.missing.length > 0)
          .slice(0, 20)
          .map((candidate) => ({
            runId: candidate.run.id,
            issueId: candidate.issueId,
            issueIdentifier: candidate.issue?.identifier ?? null,
            issueStatus: candidate.issue?.status ?? null,
            missing: candidate.missing,
          })),
      },
      tests,
      prsResolved: null,
      generatedAt: new Date().toISOString(),
    };
  }

  async function persistHourlyReports(opts: { now?: Date; source?: "scheduler" | "startup" | "manual" } = {}) {
    const source = opts.source ?? "scheduler";
    const windowEnd = floorToHour(opts.now ?? new Date());
    const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);
    const companyRows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, "active"));

    const reports = [];
    for (const company of companyRows) {
      const report = await summarize(company.id, { now: windowEnd, windowHours: 1 });
      const [stored] = await db
        .insert(flywheelHealthReports)
        .values({
          companyId: company.id,
          windowStart,
          windowEnd,
          windowHours: 1,
          source,
          reportJson: report,
          tasksAttempted: report.tasksAttempted,
          tasksCompleted: report.tasksCompleted,
          providerFailureCount: report.providerFailures.count,
          ledgerCompletenessPercent: readPercent(report.ledgerCompleteness),
          artifactCoveragePercent: readPercent(report.artifactCoverage),
          receiptsProduced: report.receipts.count,
          testsPassed: report.tests.passed,
          testsFailed: report.tests.failed,
          generatedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            flywheelHealthReports.companyId,
            flywheelHealthReports.windowStart,
            flywheelHealthReports.windowEnd,
          ],
          set: {
            source,
            reportJson: report,
            tasksAttempted: report.tasksAttempted,
            tasksCompleted: report.tasksCompleted,
            providerFailureCount: report.providerFailures.count,
            ledgerCompletenessPercent: readPercent(report.ledgerCompleteness),
            artifactCoveragePercent: readPercent(report.artifactCoverage),
            receiptsProduced: report.receipts.count,
            testsPassed: report.tests.passed,
            testsFailed: report.tests.failed,
            generatedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (stored) reports.push(stored);
    }

    return {
      source,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      companies: companyRows.length,
      reportsWritten: reports.length,
      reports,
    };
  }

  async function listReports(companyId: string, opts: { limit?: number } = {}) {
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(100, Math.floor(opts.limit)))
        : 24;
    return db
      .select()
      .from(flywheelHealthReports)
      .where(eq(flywheelHealthReports.companyId, companyId))
      .orderBy(desc(flywheelHealthReports.windowEnd))
      .limit(limit);
  }

  return {
    listReports,
    persistHourlyReports,
    summarize,
  };
}
