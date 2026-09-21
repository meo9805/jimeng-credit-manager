// A display estimate authorized for monthly team subscription credits. Keep it
// separate from observed expiry/batches so it can never become platform evidence.
export function estimateTeamCreditExpiry(account, grant) {
  if (!['team_total', 'team_member'].includes(account.scope) || !(account.subscriptionBalance > 0)) return null;
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (validDate(account.expiresAt) || (account.creditBatches ?? []).some(batch => batch.amount > 0 && batch.kind === 'subscription' && validDate(batch.expiresAt))) return null;
  if (grant?.kind !== 'grant' || grant.description !== '团队会员积分' || !(grant.amount > 0) || !validDate(grant.occurredAt)) return null;
  if (!validDate(account.lastSyncedAt) || Date.parse(grant.occurredAt) > Date.parse(account.lastSyncedAt)) return null;
  // A calendar month in Beijing time, clamped for Jan 31 -> Feb 28/29. Avoid
  // server-local timezone differences and do not roll an old grant into the future.
  const offset = 8 * 3600_000;
  const date = new Date(Date.parse(grant.occurredAt) + offset), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return { expiresAt:new Date(date.valueOf() - offset).toISOString(), grantedAt:grant.occurredAt,
    sourceEventId:grant.eventId, rule:'team_subscription_month' };
}
