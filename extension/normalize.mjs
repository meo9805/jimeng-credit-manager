const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const batchFields = (batches, complete, totals) => {
  if (batches === undefined) return {};
  const creditBatches = [];
  let valid = Array.isArray(batches);
  const sums = {subscription: 0, gift: 0, purchase: 0};
  if (valid) for (const batch of batches) {
    if (!batch || !Object.hasOwn(sums, batch.kind) || number(batch.amount) === null || batch.amount === 0 || creditBatches.length >= 200) { valid = false; continue; }
    const date = typeof batch.expiresAt === 'string' && batch.expiresAt ? new Date(batch.expiresAt) : null;
    creditBatches.push({kind:batch.kind,amount:batch.amount,expiresAt:date && Number.isFinite(date.valueOf()) ? date.toISOString() : null});
    sums[batch.kind] += batch.amount;
  }
  return {creditBatches,creditBatchesComplete:complete === true && valid && Object.entries(totals).every(([kind, total]) => number(total) !== null && Math.abs(sums[kind] - total) <= 0.000001)};
};

export function normalizeObservation(raw) {
  const empty = { observedAt: raw.observedAt, accounts: [], transactions: [], status: raw.status, message: raw.message };
  if (raw.status !== 'ok') return empty;
  const platformUserId = safeId(raw.userId);
  const teamId = safeId(raw.teamId);
  if (!platformUserId || !['personal', 'team'].includes(raw.accountType) || (raw.accountType === 'team' && !teamId)) {
    return { ...empty, status: 'error', message: '账号或空间标识不完整，未写入数据' };
  }
  const team = raw.accountType === 'team';
  const base = {
    platformUserId, spaceId: team ? teamId : 'personal', spaceType: team ? 'team' : 'personal',
    scope: team ? 'team_member' : 'personal', displayName: String(raw.displayName || '即梦账号').slice(0,100),
    spaceName: team ? String(raw.teamName || '团队空间').slice(0,100) : '个人空间',
    balance: number(raw.balance), giftBalance: number(raw.giftCredit), purchaseBalance: number(raw.purchaseCredit),
    subscriptionBalance: number(raw.vipCredit), expiresAt: raw.expiresAt || null,
    ...batchFields(raw.creditBatches,raw.creditBatchesComplete,{subscription:raw.vipCredit,gift:raw.giftCredit,purchase:raw.purchaseCredit}),
    ...(raw.subscriptionObservedAt ? {membershipPlan:raw.membershipPlan || null, billingCycle:raw.billingCycle || null,
      membershipExpiresAt:raw.membershipExpiresAt || null, nextRenewalAt:raw.nextRenewalAt || null, subscriptionObservedAt:raw.subscriptionObservedAt} : {}),
  };
  const accounts = raw.balanceFresh === false ? [] : [base];
  if (team && raw.canReadTeamTotal && number(raw.teamTotalCredit) !== null) {
    const {creditBatches,creditBatchesComplete,...poolBase} = base;
    accounts.push({ ...poolBase, scope: 'team_total', displayName: base.spaceName, balance: number(raw.teamTotalCredit),
      giftBalance: number(raw.teamGiftCredit), purchaseBalance: number(raw.teamPurchaseCredit),
      subscriptionBalance: number(raw.teamVipCredit), expiresAt: raw.teamExpiresAt || null,
      ...batchFields(raw.teamCreditBatches,raw.teamCreditBatchesComplete,{subscription:raw.teamVipCredit,gift:raw.teamGiftCredit,purchase:raw.teamPurchaseCredit}) });
  }
  const unique = new Map();
  const teams = [];
  const snapshot = raw.teamSnapshot;
  if (team && snapshot && safeId(snapshot.spaceId) === teamId) {
    const members = (snapshot.members || []).filter(member => safeId(member.platformUserId)).map(member => ({
      platformUserId:safeId(member.platformUserId),displayName:String(member.displayName || '即梦成员').slice(0,100),
      role:['creator','admin','member'].includes(member.role) ? member.role : 'unknown',
      usedCredits:number(member.usedCredits),balance:number(member.balance),joinedAt:member.joinedAt || null,
    }));
    teams.push({spaceId:teamId,name:String(snapshot.name || raw.teamName || '团队空间').slice(0,100),
      creatorPlatformUserId:safeId(snapshot.creatorPlatformUserId),creatorDisplayName:snapshot.creatorDisplayName ? String(snapshot.creatorDisplayName).slice(0,100) : null,
      membershipPlan:snapshot.membershipPlan || null,membershipExpiresAt:snapshot.membershipExpiresAt || null,
      ...(Object.hasOwn(snapshot,'totalBalance') ? {totalBalance:number(snapshot.totalBalance),allocatableBalance:number(snapshot.allocatableBalance)} : {}),
      totalSeats:number(snapshot.totalSeats),availableSeats:number(snapshot.availableSeats),
      membersComplete:snapshot.membersComplete === true && members.length === snapshot.members.length,
      members,observedAt:snapshot.observedAt});
  }
  for (const r of raw.records || []) {
    const eventId = safeId(r.historyId);
    if (!eventId || number(r.amount) === null || r.amount === 0 || ![1, 2].includes(r.historyType)) continue;
    if (team && r.teamId && r.teamId !== teamId) continue;
    const poolLedger = team && raw.ledgerScope === 'team_total';
    if (!poolLedger && r.userId && r.userId !== platformUserId) continue;
    const time = new Date(Number(r.createTime) * 1000);
    if (!Number.isFinite(time.valueOf()) || time.valueOf() > Date.now() + 300_000) continue;
    const description = String(r.title || '积分变动').slice(0,120);
    // CheckFailed is still a negative ledger entry; the separate refund is positive.
    const kind = r.historyType === 1 ? (/返还|退款/.test(description) ? 'refund' : 'grant') :
      (/到期|失效|清零/.test(description) ? 'expire' : 'consume');
    unique.set(eventId, { platformUserId, spaceId: base.spaceId, scope: poolLedger ? 'team_total' : base.scope,
      ...(poolLedger ? {chargedPlatformUserId:r.userId === teamId || (r.teamId && r.userId === r.teamId) ? null : safeId(r.userId)} : {}), eventId,
      platformSubmitId:safeId(r.submitId), occurredAt: time.toISOString(), kind, amount: (r.historyType === 1 ? 1 : -1) * r.amount, description });
  }
  // This identity comes from page-reader's verified, stable login snapshot,
  // independently of whether the credit request returned a member balance.
  return { ...empty, loginIdentity:{platformUserId,displayName:base.displayName}, accounts, transactions: [...unique.values()], ...(teams.length ? {teams} : {}) };
}
