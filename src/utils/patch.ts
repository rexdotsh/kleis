export const normalizeEditableText = (
  value: string | null | undefined
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return value.length > 0 ? value : null;
};

export const resolvePatchedValue = <T>(
  current: T,
  patched: T | undefined
): T => (patched === undefined ? current : patched);
