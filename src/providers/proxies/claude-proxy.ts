import type { ClaudeAccountMetadata } from "../metadata";

import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
} from "../constants";
import { requireProxyEndpointRoute } from "../proxy-endpoints";
import {
  readAnthropicUsageFromResponse,
  readAnthropicUsageObject,
  type TokenUsage,
} from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord, type JsonObject, withField } from "../../utils/object";
import {
  type ClaudeToolNames,
  mapClaudeRequestToolNames,
} from "./claude-tool-names";
import {
  createSseEventFramer,
  readSseData,
  replaceSseData,
} from "./sse-events";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

// Anthropic OAuth sessions reject the feedback repo path used in OpenCode's
// prompt URL and the opening `<directories>` wrapper emitted by OpenCode's
// system prompt assembly. Apply the smallest known working rewrite to all
// Claude system prompts so primary-agent and subagent requests behave the same.
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

const withClaudeSystemIdentity = (
  system: unknown,
  systemIdentity: string
): unknown => {
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
    (block) => isTextBlock(block) && block.text === systemIdentity
  )
    ? sanitized
    : [{ type: "text", text: systemIdentity }, ...sanitized];
};

const transformClaudeRequestPayload = (
  payload: unknown,
  systemIdentity: string
): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  return {
    ...payload,
    system: withClaudeSystemIdentity(payload.system, systemIdentity),
  };
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

const truncateLogValue = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
};

const readClaudeErrorField = (
  payload: Record<string, unknown>,
  key: string
): string | number | boolean | null => {
  const error = isObjectRecord(payload.error) ? payload.error : null;
  const value = error?.[key] ?? payload[key];
  if (typeof value === "string") {
    return truncateLogValue(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
};

const readClaudeErrorLogFields = (
  payload: Record<string, unknown>
): Record<string, string | number | boolean | null> => ({
  payloadType: String(payload.type),
  errorType: readClaudeErrorField(payload, "type"),
  errorCode: readClaudeErrorField(payload, "code"),
  errorMessage: readClaudeErrorField(payload, "message"),
  errorParam: readClaudeErrorField(payload, "param"),
  errorStatus: readClaudeErrorField(payload, "status"),
});

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
  readStreamUsage: (payload: unknown) => void,
  readStreamAnomaly: (payload: unknown) => void
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
    readStreamUsage(jsonBody);
    readStreamAnomaly(jsonBody);
    const transformed = transformClaudeResponsePayload(jsonBody, toolNames);
    return transformed === jsonBody
      ? chunk
      : replaceSseData(chunk, JSON.stringify(transformed));
  } catch {
    return chunk;
  }
};

// 529 is Anthropic's overloaded status.
const readStreamErrorStatus = (payload: Record<string, unknown>): number => {
  const type = isObjectRecord(payload.error) ? payload.error.type : null;
  if (type === "rate_limit_error") {
    return 429;
  }
  return type === "overloaded_error" ? 529 : 502;
};

