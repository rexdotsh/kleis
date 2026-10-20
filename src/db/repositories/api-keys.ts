import { and, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm";

import {
  apiKeys,
  providers,
  requestUsageBuckets,
  type Provider,
} from "../schema";
import type { Database } from "../index";
import { createLookupCache, invalidateLookupCaches } from "../lookup-cache";

type ScopeList = string[] | null;
type ProviderScopeList = Provider[] | null;

const isProvider = (value: string): value is Provider =>
  providers.some((provider) => provider === value);

export type ApiKeyRecord = {
  id: string;
  key: string;
  modelsDiscoveryToken: string | null;
  label: string | null;
  providerScopes: ProviderScopeList;
  modelScopes: ScopeList;
  accountScopes: ScopeList;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

export type CreateApiKeyInput = {
  label?: string | null;
  providerScopes?: Provider[] | null;
  modelScopes?: string[] | null;
  accountScopes?: string[] | null;
  expiresAt?: number | null;
};

export type UpdateApiKeyInput = {
  label: string | null;
  providerScopes: Provider[] | null;
  modelScopes: string[] | null;
  accountScopes: string[] | null;
  expiresAt: number | null;
};

const parseJsonStringList = (value: string | null): string[] => {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === "string");
};

const parseScopeList = (value: string | null): ScopeList => {
  const scopes = parseJsonStringList(value);
  return scopes.length ? scopes : null;
};

const parseProviderScopeList = (value: string | null): ProviderScopeList => {
  const scopes = parseJsonStringList(value).filter(isProvider);
  return scopes.length ? scopes : null;
};

const serializeScopeList = (
  scopes: readonly string[] | null | undefined
): string | null => {
  if (!scopes?.length) {
    return null;
  }

  const normalized = new Set<string>();
  for (const scope of scopes) {
    const value = scope.trim();
    if (value) {
      normalized.add(value);
    }
  }

  return normalized.size ? JSON.stringify(Array.from(normalized)) : null;
};

const toRecord = (row: typeof apiKeys.$inferSelect): ApiKeyRecord => ({
  id: row.id,
  key: row.key,
  modelsDiscoveryToken: row.modelsDiscoveryToken,
  label: row.label,
  providerScopes: parseProviderScopeList(row.providerScopeJson),
  modelScopes: parseScopeList(row.modelScopeJson),
  accountScopes: parseScopeList(row.accountScopeJson),
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});

export const listApiKeys = async (
  database: Database
): Promise<ApiKeyRecord[]> => {
  const rows = await database
    .select()
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toRecord);
};

export const findApiKeyById = async (
  database: Database,
  id: string
): Promise<ApiKeyRecord | null> => {
  const row = await database.query.apiKeys.findFirst({
    where: eq(apiKeys.id, id),
  });

  return row ? toRecord(row) : null;
};

const newApiKeyRow = (
  input: CreateApiKeyInput,
  now: number
): typeof apiKeys.$inferSelect => ({
  id: crypto.randomUUID(),
  key: `kleis_${crypto.randomUUID().replaceAll("-", "")}`,
  modelsDiscoveryToken: `kmd_${crypto.randomUUID().replaceAll("-", "")}`,
  label: input.label?.trim() || null,
  providerScopeJson: serializeScopeList(input.providerScopes),
  modelScopeJson: serializeScopeList(input.modelScopes),
  accountScopeJson: serializeScopeList(input.accountScopes),
  expiresAt: input.expiresAt ?? null,
  revokedAt: null,
  createdAt: now,
});

export const createApiKey = async (
  database: Database,
  input: CreateApiKeyInput,
  now: number
): Promise<ApiKeyRecord> => {
  const row = newApiKeyRow(input, now);
  await database.insert(apiKeys).values(row);
  invalidateLookupCaches();
  return toRecord(row);
};

