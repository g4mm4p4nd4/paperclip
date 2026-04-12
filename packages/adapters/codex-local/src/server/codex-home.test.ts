import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeBuildWebAppsMcpJson,
  normalizeManagedCodexConfigToml,
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
} from "./codex-home.js";

describe("normalizeManagedCodexConfigToml", () => {
  it("disables standalone vercel when build-web-apps is already enabled", () => {
    const input = [
      'model = "gpt-5.4"',
      "",
      '[plugins."build-web-apps@openai-curated"]',
      "enabled = true",
      "",
      '[plugins."vercel@openai-curated"]',
      "enabled = true",
      "",
    ].join("\n");

    const normalized = normalizeManagedCodexConfigToml(input);

    expect(normalized.changed).toBe(true);
    expect(normalized.text).toContain('[plugins."build-web-apps@openai-curated"]\nenabled = true');
    expect(normalized.text).toContain('[plugins."vercel@openai-curated"]\nenabled = false');
    expect(normalized.messages).toEqual([
      expect.stringContaining('Disabled Codex plugin "vercel@openai-curated"'),
    ]);
  });
});

describe("normalizeBuildWebAppsMcpJson", () => {
  it("removes stripe and supabase while preserving vercel", () => {
    const input = JSON.stringify(
      {
        mcpServers: {
          stripe: { type: "http", url: "https://mcp.stripe.com" },
          vercel: { type: "http", url: "https://mcp.vercel.com" },
          supabase: { type: "http", url: "https://mcp.supabase.com/mcp" },
        },
      },
      null,
      2,
    );

    const normalized = normalizeBuildWebAppsMcpJson(input);
    const parsed = JSON.parse(normalized.text) as { mcpServers: Record<string, unknown> };

    expect(normalized.changed).toBe(true);
    expect(parsed.mcpServers.vercel).toBeTruthy();
    expect(parsed.mcpServers.stripe).toBeUndefined();
    expect(parsed.mcpServers.supabase).toBeUndefined();
    expect(normalized.messages).toEqual([
      expect.stringContaining('Disabled auth-required MCP servers for "build-web-apps@openai-curated"'),
    ]);
  });
});

describe("prepareManagedCodexHome", () => {
  it("reuses the shared plugin cache and normalizes conflicting plugin config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const sharedPluginCache = path.join(
      sharedCodexHome,
      "plugins",
      "cache",
      "openai-curated",
      "build-web-apps",
      "test-version",
    );
    await fs.mkdir(sharedPluginCache, { recursive: true });
    await fs.writeFile(
      path.join(sharedPluginCache, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            stripe: { type: "http", url: "https://mcp.stripe.com" },
            vercel: { type: "http", url: "https://mcp.vercel.com" },
            supabase: { type: "http", url: "https://mcp.supabase.com/mcp" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        '[plugins."build-web-apps@openai-curated"]',
        "enabled = true",
        "",
        '[plugins."vercel@openai-curated"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const env = {
      HOME: root,
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    };

    try {
      const prepared = await prepareManagedCodexHome(
        env,
        async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
        "company-1",
      );

      expect(prepared).toBe(resolveManagedCodexHomeDir(env, "company-1"));

      const managedConfig = await fs.readFile(path.join(prepared, "config.toml"), "utf8");
      expect(managedConfig).toContain('[plugins."vercel@openai-curated"]\nenabled = false');

      const managedPluginCache = path.join(prepared, "plugins", "cache");
      expect((await fs.lstat(managedPluginCache)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedPluginCache)).toBe(await fs.realpath(path.join(sharedCodexHome, "plugins", "cache")));
      const managedMcp = JSON.parse(
        await fs.readFile(
          path.join(prepared, "plugins", "cache", "openai-curated", "build-web-apps", "test-version", ".mcp.json"),
          "utf8",
        ),
      ) as { mcpServers: Record<string, unknown> };
      expect(managedMcp.mcpServers.vercel).toBeTruthy();
      expect(managedMcp.mcpServers.stripe).toBeUndefined();
      expect(managedMcp.mcpServers.supabase).toBeUndefined();

      const managedAuth = path.join(prepared, "auth.json");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Disabled Codex plugin "vercel@openai-curated"'),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Disabled auth-required MCP servers for "build-web-apps@openai-curated": stripe, supabase.'),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
