import test from 'node:test';
import assert from 'node:assert/strict';
import { identityDirectory, identityOwnerGroups, matchesAccountOwner } from '../web/identities.js';

const identities = [
  { platformUserId: 'u1', nickname: '昵称一', realName: '员工甲', department: '部门甲' },
  { platformUserId: 'u2', nickname: '昵称二', realName: '员工甲', department: '部门甲' },
  { platformUserId: 'u3', nickname: '昵称三', realName: '员工甲', department: '部门乙' },
  { platformUserId: 'u4', nickname: '未映射昵称', realName: null, department: null },
];
const directory = identityDirectory(identities);
const groups = identityOwnerGroups(identities);
const departmentA = groups.find((group) => group.department === '部门甲');

test('one maintained name and department includes all of its platform accounts', () => {
  assert.deepEqual(departmentA.platformUserIds, ['u1', 'u2']);
  for (const chargedPlatformUserId of ['u1', 'u2']) {
    assert.equal(matchesAccountOwner({ chargedPlatformUserId }, directory, departmentA.key), true);
  }
});

test('same name in a different department stays separate', () => {
  assert.equal(groups.length, 2);
  assert.equal(matchesAccountOwner({ chargedPlatformUserId: 'u3' }, directory, departmentA.key), false);
  assert.equal(matchesAccountOwner({ chargedPlatformUserId: 'u1' }, directory, departmentA.key, '部门乙'), false);
});

test('unmapped and missing charged IDs are available in unassigned filters', () => {
  for (const chargedPlatformUserId of ['u4', 'not-observed', null]) {
    assert.equal(matchesAccountOwner({ chargedPlatformUserId }, directory, '__unassigned', '__unassigned'), true);
    assert.equal(matchesAccountOwner({ chargedPlatformUserId }, directory, departmentA.key), false);
  }
});

test('owner joins leave actual operator and source records unchanged', () => {
  const transaction = { chargedPlatformUserId: 'u1', operatorName: '已核实操作者', operatorDepartment: '其他部门', attribution: 'matched' };
  const before = structuredClone(transaction);
  assert.equal(matchesAccountOwner(transaction, directory, departmentA.key), true);
  assert.deepEqual(transaction, before);
  assert.equal(directory.get('u1').nickname, '昵称一');
  assert.equal(identityOwnerGroups([...identities, identities[0]])[0].platformUserIds.length, 2);
});
