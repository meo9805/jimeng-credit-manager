const safeId = value => typeof value === 'string' && /^[\w.@:-]{1,160}$/.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const factId = value => typeof value === 'string' && value.length <= 160 ? value :
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const factScalar = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12 ? value :
  typeof value === 'string' && value.length <= 160 ? value : null;
const factText = (value,max) => typeof value === 'string' ? value.slice(0,max).replace(/[\u0000-\u001f\u007f]/gu,' ') : null;
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
  // Raw platform credit facts are retained independently from today's kind,
  // amount-sign and owner classification rules. Future server rules can revisit
  // them without another employee extension update.
  const creditHistoryFacts = Array.isArray(raw.records) && raw.records.length ? [{
    context:{loginUserId:platformUserId,queryScope:raw.ledgerScope === 'team_total' ? 'team_total' : base.scope,
      teamId:team ? teamId : null,readAt:raw.observedAt},
    records:raw.records.slice(0,100).map(r=>({
      historyId:factId(r?.historyId),submitId:factId(r?.submitId),historyType:factScalar(r?.historyType),
      amount:factScalar(r?.amount),createTime:factScalar(r?.createTime),userId:factId(r?.userId),
      teamId:factId(r?.teamId),title:factText(r?.title,120),status:factText(r?.status,100),
    })),
  }] : [];
  const subscriptionFacts = Array.isArray(raw.subscriptionFacts) ? raw.subscriptionFacts.slice(0,1)
    .filter(f=>f && f.spaceType===raw.accountType && factId(f.loginUserId)===platformUserId &&
      (team ? factId(f.teamId)===teamId : f.teamId==null))
    .map(f=>({spaceType:f.spaceType,loginUserId:platformUserId,teamId:team ? teamId : null,readAt:f.readAt || raw.observedAt,
      active:typeof f.active==='boolean'?f.active:null,planLevel:factId(f.planLevel),productId:factId(f.productId),
      subscribeCycle:factScalar(f.subscribeCycle),cycleUnit:factId(f.cycleUnit),startTime:factScalar(f.startTime),
      endTime:factScalar(f.endTime),nextRenewalTime:factScalar(f.nextRenewalTime)})) : [];
  const creditSourceFacts = Array.isArray(raw.creditSourceFacts) ? raw.creditSourceFacts.slice(0,64)
    .filter(f=>f && ['user_credit','user_credit_history','user_info','team_info','team_member_list'].includes(f.source) &&
      factId(f.loginUserId)===platformUserId && ['personal','team_member','team_total'].includes(f.queryScope) &&
      (team ? factId(f.teamId)===teamId : f.teamId==null) && f.payload && typeof f.payload==='object')
    .map(f=>({source:f.source,loginUserId:platformUserId,teamId:team ? teamId : null,
      queryScope:f.queryScope,readAt:f.readAt || raw.observedAt,payload:f.payload})) : [];
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
  return { ...empty, loginIdentity:{platformUserId,displayName:base.displayName}, accounts, transactions: [...unique.values()],
    ...(creditHistoryFacts.length ? {creditHistoryFacts} : {}),
    ...(subscriptionFacts.length ? {subscriptionFacts} : {}),
    ...(creditSourceFacts.length ? {creditSourceFacts} : {}),
    ...(teams.length ? {teams} : {}) };
}
