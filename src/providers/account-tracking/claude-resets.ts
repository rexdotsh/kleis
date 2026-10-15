import { readBoolean, readObject, readString, requireObject } from "./decode";

// Claude's saved limit resets ("Reset for free" in Settings > Usage), the
// cedar_ember program. Schemas and limits follow Claude Code 2.1.300.
export const CLAUDE_RESET_PROGRAM = "cedar_ember";
export const CLAUDE_RESET_CLAIM_TIMEOUT_MS = 25_000;

export const claudeResetLimitTypes = [
  "five_hour",
  "seven_day",
  "seven_day_overage_included",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_cowork",
  "seven_day_omelette",
  "seven_day_oauth_apps",
] as const;

export type ClaudeResetLimitType = (typeof claudeResetLimitTypes)[number];

const ineligibleReasons = [
  "config_off",
  "tier",
  "seat",
  "mobile",
  "surface",
  "cli_version",
  "no_grant",
  "tenure",
  "other_experiment",
  "unavailable",
  "unknown",
] as const;

const claimReasons = [
  ...ineligibleReasons,
  "paused",
  "expired",
  "unknown_grant",
  "not_next_grant",
  "grant_id_required",
  "not_limited",
  "already_used",
  "cooldown",
  "stamp_indeterminate",
  "reset_unconfirmed",
] as const;

export type ClaudeResetClaimReason = (typeof claimReasons)[number];

const claimResults = [
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
] as const;

export type ClaudeResetClaimResultCode = (typeof claimResults)[number];

const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

export const isClaudeResetGrantId = (value: string): boolean =>
  GRANT_ID_PATTERN.test(value);

const readEnum = <T extends string>(
  values: readonly T[],
  value: unknown
): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;

const readCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

// Unknown limit types are dropped: Kleis can't say what they refill.
const readLimitTypes = (value: unknown): ClaudeResetLimitType[] =>
  Array.isArray(value)
    ? value
        .map((entry) => readEnum(claudeResetLimitTypes, entry))
        .filter((entry) => entry !== null)
    : [];

const readPercentUsed = (
  value: unknown
): Partial<Record<ClaudeResetLimitType, number>> => {
  const input = readObject(value) ?? {};
  const percents: Partial<Record<ClaudeResetLimitType, number>> = {};
  for (const type of claudeResetLimitTypes) {
    const percent = input[type];
    if (
      typeof percent === "number" &&
      Number.isInteger(percent) &&
      percent >= 0 &&
      percent <= 100
    ) {
      percents[type] = percent;
    }
  }
  return percents;
};

const decodeGrant = (value: unknown) => {
  const input = readObject(value);
  const id = readString(input?.id);
  const resetsLeft = readCount(input?.resets_left);
  if (!(input && id && isClaudeResetGrantId(id)) || resetsLeft === null) {
    return null;
  }
  return {
    id,
    label: readString(input.label) ?? "",
    resetsTotal: readCount(input.resets_total) ?? 0,
    resetsLeft,
    startsAt: readString(input.starts_at),
    endsAt: readString(input.ends_at),
    clears: readLimitTypes(input.clears),
    paused: readBoolean(input.paused) ?? false,
    usableNow: readBoolean(input.usable_now) ?? false,
    useRequiresLimit: readBoolean(input.use_requires_limit) ?? true,
    percentUsed: readPercentUsed(input.percent_used),
    blocking: readLimitTypes(input.blocking),
  };
};

export type ClaudeResetGrant = NonNullable<ReturnType<typeof decodeGrant>>;

// A missing or unreadable block means the server did not evaluate resets for
// this read, which is not the same as having none.
export const decodeClaudeResetStatus = (value: unknown) => {
  const input = readObject(value);
  const eligible = readBoolean(input?.eligible);
  if (!input || eligible === null) {
    return null;
  }
  const grants = Array.isArray(input.grants)
    ? input.grants.map(decodeGrant).filter((grant) => grant !== null)
    : [];
  const nextGrantId = readString(input.next_grant_id);
  return {
    eligible,
    ineligibleReason:
      input.ineligible_reason === null || input.ineligible_reason === undefined
        ? null
        : (readEnum(ineligibleReasons, input.ineligible_reason) ?? "unknown"),
    atLimit: readBoolean(input.at_limit) ?? false,
    exhausted: readLimitTypes(input.exhausted),
    grants,
    nextGrantId: grants.some((grant) => grant.id === nextGrantId)
      ? nextGrantId
      : null,
    weeklyResetsAt: readString(input.weekly_resets_at),
    cooldownUntil: readString(input.cooldown_until),
  };
};

export type ClaudeResetStatus = NonNullable<
  ReturnType<typeof decodeClaudeResetStatus>
>;

export const decodeClaudeResetClaimResult = (value: unknown) => {
  const input = requireObject(
    value,
    "Claude reset claim response is malformed"
  );
  const result = readEnum(claimResults, input.result);
  if (!result) {
    throw new Error("Claude reset claim response is malformed");
  }
  return {
    result,
    reason:
      input.reason === null || input.reason === undefined
        ? null
        : (readEnum(claimReasons, input.reason) ?? "unknown"),
    resetsLeft: readCount(input.resets_left),
    cleared: readLimitTypes(input.cleared),
    weeklyResetsAt: readString(input.weekly_resets_at),
    cooldownUntil: readString(input.cooldown_until),
  };
};

