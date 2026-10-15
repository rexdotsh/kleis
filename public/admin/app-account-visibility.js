export function isFreeTierAccount(account) {
  const data = account.quota?.data;
  const profile = account.profile?.data;
  if (account.provider === "codex") {
    return (data?.status?.planType ?? profile?.planType) === "free";
  }
  if (account.provider !== "claude") return false;
  // Stored profiles retain organization_type even when their plan is unknown.
  if (profile?.organizationType) {
    return profile.organizationType === "claude_free";
  }
  return (data?.plan?.type ?? profile?.plan?.type) === "free";
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
