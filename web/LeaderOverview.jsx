import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Clock3, Coins, MoveUpRight, UsersRound, X } from 'lucide-react';
import { ManagerSelect } from './ManagerSelect.jsx';
import { buildLeaderOverview } from './leader-overview.js';
import { formatMoney } from './credit-value.js';
import './leader-overview.css';

const STORAGE_KEY = 'jimeng-leader-overview-v2';
const PERIODS = [{ value: 'month', label: '本月' }, { value: 'week', label: '近 7 天' }, { value: 'today', label: '今日' }, { value: 'all', label: '全部时间' }, { value: 'custom', label: '自定义日期' }];
const METRICS = [{ key: 'balance', label: '名下剩余' }, { key: 'operator', label: '本人操作消耗' }, { key: 'borrowed', label: '使用他人额度' }, { key: 'lent', label: '被他人使用' }, { key: 'expiry', label: '到期未用' }];
const DEFAULT_STATE = { period: 'month', from: '', to: '', departmentId: 'all', sort: 'operator', direction: 'desc', expanded: null, detail: 'operator', summaryOpen: null, scrollY: 0, scrollX: 0 };
const format = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const moneyNote = (target, field) => {
  const value = target.money?.[field], unpriced = target.moneyUnpricedByField?.[field] || 0;
  if (unpriced > 0) return '—';
  return Number.isFinite(value) ? `约 ${formatMoney(value)}` : null;
};
const rangeLabel = range => range.label === '全部已采集记录' ? '全部时间' : range.label;
const date = (value, withTime = false) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value));
};
const chinaDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const shortDate = value => value?.replace(/^\d{4}-0?/, '').replace('-0', '/').replace('-', '/') || '';
const scopeName = scope => ({ personal: '个人钱包', team_member: '本人成员额度', team_total: '团队共享钱包' })[scope] || '成员额度';
const dueDayLabel = (value, now) => {
  const days = Math.floor((new Date(value).getTime() + 28_800_000) / 86_400_000) - Math.floor((now + 28_800_000) / 86_400_000);
  return days === 0 ? '今天到期' : days === 1 ? '明天到期' : days > 1 ? `${days} 天后` : '已过期';
};
const metricValue = (row, key) => key === 'expiry' ? !row.accounts?.length && row.ownedConsumption == null && row.operatorConsumption == null && row.expiry.total === 0 ? null : row.expiry.total : key === 'expiring' ? row.expiringAmount + row.estimatedExpiringAmount : ({ balance: row.balance, owned: row.ownedConsumption, operator: row.operatorConsumption, borrowed: row.borrowedConsumption, lent: row.lentConsumption })[key];

function readState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_STATE;
    const state = { ...DEFAULT_STATE, ...saved };
    if (!PERIODS.some(item => item.value === state.period)) state.period = 'month';
    if (!METRICS.some(item => item.key === state.sort)) state.sort = 'operator';
    if (!['asc', 'desc'].includes(state.direction)) state.direction = 'desc';
    if (!['balance', 'owned', 'borrowed', 'expiry', 'expiring'].includes(state.summaryOpen)) state.summaryOpen = null;
    return state;
  } catch { return DEFAULT_STATE; }
}

function LedgerLink({ ids = [], title, openLedger, children = '查看流水' }) {
  if (!ids.length) return null;
  return <button type="button" className="leader-link" onClick={() => openLedger(ids, title)}>{children}<ArrowRight size={13} aria-hidden="true" /></button>;
}

function SummaryWalletName({ wallet }) {
  const person = wallet.employeeName || wallet.ownerName;
  const team = wallet.scope === 'team_total';
  const primary = person ? `${person}${team ? ' · 团队' : ''}` : team ? wallet.spaceName || wallet.displayName || '团队钱包' : wallet.displayName || '其他账号';
  const secondary = [team ? wallet.spaceName : wallet.displayName, scopeName(wallet.scope)].filter((value, index, all) => value && value !== primary && all.indexOf(value) === index).join(' · ');
  return <div className="leader-summary-identity"><strong>{primary}</strong><small title={wallet.platformUserId ? `即梦 ID ${wallet.platformUserId}` : undefined}>{secondary}</small></div>;
}

