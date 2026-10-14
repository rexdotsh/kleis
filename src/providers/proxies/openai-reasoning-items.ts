import { isObjectRecord } from "../../utils/object";

export type ReasoningItemClosure = {
  closedOutputIndex: number | null;
  nextOutputIndex: number | null;
  nextSequenceNumber: number | null;
  eventsSinceClosedAdded: number;
  responseRestarted: boolean;
};

type OpenReasoningItem = {
  id: string;
  outputIndex: number | null;
  item: Record<string, unknown>;
  addedAt: number;
  responseRestarted: boolean;
};

const readIndex = (value: unknown): number | null =>
  Number.isInteger(value) ? (value as number) : null;

// OpenCode fails the whole turn when a reasoning item starts while another is
// still open. The Codex backend sometimes starts a response over mid-stream,
// numbering events and output items from 0 again, and never sends
// output_item.done for the reasoning item the abandoned attempt left open.
// This closes that item with an output_item.done built from its
// output_item.added, which carries the encrypted_content the client replays.
// https://github.com/anomalyco/opencode/blob/3a69bae8459b1aa9b122456a55d9535b23125f33/packages/ai/src/protocols/open-responses.ts#L1443-L1449
export const createReasoningItemCloser = (
  onClose: (closure: ReasoningItemClosure) => void
) => {
  let eventNumber = 0;
  let open: OpenReasoningItem | null = null;

  // Returns the events to send before `payload`.
  return (payload: Record<string, unknown>): Record<string, unknown>[] => {
    eventNumber++;
    switch (payload.type) {
      case "response.created":
        if (open) {
          open.responseRestarted = true;
        }
        return [];
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "error":
        open = null;
        return [];
      default:
        break;
    }

    const item = isObjectRecord(payload.item) ? payload.item : null;
    const outputIndex = readIndex(payload.output_index);
    if (payload.type === "response.output_item.done") {
      // Like OpenCode, an item without an id is the one open in its slot.
      const id =
        typeof item?.id === "string"
          ? item.id
          : outputIndex !== null && outputIndex === open?.outputIndex
            ? open.id
            : null;
      if (id === open?.id) {
        open = null;
      }
      return [];
    }
    if (
      payload.type !== "response.output_item.added" ||
      item?.type !== "reasoning" ||
      typeof item.id !== "string" ||
      item.id === open?.id
    ) {
      return [];
    }

    const closed = open;
    open = {
      id: item.id,
      outputIndex,
      item,
      addedAt: eventNumber,
      responseRestarted: false,
    };
    if (!closed) {
      return [];
    }
    onClose({
      closedOutputIndex: closed.outputIndex,
      nextOutputIndex: outputIndex,
      nextSequenceNumber: readIndex(payload.sequence_number),
      eventsSinceClosedAdded: eventNumber - closed.addedAt,
      responseRestarted: closed.responseRestarted,
    });
    return [
      {
        type: "response.output_item.done",
        ...(closed.outputIndex === null
          ? {}
          : { output_index: closed.outputIndex }),
        item: closed.item,
      },
    ];
  };
};
