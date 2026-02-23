import { z } from "zod";

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
      originator: z.literal("opencode"),
      accountIdHeader: z.literal("ChatGPT-Account-Id"),
      endpoint: z.literal("https://chatgpt.com/backend-api/codex/responses"),
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
    requestProfile: z.object({
      openaiIntent: z.literal("conversation-edits"),
      initiatorHeader: z.literal("x-initiator"),
      visionHeader: z.literal("Copilot-Vision-Request"),
    }),
  })
  .strict();

const claudeMetadataSchema = z
  .object({
    provider: z.literal("claude"),
    tokenType: z.string().nullable(),
    scope: z.string().nullable(),
    betaHeaders: z.array(z.string()),
    userAgent: z.string(),
    systemIdentity: z.string(),
    toolPrefix: z.literal("mcp_"),
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
