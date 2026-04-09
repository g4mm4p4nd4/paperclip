import { constants as fsConstants, promises as fs } from "node:fs";

export const MACOS_CODEX_APP_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
export const DEFAULT_CODEX_LOCAL_COMMAND = "codex";

export async function resolveDefaultCodexCommand(): Promise<string> {
  if (process.platform !== "darwin") return DEFAULT_CODEX_LOCAL_COMMAND;

  try {
    await fs.access(MACOS_CODEX_APP_COMMAND, fsConstants.X_OK);
    return MACOS_CODEX_APP_COMMAND;
  } catch {
    return DEFAULT_CODEX_LOCAL_COMMAND;
  }
}
