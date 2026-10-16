import { and, desc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

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

type ApiKeyRecord = {
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
  providerScopes?: Provider[];
  modelScopes?: string[];
  accountScopes?: string[];
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

export const createApiKey = async (
  database: Database,
  input: CreateApiKeyInput,
  now: number
): Promise<ApiKeyRecord> => {
  const row: typeof apiKeys.$inferSelect = {
    id: crypto.randomUUID(),
    key: `kleis_${crypto.randomUUID().replaceAll("-", "")}`,
    modelsDiscoveryToken: `kmd_${crypto.randomUUID().replaceAll("-", "")}`,
    label: input.label?.trim() || null,
    providerScopeJson: serializeScopeList(input.providerScopes),
    modelScopeJson: serializeScopeList(input.modelScopes),
    accountScopeJson: serializeScopeList(input.accountScopes),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    rotatedToId: null,
    createdAt: now,
  };

  await database.insert(apiKeys).values(row);
  invalidateLookupCaches();
  return toRecord(row);
};

export const rotateApiKey = async (
  database: Database,
  id: string,
  now: number,
  revokeOld = true
): Promise<ApiKeyRecord | null> => {
  const replacementId = crypto.randomUUID();
  const keyValue = `kleis_${crypto.randomUUID().replaceAll("-", "")}`;
  const modelsToken = `kmd_${crypto.randomUUID().replaceAll("-", "")}`;
  const [, replacements] = await database.batch([
    database
      .update(apiKeys)
      .set({
        rotatedToId: replacementId,
        ...(revokeOld ? { revokedAt: now } : {}),
      })
      .where(
        and(
          eq(apiKeys.id, id),
          isNull(apiKeys.revokedAt),
          isNull(apiKeys.rotatedToId),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
        )
      ),
    database
      .insert(apiKeys)
      .select(
        database
          .select({
            id: sql<string>`${replacementId}`.as("id"),
            key: sql<string>`${keyValue}`.as("key"),
            modelsDiscoveryToken: sql<string>`${modelsToken}`.as(
              "models_discovery_token"
            ),
            label: apiKeys.label,
            providerScopeJson: apiKeys.providerScopeJson,
            modelScopeJson: apiKeys.modelScopeJson,
            accountScopeJson: apiKeys.accountScopeJson,
            expiresAt: apiKeys.expiresAt,
            revokedAt: sql<null>`null`.as("revoked_at"),
            rotatedToId: sql<null>`null`.as("rotated_to_id"),
            createdAt: sql<number>`${now}`.as("created_at"),
          })
          .from(apiKeys)
          .where(
            and(eq(apiKeys.id, id), eq(apiKeys.rotatedToId, replacementId))
          )
      )
      .returning(),
  ]);
  invalidateLookupCaches();
  return replacements[0] ? toRecord(replacements[0]) : null;
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
