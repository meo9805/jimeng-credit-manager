import test from 'node:test';
import assert from 'node:assert/strict';
import { creditExpiryRows } from '../web/credit-expiry.js';
import { identityOwnerGroups, identityDirectory, matchesAccountOwner } from '../web/identities.js';

test('daily gift expiry never appears as the expiry of the monthly member balance', () => {
  const rows = creditExpiryRows({ balance: 23302, creditBatches: [
    { kind: 'gift', amount: 30, expiresAt: '2026-09-15T15:59:59.000Z' },
    { kind: 'subscription', amount: 23272, expiresAt: '2026-09-28T13:06:05.000Z' },
    { kind: 'gift', amount: 0, expiresAt: '2026-09-14T15:59:59.000Z' },
  ] });
  assert.deepEqual(rows.map(row => [row.kind, row.amount, row.expiresAt]), [
    ['subscription', 23272, '2026-09-28T13:06:05.000Z'], ['gift', 30, '2026-09-15T15:59:59.000Z'],
  ]);
  assert.deepEqual(creditExpiryRows({ balance: 23302, expiresAt: '2026-09-15T15:59:59.000Z' }), []);
});
test('same-source batches with different dates remain separate, unknown dates remain unknown', () => {
  const rows = creditExpiryRows({ creditBatches: [
    {kind:'gift',amount:5,expiresAt:null},{kind:'gift',amount:6,expiresAt:null},
    {kind:'gift',amount:7,expiresAt:'2026-10-01T00:00:00Z'},
  ] });
  assert.equal(rows.length, 2); assert.equal(rows[1].amount, 11); assert.equal(rows[1].expiresAt, null);
});
test('employee grouping and department filter use stable IDs across rename and transfer', () => {
  const old = [{platformUserId:'u1',employeeId:'e1',realName:'甲',department:'原部门',departmentId:'d1'}];
  const key = identityOwnerGroups(old)[0].key;
  const current = [{...old[0], realName:'新姓名',department:'新部门',departmentId:'d2'}, {platformUserId:'u2',employeeId:'e1',realName:'新姓名',department:'新部门',departmentId:'d2'}, {platformUserId:'u3',employeeId:'e2',realName:'新姓名',department:'新部门',departmentId:'d2'}];
  const directory = identityDirectory(current);
  assert.deepEqual(identityOwnerGroups(current).find(group => group.key === key).platformUserIds, ['u1','u2']);
  assert.equal(matchesAccountOwner({chargedPlatformUserId:'u1'},directory,key,'d2'),true);
  assert.equal(matchesAccountOwner({chargedPlatformUserId:'u3'},directory,key,'d2'),false);
});
