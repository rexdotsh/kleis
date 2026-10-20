import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { Database } from "../../db";
import {
  listOwnedProviderAccounts,
  unlinkOwnedProviderAccount,
} from "../../db/repositories/provider-accounts";
import { providers, type Provider } from "../../db/schema";
import { createOwnerLink } from "../../domain/owner-links";
import { ownerIdSchema, ownerLabelSchema } from "../../domain/owners";
import { describeAccountLimits } from "../../domain/providers/account-limits";
import { describeAccountHealth } from "../../domain/providers/provider-account-health";
import { providerAccountSnapshotsRestored } from "../../domain/providers/provider-account-tracking";
import { resolveExternalRequestUrl } from "../utils/request-origin";

const createLinkBodySchema = z.strictObject({
  owner: ownerIdSchema,
  label: ownerLabelSchema,
  provider: z.enum(providers),
});

const ownerParamsSchema = z.strictObject({ owner: ownerIdSchema });

const ownedAccountParamsSchema = ownerParamsSchema.extend({
  id: z.string().trim().min(1).max(120),
});

// Called with delegate keys only; each key sees only its providers.
export const createOwnerRoutes = (database: Database) => {
  const ownedAccounts = async (
    owner: string,
    providerScopes: readonly Provider[] | null
  ) => {
    const [accounts] = await Promise.all([
      listOwnedProviderAccounts(database, owner, providerScopes),
      providerAccountSnapshotsRestored(),
    ]);
    return accounts;
  };

  return new Hono()
    .post(
      "/links",
      zValidator("json", createLinkBodySchema),
      async (context) => {
        const { owner, label, provider } = context.req.valid("json");
        const apiKey = context.get("apiKey");
        if (
          apiKey.providerScopes &&
          !apiKey.providerScopes.includes(provider)
        ) {
          return context.json(
            {
              error: "forbidden",
              message: `API key is not allowed to access provider: ${provider}`,
            },
            403
          );
        }
        const link = await createOwnerLink(
          database,
          { provider, owner: { id: owner, label }, app: apiKey.label },
          Date.now()
        );
        const origin = resolveExternalRequestUrl(context.req.raw).origin;
        return context.json(
          { url: `${origin}/link/${link.token}`, expiresAt: link.expiresAt },
          201
        );
      }
    )
    .get(
      "/owners/:owner",
      zValidator("param", ownerParamsSchema),
      async (context) => {
        const { owner } = context.req.valid("param");
        const now = Date.now();
        const accounts = await ownedAccounts(
          owner,
          context.get("apiKey").providerScopes
        );
        return context.json({
          owner,
          accounts: accounts.map((account) => ({
            id: account.id,
            provider: account.provider,
            label: account.label,
            enabled: account.enabled,
            linkedAt: account.createdAt,
            ...describeAccountHealth(account, now),
          })),
        });
      }
    )
    .get(
      "/owners/:owner/limits",
      zValidator("param", ownerParamsSchema),
      async (context) => {
        const { owner } = context.req.valid("param");
        const accounts = await ownedAccounts(
          owner,
          context.get("apiKey").providerScopes
        );
        return context.json({
          owner,
          accounts: accounts.map(describeAccountLimits),
        });
      }
    )
    .delete(
      "/owners/:owner/accounts/:id",
      zValidator("param", ownedAccountParamsSchema),
      async (context) => {
        const { owner, id } = context.req.valid("param");
        const unlinked = await unlinkOwnedProviderAccount(
          database,
          {
            id,
            ownerId: owner,
            providerScopes: context.get("apiKey").providerScopes,
          },
          Date.now()
        );
        return unlinked
          ? context.json({ unlinked: true })
          : context.json(
              { error: "not_found", message: "Linked account not found" },
              404
            );
      }
    );
};
