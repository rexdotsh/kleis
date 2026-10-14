import { describe, expect, test } from "bun:test";

import {
  createSseEventFramer,
  readSseData,
  replaceSseData,
} from "../../src/providers/proxies/sse-events";

const encoder = new TextEncoder();

const frame = (
  chunks: readonly Uint8Array[]
): { events: string[]; rest: string } => {
  const framer = createSseEventFramer();
  const events = chunks.flatMap((chunk) => framer.push(chunk));
  const end = framer.end();
  return { events: [...events, ...end.events], rest: end.rest };
};

// Deterministic so a failure reproduces from the printed seed.
const createRandom = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

describe("SSE event framer", () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: a\r\ndata: {"text":"🙂"}\r\n\r\n',
    "event: b\rdata: {}\r\r",
    "data\ndata: 1\n\r\n",
    "\n",
    ': comment\r\ndata: {"text":"é"}\r\n\n',
  ];
  const rest = "event: message_stop\r\ndata: {}\r\n";
  const bytes = encoder.encode(`${events.join("")}${rest}`);

  test("frames LF, CRLF, CR and mixed line endings", () => {
    expect(frame([bytes])).toEqual({ events, rest });
  });

  test("frames the same events however the bytes are split", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = createRandom(seed);
      const chunks: Uint8Array[] = [];
      let start = 0;
      while (start < bytes.length) {
        const end = Math.min(
          bytes.length,
          start + 1 + Math.floor(random() * 12)
        );
        chunks.push(bytes.slice(start, end));
        start = end;
      }
      expect({ seed, ...frame(chunks) }).toEqual({ seed, events, rest });
    }
  });

  test("waits for the next read before ending an event at a trailing CR", () => {
    const framer = createSseEventFramer();
    expect(framer.push(encoder.encode("data: 1\r"))).toEqual([]);
    expect(framer.push(encoder.encode("\ndata: 2\r\n\r"))).toEqual([]);
    expect(framer.push(encoder.encode("\n"))).toEqual([
      "data: 1\r\ndata: 2\r\n\r\n",
    ]);
  });

  test("ends an event at a trailing CR when the stream ends", () => {
    expect(frame([encoder.encode("data: 1\r\r")])).toEqual({
      events: ["data: 1\r\r"],
      rest: "",
    });
  });

  test("rejects an event larger than 4 MiB", () => {
    const framer = createSseEventFramer();
    const chunk = encoder.encode(`data: ${"x".repeat(1024 * 1024)}`);
    for (let read = 0; read < 3; read++) {
      framer.push(chunk);
    }
    expect(() => framer.push(chunk)).toThrow(
      "SSE event exceeds the proxy buffer limit"
    );
  });

  test("rejects an event larger than 4 MiB that completes in one read", () => {
    const framer = createSseEventFramer();
    expect(() =>
      framer.push(encoder.encode(`data: ${"x".repeat(4 * 1024 * 1024)}\n\n`))
    ).toThrow("SSE event exceeds the proxy buffer limit");
  });
});

describe("SSE event data", () => {
  test("joins data lines, including bare data lines", () => {
    expect(readSseData('event: x\r\ndata: {"a":\rdata\ndata: 1}\n\n')).toBe(
      '{"a":\n\n1}'
    );
  });

  test("replaces data lines, keeping other fields and line endings", () => {
    expect(
      replaceSseData(
        "event: x\r\ndata: a\ndata\r\nid: 7\rdata: b\r\n\r\n",
        '{"b":1}'
      )
    ).toBe('event: x\r\nid: 7\rdata: {"b":1}\r\n\r\n');
  });

  test("a rewritten event still frames as one event", () => {
    const output = replaceSseData("data: {\rdata: }\n\n", "{}", "done");
    const framer = createSseEventFramer();
    expect(framer.push(new TextEncoder().encode(output))).toEqual([output]);
    expect(framer.end()).toEqual({ events: [], rest: "" });
  });
});