export type ClaudeResetClaimResult = ReturnType<
  typeof decodeClaudeResetClaimResult
>;

const parseTime = (value: string | null): number | null | "invalid" => {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
};

const isLive = (grant: ClaudeResetGrant, now: number): boolean => {
  const startsAt = parseTime(grant.startsAt);
  const endsAt = parseTime(grant.endsAt);
  return (
    grant.resetsLeft > 0 &&
    startsAt !== "invalid" &&
    endsAt !== "invalid" &&
    (startsAt === null || startsAt <= now) &&
    (endsAt === null || endsAt > now)
  );
};

export type ClaudeResetUnavailableReason =
  | "ineligible"
  | "none_left"
  | "paused"
  | "cooldown"
  | "requires_limit"
  | "not_usable";

export type ClaudeResetOffer = {
  // Binds an admin's confirmation to exactly what it showed.
  key: string;
  grantId: string;
  label: string;
  clears: ClaudeResetLimitType[];
  endsAt: string | null;
  weeklyResetsAt: string | null;
  // Not at any limit this reset refills; the highest use among them, when
  // the server reports one.
  earlyUse: {
    limit: ClaudeResetLimitType | null;
    percentUsed: number | null;
  } | null;
};

export type ClaudeResetSummary = {
  saved: number;
  nextEndsAt: string | null;
  clears: ClaudeResetLimitType[];
  ineligibleReason: string | null;
  offer: ClaudeResetOffer | null;
  unavailable: ClaudeResetUnavailableReason | null;
};

const offerKey = (grant: ClaudeResetGrant): string =>
  Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify([
      grant.id,
      grant.resetsLeft,
      grant.clears,
      grant.endsAt,
      grant.useRequiresLimit,
    ]),
    "hex"
  ).slice(0, 32);

const earlyUse = (
  grant: ClaudeResetGrant,
  status: ClaudeResetStatus
): ClaudeResetOffer["earlyUse"] => {
  if (grant.clears.some((type) => status.exhausted.includes(type))) {
    return null;
  }
  let highest: ClaudeResetOffer["earlyUse"] = {
    limit: null,
    percentUsed: null,
  };
  for (const type of grant.clears) {
    const percent = grant.percentUsed[type];
    if (
      percent !== undefined &&
      (highest.percentUsed === null || percent > highest.percentUsed)
    ) {
      highest = { limit: type, percentUsed: percent };
    }
  }
  return highest;
};

// Mirrors Claude Code's choice: only the server's next grant is offered, and
// only when the server says it is usable now. Anything Kleis can't confirm
// (unknown limits, unreadable dates, blocking limits) is not offered.
const selectOffer = (
  status: ClaudeResetStatus,
  live: ClaudeResetGrant[],
  now: number
): ClaudeResetOffer | ClaudeResetUnavailableReason => {
  if (!status.eligible) {
    return "ineligible";
  }
  if (!live.length) {
    return "none_left";
  }
  const cooldownUntil = parseTime(status.cooldownUntil);
  if (cooldownUntil === "invalid" || (cooldownUntil ?? 0) > now) {
    return "cooldown";
  }
  const grant = live.find((entry) => entry.id === status.nextGrantId);
  if (!grant) {
    return live.every((entry) => entry.paused) ? "paused" : "not_usable";
  }
  if (grant.paused) {
    return "paused";
  }
  if (!(grant.usableNow && grant.clears.length) || grant.blocking.length) {
    return "not_usable";
  }
  const early = earlyUse(grant, status);
  if (grant.useRequiresLimit && early) {
    return "requires_limit";
  }
  return {
    key: offerKey(grant),
    grantId: grant.id,
    label: grant.label,
    clears: grant.clears,
    endsAt: grant.endsAt,
    weeklyResetsAt: status.weeklyResetsAt,
    earlyUse: early,
  };
};

export const summarizeClaudeResets = (
  status: ClaudeResetStatus,
  now: number
): ClaudeResetSummary => {
  const live = status.eligible
    ? status.grants.filter((grant) => isLive(grant, now))
    : [];
  const expiry = (grant: ClaudeResetGrant): number => {
    const endsAt = parseTime(grant.endsAt);
    return typeof endsAt === "number" ? endsAt : Number.POSITIVE_INFINITY;
  };
  const next =
    live.find((grant) => grant.id === status.nextGrantId) ??
    [...live].sort((a, b) => expiry(a) - expiry(b))[0];
  const offer = selectOffer(status, live, now);
  return {
    saved: live.reduce((total, grant) => total + grant.resetsLeft, 0),
    nextEndsAt: next?.endsAt ?? null,
    clears: next?.clears ?? [],
    ineligibleReason: status.eligible ? null : status.ineligibleReason,
    offer: typeof offer === "string" ? null : offer,
    unavailable: typeof offer === "string" ? offer : null,
  };
};
