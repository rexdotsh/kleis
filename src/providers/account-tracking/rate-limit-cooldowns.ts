import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import type { LiveLimits } from "./live-limits";

const identity = (account: ProviderAccountRecord): string =>
  JSON.stringify([
    account.provider,
    account.accountId,
    account.metadata?.provider === "codex"
      ? account.metadata.chatgptAccountId
      : null,
    account.metadata?.provider === "claude"
      ? account.metadata.accountUuid
      : null,
    account.metadata?.provider === "claude"
      ? account.metadata.organizationUuid
      : null,
  ]);

const windowUsage = (limits: LiveLimits): Record<string, number | undefined> =>
  limits.provider === "claude"
    ? Object.fromEntries(
        Object.entries(limits.windows).map(([key, window]) => [
          key,
          window.utilization ?? undefined,
        ])
      )
    : {
        primary: limits.primaryWindow?.usedPercent,
        secondary: limits.secondaryWindow?.usedPercent,
      };

type Cooldown = {
  reset: number;
  windows: Set<string>;
};

type AccountState = {
  identity: string;
  provider: Provider;
  cooldown: Cooldown | null;
};

export type AccountCooldownObservation = {
  mark(reset: number, limits?: LiveLimits | null): void;
  observe(limits: LiveLimits): void;
};

export const createAccountCooldowns = () => {
  const states = new Map<string, AccountState>();
  return {
    resetAt(account: ProviderAccountRecord, now = Date.now()): number {
      const entry = states.get(account.id);
      if (!entry?.cooldown || entry.identity !== identity(account)) return 0;
      if (entry.cooldown.reset > now) return entry.cooldown.reset;
      states.delete(account.id);
      return 0;
    },
    capture(account: ProviderAccountRecord): AccountCooldownObservation {
      const accountIdentity = identity(account);
      const current = states.get(account.id);
      let revision: AccountState =
        current?.identity === accountIdentity
          ? current
          : {
              identity: accountIdentity,
              provider: account.provider,
              cooldown: null,
            };
      states.set(account.id, revision);
      // A revision includes an empty cooldown so clears also fence pending 429s.
      // Only this observation can advance its revision after applying an update.
      const commit = (cooldown: Cooldown | null): void => {
        revision = { ...revision, cooldown };
        states.set(account.id, revision);
      };
      return {
        mark(reset, limits = null): void {
          if (states.get(account.id) !== revision) return;
          const previous = revision.cooldown;
          const exhausted = limits
            ? Object.entries(windowUsage(limits))
                .filter(
                  ([, percent]) => percent !== undefined && percent >= 100
                )
                .map(([key]) => key)
            : [];
          const windows = exhausted.length
            ? exhausted
            : account.provider === "claude"
              ? ["five_hour", "seven_day"]
              : ["primary", "secondary"];
          commit({
            reset: Math.max(previous?.reset ?? 0, reset),
            windows: new Set([...(previous?.windows ?? []), ...windows]),
          });
        },
        observe(limits): void {
          if (
            states.get(account.id) !== revision ||
            limits.provider !== account.provider
          )
            return;
          const previous = revision.cooldown;
          if (!previous) {
            commit(null);
            return;
          }
          const windows = new Set(previous.windows);
          for (const [key, percent] of Object.entries(windowUsage(limits))) {
            if (percent === undefined) continue;
            if (percent >= 100) windows.add(key);
            else windows.delete(key);
          }
          commit(windows.size ? { ...previous, windows } : null);
        },
      };
    },
    clear(id: string): void {
      states.delete(id);
    },
    clearChangedIdentity(account: ProviderAccountRecord): void {
      const entry = states.get(account.id);
      if (entry && entry.identity !== identity(account))
        states.delete(account.id);
    },
    clearProvider(provider: Provider): void {
      for (const [id, entry] of states) {
        if (entry.provider === provider) states.delete(id);
      }
    },
  };
};

export const accountCooldowns = createAccountCooldowns();
