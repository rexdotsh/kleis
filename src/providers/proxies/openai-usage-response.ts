import type { TokenUsage } from "../../usage/token-usage";
import { createOpenAiSseUsagePassthrough } from "./openai-sse-passthrough";

type UsageExtractor = (payload: unknown) => TokenUsage | null;

type TransformOpenAiUsageResponseInput = {
  response: Response;
  extractSseUsage: UsageExtractor;
  extractJsonUsage: UsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
  isStreamingRequest: boolean;
};

const hasContentType = (response: Response, expected: string): boolean => {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes(expected);
};

const trackJsonUsage = async (
  response: Response,
  extractUsage: UsageExtractor,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
): Promise<Response> => {
  const bodyText = await response.text();
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyText) as unknown;
  } catch {
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const usage = extractUsage(bodyJson);
  if (usage) {
    onTokenUsage?.(usage);
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(bodyJson, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const transformOpenAiUsageResponse = (
  input: TransformOpenAiUsageResponseInput
): Promise<Response> => {
  if (!input.response.body) {
    return Promise.resolve(input.response);
  }

  // Route based on request intent, not just response content-type.
  // Codex (chatgpt.com/backend-api) returns SSE streams with no Content-Type header,
  // so content-type alone is insufficient for routing.
  if (
    input.isStreamingRequest ||
    hasContentType(input.response, "text/event-stream")
  ) {
    return Promise.resolve(
      createOpenAiSseUsagePassthrough({
        response: input.response,
        extractUsage: input.extractSseUsage,
        onTokenUsage: input.onTokenUsage,
      })
    );
  }

  return trackJsonUsage(
    input.response,
    input.extractJsonUsage,
    input.onTokenUsage
  );
};
