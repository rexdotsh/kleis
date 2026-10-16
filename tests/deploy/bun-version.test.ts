import { expect, test } from "bun:test";
import manifest from "../../package.json";

const version = manifest.packageManager.replace(/^bun@/, "");

test("development, CI, Docker, and types use the exact packageManager version", async () => {
  expect(manifest.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  expect(Bun.version).toBe(version);
  expect(manifest.devDependencies["@types/bun"]).toBe(version);

  const dockerfile = await Bun.file(
    new URL("../../Dockerfile", import.meta.url)
  ).text();
  expect(dockerfile.match(/^FROM oven\/bun:(\S+) AS base$/m)?.[1]).toBe(
    version
  );

  const workflow = Bun.YAML.parse(
    await Bun.file(
      new URL("../../.github/workflows/deploy.yml", import.meta.url)
    ).text()
  ) as {
    jobs: Record<
      string,
      { steps: { uses?: string; with?: Record<string, string> }[] }
    >;
  };
  const setupSteps = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
  );
  expect(setupSteps.length).toBeGreaterThan(0);
  for (const step of setupSteps) {
    expect(step.with?.["bun-version-file"]).toBe("package.json");
    expect(step.with?.["bun-version"]).toBeUndefined();
  }
});
