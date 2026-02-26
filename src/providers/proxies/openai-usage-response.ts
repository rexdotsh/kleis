import type { TokenUsage } from "../../usage/token-usage";
import { maybeCreateOpenAiSseUsagePassthrough } from "./openai-sse-passthrough";

type UsageExtractor = (payload: unknown) => TokenUsage | null;

type TransformOpenAiUsageResponseInput = {
  response: Response;
  extractSseUsage: UsageExtractor;
  extractJsonUsage: UsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
};

const maybeTrackJsonUsage = async (
  response: Response,
  extractUsage: UsageExtractor,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
): Promise<Response> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response;
  }

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

  const maybeSseResponse = maybeCreateOpenAiSseUsagePassthrough({
    response: input.response,
    extractUsage: input.extractSseUsage,
    onTokenUsage: input.onTokenUsage,
  });
  if (maybeSseResponse !== input.response) {
    return Promise.resolve(maybeSseResponse);
  }

  return maybeTrackJsonUsage(
    input.response,
    input.extractJsonUsage,
    input.onTokenUsage
  );
};
