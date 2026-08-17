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

const parseRetryAfterMs = (
  value: string | null,
  now: number
): number | null => {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
};

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

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`${input.errorPrefix} returned invalid JSON`);
  }
};
