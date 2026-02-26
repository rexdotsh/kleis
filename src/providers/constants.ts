// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/plugin/codex.ts#L475-L477
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L844-L847
export const CODEX_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";
export const CODEX_RESPONSE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/plugin/codex.ts#L619
export const CODEX_ORIGINATOR = "opencode";

// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/plugin/copilot.ts#L121-L131
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/github-copilot-headers.ts#L27-L34
export const COPILOT_DEFAULT_API_BASE_URL = "https://api.githubcopilot.com";
export const COPILOT_OPENAI_INTENT = "conversation-edits";
export const COPILOT_INITIATOR_HEADER = "x-initiator";
export const COPILOT_VISION_HEADER = "Copilot-Vision-Request";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/provider/provider.ts#L124-L127
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L536
const CLAUDE_CODE_BETA_HEADER = "claude-code-20250219";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_INTERLEAVED_THINKING_BETA_HEADER =
  "interleaved-thinking-2025-05-14";
const CLAUDE_FINE_GRAINED_TOOL_STREAMING_BETA_HEADER =
  "fine-grained-tool-streaming-2025-05-14";
export const CLAUDE_REQUIRED_BETA_HEADERS = [
  CLAUDE_CODE_BETA_HEADER,
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_INTERLEAVED_THINKING_BETA_HEADER,
  CLAUDE_FINE_GRAINED_TOOL_STREAMING_BETA_HEADER,
] as const;
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L537
export const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L581-L586
export const CLAUDE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L192
export const CLAUDE_TOOL_PREFIX = "mcp_";
