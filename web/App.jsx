import { DiagnosticsPanel } from './DiagnosticsPanel.jsx';
import { collectorMessage } from './diagnostics.js';
import { ThemeToggle } from './ThemeToggle.jsx';
import { CollectorReleasePanel } from './CollectorReleasePanel.jsx';
import { EnrollmentRequestsPanel } from './EnrollmentRequestsPanel.jsx';
import { AccessSettingsTabs } from './AccessSettingsTabs.jsx';
import { CollectorActionsMenu } from './CollectorActionsMenu.jsx';
import { ManagementLoginPanel } from './ManagementLoginPanel.jsx';
import { DirectoryPanel } from './DirectoryPanel.jsx';
import { EmployeeSelect, DepartmentSelect } from './DirectoryFields.jsx';
import { ManagerSelect } from './ManagerSelect.jsx';
import { matchesActualOperator, actualOperatorOptions, matchesIdentityAssignment } from './manager-filters.js';
import './directory.css';
import './ledger-focus.css';
import './accounts-focus.css';
import { captureExtensionLogin, extensionLoginAttempt } from './extension-login.js';
import { withRequestTimeout } from './request-timeout.js';
import { fetchDashboard, DASHBOARD_POLL_MS } from './dashboard-client.js';
import { LedgerPagination, useLedgerPagination } from './LedgerPagination.jsx';
import { SyncStatus, useSyncRequest } from './SyncStatus.jsx';
import { IdentityProvider, IdentityOwner, IdentitiesPanel, IdentityForm, useIdentities } from './IdentityContext.jsx';
import { matchesAccountOwner } from './identities.js';
import { identityPresentation, transactionPresentation, accountPresentation, accountOptionLabel } from './identity-presentation.js';
import { creditExpiryRows,creditExpiryDueSoon,teamCreditExpiryEstimate,estimatedExpiryLabel,estimatedExpiryTitle } from './credit-expiry.js';
import { ExpiryBadge } from './ExpiryBadge.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import Input from '@douyinfe/semi-ui/lib/es/input';
import Modal from '@douyinfe/semi-ui/lib/es/modal';
import SideSheet from '@douyinfe/semi-ui/lib/es/sideSheet';
import Toast from '@douyinfe/semi-ui/lib/es/toast';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, ChevronRight, Coins, Database, Download, FileClock, Fingerprint, LayoutGrid, LogOut, MoreHorizontal, Plus, Plug, RefreshCw, Search, ShieldCheck, UsersRound, Wallet, X } from 'lucide-react';
import { balanceSummary, loginIdentitySummary } from './accounting.js';
import { billingLabel } from './WalletContext.jsx';
import { linkedTeamsForLogin, teamRelationship, teamViewModels } from './teams.js';
import { ACCOUNT_ORDERS, orderAccountGroups, orderPools, orderTeamLinks } from './list-order.js';
import { CreatorName, TeamsPanel, TeamDetail } from './TeamsView.jsx';
import { transactionActor } from './transaction-actor.js';
import { walletOwnershipOverrides, walletOwnerDefaultLabel } from './wallet-ownership.js';
import LeaderOverview from './LeaderOverview.jsx';
import ReferenceRates from './ReferenceRates.jsx';
import { DataManagementPanel } from './DataManagementPanel.jsx';
import PlatformPrices from './PlatformPrices.jsx';
import AccountPool from './AccountPool.jsx';
import { overviewRange, inOverviewRange } from './leader-overview.js';

const extensionEntry = typeof window === 'undefined' ? null : captureExtensionLogin(window.location, window.history);
const completeExtensionLogin = extensionEntry ? extensionLoginAttempt(extensionEntry, api, window.history) : null;

const EMPTY = { accounts: [], transactions: [], installations: [], teams: [], teamManagement: [], identities: [], departments: [], employees: [], pendingEnrollmentCount: 0, asOf: null };
const NAV = [
  { id: 'overview', label: '积分总览', icon: LayoutGrid },
  { id: 'platform-prices', label: '平台标价', icon: Coins },
  { id: 'accounts', label: '账号池', icon: Wallet },
  { id: 'teams', label: '团队', icon: UsersRound },
  { id: 'ledger', label: '积分流水', icon: FileClock },
  { id: 'directory', label: '员工与部门', icon: UsersRound },
  { id: 'installations', label: '接入设置', icon: Plug },
];
const KINDS = { consume: '生成消耗', refund: '退回积分', grant: '获得积分', expire: '到期失效', adjustment: '积分调整' };
const SCOPE_NAMES = { personal: '个人钱包', team_total: '团队共享钱包', team_member: '团队成员额度' };
const STATUS_NAMES = { ok: '已同步', stale: '数据较旧', unknown: '状态未获取', waiting: '尚未连接', login_required: '需登录即梦', error: '采集异常', offline: '暂未连接' };
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const fmt = (value) => typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : '—';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const stamp = (value, full = false) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { year: 'numeric' } : {}) }).format(new Date(value));
};
const dateOnly = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '未获取';
const dueSoon = (a) => creditExpiryDueSoon(a);

async function api(path, options = {}) {
  return withRequestTimeout(async (signal) => {
    const response = await fetch(path, { credentials: 'same-origin', ...options, signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.error || (response.status === 401 ? '登录已过期，请重新进入管理台。' : '请求未完成，请稍后重试。'));
      error.status = response.status;
      throw error;
    }
    return body;
  }, { signal: options.signal });
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><img className="brand-mark" src="/branding/yiqian-gradient-logo.png" alt="益谦教育" width="35" height="35" /><div><strong>即梦积分管家</strong></div></div>;
}

function Status({ status = 'unknown', disabled = false }) {
  return <span className={`status status-${disabled ? 'disabled' : status}`}><i />{disabled ? '已停用' : STATUS_NAMES[status] || '状态未获取'}</span>;
}

function EmptyState({ icon: Icon = Database, title, description, action, compact = false }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><span className="empty-icon"><Icon size={27} strokeWidth={1.5} /></span><h3>{title}</h3>{description ? <p>{description}</p> : null}{action}</div>;
}

function Login({ onSuccess }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (!secret.trim() || busy) return;
    setBusy(true); setError('');
    try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: secret }) }); setSecret(''); onSuccess(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div className="login-screen"><div className="login-top"><Brand /></div><div className="login-theme"><ThemeToggle /></div><main className="login-card"><div className="login-symbol"><ShieldCheck size={27} /></div><h1>管理员登录</h1><form onSubmit={submit}><label htmlFor="admin-secret">登录密码</label><Input id="admin-secret" type="password" value={secret} onChange={setSecret} placeholder="输入登录密码" autoComplete="current-password" size="large" />{error ? <p className="form-error" role="alert">{error}</p> : null}<Button htmlType="submit" theme="solid" type="primary" size="large" block loading={busy} disabled={!secret.trim()}>进入管理台 <ArrowRight size={16} /></Button></form></main></div>;
}

function LoadingScreen() { return <div className="boot"><Brand /><div className="boot-line" /><p>正在连接管理台…</p></div>; }

export default function App() {
  const [authenticated, setAuthenticated] = useState(null);
  const [bootError, setBootError] = useState('');
  const checkSession = useCallback(async () => {
    setBootError('');
    try {
      const session = completeExtensionLogin ? await completeExtensionLogin() : await api('/api/session');
      setAuthenticated(session.authenticated === true && session.role === 'admin');
    } catch (error) { setBootError(error.message); }
  }, []);
  useEffect(() => { checkSession(); }, [checkSession]);
  const logout = useCallback(() => setAuthenticated(false), []);
  if (bootError) return <div className="boot"><Brand /><EmptyState title={completeExtensionLogin ? '管理员快捷登录未完成' : '暂时无法连接管理台'} description={completeExtensionLogin ? bootError : '请检查网络连接后重试。'} action={completeExtensionLogin ? <Button theme="solid" onClick={() => window.location.replace('/')}>返回管理员登录</Button> : <Button theme="solid" onClick={checkSession}>重新连接</Button>} /></div>;
  if (authenticated === null) return <LoadingScreen />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;
  return <Workspace onLogout={logout} />;
}

