import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const providers = ["copilot", "codex", "claude"] as const;
export type Provider = (typeof providers)[number];

export const providerAccounts = sqliteTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: providers }).notNull(),
    label: text("label"),
    accountId: text("account_id"),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    metadataJson: text("metadata_json"),
    lastRefreshAt: integer("last_refresh_at", { mode: "number" }),
    lastRefreshStatus: text("last_refresh_status"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("provider_accounts_provider_idx").on(table.provider),
    index("provider_accounts_primary_idx").on(table.provider, table.isPrimary),
    index("provider_accounts_provider_account_idx").on(
      table.provider,
      table.accountId
    ),
  ]
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    label: text("label"),
    providerScopeJson: text("provider_scope_json"),
    modelScopeJson: text("model_scope_json"),
    expiresAt: integer("expires_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("api_keys_key_unique").on(table.key)]
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider", { enum: providers }).notNull(),
  pkceVerifier: text("pkce_verifier"),
  metadataJson: text("metadata_json"),
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
});
