import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  buildRequestUsageRow,
  buildTokenUsageRow,
  MISSING_PROVIDER_ACCOUNT_ID,
} from "../../db/repositories/request-usage";
import {
  findGrantedOwnedAccounts,
  isOwnedCredentialLive,
} from "../../db/repositories/grants";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import { splitOwnerSuffix } from "../../domain/owners";
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
import { prepareClaudeProxyRequest } from "../../providers/proxies/claude-proxy";
import { isEventStreamResponse } from "../../providers/proxies/response";
import {
  deriveCodexSessionId,
  prepareCodexProxyRequest,
  readCodexSessionId,
} from "../../providers/proxies/codex-proxy";
import { tryProxyCodexWebSocket } from "../../providers/proxies/codex-websocket";
import {
  readUpstreamErrorFields,
  readUpstreamErrorPayload,
} from "../../providers/proxies/upstream-error";
import { rewriteUsageLimitResponse } from "../../providers/proxies/usage-limit-response";
import type { UsageRequestSource } from "../../usage/request-outcome";
import { createUsageBuffer } from "../../usage/usage-buffer";
import {
  isTokenUsagePopulated,
  type TokenUsage,
} from "../../usage/token-usage";
import { isObjectRecord, readBooleanField } from "../../utils/object";
import { hashLogId } from "../../utils/log";
import { sendWithAuthReplay } from "../auth-replay";
import { createUpstreamProxyHeaders } from "../proxy-headers";
import { createUpstreamFailureLogger } from "../upstream-failure-log";
import {
  parseModelForProxyRoute,
  proxyRouteTable,
  type ProxyRoute,
} from "../proxy-routing";

class OwnerAccessRevoked extends Error {
  constructor() {
    super("The owner's grant or linked account was revoked");
    this.name = "OwnerAccessRevoked";
  }
}

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
const upstreamFailureLogger = createUpstreamFailureLogger();

const logUpstreamResponse = async (
  response: Response,
  route: ProxyRoute,
  providerAccountId: string,
  startedAt: number
): Promise<unknown> => {
  if (response.ok) {
    return null;
  }
  const payload = await readUpstreamErrorPayload(response);
  upstreamFailureLogger.log({
    provider: route.provider,
    providerAccountId,
    endpoint: route.endpoint,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    requestIdHash: hashLogId(
      response.headers.get("x-request-id") ?? response.headers.get("request-id")
    ),
    ...readUpstreamErrorFields(payload),
  });
  return payload;
};

export const flushProxyUsage = (): Promise<void> => usageBuffer.flush();

export const flushProxyFailureLogs = (): Promise<void> =>
  Promise.resolve(upstreamFailureLogger.flush());

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
    if (timeoutError && !input.signal.aborted) throw timeoutError;
    throw error;
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

