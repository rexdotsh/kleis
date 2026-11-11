import { isObjectRecord, type JsonObject, withField } from "../../utils/object";
import { CLAUDE_TOOL_PREFIX } from "../constants";

// Claude Code's tool name limit.
const MAX_TOOL_NAME_LENGTH = 64;
const DIGEST_LENGTH = 16;

// Upstream name -> client name for every custom tool name in the request.
export type ClaudeToolNames = ReadonlyMap<string, string>;

// Upstream names carry Claude Code's mcp_ prefix, as in
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L214-L239
// The name alone decides the result, so a tool keeps its upstream name across
// turns. Lowercase-initial names get `mcp_` + an uppercase letter and all
// others `mcp__`, and only digest-suffixed names reach the length limit.
const toUpstreamToolName = (name: string): string => {
  const upstream = /^[a-z]/u.test(name)
    ? `${CLAUDE_TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
    : `${CLAUDE_TOOL_PREFIX}_${name}`;
  if (upstream.length < MAX_TOOL_NAME_LENGTH) {
    return upstream;
  }

  const digest = new Bun.CryptoHasher("sha256")
    .update(name)
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
  return `${upstream.slice(0, MAX_TOOL_NAME_LENGTH - DIGEST_LENGTH - 1)}_${digest}`;
};

// Digest-shortened names can't be inverted and give null.
const fromUpstreamToolName = (upstream: string): string | null => {
  if (!upstream.startsWith(CLAUDE_TOOL_PREFIX)) {
    return null;
  }
  const rest = upstream.slice(CLAUDE_TOOL_PREFIX.length);
  const name = rest.startsWith("_")
    ? rest.slice(1)
    : `${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
  return toUpstreamToolName(name) === upstream ? name : null;
};

// Anthropic-defined tools (web_search, bash, computer, ...) keep their names.
const isFixedNameTool = (tool: JsonObject): boolean =>
  typeof tool.type === "string" && tool.type !== "custom";

const mapList = (value: unknown, map: (item: unknown) => unknown): unknown =>
  Array.isArray(value) ? value.map(map) : value;

const readToolDefinition = (block: unknown): unknown =>
  isObjectRecord(block) &&
  block.type === "tool_addition" &&
  isObjectRecord(block.tool) &&
  block.tool.type === "tool_definition"
    ? block.tool.definition
    : undefined;

// The inline-tools beta defines tools by value inside `tool_addition` blocks.
// https://github.com/earendil-works/pi/blob/4b535d57ea8863dbba44b89872146523da271786/packages/ai/src/api/anthropic-messages.ts#L1381-L1394
// A compaction block's `tool_changes` carries the definitions it summarized
// as Anthropic received them, so with upstream names.
const readInlineTools = (
  messages: unknown
): { inline: unknown[]; compacted: unknown[] } => {
  const inline: unknown[] = [];
  const compacted: unknown[] = [];
  if (!Array.isArray(messages)) {
    return { inline, compacted };
  }
  for (const message of messages) {
    if (!(isObjectRecord(message) && Array.isArray(message.content))) {
      continue;
    }
    for (const block of message.content) {
      const definition = readToolDefinition(block);
      if (definition !== undefined) {
        inline.push(definition);
      } else if (
        isObjectRecord(block) &&
        block.type === "compaction" &&
        Array.isArray(block.tool_changes)
      ) {
        compacted.push(
          ...block.tool_changes
            .map(readToolDefinition)
            .filter((tool) => tool !== undefined)
        );
      }
    }
  }
  return { inline, compacted };
};

export const mapClaudeRequestToolNames = (
  payload: unknown
): { payload: unknown; toolNames: ClaudeToolNames } => {
  const toolNames = new Map<string, string>();
  if (!isObjectRecord(payload)) {
    return { payload, toolNames };
  }

  const tools: unknown[] = Array.isArray(payload.tools) ? payload.tools : [];
  const { inline, compacted } = readInlineTools(payload.messages);
  const fixedNames = new Set<unknown>();
  for (const tool of [...tools, ...inline, ...compacted]) {
    if (isObjectRecord(tool) && isFixedNameTool(tool)) {
      fixedNames.add(tool.name);
    }
  }

  const rename = (record: JsonObject, key: string): JsonObject => {
    const name = record[key];
    if (typeof name !== "string" || fixedNames.has(name)) {
      return record;
    }
    const upstream = toUpstreamToolName(name);
    const existing = toolNames.get(upstream);
    if (existing !== undefined && existing !== name) {
      throw new Error(
        `Tools "${existing}" and "${name}" map to the same upstream name`
      );
    }
    toolNames.set(upstream, name);
    return withField(record, key, upstream);
  };

  const mapTool = (tool: unknown): unknown =>
    isObjectRecord(tool) && !isFixedNameTool(tool)
      ? rename(tool, "name")
      : tool;

  const mapToolResultItem = (item: unknown): unknown =>
    isObjectRecord(item) && item.type === "tool_reference"
      ? rename(item, "tool_name")
      : item;

  // MCP tool and toolset references keep their server-side names.
  const mapToolChange = (block: JsonObject): JsonObject => {
    const { tool } = block;
    if (!isObjectRecord(tool)) {
      return block;
    }
    if (tool.type === "tool_reference") {
      return withField(block, "tool", rename(tool, "name"));
    }
    if (tool.type === "tool_definition") {
      return withField(
        block,
        "tool",
        withField(tool, "definition", mapTool(tool.definition))
      );
    }
    return block;
  };

  const mapBlock = (block: unknown): unknown => {
    if (!isObjectRecord(block)) {
      return block;
    }
    // Toolset members (browser, computer) keep their fixed names.
    if (block.type === "tool_use" && typeof block.toolset_name !== "string") {
      return rename(block, "name");
    }
    if (block.type === "tool_result") {
      return withField(
        block,
        "content",
        mapList(block.content, mapToolResultItem)
      );
    }
    if (block.type === "tool_addition" || block.type === "tool_removal") {
      return mapToolChange(block);
    }
    return block;
  };

  const mapMessage = (message: unknown): unknown =>
    isObjectRecord(message)
      ? withField(message, "content", mapList(message.content, mapBlock))
      : message;

  const toolChoice =
    isObjectRecord(payload.tool_choice) && payload.tool_choice.type === "tool"
      ? rename(payload.tool_choice, "name")
      : payload.tool_choice;

  let mapped = withField(payload, "tools", mapList(payload.tools, mapTool));
  mapped = withField(mapped, "tool_choice", toolChoice);
  mapped = withField(mapped, "messages", mapList(payload.messages, mapMessage));

  // Compaction blocks go upstream unchanged; their tools only need mapping back.
  for (const tool of compacted) {
    if (
      !isObjectRecord(tool) ||
      isFixedNameTool(tool) ||
      typeof tool.name !== "string" ||
      toolNames.has(tool.name)
    ) {
      continue;
    }
    const name = fromUpstreamToolName(tool.name);
    if (name !== null) {
      toolNames.set(tool.name, name);
    }
  }
  return { payload: mapped, toolNames };
};
