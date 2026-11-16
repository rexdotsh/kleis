import { readResponseJson } from "../../utils/response-json";
import { parseRetryAfterMs } from "../http";

export class AccountTrackingHttpError extends Error {
  readonly retryAfterMs: number | null;
  readonly status: number;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "AccountTrackingHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const fetchTrackingJson = async (input: {
  url: string;
  headers: HeadersInit;
  method?: "GET" | "POST";
  body?: string;
  timeoutMs: number;
  errorPrefix: string;
}): Promise<unknown> => {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });

  if (!response.ok) {
    throw new AccountTrackingHttpError(
      `${input.errorPrefix} (${response.status})`,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after"), Date.now())
    );
  }

  return readResponseJson(response, input.errorPrefix);
};
