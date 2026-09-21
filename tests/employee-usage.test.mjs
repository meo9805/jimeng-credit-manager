import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { employeeUsage, matchesUsagePeriod } from '../web/employee-usage.js';
import { identity, transactionId, validateIngest } from '../server/domain.mjs';
import { createStore } from '../server/store.mjs';

const now = Date.parse('2026-09-15T07:00:00Z');
const employees = [{ id: 'a', name: '员工甲', departmentId: 'd1' }, { id: 'b', name: '员工乙', departmentId: 'd2' }, { id: 'c', name: '员工丙' }];
const departments = [{ id: 'd1', name: '部门甲' }, { id: 'd2', name: '部门乙' }];
const directory = new Map([['user-a', { employeeId: 'a' }], ['user-a-other', { employeeId: 'a' }], ['user-b', { employeeId: 'b' }]]);
const expense = (id, extra = {}) => ({ id, kind: 'consume', amount: -20, occurredAt: '2026-09-10T08:00:00Z', chargedPlatformUserId: 'user-a', attribution: 'unconfirmed', ...extra });
const calculate = extra => employeeUsage({ employees, departments, directory, now, ...extra });

test('borrowed accounts charge their owner while confirmed operation credits the distinct employee ID', () => {
  const transactions = [expense('borrowed', { amount: -100, attribution: 'matched', operatorEmployeeId: 'b', operatorName: '过期姓名' }), expense('another', { chargedPlatformUserId: 'user-a-other' })];
  const original = structuredClone(transactions);
  const result = calculate({ transactions });
  assert.equal(result.rows[0].employeeId, 'a');
  assert.equal(result.rows[0].ownedConsumption, 120);
  assert.equal(result.rows[0].operatorConsumption, null);
  assert.equal(result.rows.find(row => row.employeeId === 'b').operatorConsumption, 100);
  assert.equal(result.rows.find(row => row.employeeId === 'b').ownedConsumption, 0);
  assert.equal(result.unconfirmedOperatorConsumption, 20);
  assert.equal(result.rows[0].department, '部门甲');
  assert.deepEqual(transactions, original);
});

test('team cost owners and observing accounts are not substituted for the charged member', () => {
  const accounts = [{ id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'user-a', ownerEmployeeId: 'a', ownerName: '员工甲' }];
  const result = calculate({ accounts, transactions: [expense('member', { accountId: 'pool', chargedPlatformUserId: 'user-b', amount: -50 }), expense('unknown', { accountId: 'pool', chargedPlatformUserId: null, amount: -15 })] });
  assert.equal(result.rows.find(row => row.employeeId === 'a').ownedConsumption, 0);
  assert.equal(result.rows.find(row => row.employeeId === 'b').ownedConsumption, 50);
  assert.equal(result.unassignedConsumption, 15);
  assert.equal(result.totalConsumption, 65);
});

test('the same official team event observed from pool and member views counts once, separate ledgers remain distinct', () => {
  const pool = identity({ scope: 'team_total', platformUserId: 'user-a', spaceId: 'team' });
  const member = identity({ scope: 'team_member', platformUserId: 'user-b', spaceId: 'team' });
  const personal = identity({ scope: 'personal', platformUserId: 'user-a', spaceId: 'personal' });
  const transaction = account => expense(transactionId(account, 'event'), { accountId: account.id, eventId: 'event', chargedPlatformUserId: 'user-b' });
  const result = calculate({ accounts: [pool, member, personal], transactions: [transaction(pool), transaction(member), transaction(pool), transaction(personal)] });
  assert.equal(result.transactionCount, 2);
  assert.equal(result.totalConsumption, 40);
  assert.equal(result.rows.find(row => row.employeeId === 'b').ownedConsumption, 40);
});

test('Beijing month starts at UTC 16:00, excludes future rows, and all includes earlier collected usage', () => {
  assert.equal(matchesUsagePeriod('2026-08-31T15:59:59Z', 'month', now), false);
  assert.equal(matchesUsagePeriod('2026-08-31T16:00:00Z', 'month', now), true);
  assert.equal(matchesUsagePeriod('2026-09-30T16:00:00Z', 'month', now), false);
  assert.equal(matchesUsagePeriod('invalid', 'all', now), false);
  const transactions = [expense('before', { occurredAt: '2026-08-31T15:59:59Z' }), expense('start', { occurredAt: '2026-08-31T16:00:00Z' }), expense('future', { occurredAt: '2026-09-30T16:00:00Z' })];
  assert.equal(calculate({ transactions }).totalConsumption, 20);
  assert.equal(calculate({ transactions, period: 'all' }).totalConsumption, 40);
  assert.match(calculate({ transactions }).rangeLabel, /2026\/9\/1/);
  assert.equal(matchesUsagePeriod('2025-12-31T16:00:00Z', 'month', Date.parse('2026-01-01T00:00:00Z')), true);
});

