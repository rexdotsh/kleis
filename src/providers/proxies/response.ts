import type { TokenUsage } from "../../usage/token-usage";

export const isEventStreamResponse = (response: Response): boolean =>
  response.body !== null &&
  (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");

export const createProxyResponseHeaders = (source: HeadersInit): Headers => {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return headers;
};

export const passthroughProxyResponse = (response: Response): Response =>
  new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: createProxyResponseHeaders(response.headers),
  });

export const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const transformJsonResponse = async (input: {
  response: Response;
  readUsage(payload: unknown): TokenUsage | null;
  transformPayload?: (payload: unknown) => unknown;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
}): Promise<Response> => {
  const bytes = new Uint8Array(await input.response.arrayBuffer());
  const payload = tryParseJson(new TextDecoder().decode(bytes));
  const usage = input.readUsage(payload);
  if (usage) {
    input.onTokenUsage?.(usage);
  }
  const transformed = input.transformPayload
    ? input.transformPayload(payload)
    : payload;
  return new Response(
    transformed === payload ? bytes : JSON.stringify(transformed),
    {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: createProxyResponseHeaders(input.response.headers),
    }
  );
};
