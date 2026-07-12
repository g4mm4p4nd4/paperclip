import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  budgetPromptSections,
  buildPaperclipPromptMetrics,
  PAPERCLIP_OUTPUT_BUDGET_VERSION,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  describeToolOutputBudgetViolation,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  ensurePathInEnv,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveCommandForLogs,
  resolvePaperclipPromptClass,
  resolvePaperclipRuntimeSkillCandidateNames,
  removeMaintainerOnlySkillSymlinks,
  parseObject,
  renderTemplate,
  renderPaperclipContextEconomyPrompt,
  renderPaperclipOutputContract,
  renderPaperclipRequestShapingPrompt,
  renderPaperclipSessionDeltaPrompt,
  renderPaperclipWakePrompt,
  resolvePaperclipRequestShaping,
  resolvePaperclipSessionContinuity,
  resolveToolOutputBudget,
  buildPaperclipSessionParams,
  stringifyPaperclipWakePayload,
  runChildProcess,
  selectPaperclipRuntimeSkillsForRun,
  assertPolicyOwnedAdapterConfigIsConflictFree,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";
import {
  describeGeminiFailure,
  detectGeminiAuthRequired,
  isGeminiTurnLimitResult,
  isGeminiUnknownSessionError,
  parseGeminiJsonl,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import { createGeminiStderrNoiseFilter, stripGeminiStderrNoise } from "./noise.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const GEMINI_LOCAL_ADAPTER_VERSION = "0.3.1";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
}

