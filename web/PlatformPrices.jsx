import { useEffect, useMemo, useState } from 'react';
import './platform-prices.css';

const PLAN_NAMES = {
  standard: '基础会员', artisan: '标准会员', maestro: '高级会员', ultra: '超级会员',
  teams: '高级团队会员', teams_super: '超级团队会员',
};
const PLAN_ORDER = ['standard', 'artisan', 'maestro', 'ultra', 'teams', 'teams_super'];
const quantity = new Intl.NumberFormat('zh-CN');
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function cycleMonths(item) {
  const unit = String(item.cycleUnit || '').toUpperCase();
  const count = item.subscribeCycle;
  if (!Number.isSafeInteger(count) || count < 1) return null;
  if (unit === 'MONTH') return count;
  if (unit === 'QUARTER') return count * 3;
  if (unit === 'YEAR') return count * 12;
  return null;
}

function cycleName(months) {
  if (months === 1) return '月付';
  if (months === 3) return '季付';
  if (months === 12) return '年付';
  return months ? `${months} 个月` : '其他周期';
}

function priceType(item) { return String(item.priceType || '').replaceAll('_', '-'); }
function offerColumnKey(item) { return JSON.stringify([cycleMonths(item), priceType(item), item.goodsType || '']); }
function yuan(cents) { return `¥${money.format(cents / 100)}`; }
function observedDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
    : null;
}

function groupedOffers(products, scene) {
  const isTeam = scene === 'teams_default';
  const distinct = new Map();
  for (const product of products || []) {
    if (product?.scene !== scene || product.currencyCode !== 'CNY' || !Number.isSafeInteger(product.totalAmount) || product.totalAmount <= 0) continue;
    const key = JSON.stringify([product.level, product.subscribeCycle, product.cycleUnit,
      product.totalAmount, product.originPriceAmount, product.normalAmount,
      product.monthlyCredits, product.memberLimit, priceType(product), product.goodsType]);
    distinct.set(key, product);
  }
  const groups = new Map();
  for (const offer of distinct.values()) {
    const level = offer.level || 'other';
    if (!groups.has(level)) groups.set(level, { level, label: PLAN_NAMES[level] || level, isTeam, offers: [] });
    groups.get(level).offers.push(offer);
  }
  const rank = level => PLAN_ORDER.includes(level) ? PLAN_ORDER.indexOf(level) : PLAN_ORDER.length;
  return [...groups.values()].sort((a, b) => rank(a.level) - rank(b.level) || a.label.localeCompare(b.label, 'zh-CN'));
}

function priceColumns(groups, isTeam) {
  const columns = new Map();
  for (const group of groups) for (const offer of group.offers) {
    const key = offerColumnKey(offer);
    if (!columns.has(key)) columns.set(key, {
      key, months: cycleMonths(offer), type: priceType(offer), goodsType: offer.goodsType || '',
    });
  }
  const list = [...columns.values()].sort((a, b) =>
    (a.type === 'auto' ? 0 : a.type === 'un-auto' ? 1 : 2) -
    (b.type === 'auto' ? 0 : b.type === 'un-auto' ? 1 : 2) ||
    (a.months ?? 999) - (b.months ?? 999) || a.goodsType.localeCompare(b.goodsType));
  const labels = new Map();
  for (const column of list) {
    const period = cycleName(column.months);
    column.label = column.type === 'auto' ? `连续${period}`
      : !isTeam && column.type === 'un-auto' && column.months === 1 ? '单月购买'
        : column.type === 'un-auto' ? period : `${period} · ${column.type || '其他方式'}`;
    labels.set(column.label, (labels.get(column.label) || 0) + 1);
  }
  for (const column of list) if (labels.get(column.label) > 1) column.label += ` · ${column.goodsType || '其他商品'}`;
  return list;
}

function matchingOffer(group, column, selected) {
  const matches = group.offers.filter(offer => offerColumnKey(offer) === column.key &&
    (group.isTeam ? offer.memberLimit : offer.monthlyCredits) === selected);
  if (!matches.length || new Set(matches.map(offer => offer.totalAmount)).size !== 1) return null;
  return matches[0];
}

function PriceQuote({ group, column, selected }) {
  const offer = matchingOffer(group, column, selected);
  const columnOffers = group.offers.filter(item => offerColumnKey(item) === column.key);
  const onlyTier = !offer && !group.isTeam && columnOffers.length &&
    new Set(columnOffers.map(item => item.monthlyCredits)).size === 1 ? columnOffers[0].monthlyCredits : null;
  const renewal = offer && column.type === 'auto' && Number.isSafeInteger(offer.normalAmount) && offer.normalAmount > offer.totalAmount
    ? offer.normalAmount : null;
  return <div className={`platform-price-quote${offer ? '' : ' is-empty'}`}>
    <span className="platform-price-mobile-label">{column.label}</span>
    {offer ? <>
      <div className="platform-price-amount">{yuan(offer.totalAmount)}</div>
      {renewal ? <small>续费 {yuan(renewal)}</small> : null}
    </> : <>
      <div className="platform-price-amount">—</div>
      {onlyTier ? <small>仅 {quantity.format(onlyTier)} 分档</small> : null}
    </>}
  </div>;
}

