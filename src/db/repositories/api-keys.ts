import { and, desc, eq, gt, isNull, or } from "drizzle-orm";

import { apiKeys } from "../schema";
import type { Database } from "../client";

type ScopeList = string[] | null;

export type ApiKeyRecord = {
  id: string;
  key: string;
  label: string | null;
  providerScopes: ScopeList;
  modelScopes: ScopeList;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

export type CreateApiKeyInput = {
  label?: string | null;
  providerScopes?: string[];
  modelScopes?: string[];
  expiresAt?: number | null;
};

const parseScopeList = (value: string | null): ScopeList => {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const scopes: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      scopes.push(item);
    }
  }

  return scopes;
};

const toRecord = (row: typeof apiKeys.$inferSelect): ApiKeyRecord => ({
  id: row.id,
  key: row.key,
  label: row.label,
  providerScopes: parseScopeList(row.providerScopeJson),
  modelScopes: parseScopeList(row.modelScopeJson),
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

const generateApiKeyValue = (): string =>
  `kleis_${crypto.randomUUID().replaceAll("-", "")}`;

export const createApiKey = async (
  database: Database,
  input: CreateApiKeyInput,
  now: number
): Promise<ApiKeyRecord> => {
  const row: typeof apiKeys.$inferInsert = {
    id: crypto.randomUUID(),
    key: generateApiKeyValue(),
    label: input.label?.trim() || null,
    providerScopeJson: input.providerScopes?.length
      ? JSON.stringify(input.providerScopes)
      : null,
    modelScopeJson: input.modelScopes?.length
      ? JSON.stringify(input.modelScopes)
      : null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: now,
  };

  await database.insert(apiKeys).values(row);
  return toRecord({
    ...row,
    label: row.label ?? null,
    providerScopeJson: row.providerScopeJson ?? null,
    modelScopeJson: row.modelScopeJson ?? null,
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
  });
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

  return result.meta.changes > 0;
};

export const findActiveApiKeyByValue = async (
  database: Database,
  keyValue: string,
  now: number
): Promise<ApiKeyRecord | null> => {
  const row = await database.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.key, keyValue),
      isNull(apiKeys.revokedAt),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
    ),
  });

  if (!row) {
    return null;
  }

  return toRecord(row);
};
