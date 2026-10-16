import { expect, test } from "bun:test";

// The upgrade needs its own pre-migration schema, isolated from shared-memory suites.
test("generated migrations upgrade a populated Codex ledger safely", () => {
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/db/codex-reset-migration.scenarios.ts"],
    {
      env: {
        ...process.env,
        TURSO_CONNECTION_URL: ":memory:",
        TURSO_AUTH_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
});
