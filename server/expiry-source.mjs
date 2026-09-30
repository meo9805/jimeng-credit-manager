// Match the original platform record, never infer a credit source from its size,
// expiry hour, current wallet balances, or the English word GIFT alone.
const kinds = new Map([
  ['FREEMIUM_RECEIVE', 'gift'],
  ['VIP_GIFT', 'subscription'],
  ['TEAMS_VIP_GIFT', 'subscription'],
  ['ONE_OFF_PURCHASE', 'purchase'],
]);
const key = (ledger, event, user, amount, at) => JSON.stringify([ledger, String(event), user || null, amount, at]);

export function expirySourceIndex(facts) {
  const result = new Map();
  for (const fact of facts) {
    let payload;
    try { payload = JSON.parse(fact.payload); } catch { continue; }
    const personal = fact.query_scope === 'personal';
    const ledger = personal ? `personal:${fact.login_user_id}` : `team:${fact.team_id}`;
    if (!personal && !fact.team_id) continue;
    const records = payload?.data?.records;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (record.history_type !== 2 || !record.history_id || !(record.amount > 0)) continue;
      if (personal && record.user_id != null && String(record.user_id) !== fact.login_user_id) continue;
      if (!personal && record.team_id && String(record.team_id) !== fact.team_id) continue;
      const rawUser = record.user_id ?? (personal || fact.query_scope === 'team_member' ? fact.login_user_id : null);
      const user = String(rawUser ?? '') === fact.team_id ? null : String(rawUser ?? '') || null;
      const at = Number(record.create_time) * 1000;
      if (!Number.isFinite(at)) continue;
      const id = key(ledger, record.history_id, user, record.amount, at);
      const kind = kinds.get(record.trade_source) ?? null;
      if (!result.has(id)) result.set(id, kind);
      else if (result.get(id) !== kind) result.set(id, null);
    }
  }
  return result;
}

export function expiryCreditKind(transaction, account, sources) {
  if (!account || transaction.kind !== 'expire' || !(transaction.amount < 0)) return null;
  const personal = account.scope === 'personal';
  const ledger = personal ? `personal:${account.platformUserId}` : `team:${account.spaceId}`;
  const user = transaction.chargedPlatformUserId ?? (personal ? account.platformUserId : null);
  const id = key(ledger, transaction.eventId, user, -transaction.amount, Date.parse(transaction.occurredAt));
  if (sources.has(id)) return sources.get(id);
  // Older collectors retained these explicit platform labels before raw facts.
  // Generic “积分到期清零” cannot distinguish a free credit from a paid credit.
  return ['订阅积分到期清零', '团队会员失效积分失效'].includes(transaction.description) ? 'subscription' : null;
}
