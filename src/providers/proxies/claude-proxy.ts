import type { ClaudeAccountMetadata } from "../metadata";

import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
} from "../constants";
import { isObjectRecord, type JsonObject } from "../../utils/object";

const sanitizeClaudeSystemText = (text: string): string =>
  text
    .replace(/OpenCode/g, "Claude Code")
    .replace(/(?<!\/)opencode/gi, "Claude");

const prefixToolName = (name: string, prefix: string): string =>
  name.startsWith(prefix) ? name : `${prefix}${name}`;

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    transformed.system = [
      {
        type: "text",
        text: systemIdentity,
      },
      {
        type: "text",
        text: sanitizeClaudeSystemText(transformed.system),
      },
    ];
  }

  if (Array.isArray(transformed.system)) {
    const systemBlocks: unknown[] = [
      {
        type: "text",
        text: systemIdentity,
      },
    ];
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

const buildUpstreamUrl = (requestUrl: URL): string => {
  const pathWithQuery = `${requestUrl.pathname}${requestUrl.search}`;
  const upstream = new URL(pathWithQuery, ANTHROPIC_API_BASE_URL);
  if (!upstream.searchParams.has("beta")) {
    upstream.searchParams.set("beta", "true");
  }

  return upstream.toString();
};

const maybeTransformClaudeStreamResponse = (
  response: Response,
  toolPrefix: string
): Response => {
  if (!response.body) {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return response;
  }

  const escapedPrefix = escapeRegExp(toolPrefix);
  const stripToolPrefixRegex = new RegExp(
    `"name"\\s*:\\s*"${escapedPrefix}([^"]+)"`,
    "g"
  );
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      if (!value) {
        return;
      }

      const text = decoder
        .decode(value, { stream: true })
        .replace(stripToolPrefixRegex, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
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

const mergeBetaHeaders = (headers: Headers, required: readonly string[]) => {
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set([...required, ...incoming])].join(",");
};

export type ClaudeProxyPreparationInput = {
  requestUrl: URL;
  headers: Headers;
  bodyText: string;
  bodyJson: unknown;
  accessToken: string;
  metadata: ClaudeAccountMetadata | null;
};

export type ClaudeProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Response;
};

export const prepareClaudeProxyRequest = (
  input: ClaudeProxyPreparationInput
): ClaudeProxyPreparationResult => {
  const requiredBetaHeaders =
    input.metadata?.betaHeaders ?? CLAUDE_REQUIRED_BETA_HEADERS;
  const toolPrefix = input.metadata?.toolPrefix ?? CLAUDE_TOOL_PREFIX;
  const systemIdentity =
    input.metadata?.systemIdentity ?? CLAUDE_SYSTEM_IDENTITY;
  const mergedBetas = mergeBetaHeaders(input.headers, requiredBetaHeaders);

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
    upstreamUrl: buildUpstreamUrl(input.requestUrl),
    bodyText,
    transformResponse: (response: Response): Response =>
      maybeTransformClaudeStreamResponse(response, toolPrefix),
  };
};
