import { CODEX_ACCOUNT_ID_HEADER } from "../providers/constants";

const PROXY_ONLY_HEADERS = new Set([
  "authorization",
  "x-api-key",
  CODEX_ACCOUNT_ID_HEADER.toLowerCase(),
  "host",
  "content-length",
  "cookie",
  "forwarded",
  "via",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const createUpstreamProxyHeaders = (incoming: Headers): Headers => {
  const headers = new Headers(incoming);
  for (const name of Array.from(headers.keys())) {
    if (
      PROXY_ONLY_HEADERS.has(name) ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("cf-")
    ) {
      headers.delete(name);
    }
  }
  return headers;
};
