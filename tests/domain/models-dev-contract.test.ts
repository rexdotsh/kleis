import { describe, expect, test } from "bun:test";

import { buildProxyModelsRegistry } from "../../src/domain/models/models-dev";

const upstreamRegistry = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5.3-codex": {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        provider: {
          api: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai",
        },
      },
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        provider: {
          api: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai",
        },
      },
      "text-embedding-3-large": {
        id: "text-embedding-3-large",
        name: "text-embedding-3-large",
        provider: {
          api: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai",
        },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4": {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: {
          api: "https://api.anthropic.com/v1",
          npm: "@ai-sdk/anthropic",
        },
      },
    },
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    env: ["GITHUB_TOKEN"],
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        provider: {
          api: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      },
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        provider: {
          api: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      },
    },
  },
} as const;

describe("models registry contract", () => {
  test("patches canonical provider entries for proxy usage", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/",
      configuredProviders: ["codex", "claude", "copilot"],
    });

    const copilot = registry["github-copilot"] as {
      env?: string[];
      models?: Record<string, { id?: string; provider?: { api?: string } }>;
    };
    expect(copilot.env).toEqual(["KLEIS_API_KEY"]);
    expect(copilot.models?.["gpt-5"]?.id).toBe("gpt-5");
    expect(copilot.models?.["gpt-5"]?.provider?.api).toBe(
      "https://kleis.example/copilot/v1"
    );

    const openai = registry.openai as {
      env?: string[];
      models?: Record<string, { provider?: { api?: string } }>;
    };
    expect(openai.env).toEqual(["KLEIS_API_KEY"]);
    expect(openai.models?.["gpt-5.3-codex"]?.provider?.api).toBe(
      "https://kleis.example/openai/v1"
    );
    expect(openai.models?.["gpt-5"]).toBeUndefined();
    expect(openai.models?.["text-embedding-3-large"]).toBeUndefined();
  });

  test("keeps kleis aggregate provider with prefixed ids", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/",
      configuredProviders: ["codex", "claude", "copilot"],
    });

    const kleis = registry.kleis as {
      env?: string[];
      models?: Record<string, { id?: string; provider?: { api?: string } }>;
    };
    expect(kleis.env).toEqual(["KLEIS_API_KEY"]);
    expect(kleis.models?.["github-copilot/gpt-5"]?.id).toBe(
      "github-copilot/gpt-5"
    );
    expect(kleis.models?.["github-copilot/gpt-5"]?.provider?.api).toBe(
      "https://kleis.example/copilot/v1"
    );
    expect(kleis.models?.["openai/text-embedding-3-large"]).toBeUndefined();
  });

  test("preserves unconfigured providers from upstream unchanged", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/",
      configuredProviders: ["codex"],
    });

    const anthropic = registry.anthropic as {
      env?: string[];
      models?: Record<string, { provider?: { api?: string } }>;
    };
    expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(anthropic.models?.["claude-sonnet-4"]?.provider?.api).toBe(
      "https://api.anthropic.com/v1"
    );

    const copilot = registry["github-copilot"] as {
      env?: string[];
      models?: Record<string, { provider?: { api?: string } }>;
    };
    expect(copilot.env).toEqual(["GITHUB_TOKEN"]);
    expect(copilot.models?.["gpt-5"]?.provider?.api).toBe(
      "https://api.githubcopilot.com"
    );

    const openai = registry.openai as {
      env?: string[];
      models?: Record<string, { id?: string }>;
    };
    expect(openai.env).toEqual(["KLEIS_API_KEY"]);
    expect(openai.models?.["gpt-5.3-codex"]?.id).toBe("gpt-5.3-codex");

    const kleis = registry.kleis as {
      models?: Record<string, { id?: string }>;
    };
    expect(kleis.models?.["openai/gpt-5.3-codex"]?.id).toBe(
      "openai/gpt-5.3-codex"
    );
    expect(kleis.models?.["anthropic/claude-sonnet-4"]).toBeUndefined();
    expect(kleis.models?.["github-copilot/gpt-5"]).toBeUndefined();
  });

  test("preserves all upstream providers when none are configured", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/",
      configuredProviders: [],
    });

    const openai = registry.openai as {
      env?: string[];
      models?: Record<string, unknown>;
    };
    expect(openai.env).toEqual(["OPENAI_API_KEY"]);
    expect(Object.keys(openai.models ?? {})).toHaveLength(3);

    expect(registry.anthropic).toBeDefined();
    expect(registry["github-copilot"]).toBeDefined();

    const kleis = registry.kleis as {
      env?: string[];
      models?: Record<string, unknown>;
    };
    expect(kleis.env).toEqual(["KLEIS_API_KEY"]);
    expect(Object.keys(kleis.models ?? {})).toHaveLength(0);
  });

  test("applies api key provider and model scopes", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/api/kmd_abc123",
      configuredProviders: ["codex", "claude", "copilot"],
      apiKeyScopes: {
        providerScopes: ["codex", "copilot"],
        modelScopes: ["openai/gpt-5.3-codex", "gpt-5-mini"],
      },
    });

    expect(Object.keys(registry).sort()).toEqual([
      "github-copilot",
      "kleis",
      "openai",
    ]);

    const openai = registry.openai as {
      models?: Record<string, { id?: string }>;
    };
    expect(Object.keys(openai.models ?? {})).toEqual(["gpt-5.3-codex"]);

    const copilot = registry["github-copilot"] as {
      models?: Record<string, { id?: string }>;
    };
    expect(Object.keys(copilot.models ?? {})).toEqual(["gpt-5-mini"]);

    const kleis = registry.kleis as {
      models?: Record<string, { id?: string }>;
    };
    expect(Object.keys(kleis.models ?? {}).sort()).toEqual([
      "github-copilot/gpt-5-mini",
      "openai/gpt-5.3-codex",
    ]);
  });

  test("scoped mode omits non-proxy upstream providers", () => {
    const registry = buildProxyModelsRegistry({
      upstreamRegistry: upstreamRegistry as unknown as Record<string, unknown>,
      baseOrigin: "https://kleis.example/api/kmd_xyz789",
      configuredProviders: ["codex"],
      apiKeyScopes: {
        providerScopes: ["codex"],
        modelScopes: null,
      },
    });

    expect(registry.anthropic).toBeUndefined();
    expect(registry["github-copilot"]).toBeUndefined();

    const kleis = registry.kleis as {
      models?: Record<string, unknown>;
    };
    expect(Object.keys(kleis.models ?? {})).toEqual(["openai/gpt-5.3-codex"]);
  });
});
