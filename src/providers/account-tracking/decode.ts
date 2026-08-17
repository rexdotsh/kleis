import { isObjectRecord } from "../../utils/object";

export const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

export const readObject = (value: unknown): Record<string, unknown> | null =>
  isObjectRecord(value) ? value : null;

export const requireObject = (
  value: unknown,
  errorMessage: string
): Record<string, unknown> => {
  const object = readObject(value);
  if (!object) {
    throw new Error(errorMessage);
  }
  return object;
};

export const decodeArray = <T>(
  value: unknown,
  decode: (entry: unknown) => T | null
): T[] =>
  Array.isArray(value)
    ? value.map(decode).filter((entry) => entry !== null)
    : [];

type Field = readonly [source: string, decode: (value: unknown) => unknown];
type Fields = Record<string, Field>;
type Decoded<T extends Fields> = {
  [K in keyof T]: ReturnType<T[K][1]>;
};

export const decodeFields = <T extends Fields>(
  value: unknown,
  fields: T
): Decoded<T> | null => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, [source, decode]]) => [
      key,
      decode(input[source]),
    ])
  ) as Decoded<T>;
};
