import type { Database } from "../../db";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import { isAccessGatedCodexModel } from "../models/models-dev";
import { fetchCodexModels } from "../../providers/account-tracking/codex";
import { errorLogFields, logWarn } from "../../utils/log";
import {
  isTrackingAccount,
  resolveAccount,
  retryAfter401,
} from "./provider-account-tracking";

const ACCESS_CACHE_MS = 10 * 60_000;
const ACCESS_RETRY_MS = 60_000;

// Access-gated model slug to the cyber access programs the account's catalog
// advertises for it.
type CodexModelAccess = ReadonlyMap<string, readonly string[]>;

type AccessEntry = { expiresAt: number; access: CodexModelAccess | null };

const entries = new Map<string, AccessEntry>();
const inFlight = new Map<string, Promise<CodexModelAccess | null>>();

const accessKey = (account: ProviderAccountRecord): string =>
  `${account.id}:${account.accountId ?? ""}`;

const loadCodexModelAccess = async (
  database: Database,
  account: ProviderAccountRecord
): Promise<CodexModelAccess | null> => {
  const key = accessKey(account);
  const previous = entries.get(key)?.access ?? null;
  try {
    const resolved = isTrackingAccount(account)
      ? await resolveAccount(database, account)
      : null;
    if (!resolved) {
      throw new Error("Codex account credentials are unavailable");
    }
    const models = await retryAfter401(database, resolved, (current) =>
      fetchCodexModels(current.accessToken, current.accountId)
    );
    const access = new Map(
      models
        .filter((model) => isAccessGatedCodexModel(model.slug))
        .map((model) => [model.slug.toLowerCase(), model.cyberAccessPrograms])
    );
    entries.set(key, { expiresAt: Date.now() + ACCESS_CACHE_MS, access });
    return access;
  } catch (error) {
    logWarn("codex_model_access_fetch_failed", {
      provider: account.provider,
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
    entries.set(key, {
      expiresAt: Date.now() + ACCESS_RETRY_MS,
      access: previous,
    });
    return previous;
  }
};

// An account whose catalog was never read has no gated models.
const getCodexModelAccess = (
  database: Database,
  account: ProviderAccountRecord
): Promise<CodexModelAccess | null> => {
  const key = accessKey(account);
  const cached = entries.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.access);
  }
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const request = loadCodexModelAccess(database, account).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
};

export const codexAccountCanUseModel = async (
  database: Database,
  account: ProviderAccountRecord,
  model: string
): Promise<boolean> =>
  (await getCodexModelAccess(database, account))?.has(model.toLowerCase()) ??
  false;

export const listAccessibleCodexModels = async (
  database: Database,
  accounts: readonly ProviderAccountRecord[]
): Promise<Set<string>> => {
  const accesses = await Promise.all(
    accounts
      .filter((account) => account.provider === "codex" && account.enabled)
      .map((account) => getCodexModelAccess(database, account))
  );
  return new Set(accesses.flatMap((access) => [...(access?.keys() ?? [])]));
};

// Codex sends the Daybreak program a model advertises, Blue before Red.
// https://github.com/openai/codex/blob/f752c97f7d0be0cbef5cece327f52a16ad6fb1c6/codex-rs/protocol/src/openai_models/access_programs.rs#L21-L29
export const codexDaybreakAccessProgram = async (
  database: Database,
  account: ProviderAccountRecord,
  model: string
): Promise<string | null> => {
  const programs =
    (await getCodexModelAccess(database, account))?.get(model.toLowerCase()) ??
    [];
  return (
    ["daybreak_blue", "daybreak_red"].find((program) =>
      programs.includes(program)
    ) ?? null
  );
};
