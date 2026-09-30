import { useMemo, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import { referenceWalletKey, resolveReferenceRate } from '../shared/reference-pricing.mjs';
import { teamCreator } from './teams.js';
import './reference-rates.css';

const currency = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '';
const rateDate = (value, withTime = false) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value)) : null;
const sourceLabel = rate => ({ platform_reference: '套餐参考价', plan_estimate: '月付参考价估算', team_estimate: '同类团队价估算', purchase_estimate: '充值挂牌价估算', manual: '自定义单价' })[rate.source] || '自动估算';
const effectiveLabel = rate => rate.basis === 'initial_reference' ? '初始折算单价' : rateDate(rate.effectiveAt, true) ? `${rateDate(rate.effectiveAt, true)} 起` : '—';
const rateBasis = rate => rate.explanation || (rate.source === 'manual' ? effectiveLabel(rate) : sourceLabel(rate));
const observedLabel = rate => rateDate(rate.priceObservedAt) ? `参考价核对于 ${rateDate(rate.priceObservedAt)}` : undefined;

function walletsFor(data) {
  const identities = new Map((data.identities || []).map(item => [String(item.platformUserId), item]));
  const teams = new Map((data.teams || []).map(item => [String(item.spaceId), item]));
  const groups = new Map();
  for (const account of data.accounts || []) {
    const key = referenceWalletKey(account);
    if (!key) continue;
    const previous = groups.get(key);
    if (!previous || account.scope === 'team_total' || new Date(account.lastSyncedAt) > new Date(previous.lastSyncedAt)) groups.set(key, account);
  }
  return [...groups.entries()].map(([key, account]) => {
    const team = teams.get(String(account.spaceId)), isTeam = key.startsWith('team:');
    const creator = isTeam ? teamCreator(team) : null;
    const identity = identities.get(String(isTeam ? creator?.platformUserId : account.platformUserId));
    const name = identity?.realName || (isTeam ? creator?.displayName || team?.name || account.spaceName : account.displayName || identity?.nickname) || '未归属账号';
    return { key, account, name, type: isTeam ? '团队钱包' : '个人钱包', description: isTeam ? team?.name || account.spaceName : identity?.nickname || account.displayName, plan: team?.membershipPlan || account.membershipPlan };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.type.localeCompare(b.type, 'zh-CN'));
}

function RateRow({ wallet, rates, now, busy, onSave }) {
  const current = resolveReferenceRate(wallet.account, rates, now);
  const history = rates.filter(rate => rate.walletKey === wallet.key).sort((a, b) => new Date(b.effectiveAt) - new Date(a.effectiveAt) || (b.revision || 0) - (a.revision || 0));
  const [draft, setDraft] = useState(null), [error, setError] = useState(null);
  const input = draft ?? (current ? String(Math.round(current.perThousand * 10000) / 10000) : '');
  const dirty = draft !== null && (!current || Number(draft) !== Math.round(current.perThousand * 10000) / 10000);
  const save = async event => {
    event.preventDefault();
    const value = Number(input);
    if (!input.trim() || !Number.isFinite(value) || value <= 0 || value > 1_000_000) { setError('请输入大于 0、最高 1,000,000 的单价'); return; }
    setError(null);
    try { await onSave({ walletKey: wallet.key, perThousand: value }); setDraft(null); }
    catch (reason) { setError(reason?.message || '保存失败，请重试'); }
  };
  return <div className="reference-rate-row">
    <form onSubmit={save} className="reference-rate-form">
      <div className="reference-rate-wallet"><strong>{wallet.name}<small>{wallet.type}</small></strong><span>{[wallet.description !== wallet.name ? wallet.description : null, wallet.plan].filter(Boolean).join(' · ') || wallet.key}</span>{current ? <small title={observedLabel(current)}>{current.source === 'manual' ? '自定义单价 · ' : ''}{rateBasis(current)}</small> : <small>—</small>}</div>
      <label className="reference-rate-input"><span className="sr-only">{wallet.name}{wallet.type}每千积分参考金额</span><span aria-hidden="true">¥</span><input type="number" min="0.0001" max="1000000" step="0.0001" inputMode="decimal" aria-label={`${wallet.name}${wallet.type}每千积分参考金额`} value={input} placeholder="—" onChange={event => { setDraft(event.target.value); setError(null); }} disabled={busy} /><span> / 千分</span></label>
      <Button htmlType="submit" disabled={busy || !dirty} theme={dirty ? 'solid' : 'light'}>保存</Button>
    </form>
    {error ? <p role="alert" className="reference-rate-error">{error}</p> : null}
    {history.length ? <details className="reference-rate-history"><summary>单价记录 · {history.length}</summary><div>{history.map(rate => <div key={rate.id}><span>{effectiveLabel(rate)}<small title={observedLabel(rate)}>{sourceLabel(rate)}{rate.explanation ? ` · ${rate.explanation}` : ''}</small></span><strong>¥{currency(rate.perThousand)} / 千分</strong></div>)}</div></details> : null}
  </div>;
}

/** Dialog content only; the application owns the single modal and authentication. */
export default function ReferenceRates({ data, onSave, onClose }) {
  const [busy, setBusy] = useState(false);
  const wallets = useMemo(() => walletsFor(data), [data.accounts, data.teams, data.identities]);
  const now = Math.max(Date.now(), Number.isFinite(Date.parse(data.asOf)) ? Date.parse(data.asOf) : 0);
  const save = async values => { setBusy(true); try { await onSave(values); } finally { setBusy(false); } };
  return <div className="reference-rates"><p className="reference-rates-intro">按套餐或充值挂牌价自动估算，不代表实际付款。自定义单价保存后生效，历史折算不变。</p><div className="reference-rates-list">{wallets.length ? wallets.map(wallet => <RateRow key={wallet.key} wallet={wallet} rates={data.referenceRates || []} now={now} busy={busy} onSave={save} />) : <div className="reference-rates-empty">暂无已采集的钱包</div>}</div><div className="reference-rates-footer"><Button onClick={onClose} disabled={busy}>完成</Button></div></div>;
}
