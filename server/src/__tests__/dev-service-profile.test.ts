import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalLocalServicePath } from "../services/local-service-supervisor.ts";

describe("resolveCanonicalLocalServicePath", () => {
  const canonicalParentDir = path.join(path.sep, "Users", "tester", "Documents", "Github");
  const canonicalPaperclipRoot = path.join(canonicalParentDir, "paperclip");

  it("leaves canonical checkout paths unchanged", () => {
    expect(
      resolveCanonicalLocalServicePath(canonicalPaperclipRoot, {
        canonicalParentDir,
        pathExists: () => true,
      }),
    ).toBe(canonicalPaperclipRoot);
  });

  it("maps Codex worktree roots to the canonical checkout when it exists", () => {
    const worktreeRoot = path.join(path.sep, "Users", "tester", ".codex", "worktrees", "65bb", "paperclip");

    expect(
      resolveCanonicalLocalServicePath(worktreeRoot, {
        canonicalParentDir,
        pathExists: (candidate) => candidate === canonicalPaperclipRoot,
      }),
    ).toBe(canonicalPaperclipRoot);
  });

  it("preserves nested paths under the canonical checkout", () => {
    const worktreeServerPath = path.join(path.sep, "Users", "tester", ".codex", "worktrees", "65bb", "paperclip", "server");

    expect(
      resolveCanonicalLocalServicePath(worktreeServerPath, {
        canonicalParentDir,
        pathExists: (candidate) => candidate === canonicalPaperclipRoot,
      }),
    ).toBe(path.join(canonicalPaperclipRoot, "server"));
  });

  it("leaves Codex worktree paths unchanged when no canonical checkout exists", () => {
    const worktreeRoot = path.join(path.sep, "Users", "tester", ".codex", "worktrees", "65bb", "paperclip");

    expect(
      resolveCanonicalLocalServicePath(worktreeRoot, {
        canonicalParentDir,
        pathExists: () => false,
      }),
    ).toBe(worktreeRoot);
  });
});
