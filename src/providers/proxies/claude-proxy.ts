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
import { isObjectRecord, type JsonObject } from "../../utils/object";

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
    .replace(/<directories>\n\s*/gi, "Directories\n");

const toClaudeToolName = (name: string, prefix: string): string => {
  if (name.startsWith(prefix)) {
    return name;
  }

  return `${prefix}${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
};

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

// Request: prefix tool names so they match Claude Code's expected format.
// Response: strip prefixes back so the client sees its original names.
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L214-L239
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L276-L294
// pi-mono uses case-normalized Claude Code tool names instead of a prefix:
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L64-L93
const prefixToolName = (name: string, prefix: string): string =>
  toClaudeToolName(name, prefix);

const stripToolNamePrefix = (name: string, prefix: string): string =>
  fromClaudeToolName(name, prefix);

const transformClaudeRequestPayload = (
  payload: unknown,
  toolPrefix: string,
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
        systemBlocks.push({
          ...block,
          text: sanitizeClaudeSystemText(block.text),
        });
        continue;
      }

      systemBlocks.push(block);
    }
    transformed.system = systemBlocks;
  }

  if (Array.isArray(transformed.tools)) {
    transformed.tools = transformed.tools.map((tool) => {
      if (!isObjectRecord(tool) || typeof tool.name !== "string") {
        return tool;
      }

      return {
        ...tool,
        name: prefixToolName(tool.name, toolPrefix),
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
      name: prefixToolName(transformed.tool_choice.name, toolPrefix),
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
            name: prefixToolName(block.name, toolPrefix),
          };
        }),
      };
    });
  }

  return transformed;
};

const transformClaudeResponsePayload = (
  payload: unknown,
  toolPrefix: string
): unknown => {
  if (Array.isArray(payload)) {
    return payload.map((item) =>
      transformClaudeResponsePayload(item, toolPrefix)
    );
  }

  if (!isObjectRecord(payload)) {
    return payload;
  }

  const transformed: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    transformed[key] = transformClaudeResponsePayload(value, toolPrefix);
  }

  if (transformed.type === "tool_use" && typeof transformed.name === "string") {
    transformed.name = stripToolNamePrefix(transformed.name, toolPrefix);
  }

  return transformed;
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
  if (!upstream.searchParams.has("beta")) {
    upstream.searchParams.set("beta", "true");
  }

  return upstream.toString();
};

const findSseEventBoundary = (
  buffer: string
): { index: number; length: number } | null => {
  const match = /\r\n\r\n|\n\n|\n\r\n|\r\n\n/u.exec(buffer);
  if (!match || match.index === undefined) {
    return null;
  }

  return {
    index: match.index,
    length: match[0].length,
  };
};

const parseSseEventData = (chunk: string): string | null => {
  const dataLines = chunk
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) {
    return null;
  }

  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }

  return data;
};

const rewriteSseDataLines = (chunk: string, payload: string): string => {
  const boundary = findSseEventBoundary(chunk);
  const eventTrailer =
    boundary && boundary.index + boundary.length === chunk.length
      ? chunk.slice(boundary.index)
      : "";
  const chunkBody = eventTrailer ? chunk.slice(0, -eventTrailer.length) : chunk;
  const rewrittenBody = chunkBody.replace(
    /((?:^|\r\n|\n))(?:data:.*(?:\r\n|\n)?)+$/u,
    (_, separator: string) => `${separator}data: ${payload}`
  );

  if (rewrittenBody === chunkBody) {
    return chunk;
  }

  return `${rewrittenBody}${eventTrailer}`;
};

const transformSseEventChunk = (
  chunk: string,
  toolPrefix: string,
  readStreamUsage: (payload: unknown) => void
): string => {
  const payload = parseSseEventData(chunk);
  if (!payload) {
    return chunk;
  }

  try {
    const jsonBody = JSON.parse(payload) as unknown;
    readStreamUsage(jsonBody);
    const transformed = transformClaudeResponsePayload(jsonBody, toolPrefix);
    return rewriteSseDataLines(chunk, JSON.stringify(transformed));
  } catch {
    return chunk;
  }
};

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolPrefix: string,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
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
  let buffer = "";

  const streamUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const pump = async (): Promise<void> => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              if (buffer) {
                controller.enqueue(
                  encoder.encode(
                    transformSseEventChunk(buffer, toolPrefix, readStreamUsage)
                  )
                );
                buffer = "";
              }
              onTokenUsage?.(streamUsage);
              controller.close();
              return;
            }

            if (!value) {
              continue;
            }

            buffer += decoder.decode(value, { stream: true });

            let boundary = findSseEventBoundary(buffer);
            while (boundary) {
              const chunk = buffer.slice(0, boundary.index + boundary.length);
              buffer = buffer.slice(boundary.index + boundary.length);
              controller.enqueue(
                encoder.encode(
                  transformSseEventChunk(chunk, toolPrefix, readStreamUsage)
                )
              );
              boundary = findSseEventBoundary(buffer);
            }
          }
        } catch (error) {
          controller.error(error);
        }
      };

      pump().catch((error: unknown) => {
        controller.error(error);
      });
    },
    cancel(reason): Promise<void> {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const maybeTransformClaudeJsonResponse = async (
  response: Response,
  toolPrefix: string,
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

  const transformedBody = transformClaudeResponsePayload(jsonBody, toolPrefix);
  const usage = readAnthropicUsageFromResponse(jsonBody);
  if (usage) {
    onTokenUsage?.(usage);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(transformedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const transformClaudeResponse = (
  response: Response,
  toolPrefix: string,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
): Promise<Response> => {
  if (!response.body) {
    return Promise.resolve(response);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return Promise.resolve(
      maybeTransformClaudeStreamResponse(response, toolPrefix, onTokenUsage)
    );
  }

  return maybeTransformClaudeJsonResponse(response, toolPrefix, onTokenUsage);
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
};

type ClaudeProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareClaudeProxyRequest = (
  input: ClaudeProxyPreparationInput
): ClaudeProxyPreparationResult => {
  const toolPrefix = input.metadata?.toolPrefix ?? CLAUDE_TOOL_PREFIX;
  const systemIdentity =
    input.metadata?.systemIdentity ?? CLAUDE_SYSTEM_IDENTITY;
  const mergedBetas = mergeBetaHeaders(
    input.headers,
    CLAUDE_REQUIRED_BETA_HEADERS
  );

  // OAuth sessions require Claude Code identity headers.
  // https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L525-L538
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("anthropic-beta", mergedBetas);
  input.headers.set(
    "user-agent",
    input.metadata?.userAgent ?? CLAUDE_CLI_USER_AGENT
  );
  input.headers.set("x-app", "cli");

  const transformedPayload = transformClaudeRequestPayload(
    input.bodyJson,
    toolPrefix,
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
      transformClaudeResponse(response, toolPrefix, input.onTokenUsage),
  };
};
