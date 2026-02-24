export type CanonicalProvider = "openai" | "anthropic" | "github-copilot";

export type ProxyEndpoint = "chat_completions" | "responses" | "messages";

export type ProxyRouteSuffix = "/responses" | "/messages" | "/chat/completions";

type ProxyEndpointRoute = {
  publicProvider: CanonicalProvider;
  endpoint: ProxyEndpoint;
  publicSuffix: ProxyRouteSuffix;
  upstreamSuffix: string;
};

export const proxyEndpointRoutes: readonly ProxyEndpointRoute[] = [
  {
    publicProvider: "openai",
    endpoint: "responses",
    publicSuffix: "/responses",
    upstreamSuffix: "/responses",
  },
  {
    publicProvider: "anthropic",
    endpoint: "messages",
    publicSuffix: "/messages",
    upstreamSuffix: "/v1/messages",
  },
  {
    publicProvider: "github-copilot",
    endpoint: "chat_completions",
    publicSuffix: "/chat/completions",
    upstreamSuffix: "/chat/completions",
  },
  {
    publicProvider: "github-copilot",
    endpoint: "responses",
    publicSuffix: "/responses",
    upstreamSuffix: "/responses",
  },
] as const;

export const requireProxyEndpointRoute = (input: {
  publicProvider: CanonicalProvider;
  endpoint: ProxyEndpoint;
}): ProxyEndpointRoute => {
  for (const route of proxyEndpointRoutes) {
    if (
      route.publicProvider === input.publicProvider &&
      route.endpoint === input.endpoint
    ) {
      return route;
    }
  }

  throw new Error(
    `Unknown endpoint route: ${input.publicProvider}/${input.endpoint}`
  );
};
