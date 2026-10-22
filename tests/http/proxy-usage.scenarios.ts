import {
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";
import { installErrorHandler } from "../../src/http/error-handler";
import { CODEX_USER_AGENT } from "../../src/providers/constants";

// Run through proxy-usage.test.ts, which starts this file in its own process
// with an in-memory database.
if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN
) {
  throw new Error(
    "proxy usage scenarios need an unauthenticated in-memory database"
  );
}
const { db } = await import("../../src/db");
const { upsertProviderAccount, updateProviderAccountTokens } =
  await import("../../src/db/repositories/provider-accounts");
const { requestUsageBuckets } = await import("../../src/db/schema");
const { createApiKey } = await import("../../src/db/repositories/api-keys");
const { requireProxyApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { proxyRoutes, flushProxyUsage, flushProxyFailureLogs } =
  await import("../../src/http/routes/proxy");
const { adminUsageRoutes } = await import("../../src/http/routes/admin-usage");
const { namespaceCodexKey } =
  await import("../../src/providers/proxies/codex-proxy");

const app = new Hono();
installErrorHandler(app);
app.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", null);
  const text = await context.req.text();
  context.set("proxyRequestBody", {
    text,
    parsed: JSON.parse(text) as unknown,
    model: context.req.path.startsWith("/openai/") ? "gpt-fake" : "claude-fake",
  });
  await next();
});
app.route("/", proxyRoutes);

