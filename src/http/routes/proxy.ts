import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  buildRequestUsageRow,
  buildTokenUsageRow,
  MISSING_PROVIDER_ACCOUNT_ID,
} from "../../db/repositories/request-usage";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import { recordProviderAccountLiveLimits } from "../../domain/providers/provider-account-tracking";
import {
  findPinnedProviderAccounts,
  getRoutableProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../../domain/providers/provider-service";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../../providers/account-tracking/live-limits";
import {
  isEventStreamResponse,
  prepareClaudeProxyRequest,
} from "../../providers/proxies/claude-proxy";
import {
  deriveCodexSessionId,
  prepareCodexProxyRequest,
  readCodexSessionId,
} from "../../providers/proxies/codex-proxy";
import { tryProxyCodexWebSocket } from "../../providers/proxies/codex-websocket";
import { readUpstreamResponseError } from "../../providers/proxies/upstream-error";
import type { UsageRequestSource } from "../../usage/request-outcome";
import { createUsageBuffer } from "../../usage/usage-buffer";
import {
  isTokenUsagePopulated,
  type TokenUsage,
} from "../../usage/token-usage";
import { isObjectRecord, readBooleanField } from "../../utils/object";
import { sendWithAuthReplay } from "../auth-replay";
import { createUpstreamProxyHeaders } from "../proxy-headers";
import { createUpstreamFailureLogger } from "../upstream-failure-log";
import {
  parseModelForProxyRoute,
  proxyRouteTable,
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

const usageBuffer = createUsageBuffer(db);
const logUpstreamFailure = createUpstreamFailureLogger();

const logUpstreamResponse = async (
  response: Response,
  route: ProxyRoute,
  providerAccountId: string,
  startedAt: number
): Promise<void> => {
  if (response.ok) {
    return;
  }
  const fields = await readUpstreamResponseError(response);
  logUpstreamFailure({
    provider: route.provider,
    providerAccountId,
    endpoint: route.endpoint,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("request-id"),
    ...fields,
  });
};

export const flushProxyUsage = (): Promise<void> => usageBuffer.flush();

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
    usageBuffer.add(buildRequestUsageRow(usageInput));
  };

  const recordTokenCounters = (
    tokenUsage: TokenUsage,
    occurredAt: number
  ): void => {
    usageBuffer.add(
      buildTokenUsageRow({
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
    recordFinal(statusCode: number, occurredAt = Date.now()): void {
      requestOccurredAt = occurredAt;
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
  context.set("proxyLogContext", {
    provider: route.provider,
    endpoint: route.endpoint,
  });
  const apiKeyId = context.get("proxyApiKeyId");
  const accountScopeIds = context.get("proxyApiKeyAccountScopeIds");
  let providerAccountId = MISSING_PROVIDER_ACCOUNT_ID;

  const requestUrl = new URL(context.req.url);
  const {
    text: requestBodyText,
    parsed: parsedRequestBody,
    model: requestedModel,
  } = context.get("proxyRequestBody");
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
    const isAccountScoped =
      (await findPinnedProviderAccounts(db, route.provider, accountScopeIds))
        .length > 0;
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
  context.set("proxyLogContext", {
    provider: route.provider,
    endpoint: route.endpoint,
    providerAccountId,
  });

  const headers = createUpstreamProxyHeaders(context.req.raw.headers);

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
          providerAccountId: attemptAccount.id,
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
            providerAccountId: attemptAccount.id,
            sessionId: codexSessionId,
            upstreamSessionId: codexUpstreamSessionId,
            onTokenUsage: usageRecorder.onTokenUsage,
            onLiveLimits: (limits) =>
              recordProviderAccountLiveLimits(attemptAccount, limits),
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

      const sendCodexWithAuthReplay = () =>
        sendWithAuthReplay<
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
      let result: Awaited<ReturnType<typeof sendCodexWithAuthReplay>>;
      try {
        result = await sendCodexWithAuthReplay();
      } catch (error) {
        if (context.req.raw.signal.aborted) {
          throw error;
        }
        usageRecorder.recordImmediate(500);
        throw error;
      }
      account = result.account;
      const { attempt } = result;
      await logUpstreamResponse(attempt.response, route, account.id, startedAt);
      recordProviderAccountLiveLimits(
        account,
        readCodexLiveLimits(attempt.response.headers)
      );

      let responseToClient = attempt.response;
      if (attempt.transformResponse) {
        try {
          responseToClient = await attempt.transformResponse(attempt.response);
          responseToClient.headers.delete("content-encoding");
        } catch (error) {
          context.set("proxyLogContext", {
            ...context.get("proxyLogContext"),
            stage: "response_transform",
            upstreamStatus: attempt.response.status,
          });
          usageRecorder.recordImmediate(500);
          throw error;
        }
      }

      usageRecorder.recordFinal(attempt.response.status);
      return responseToClient;
    }

    case "claude": {
      const initialClaudeAccount = account;
      const baseHeaders = new Headers(headers);
      const sendAttempt = async (attemptAccount: ProviderAccountRecord) => {
        const attemptHeaders = new Headers(baseHeaders);
        let respondedAt = 0;
        const claudeProxy = prepareClaudeProxyRequest({
          requestUrl,
          headers: attemptHeaders,
          bodyText: requestBody,
          bodyJson: requestBodyJson,
          accessToken: attemptAccount.accessToken,
          providerAccountId: attemptAccount.id,
          metadata:
            attemptAccount.metadata?.provider === "claude"
              ? attemptAccount.metadata
              : null,
          onTokenUsage: usageRecorder.onTokenUsage,
          onStreamEnd: (statusCode) =>
            usageRecorder.recordFinal(statusCode, respondedAt),
        });
        const response = await fetchProxyUpstream({
          url: claudeProxy.upstreamUrl,
          method: context.req.method,
          headers: attemptHeaders,
          body: claudeProxy.bodyText,
          signal: context.req.raw.signal,
          useCodexSseHeaderTimeout: false,
        });
        respondedAt = Date.now();
        return { response, transformResponse: claudeProxy.transformResponse };
      };
      let result: Awaited<
        ReturnType<
          typeof sendWithAuthReplay<
            ProviderAccountRecord,
            Awaited<ReturnType<typeof sendAttempt>>
          >
        >
      >;
      try {
        result = await sendWithAuthReplay({
          account: initialClaudeAccount,
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
      } catch (error) {
        if (context.req.raw.signal.aborted) {
          throw error;
        }
        usageRecorder.recordImmediate(500);
        throw error;
      }
      account = result.account;
      const { attempt } = result;
      await logUpstreamResponse(attempt.response, route, account.id, startedAt);
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(attempt.response.headers)
      );
      let responseToClient = attempt.response;
      try {
        responseToClient = await attempt.transformResponse(attempt.response);
        responseToClient.headers.delete("content-encoding");
      } catch (error) {
        context.set("proxyLogContext", {
          ...context.get("proxyLogContext"),
          stage: "response_transform",
          upstreamStatus: attempt.response.status,
        });
        usageRecorder.recordImmediate(500);
        throw error;
      }
      if (!isEventStreamResponse(attempt.response)) {
        usageRecorder.recordFinal(attempt.response.status);
      }
      return responseToClient;
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
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
