// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/plugin/codex.ts#L475-L477
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L844-L847
export const CODEX_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";
export const CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
export const CODEX_BETA_FEATURES = "remote_compaction_v2";
export const CODEX_RESPONSE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_COMPACTION_ENDPOINT = `${CODEX_RESPONSE_ENDPOINT}/compact`;
export const CODEX_WEBSOCKET_BETA_HEADER = "responses_websockets=2026-02-06";
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/plugin/codex.ts#L619
export const CODEX_ORIGINATOR = "opencode";
// OpenCode v2.1.2: https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/model-request.ts#L288
export const CODEX_USER_AGENT = "opencode/latest/2.1.2/cli";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/provider/provider.ts#L124-L127
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L536
const CLAUDE_CODE_BETA_HEADER = "claude-code-20250219";
export const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_INTERLEAVED_THINKING_BETA_HEADER =
  "interleaved-thinking-2025-05-14";
// Claude Code 2.1.310 main-thread betas in its order, with the models it sends
// each for. Betas that change thinking output or tool permissions are left out.
export const CLAUDE_BETA_HEADERS: ReadonlyArray<{
  beta: string;
  models?: RegExp;
}> = [
  { beta: CLAUDE_CODE_BETA_HEADER },
  { beta: CLAUDE_OAUTH_BETA_HEADER },
  { beta: CLAUDE_INTERLEAVED_THINKING_BETA_HEADER },
  { beta: "thinking-token-count-2026-05-13" },
  { beta: "context-management-2025-06-27" },
  { beta: "prompt-caching-scope-2026-01-05" },
  { beta: "per-turn-control-2026-07-01", models: /^claude-[a-z]+-5-5/ },
  {
    beta: "mid-conversation-tool-changes-2026-07-01",
    models: /^claude-(?:[a-z]+-5-5|opus-4-8|mythos-5)/,
  },
  { beta: "advanced-tool-use-2025-11-20" },
  {
    beta: "effort-2025-11-24",
    models: /^claude-(?:[a-z]+-5|opus-4-[5-9]|sonnet-4-6)/,
  },
];
// Claude Code sends it with every 1h cache_control.
export const CLAUDE_EXTENDED_CACHE_TTL_BETA_HEADER =
  "extended-cache-ttl-2025-04-11";
export const CLAUDE_CACHE_DIAGNOSIS_BETA_HEADER = "cache-diagnosis-2026-04-07";
const CLAUDE_CODE_VERSION = "2.1.310";
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
// The Anthropic SDK build bundled in Claude Code 2.1.310.
export const CLAUDE_STAINLESS_HEADERS = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.128.0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
} as const;
// Values Claude Code sends in x-claude-code-request-class.
export const CLAUDE_REQUEST_CLASSES = new Set([
  "main",
  "subagent",
  "workflow",
  "compaction",
  "auxiliary",
  "side_reply",
]);
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L581-L586
export const CLAUDE_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L192
export const CLAUDE_TOOL_PREFIX = "mcp_";
