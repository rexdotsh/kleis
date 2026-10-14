import { logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";

const HISTORY_SIZE = 64;

type EventSummary = {
  type: string | null;
  sequenceNumber: number | null;
  outputIndex: number | null;
  itemType: string | null;
  itemIdHash: string | null;
  responseIdHash: string | null;
  elapsedMs: number;
};

const hashId = (value: unknown): string | null =>
  typeof value === "string"
    ? Bun.CryptoHasher.hash("sha256", value, "hex").slice(0, 8)
    : null;

const readInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const readType = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 128 ? value : null;

export const createCodexStreamDiagnostics = (input: {
  providerAccountId?: string | undefined;
  requestId?: string | null | undefined;
  transport: "sse" | "websocket";
  startedAt: number;
}): ((payload: Record<string, unknown>) => void) => {
  const history: EventSummary[] = [];
  let nextIndex = 0;
  let openItemId: string | null = null;
  let responseIdHash: string | null = null;
  let logged = false;

  return (payload): void => {
    if (logged) {
      return;
    }
    const item = isObjectRecord(payload.item) ? payload.item : null;
    const response = isObjectRecord(payload.response) ? payload.response : null;
    const itemId = item?.id ?? payload.item_id;
    responseIdHash =
      hashId(response?.id ?? payload.response_id) ?? responseIdHash;
    history[nextIndex] = {
      type: readType(payload.type),
      sequenceNumber: readInteger(payload.sequence_number),
      outputIndex: readInteger(payload.output_index),
      itemType: readType(item?.type),
      itemIdHash: hashId(itemId),
      responseIdHash,
      elapsedMs: Date.now() - input.startedAt,
    };
    nextIndex = (nextIndex + 1) % HISTORY_SIZE;

    // OpenCode closes reasoning only on output_item.done with the same ID;
    // response.created and a reused output index leave the item open.
    if (payload.type === "response.output_item.done" && itemId === openItemId) {
      openItemId = null;
    }
    if (
      payload.type !== "response.output_item.added" ||
      item?.type !== "reasoning" ||
      typeof itemId !== "string"
    ) {
      return;
    }
    if (openItemId !== null) {
      logged = true;
      logWarn("codex_reasoning_overlap", {
        provider: "codex",
        providerAccountId: input.providerAccountId,
        requestId: input.requestId,
        transport: input.transport,
        elapsedMs: Date.now() - input.startedAt,
        history: history.slice(nextIndex).concat(history.slice(0, nextIndex)),
      });
      return;
    }
    openItemId = itemId;
  };
};
