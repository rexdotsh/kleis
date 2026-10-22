import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const providers = ["codex", "claude"] as const;
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
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    refreshLockToken: text("refresh_lock_token"),
    refreshLockExpiresAt: integer("refresh_lock_expires_at", {
      mode: "number",
    }),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    metadataJson: text("metadata_json"),
    lastRefreshAt: integer("last_refresh_at", { mode: "number" }),
    lastRefreshStatus: text("last_refresh_status"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("provider_accounts_provider_idx").on(table.provider),
    index("provider_accounts_enabled_idx").on(table.provider, table.enabled),
    index("provider_accounts_primary_idx").on(table.provider, table.isPrimary),
    uniqueIndex("provider_accounts_primary_unique")
      .on(table.provider)
      .where(sql`${table.isPrimary} = 1`),
    uniqueIndex("provider_accounts_provider_account_unique")
      .on(table.provider, table.accountId)
      .where(sql`${table.accountId} is not null`),
  ]
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    modelsDiscoveryToken: text("models_discovery_token"),
    label: text("label"),
    providerScopeJson: text("provider_scope_json"),
    modelScopeJson: text("model_scope_json"),
    accountScopeJson: text("account_scope_json"),
    expiresAt: integer("expires_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("api_keys_key_unique").on(table.key),
    uniqueIndex("api_keys_models_discovery_token_unique").on(
      table.modelsDiscoveryToken
    ),
  ]
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider", { enum: providers }).notNull(),
  pkceVerifier: text("pkce_verifier"),
  metadataJson: text("metadata_json"),
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
});

export const requestUsageBuckets = sqliteTable(
  "request_usage_buckets",
  {
    bucketStart: integer("bucket_start", { mode: "number" }).notNull(),
    apiKeyId: text("api_key_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    provider: text("provider", { enum: providers }).notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model").notNull().default(""),
    requestCount: integer("request_count", { mode: "number" })
      .notNull()
      .default(0),
    successCount: integer("success_count", { mode: "number" })
      .notNull()
      .default(0),
    clientErrorCount: integer("client_error_count", { mode: "number" })
      .notNull()
      .default(0),
    serverErrorCount: integer("server_error_count", { mode: "number" })
      .notNull()
      .default(0),
    authErrorCount: integer("auth_error_count", { mode: "number" })
      .notNull()
      .default(0),
    rateLimitCount: integer("rate_limit_count", { mode: "number" })
      .notNull()
      .default(0),
    proxyErrorCount: integer("proxy_error_count", { mode: "number" })
      .notNull()
      .default(0),
    upstreamErrorCount: integer("upstream_error_count", { mode: "number" })
      .notNull()
      .default(0),
    totalLatencyMs: integer("total_latency_ms", { mode: "number" })
      .notNull()
      .default(0),
    maxLatencyMs: integer("max_latency_ms", { mode: "number" })
      .notNull()
      .default(0),
    inputTokens: integer("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: integer("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: integer("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: integer("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    // Tokens re-paid on main-turn prompt-cache misses.
    cacheRepaidTokens: integer("cache_repaid_tokens", { mode: "number" })
      .notNull()
      .default(0),
    inputTotalTokens: integer("input_total_tokens", { mode: "number" }),
    reasoningTokens: integer("reasoning_tokens", { mode: "number" }),
    totalTokens: integer("total_tokens", { mode: "number" }),
    lastRequestAt: integer("last_request_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketStart,
        table.apiKeyId,
        table.providerAccountId,
        table.provider,
        table.endpoint,
        table.model,
      ],
    }),
    index("request_usage_buckets_key_bucket_idx").on(
      table.apiKeyId,
      table.bucketStart
    ),
    index("request_usage_buckets_account_bucket_idx").on(
      table.providerAccountId,
      table.bucketStart
    ),
    index("request_usage_buckets_bucket_idx").on(table.bucketStart),
  ]
);

const resetSpendStatuses = [
  "pending",
  "completed",
  "failed",
  "expired",
] as const;

// One row per reset spend, written before the request is sent. At most one
// spend per account is pending, across every process sharing the database.
export const resetSpends = sqliteTable(
  "reset_spends",
  {
    requestId: text("request_id").primaryKey(),
    provider: text("provider", { enum: providers }).notNull(),
    providerAccountId: text("provider_account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    status: text("status", { enum: resetSpendStatuses }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("reset_spends_pending_unique")
      .on(table.providerAccountId)
      .where(sql`${table.status} = 'pending'`),
  ]
);

// The last known profile and limits per account, kept out of
// provider_accounts so these frequent writes never clear the proxy's routing
// lookups. account_identity is the provider account ID the data belongs to.
export const providerAccountSnapshots = sqliteTable(
  "provider_account_snapshots",
  {
    providerAccountId: text("provider_account_id")
      .primaryKey()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    accountIdentity: text("account_identity").notNull().default(""),
    profileJson: text("profile_json"),
    profileFetchedAt: integer("profile_fetched_at", { mode: "number" }),
    quotaJson: text("quota_json"),
    quotaFetchedAt: integer("quota_fetched_at", { mode: "number" }),
    lastError: text("last_error"),
    lastErrorStatus: integer("last_error_status", { mode: "number" }),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  }
);
