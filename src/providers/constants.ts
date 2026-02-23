export const CODEX_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";
export const CODEX_RESPONSE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_ORIGINATOR = "opencode";

export const COPILOT_DEFAULT_API_BASE_URL = "https://api.githubcopilot.com";
export const COPILOT_OPENAI_INTENT = "conversation-edits";
export const COPILOT_INITIATOR_HEADER = "x-initiator";
export const COPILOT_VISION_HEADER = "Copilot-Vision-Request";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_INTERLEAVED_THINKING_BETA_HEADER =
  "interleaved-thinking-2025-05-14";
export const CLAUDE_REQUIRED_BETA_HEADERS = [
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_INTERLEAVED_THINKING_BETA_HEADER,
] as const;
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
export const CLAUDE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_TOOL_PREFIX = "mcp_";
