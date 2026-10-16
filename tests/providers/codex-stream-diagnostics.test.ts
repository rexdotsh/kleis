import { expect, spyOn, test } from "bun:test";
import { createOpenAiSseUsagePassthrough } from "../../src/providers/proxies/openai-sse-passthrough";

test("unknown event and item metadata cannot leak through stream diagnostics", async () => {
  const events = [
    {
      type: "response.output_item.added",
      item: { id: "private-A", type: "reasoning" },
      output_index: 0,
    },
    {
      type: "PRIVATESECRETTOKEN",
      item: { id: "private-item", type: "PRIVATEITEMSECRET" },
      delta: "private content",
    },
    { type: "PRIVATESECRETTOKEN", output_index: "PRIVATEINDEXSECRET" },
    {
      type: "response.output_item.added",
      item: { id: "private-B", type: "reasoning" },
      output_index: 0,
    },
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
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(lines.join("\n")).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});
