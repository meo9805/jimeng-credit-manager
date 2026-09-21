import { IdentityOwner, useIdentities } from './IdentityContext.jsx';
import { ExpiryBadge } from './ExpiryBadge.jsx';
import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ChevronRight, Crown, Search, UsersRound } from 'lucide-react';
import { teamCreator, teamRelationship } from './teams.js';
import { identityPresentation } from './identity-presentation.js';
import { orderTeamMembers, orderTeams } from './list-order.js';

const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? formatter.format(value) : '—';
const date = (value, withTime = false) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value)) : '未获取';
const roleNames = { creator: '创建者', admin: '管理员', member: '协作者', unknown: '角色待确认' };

export function CreatorName({ team }) {
  const { directory } = useIdentities();
  const creator = teamCreator(team);
  const presentation = identityPresentation(creator.platformUserId, directory, creator.displayName);
  return creator.platformUserId ? <>{presentation.primary}<small className="creator-platform-name">{presentation.ownerName ? `即梦昵称 · ${presentation.secondary}` : presentation.secondary}</small></> : <>创建者待确认</>;
}

export function TeamsPanel({ teams, onTeam }) {
  const { directory } = useIdentities();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => orderTeams(teams.filter((team) => { const creator = teamCreator(team); const owner = identityPresentation(creator.platformUserId, directory, creator.displayName); return [team.name, team.membershipPlan, owner.ownerName, owner.nickname, owner.platformUserId, owner.department, team.costDepartment, ...(team.members || []).flatMap((member) => { const identity = identityPresentation(member.platformUserId, directory, member.displayName); return [identity.ownerName, identity.nickname, identity.platformUserId, identity.department]; })].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase()); })), [search, teams, directory]);
  return <div className="teams-view">
    <section className="panel team-directory"><div className="panel-title"><div className="inline-title"><h2>已纳管团队</h2><span className="count-chip">{teams.length} 个</span></div><div className="search-input"><Search size={16} /><input aria-label="搜索团队" placeholder="搜索团队、创建者或部门" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      {!filtered.length ? <div className="empty-state"><span className="empty-icon"><UsersRound size={27} /></span><h3>{teams.length ? '没有符合条件的团队' : '暂无团队资料'}</h3>{search ? <button className="text-button" onClick={() => setSearch('')}>清空搜索</button> : null}</div> : <div className="team-directory-grid">{filtered.map((team) => <article className="team-overview-card" key={team.spaceId}>
        <div className="team-overview-title"><span className="account-avatar team"><UsersRound size={21} /></span><div><h3>{team.name}</h3><p>{team.membershipPlan || '套餐资料待获取'}</p></div><button className="row-arrow" aria-label={`查看${team.name}团队详情`} onClick={() => onTeam(team)}><ChevronRight size={18} /></button></div>
        <div className="team-owner-summary"><span><Crown size={14} />创建者</span><strong><CreatorName team={team} /></strong></div>
        <div className="team-inventory"><div><span>团队积分总额</span><strong className="amount-with-expiry"><span className="amount-value">{number(team.totalBalance)}<small>积分</small></span><ExpiryBadge account={team.pool || {}} /></strong></div><div><span>待分配积分</span><strong>{number(team.allocatableBalance)}<small>积分</small></strong></div></div>
        <div className="team-card-facts"><div><span>成员</span><strong>{team.membersComplete ? `${team.members.length} 人` : `已同步 ${team.members.length} 人`}</strong></div><div><span>总席位 / 可用席位</span><strong>{number(team.totalSeats)} / {number(team.availableSeats)}</strong></div><div><span>会员有效期</span><strong>{date(team.membershipExpiresAt)}</strong></div><div><span>公司成本部门</span><strong>{team.costDepartment || '待归属'}</strong></div></div>
        <div className="team-card-foot"><span>余额更新 {date(team.totalBalanceObservedAt, true)}</span><button className="text-button" onClick={() => onTeam(team)}>查看成员与额度 <ArrowRight size={14} /></button></div>
      </article>)}</div>}
    </section>
  </div>;
}

