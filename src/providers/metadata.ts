import { z } from "zod";

import type { Provider } from "../db/schema";
import { isObjectRecord } from "../utils/object";

import {
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_REQUEST_PROFILE,
  CODEX_RESPONSE_ENDPOINT,
  CODEX_ORIGINATOR,
  COPILOT_INITIATOR_HEADER,
  COPILOT_OPENAI_INTENT,
  COPILOT_REQUEST_PROFILE,
  COPILOT_VISION_HEADER,
} from "./constants";

const codexMetadataSchema = z.strictObject({
  provider: z.literal("codex"),
  tokenType: z.string().nullable(),
  scope: z.string().nullable(),
  idToken: z.string().nullable(),
  chatgptAccountId: z.string().nullable(),
  organizationIds: z.array(z.string()),
  email: z.string().nullable(),
  requestProfile: z.strictObject({
    originator: z.literal(CODEX_ORIGINATOR),
    accountIdHeader: z.literal(CODEX_ACCOUNT_ID_HEADER),
    endpoint: z.literal(CODEX_RESPONSE_ENDPOINT),
  }),
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
  requestProfile: z.strictObject({
    openaiIntent: z.literal(COPILOT_OPENAI_INTENT),
    initiatorHeader: z.literal(COPILOT_INITIATOR_HEADER),
    visionHeader: z.literal(COPILOT_VISION_HEADER),
  }),
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
      requestProfile: CODEX_REQUEST_PROFILE,
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
      requestProfile: COPILOT_REQUEST_PROFILE,
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
  const defaultRequestProfile = isObjectRecord(
    (defaults as Record<string, unknown>).requestProfile
  )
    ? (defaults as Record<string, unknown>).requestProfile
    : null;
  if (defaultRequestProfile && isObjectRecord(input.metadata.requestProfile)) {
    mergedMetadata.requestProfile = {
      ...defaultRequestProfile,
      ...input.metadata.requestProfile,
    };
  }

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
