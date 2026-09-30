import { archivedTeamIds, teamManagementById } from './team-management.js';

const knownNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function latestTeamBalance(team, pool) {
  const teamValue = knownNumber(team.totalBalance);
  const poolValue = knownNumber(pool?.balance);
  const teamDate = team.balanceObservedAt || team.observedAt || null;
  const poolDate = pool?.lastSyncedAt || null;
  const teamTime = timestamp(teamDate);
  const poolTime = timestamp(poolDate);
  const usePool = poolValue !== null && (teamValue === null || (poolTime !== null && (teamTime === null || poolTime > teamTime)));
  return { totalBalance: usePool ? poolValue : teamValue, totalBalanceObservedAt: usePool ? poolDate : teamValue !== null ? teamDate : null };
}

export function teamCreator(team) {
  const members = Array.isArray(team?.members) ? team.members : [];
  const explicitId = team?.creatorPlatformUserId ? String(team.creatorPlatformUserId) : null;
  const roleCreators = members.filter((member) => member.role === 'creator');
  const member = explicitId ? members.find((item) => String(item.platformUserId) === explicitId) : roleCreators.length === 1 ? roleCreators[0] : null;
  return {
    platformUserId: explicitId || (member?.platformUserId ? String(member.platformUserId) : null),
    displayName: team?.creatorDisplayName || member?.displayName || null,
  };
}

/** The platform creator and an internal cost owner are different facts. */
export function teamRelationship(team, platformUserId) {
  if (!team || !platformUserId) return { role: 'unknown', label: '团队关系未获取' };
  const id = String(platformUserId);
  const creator = teamCreator(team);
  if (creator.platformUserId === id) return { role: 'creator', label: '创建的团队' };
  const member = (team.members || []).find((item) => String(item.platformUserId) === id);
  if (member?.role === 'creator' && !creator.platformUserId) return { role: 'creator', label: '创建的团队' };
  if (member && ['admin', 'member'].includes(member.role)) {
    return { role: member.role, label: '加入的团队' };
  }
  if (member && creator.platformUserId && creator.platformUserId !== id && member.role !== 'creator') {
    return { role: 'unknown', label: '加入的团队' };
  }
  return { role: 'unknown', label: '团队关系未获取' };
}

/** Associate teams only with login identities already established by account data. */
export function linkedTeamsForLogin(group, teams = []) {
  const links = new Map();
  for (const member of group.members || []) {
    if (!member.spaceId) continue;
    const spaceId = String(member.spaceId);
    links.set(spaceId, { spaceId, member, pool: group.sharedWallets.find((pool) => String(pool.spaceId) === spaceId), loginPlatformUserId: group.platformUserId });
  }
  for (const team of teams) {
    const spaceId = String(team.spaceId);
    const rosterMember = team.members.find((member) => String(member.platformUserId) === String(group.platformUserId));
    if (!links.has(spaceId) && teamCreator(team).platformUserId !== String(group.platformUserId) && !rosterMember) continue;
    links.set(spaceId, { ...links.get(spaceId), spaceId, team, pool: team.pool || links.get(spaceId)?.pool, rosterMember, loginPlatformUserId: group.platformUserId });
  }
  return [...links.values()];
}

/** Link a team to its existing wallet without adding member identities to logins. */
export function teamViewModels(teams = [], accounts = [], teamManagement = []) {
  const pools = accounts.filter((account) => account.scope === 'team_total' && account.spaceId);
  const archived = archivedTeamIds(teams, teamManagement);
  const policies = teamManagementById(teamManagement);
  const bySpace = new Map();
  for (const pool of pools) bySpace.set(String(pool.spaceId), { spaceId: String(pool.spaceId) });
  for (const team of teams) if (team?.spaceId) bySpace.set(String(team.spaceId), team);
  return [...bySpace.values()].map((team) => {
    const pool = pools.find((account) => String(account.spaceId) === String(team.spaceId));
    const memberMap = new Map();
    for (const member of Array.isArray(team.members) ? team.members : []) {
      if (member?.platformUserId) memberMap.set(String(member.platformUserId), { ...member, platformUserId: String(member.platformUserId) });
    }
    const result = {
      ...team,
      spaceId: String(team.spaceId),
      archived: archived.has(String(team.spaceId)),
      archivedAt: policies.get(String(team.spaceId))?.archivedAt ?? team.archivedAt ?? null,
      name: team.name || pool?.spaceName || pool?.displayName || '团队名称未获取',
      membershipPlan: team.membershipPlan || pool?.membershipPlan || null,
      membershipExpiresAt: team.membershipExpiresAt || pool?.membershipExpiresAt || null,
      ...latestTeamBalance(team, pool),
      allocatableBalance: knownNumber(team.allocatableBalance),
      totalSeats: knownNumber(team.totalSeats),
      availableSeats: knownNumber(team.availableSeats),
      membersComplete: team.membersComplete === true,
      members: [...memberMap.values()],
      observedAt: team.observedAt || null,
      costDepartment: pool?.ownerDepartment || null,
      costOwnerName: pool?.ownerName || null,
      pool,
    };
    result.creator = teamCreator(result);
    return result;
  });
}
