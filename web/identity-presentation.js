import { teamCreator } from './teams.js';
import { transactionOwner } from './identities.js';

const text = value => typeof value === 'string' ? value.trim() || null : null;
const unknownNames = new Set(['即梦账号', '未识别账号', '平台昵称未获取', '成员名称未获取', '未获取', '个人空间', '团队空间']);
const nicknameValue = (value, platformUserId) => {
  const name = text(value);
  return name && name !== platformUserId && !unknownNames.has(name) ? name : null;
};

/** Display mapping does not identify the operator of a borrowed account. */
export function identityPresentation(platformUserId, directory, fallbackNickname) {
  const id = platformUserId == null ? null : text(String(platformUserId));
  const identity = id ? directory?.get(id) : null;
  const ownerName = text(identity?.realName);
  const nickname = nicknameValue(identity?.nickname, id) || (text(fallbackNickname) !== ownerName ? nicknameValue(fallbackNickname, id) : null);
  return {
    primary: ownerName || nickname || '未识别账号',
    secondary: ownerName ? nickname || '平台昵称未获取' : '归属待映射',
    ownerName,
    nickname,
    platformUserId: id,
    department: text(identity?.department),
  };
}

export function transactionPresentation(transaction, directory, fallbackNickname) {
  const id = transaction.chargedPlatformUserId;
  if (!transaction.ownershipSnapshot || !id) return identityPresentation(id,directory,fallbackNickname);
  const owner = transactionOwner(transaction,directory);
  return identityPresentation(id,new Map([[String(id),owner]]),fallbackNickname);
}

/** Team wallets follow only the confirmed platform creator, never the reader or cost owner. */
export function accountPresentation(account = {}, directory, teams = []) {
  const team = account.spaceId ? teams.find(item => String(item.spaceId) === String(account.spaceId)) : null;
  if (account.scope === 'team_total') {
    const creator = teamCreator(team);
    const identity = identityPresentation(creator.platformUserId, directory);
    const teamName = text(team?.name) || text(account.spaceName) || '团队名称未获取';
    return {
      ...identity,
      primary: identity.ownerName || teamName,
      secondary: identity.ownerName ? `${teamName} · 创建者` : creator.platformUserId ? '创建者归属待映射' : '创建者待确认',
      nickname: teamName,
      scopeLabel: '团队总积分',
    };
  }
  const member = (team?.members || []).find(item => String(item.platformUserId) === String(account.platformUserId));
  const displayName = text(account.displayName);
  const fallback = member?.displayName || (displayName !== text(account.spaceName) && displayName !== text(team?.name) ? displayName : null);
  return {
    ...identityPresentation(account.platformUserId, directory, fallback),
    scopeLabel: account.scope === 'personal' ? '个人钱包' : account.scope === 'team_member' ? '团队成员额度' : '账号积分',
  };
}

/** Compact native-select text keeps multiple accounts and team spaces distinguishable. */
export function accountOptionLabel(account = {}, directory, teams = []) {
  const presentation = accountPresentation(account, directory, teams);
  const team = account.spaceId ? teams.find(item => String(item.spaceId) === String(account.spaceId)) : null;
  const teamName = text(team?.name) || text(account.spaceName) || '团队名称未获取';
  const accountId = presentation.platformUserId;
  const idLabel = accountId ? `ID ${accountId.slice(-6)}` : '未识别账号';
  if (account.scope === 'team_total') {
    const creator = teamCreator(team);
    const identity = identityPresentation(creator.platformUserId, directory, creator.displayName);
    const owner = identity.ownerName ? `${identity.ownerName}（创建者）` : creator.platformUserId ? `${identity.nickname || idLabel}（创建者归属待映射）` : '创建者待确认';
    return [owner, teamName, presentation.scopeLabel].join(' · ');
  }
  const owner = presentation.ownerName || `${presentation.nickname || idLabel}（归属待映射）`;
  return [owner, presentation.ownerName ? presentation.nickname || idLabel : null, account.scope === 'team_member' ? teamName : null, presentation.scopeLabel].filter(Boolean).join(' · ');
}
