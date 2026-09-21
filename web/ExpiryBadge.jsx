import { creditExpiryRows,teamCreditExpiryEstimate,estimatedExpiryLabel,estimatedExpiryTitle } from './credit-expiry.js';

const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ExpiryBadge({ account = {} }) {
  const rows = creditExpiryRows(account);
  const now = Date.now();
  const estimate=teamCreditExpiryEstimate(account);
  const estimateBadge=estimate?<span className={`credit-expiry-badge estimated ${Date.parse(estimate.expiresAt)-now<=7*86400000?'urgent':''}`} title={estimatedExpiryTitle(estimate)}>{estimatedExpiryLabel(estimate,now)}</span>:null;
  if (rows.length) return <span className="credit-expiry-list">{rows.map(row => {
    const time = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
    const expired = Number.isFinite(time) && time <= now;
    return <span key={row.key} className={`credit-expiry-badge ${!Number.isFinite(time) ? 'unknown' : time - now <= 7 * 86400000 ? 'urgent' : ''}`} title={row.expiresAt ? `${row.label}积分 ${amount.format(row.amount)} 分，到期时间：${fullDate.format(time)}（北京时间）` : '平台尚未返回该批积分的到期时间'}>{row.label} {amount.format(row.amount)} 分 · {row.expiresAt ? `${date.format(time)} ${expired ? '已到期，待更新' : '到期'}` : '到期日未获取'}</span>;
  })}{estimateBadge}{!account.creditBatchesComplete ? <span className="credit-expiry-badge unknown">其余批次未获取</span> : null}</span>;
  const time = account.expiresAt ? Date.parse(account.expiresAt) : NaN;
  if(estimate)return <span className="credit-expiry-list">{estimateBadge}</span>;
  return <span className="credit-expiry-list"><span className="credit-expiry-badge unknown">{Number.isFinite(time) ? `部分积分 ${date.format(time)} ${time <= now ? '已到期' : '到期'} · 金额未获取` : '到期日未获取'}</span></span>;
}
