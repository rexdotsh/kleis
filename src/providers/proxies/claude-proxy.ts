import type { ClaudeAccountMetadata } from "../metadata";

import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_BETA_HEADERS,
  CLAUDE_CACHE_DIAGNOSIS_BETA_HEADER,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_EXTENDED_CACHE_TTL_BETA_HEADER,
  CLAUDE_REQUEST_CLASSES,
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

// Claude Code fills its cch field after serializing the body, so a forwarded
// billing line can't be made true for the rewritten request.
const BILLING_HEADER_LINE = /^x-anthropic-billing-header:[^\n]*\n?/;

const withCacheControl = (block: unknown, control: unknown): unknown =>
  isObjectRecord(block) && block.cache_control === undefined
    ? { ...block, cache_control: control }
    : block;

// A breakpoint on a removed billing block moves to the prefix block before it
// (the last tool when it was first), or to the next block when nothing is
// before it, so the request stays cached.
const withoutBillingHeader = (payload: JsonObject): JsonObject => {
  if (typeof payload.system === "string") {
    return withField(
      payload,
      "system",
      payload.system.replace(BILLING_HEADER_LINE, "")
    );
  }
  if (!Array.isArray(payload.system)) {
    return payload;
  }

  let tools = payload.tools;
  const system: unknown[] = [];
  let carried: unknown;
  for (const block of payload.system as unknown[]) {
    if (!(isTextBlock(block) && BILLING_HEADER_LINE.test(block.text))) {
      system.push(
        carried === undefined ? block : withCacheControl(block, carried)
      );
      carried = undefined;
      continue;
    }
    const text = block.text.replace(BILLING_HEADER_LINE, "");
    if (text.trim()) {
      system.push({ ...block, text });
    } else if (block.cache_control !== undefined) {
      if (system.length > 0) {
        system.push(withCacheControl(system.pop(), block.cache_control));
      } else if (Array.isArray(tools) && tools.length > 0) {
        tools = [
          ...tools.slice(0, -1),
          withCacheControl(tools.at(-1), block.cache_control),
        ];
      } else {
        carried = block.cache_control;
      }
    }
  }
  if (carried !== undefined) {
    system.push({
      type: "text",
      text: CLAUDE_SYSTEM_IDENTITY,
      cache_control: carried,
    });
  }
  return { ...payload, tools, system };
};

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

const readClaudeBetas = (model: unknown, cacheFound: boolean): string[] => [
  ...CLAUDE_BETA_HEADERS.filter(
    (entry) =>
      !entry.models || (typeof model === "string" && entry.models.test(model))
  ).map((entry) => entry.beta),
  ...(cacheFound ? [CLAUDE_EXTENDED_CACHE_TTL_BETA_HEADER] : []),
  CLAUDE_CACHE_DIAGNOSIS_BETA_HEADER,
];

// Claude Code 2.1.86+ and OpenCode send a session header.
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2186
// https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/model-request.ts#L282-L291
const CLAUDE_SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
] as const;

export const readClaudeSessionHeader = (headers: Headers): string | undefined =>
  CLAUDE_SESSION_HEADERS.map((name) => headers.get(name)?.trim()).find(Boolean);

const sha256Hex = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

// Claude Code's session and prompt IDs are version 4 UUIDs.
const hashUuid = (value: string): string => {
  const hex = sha256Hex(value);
  const variant = "89ab".charAt(Number.parseInt(hex.charAt(16), 16) % 4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const readMessageContent = (message: unknown): unknown[] => {
  if (!isObjectRecord(message)) {
    return [];
  }
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content)
      ? message.content
      : [];
};

const readMessageText = (message: unknown): string =>
  readMessageContent(message)
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");

const isUserPrompt = (message: unknown): boolean =>
  isObjectRecord(message) &&
  message.role === "user" &&
  readMessageContent(message).some(
    (block) => !(isObjectRecord(block) && block.type === "tool_result")
  );

// A user turn that isn't only tool results starts a new prompt. Its text is
// part of the key so a prompt after compaction never reuses an earlier ID.
const readPromptKey = (messages: unknown[]): string => {
  const prompts = messages.filter(isUserPrompt);
  return `${prompts.length}:${readMessageText(prompts.at(-1))}`;
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
  apiKeyId?: string;
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
  const incoming = new Headers(input.headers);
  const messages =
    isObjectRecord(input.bodyJson) && Array.isArray(input.bodyJson.messages)
      ? input.bodyJson.messages
      : [];
  const sessionKey = `${input.apiKeyId ?? ""}:${input.providerAccountId ?? ""}`;
  const clientSession = readClaudeSessionHeader(incoming);
  const sessionId = hashUuid(
    `${sessionKey}:${
      clientSession
        ? `session:${clientSession}`
        : `message:${readMessageText(messages[0])}`
    }`
  );
  const userId = JSON.stringify({
    device_id: sha256Hex(`device:${sessionKey}`),
    account_uuid: input.metadata?.accountUuid ?? "",
    session_id: sessionId,
  });

  const { payload, toolNames } = mapClaudeRequestToolNames(input.bodyJson);
  const stripped = isObjectRecord(payload)
    ? withoutBillingHeader(payload)
    : payload;
  let transformedPayload = isObjectRecord(stripped)
    ? {
        ...stripped,
        system: withClaudeSystemIdentity(stripped.system),
        metadata: {
          ...(isObjectRecord(stripped.metadata) ? stripped.metadata : {}),
          user_id: userId,
        },
      }
    : stripped;
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

  const requestClass =
    incoming.get("x-claude-code-request-class")?.trim() ?? "";

  // Upstream gets exactly the headers interactive Claude Code sends to
  // api.anthropic.com, so client and SDK labels never pass through.
  for (const name of Array.from(input.headers.keys())) {
    input.headers.delete(name);
  }
  // Claude Code's SDK uses JSON Accept even for SSE responses.
  // https://unpkg.com/@anthropic-ai/sdk@0.128.0/src/client.ts
  input.headers.set("accept", "application/json");
  input.headers.set(
    "anthropic-beta",
    mergeBetaHeaders(
      incoming,
      readClaudeBetas(
        isObjectRecord(input.bodyJson) ? input.bodyJson.model : null,
        cache.found
      )
    )
  );
  input.headers.set("anthropic-dangerous-direct-browser-access", "true");
  input.headers.set("anthropic-version", "2023-06-01");
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("content-type", "application/json");
  input.headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  input.headers.set("x-app", "cli");
  input.headers.set(
    "x-claude-code-prompt-id",
    hashUuid(`${sessionId}:${readPromptKey(messages)}`)
  );
  input.headers.set(
    "x-claude-code-request-class",
    CLAUDE_REQUEST_CLASSES.has(requestClass) ? requestClass : "main"
  );
  input.headers.set("x-claude-code-session-id", sessionId);
  input.headers.set("x-client-request-id", crypto.randomUUID());
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
