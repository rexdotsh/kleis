export const normalizeStringList = (
  values: readonly string[] | null | undefined
): string[] | null => {
  const normalized = [
    ...new Set(values?.map((value) => value.trim()).filter(Boolean)),
  ];
  return normalized.length ? normalized : null;
};
