import type { ClaudeAccountMetadata } from "../metadata";

import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
} from "../constants";
import { requireProxyEndpointRoute } from "../proxy-endpoints";
import {
  readAnthropicUsageFromResponse,
  readAnthropicUsageObject,
  type TokenUsage,
} from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord, type JsonObject } from "../../utils/object";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

const MAX_CLAUDE_SSE_EVENT_BYTES = 4 * 1024 * 1024;

// Anthropic OAuth sessions reject the feedback repo path used in OpenCode's
// prompt URL and the opening `<directories>` wrapper emitted by OpenCode's
// system prompt assembly. Apply these workarounds to every system text block:
// subagent prompts need them even when they do not start with OpenCode's
// primary-agent introduction.
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
    .replace(/<directories>\n\s*/gi, "Directories\n");

const fromClaudeToolName = (name: string, prefix: string): string => {
  if (!name.startsWith(prefix)) {
    return name;
  }

  const rest = name.slice(prefix.length);
  if (!rest) {
    return rest;
  }

  return `${rest[0]?.toLowerCase() ?? ""}${rest.slice(1)}`;
};

type ClaudeToolNames = {
  upstream(name: string): string;
  client(name: string): string;
};

// Reserve already-prefixed names before allocating transformed names so
// `Shell`, `shell`, and `mcp_Shell` can all round-trip in the same request.
const createClaudeToolNames = (
  payload: unknown,
  prefix: string
): ClaudeToolNames => {
  const names: string[] = [];
  const passthroughNames = new Set<string>();
  if (isObjectRecord(payload)) {
    if (Array.isArray(payload.tools)) {
      for (const tool of payload.tools) {
        if (isObjectRecord(tool) && typeof tool.name === "string") {
          names.push(tool.name);
          if (typeof tool.type === "string" && tool.type !== "custom") {
            passthroughNames.add(tool.name);
          }
        }
      }
    }
    if (
      isObjectRecord(payload.tool_choice) &&
      typeof payload.tool_choice.name === "string"
    ) {
      names.push(payload.tool_choice.name);
    }
    if (Array.isArray(payload.messages)) {
      for (const message of payload.messages) {
        if (!isObjectRecord(message) || !Array.isArray(message.content)) {
          continue;
        }
        for (const block of message.content) {
          if (
            isObjectRecord(block) &&
            block.type === "tool_use" &&
            typeof block.name === "string"
          ) {
            names.push(block.name);
          }
        }
      }
    }
  }

  const originalToUpstream = new Map<string, string>();
  const upstreamToOriginal = new Map<string, string>();
  for (const name of names) {
    if (name.startsWith(prefix) || passthroughNames.has(name)) {
      originalToUpstream.set(name, name);
      upstreamToOriginal.set(name, name);
    }
  }
  for (const name of names) {
    if (originalToUpstream.has(name)) {
      continue;
    }
    const base =
      `${prefix}${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`.slice(0, 64);
    let candidate = base;
    let suffix = 2;
    while (upstreamToOriginal.has(candidate)) {
      const ending = `_${suffix++}`;
      candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
    }
    originalToUpstream.set(name, candidate);
    upstreamToOriginal.set(candidate, name);
  }

  return {
    upstream: (name) => originalToUpstream.get(name) ?? name,
    client: (name) =>
      upstreamToOriginal.get(name) ?? fromClaudeToolName(name, prefix),
  };
};

