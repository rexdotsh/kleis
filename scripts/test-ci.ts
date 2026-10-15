const slowSuite = "./tests/db/provider-accounts.test.ts";
const testFiles = Array.from(
  new Bun.Glob("**/*{.test,.spec,_test,_spec}.{ts,tsx,js,jsx}").scanSync(
    "tests"
  )
)
  .map((file) => `./tests/${file}`)
  .sort();

if (!testFiles.includes(slowSuite)) {
  throw new Error(`Missing slow test suite: ${slowSuite}`);
}

// Process isolation keeps mocks and shared modules private to each suite.
const suites = [[slowSuite], testFiles.filter((file) => file !== slowSuite)];
const results = await Promise.all(
  suites.map(async (files) => {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "test", ...files], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    console.info(
      `${files.length} test files: ${((performance.now() - started) / 1000).toFixed(2)}s (exit ${exitCode})`
    );
    return exitCode;
  })
);

process.exit(results.some((code) => code !== 0) ? 1 : 0);
