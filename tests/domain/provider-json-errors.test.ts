import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import type { Database } from "../../src/db";
import * as schema from "../../src/db/schema";
import {
  refreshProviderAccount,
  startProviderOAuth,
  completeProviderOAuth,
} from "../../src/domain/providers/provider-service";
import { installErrorHandler } from "../../src/http/error-handler";
import { errorLogFields } from "../../src/utils/log";

const originalFetch = globalThis.fetch;
let client: ReturnType<typeof createClient>;
let database: Database;
const secret = "PRIVATESECRETTOKEN";

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  const now = Date.now();
  for (const provider of ["claude", "codex"] as const) {
    await database.insert(schema.providerAccounts).values({
      id: `fake-${provider}`,
      provider,
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now - 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  globalThis.fetch = (() =>
    Promise.resolve(new Response(secret))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  client.close();
});

test.each([
  "claude",
  "codex",
] as const)("%s malformed token responses cannot leak through refresh or HTTP logs", async (provider) => {
  const app = new Hono();
  installErrorHandler(app);
  app.get("/refresh", async () => {
    await refreshProviderAccount(database, `fake-${provider}`, Date.now(), {
      force: true,
    });
    return new Response(null, { status: 204 });
  });
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await app.request("/refresh");
    expect(response.status).toBe(500);
    const message = `${provider === "claude" ? "Claude" : "Codex"} token response is not valid JSON (HTTP 200, 18 bytes)`;
    expect(await response.json()).toMatchObject({ message });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    for (const [event, calls] of [
      ["provider_oauth_refresh_failed", warn.mock.calls],
      ["http_request_failed", log.mock.calls],
    ] as const) {
      const line = String(calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event,
        errorName: "SyntaxError",
        errorMessage: message,
        errorStack: expect.stringContaining(message),
      });
      expect(line).not.toContain(secret);
    }
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

test.each([
  "claude",
  "codex",
] as const)("%s code exchange uses content-free JSON parse failures", async (provider) => {
  const started = await startProviderOAuth(database, provider, {}, Date.now());
  try {
    await completeProviderOAuth(
      database,
      provider,
      { state: started.state, code: "fake-code" },
      Date.now()
    );
    throw new Error("Expected token parsing to fail");
  } catch (error) {
    const fields = errorLogFields(error);
    expect(fields.errorMessage).toContain(
      "token response is not valid JSON (HTTP 200, 18 bytes)"
    );
    expect(JSON.stringify(fields)).not.toContain(secret);
  }
});

test("Codex device authorization sanitizes malformed start responses", async () => {
  try {
    await startProviderOAuth(
      database,
      "codex",
      { options: { mode: "headless" } },
      Date.now()
    );
    throw new Error("Expected device parsing to fail");
  } catch (error) {
    const fields = errorLogFields(error);
    expect(fields.errorMessage).toBe(
      "Codex device authorization response is not valid JSON (HTTP 200, 18 bytes)"
    );
    expect(JSON.stringify(fields)).not.toContain(secret);
  }
});

test("Codex device authorization sanitizes malformed successful poll responses", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        device_auth_id: "fake-device",
        user_code: "fake-code",
        interval: 1,
      })
    )) as typeof fetch;
  const started = await startProviderOAuth(
    database,
    "codex",
    { options: { mode: "headless" } },
    Date.now()
  );
  globalThis.fetch = (() =>
    Promise.resolve(new Response(secret))) as typeof fetch;
  try {
    await completeProviderOAuth(
      database,
      "codex",
      { state: started.state },
      Date.now()
    );
    throw new Error("Expected device polling to fail");
  } catch (error) {
    const fields = errorLogFields(error);
    expect(fields.errorMessage).toBe(
      "Codex device token response is not valid JSON (HTTP 200, 18 bytes)"
    );
    expect(JSON.stringify(fields)).not.toContain(secret);
  }
});
