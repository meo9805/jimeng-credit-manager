import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Clock3, Coins, MoveUpRight, UsersRound, X } from 'lucide-react';
import { ManagerSelect } from './ManagerSelect.jsx';
import { buildLeaderOverview } from './leader-overview.js';
import { PRICE_TABLE, formatMoney } from './credit-value.js';
import './leader-overview.css';

const STORAGE_KEY = 'jimeng-leader-overview-v1';
const PERIODS = [{ value: 'month', label: '本月' }, { value: 'week', label: '近 7 天' }, { value: 'today', label: '今日' }, { value: 'all', label: '全部已采集' }, { value: 'custom', label: '自定义日期' }];
/** 摘要卡是唯一的取数入口，这里只保留卡片能设置的筛选值。 */
const FILTER_VALUES = ['all', 'balance', 'borrowed', 'expiry', 'expiring', 'pending'];
const FILTER_TITLES = { borrowed: '使用他人额度', expiry: '到期未用', expiring: '7 天内到期', pending: '数据待补齐' };
const METRICS = [{ key: 'balance', label: '名下剩余' }, { key: 'owned', label: '名下消耗' }, { key: 'operator', label: '本人操作' }, { key: 'borrowed', label: '使用他人额度' }, { key: 'lent', label: '被他人使用' }, { key: 'expiry', label: '到期未用' }];
const DEFAULT_STATE = { period: 'month', from: '', to: '', departmentId: 'all', filter: 'all', sort: 'owned', direction: 'desc', expanded: null, detail: 'owned', scrollY: 0, scrollX: 0 };
const format = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
/** 积分后面跟一份人民币估算：“约”字已经说明是估算值，不再另加标记。 */
const moneyText = value => Number.isFinite(value) ? formatMoney(value) : null;
const joinNote = (...parts) => { const items = parts.filter(Boolean); return items.length ? items.join(' · ') : null; };
const date = (value, withTime = false) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '未采集';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value));
};
const chinaDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const shortDate = value => value?.replace(/^\d{4}-0?/, '').replace('-0', '/').replace('-', '/') || '';
const scopeName = scope => ({ personal: '个人钱包', team_member: '本人成员额度', team_total: '团队共享钱包' })[scope] || '成员额度';
const metricValue = (row, key) => key === 'expiry' ? row.expiry.total : key === 'expiring' ? row.expiringAmount + row.estimatedExpiringAmount : ({ balance: row.balance, owned: row.ownedConsumption, operator: row.operatorConsumption, borrowed: row.borrowedConsumption, lent: row.lentConsumption })[key];

function needsData(row) {
  return row.balance === null || row.balancePartial || row.unconfirmedConsumption > 0 || row.unknownExpiryCount > 0;
}

function readState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_STATE;
    const state = { ...DEFAULT_STATE, ...saved };
    if (!PERIODS.some(item => item.value === state.period)) state.period = 'month';
    if (!FILTER_VALUES.includes(state.filter)) state.filter = 'all';
    if (![...METRICS.map(item => item.key), 'expiring'].includes(state.sort)) state.sort = 'owned';
    if (!['asc', 'desc'].includes(state.direction)) state.direction = 'desc';
    return state;
  } catch { return DEFAULT_STATE; }
}

function LedgerLink({ ids = [], title, openLedger, children = '查看流水' }) {
  if (!ids.length) return null;
  return <button type="button" className="leader-link" onClick={() => openLedger(ids, title)}>{children}<ArrowRight size={13} aria-hidden="true" /></button>;
}

