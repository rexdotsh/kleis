import { Hono, type Context } from "hono";

import { db } from "../../db";
import {
  MISSING_PROVIDER_ACCOUNT_ID,
  recordRequestUsage,
  recordTokenUsage,
} from "../../db/repositories/request-usage";
import { getRoutableProviderAccount } from "../../domain/providers/provider-service";
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

const readString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
};

const arrayLength = (value: unknown): number | null =>
  Array.isArray(value) ? value.length : null;

const countByStringField = (
  values: readonly unknown[],
  field: string
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = isObjectRecord(value) ? readString(value[field]) : null;
    counts[key ?? "missing"] = (counts[key ?? "missing"] ?? 0) + 1;
  }
  return counts;
};

const readContentTypes = (value: unknown): string[] | null => {
  if (!isObjectRecord(value) || !Array.isArray(value.content)) {
    return null;
  }
  return value.content.map((item) => {
    if (!isObjectRecord(item)) {
      return typeof item;
    }
    return readString(item.type) ?? "missing";
  });
};

const summarizeInputShape = (input: unknown) => {
  if (!Array.isArray(input)) {
    return {
      inputItems: null,
      inputTypes: {},
      inputRoles: {},
      lastItem: null,
    };
  }

  const last = input.at(-1);
  return {
    inputItems: input.length,
    inputTypes: countByStringField(input, "type"),
    inputRoles: countByStringField(input, "role"),
    lastItem: isObjectRecord(last)
      ? {
          type: readString(last.type),
          role: readString(last.role),
          keys: Object.keys(last).sort(),
          contentTypes: readContentTypes(last),
        }
      : null,
  };
};

const readCodexSessionSource = (body: unknown, headers: Headers): string => {
  if (isObjectRecord(body) && readString(body.prompt_cache_key)) {
    return "prompt_cache_key";
  }
  for (const header of ["session_id", "session-id", "x-session-affinity"]) {
    if (readString(headers.get(header))) {
      return header;
    }
  }
  return "none";
};

const logCodexCompactionDiagnostic = (
  payload: Record<string, unknown>
): void => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

const logCodexRequestDiagnostic = (input: {
  body: unknown;
  headers: Headers;
  sessionHash: string | null;
  sessionSource: string;
}): void => {
  const body = isObjectRecord(input.body) ? input.body : null;
  const inputShape = summarizeInputShape(body?.input);
  logCodexCompactionDiagnostic({
    event: "codex_compaction_request",
    model: readString(body?.model),
    sessionHash: input.sessionHash,
    sessionSource: input.sessionSource,
    stream: body ? body.stream === true : null,
    background: body ? body.background === true : null,
    store: body ? body.store === true : null,
    hasPreviousResponseId: typeof body?.previous_response_id === "string",
    hasPromptCacheKey: typeof body?.prompt_cache_key === "string",
    topLevelKeys: body ? Object.keys(body).sort() : [],
    includeItems: arrayLength(body?.include),
    tools: arrayLength(body?.tools),
    hasInstructions: typeof body?.instructions === "string",
    reasoningKeys: isObjectRecord(body?.reasoning)
      ? Object.keys(body.reasoning).sort()
      : null,
    textKeys: isObjectRecord(body?.text) ? Object.keys(body.text).sort() : null,
    incomingSessionHeaders: {
      session_id: Boolean(readString(input.headers.get("session_id"))),
      sessionId: Boolean(readString(input.headers.get("session-id"))),
      xSessionAffinity: Boolean(
        readString(input.headers.get("x-session-affinity"))
      ),
      xClientRequestId: Boolean(
        readString(input.headers.get("x-client-request-id"))
      ),
    },
    ...inputShape,
  });
};

const logCodexUsageDiagnostic = (input: {
  model: string;
  sessionHash: string | null;
  sessionSource: string;
  usage: TokenUsage;
}): void => {
  logCodexCompactionDiagnostic({
    event: "codex_compaction_usage",
    model: input.model,
    sessionHash: input.sessionHash,
    sessionSource: input.sessionSource,
    inputTokens: input.usage.inputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    totalInputTokens:
      input.usage.inputTokens +
      input.usage.cacheReadTokens +
      input.usage.cacheWriteTokens,
    outputTokens: input.usage.outputTokens,
  });
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
  let useCodexSseHeaderTimeout = false;

  switch (route.provider) {
    case "codex": {
      const codexSessionId = readCodexSessionId(requestBodyJson, headers);
      const codexUpstreamSessionId = codexSessionId
        ? await deriveCodexSessionId(
            `${apiKeyId}:${account.id}`,
            codexSessionId
          )
        : null;
      const codexSessionSource = readCodexSessionSource(
        requestBodyJson,
        headers
      );
      const codexSessionHash = codexUpstreamSessionId
        ? codexUpstreamSessionId.replace(/^kleis_/, "").slice(0, 16)
        : null;
      const codexIncomingHeaders = new Headers(headers);
      const onCodexTokenUsage = (tokenUsage: TokenUsage): void => {
        usageRecorder.onTokenUsage(tokenUsage);
        logCodexUsageDiagnostic({
          model: usageModel,
          sessionHash: codexSessionHash,
          sessionSource: codexSessionSource,
          usage: tokenUsage,
        });
      };
      const codexProxy = prepareCodexProxyRequest({
        headers,
        accessToken: account.accessToken,
        accountId: account.accountId,
        metadata:
          account.metadata?.provider === "codex" ? account.metadata : null,
        bodyText: requestBody,
        bodyJson: requestBodyJson,
        sessionId: codexUpstreamSessionId,
        onTokenUsage: onCodexTokenUsage,
      });
      upstreamUrl = codexProxy.upstreamUrl;
      requestBody = codexProxy.bodyText;
      responseTransformer = codexProxy.transformResponse;
      useCodexSseHeaderTimeout =
        readBooleanField(codexProxy.bodyJson, "stream") === true;
      logCodexRequestDiagnostic({
        body: codexProxy.bodyJson,
        headers: codexIncomingHeaders,
        sessionHash: codexSessionHash,
        sessionSource: codexSessionSource,
      });

      const webSocketResponse = await tryProxyCodexWebSocket({
        headers,
        bodyJson: codexProxy.bodyJson,
        accountKey: `${apiKeyId}:${account.id}`,
        sessionId: codexSessionId,
        upstreamSessionId: codexUpstreamSessionId,
        onTokenUsage: onCodexTokenUsage,
        signal: context.req.raw.signal,
      });
      if (webSocketResponse) {
        usageRecorder.recordFinal(webSocketResponse.status);
        return webSocketResponse;
      }
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
    const headerTimeout = useCodexSseHeaderTimeout
      ? createCodexSseHeaderTimeout()
      : null;
    const upstreamRequestInit: BunFetchRequestInit = {
      method: context.req.method,
      headers,
      body: requestBody,
      // Provider streams can pause for minutes while a model is thinking.
      timeout: false,
    };
    if (headerTimeout) {
      upstreamRequestInit.signal = AbortSignal.any([
        context.req.raw.signal,
        headerTimeout.signal,
      ]);
    }
    try {
      upstreamResponse = await fetch(upstreamUrl, upstreamRequestInit);
    } catch (error) {
      const timeoutError = headerTimeout?.error();
      throw timeoutError && !context.req.raw.signal.aborted
        ? timeoutError
        : error;
    } finally {
      headerTimeout?.clear();
    }
  } catch (error) {
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
