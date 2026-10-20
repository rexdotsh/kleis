import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { Database } from "../../db";
import { ProviderAccountOwnerConflict } from "../../db/repositories/provider-accounts";
import { providers } from "../../db/schema";
import { completeOwnerLink, startOwnerLink } from "../../domain/owner-links";
import { expireProviderAccountTracking } from "../../domain/providers/provider-account-tracking";
import { errorLogFields, logWarn } from "../../utils/log";

const linkParamsSchema = z.strictObject({
  token: z.string().regex(/^kln_[0-9a-f]{32}$/u),
});

const completeBodySchema = z.strictObject({
  provider: z.enum(providers),
  state: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(4000),
});

const expiredBody = {
  error: "not_found",
  message: "This link has expired or was already used. Ask for a new one.",
} as const;

// Public: the link token or the sign-in it started is the only credential.
export const createLinkRoutes = (database: Database) =>
  new Hono()
    .post(
      "/link/:token/start",
      zValidator("param", linkParamsSchema, (result, context) =>
        result.success ? undefined : context.json(expiredBody, 404)
      ),
      async (context) => {
        const started = await startOwnerLink(
          database,
          context.req.valid("param").token,
          Date.now()
        );
        return started ? context.json(started) : context.json(expiredBody, 404);
      }
    )
    .post(
      "/link/complete",
      zValidator("json", completeBodySchema),
      async (context) => {
        const input = context.req.valid("json");
        try {
          const account = await completeOwnerLink(database, input, Date.now());
          if (!account) {
            return context.json(expiredBody, 404);
          }
          expireProviderAccountTracking(account.id);
          return context.json({ linked: true });
        } catch (error) {
          if (error instanceof ProviderAccountOwnerConflict) {
            return context.json(
              { error: "conflict", message: error.message },
              409
            );
          }
          logWarn("owner_link_failed", {
            provider: input.provider,
            ...errorLogFields(error),
          });
          return context.json(
            {
              error: "bad_request",
              message:
                "Sign-in didn't complete. Ask for a new link and try again.",
            },
            400
          );
        }
      }
    );
