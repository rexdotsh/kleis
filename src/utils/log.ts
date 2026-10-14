type LogFields = Record<string, string | number | boolean | null | undefined>;

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
): { errorName: string; errorMessage: string } => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorName: typeof error,
    errorMessage: String(error),
  };
};
