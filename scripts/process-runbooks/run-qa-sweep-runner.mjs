#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STRUCTURED_RESULT_MARKER = "PAPERCLIP_ADAPTER_RESULT_JSON=";
const apiBase = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY || "";
const issueId = process.env.PAPERCLIP_ISSUE_ID || process.env.PAPERCLIP_TASK_ID || "";
const gstackDir = process.env.GSTACK_DIR || "/Users/mnm/Documents/Github/gstack";
const portfolioOsDir = process.env.PORTFOLIO_OS_DIR || "/Users/mnm/Documents/Github/portfolio-os";
const gstackQaBin = process.env.RUN_QA_SWEEP_GSTACK_BIN || path.join(gstackDir, "bin/gstack-pos-build-qa");
const browserMode = process.env.RUN_QA_SWEEP_BROWSER_MODE || "playwright";
const writeDocs = process.env.RUN_QA_SWEEP_WRITE_DOCS !== "0";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
  "base64",
);

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
    summary: `Run QA Sweep process failed before issue update: ${message}`,
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("gstack QA command returned no stdout JSON");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) return JSON.parse(text.slice(start + 1));
    const first = text.indexOf("{");
    if (first >= 0) return JSON.parse(text.slice(first));
    throw new Error(`gstack QA command stdout was not JSON: ${tailText(text, 500)}`);
  }
}

