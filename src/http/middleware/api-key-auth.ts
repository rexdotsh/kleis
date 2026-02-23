import { createMiddleware } from "hono/factory";

import { dbFromContext } from "../../db/client";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
import type { AppEnv } from "../app-env";
import { parseBearerToken } from "../utils/bearer";
import {
  endpointFromPath,
  isProviderSupportedForEndpoint,
  parseProviderPrefixedModel,
  readModelFromBody,
  resolveTargetProvider,
} from "../v1-routing";

const readRequestedModel = async (request: Request): Promise<string | null> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  return readModelFromBody(body);
};

export const requireProxyApiKey = createMiddleware<AppEnv>(
  async (context, next) => {
    const token = parseBearerToken(context.req.header("authorization"));
    if (!token) {
      return context.json(
        {
          error: "unauthorized",
          message: "Missing bearer API key",
        },
        401
      );
    }

    const database = dbFromContext(context);
    const apiKey = await findActiveApiKeyByValue(database, token, Date.now());
    if (!apiKey) {
      return context.json(
        {
          error: "unauthorized",
          message: "Invalid or expired API key",
        },
        401
      );
    }

    const endpoint = endpointFromPath(context.req.path);
    const requestedModel = endpoint
      ? await readRequestedModel(context.req.raw)
      : null;
    const requestedModelRoute = parseProviderPrefixedModel(requestedModel);

    if (endpoint && apiKey.providerScopes?.length) {
      const targetProvider = resolveTargetProvider(
        endpoint,
        requestedModelRoute.provider
      );
      if (!isProviderSupportedForEndpoint(endpoint, targetProvider)) {
        return context.json(
          {
            error: "bad_request",
            message: `Provider ${targetProvider} is not valid for this endpoint`,
          },
          400
        );
      }

      if (!apiKey.providerScopes.includes(targetProvider)) {
        return context.json(
          {
            error: "forbidden",
            message: `API key is not allowed to access provider: ${targetProvider}`,
          },
          403
        );
      }
    }

    if (endpoint && apiKey.modelScopes?.length) {
      const modelCandidates = [
        requestedModelRoute.rawModel,
        requestedModelRoute.upstreamModel,
      ].filter((value): value is string => Boolean(value));
      const allowed = modelCandidates.some((candidate) =>
        apiKey.modelScopes?.includes(candidate)
      );
      if (!allowed) {
        const deniedModel = requestedModelRoute.rawModel ?? null;
        return context.json(
          {
            error: "forbidden",
            message: deniedModel
              ? `API key is not allowed to access model: ${deniedModel}`
              : "API key model scope requires an explicit model field",
          },
          403
        );
      }
    }

    await next();
  }
);