/** 曲线按交易日逐点悬停，显示当天的名下消耗和本人操作。 */
function DailyTrend({ row, days }) {
  const [active, setActive] = useState(null);
  const series = row.daily || [];
  if (!series.length) return <div className="leader-detail-empty">所选期间暂无每日用量记录</div>;
  const low = Math.min(0, ...series.flatMap(item => [item.owned || 0, item.operator || 0]));
  const high = Math.max(1, ...series.flatMap(item => [item.owned || 0, item.operator || 0]));
  const x = index => 10 + (series.length === 1 ? 180 : index / (series.length - 1) * 360);
  const y = value => 82 - ((value || 0) - low) / (high - low) * 70;
  const point = active == null ? null : series[active];
  return <div className="leader-trend">
    <div className="leader-trend-legend"><span><i />名下消耗</span><span><i />本人操作</span><small>悬停查看当天数值</small></div>
    <div className="leader-trend-plot" onMouseLeave={() => setActive(null)}>
      {point ? <div className="leader-trend-tip" style={{ left: `${Math.min(86, Math.max(14, x(active) / 380 * 100))}%` }}>
        <strong>{shortDate(point.date)}</strong>
        <span><i />名下消耗 <b>{format(point.owned)}</b></span>
        <span><i />本人操作 <b>{format(point.operator)}</b></span>
      </div> : null}
      <svg viewBox="0 0 380 94" role="img" aria-label={`${row.name}每日净消耗趋势，${series.length}天有已采集记录`}>
        <line className="leader-trend-baseline" x1="10" x2="370" y1={y(0)} y2={y(0)} />
        <polyline className="leader-trend-owned" points={series.map((item, index) => `${x(index)},${y(item.owned)}`).join(' ')} />
        <polyline className="leader-trend-operator" points={series.map((item, index) => `${x(index)},${y(item.operator)}`).join(' ')} />
        {series.length === 1 ? <><circle className="leader-trend-dot-owned" cx={x(0)} cy={y(series[0].owned)} r="3" /><circle className="leader-trend-dot-operator" cx={x(0)} cy={y(series[0].operator)} r="3" /></> : null}
        {active == null ? null : <><line className="leader-trend-crosshair" x1={x(active)} x2={x(active)} y1="4" y2="88" /><circle className="leader-trend-dot-owned" cx={x(active)} cy={y(point.owned)} r="3.6" /><circle className="leader-trend-dot-operator" cx={x(active)} cy={y(point.operator)} r="3.6" /></>}
        {series.map((item, index) => <rect key={item.date} x={x(index) - Math.max(4, 180 / series.length)} y="0" width={Math.max(8, 360 / series.length)} height="94" fill="transparent" onMouseEnter={() => setActive(index)} onMouseMove={() => setActive(index)} />)}
      </svg>
      <div className="leader-trend-axis"><span>{shortDate(series[0].date)}</span><span>{days > 0 ? `日均名下消耗 ${format((row.ownedConsumption || 0) / days)} 分` : '已采集用量'}</span><span>{shortDate(series[series.length - 1].date)}</span></div>
    </div>
    <details className="leader-daily-values"><summary>每日数值</summary><div><table><thead><tr><th>日期</th><th>名下消耗</th><th>本人操作</th></tr></thead><tbody>{series.map(item => <tr key={item.date}><td>{item.date}</td><td>{format(item.owned)}</td><td>{format(item.operator)}</td></tr>)}</tbody></table></div></details>
  </div>;
}

function Relations({ row, direction, openLedger }) {
  const borrowed = direction === 'borrowed';
  const edges = borrowed ? row.borrowedFrom : row.lentTo;
  return <div className="leader-detail-block"><h3>{borrowed ? '用了谁的额度' : '名下积分被谁用了'}</h3>{edges?.length ? <div className="leader-relations">{edges.map(edge => <button type="button" key={edge.employeeId || edge.name} onClick={() => openLedger(edge.transactionIds, `${row.name} · ${borrowed ? `使用${edge.name}额度` : `被${edge.name}使用`}`)}><span><strong>{edge.name}</strong><small>{edge.department || '部门未设置'}</small></span><strong>{format(edge.amount)} <small>分</small></strong><ChevronRight size={14} aria-hidden="true" /></button>)}</div> : <p className="leader-detail-empty">{borrowed ? '暂无已确认的使用他人额度记录' : '暂无已确认的他人使用记录'}</p>}{borrowed && edges?.length ? <p className="leader-detail-note">使用时的自有余额未确认</p> : null}</div>;
}

