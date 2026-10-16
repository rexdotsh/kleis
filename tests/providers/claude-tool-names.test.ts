import { expect, spyOn, test } from "bun:test";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";

const prepare = (bodyJson: unknown) =>
  prepareClaudeProxyRequest({
    requestUrl: new URL("https://kleis.test/anthropic/v1/messages"),
    headers: new Headers(),
    bodyText: JSON.stringify(bodyJson),
    bodyJson,
    accessToken: "fake-token",
    metadata: null,
  });

test("case, prefix and length collisions stay distinct and round-trip through JSON and SSE", async () => {
  const names = [
    "shell",
    "Shell",
    "mcp_Shell",
    "_Shell",
    "a".repeat(59),
    "a".repeat(60),
    "a".repeat(70),
    `${"a".repeat(70)}b`,
  ];
  const request = prepare({
    tools: names.map((name) => ({ name, input_schema: { type: "object" } })),
  });
  const upstream = (
    JSON.parse(request.bodyText) as { tools: { name: string }[] }
  ).tools.map((tool) => tool.name);
  expect(new Set(upstream).size).toBe(names.length);
  expect(upstream.every((name) => name.length <= 64)).toBe(true);
  const content = upstream.map((name) => ({
    type: "tool_use",
    id: name,
    name,
    input: {},
  }));
  const json = await request.transformResponse(
    Response.json({ type: "message", content })
  );
  expect(
    ((await json.json()) as { content: { name: string }[] }).content.map(
      (block) => block.name
    )
  ).toEqual(names);
  const sse = await request.transformResponse(
    new Response(
      content
        .map(
          (content_block) =>
            `data: ${JSON.stringify({ type: "content_block_start", content_block })}\n\n`
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } }
    )
  );
  const restored = (await sse.text())
    .trim()
    .split("\n\n")
    .map(
      (event) =>
        (JSON.parse(event.slice(6)) as { content_block: { name: string } })
          .content_block.name
    );
  expect(restored).toEqual(names);
});

test("refuses ambiguous shortened tool names before forwarding a request", () => {
  const digest = spyOn(Bun.CryptoHasher.prototype, "digest").mockReturnValue(
    "0".repeat(64)
  );
  try {
    expect(() =>
      prepare({ tools: [{ name: "a".repeat(70) }, { name: "a".repeat(71) }] })
    ).toThrow("map to the same upstream name");
  } finally {
    digest.mockRestore();
  }
});