function SummaryBreakdown({ type, title, overview, openLedger, openWallet, now, onClose }) {
  const { summary, rows, range } = overview;
  const walletMoney = item => moneyNote({ money: { value: item.referenceValue }, moneyUnpricedByField: { value: item.unpricedCredits } }, 'value');
  const wallets = [...(summary.wallets || [])].sort((a, b) => b.balance - a.balance || String(a.accountId).localeCompare(String(b.accountId)));
  const batches = [...(summary.dueBatches || [])].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt) || b.amount - a.amount);
  const relations = rows.flatMap(row => (row.borrowedFrom || []).map(edge => ({ ...edge, operatorId: row.employeeId, operatorName: row.name }))).sort((a, b) => b.amount - a.amount || a.operatorName.localeCompare(b.operatorName, 'zh-CN'));
  const other = overview.unassigned;
  const previousOther = rows.find(row => row.unassigned);
  const otherRow = other ? { ...other, employeeId: 'other-accounts', unassigned: true, ownedConsumption: other.consumption, money: { ...previousOther?.money, ...other.money }, moneyUnpricedByField: { ...previousOther?.moneyUnpricedByField, ...other.moneyUnpricedByField } } : null;
  const people = [...rows.filter(row => !row.unassigned), ...(otherRow ? [otherRow] : [])].filter(row => type === 'expiry' ? row.expiry.total > 0 : row.transactionIds.owned.length > 0).sort((a, b) => type === 'expiry' ? b.expiry.total - a.expiry.total : (b.ownedConsumption || 0) - (a.ownedConsumption || 0));
  const count = type === 'balance' ? wallets.length : type === 'expiring' ? batches.length : type === 'borrowed' ? relations.length : people.length;
  const headings = type === 'balance' ? ['员工 / 钱包', '可用积分', '估算金额', ''] : type === 'expiring' ? ['员工 / 钱包', '到期积分', '到期时间', ''] : type === 'borrowed' ? ['使用关系', '净消耗', '估算金额', ''] : ['员工 / 账号', type === 'expiry' ? '到期未用' : '名下净消耗', '估算金额', ''];
  return <section className="leader-summary-breakdown" id="leader-summary-breakdown" aria-label={title + '明细'}>
    <header className="leader-summary-heading"><div><h2>{title}明细</h2>{type !== 'balance' ? <span>{type === 'expiring' ? date(now) + ' — ' + date(now + 7 * 86400000) : rangeLabel(range)}</span> : null}</div><button type="button" className="leader-close" aria-label="收起摘要明细" onClick={onClose}><X size={17} /></button></header>
    {count ? <div className="leader-summary-scroll"><table className={'leader-summary-table leader-summary-' + type}>
      <thead><tr>{headings.map((label, index) => <th key={index} scope="col">{label || <span className="sr-only">查看明细</span>}</th>)}</tr></thead>
      <tbody>
        {type === 'balance' ? wallets.map(wallet => <tr key={wallet.accountId}><td><SummaryWalletName wallet={wallet} /></td><td><strong>{format(wallet.balance)}</strong></td><td>{walletMoney(wallet)}</td><td><button type="button" className="leader-link" onClick={() => openWallet(wallet)}>钱包<ChevronRight size={13} /></button></td></tr>) : null}
        {type === 'expiring' ? batches.map((batch, index) => <tr key={batch.accountId + '-' + (batch.id || index)}><td><SummaryWalletName wallet={batch} /></td><td><strong className="leader-warning">{format(batch.amount)}</strong>{({ subscription: '会员积分', purchase: '充值积分', gift: '赠送积分' })[batch.kind] ? <small className="leader-summary-sub">{({ subscription: '会员积分', purchase: '充值积分', gift: '赠送积分' })[batch.kind]}</small> : null}</td><td><span className="leader-summary-expiry-date"><time dateTime={batch.expiresAt} title={date(batch.expiresAt, true)}>{date(batch.expiresAt)}</time><small className={batch.estimated ? 'leader-summary-estimated' : 'leader-summary-remaining'}>{batch.estimated ? '预计 · ' : ''}{dueDayLabel(batch.expiresAt, now)}</small></span></td><td><button type="button" className="leader-link" onClick={() => openWallet(batch)}>钱包<ChevronRight size={13} /></button></td></tr>) : null}
        {type === 'borrowed' ? relations.map(edge => <tr key={edge.operatorId + '-' + edge.employeeId}><td><div className="leader-summary-relation"><strong>{edge.operatorName}</strong><span>使用</span><strong>{edge.name}</strong><span>的额度</span></div></td><td><strong className="leader-purple">{format(edge.amount)}</strong></td><td>{moneyNote({ money: { value: edge.money }, moneyUnpricedByField: { value: edge.unpricedCredits } }, 'value')}</td><td><LedgerLink ids={edge.transactionIds} title={edge.operatorName + ' · 使用' + edge.name + '额度'} openLedger={openLedger}>流水</LedgerLink></td></tr>) : null}
        {type === 'owned' || type === 'expiry' ? people.map(row => <tr key={row.employeeId}><td><div className="leader-summary-identity"><strong>{row.unassigned ? '其他账号' : row.name}</strong>{!row.unassigned && row.department ? <small>{row.department}</small> : null}</div></td><td><strong>{format(type === 'expiry' ? row.expiry.total : row.ownedConsumption)}</strong></td><td>{moneyNote(row, type === 'expiry' ? 'expiry' : 'consumption')}</td><td><LedgerLink ids={row.transactionIds[type]} title={(row.unassigned ? '其他账号' : row.name) + ' · ' + (type === 'expiry' ? '到期未用' : '名下净消耗')} openLedger={openLedger}>{type === 'expiry' ? '清零记录' : '流水'}</LedgerLink></td></tr>) : null}
      </tbody>
    </table></div> : <div className="leader-summary-empty">{type === 'balance' ? '—' : type === 'expiring' ? '未来 7 天暂无到期积分' : type === 'borrowed' ? '暂无使用他人额度记录' : '本期暂无记录'}</div>}
    {type === 'balance' && wallets.length ? <footer className="leader-summary-footer"><span>小计 {format(summary.availableBalance)} 积分</span><span>{moneyNote(summary, 'availableBalance')}</span></footer> : null}
  </section>;
}

