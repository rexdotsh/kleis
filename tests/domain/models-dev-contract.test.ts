import { expect, test } from "bun:test";
import { buildProxyModelsRegistry } from "../../src/domain/models/models-dev";
import {
  parseModelForProxyRoute,
  resolveProxyRoute,
} from "../../src/http/proxy-routing";

const upstreamRegistry = {
  openai: { models: { "gpt-99-test": { id: "gpt-99-test" } } },
  anthropic: { models: { "claude-test": { id: "claude-test" } } },
};
const build = (
  options: Partial<Parameters<typeof buildProxyModelsRegistry>[0]> = {}
) =>
  buildProxyModelsRegistry({
    upstreamRegistry,
    baseOrigin: "https://kleis.example/",
    configuredProviders: ["codex", "claude"],
    ...options,
  });
const models = (registry: Record<string, unknown>) =>
  (
    registry.kleis as {
      models: Record<string, { id: string; provider: { api: string } }>;
    }
  ).models;

test("advertised aggregate models route to the configured proxy without mutating upstream", () => {
  const original = structuredClone(upstreamRegistry);
  const registry = build();
  for (const [id, model] of Object.entries(models(registry))) {
    const suffix = id.startsWith("anthropic/") ? "/messages" : "/responses";
    const route = resolveProxyRoute(
      new URL(`${model.provider.api}${suffix}`).pathname
    );
    if (!route) throw new Error(`Unroutable advertised model: ${id}`);
    expect(model.id).toBe(id);
    expect(parseModelForProxyRoute(id, route).upstreamModel).toBe(
      id.startsWith("anthropic/") ? "claude-test" : "gpt-99-test"
    );
  }
  expect(Object.keys(models(registry))).toHaveLength(2);
  expect(registry.openai).toEqual(original.openai);
  expect(registry.anthropic).toEqual(original.anthropic);
  expect(upstreamRegistry).toEqual(original);
});

test.each([
  {
    configuredProviders: [] as ("codex" | "claude")[],
    providerScopes: null,
    modelScopes: null,
    expected: [],
  },
  {
    configuredProviders: ["codex"] as const,
    providerScopes: null,
    modelScopes: null,
    expected: ["gpt-99-test"],
  },
  {
    configuredProviders: ["codex", "claude"] as const,
    providerScopes: ["claude"],
    modelScopes: null,
    expected: ["anthropic/claude-test"],
  },
  {
    configuredProviders: ["codex", "claude"] as const,
    providerScopes: null,
    modelScopes: ["openai/gpt-99-test"],
    expected: ["gpt-99-test"],
  },
  {
    configuredProviders: ["codex", "claude"] as const,
    providerScopes: ["claude"],
    modelScopes: ["openai/claude-test"],
    expected: [],
  },
])(
  "discovery respects configuration and key scopes: %j",
  ({ configuredProviders, providerScopes, modelScopes, expected }) => {
    const registry = build({
      configuredProviders,
      apiKeyScopes: { providerScopes, modelScopes },
    });
    expect(Object.keys(models(registry))).toEqual(expected);
    expect(registry.openai).toEqual(upstreamRegistry.openai);
    expect(registry.anthropic).toEqual(upstreamRegistry.anthropic);
  }
);

test("preserves existing aggregate models when appending proxy models", () => {
  const existing = {
    id: "gpt-99-test",
    provider: { api: "https://keep.example/v1" },
  };
  const registry = build({
    upstreamRegistry: {
      ...upstreamRegistry,
      kleis: { models: { "gpt-99-test": existing } },
    },
  });
  expect(models(registry)["gpt-99-test"]).toEqual(existing);
  expect(Object.keys(models(registry))).toHaveLength(2);
});

test("removes unsupported reasoning modes by their request body, only in the proxy copy", () => {
  const modes = {
    speedy: { provider: { body: { service_tier: "priority" } } },
    unsupported: { provider: { body: { reasoning: { mode: "pro" } } } },
  };
  const registry = build({
    upstreamRegistry: {
      openai: { models: { "gpt-99-test": { experimental: { modes } } } },
    },
  });
  expect(models(registry)["gpt-99-test"]).toMatchObject({
    experimental: { modes: { speedy: modes.speedy } },
  });
  expect(
    (
      models(registry)["gpt-99-test"] as unknown as {
        experimental: { modes: unknown };
      }
    ).experimental.modes
  ).not.toHaveProperty("unsupported");
  expect(registry.openai).toEqual({
    models: { "gpt-99-test": { experimental: { modes } } },
  });
});