const transformClaudeRequestPayload = (
  payload: unknown,
  toolNames: ClaudeToolNames,
  systemIdentity: string
): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  const transformed: JsonObject = { ...payload };

  if (typeof transformed.system === "string") {
    const sanitizedSystem = sanitizeClaudeSystemText(transformed.system);
    const systemBlocks: Array<{ type: string; text: string }> = [
      { type: "text", text: systemIdentity },
    ];
    if (sanitizedSystem !== systemIdentity) {
      systemBlocks.push({ type: "text", text: sanitizedSystem });
    }
    transformed.system = systemBlocks;
  } else if (Array.isArray(transformed.system)) {
    const systemBlocks: unknown[] = [{ type: "text", text: systemIdentity }];
    for (const block of transformed.system) {
      if (
        isObjectRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        if (block.text !== systemIdentity) {
          systemBlocks.push({
            ...block,
            text: sanitizeClaudeSystemText(block.text),
          });
        }
        continue;
      }

      systemBlocks.push(block);
    }
    transformed.system = systemBlocks;
  } else if (transformed.system == null) {
    transformed.system = [{ type: "text", text: systemIdentity }];
  }

  if (Array.isArray(transformed.tools)) {
    transformed.tools = transformed.tools.map((tool) => {
      if (!isObjectRecord(tool) || typeof tool.name !== "string") {
        return tool;
      }

      return {
        ...tool,
        name: toolNames.upstream(tool.name),
      };
    });
  }

  if (
    isObjectRecord(transformed.tool_choice) &&
    transformed.tool_choice.type === "tool" &&
    typeof transformed.tool_choice.name === "string"
  ) {
    transformed.tool_choice = {
      ...transformed.tool_choice,
      name: toolNames.upstream(transformed.tool_choice.name),
    };
  }

  if (Array.isArray(transformed.messages)) {
    transformed.messages = transformed.messages.map((message) => {
      if (!isObjectRecord(message) || !Array.isArray(message.content)) {
        return message;
      }

      return {
        ...message,
        content: message.content.map((block) => {
          if (
            !isObjectRecord(block) ||
            block.type !== "tool_use" ||
            typeof block.name !== "string"
          ) {
            return block;
          }

          return {
            ...block,
            name: toolNames.upstream(block.name),
          };
        }),
      };
    });
  }

  return transformed;
};

const transformClaudeResponsePayload = (
  payload: unknown,
  toolNames: ClaudeToolNames
): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  if (payload.type === "tool_use" && typeof payload.name === "string") {
    const name = toolNames.client(payload.name);
    return name === payload.name ? payload : { ...payload, name };
  }
  if (
    payload.type === "content_block_start" &&
    isObjectRecord(payload.content_block)
  ) {
    const contentBlock = transformClaudeResponsePayload(
      payload.content_block,
      toolNames
    );
    return contentBlock === payload.content_block
      ? payload
      : { ...payload, content_block: contentBlock };
  }
  if (payload.type === "message_start" && isObjectRecord(payload.message)) {
    const message = transformClaudeResponsePayload(payload.message, toolNames);
    return message === payload.message ? payload : { ...payload, message };
  }
  if (
    (payload.type === "message" || payload.type === undefined) &&
    Array.isArray(payload.content)
  ) {
    const originalContent: unknown[] = payload.content;
    const content = originalContent.map((block) =>
      isObjectRecord(block) && block.type === "tool_use"
        ? transformClaudeResponsePayload(block, toolNames)
        : block
    );
    return content.every((block, index) => block === originalContent[index])
      ? payload
      : { ...payload, content };
  }
  return payload;
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

const findSseEventBoundary = (
  buffer: string,
  startIndex = 0
): { index: number; length: number } | null => {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/u.exec(buffer.slice(startIndex));
  if (!match || match.index === undefined) {
    return null;
  }

  return {
    index: startIndex + match.index,
    length: match[0].length,
  };
};

const parseSseEventData = (chunk: string): string | null => {
  const dataLines = chunk
    .replace(/\r\n|\r/gu, "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => (line === "data" ? "" : line.slice(5).trimStart()));
  if (!dataLines.length) {
    return null;
  }

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }

  return data;
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
  errorStatus: readClaudeErrorField(payload, "status"),
});

const rewriteSseDataLines = (chunk: string, payload: string): string => {
  const boundary = findSseEventBoundary(chunk);
  if (!boundary || boundary.index + boundary.length !== chunk.length) {
    return chunk;
  }
  const body = chunk.slice(0, boundary.index);
  const trailer = chunk.slice(boundary.index);
  const newline =
    /\r\n|\r|\n/u.exec(body)?.[0] ??
    (trailer.startsWith("\r\n")
      ? "\r\n"
      : trailer.startsWith("\r")
        ? "\r"
        : "\n");
  const lines: string[] = [];
  let replaced = false;
  for (const line of body.split(/\r\n|\r|\n/u)) {
    if (line === "data" || line.startsWith("data:")) {
      if (!replaced) {
        lines.push(`data: ${payload}`);
        replaced = true;
      }
      continue;
    }
    lines.push(line);
  }
  return replaced ? `${lines.join(newline)}${trailer}` : chunk;
};

