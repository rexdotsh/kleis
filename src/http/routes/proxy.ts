import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  MISSING_PROVIDER_ACCOUNT_ID,
  recordRequestUsage,
  recordTokenUsage,
} from "../../db/repositories/request-usage";
import {
  setPrimaryProviderAccount,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  getRoutableProviderAccount,
  getRoutableProviderAccountCandidates,
} from "../../domain/providers/provider-service";
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
import { isObjectRecord, readBooleanField } from "../../utils/object";
import {
  parseModelForProxyRoute,
  proxyRouteTable,
  readModelFromBody,
  type ProxyRoute,
} from "../proxy-routing";
import {
  isRateLimitFailoverEnabled,
  shouldPersistRateLimitFailover,
  shouldRetryRateLimitWithNextAccount,
} from "../rate-limit-failover";

const proxyErrorResponse = (message: string, type = "proxy_error") => ({
  error: {
    message,
    type,
  },
});

const CODEX_SSE_HEADER_TIMEOUT_MS = 10_000;

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

type ProxyAttemptInput = {
  context: Context;
  route: ProxyRoute;
  requestUrl: URL;
  requestBody: string;
  requestBodyJson: unknown | null;
  apiKeyId: string;
  account: ProviderAccountRecord;
  usageRecorder: ReturnType<typeof createUsageRecorder>;
};

type ProxyAttemptResult = {
  upstreamResponse: Response;
  responseTransformer: ((response: Response) => Promise<Response>) | null;
  canFailover: boolean;
};

const cancelResponseBody = (response: Response): void => {
  response.body?.cancel().catch(() => undefined);
};

const fetchUpstreamForAccount = async (
  input: ProxyAttemptInput
): Promise<ProxyAttemptResult> => {
  const headers = new Headers(input.context.req.raw.headers);
  removeProxyAuthHeaders(headers);

  let upstreamUrl = "";
  let requestBody = input.requestBody;
  let responseTransformer: ((response: Response) => Promise<Response>) | null =
    null;
  let useCodexSseHeaderTimeout = false;

  switch (input.route.provider) {
    case "codex": {
      const codexSessionId = readCodexSessionId(input.requestBodyJson, headers);
      const codexUpstreamSessionId = codexSessionId
        ? await deriveCodexSessionId(
            `${input.apiKeyId}:${input.account.id}`,
            codexSessionId
          )
        : null;
      const codexProxy = prepareCodexProxyRequest({
        headers,
        accessToken: input.account.accessToken,
        accountId: input.account.accountId,
        metadata:
          input.account.metadata?.provider === "codex"
            ? input.account.metadata
            : null,
        bodyText: requestBody,
        bodyJson: input.requestBodyJson,
        sessionId: codexUpstreamSessionId,
        onTokenUsage: input.usageRecorder.onTokenUsage,
      });
      upstreamUrl = codexProxy.upstreamUrl;
      requestBody = codexProxy.bodyText;
      responseTransformer = codexProxy.transformResponse;
      useCodexSseHeaderTimeout =
        readBooleanField(codexProxy.bodyJson, "stream") === true;

      const webSocketResponse = await tryProxyCodexWebSocket({
        headers,
        bodyJson: codexProxy.bodyJson,
        accountKey: `${input.apiKeyId}:${input.account.id}`,
        sessionId: codexSessionId,
        upstreamSessionId: codexUpstreamSessionId,
        onTokenUsage: input.usageRecorder.onTokenUsage,
        signal: input.context.req.raw.signal,
      });
      if (webSocketResponse) {
        return {
          upstreamResponse: webSocketResponse,
          responseTransformer: null,
          canFailover: false,
        };
      }
      break;
    }

    case "copilot": {
      const copilotProxy = prepareCopilotProxyRequest({
        endpoint: input.route.endpoint,
        requestUrl: input.requestUrl,
        headers,
        bodyText: requestBody,
        bodyJson: input.requestBodyJson,
        githubAccessToken: input.account.refreshToken,
        metadata:
          input.account.metadata?.provider === "copilot"
            ? input.account.metadata
            : null,
        onTokenUsage: input.usageRecorder.onTokenUsage,
      });
      upstreamUrl = copilotProxy.upstreamUrl;
      requestBody = copilotProxy.bodyText;
      responseTransformer = copilotProxy.transformResponse;
      break;
    }

    case "claude": {
      const claudeProxy = prepareClaudeProxyRequest({
        requestUrl: input.requestUrl,
        headers,
        bodyText: requestBody,
        bodyJson: input.requestBodyJson,
        accessToken: input.account.accessToken,
        metadata:
          input.account.metadata?.provider === "claude"
            ? input.account.metadata
            : null,
        onTokenUsage: input.usageRecorder.onTokenUsage,
      });
      upstreamUrl = claudeProxy.upstreamUrl;
      requestBody = claudeProxy.bodyText;
      responseTransformer = claudeProxy.transformResponse;
      break;
    }

    default: {
      throw new Error(
        `Proxy route provider is not supported: ${input.route.provider}`
      );
    }
  }

  const headerTimeout = useCodexSseHeaderTimeout
    ? createCodexSseHeaderTimeout()
    : null;
  const upstreamRequestInit: BunFetchRequestInit = {
    method: input.context.req.method,
    headers,
    body: requestBody,
    // Provider streams can pause for minutes while a model is thinking.
    timeout: false,
  };
  if (headerTimeout) {
    upstreamRequestInit.signal = AbortSignal.any([
      input.context.req.raw.signal,
      headerTimeout.signal,
    ]);
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, upstreamRequestInit);
    return {
      upstreamResponse,
      responseTransformer,
      canFailover: true,
    };
  } catch (error) {
    const timeoutError = headerTimeout?.error();
    throw timeoutError && !input.context.req.raw.signal.aborted
      ? timeoutError
      : error;
  } finally {
    headerTimeout?.clear();
  }
};

