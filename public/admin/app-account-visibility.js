// Profile refreshes start at 23h; failed attempts retain the last fetchedAt.
const PROFILE_FRESH_MS = 23 * 60 * 60 * 1000;
const CODEX_QUOTA_FRESH_MS = 60_000;

function isFresh(snapshot, maxAge, now) {
  const fetchedAt = snapshot?.fetchedAt;
  return (
    !snapshot?.error &&
    !snapshot?.errorStatus &&
    Number.isFinite(fetchedAt) &&
    fetchedAt > 0 &&
    fetchedAt <= now &&
    now - fetchedAt < maxAge
  );
}

export function isFreeTierAccount(account) {
  const now = Date.now();
  const quota = account.quota;
  const profile = account.profile;
  if (
    (account.lastRefreshStatus && account.lastRefreshStatus !== "success") ||
    quota?.error ||
    quota?.errorStatus
  )
    return false;

  if (account.provider === "codex") {
    const planType = quota?.data?.status?.planType;
    if (planType != null) {
      return isFresh(quota, CODEX_QUOTA_FRESH_MS, now) && planType === "free";
    }
    return (
      isFresh(profile, PROFILE_FRESH_MS, now) &&
      profile.data?.planType === "free"
    );
  }
  // Claude usage syncs copy the cached plan; only the profile dates its verification.
  if (
    account.provider !== "claude" ||
    !isFresh(profile, PROFILE_FRESH_MS, now)
  ) {
    return false;
  }
  if (profile.data?.organizationType) {
    return profile.data.organizationType === "claude_free";
  }
  return profile.data?.plan?.type === "free";
}

export function isAccountVisible(
  account,
  { showFreeTier = false, keepIds = new Set(), usage = null } = {}
) {
  return (
    showFreeTier ||
    !isFreeTierAccount(account) ||
    account.isPrimary ||
    keepIds.has(account.id) ||
    (usage?.requestCount ?? 0) > 0
  );
}
