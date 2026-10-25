import { isObjectRecord } from "../../utils/object";

// Claude Code 2.1.310 gzips api.anthropic.com bodies of 4096+ UTF-16 units
// with Bun's fetch `compress: "gzip"` (cjt, lKt and _Bo in its bundle).
const GZIP_HOST = "api.anthropic.com";
const GZIP_MIN_BODY_LENGTH = 4096;
const GZIP_REJECTION_STATUSES = new Set([400, 403, 415]);
const REJECTION_BODY_BYTES = 8192;
const JSON_PARSE_ERROR_PREFIXES = [
  "The request body is not valid JSON",
  "Failed to parse request: could not parse request body as JSON",
];
const BAD_JSON_PATTERN =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/;

// Claude Code stops gzipping for the rest of the process after one rejection.
let gzipRejected = false;

const shouldGzip = (url: string, bodyText: string): boolean => {
  if (gzipRejected || bodyText.length < GZIP_MIN_BODY_LENGTH) {
    return false;
  }
  try {
    return new URL(url).host === GZIP_HOST;
  } catch {
    return false;
  }
};

// Claude Code appends a newline and 0-256 random spaces or tabs to every
// gzipped body.
const padGzipBody = (bodyText: string): string => {
  let padding = "\n";
  const length = Math.floor(Math.random() * 257);
  for (let index = 0; index < length; index++) {
    padding += Math.random() < 0.5 ? " " : "\t";
  }
  return `${bodyText}${padding}`;
};

const readBodyPrefix = async (response: Response): Promise<string> => {
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  let remaining = REJECTION_BODY_BYTES;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value.subarray(0, remaining);
      remaining -= chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
  } catch {
    // Whatever was read before the failure is still checked.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text;
};

const isJsonParseError = (text: string): boolean => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return BAD_JSON_PATTERN.test(text.trimEnd());
  }
  if (!isObjectRecord(payload)) {
    return false;
  }
  const { error } = payload;
  if (payload.type === "error" && isObjectRecord(error)) {
    const { message } = error;
    return (
      typeof error.type === "string" &&
      typeof message === "string" &&
      JSON_PARSE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
    );
  }
  return (
    typeof error === "string" &&
    payload.reason === "bad_json" &&
    BAD_JSON_PATTERN.test(error)
  );
};

// A 400, 403 or 415 without Anthropic's request id or a Cloudflare ray came
// from something in between; one from Anthropic counts only as a JSON error.
const isGzipRejection = async (response: Response): Promise<boolean> => {
  if (!GZIP_REJECTION_STATUSES.has(response.status)) {
    return false;
  }
  const fromAnthropic =
    (response.headers.get("request-id")?.startsWith("req_") ?? false) ||
    response.headers.has("cf-ray");
  if (!fromAnthropic) {
    return true;
  }
  return (
    response.status === 400 && isJsonParseError(await readBodyPrefix(response))
  );
};

export const sendClaudeRequestBody = async (input: {
  url: string;
  bodyText: string;
  send(body: string, compress: "gzip" | undefined): Promise<Response>;
}): Promise<Response> => {
  if (!shouldGzip(input.url, input.bodyText)) {
    return input.send(input.bodyText, undefined);
  }

  const response = await input.send(padGzipBody(input.bodyText), "gzip");
  if (!(await isGzipRejection(response))) {
    return response;
  }

  gzipRejected = true;
  await response.body?.cancel().catch(() => undefined);
  return input.send(input.bodyText, undefined);
};
