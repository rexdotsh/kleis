import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  MISSING_PROVIDER_ACCOUNT_ID,
  recordRequestUsage,
  recordTokenUsage,
} from "../../db/repositories/request-usage";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import {
  getRoutableProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../../domain/providers/provider-service";
import { CODEX_ACCOUNT_ID_HEADER } from "../../providers/constants";
import { prepareClaudeProxyRequest } from "../../providers/proxies/claude-proxy";
import {
  deriveCodexSessionId,
  prepareCodexProxyRequest,
  readCodexSessionId,
} from "../../providers/proxies/codex-proxy";
import { tryProxyCodexWebSocket } from "../../providers/proxies/codex-websocket";
import { prepareCopilotProxyRequest } from "../../providers/proxies/copilot-proxy";
import type { UsageRequestSource } from "../../usage/request-outcome";
import {
  isTokenUsagePopulated,
  type TokenUsage,
} from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord, readBooleanField } from "../../utils/object";
import { sendCodexWithAuthReplay } from "../codex-auth-replay";
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

const CODEX_SSE_HEADER_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_WEBSOCKET_ENABLED =
  process.env.CODEX_WEBSOCKET_ENABLED?.trim().toLowerCase() === "true";

const createCodexSseHeaderTimeout = (): {
  signal: AbortSignal;
  clear(): void;
  error(): Error | undefined;
} => {
  const controller = new AbortController();
  let error: Error | undefined;
  const timeout = setTimeout(() => {
    error = new Error(
      `Codex SSE response headers timed out after ${CODEX_SSE_HEADER_TIMEOUT_MS}ms`
    );
    controller.abort(error);
  }, CODEX_SSE_HEADER_TIMEOUT_MS);

  return {
    signal: controller.signal,
    clear(): void {
      clearTimeout(timeout);
    },
    error: () => error,
  };
};