function defaultGeminiSystemSettingsPath() {
  if (process.platform === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  if (process.platform === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  return "/etc/gemini-cli/settings.json";
}

async function prepareGeminiMaxTurnsSettings(
  env: Record<string, string>,
  maxTurns: number,
  inheritParentEnv: boolean,
) {
  if (maxTurns <= 0) return null;
  const sourcePath = path.resolve(
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
    (inheritParentEnv ? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH : undefined) ||
    defaultGeminiSystemSettingsPath(),
  );
  let source: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Gemini system settings must contain a JSON object");
    }
    source = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-settings-"));
  const settingsPath = path.join(root, "settings.json");
  const model = parseObject(source.model);
  await fs.writeFile(settingsPath, `${JSON.stringify({
    ...source,
    model: { ...model, maxSessionTurns: maxTurns },
  })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
  return { root, settingsPath };
}

function prefersSubscriptionAuth(config: Record<string, unknown>): boolean {
  const authMode = asString(config.authMode, asString(config.billingMode, "")).trim().toLowerCase();
  return authMode === "subscription" || asBoolean(config.preferSubscriptionAuth, false);
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use run_shell_command with curl to make Paperclip API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" \\"$PAPERCLIP_API_URL/api/agents/me\\"" })`,
    "POST/PATCH example:",
    `  run_shell_command({ command: "curl -s -X POST -H \\"Authorization: Bearer $PAPERCLIP_API_KEY\\" -H 'Content-Type: application/json' -H \\"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\\" -d '{...}' \\"$PAPERCLIP_API_URL/api/issues/{id}/checkout\\"" })`,
    "",
    "",
  ].join("\n");
}

/**
 * Inject Paperclip skills directly into `~/.gemini/skills/` via symlinks.
 * This avoids needing GEMINI_CLI_HOME overrides, so the CLI naturally finds
 * both its auth credentials and the injected skills in the real home directory.
 */
async function ensureGeminiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsHome: string,
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Gemini skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Gemini skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  const selectedRuntimeNames = new Set(selectedEntries.map((entry) => entry.runtimeName));
  const availableByRuntimeName = new Map(skillsEntries.map((entry) => [entry.runtimeName, entry]));
  const installed = await readInstalledSkillTargets(skillsHome);
  for (const [name, installedEntry] of installed.entries()) {
    if (selectedRuntimeNames.has(name)) continue;
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (installedEntry.targetPath !== path.resolve(available.source)) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
    await onLog(
      "stderr",
      `[paperclip] Removed unselected Gemini skill: ${available.key}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Gemini skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Gemini skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  assertPolicyOwnedAdapterConfigIsConflictFree(config, "gemini_local");

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const envConfig = parseObject(config.env);
  const configuredHome = asString(envConfig.HOME, process.env.HOME ?? os.homedir());
  const skillsHome = path.join(path.resolve(configuredHome), ".gemini", "skills");
  const geminiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredGeminiSkillNames = resolvePaperclipRuntimeSkillCandidateNames(config, geminiSkillEntries);
  const skillSelection = selectPaperclipRuntimeSkillsForRun({
    config,
    identifiers: desiredGeminiSkillNames,
    agentName: agent.name,
    runtime,
    context,
  });
  await ensureGeminiSkillsInjected(onLog, skillsHome, geminiSkillEntries, skillSelection.selected);

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (prefersSubscriptionAuth(config)) {
    env.GEMINI_API_KEY = "";
    env.GOOGLE_API_KEY = "";
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const inheritParentEnv = !asBoolean(config.isolateParentEnvironment, false);
  const effectiveEnv = Object.fromEntries(
    Object.entries(inheritParentEnv ? { ...process.env, ...env } : env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveGeminiBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const baseContextMaxChars = Math.max(0, Math.trunc(asNumber(config.contextMaxChars, 0)));
  const baseOutputMaxChars = Math.max(0, Math.trunc(asNumber(config.outputMaxChars, 0)));
  const baseOutputMaxSentences = Math.max(0, Math.trunc(asNumber(config.outputMaxSentences, 0)));
  const maxTurns = Math.max(0, Math.trunc(asNumber(config.maxTurnsPerRun, 0)));
  const maxTotalTokens = Math.max(0, Math.trunc(asNumber(config.maxTotalTokens, 0)));
  const toolOutputBudget = resolveToolOutputBudget(config);
  const requestShaping = resolvePaperclipRequestShaping({
    config,
    context,
    baseContextMaxChars,
    baseOutputMaxChars,
    baseOutputMaxSentences,
  });
  const contextMaxChars = requestShaping.contextMaxChars;
  const outputMaxChars = requestShaping.outputMaxChars;
  const outputMaxSentences = requestShaping.outputMaxSentences;
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const sessionContinuity = resolvePaperclipSessionContinuity({
    config,
    context,
    runtimeSessionId,
    sessionParams: runtimeSessionParams,
    cwd,
    requestShaping,
  });
  const sessionId = sessionContinuity.sessionId;
  if (runtimeSessionId && !sessionId) {
    await onLog(
      "stdout",
      `[paperclip] Gemini session "${runtimeSessionId}" will not be resumed: ${sessionContinuity.reason}.\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  let commandNotes = (() => {
    const notes: string[] = ["Prompt is passed to Gemini via --prompt for non-interactive execution."];
    notes.push("Added --approval-mode yolo for unattended execution.");
    if (prefersSubscriptionAuth(config)) {
      notes.push("Using Gemini local subscription auth; inherited GEMINI_API_KEY and GOOGLE_API_KEY are stripped from the child process.");
    }
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
  })();

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePayloadPrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const wakePrompt =
    wakePayloadPrompt ||
    renderPaperclipSessionDeltaPrompt(context, { resumedSession: Boolean(sessionId), runId });
  const contextEconomyPrompt = renderPaperclipContextEconomyPrompt(context.paperclipContextEconomy);
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  if (shouldUseResumeDeltaPrompt && instructionsPrefix.length > 0) {
    commandNotes = commandNotes
      .filter((note) => !note.includes("Prepended instructions + path directive"))
      .concat("Skipped prompt instruction and runtime note reinjection because an existing Gemini session is being resumed with a wake delta.");
  }
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const paperclipWakeRecord = parseObject(context.paperclipWake);
  const paperclipWakeReason = asString(paperclipWakeRecord.reason, wakeReason ?? asString(context.wakeReason, ""));
  const promptClass = resolvePaperclipPromptClass({
    hasSession: Boolean(sessionId),
    wakeReason: paperclipWakeReason,
  });
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const requestShapingPrompt = renderPaperclipRequestShapingPrompt(requestShaping);
  const sessionHandoffNote = requestShaping.dropSessionHandoff
    ? ""
    : asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = shouldUseResumeDeltaPrompt ? "" : renderPaperclipEnvNote(env);
  const apiAccessNote = shouldUseResumeDeltaPrompt ? "" : renderApiAccessNote(env);
  const outputBudgetVersion = PAPERCLIP_OUTPUT_BUDGET_VERSION;
  const outputContractPrompt = renderPaperclipOutputContract({
    outputBudgetVersion,
    ...(outputMaxSentences > 0 ? { maxSentences: outputMaxSentences } : {}),
    ...(outputMaxChars > 0 ? {
      maxChars: outputMaxChars,
      maxOutputTokens: Math.max(1, Math.ceil(outputMaxChars / 4)),
    } : {}),
  });
  const budgetedPrompt = budgetPromptSections(
    [
      { name: "managed_agent_instructions", content: promptInstructionsPrefix, minChars: 1_000 },
      { name: "bootstrap_prompt", content: renderedBootstrapPrompt, minChars: 500 },
      { name: "paperclip_wake", content: wakePrompt, protected: true, minChars: 1_000 },
      { name: "request_shaping", content: requestShapingPrompt, protected: true, minChars: 500 },
      { name: "context_pack_manifest", content: contextEconomyPrompt, minChars: 500 },
      { name: "session_handoff", content: sessionHandoffNote, minChars: 500 },
      { name: "output_contract", content: outputContractPrompt, protected: true, minChars: 500 },
      { name: "runtime_note", content: joinPromptSections([paperclipEnvNote, apiAccessNote]), minChars: 500 },
      { name: "heartbeat_prompt", content: renderedPrompt, minChars: 500 },
    ],
    contextMaxChars,
  );
  const promptInstructionsPrefixBudgeted = budgetedPrompt.sections.managed_agent_instructions ?? "";
  const renderedBootstrapPromptBudgeted = budgetedPrompt.sections.bootstrap_prompt ?? "";
  const wakePromptBudgeted = budgetedPrompt.sections.paperclip_wake ?? "";
  const requestShapingPromptBudgeted = budgetedPrompt.sections.request_shaping ?? "";
  const contextEconomyPromptBudgeted = budgetedPrompt.sections.context_pack_manifest ?? "";
  const sessionHandoffNoteBudgeted = budgetedPrompt.sections.session_handoff ?? "";
  const outputContractPromptBudgeted = budgetedPrompt.sections.output_contract ?? "";
  const runtimeNoteBudgeted = budgetedPrompt.sections.runtime_note ?? "";
  const renderedPromptBudgeted = budgetedPrompt.sections.heartbeat_prompt ?? "";
  const prompt = budgetedPrompt.prompt;
  if (contextMaxChars > 0 && prompt.length > contextMaxChars) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "provider_context_budget_exceeded",
      errorMessage: `Gemini prompt ${prompt.length} chars exceeds the pinned ${contextMaxChars}-char provider budget after safe section truncation`,
      provider: "google",
      model,
      billingType,
      costUsd: null,
      summary: null,
      resultJson: null,
    };
  }
  const { promptBudgetVersion, promptMetrics, evidenceSliceCount } = buildPaperclipPromptMetrics({
    prompt,
    promptClass,
    outputBudgetVersion,
    baseMetrics: {
      instructionsChars: promptInstructionsPrefixBudgeted.length,
      bootstrapPromptChars: renderedBootstrapPromptBudgeted.length,
      wakePromptChars: wakePromptBudgeted.length,
      requestShapingPromptChars: requestShapingPromptBudgeted.length,
      requestShapingMode: requestShaping.mode,
      requestShapingReason: requestShaping.reason,
      requestShapingEnabled: requestShaping.enabled,
      requestShapingAllowSessionResume: requestShaping.allowSessionResume,
      requestShapingDroppedSessionHandoff: requestShaping.dropSessionHandoff,
      priorRunValueQuestion: requestShaping.priorRunValueQuestion,
      sessionResumeSuppressed: Boolean(runtimeSessionId && !sessionId),
      sessionResumeSuppressedReason: runtimeSessionId && !sessionId ? sessionContinuity.reason : null,
      sessionContinuityReason: sessionContinuity.reason,
      workIdentity: sessionContinuity.workIdentity,
      savedWorkIdentity: sessionContinuity.savedWorkIdentity,
      contextEconomyPromptChars: contextEconomyPromptBudgeted.length,
      sessionHandoffChars: sessionHandoffNoteBudgeted.length,
      outputContractChars: outputContractPromptBudgeted.length,
      runtimeNoteChars: runtimeNoteBudgeted.length,
      heartbeatPromptChars: renderedPromptBudgeted.length,
      contextMaxChars: contextMaxChars || null,
      promptTruncatedSections: budgetedPrompt.truncatedSections,
      skillBudget: skillSelection.metrics,
    },
    components: [
      {
        name: "managed_agent_instructions",
        content: promptInstructionsPrefixBudgeted,
        metadata: {
          sourcePath: instructionsFilePath || null,
          skippedOnResumeDelta: shouldUseResumeDeltaPrompt,
        },
      },
      {
        name: "bootstrap_prompt",
        content: renderedBootstrapPromptBudgeted,
        metadata: { templateConfigured: bootstrapPromptTemplate.trim().length > 0 },
      },
      {
        name: "paperclip_wake",
        componentType: "evidence_slice",
        content: wakePromptBudgeted,
        metadata: {
          reason: paperclipWakeReason || null,
          resumedSession: Boolean(sessionId),
        },
      },
      {
        name: "request_shaping",
        componentType: "control_contract",
        content: requestShapingPromptBudgeted,
        evidenceSliceCount: 0,
        metadata: {
          mode: requestShaping.mode,
          reason: requestShaping.reason,
          allowSessionResume: requestShaping.allowSessionResume,
          dropSessionHandoff: requestShaping.dropSessionHandoff,
        },
      },
      {
        name: "context_pack_manifest",
        componentType: "context_manifest",
        content: contextEconomyPromptBudgeted,
        metadata: { contextEconomy: context.paperclipContextEconomy ?? null },
      },
      {
        name: "session_handoff",
        componentType: "evidence_slice",
        content: sessionHandoffNoteBudgeted,
        metadata: { source: "paperclipSessionHandoffMarkdown" },
      },
      {
        name: "output_contract",
        content: outputContractPromptBudgeted,
        metadata: { outputBudgetVersion },
      },
      {
        name: "runtime_note",
        content: runtimeNoteBudgeted,
        metadata: { skippedOnResumeDelta: shouldUseResumeDeltaPrompt },
      },
      {
        name: "heartbeat_prompt",
        content: renderedPromptBudgeted,
        metadata: {
          templateConfigured: promptTemplate.trim().length > 0,
          skippedOnResumeDelta: shouldUseResumeDeltaPrompt,
        },
      },
    ],
  });

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
    args.push("--approval-mode", "yolo");
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "gemini_local",
        adapterVersion: GEMINI_LOCAL_ADAPTER_VERSION,
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: loggedEnv,
        prompt,
        promptClass,
        promptBudgetVersion,
        outputBudgetVersion,
        promptMetrics,
        evidenceSliceCount,
        runtimeProvenance: {
          adapterType: "gemini_local",
          adapterVersion: GEMINI_LOCAL_ADAPTER_VERSION,
          promptBudgetVersion,
          outputBudgetVersion,
        },
        context,
      });
    }

    const stderrNoiseFilter = createGeminiStderrNoiseFilter();
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      inheritParentEnv,
      toolOutputBudget,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stderrNoiseFilter.push(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripGeminiStderrNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseGeminiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: RunProcessResult;
      rawStderr: string;
      parsed: ReturnType<typeof parseGeminiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectGeminiAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "gemini_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    if (attempt.proc.toolOutputBudgetViolation) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: describeToolOutputBudgetViolation(attempt.proc.toolOutputBudgetViolation),
        errorCode: "provider_tool_output_budget_exceeded",
        usage: attempt.parsed.usage,
        provider: "google",
        biller: "google",
        model,
        billingType,
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          toolOutputBudgetViolation: attempt.proc.toolOutputBudgetViolation,
        },
        summary: attempt.parsed.summary,
        clearSession: true,
      };
    }

    const clearSessionForTurnLimit = isGeminiTurnLimitResult(attempt.parsed.resultEvent, attempt.proc.exitCode);

    // On retry, don't fall back to old session ID — the old session was stale
    const canFallbackToRuntimeSession = !isRetry && Boolean(sessionId);
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        ...buildPaperclipSessionParams({
          sessionId: resolvedSessionId,
          cwd,
          workIdentity: sessionContinuity.workIdentity,
        }),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const structuredFailure = attempt.parsed.resultEvent
      ? describeGeminiFailure(attempt.parsed.resultEvent)
      : null;
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      `Gemini exited with code ${attempt.proc.exitCode ?? -1}`;
    const observedTotalTokens = Math.max(
      0,
      attempt.parsed.usage.inputTokens - attempt.parsed.usage.cachedInputTokens,
    ) + attempt.parsed.usage.outputTokens;
    const totalTokenBudgetExceeded = maxTotalTokens > 0 && observedTotalTokens > maxTotalTokens;
    const outputBudgetExceeded = outputMaxChars > 0 && attempt.parsed.summary.length > outputMaxChars;
    const budgetErrorCode = clearSessionForTurnLimit
      ? "provider_max_turns_exceeded"
      : totalTokenBudgetExceeded
        ? "provider_total_token_budget_exceeded"
        : outputBudgetExceeded
          ? "provider_output_budget_exceeded"
          : null;
    const budgetErrorMessage = clearSessionForTurnLimit
      ? `Gemini reached the pinned ${maxTurns || "runtime"} turn provider budget without a complete final response`
      : totalTokenBudgetExceeded
        ? `Gemini observed ${observedTotalTokens} uncached-input/output tokens, exceeding the pinned ${maxTotalTokens}-token provider budget`
        : outputBudgetExceeded
          ? `Gemini final response ${attempt.parsed.summary.length} chars exceeds the pinned ${outputMaxChars}-char provider budget`
          : null;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: budgetErrorMessage ?? ((attempt.proc.exitCode ?? 0) === 0 ? null : fallbackErrorMessage),
      errorCode: budgetErrorCode ?? ((attempt.proc.exitCode ?? 0) !== 0 && authMeta.requiresAuth ? "gemini_auth_required" : null),
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      biller: "google",
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson: attempt.parsed.resultEvent ?? {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
      clearSession: Boolean(budgetErrorCode) || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const maxTurnsSettings = await prepareGeminiMaxTurnsSettings(env, maxTurns, inheritParentEnv);
  if (maxTurnsSettings) {
    commandNotes.push(`Pinned Gemini model.maxSessionTurns=${maxTurns} through an isolated system-settings overlay.`);
  }
  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      !initial.proc.toolOutputBudgetViolation &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isGeminiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    if (maxTurnsSettings) await fs.rm(maxTurnsSettings.root, { recursive: true, force: true });
  }
}
