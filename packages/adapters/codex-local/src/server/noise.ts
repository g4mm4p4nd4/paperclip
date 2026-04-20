const CODEX_STDERR_SINGLE_LINE_NOISE_RES = [
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i,
  /^(?:Error:\s*)?(?:thread\/resume:\s+)?thread\/resume failed:\s+no rollout found for thread id\s+[a-z0-9-]+$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_core::shell_snapshot:\s+Failed to delete shell snapshot at ".+?\.tmp-\d+": Os \{ code: 2, kind: NotFound, message: "No such file or directory" \}$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+(?:codex_)?core::plugins::manifest:\s+ignoring interface\.defaultPrompt: prompt must be at most 128 characters path=.+$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+(?:codex_)?core::plugins::manager:\s+skipping duplicate plugin MCP server name plugin="vercel@openai-curated" previous_plugin="build-web-apps@openai-curated" server="vercel"$/i,
];

const CODEX_FEATURED_PLUGIN_CACHE_WARNING_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+(?:codex_)?core::plugins::manager:\s+failed to warm featured plugin ids cache error=/i;

function shouldDropCodexStderrLine(
  line: string,
  state: { skippingFeaturedPluginHtml: boolean },
): boolean {
  const trimmed = line.trim();

  if (state.skippingFeaturedPluginHtml) {
    if (/<\/html>/i.test(trimmed)) {
      state.skippingFeaturedPluginHtml = false;
    }
    return true;
  }

  if (!trimmed) {
    return false;
  }

  if (CODEX_FEATURED_PLUGIN_CACHE_WARNING_RE.test(trimmed)) {
    if (/<html\b/i.test(trimmed) && !/<\/html>/i.test(trimmed)) {
      state.skippingFeaturedPluginHtml = true;
    }
    return true;
  }

  return CODEX_STDERR_SINGLE_LINE_NOISE_RES.some((pattern) => pattern.test(trimmed));
}

export function createCodexStderrNoiseFilter() {
  let carry = "";
  const state = { skippingFeaturedPluginHtml: false };

  const processCompleteLines = (text: string): string => {
    let remaining = text;
    let cleaned = "";

    while (true) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex < 0) break;

      const line = remaining.slice(0, newlineIndex);
      remaining = remaining.slice(newlineIndex + 1);

      if (!shouldDropCodexStderrLine(line, state)) {
        cleaned += `${line}\n`;
      }
    }

    carry = remaining;
    return cleaned;
  };

  return {
    push(chunk: string): string {
      return processCompleteLines(carry + chunk);
    },
    flush(): string {
      if (!carry) return "";
      const line = carry;
      carry = "";
      return shouldDropCodexStderrLine(line, state) ? "" : line;
    },
  };
}

export function stripCodexStderrNoise(text: string): string {
  const filter = createCodexStderrNoiseFilter();
  return `${filter.push(text)}${filter.flush()}`;
}
