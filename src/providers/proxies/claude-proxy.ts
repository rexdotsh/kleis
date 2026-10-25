import type { ClaudeAccountMetadata } from "../metadata";

import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_EXTENDED_CACHE_TTL_BETA_HEADER,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_STAINLESS_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
} from "../constants";
import { requireProxyEndpointRoute } from "../proxy-endpoints";
import {
  readAnthropicUsageFromResponse,
  readAnthropicIterations,
  readAnthropicUsageObject,
  readAnthropicUsageToken,
  type TokenUsage,
} from "../../usage/token-usage";
import { isObjectRecord, type JsonObject, withField } from "../../utils/object";
import {
  type ClaudeToolNames,
  mapClaudeRequestToolNames,
} from "./claude-tool-names";
import { readSseData, replaceSseData } from "./sse-events";
import { createSseRelay } from "./sse-relay";
import {
  isEventStreamResponse,
  passthroughProxyResponse,
  transformJsonResponse,
} from "./response";
import {
  readStreamErrorStatus,
  readUpstreamErrorFields,
} from "./upstream-error";

// Anthropic OAuth rejects these system-prompt markers from third-party clients.
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/prompt/anthropic.txt
// https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/system.ts#L32-L72
const sanitizeClaudeSystemText = (text: string): string =>
  text
    .replace(
      /^(\s*)https:\/\/github\.com\/anomalyco\/opencode$/gim,
      "$1https://github.com/anomalyco/project"
    )
    .replace(
      /Here is some useful information about the environment you are running in:/g,
      "Here is useful information about the environment you are running in:"
    )
    .replace(/<directories>\n\s*/gi, "Directories\n")
    // Pi docs phrases that make Anthropic bill OAuth as third-party usage.
    .replace("follow .md cross-references", "follow cross-references")
    .replace("pi packages (docs/packages.md)", "packages (docs/packages.md)");

const isTextBlock = (
  block: unknown
): block is JsonObject & { type: "text"; text: string } =>
  isObjectRecord(block) &&
  block.type === "text" &&
  typeof block.text === "string";

const withClaudeSystemIdentity = (system: unknown): unknown => {
  let blocks = system || [];
  if (typeof blocks === "string") {
    blocks = [{ type: "text", text: blocks }];
  }
  if (!Array.isArray(blocks)) {
    return system;
  }

  const sanitized = blocks.map((block: unknown) =>
    isTextBlock(block)
      ? { ...block, text: sanitizeClaudeSystemText(block.text) }
      : block
  );
  return sanitized.some(
    (block) => isTextBlock(block) && block.text === CLAUDE_SYSTEM_IDENTITY
  )
    ? sanitized
    : [{ type: "text", text: CLAUDE_SYSTEM_IDENTITY }, ...sanitized];
};

const restoreToolUseName = (
  block: unknown,
  toolNames: ClaudeToolNames
): unknown =>
  isObjectRecord(block) &&
  block.type === "tool_use" &&
  typeof block.name === "string"
    ? withField(block, "name", toolNames.get(block.name) ?? block.name)
    : block;

const restoreMessageToolNames = (
  message: unknown,
  toolNames: ClaudeToolNames
): unknown => {
  if (!(isObjectRecord(message) && Array.isArray(message.content))) {
    return message;
  }

  const content: unknown[] = message.content;
  const restored = content.map((block) => restoreToolUseName(block, toolNames));
  return restored.some((block, index) => block !== content[index])
    ? { ...message, content: restored }
    : message;
};

// Only tool_use blocks are renamed: look-alikes inside tool inputs must reach
// the client as sent. Returning the same object when nothing changed lets
// callers forward the upstream bytes.
const transformClaudeResponsePayload = (
  payload: unknown,
  toolNames: ClaudeToolNames
): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  switch (payload.type) {
    case "message":
      return restoreMessageToolNames(payload, toolNames);
    case "message_start":
      return withField(
        payload,
        "message",
        restoreMessageToolNames(payload.message, toolNames)
      );
    case "content_block_start":
      return withField(
        payload,
        "content_block",
        restoreToolUseName(payload.content_block, toolNames)
      );
    default:
      return payload;
  }
};

const claudeMessagesUpstreamSuffix = requireProxyEndpointRoute({
  publicProvider: "anthropic",
  endpoint: "messages",
}).upstreamSuffix;

// OAuth requests need ?beta=true on the messages endpoint.
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L258-L263
const buildUpstreamUrl = (search: string): string => {
  const upstream = new URL(
    `${claudeMessagesUpstreamSuffix}${search}`,
    ANTHROPIC_API_BASE_URL
  );
  upstream.searchParams.set("beta", "true");
  return upstream.toString();
};

