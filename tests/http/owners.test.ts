import { expect, test } from "bun:test";

import { createTempDatabaseUrl } from "../helpers/temp-database";

// The scenarios use the app's shared database module, so they get a process
// of their own instead of sharing it with the other test files.
test("owner APIs stay limited to delegate keys and to each owner", () => {
  const database = createTempDatabaseUrl();
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/owners.scenarios.ts"],
    {
      env: {
        ...process.env,
        TURSO_CONNECTION_URL: database.url,
        TURSO_AUTH_TOKEN: "",
        CODEX_WEBSOCKET_ENABLED: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  database.remove();
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
});
