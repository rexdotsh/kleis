import { expect, spyOn, test } from "bun:test";
import { createCodexStreamDiagnostics } from "../../src/providers/proxies/codex-stream-diagnostics";

const itemEvent = (type: "added" | "done", id: string) => ({
  type: `response.output_item.${type}`,
  item: { id, type: "reasoning" },
  output_index: 0,
});

test("overlap history is bounded, ordered, content-free and emitted only once", () => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  const track = createCodexStreamDiagnostics({
    providerAccountId: "fake-account",
    transport: "websocket",
    requestId: "fake-request",
    startedAt: Date.now(),
  });
  try {
    track(itemEvent("added", "private-item-1"));
    for (let sequence = 0; sequence < 100; sequence++) {
      track({
        type: "response.reasoning_summary_text.delta",
        sequence_number: sequence,
        item_id: "private-item-1",
        delta: "private content",
      });
    }
    track({
      type: "response.created",
      sequence_number: 0,
      response: { id: "private-response" },
    });
    track({ ...itemEvent("added", "private-item-2"), sequence_number: 2 });
    track({ type: "response.created" });
    track(itemEvent("added", "private-item-3"));
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    const payload = JSON.parse(line);
    expect(payload).toMatchObject({
      event: "codex_reasoning_overlap",
      transport: "websocket",
    });
    expect(payload.history).toHaveLength(64);
    expect(payload.history[0].sequenceNumber).toBe(38);
    expect(payload.history[61].sequenceNumber).toBe(99);
    expect(payload.history[63]).toMatchObject({
      type: "response.output_item.added",
      sequenceNumber: 2,
      outputIndex: 0,
      itemType: "reasoning",
    });
    expect(payload.history[0].itemIdHash).toMatch(/^[a-f0-9]{8}$/);
    expect(payload.history[0].itemIdHash).toBe(payload.history[61].itemIdHash);
    expect(payload.history[62].responseIdHash).toBe(
      payload.history[63].responseIdHash
    );
    expect(line).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});

test.each([
  "response.created",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.done",
])("%s does not close reasoning", (type) => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const track = createCodexStreamDiagnostics({
      transport: "sse",
      startedAt: Date.now(),
    });
    track(itemEvent("added", "item-1"));
    track({ type });
    track(itemEvent("done", "different-item"));
    track(itemEvent("added", "item-2"));
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("a matching item ID closes reasoning even if the output index differs", () => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const track = createCodexStreamDiagnostics({
      transport: "sse",
      startedAt: Date.now(),
    });
    track(itemEvent("added", "item-1"));
    track({ ...itemEvent("done", "item-1"), output_index: 9 });
    track(itemEvent("added", "item-2"));
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
