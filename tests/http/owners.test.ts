import { expect, test } from "bun:test";

// The scenarios use the app's shared database module, so they get a process
// of their own instead of sharing it with the other test files.
test("owner APIs stay limited to delegate keys and to each owner", () => {
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/owners.scenarios.ts"],
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
