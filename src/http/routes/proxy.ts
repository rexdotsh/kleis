import { waitUntil } from "@vercel/functions";
import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  MISSING_PROVIDER_ACCOUNT_ID,
  recordRequestUsage,
  recordTokenUsage,
} from "../../db/repositories/request-usage";
import { getPrimaryProviderAccount } from "../../domain/providers/provider-service";
import { prepareClaudeProxyRequest } from "../../providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../providers/proxies/codex-proxy";
import { prepareCopilotProxyRequest } from "../../providers/proxies/copilot-proxy";
import {
  isTokenUsagePopulated,
  type TokenUsage,
} from "../../usage/token-usage";
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
  waitUntil(promise.catch(() => undefined));
};

type UsageRecorderInput = {
  startedAt: number;
  apiKeyId: string;
  route: ProxyRoute;
  model: string;
  getProviderAccountId: () => string;
};

const createUsageRecorder = (input: UsageRecorderInput) => {
  let requestOccurredAt = 0;
  let requestPersisted = false;
  let latestTokenUsage: TokenUsage | null = null;

  const recordRequestCounters = (
    statusCode: number,
    occurredAt: number,
    tokenUsage?: TokenUsage | null
  ): void => {
    const usageInput = {
      apiKeyId: input.apiKeyId,
      providerAccountId: input.getProviderAccountId(),
      provider: input.route.provider,
      endpoint: input.route.endpoint,
      model: input.model,
      statusCode,
      durationMs: occurredAt - input.startedAt,
      occurredAt,
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    };
    runInBackground(recordRequestUsage(db, usageInput));
  };

  const recordTokenCounters = (
    tokenUsage: TokenUsage,
    occurredAt: number
  ): void => {
    runInBackground(
      recordTokenUsage(db, {
        apiKeyId: input.apiKeyId,
        providerAccountId: input.getProviderAccountId(),
        provider: input.route.provider,
        endpoint: input.route.endpoint,
        model: input.model,
        occurredAt,
        tokenUsage,
      })
    );
  };

  return {
    onTokenUsage(tokenUsage: TokenUsage): void {
      if (!isTokenUsagePopulated(tokenUsage)) {
        return;
      }

      latestTokenUsage = tokenUsage;
      if (!requestPersisted) {
        return;
      }

      recordTokenCounters(tokenUsage, requestOccurredAt || Date.now());
    },
    recordImmediate(statusCode: number): void {
      requestOccurredAt = Date.now();
      requestPersisted = true;
      recordRequestCounters(statusCode, requestOccurredAt);
    },
    recordFinal(statusCode: number): void {
      requestOccurredAt = Date.now();
      recordRequestCounters(statusCode, requestOccurredAt, latestTokenUsage);
      requestPersisted = true;
    },
  };
};

const proxyRequest = async (
  context: Context,
  route: ProxyRoute
): Promise<Response> => {
  const startedAt = Date.now();
  const apiKeyId = context.get("proxyApiKeyId");
  let providerAccountId = MISSING_PROVIDER_ACCOUNT_ID;

  const requestUrl = new URL(context.req.url);
  const requestBodyText = await context.req.text();
  const parsedRequestBody = tryParseJsonBody(requestBodyText);
  const requestedModel = readModelFromBody(parsedRequestBody);
  const parsedModel = parseModelForProxyRoute(requestedModel, route);
  const usageModel = parsedModel.upstreamModel ?? "";

  const usageRecorder = createUsageRecorder({
    startedAt,
    apiKeyId,
    route,
    model: usageModel,
    getProviderAccountId: () => providerAccountId,
  });

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
  let account: Awaited<ReturnType<typeof getPrimaryProviderAccount>>;
  try {
    account = await getPrimaryProviderAccount(db, route.provider, now);
  } catch {
    usageRecorder.recordImmediate(502);
    return context.json(
      proxyErrorResponse(
        `Failed to refresh ${route.provider} account token`,
        "token_refresh_failed"
      ),
      502
    );
  }

  if (!account) {
    usageRecorder.recordImmediate(400);
    return context.json(
      proxyErrorResponse(
        `No primary ${route.provider} account is configured`,
        "account_missing"
      ),
      400
    );
  }

  providerAccountId = account.id;

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
        bodyText: requestBody,
        bodyJson: requestBodyJson,
        onTokenUsage: usageRecorder.onTokenUsage,
      });
      upstreamUrl = codexProxy.upstreamUrl;
      requestBody = codexProxy.bodyText;
      responseTransformer = codexProxy.transformResponse;
      break;
    }

    case "copilot": {
      const copilotProxy = prepareCopilotProxyRequest({
        endpoint: route.endpoint,
        requestUrl,
        headers,
        bodyText: requestBody,
        bodyJson: requestBodyJson,
        githubAccessToken: account.refreshToken,
        metadata:
          account.metadata?.provider === "copilot" ? account.metadata : null,
        onTokenUsage: usageRecorder.onTokenUsage,
      });
      upstreamUrl = copilotProxy.upstreamUrl;
      requestBody = copilotProxy.bodyText;
      responseTransformer = copilotProxy.transformResponse;
      break;
    }

    case "claude": {
      const claudeProxy = prepareClaudeProxyRequest({
        requestUrl,
        headers,
        bodyText: requestBody,
        bodyJson: requestBodyJson,
        accessToken: account.accessToken,
        metadata:
          account.metadata?.provider === "claude" ? account.metadata : null,
        onTokenUsage: usageRecorder.onTokenUsage,
      });
      upstreamUrl = claudeProxy.upstreamUrl;
      requestBody = claudeProxy.bodyText;
      responseTransformer = claudeProxy.transformResponse;
      break;
    }

    default: {
      usageRecorder.recordImmediate(500);
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
    usageRecorder.recordImmediate(500);
    throw error;
  }

  let responseToClient = upstreamResponse;
  if (responseTransformer) {
    responseToClient = await responseTransformer(upstreamResponse);
    // Bun auto-decompresses but keeps Content-Encoding; Anthropic is the main
    // upstream that returns it, causing ZlibError on clients reading plaintext.
    responseToClient.headers.delete("content-encoding");
  }

  usageRecorder.recordFinal(upstreamResponse.status);

  return responseToClient;
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