const transformSseEventChunk = (
  chunk: string,
  toolNames: ClaudeToolNames,
  readStreamUsage: (payload: unknown) => void,
  readStreamAnomaly: (payload: unknown) => void,
  onInvalidEvent: () => void
): string => {
  const payload = parseSseEventData(chunk);
  if (!payload) {
    return chunk;
  }

  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(payload) as unknown;
  } catch {
    onInvalidEvent();
    return chunk;
  }
  if (!isObjectRecord(jsonBody)) {
    onInvalidEvent();
    return chunk;
  }
  readStreamUsage(jsonBody);
  readStreamAnomaly(jsonBody);
  if (
    jsonBody.type !== "content_block_start" &&
    jsonBody.type !== "message_start" &&
    jsonBody.type !== "tool_use"
  ) {
    return chunk;
  }
  const transformed = transformClaudeResponsePayload(jsonBody, toolNames);
  return transformed === jsonBody
    ? chunk
    : rewriteSseDataLines(chunk, JSON.stringify(transformed));
};

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamOutcome?: (outcome: ClaudeStreamOutcome) => void
): Response => {
  if (!response.body) {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return response;
  }

  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const validationDecoder = new TextDecoder("utf-8", { fatal: true });
  const startedAt = Date.now();
  let buffer = "";
  let bufferedBytes = 0;
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let sawMessageStart = false;
  let sawMessageStop = false;
  let sawError = false;
  let streamErrorOutcome: ClaudeStreamOutcome = "failed";
  let sawMalformedEvent = false;
  let utf8ValidationEnabled = true;
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

  const finishStream = (outcome: ClaudeStreamOutcome): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearKeepAlive?.();
    onTokenUsage?.(streamUsage);
    onStreamOutcome?.(outcome);
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

      streamUsage.inputTokens = usage.inputTokens;
      streamUsage.outputTokens = usage.outputTokens;
      streamUsage.cacheReadTokens = usage.cacheReadTokens;
      streamUsage.cacheWriteTokens = usage.cacheWriteTokens;
      return;
    }

    if (payload.type === "message_delta") {
      const usage = isObjectRecord(payload.usage) ? payload.usage : null;
      if (!usage) {
        return;
      }

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

    if (payload.type === "message_start") {
      sawMessageStart = true;
      return;
    }
    if (payload.type === "message_stop") {
      sawMessageStop = true;
      return;
    }
    if (payload.type === "error") {
      sawError = true;
      const error = isObjectRecord(payload.error) ? payload.error : null;
      streamErrorOutcome =
        error?.type === "rate_limit_error"
          ? "rate_limited"
          : error?.type === "overloaded_error"
            ? "overloaded"
            : "failed";
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

  const reportInvalidEvent = (): void => {
    if (sawMalformedEvent) {
      return;
    }
    sawMalformedEvent = true;
    logStreamAnomaly("claude_sse_invalid_event", {
      parseCategory: "invalid_json_or_non_object",
    });
  };

  const reportInvalidUtf8 = (): void => {
    if (!utf8ValidationEnabled) {
      return;
    }
    utf8ValidationEnabled = false;
    sawMalformedEvent = true;
    logStreamAnomaly("claude_sse_invalid_frame", {
      parseCategory: "invalid_utf8",
    });
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
            const trailingText = decoder.decode();
            buffer += trailingText;
            bufferedBytes += encoder.encode(trailingText).byteLength;
            if (utf8ValidationEnabled) {
              try {
                validationDecoder.decode();
              } catch {
                reportInvalidUtf8();
              }
            }
            const hadTrailingEvent = buffer.trim().length > 0;
            if (bufferedBytes > MAX_CLAUDE_SSE_EVENT_BYTES) {
              throw new Error(
                "Claude SSE event exceeds the proxy buffer limit"
              );
            }
            if (buffer) {
              controller.enqueue(
                encoder.encode(
                  transformSseEventChunk(
                    buffer,
                    toolNames,
                    readStreamUsage,
                    readStreamAnomaly,
                    reportInvalidEvent
                  )
                )
              );
              lastWriteAt = Date.now();
              buffer = "";
            }
            if (hadTrailingEvent) {
              logStreamAnomaly("claude_sse_truncated_event");
            }
            if (
              sawMessageStart &&
              !sawError &&
              (!sawMessageStop || hadTrailingEvent || sawMalformedEvent)
            ) {
              logStreamAnomaly("claude_sse_missing_message_stop");
              controller.enqueue(
                encoder.encode(
                  `${hadTrailingEvent ? "\n\n" : ""}event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Claude stream ended before message_stop"}}\n\n`
                )
              );
            }
            finishStream(
              sawError
                ? streamErrorOutcome
                : !sawMessageStart ||
                    !sawMessageStop ||
                    hadTrailingEvent ||
                    sawMalformedEvent
                  ? "failed"
                  : "completed"
            );
            controller.close();
            return;
          }

          if (!value) {
            continue;
          }

          bytes += value.byteLength;
          chunks++;
          lastChunkAt = Date.now();
          if (utf8ValidationEnabled) {
            try {
              validationDecoder.decode(value, { stream: true });
            } catch {
              reportInvalidUtf8();
            }
          }
          const decoded = decoder.decode(value, { stream: true });
          const previousBufferLength = buffer.length;
          buffer += decoded;
          bufferedBytes += encoder.encode(decoded).byteLength;

          let enqueued = false;
          // A delimiter is at most four characters, so only its final three
          // characters can precede the newly appended text.
          let boundary = findSseEventBoundary(
            buffer,
            Math.max(0, previousBufferLength - 3)
          );
          while (boundary) {
            const chunk = buffer.slice(0, boundary.index + boundary.length);
            buffer = buffer.slice(boundary.index + boundary.length);
            const chunkBytes = encoder.encode(chunk);
            bufferedBytes -= chunkBytes.byteLength;
            if (chunkBytes.byteLength > MAX_CLAUDE_SSE_EVENT_BYTES) {
              throw new Error(
                "Claude SSE event exceeds the proxy buffer limit"
              );
            }
            try {
              const transformed = transformSseEventChunk(
                chunk,
                toolNames,
                readStreamUsage,
                readStreamAnomaly,
                reportInvalidEvent
              );
              const invalidTerminal =
                sawMessageStop && (!sawMessageStart || sawMalformedEvent);
              const outgoing = invalidTerminal
                ? 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Claude stream contains invalid events"}}\n\n'
                : transformed;
              controller.enqueue(
                outgoing === chunk ? chunkBytes : encoder.encode(outgoing)
              );
              lastWriteAt = Date.now();
              enqueued = true;
              if (sawMessageStop || sawError) {
                finishStream(
                  sawMalformedEvent || (sawMessageStop && !sawMessageStart)
                    ? "failed"
                    : sawError
                      ? streamErrorOutcome
                      : "completed"
                );
                reader.cancel().catch(() => undefined);
                controller.close();
                return;
              }
            } catch (error) {
              logStreamAnomaly("claude_sse_enqueue_failed", {}, error);
              throw error;
            }
            boundary = findSseEventBoundary(buffer);
          }
          if (bufferedBytes > MAX_CLAUDE_SSE_EVENT_BYTES) {
            throw new Error("Claude SSE event exceeds the proxy buffer limit");
          }
          if (enqueued) {
            return;
          }
        }
      } catch (error) {
        if (closed) {
          clearKeepAlive?.();
          return;
        }
        finishStream("failed");
        logStreamAnomaly("claude_sse_stream_failed", {}, error);
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      finishStream("cancelled");
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
  headers.delete("content-encoding");
  headers.delete("content-length");
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
  onStreamOutcome?: (outcome: ClaudeStreamOutcome) => void
): Promise<Response> => {
  if (!response.body) {
    return Promise.resolve(response);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return Promise.resolve(
      maybeTransformClaudeStreamResponse(
        response,
        toolNames,
        onTokenUsage,
        onStreamOutcome
      )
    );
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
  onStreamOutcome?: (outcome: ClaudeStreamOutcome) => void;
};

type ClaudeStreamOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "rate_limited"
  | "overloaded";

type ClaudeProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareClaudeProxyRequest = (
  input: ClaudeProxyPreparationInput
): ClaudeProxyPreparationResult => {
  const toolNames = createClaudeToolNames(input.bodyJson, CLAUDE_TOOL_PREFIX);
  const systemIdentity = CLAUDE_SYSTEM_IDENTITY;
  const mergedBetas = mergeBetaHeaders(
    input.headers,
    CLAUDE_REQUIRED_BETA_HEADERS
  );

  // OAuth sessions require Claude Code identity headers.
  // https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L525-L538
  // Claude Code's Messages client uses the 2023-06-01 API version and accepts
  // JSON even when `stream: true` requests an SSE response.
  input.headers.delete("x-api-key");
  input.headers.delete("cookie");
  input.headers.delete("proxy-authorization");
  input.headers.delete("content-encoding");
  input.headers.delete("content-length");
  input.headers.delete("host");
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("anthropic-version", "2023-06-01");
  input.headers.set("anthropic-beta", mergedBetas);
  input.headers.set("accept", "application/json");
  input.headers.set("content-type", "application/json");
  // Keep existing accounts on the minimum supported Claude Code version even
  // when their persisted metadata still contains an older user agent.
  input.headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  input.headers.set("x-app", "cli");

  const transformedPayload = transformClaudeRequestPayload(
    input.bodyJson,
    toolNames,
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
        input.onStreamOutcome
      ),
  };
};