// Events that never carry usage, errors, tool names or the end of the stream.
// Text deltas make up almost all of a stream, so they skip JSON parsing.
const CLAUDE_PASSTHROUGH_EVENTS = new Set([
  "content_block_delta",
  "content_block_start",
  "content_block_stop",
  "ping",
]);

const readSseEventName = (chunk: string): string | null => {
  let start = 6;
  if (!chunk.startsWith("event:")) {
    const index = chunk.indexOf("\nevent:");
    if (index === -1) {
      return null;
    }
    start = index + 7;
  }
  const end = chunk.indexOf("\n", start);
  return chunk.slice(start, end === -1 ? undefined : end).trim();
};

const transformSseEventChunk = (
  chunk: string,
  toolNames: ClaudeToolNames,
  observePayload: (payload: unknown) => void
): string => {
  const eventName = readSseEventName(chunk);
  if (
    eventName !== null &&
    CLAUDE_PASSTHROUGH_EVENTS.has(eventName) &&
    !chunk.includes('"tool_use"')
  ) {
    return chunk;
  }

  const payload = readSseData(chunk);
  if (!payload) {
    return chunk;
  }

  try {
    const jsonBody = JSON.parse(payload) as unknown;
    observePayload(jsonBody);
    const transformed = transformClaudeResponsePayload(jsonBody, toolNames);
    return transformed === jsonBody
      ? chunk
      : replaceSseData(chunk, JSON.stringify(transformed));
  } catch {
    return chunk;
  }
};

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamEnd?: ((statusCode: number) => void) | null,
  providerAccountId?: string
): Response => {
  let endStatus: number | null = response.ok ? null : response.status;

  const streamUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sawStreamUsage = false;

  return createSseRelay({
    response,
    provider: "claude",
    providerAccountId,
    transport: "sse_transform",
    streamFailedEvent: "claude_sse_stream_failed",
    onTokenUsage,
    onStreamEnd,
    createProtocol: ({ log }) => {
      const observePayload = (payload: unknown): void => {
        if (!isObjectRecord(payload)) {
          return;
        }

        if (payload.type === "message_start") {
          const message = isObjectRecord(payload.message)
            ? payload.message
            : null;
          const usage = readAnthropicUsageObject(message?.usage);
          if (!usage) {
            return;
          }

          sawStreamUsage = true;
          Object.assign(streamUsage, usage);
          return;
        }

        if (payload.type === "message_delta") {
          const usage = isObjectRecord(payload.usage) ? payload.usage : null;
          if (!usage) {
            return;
          }

          sawStreamUsage = true;
          streamUsage.inputTokens = readAnthropicUsageToken(
            usage,
            "input_tokens",
            streamUsage.inputTokens
          );
          streamUsage.outputTokens = readAnthropicUsageToken(
            usage,
            "output_tokens",
            streamUsage.outputTokens
          );
          streamUsage.cacheReadTokens = readAnthropicUsageToken(
            usage,
            "cache_read_input_tokens",
            streamUsage.cacheReadTokens
          );
          streamUsage.cacheWriteTokens = readAnthropicUsageToken(
            usage,
            "cache_creation_input_tokens",
            streamUsage.cacheWriteTokens
          );
          Object.assign(streamUsage, readAnthropicIterations(usage));
          return;
        }

        if (payload.type === "message_stop") {
          endStatus ??= 200;
          return;
        }

        if (payload.type === "error") {
          endStatus ??= readStreamErrorStatus(payload);
          if (response.ok) {
            log("claude_sse_error_event", {
              status: readStreamErrorStatus(payload),
              ...readUpstreamErrorFields(payload),
            });
          }
        }
      };

      return {
        transformEvent: (event) =>
          transformSseEventChunk(event, toolNames, observePayload),
        getUsage: () => (sawStreamUsage ? { ...streamUsage } : null),
        getEndStatus: () => endStatus,
        onEof(rest): void {
          // OpenCode treats an EOF without message_stop as an interrupted stream.
          if (endStatus === null) {
            log("claude_sse_missing_message_stop", {
              truncatedEvent: rest.trim().length > 0,
            });
          }
        },
      };
    },
  });
};

