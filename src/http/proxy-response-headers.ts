const SENSITIVE_UPSTREAM_RESPONSE_HEADERS = [
  "anthropic-organization-id",
  "openai-organization",
  "openai-project",
  "x-openai-organization",
  "x-openai-project",
  "set-cookie",
  "set-cookie2",
  "proxy-authenticate",
  "authorization",
  "x-api-key",
] as const;

export const stripSensitiveProxyResponseHeaders = (
  response: Response
): Response => {
  const headers = new Headers(response.headers);
  for (const name of SENSITIVE_UPSTREAM_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
