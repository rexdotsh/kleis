import {
  readOpenAiResponsesUsageFromSseEvent,
  type TokenUsage,
} from "../../usage/token-usage";
import { isObjectRecord } from "../../utils/object";
import { createCodexStreamDiagnostics } from "./codex-stream-diagnostics";
import {
  readStreamErrorStatus,
  readUpstreamErrorFields,
} from "./upstream-error";
import { readOpenAiResponseStatus } from "./openai-event-types";
import {
  normalizeOpenAiResponsesEvent,
  readOpenAiResponsesEventShapeIssue,
} from "./openai-responses-event";
import { readSseData, replaceSseData } from "./sse-events";
import { passthroughProxyResponse, tryParseJson } from "./response";
import { createSseRelay } from "./sse-relay";

type OpenAiSsePassthroughInput = {
  response: Response;
  providerAccountId?: string | undefined;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
  onStreamEnd?: ((statusCode: number) => void) | null | undefined;
  keepAliveIntervalMs?: number;
};

type SseTerminalAnomaly = Record<string, string | number | boolean | null>;

const readSseTerminalAnomaly = (
  payload: unknown
): SseTerminalAnomaly | null => {
  if (!isObjectRecord(payload)) {
    return null;
  }

  if (payload.type === "response.incomplete") {
    const response = isObjectRecord(payload.response) ? payload.response : null;
    const incompleteDetails = isObjectRecord(response?.incomplete_details)
      ? response.incomplete_details
      : null;
    if (incompleteDetails?.reason === "max_output_tokens") {
      return null;
    }
    return {
      terminalAnomaly: "response.incomplete",
      responseStatus: readOpenAiResponseStatus(response?.status),
      incompleteReason:
        incompleteDetails?.reason === "content_filter"
          ? "content_filter"
          : "unknown",
    };
  }
  if (payload.type === "response.failed" || payload.type === "error") {
    const response = isObjectRecord(payload.response) ? payload.response : null;
    return {
      terminalAnomaly: String(payload.type),
      responseStatus: readOpenAiResponseStatus(response?.status),
      ...readUpstreamErrorFields(payload),
    };
  }

  return null;
};

export const createOpenAiSseUsagePassthrough = (
  input: OpenAiSsePassthroughInput
): Response => {
  if (!input.response.body) {
    return input.response;
  }

  const contentType = (
    input.response.headers.get("content-type") ?? ""
  ).toLowerCase();
  // Codex omits content-type on successful SSE streams and some HTTP errors.
  const isSseBody =
    contentType.includes("text/event-stream") ||
    (input.response.ok && !contentType);
  if (!isSseBody) {
    return passthroughProxyResponse(input.response);
  }
  return createSseRelay({
    ...input,
    provider: "codex",
    transport: "sse",
    streamFailedEvent: "openai_sse_stream_failed",
    invalidFrameEvent: "openai_sse_invalid_frame",
    createProtocol: ({ log, startedAt, requestId }) => {
      const state = {
        latestUsage: null as TokenUsage | null,
        terminalAnomaly: null as SseTerminalAnomaly | null,
        endStatus: null as number | null,
      };
      const trackDiagnostics = createCodexStreamDiagnostics({
        providerAccountId: input.providerAccountId,
        requestId,
        transport: "sse",
        startedAt,
      });
      return {
        transformEvent(chunk): string {
          const payloadText = readSseData(chunk);
          if (!payloadText) return chunk;
          const payload = tryParseJson(payloadText);
          if (!isObjectRecord(payload)) {
            log("openai_sse_invalid_json", {
              eventDataBytes: Buffer.byteLength(payloadText),
              eventDataLines: payloadText.split("\n").length,
              parseCategory: "invalid_json_or_non_object",
            });
            return chunk;
          }
          const issue = readOpenAiResponsesEventShapeIssue(payload);
          if (issue) {
            log("openai_sse_invalid_shape", {
              parseCategory: "invalid_field_type",
              eventType: issue.eventType,
              fields: issue.fields,
            });
          }
          trackDiagnostics(payload);
          const normalized =
            state.endStatus !== null
              ? payload
              : normalizeOpenAiResponsesEvent(payload);
          const anomaly = readSseTerminalAnomaly(normalized);
          state.terminalAnomaly = anomaly ?? state.terminalAnomaly;
          if (
            normalized.type === "response.completed" ||
            normalized.type === "response.incomplete" ||
            normalized.type === "response.failed" ||
            normalized.type === "error"
          ) {
            state.endStatus ??= anomaly
              ? readStreamErrorStatus(normalized)
              : 200;
          }
          state.latestUsage =
            readOpenAiResponsesUsageFromSseEvent(normalized) ??
            state.latestUsage;
          return normalized === payload
            ? chunk
            : replaceSseData(
                chunk,
                JSON.stringify(normalized),
                String(normalized.type)
              );
        },
        getUsage: () => state.latestUsage,
        getEndStatus: () => state.endStatus,
        onEof(rest): void {
          if (rest.trim()) {
            log("openai_sse_truncated_event", {
              pendingBytes: Buffer.byteLength(rest),
              parseCategory: "truncated_event",
            });
          }
          if (!input.response.ok) return;
          if (state.terminalAnomaly) {
            log("openai_sse_terminal_anomaly", state.terminalAnomaly);
          } else if (state.endStatus === null) {
            log("openai_sse_missing_terminal", {
              truncatedEvent: rest.trim().length > 0,
            });
          }
        },
      };
    },
  });
};
