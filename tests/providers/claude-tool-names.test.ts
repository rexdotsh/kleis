import { describe, expect, test } from "bun:test";

import {
  mapClaudeRequestToolNames,
  toUpstreamToolName,
} from "../../src/providers/proxies/claude-tool-names";

const tool = (name: string) => ({ name, input_schema: { type: "object" } });

const mapRequest = (payload: unknown) => {
  const { payload: mapped, toolNames } = mapClaudeRequestToolNames(payload);
  return { mapped: mapped as Record<string, any>, toolNames };
};

describe("claude tool names", () => {
  test("maps names without depending on the other tools", () => {
    expect(toUpstreamToolName("shell")).toBe("mcp_Shell");
    expect(toUpstreamToolName("Shell")).toBe("mcp__Shell");
    expect(toUpstreamToolName("mcp_Shell")).toBe("mcp_Mcp_Shell");
    expect(toUpstreamToolName("mcp_shell")).toBe("mcp_Mcp_shell");
    expect(toUpstreamToolName("_x")).toBe("mcp___x");
    expect(toUpstreamToolName("1x")).toBe("mcp__1x");

    const alone = mapRequest({ tools: [tool("shell")] }).mapped;
    const crowded = mapRequest({
      tools: [tool("mcp_Shell"), tool("Shell"), tool("shell")],
    }).mapped;
    expect(alone.tools[0].name).toBe("mcp_Shell");
    expect(crowded.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "mcp_Mcp_Shell",
      "mcp__Shell",
      "mcp_Shell",
    ]);
  });

  test("gives distinct names that round-trip", () => {
    const names = [
      "shell",
      "Shell",
      "mcp_Shell",
      "mcp_shell",
      "_Shell",
      "a".repeat(59),
      "a".repeat(60),
      "a".repeat(70),
      `${"a".repeat(70)}b`,
      `mcp_${"x".repeat(70)}`,
    ];
    const { toolNames } = mapRequest({ tools: names.map(tool) });
    const upstream = names.map(toUpstreamToolName);

    expect(new Set(upstream).size).toBe(names.length);
    expect(upstream.map((name) => toolNames.get(name))).toEqual(names);
  });

  test("keeps upstream names under 64 characters unless digest-suffixed", () => {
    expect(toUpstreamToolName("a".repeat(59))).toBe(`mcp_A${"a".repeat(58)}`);
    for (const name of [
      "a".repeat(60),
      "A".repeat(200),
      `mcp_${"x".repeat(70)}`,
    ]) {
      const upstream = toUpstreamToolName(name);
      expect(upstream).toHaveLength(64);
      expect(upstream).toMatch(/_[0-9a-f]{8}$/u);
    }
  });

  test("keeps Anthropic-defined tools and toolset members", () => {
    const { mapped, toolNames } = mapRequest({
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
        { type: "custom", name: "browser" },
      ],
      tool_choice: { type: "tool", name: "bash" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t-1", name: "bash", input: {} },
            {
              type: "tool_use",
              id: "t-2",
              toolset_name: "browser",
              name: "navigate",
              input: {},
            },
          ],
        },
      ],
    });

    expect(mapped.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "web_search",
      "bash",
      "mcp_Browser",
    ]);
    expect(mapped.tool_choice.name).toBe("bash");
    expect(
      mapped.messages[0].content.map((block: { name: string }) => block.name)
    ).toEqual(["bash", "navigate"]);
    expect([...toolNames]).toEqual([["mcp_Browser", "browser"]]);
  });

  test("maps history tool_use and tool_reference in tool results", () => {
    const { mapped, toolNames } = mapRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-1", name: "search", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t-1",
              content: [{ type: "tool_reference", tool_name: "read" }],
            },
          ],
        },
      ],
    });

    expect(mapped.messages[0].content[0].name).toBe("mcp_Search");
    expect(mapped.messages[1].content[0].content[0].tool_name).toBe("mcp_Read");
    expect(toolNames.get("mcp_Read")).toBe("read");
  });
});
