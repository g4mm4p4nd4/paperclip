import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_PATHS = ["auth.json", path.join("plugins", "cache")] as const;
const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";
const BUILD_WEB_APPS_PLUGIN = "build-web-apps@openai-curated";
const STANDALONE_VERCEL_PLUGIN = "vercel@openai-curated";

type ManagedCodexConfigNormalization = {
  changed: boolean;
  text: string;
  messages: string[];
};

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return companyId
    ? path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "codex-home")
    : path.resolve(paperclipHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return;

  await fs.unlink(target);
  await fs.symlink(source, target);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

function listTomlSections(text: string): Array<{ header: string; start: number; end: number; text: string }> {
  const matches = Array.from(text.matchAll(/^\[[^\]\n]+\]\s*$/gm));
  return matches.map((match, idx) => {
    const start = match.index ?? 0;
    const end = idx + 1 < matches.length ? (matches[idx + 1]?.index ?? text.length) : text.length;
    return {
      header: match[0].trim(),
      start,
      end,
      text: text.slice(start, end),
    };
  });
}

function getPluginTomlSection(
  text: string,
  pluginName: string,
): { header: string; start: number; end: number; text: string } | null {
  const header = `[plugins."${pluginName}"]`;
  return listTomlSections(text).find((section) => section.header === header) ?? null;
}

function isPluginEnabledInToml(text: string, pluginName: string): boolean {
  const section = getPluginTomlSection(text, pluginName);
  if (!section) return false;
  const enabledMatch = section.text.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
  return enabledMatch?.[1] === "true";
}

function setPluginEnabledInToml(text: string, pluginName: string, enabled: boolean): string {
  const section = getPluginTomlSection(text, pluginName);
  if (!section) return text;

  const enabledLineRe = /^(\s*enabled\s*=\s*)(true|false)(\s*)$/m;
  const nextSectionText = enabledLineRe.test(section.text)
    ? section.text.replace(enabledLineRe, `$1${enabled}$3`)
    : `${section.text}${section.text.endsWith("\n") ? "" : "\n"}enabled = ${enabled}\n`;

  return `${text.slice(0, section.start)}${nextSectionText}${text.slice(section.end)}`;
}

export function normalizeManagedCodexConfigToml(text: string): ManagedCodexConfigNormalization {
  let nextText = text;
  const messages: string[] = [];

  if (
    isPluginEnabledInToml(nextText, BUILD_WEB_APPS_PLUGIN) &&
    isPluginEnabledInToml(nextText, STANDALONE_VERCEL_PLUGIN)
  ) {
    const updated = setPluginEnabledInToml(nextText, STANDALONE_VERCEL_PLUGIN, false);
    if (updated !== nextText) {
      nextText = updated;
      messages.push(
        `Disabled Codex plugin "${STANDALONE_VERCEL_PLUGIN}" in managed config.toml because "${BUILD_WEB_APPS_PLUGIN}" already registers MCP server "vercel".`,
      );
    }
  }

  return {
    changed: nextText !== text,
    text: nextText,
    messages,
  };
}

async function normalizeManagedCodexConfig(
  targetHome: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const configPath = path.join(targetHome, "config.toml");
  if (!(await pathExists(configPath))) return;

  const current = await fs.readFile(configPath, "utf8");
  const normalized = normalizeManagedCodexConfigToml(current);
  if (!normalized.changed) return;

  await fs.writeFile(configPath, normalized.text, "utf8");
  for (const message of normalized.messages) {
    await onLog("stdout", `[paperclip] ${message}\n`);
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, companyId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  for (const relativePath of SYMLINKED_SHARED_PATHS) {
    const source = path.join(sourceHome, relativePath);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, relativePath), source);
  }

  for (const name of COPIED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureCopiedFile(path.join(targetHome, name), source);
  }

  await normalizeManagedCodexConfig(targetHome, onLog);

  await onLog(
    "stdout",
    `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
