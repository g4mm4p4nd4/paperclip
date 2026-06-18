export const type = "gemini_local";
export const label = "Gemini CLI (local)";
export const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

export const GEMINI_LOCAL_MODEL_IDS = [
  "auto-gemini-3",
  "auto-gemini-2.5",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

export type GeminiLocalModelId = (typeof GEMINI_LOCAL_MODEL_IDS)[number];

const GEMINI_LOCAL_MODEL_LABELS: Record<GeminiLocalModelId, string> = {
  "auto-gemini-3": "Auto Gemini 3",
  "auto-gemini-2.5": "Auto Gemini 2.5",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "gemini-3-pro-preview": "Gemini 3 Pro Preview",
  "gemini-3-flash-preview": "Gemini 3 Flash Preview",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
};

export const GEMINI_LOCAL_MODELS = GEMINI_LOCAL_MODEL_IDS.map((id) => ({
  id,
  label: GEMINI_LOCAL_MODEL_LABELS[id],
}));

export const models = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  ...GEMINI_LOCAL_MODELS,
];

export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Use when:
- You want Paperclip to run the Gemini CLI locally on the host machine
- You want Gemini chat sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Gemini CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Gemini CLI model id. Defaults to auto.
- authMode (string, optional): set to "subscription" to force local Gemini CLI login/OAuth by stripping inherited GEMINI_API_KEY and GOOGLE_API_KEY from the child process; set to "api" to allow API-key auth
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox=none)
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY or local Gemini CLI login. Tiered subscription fallback sets authMode="subscription" so local login is preferred even if the Paperclip server inherited API-key env vars.
- Tiered fallback routing selects Gemini CLI model ids verified against the local subscription login. Executive/research/QA/design work starts on Pro-tier models such as \`gemini-3.1-pro-preview\`; implementation work starts on Flash-tier models such as \`gemini-3-flash-preview\`; lightweight support starts on Flash Lite. Unsupported stable aliases such as \`gemini-3.1-pro\`, \`gemini-3.5-flash\`, and Gemini 2.0 ids are intentionally omitted because this CLI/account rejects them with model-access errors.
`;