function DailyTrend({ row, operator = false }) {
  const [active, setActive] = useState(null);
  const key = operator ? 'operator' : 'owned';
  const total = operator ? row.operatorConsumption : row.ownedConsumption;
  const series = row.daily || [];
  if (!Number.isFinite(total) || !series.length) return <div className="leader-detail-empty">—</div>;
  const low = Math.min(0, ...series.map(item => item[key] || 0));
  const high = Math.max(1, ...series.map(item => item[key] || 0));
  const x = index => 10 + (series.length === 1 ? 180 : index / (series.length - 1) * 360);
  const y = value => 82 - ((value || 0) - low) / (high - low) * 70;
  const point = active == null ? null : series[active];
  return <div className="leader-trend">
    <div className="leader-trend-plot" onMouseLeave={() => setActive(null)}>
      {point ? <div className="leader-trend-tip" style={{ left: Math.min(86, Math.max(14, x(active) / 380 * 100)) + '%' }}><strong>{shortDate(point.date)}</strong><span>{operator ? '本人操作' : '名下消耗'} <b>{format(point[key])} 分</b></span></div> : null}
      <svg viewBox="0 0 380 94" role="img" aria-label={row.name + (operator ? '本人操作' : '名下消耗') + '每日趋势'}>
        <line className="leader-trend-baseline" x1="10" x2="370" y1={y(0)} y2={y(0)} />
        <polyline className="leader-trend-owned" points={series.map((item, index) => x(index) + ',' + y(item[key])).join(' ')} />
        {series.length === 1 ? <circle className="leader-trend-dot-owned" cx={x(0)} cy={y(series[0][key])} r="3" /> : null}
        {active == null ? null : <><line className="leader-trend-crosshair" x1={x(active)} x2={x(active)} y1="4" y2="88" /><circle className="leader-trend-dot-owned" cx={x(active)} cy={y(point[key])} r="3.6" /></>}
        {series.map((item, index) => <rect key={item.date} x={x(index) - Math.max(4, 180 / series.length)} y="0" width={Math.max(8, 360 / series.length)} height="94" fill="transparent" onMouseEnter={() => setActive(index)} onMouseMove={() => setActive(index)} />)}
      </svg>
      <div className="leader-trend-axis"><span>{shortDate(series[0].date)}</span><span>{shortDate(series[series.length - 1].date)}</span></div>
    </div>
  </div>;
}

