import { z } from "zod";

import type { Provider } from "../db/schema";

import {
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
} from "./constants";

const codexMetadataSchema = z.strictObject({
  provider: z.literal("codex"),
  tokenType: z.string().nullable(),
  scope: z.string().nullable(),
  idToken: z.string().nullable(),
  chatgptAccountId: z.string().nullable(),
  organizationIds: z.array(z.string()),
  email: z.string().nullable(),
  requestProfile: z
    .strictObject({
      originator: z.string().optional(),
      accountIdHeader: z.string().optional(),
      endpoint: z.string().optional(),
    })
    .optional(),
});

const copilotMetadataSchema = z.strictObject({
  provider: z.literal("copilot"),
  tokenType: z.string().nullable(),
  scope: z.string().nullable(),
  enterpriseDomain: z.string().nullable(),
  copilotApiBaseUrl: z.string().nullable(),
  githubUserId: z.string().nullable(),
  githubLogin: z.string().nullable(),
  githubEmail: z.string().nullable(),
  requestProfile: z
    .strictObject({
      openaiIntent: z.string().optional(),
      initiatorHeader: z.string().optional(),
      visionHeader: z.string().optional(),
    })
    .optional(),
});

const claudeMetadataSchema = z.strictObject({
  provider: z.literal("claude"),
  tokenType: z.string().nullable(),
  scope: z.string().nullable(),
  oauthMode: z.enum(["max", "console"]),
  oauthHost: z.enum(["claude.ai", "console.anthropic.com"]),
  betaHeaders: z.array(z.string()),
  userAgent: z.string(),
  systemIdentity: z.string(),
  toolPrefix: z.literal(CLAUDE_TOOL_PREFIX),
});

export const providerAccountMetadataSchema = z.discriminatedUnion("provider", [
  codexMetadataSchema,
  copilotMetadataSchema,
  claudeMetadataSchema,
]);

export type CodexAccountMetadata = z.infer<typeof codexMetadataSchema>;
export type CopilotAccountMetadata = z.infer<typeof copilotMetadataSchema>;
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
      tokenType: null,
      scope: null,
      idToken: null,
      chatgptAccountId: accountId,
      organizationIds: [],
      email: null,
    };
  }

  if (provider === "copilot") {
    return {
      provider,
      tokenType: null,
      scope: null,
      enterpriseDomain: null,
      copilotApiBaseUrl: null,
      githubUserId: accountId,
      githubLogin: null,
      githubEmail: null,
    };
  }

  return {
    provider,
    tokenType: null,
    scope: null,
    oauthMode: "max",
    oauthHost: "claude.ai",
    betaHeaders: [...CLAUDE_REQUIRED_BETA_HEADERS],
    userAgent: CLAUDE_CLI_USER_AGENT,
    systemIdentity: CLAUDE_SYSTEM_IDENTITY,
    toolPrefix: CLAUDE_TOOL_PREFIX,
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

  if (metadata.provider === "copilot") {
    return metadata.githubUserId;
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

  return JSON.stringify(metadata);
};
