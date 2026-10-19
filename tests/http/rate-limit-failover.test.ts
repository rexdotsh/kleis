import { expect, test } from "bun:test";

// Proxy routes share the application's database module, so these scenarios
// run in their own process with an in-memory database.
test("subscription failover preserves routing boundaries and response accounting", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      "./tests/http/rate-limit-failover.scenarios.ts",
      ...process.argv.filter(
        (arg) => arg === "--randomize" || arg.startsWith("--seed=")
      ),
    ],
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
  expect({
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }).toMatchObject({ exitCode: 0 });
});
