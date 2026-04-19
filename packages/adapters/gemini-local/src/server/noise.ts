const GEMINI_STDERR_SINGLE_LINE_NOISE_RES = [
  /^YOLO mode is enabled\. All tool calls will be automatically approved\.$/i,
];

function shouldDropGeminiStderrLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return GEMINI_STDERR_SINGLE_LINE_NOISE_RES.some((pattern) => pattern.test(trimmed));
}

export function createGeminiStderrNoiseFilter() {
  let carry = "";

  const processCompleteLines = (text: string): string => {
    let remaining = text;
    let cleaned = "";

    while (true) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex < 0) break;

      const line = remaining.slice(0, newlineIndex);
      remaining = remaining.slice(newlineIndex + 1);

      if (!shouldDropGeminiStderrLine(line)) {
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
      return shouldDropGeminiStderrLine(line) ? "" : line;
    },
  };
}

export function stripGeminiStderrNoise(text: string): string {
  const filter = createGeminiStderrNoiseFilter();
  return `${filter.push(text)}${filter.flush()}`;
}