function Relations({ row, direction, openLedger }) {
  const borrowed = direction === 'borrowed';
  const edges = borrowed ? row.borrowedFrom : row.lentTo;
  return <div className="leader-detail-block"><h3>{borrowed ? '用了谁的额度' : '名下积分被谁用了'}</h3>{edges?.length ? <div className="leader-relations">{edges.map(edge => <button type="button" key={edge.employeeId || edge.name} onClick={() => openLedger(edge.transactionIds, `${row.name} · ${borrowed ? `使用${edge.name}额度` : `被${edge.name}使用`}`)}><span><strong>{edge.name}</strong><small>{edge.department || ''}</small></span><span className="leader-relation-amount"><strong>{format(edge.amount)} <small>分</small></strong><small>{moneyNote({ money: { value: edge.money }, moneyUnpricedByField: { value: edge.unpricedCredits } }, 'value')}</small></span><ChevronRight size={14} aria-hidden="true" /></button>)}</div> : <p className="leader-detail-empty">{metricValue(row, direction) == null ? '—' : borrowed ? '暂无使用他人额度记录' : '暂无他人使用记录'}</p>}</div>;
}

function TransactionPreview({ ids, transactionMap, title, openLedger }) {
  const rows = (ids || []).map(id => transactionMap.get(id)).filter(Boolean).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  return <>{rows.length ? <div className="leader-transaction-preview">{rows.slice(0, 4).map(item => <div key={item.id}><span>{date(item.occurredAt, true)}<small>{item.description || item.model || ({ expire: '积分到期', refund: '积分退回', consume: '生成消费' })[item.kind] || '积分变动'}</small></span><strong>{item.amount > 0 ? '+' : ''}{format(item.amount)}</strong></div>)}</div> : <p className="leader-detail-empty">本期暂无记录</p>}<LedgerLink ids={ids} title={title} openLedger={openLedger}>查看全部流水</LedgerLink></>;
}

function BalanceDetail({ row, onNavigate }) {
  return <>
    <div className="leader-detail-block"><h3>余额构成</h3><dl className="leader-breakdown"><div><dt>个人钱包</dt><dd>{format(row.personalBalance)}</dd></div><div><dt>本人成员额度</dt><dd>{format(row.teamBalance)}</dd></div></dl>{moneyNote(row, 'balance') ? <p className="leader-detail-money">{moneyNote(row, 'balance')}</p> : null}</div>
    <div className="leader-detail-block"><h3>未来 7 天到期</h3>{row.dueBatches?.length ? <div className="leader-due-list">{row.dueBatches.map((batch, index) => <div key={(batch.id || batch.accountId) + '-' + index}><span>{batch.estimated ? '预计 ' : ''}{date(batch.expiresAt)}<small>{scopeName(batch.scope)}</small></span><strong>{format(batch.amount)} 分</strong></div>)}</div> : <p className="leader-detail-empty">—</p>}</div>
    <div className="leader-detail-block"><h3>名下账号</h3>{row.accounts?.length ? <div className="leader-account-list">{row.accounts.map((account, index) => <div key={account.id || account.platformUserId + '-' + index}><strong>{account.displayName || account.nickname || '账号'}</strong><small>{scopeName(account.scope)}</small></div>)}</div> : null}<button type="button" className="leader-link" onClick={() => onNavigate('accounts', { employeeId: row.employeeId })}>查看账号与钱包<ArrowRight size={13} /></button></div>
  </>;
}

