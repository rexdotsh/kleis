import { expect, spyOn, test } from "bun:test";
import { createCodexStreamDiagnostics } from "../../src/providers/proxies/codex-stream-diagnostics";
import { createOpenAiSseUsagePassthrough } from "../../src/providers/proxies/openai-sse-passthrough";

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
    track({ type, sequence_number: 10, response: { id: "private-response" } });
    track(itemEvent("done", "different-item"));
    track(itemEvent("added", "item-2"));
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.responseTransitions[0]).toMatchObject({
      type,
      sequenceNumber: 10,
      responseIdHash: expect.stringMatching(/^[a-f0-9]{8}$/),
    });
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

test("duplicate additions preserve the original anchor and warn only on a different item", () => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const track = createCodexStreamDiagnostics({
      transport: "sse",
      startedAt: Date.now(),
    });
    track({ ...itemEvent("added", "private-A"), sequence_number: 2 });
    track({ ...itemEvent("added", "private-A"), sequence_number: 3 });
    expect(log).not.toHaveBeenCalled();
    track({ ...itemEvent("added", "private-B"), sequence_number: 4 });
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.openItem.sequenceNumber).toBe(2);
    expect(payload.history.at(-1).sequenceNumber).toBe(4);
    expect(payload.openItem.itemIdHash).not.toBe(
      payload.history.at(-1).itemIdHash
    );
  } finally {
    log.mockRestore();
  }
});

test("unknown event and item types are content-free in every diagnostic and forwarded unchanged", async () => {
  const events = [
    itemEvent("added", "private-A"),
    {
      type: "PRIVATESECRETTOKEN",
      item: { id: "private-item", type: "PRIVATEITEMSECRET" },
      delta: "private content",
    },
    { type: "PRIVATESECRETTOKEN", output_index: "PRIVATEINDEXSECRET" },
    itemEvent("added", "private-B"),
  ];
  const source = events
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const response = createOpenAiSseUsagePassthrough({
      response: new Response(source),
      extractUsage: () => null,
    });
    expect(await response.text()).toBe(source);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    const diagnostics = lines.map((line) => JSON.parse(line));
    expect(diagnostics[0]).toMatchObject({
      event: "openai_sse_invalid_shape",
      eventType: "other",
    });
    expect(diagnostics[1]).toMatchObject({ event: "codex_reasoning_overlap" });
    expect(diagnostics[1].history[1]).toMatchObject({
      type: "other",
      itemType: "other",
    });
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(lines.join("\n")).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});

test.each([
  false,
  true,
])("open-item and restart anchors survive ring eviction (restart=%s)", (restart) => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const track = createCodexStreamDiagnostics({
      transport: "sse",
      startedAt: Date.now(),
    });
    track({
      type: "response.created",
      response: { id: "private-response-A" },
      sequence_number: 0,
    });
    track({ ...itemEvent("added", "private-A"), sequence_number: 2 });
    if (restart) {
      track({
        type: "response.created",
        response: { id: "private-response-B" },
        sequence_number: 0,
      });
    }
    for (let sequence = 0; sequence < 100; sequence++) {
      track({
        type: "response.reasoning_summary_text.delta",
        sequence_number: sequence,
        delta: "private content",
      });
    }
    track({ ...itemEvent("added", "private-B"), sequence_number: 2 });
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.history).toHaveLength(64);
    expect(
      payload.history.some(
        (entry: { type: string }) => entry.type === "response.created"
      )
    ).toBe(false);
    expect(payload.openItem).toMatchObject({
      type: "response.output_item.added",
      sequenceNumber: 2,
      outputIndex: 0,
      elapsedMs: expect.any(Number),
    });
    expect(payload.responseTransitionCount).toBe(restart ? 1 : 0);
    expect(payload.responseTransitions).toHaveLength(restart ? 1 : 0);
    if (restart) {
      expect(payload.firstResponseCreated).toMatchObject({
        type: "response.created",
        sequenceNumber: 0,
      });
      expect(payload.firstResponseCreated.responseIdHash).not.toBe(
        payload.openItem.responseIdHash
      );
      expect(payload.firstResponseCreated.responseIdHash).toBe(
        payload.history.at(-1).responseIdHash
      );
      expect(payload.responseTransitions[0]).toMatchObject({
        type: "response.created",
        sequenceNumber: 0,
        responseIdHash: payload.firstResponseCreated.responseIdHash,
      });
    } else {
      expect(payload.firstResponseCreated).toBeNull();
      expect(payload.openItem.responseIdHash).toBe(
        payload.history.at(-1).responseIdHash
      );
    }
    expect(JSON.stringify(payload)).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});

test("transition history is bounded without evicting the first restart", () => {
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const track = createCodexStreamDiagnostics({
      transport: "sse",
      startedAt: Date.now(),
    });
    track(itemEvent("added", "private-A"));
    for (let sequence = 0; sequence < 100; sequence++) {
      track({
        type: "response.created",
        response: { id: `private-response-${sequence}` },
        sequence_number: sequence,
      });
    }
    track(itemEvent("added", "private-B"));
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.responseTransitions).toHaveLength(16);
    expect(payload.responseTransitionCount).toBe(100);
    expect(payload.firstResponseCreated.sequenceNumber).toBe(0);
    expect(payload.responseTransitions[0].sequenceNumber).toBe(84);
    expect(payload.responseTransitions.at(-1).sequenceNumber).toBe(99);
  } finally {
    log.mockRestore();
  }
});
