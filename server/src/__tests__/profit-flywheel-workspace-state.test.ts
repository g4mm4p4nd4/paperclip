import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProfitFlywheelWorkspaceSnapshot,
  revalidateProfitFlywheelWorkspaceSnapshot,
} from "../services/profit-flywheel-workspace-state.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

async function git(root: string, ...args: string[]) {
  return execFile("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function createRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-checkpoint-state-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "paperclip-test@example.com");
  await git(root, "config", "user.name", "Paperclip Test");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "base");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Profit Flywheel canonical workspace checkpoints", () => {
  it("round-trips an unchanged canonical workspace and excludes Paperclip-owned artifacts", async () => {
    const root = await createRepo();
    await mkdir(path.join(root, ".paperclip", "receipts"), { recursive: true });
    await writeFile(path.join(root, ".paperclip", "receipts", "server-owned.json"), "{}\n");
    await writeFile(path.join(root, "product.txt"), "work product\n");

    const snapshot = await captureProfitFlywheelWorkspaceSnapshot(root);
    expect(snapshot.untracked.map((entry) => entry.path)).toEqual(["product.txt"]);
    expect(snapshot.indexDiffSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(revalidateProfitFlywheelWorkspaceSnapshot(snapshot)).resolves.toMatchObject({
      headGitObject: snapshot.headGitObject,
      trackedDiffSha256: snapshot.trackedDiffSha256,
      indexDiffSha256: snapshot.indexDiffSha256,
    });
  });

  it("detects index-byte drift even when HEAD-to-worktree bytes and porcelain status class are unchanged", async () => {
    const root = await createRepo();
    await writeFile(path.join(root, "tracked.txt"), "worktree bytes\n");
    const writeBlob = async (value: string) => {
      const inputPath = path.join(root, ".git", "paperclip-test-blob-input");
      await writeFile(inputPath, value);
      const result = await git(root, "hash-object", "-w", inputPath);
      return result.stdout.trim();
    };
    const blobA = await writeBlob("staged A\n");
    await git(root, "update-index", "--cacheinfo", `100644,${blobA},tracked.txt`);
    const snapshot = await captureProfitFlywheelWorkspaceSnapshot(root);

    const blobB = await writeBlob("staged B\n");
    await git(root, "update-index", "--cacheinfo", `100644,${blobB},tracked.txt`);
    const changed = await captureProfitFlywheelWorkspaceSnapshot(root);
    expect(changed.trackedDiffSha256).toBe(snapshot.trackedDiffSha256);
    expect(changed.statusSha256).toBe(snapshot.statusSha256);
    expect(changed.indexDiffSha256).not.toBe(snapshot.indexDiffSha256);
    await expect(revalidateProfitFlywheelWorkspaceSnapshot(snapshot)).rejects.toThrow(/workspace changed/i);
  });

  it("rejects secret-like untracked paths before they can enter immutable evidence", async () => {
    const root = await createRepo();
    await writeFile(path.join(root, "api_key=super-secret-value"), "sentinel\n");
    await expect(captureProfitFlywheelWorkspaceSnapshot(root)).rejects.toThrow(/secret-like/i);
  });
});
