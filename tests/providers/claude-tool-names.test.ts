import { describe, expect, test } from "bun:test";

import { createClaudeToolNames } from "../../src/providers/proxies/claude-tool-names";

const mapTools = (names: string[]) => {
  const toolNames = createClaudeToolNames({
    tools: names.map((name) => ({ name })),
  });
  const upstream = names.map((name) => toolNames.toUpstream(name));
  return {
    upstream,
    restored: upstream.map((name) => toolNames.toClient(name)),
  };
};

describe("claude tool names", () => {
  test("gives names that collide after prefixing distinct upstream names", () => {
    const { upstream, restored } = mapTools(["Shell", "shell", "mcp_Shell"]);

    expect(upstream).toEqual(["mcp_Shell_2", "mcp_Shell_3", "mcp_Shell"]);
    expect(restored).toEqual(["Shell", "shell", "mcp_Shell"]);
  });

  test("keeps upstream names within Anthropic's 64 character limit", () => {
    const long = "a".repeat(70);
    const longCapitalized = `A${"a".repeat(69)}`;
    const { upstream, restored } = mapTools([long, longCapitalized]);

    expect(upstream).toEqual([
      `mcp_A${"a".repeat(59)}`,
      `mcp_A${"a".repeat(57)}_2`,
    ]);
    expect(restored).toEqual([long, longCapitalized]);
  });

  test("keeps Anthropic server tool names", () => {
    const toolNames = createClaudeToolNames({
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "custom", name: "browser" },
      ],
    });

    expect(toolNames.toUpstream("web_search")).toBe("web_search");
    expect(toolNames.toUpstream("browser")).toBe("mcp_Browser");
  });

  test("maps tool names used in message history", () => {
    const toolNames = createClaudeToolNames({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-1", name: "read", input: {} }],
        },
      ],
    });

    expect(toolNames.toUpstream("read")).toBe("mcp_Read");
    expect(toolNames.toClient("mcp_Read")).toBe("read");
  });
});
