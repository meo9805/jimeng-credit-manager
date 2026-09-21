import { identityPresentation } from './identity-presentation.js';

/**
 * 界面上的顺序必须由界面自己决定。服务端为了“最新数据优先”按采集时间倒序返回账号与团队，
 * 直接把数组顺序画出来，就等于“谁刚上报谁排最前”——采集端每次上报，卡片就换一次位置。
 */

const text = value => value == null ? '' : String(value);
export const compareText = (left, right) => text(left).localeCompare(text(right), 'zh-CN', { numeric: true });
const time = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : 0; };
const personLabel = (person, group) => person.ownerName || person.nickname || group.displayName || '';
const newest = group => Math.max(0, ...(group.accounts || []).map(account => time(account.lastSyncedAt)));
const personalStock = group => { const balance = group.personal?.balance; return Number.isFinite(balance) ? balance : -1; };

export const ACCOUNT_ORDERS = [
  { value: 'name', label: '按归属人姓名' },
  { value: 'department', label: '按员工部门' },
  { value: 'synced', label: '按最近采集' },
  { value: 'balance', label: '按个人余额' },
];

/** 登录账号卡的顺序。默认按归属人姓名，部门与钱包类型作为次级键，保证完全确定。 */
export function orderAccountGroups(groups = [], { mode = 'name', directory } = {}) {
  const described = groups.map(group => ({ group, person: identityPresentation(group.platformUserId, directory, group.displayName) }));
  const byName = (a, b) => compareText(personLabel(a.person, a.group), personLabel(b.person, b.group))
    || compareText(a.person.department, b.person.department)
    || compareText(a.group.platformUserId, b.group.platformUserId);
  const comparators = {
    name: byName,
    department: (a, b) => compareText(a.person.department, b.person.department) || byName(a, b),
    synced: (a, b) => newest(b.group) - newest(a.group) || byName(a, b),
    balance: (a, b) => personalStock(b.group) - personalStock(a.group) || byName(a, b),
  };
  return described.sort(comparators[mode] || byName).map(item => item.group);
}

/** 一张账号卡内部的团队块顺序：按团队名固定，避免团队上报时块级换位。 */
export function orderTeamLinks(links = []) {
  return links.slice().sort((a, b) => compareText(a.team?.name || a.team?.spaceId || a.spaceId, b.team?.name || b.team?.spaceId || b.spaceId));
}

/** 团队列表顺序：按团队名固定。 */
export function orderTeams(teams = []) {
  return teams.slice().sort((a, b) => compareText(a.name || a.spaceId, b.name || b.spaceId));
}

/** 团队成员顺序：创建者在前，其余按角色与姓名。 */
export function orderTeamMembers(members = [], roleOf = () => 'unknown', labelOf = member => member.displayName) {
  const rank = { creator: 0, admin: 1, member: 2, unknown: 3 };
  return members.slice().sort((a, b) => (rank[roleOf(a)] ?? 3) - (rank[roleOf(b)] ?? 3) || compareText(labelOf(a), labelOf(b)));
}

/** 尚未关联登录账号的团队钱包：按团队名固定。 */
export function orderPools(pools = [], nameOf = pool => pool.spaceId) {
  return pools.slice().sort((a, b) => compareText(nameOf(a), nameOf(b)));
}
