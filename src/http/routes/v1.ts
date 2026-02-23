import { Hono, type Context } from "hono";

import { getRuntimeConfig } from "../../config/runtime";
import { dbFromContext } from "../../db/client";
import type { Provider } from "../../db/schema";
import {
  getModelsDevRegistry,
  toOpenAiModelList,
} from "../../domain/models/models-dev";
import { getPrimaryProviderAccount } from "../../domain/providers/provider-service";
import { prepareClaudeProxyRequest } from "../../providers/claude-proxy";
import { prepareCodexProxyRequest } from "../../providers/codex-proxy";
import { prepareCopilotProxyRequest } from "../../providers/copilot-proxy";
import type { AppEnv } from "../app-env";

const proxyErrorResponse = (message: string, type = "proxy_error") => ({
  error: {
    message,
    type,
  },
});

const PROVIDER_HEADER = "x-kleis-provider";

type ProxyEndpoint = "chat_completions" | "responses" | "messages";

const toProvider = (value: string | null | undefined): Provider | null => {
  if (value === "copilot" || value === "codex" || value === "claude") {
    return value;
  }

  return null;
};

const resolveTargetProvider = (
  endpoint: ProxyEndpoint,
  preferredProvider: Provider | null
): Provider => {
  if (preferredProvider) {
    return preferredProvider;
  }

  if (endpoint === "messages") {
    return "claude";
  }

  if (endpoint === "chat_completions") {
    return "copilot";
  }

  return "codex";
};

const removeProxyAuthHeaders = (headers: Headers): void => {
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("content-length");
};

const tryParseJsonBody = (bodyText: string | null): unknown | null => {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
};

const proxyRequest = async (
  context: Context<AppEnv>,
  endpoint: ProxyEndpoint
): Promise<Response> => {
  const requestedProvider = toProvider(context.req.header(PROVIDER_HEADER));
  const targetProvider = resolveTargetProvider(endpoint, requestedProvider);
  const database = dbFromContext(context);
  const now = Date.now();
  const account = await getPrimaryProviderAccount(
    database,
    targetProvider,
    now
  );
  if (!account) {
    return context.json(
      proxyErrorResponse(
        `No primary ${targetProvider} account is configured`,
        "account_missing"
      ),
      400
    );
  }

  const requestUrl = new URL(context.req.url);
  const requestBodyText = await context.req.text();
  const requestBodyJson = tryParseJsonBody(requestBodyText);
  const headers = new Headers(context.req.raw.headers);
  removeProxyAuthHeaders(headers);

  let upstreamUrl = "";
  let requestBody = requestBodyText;
  let responseTransformer: ((response: Response) => Response) | null = null;

  if (targetProvider === "codex") {
    const codexMetadata =
      account.metadata?.provider === "codex" ? account.metadata : null;
    const codexProxy = prepareCodexProxyRequest({
      headers,
      accessToken: account.accessToken,
      fallbackAccountId: account.accountId,
      metadata: codexMetadata,
    });

    upstreamUrl = codexProxy.upstreamUrl;
  }

  if (targetProvider === "copilot") {
    const copilotMetadata =
      account.metadata?.provider === "copilot" ? account.metadata : null;
    const copilotProxy = prepareCopilotProxyRequest({
      endpoint,
      requestUrl,
      headers,
      bodyJson: requestBodyJson,
      githubAccessToken: account.refreshToken,
      metadata: copilotMetadata,
    });

    upstreamUrl = copilotProxy.upstreamUrl;
  }

  if (targetProvider === "claude") {
    const claudeMetadata =
      account.metadata?.provider === "claude" ? account.metadata : null;
    const claudeProxy = prepareClaudeProxyRequest({
      requestUrl,
      headers,
      bodyText: requestBody,
      bodyJson: requestBodyJson,
      accessToken: account.accessToken,
      metadata: claudeMetadata,
    });

    upstreamUrl = claudeProxy.upstreamUrl;
    requestBody = claudeProxy.bodyText;
    responseTransformer = claudeProxy.transformResponse;
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: context.req.method,
    headers,
    body: requestBody,
  });

  if (responseTransformer) {
    return responseTransformer(upstreamResponse);
  }

  return upstreamResponse;
};

export const v1Routes = new Hono<AppEnv>()
  .get("/models", async (context) => {
    const config = getRuntimeConfig(context.env);
    const registry = await getModelsDevRegistry(config);
    return context.json(toOpenAiModelList(registry));
  })
  .post("/chat/completions", async (context) =>
    proxyRequest(context, "chat_completions")
  )
  .post("/responses", async (context) => proxyRequest(context, "responses"))
  .post("/messages", async (context) => proxyRequest(context, "messages"));
