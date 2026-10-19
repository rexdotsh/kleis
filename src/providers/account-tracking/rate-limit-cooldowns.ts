import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import type { LiveLimits } from "./live-limits";

const identity = (account: ProviderAccountRecord): string =>
  JSON.stringify([
    account.provider,
    account.accountId,
    account.metadata?.provider === "claude"
      ? account.metadata.organizationUuid
      : null,
  ]);

const windows = (limits: LiveLimits): [string, number | null | undefined][] =>
  limits.provider === "claude"
    ? Object.entries(limits.windows).map(([key, window]) => [
        key,
        window.utilization,
      ])
    : [
        ["primary", limits.primaryWindow?.usedPercent],
        ["secondary", limits.secondaryWindow?.usedPercent],
      ];

type Cooldown = {
  identity: string;
  provider: Provider;
  until: number;
  resetsAt: number | null;
  windows: Set<string>;
};
const cooldowns = new Map<string, Cooldown>();

export const accountCooldowns = {
  get(account: ProviderAccountRecord, now = Date.now()): Cooldown | null {
    const entry = cooldowns.get(account.id);
    if (!entry) return null;
    if (entry.identity === identity(account) && entry.until > now) return entry;
    cooldowns.delete(account.id);
    return null;
  },
  mark(
    account: ProviderAccountRecord,
    resetsAt: number | null,
    limits: LiveLimits | null
  ): void {
    const exhausted = limits
      ? windows(limits)
          .filter(([, used]) => (used ?? 0) >= 100)
          .map(([key]) => key)
      : [];
    cooldowns.set(account.id, {
      identity: identity(account),
      provider: account.provider,
      until: resetsAt ?? Date.now() + 30_000,
      resetsAt,
      windows: new Set(
        exhausted.length
          ? exhausted
          : account.provider === "claude"
            ? ["five_hour", "seven_day"]
            : ["primary", "secondary"]
      ),
    });
  },
  observe(account: ProviderAccountRecord, limits: LiveLimits): void {
    const entry = this.get(account);
    if (!entry) return;
    for (const [key, used] of windows(limits)) {
      if (used === null || used === undefined) continue;
      if (used >= 100) entry.windows.add(key);
      else entry.windows.delete(key);
    }
    if (!entry.windows.size) cooldowns.delete(account.id);
  },
  clear(id: string): void {
    cooldowns.delete(id);
  },
  clearProvider(provider: Provider): void {
    for (const [id, entry] of cooldowns) {
      if (entry.provider === provider) cooldowns.delete(id);
    }
  },
};
