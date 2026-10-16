import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployScript = new URL("../../scripts/deploy-release.sh", import.meta.url)
  .pathname;
const command = `#!/usr/bin/env bash
set -euo pipefail
case "\${0##*/}" in
  docker)
    if [[ "$*" == *"--exit-code-from migrate"* && "$FAILURE" == migration ]]; then exit 17; fi
    if [[ "$*" == "inspect -f {{.State.Running}} kleis-blue" ]]; then echo true; fi
    ;;
  curl)
    if [[ "$*" == *":3004/healthz"* && "$FAILURE" == health ]]; then exit 1; fi
    ;;
esac
`;

test.each(["migration", "health"])(
  "a failed %s leaves the active deployment slot unchanged",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "kleis-deploy-test-"));
    try {
      await writeFile(join(directory, "active-slot"), "blue\n");
      for (const name of ["docker", "curl", "sleep", "setsid"]) {
        await writeFile(join(directory, name), command, { mode: 0o755 });
      }
      const child = Bun.spawn(["bash", deployScript], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          KLEIS_APP_IMAGE: "example.test/kleis:test",
          KLEIS_MIGRATE_IMAGE: "example.test/kleis-migrate:test",
          FAILURE: failure,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toMatchObject({
        exitCode: failure === "migration" ? 17 : 1,
      });
      expect(await readFile(join(directory, "active-slot"), "utf8")).toBe(
        "blue\n"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