function shellCommand(command, args) {
  return [command, ...args].map((part) => {
    const text = String(part);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}

function runGstackQaArtifact(artifactPath, outputPath) {
  const args = ["--bundle", artifactPath];
  if (outputPath) args.push("--output", outputPath);
  const startedAt = Date.now();
  const result = spawnSync(gstackQaBin, args, {
    cwd: gstackDir,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const command = shellCommand(gstackQaBin, args);
  const output = {
    command,
    cwd: gstackDir,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
  if (result.error) {
    throw new Error(`gstack QA artifact command failed to launch: ${result.error.message}`);
  }
  if (output.exitCode !== 0) {
    throw new Error(`gstack QA artifact command failed with exit ${output.exitCode}: ${tailText(output.stderr || output.stdout, 1200)}`);
  }
  const parsed = parseJsonFromStdout(output.stdout);
  const artifact = parsed?.artifact && typeof parsed.artifact === "object" && !Array.isArray(parsed.artifact)
    ? parsed.artifact
    : parsed?.artifact_path
      ? readJson(String(parsed.artifact_path))
      : null;
  if (!artifact) throw new Error("gstack QA artifact command did not return an artifact payload or artifact_path");
  return {
    command: output,
    artifactPath: readText(parsed.artifact_path) ?? outputPath ?? null,
    artifact,
  };
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    if (existsSync(absolute)) return absolute;
  }
  return readText(candidates.find(Boolean)) ? path.resolve(String(candidates.find(Boolean))) : null;
}

function resolveArtifactPath({ description, contract, runId }) {
  const candidates = [
    process.env.RUN_QA_SWEEP_ARTIFACT_PATH,
    readText(contract.source_dispatch_path),
    readText(contract.sourceDispatchPath),
    extractLine(description, "Primary artifact"),
    extractLine(description, "Dispatch file"),
    readText(contract.selection_snapshot_path),
    readText(contract.selectionSnapshotPath),
    extractLine(description, "Selection snapshot"),
    runId ? path.join(portfolioOsDir, "data/dispatch/outbox", `dispatch_${runId}.json`) : null,
  ];
  const artifactPath = firstExisting(candidates);
  if (!artifactPath) throw new Error("dispatch or selection snapshot artifact path missing from issue contract");
  if (!existsSync(artifactPath)) throw new Error(`dispatch or selection snapshot artifact does not exist: ${artifactPath}`);
  return artifactPath;
}

function resolveTargetUrl({ contract, description, qaArtifact }) {
  const localCandidate = Array.isArray(qaArtifact.local_html_candidates)
    ? qaArtifact.local_html_candidates.find((candidate) => readText(candidate) && existsSync(String(candidate)))
    : null;
  if (localCandidate) {
    return {
      kind: "local_html",
      source: String(localCandidate),
      url: pathToFileURL(path.resolve(String(localCandidate))).href,
    };
  }
  const explicitUrl =
    readText(process.env.RUN_QA_SWEEP_TARGET_URL) ??
    readText(contract.target_app_url) ??
    readText(contract.targetUrl) ??
    extractLine(description, "Target URL") ??
    extractLine(description, "App URL") ??
    extractLine(description, "Run URL");
  if (explicitUrl) {
    return {
      kind: "url",
      source: explicitUrl,
      url: explicitUrl,
    };
  }
  return null;
}

function blockerFinding(id, severity, message) {
  return { id, severity, message };
}

async function runStubBrowserChecks({ target, qaArtifact }) {
  const screenshotsDir = String(qaArtifact.screenshots_dir || "");
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true });
  const screenshots = [];
  for (const viewport of ["desktop", "mobile"]) {
    const screenshotPath = path.join(screenshotsDir || process.cwd(), `${viewport}.png`);
    writeFileSync(screenshotPath, ONE_BY_ONE_PNG);
    screenshots.push({ viewport, path: screenshotPath });
  }
  return {
    status: "passed",
    target,
    findings: [],
    screenshots,
    consoleErrors: [],
    checks: [
      { id: "stub-browser-check", status: "pass", reason: "RUN_QA_SWEEP_BROWSER_MODE=stub" },
    ],
  };
}

async function runPlaywrightChecks({ target, qaArtifact }) {
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    return {
      status: "blocked",
      target,
      findings: [
        blockerFinding("playwright-import", "critical", `@playwright/test is unavailable: ${error instanceof Error ? error.message : String(error)}`),
      ],
      screenshots: [],
      consoleErrors: [],
      checks: [{ id: "playwright-import", status: "blocked" }],
    };
  }

  const screenshotsDir = String(qaArtifact.screenshots_dir || "");
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true });
  const findings = [];
  const screenshots = [];
  const consoleErrors = [];
  const checks = [];
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return {
      status: "blocked",
      target,
      findings: [
        blockerFinding(
          "playwright-browser",
          "critical",
          `Playwright Chromium is unavailable: ${error instanceof Error ? error.message : String(error)}. Run npx playwright install chromium from the Paperclip repo.`,
        ),
      ],
      screenshots,
      consoleErrors,
      checks: [{ id: "playwright-browser", status: "blocked" }],
    };
  }

  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.name === "mobile" ? 2 : 1,
      });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push({ viewport: viewport.name, text: message.text() });
        }
      });
      page.on("pageerror", (error) => {
        consoleErrors.push({ viewport: viewport.name, text: error.message });
      });
      let loaded = false;
      try {
        await page.goto(target.url, { waitUntil: "networkidle", timeout: 20_000 });
        loaded = true;
      } catch (error) {
        findings.push(blockerFinding(
          `load-${viewport.name}`,
          "critical",
          `Failed to load ${target.source} at ${viewport.name}: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
      const screenshotPath = path.join(screenshotsDir || process.cwd(), `${viewport.name}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshots.push({ viewport: viewport.name, path: screenshotPath });
      } catch (error) {
        findings.push(blockerFinding(
          `screenshot-${viewport.name}`,
          "high",
          `Failed to capture ${viewport.name} screenshot: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
      if (loaded) {
        const metrics = await page.evaluate(() => {
          const visibleText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
          const visible = (el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const anchors = Array.from(document.querySelectorAll("a"));
          const buttons = Array.from(document.querySelectorAll("button"));
          const forms = Array.from(document.querySelectorAll("form"));
          const ctas = [...anchors, ...buttons]
            .filter(visible)
            .map((el) => (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .slice(0, 12);
          const deadLinks = anchors
            .map((anchor) => anchor.getAttribute("href") || "")
            .filter((href) => !href || href === "#" || href.toLowerCase().startsWith("javascript:"))
            .length;
          const images = Array.from(document.images);
          const missingImages = images.filter((image) => !image.complete || image.naturalWidth === 0).length;
          return {
            title: document.title || null,
            bodyTextLength: visibleText.length,
            visibleTextSample: visibleText.slice(0, 500),
            anchorCount: anchors.length,
            buttonCount: buttons.length,
            formCount: forms.length,
            ctas,
            deadLinks,
            imageCount: images.length,
            missingImages,
          };
        });
        checks.push({ id: `surface-${viewport.name}`, status: "pass", metrics });
        if (metrics.bodyTextLength < 100) {
          findings.push(blockerFinding(`body-copy-${viewport.name}`, "high", `${viewport.name} page has very little visible text (${metrics.bodyTextLength} characters).`));
        }
        if (metrics.ctas.length === 0) {
          findings.push(blockerFinding(`cta-${viewport.name}`, "high", `${viewport.name} page has no visible link or button CTA.`));
        }
        if (metrics.deadLinks > 0) {
          findings.push(blockerFinding(`dead-links-${viewport.name}`, "medium", `${viewport.name} page has ${metrics.deadLinks} empty, hash-only, or javascript links.`));
        }
        if (metrics.missingImages > 0) {
          findings.push(blockerFinding(`missing-images-${viewport.name}`, "high", `${viewport.name} page has ${metrics.missingImages} missing image assets.`));
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  for (const error of consoleErrors.slice(0, 10)) {
    findings.push(blockerFinding(`console-${error.viewport}`, "medium", `${error.viewport} console error: ${error.text}`));
  }

  const hasBlockingFindings = findings.some((finding) => finding.severity === "critical" || finding.severity === "high");
  return {
    status: hasBlockingFindings ? "failed" : "passed",
    target,
    findings,
    screenshots,
    consoleErrors,
    checks,
  };
}

async function runBrowserChecks(input) {
  if (!input.target) {
    return {
      status: "blocked",
      target: null,
      findings: [
        blockerFinding("target-surface", "critical", "No local HTML candidate or explicit target URL was available for the QA sweep."),
      ],
      screenshots: [],
      consoleErrors: [],
      checks: [{ id: "target-surface", status: "blocked" }],
    };
  }
  if (browserMode === "stub") return runStubBrowserChecks(input);
  return runPlaywrightChecks(input);
}

function renderReport(input) {
  const {
    issue,
    runId,
    statusAction,
    artifactPath,
    qaArtifactPath,
    qaArtifact,
    browser,
    gstackCommand,
  } = input;
  const internetPipes = qaArtifact.internet_pipes || {};
  return [
    `# Run QA Sweep ${runId}`,
    "",
    `Issue: ${issue.identifier || issue.id}`,
    `Issue action: ${statusAction}`,
    `Source artifact: ${artifactPath}`,
    `QA verification artifact: ${qaArtifactPath || "not written"}`,
    `Target tested: ${browser.target?.source || "none"}`,
    `Browser status: ${browser.status}`,
    `QA artifact status: ${qaArtifact.status || "unknown"}`,
    "",
    "## Internet Pipes",
    "",
    "```json",
    JSON.stringify(internetPipes, null, 2),
    "```",
    "",
    "## Screenshots",
    "",
    ...(browser.screenshots.length > 0
      ? browser.screenshots.map((screenshot) => `- ${screenshot.viewport}: ${screenshot.path}`)
      : ["- none"]),
    "",
    "## Findings",
    "",
    ...(browser.findings.length > 0
      ? browser.findings.map((finding) => `- ${finding.severity}: ${finding.id} - ${finding.message}`)
      : ["- No blocking findings in the bounded QA sweep."]),
    "",
    "## Browser Checks",
    "",
    "```json",
    JSON.stringify(browser.checks, null, 2),
    "```",
    "",
    "## GStack Artifact Command",
    "",
    "```json",
    JSON.stringify({
      command: gstackCommand.command,
      cwd: gstackCommand.cwd,
      exitCode: gstackCommand.exitCode,
      signal: gstackCommand.signal,
      durationMs: gstackCommand.durationMs,
    }, null, 2),
    "```",
    "",
  ].join("\n");
}

function renderRegressionNotes(input) {
  const { runId, statusAction, browser, qaArtifact } = input;
  return [
    `# Regression Notes ${runId}`,
    "",
    `Status: ${statusAction}`,
    `QA artifact status: ${qaArtifact.status || "unknown"}`,
    `Target: ${browser.target?.source || "none"}`,
    "",
    "## Blocking Findings",
    "",
    ...(browser.findings.length > 0
      ? browser.findings.map((finding) => `- ${finding.severity}: ${finding.message}`)
      : ["- None found by the bounded browser sweep."]),
    "",
    "## Next Action",
    "",
    statusAction === "done"
      ? "- Ready for release-gate evaluation from this QA station."
      : "- Keep the run out of release until the blockers above are resolved and the QA sweep is rerun.",
    "",
  ].join("\n");
}

function issueMarkdownLink(issue) {
  const identifier = readText(issue.identifier);
  if (!identifier) return issue.id || "issue";
  const prefix = identifier.split("-")[0] || identifier;
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

function statusComment(input) {
  const {
    issue,
    runId,
    statusAction,
    qaArtifact,
    browser,
    reportPath,
    regressionNotesPath,
    qaArtifactPath,
  } = input;
  const issueRef = issueMarkdownLink(issue);
  const heading = statusAction === "done" ? "Run QA Sweep Complete" : "Run QA Sweep Blocked";
  return [
    `## ${heading}`,
    "",
    `${issueRef} ${statusAction === "done" ? "passed" : "was blocked by"} the deterministic POS QA sweep for run ${runId}.`,
    "",
    `- QA artifact status: ${qaArtifact.status || "unknown"}`,
    `- Browser status: ${browser.status}`,
    `- Target tested: ${browser.target?.source || "none"}`,
    `- Blocking findings: ${browser.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length}`,
    `- QA verification artifact: ${qaArtifactPath || "not written"}`,
    `- QA report: ${reportPath || "not written"}`,
    `- Regression notes: ${regressionNotesPath || "not written"}`,
    `- Screenshots: ${browser.screenshots.map((screenshot) => screenshot.path).join(", ") || "none"}`,
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");
}

async function main() {
  requireEnv();

  const issue = normalizeIssueResponse(await apiJson("GET", `/api/issues/${issueId}`));
  const description = issue.description || "";
  const contract = extractContract(description);
  const runId =
    readText(contract.run_id) ??
    readText(contract.runId) ??
    process.env.DISPATCH_RUN_ID ??
    process.env.PAPERCLIP_RUN_ID ??
    "unknown";
  const artifactPath = resolveArtifactPath({ description, contract, runId });
  const outputPath = readText(process.env.RUN_QA_SWEEP_OUTPUT_PATH) ?? readText(contract.qa_verification_path);
  const qa = runGstackQaArtifact(artifactPath, outputPath);
  const qaArtifact = qa.artifact;
  const target = resolveTargetUrl({ contract, description, qaArtifact });
  const browser = await runBrowserChecks({ target, qaArtifact });
  const qaBlocksRelease = qaArtifact.status !== "ready_for_qa";
  const browserBlocksRelease = browser.status !== "passed";
  const statusAction = !qaBlocksRelease && !browserBlocksRelease ? "done" : "blocked";

  let reportPath = null;
  let regressionNotesPath = null;
  if (writeDocs) {
    const qaReportPath = readText(qaArtifact.qa_report_path);
    const regressionPath = readText(qaArtifact.regression_notes_path);
    if (qaReportPath) {
      mkdirSync(path.dirname(qaReportPath), { recursive: true });
      reportPath = qaReportPath;
      writeFileSync(reportPath, renderReport({
        issue,
        runId,
        statusAction,
        artifactPath,
        qaArtifactPath: qa.artifactPath,
        qaArtifact,
        browser,
        gstackCommand: qa.command,
      }));
    }
    if (regressionPath) {
      mkdirSync(path.dirname(regressionPath), { recursive: true });
      regressionNotesPath = regressionPath;
      writeFileSync(regressionNotesPath, renderRegressionNotes({
        runId,
        statusAction,
        qaArtifact,
        browser,
      }));
    }
  }

  const comment = statusComment({
    issue,
    runId,
    statusAction,
    qaArtifact,
    browser,
    reportPath,
    regressionNotesPath,
    qaArtifactPath: qa.artifactPath,
  });
  await apiJson("PATCH", `/api/issues/${issueId}`, { status: statusAction, comment });

  const summary = [
    `Run QA Sweep process ${statusAction === "done" ? "complete" : "blocked"} for ${issue.identifier || issue.id} (${runId}).`,
    `- QA artifact status: ${qaArtifact.status || "unknown"}`,
    `- Browser status: ${browser.status}`,
    `- Target tested: ${browser.target?.source || "none"}`,
    `- Blocking findings: ${browser.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length}`,
    ...(reportPath ? [`- QA report: ${reportPath}`] : []),
    ...(regressionNotesPath ? [`- Regression notes: ${regressionNotesPath}`] : []),
    "- Provider tokens: 0 (process adapter deterministic runbook).",
  ].join("\n");

  const result = {
    summary,
    runId,
    issueId,
    identifier: issue.identifier ?? null,
    statusAction,
    artifactPath,
    qaArtifactPath: qa.artifactPath,
    qaArtifactStatus: qaArtifact.status ?? null,
    target,
    browser,
    reportPath,
    regressionNotesPath,
    commands: {
      gstackQaArtifact: qa.command,
    },
    providerTokensSpent: 0,
  };
  console.log(`${STRUCTURED_RESULT_MARKER}${JSON.stringify(result)}`);
  if (statusAction === "blocked") process.exitCode = 2;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
