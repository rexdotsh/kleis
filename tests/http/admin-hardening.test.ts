import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const originalFetch = globalThis.fetch;
const databaseDirectory = await mkdtemp(
  join(tmpdir(), "kleis-admin-hardening-")
);
process.env.TURSO_CONNECTION_URL = `file:${join(databaseDirectory, "test.db")}`;

const { db } = await import("../../src/db");
const { default: server } = await import("../../src/index");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "TURSO_CONNECTION_URL");
  } else {
    process.env.TURSO_CONNECTION_URL = originalDatabaseUrl;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});

test("admin page cannot be framed", async () => {
  const response = await server.fetch(
    new Request("http://localhost/admin"),
    {} as Bun.Server<unknown>
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "frame-ancestors 'none'"
  );
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("unexpected server errors do not expose exception details", async () => {
  globalThis.fetch = (() =>
    Promise.reject(new Error("credential-leak-test-sentinel"))) as typeof fetch;
  const response = await server.fetch(
    new Request("http://localhost/api.json"),
    {} as Bun.Server<unknown>
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "internal_error",
    message: "Internal server error",
  });
});
