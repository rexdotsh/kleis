import { expect, test } from "bun:test";

// The routes import a shared database module, so they need a separate process.
test("Claude reset admin routes reject untrusted claims before dispatch", () => {
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/admin-claude-resets.scenarios.ts"],
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
