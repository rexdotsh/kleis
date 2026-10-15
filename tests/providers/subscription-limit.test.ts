import { expect, test } from "bun:test";
import { isSubscriptionLimitResponse } from "../../src/providers/proxies/subscription-limit";

const signal = () => new AbortController().signal;

test.each([undefined, "allowed"])(
  "Claude generic rate_limit_error with status %s is not subscription exhaustion",
  async (status) => {
    const headers = new Headers({ "retry-after": "60" });
    if (status) headers.set("anthropic-ratelimit-unified-status", status);
    const response = Response.json(
      { error: { type: "rate_limit_error" } },
      { status: 429, headers }
    );
    expect(
      await isSubscriptionLimitResponse("claude", response, signal())
    ).toBe(false);
  }
);

test.each([0.2, 1])(
  "Claude representative claim at %s requires its own exhausted window",
  async (utilization) => {
    const response = new Response(null, {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": String(utilization),
        "anthropic-ratelimit-unified-7d-utilization": "1",
      },
    });
    expect(
      await isSubscriptionLimitResponse("claude", response, signal())
    ).toBe(utilization >= 1);
  }
);

test.each(["claude", "codex"] as const)(
  "%s subscription headers classify without reading a hanging body",
  async (provider) => {
    let reads = 0;
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            reads++;
          },
        },
        { highWaterMark: 0 }
      ),
      {
        status: 429,
        headers:
          provider === "claude"
            ? { "anthropic-ratelimit-unified-status": "rejected" }
            : { "x-codex-primary-used-percent": "100" },
      }
    );
    expect(
      await isSubscriptionLimitResponse(provider, response, signal())
    ).toBe(true);
    expect(reads).toBe(0);
    await response.body?.cancel();
  }
);

test("Codex usage-limit code is distinct from per-minute rate_limit_exceeded", async () => {
  for (const code of ["rate_limit_exceeded", "usage_limit_reached"]) {
    const response = Response.json(
      { error: { type: "rate_limit_error", code } },
      { status: 429 }
    );
    expect(await isSubscriptionLimitResponse("codex", response, signal())).toBe(
      code === "usage_limit_reached"
    );
  }
  const conflicting = Response.json(
    { error: { type: "usage_limit_reached", code: "rate_limit_exceeded" } },
    { status: 429 }
  );
  expect(
    await isSubscriptionLimitResponse("codex", conflicting, signal())
  ).toBe(false);
});

test("Codex classification has a size cap and preserves the upstream body", async () => {
  const text = JSON.stringify({
    error: { code: "usage_limit_reached" },
    padding: "x".repeat(8192),
  });
  const response = new Response(text, {
    status: 429,
    headers: { "content-type": "application/json" },
  });
  expect(await isSubscriptionLimitResponse("codex", response, signal())).toBe(
    false
  );
  expect(await response.text()).toBe(text);
});

test("client cancellation detaches from a delayed classification body", async () => {
  const controller = new AbortController();
  const reason = new Error("fake disconnect");
  const response = new Response(new ReadableStream(), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
  const reading = isSubscriptionLimitResponse(
    "codex",
    response,
    controller.signal
  );
  const outcome = reading.then(
    () => null,
    (error: unknown) => error
  );
  controller.abort(reason);
  expect(
    await Promise.race([outcome, Bun.sleep(250).then(() => "still waiting")])
  ).toBe(reason);
  await response.body?.cancel();
});

test("Codex classification stops waiting for an incomplete body after three seconds", async () => {
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
    { status: 429 }
  );
  const startedAt = performance.now();
  expect(await isSubscriptionLimitResponse("codex", response, signal())).toBe(
    false
  );
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2800);
  await response.body?.cancel();
  expect(cancelled).toBe(1);
}, 5000);