function EmployeeDetail({ row, detail, range, transactionMap, openLedger, onNavigate, onClose }) {
  const title = METRICS.find(item => item.key === detail)?.label || '名下消耗';
  const ledger = (ids, label) => <LedgerLink ids={ids} title={row.name + ' · ' + label} openLedger={openLedger}>查看流水</LedgerLink>;
  const isOperator = detail === 'operator';
  const total = isOperator ? row.operatorConsumption : row.ownedConsumption;
  const gross = Number.isFinite(total) ? isOperator ? row.grossOperatorConsumption : row.grossConsumption : null;
  const refunds = Number.isFinite(total) ? isOperator ? row.operatorRefunds : row.linkedRefunds : null;
  const amountNote = moneyNote(row, isOperator ? 'operatorConsumption' : 'consumption');
  const composition = isOperator && Number.isFinite(total)
    ? [{ term: '使用自有额度', value: row.selfConsumption }, { term: '使用他人额度', value: row.borrowedConsumption, purple: true }, ...(row.unknownOwnerConsumption > 0 ? [{ term: '其他账号', value: row.unknownOwnerConsumption }] : [])]
    : [{ term: '扣费', value: gross }, { term: '退回', value: refunds }, { term: '净消耗', value: total }];
  return <section className="leader-inline-detail" aria-label={row.name + ' · ' + title}>
    <div className="leader-detail-top"><strong>{row.name} · {title}</strong>{detail !== 'balance' ? <span>{rangeLabel(range)}</span> : null}<button type="button" className="leader-close" aria-label={'收起' + row.name + '明细'} onClick={onClose}><X size={17} /></button></div>
    {detail === 'balance' ? <div className="leader-detail-grid leader-detail-grid-3"><BalanceDetail row={row} onNavigate={onNavigate} /></div> : null}
    {detail === 'expiry' ? <div className="leader-detail-grid leader-detail-grid-wide">
      <div className="leader-detail-block"><h3>到期未用 <strong>{format(metricValue(row, 'expiry'))} 分</strong></h3>{metricValue(row, 'expiry') != null && moneyNote(row, 'expiry') ? <p className="leader-detail-money">{moneyNote(row, 'expiry')}</p> : null}</div>
      <div className="leader-detail-block"><h3>清零记录</h3>{metricValue(row, 'expiry') == null ? <p className="leader-detail-empty">—</p> : <TransactionPreview ids={row.transactionIds.expiry} transactionMap={transactionMap} title={row.name + ' · 到期未用'} openLedger={openLedger} />}</div>
    </div> : null}
    {detail === 'borrowed' || detail === 'lent' ? <div className="leader-detail-grid">
      <Relations row={row} direction={detail} openLedger={openLedger} />
      <div className="leader-detail-block"><h3>本期合计 <strong>{format(metricValue(row, detail))} 分</strong></h3>{moneyNote(row, detail === 'borrowed' ? 'borrowedConsumption' : 'lentConsumption') ? <p className="leader-detail-money">{moneyNote(row, detail === 'borrowed' ? 'borrowedConsumption' : 'lentConsumption')}</p> : null}<div className="leader-detail-actions">{ledger(row.transactionIds[detail], title)}</div></div>
    </div> : null}
    {detail === 'owned' || detail === 'operator' ? <div className="leader-detail-grid">
      <div className="leader-detail-block"><h3>每日用量</h3><DailyTrend row={row} operator={isOperator} /></div>
      <div className="leader-detail-block"><h3>{title} <strong>{format(total)} 分</strong></h3><dl className="leader-breakdown">{composition.map(item => <div key={item.term}><dt>{item.term}</dt><dd className={item.purple ? 'leader-purple' : undefined}>{format(item.value)}</dd></div>)}</dl>{amountNote ? <p className="leader-detail-money">{amountNote}</p> : null}{isOperator && refunds > 0 ? <p className="leader-detail-note">扣费 {format(gross)} · 退回 {format(refunds)}</p> : null}<div className="leader-detail-actions">{ledger(row.transactionIds[detail], title)}{refunds > 0 ? <LedgerLink ids={isOperator ? row.transactionIds.operatorRefund : row.transactionIds.refund} title={row.name + ' · ' + (isOperator ? '本人操作' : '名下账号') + '退回'} openLedger={openLedger}>退回记录</LedgerLink> : null}</div></div>
    </div> : null}
  </section>;
}

