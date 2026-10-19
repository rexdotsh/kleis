import { DrizzleQueryError } from "drizzle-orm/errors";
import { DependencyError } from "./dependency-error";

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
): {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  errorCode?: string;
  dependency?: DependencyError["dependency"];
} => {
  // Drizzle's wrapper includes SQL parameters; the cause retains the DB error.
  if (error instanceof DrizzleQueryError && error.cause) {
    return { ...errorLogFields(error.cause), dependency: "db" };
  }
  if (error instanceof DependencyError) {
    const fields = errorLogFields(error.cause);
    const stack = fields.errorStack ?? error.stack;
    return {
      ...fields,
      ...(stack ? { errorStack: stack } : {}),
      dependency: error.dependency,
    };
  }
  if (error instanceof Error) {
    const codeSource = "code" in error ? error : error.cause;
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
      ...(codeSource instanceof Error &&
      "code" in codeSource &&
      typeof codeSource.code === "string"
        ? { errorCode: codeSource.code }
        : {}),
    };
  }

  return {
    errorName: typeof error,
    errorMessage: String(error),
  };
};