function ExpirySplit({ expiry }) {
  return <dl className="leader-breakdown"><div><dt>会员 / 充值</dt><dd className={expiry.paid > 0 ? 'leader-danger' : ''}>{format(expiry.paid)}</dd></div><div><dt>免费赠送</dt><dd>{format(expiry.gift)}</dd></div><div><dt>来源未分类</dt><dd>{format(expiry.unclassified)}</dd></div></dl>;
}

function TransactionPreview({ ids, transactionMap, title, openLedger }) {
  const rows = (ids || []).map(id => transactionMap.get(id)).filter(Boolean).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  return <>{rows.length ? <div className="leader-transaction-preview">{rows.slice(0, 4).map(item => <div key={item.id}><span>{date(item.occurredAt, true)}<small>{item.description || item.model || ({ expire: '积分到期', refund: '积分退回', consume: '生成消费' })[item.kind] || '积分变动'}</small></span><strong>{item.amount > 0 ? '+' : ''}{format(item.amount)}</strong></div>)}</div> : <p className="leader-detail-empty">所选期间暂无已采集记录</p>}<LedgerLink ids={ids} title={title} openLedger={openLedger}>查看全部流水</LedgerLink></>;
}

function BalanceDetail({ row, onNavigate }) {
  return <>
    <div className="leader-detail-block"><h3>余额构成</h3><dl className="leader-breakdown"><div><dt>个人钱包</dt><dd>{format(row.personalBalance)}</dd></div><div><dt>本人成员额度</dt><dd>{format(row.teamBalance)}</dd></div>{row.staleBalance > 0 ? <div><dt>旧余额 · 未计入本行</dt><dd className="leader-warning">{format(row.staleBalance)}</dd></div> : null}</dl>{moneyText(row.money?.balance, row.moneyEstimated) ? <p className="leader-detail-money">折算金额 约 {moneyText(row.money?.balance, row.moneyEstimated)}</p> : null}<p className="leader-detail-note">最近采集 {date(row.lastSyncedAt, true)}{row.balancePartial ? ' · 余额尚不完整' : ''}</p></div>
    <div className="leader-detail-block"><h3>未来 7 天到期</h3>{row.dueBatches?.length ? <div className="leader-due-list">{row.dueBatches.map((batch, index) => <div key={`${batch.id || batch.accountId}-${index}`}><span>{batch.estimated ? '预计 ' : ''}{date(batch.expiresAt)}<small>{scopeName(batch.scope)}</small></span><strong>{format(batch.amount)} 分</strong></div>)}</div> : <p className="leader-detail-empty">暂无已知的近期到期批次</p>}{row.unknownExpiryCount > 0 ? <p className="leader-detail-note">{row.unknownExpiryCount} 项到期时间待补齐</p> : null}</div>
    <div className="leader-detail-block"><h3>名下账号与额度</h3>{row.accounts?.length ? <div className="leader-account-list">{row.accounts.map((account, index) => <div key={account.id || `${account.platformUserId}-${index}`}><strong>{account.displayName || account.nickname || '昵称未获取'}</strong><small>{scopeName(account.scope)} · ID {account.platformUserId || '未获取'}</small></div>)}</div> : <p className="leader-detail-empty">暂无已归属账号</p>}<button type="button" className="leader-link" onClick={() => onNavigate('accounts', { search: row.name })}>查看账号与钱包<ArrowRight size={13} /></button></div>
  </>;
}

/**
 * 展开区只解释本行数字是怎么来的：不重复表格里已有的合计，
 * 内容跟随被点击的那一列，因此不需要再放一排重复的页签。
 */
