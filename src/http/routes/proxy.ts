import { Hono, type Context } from "hono";

import { db } from "../../db";
import { recordApiKeyUsage } from "../../db/repositories/api-key-usage";
import { getPrimaryProviderAccount } from "../../domain/providers/provider-service";
import { prepareClaudeProxyRequest } from "../../providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../providers/proxies/codex-proxy";
import { prepareCopilotProxyRequest } from "../../providers/proxies/copilot-proxy";
import { isObjectRecord } from "../../utils/object";
import {
  parseModelForProxyRoute,
  proxyRouteTable,
  readModelFromBody,
  type ProxyRoute,
} from "../proxy-routing";

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

const runInBackground = (promise: Promise<unknown>): void => {
  promise.catch(() => undefined);
};

const proxyRequest = async (
  context: Context,
  route: ProxyRoute
): Promise<Response> => {
  const startedAt = Date.now();
  const apiKeyId = context.get("proxyApiKeyId");
  const recordUsage = (statusCode: number): void => {
    runInBackground(
      recordApiKeyUsage(db, {
        apiKeyId,
        provider: route.provider,
        endpoint: route.endpoint,
        statusCode,
        durationMs: Date.now() - startedAt,
        occurredAt: Date.now(),
      })
    );
  };

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

  const now = Date.now();
  const account = await getPrimaryProviderAccount(db, route.provider, now);
  if (!account) {
    recordUsage(400);
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

  switch (route.provider) {
    case "codex": {
      const codexProxy = prepareCodexProxyRequest({
        headers,
        accessToken: account.accessToken,
        accountId: account.accountId,
        metadata:
          account.metadata?.provider === "codex" ? account.metadata : null,
      });
      upstreamUrl = codexProxy.upstreamUrl;
      break;
    }

    case "copilot": {
      const copilotProxy = prepareCopilotProxyRequest({
        endpoint: route.endpoint,
        requestUrl: upstreamRequestUrl,
        headers,
        bodyJson: requestBodyJson,
        githubAccessToken: account.refreshToken,
        metadata:
          account.metadata?.provider === "copilot" ? account.metadata : null,
      });
      upstreamUrl = copilotProxy.upstreamUrl;
      break;
    }

    case "claude": {
      const claudeProxy = prepareClaudeProxyRequest({
        requestUrl: upstreamRequestUrl,
        headers,
        bodyText: requestBody,
        bodyJson: requestBodyJson,
        accessToken: account.accessToken,
        metadata:
          account.metadata?.provider === "claude" ? account.metadata : null,
      });
      upstreamUrl = claudeProxy.upstreamUrl;
      requestBody = claudeProxy.bodyText;
      responseTransformer = claudeProxy.transformResponse;
      break;
    }

    default: {
      recordUsage(500);
      return context.json(
        proxyErrorResponse(
          `Proxy route provider is not supported: ${route.provider}`,
          "provider_not_supported"
        ),
        500
      );
    }
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: context.req.method,
      headers,
      body: requestBody,
    });
  } catch (error) {
    recordUsage(500);
    throw error;
  }

  recordUsage(upstreamResponse.status);

  if (responseTransformer) {
    return await responseTransformer(upstreamResponse);
  }

  return upstreamResponse;
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
