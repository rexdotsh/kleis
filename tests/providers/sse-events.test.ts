import { expect, test } from "bun:test";
import { createSseEventFramer } from "../../src/providers/proxies/sse-events";

test("SSE framing preserves mixed newlines and UTF-8 at every byte boundary, including EOF", () => {
  const events = [
    'event: a\ndata: {"text":"🙂"}\n\n',
    'data: {"text":"é"}\r\n\r\n',
    "data: 1\r\r",
    "data\ndata: 1\n\r\n",
  ];
  const rest = "data: unfinished";
  const bytes = new TextEncoder().encode(`${events.join("")}${rest}`);
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    const framer = createSseEventFramer();
    const framed = [
      ...framer.push(bytes.slice(0, boundary)),
      ...framer.push(bytes.slice(boundary)),
    ];
    const end = framer.end();
    expect({
      boundary,
      events: [...framed, ...end.events],
      rest: end.rest,
    }).toEqual({ boundary, events, rest });
  }
  const framer = createSseEventFramer();
  expect(framer.push(new TextEncoder().encode("data: 1\r\r"))).toEqual([]);
  expect(framer.end()).toEqual({ events: ["data: 1\r\r"], rest: "" });
});

test.each([false, true])(
  "rejects oversized events before unbounded buffering (complete=%s)",
  (complete) => {
    const framer = createSseEventFramer();
    const encoder = new TextEncoder();
    if (complete) {
      expect(() =>
        framer.push(encoder.encode(`data: ${"x".repeat(4 * 1024 * 1024)}\n\n`))
      ).toThrow("buffer limit");
    } else {
      const chunk = encoder.encode(`data: ${"x".repeat(1024 * 1024)}`);
      for (let read = 0; read < 3; read++) framer.push(chunk);
      expect(() => framer.push(chunk)).toThrow("buffer limit");
    }
  }
);
