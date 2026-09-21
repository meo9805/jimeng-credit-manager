const labels = { subscription: '会员', gift: '赠送', purchase: '充值' };
const rank = { subscription: 0, gift: 1, purchase: 2 };
const date = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'});
const fullDate = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const validDate = value => typeof value==='string'&&Number.isFinite(Date.parse(value));

export function creditExpiryRows(account = {}) {
  const groups = new Map();
  for (const batch of account.creditBatches || []) {
    if (!labels[batch.kind] || !Number.isFinite(batch.amount) || batch.amount <= 0) continue;
    const expiresAt = batch.expiresAt && Number.isFinite(Date.parse(batch.expiresAt)) ? batch.expiresAt : null;
    const key = `${batch.kind}:${expiresAt || ''}`;
    const current = groups.get(key) || { key, kind: batch.kind, label: labels[batch.kind], amount: 0, expiresAt };
    current.amount += batch.amount;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.expiresAt || 'z').localeCompare(b.expiresAt || 'z'));
}

export function teamCreditExpiryEstimate(account = {}) {
  const estimate=account.creditExpiryEstimate;
  if(!['team_total','team_member'].includes(account.scope)||estimate?.rule!=='team_subscription_month'||!validDate(estimate.expiresAt)||!validDate(estimate.grantedAt))return null;
  const rows=creditExpiryRows(account);
  if(rows.some(row=>row.kind==='subscription'&&row.expiresAt))return null;
  // Any official account expiry remains authoritative over a supplied estimate.
  if(validDate(account.expiresAt))return null;
  return estimate;
}

export function estimatedExpiryLabel(estimate,now=Date.now(),full=false) {
  const expires=Date.parse(estimate.expiresAt),label=(full?fullDate:date).format(expires);
  return `预计 ${label} ${expires<=now?'已到期，待更新':'到期'}`;
}

export function estimatedExpiryTitle(estimate) {
  return `按团队会员积分发放日 ${fullDate.format(Date.parse(estimate.grantedAt))} 加一个月估算（北京时间）`;
}

export function creditExpiryDates(account = {}) {
  const official=[...new Set([account.expiresAt,...creditExpiryRows(account).map(row=>row.expiresAt)].filter(validDate))].map(expiresAt=>({expiresAt,estimated:false}));
  const estimate=teamCreditExpiryEstimate(account);
  return estimate?[...official,{expiresAt:estimate.expiresAt,estimated:true}]:official;
}

export function creditExpiryDueSoon(account,now=Date.now(),{officialOnly=false}={}) {
  return creditExpiryDates(account).some(row=>{
    const time=Date.parse(row.expiresAt);
    return (!officialOnly||!row.estimated)&&time>now&&time-now<=7*86400_000;
  });
}
