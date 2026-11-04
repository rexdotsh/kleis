import { DrizzleQueryError } from "drizzle-orm/errors";

type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };
export type LogFields = Record<string, LogValue>;

export const hashLogId = (value: unknown): string | null =>
  typeof value === "string"
    ? Bun.CryptoHasher.hash("sha256", value, "hex").slice(0, 8)
    : null;

const writeLog = (
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields
) => {
  const payload = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...Object.fromEntries(
      Object.entries(fields).filter((entry) => entry[1] !== undefined)
    ),
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "info") {
    console.info(line);
    return;
  }

  console.warn(line);
};

export const logInfo = (event: string, fields: LogFields = {}): void => {
  writeLog("info", event, fields);
};

export const logWarn = (event: string, fields: LogFields = {}): void => {
  writeLog("warn", event, fields);
};

export const logError = (event: string, fields: LogFields = {}): void => {
  writeLog("error", event, fields);
};

export const errorLogFields = (
  error: unknown
): { errorName: string; errorMessage: string; errorStack?: string } => {
  // Drizzle's query errors list their SQL parameters, which can hold
  // credentials, so only the database error beneath them is ever reported.
  if (error instanceof DrizzleQueryError) {
    const seen = new Set<unknown>();
    let cause: unknown = error;
    while (cause instanceof DrizzleQueryError && !seen.has(cause)) {
      seen.add(cause);
      cause = cause.cause;
    }
    return cause instanceof Error && !(cause instanceof DrizzleQueryError)
      ? errorLogFields(cause)
      : {
          errorName: "DrizzleQueryError",
          errorMessage: "Database query failed",
        };
  }
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }

  return {
    errorName: typeof error,
    errorMessage: String(error),
  };
};
