import { z } from "zod";

import type { Provider } from "../db/schema";

// Strip legacy, unused fields when reading/importing metadata. OAuth refresh
// will persist the normalized shape without requiring a database migration.
const codexMetadataSchema = z.object({
  provider: z.literal("codex"),
  chatgptAccountId: z.string().nullable(),
  email: z.string().nullable(),
});

const claudeMetadataSchema = z.object({
  provider: z.literal("claude"),
  oauthMode: z.enum(["max", "console"]),
  oauthHost: z.enum([
    "claude.ai",
    "console.anthropic.com",
    "platform.claude.com",
  ]),
});

export const providerAccountMetadataSchema = z.discriminatedUnion("provider", [
  codexMetadataSchema,
  claudeMetadataSchema,
]);

export type CodexAccountMetadata = z.infer<typeof codexMetadataSchema>;
export type ClaudeAccountMetadata = z.infer<typeof claudeMetadataSchema>;

export type ProviderAccountMetadata = z.infer<
  typeof providerAccountMetadataSchema
>;

const buildDefaultProviderAccountMetadata = (
  provider: Provider,
  accountId: string | null
): ProviderAccountMetadata => {
  if (provider === "codex") {
    return {
      provider,
      chatgptAccountId: accountId,
      email: null,
    };
  }

  return {
    provider,
    oauthMode: "max",
    oauthHost: "claude.ai",
  };
};

export const parseImportedProviderAccountMetadata = (input: {
  provider: Provider;
  accountId: string | null;
  metadata: Record<string, unknown> | null | undefined;
}): ProviderAccountMetadata => {
  const defaults = buildDefaultProviderAccountMetadata(
    input.provider,
    input.accountId
  );
  if (!input.metadata) {
    return defaults;
  }

  const mergedMetadata: Record<string, unknown> = {
    ...defaults,
    ...input.metadata,
    provider: input.provider,
  };

  const parsed = providerAccountMetadataSchema.safeParse(mergedMetadata);
  if (!parsed.success) {
    throw new Error("Invalid provider metadata payload");
  }

  return parsed.data;
};

export const resolveImportedProviderAccountId = (
  explicitAccountId: string | null,
  metadata: ProviderAccountMetadata
): string | null => {
  if (explicitAccountId) {
    return explicitAccountId;
  }

  if (metadata.provider === "codex") {
    return metadata.chatgptAccountId;
  }

  return null;
};

export const parseProviderAccountMetadata = (
  metadataJson: string | null
): ProviderAccountMetadata | null => {
  if (!metadataJson) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return null;
  }

  const result = providerAccountMetadataSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data;
};

export const serializeProviderAccountMetadata = (
  metadata: ProviderAccountMetadata | null
): string | null => {
  if (!metadata) {
    return null;
  }

  return JSON.stringify(providerAccountMetadataSchema.parse(metadata));
};