export default function LeaderOverview({ data, onNavigate, onAccount }) {
  const [state, setState] = useState(readState);
  const [now, setNow] = useState(Date.now);
  const tableRef = useRef(null), detailRowRef = useRef(null), stateRef = useRef(state);
  const savedPosition = useRef({ y: state.scrollY, x: state.scrollX });
  stateRef.current = state;
  const update = patch => setState(previous => ({ ...previous, ...patch }));
  const departments = data.departments || [];
  const departmentId = state.departmentId === 'all' || departments.some(item => item.id === state.departmentId) ? state.departmentId : 'all';
  const overview = useMemo(() => buildLeaderOverview({ ...data, period: state.period, from: state.from || null, to: state.to || null, departmentId, now, useLastKnownBalances: true }), [data, state.period, state.from, state.to, departmentId, now]);
  const { range, summary } = overview;
  const transactionMap = useMemo(() => new Map((data.transactions || []).map(item => [item.id, item])), [data.transactions]);
  const visible = overview.rows.filter(row => !row.unassigned).sort((a, b) => {
    const left = metricValue(a, state.sort), right = metricValue(b, state.sort);
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
    return ((left ?? 0) - (right ?? 0)) * (state.direction === 'asc' ? 1 : -1) || a.name.localeCompare(b.name, 'zh-CN');
  });
  const persist = () => { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stateRef.current, scrollY: window.scrollY, scrollX: tableRef.current?.scrollLeft || 0 })); } catch { /* A disabled storage policy must not block the dashboard. */ } };
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { persist(); }, [state]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (savedPosition.current.y) window.scrollTo(0, savedPosition.current.y); if (tableRef.current) tableRef.current.scrollLeft = savedPosition.current.x || 0; });
    window.addEventListener('scroll', persist, { passive: true });
    const closeOnEscape = event => { if (event.key === 'Escape') setState(previous => previous.summaryOpen ? { ...previous, summaryOpen: null } : previous.expanded ? { ...previous, expanded: null } : previous); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { cancelAnimationFrame(frame); persist(); window.removeEventListener('scroll', persist); window.removeEventListener('keydown', closeOnEscape); };
  }, []);
  // 展开明细时只滚动表格区域，页面保持不动。让被点的员工行连同明细尽量一起进入可视区。
  useEffect(() => {
    const region = tableRef.current, detail = detailRowRef.current;
    if (!region || !detail || state.expanded == null) return;
    const row = detail.previousElementSibling;
    if (!row) return;
    const regionRect = region.getBoundingClientRect(), rowRect = row.getBoundingClientRect();
    const headerHeight = region.querySelector('thead')?.getBoundingClientRect().height || 0;
    const room = regionRect.bottom - regionRect.top - headerHeight;
    if (room <= 0) return;
    const rowOffset = rowRect.top - regionRect.top - headerHeight;
    const wanted = Math.min(detail.getBoundingClientRect().height + rowRect.height, room);
    if (rowOffset + wanted > room) region.scrollTop += rowOffset + wanted - room;
  }, [state.expanded, state.detail]);
  const navigate = (page, focus) => { persist(); onNavigate?.(page, focus); };
  const openLedger = (ids, title) => navigate('ledger', { transactionIds: [...new Set(ids || [])], title, period: 'all' });
  const openWallet = wallet => { persist(); onAccount?.((data.accounts || []).find(account => account.id === wallet.accountId) || { ...wallet, id: wallet.accountId }); };
  const toggleSummary = key => update({ summaryOpen: state.summaryOpen === key ? null : key });
  const expand = (row, detail) => update({ expanded: state.expanded === row.employeeId && state.detail === detail ? null : row.employeeId, detail });
  const sortBy = key => update({ sort: key, direction: state.sort === key && state.direction === 'desc' ? 'asc' : 'desc' });
  const reset = () => update({ ...DEFAULT_STATE });
  const cards = [
    { key: 'balance', label: '剩余可用', value: summary.availableBalance, moneyField: 'availableBalance', icon: Coins, tone: 'blue' },
    { key: 'owned', label: '本期消耗', value: summary.netConsumption, moneyField: 'netConsumption', icon: MoveUpRight },
    { key: 'borrowed', label: '使用他人额度', value: summary.borrowedConsumption, moneyField: 'borrowedConsumption', icon: UsersRound, tone: 'purple' },
    { key: 'expiry', label: '到期浪费', value: summary.expiry.total, moneyField: 'expiry', icon: Clock3 },
    { key: 'expiring', label: '7 天内到期', value: summary.expiringAmount + summary.estimatedExpiringAmount, icon: Clock3, tone: 'amber', note: '截至 ' + date(now + 7 * 86400000) },
  ];
  return <div className="leader-overview">
    <div className="leader-controls"><div className="leader-period-label">{range.error ? <span role="alert" className="leader-danger">{range.error}</span> : <strong>{rangeLabel(range)}</strong>}</div><div className="leader-controls-inputs"><ManagerSelect label="总览时间范围" value={state.period} options={PERIODS} onChange={period => update({ period, expanded: null, ...(period === 'custom' && !state.from ? { from: chinaDay(now).slice(0, 8) + '01', to: chinaDay(now) } : {}) })} />{state.period === 'custom' ? <div className="leader-date-range"><input type="date" aria-label="开始日期" value={state.from} max={state.to || chinaDay(now)} onChange={event => update({ from: event.target.value, expanded: null })} /><span>至</span><input type="date" aria-label="结束日期" value={state.to} min={state.from || undefined} max={chinaDay(now)} onChange={event => update({ to: event.target.value, expanded: null })} /></div> : null}<ManagerSelect label="总览部门" value={departmentId} onChange={departmentId => update({ departmentId, expanded: null })} options={[{ value: 'all', label: '全部部门' }, ...departments.map(item => ({ value: item.id, label: item.name }))]} searchable />{state.period !== 'month' || departmentId !== 'all' ? <button type="button" className="leader-link" onClick={reset}>重置</button> : null}</div></div>
    {range.error ? null : <>
      <section className="leader-stats" aria-label="积分摘要">{cards.map(card => { const Icon = card.icon; return <button type="button" key={card.key} className={`leader-stat ${card.tone ? `leader-stat-${card.tone}` : ''}`} onClick={() => toggleSummary(card.key)} aria-expanded={state.summaryOpen === card.key} aria-controls={state.summaryOpen === card.key ? 'leader-summary-breakdown' : undefined}><span className="leader-stat-label">{card.label}<Icon size={16} aria-hidden="true" /></span><strong>{format(card.value)}<small>积分</small></strong><span className="leader-stat-note">{card.moneyField ? moneyNote(summary, card.moneyField) : card.note}<ChevronDown size={12} aria-hidden="true" /></span></button>; })}</section>
      {state.summaryOpen ? <SummaryBreakdown type={state.summaryOpen} title={cards.find(card => card.key === state.summaryOpen)?.label || '积分'} overview={overview} openLedger={openLedger} openWallet={openWallet} now={Math.max(now, Number.isFinite(Date.parse(data.asOf)) ? Date.parse(data.asOf) : now)} onClose={() => update({ summaryOpen: null })} /> : null}
      <section className="leader-board">
        <div className="leader-board-heading"><h2>员工用量 <small>积分</small></h2></div>
        <div className="leader-table-scroll" ref={tableRef} onScroll={persist}><table className="leader-table"><thead><tr><th scope="col">员工 / 部门</th>{METRICS.map(metric => <th scope="col" key={metric.key} aria-sort={state.sort === metric.key ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortBy(metric.key)}>{metric.label}{state.sort === metric.key ? state.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} /> : <ArrowUpDown size={12} />}</button></th>)}</tr></thead><tbody>{visible.map(row => <Fragment key={row.employeeId}><tr className={`leader-employee-row ${state.expanded === row.employeeId ? 'expanded' : ''}`}><th scope="row"><button type="button" className="leader-person" aria-expanded={state.expanded === row.employeeId} onClick={() => expand(row, 'operator')}><span className="leader-avatar">{row.name.slice(-2)}</span><span><strong>{row.name}{row.removed ? <small className="leader-removed">已移除</small> : null}</strong><small>{row.department || ''}</small></span>{state.expanded === row.employeeId ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button><button type="button" className="leader-owned-preview" onClick={() => expand(row, 'owned')} aria-label={`查看${row.name}名下消耗 ${format(row.ownedConsumption)} 积分`} aria-expanded={state.expanded === row.employeeId && state.detail === 'owned'}>名下消耗 <strong>{format(row.ownedConsumption)}</strong>{row.ownedConsumption != null && moneyNote(row, 'consumption') ? <span className="leader-owned-money">{moneyNote(row, 'consumption')}</span> : null}</button></th>{METRICS.map(metric => { const value = metricValue(row, metric.key); let note = null;
          if (metric.key === 'balance') note = value == null ? null : moneyNote(row, 'balance');
          if (metric.key === 'operator') note = value == null ? null : moneyNote(row, 'operatorConsumption');
          if (metric.key === 'borrowed') note = value > 0 ? moneyNote(row, 'borrowedConsumption') : null;
          if (metric.key === 'lent') note = value > 0 ? moneyNote(row, 'lentConsumption') : null;
          if (metric.key === 'expiry') note = value > 0 ? moneyNote(row, 'expiry') : null;
          return <td key={metric.key}><button type="button" className={`leader-metric-cell ${metric.key === 'balance' ? 'leader-balance' : ['borrowed', 'lent'].includes(metric.key) && value > 0 ? 'leader-purple' : ''} ${value === null ? 'leader-metric-unknown' : ''}`} aria-label={`查看${row.name}${metric.label}${value === null ? '' : ` ${format(value)} 积分`}`} aria-expanded={state.expanded === row.employeeId && state.detail === metric.key} onClick={() => expand(row, metric.key)}><strong>{format(value)}</strong>{note ? <small>{note}</small> : null}</button></td>;
        })}</tr>{state.expanded === row.employeeId ? <tr className="leader-expanded-row" ref={detailRowRef}><td colSpan={6}><EmployeeDetail row={row} detail={state.detail} range={range} transactionMap={transactionMap} openLedger={openLedger} onNavigate={navigate} onClose={() => update({ expanded: null })} /></td></tr> : null}</Fragment>)}</tbody></table>{!visible.length ? <div className="leader-empty"><UsersRound size={26} /><strong>{departmentId === 'all' ? '暂无员工' : '该部门暂无员工'}</strong><button type="button" className="leader-link" onClick={() => navigate('directory')}>维护员工与部门<ArrowRight size={13} /></button></div> : null}</div>

      </section>

    </>}
  </div>;
}
