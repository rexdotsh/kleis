import { expect, spyOn, test } from "bun:test";

test("a Bun version split across tarball chunks is read whole", async () => {
  const binary = new TextEncoder().encode(
    `${"x".repeat(1000)}Bun v1.4.14 (Linux x64)${"y".repeat(1000)}`
  );
  // Stored deflate blocks decompress exactly up to where the input stops,
  // so this split ends the first chunk at "Bun v1.4.1".
  const tarball = Bun.gzipSync(binary, { level: 0 });
  const split = 10 + 5 + 1000 + 10;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/@anthropic-ai/claude-code/latest")) {
      return Response.json({ version: "9.9.9" });
    }
    if (url.endsWith("/@anthropic-ai/claude-code-linux-x64/9.9.9")) {
      return Response.json({ dist: { tarball: "https://fake.test/cc.tgz" } });
    }
    if (url === "https://fake.test/cc.tgz") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(tarball.slice(0, split));
            controller.enqueue(tarball.slice(split));
            controller.close();
          },
        })
      );
    }
    if (url.startsWith("https://api.github.com/repos/fake/repo/issues?")) {
      return Response.json([]);
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  const info = spyOn(console, "info").mockImplementation(() => undefined);
  const repository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "fake/repo";
  process.argv.push("--dry-run");
  try {
    await import("../../scripts/check-claude-code-version");
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      bun: { latest: "1.4.14" },
    });
  } finally {
    process.argv.pop();
    if (repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = repository;
    info.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