function EmployeeDetail({ row, detail, range, transactionMap, openLedger, onNavigate, onClose }) {
  const title = METRICS.find(item => item.key === detail)?.label || '用量明细';
  const ledger = (ids, label) => <LedgerLink ids={ids} title={`${row.name} · ${label}`} openLedger={openLedger}>查看{label}流水</LedgerLink>;
  const composition = detail === 'operator'
    ? [{ term: '使用自有额度', value: row.selfConsumption }, { term: '使用他人额度', value: row.borrowedConsumption, purple: true }, { term: '额度归属未确认', value: row.unknownOwnerConsumption }]
    : [{ term: '使用自有额度', value: row.selfConsumption }, { term: '被他人使用', value: row.lentConsumption, purple: true }, { term: '操作者未确认', value: row.unconfirmedConsumption, warning: row.unconfirmedConsumption > 0 }];
  return <section className="leader-inline-detail" aria-label={`${row.name} · ${title}`}>
    <div className="leader-detail-top"><strong>{row.name} · {title}</strong><span>{detail === 'balance' ? `最近采集 ${date(row.lastSyncedAt, true)}` : range.label}</span><button type="button" className="leader-close" aria-label={`收起${row.name}明细`} onClick={onClose}><X size={17} /></button></div>
    {detail === 'balance' ? <div className="leader-detail-grid leader-detail-grid-3"><BalanceDetail row={row} onNavigate={onNavigate} /></div> : null}
    {detail === 'expiry' ? <div className="leader-detail-grid leader-detail-grid-wide">
      <div className="leader-detail-block"><h3>到期来源</h3><ExpirySplit expiry={row.expiry} />{moneyText(row.money?.expiry, row.moneyEstimated) ? <p className="leader-detail-money">折算金额 约 {moneyText(row.money?.expiry, row.moneyEstimated)}</p> : null}<p className="leader-detail-note">只统计平台已确认清零的积分{row.unknownExpiryCount > 0 ? `；另有 ${row.unknownExpiryCount} 项到期时间未获取` : ''}</p></div>
      <div className="leader-detail-block"><h3>到期记录</h3><TransactionPreview ids={row.transactionIds.expiry} transactionMap={transactionMap} title={`${row.name} · 到期未用`} openLedger={openLedger} /></div>
    </div> : null}
    {detail === 'borrowed' || detail === 'lent' ? <div className="leader-detail-grid">
      <Relations row={row} direction={detail} openLedger={openLedger} />
      <div className="leader-detail-block"><h3>口径</h3><p className="leader-detail-note">{detail === 'borrowed' ? '使用他人额度记在实际操作者名下，账号归属人不变；只有匹配到操作凭证才计入。' : '名下积分被他人使用：积分从本行员工的账号或成员额度扣除，实际操作者是别人。'}</p>{ledger(row.transactionIds[detail], title)}</div>
    </div> : null}
    {detail === 'owned' || detail === 'operator' ? <>
      <div className="leader-detail-grid">
        <div className="leader-detail-block"><h3>每日用量</h3><DailyTrend row={row} days={range.days} /></div>
        <div className="leader-detail-block"><h3>构成</h3><dl className="leader-breakdown">{composition.map(item => <div key={item.term}><dt>{item.term}</dt><dd className={item.purple ? 'leader-purple' : item.warning ? 'leader-warning' : undefined}>{format(item.value)}</dd></div>)}</dl><p className="leader-detail-note">三项相加即本行「{title}」。</p>{moneyText(row.money?.consumption, row.moneyEstimated) ? <p className="leader-detail-money">折算金额 约 {moneyText(row.money?.consumption, row.moneyEstimated)}</p> : null}<p className="leader-detail-note">本期扣费 {format(row.grossConsumption)}{row.linkedRefunds > 0 ? ` · 关联退回 ${format(row.linkedRefunds)}` : ''}{row.legacyOwnershipAmount > 0 ? ` · 历史归属按首次登记映射 ${format(row.legacyOwnershipAmount)} 分` : ''}</p>{ledger(row.transactionIds[detail], title)}</div>
      </div>
      <div className="leader-detail-grid leader-detail-relations">
        {detail === 'owned' ? <Relations row={row} direction="borrowed" openLedger={openLedger} /> : null}
        <Relations row={row} direction={detail === 'operator' ? 'borrowed' : 'lent'} openLedger={openLedger} />
        {detail === 'operator' && row.linkedRefunds > 0 ? <div className="leader-detail-block"><h3>退回</h3><p className="leader-detail-note">本人操作按扣费记账，关联退回单独列示，不从本人操作里倒扣。</p><LedgerLink ids={row.transactionIds.refund} title={`${row.name} · 积分退回`} openLedger={openLedger}>退回记录{row.unmatchedRefunds > 0 ? ` · ${format(row.unmatchedRefunds)} 分未关联` : ''}</LedgerLink></div> : null}
      </div>
    </> : null}
  </section>;
}

