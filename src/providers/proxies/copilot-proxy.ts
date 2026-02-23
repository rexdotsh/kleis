import type { CopilotAccountMetadata } from "../metadata";

import {
  COPILOT_DEFAULT_API_BASE_URL,
  COPILOT_INITIATOR_HEADER,
  COPILOT_OPENAI_INTENT,
  COPILOT_VISION_HEADER,
} from "../constants";

export type CopilotProxyEndpoint =
  | "chat_completions"
  | "responses"
  | "messages";

type JsonObject = Record<string, unknown>;

type CopilotMessageProfile = {
  isVision: boolean;
  isAgent: boolean;
};

const isObjectRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getArrayField = (value: unknown, key: string): unknown[] | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const field = value[key];
  return Array.isArray(field) ? field : null;
};

const arrayHasPartType = (value: unknown, type: string): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const part of value) {
    if (isObjectRecord(part) && part.type === type) {
      return true;
    }
  }

  return false;
};

const hasNestedImageInToolResult = (value: unknown): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const part of value) {
    if (
      !isObjectRecord(part) ||
      part.type !== "tool_result" ||
      !Array.isArray(part.content)
    ) {
      continue;
    }

    if (arrayHasPartType(part.content, "image")) {
      return true;
    }
  }

  return false;
};

const deriveCompletionsProfile = (jsonBody: unknown): CopilotMessageProfile => {
  const messages = getArrayField(jsonBody, "messages");
  if (!messages || messages.length === 0) {
    return { isVision: false, isAgent: false };
  }

  const last = messages.at(-1);
  const lastRole = isObjectRecord(last) ? last.role : null;
  let isVision = false;
  for (const message of messages) {
    if (!isObjectRecord(message)) {
      continue;
    }

    if (arrayHasPartType(message.content, "image_url")) {
      isVision = true;
      break;
    }
  }

  return {
    isVision,
    isAgent: lastRole !== "user",
  };
};

const deriveResponsesProfile = (jsonBody: unknown): CopilotMessageProfile => {
  const input = getArrayField(jsonBody, "input");
  if (!input || input.length === 0) {
    return { isVision: false, isAgent: false };
  }

  const last = input.at(-1);
  const lastRole = isObjectRecord(last) ? last.role : null;
  let isVision = false;
  for (const item of input) {
    if (!isObjectRecord(item)) {
      continue;
    }

    if (arrayHasPartType(item.content, "input_image")) {
      isVision = true;
      break;
    }
  }

  return {
    isVision,
    isAgent: lastRole !== "user",
  };
};

const deriveMessagesProfile = (jsonBody: unknown): CopilotMessageProfile => {
  const messages = getArrayField(jsonBody, "messages");
  if (!messages || messages.length === 0) {
    return { isVision: false, isAgent: false };
  }

  const last = messages.at(-1);
  const lastRole = isObjectRecord(last) ? last.role : null;
  const lastContent = isObjectRecord(last) ? last.content : null;
  const hasNonToolCalls =
    Array.isArray(lastContent) &&
    lastContent.some(
      (part) => !isObjectRecord(part) || part.type !== "tool_result"
    );

  let isVision = false;
  for (const message of messages) {
    if (!isObjectRecord(message)) {
      continue;
    }

    if (
      arrayHasPartType(message.content, "image") ||
      hasNestedImageInToolResult(message.content)
    ) {
      isVision = true;
      break;
    }
  }

  return {
    isVision,
    isAgent: !(lastRole === "user" && hasNonToolCalls),
  };
};

const deriveCopilotRequestProfile = (
  endpoint: CopilotProxyEndpoint,
  jsonBody: unknown
): CopilotMessageProfile => {
  if (endpoint === "chat_completions") {
    return deriveCompletionsProfile(jsonBody);
  }

  if (endpoint === "responses") {
    return deriveResponsesProfile(jsonBody);
  }

  return deriveMessagesProfile(jsonBody);
};

const buildUpstreamUrl = (baseUrl: string, requestUrl: URL): string => {
  const pathWithQuery = `${requestUrl.pathname}${requestUrl.search}`;
  const upstream = new URL(pathWithQuery, baseUrl);
  return upstream.toString();
};

export type CopilotProxyPreparationInput = {
  endpoint: CopilotProxyEndpoint;
  requestUrl: URL;
  headers: Headers;
  bodyJson: unknown;
  githubAccessToken: string;
  metadata: CopilotAccountMetadata | null;
};

export type CopilotProxyPreparationResult = {
  upstreamUrl: string;
};

export const prepareCopilotProxyRequest = (
  input: CopilotProxyPreparationInput
): CopilotProxyPreparationResult => {
  const requestProfile = input.metadata?.requestProfile;
  const profile = deriveCopilotRequestProfile(input.endpoint, input.bodyJson);
  const baseUrl =
    input.metadata?.copilotApiBaseUrl ?? COPILOT_DEFAULT_API_BASE_URL;
  const initiatorHeader =
    requestProfile?.initiatorHeader ?? COPILOT_INITIATOR_HEADER;
  const visionHeader = requestProfile?.visionHeader ?? COPILOT_VISION_HEADER;

  input.headers.set("authorization", `Bearer ${input.githubAccessToken}`);
  input.headers.set(
    "Openai-Intent",
    requestProfile?.openaiIntent ?? COPILOT_OPENAI_INTENT
  );
  input.headers.set(initiatorHeader, profile.isAgent ? "agent" : "user");
  if (profile.isVision) {
    input.headers.set(visionHeader, "true");
  } else {
    input.headers.delete(visionHeader);
  }

  return {
    upstreamUrl: buildUpstreamUrl(baseUrl, input.requestUrl),
  };
};