const removeProxyAuthHeaders = (headers: Headers): void => {
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("content-length");
  headers.delete(CODEX_ACCOUNT_ID_HEADER);
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

type BunFetchRequestInit = RequestInit & {
  timeout?: number | false;
};

const fetchProxyUpstream = async (input: {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
  useCodexSseHeaderTimeout: boolean;
}): Promise<Response> => {
  const headerTimeout = input.useCodexSseHeaderTimeout
    ? createCodexSseHeaderTimeout()
    : null;
  const requestInit: BunFetchRequestInit = {
    method: input.method,
    headers: input.headers,
    body: input.body,
    timeout: false,
    signal: input.signal,
  };
  if (headerTimeout) {
    requestInit.signal = AbortSignal.any([input.signal, headerTimeout.signal]);
  }

  try {
    return await fetch(input.url, requestInit);
  } catch (error) {
    const timeoutError = headerTimeout?.error();
    throw timeoutError && !input.signal.aborted ? timeoutError : error;
  } finally {
    headerTimeout?.clear();
  }
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
    source: UsageRequestSource,
    tokenUsage?: TokenUsage | null
  ): void => {
    const usageInput = {
      apiKeyId: input.apiKeyId,
      providerAccountId: input.getProviderAccountId(),
      provider: input.route.provider,
      endpoint: input.route.endpoint,
      model: input.model,
      source,
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
      recordRequestCounters(statusCode, requestOccurredAt, "proxy");
    },
    recordFinal(statusCode: number): void {
      requestOccurredAt = Date.now();
      recordRequestCounters(
        statusCode,
        requestOccurredAt,
        "upstream",
        latestTokenUsage
      );
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
  const accountScopeIds = context.get("proxyApiKeyAccountScopeIds");
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
  let account: Awaited<ReturnType<typeof getRoutableProviderAccount>>;
  try {
    account = await getRoutableProviderAccount(db, route.provider, now, {
      allowedAccountIds: accountScopeIds,
    });
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
    const isAccountScoped = Boolean(accountScopeIds?.length);
    usageRecorder.recordImmediate(isAccountScoped ? 403 : 400);
    return context.json(
      proxyErrorResponse(
        isAccountScoped
          ? `No scoped ${route.provider} account is configured for this API key`
          : `No primary ${route.provider} account is configured`,
        isAccountScoped ? "account_scope_missing" : "account_missing"
      ),
      isAccountScoped ? 403 : 400
    );
  }

  providerAccountId = account.id;

  const headers = new Headers(context.req.raw.headers);
  removeProxyAuthHeaders(headers);

  let upstreamUrl = "";
  let responseTransformer: ((response: Response) => Promise<Response>) | null =
    null;
  const useCodexSseHeaderTimeout = false;

  switch (route.provider) {
    case "codex": {
      const initialCodexAccount = account;
      const codexSessionId = readCodexSessionId(requestBodyJson, headers);
      const codexUpstreamSessionId = codexSessionId
        ? await deriveCodexSessionId(
            `${apiKeyId}:${account.id}`,
            codexSessionId
          )
        : null;
      const baseHeaders = new Headers(headers);
      const baseRequestBody = requestBody;
      const sendAttempt = async (
        attemptAccount: ProviderAccountRecord
      ): Promise<{
        response: Response;
        transformResponse: ((response: Response) => Promise<Response>) | null;
      }> => {
        const attemptHeaders = new Headers(baseHeaders);
        const codexProxy = prepareCodexProxyRequest({
          ...(route.operation ? { operation: route.operation } : {}),
          headers: attemptHeaders,
          accessToken: attemptAccount.accessToken,
          accountId: attemptAccount.accountId,
          metadata:
            attemptAccount.metadata?.provider === "codex"
              ? attemptAccount.metadata
              : null,
          bodyText: baseRequestBody,
          bodyJson: requestBodyJson,
          sessionId: codexUpstreamSessionId,
          onTokenUsage: usageRecorder.onTokenUsage,
        });

        if (CODEX_WEBSOCKET_ENABLED && route.operation !== "compact") {
          const webSocketResponse = await tryProxyCodexWebSocket({
            headers: attemptHeaders,
            bodyJson: codexProxy.bodyJson,
            accountKey: `${apiKeyId}:${attemptAccount.id}`,
            sessionId: codexSessionId,
            upstreamSessionId: codexUpstreamSessionId,
            onTokenUsage: usageRecorder.onTokenUsage,
            signal: context.req.raw.signal,
          });
          if (webSocketResponse) {
            return { response: webSocketResponse, transformResponse: null };
          }
        }

        const response = await fetchProxyUpstream({
          url: codexProxy.upstreamUrl,
          method: context.req.method,
          headers: attemptHeaders,
          body: codexProxy.bodyText,
          signal: context.req.raw.signal,
          useCodexSseHeaderTimeout:
            readBooleanField(codexProxy.bodyJson, "stream") === true,
        });
        return { response, transformResponse: codexProxy.transformResponse };
      };

      const sendWithAuthReplay = () =>
        sendCodexWithAuthReplay<
          ProviderAccountRecord,
          Awaited<ReturnType<typeof sendAttempt>>
        >({
          account: initialCodexAccount,
          signal: context.req.raw.signal,
          send: sendAttempt,
          refresh: (accountId, failedAccessToken) =>
            refreshProviderAccountAfterAuthFailure(
              db,
              accountId,
              failedAccessToken,
              context.req.raw.signal
            ),
        });
      let result: Awaited<ReturnType<typeof sendWithAuthReplay>>;
      try {
        result = await sendWithAuthReplay();
      } catch (error) {
        if (context.req.raw.signal.aborted) {
          throw error;
        }
        logWarn("proxy_upstream_request_failed", {
          provider: route.provider,
          endpoint: route.endpoint,
          elapsedMs: Date.now() - startedAt,
          aborted: false,
          ...errorLogFields(error),
        });
        usageRecorder.recordImmediate(500);
        throw error;
      }
      account = result.account;
      if (result.refreshFailed) {
        logWarn("codex_auth_refresh_replay_failed", {
          accountId: account.id,
          elapsedMs: Date.now() - startedAt,
          upstreamStatus: result.attempt.response.status,
        });
      }
      const { attempt } = result;

      let responseToClient = attempt.response;
      if (attempt.transformResponse) {
        try {
          responseToClient = await attempt.transformResponse(attempt.response);
          responseToClient.headers.delete("content-encoding");
        } catch (error) {
          logWarn("proxy_response_transform_failed", {
            provider: route.provider,
            endpoint: route.endpoint,
            status: attempt.response.status,
            elapsedMs: Date.now() - startedAt,
            ...errorLogFields(error),
          });
          usageRecorder.recordImmediate(500);
          throw error;
        }
      }

      usageRecorder.recordFinal(attempt.response.status);
      return responseToClient;
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
    upstreamResponse = await fetchProxyUpstream({
      url: upstreamUrl,
      method: context.req.method,
      headers,
      body: requestBody,
      signal: context.req.raw.signal,
      useCodexSseHeaderTimeout,
    });
  } catch (error) {
    if (context.req.raw.signal.aborted) {
      // Client disconnects are expected cancellations, not proxy failures.
      throw error;
    }
    logWarn("proxy_upstream_request_failed", {
      provider: route.provider,
      endpoint: route.endpoint,
      elapsedMs: Date.now() - startedAt,
      aborted: false,
      ...errorLogFields(error),
    });
    usageRecorder.recordImmediate(500);
    throw error;
  }

  let responseToClient = upstreamResponse;
  if (responseTransformer) {
    try {
      responseToClient = await responseTransformer(upstreamResponse);
      // Bun auto-decompresses but keeps Content-Encoding; Anthropic is the main
      // upstream that returns it, causing ZlibError on clients reading plaintext.
      responseToClient.headers.delete("content-encoding");
    } catch (error) {
      logWarn("proxy_response_transform_failed", {
        provider: route.provider,
        endpoint: route.endpoint,
        status: upstreamResponse.status,
        elapsedMs: Date.now() - startedAt,
        ...errorLogFields(error),
      });
      usageRecorder.recordImmediate(500);
      throw error;
    }
  }

  usageRecorder.recordFinal(upstreamResponse.status);

  return responseToClient;
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