const transformClaudeResponse = async (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamEnd?: ((statusCode: number) => void) | null,
  providerAccountId?: string
): Promise<Response> => {
  if (isEventStreamResponse(response)) {
    return maybeTransformClaudeStreamResponse(
      response,
      toolNames,
      onTokenUsage,
      onStreamEnd,
      providerAccountId
    );
  }
  if (!response.body) {
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return passthroughProxyResponse(response);
  }
  return transformJsonResponse({
    response,
    readUsage: readAnthropicUsageFromResponse,
    transformPayload: (payload) =>
      transformClaudeResponsePayload(payload, toolNames),
    onTokenUsage,
  });
};

// Every breakpoint gets the 1h TTL, so no 1h entry can follow a 5m one.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
const withLongCacheTtl = (
  value: unknown,
  cache: { found: boolean }
): unknown => {
  if (Array.isArray(value)) {
    let items: unknown[] | null = null;
    for (let index = 0; index < value.length; index++) {
      const upgraded = withLongCacheTtl(value[index], cache);
      if (upgraded !== value[index]) {
        items ??= [...value];
        items[index] = upgraded;
      }
    }
    return items ?? value;
  }
  if (!isObjectRecord(value)) {
    return value;
  }

  const result = Array.isArray(value.content)
    ? withField(value, "content", withLongCacheTtl(value.content, cache))
    : value;
  const control = value.cache_control;
  if (!isObjectRecord(control)) {
    return result;
  }
  cache.found = true;
  return control.type === "ephemeral" && control.ttl !== "1h"
    ? withField(result, "cache_control", { ...control, ttl: "1h" })
    : result;
};

const mergeBetaHeaders = (headers: Headers, required: readonly string[]) => {
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set([...required, ...incoming])].join(",");
};

const STAINLESS_OS_NAMES: Record<string, string> = {
  darwin: "MacOS",
  linux: "Linux",
  win32: "Windows",
};

type ClaudeProxyPreparationInput = {
  requestUrl: URL;
  headers: Headers;
  bodyText: string;
  bodyJson: unknown;
  accessToken: string;
  providerAccountId?: string;
  metadata: ClaudeAccountMetadata | null;
  onTokenUsage?: ((usage: TokenUsage) => void) | null;
  // Called once when an SSE response ends, with the status to record for it.
  onStreamEnd?: ((statusCode: number) => void) | null;
};

type ClaudeProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareClaudeProxyRequest = (
  input: ClaudeProxyPreparationInput
): ClaudeProxyPreparationResult => {
  const { payload, toolNames } = mapClaudeRequestToolNames(input.bodyJson);
  let transformedPayload = isObjectRecord(payload)
    ? { ...payload, system: withClaudeSystemIdentity(payload.system) }
    : payload;
  const cache = { found: false };
  if (isObjectRecord(transformedPayload)) {
    let upgraded = transformedPayload;
    for (const key of ["tools", "system", "messages"] as const) {
      upgraded = withField(
        upgraded,
        key,
        withLongCacheTtl(upgraded[key], cache)
      );
    }
    transformedPayload = withLongCacheTtl(upgraded, cache);
  }
  const bodyText =
    transformedPayload !== input.bodyJson
      ? JSON.stringify(transformedPayload)
      : input.bodyText;

  const mergedBetas = mergeBetaHeaders(
    input.headers,
    cache.found
      ? [...CLAUDE_REQUIRED_BETA_HEADERS, CLAUDE_EXTENDED_CACHE_TTL_BETA_HEADER]
      : CLAUDE_REQUIRED_BETA_HEADERS
  );

  // OAuth sessions require Claude Code identity headers.
  // https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L525-L538
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("anthropic-beta", mergedBetas);
  input.headers.set("anthropic-dangerous-direct-browser-access", "true");
  input.headers.set("anthropic-version", "2023-06-01");
  input.headers.set("content-type", "application/json");
  // Claude Code's SDK uses JSON Accept even for SSE responses.
  // https://unpkg.com/@anthropic-ai/sdk@0.128.0/src/client.ts
  input.headers.set("accept", "application/json");
  input.headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  input.headers.set("x-app", "cli");
  input.headers.set("x-stainless-arch", process.arch);
  input.headers.set(
    "x-stainless-os",
    STAINLESS_OS_NAMES[process.platform] ?? `Other:${process.platform}`
  );
  for (const [name, value] of Object.entries(CLAUDE_STAINLESS_HEADERS)) {
    input.headers.set(name, value);
  }

  return {
    upstreamUrl: buildUpstreamUrl(input.requestUrl.search),
    bodyText,
    transformResponse: (response: Response): Promise<Response> =>
      transformClaudeResponse(
        response,
        toolNames,
        input.onTokenUsage,
        input.onStreamEnd,
        input.providerAccountId
      ),
  };
};
