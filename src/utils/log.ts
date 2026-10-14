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
  // Drizzle's wrapper includes SQL parameters; the cause retains the DB error.
  if (error instanceof DrizzleQueryError && error.cause) {
    return errorLogFields(error.cause);
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
