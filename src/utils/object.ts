export type JsonObject = Record<string, unknown>;

export const isObjectRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readBooleanField = (
  value: unknown,
  key: string
): boolean | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const field = value[key];
  return typeof field === "boolean" ? field : null;
};

export const getObjectProperty = (
  value: unknown,
  key: string
): JsonObject | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const nested = value[key];
  return isObjectRecord(nested) ? nested : null;
};
