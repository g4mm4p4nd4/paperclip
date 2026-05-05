import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("accepts prefixed OpenCode Go models from discovery output and rejects unprefixed ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-models-"));
    tempDirs.push(dir);
    const command = path.join(dir, "opencode");
    await fs.writeFile(
      command,
      [
        "#!/bin/sh",
        "cat <<'EOF'",
        "opencode-go/deepseek-v4-flash",
        "opencode-go/deepseek-v4-pro",
        "opencode-go/kimi-k2.6",
        "opencode-go/qwen3.5-plus",
        "EOF",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(command, 0o755);
    process.env.PAPERCLIP_OPENCODE_COMMAND = command;

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "opencode-go/deepseek-v4-flash" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "opencode-go/deepseek-v4-flash" }),
      ]),
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "deepseek-v4-flash" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable: deepseek-v4-flash");
  });
});