function PriceRow({ group, columns }) {
  const options = [...new Set(group.offers.map(offer => group.isTeam ? offer.memberLimit : offer.monthlyCredits)
    .filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
  const [choice, setChoice] = useState(() => options[0]);
  const selected = options.includes(choice) ? choice : options[0];
  const index = options.indexOf(selected);
  const selectedCredits = [...new Set(group.offers.filter(offer => offer.memberLimit === selected)
    .map(offer => offer.monthlyCredits).filter(value => Number.isSafeInteger(value) && value > 0))];
  const teamCredits = selectedCredits.length === 1 ? selectedCredits[0] : null;
  return <article className="platform-price-row" aria-label={group.label}>
    <div className="platform-price-plan">
      <h2>{group.label}</h2>
      {group.isTeam ? <>
        <div className="platform-price-credit">{teamCredits ? `${quantity.format(teamCredits)} 分/人·月` : '每人每月积分 —'}</div>
        {options.length > 1 ? <div className="platform-price-seat-picker">
          <button type="button" aria-label={`${group.label}减少席位`} disabled={index === 0} onClick={() => setChoice(options[index - 1])}>−</button>
          <input type="range" min="0" max={options.length - 1} step="1" value={index}
            style={{ '--step-progress': `${index / (options.length - 1) * 100}%` }}
            aria-label={`${group.label}团队席位`} aria-valuetext={`${selected} 席`}
            onChange={event => setChoice(options[Number(event.target.value)])} />
          <button type="button" aria-label={`${group.label}增加席位`} disabled={index === options.length - 1} onClick={() => setChoice(options[index + 1])}>+</button>
          <strong>{selected} 席</strong>
        </div> : <div className="platform-price-credit">{selected} 席</div>}
      </> : options.length > 1 ? <div className="platform-price-tier-picker" aria-label={`${group.label}每月积分`}>
        {options.map(value => <button type="button" key={value} aria-pressed={selected === value}
          className={selected === value ? 'active' : ''} onClick={() => setChoice(value)}>{quantity.format(value)}</button>)}
        <span>分/月</span>
      </div> : <div className="platform-price-credit">{selected ? `${quantity.format(selected)} 分/月` : '每月积分 —'}</div>}
    </div>
    {columns.map(column => <PriceQuote key={column.key} group={group} column={column} selected={selected} />)}
  </article>;
}

export default function PlatformPrices({ request }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scene, setScene] = useState('vip');
  const [read, setRead] = useState(0);

  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === 'visible') setRead(value => value + 1); };
    const timer = setInterval(refreshVisible, 5 * 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    request('/api/admin/platform-prices', { signal: controller.signal })
      .then(result => { setCatalog(result.catalog || null); setError(''); })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason?.message || '标价读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, read]);

  const personal = useMemo(() => groupedOffers(catalog?.products, 'vip'), [catalog]);
  const teams = useMemo(() => groupedOffers(catalog?.products, 'teams_default'), [catalog]);
  const groups = scene === 'vip' ? personal : teams;
  const columns = useMemo(() => priceColumns(groups, scene === 'teams_default'), [groups, scene]);
  const date = observedDate(catalog?.lastObservedAt || catalog?.observedAt);

  return <section className="panel platform-prices" aria-label="平台标价">
    <div className="platform-prices-toolbar">
      <div className="platform-prices-scenes" aria-label="套餐类别">
        <button type="button" className={scene === 'vip' ? 'active' : ''} aria-pressed={scene === 'vip'} onClick={() => setScene('vip')}>个人会员</button>
        <button type="button" className={scene === 'teams_default' ? 'active' : ''} aria-pressed={scene === 'teams_default'} onClick={() => setScene('teams_default')}>团队套餐</button>
      </div>
      {date ? <time dateTime={catalog.lastObservedAt || catalog.observedAt}>读取于 {date}</time> : null}
    </div>
    {error ? <div className="platform-prices-state" role="alert"><span>{error}</span><button type="button" onClick={() => setRead(value => value + 1)}>重试</button></div> : null}
    {loading && !catalog ? <div className="platform-prices-state" role="status">正在读取标价…</div> : null}
    {!loading && !error && !catalog ? <div className="platform-prices-state">暂无平台标价</div> : null}
    {catalog && !groups.length ? <div className="platform-prices-state">暂无{scene === 'vip' ? '个人会员' : '团队套餐'}标价</div> : null}
    {groups.length ? <div className={`platform-price-matrix${scene === 'teams_default' ? ' is-team' : ''}`}
      style={{ '--price-columns': columns.length }}>
      <div className="platform-price-matrix-head" aria-hidden="true"><span>会员等级 · 每月积分</span>
        {columns.map(column => <span key={column.key}>{column.label}</span>)}
      </div>
      {groups.map(group => <PriceRow key={`${scene}-${group.level}`} group={group} columns={columns} />)}
    </div> : null}
  </section>;
}
