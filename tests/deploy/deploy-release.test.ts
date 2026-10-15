import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployScript = new URL("../../scripts/deploy-release.sh", import.meta.url)
  .pathname;

const mockCommand = `#!/usr/bin/env bash
set -euo pipefail
command="\${0##*/}"
printf '%s %s\\n' "$command" "$*" >> "$MOCK_DIRECTORY/commands"
case "$command" in
  docker)
    case "$*" in
      "inspect -f {{.State.Running}} kleis-blue") echo true ;;
      "inspect -f {{.State.Running}} kleis-green") echo "$MOCK_REUSE_TARGET" ;;
      "compose -f docker-compose.deploy.yml up --no-deps --force-recreate --exit-code-from migrate migrate")
        exit "$MOCK_MIGRATE_EXIT" ;;
      "compose -f docker-compose.deploy.yml up -d --no-deps app-green")
        touch "$MOCK_DIRECTORY/started" ;;
    esac
    ;;
  curl)
    if [[ "$*" == *":3004/healthz"* ]]; then
      [[ -f "$MOCK_DIRECTORY/started" && "$MOCK_UNHEALTHY" == false ]]
    fi
    ;;
esac
`;

async function deploy(env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kleis-deploy-test-"));
  try {
    await writeFile(join(directory, "active-slot"), "blue\n");
    for (const command of ["docker", "curl", "sleep", "setsid"]) {
      await writeFile(join(directory, command), mockCommand, { mode: 0o755 });
    }
    const child = Bun.spawn(["bash", deployScript], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        KLEIS_APP_IMAGE: "example.test/kleis:sha-test",
        KLEIS_MIGRATE_IMAGE: "example.test/kleis-migrate:inputs-test",
        MOCK_DIRECTORY: directory,
        MOCK_MIGRATE_EXIT: "0",
        MOCK_UNHEALTHY: "false",
        MOCK_REUSE_TARGET: "false",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (stdout.includes("Draining kleis-blue in the background")) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const commands = await readFile(join(directory, "commands"), "utf8");
        if (commands.includes("setsid nohup docker stop -t 900 kleis-blue")) {
          break;
        }
        await Bun.sleep(5);
      }
    }
    return {
      exitCode,
      output: `${stdout}${stderr}`,
      commands: await readFile(join(directory, "commands"), "utf8"),
      slot: await readFile(join(directory, "active-slot"), "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("deploy retains the migration container and launches the old slot drain after readiness", async () => {
  const result = await deploy();
  expect(result.exitCode).toBe(0);
  expect(result.slot).toBe("green\n");
  expect(result.commands).toContain(
    "up --no-deps --force-recreate --exit-code-from migrate migrate"
  );
  expect(result.commands).not.toContain("run --rm");
  expect(result.commands.indexOf("--exit-code-from migrate")).toBeLessThan(
    result.commands.indexOf("up -d --no-deps app-green")
  );
  expect(result.commands).toContain(
    "setsid nohup docker stop -t 900 kleis-blue"
  );
  expect(result.commands).not.toContain("\ndocker stop -t 900 kleis-blue");
  expect(result.output).toContain("New slot healthy");
  expect(result.output).toContain("Release live on green");
});

test("failed migrations block slot startup, switching, and pruning", async () => {
  const result = await deploy({ MOCK_MIGRATE_EXIT: "17" });
  expect(result.exitCode).toBe(17);
  expect(result.slot).toBe("blue\n");
  expect(result.commands).not.toContain("up -d");
  expect(result.commands).not.toContain("docker stop");
  expect(result.commands).not.toContain("image prune");
});

test("an unhealthy release leaves the active slot serving", async () => {
  const result = await deploy({ MOCK_UNHEALTHY: "true" });
  expect(result.exitCode).toBe(1);
  expect(result.slot).toBe("blue\n");
  expect(result.output).toContain("New release never became healthy");
  expect(result.commands).not.toContain("stop -t 900 kleis-blue");
  expect(result.commands).not.toContain("image prune");
});

test("a draining target is stopped with the full grace period before reuse", async () => {
  const result = await deploy({ MOCK_REUSE_TARGET: "true" });
  expect(result.exitCode).toBe(0);
  expect(result.commands).toContain("docker stop -t 900 kleis-green");
  expect(
    result.commands.indexOf("docker stop -t 900 kleis-green")
  ).toBeLessThan(result.commands.indexOf("up -d --no-deps app-green"));
  expect(result.output).toContain("kleis-green ready for reuse");
});
