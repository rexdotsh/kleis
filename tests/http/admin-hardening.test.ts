import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const databaseDirectory = await mkdtemp(
  join(tmpdir(), "kleis-admin-hardening-")
);
process.env.TURSO_CONNECTION_URL = `file:${join(databaseDirectory, "test.db")}`;

const { db } = await import("../../src/db");
const { default: server } = await import("../../src/index");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

afterAll(async () => {
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
  expect(response.headers.get("Cache-Control")).toBe("no-cache");
});

test("admin assets revalidate with an ETag and fonts are immutable", async () => {
  const fetchAdmin = (path: string, headers: HeadersInit = {}) =>
    server.fetch(
      new Request(`http://localhost${path}`, { headers }),
      {} as Bun.Server<unknown>
    );

  const first = await fetchAdmin("/admin/app.js");
  const etag = first.headers.get("ETag");
  expect(first.status).toBe(200);
  expect(first.headers.get("Content-Type")).toContain("text/javascript");
  expect(etag).toBeTruthy();

  const revalidated = await fetchAdmin("/admin/app.js", {
    "If-None-Match": etag ?? "",
  });
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe("");

  const index = await fetchAdmin("/admin", {
    "If-None-Match": (await fetchAdmin("/admin")).headers.get("ETag") ?? "",
  });
  expect(index.status).toBe(304);
  expect(index.headers.get("X-Frame-Options")).toBe("DENY");

  const font = await fetchAdmin("/admin/fonts/geist-latin.v1.woff2");
  expect(font.status).toBe(200);
  expect(font.headers.get("Content-Type")).toBe("font/woff2");
  expect(font.headers.get("Cache-Control")).toContain("immutable");
});
