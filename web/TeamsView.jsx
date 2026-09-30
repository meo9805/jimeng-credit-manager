import { useIdentities } from './IdentityContext.jsx';
import { creditExpiryDates, creditExpiryRows } from './credit-expiry.js';
import { useMemo, useState } from 'react';
import { Archive, ArrowRight, RotateCcw, Search, UsersRound } from 'lucide-react';
import { teamCreator, teamRelationship } from './teams.js';
import { identityPresentation } from './identity-presentation.js';
import { orderTeamMembers, orderTeams } from './list-order.js';
import './teams-focus.css';

const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? formatter.format(value) : '—';
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '未获取';
const roleNames = { creator: '创建者', admin: '管理员', member: '协作者' };

function TeamNextExpiry({ pool }) {
  if (!pool) return null;
  const next = creditExpiryDates(pool).filter(item => Date.parse(item.expiresAt) > Date.now()).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
  if (!next) return null;
  const batch = creditExpiryRows(pool).find(item => item.expiresAt === next.expiresAt);
  return <span className="team-focus-expiry">{batch ? `${batch.label} ${number(batch.amount)} 分` : next.estimated ? '会员积分（预计）' : '部分积分'} · {date(next.expiresAt)} 到期</span>;
}

export function CreatorName({ team, compact = false }) {
  const { directory } = useIdentities();
  const creator = teamCreator(team);
  const presentation = identityPresentation(creator.platformUserId, directory, creator.displayName);
  return creator.platformUserId ? <>{presentation.primary}{!compact && presentation.ownerName && presentation.nickname ? <small className="creator-platform-name">即梦昵称 · {presentation.nickname}</small> : null}</> : <>创建者未获取</>;
}

export function TeamsPanel({ teams, onTeam }) {
  const { directory } = useIdentities();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = teams.filter(team => team.archived).length;
  const current = useMemo(() => teams.filter(team => Boolean(team.archived) === showArchived), [teams, showArchived]);
  const filtered = useMemo(() => orderTeams(current.filter((team) => { const creator = teamCreator(team); const owner = identityPresentation(creator.platformUserId, directory, creator.displayName); return [team.name, team.membershipPlan, owner.ownerName, owner.nickname, owner.platformUserId, owner.department, team.costDepartment, ...(team.members || []).flatMap((member) => { const identity = identityPresentation(member.platformUserId, directory, member.displayName); return [identity.ownerName, identity.nickname, identity.platformUserId, identity.department]; })].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase()); })), [search, current, directory]);
  return <div className="teams-view">
    <section className="panel team-directory"><div className="panel-title"><div className="inline-title"><h2>{showArchived ? '已归档团队' : '已纳管团队'}</h2><span className="count-chip">{current.length} 个</span>{archivedCount ? <button type="button" className="text-button" onClick={() => { setShowArchived(!showArchived); setSearch(''); }}>{showArchived ? '返回纳管团队' : `查看已归档 ${archivedCount}`}</button> : null}</div><div className="search-input"><Search size={16} /><input aria-label="搜索团队" placeholder="搜索团队、创建者或部门" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      {!filtered.length ? <div className="empty-state"><span className="empty-icon"><UsersRound size={27} /></span><h3>{current.length ? '没有符合条件的团队' : showArchived ? '暂无已归档团队' : '暂无团队资料'}</h3>{search ? <button className="text-button" onClick={() => setSearch('')}>清空搜索</button> : null}</div> : <div className="team-directory-grid">{filtered.map((team) => <article className="team-overview-card team-focus-card" key={team.spaceId}>
        <div className="team-overview-title"><span className="account-avatar team"><UsersRound size={21} /></span><div><h3>{team.name}</h3>{team.membershipPlan || team.membershipExpiresAt ? <p>{[team.membershipPlan, team.membershipExpiresAt ? `会员至 ${date(team.membershipExpiresAt)}` : null].filter(Boolean).join(' · ')}</p> : null}</div><ArrowRight className="team-focus-arrow" size={17} aria-hidden="true" /></div>
        <div className="team-focus-card-balance"><span>{team.archived ? '归档时余额' : '团队余额'}</span><strong>{number(team.totalBalance)}<small>积分</small></strong>{!team.archived ? <TeamNextExpiry pool={team.pool} /> : null}</div>
        <div className="team-focus-card-meta"><span>创建者 <strong><CreatorName team={team} compact /></strong></span><span>成本归属 <strong>{[team.costOwnerName, team.costDepartment].filter(Boolean).join(' · ') || '未设置'}</strong></span>{team.members.length || team.membersComplete ? <span>{team.membersComplete ? `${team.members.length} 位成员` : `已知 ${team.members.length} 位成员`}</span> : null}{Number.isFinite(team.totalSeats) && Number.isFinite(team.availableSeats) ? <span>可用席位 {number(team.availableSeats)} / {number(team.totalSeats)}</span> : null}{Number.isFinite(team.allocatableBalance) && team.allocatableBalance > 0 ? <span>未分配 {number(team.allocatableBalance)} 分</span> : null}</div>
        <button type="button" className="team-focus-card-open" aria-label={`查看${team.name}团队详情`} onClick={() => onTeam(team)} />
      </article>)}</div>}
    </section>
  </div>;
}

