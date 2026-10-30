import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  buildRequestUsageRow,
  buildTokenUsageRow,
  MISSING_PROVIDER_ACCOUNT_ID,
} from "../../db/repositories/request-usage";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import { isAccessGatedCodexModel } from "../../domain/models/models-dev";
import {
  codexDaybreakAccessProgram,
  readCodexModelPrograms,
} from "../../domain/providers/codex-model-access";
import { recordProviderAccountLiveLimits } from "../../domain/providers/provider-account-tracking";
import {
  findPinnedProviderAccounts,
  findRoutingCandidates,
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
  encodeCodexRequestBody,
  namespaceCodexKey,
  prepareCodexProxyRequest,
  readCodexPromptCacheKey,
  readCodexSessionId,
} from "../../providers/proxies/codex-proxy";
import { tryProxyCodexWebSocket } from "../../providers/proxies/codex-websocket";
import {
  readUpstreamErrorFields,
  readUpstreamErrorPayload,
} from "../../providers/proxies/upstream-error";
import { rewriteUsageLimitResponse } from "../../providers/proxies/usage-limit-response";
import {
  createPromptCacheTracker,
  readPromptCacheRequest,
  type PromptCacheTurn,
} from "../../usage/prompt-cache";
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
const promptCacheTracker = createPromptCacheTracker();
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

export const readPromptCacheMissTotals = () => promptCacheTracker.missTotals();

export const flushProxyFailureLogs = (): Promise<void> =>
  Promise.resolve(upstreamFailureLogger.flush());

type BunFetchRequestInit = RequestInit & {
  timeout?: number | false;
};

const fetchProxyUpstream = async (input: {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit;
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
  promptCache: PromptCacheTurn | null;
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
  let promptCache = input.promptCache;

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

      let usage = tokenUsage;
      if (promptCache) {
        const miss = promptCacheTracker.observe(promptCache, {
          providerAccountId: input.getProviderAccountId(),
          usage,
        });
        promptCache = null;
        if (miss?.isMain) {
          usage = { ...usage, cacheRepaidTokens: miss.repaidTokens };
        }
      }
      latestTokenUsage = usage;
      if (!requestPersisted) {
        return;
      }

      recordTokenCounters(usage, requestOccurredAt || Date.now());
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

  const promptCacheRequest = readPromptCacheRequest(route.provider, {
    apiKeyId,
    model: usageModel,
    headers: context.req.raw.headers,
    body: requestBodyJson,
    ...(route.operation ? { operation: route.operation } : {}),
  });
  const usageRecorder = createUsageRecorder({
    startedAt,
    apiKeyId,
    route,
    model: usageModel,
    promptCache:
      promptCacheRequest && promptCacheTracker.begin(promptCacheRequest),
    getProviderAccountId: () => providerAccountId,
  });

  const now = Date.now();
  const accessGatedModel =
    route.provider === "codex" &&
    parsedModel.upstreamModel &&
    isAccessGatedCodexModel(parsedModel.upstreamModel)
      ? parsedModel.upstreamModel
      : null;
  // Each candidate's catalog is read once; injection reuses the chosen one's.
  const accessPrograms = new Map<string, readonly string[]>();
  let account: Awaited<ReturnType<typeof getRoutableProviderAccount>>;
  try {
    account = await getRoutableProviderAccount(db, route.provider, now, {
      allowedAccountIds: accountScopeIds,
      ...(accessGatedModel
        ? {
            accepts: async (candidate: ProviderAccountRecord) => {
              const programs = await readCodexModelPrograms(
                db,
                candidate,
                accessGatedModel
              );
              if (programs) {
                accessPrograms.set(candidate.id, programs);
              }
              return programs !== null;
            },
          }
        : {}),
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

  if (!account && accessGatedModel) {
    const candidates = await findRoutingCandidates(
      db,
      route.provider,
      accountScopeIds
    );
    if (candidates.some((candidate) => candidate.enabled)) {
      usageRecorder.recordImmediate(403);
      return context.json(
        proxyErrorResponse(
          `No ${route.provider} account for this API key has access to ${accessGatedModel}`,
          "model_access_missing"
        ),
        403
      );
    }
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

  if (
    accessGatedModel &&
    route.operation !== "compact" &&
    isObjectRecord(requestBodyJson) &&
    requestBodyJson.access_programs === undefined
  ) {
    const program = codexDaybreakAccessProgram(
      accessPrograms.get(account.id) ?? []
    );
    if (program) {
      requestBodyJson = {
        ...requestBodyJson,
        access_programs: { cyber: program },
      };
      requestBody = JSON.stringify(requestBodyJson);
    }
  }

  const headers = createUpstreamProxyHeaders(context.req.raw.headers);
  let sendAttempt: (account: ProviderAccountRecord) => Promise<ProxyAttempt>;
  let respondedAt = 0;
  const onStreamEnd = (statusCode: number): void =>
    usageRecorder.recordFinal(statusCode, respondedAt);

  switch (route.provider) {
    case "codex": {
      const accountKey = `${apiKeyId}:${account.id}`;
      const codexSessionId = readCodexSessionId(requestBodyJson, headers);
      const codexUpstreamSessionId = codexSessionId
        ? await namespaceCodexKey(accountKey, codexSessionId)
        : null;
      const promptCacheKey = readCodexPromptCacheKey(requestBodyJson);
      const codexPromptCacheKey = promptCacheKey
        ? await namespaceCodexKey(accountKey, promptCacheKey)
        : null;
      const clientSentZstd =
        context.req.header("content-encoding")?.trim().toLowerCase() === "zstd";
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
          promptCacheKey: codexPromptCacheKey,
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
          body: encodeCodexRequestBody(
            attemptHeaders,
            codexProxy.bodyText,
            clientSentZstd
          ),
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
