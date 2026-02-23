import { Hono, type Context } from "hono";

import { dbFromContext } from "../../db/client";
import { getPrimaryProviderAccount } from "../../domain/providers/provider-service";
import { prepareClaudeProxyRequest } from "../../providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../providers/proxies/codex-proxy";
import { prepareCopilotProxyRequest } from "../../providers/proxies/copilot-proxy";
import { isObjectRecord } from "../../utils/object";
import type { AppEnv } from "../app-env";
import {
  getRequiredProxyRoute,
  parseModelForProxyRoute,
  readModelFromBody,
  type ProxyRoute,
} from "../proxy-routing";

const openAiResponsesRoute = getRequiredProxyRoute("/openai/v1/responses");
const anthropicMessagesRoute = getRequiredProxyRoute("/anthropic/v1/messages");
const copilotChatCompletionsRoute = getRequiredProxyRoute(
  "/copilot/v1/chat/completions"
);
const copilotResponsesRoute = getRequiredProxyRoute("/copilot/v1/responses");

const proxyErrorResponse = (message: string, type = "proxy_error") => ({
  error: {
    message,
    type,
  },
});

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
  route: ProxyRoute
): Promise<Response> => {
  const requestUrl = new URL(context.req.url);
  const upstreamRequestUrl = new URL(requestUrl);
  upstreamRequestUrl.pathname = route.upstreamPath;

  const requestBodyText = await context.req.text();
  const parsedRequestBody = tryParseJsonBody(requestBodyText);
  const requestedModel = readModelFromBody(parsedRequestBody);
  const parsedModel = parseModelForProxyRoute(requestedModel, route);

  let requestBodyJson = parsedRequestBody;
  let requestBody = requestBodyText;
  if (
    parsedModel.rawModel &&
    parsedModel.upstreamModel &&
    parsedModel.rawModel !== parsedModel.upstreamModel &&
    isObjectRecord(parsedRequestBody)
  ) {
    requestBodyJson = {
      ...parsedRequestBody,
      model: parsedModel.upstreamModel,
    };
    requestBody = JSON.stringify(requestBodyJson);
  }

  const database = dbFromContext(context);
  const now = Date.now();
  const account = await getPrimaryProviderAccount(
    database,
    route.provider,
    now
  );
  if (!account) {
    return context.json(
      proxyErrorResponse(
        `No primary ${route.provider} account is configured`,
        "account_missing"
      ),
      400
    );
  }

  const headers = new Headers(context.req.raw.headers);
  removeProxyAuthHeaders(headers);

  let upstreamUrl = "";
  let responseTransformer: ((response: Response) => Promise<Response>) | null =
    null;

  if (route.provider === "codex") {
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

  if (route.provider === "copilot") {
    const copilotMetadata =
      account.metadata?.provider === "copilot" ? account.metadata : null;
    const copilotProxy = prepareCopilotProxyRequest({
      endpoint: route.endpoint,
      requestUrl: upstreamRequestUrl,
      headers,
      bodyJson: requestBodyJson,
      githubAccessToken: account.refreshToken,
      metadata: copilotMetadata,
    });

    upstreamUrl = copilotProxy.upstreamUrl;
  }

  if (route.provider === "claude") {
    const claudeMetadata =
      account.metadata?.provider === "claude" ? account.metadata : null;
    const claudeProxy = prepareClaudeProxyRequest({
      requestUrl: upstreamRequestUrl,
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
    return await responseTransformer(upstreamResponse);
  }

  return upstreamResponse;
};

export const proxyRoutes = new Hono<AppEnv>()
  .post(openAiResponsesRoute.path, async (context) =>
    proxyRequest(context, openAiResponsesRoute)
  )
  .post(anthropicMessagesRoute.path, async (context) =>
    proxyRequest(context, anthropicMessagesRoute)
  )
  .post(copilotChatCompletionsRoute.path, async (context) =>
    proxyRequest(context, copilotChatCompletionsRoute)
  )
  .post(copilotResponsesRoute.path, async (context) =>
    proxyRequest(context, copilotResponsesRoute)
  );
