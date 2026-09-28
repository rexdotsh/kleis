import { isObjectRecord } from "../../utils/object";

// Temporary workaround for OpenCode V2 <= 2.0.18. Remove this module and its
// caller once the deployed OpenCode contains upstream commit d9987ef9c8.
// This temporarily overrides even an intentional 32k limit on matching
// requests, since the proxy cannot distinguish it from OpenCode's fallback.
const FALLBACK_OUTPUT_TOKENS = 32_000;
const OPUS_55_OUTPUT_TOKENS = 128_000;

export const applyOpenCode2018ClaudeOutputHotfix = (
  payload: unknown
): unknown => {
  if (
    !isObjectRecord(payload) ||
    payload.model !== "claude-opus-5-5" ||
    payload.max_tokens !== FALLBACK_OUTPUT_TOKENS ||
    payload.stream !== true ||
    !isObjectRecord(payload.thinking) ||
    payload.thinking.type !== "adaptive"
  ) {
    return payload;
  }

  return { ...payload, max_tokens: OPUS_55_OUTPUT_TOKENS };
};
