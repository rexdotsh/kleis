import { z } from "zod";

import {
  CLAUDE_TOOL_PREFIX,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_RESPONSE_ENDPOINT,
  CODEX_ORIGINATOR,
  COPILOT_INITIATOR_HEADER,
  COPILOT_OPENAI_INTENT,
  COPILOT_VISION_HEADER,
} from "./constants";

const codexMetadataSchema = z
  .object({
    provider: z.literal("codex"),
    tokenType: z.string().nullable(),
    scope: z.string().nullable(),
    idToken: z.string().nullable(),
    chatgptAccountId: z.string().nullable(),
    organizationIds: z.array(z.string()),
    email: z.string().nullable(),
    requestProfile: z.object({
      originator: z.literal(CODEX_ORIGINATOR),
      accountIdHeader: z.literal(CODEX_ACCOUNT_ID_HEADER),
      endpoint: z.literal(CODEX_RESPONSE_ENDPOINT),
    }),
  })
  .strict();

const copilotMetadataSchema = z
  .object({
    provider: z.literal("copilot"),
    tokenType: z.string().nullable(),
    scope: z.string().nullable(),
    enterpriseDomain: z.string().nullable(),
    copilotApiBaseUrl: z.string().nullable(),
    githubUserId: z.string().nullable(),
    githubLogin: z.string().nullable(),
    githubEmail: z.string().nullable(),
    requestProfile: z.object({
      openaiIntent: z.literal(COPILOT_OPENAI_INTENT),
      initiatorHeader: z.literal(COPILOT_INITIATOR_HEADER),
      visionHeader: z.literal(COPILOT_VISION_HEADER),
    }),
  })
  .strict();

const claudeMetadataSchema = z
  .object({
    provider: z.literal("claude"),
    tokenType: z.string().nullable(),
    scope: z.string().nullable(),
    oauthMode: z.enum(["max", "console"]),
    oauthHost: z.enum(["claude.ai", "console.anthropic.com"]),
    betaHeaders: z.array(z.string()),
    userAgent: z.string(),
    systemIdentity: z.string(),
    toolPrefix: z.literal(CLAUDE_TOOL_PREFIX),
  })
  .strict();

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
