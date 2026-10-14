import { hashLogId, logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";
import { readOpenAiEventType, readOpenAiItemType } from "./openai-event-types";

const HISTORY_SIZE = 64;
const TRANSITION_HISTORY_SIZE = 16;
const RESPONSE_TRANSITIONS = new Set([
  "response.created",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
]);

type EventSummary = {
  type: string;
  sequenceNumber: number | null;
  outputIndex: number | null;
  itemType: string | null;
  itemIdHash: string | null;
  responseIdHash: string | null;
  elapsedMs: number;
};

const readInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export const createCodexStreamDiagnostics = (input: {
  providerAccountId?: string | undefined;
  requestId?: string | null | undefined;
  transport: "sse" | "websocket";
  startedAt: number;
}): ((payload: Record<string, unknown>) => void) => {
  const history: EventSummary[] = [];
  const responseTransitions: EventSummary[] = [];
  let nextIndex = 0;
  let openItemId: string | null = null;
  let openItem: EventSummary | null = null;
  let firstResponseCreated: EventSummary | null = null;
  let responseTransitionCount = 0;
  let responseIdHash: string | null = null;
  let logged = false;

  return (payload): void => {
    if (logged) {
      return;
    }
    const item = isObjectRecord(payload.item) ? payload.item : null;
    const response = isObjectRecord(payload.response) ? payload.response : null;
    const itemId = item?.id ?? payload.item_id;
    const nextResponseIdHash = hashLogId(response?.id ?? payload.response_id);
    responseIdHash =
      payload.type === "response.created"
        ? nextResponseIdHash
        : (nextResponseIdHash ?? responseIdHash);
    const summary: EventSummary = {
      type: readOpenAiEventType(payload.type),
      sequenceNumber: readInteger(payload.sequence_number),
      outputIndex: readInteger(payload.output_index),
      itemType: item ? readOpenAiItemType(item.type) : null,
      itemIdHash: hashLogId(itemId),
      responseIdHash,
      elapsedMs: Date.now() - input.startedAt,
    };
    history[nextIndex] = summary;
    nextIndex = (nextIndex + 1) % HISTORY_SIZE;

    if (openItemId !== null && RESPONSE_TRANSITIONS.has(summary.type)) {
      responseTransitionCount++;
      responseTransitions.push(summary);
      if (responseTransitions.length > TRANSITION_HISTORY_SIZE) {
        responseTransitions.shift();
      }
      if (summary.type === "response.created") {
        firstResponseCreated ??= summary;
      }
    }

    // OpenCode closes reasoning only on output_item.done with the same ID;
    // response.created and a reused output index leave the item open.
    if (payload.type === "response.output_item.done" && itemId === openItemId) {
      openItemId = null;
      openItem = null;
    }
    if (
      payload.type !== "response.output_item.added" ||
      item?.type !== "reasoning" ||
      typeof itemId !== "string" ||
      itemId === openItemId
    ) {
      return;
    }
    if (openItemId !== null) {
      logged = true;
      logWarn("codex_reasoning_overlap", {
        provider: "codex",
        providerAccountId: input.providerAccountId,
        requestIdHash: hashLogId(input.requestId),
        transport: input.transport,
        elapsedMs: Date.now() - input.startedAt,
        openItem,
        firstResponseCreated,
        responseTransitions,
        responseTransitionCount,
        history: history.slice(nextIndex).concat(history.slice(0, nextIndex)),
      });
      return;
    }
    openItemId = itemId;
    // The open item and first restart stay pinned while deltas evict the ring.
    openItem = summary;
    firstResponseCreated = null;
    responseTransitionCount = 0;
    responseTransitions.length = 0;
  };
};