export default function LeaderOverview({ data, onNavigate }) {
  const [state, setState] = useState(readState);
  const [now, setNow] = useState(Date.now);
  const tableRef = useRef(null), detailRowRef = useRef(null), stateRef = useRef(state);
  const savedPosition = useRef({ y: state.scrollY, x: state.scrollX });
  stateRef.current = state;
  const update = patch => setState(previous => ({ ...previous, ...patch }));
  const departments = data.departments || [];
  const departmentId = state.departmentId === 'all' || departments.some(item => item.id === state.departmentId) ? state.departmentId : 'all';
  const overview = useMemo(() => buildLeaderOverview({ ...data, period: state.period, from: state.from || null, to: state.to || null, departmentId, now }), [data, state.period, state.from, state.to, departmentId, now]);
  const { range, summary } = overview;
  const transactionMap = useMemo(() => new Map((data.transactions || []).map(item => [item.id, item])), [data.transactions]);
  // 摘要卡只排序和高亮，不删行：一旦按卡片过滤掉行，整页高度会骤降，页面就会跟着跳。
  const matchesFilter = row => state.filter === 'borrowed' ? row.borrowedConsumption > 0 : state.filter === 'expiry' ? row.expiry.total > 0 : state.filter === 'expiring' ? row.expiringAmount + row.estimatedExpiringAmount > 0 : state.filter === 'pending' ? needsData(row) : false;
  const visible = overview.rows.slice().sort((a, b) => {
    const left = metricValue(a, state.sort), right = metricValue(b, state.sort);
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
    return ((left ?? 0) - (right ?? 0)) * (state.direction === 'asc' ? 1 : -1) || a.name.localeCompare(b.name, 'zh-CN');
  });
  const matchCount = FILTER_TITLES[state.filter] ? visible.filter(matchesFilter).length : 0;
  const persist = () => { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stateRef.current, scrollY: window.scrollY, scrollX: tableRef.current?.scrollLeft || 0 })); } catch { /* A disabled storage policy must not block the dashboard. */ } };
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { persist(); }, [state]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (savedPosition.current.y) window.scrollTo(0, savedPosition.current.y); if (tableRef.current) tableRef.current.scrollLeft = savedPosition.current.x || 0; });
    window.addEventListener('scroll', persist, { passive: true });
    const closeOnEscape = event => { if (event.key === 'Escape' && stateRef.current.expanded) setState(previous => ({ ...previous, expanded: null })); };
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
  const selectFilter = (filter, sort = state.sort) => { update({ filter, sort, direction: 'desc', expanded: null }); };
  const chooseCard = (filter, sort) => { selectFilter(filter, sort); };
  const expand = (row, detail) => update({ expanded: state.expanded === row.employeeId && state.detail === detail ? null : row.employeeId, detail });
  const sortBy = key => update({ sort: key, direction: state.sort === key && state.direction === 'desc' ? 'asc' : 'desc' });
  const reset = () => update({ ...DEFAULT_STATE });
  const filterTitle = FILTER_TITLES[state.filter];
  const estimated = summary.moneyEstimated;
  const cards = [
    { key: 'balance', label: departmentId === 'all' ? '当前可用 · 已同步' : '本部门当前可用', value: summary.availableBalance, icon: Coins, tone: 'blue', filter: 'balance', sort: 'balance', note: joinNote(moneyText(summary.money?.availableBalance, estimated) && `约 ${moneyText(summary.money?.availableBalance, estimated)}`, summary.staleBalance > 0 ? `${format(summary.staleBalance)} 分未计入（读数过旧）` : '个人钱包 + 团队余额') },
    { key: 'owned', label: departmentId === 'all' ? '本期净消耗' : '本部门名下净消耗', value: summary.netConsumption, icon: MoveUpRight, filter: 'all', sort: 'owned', note: joinNote(moneyText(summary.money?.netConsumption, estimated) && `约 ${moneyText(summary.money?.netConsumption, estimated)}`, range.days ? `${range.days} 天 · 日均 ${format(summary.netConsumption / range.days)} 分` : '暂无期间用量') },
    { key: 'borrowed', label: '使用他人额度', value: summary.borrowedConsumption, icon: UsersRound, tone: 'purple', filter: 'borrowed', sort: 'borrowed', note: departmentId === 'all' ? '已确认的跨员工使用' : '按本部门操作员工统计' },
    { key: 'expiry', label: '已到期积分', value: summary.expiry.total, icon: Clock3, filter: 'expiry', sort: 'expiry', note: joinNote(moneyText(summary.money?.expiry, estimated) && `约 ${moneyText(summary.money?.expiry, estimated)}`, summary.expiry.paid + summary.expiry.gift > 0 ? `付费 ${format(summary.expiry.paid)} · 赠送 ${format(summary.expiry.gift)}` : null) },
    { key: 'expiring', label: '7 天内到期', value: summary.expiringAmount, icon: Clock3, tone: 'amber', filter: 'expiring', sort: 'expiring', note: summary.estimatedExpiringAmount > 0 ? `另有 ${format(summary.estimatedExpiringAmount)} 分预计到期` : `截至 ${date(now + 7 * 86400000)}` },
  ];
  return <div className="leader-overview">
    <div className="leader-controls"><div className="leader-period-label">{range.error ? <span role="alert" className="leader-danger">{range.error}</span> : <><strong>{range.label}</strong>{range.days > 0 ? <span>{range.days} 天 · 已采集</span> : null}</>}</div><div className="leader-controls-inputs"><ManagerSelect label="总览时间范围" value={state.period} options={PERIODS} onChange={period => update({ period, expanded: null, ...(period === 'custom' && !state.from ? { from: chinaDay(now).slice(0, 8) + '01', to: chinaDay(now) } : {}) })} />{state.period === 'custom' ? <div className="leader-date-range"><input type="date" aria-label="开始日期" value={state.from} max={state.to || chinaDay(now)} onChange={event => update({ from: event.target.value, expanded: null })} /><span>至</span><input type="date" aria-label="结束日期" value={state.to} min={state.from || undefined} max={chinaDay(now)} onChange={event => update({ to: event.target.value, expanded: null })} /></div> : null}<ManagerSelect label="总览部门" value={departmentId} onChange={departmentId => update({ departmentId, expanded: null })} options={[{ value: 'all', label: '全部部门' }, ...departments.map(item => ({ value: item.id, label: item.name }))]} searchable />{state.period !== 'month' || departmentId !== 'all' || state.filter !== 'all' ? <button type="button" className="leader-link" onClick={reset}>重置</button> : null}</div></div>
    {range.error ? null : <>
      <section className="leader-stats" aria-label="积分摘要">{cards.map(card => { const Icon = card.icon; const selected = state.filter === card.filter && state.sort === card.sort; return <button type="button" key={card.key} className={`leader-stat ${card.tone ? `leader-stat-${card.tone}` : ''} ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={() => chooseCard(card.filter, card.sort)}><span className="leader-stat-label">{card.label}<Icon size={16} aria-hidden="true" /></span><strong>{format(card.value)}<small>积分</small></strong><span className="leader-stat-note">{card.note}</span></button>; })}</section>
      <section className="leader-board">
        <div className="leader-board-heading"><h2>员工用量 <small>{overview.rows.filter(row => !row.unassigned).length} 人{overview.rows.some(row => row.unassigned) ? ' + 未归属' : ''} · 单位：积分</small></h2>{filterTitle ? <div className="leader-board-note"><span>已选：{filterTitle}</span><small>{matchCount} 人符合 · 已排在最前</small><button type="button" className="leader-link" onClick={() => update({ filter: 'all', expanded: null })}>清除<X size={12} aria-hidden="true" /></button></div> : null}</div>
        <div className="leader-table-scroll" ref={tableRef} onScroll={persist}><table className="leader-table"><thead><tr><th scope="col">员工 / 部门</th>{METRICS.map(metric => <th scope="col" key={metric.key} aria-sort={state.sort === metric.key ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortBy(metric.key)}>{metric.label}{state.sort === metric.key ? state.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} /> : <ArrowUpDown size={12} />}</button></th>)}</tr></thead><tbody>{visible.map(row => <Fragment key={row.employeeId}><tr className={`leader-employee-row ${row.unassigned ? 'leader-unassigned-row' : ''} ${state.expanded === row.employeeId ? 'expanded' : ''} ${filterTitle && matchesFilter(row) ? 'leader-row-match' : ''}`}><th scope="row"><button type="button" className="leader-person" aria-expanded={state.expanded === row.employeeId} onClick={() => expand(row, 'owned')}><span className="leader-avatar">{row.unassigned ? '未' : row.name.slice(-2)}</span><span><strong>{row.name}{row.unassigned ? <small className="leader-unassigned-tag">历史账号</small> : row.removed ? <small className="leader-removed">已移除</small> : null}</strong><small>{row.unassigned ? '归属已失效，无法追认' : row.department || '部门未设置'}</small></span>{state.expanded === row.employeeId ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button></th>{METRICS.map(metric => { const value = metricValue(row, metric.key); let note = null;
          if (metric.key === 'balance') note = joinNote(moneyText(row.money?.balance, row.moneyEstimated) && `约 ${moneyText(row.money?.balance, row.moneyEstimated)}`, row.balance === null ? row.staleBalance > 0 ? `上次 ${format(row.staleBalance)} · 待更新` : '待更新' : row.balancePartial ? '部分待补齐' : row.expiringAmount > 0 ? `7 天内到期 ${format(row.expiringAmount)}` : row.estimatedExpiringAmount > 0 ? `预计到期 ${format(row.estimatedExpiringAmount)}` : `个人 ${format(row.personalBalance)} · 团队 ${format(row.teamBalance)}`);
          if (metric.key === 'owned') note = joinNote(row.money?.consumption != null ? `约 ${moneyText(row.money.consumption, row.moneyEstimated)}` : null, value !== null && range.days ? `日均 ${format(value / range.days)}` : null);
          if (metric.key === 'operator') note = value !== null ? `自有 ${format(row.selfConsumption)}` : null;
          if (metric.key === 'borrowed') note = value !== null && row.borrowedFrom.length ? `使用 ${row.borrowedFrom.length} 人额度` : null;
          if (metric.key === 'lent') note = value !== null && row.lentTo.length ? `${row.lentTo.length} 人使用` : null;
          if (metric.key === 'expiry') note = joinNote(row.expiry.total > 0 ? `约 ${moneyText(row.money?.expiry, row.moneyEstimated) ?? '—'}` : null, row.expiry.paid > 0 ? `付费 ${format(row.expiry.paid)}${row.expiry.gift > 0 ? ` · 赠送 ${format(row.expiry.gift)}` : ''}` : row.expiry.gift > 0 ? `赠送 ${format(row.expiry.gift)}` : null);
          return <td key={metric.key}><button type="button" className={`leader-metric-cell ${metric.key === 'balance' ? 'leader-balance' : ['borrowed', 'lent'].includes(metric.key) && value > 0 ? 'leader-purple' : ''} ${value === null ? 'leader-metric-unknown' : ''}`} aria-label={`查看${row.name}${metric.label}${value === null ? '，数据未确认' : ` ${format(value)} 积分`}`} aria-expanded={state.expanded === row.employeeId && state.detail === metric.key} onClick={() => expand(row, metric.key)}><strong>{format(value)}</strong>{note ? <small>{note}</small> : null}</button></td>;
        })}</tr>{state.expanded === row.employeeId ? <tr className="leader-expanded-row" ref={detailRowRef}><td colSpan={7}><EmployeeDetail row={row} detail={state.detail} range={range} transactionMap={transactionMap} openLedger={openLedger} onNavigate={navigate} onClose={() => update({ expanded: null })} /></td></tr> : null}</Fragment>)}</tbody></table>{!visible.length ? <div className="leader-empty"><UsersRound size={26} /><strong>{overview.rows.length ? '没有符合条件的员工' : '暂无员工'}</strong><button type="button" className="leader-link" onClick={() => overview.rows.length ? selectFilter('all', 'owned') : navigate('directory')}>{overview.rows.length ? '查看全部员工' : '维护员工与部门'}<ArrowRight size={13} /></button></div> : null}</div>
        <div className="leader-board-footer"><span>显示 {visible.filter(row => !row.unassigned).length} 人{visible.some(row => row.unassigned) ? ' + 未归属 1 行' : ''}</span>{summary.unallocatedBalance > 0 ? <button type="button" className="leader-link" onClick={() => navigate('teams')}>团队未分配 {format(summary.unallocatedBalance)} 分<ArrowRight size={13} /></button> : null}</div>
      </section>
      <details className="leader-definitions"><summary>统计口径与数据情况</summary><p>名下消耗 = 本人使用自有额度 + 被他人使用 + 操作者未确认。本人操作 = 使用自有额度 + 使用他人额度 + 额度归属未确认。正常使用自己的团队成员额度计入自用。</p><p>消费按所选期间扣费减去明确关联的退回计算。归属按事件时已登记的映射保留；登记前的历史沿用首次登记映射{summary.legacyOwnershipAmount > 0 ? `（当前 ${format(summary.legacyOwnershipAmount)} 分）` : ''}，不作为实际操作者凭证。没有匹配凭证的消费保留未确认，因此历史流水会长期显示较低的“操作者已确认”比例。</p><p>余额与未来 7 天到期按当前时间查看，不随统计期间变化。超过 24 小时的旧余额不计入当前可用；公司余额按个人钱包与团队总钱包去重，员工余额按个人与本人成员额度计算。</p><p>到期未用只计平台已确认清零。付费、赠送或来源未分类分别展示；归属员工不等同于浪费责任人，使用他人额度也不代表自己的额度已用完。使用他人额度与被他人使用不重复相加。</p><p>人民币金额按积分来源分别折算，是估算值不是付款额：订阅会员积分用「该账号套餐月费 ÷ 每月实发订阅积分」，取续费原价；充值购买积分固定 ¥0.10/分（积分商城 500 分 ¥50 起）；每日赠送积分没有花钱，按 0 成本。价目表版本 {PRICE_TABLE.observedAt}（{PRICE_TABLE.source}），平台调价后需要更新。其中「高级团队会员」平台已下架、价格查不到，暂按同级个人会员单价折算，这部分估算最需要你复核{summary.moneyUnpriced > 0 ? `；另有 ${format(summary.moneyUnpriced)} 分没有任何可用单价，未计入金额` : ''}。</p><div className="leader-definitions-status"><span><Check size={13} aria-hidden="true" />操作者已确认 {summary.confirmedOperatorRate == null ? '—' : `${Math.round(summary.confirmedOperatorRate * 100)}%`}</span>{summary.unconfirmedOperatorConsumption > 0 ? <LedgerLink ids={summary.transactionIds.unconfirmed} title="操作者未确认" openLedger={openLedger}>{format(summary.unconfirmedOperatorConsumption)} 分未确认</LedgerLink> : null}{summary.linkedRefunds > 0 || summary.unmatchedRefunds > 0 ? <LedgerLink ids={summary.transactionIds.refund} title="本期积分退回" openLedger={openLedger}>已扣除关联退回 {format(summary.linkedRefunds)}{summary.unmatchedRefunds > 0 ? ` · ${format(summary.unmatchedRefunds)} 未关联` : ''}</LedgerLink> : null}{summary.pendingEmployees > 0 ? <button type="button" className="leader-link" onClick={() => chooseCard('pending', 'balance')}>{summary.pendingEmployees} 人数据待补齐</button> : null}{summary.unknownBalanceCount > 0 ? <button type="button" className="leader-link" onClick={() => navigate('accounts')}>{summary.unknownBalanceCount} 项余额未完整获取</button> : null}{summary.unknownExpiryCount > 0 ? <span>{summary.unknownExpiryCount} 项到期时间未获取</span> : null}</div></details>
    </>}
  </div>;
}
