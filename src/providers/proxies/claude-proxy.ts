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

// Anthropic custom tool names must match ^[a-zA-Z0-9_-]{1,64}$.
const CLAUDE_TOOL_NAME_MAX_LENGTH = 64;

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

const collectClaudeToolNames = (
  payload: unknown
): { names: string[]; serverToolNames: Set<string> } => {
  const names: string[] = [];
  const serverToolNames = new Set<string>();
  if (!isObjectRecord(payload)) {
    return { names, serverToolNames };
  }

  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!isObjectRecord(tool) || typeof tool.name !== "string") {
        continue;
      }
      names.push(tool.name);
      // Anthropic server tools (for example `web_search_20250305`) declare a
      // versioned type and must keep their documented names.
      if (typeof tool.type === "string" && tool.type !== "custom") {
        serverToolNames.add(tool.name);
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

  return { names, serverToolNames };
};

// Request: prefix tool names so they match Claude Code's expected format.
// Response: map names back so the client sees its original names.
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L214-L239
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L276-L294
// pi-mono uses case-normalized Claude Code tool names instead of a prefix:
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L64-L93
// Already-prefixed and server tool names are reserved before allocating
// prefixed names, so `Shell`, `shell`, and `mcp_Shell` can all round-trip in
// the same request.
const createClaudeToolNames = (
  payload: unknown,
  prefix: string
): ClaudeToolNames => {
  const { names, serverToolNames } = collectClaudeToolNames(payload);
  const originalToUpstream = new Map<string, string>();
  const upstreamToOriginal = new Map<string, string>();
  for (const name of names) {
    if (name.startsWith(prefix) || serverToolNames.has(name)) {
      originalToUpstream.set(name, name);
      upstreamToOriginal.set(name, name);
    }
  }

  for (const name of names) {
    if (originalToUpstream.has(name)) {
      continue;
    }
    const base =
      `${prefix}${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`.slice(
        0,
        CLAUDE_TOOL_NAME_MAX_LENGTH
      );
    let candidate = base;
    let suffix = 2;
    while (upstreamToOriginal.has(candidate)) {
      const ending = `_${suffix}`;
      suffix += 1;
      candidate = `${base.slice(0, CLAUDE_TOOL_NAME_MAX_LENGTH - ending.length)}${ending}`;
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

const transformClaudeResponseToolUse = (
  block: unknown,
  toolNames: ClaudeToolNames
): unknown => {
  if (
    !isObjectRecord(block) ||
    block.type !== "tool_use" ||
    typeof block.name !== "string"
  ) {
    return block;
  }

  const name = toolNames.client(block.name);
  return name === block.name ? block : { ...block, name };
};

const transformClaudeResponseMessage = (
  message: JsonObject,
  toolNames: ClaudeToolNames
): JsonObject => {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const content: unknown[] = message.content;
  const transformedContent = content.map((block) =>
    transformClaudeResponseToolUse(block, toolNames)
  );
  return transformedContent.every((block, index) => block === content[index])
    ? message
    : { ...message, content: transformedContent };
};

// Only rename tool_use blocks where Messages responses carry them. Tool inputs,
// partial JSON deltas, and unknown events keep their original names. Returns
// the same object when nothing changed so callers can skip re-serializing.
const transformClaudeResponsePayload = (
  payload: unknown,
  toolNames: ClaudeToolNames
): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  if (payload.type === "tool_use") {
    return transformClaudeResponseToolUse(payload, toolNames);
  }

  if (payload.type === "content_block_start") {
    const contentBlock = transformClaudeResponseToolUse(
      payload.content_block,
      toolNames
    );
    return contentBlock === payload.content_block
      ? payload
      : { ...payload, content_block: contentBlock };
  }

  if (payload.type === "message_start") {
    if (!isObjectRecord(payload.message)) {
      return payload;
    }
    const message = transformClaudeResponseMessage(payload.message, toolNames);
    return message === payload.message ? payload : { ...payload, message };
  }

  if (payload.type === "message" || payload.type === undefined) {
    return transformClaudeResponseMessage(payload, toolNames);
  }

  return payload;
};

const claudeMessagesUpstreamSuffix = requireProxyEndpointRoute({
  publicProvider: "anthropic",
  endpoint: "messages",
}).upstreamSuffix;

// OAuth requests need ?beta=true on the messages endpoint, so a caller-supplied
// beta flag is overridden rather than forwarded.
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L258-L263
const buildUpstreamUrl = (search: string): string => {
  const upstream = new URL(
    `${claudeMessagesUpstreamSuffix}${search}`,
    ANTHROPIC_API_BASE_URL
  );
  upstream.searchParams.set("beta", "true");

  return upstream.toString();
};

const isSseLineEndingChar = (char: string | undefined): boolean =>
  char === "\r" || char === "\n";

// An event ends at a blank line: two line endings, where a CRLF is one line
// ending, not two. The single-CR and single-LF cases must not match the halves
// of a CRLF pair. The pair is matched only at the start of each CR/LF run (the
// scan backs up to the start of a run that `startIndex` falls inside), which
// keeps a lookbehind-heavy regex off large event bodies. Before the end of the
// stream, a boundary whose last character is a CR at the end of the buffer is
// not accepted: the next read may start with its LF.
const findSseEventBoundary = (
  buffer: string,
  startIndex = 0,
  endOfStream = true
): { index: number; length: number } | null => {
  let scanFrom = startIndex;
  while (scanFrom > 0 && isSseLineEndingChar(buffer[scanFrom - 1])) {
    scanFrom--;
  }

  const lineEndingRuns = /[\r\n]+/gu;
  lineEndingRuns.lastIndex = scanFrom;
  for (
    let run = lineEndingRuns.exec(buffer);
    run;
    run = lineEndingRuns.exec(buffer)
  ) {
    const pair = /^(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/u.exec(run[0]);
    if (!pair) {
      continue;
    }

    const length = pair[0].length;
    if (
      !endOfStream &&
      run.index + length === buffer.length &&
      pair[0].endsWith("\r")
    ) {
      return null;
    }

    return { index: run.index, length };
  }

  return null;
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
  errorMessage: readClaudeErrorField(payload, "message"),
  errorParam: readClaudeErrorField(payload, "param"),
  errorStatus: readClaudeErrorField(payload, "status"),
});

// Replace all data lines of a complete event with one line carrying `payload`,
// keeping other fields in place and the event's own line endings. Truncated
// events (no terminating blank line) are forwarded unchanged.
const rewriteSseDataLines = (chunk: string, payload: string): string => {
  const boundary = findSseEventBoundary(chunk);
  if (!boundary || boundary.index + boundary.length !== chunk.length) {
    return chunk;
  }

  const body = chunk.slice(0, boundary.index);
  const trailer = chunk.slice(boundary.index);
  const newline =
    /\r\n|\r|\n/u.exec(body)?.[0] ??
    /^(?:\r\n|\r|\n)/u.exec(trailer)?.[0] ??
    "\n";
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

// Events that never carry usage, errors or tool names. Text deltas make up
// almost all of a stream, so they skip JSON parsing entirely.
const CLAUDE_PASSTHROUGH_EVENTS = new Set([
  "content_block_delta",
  "content_block_start",
  "content_block_stop",
  "message_stop",
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
  readStreamAnomaly: (payload: unknown) => void,
  onInvalidEvent: () => void
): string => {
  const eventName = readSseEventName(chunk);
  if (
    eventName !== null &&
    CLAUDE_PASSTHROUGH_EVENTS.has(eventName) &&
    !chunk.includes('"tool_use"')
  ) {
    // message_stop carries nothing else, but it still ends the stream.
    if (eventName === "message_stop") {
      readStreamAnomaly({ type: "message_stop" });
    }
    return chunk;
  }

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
  const transformed = transformClaudeResponsePayload(jsonBody, toolNames);
  return transformed === jsonBody
    ? chunk
    : rewriteSseDataLines(chunk, JSON.stringify(transformed));
};

const INVALID_STREAM_ERROR_EVENT = `event: error\ndata: ${JSON.stringify({
  type: "error",
  error: {
    type: "api_error",
    message: "Claude stream contains invalid events",
  },
})}\n\n`;

export type ClaudeStreamOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "rate_limited"
  | "overloaded";

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolNames: ClaudeToolNames,
  onTokenUsage?: ((usage: TokenUsage) => void) | null,
  onStreamOutcome?: ((outcome: ClaudeStreamOutcome) => void) | null
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
  let errorOutcome: ClaudeStreamOutcome = "failed";
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
  let sawStreamUsage = false;
  let usageReported = false;
  const reportStreamUsage = (): void => {
    if (usageReported || !sawStreamUsage) {
      return;
    }
    usageReported = true;
    onTokenUsage?.({ ...streamUsage });
  };

  // Usage is reported before the outcome so the outcome's request record can
  // include the observed tokens.
  const finishStream = (outcome: ClaudeStreamOutcome): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearKeepAlive?.();
    reportStreamUsage();
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

      sawStreamUsage = true;
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
      if (error?.type === "rate_limit_error") {
        errorOutcome = "rate_limited";
      } else if (error?.type === "overloaded_error") {
        errorOutcome = "overloaded";
      }
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

  const validateUtf8 = (value?: Uint8Array): void => {
    if (!utf8ValidationEnabled) {
      return;
    }
    try {
      validationDecoder.decode(value, { stream: value !== undefined });
    } catch {
      utf8ValidationEnabled = false;
      sawMalformedEvent = true;
      logStreamAnomaly("claude_sse_invalid_frame", {
        parseCategory: "invalid_utf8",
      });
    }
  };

  const appendText = (text: string): void => {
    buffer += text;
    bufferedBytes += encoder.encode(text).byteLength;
  };

  const assertBufferWithinLimit = (byteLength: number): void => {
    if (byteLength > MAX_CLAUDE_SSE_EVENT_BYTES) {
      throw new Error("Claude SSE event exceeds the proxy buffer limit");
    }
  };

  // Forward every complete buffered event. Returns "closed" once a terminal
  // event (message_stop or error) has been forwarded and the stream closed.
  const drainEvents = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    startIndex: number,
    endOfStream: boolean
  ): "closed" | "enqueued" | "pending" => {
    let enqueued = false;
    let boundary = findSseEventBoundary(buffer, startIndex, endOfStream);
    while (boundary) {
      const end = boundary.index + boundary.length;
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const chunkBytes = encoder.encode(chunk);
      bufferedBytes -= chunkBytes.byteLength;
      assertBufferWithinLimit(chunkBytes.byteLength);

      const transformed = transformSseEventChunk(
        chunk,
        toolNames,
        readStreamUsage,
        readStreamAnomaly,
        reportInvalidEvent
      );
      // A message_stop after malformed data, or without a message_start, must
      // not look like a clean completion to the client.
      const invalidTerminal =
        sawMessageStop && (!sawMessageStart || sawMalformedEvent);
      const outgoing = invalidTerminal
        ? INVALID_STREAM_ERROR_EVENT
        : transformed;
      try {
        controller.enqueue(
          outgoing === chunk ? chunkBytes : encoder.encode(outgoing)
        );
      } catch (error) {
        logStreamAnomaly("claude_sse_enqueue_failed", {}, error);
        throw error;
      }
      lastWriteAt = Date.now();
      enqueued = true;

      if (sawMessageStop || sawError) {
        finishStream(
          sawMalformedEvent || (sawMessageStop && !sawMessageStart)
            ? "failed"
            : sawError
              ? errorOutcome
              : "completed"
        );
        reader.cancel().catch(() => undefined);
        controller.close();
        return "closed";
      }
      boundary = findSseEventBoundary(buffer, 0, endOfStream);
    }

    return enqueued ? "enqueued" : "pending";
  };

  const finishAtEof = (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void => {
    // Any remaining event has no terminating blank line, so SSE clients will
    // discard it. Forward it anyway and classify the stream as incomplete.
    const hadTrailingEvent = buffer.trim().length > 0;
    assertBufferWithinLimit(bufferedBytes);
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
      bufferedBytes = 0;
    }
    if (hadTrailingEvent) {
      logStreamAnomaly("claude_sse_truncated_event");
    }

    const incomplete =
      !(sawMessageStart && sawMessageStop) ||
      hadTrailingEvent ||
      sawMalformedEvent;
    if (sawMessageStart && !sawError && incomplete) {
      // Let the client see the incomplete EOF. OpenCode classifies it as an
      // interrupted stream and can continue from partial output; a fabricated
      // API error event would bypass that recovery path.
      logStreamAnomaly("claude_sse_missing_message_stop");
    }
    finishStream(sawError ? errorOutcome : incomplete ? "failed" : "completed");
    controller.close();
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
            appendText(decoder.decode());
            validateUtf8();
            if (drainEvents(controller, 0, true) !== "closed") {
              finishAtEof(controller);
            }
            return;
          }

          if (!value) {
            continue;
          }

          bytes += value.byteLength;
          chunks++;
          lastChunkAt = Date.now();
          validateUtf8(value);
          const previousBufferLength = buffer.length;
          appendText(decoder.decode(value, { stream: true }));

          // A boundary is at most four characters, so one completed by the
          // new text starts at most three characters before it.
          const drained = drainEvents(
            controller,
            Math.max(0, previousBufferLength - 3),
            false
          );
          if (drained === "closed") {
            return;
          }
          assertBufferWithinLimit(bufferedBytes);
          if (drained === "enqueued") {
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
  onStreamOutcome?: ((outcome: ClaudeStreamOutcome) => void) | null
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
  // Called once with the terminal outcome of a streaming (SSE) response.
  onStreamOutcome?: ((outcome: ClaudeStreamOutcome) => void) | null;
};

type ClaudeProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareClaudeProxyRequest = (
  input: ClaudeProxyPreparationInput
): ClaudeProxyPreparationResult => {
  const toolPrefix = CLAUDE_TOOL_PREFIX;
  const systemIdentity = CLAUDE_SYSTEM_IDENTITY;
  const mergedBetas = mergeBetaHeaders(
    input.headers,
    CLAUDE_REQUIRED_BETA_HEADERS
  );

  // OAuth sessions require Claude Code identity headers.
  // https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L525-L538
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("anthropic-beta", mergedBetas);
  // Keep existing accounts on the minimum supported Claude Code version even
  // when their persisted metadata still contains an older user agent.
  input.headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  input.headers.set("x-app", "cli");

  const toolNames = createClaudeToolNames(input.bodyJson, toolPrefix);
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