export const isEventStreamResponse = (response: Response): boolean =>
  response.body !== null &&
  (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamEnd?: ((statusCode: number) => void) | null
): Response => {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const framer = createSseEventFramer();
  const startedAt = Date.now();
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let endStatus: number | null = response.ok ? null : response.status;
  let clearKeepAlive: (() => void) | null = null;

  const logStreamAnomaly = (
    event: string,
    fields: Record<string, string | number | boolean | null> = {},
    error?: unknown
  ): void => {
    logWarn(event, {
      provider: "claude",
      transport: "sse_transform",
      elapsedMs: Date.now() - startedAt,
      idleMs: Date.now() - lastChunkAt,
      downstreamIdleMs: Date.now() - lastWriteAt,
      bytes,
      chunks,
      ...fields,
      ...(error === undefined ? {} : errorLogFields(error)),
    });
  };

  const streamUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sawStreamUsage = false;
  let usageReported = false;
  const reportStreamUsage = (): void => {
    if (usageReported || !sawStreamUsage) {
      return;
    }
    usageReported = true;
    onTokenUsage?.({ ...streamUsage });
  };

  // Usage goes first so the request recorded at the end includes it.
  const finishStream = (fallbackStatus: number): void => {
    closed = true;
    clearKeepAlive?.();
    reportStreamUsage();
    onStreamEnd?.(endStatus ?? fallbackStatus);
  };

  const readOptionalUsageToken = (
    usage: Record<string, unknown>,
    key: string
  ): number | null => {
    if (!(key in usage)) {
      return null;
    }

    const value = usage[key];
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(0, Math.trunc(parsed));
  };

  const readStreamUsage = (payload: unknown): void => {
    if (!isObjectRecord(payload)) {
      return;
    }

    if (payload.type === "message_start") {
      const message = isObjectRecord(payload.message) ? payload.message : null;
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
      const inputTokens = readOptionalUsageToken(usage, "input_tokens");
      if (inputTokens !== null) {
        streamUsage.inputTokens = inputTokens;
      }

      const outputTokens = readOptionalUsageToken(usage, "output_tokens");
      if (outputTokens !== null) {
        streamUsage.outputTokens = outputTokens;
      }

      const cacheReadTokens = readOptionalUsageToken(
        usage,
        "cache_read_input_tokens"
      );
      if (cacheReadTokens !== null) {
        streamUsage.cacheReadTokens = cacheReadTokens;
      }

      const cacheWriteTokens = readOptionalUsageToken(
        usage,
        "cache_creation_input_tokens"
      );
      if (cacheWriteTokens !== null) {
        streamUsage.cacheWriteTokens = cacheWriteTokens;
      }
    }
  };

  const readStreamAnomaly = (payload: unknown): void => {
    if (!isObjectRecord(payload)) {
      return;
    }

    if (payload.type === "message_stop") {
      endStatus ??= 200;
      return;
    }

    if (payload.type === "error") {
      endStatus ??= readStreamErrorStatus(payload);
      logStreamAnomaly(
        "claude_sse_error_event",
        readClaudeErrorLogFields(payload)
      );
      return;
    }

    if (payload.type !== "message_delta") {
      return;
    }
    const delta = isObjectRecord(payload.delta) ? payload.delta : null;
    const stopReason = delta?.stop_reason;
    if (stopReason === "max_tokens") {
      logStreamAnomaly("claude_sse_max_tokens_stop");
    }
  };

  const transformEvents = (events: string[]): string => {
    let output = "";
    for (const event of events) {
      output += transformSseEventChunk(
        event,
        toolNames,
        readStreamUsage,
        readStreamAnomaly
      );
    }
    return output;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      clearKeepAlive = createSseKeepAlive(controller, {
        provider: "claude",
        transport: "sse_transform",
        getElapsedMs: () => Date.now() - startedAt,
        onKeepAlive: () => {
          lastWriteAt = Date.now();
        },
      }).clear;
    },
    async pull(controller): Promise<void> {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (closed) {
              clearKeepAlive?.();
              return;
            }
            const { events, rest } = framer.end();
            const output = transformEvents(rest ? [...events, rest] : events);
            if (output) {
              controller.enqueue(encoder.encode(output));
              lastWriteAt = Date.now();
            }
            // Forwarded as is: OpenCode treats an EOF without message_stop as
            // an interrupted stream and can continue from the partial output.
            if (endStatus === null) {
              logStreamAnomaly("claude_sse_missing_message_stop", {
                truncatedEvent: rest.trim().length > 0,
              });
            }
            finishStream(502);
            controller.close();
            return;
          }

          if (!value) {
            continue;
          }

          bytes += value.byteLength;
          chunks++;
          lastChunkAt = Date.now();
          const events = framer.push(value);
          if (!events.length) {
            continue;
          }
          try {
            controller.enqueue(encoder.encode(transformEvents(events)));
          } catch (error) {
            logStreamAnomaly("claude_sse_enqueue_failed", {}, error);
            throw error;
          }
          lastWriteAt = Date.now();
          return;
        }
      } catch (error) {
        if (closed) {
          clearKeepAlive?.();
          return;
        }
        finishStream(502);
        logStreamAnomaly("claude_sse_stream_failed", {}, error);
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      if (!closed) {
        // 499: the client closed the request.
        finishStream(499);
      }
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: createSseResponseHeaders(response.headers),
  });
};

const maybeTransformClaudeJsonResponse = async (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
): Promise<Response> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response;
  }

  const bodyText = await response.text();
  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(bodyText) as unknown;
  } catch {
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const transformedBody = transformClaudeResponsePayload(jsonBody, toolNames);
  const usage = readAnthropicUsageFromResponse(jsonBody);
  if (usage) {
    onTokenUsage?.(usage);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (transformedBody === jsonBody) {
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return Response.json(transformedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const transformClaudeResponse = (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamEnd?: ((statusCode: number) => void) | null
): Promise<Response> => {
  if (isEventStreamResponse(response)) {
    return Promise.resolve(
      maybeTransformClaudeStreamResponse(
        response,
        toolNames,
        onTokenUsage,
        onStreamEnd
      )
    );
  }
  if (!response.body) {
    return Promise.resolve(response);
  }

  return maybeTransformClaudeJsonResponse(response, toolNames, onTokenUsage);
};

const mergeBetaHeaders = (headers: Headers, required: readonly string[]) => {
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set([...required, ...incoming])].join(",");
};

type ClaudeProxyPreparationInput = {
  requestUrl: URL;
  headers: Headers;
  bodyText: string;
  bodyJson: unknown;
  accessToken: string;
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
  const systemIdentity = CLAUDE_SYSTEM_IDENTITY;
  const mergedBetas = mergeBetaHeaders(
    input.headers,
    CLAUDE_REQUIRED_BETA_HEADERS
  );

  // OAuth sessions require Claude Code identity headers.
  // https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L525-L538
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("anthropic-beta", mergedBetas);
  input.headers.set("anthropic-version", "2023-06-01");
  input.headers.set("content-type", "application/json");
  // Claude Code's SDK uses JSON Accept even for SSE responses.
  // https://unpkg.com/@anthropic-ai/sdk@0.128.0/src/client.ts
  input.headers.set("accept", "application/json");
  // Keep existing accounts on the minimum supported Claude Code version even
  // when their persisted metadata still contains an older user agent.
  input.headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  input.headers.set("x-app", "cli");

  const { payload, toolNames } = mapClaudeRequestToolNames(input.bodyJson);
  const transformedPayload = transformClaudeRequestPayload(
    payload,
    systemIdentity
  );
  const bodyText =
    transformedPayload !== input.bodyJson
      ? JSON.stringify(transformedPayload)
      : input.bodyText;

  return {
    upstreamUrl: buildUpstreamUrl(input.requestUrl.search),
    bodyText,
    transformResponse: (response: Response): Promise<Response> =>
      transformClaudeResponse(
        response,
        toolNames,
        input.onTokenUsage,
        input.onStreamEnd
      ),
  };
};
