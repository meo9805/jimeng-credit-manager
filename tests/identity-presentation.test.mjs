import test from 'node:test';
import assert from 'node:assert/strict';
import { identityDirectory } from '../web/identities.js';
import { identityPresentation, accountPresentation, accountOptionLabel } from '../web/identity-presentation.js';

const directory = identityDirectory([
  { platformUserId: 'creator-123456', realName: '员工甲', nickname: '平台昵称甲', department: '教研' },
  { platformUserId: 'reader-654321', realName: '员工乙', nickname: '平台昵称乙', department: '短剧' },
  { platformUserId: 'unknown-987654', realName: null, nickname: '待归属昵称' },
  { platformUserId: 'named-112233', realName: '员工丙', nickname: null, department: '农资' },
]);
const team = {
  spaceId: 'team-a', name: '平台团队甲', creatorPlatformUserId: 'creator-123456',
  members: [{ platformUserId: 'creator-123456', role: 'creator', displayName: '名单旧昵称甲' }, { platformUserId: 'reader-654321', role: 'member', displayName: '名单旧昵称乙' }],
};
const pool = { scope: 'team_total', spaceId: 'team-a', spaceName: '平台团队甲', platformUserId: 'reader-654321', displayName: '采集账号昵称', ownerName: '人工成本负责人', ownerDepartment: '成本部门' };

test('employee assignment is primary and a known platform nickname stays secondary', () => {
  assert.deepEqual(identityPresentation('creator-123456', directory, '较旧页面昵称'), {
    primary: '员工甲', secondary: '平台昵称甲', ownerName: '员工甲', nickname: '平台昵称甲', platformUserId: 'creator-123456', department: '教研',
  });
  const unmapped = identityPresentation('unknown-987654', directory);
  assert.equal(unmapped.primary, '待归属昵称');
  assert.equal(unmapped.secondary, '未关联员工');
  assert.equal(unmapped.ownerName, null);
});

test('missing nicknames never become employee names, placeholder names or raw IDs', () => {
  const missing = identityPresentation('named-112233', directory, '员工丙');
  assert.equal(missing.primary, '员工丙');
  assert.equal(missing.nickname, null);
  assert.equal(missing.secondary, '平台昵称未获取');
  for (const fallback of ['unseen-999999', '即梦账号', '个人空间', '团队空间', '平台昵称未获取', ' ']) {
    assert.equal(identityPresentation('unseen-999999', directory, fallback).primary, '未识别账号');
  }
  assert.equal(identityPresentation(null, directory).platformUserId, null);
  assert.equal(identityPresentation('unseen-999999', directory, '有效页面昵称').nickname, '有效页面昵称');
});

test('personal and member wallets use their account identity independently of cost owner', () => {
  for (const scope of ['personal', 'team_member']) {
    const view = accountPresentation({ ...pool, scope }, directory, [team]);
    assert.equal(view.primary, '员工乙');
    assert.equal(view.nickname, '平台昵称乙');
    assert.equal(view.department, '短剧');
    assert.equal(view.platformUserId, 'reader-654321');
  }
  assert.equal(accountPresentation({ ...pool, scope: 'team_member', platformUserId: 'unseen', displayName: pool.spaceName }, directory, [team]).nickname, null);
});

test('team pool owner comes only from the confirmed creator, never the reader or cost assignment', () => {
  assert.deepEqual(accountPresentation(pool, directory, [team]), {
    primary: '员工甲', secondary: '平台团队甲 · 创建者', ownerName: '员工甲', nickname: '平台团队甲', platformUserId: 'creator-123456', department: '教研', scopeLabel: '团队总积分',
  });
  const noTeam = accountPresentation(pool, directory, []);
  assert.equal(noTeam.primary, '平台团队甲');
  assert.equal(noTeam.ownerName, null);
  assert.equal(noTeam.platformUserId, null);
  assert.equal(noTeam.secondary, '创建者未获取');
});

test('one roster creator is accepted; conflicting roles do not establish an owner', () => {
  const rosterOnly = { ...team, creatorPlatformUserId: undefined };
  assert.equal(accountPresentation(pool, directory, [rosterOnly]).ownerName, '员工甲');
  const conflict = { ...rosterOnly, members: rosterOnly.members.map(member => ({ ...member, role: 'creator' })) };
  assert.equal(accountPresentation(pool, directory, [conflict]).ownerName, null);
  const unknownCreator = { ...team, creatorPlatformUserId: 'unknown-987654' };
  assert.equal(accountPresentation(pool, directory, [unknownCreator]).secondary, '创建者未关联员工');
});

test('account options distinguish employee, platform nickname and team without misidentifying pool readers', () => {
  assert.equal(accountOptionLabel({ ...pool, scope: 'personal' }, directory, [team]), '员工乙 · 平台昵称乙 · 个人钱包');
  assert.equal(accountOptionLabel({ ...pool, scope: 'team_member' }, directory, [team]), '员工乙 · 平台昵称乙 · 平台团队甲 · 团队成员额度');
  assert.equal(accountOptionLabel(pool, directory, [team]), '员工甲（创建者） · 平台团队甲 · 团队总积分');
  assert.equal(accountOptionLabel({ scope: 'personal', platformUserId: 'unknown-987654' }, directory), '待归属昵称（未关联员工） · 个人钱包');
  assert.equal(accountOptionLabel({ scope: 'personal', platformUserId: 'unseen-998877' }, directory), 'ID 998877（未关联员工） · 个人钱包');
  assert.equal(accountOptionLabel({ scope: 'personal', platformUserId: 'named-112233' }, directory), '员工丙 · ID 112233 · 个人钱包');
  assert.doesNotMatch(accountOptionLabel(pool, directory, []), /员工乙|人工成本负责人/);
});

test('presentation leaves live identity, team and wallet records unchanged', () => {
  const before = structuredClone({ identities: [...directory], pool, team });
  identityPresentation('creator-123456', directory);
  accountPresentation(pool, directory, [team]);
  accountOptionLabel(pool, directory, [team]);
  assert.deepEqual({ identities: [...directory], pool, team }, before);
});
