import { describe, expect, it } from "vitest";
import { stripCodexStderrNoise } from "./execute.js";

describe("stripCodexStderrNoise", () => {
  it("removes known rollout, shell snapshot, and benign plugin noise", () => {
    const input = [
      '2026-04-08T09:38:46.076806Z  ERROR codex_core::rollout::list: state db missing rollout path for thread 019d7030-13c5-7f30-98d1-a7e6d37615f6',
      '2026-04-09T03:01:32.316798Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at "/tmp/019d7030-13c5-7f30-98d1-a7e6d37615f6.tmp-1775703692231114000": Os { code: 2, kind: NotFound, message: "No such file or directory" }',
      '2026-04-12T07:19:33.464738Z  WARN codex_core::plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/tmp/build-ios-apps/.codex-plugin/plugin.json',
      '2026-04-12T07:20:18.615232Z  WARN codex_core::plugins::manager: skipping duplicate plugin MCP server name plugin="vercel@openai-curated" previous_plugin="build-web-apps@openai-curated" server="vercel"',
      "actual stderr",
    ].join("\n");

    expect(stripCodexStderrNoise(input)).toBe("actual stderr");
  });

  it("keeps other shell snapshot warnings intact", () => {
    const warning =
      '2026-04-09T03:01:32.316798Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at "/tmp/019d7030-13c5-7f30-98d1-a7e6d37615f6.tmp-1775703692231114000": Os { code: 13, kind: PermissionDenied, message: "Permission denied" }';

    expect(stripCodexStderrNoise(warning)).toBe(warning);
  });
});
