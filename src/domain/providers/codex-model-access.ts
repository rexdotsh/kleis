import type { Database } from "../../db";
import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import { isAccessGatedCodexModel } from "../models/models-dev";
import { fetchCodexModels } from "../../providers/account-tracking/codex";
import { errorLogFields, logWarn } from "../../utils/log";
import { normalizeStringList } from "../../utils/string-list";
import {
  isTrackingAccount,
  resolveAccount,
  retryAfter401,
} from "./provider-account-tracking";
import { findRoutingCandidates } from "./provider-service";

const ACCESS_CACHE_MS = 10 * 60_000;
const ACCESS_RETRY_MS = 60_000;
// A failing catalog keeps the last read access for at most this long.
const ACCESS_MAX_AGE_MS = 24 * 60 * 60_000;
const PROXY_ACCESS_WAIT_MS = 5000;

// Access-gated model slug to the cyber access programs the account's catalog
// advertises for it.
type CodexModelAccess = ReadonlyMap<string, readonly string[]>;

type AccessEntry = {
  expiresAt: number;
  access: CodexModelAccess | null;
  readAt: number | null;
};

const entries = new Map<string, AccessEntry>();
const inFlight = new Map<string, Promise<CodexModelAccess | null>>();

const accessKey = (account: ProviderAccountRecord): string =>
  `${account.id}:${account.accountId ?? ""}`;

// An account whose catalog was never read, or not read successfully in a
// day, has no gated models.
const usableAccess = (
  entry: AccessEntry | undefined
): CodexModelAccess | null => {
  const readAt = entry?.readAt ?? null;
  return readAt !== null && Date.now() - readAt < ACCESS_MAX_AGE_MS
    ? (entry?.access ?? null)
    : null;
};

const loadCodexModelAccess = async (
  database: Database,
  account: ProviderAccountRecord
): Promise<CodexModelAccess | null> => {
  const key = accessKey(account);
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
    const now = Date.now();
    entries.set(key, { expiresAt: now + ACCESS_CACHE_MS, access, readAt: now });
    return access;
  } catch (error) {
    logWarn("codex_model_access_fetch_failed", {
      provider: account.provider,
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
    const previous = entries.get(key);
    entries.set(key, {
      expiresAt: Date.now() + ACCESS_RETRY_MS,
      access: previous?.access ?? null,
      readAt: previous?.readAt ?? null,
    });
    return usableAccess(entries.get(key));
  }
};

const refreshCodexModelAccess = (
  database: Database,
  account: ProviderAccountRecord
): Promise<CodexModelAccess | null> => {
  const key = accessKey(account);
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

// Returns the cached access at once, refreshing it in the background when it
// is missing or expired.
const peekCodexModelAccess = (
  database: Database,
  account: ProviderAccountRecord
): CodexModelAccess | null => {
  const entry = entries.get(accessKey(account));
  if (!entry || entry.expiresAt <= Date.now()) {
    refreshCodexModelAccess(database, account).catch(() => undefined);
  }
  return usableAccess(entry);
};

// A proxied request needs a current answer, so it waits for a missing or
// expired one, up to a bound, then falls back to the cached access.
const getCodexModelAccess = async (
  database: Database,
  account: ProviderAccountRecord
): Promise<CodexModelAccess | null> => {
  const entry = entries.get(accessKey(account));
  if (entry && entry.expiresAt > Date.now()) {
    return usableAccess(entry);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PROXY_ACCESS_WAIT_MS);
  });
  try {
    const result = await Promise.race([
      refreshCodexModelAccess(database, account),
      timedOut,
    ]);
    return result === "timeout"
      ? usableAccess(entries.get(accessKey(account)))
      : result;
  } finally {
    clearTimeout(timer);
  }
};

export const codexAccountCanUseModel = async (
  database: Database,
  account: ProviderAccountRecord,
  model: string
): Promise<boolean> =>
  (await getCodexModelAccess(database, account))?.has(model.toLowerCase()) ??
  false;

// Sorted gated Codex models that an account a key routes to (its pinned
// Codex accounts, or the primary) can use, from cached catalogs only.
export const listAccessibleCodexModels = async (
  database: Database,
  input: {
    configuredProviders: readonly Provider[];
    providerScopes: readonly string[] | null;
    accountScopes: readonly string[] | null;
  }
): Promise<string[]> => {
  const providerScopes = normalizeStringList(input.providerScopes);
  if (
    !input.configuredProviders.includes("codex") ||
    (providerScopes && !providerScopes.includes("codex"))
  ) {
    return [];
  }
  const candidates = await findRoutingCandidates(
    database,
    "codex",
    input.accountScopes
  );
  const models = new Set<string>();
  for (const account of candidates) {
    if (account.provider !== "codex" || !account.enabled) {
      continue;
    }
    for (const model of peekCodexModelAccess(database, account)?.keys() ?? []) {
      models.add(model);
    }
  }
  return [...models].sort();
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
