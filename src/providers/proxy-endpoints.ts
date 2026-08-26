export type CanonicalProvider = "openai" | "anthropic";

export type ProxyEndpoint = "chat_completions" | "responses" | "messages";

export type ProxyOperation = "compact";

export type ProxyRouteSuffix =
  | "/responses"
  | "/responses/compact"
  | "/messages"
  | "/chat/completions";

type ProxyEndpointRoute = {
  publicProvider: CanonicalProvider;
  endpoint: ProxyEndpoint;
  operation?: ProxyOperation;
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
    publicProvider: "openai",
    endpoint: "responses",
    operation: "compact",
    publicSuffix: "/responses/compact",
    upstreamSuffix: "/responses/compact",
  },
  {
    publicProvider: "anthropic",
    endpoint: "messages",
    publicSuffix: "/messages",
    upstreamSuffix: "/v1/messages",
  },
] as const;

export const requireProxyEndpointRoute = (input: {
  publicProvider: CanonicalProvider;
  endpoint: ProxyEndpoint;
  operation?: ProxyOperation;
}): ProxyEndpointRoute => {
  for (const route of proxyEndpointRoutes) {
    if (
      route.publicProvider === input.publicProvider &&
      route.endpoint === input.endpoint &&
      route.operation === input.operation
    ) {
      return route;
    }
  }

  throw new Error(
    `Unknown endpoint route: ${input.publicProvider}/${input.endpoint}`
  );
};
