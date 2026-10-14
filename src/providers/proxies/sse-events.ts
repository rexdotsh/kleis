const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

// A CRLF is one line ending; a lone CR or LF is one too.
const LINE_ENDING = /\r\n?|\n/gu;
const LINE_SPLIT = /(\r\n|\r|\n)/u;

const isDataLine = (line: string): boolean =>
  line === "data" || line.startsWith("data:");

const isEventLine = (line: string): boolean =>
  line === "event" || line.startsWith("event:");

// Splits a byte stream into SSE events, each ending with the blank line that
// terminates it. Each read is scanned once and only joined with earlier reads
// when an event completes, so large events stay linear.
export const createSseEventFramer = () => {
  const decoder = new TextDecoder();
  let parts: string[] = [];
  let pendingBytes = 0;
  let atLineStart = true;
  // A read ended with a CR, so an LF starting the next read completes it.
  let endedWithCr = false;
  // That CR ended a blank line: the event ends after the possible LF.
  let eventEndsAfterCr = false;

  const scan = (text: string, endOfStream: boolean): string[] => {
    const events: string[] = [];
    if (!(text || endOfStream)) {
      return events;
    }

    let eventStart = 0;
    const append = (part: string): void => {
      pendingBytes += Buffer.byteLength(part);
      if (pendingBytes > MAX_SSE_EVENT_BYTES) {
        throw new Error("SSE event exceeds the proxy buffer limit");
      }
      parts.push(part);
    };
    const emit = (end: number): void => {
      append(text.slice(eventStart, end));
      events.push(parts.join(""));
      parts = [];
      pendingBytes = 0;
      eventStart = end;
    };

    let lineStart = endedWithCr && text.startsWith("\n") ? 1 : 0;
    endedWithCr = false;
    if (eventEndsAfterCr) {
      eventEndsAfterCr = false;
      emit(lineStart);
    }

    LINE_ENDING.lastIndex = lineStart;
    for (
      let match = LINE_ENDING.exec(text);
      match;
      match = LINE_ENDING.exec(text)
    ) {
      const lineEnd = match.index + match[0].length;
      endedWithCr = match[0] === "\r" && lineEnd === text.length;
      if (match.index === lineStart && atLineStart) {
        if (endedWithCr && !endOfStream) {
          eventEndsAfterCr = true;
        } else {
          emit(lineEnd);
        }
      }
      lineStart = lineEnd;
      atLineStart = true;
    }

    if (lineStart < text.length) {
      atLineStart = false;
    }
    if (eventStart < text.length) {
      append(text.slice(eventStart));
    }
    return events;
  };

  return {
    push(chunk: Uint8Array): string[] {
      return scan(decoder.decode(chunk, { stream: true }), false);
    },
    // `rest` is a final event without its terminating blank line.
    end(): { events: string[]; rest: string } {
      const events = scan(decoder.decode(), true);
      return { events, rest: parts.join("") };
    },
  };
};

export const readSseData = (event: string): string | null => {
  const dataLines: string[] = [];
  for (const line of event.split(LINE_SPLIT)) {
    if (isDataLine(line)) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  return data;
};

// Replaces an event's data lines with one line carrying `data`, and its event
// name when one is given, keeping other fields and line endings as they are.
// The new line takes the last data line's place, so the line endings around
// the blank line that ends the event are left untouched.
export const replaceSseData = (
  event: string,
  data: string,
  eventName?: string
): string => {
  const parts = event.split(LINE_SPLIT);
  let lastData = -1;
  for (let index = 0; index < parts.length; index += 2) {
    if (isDataLine(parts[index] ?? "")) {
      lastData = index;
    }
  }
  let output = "";
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const ending = parts[index + 1] ?? "";
    if (index === lastData) {
      output += `data: ${data}${ending}`;
    } else if (eventName !== undefined && isEventLine(line)) {
      output += `event: ${eventName}${ending}`;
    } else if (!isDataLine(line)) {
      output += `${line}${ending}`;
    }
  }
  return output;
};
