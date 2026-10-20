import { expect, test } from "bun:test";

import { createTempDatabaseUrl } from "../helpers/temp-database";

// The scenarios use the app's shared database module, so they get a process
// of their own instead of sharing it with the other test files.
test("proxy routes record each request and its tokens once", () => {
  const database = createTempDatabaseUrl();
  const result = Bun.spawnSync(
    [process.execPath, "test", "./tests/http/proxy-usage.scenarios.ts"],
    {
      env: {
        ...process.env,
        TURSO_CONNECTION_URL: database.url,
        TURSO_AUTH_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  database.remove();
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
});