let account: Awaited<ReturnType<typeof upsertProviderAccount>>;
let codexAccount: typeof account;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  account = await upsertProviderAccount(db, {
    provider: "claude",
    accountId: "fake-account",
    label: "Fake Claude",
    accessToken: "fake-token-1",
    refreshToken: "fake-refresh-1",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
  codexAccount = await upsertProviderAccount(db, {
    provider: "codex",
    accountId: "fake-codex-account",
    label: "Fake Codex",
    accessToken: "fake-codex-token",
    refreshToken: "fake-codex-refresh",
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

beforeEach(async () => {
  await flushProxyUsage();
  await flushProxyFailureLogs();
  await db.delete(requestUsageBuckets);
});

test("proxy authorization enforces credentials, provider and model scopes before forwarding", async () => {
  const key = await createApiKey(
    db,
    {
      providerScopes: ["codex"],
      modelScopes: ["openai/gpt-fake"],
    },
    Date.now()
  );
  const authenticated = new Hono();
  authenticated.use("*", requireProxyApiKey);
  authenticated.route("/", proxyRoutes);
  const original = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded++;
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    for (const { path, token, model, status } of [
      {
        path: "/openai/v1/responses",
        token: "",
        model: "gpt-fake",
        status: 401,
      },
      {
        path: "/openai/v1/responses",
        token: "Bearer wrong",
        model: "gpt-fake",
        status: 401,
      },
      {
        path: "/anthropic/v1/messages",
        token: `Bearer ${key.key}`,
        model: "claude-fake",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "gpt-other",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "anthropic/gpt-fake",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "",
        status: 400,
      },
      {
        path: "/openai/v1/responses",
        token: `bEaReR ${key.key}`,
        model: "openai/gpt-fake",
        status: 200,
      },
      {
        path: "/openai/v1/responses/compact",
        token: `Bearer ${key.key}`,
        model: "codex/gpt-fake",
        status: 200,
      },
    ]) {
      const before = forwarded;
      const response = await authenticated.request(path, {
        method: "POST",
        headers: { authorization: token },
        body: JSON.stringify({ model }),
      });
      expect(response.status).toBe(status);
      await response.text();
      expect(forwarded - before).toBe(status === 200 ? 1 : 0);
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("compressed bodies are decoded for validation and Codex bodies are sent as zstd when compressed or large", async () => {
  const key = await createApiKey(db, {}, Date.now());
  const authenticated = new Hono();
  authenticated.use("*", requireProxyApiKey);
  authenticated.route("/", proxyRoutes);
  const original = globalThis.fetch;
  let upstream = { encoding: null as string | null, body: "" };
  globalThis.fetch = (async (_input, init) => {
    const encoding = new Headers(init?.headers).get("content-encoding");
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    upstream = {
      encoding,
      body: new TextDecoder().decode(
        encoding === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes
      ),
    };
    return Response.json({ output: [] });
  }) as typeof fetch;
  const small = JSON.stringify({ model: "gpt-fake", input: "hi" });
  const large = JSON.stringify({ model: "gpt-fake", input: "x".repeat(2e6) });
  const claude = JSON.stringify({ model: "claude-fake", messages: [] });
  const bodies: string[] = [];
  try {
    for (const entry of [
      { path: "/openai/v1/responses", body: small, sent: null, out: null },
      { path: "/openai/v1/responses", body: large, sent: null, out: "zstd" },
      { path: "/openai/v1/responses", body: small, sent: "zstd", out: "zstd" },
      { path: "/openai/v1/responses", body: small, sent: "gzip", out: null },
      { path: "/anthropic/v1/messages", body: claude, sent: "zstd", out: null },
      { path: "/anthropic/v1/messages", body: claude, sent: null, out: null },
    ]) {
      const response = await authenticated.request(entry.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          ...(entry.sent ? { "content-encoding": entry.sent } : {}),
        },
        body:
          entry.sent === "zstd"
            ? Bun.zstdCompressSync(entry.body)
            : entry.sent === "gzip"
              ? Bun.gzipSync(entry.body)
              : entry.body,
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.encoding).toBe(entry.out);
      expect(JSON.parse(upstream.body)).toMatchObject(JSON.parse(entry.body));
      bodies.push(upstream.body);
    }
    expect(bodies[4]).toBe(bodies[5]);
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("undecodable or unsupported compressed bodies are rejected before forwarding", async () => {
  const key = await createApiKey(db, {}, Date.now());
  const authenticated = new Hono();
  authenticated.use("*", requireProxyApiKey);
  authenticated.route("/", proxyRoutes);
  const original = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded++;
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    for (const entry of [
      { encoding: "zstd", body: "not zstd", status: 400, message: "zstd" },
      { encoding: "br", body: "{}", status: 415, message: "br" },
      {
        encoding: "constructor",
        body: '{"model":"gpt-fake"}',
        status: 415,
        message: "constructor",
      },
    ]) {
      const response = await authenticated.request("/openai/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          "content-encoding": entry.encoding,
        },
        body: entry.body,
      });
      expect(response.status).toBe(entry.status);
      expect(
        ((await response.json()) as { message: string }).message
      ).toContain(entry.message);
    }
    expect(forwarded).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("compressed uploads over the limit are rejected and cancelled while still streaming", async () => {
  const key = await createApiKey(db, {}, Date.now());
  const authenticated = new Hono();
  authenticated.use("*", requireProxyApiKey);
  authenticated.route("/", proxyRoutes);
  const original = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded++;
    return Response.json({ output: [] });
  }) as typeof fetch;
  const bomb = Bun.zstdCompressSync("x".repeat(65 * 1024 * 1024));
  const skippableFrame = new Uint8Array(8 + 1024 * 1024);
  new DataView(skippableFrame.buffer).setUint32(0, 0x184d2a50, true);
  new DataView(skippableFrame.buffer).setUint32(4, 1024 * 1024, true);
  try {
    for (const chunks of [
      [bomb],
      Array.from({ length: 70 }, () => skippableFrame),
    ]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller): void {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const response = await Promise.race([
        authenticated.request("/openai/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.key}`,
            "content-encoding": "zstd",
          },
          body,
        }),
        Bun.sleep(2000).then(() => null),
      ]);
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({
        message: expect.stringContaining("64 MiB"),
      });
      for (let attempt = 0; attempt < 50 && !cancelled; attempt++) {
        await Bun.sleep(1);
      }
      expect(cancelled).toBe(true);
    }
    expect(forwarded).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the proxy forwards its selected credential, never client secrets, spoofed accounts or IPs", async () => {
  const original = globalThis.fetch;
  let upstream = new Headers();
  globalThis.fetch = (async (_input, init) => {
    upstream = new Headers(init?.headers);
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer kleis_private",
        "x-api-key": "kleis_private",
        "ChatGPT-Account-Id": "spoofed",
        cookie: "session=private",
        forwarded: "for=192.0.2.4",
        "x-forwarded-for": "192.0.2.4",
        "cf-connecting-ip": "192.0.2.4",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.get("authorization")).toBe("Bearer fake-codex-token");
    expect(upstream.get("ChatGPT-Account-Id")).toBe("fake-codex-account");
    for (const name of [
      "x-api-key",
      "cookie",
      "forwarded",
      "x-forwarded-for",
      "cf-connecting-ip",
    ]) {
      expect(upstream.has(name)).toBe(false);
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex compaction keeps tools and generation settings but drops response-only fields", async () => {
  const original = globalThis.fetch;
  let forwarded: unknown = null;
  globalThis.fetch = (async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return Response.json({ object: "response.compaction", output: [] });
  }) as typeof fetch;
  const kept = {
    model: "gpt-fake",
    input: [{ role: "user", content: "compact this" }],
    instructions: "Keep context",
    tools: [{ type: "function", name: "read", parameters: {} }],
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
  };
  try {
    const response = await app.request("/openai/v1/responses/compact", {
      method: "POST",
      body: JSON.stringify({
        ...kept,
        stream: true,
        store: true,
        client_metadata: { source: "fake" },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(forwarded).toEqual(kept);
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex session headers and prompt cache keys are namespaced independently and never invented", async () => {
  const original = globalThis.fetch;
  let forwarded = { headers: new Headers(), body: {} as unknown };
  globalThis.fetch = (async (_input, init) => {
    forwarded = {
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    return Response.json({ output: [] });
  }) as typeof fetch;
  const namespaced = (key: string) =>
    namespaceCodexKey(`fake-key:${codexAccount.id}`, key);
  try {
    for (const entry of [
      { path: "responses", session: "s1", key: "k1", affinity: "s1" },
      { path: "responses", session: "s1", key: null, affinity: "s1" },
      { path: "responses/compact", session: "s1", key: null, affinity: "s1" },
      { path: "responses", session: null, key: "k1", affinity: "k1" },
    ]) {
      const response = await app.request(`/openai/v1/${entry.path}`, {
        method: "POST",
        headers: entry.session ? { "session-id": entry.session } : {},
        body: JSON.stringify({
          model: "gpt-fake",
          input: [],
          ...(entry.key ? { prompt_cache_key: entry.key } : {}),
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      const affinity = await namespaced(entry.affinity);
      expect(forwarded.headers.get("session-id")).toBe(affinity);
      expect(forwarded.headers.get("x-session-affinity")).toBe(affinity);
      if (entry.key) {
        expect(forwarded.body).toMatchObject({
          prompt_cache_key: await namespaced(entry.key),
        });
      } else {
        expect(forwarded.body).not.toHaveProperty("prompt_cache_key");
      }
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex keeps client request, thread, user-agent and beta headers", async () => {
  const original = globalThis.fetch;
  let upstream = new Headers();
  globalThis.fetch = (async (_input, init) => {
    upstream = new Headers(init?.headers);
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    for (const entry of [
      {
        sent: {
          "x-client-request-id": "fake-request",
          "thread-id": "fake-thread",
          "user-agent": "fake-client/1.2.3",
          "openai-beta": "fake_beta=1",
          "x-codex-beta-features": "fake_feature",
          originator: "fake-originator",
        },
        expected: {
          "x-client-request-id": "fake-request",
          "thread-id": "fake-thread",
          "user-agent": "fake-client/1.2.3",
          "openai-beta": "fake_beta=1",
          "x-codex-beta-features": "fake_feature,remote_compaction_v2",
          originator: "fake-originator",
          "session-id": null,
        },
      },
      {
        sent: {},
        expected: {
          "user-agent": CODEX_USER_AGENT,
          "x-codex-beta-features": "remote_compaction_v2",
          "openai-beta": null,
        },
      },
    ]) {
      const response = await app.request("/openai/v1/responses", {
        method: "POST",
        headers: entry.sent,
        body: "{}",
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(
        Object.fromEntries(
          Object.keys(entry.expected).map((name) => [name, upstream.get(name)])
        )
      ).toEqual(entry.expected);
      expect(upstream.get("authorization")).toBe("Bearer fake-codex-token");
      expect(upstream.get("ChatGPT-Account-Id")).toBe("fake-codex-account");
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("route records one successful SSE request including latest tokens", async () => {
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

test("Claude compaction usage iterations are counted once in JSON and SSE", async () => {
  const onDemand = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    iterations: [
      {
        type: "compaction",
        input_tokens: 132,
        output_tokens: 173,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    ],
  };
  const threshold = {
    input_tokens: 23_000,
    output_tokens: 1000,
    cache_read_input_tokens: 4000,
    iterations: [
      { type: "compaction", input_tokens: 180_000, output_tokens: 3500 },
      {
        type: "message",
        input_tokens: 23_000,
        output_tokens: 1000,
        cache_read_input_tokens: 4000,
      },
    ],
  };
  const sse = (finalUsage: Record<string, unknown>) =>
    new Response(
      event({
        type: "message_start",
        message: { usage: { input_tokens: 0, output_tokens: 0 } },
      }) +
        event({ type: "message_delta", usage: finalUsage }) +
        event({ type: "message_stop" }),
      { headers: { "content-type": "text/event-stream" } }
    );
  const original = globalThis.fetch;
  try {
    for (const { upstream, expected } of [
      {
        upstream: () => Response.json({ type: "message", usage: onDemand }),
        expected: { inputTokens: 132, outputTokens: 173 },
      },
      {
        upstream: () => sse(onDemand),
        expected: { inputTokens: 132, outputTokens: 173 },
      },
      {
        upstream: () => Response.json({ type: "message", usage: threshold }),
        expected: {
          inputTokens: 203_000,
          outputTokens: 4500,
          cacheReadTokens: 4000,
        },
      },
      {
        upstream: () => sse(threshold),
        expected: {
          inputTokens: 203_000,
          outputTokens: 4500,
          cacheReadTokens: 4000,
        },
      },
    ]) {
      globalThis.fetch = (async () => upstream()) as typeof fetch;
      const response = await request();
      expect(response.status).toBe(200);
      await response.text();
      await flushProxyUsage();
      expect(await db.select().from(requestUsageBuckets)).toMatchObject([
        { requestCount: 1, cacheReadTokens: 0, ...expected },
      ]);
      await db.delete(requestUsageBuckets);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Claude cache writes are recorded by TTL in JSON and SSE", async () => {
  const split = {
    cache_creation_input_tokens: 7,
    cache_creation: {
      ephemeral_5m_input_tokens: 3,
      ephemeral_1h_input_tokens: 4,
    },
  };
  const iterations = {
    ...split,
    iterations: [
      { type: "compaction", input_tokens: 9, ...split },
      { type: "message", input_tokens: 1, ...split },
    ],
  };
  const sse = (
    start: Record<string, unknown>,
    delta: Record<string, unknown>
  ) =>
    new Response(
      event({ type: "message_start", message: { usage: start } }) +
        event({ type: "message_delta", usage: delta }) +
        event({ type: "message_stop" }),
      { headers: { "content-type": "text/event-stream" } }
    );
  const original = globalThis.fetch;
  try {
    for (const { upstream, expected } of [
      {
        upstream: () => Response.json({ type: "message", usage: split }),
        expected: { cacheWrite5mTokens: 3, cacheWrite1hTokens: 4 },
      },
      {
        upstream: () => sse(split, { output_tokens: 1 }),
        expected: { cacheWrite5mTokens: 3, cacheWrite1hTokens: 4 },
      },
      {
        upstream: () => sse({ input_tokens: 1 }, split),
        expected: { cacheWrite5mTokens: 3, cacheWrite1hTokens: 4 },
      },
      {
        upstream: () => Response.json({ type: "message", usage: iterations }),
        expected: { cacheWrite5mTokens: 6, cacheWrite1hTokens: 8 },
      },
      {
        upstream: () => sse({ input_tokens: 0 }, iterations),
        expected: { cacheWrite5mTokens: 6, cacheWrite1hTokens: 8 },
      },
    ]) {
      globalThis.fetch = (async () => upstream()) as typeof fetch;
      const response = await request();
      expect(response.status).toBe(200);
      await response.text();
      await flushProxyUsage();
      expect(await db.select().from(requestUsageBuckets)).toMatchObject([
        { requestCount: 1, ...expected },
      ]);
      await db.delete(requestUsageBuckets);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("concurrent first turns are not compared, and a later cold turn logs and records one content-free miss", async () => {
  const original = globalThis.fetch;
  const info = spyOn(console, "info").mockImplementation(() => undefined);
  const gates: ((response: Response) => void)[] = [];
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => gates.push(resolve))) as typeof fetch;
  const admin = new Hono().route("/", adminUsageRoutes);
  const repaidSinceStart = async (provider: string) => {
    const body = (await (await admin.request("/dashboard")).json()) as {
      promptCacheMisses: {
        totals: {
          provider: string;
          isMain: boolean;
          idleGap: string;
          has5mBreakpoint: boolean;
          repaidTokens: number;
        }[];
      };
    };
    const main = body.promptCacheMisses.totals.filter(
      (total) => total.provider === provider && total.isMain
    );
    return {
      cacheRepaidTokens: main.reduce((sum, t) => sum + t.repaidTokens, 0),
      cacheRepaidIdleTokens: main
        .filter((t) => t.idleGap === "5m_to_60m" && t.has5mBreakpoint)
        .reduce((sum, t) => sum + t.repaidTokens, 0),
    };
  };
  const recorded = async (provider: string) => {
    await flushProxyUsage();
    const rows = await db.select().from(requestUsageBuckets);
    const own = rows.filter((row) => row.provider === provider);
    return {
      cacheRepaidTokens: own.reduce((sum, r) => sum + r.cacheRepaidTokens, 0),
      cacheRepaidIdleTokens: own.reduce(
        (sum, r) => sum + r.cacheRepaidIdleTokens,
        0
      ),
    };
  };
  const missLines = () =>
    info.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"prompt_cache_miss"'));
  try {
    for (const entry of [
      {
        provider: "claude",
        path: "/anthropic/v1/messages",
        headers: { "x-claude-code-session-id": "fake-claude-session" },
        body: {
          system: "SECRET system",
          messages: [
            {
              content: [
                {
                  type: "text",
                  text: "SECRET",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
        cold: {
          usage: { input_tokens: 500, cache_creation_input_tokens: 20_000 },
        },
        idle: 20_000,
        accountId: () => account.id,
      },
      {
        provider: "codex",
        path: "/openai/v1/responses",
        headers: { "session-id": "fake-codex-session" },
        body: {
          instructions: "SECRET instructions",
          input: [{ content: "SECRET" }],
        },
        cold: {
          usage: {
            input_tokens: 20_500,
            input_tokens_details: { cache_write_tokens: 20_000 },
          },
        },
        idle: 0,
        accountId: () => codexAccount.id,
      },
    ]) {
      gates.length = 0;
      const send = () =>
        app.request(entry.path, {
          method: "POST",
          headers: entry.headers,
          body: JSON.stringify(entry.body),
        });
      const finish = async (pending: Promise<Response>, gate: number) => {
        while (gates.length <= gate) await Bun.sleep(1);
        gates[gate]?.(Response.json(entry.cold));
        await (await pending).text();
      };
      const [first, second] = [send(), send()];
      await finish(first, 0);
      await finish(second, 1);
      expect(missLines()).toHaveLength(0);

      const before = await repaidSinceStart(entry.provider);
      setSystemTime(new Date(Date.now() + 10 * 60_000));
      try {
        await finish(send(), 2);
      } finally {
        setSystemTime();
      }
      const after = await repaidSinceStart(entry.provider);
      const expectedRepaid = {
        cacheRepaidTokens: 20_000,
        cacheRepaidIdleTokens: entry.idle,
      };
      expect({
        cacheRepaidTokens: after.cacheRepaidTokens - before.cacheRepaidTokens,
        cacheRepaidIdleTokens:
          after.cacheRepaidIdleTokens - before.cacheRepaidIdleTokens,
      }).toEqual(expectedRepaid);
      expect(await recorded(entry.provider)).toEqual(expectedRepaid);
      const [line = "", ...rest] = missLines();
      expect(rest).toHaveLength(0);
      expect(line).not.toMatch(/SECRET|fake-(claude|codex)-session/);
      const expected = {
        apiKeyId: "fake-key",
        providerAccountId: entry.accountId(),
        reason: "idle_expired",
        repaidTokens: 20_000,
      };
      expect(JSON.parse(line)).toMatchObject(expected);
      info.mockClear();
    }
    await flushProxyUsage();
  } finally {
    info.mockRestore();
    globalThis.fetch = original;
  }
});

test("Codex HTTP-200 SSE rate limits count as failed requests", async () => {
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body = event({
    type: "error",
    error: { type: "rate_limit_error", message: "Try again later" },
  });
  globalThis.fetch = (async () =>
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      body: '{"stream":true}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      { requestCount: 1, successCount: 0, rateLimitCount: 1 },
    ]);
  } finally {
    warn.mockRestore();
    globalThis.fetch = original;
  }
});

test("route auth replay records only final stream with refreshed account", async () => {
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
  const original = globalThis.fetch;
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  globalThis.fetch = (async () =>
    new Response(
      'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}\n\n',
      { status: 403, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const response = await request();
    expect(response.status).toBe(403);
    await response.text();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "proxy_upstream_response_failed",
      provider: "claude",
      providerAccountId: account.id,
      status: 403,
    });
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        authErrorCount: 1,
        serverErrorCount: 0,
      },
    ]);
  } finally {
    log.mockRestore();
    globalThis.fetch = original;
  }
});

for (const [provider, path] of [
  ["codex", "/openai/v1/responses"],
  ["claude", "/anthropic/v1/messages"],
] as const) {
  test(`${provider} defers SSE accounting until downstream cancellation`, async () => {
    const original = globalThis.fetch;
    let cancelled = 0;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          },
          cancel(): void {
            cancelled++;
          },
        }),
        provider === "codex"
          ? {}
          : { headers: { "content-type": "text/event-stream" } }
      )) as typeof fetch;
    try {
      const response = await app.request(path, {
        method: "POST",
        body: '{"stream":true}',
      });
      await flushProxyUsage();
      expect(await db.select().from(requestUsageBuckets)).toEqual([]);
      await response.body?.cancel();
      await flushProxyUsage();
      expect(cancelled).toBe(1);
      expect(await db.select().from(requestUsageBuckets)).toMatchObject([
        { requestCount: 1, successCount: 0, clientErrorCount: 1 },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each([403, 429, 503])(
    `${provider} non-2xx %s is logged once without provider content`,
    async (status) => {
      const original = globalThis.fetch;
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const error = spyOn(console, "error").mockImplementation(() => undefined);
      const body = {
        error: {
          type: "permission_error",
          code: "private-code",
          message: "private prompt",
        },
      };
      globalThis.fetch = (async () =>
        Response.json(body, { status })) as typeof fetch;
      try {
        const response = await app.request(path, {
          method: "POST",
          body: "{}",
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        const calls = [...warn.mock.calls, ...error.mock.calls];
        expect(calls).toHaveLength(1);
        const line = String(calls[0]?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "proxy_upstream_response_failed",
          level: status >= 500 ? "error" : "warn",
          provider,
          providerAccountId: expect.any(String),
          status,
          errorType: "permission_error",
          errorCode: null,
          elapsedMs: expect.any(Number),
        });
        expect(line).not.toContain("private");
      } finally {
        warn.mockRestore();
        error.mockRestore();
        globalThis.fetch = original;
      }
    }
  );
}

test("Codex streaming HTTP errors without content-type retain bytes and log safe metadata once", async () => {
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "server_error", "code": "overloaded_error", "message": "PRIVATESECRETTOKEN" } }';
  globalThis.fetch = (async () =>
    new Response(new TextEncoder().encode(body), {
      status: 503,
      headers: { "retry-after": "3" },
    })) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      body: '{"stream":true}',
    });
    expect(response.status).toBe(503);
    expect(response.headers.has("content-type")).toBe(false);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe(body);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "proxy_upstream_response_failed",
      provider: "codex",
      status: 503,
      errorType: "server_error",
      errorCode: "overloaded_error",
    });
    expect(line).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      { requestCount: 1, successCount: 0, serverErrorCount: 1 },
    ]);
  } finally {
    warn.mockRestore();
    error.mockRestore();
    globalThis.fetch = original;
  }
});

test("thrown upstream failures reach the global error handler exactly once", async () => {
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  globalThis.fetch = (() =>
    Promise.reject(
      new Error("ConnectionRefused: upstream socket")
    )) as typeof fetch;
  try {
    expect((await request()).status).toBe(500);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "http_request_failed",
      provider: "claude",
      providerAccountId: account.id,
      errorMessage: "ConnectionRefused: upstream socket",
    });
  } finally {
    warn.mockRestore();
    log.mockRestore();
    globalThis.fetch = original;
  }
});

test("100 identical Claude 429s do not flood the logs or change client responses", async () => {
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  const body = {
    error: {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "PRIVATESECRETTOKEN",
    },
  };
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json(body, {
        status: 429,
        headers: { "x-request-id": "PRIVATESECRETTOKEN" },
      })
    )) as typeof fetch;
  try {
    for (let index = 0; index < 100; index++) {
      const response = await request();
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual(body);
    }
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "proxy_upstream_response_failed",
      status: 429,
      errorCode: "rate_limit_exceeded",
    });
    expect(line).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyFailureLogs();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      suppressedCount: 99,
      summaryReason: "shutdown",
      errorCode: "rate_limit_exceeded",
    });
    expect(String(log.mock.calls[1]?.[0])).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyFailureLogs();
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("exhausted 429s expose only the blocking window's reset and account", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const seconds = 3 * 3600 + 12 * 60;
  const reset = now + seconds * 1000;
  const resetsAt = new Date(reset).toISOString();
  const cases = [
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(reset / 1000),
      },
    },
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(reset / 1000 + 86400),
        "anthropic-ratelimit-unified-reset": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000),
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-reset-at": String(reset / 1000 + 86400),
      },
      type: "rate_limit_error",
      error: { resets_in_seconds: seconds * 2 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-after-seconds": String(seconds),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "20",
        "x-codex-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_in_seconds: seconds },
    },
    {
      provider: "codex",
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "bengalfox",
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000),
        "x-codex-bengalfox-secondary-used-percent": "20",
        "x-codex-bengalfox-secondary-reset-at": String(reset / 1000 + 86400),
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": " CODEX_BENGALFOX ",
        "x-codex-bengalfox-secondary-used-percent": "100",
        "x-codex-bengalfox-secondary-reset-after-seconds": String(seconds),
      },
      type: "rate_limit_error",
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(now / 1000 - 30),
      },
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "premium",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "premium",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000),
      },
      type: "rate_limit_error",
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "premium",
        "x-codex-premium-primary-used-percent": "20",
        "x-codex-premium-primary-reset-at": String(reset / 1000 + 86400),
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "20",
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_at: reset / 1000 },
    },
  ] as const;
  try {
    for (const entry of cases) {
      const selected = entry.provider === "claude" ? account : codexAccount;
      globalThis.fetch = (async () =>
        Response.json(
          {
            error: {
              type:
                entry.provider === "claude"
                  ? "rate_limit_error"
                  : "type" in entry
                    ? entry.type
                    : "usage_limit_reached",
              code:
                "type" in entry ? "rate_limit_exceeded" : "usage_limit_reached",
              message: "PRIVATESECRETTOKEN",
              ...("error" in entry ? entry.error : {}),
            },
          },
          {
            status: 429,
            headers: {
              ...("headers" in entry ? entry.headers : {}),
              "retry-after": "61",
              "retry-after-ms": "61000",
              "x-request-id": "fake-request",
              "content-encoding": "gzip",
              "content-length": "999",
            },
          }
        )) as typeof fetch;
      const response = await app.request(
        entry.provider === "claude"
          ? "/anthropic/v1/messages"
          : "/openai/v1/responses",
        {
          method: "POST",
          headers: { "x-kleis-on-limit": "fail" },
          body: '{"stream":true}',
        }
      );
      expect(response.status).toBe(429);
      for (const header of [
        "retry-after",
        "retry-after-ms",
        "content-encoding",
        "content-length",
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(response.headers.get("x-request-id")).toBe("fake-request");
      const body = await response.json();
      expect(body).toEqual({
        ...(entry.provider === "claude" ? { type: "error" } : {}),
        error: {
          type:
            entry.provider === "claude"
              ? "rate_limit_error"
              : "type" in entry
                ? entry.type
                : "usage_limit_reached",
          ...(entry.provider === "codex"
            ? {
                code:
                  "type" in entry
                    ? "rate_limit_exceeded"
                    : "usage_limit_reached",
              }
            : {}),
          message: `${entry.provider === "claude" ? "Claude" : "Codex"} usage limit reached for account "${selected.label}". Resets at ${resetsAt} (in 3h 12m).`,
          resets_at: resetsAt,
          account: selected.label,
        },
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATESECRETTOKEN");
    }
    await flushProxyUsage();
    const rows = await db.select().from(requestUsageBuckets);
    for (const provider of ["claude", "codex"] as const) {
      const count = cases.filter((entry) => entry.provider === provider).length;
      expect(rows.find((row) => row.provider === provider)).toMatchObject({
        requestCount: count,
        rateLimitCount: count,
        successCount: 0,
      });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATESECRETTOKEN");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Fake Claude");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Fake Codex");
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("short or missing retry hints preserve non-exhausted 429 bytes and headers", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "rate_limit_error", "message": "Try later", "resets_in_seconds": 7200 } }';
  try {
    for (const entry of [
      {
        path: "/anthropic/v1/messages",
        headers: { "retry-after": "60", "retry-after-ms": "60000" },
      },
      { path: "/openai/v1/responses", headers: { "retry-after-ms": "60000" } },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 60),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: { "x-codex-primary-reset-at": String(now / 1000 + 10800) },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-active-limit": "premium",
          "x-codex-premium-primary-used-percent": "20",
          "x-codex-premium-primary-reset-at": String(now / 1000 + 10800),
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(now / 1000 + 10800),
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "20",
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(now / 1000 - 30),
        },
      },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "retry-after": "3",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(now / 1000 - 30),
          "anthropic-ratelimit-unified-reset": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "100",
        },
      },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "retry-after": "3",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
        },
      },
    ]) {
      const headers = new Headers({
        ...entry.headers,
        "content-type": "application/json",
        "x-request-id": "fake-short-throttle",
      });
      globalThis.fetch = (async () =>
        new Response(body, { status: 429, headers })) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        headers: { "x-kleis-on-limit": "fail" },
        body: '{"stream":true}',
      });
      expect(response.status).toBe(429);
      expect([...response.headers]).toEqual([...headers]);
      expect(await response.text()).toBe(body);
    }
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("explicitly exhausted 429s never borrow retry hints, expired or allowed resets", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const entry of [
      {
        provider: "claude",
        path: "/anthropic/v1/messages",
        selected: account,
        type: "rate_limit_error",
        code: null,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(
            Date.now() / 1000 - 30
          ),
          "anthropic-ratelimit-unified-7d-utilization": "0.2",
          "anthropic-ratelimit-unified-7d-reset": String(
            Date.now() / 1000 + 10800
          ),
        },
      },
      {
        provider: "codex",
        path: "/openai/v1/responses",
        selected: codexAccount,
        type: "usage_limit_reached",
        code: "usage_limit_reached",
        resets_at: Date.now() / 1000 - 30,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(Date.now() / 1000 - 30),
          "x-codex-secondary-used-percent": "20",
          "x-codex-secondary-reset-at": String(Date.now() / 1000 + 10800),
        },
      },
      {
        provider: "codex",
        path: "/openai/v1/responses",
        selected: codexAccount,
        type: "usage_limit_reached",
        code: "usage_limit_reached",
        headers: {
          "x-codex-active-limit": "premium",
          "x-codex-premium-primary-used-percent": "20",
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(
            Date.now() / 1000 + 10800
          ),
        },
      },
    ]) {
      globalThis.fetch = (async () =>
        Response.json(
          {
            error: {
              type: entry.type,
              code: entry.code,
              message: "PRIVATESECRETTOKEN",
              ...("resets_at" in entry ? { resets_at: entry.resets_at } : {}),
            },
          },
          {
            status: 429,
            headers: {
              ...entry.headers,
              "retry-after": "61",
              "retry-after-ms": "61000",
            },
          }
        )) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        headers: { "x-kleis-on-limit": "fail" },
        body: "{}",
      });
      expect(response.status).toBe(429);
      expect(response.headers.has("retry-after")).toBe(false);
      expect(response.headers.has("retry-after-ms")).toBe(false);
      expect(await response.json()).toEqual({
        ...(entry.provider === "claude" ? { type: "error" } : {}),
        error: {
          type: entry.type,
          ...(entry.provider === "codex" ? { code: entry.code } : {}),
          message: `${entry.provider === "claude" ? "Claude" : "Codex"} usage limit reached for account "${entry.selected.label}". Reset time unknown.`,
          resets_at: null,
          account: entry.selected.label,
        },
      });
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("ordinary throttle retry hints are preserved by default and capped only in fail mode", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "rate_limit_error", "message": "Rate limit exceeded. Try again later." } }';
  try {
    for (const mode of ["wait", "fail"] as const) {
      for (const entry of [
        { path: "/anthropic/v1/messages", headers: { "retry-after": "61" } },
        { path: "/openai/v1/responses", headers: { "retry-after": "61" } },
        {
          path: "/anthropic/v1/messages",
          headers: { "retry-after-ms": "61000" },
        },
        {
          path: "/openai/v1/responses",
          headers: {
            "retry-after": new Date(Date.now() + 120000).toUTCString(),
            "retry-after-ms": "invalid",
          },
        },
      ]) {
        const headers = new Headers({
          ...entry.headers,
          "content-type": "application/json",
          "x-request-id": "fake-throttle",
          "x-should-retry": "true",
        });
        globalThis.fetch = (async () =>
          new Response(body, { status: 429, headers })) as typeof fetch;
        const response = await app.request(entry.path, {
          method: "POST",
          ...(mode === "fail"
            ? { headers: { "x-kleis-on-limit": "fail" } }
            : {}),
          body: '{"stream":true}',
        });
        expect(response.status).toBe(429);
        if (mode === "fail") {
          headers.delete("retry-after");
          headers.delete("retry-after-ms");
        }
        expect([...response.headers]).toEqual([...headers]);
        expect(await response.text()).toBe(body);
      }
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("allowed Claude quota resets cannot turn a throttle into subscription exhaustion", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "type": "error", "error": { "type": "rate_limit_error", "message": "Rate limit exceeded" } }';
  try {
    for (const utilization of ["0.2", "0.99999"]) {
      const headers = new Headers({
        "content-type": "application/json",
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": utilization,
        "anthropic-ratelimit-unified-reset": String(Date.now() / 1000 + 10800),
      });
      globalThis.fetch = (async () =>
        new Response(body, { status: 429, headers })) as typeof fetch;
      const response = await request();
      expect(response.status).toBe(429);
      expect([...response.headers]).toEqual([...headers]);
      expect(await response.text()).toBe(body);
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("synthesized quota errors discard upstream retry overrides and hints", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const entry of [
      {
        path: "/anthropic/v1/messages",
        type: "rate_limit_error",
        headers: { "anthropic-ratelimit-unified-status": "rejected" },
      },
      {
        path: "/openai/v1/responses",
        type: "usage_limit_reached",
        headers: {},
      },
    ]) {
      globalThis.fetch = (async () =>
        Response.json(
          { error: { type: entry.type, message: "Limit reached" } },
          {
            status: 429,
            headers: {
              ...entry.headers,
              "retry-after": "61",
              "retry-after-ms": "61000",
              "x-should-retry": "true",
              "x-ms-retry-after-ms": "61000",
              "x-request-id": "fake-quota",
            },
          }
        )) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        headers: { "x-kleis-on-limit": "fail" },
        body: "{}",
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("x-request-id")).toBe("fake-quota");
      for (const header of [
        "retry-after",
        "retry-after-ms",
        "x-should-retry",
        "x-ms-retry-after-ms",
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(await response.json()).toMatchObject({
        error: {
          type: entry.type,
          resets_at: null,
          account: expect.any(String),
        },
      });
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("default mode waits for known exhausted resets and retries unknown resets without leaking its option", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-10-19T00:00:00Z");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const provider of ["claude", "codex"] as const) {
      const selected = provider === "claude" ? account : codexAccount;
      for (const entry of [
        {
          reset: now + 4080_500,
          retryAfter: "4081",
          when: "01:08 UTC",
          duration: "1h 9m",
          option: undefined,
        },
        {
          reset: now + 2 * 86400_000 + 4080_000,
          retryAfter: "176880",
          when: "Oct 21 01:08 UTC",
          duration: "49h 8m",
          option: "wait",
        },
        {
          reset: null,
          retryAfter: null,
          when: null,
          duration: null,
          option: undefined,
        },
      ]) {
        let forwarded = new Headers();
        globalThis.fetch = (async (_url, init) => {
          forwarded = new Headers(init?.headers);
          return Response.json(
            {
              error: {
                type:
                  provider === "claude"
                    ? "rate_limit_error"
                    : "usage_limit_reached",
                code: "insufficient_quota",
                message: "PRIVATESECRETTOKEN usage limit quota exceeded",
                ...(entry.reset === null
                  ? {}
                  : { resets_at: entry.reset / 1000 }),
              },
            },
            {
              status: 429,
              headers: {
                ...(provider === "claude"
                  ? {
                      "anthropic-ratelimit-unified-status": "rejected",
                      ...(entry.reset === null
                        ? {}
                        : {
                            "anthropic-ratelimit-unified-reset": String(
                              entry.reset / 1000
                            ),
                          }),
                    }
                  : {}),
                "retry-after": "61",
                "retry-after-ms": "61000",
                "x-should-retry": "false",
                "x-ms-retry-after-ms": "61000",
              },
            }
          );
        }) as typeof fetch;
        const response = await app.request(
          provider === "claude"
            ? "/anthropic/v1/messages"
            : "/openai/v1/responses",
          {
            method: "POST",
            headers: entry.option ? { "x-kleis-on-limit": entry.option } : {},
            body: "{}",
          }
        );
        expect(forwarded.has("x-kleis-on-limit")).toBe(false);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe(entry.retryAfter);
        for (const header of [
          "retry-after-ms",
          "x-should-retry",
          "x-ms-retry-after-ms",
        ]) {
          expect(response.headers.has(header)).toBe(false);
        }
        const prefix = `${provider === "claude" ? "Claude" : "Codex"} limit for "${selected.label}"`;
        expect(await response.json()).toEqual({
          ...(provider === "claude" ? { type: "error" } : {}),
          error: {
            type: "rate_limit_error",
            ...(provider === "codex" ? { code: "rate_limit_exceeded" } : {}),
            message:
              entry.reset === null
                ? `${prefix} reached. Reset time unknown.`
                : `${prefix} resets at ${entry.when} (in ${entry.duration})`,
            resets_at:
              entry.reset === null ? null : new Date(entry.reset).toISOString(),
            account: selected.label,
          },
        });
      }
    }
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("fail mode preserves terminal exhausted-limit errors without forwarding its option", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-10-19T00:00:00Z");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const provider of ["claude", "codex"] as const) {
      const selected = provider === "claude" ? account : codexAccount;
      for (const reset of [now + 4080_000, null]) {
        let forwarded = new Headers();
        globalThis.fetch = (async (_url, init) => {
          forwarded = new Headers(init?.headers);
          return Response.json(
            {
              error: {
                type:
                  provider === "claude"
                    ? "rate_limit_error"
                    : "usage_limit_reached",
                code: "usage_limit_reached",
                message: "PRIVATESECRETTOKEN",
                ...(reset === null ? {} : { resets_at: reset / 1000 }),
              },
            },
            {
              status: 429,
              headers: {
                ...(provider === "claude"
                  ? {
                      "anthropic-ratelimit-unified-status": "rejected",
                      ...(reset === null
                        ? {}
                        : {
                            "anthropic-ratelimit-unified-reset": String(
                              reset / 1000
                            ),
                          }),
                    }
                  : {}),
                "retry-after": "61",
                "x-should-retry": "true",
              },
            }
          );
        }) as typeof fetch;
        const response = await app.request(
          provider === "claude"
            ? "/anthropic/v1/messages"
            : "/openai/v1/responses",
          {
            method: "POST",
            headers: { "x-kleis-on-limit": "fail" },
            body: "{}",
          }
        );
        expect(forwarded.has("x-kleis-on-limit")).toBe(false);
        expect(response.status).toBe(429);
        expect(
          [...response.headers.keys()].filter((name) => name.includes("retry"))
        ).toEqual([]);
        const resetsAt = reset === null ? null : new Date(reset).toISOString();
        expect(await response.json()).toEqual({
          ...(provider === "claude" ? { type: "error" } : {}),
          error: {
            type:
              provider === "claude"
                ? "rate_limit_error"
                : "usage_limit_reached",
            ...(provider === "codex" ? { code: "usage_limit_reached" } : {}),
            message: `${provider === "claude" ? "Claude" : "Codex"} usage limit reached for account "${selected.label}". ${resetsAt === null ? "Reset time unknown." : `Resets at ${resetsAt} (in 1h 8m).`}`,
            resets_at: resetsAt,
            account: selected.label,
          },
        });
      }
    }
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
