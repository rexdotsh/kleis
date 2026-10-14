import { isObjectRecord, type JsonObject } from "../../utils/object";
import { CLAUDE_TOOL_PREFIX } from "../constants";

// Anthropic custom tool names must match ^[a-zA-Z0-9_-]{1,64}$.
const MAX_TOOL_NAME_LENGTH = 64;

export type ClaudeToolNames = {
  toUpstream(name: string): string;
  toClient(name: string): string;
};

const fromClaudeToolName = (name: string): string => {
  if (!name.startsWith(CLAUDE_TOOL_PREFIX)) {
    return name;
  }

  const rest = name.slice(CLAUDE_TOOL_PREFIX.length);
  return `${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
};

// Server tools such as `web_search_20250305` declare a versioned type and must
// keep their documented names, as must names the client already prefixed.
const readRequestToolNames = (
  payload: JsonObject
): { kept: string[]; renamed: string[] } => {
  const kept: string[] = [];
  const renamed: string[] = [];
  const add = (name: string, isServerTool: boolean): void => {
    const list =
      isServerTool || name.startsWith(CLAUDE_TOOL_PREFIX) ? kept : renamed;
    list.push(name);
  };

  const tools: unknown[] = Array.isArray(payload.tools) ? payload.tools : [];
  for (const tool of tools) {
    if (isObjectRecord(tool) && typeof tool.name === "string") {
      add(tool.name, typeof tool.type === "string" && tool.type !== "custom");
    }
  }

  const messages: unknown[] = Array.isArray(payload.messages)
    ? payload.messages
    : [];
  for (const message of messages) {
    if (!(isObjectRecord(message) && Array.isArray(message.content))) {
      continue;
    }
    for (const block of message.content) {
      if (
        isObjectRecord(block) &&
        block.type === "tool_use" &&
        typeof block.name === "string"
      ) {
        add(block.name, false);
      }
    }
  }

  return { kept, renamed };
};

const allocateUpstreamName = (
  name: string,
  taken: ReadonlyMap<string, string>
): string => {
  const base =
    `${CLAUDE_TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`.slice(
      0,
      MAX_TOOL_NAME_LENGTH
    );
  let candidate = base;
  for (let index = 2; taken.has(candidate); index++) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
  }
  return candidate;
};

// Request: prefix tool names so they match Claude Code's expected format.
// Response: map names back so the client sees its original names.
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L214-L239
// https://github.com/anomalyco/opencode-anthropic-auth/blob/d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd/index.mjs#L276-L294
// pi-mono uses case-normalized Claude Code tool names instead of a prefix:
// https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/anthropic.ts#L64-L93
// Kept names are reserved first, so `Shell`, `shell` and `mcp_Shell` in one
// request get distinct upstream names.
export const createClaudeToolNames = (payload: unknown): ClaudeToolNames => {
  const upstreamNames = new Map<string, string>();
  const clientNames = new Map<string, string>();
  const assign = (name: string, upstream: string): void => {
    upstreamNames.set(name, upstream);
    clientNames.set(upstream, name);
  };

  if (isObjectRecord(payload)) {
    const { kept, renamed } = readRequestToolNames(payload);
    for (const name of kept) {
      assign(name, name);
    }
    for (const name of renamed) {
      if (!upstreamNames.has(name)) {
        assign(name, allocateUpstreamName(name, clientNames));
      }
    }
  }

  return {
    toUpstream: (name) => upstreamNames.get(name) ?? name,
    toClient: (name) => clientNames.get(name) ?? fromClaudeToolName(name),
  };
};
