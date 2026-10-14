import { beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";

// Run through proxy-usage.test.ts, which starts this file in its own process
// with an in-memory database.
if (process.env.TURSO_CONNECTION_URL !== ":memory:") {
  throw new Error("proxy usage scenarios need TURSO_CONNECTION_URL=:memory:");
}
const { db } = await import("../../src/db");
const { upsertProviderAccount, updateProviderAccountTokens } = await import(
  "../../src/db/repositories/provider-accounts"
);
const { requestUsageBuckets } = await import("../../src/db/schema");
const { proxyRoutes, flushProxyUsage } = await import(
  "../../src/http/routes/proxy"
);

const app = new Hono();
app.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", null);
  context.set("proxyRequestBody", {
    text: "{}",
    parsed: {},
    model: "claude-fake",
  });
  await next();
});
app.route("/", proxyRoutes);

let account: Awaited<ReturnType<typeof upsertProviderAccount>>;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  account = await upsertProviderAccount(db, {
    provider: "claude",
    accountId: "fake-account",
    accessToken: "fake-token-1",
    refreshToken: "fake-refresh-1",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
});

const event = (payload: { type: string; [field: string]: unknown }) =>
  `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
const usage = {
  input_tokens: 3,
  output_tokens: 2,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 7,
};
const complete =
  event({ type: "message_start", message: { usage } }) +
  event({ type: "message_delta", usage: { output_tokens: 11 } }) +
  event({ type: "message_stop" });
const request = () =>
  app.request("/anthropic/v1/messages", { method: "POST", body: "{}" });

test("route records one successful SSE request including latest tokens", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(complete, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        successCount: 1,
        inputTokens: 3,
        outputTokens: 11,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("route auth replay records only final stream with refreshed account", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  let calls = 0;
  let firstCancelled = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    expect(String(url).includes("api.anthropic.com/")).toBe(true);
    calls++;
    if (calls === 1) {
      await updateProviderAccountTokens(db, account.id, {
        accessToken: "fake-token-2",
        refreshToken: "fake-refresh-2",
        expiresAt: Date.now() + 3_600_000,
        now: Date.now(),
        accountId: account.accountId,
        metadata: null,
      });
      return new Response(
        new ReadableStream({
          cancel() {
            firstCancelled++;
          },
        }),
        { status: 401, headers: { "content-type": "text/event-stream" } }
      );
    }
    return new Response(complete, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const response = await request();
    await response.text();
    await flushProxyUsage();
    expect(calls).toBe(2);
    expect(firstCancelled).toBe(1);
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        successCount: 1,
        inputTokens: 3,
        outputTokens: 11,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("route preserves non-2xx SSE classification in the usage bucket", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}\n\n',
      { status: 403, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const response = await request();
    expect(response.status).toBe(403);
    await response.text();
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        authErrorCount: 1,
        serverErrorCount: 0,
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
