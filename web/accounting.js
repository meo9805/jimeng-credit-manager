/** Unknown balances stay unknown; team member allocations never increase the total. */
export function balanceSummary(accounts) {
  const pooled = accounts.filter((a) => a.scope === 'personal' || a.scope === 'team_total');
  const known = pooled.filter((a) => typeof a.balance === 'number' && Number.isFinite(a.balance));
  const totalFor = (scope) => {
    const items = known.filter((a) => a.scope === scope);
    return items.length ? items.reduce((sum, a) => sum + a.balance, 0) : null;
  };
  return {
    pooled,
    known,
    total: known.length ? known.reduce((sum, a) => sum + a.balance, 0) : null,
    personal: totalFor('personal'),
    team: totalFor('team_total'),
  };
}

/** A shared team pool identifies a space, never an additional login identity. */
export function loginIdentitySummary(accounts) {
  const byUser = new Map();
  for (const account of accounts) {
    if (account.scope === 'team_total' || !account.platformUserId) continue;
    const id = String(account.platformUserId);
    const group = byUser.get(id) || { platformUserId: id, accounts: [] };
    group.accounts.push(account);
    byUser.set(id, group);
  }
  const groups = [...byUser.values()].map((group) => {
    const personal = group.accounts.find((a) => a.scope === 'personal');
    const members = group.accounts.filter((a) => a.scope === 'team_member');
    const spaces = new Set(members.map((a) => a.spaceId).filter(Boolean));
    return { ...group, personal, members, displayName: personal?.displayName || members[0]?.displayName || '即梦账号', sharedWallets: accounts.filter((a) => a.scope === 'team_total' && spaces.has(a.spaceId)) };
  });
  return {
    groups,
    loginCount: groups.length,
    walletCount: accounts.filter((a) => a.scope === 'personal' || a.scope === 'team_total').length,
    memberAllowanceCount: accounts.filter((a) => a.scope === 'team_member').length,
  };
}