function pageFromLocation() {
  const id = window.location.hash.slice(1);
  if(id === 'identities') return 'accounts';
  return NAV.some(item => item.id === id) ? id : 'overview';
}

function focusFromLocation(target) {
  const saved=window.history.state?.jimeng;
  return saved?.page===target && saved.focus && typeof saved.focus==='object' ? saved.focus : null;
}

function Workspace({ onLogout }) {
  const [page, setCurrentPage] = useState(pageFromLocation);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [accountFocus, setAccountFocus] = useState(() => focusFromLocation('accounts') || 'all');
  const [ledgerFocus, setLedgerFocus] = useState(() => focusFromLocation('ledger'));
  function setPage(nextPage, focus = 'all') {
    if(nextPage === 'identities') nextPage = 'accounts';
    if (!NAV.some(item => item.id === nextPage)) return;
    setMobileMoreOpen(false);
    setDetailOpen(false); setDiagnosticDevice(null);
    setAccountFocus(nextPage === 'accounts' ? focus : 'all'); setCurrentPage(nextPage);
    setLedgerFocus(nextPage === 'ledger' && typeof focus === 'object' ? focus : null);
    const state={jimeng:{page:nextPage,focus:typeof focus==='object'?focus:null}};
    if (window.location.hash !== `#${nextPage}`) window.history.pushState(state, '', `${window.location.pathname}${window.location.search}#${nextPage}`);
    else window.history.replaceState(state,'');
  }
  useEffect(() => {
    const restorePage = () => { setCurrentPage(pageFromLocation()); setAccountFocus(focusFromLocation('accounts') || 'all'); setLedgerFocus(focusFromLocation('ledger')); setDetailOpen(false); setDiagnosticDevice(null); setMobileMoreOpen(false); };
    window.addEventListener('popstate', restorePage); window.addEventListener('hashchange', restorePage);
    return () => { window.removeEventListener('popstate', restorePage); window.removeEventListener('hashchange', restorePage); };
  }, []);
  const [data, setData] = useState(EMPTY);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [ownerEditOnOpen, setOwnerEditOnOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [archivingTeam, setArchivingTeam] = useState(null);
  const [teamTab, setTeamTab] = useState('members');
  const [installationModal, setInstallationModal] = useState(null);
  const [deletingInstallation, setDeletingInstallation] = useState(null);
  const [skippingInstallation, setSkippingInstallation] = useState(null);
  const [diagnosticDevice, setDiagnosticDevice] = useState(null);
  const [identityModal, setIdentityModal] = useState(null);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [accessTab, setAccessTab] = useState(() => {
    try { const saved = window.sessionStorage.getItem('jimeng-access-tab'); return ['employees', 'data', 'admin'].includes(saved) ? saved : 'employees'; }
    catch { return 'employees'; }
  });
  function changeAccessTab(next) {
    setAccessTab(next);
    try { window.sessionStorage.setItem('jimeng-access-tab', next); } catch { /* Storage can be disabled. */ }
  }
  const [mutation, setMutation] = useState(false);
  const requestId = useRef(0);
  const controller = useRef(null);
  const dashboardEtag = useRef(null);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const id = ++requestId.current;
    controller.current?.abort();
    controller.current = new AbortController();
    if (!quiet) setBusy(true);
    try {
      const result = await fetchDashboard({ etag:dashboardEtag.current,signal:controller.current.signal });
      if (id !== requestId.current) return;
      if (!result.unchanged) { dashboardEtag.current=result.etag;setData({ ...EMPTY,...result.data }); }
      setError('');
    } catch (e) {
      if (e.name === 'AbortError' || id !== requestId.current) return;
      if (e.status === 401) onLogout(); else setError(e.message);
    } finally { if (id === requestId.current) setBusy(false); }
  }, [onLogout]);

  const sync = useSyncRequest({ api, onRefresh: refresh, enabled: true });

  useEffect(() => {
    dashboardEtag.current=null;setData(EMPTY); setSelected(null); setDetailOpen(false); setSelectedTeam(null); refresh();
    const refreshVisible = () => { if (document.visibilityState === 'visible') refresh({ quiet:true }); };
    const timer = setInterval(refreshVisible,DASHBOARD_POLL_MS);
    document.addEventListener('visibilitychange',refreshVisible);
    return () => { controller.current?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refreshVisible); };
  }, []);

  async function logout() { try { await api('/api/admin/logout', { method: 'POST' }); onLogout(); } catch (e) { Toast.error(e.message); } }
  function openAccount(account, { editOwner = false } = {}) {
    const team = !editOwner && account.scope === 'team_total' ? teamDirectory.find(item => item.spaceId === account.spaceId) : null;
    if (team) { openTeam(team); return; }
    setDiagnosticDevice(null); setSelectedTeam(null); setSelected(account); setOwnerEditOnOpen(editOwner); setDetailOpen(true);
  }
  function openTeam(team, tab = 'members') { setDiagnosticDevice(null); setSelected(null); setSelectedTeam(team); setTeamTab(tab); setDetailOpen(true); }
  function manageDirectory() { setIdentityModal(null); setInstallationModal(null); setDetailOpen(false); setPage('directory'); }
  async function changeDirectory(kind, id, values, remove = false) {
    setMutation(true);
    try {
      const result = await api(`/api/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: remove ? 'DELETE' : id ? 'PATCH' : 'POST', ...(remove ? {} : { body: JSON.stringify(values) }) });
      await refresh({ quiet: true }); Toast.success(remove ? '已删除' : '已保存'); return result;
    } catch (error) { Toast.error(error.message); throw error; }
    finally { setMutation(false); }
  }
  async function publishCollectorUpdate() {
    setMutation(true);
    try { await api('/api/collector-release/publish', { method: 'POST', body: '{}' }); await refresh({ quiet: true }); Toast.success('更新提醒已发布'); }
    catch (error) { Toast.error(error.message); }
    finally { setMutation(false); }
  }
  async function saveAdminPassword(password) {
    setMutation(true);
    try { await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password }) }); await refresh({ quiet: true }); Toast.success('登录密码已设置'); }
    catch (error) { Toast.error(error.message); throw error; }
    finally { setMutation(false); }
  }
  async function saveOwner(targetId, values) {
    setMutation(true);
    try {
      const account = await api(`/api/accounts/${encodeURIComponent(targetId)}`, { method: 'PATCH', body: JSON.stringify(values) });
      setSelected((previous) => previous?.id === targetId ? { ...previous, ...values, ...account } : previous); await refresh({ quiet: true }); Toast.success('钱包成本归属已保存');
    } catch (e) { Toast.error(e.message); throw e; }
    finally { setMutation(false); }
  }
  async function saveReferenceRate(values) {
    setMutation(true);
    try {
      await api('/api/reference-rates', { method: 'POST', body: JSON.stringify(values) });
      await refresh({ quiet: true }); Toast.success('折算单价已保存');
    } finally { setMutation(false); }
  }
  async function saveIdentity(values) {
    if (!identityModal) return;
    setMutation(true);
    try {
      await api(`/api/identities/${encodeURIComponent(identityModal.platformUserId)}`, { method: 'PATCH', body: JSON.stringify(values) });
      setIdentityModal(null); await refresh({ quiet: true }); Toast.success('绑定已保存，历史数据已同步');
    } catch (e) { Toast.error(e.message); }
    finally { setMutation(false); }
  }
  async function saveInstallation(values) {
    setMutation(true);
    try {
      const editing = installationModal?.id;
      await api(editing ? `/api/installations/${encodeURIComponent(editing)}` : '/api/installations', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) });
      setInstallationModal(null); await refresh({ quiet: true }); Toast.success(editing ? '采集端配置已保存' : '采集端已创建');
    } catch (e) { Toast.error(e.message); }
    finally { setMutation(false); }
  }
  async function toggleInstallation(installation) {
    setMutation(true);
    try { await api(`/api/installations/${encodeURIComponent(installation.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !installation.enabled }) }); await refresh({ quiet: true }); Toast.success(installation.enabled ? '采集端已停用' : '采集端已启用'); }
    catch (e) { Toast.error(e.message); }
    finally { setMutation(false); }
  }
  async function deleteInstallation() {
    if (!deletingInstallation || mutation) return;
    const id = deletingInstallation.id;
    setMutation(true);
    try {
      await api(`/api/installations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setDeletingInstallation(null);
      setDiagnosticDevice(current => current?.id === id ? null : current);
      await refresh({ quiet: true }); Toast.success('采集端已删除');
    } catch (error) { Toast.error(error.message); }
    finally { setMutation(false); }
  }
  async function skipInitialBinding() {
    if (!skippingInstallation || mutation) return;
    setMutation(true);
    try {
      await api(`/api/installations/${encodeURIComponent(skippingInstallation.id)}/skip-initial-binding`, { method: 'POST', body: '{}' });
      setSkippingInstallation(null); await refresh({ quiet: true }); Toast.success('已跳过首次自动绑定');
    } catch (error) { Toast.error(error.message); }
    finally { setMutation(false); }
  }
  async function download(installation) {
    setMutation(true);
    try {
      const response = await fetch(`/api/installations/${encodeURIComponent(installation.id)}/extension.zip`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('插件下载失败，请刷新后重试。');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a'); a.href = url; a.download = `即梦采集端-${installation.employeeName || '员工'}-${installation.id.slice(0, 8)}.zip`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      Toast.success('插件已下载');
    } catch (e) { Toast.error(e.message); }
    finally { setMutation(false); }
  }
  async function downloadObserver() {
    setMutation(true);
    try {
      const response = await fetch('/api/admin/observer-extension.zip', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('观察版下载失败，请刷新后重试。');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a'); a.href = url; a.download = '即梦管理员观察版.zip'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Toast.success('观察版已下载');
    } catch (e) { Toast.error(e.message); }
    finally { setMutation(false); }
  }
  async function setTeamArchived(team, archived) {
    setMutation(true);
    try {
      await api(`/api/teams/${encodeURIComponent(team.spaceId)}/management`, { method: 'PATCH', body: JSON.stringify({ archived }) });
      await refresh({ quiet: true });
      Toast.success(archived ? '团队已归档，历史记录仍可查看' : '团队已恢复纳管');
      return true;
    } catch (error) { Toast.error(error.message); return false; }
    finally { setMutation(false); }
  }
  const selectedAccount = data.accounts.find((a) => a.id === selected?.id) || selected;
  const teamDirectory = useMemo(() => teamViewModels(data.teams, data.accounts, data.teamManagement), [data.teams, data.accounts, data.teamManagement]);
  const archivedTeamSpaces = useMemo(() => new Set(teamDirectory.filter(team => team.archived).map(team => String(team.spaceId))), [teamDirectory]);
  const currentTeamDirectory = useMemo(() => teamDirectory.filter(team => !team.archived), [teamDirectory]);
  const currentAccounts = useMemo(() => data.accounts.filter(account => account.scope === 'personal' || !archivedTeamSpaces.has(String(account.spaceId))), [data.accounts, archivedTeamSpaces]);
  const selectedTeamRecord = teamDirectory.find((team) => team.spaceId === selectedTeam?.spaceId) || selectedTeam;
  const pageInfo = NAV.find((n) => n.id === page);

  return <IdentityProvider identities={data.identities} employees={data.employees} departments={data.departments} onEdit={setIdentityModal} onManage={manageDirectory}><div className="app-shell">
    <aside className="sidebar"><Brand /><nav aria-label="主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon size={18} /><span>{label}</span>{id === 'installations' && data.pendingEnrollmentCount > 0 ? <small title="待审核领取申请">{data.pendingEnrollmentCount}</small> : null}</button>)}<button type="button" className={`nav-item mobile-more-trigger ${NAV.slice(5).some(item => item.id === page) ? 'active' : ''}`} aria-expanded={mobileMoreOpen} aria-controls="mobile-more-panel" onClick={() => setMobileMoreOpen(open => !open)}><MoreHorizontal size={18} /><span>更多</span></button><div id="mobile-more-panel" className="mobile-more-panel" hidden={!mobileMoreOpen}>{NAV.slice(5).map(({ id, label, icon: Icon }) => <button key={id} type="button" className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon size={17} /><span>{label}</span>{id === 'installations' && data.pendingEnrollmentCount > 0 ? <small>{data.pendingEnrollmentCount}</small> : null}</button>)}</div></nav></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={13} /><strong>{pageInfo.label}</strong></div><div className="topbar-actions"><ThemeToggle /><span className="admin-avatar" title="管理员">管</span><button className="icon-button logout" aria-label="退出管理台" title="退出管理台" onClick={logout}><LogOut size={16} /></button></div></header>
      <main className="main-content"><div className="page-heading"><div><h1>{pageInfo.label}</h1></div><div className="page-heading-actions">{['overview', 'directory', 'platform-prices', 'installations'].includes(page) ? null : <Button theme="borderless" aria-label="立即同步" icon={<RefreshCw size={15} className={sync.active ? 'spin' : ''} />} onClick={sync.paused ? sync.retryRead : sync.start} disabled={busy || sync.active}>{sync.active ? '同步中' : sync.paused ? '重试读取进度' : '立即同步'}</Button>}</div></div>
      {!['overview', 'platform-prices'].includes(page) ? <SyncStatus job={sync.job} starting={sync.starting} error={sync.error} paused={sync.paused} onRetry={sync.retryRead} /> : null}
      {error && page !== 'platform-prices' ? <div className="notice error-notice" role="alert"><Activity size={17} /><span>{page === 'overview' ? '数据更新失败，当前为上次读取结果。' : `${error} 已保留上次成功读取的数据。`}</span><button onClick={() => refresh()}>重试</button></div> : null}
      {page === 'platform-prices' ? <PlatformPrices request={api} /> : busy && !data.asOf ? <DashboardSkeleton /> : <>
        {page === 'overview' ? <LeaderOverview data={data} onNavigate={setPage} onAccount={openAccount} /> : null}
        {page === 'accounts' ? <AccountPool key={JSON.stringify(accountFocus)} initialFocus={accountFocus} accounts={currentAccounts} teams={currentTeamDirectory} usage={data.accountUsage} onTeam={openTeam} onAccount={openAccount} onLedger={platformUserId=>setPage('ledger',{platformUserId})} onSetup={() => setPage('installations')} now={Date.parse(data.asOf)||Date.now()} /> : null}
        {page === 'teams' ? <TeamsPanel teams={teamDirectory} onTeam={openTeam} /> : null}
        {page === 'ledger' ? <LedgerPanel key={JSON.stringify(ledgerFocus)} initialFocus={ledgerFocus} accounts={data.accounts} transactions={data.transactions} teamDirectory={teamDirectory} onAccount={openAccount} onOverview={() => setPage('overview')} /> : null}
        {page === 'identities' ? <IdentitiesPanel /> : null}
        {page === 'directory' ? <DirectoryPanel departments={data.departments} employees={data.employees} busy={mutation} onSaveDepartment={(id, values) => changeDirectory('departments', id, values)} onDeleteDepartment={id => changeDirectory('departments', id, null, true)} onSaveEmployee={(id, values) => changeDirectory('employees', id, values)} onDeleteEmployee={id => changeDirectory('employees', id, null, true)} /> : null}
        {page === 'installations' ? <>
          <AccessSettingsTabs value={accessTab} onChange={changeAccessTab} pendingCount={data.pendingEnrollmentCount} />
          <div id={`access-panel-${accessTab}`} role="tabpanel" aria-labelledby={`access-tab-${accessTab}`}>
            {accessTab === 'employees' ? <>
              <EnrollmentRequestsPanel employees={data.employees} request={api} enrollmentUrls={data.enrollmentUrls} onEmployees={() => setPage('directory')} onApproved={() => refresh({ quiet: true })} />
              <InstallationsPanel release={data.collectorRelease} installations={data.installations} usage={data.accountUsage} onAccount={platformUserId=>setPage('accounts',{platformUserId})} busy={mutation} onAdd={() => setInstallationModal({})} onEdit={setInstallationModal} onToggle={toggleInstallation} onDelete={setDeletingInstallation} onDownload={download} onDiagnostics={setDiagnosticDevice} />
            </> : null}
            {accessTab === 'data' ? <>
              <DataManagementPanel data={data} onPricing={() => setRatesOpen(true)} onNavigate={setPage} onSync={sync.paused ? sync.retryRead : sync.start} syncing={sync.active} disabled={busy} />
              <CollectorReleasePanel release={data.collectorRelease} installations={data.installations} busy={mutation} onPublish={publishCollectorUpdate} />
            </> : null}
            {accessTab === 'admin' ? <>
              <ManagementLoginPanel configured={data.adminPasswordConfigured} busy={mutation} onSave={saveAdminPassword} />
              <section className="panel access-settings-admin-panel"><div className="panel-title"><div><h2>管理员观察版</h2><p>只读查看采集情况，不上报员工数据。</p></div><Button disabled={mutation} icon={<Download size={16} />} onClick={downloadObserver}>下载观察版</Button></div></section>
            </> : null}
          </div>
        </> : null}
      </>}
      </main>
    </div>
    <SideSheet visible={detailOpen} onCancel={() => setDetailOpen(false)} title={selectedTeamRecord ? '团队详情' : ownerEditOnOpen ? '编辑成本归属' : '积分分批'} width={selectedTeamRecord ? 690 : 500} className="account-sheet unified-detail-sheet" maskClosable closeOnEsc motion={true}>
      {detailOpen && selectedTeamRecord ? <TeamDetail key={selectedTeamRecord.spaceId} team={selectedTeamRecord} tab={teamTab} onTabChange={setTeamTab} onSetArchived={(team, archived) => archived ? setArchivingTeam(team) : setTeamArchived(team, false)} onEditOwnership={(team) => { if (team.pool) openAccount(team.pool, { editOwner: true }); }} archiveBusy={mutation} transactionCount={data.transactions.filter(t => t.accountId === selectedTeamRecord.pool?.id).length}>
        {selectedTeamRecord.pool ? <AccountDetail key={selectedTeamRecord.pool.id} account={selectedTeamRecord.pool} accounts={data.accounts} teamDirectory={teamDirectory} transactions={data.transactions.filter(t => t.accountId === selectedTeamRecord.pool.id)} busy={mutation} onSave={values => saveOwner(selectedTeamRecord.pool.id, values)} embedded activeTab={teamTab === 'history' ? 'history' : 'details'} /> : <EmptyState compact icon={Wallet} title="团队钱包尚未同步" />}
      </TeamDetail> : detailOpen && selectedAccount ? <AccountDetail key={`${selectedAccount.id}-${ownerEditOnOpen ? 'edit' : 'view'}`} account={selectedAccount} teamDirectory={teamDirectory} transactions={data.transactions.filter((t) => t.accountId === selectedAccount.id)} busy={mutation} onSave={values => saveOwner(selectedAccount.id, values)} onLedger={() => setPage('ledger', { accountId: selectedAccount.id })} initialEditing={ownerEditOnOpen} onEditingComplete={() => setDetailOpen(false)} /> : null}
    </SideSheet>
    <SideSheet visible={diagnosticDevice !== null} onCancel={() => setDiagnosticDevice(null)} title="采集端排障日志" width={560} className="account-sheet diagnostics-sheet" maskClosable motion={true}>
      {diagnosticDevice ? <DiagnosticsPanel key={diagnosticDevice.id} installation={diagnosticDevice} request={api} /> : null}
    </SideSheet>
    <Modal visible={ratesOpen} onCancel={() => !mutation && setRatesOpen(false)} title="人民币折算" footer={null} width={720} closeOnEsc={!mutation} maskClosable={!mutation}>
      {ratesOpen ? <ReferenceRates data={data} onSave={saveReferenceRate} onClose={() => setRatesOpen(false)} /> : null}
    </Modal>
    <Modal visible={installationModal !== null} onCancel={() => !mutation && setInstallationModal(null)} title={installationModal?.id ? '采集端信息' : '添加采集端'} footer={null} width={480} closeOnEsc={!mutation} maskClosable={!mutation}>
      {installationModal !== null ? <InstallationForm key={installationModal.id || 'new'} initial={installationModal} busy={mutation} onSave={saveInstallation} onCancel={() => setInstallationModal(null)} /> : null}
    </Modal>
    <Modal visible={deletingInstallation !== null} onCancel={() => !mutation && setDeletingInstallation(null)} title="删除采集端" width={440} closeOnEsc={!mutation} maskClosable={!mutation} footer={<><Button disabled={mutation} onClick={() => setDeletingInstallation(null)}>取消</Button><Button theme="solid" type="danger" loading={mutation} onClick={deleteInstallation}>确认删除</Button></>}>
      {deletingInstallation ? <p>删除 {deletingInstallation.employeeName} 的采集端（{deletingInstallation.id.slice(0, 8)}）？旧插件将停止上报，已采集数据保留。</p> : null}
    </Modal>
    <Modal visible={identityModal !== null} onCancel={() => !mutation && setIdentityModal(null)} title="账号绑定" footer={null} width={480} closeOnEsc={!mutation} maskClosable={!mutation}>
      {identityModal ? <IdentityForm key={identityModal.platformUserId} identity={identityModal} busy={mutation} onSave={saveIdentity} onCancel={() => setIdentityModal(null)} /> : null}
    </Modal>
    <Modal visible={skippingInstallation !== null} onCancel={() => !mutation && setSkippingInstallation(null)} title="跳过首次自动绑定" width={440} closeOnEsc={!mutation} maskClosable={!mutation} footer={<><Button disabled={mutation} onClick={() => setSkippingInstallation(null)}>取消</Button><Button theme="solid" loading={mutation} onClick={skipInitialBinding}>确认跳过</Button></>}>
      {skippingInstallation ? <p>{skippingInstallation.employeeName} 的插件继续采集，保留现有账号归属，今后登录其他账号也不会自动认领。</p> : null}
    </Modal>
    <Modal visible={archivingTeam !== null} onCancel={() => !mutation && setArchivingTeam(null)} title="归档团队" width={440} closeOnEsc={!mutation} maskClosable={!mutation} footer={<><Button disabled={mutation} onClick={() => setArchivingTeam(null)}>取消</Button><Button theme="solid" loading={mutation} onClick={async () => { if (archivingTeam && await setTeamArchived(archivingTeam, true)) setArchivingTeam(null); }}>确认归档</Button></>}>
      {archivingTeam ? <p>归档「{archivingTeam.name}」后，当前余额和临期统计不再计入该团队；历史流水仍可查看，也可以随时恢复纳管。</p> : null}
    </Modal>
  </div></IdentityProvider>;
}

function DashboardSkeleton() { return <div aria-label="正在读取数据" className="dashboard-skeleton"><div className="summary-grid">{[1, 2, 3, 4].map((n) => <div className="skeleton-card" key={n}><i /><b /><i /></div>)}</div><div className="skeleton-table">{[1, 2, 3, 4, 5].map((n) => <i key={n} />)}</div></div>; }


function FilterSelect(props) { return <ManagerSelect {...props} />; }


function LoginAccountCard({ group, match, matchTeam, onAccount, onTeam }) {
  const { directory } = useIdentities();
  const person = identityPresentation(group.platformUserId, directory, group.displayName);
  const boundPhone = directory.get(String(group.platformUserId))?.boundPhone;
  const [expanded, setExpanded] = useState(true);
  const personal = group.personal;
  const teams = orderTeamLinks(group.teamLinks.filter(matchTeam));
  return <article className="login-account-card">
    <button className="login-account-heading" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} title={`即梦 ID ${group.platformUserId}${boundPhone ? ` · 手机号 ${boundPhone}` : ''}`}>
      <span className="account-avatar"><Fingerprint size={21} /></span>
      <span className="login-account-title"><strong>{person.primary}</strong><small>{person.secondary}</small></span>
      <ChevronRight size={18} className={expanded ? 'expanded-chevron' : ''} />
    </button>
    <div className="login-owner-line"><IdentityOwner platformUserId={group.platformUserId} showName={false} editable /></div>
    {expanded ? <div className="member-plan-grid">
      {personal && match(personal) ? <div className="member-plan-card personal-plan"><div className="member-plan-heading"><span className="plan-label"><Fingerprint size={15} />个人会员</span><Status status={personal.status} /></div><strong className="plan-title">{personal.membershipPlan || '会员套餐未获取'}</strong>{personal.billingCycle ? <span className="plan-cycle">{billingLabel(personal.billingCycle)}</span> : null}<div className="plan-amount"><span>个人钱包余额</span><strong className="amount-with-expiry"><span className="amount-value">{fmt(personal.balance)}<small>积分</small></span><ExpiryBadge account={personal} compact /></strong></div><PlanMeta account={personal} /><div className="plan-foot"><span>{personal.ownerDepartment ? `成本部门 · ${personal.ownerDepartment}` : '未设置成本部门'}</span><button className="text-button" onClick={() => onAccount(personal)}>查看积分分批 <ArrowRight size={13} /></button></div></div> : null}
      {teams.map((link) => <TeamPlanCard key={link.spaceId} {...link} onAccount={onAccount} onTeam={onTeam} />)}
    </div> : null}
  </article>;
}

function PlanMeta({ account }) {
  const dates = [
    ['下次续费', account.nextRenewalAt],
    ['会员有效期', account.membershipExpiresAt],
  ].filter(([, value]) => value);
  return <div className="plan-meta">{dates.map(([label, value]) => <div key={label}><span>{label}</span><strong>{dateOnly(value)}</strong></div>)}{!dates.length ? <p>有效期未获取</p> : null}<div><span>数据更新</span><strong>{stamp(account.lastSyncedAt)}</strong></div></div>;
}

function TeamPlanCard({ member, pool, onAccount, team, onTeam, rosterMember, loginPlatformUserId }) {
  const primary = member || pool;
  const identityId = loginPlatformUserId || member?.platformUserId;
  const isLinkedLogin = Boolean(identityId);
  const relationship = teamRelationship(team, identityId);
  const memberBalance = member ? member.balance : rosterMember?.balance;
  const totalBalance = team ? team.totalBalance : pool?.balance;
  const membership = { ...primary, membershipExpiresAt: member?.membershipExpiresAt || team?.membershipExpiresAt || pool?.membershipExpiresAt, billingCycle: member?.billingCycle || pool?.billingCycle, nextRenewalAt: member?.nextRenewalAt || pool?.nextRenewalAt, lastSyncedAt: primary?.lastSyncedAt || team?.observedAt };
  return <div className="member-plan-card team-plan"><div className="member-plan-heading"><span className="plan-label"><UsersRound size={15} />团队套餐 {isLinkedLogin ? <span className={`team-relationship-label ${relationship.role}`}>{relationship.label}</span> : null}<small>{team?.name || primary?.spaceName || '团队空间'}</small></span>{primary?.status ? <Status status={primary.status} /> : null}</div><strong className="plan-title">{team?.membershipPlan || member?.membershipPlan || pool?.membershipPlan || '团队套餐未获取'}</strong>{membership.billingCycle ? <span className="plan-cycle">{billingLabel(membership.billingCycle)}</span> : null}{team ? <div className="plan-team-owner"><span>平台归属 · 创建者</span><strong><CreatorName team={team} /></strong></div> : null}<div className="team-plan-amounts"><div className="plan-amount"><span>{isLinkedLogin ? '该登录账号的成员额度' : '团队共享钱包总额'}</span><strong className="amount-with-expiry"><span className="amount-value">{fmt(isLinkedLogin ? memberBalance : totalBalance)}<small>积分</small></span><ExpiryBadge account={(isLinkedLogin ? member : pool) || {}} compact /></strong></div>{isLinkedLogin ? <div className="team-pool-amount"><span>团队共享钱包总额</span><strong className="amount-with-expiry"><span className="amount-value">{fmt(totalBalance)}<small>积分</small></span><ExpiryBadge account={pool || {}} compact /></strong></div> : null}</div><PlanMeta account={membership} /><div className="plan-foot"><span>{pool?.ownerDepartment || member?.ownerDepartment ? `成本部门 · ${pool?.ownerDepartment || member?.ownerDepartment}` : '未设置成本部门'}</span><div>{member ? <button className="text-button" onClick={() => onAccount(member)}>查看成员额度分批</button> : null}{team && onTeam ? <button className="text-button" onClick={() => onTeam(team)}>团队与成员 <ArrowRight size={13} /></button> : pool ? <button className="text-button" onClick={() => onAccount(pool)}>查看积分分批 <ArrowRight size={13} /></button> : null}</div></div></div>;
}

function LedgerPanel({ accounts, transactions, teamDirectory = [], initialFocus, onAccount, onOverview }) {
  const { employees, directory, departments } = useIdentities();
  const ownerGroups = useMemo(() => {
    const known=new Map(employees.map(employee => [employee.id,{key:`employee:${employee.id}`,realName:employee.name,department:employee.department}]));
    for(const transaction of transactions){const owner=transaction.ownershipSnapshot;if(owner?.employeeId&&!known.has(owner.employeeId))known.set(owner.employeeId,{key:`employee:${owner.employeeId}`,realName:owner.name||'已移除员工',department:owner.department});}
    return [...known.values()];
  }, [employees,transactions]);
  const operatorOptions = useMemo(() => actualOperatorOptions(employees, transactions), [employees, transactions]);
  const [person, setPerson] = useState(initialFocus?.employeeId ? `employee:${initialFocus.employeeId}` : initialFocus?.ownerStatus === 'unassigned' ? '__unassigned' : 'all');
  const [operator, setOperator] = useState(initialFocus?.operatorEmployeeId ? `employee:${initialFocus.operatorEmployeeId}` : initialFocus?.operatorStatus === 'unconfirmed' ? '__unconfirmed' : 'all');
  const [period, setPeriod] = useState(initialFocus?.period || initialFocus?.usagePeriod || 'all');
  const [from, setFrom] = useState(initialFocus?.from || '');
  const [to, setTo] = useState(initialFocus?.to || '');
  const [selection, setSelection] = useState(() => Array.isArray(initialFocus?.transactionIds) ? new Set(initialFocus.transactionIds) : null);
  const [department, setDepartment] = useState('all');
  const [kind, setKind] = useState(initialFocus?.kind || (initialFocus?.employeeId || initialFocus?.operatorEmployeeId || initialFocus?.operatorStatus || initialFocus?.ownerStatus ? 'consume' : 'all'));
  const [account, setAccount] = useState(initialFocus?.accountId || 'all');
  const [platformUserId, setPlatformUserId] = useState(initialFocus?.platformUserId || null);
  const [search, setSearch] = useState('');
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const accountOptions = useMemo(() => {
    const options = accounts.map(item => ({id:item.id,platformId:item.platformUserId,label:accountOptionLabel(item,directory,teamDirectory)}));
    const counts = new Map(); for (const item of options) counts.set(item.label,(counts.get(item.label)||0)+1);
    return options.map(item => ({...item,label:counts.get(item.label)>1?`${item.label} · ID ${item.platformId?.slice(-6) || item.id.slice(-6)}`:item.label}));
  },[accounts,directory,teamDirectory]);
  const filtered = useMemo(() => {
    const accountMap=new Map(accounts.map(item=>[item.id,item])),term=search.trim().toLowerCase();
    const range=overviewRange({period,from,to});
    return transactions.filter((t) => (!selection || selection.has(t.id)) && (!platformUserId || t.chargedPlatformUserId === platformUserId || (!t.chargedPlatformUserId && accountMap.get(t.accountId)?.scope === 'personal' && accountMap.get(t.accountId)?.platformUserId === platformUserId)) && inOverviewRange(t.occurredAt,range) && (kind === 'all' || t.kind === kind) && (account === 'all' || t.accountId === account) && matchesAccountOwner(t, directory, person, department) && matchesActualOperator(t, operator) && [t.description, t.eventId, t.operatorName, t.ownershipSnapshot?.name, t.ownershipSnapshot?.department, t.chargedPlatformUserId, directory.get(String(t.chargedPlatformUserId))?.realName, directory.get(String(t.chargedPlatformUserId))?.nickname, directory.get(String(t.chargedPlatformUserId))?.department, directory.get(String(t.chargedPlatformUserId))?.boundPhone, accountMap.get(t.accountId)?.displayName].filter(Boolean).join(' ').toLowerCase().includes(term)).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  },[transactions,accounts,directory,kind,account,person,operator,department,search,period,from,to,selection,platformUserId]);
  const pagination=useLedgerPagination(filtered,JSON.stringify([kind,account,person,operator,department,search,period,from,to,selection?.size]));
  const rangeError = overviewRange({period,from,to}).error;
  const ledgerTotals=useMemo(() => filtered.reduce((sum,t)=>{ if(t.kind==='consume')sum.debits-=t.amount;else if(t.kind==='refund')sum.refunds+=t.amount;else if(t.kind==='expire')sum.expired-=t.amount;return sum; },{debits:0,refunds:0,expired:0}),[filtered]);
  function reset() { setKind('all'); setAccount('all'); setSearch(''); setPerson('all'); setOperator('all'); setDepartment('all'); setPeriod('all');setFrom('');setTo('');setSelection(null);setPlatformUserId(null);setMoreFiltersOpen(false); }
  const activeExtraFilters = [
    platformUserId && { key: 'platform', label: `账号：${directory.get(platformUserId)?.realName || directory.get(platformUserId)?.nickname || platformUserId}`, clear: () => setPlatformUserId(null) },
    person !== 'all' && { key: 'person', label: `归属：${person === '__unassigned' ? '未关联员工' : ownerGroups.find(item => item.key === person)?.realName || '已选员工'}`, clear: () => setPerson('all') },
    operator !== 'all' && { key: 'operator', label: `操作：${operator === '__unconfirmed' ? '无操作凭证' : operator === '__matched' ? '已确认' : operator === '__platform' ? '平台自动' : operatorOptions.find(item => `employee:${item.id}` === operator)?.name || '已选员工'}`, clear: () => setOperator('all') },
    account !== 'all' && { key: 'account', label: `账号：${accountOptions.find(item => item.id === account)?.label || '已选账号'}`, clear: () => setAccount('all') },
    department !== 'all' && { key: 'department', label: `部门：${department === '__unassigned' ? '未设置' : departments.find(item => item.id === department)?.name || '已选部门'}`, clear: () => setDepartment('all') },
    period === 'custom' && { key: 'dates', label: `${from || '开始日期'} — ${to || '结束日期'}`, clear: () => { setPeriod('all'); setFrom(''); setTo(''); } },
  ].filter(Boolean);
  const anyFilter = Boolean(search || kind !== 'all' || period !== 'all' || activeExtraFilters.length);
  function changePeriod(next) { setPeriod(next); if (next === 'custom') setMoreFiltersOpen(true); }
  return <section className="panel ledger-panel">
    <div className="panel-title"><div className="inline-title"><h2>{selection ? initialFocus?.title || '总览选中流水' : '积分变动明细'}</h2><span className="count-chip">{filtered.length}</span></div>{selection ? <button className="text-button" onClick={onOverview}>返回总览</button> : null}</div>
    {selection ? <div className="ledger-selection-summary"><span>{ledgerTotals.debits || ledgerTotals.refunds ? `扣费 ${fmt(ledgerTotals.debits)} · 退回 ${fmt(ledgerTotals.refunds)} · 净额 ${fmt(ledgerTotals.debits-ledgerTotals.refunds)} 积分` : ledgerTotals.expired ? `到期失效 ${fmt(ledgerTotals.expired)} 积分` : '当前选中记录'}</span><button className="text-button" onClick={reset}>查看全部流水</button></div> : null}
    <div className="filter-bar ledger-primary-filters">
      <div className="search-input"><Search size={16} /><input aria-label="搜索流水" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索员工、昵称、手机号或流水" /></div>
      <FilterSelect label="流水时间" value={period} onChange={changePeriod}><option value="all">全部时间</option><option value="today">今日</option><option value="week">近 7 天</option><option value="month">本月</option><option value="custom">自定义日期</option></FilterSelect>
      <FilterSelect label="流水类型" value={kind} onChange={setKind}><option value="all">全部变动</option>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</FilterSelect>
      <button type="button" className={`ledger-more-toggle${moreFiltersOpen ? ' active' : ''}`} aria-expanded={moreFiltersOpen} aria-controls="ledger-more-filters" onClick={() => setMoreFiltersOpen(open => !open)}>筛选{activeExtraFilters.length ? <span className="ledger-more-count">{activeExtraFilters.length}</span> : null}<ChevronRight size={14} aria-hidden="true" /></button>
      {anyFilter ? <button type="button" className="text-button ledger-reset" onClick={reset}>重置</button> : null}
    </div>
    <div id="ledger-more-filters" className="ledger-more-filters" hidden={!moreFiltersOpen}>
      <FilterSelect label="账号归属员工" prefix="归属" value={person} onChange={setPerson} searchable><option value="all">全部员工</option>{ownerGroups.map((group) => <option key={group.key} value={group.key}>{group.realName} · {group.department || '未设置部门'}</option>)}<option value="__unassigned">未关联员工</option></FilterSelect>
      <FilterSelect label="实际操作者" prefix="操作者" value={operator} onChange={setOperator} searchable><option value="all">全部</option>{operatorOptions.map(item => <option key={item.id} value={`employee:${item.id}`}>{item.name} · {item.department || '部门未记录'}{item.removed ? '（已移除）' : ''}</option>)}<option value="__unconfirmed">无操作凭证</option><option value="__matched">全部已确认</option><option value="__platform">平台自动变动</option></FilterSelect>
      <FilterSelect label="流水账号" value={account} onChange={setAccount} searchable><option value="all">全部账号 / 钱包</option>{accountOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</FilterSelect>
      <FilterSelect label="账号所属部门" value={department} onChange={setDepartment} searchable><option value="all">全部账号归属部门</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__unassigned">未设置部门</option></FilterSelect>
      {period === 'custom' ? <div className="ledger-date-range"><input type="date" aria-label="流水开始日期" value={from} onChange={e=>setFrom(e.target.value)} /><span>—</span><input type="date" aria-label="流水结束日期" value={to} onChange={e=>setTo(e.target.value)} /></div> : null}
    </div>
    {activeExtraFilters.length ? <div className="ledger-active-filters" aria-label="已选筛选条件">{activeExtraFilters.map(item => <button key={item.key} type="button" onClick={item.clear} title={`清除${item.label}`}><span>{item.label}</span><X size={12} aria-hidden="true" /></button>)}</div> : null}
    {rangeError ? <p className="form-error" role="alert">{rangeError}</p> : null}
    {transactions.length > 0 && filtered.length === 0 ? <EmptyState icon={Search} title="没有符合条件的流水" action={<Button onClick={reset}>重置筛选</Button>} /> : <LedgerTable transactions={pagination.items} accounts={accounts} onAccount={onAccount} />}
    <LedgerPagination pagination={pagination} />
  </section>;
}

function LedgerTable({ transactions, accounts, onAccount, compact = false }) {
  const { directory } = useIdentities();
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  if (!transactions.length) return <EmptyState compact={compact} icon={FileClock} title="暂无积分流水" />;
  return <div className="table-scroll"><table className="data-table ledger-table owner-first-ledger"><thead><tr><th>归属人 / 账号</th><th>变动内容</th><th className="align-right">积分变化</th><th>实际操作者</th><th>发生时间</th></tr></thead><tbody>{transactions.map((t) => {
    const a = accountMap.get(t.accountId), positive = t.amount > 0, actor = transactionActor(t);
    const sameLogin = a?.scope !== 'team_total' && a?.platformUserId === t.chargedPlatformUserId;
    const person = transactionPresentation(t,directory,sameLogin ? a.displayName : null);
    return <tr key={t.id}>
      <td><div className="ledger-account-identity" title={`即梦 ID：${t.chargedPlatformUserId || '未获取'}`}>
        {a ? <button className="table-link employee-primary" onClick={() => onAccount(a)}>{person.primary}</button> : <strong className="employee-primary">{person.primary}</strong>}
        <small className="cell-sub">{person.ownerName ? person.nickname : t.chargedPlatformUserId ? `ID ${t.chargedPlatformUserId}` : ''}</small>
        <small className="cell-sub">{[person.department,a?.scope === 'personal' ? '个人钱包' : a?.spaceName, a?.scope === 'team_member' ? '成员额度' : null].filter(Boolean).join(' · ')}</small>
      </div></td>
      <td><div className="transaction-kind"><span className={`transaction-icon ${positive ? 'positive' : t.kind === 'expire' ? 'expired' : ''}`}>{positive ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><span><strong>{KINDS[t.kind] || '积分变化'}</strong><small title={t.description}>{t.description || '平台积分记录'}</small></span></div></td>
      <td className="align-right"><strong className={`transaction-amount ${positive ? 'positive-text' : ''}`}>{positive ? '+' : ''}{fmt(t.amount)}</strong></td>
      <td>{actor.status === 'matched' ? <><strong>{t.operatorName}</strong><small className="cell-sub">{actor.department}</small></> : actor.status === 'platform' ? <span>{actor.label}</span> : <span className="subtle">—</span>}</td>
      <td className="time-cell">{stamp(t.occurredAt)}</td>
    </tr>;
  })}</tbody></table></div>;
}

function CollectorAccounts({ installation, usage, onAccount }) {
  const { directory } = useIdentities();
  const logins = usage.filter(item => item.installationId === installation.id);
  return <div className="collector-owned-accounts">{logins.length ? logins.map(item => {
    const person = identityPresentation(item.platformUserId, directory, item.nickname);
    return <button key={item.platformUserId} className="table-link" title={`即梦 ID：${item.platformUserId}`} onClick={() => onAccount(item.platformUserId)}>{person.ownerName ? `${person.ownerName} · ${person.nickname || item.platformUserId}` : person.nickname || `ID ${item.platformUserId}`}</button>;
  }) : <span className="subtle">—</span>}</div>;
}

function InstallationsPanel({ release, installations, usage = [], onAccount, busy, onAdd, onEdit, onToggle, onDelete, onDownload, onDiagnostics, onSkipBinding }) {
  const [search, setSearch] = useState('');
  const visible = installations.filter((i) => `${i.employeeName} ${i.department}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <section className="panel"><div className="panel-title"><div className="inline-title"><h2>员工采集端</h2><span className="count-chip">{installations.length}</span></div><div className="installation-heading-actions"><div className="search-input"><Search size={15} /><input aria-label="搜索采集端" placeholder="搜索员工或部门" value={search} onChange={(e) => setSearch(e.target.value)} /></div><Button icon={<Plus size={14} />} onClick={onAdd}>手动添加</Button></div></div>
    {!installations.length ? <EmptyState icon={Plug} title="尚无员工采集端" /> : !visible.length ? <EmptyState title="没有找到采集端" action={<Button onClick={() => setSearch('')}>清空搜索</Button>} /> : <div className="table-scroll"><table className="data-table installation-table"><thead><tr><th>员工</th><th>使用过的账号</th><th>采集状态</th><th>插件版本</th><th>账号数</th><th>最近采集</th><th className="align-right">操作</th></tr></thead><tbody>{visible.map((i) => <tr key={i.id}><td><div className="employee-cell"><span className="employee-avatar">{i.employeeName?.slice(-2) || '员'}</span><span><strong title={`采集端 ID：${i.id}`}>{i.employeeName}</strong><small className="cell-sub">{i.department || '未填写部门'}</small></span></div></td><td><CollectorAccounts installation={i} usage={usage} onAccount={onAccount} /></td><td><Status status={i.status} disabled={!i.enabled} />{i.message && ['error', 'login_required'].includes(i.status) ? <small className="cell-sub collector-message" title={collectorMessage(i.message)}>{collectorMessage(i.message)}</small> : null}</td><td><strong>{i.extensionVersion ? `v${i.extensionVersion}` : '未上报版本'}</strong>{i.updateAvailable ? <small className="cell-sub caution">可更新至 v{release.version}</small> : null}</td><td className="tabular">{usage.filter(item => item.installationId === i.id).length}</td><td className="time-cell">{stamp(i.lastSeenAt)}</td><td><div className="row-actions"><button disabled={busy || !i.enabled} title={!i.enabled ? '启用后可下载安装包' : '下载该员工采集端'} onClick={() => onDownload(i)}><Download size={14} />下载</button><CollectorActionsMenu busy={busy} enabled={i.enabled} onView={() => onEdit(i)} onDiagnostics={() => onDiagnostics(i)} onToggle={() => onToggle(i)} onDelete={() => onDelete(i)} /></div></td></tr>)}</tbody></table></div>}
  </section>;
}

function InstallationForm({ initial, busy, onSave, onCancel }) {
  const { employees, onManage } = useIdentities();
  const [employeeId, setEmployeeId] = useState(initial.employeeId || '');
  const existing = Boolean(initial.id);
  const employee = employees.find(item => item.id === employeeId);
  const valid = Boolean(employee);
  return <form className="configuration-form" onSubmit={(event) => { event.preventDefault(); if (!existing && valid && !busy) onSave({ employeeId }); }}>
    <label htmlFor="collector-employee">员工 <span>*</span></label>
    {existing ? <output id="collector-employee" className="directory-readonly">{employee?.name || initial.employeeName || '员工未关联'}</output> : <EmployeeSelect id="collector-employee" label="采集端员工" value={employeeId} onChange={setEmployeeId} employees={employees} disabled={busy} required emptyLabel="请选择员工" />}
    <label>归属部门</label><output className="directory-readonly">{employee?.department || '未设置'}</output>
    {existing ? <><label>采集端编号</label><output className="directory-readonly">{initial.id}</output></> : null}
    <button type="button" className="text-button" disabled={busy} onClick={onManage}>维护员工与部门</button>

    <div className="form-actions">{existing ? <Button theme="solid" onClick={onCancel}>完成</Button> : <><Button onClick={onCancel} disabled={busy}>取消</Button><Button theme="solid" htmlType="submit" loading={busy} disabled={!valid}>创建采集端</Button></>}</div>
  </form>;
}

function AccountDetail({ account, teamDirectory, transactions, busy, onSave, onLedger, onEditingComplete, embedded = false, activeTab, initialEditing = false }) {
  const [editing, setEditing] = useState(initialEditing);
  const { employees, departments, directory, onManage } = useIdentities();
  const person = accountPresentation(account,directory,teamDirectory);
  const [ownerEmployeeId, setOwnerEmployeeId] = useState(() => walletOwnershipOverrides(account).ownerEmployeeId);
  const [ownerDepartmentId, setOwnerDepartmentId] = useState(() => walletOwnershipOverrides(account).ownerDepartmentId);
  const history=useMemo(()=>transactions.slice().sort((a,b)=>new Date(b.occurredAt)-new Date(a.occurredAt)),[transactions]);
  const pagination=useLedgerPagination(history,account.id);
  const expiryEstimate=teamCreditExpiryEstimate(account);
  const batches = creditExpiryRows(account);
  const fallbackBatches = [
    { key: 'subscription', kind: 'subscription', label: '会员', amount: account.subscriptionBalance },
    { key: 'purchase', kind: 'purchase', label: '充值', amount: account.purchaseBalance },
    { key: 'gift', kind: 'gift', label: '赠送', amount: account.giftBalance },
  ].filter(batch => finite(batch.amount) && batch.amount > 0);
  const expiryRows = batches.length ? batches : fallbackBatches;
  async function save(e) { e.preventDefault(); try { await onSave({ ownerEmployeeId: ownerEmployeeId || null, ownerDepartmentId: ownerDepartmentId || null }); if (initialEditing) onEditingComplete?.(); else setEditing(false); } catch {} }
  if (embedded) return activeTab === 'history' ? <div className="detail-transactions">{transactions.length ? <>{pagination.items.map((t) => {
    const actor = transactionActor(t);
    const kind = KINDS[t.kind] || '积分变化';
    const chargedAccount = account.scope === 'team_total' && t.chargedPlatformUserId ? identityPresentation(t.chargedPlatformUserId, directory).primary : null;
    return <div className="detail-transaction account-transaction" key={t.id}><span className={`transaction-icon ${t.amount > 0 ? 'positive' : ''}`}>{t.amount > 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><div><strong>{kind}</strong>{chargedAccount ? <small className="cell-sub">账号：{chargedAccount}</small> : null}{t.description && t.description !== kind ? <p>{t.description}</p> : null}<small>{stamp(t.occurredAt)}{actor.status === 'matched' && t.operatorName ? ` · ${t.operatorName} 操作` : actor.status === 'platform' ? ` · ${actor.label}` : ''}</small></div><strong className={`transaction-amount ${t.amount > 0 ? 'positive-text' : ''}`}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}</strong></div>;
  })}<LedgerPagination pagination={pagination} label="团队流水分页" /></> : <EmptyState compact icon={FileClock} title="暂无积分流水" />}</div> : null;
  return <div className={`account-detail account-detail-focus${initialEditing ? ' direct-edit' : ''}`}>
    <div className="account-detail-context"><strong>{person.primary}</strong><span>{[person.secondary, person.scopeLabel].filter(Boolean).join(' · ')}</span></div>
    {!initialEditing ? <section className="detail-section account-expiry-section">{expiryRows.length ? <dl>{expiryRows.map(batch => {
        const expiry = batch.expiresAt ? `${dateOnly(batch.expiresAt)} ${Date.parse(batch.expiresAt) <= Date.now() ? '已到期' : '到期'}` : batch.kind === 'subscription' && expiryEstimate ? estimatedExpiryLabel(expiryEstimate, Date.now(), true) : '到期日未获取';
        return <div key={batch.key}><dt>{batch.label}积分</dt><dd><strong>{fmt(batch.amount)} 分</strong><span title={batch.kind === 'subscription' && expiryEstimate && !batch.expiresAt ? estimatedExpiryTitle(expiryEstimate) : undefined}>{expiry}</span></dd></div>;
      })}{expiryEstimate && !expiryRows.some(batch => batch.kind === 'subscription') ? <div><dt>会员积分</dt><dd><span title={estimatedExpiryTitle(expiryEstimate)}>{estimatedExpiryLabel(expiryEstimate, Date.now(), true)}</span></dd></div> : null}</dl> : <p className="account-detail-empty">{expiryEstimate ? estimatedExpiryLabel(expiryEstimate, Date.now(), true) : finite(account.balance) && account.balance > 0 ? '到期信息未获取' : '暂无积分'}</p>}</section> : null}
    {onLedger && !initialEditing ? <button type="button" className="account-ledger-link" onClick={onLedger}>查看该钱包流水 <ArrowRight size={15} /></button> : null}
    <section className="account-detail-management">{!initialEditing ? <button type="button" className="account-manage-toggle" aria-expanded={editing} onClick={() => { if (!editing) { const overrides = walletOwnershipOverrides(account); setOwnerEmployeeId(overrides.ownerEmployeeId); setOwnerDepartmentId(overrides.ownerDepartmentId); } setEditing(!editing); }}>调整成本归属 <ChevronRight size={15} aria-hidden="true" /></button> : null}
      {editing ? <form id="account-owner-form" className="owner-form" onSubmit={save}><label htmlFor="owner-name">钱包负责人</label><EmployeeSelect id="owner-name" label="钱包负责人" value={ownerEmployeeId} onChange={setOwnerEmployeeId} employees={employees} disabled={busy} emptyLabel={walletOwnerDefaultLabel(account.scope)} /><label htmlFor="owner-department">成本归属部门</label><DepartmentSelect id="owner-department" label="成本归属部门" value={ownerDepartmentId} onChange={setOwnerDepartmentId} departments={departments} disabled={busy} emptyLabel="跟随钱包负责人部门" /><button type="button" className="text-button" disabled={busy} onClick={onManage}>维护员工与部门</button><div className="form-actions"><Button disabled={busy} onClick={() => initialEditing ? onEditingComplete?.() : setEditing(false)}>取消</Button><Button theme="solid" htmlType="submit" loading={busy}>保存归属</Button></div></form> : null}
    </section>
  </div>;
}
