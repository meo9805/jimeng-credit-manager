import { Fingerprint, UsersRound, Wallet, ChevronRight } from 'lucide-react';
import { loginIdentitySummary } from './accounting.js';
import { useIdentities } from './IdentityContext.jsx';
import { identityPresentation } from './identity-presentation.js';

const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '未获取';
export function billingLabel(value) {
  const names = { monthly: '按月', month: '按月', annual: '按年', annually: '按年', yearly: '按年', year: '按年', quarterly: '按季', quarter: '按季', lifetime: '长期', one_time: '单次购买' };
  return value ? names[String(value).toLowerCase()] || String(value) : '周期未获取';
}
export function walletTitle(account) {
  if (account.scope === 'team_total') return `${account.spaceName || account.displayName || '团队'} · 共享钱包`;
  if (account.scope === 'team_member') return `${account.displayName || '即梦账号'} · 成员额度`;
  return `${account.displayName || '即梦账号'} · 个人钱包`;
}
export function WalletIdentitySummary({ accounts, details = false, onAccount }) {
  const { directory } = useIdentities();
  const summary = loginIdentitySummary(accounts);
  return <div className={`wallet-context ${details ? 'with-details' : ''}`}>
    <div className="wallet-counts"><span><Fingerprint size={15} />已识别登录账号 <strong>{summary.loginCount}</strong></span><span><Wallet size={15} />独立积分钱包 <strong>{summary.walletCount}</strong></span><span><UsersRound size={15} />成员额度 <strong>{summary.memberAllowanceCount}</strong></span></div>
    {details && summary.groups.length > 0 ? <div className="login-group-list">{summary.groups.map((group) => <div className="login-group" key={group.platformUserId}><div><Fingerprint size={17} /><span><strong>{identityPresentation(group.platformUserId,directory,group.displayName).primary}</strong><small>{identityPresentation(group.platformUserId,directory,group.displayName).secondary} · ID {group.platformUserId}</small></span></div><div className="login-wallet-links">{group.personal ? <button onClick={() => onAccount(group.personal)}><span>个人会员</span>{group.personal.membershipPlan || '套餐未获取'}<ChevronRight size={13} /></button> : null}{group.members.map((member) => { const pool = group.sharedWallets.find((w) => w.spaceId === member.spaceId); return <button key={member.id} onClick={() => onAccount(member)}><span>{member.spaceName || '团队'} · 团队套餐</span>{member.membershipPlan || pool?.membershipPlan || '套餐未获取'}<ChevronRight size={13} /></button>; })}</div></div>)}</div> : null}
  </div>;
}

export function WalletRelation({ account, accounts, onAccount }) {
  const summary = loginIdentitySummary(accounts);
  if (account.scope === 'team_total') {
    const members = summary.groups.filter((group) => group.members.some((member) => member.spaceId === account.spaceId));
    return <div className="wallet-relation"><UsersRound size={17} /><div><strong>团队共享钱包</strong><p>{members.length ? `已关联 ${members.length} 个登录账号` : '关联成员未获取'}</p></div></div>;
  }
  const group = summary.groups.find((g) => g.platformUserId === String(account.platformUserId));
  const linked = group?.accounts.filter((a) => a.id !== account.id) || [];
  return <div className="wallet-relation"><Fingerprint size={17} /><div><strong>登录 ID {account.platformUserId || '未获取'}</strong>{linked.length ? <div className="related-wallets">{linked.map((a) => <button key={a.id} onClick={() => onAccount(a)}>{a.scope === 'personal' ? '个人钱包' : `${a.spaceName || '团队'} · 成员额度`}<ChevronRight size={13} /></button>)}</div> : null}</div></div>;
}

export function MembershipSection({ account }) {
  return <section className="detail-section membership-section"><h3>{account.scope === 'personal' ? '个人会员' : '团队套餐'}</h3><dl><div><dt>会员套餐</dt><dd>{account.membershipPlan || '未获取'}</dd></div><div><dt>计费周期</dt><dd>{billingLabel(account.billingCycle)}</dd></div><div><dt>会员有效期</dt><dd>{date(account.membershipExpiresAt)}</dd></div>{account.nextRenewalAt ? <div><dt>下次续费</dt><dd>{date(account.nextRenewalAt)}</dd></div> : null}<div><dt>套餐信息采集于</dt><dd>{date(account.subscriptionObservedAt)}</dd></div></dl></section>;
}
