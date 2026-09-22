import { isObjectRecord } from "../../utils/object";

export type OpenAiResponsesEventShapeIssue = {
  eventType: string;
  fields: string;
};

export const readOpenAiResponsesEventShapeIssue = (
  payload: Record<string, unknown>
): OpenAiResponsesEventShapeIssue | null => {
  const issues: string[] = [];
  const stringFields = ["id", "item_id", "response_id", "call_id", "delta"];
  const indexFields = ["output_index", "content_index", "summary_index"];
  for (const field of stringFields) {
    if (field in payload && typeof payload[field] !== "string") {
      issues.push(`${field}:non-string`);
    }
  }
  for (const field of indexFields) {
    if (field in payload && !Number.isInteger(payload[field])) {
      issues.push(`${field}:non-integer`);
    }
  }
  for (const field of ["response", "item"] as const) {
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

  const response = isObjectRecord(payload.response) ? payload.response : null;
  const type =
    response?.status === "failed"
      ? "response.failed"
      : response?.status === "incomplete"
        ? "response.incomplete"
        : "response.completed";
  return { ...payload, type };
};