export function TeamDetail({ team, tab = 'members', onTabChange, transactionCount = 0, children }) {
  const { directory } = useIdentities();
  const creator = teamCreator(team);
  const members = orderTeamMembers(team.members, member => teamRelationship(team, member.platformUserId).role, member => identityPresentation(member.platformUserId, directory, member.displayName).ownerName || member.displayName);
  return <div className="team-detail">
    <div className="detail-identity"><span className="account-avatar large team"><UsersRound size={27} /></span><div><h2>{team.name}</h2><p>{team.membershipPlan || '团队套餐待获取'}</p></div></div>
    <div className="detail-tabs team-detail-tabs" aria-label="团队详情内容"><span style={{ transform: `translateX(${['members','wallet','history'].indexOf(tab) * 100}%)` }} />{[{id:'members',label:'团队成员'},{id:'wallet',label:'积分钱包'},{id:'history',label:'积分流水'}].map(item => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} aria-pressed={tab === item.id} onClick={() => onTabChange(item.id)}>{item.label}{item.id === 'history' ? <small>{transactionCount}</small> : null}</button>)}</div>
    <div hidden={tab !== 'members'}>
    <div className="team-ownership-box"><Crown size={20} /><div><span>团队创建者</span><strong><CreatorName team={team} /></strong>{creator.platformUserId ? <><small>平台账号 ID {creator.platformUserId}</small><IdentityOwner platformUserId={creator.platformUserId} editable showName={false} /></> : null}</div></div>
    <div className="team-detail-totals"><div><span>团队积分总额</span><strong className="amount-with-expiry"><span className="amount-value">{number(team.totalBalance)}<small>积分</small></span><ExpiryBadge account={team.pool || {}} /></strong></div><div><span>待分配积分</span><strong>{number(team.allocatableBalance)}<small>积分</small></strong></div></div>
    <section className="team-members-section"><div className="panel-title"><div className="inline-title"><h3>团队成员</h3><span className="count-chip">{members.length} 人</span></div><span className={`team-roster-status ${team.membersComplete ? 'complete' : ''}`}>{team.membersComplete ? <><CheckCircle2 size={13} />名单已同步</> : '名单未完整同步'}</span></div>
      {members.length ? <div className="table-scroll"><table className="data-table team-members-table"><thead><tr><th>成员 / 角色</th><th className="align-right">平台已用积分</th><th className="align-right">成员余额</th><th>加入时间</th></tr></thead><tbody>{members.map((member) => { const role = teamRelationship(team, member.platformUserId).role; const presentation = identityPresentation(member.platformUserId, directory, member.displayName); return <tr key={member.platformUserId}><td><strong>{presentation.primary}</strong><span className={`team-member-role ${role}`}>{roleNames[role] || roleNames.unknown}</span><small className="cell-sub">{presentation.ownerName ? `即梦昵称 · ${presentation.secondary}` : presentation.secondary}</small><small className="cell-sub">平台 ID {member.platformUserId}</small><IdentityOwner platformUserId={member.platformUserId} editable showName={false} /></td><td className="align-right tabular">{number(member.usedCredits)}</td><td className="align-right tabular">{number(member.balance)}</td><td className="time-cell">{date(member.joinedAt)}</td></tr>; })}</tbody></table></div> : <div className="empty-state compact"><UsersRound size={24} /><h3>成员资料尚未同步</h3></div>}
    </section>
    <section className="detail-section team-detail-facts"><h3>团队与公司归属</h3><dl><div><dt>公司成本部门</dt><dd>{team.costDepartment || '待归属'}</dd></div><div><dt>内部负责人</dt><dd>{team.costOwnerName || '待归属'}</dd></div><div><dt>会员套餐</dt><dd>{team.membershipPlan || '未获取'}</dd></div><div><dt>会员有效期</dt><dd>{date(team.membershipExpiresAt)}</dd></div><div><dt>总席位</dt><dd>{number(team.totalSeats)}</dd></div><div><dt>可用席位</dt><dd>{number(team.availableSeats)}</dd></div></dl></section>
    <div className="team-detail-stamp"><span>团队空间 ID {team.spaceId}</span><span>余额更新于 {date(team.totalBalanceObservedAt, true)}</span><span>团队资料更新于 {date(team.observedAt, true)}</span></div>
    </div>
    <div hidden={tab === 'members'} className="team-wallet-panel">{children}</div>
  </div>;
}
