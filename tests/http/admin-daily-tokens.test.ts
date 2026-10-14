import { expect, test } from "bun:test";

// Bun shares the db module between test files; if this file loads it first,
// give it a database that is never deleted.
process.env.TURSO_CONNECTION_URL ||= ":memory:";
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");

// Validation rejects these before any database access. Data and ordering are
// covered by tests/db/account-daily-tokens.test.ts; admin auth by
// tests/http/admin-hardening.test.ts.
test("daily tokens validate their query", async () => {
  for (const path of [
    "/daily-tokens?days=0",
    "/daily-tokens?days=91",
    "/daily-tokens?days=abc",
    "/daily-tokens?ids=,",
    "/daily-tokens?provider=gemini",
    "/daily-tokens?unknown=1",
    "/claude-a/daily-tokens?days=1.5",
    "/claude-a/daily-tokens?ids=claude-a",
  ]) {
    const response = await adminAccountsRoutes.request(
      `http://localhost${path}`
    );
    expect({ path, status: response.status }).toEqual({ path, status: 400 });
  }
});