export function TeamDetail({ team, tab = 'members', onTabChange, transactionCount = 0, onSetArchived, onEditOwnership, archiveBusy = false, children }) {
  const { directory } = useIdentities();
  const members = orderTeamMembers(team.members, member => teamRelationship(team, member.platformUserId).role, member => identityPresentation(member.platformUserId, directory, member.displayName).ownerName || member.displayName);
  const activeTab = tab === 'history' ? 'history' : 'members';
  const canEditOwnership = Boolean(onEditOwnership && team.pool);
  const memberCount = team.membersComplete ? members.length : members.length ? `${members.length}+` : '—';
  return <div className="team-detail team-focus-detail">
    <div className="detail-identity"><span className="account-avatar large team"><UsersRound size={27} /></span><div><h2>{team.name}</h2>{team.membershipPlan || team.membershipExpiresAt || team.archived ? <p>{[team.membershipPlan, team.membershipExpiresAt ? `会员至 ${date(team.membershipExpiresAt)}` : null, team.archived ? '已归档' : null].filter(Boolean).join(' · ')}</p> : null}</div>{canEditOwnership ? <details className="team-manage-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}><summary>管理</summary><div className="team-manage-options"><button type="button" onClick={(event) => { event.currentTarget.closest('details').open = false; onEditOwnership(team); }}>修改成本归属</button>{onSetArchived ? <button type="button" disabled={archiveBusy} onClick={(event) => { event.currentTarget.closest('details').open = false; onSetArchived(team, !team.archived); }}>{team.archived ? '恢复纳管' : '归档团队'}</button> : null}</div></details> : onSetArchived ? <button type="button" className="text-button team-archive-action" disabled={archiveBusy} onClick={() => onSetArchived(team, !team.archived)}>{team.archived ? <RotateCcw size={14} /> : <Archive size={14} />}{team.archived ? '恢复纳管' : '归档团队'}</button> : null}</div>
    <div className="team-focus-context"><span>{team.archived ? '归档余额' : '团队余额'} <strong>{number(team.totalBalance)} 分</strong></span>{!team.archived ? <TeamNextExpiry pool={team.pool} /> : null}{Number.isFinite(team.allocatableBalance) && team.allocatableBalance > 0 ? <span>未分配 {number(team.allocatableBalance)} 分</span> : null}</div>
    <div className="detail-tabs team-detail-tabs" aria-label="团队详情内容"><span style={{ transform: `translateX(${activeTab === 'history' ? 100 : 0}%)` }} />{[{id:'members',label:'团队成员'},{id:'history',label:'积分流水'}].map(item => <button key={item.id} type="button" className={activeTab === item.id ? 'active' : ''} aria-pressed={activeTab === item.id} onClick={() => onTabChange(item.id)}>{item.label}<small>{item.id === 'members' ? memberCount : transactionCount}</small></button>)}</div>
    <div hidden={activeTab !== 'members'}>
      <section className="team-members-section">
        {members.length ? <div className="table-scroll"><table className="data-table team-members-table"><thead><tr><th>成员</th><th className="align-right">已用积分</th><th className="align-right">剩余积分</th></tr></thead><tbody>{members.map((member) => { const role = teamRelationship(team, member.platformUserId).role; const presentation = identityPresentation(member.platformUserId, directory, member.displayName); return <tr key={member.platformUserId}><td><strong title={presentation.nickname && presentation.nickname !== presentation.primary ? `即梦昵称：${presentation.nickname}` : undefined}>{presentation.primary}</strong>{roleNames[role] ? <span className={`team-member-role ${role}`}>{roleNames[role]}</span> : null}</td><td className="align-right tabular">{number(member.usedCredits)}</td><td className="align-right tabular">{number(member.balance)}</td></tr>; })}</tbody></table></div> : <div className="empty-state compact"><UsersRound size={24} /><h3>暂无成员资料</h3></div>}
      </section>
    </div>
    <div hidden={activeTab !== 'history'} className="team-wallet-panel">{children}</div>
  </div>;
}
