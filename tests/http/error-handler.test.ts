import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { installErrorHandler } from "../../src/http/error-handler";

test("unexpected route errors log once with the real error and safe request context", async () => {
  const app = new Hono();
  installErrorHandler(app);
  const error = new TypeError("upstream connection refused");
  app.post("/api/:modelsToken/api.json", (context) => {
    context.set("proxyLogContext", {
      provider: "codex",
      providerAccountId: "fake-account",
      endpoint: "responses",
    });
    throw error;
  });
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await app.request(
      "/api/private-token/api.json?secret=private-query",
      {
        method: "POST",
        headers: {
          authorization: "Bearer private-auth",
          cookie: "private-cookie",
        },
        body: "private prompt and tool content",
      }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: error.message });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      event: "http_request_failed",
      method: "POST",
      path: "/api/:modelsToken/api.json",
      provider: "codex",
      providerAccountId: "fake-account",
      status: 500,
      elapsedMs: expect.any(Number),
      errorName: "TypeError",
      errorMessage: error.message,
      errorStack: error.stack,
    });
    expect(line).not.toContain("private");
  } finally {
    log.mockRestore();
  }
});

test("expected HTTP rejections are not unexpected errors", async () => {
  const app = new Hono();
  installErrorHandler(app);
  app.get("/denied", () => {
    throw new HTTPException(401, { message: "Unauthorized" });
  });
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect((await app.request("/denied")).status).toBe(401);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("client cancellation is not logged as a broken proxy request", async () => {
  const app = new Hono();
  installErrorHandler(app);
  app.get("/cancelled", () => {
    throw new Error("Request aborted");
  });
  const controller = new AbortController();
  controller.abort();
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await app.request("/cancelled", { signal: controller.signal });
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("database errors keep the actual cause without SQL parameters", async () => {
  const app = new Hono();
  installErrorHandler(app);
  const cause = new Error("SQLITE_BUSY: database is locked");
  app.get("/db", () => {
    throw new DrizzleQueryError(
      "update provider_accounts set access_token = ?",
      ["private-token"],
      cause
    );
  });
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await app.request("/db");
    expect(await response.json()).toMatchObject({ message: cause.message });
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      errorMessage: cause.message,
      errorStack: cause.stack,
    });
    expect(line).not.toContain("private-token");
    expect(line).not.toContain("update provider_accounts");
  } finally {
    log.mockRestore();
  }
});
