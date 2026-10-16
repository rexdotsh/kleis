import { z } from "zod";

import type { Provider } from "../db/schema";

const optionalText = z.string().nullable().optional();
const optionalTimestamp = z.number().nullable().optional();

const codexMetadataSchema = z.object({
  provider: z.literal("codex"),
  scope: z.string().nullable().default(null),
  chatgptAccountId: z.string().nullable(),
  email: z.string().nullable(),
  chatgptUserId: optionalText,
  planTypeClaim: optionalText,
  subscriptionActiveStart: optionalTimestamp,
  subscriptionActiveUntil: optionalTimestamp,
  subscriptionLastChecked: optionalTimestamp,
  isFedramp: z.boolean().nullable().optional(),
});

const claudeMetadataSchema = z.object({
  provider: z.literal("claude"),
  scope: z.string().nullable().default(null),
  oauthMode: z.enum(["max", "console"]),
  oauthHost: z.enum([
    "claude.ai",
    "console.anthropic.com",
    "platform.claude.com",
  ]),
  accountUuid: optionalText,
  email: optionalText,
  organizationUuid: optionalText,
  organizationName: optionalText,
  workspaceId: optionalText,
  workspaceName: optionalText,
  refreshTokenExpiresAt: optionalTimestamp,
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

export const parseImportedProviderAccountMetadata = (input: {
  provider: Provider;
  accountId: string | null;
  metadata: Record<string, unknown> | null | undefined;
}): ProviderAccountMetadata => {
  const defaults: ProviderAccountMetadata =
    input.provider === "codex"
      ? {
          provider: "codex",
          scope: null,
          chatgptAccountId: input.accountId,
          email: null,
        }
      : {
          provider: "claude",
          scope: null,
          oauthMode: "max",
          oauthHost: "claude.ai",
        };
  if (!input.metadata) {
    return defaults;
  }

  const parsed = providerAccountMetadataSchema.safeParse({
    ...defaults,
    ...input.metadata,
    provider: input.provider,
  });
  if (!parsed.success) {
    throw new Error("Invalid provider metadata payload");
  }

  return parsed.data;
};

export const resolveImportedProviderAccountId = (
  explicitAccountId: string | null,
  metadata: ProviderAccountMetadata
): string | null =>
  explicitAccountId ||
  (metadata.provider === "codex" ? metadata.chatgptAccountId : null);

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
  return result.success ? result.data : null;
};

export const serializeProviderAccountMetadata = (
  metadata: ProviderAccountMetadata | null
): string | null => {
  if (!metadata) {
    return null;
  }

  return JSON.stringify(providerAccountMetadataSchema.parse(metadata));
};
