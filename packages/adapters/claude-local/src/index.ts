export const type = "claude_local";
export const label = "Claude Code (local)";

export const models = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- authMode (string, optional): set to "subscription" to force local Claude login/subscription auth by stripping inherited ANTHROPIC_API_KEY from the child process; set to "api" to allow API-key auth
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions to claude; defaults to true because Paperclip runs Claude in headless --print mode where interactive permission prompts cannot be answered
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
- Before spawning Claude, Paperclip strips parent Claude/Codex harness markers such as CLAUDE_CODE_*, CLAUDECODE, and inherited CODEX_* variables unless they were explicitly configured on this adapter.
- Tiered subscription fallback uses Sonnet 4.6 for high-intelligence work and Haiku 4.5 for lightweight work. Opus is selectable for explicitly configured agents, but it is not used automatically for Pro subscription fallback.
`;
