import { expect, test } from "bun:test";

test("rate-limit failover route scenarios", () => {
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/rate-limit-failover.scenarios.ts"],
    {
      env: {
        ...process.env,
        TURSO_CONNECTION_URL: ":memory:",
        TURSO_AUTH_TOKEN: "",
        CODEX_WEBSOCKET_ENABLED: "false",
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
