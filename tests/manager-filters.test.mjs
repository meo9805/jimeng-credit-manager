import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesActualOperator, actualOperatorOptions, matchesIdentityAssignment } from '../web/manager-filters.js';
import { matchesAccountOwner, identityDirectory } from '../web/identities.js';

test('borrowed-account consumption separates the actual employee from the account owner', () => {
  const directory = identityDirectory([{ platformUserId: 'xia-account', employeeId: 'xia', realName: '夏意然', departmentId: 'video' }]);
  const transaction = Object.freeze({ kind: 'consume', amount: -100, chargedPlatformUserId: 'xia-account', attribution: 'matched', operatorEmployeeId: 'ma', operatorName: '马亚波' });
  assert.equal(matchesActualOperator(transaction, 'employee:ma'), true);
  assert.equal(matchesActualOperator(transaction, 'employee:xia'), false);
  assert.equal(matchesAccountOwner(transaction, directory, 'employee:xia'), true);
  assert.equal(matchesAccountOwner(transaction, directory, 'employee:ma'), false);
});

test('unknown operators never derive from charged accounts or platform automatic events', () => {
  for (const transaction of [{ kind: 'consume', attribution: 'unconfirmed', chargedPlatformUserId: 'ma' }, { kind: 'consume', operatorEmployeeId: 'ma', operatorName: '马亚波', attribution: 'unconfirmed' }]) {
    assert.equal(matchesActualOperator(transaction, '__unconfirmed'), true);
    assert.equal(matchesActualOperator(transaction, 'employee:ma'), false);
  }
  for (const transaction of [{ kind: 'expire' }, { kind: 'grant', description: '每日免费积分' }]) {
    assert.equal(matchesActualOperator(transaction, '__unconfirmed'), false);
    assert.equal(matchesActualOperator(transaction, '__platform'), true);
  }
});

test('historical matched operators remain selectable after employee deletion', () => {
  const transaction = { kind: 'consume', attribution: 'matched', operatorEmployeeId: 'removed', operatorName: '原员工', operatorDepartment: '原部门', occurredAt: '2026-09-15T00:00:00Z' };
  const options = actualOperatorOptions([{ id: 'active', name: '现员工', department: '新部门' }], [transaction, { ...transaction, occurredAt: '2026-09-14T00:00:00Z', operatorName: '旧名称' }]);
  assert.equal(options.length, 2);
  assert.equal(options.find(option => option.id === 'removed').name, '原员工');
  assert.equal(matchesActualOperator(transaction, 'employee:removed'), true);
  assert.equal(matchesActualOperator(transaction, '__matched'), true);
});

test('employee department filtering uses the account assignment instead of team wallet cost ownership', () => {
  const member = { employeeId: 'collaborator', departmentId: 'teaching' };
  assert.equal(matchesIdentityAssignment(member, 'collaborator', 'teaching'), true);
  assert.equal(matchesIdentityAssignment(member, 'creator', 'teaching'), false);
  assert.equal(matchesIdentityAssignment(member, 'all', 'video'), false);
  assert.equal(matchesIdentityAssignment(null, '__unassigned', '__unassigned'), true);
});