type ProxyAttempt = {
  response: Response;
  transformResponse: ((response: Response) => Promise<Response>) | null;
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
  const ownerId = context.get("proxyOwnerId") ?? null;
  let providerAccountId = MISSING_PROVIDER_ACCOUNT_ID;

  const requestUrl = new URL(context.req.url);
  const {
    text: requestBodyText,
    parsed: parsedRequestBody,
    model: requestedModel,
  } = context.get("proxyRequestBody");
  const parsedModel = parseModelForProxyRoute(
    ownerId && requestedModel
      ? splitOwnerSuffix(requestedModel).model
      : requestedModel,
    route
  );
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
    parsedModel.upstreamModel &&
    parsedModel.upstreamModel !== requestedModel &&
    isObjectRecord(parsedRequestBody)
  ) {
    requestBodyJson = {
      ...parsedRequestBody,
      model: parsedModel.upstreamModel,
    };
    requestBody = JSON.stringify(requestBodyJson);
  }

  const now = Date.now();
  const owned = ownerId
    ? await findGrantedOwnedAccounts(db, {
        apiKeyId,
        ownerId,
        provider: route.provider,
        now,
      })
    : undefined;
  if (owned === null) {
    usageRecorder.recordImmediate(403);
    return context.json(
      proxyErrorResponse(
        `This API key has no live grant for ${ownerId}. Ask for a grant before using their model names.`,
        "grant_missing"
      ),
      403
    );
  }

  let account: Awaited<ReturnType<typeof getRoutableProviderAccount>>;
  try {
    account = await getRoutableProviderAccount(db, route.provider, now, {
      allowedAccountIds: accountScopeIds,
      ...(owned ? { candidates: owned } : {}),
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

  if (!account && ownerId) {
    usageRecorder.recordImmediate(400);
    return context.json(
      proxyErrorResponse(
        `No ${route.provider} account is linked for ${ownerId}`,
        "account_missing"
      ),
      400
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
  let sendAttempt: (account: ProviderAccountRecord) => Promise<ProxyAttempt>;
  let respondedAt = 0;
  const onStreamEnd = (statusCode: number): void =>
    usageRecorder.recordFinal(statusCode, respondedAt);

  switch (route.provider) {
    case "codex": {
      const codexSessionId = readCodexSessionId(requestBodyJson, headers);
      const codexUpstreamSessionId = codexSessionId
        ? await deriveCodexSessionId(
            `${apiKeyId}:${account.id}`,
            codexSessionId
          )
        : null;
      sendAttempt = async (attemptAccount) => {
        const attemptHeaders = new Headers(headers);
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
          bodyText: requestBody,
          bodyJson: requestBodyJson,
          sessionId: codexUpstreamSessionId,
          onTokenUsage: usageRecorder.onTokenUsage,
          onStreamEnd,
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
      break;
    }

    case "claude": {
      sendAttempt = async (attemptAccount) => {
        const attemptHeaders = new Headers(headers);
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
          onStreamEnd,
        });
        const response = await fetchProxyUpstream({
          url: claudeProxy.upstreamUrl,
          method: context.req.method,
          headers: attemptHeaders,
          body: claudeProxy.bodyText,
          signal: context.req.raw.signal,
          useCodexSseHeaderTimeout: false,
        });
        return { response, transformResponse: claudeProxy.transformResponse };
      };
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

  let result: { account: ProviderAccountRecord; attempt: ProxyAttempt };
  try {
    result = await sendWithAuthReplay({
      account,
      signal: context.req.raw.signal,
      send: ownerId
        ? async (attemptAccount) => {
            const live = await isOwnedCredentialLive(db, {
              apiKeyId,
              ownerId,
              accountId: attemptAccount.id,
              accessToken: attemptAccount.accessToken,
              now: Date.now(),
            });
            if (!live) {
              throw new OwnerAccessRevoked();
            }
            return sendAttempt(attemptAccount);
          }
        : sendAttempt,
      refresh: (accountId, failedAccessToken) =>
        refreshProviderAccountAfterAuthFailure(
          db,
          accountId,
          failedAccessToken,
          context.req.raw.signal
        ),
    });
  } catch (error) {
    if (error instanceof OwnerAccessRevoked) {
      usageRecorder.recordImmediate(403);
      return context.json(
        proxyErrorResponse(error.message, "grant_missing"),
        403
      );
    }
    if (!context.req.raw.signal.aborted) {
      usageRecorder.recordImmediate(500);
    }
    throw error;
  }
  account = result.account;
  respondedAt = Date.now();
  const { attempt } = result;
  const errorPayload = await logUpstreamResponse(
    attempt.response,
    route,
    account.id,
    startedAt
  );
  const liveLimits =
    route.provider === "codex"
      ? readCodexLiveLimits(attempt.response.headers)
      : readClaudeLiveLimits(attempt.response.headers);
  recordProviderAccountLiveLimits(account, liveLimits);

  const usageLimitResponse = attempt.transformResponse
    ? rewriteUsageLimitResponse({
        response: attempt.response,
        provider: route.provider,
        accountLabel: account.label,
        liveLimits,
        errorPayload,
        now: respondedAt,
        mode:
          context.req.header("x-kleis-on-limit")?.trim().toLowerCase() ===
          "fail"
            ? "fail"
            : "wait",
      })
    : null;
  if (usageLimitResponse) {
    usageRecorder.recordFinal(attempt.response.status);
    return usageLimitResponse;
  }

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

  if (!attempt.transformResponse || !isEventStreamResponse(responseToClient)) {
    usageRecorder.recordFinal(attempt.response.status);
  }
  return responseToClient;
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
