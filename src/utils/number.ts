const toInteger = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
};

export const toNonNegativeInteger = (value: unknown): number =>
  Math.max(0, toInteger(value));
