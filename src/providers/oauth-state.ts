import type { z } from "zod";

export const parseOAuthStateMetadata = <TSchema extends z.ZodType>(
  providerLabel: string,
  metadataJson: string | null,
  schema: TSchema
): z.infer<TSchema> => {
  let parsed: unknown = {};
  if (metadataJson) {
    try {
      parsed = JSON.parse(metadataJson);
    } catch {
      throw new Error(`${providerLabel} OAuth state metadata is malformed`);
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${providerLabel} OAuth state metadata is invalid`);
  }

  return result.data;
};
