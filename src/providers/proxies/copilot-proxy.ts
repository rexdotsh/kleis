import type { CopilotAccountMetadata } from "../metadata";

import {
  COPILOT_DEFAULT_API_BASE_URL,
  COPILOT_INITIATOR_HEADER,
  COPILOT_OPENAI_INTENT,
  COPILOT_VISION_HEADER,
} from "../constants";
import { isObjectRecord } from "../../utils/object";

type CopilotProxyEndpoint = "chat_completions" | "responses" | "messages";

type CopilotMessageProfile = {
  isVision: boolean;
  isAgent: boolean;
};

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

type CopilotProxyPreparationInput = {
  endpoint: CopilotProxyEndpoint;
  requestUrl: URL;
  headers: Headers;
  bodyJson: unknown;
  githubAccessToken: string;
  metadata: CopilotAccountMetadata | null;
};

type CopilotProxyPreparationResult = {
  upstreamUrl: string;
};

export const prepareCopilotProxyRequest = (
  input: CopilotProxyPreparationInput
): CopilotProxyPreparationResult => {
  const profile = deriveCopilotRequestProfile(input.endpoint, input.bodyJson);
  const baseUrl =
    input.metadata?.copilotApiBaseUrl ?? COPILOT_DEFAULT_API_BASE_URL;

  input.headers.set("authorization", `Bearer ${input.githubAccessToken}`);
  input.headers.set("Openai-Intent", COPILOT_OPENAI_INTENT);
  input.headers.set(
    COPILOT_INITIATOR_HEADER,
    profile.isAgent ? "agent" : "user"
  );
  if (profile.isVision) {
    input.headers.set(COPILOT_VISION_HEADER, "true");
  } else {
    input.headers.delete(COPILOT_VISION_HEADER);
  }

  return {
    upstreamUrl: buildUpstreamUrl(baseUrl, input.requestUrl),
  };
};