test('gifts, expiry, refunds and invalid consumption never become employee usage; names alone never prove identity', () => {
  const transactions = ['grant', 'expire', 'refund', 'adjustment'].map(kind => expense(kind, { kind }));
  transactions.push(expense('positive', { amount: 1 }), expense('zero', { amount: 0 }), expense('invalid', { amount: NaN }), expense('string', { amount: '-30' }));
  transactions.push(expense('unconfirmed', { operatorEmployeeId: 'a', operatorName: '员工甲' }), expense('name-only', { attribution: 'matched', operatorName: '员工甲' }));
  const result = calculate({ transactions });
  assert.equal(result.totalConsumption, 40);
  assert.equal(result.rows[0].ownedConsumption, 40);
  assert.equal(result.rows[0].operatorConsumption, null);
  assert.equal(result.unconfirmedOperatorConsumption, 40);
  assert.equal(result.rows.find(row => row.employeeId === 'c').operatorConsumption, null);
});

test('same employee names remain separate stable IDs, and unknown mappings stay unassigned', () => {
  const result = calculate({ employees: employees.map(employee => ({ ...employee, name: '同名员工' })), transactions: [expense('a'), expense('b', { chargedPlatformUserId: 'user-b', attribution: 'matched', operatorEmployeeId: 'b' }), expense('unknown', { chargedPlatformUserId: 'missing' })] });
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.find(row => row.employeeId === 'a').ownedConsumption, 20);
  assert.equal(result.rows.find(row => row.employeeId === 'b').ownedConsumption, 20);
  assert.equal(result.unassignedConsumption, 20);
  assert.equal(result.rows.find(row => row.employeeId === 'b').operatorConsumption, 20);
});

test('deleting an operator and collector preserves confirmed historical usage under the employee snapshot', t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jmc-usage-removed-'));
  const store = createStore({ dataDir, secret: 'isolated-usage-test', clock: () => now });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const department = store.createDepartment({ name: '历史部门' });
  const operator = store.createEmployee({ name: '历史操作者', departmentId: department.id });
  const owner = store.createEmployee({ name: '账号归属员工', departmentId: department.id });
  const device = store.createInstallation({ employeeId: operator.id, role: 'collector' });
  const occurredAt = new Date(now).toISOString();
  store.ingest(device, validateIngest({ observedAt: occurredAt, status: 'ok', accounts: [], transactions: [{ platformUserId: 'borrowed-user', scope: 'personal', spaceId: 'personal', eventId: 'history-event', occurredAt, kind: 'consume', amount: -100, platformSubmitId: 'submit-removed' }], operationEvidence: [{ submitId: 'submit-removed', userId: 'borrowed-user', spaceType: 'personal', spaceId: 'personal', occurredAt }] }, now));
  store.patchIdentity('borrowed-user', { employeeId: owner.id });
  store.deleteInstallation(device.id);
  store.deleteEmployee(operator.id);
  const dashboard = store.dashboard();
  assert.equal(dashboard.employees.some(employee => employee.id === operator.id), false);
  assert.equal(dashboard.transactions[0].attribution, 'matched');
  const result = employeeUsage({ ...dashboard, directory: new Map(dashboard.identities.map(identity => [identity.platformUserId, identity])), now });
  const retired = result.rows.find(row => row.employeeId === operator.id);
  assert.ok(retired);
  assert.equal(retired.name, operator.name);
  assert.equal(retired.department, department.name);
  assert.equal(retired.removed, true);
  assert.equal(retired.ownedConsumption, null);
  assert.equal(retired.operatorConsumption, 100);
  assert.equal(result.rows.find(row => row.employeeId === owner.id).ownedConsumption, 100);
  assert.equal(result.unconfirmedOperatorConsumption, 0);
});
