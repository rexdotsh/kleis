import { isObjectRecord } from "../../utils/object";

export type OpenAiResponsesEventShapeIssue = {
  eventType: string;
  fields: string;
};

const STRING_FIELDS = ["id", "item_id", "response_id", "call_id", "delta"];
const INDEX_FIELDS = ["output_index", "content_index", "summary_index"];
const OBJECT_FIELDS = ["response", "item"] as const;

export const readOpenAiResponsesEventShapeIssue = (
  payload: Record<string, unknown>
): OpenAiResponsesEventShapeIssue | null => {
  const issues: string[] = [];
  for (const field of STRING_FIELDS) {
    if (field in payload && typeof payload[field] !== "string") {
      issues.push(`${field}:non-string`);
    }
  }
  for (const field of INDEX_FIELDS) {
    if (field in payload && !Number.isInteger(payload[field])) {
      issues.push(`${field}:non-integer`);
    }
  }
  for (const field of OBJECT_FIELDS) {
    if (field in payload && !isObjectRecord(payload[field])) {
      issues.push(`${field}:non-object`);
    }
  }
  if (!issues.length) {
    return null;
  }
  return {
    eventType:
      typeof payload.type === "string" ? payload.type.slice(0, 100) : "unknown",
    fields: issues.join(","),
  };
};

export const normalizeOpenAiResponsesEvent = (
  payload: Record<string, unknown>
): Record<string, unknown> => {
  if (payload.type !== "response.done") {
    return payload;
  }

  if (!isObjectRecord(payload.response)) {
    return payload;
  }
  const response = payload.response;
  if (
    response.status !== undefined &&
    response.status !== "completed" &&
    response.status !== "failed" &&
    response.status !== "incomplete"
  ) {
    return payload;
  }
  const type =
    response.status === "failed"
      ? "response.failed"
      : response.status === "incomplete"
        ? "response.incomplete"
        : "response.completed";
  return { ...payload, type };
};
