import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DeployJob = {
  concurrency: {
    group: string;
    "cancel-in-progress": boolean;
    queue?: "single" | "max";
  };
  needs: string[];
  steps: {
    id?: string;
    name: string;
    run?: string;
    if?: string;
  }[];
};

const workflow = Bun.YAML.parse(
  await Bun.file(
    new URL("../../.github/workflows/deploy.yml", import.meta.url)
  ).text()
) as { jobs: { deploy: DeployJob } };
const deploy = workflow.jobs.deploy;
const guard = deploy.steps.find((step) => step.id === "revision")?.run;
if (!guard) {
  throw new Error("Missing in-lock deployment revision guard");
}

async function checkRevision(revision: string, main: string, gitExit = 0) {
  const directory = await mkdtemp(join(tmpdir(), "kleis-revision-test-"));
  try {
    await writeFile(
      join(directory, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$MOCK_GIT_EXIT" != 0 ]; then exit "$MOCK_GIT_EXIT"; fi
printf '%s\\trefs/heads/main\\n' "$MOCK_MAIN_SHA"
`,
      { mode: 0o755 }
    );
    const output = Bun.file(join(directory, "output"));
    await output.write("");
    const child = Bun.spawn(["bash", "-c", guard], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_SHA: revision,
        GITHUB_OUTPUT: output.name,
        MOCK_MAIN_SHA: main,
        MOCK_GIT_EXIT: String(gitExit),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      output: await output.text(),
      logs: `${stdout}${stderr}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function finishDeployments(
  arrivals: readonly string[],
  queue = deploy.concurrency.queue ?? "single"
) {
  // Model GitHub's documented pending queue while A holds the deploy lock.
  const pending: string[] = [];
  const cancelled: string[] = [];
  for (const revision of arrivals) {
    if (queue === "single") {
      cancelled.push(...pending.splice(0));
    }
    pending.push(revision);
  }

  let deployed = "A";
  const skipped: string[] = [];
  for (const revision of pending) {
    const result = await checkRevision(revision, "C");
    expect(result.exitCode).toBe(0);
    if (result.output === "deploy=true\n") {
      deployed = revision;
    } else {
      expect(result.output).toBe("deploy=false\n");
      skipped.push(revision);
    }
  }
  return { deployed, skipped, cancelled };
}

test("production serializes a non-replacing deployment queue behind both checks", () => {
  expect(deploy.concurrency).toEqual({
    group: "production-deploy",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(deploy.needs).toEqual(["verify", "publish"]);
  for (const name of [
    "Promote verified images",
    "Configure SSH",
    "Deploy release",
  ]) {
    const index = deploy.steps.findIndex((step) => step.name === name);
    expect(index).toBeGreaterThan(
      deploy.steps.findIndex((step) => step.id === "revision")
    );
    expect(deploy.steps[index]?.if).toBe(
      "steps.revision.outputs.deploy == 'true'"
    );
  }
});

test.each([
  ["C", "B"],
  ["B", "C"],
])(
  "A is running; %s then %s queue without losing newest C",
  async (first, second) => {
    expect(await finishDeployments([first, second])).toEqual({
      deployed: "C",
      skipped: ["B"],
      cancelled: [],
    });
  }
);

test("a single pending slot reproduces C being cancelled by slower B", async () => {
  expect(await finishDeployments(["C", "B"], "single")).toEqual({
    deployed: "A",
    skipped: ["B"],
    cancelled: ["C"],
  });
});

test("a failed main lookup cannot enable deployment", async () => {
  const result = await checkRevision("C", "C", 17);
  expect(result.exitCode).toBe(17);
  expect(result.output).toBe("");
});
