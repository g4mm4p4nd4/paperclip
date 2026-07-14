#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_DETECTORS = Object.freeze([
  ["openai_like", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g],
  ["github_like", /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ["google_like", /AIza[A-Za-z0-9_-]{20,}/g],
  ["slack_like", /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["aws_access_key_like", /AKIA[A-Z0-9]{16}/g],
  ["jwt_like", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["private_key_header", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value) {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function pathIsInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function scanText(text, metadata = {}) {
  const findings = [];
  for (const [detector, source] of SECRET_DETECTORS) {
    const pattern = new RegExp(source.source, source.flags);
    for (const match of text.matchAll(pattern)) {
      const offset = match.index ?? 0;
      findings.push({
        ...metadata,
        detector,
        line: text.slice(0, offset).split("\n").length,
        matchDigest: sha256(match[0]),
      });
    }
  }
  return findings;
}

function readScannableFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const value = readFileSync(path);
  if (value.subarray(0, Math.min(value.length, 8192)).includes(0)) return null;
  return value.toString("utf8");
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding === "buffer" ? null : (options.encoding ?? "utf8"),
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveReviewScopes(repo, policy) {
  return policy.reviewedGitScopes
    .filter((scope) => scope.repository === repo.name)
    .map((scope) => {
      const actualObjectId = git(repo.root, ["rev-parse", `HEAD:${scope.path}`]).trim();
      if (actualObjectId !== scope.objectId) {
        throw new Error(`reviewed_git_scope_drift:${repo.name}:${scope.path}`);
      }
      return { ...scope, actualObjectId, currentMatchDigests: new Set() };
    });
}

function matchingReviewScope(scopes, path) {
  return scopes.find((scope) => pathIsInside(path, scope.path)) ?? null;
}

function scanGitHead(repo, scopes) {
  const files = git(repo.root, ["ls-files", "-z"], { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const findings = [];
  let scannedFiles = 0;
  for (const rawPath of files) {
    const path = normalizeRelativePath(rawPath);
    const text = readScannableFile(join(repo.root, path));
    if (text === null) continue;
    scannedFiles += 1;
    const fileFindings = scanText(text, {
      scope: "git_head",
      repository: repo.name,
      revision: repo.head,
      path,
    });
    const review = matchingReviewScope(scopes, path);
    for (const finding of fileFindings) {
      if (review) review.currentMatchDigests.add(`${finding.detector}:${finding.matchDigest}`);
      findings.push({ ...finding, disposition: review ? review.disposition : "unsuppressed", reviewId: review?.id ?? null });
    }
  }
  return { scannedFiles, findings };
}

function changedPathsAtCommit(repoRoot, commit) {
  return git(repoRoot, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit], { encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath);
}

function resolveHistoricalReviews(repo, policy) {
  return (policy.reviewedHistoricalBlobs ?? [])
    .filter((review) => review.repository === repo.name)
    .map((review) => {
      const actualObjectId = git(repo.root, ["rev-parse", `${review.revision}:${review.path}`]).trim();
      if (actualObjectId !== review.objectId) {
        throw new Error(`reviewed_historical_blob_drift:${repo.name}:${review.revision}:${review.path}`);
      }
      return review;
    });
}

function scanGitHistory(repo, scopes, historicalReviews) {
  const commits = git(repo.root, ["rev-list", "--reverse", `${repo.historyBase}..${repo.head}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  const findings = [];
  let scannedBlobs = 0;
  for (const commit of commits) {
    for (const path of changedPathsAtCommit(repo.root, commit)) {
      let text;
      try {
        text = git(repo.root, ["show", `${commit}:${path}`]);
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      scannedBlobs += 1;
      const review = matchingReviewScope(scopes, path);
      const historicalReview = historicalReviews.find((candidate) => candidate.revision === commit && candidate.path === path) ?? null;
      for (const finding of scanText(text, {
        scope: "git_task_history",
        repository: repo.name,
        revision: commit,
        path,
      })) {
        const exactReviewedFixture = review?.currentMatchDigests.has(`${finding.detector}:${finding.matchDigest}`) ?? false;
        findings.push({
          ...finding,
          disposition: historicalReview?.disposition ?? (exactReviewedFixture ? review.disposition : "unsuppressed"),
          reviewId: historicalReview?.id ?? (exactReviewedFixture ? review.id : null),
        });
      }
    }
  }
  return { commits: commits.length, scannedBlobs, findings };
}

function walkFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result.sort();
}

function scanRuntimeRoot(runtime, policy) {
  const reviews = policy.reviewedRuntimeFiles.filter((review) => review.runtimeRoot === runtime.name);
  const findings = [];
  let scannedFiles = 0;
  for (const path of walkFiles(runtime.root)) {
    const text = readScannableFile(path);
    if (text === null) continue;
    scannedFiles += 1;
    const rel = normalizeRelativePath(relative(runtime.root, path));
    const review = reviews.find((candidate) => candidate.path === rel) ?? null;
    if (review && sha256(readFileSync(path)) !== review.sha256) {
      throw new Error(`reviewed_runtime_file_drift:${runtime.name}:${rel}`);
    }
    for (const finding of scanText(text, { scope: "runtime", runtimeRoot: runtime.name, path: rel })) {
      findings.push({
        ...finding,
        disposition: review ? review.disposition : "unsuppressed",
        reviewId: review?.id ?? null,
      });
    }
  }
  return { scannedFiles, findings };
}

function publicFinding(finding) {
  const { matchDigest: _matchDigest, ...safe } = finding;
  return safe;
}

function countsBy(values, key) {
  const counts = {};
  for (const value of values) counts[value[key]] = (counts[value[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildAuditReceipt({ policy, repositories, runtimeRoots, generatedAt = new Date().toISOString() }) {
  const allFindings = [];
  const repositoryResults = [];
  for (const repo of repositories) {
    const head = git(repo.root, ["rev-parse", "HEAD"]).trim();
    const normalized = { ...repo, head };
    const scopes = resolveReviewScopes(normalized, policy);
    const historicalReviews = resolveHistoricalReviews(normalized, policy);
    const headResult = scanGitHead(normalized, scopes);
    const historyResult = scanGitHistory(normalized, scopes, historicalReviews);
    allFindings.push(...headResult.findings, ...historyResult.findings);
    repositoryResults.push({
      name: repo.name,
      root: repo.root,
      head,
      historyBase: repo.historyBase,
      scannedHeadFiles: headResult.scannedFiles,
      scannedTaskCommits: historyResult.commits,
      scannedTaskBlobs: historyResult.scannedBlobs,
      findings: headResult.findings.length + historyResult.findings.length,
    });
  }

  const runtimeResults = [];
  for (const runtime of runtimeRoots) {
    const result = scanRuntimeRoot(runtime, policy);
    allFindings.push(...result.findings);
    runtimeResults.push({ name: runtime.name, root: runtime.root, scannedFiles: result.scannedFiles, findings: result.findings.length });
  }

  const unsuppressed = allFindings.filter((finding) => finding.disposition === "unsuppressed");
  const receipt = {
    schemaVersion: "paperclip.profit_flywheel_secret_audit.v1",
    generatedAt,
    status: unsuppressed.length === 0 ? "verified" : "blocked",
    policyVersion: policy.schemaVersion,
    repositories: repositoryResults,
    runtimeRoots: runtimeResults,
    summary: {
      findings: allFindings.length,
      reviewedNonSecrets: allFindings.length - unsuppressed.length,
      unsuppressed: unsuppressed.length,
      byDetector: countsBy(allFindings, "detector"),
      byDisposition: countsBy(allFindings, "disposition"),
    },
    unsuppressedFindings: unsuppressed.map(publicFinding),
    guarantees: {
      rawMatchedValuesPersisted: false,
      reviewedGitScopesPinnedToObjectIds: true,
      implicitHistoricalSuppressionsRequireCurrentExactMatch: true,
      explicitHistoricalReviewsPinnedToRevisionAndObjectId: true,
      reviewedRuntimeFilesPinnedToSha256: true,
    },
  };
  receipt.payloadSha256 = sha256(`${JSON.stringify(receipt)}\n`);
  return receipt;
}

function parseNamedPath(value, flag) {
  const split = value.indexOf("=");
  if (split <= 0 || split === value.length - 1) throw new Error(`${flag}_must_be_name_equals_path`);
  return { name: value.slice(0, split), root: resolve(value.slice(split + 1)) };
}

export function parseArgs(argv) {
  const parsed = { repositories: [], runtimeRoots: [], policyPath: null, receiptDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const value = argv[index + 1];
    if (["--policy", "--receipt-dir", "--repo", "--runtime-root"].includes(flag) && !value) throw new Error(`missing_value:${flag}`);
    if (flag === "--policy") parsed.policyPath = resolve(value);
    else if (flag === "--receipt-dir") parsed.receiptDir = resolve(value);
    else if (flag === "--repo") parsed.repositories.push(parseNamedPath(value, "repo"));
    else if (flag === "--runtime-root") parsed.runtimeRoots.push(parseNamedPath(value, "runtime_root"));
    else throw new Error(`unknown_argument:${flag}`);
    index += 1;
  }
  if (!parsed.policyPath || !parsed.receiptDir || parsed.repositories.length === 0) throw new Error("policy_receipt_dir_and_repo_required");
  return parsed;
}

function writeImmutableReceipt(receiptDir, receipt) {
  mkdirSync(receiptDir, { recursive: true });
  const timestamp = receipt.generatedAt.replace(/[-:.]/g, "");
  const path = join(receiptDir, `${timestamp}-profit-flywheel-secret-audit.json`);
  if (existsSync(path)) throw new Error(`receipt_exists:${path}`);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o444);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(args.policyPath, "utf8"));
  const bases = new Map(policy.repositories.map((repo) => [repo.name, repo.historyBase]));
  const repositories = args.repositories.map((repo) => {
    const historyBase = bases.get(repo.name);
    if (!historyBase) throw new Error(`missing_history_base:${repo.name}`);
    return { ...repo, historyBase };
  });
  const receipt = buildAuditReceipt({ policy, repositories, runtimeRoots: args.runtimeRoots });
  const path = writeImmutableReceipt(args.receiptDir, receipt);
  console.log(JSON.stringify({ status: receipt.status, receiptPath: path, payloadSha256: receipt.payloadSha256, summary: receipt.summary }));
  process.exit(receipt.status === "verified" ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
