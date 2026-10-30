import type { Context } from "hono";

export const createEtag = (body: ArrayBuffer | string): string =>
  `"${Bun.hash(body).toString(36)}"`;

const opaqueTag = (etag: string): string =>
  etag.startsWith("W/") ? etag.slice(2) : etag;

// If-None-Match uses weak comparison: https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2
const matchesIfNoneMatch = (
  header: string | undefined,
  etag: string
): boolean => {
  if (!header) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }
  const tag = opaqueTag(etag);
  return header.split(",").some((value) => opaqueTag(value.trim()) === tag);
};

export const respondWithEtag = (
  context: Context,
  body: ArrayBuffer | string,
  etag: string,
  contentType: string,
  cacheControl: string,
  extraHeaders: Record<string, string> = {}
): Response => {
  const headers = {
    "Cache-Control": cacheControl,
    ETag: etag,
    ...extraHeaders,
  };
  if (matchesIfNoneMatch(context.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    headers: { "Content-Type": contentType, ...headers },
  });
};