const resolveRoutableProviderAccounts = async (
  route: ProxyRoute,
  now: number,
  accountScopeIds: readonly string[] | null | undefined,
  failoverEnabled: boolean
): Promise<ProviderAccountRecord[]> => {
  if (failoverEnabled) {
    return getRoutableProviderAccountCandidates(db, route.provider, now, {
      allowedAccountIds: accountScopeIds ?? null,
    });
  }

  const account = await getRoutableProviderAccount(db, route.provider, now, {
    allowedAccountIds: accountScopeIds ?? null,
  });
  return account ? [account] : [];
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
  const failoverEnabled = isRateLimitFailoverEnabled();
  let accounts: ProviderAccountRecord[];
  try {
    accounts = await resolveRoutableProviderAccounts(
      route,
      now,
      accountScopeIds,
      failoverEnabled
    );
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

  const account = accounts[0] ?? null;
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

  let attemptIndex = 0;
  let failoverAttempted = false;
  while (true) {
    const attemptAccount = accounts[attemptIndex];
    if (!attemptAccount) {
      usageRecorder.recordImmediate(500);
      return context.json(
        proxyErrorResponse(
          `No ${route.provider} account is available for proxy retry`,
          "account_missing"
        ),
        500
      );
    }

    providerAccountId = attemptAccount.id;

    let attempt: ProxyAttemptResult;
    try {
      attempt = await fetchUpstreamForAccount({
        context,
        route,
        requestUrl,
        requestBody,
        requestBodyJson,
        apiKeyId,
        account: attemptAccount,
        usageRecorder,
      });
    } catch (error) {
      usageRecorder.recordImmediate(500);
      throw error;
    }

    const nextAccount = accounts[attemptIndex + 1] ?? null;
    if (
      shouldRetryRateLimitWithNextAccount({
        failoverEnabled,
        failoverAttempted,
        canFailover: attempt.canFailover,
        statusCode: attempt.upstreamResponse.status,
        hasNextAccount: Boolean(nextAccount),
      }) &&
      nextAccount
    ) {
      if (shouldPersistRateLimitFailover(accountScopeIds)) {
        let updatedNextAccount: ProviderAccountRecord | null;
        try {
          updatedNextAccount = await setPrimaryProviderAccount(
            db,
            nextAccount.id,
            Date.now()
          );
        } catch (error) {
          usageRecorder.recordImmediate(500);
          throw error;
        }
        if (!updatedNextAccount) {
          let responseToClient = attempt.upstreamResponse;
          if (attempt.responseTransformer) {
            try {
              responseToClient = await attempt.responseTransformer(
                attempt.upstreamResponse
              );
              responseToClient.headers.delete("content-encoding");
            } catch (error) {
              usageRecorder.recordImmediate(500);
              throw error;
            }
          }
          usageRecorder.recordFinal(attempt.upstreamResponse.status);
          return responseToClient;
        }
        accounts[attemptIndex + 1] = updatedNextAccount;
      }

      usageRecorder.recordFinal(attempt.upstreamResponse.status);
      cancelResponseBody(attempt.upstreamResponse);
      attemptIndex += 1;
      failoverAttempted = true;
      continue;
    }

    let responseToClient = attempt.upstreamResponse;
    if (attempt.responseTransformer) {
      try {
        responseToClient = await attempt.responseTransformer(
          attempt.upstreamResponse
        );
        // Bun auto-decompresses but keeps Content-Encoding; Anthropic is the main
        // upstream that returns it, causing ZlibError on clients reading plaintext.
        responseToClient.headers.delete("content-encoding");
      } catch (error) {
        usageRecorder.recordImmediate(500);
        throw error;
      }
    }

    usageRecorder.recordFinal(attempt.upstreamResponse.status);
    return responseToClient;
  }
};

const routes = new Hono();
for (const route of proxyRouteTable) {
  routes.post(route.path, async (context) => proxyRequest(context, route));
}

export const proxyRoutes = routes;
