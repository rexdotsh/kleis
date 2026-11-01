import { createClient } from "@libsql/client";
import { afterEach, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { fetchDatabase } from "../../src/db/fetch";
import { installErrorHandler } from "../../src/http/error-handler";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const reset = () =>
  Object.assign(
    new TypeError("The socket connection was closed unexpectedly"),
    {
      code: "ECONNRESET",
    }
  );

const createTransport = (reply: (attempt: number) => Response | undefined) => {
  const value = crypto.randomUUID();
  const bodies: string[] = [];
  globalThis.fetch = (async (input) => {
    const request = input as Request;
    if (request.method === "GET") return new Response(null, { status: 404 });
    bodies.push(await request.text());
    const response = reply(bodies.length);
    if (response) return response;
    return Response.json({
      baton: null,
      results: [
        {
          type: "ok",
          response: {
            type: "execute",
            result: {
              cols: [{ name: "value", decltype: "TEXT" }],
              rows: [[{ type: "text", value }]],
              affected_row_count: 0,
              last_insert_rowid: null,
            },
          },
        },
        { type: "ok", response: { type: "close" } },
      ],
    });
  }) as typeof fetch;
  const client = createClient({
    url: "http://database.invalid",
    fetch: fetchDatabase,
  });
  return {
    client,
    bodies,
    value,
    execute: () => client.execute({ sql: "select ? as value", args: [value] }),
  };
};

test.each([
  reset(),
  new TypeError("The socket connection was closed unexpectedly"),
  Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
  new TypeError("fetch failed", { cause: reset() }),
])(
  "a libSQL query survives one reset with its complete request body: %s",
  async (error: Error) => {
    const transport = createTransport((attempt) => {
      if (attempt === 1) throw error;
      return;
    });
    try {
      expect((await transport.execute()).rows[0]?.value).toBe(transport.value);
      expect(transport.bodies).toHaveLength(2);
      expect(transport.bodies[1]).toBe(transport.bodies[0]);
    } finally {
      transport.client.close();
    }
  }
);

test("a second libSQL reset is surfaced without a third attempt", async () => {
  const transport = createTransport(() => {
    throw reset();
  });
  try {
    await expect(transport.execute()).rejects.toMatchObject({
      dependency: "db",
      cause: { code: "ECONNRESET" },
    });
    expect(transport.bodies).toHaveLength(2);
  } finally {
    transport.client.close();
  }
});

test.each([401, 429, 500, 503])(
  "libSQL HTTP %i responses are not retried",
  async (status) => {
    const transport = createTransport(() => new Response(null, { status }));
    try {
      await expect(transport.execute()).rejects.toThrow();
      expect(transport.bodies).toHaveLength(1);
    } finally {
      transport.client.close();
    }
  }
);

test.each([
  Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }),
  Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  new DOMException("Timed out", "TimeoutError"),
  new DOMException("Aborted", "AbortError"),
])("unrelated libSQL failures are not retried: %s", async (error: Error) => {
  const transport = createTransport(() => {
    throw error;
  });
  try {
    await expect(transport.execute()).rejects.toMatchObject({ cause: error });
    expect(transport.bodies).toHaveLength(1);
  } finally {
    transport.client.close();
  }
});

test("a libSQL response body reset is not replayed", async () => {
  const transport = createTransport(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(reset());
          },
        })
      )
  );
  try {
    await expect(transport.execute()).rejects.toThrow();
    expect(transport.bodies).toHaveLength(1);
  } finally {
    transport.client.close();
  }
});

test.each([reset(), new TypeError("fetch failed", { cause: reset() })])(
  "exhausted DB resets log their dependency and cause without SQL or credentials: %s",
  async (error: Error) => {
    error.stack = undefined;
    const transport = createTransport(() => {
      throw error;
    });
    const database = drizzle(transport.client);
    const app = new Hono();
    installErrorHandler(app);
    app.get("/db", async () => {
      await database.get(sql`select ${"private-token"} as secret`);
      return new Response(null, { status: 204 });
    });
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await app.request("/db")).status).toBe(500);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "http_request_failed",
        dependency: "db",
        errorCode: "ECONNRESET",
        errorMessage: error.message,
        errorStack: expect.stringContaining("DependencyError"),
      });
      expect(line).not.toContain("private-token");
      expect(line).not.toContain("select");
    } finally {
      log.mockRestore();
      transport.client.close();
    }
  }
);
