import { expect, test } from "bun:test";

// Admin routes import the shared database, so the scenarios need a private process.
test("admin spending, rotation and credential boundaries hold at the HTTP entry points", () => {
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/admin-server-guards.scenarios.ts"],
    {
      env: {
        ...process.env,
        TURSO_CONNECTION_URL: "file::memory:?cache=shared",
        TURSO_AUTH_TOKEN: "",
        ADMIN_TOKEN: "fake-owner-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
});