// Creates a key with the same settings; revoking the old one happens in the
// same batch, so a failure leaves neither change.
export const rotateApiKey = async (
  database: Database,
  existing: ApiKeyRecord,
  revokeOld: boolean,
  now: number
): Promise<ApiKeyRecord> => {
  const row = newApiKeyRow(
    {
      label: existing.label,
      providerScopes: existing.providerScopes,
      modelScopes: existing.modelScopes,
      accountScopes: existing.accountScopes,
      expiresAt:
        existing.expiresAt !== null && existing.expiresAt > now
          ? existing.expiresAt
          : null,
    },
    now
  );
  const insert = database.insert(apiKeys).values(row);
  try {
    if (revokeOld) {
      await database.batch([
        database
          .update(apiKeys)
          .set({ revokedAt: now })
          .where(and(eq(apiKeys.id, existing.id), isNull(apiKeys.revokedAt))),
        insert,
      ]);
    } else {
      await insert;
    }
  } finally {
    invalidateLookupCaches();
  }
  return toRecord(row);
};

export const revokeApiKey = async (
  database: Database,
  id: string,
  now: number
): Promise<boolean> => {
  const result = await database
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
  invalidateLookupCaches();

  return result.rowsAffected > 0;
};

export const updateApiKey = async (
  database: Database,
  id: string,
  input: UpdateApiKeyInput
): Promise<ApiKeyRecord | null> => {
  const result = await database
    .update(apiKeys)
    .set({
      label: input.label,
      providerScopeJson: serializeScopeList(input.providerScopes),
      modelScopeJson: serializeScopeList(input.modelScopes),
      accountScopeJson: serializeScopeList(input.accountScopes),
      expiresAt: input.expiresAt,
    })
    .where(eq(apiKeys.id, id));
  invalidateLookupCaches();

  if (result.rowsAffected === 0) {
    return null;
  }

  return findApiKeyById(database, id);
};

type DeleteRevokedApiKeyResult = "deleted" | "not_found" | "not_revoked";

export const deleteRevokedApiKey = async (
  database: Database,
  id: string
): Promise<DeleteRevokedApiKeyResult> => {
  const result = await database.transaction(async (tx) => {
    const key = await tx.query.apiKeys.findFirst({
      columns: {
        id: true,
        revokedAt: true,
      },
      where: eq(apiKeys.id, id),
    });

    if (!key) {
      return "not_found";
    }

    if (key.revokedAt === null) {
      return "not_revoked";
    }

    await tx
      .delete(requestUsageBuckets)
      .where(eq(requestUsageBuckets.apiKeyId, id));
    await tx.delete(apiKeys).where(eq(apiKeys.id, id));

    return "deleted" as const;
  });
  invalidateLookupCaches();
  return result;
};

const API_KEY_CACHE_TTL_MS = 30_000;
const apiKeyByValueCache = createLookupCache<ApiKeyRecord | null>(
  API_KEY_CACHE_TTL_MS
);

const isActiveAt = (record: ApiKeyRecord, now: number): boolean =>
  record.revokedAt === null &&
  (record.expiresAt === null || record.expiresAt > now);

export const findActiveApiKeyByValue = async (
  database: Database,
  keyValue: string,
  now: number
): Promise<ApiKeyRecord | null> => {
  const record = await apiKeyByValueCache.get(database, keyValue, () =>
    findActiveApiKey(database, eq(apiKeys.key, keyValue), now)
  );
  return record && isActiveAt(record, now) ? record : null;
};

const findActiveApiKey = async (
  database: Database,
  predicate: SQL,
  now: number
): Promise<ApiKeyRecord | null> => {
  const row = await database.query.apiKeys.findFirst({
    where: and(
      predicate,
      isNull(apiKeys.revokedAt),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
    ),
  });

  return row ? toRecord(row) : null;
};

export const findActiveApiKeyByModelsDiscoveryToken = (
  database: Database,
  modelsDiscoveryToken: string,
  now: number
): Promise<ApiKeyRecord | null> =>
  findActiveApiKey(
    database,
    eq(apiKeys.modelsDiscoveryToken, modelsDiscoveryToken),
    now
  );
