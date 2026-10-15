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
  identity: string;
  provider: Provider;
  reset: number;
  windows: Set<string>;
};

export const createAccountCooldowns = () => {
  const resets = new Map<string, Cooldown>();
  return {
    resetAt(account: ProviderAccountRecord, now = Date.now()): number {
      const entry = resets.get(account.id);
      if (!entry || entry.identity !== identity(account)) return 0;
      if (entry.reset > now) return entry.reset;
      resets.delete(account.id);
      return 0;
    },
    mark(
      account: ProviderAccountRecord,
      reset: number,
      limits: LiveLimits | null = null,
      now = Date.now()
    ): void {
      for (const [key, value] of resets) {
        if (value.reset <= now) resets.delete(key);
      }
      const current = resets.get(account.id);
      const previous =
        current?.identity === identity(account) ? current : undefined;
      const exhausted = limits
        ? Object.entries(windowUsage(limits))
            .filter(([, percent]) => percent !== undefined && percent >= 100)
            .map(([key]) => key)
        : [];
      const windows = exhausted.length
        ? exhausted
        : account.provider === "claude"
          ? ["five_hour", "seven_day"]
          : ["primary", "secondary"];
      resets.set(account.id, {
        identity: identity(account),
        provider: account.provider,
        reset: Math.max(previous?.reset ?? 0, reset),
        windows: new Set([...(previous?.windows ?? []), ...windows]),
      });
    },
    clear(id: string): void {
      resets.delete(id);
    },
    clearChangedIdentity(account: ProviderAccountRecord): void {
      const entry = resets.get(account.id);
      if (entry && entry.identity !== identity(account))
        resets.delete(account.id);
    },
    clearProvider(provider: Provider): void {
      for (const [id, entry] of resets) {
        if (entry.provider === provider) resets.delete(id);
      }
    },
    observe(account: ProviderAccountRecord, limits: LiveLimits): void {
      const entry = resets.get(account.id);
      if (
        !entry ||
        entry.identity !== identity(account) ||
        limits.provider !== account.provider
      )
        return;
      const usage = windowUsage(limits);
      for (const [key, percent] of Object.entries(usage)) {
        if (percent === undefined) continue;
        if (percent >= 100) entry.windows.add(key);
        else entry.windows.delete(key);
      }
      if (!entry.windows.size) resets.delete(account.id);
    },
  };
};

export const accountCooldowns = createAccountCooldowns();
