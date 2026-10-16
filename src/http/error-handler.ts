import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorLogFields, logError } from "../utils/log";
import { CodexResetIdentityUnverified } from "../db/repositories/codex-reset-redemptions";

export const installErrorHandler = (app: Hono): void => {
  app.use("*", async (context, next) => {
    context.set("requestStartedAt", Date.now());
    await next();
  });
  app.onError((error, context) => {
    const status =
      error instanceof HTTPException
        ? error.status
        : error instanceof CodexResetIdentityUnverified
          ? 409
          : 500;
    const fields = errorLogFields(error);
    if (status >= 500 && !context.req.raw.signal.aborted) {
      logError("http_request_failed", {
        method: context.req.method,
        // Route templates exclude scoped model-discovery tokens and query strings.
        path: context.req.routePath,
        status,
        elapsedMs: Date.now() - context.get("requestStartedAt"),
        ...context.get("proxyLogContext"),
        ...fields,
      });
    }
    return context.json(
      {
        error:
          error instanceof HTTPException
            ? "request_error"
            : error instanceof CodexResetIdentityUnverified
              ? "conflict"
              : "internal_error",
        message: fields.errorMessage,
      },
      status
    );
  });
};
