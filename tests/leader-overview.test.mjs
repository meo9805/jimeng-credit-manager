import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeaderOverview, overviewRange, inOverviewRange } from '../web/leader-overview.js';

const now = Date.parse('2026-09-17T06:00:00Z');
const recent = '2026-09-17T05:00:00Z';
const employees = [{ id: 'a', name: '甲', departmentId: 'd1' }, { id: 'b', name: '乙', departmentId: 'd2' }, { id: 'c', name: '丙', departmentId: 'd1' }];
const departments = [{ id: 'd1', name: '一部' }, { id: 'd2', name: '二部' }];
const identities = [{ platformUserId: 'ua', employeeId: 'a', realName: '甲', departmentId: 'd1', department: '一部' }, { platformUserId: 'ub', employeeId: 'b', realName: '乙', departmentId: 'd2', department: '二部' }];
const personal = (who = 'a', extra = {}) => ({ id: `p${who}`, platformUserId: `u${who}`, scope: 'personal', spaceId: 'personal', balance: 500, lastSyncedAt: recent, creditBatches: [], ...extra });
const accounts = [personal(), personal('b')];
const owner = (who = 'a', extra = {}) => ({ employeeId: who, name: who === 'a' ? '甲' : '乙', departmentId: who === 'a' ? 'd1' : 'd2', department: who === 'a' ? '一部' : '二部', basis: 'effective', effectiveAt: '2026-09-01T00:00:00Z', ...extra });
const transaction = (key, extra = {}) => ({ id: key, eventId: key, accountId: 'pa', chargedPlatformUserId: 'ua', kind: 'consume', amount: -100, occurredAt: '2026-09-10T06:00:00Z', platformSubmitId: `task-${key}`, ownershipSnapshot: owner(), attribution: 'unconfirmed', ...extra });
const matched = (who = 'a') => ({ attribution: 'matched', operatorEmployeeId: who, operatorName: who === 'a' ? '甲' : '乙', operatorDepartmentId: who === 'a' ? 'd1' : 'd2', operatorDepartment: who === 'a' ? '一部' : '二部' });
const calculate = extra => buildLeaderOverview({ employees, departments, identities, accounts, now, ...extra });
const row = (result, key) => result.rows.find(value => value.employeeId === key);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const referenceRate = (who, perThousand, effectiveAt = '1970-01-01T00:00:00.000Z') => ({ id: `${who}:${effectiveAt}`, walletKey: `personal:u${who}`, perThousand, effectiveAt, createdAt: effectiveAt });

test('historical reference amounts do not follow current balance, plan or batch mix', () => {
  const referenceRates = [referenceRate('a', 60)];
  const transactions = [transaction('charge', { ...matched('b') }), transaction('expired', { kind: 'expire', amount: -30, expiryCreditKind: 'subscription' })];
  for (const kind of ['gift', 'purchase', 'subscription']) {
    const result = calculate({ accounts: [personal('a', { membershipPlan: '高级会员', billingCycle: '连续包月', creditBatches: [{ kind, amount: 500 }] })], referenceRates, transactions });
    assert.equal(result.summary.money.netConsumption, 6);
    assert.equal(result.summary.money.expiry, 1.8);
    assert.equal(row(result, 'b').money.operatorConsumption, 6);
    assert.equal(row(result, 'a').money.lentConsumption, 6);
  }
});

test('operator, owner and borrowing use the charged wallet reference independently', () => {
  const result = calculate({ referenceRates: [referenceRate('a', 50), referenceRate('b', 100)], transactions: [
    transaction('a-own', { ...matched('a'), amount: -100 }),
    transaction('a-borrow', { ...matched('a'), accountId: 'pb', chargedPlatformUserId: 'ub', ownershipSnapshot: owner('b'), amount: -200 }),
    transaction('b-borrow', { ...matched('b'), amount: -50 }),
  ] });
  assert.equal(row(result, 'a').money.consumption, 7.5);
  assert.equal(row(result, 'a').money.operatorConsumption, 25);
  assert.equal(row(result, 'a').money.grossOperatorConsumption, 25);
  assert.equal(row(result, 'a').grossOperatorConsumption, 300);
  assert.equal(row(result, 'a').money.borrowedConsumption, 20);
  assert.equal(row(result, 'a').borrowedFrom[0].money, 20);
  assert.equal(row(result, 'b').money.lentConsumption, 20);
  assert.equal(result.summary.money.borrowedConsumption, 22.5);
});

test('a new reference revision never reprices a refund or a previous-period charge', () => {
  const old = transaction('old', { ...matched('b'), occurredAt: '2026-08-20T06:00:00Z' });
  const result = calculate({ referenceRates: [referenceRate('a', 50), referenceRate('a', 100, '2026-09-01T00:00:00Z')], transactions: [
    old, transaction('refund', { kind: 'refund', amount: 40, platformSubmitId: old.platformSubmitId }),
    transaction('new', { ...matched('b'), amount: -10 }),
  ] });
  assert.equal(result.summary.money.netConsumption, -1);
  assert.equal(result.summary.money.linkedRefunds, 2);
  assert.equal(row(result, 'b').money.operatorConsumption, -1);
  assert.equal(row(result, 'b').money.operatorRefunds, 2);
  assert.equal(row(result, 'b').operatorRefunds, 40);
  assert.deepEqual(row(result, 'b').transactionIds.operatorRefund, ['refund']);
  assert.equal(row(result, 'a').money.linkedRefunds, 2);
});

test('prior-period refunds and repeated refunds cannot exceed the charged credits', () => {
  const debit = transaction('old', { ...matched('b'), occurredAt: '2026-08-20T06:00:00Z' });
  const refund = (key, amount, occurredAt) => transaction(key, { kind: 'refund', amount, occurredAt, platformSubmitId: debit.platformSubmitId });
  const result = calculate({ referenceRates: [referenceRate('a', 50)], transactions: [
    refund('over', 50, '2026-09-02T00:00:00Z'), debit, refund('before', 80, '2026-08-25T00:00:00Z'), refund('again', 10, '2026-09-03T00:00:00Z'),
  ] });
  assert.equal(result.summary.linkedRefunds, 20);
  assert.equal(result.summary.unmatchedRefunds, 40);
  assert.equal(result.summary.money.linkedRefunds, 1);
  assert.equal(row(result, 'b').operatorRefunds, 20);
});

test('mixed-rate partial refunds prorate original charges and full refunds cancel their value', () => {
  const first = transaction('early', { ...matched('b'), platformSubmitId: 'same', occurredAt: '2026-09-01T00:00:00Z' });
  const second = transaction('late', { ...matched('b'), platformSubmitId: 'same', occurredAt: '2026-09-10T00:00:00Z' });
  const refund = amount => transaction('refund', { kind: 'refund', amount, platformSubmitId: 'same', occurredAt: '2026-09-11T00:00:00Z' });
  const referenceRates = [referenceRate('a', 50), referenceRate('a', 100, '2026-09-05T00:00:00Z')];
  const full = calculate({ referenceRates, transactions: [first, second, refund(200)] });
  assert.equal(full.summary.money.linkedRefunds, 15);
  assert.equal(full.summary.money.netConsumption, 0);
  const partial = calculate({ referenceRates, transactions: [first, second, refund(50)] });
  assert.equal(partial.summary.linkedRefunds, 50);
  assert.equal(partial.summary.money.linkedRefunds, 3.75);
  assert.equal(partial.summary.money.netConsumption, 11.25);
  assert.equal(row(partial, 'b').money.operatorRefunds, 3.75);
  assert.equal(row(partial, 'b').money.operatorConsumption, 11.25);
  assert.equal(partial.summary.moneyUnpricedByField.linkedRefunds, undefined);
  assert.equal(row(partial, 'b').moneyUnpricedByField.operatorRefunds, undefined);
  const repeated = calculate({ referenceRates, transactions: [first, second, refund(50),
    { ...refund(200), id: 'refund-rest', eventId: 'refund-rest', occurredAt: '2026-09-12T00:00:00Z' },
  ] });
  assert.equal(repeated.summary.linkedRefunds, 200);
  assert.equal(repeated.summary.unmatchedRefunds, 50);
  assert.equal(repeated.summary.money.linkedRefunds, 15);
  assert.equal(repeated.summary.money.netConsumption, 0);
  assert.equal(row(repeated, 'b').money.operatorConsumption, 0);
});

test('a later charge on a partially refunded task retains only the unrefunded original value', () => {
  const charge = (id, occurredAt) => transaction(id, { ...matched('b'), platformSubmitId: 'same', occurredAt });
  const refund = (id, amount, occurredAt) => transaction(id, { kind: 'refund', amount, platformSubmitId: 'same', occurredAt });
  const referenceRates = [referenceRate('a', 50), referenceRate('a', 100, '2026-09-05T00:00:00Z')];
  const transactions = [
    charge('old', '2026-09-01T00:00:00Z'), refund('early-refund', 50, '2026-09-02T00:00:00Z'),
    charge('new', '2026-09-10T00:00:00Z'), refund('later-partial', 60, '2026-09-11T00:00:00Z'),
  ];
  const partial = calculate({ referenceRates, transactions });
  assert.equal(partial.summary.linkedRefunds, 110);
  assert.equal(partial.summary.money.linkedRefunds, 7.5, 'the second refund returns 60 / 150 of the remaining 12.5 yuan');
  assert.equal(partial.summary.money.netConsumption, 7.5);
  const result = calculate({ referenceRates, transactions: [...transactions, refund('remaining', 90, '2026-09-12T00:00:00Z')] });
  assert.equal(result.summary.linkedRefunds, 200);
  assert.equal(result.summary.money.linkedRefunds, 15);
  assert.equal(result.summary.money.netConsumption, 0);
  assert.equal(row(result, 'a').money.lentConsumption, 0);
  assert.equal(row(result, 'b').money.borrowedConsumption, 0);
});

test('missing plan prices automatically estimate every visible metric using the charged wallet', () => {
  const result = calculate({ referenceRates: [referenceRate('a', 50)], transactions: [
    transaction('priced', { ...matched('a'), amount: -100 }),
    transaction('unknown', { ...matched('a'), accountId: 'pb', chargedPlatformUserId: 'ub', ownershipSnapshot: owner('b'), amount: -200 }),
  ] });
  assert.equal(row(result, 'a').money.operatorConsumption, 25);
  assert.equal(row(result, 'a').moneyUnpricedByField.operatorConsumption, undefined);
  assert.equal(row(result, 'a').money.borrowedConsumption, 20);
  assert.equal(row(result, 'a').moneyUnpricedByField.borrowedConsumption, undefined);
  assert.equal(row(result, 'a').borrowedFrom[0].money, 20);
  assert.equal(row(result, 'a').borrowedFrom[0].unpricedCredits, 0);
  assert.equal(row(result, 'b').money.balance, 50);
  assert.equal(row(result, 'b').moneyUnpricedByField.balance, undefined);
  assert.equal(result.summary.money.netConsumption, 25);
  assert.equal(result.summary.moneyUnpricedByField.netConsumption, undefined);
});

test('unknown balances remain missing while readable zero balances receive zero value', () => {
  const result = calculate({ accounts: [personal('a', { balance: null }), personal('b', { balance: 0 })], transactions: [] });
  assert.equal(row(result, 'a').balance, null);
  assert.equal(row(result, 'a').money.balance, undefined);
  assert.equal(row(result, 'b').balance, 0);
  assert.equal(row(result, 'b').money.balance, 0);
  assert.equal(result.summary.unknownBalanceCount, 1);
});

test('China calendar ranges include today, trailing seven days, clipped custom days, and reject invalid dates', () => {
  const month = overviewRange({ now });
  assert.equal(month.start, Date.parse('2026-08-31T16:00:00Z'));
  assert.equal(month.days, 17);
  assert.equal(inOverviewRange('2026-08-31T15:59:59Z', month), false);
  assert.equal(inOverviewRange('2026-08-31T16:00:00Z', month), true);
  assert.equal(inOverviewRange('2026-09-17T06:00:01Z', month), false);
  assert.equal(overviewRange({ period: 'today', now }).days, 1);
  assert.equal(overviewRange({ period: 'week', now }).start, Date.parse('2026-09-10T16:00:00Z'));
  const custom = overviewRange({ period: 'custom', from: '2026-09-09', to: '2026-09-10', now });
  assert.equal(custom.days, 2);
  assert.equal(custom.end, Date.parse('2026-09-10T15:59:59.999Z'));
  assert.equal(overviewRange({ period: 'custom', from: '2026-09-01', to: '2026-10-01', now }).end, now);
  for (const [from, to] of [['2026-02-30', '2026-09-17'], ['2026-09-18', '2026-09-17'], ['2026-09-18', '2026-09-20']]) {
    const bad = overviewRange({ period: 'custom', from, to, now });
    assert.ok(bad.error);
    assert.equal(inOverviewRange('2026-09-10T06:00:00Z', bad), false);
  }
});

test('both directions are calculated per debit, not by subtracting total owned and operated', () => {
  const transactions = [
    transaction('own', { ...matched('a'), amount: -50 }),
    transaction('b-uses-a', { ...matched('b'), amount: -100 }),
    transaction('a-uses-b', { accountId: 'pb', chargedPlatformUserId: 'ub', ownershipSnapshot: owner('b'), ...matched('a'), amount: -30 }),
    transaction('unknown-operator', { amount: -20 }),
    transaction('unknown-owner', { chargedPlatformUserId: 'unknown', ownershipSnapshot: { employeeId: null, basis: 'effective' }, ...matched('a'), amount: -10 }),
  ];
  const original = structuredClone({ accounts, transactions });
  const result = calculate({ transactions });
  assert.equal(row(result, 'a').ownedConsumption, 170);
  assert.equal(row(result, 'a').operatorConsumption, 90);
  assert.equal(row(result, 'a').selfConsumption, 50);
  assert.equal(row(result, 'a').borrowedConsumption, 30);
  assert.equal(row(result, 'a').lentConsumption, 100);
  assert.equal(row(result, 'a').unconfirmedConsumption, 20);
  assert.equal(row(result, 'a').unknownOwnerConsumption, 10);
  assert.equal(row(result, 'a').borrowedFrom[0].employeeId, 'b');
  assert.equal(row(result, 'b').borrowedConsumption, 100);
  assert.equal(result.summary.netConsumption, 210);
  assert.equal(result.summary.borrowedConsumption, 130);
  assert.equal(result.summary.unassignedConsumption, 10);
  assert.equal(result.summary.confirmedOperatorRate, 190 / 210);
  assert.equal(row(result, 'a').daily.reduce((sum, value) => sum + value.owned, 0), 170);
  assert.deepEqual({ accounts, transactions }, original);
});

test('normal team member use belongs to the member, while duplicate pool and member observations count once', () => {
  const teamAccounts = [{ id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', ownerEmployeeId: 'a', balance: 1000, lastSyncedAt: recent }, { id: 'member', scope: 'team_member', spaceId: 'team', platformUserId: 'ub', balance: 200, lastSyncedAt: recent }];
  const charge = transaction('team-event', { eventId: 'shared', accountId: 'pool', chargedPlatformUserId: 'ub', ownershipSnapshot: owner('b'), ...matched('b') });
  const result = calculate({ accounts: teamAccounts, transactions: [charge, { ...charge, id: 'same-in-member', accountId: 'member' }, { ...charge, id: 'distinct-personal', accountId: 'pa' }].slice(0, 2) });
  assert.equal(result.summary.netConsumption, 100);
  assert.equal(row(result, 'b').selfConsumption, 100);
  assert.equal(row(result, 'b').borrowedConsumption, 0);
  assert.equal(row(result, 'a').ownedConsumption, null);
  assert.equal(result.summary.availableBalance, 1000);
  assert.equal(row(result, 'b').balance, 200);
  near(result.summary.money.netConsumption, 100 * 6319 / 68250);
  near(result.summary.money.availableBalance, 1000 * 6319 / 68250);
  near(row(result, 'b').money.balance, 200 * 6319 / 68250);
});

test('task-linked refunds retain charge ownership and operator, including refunds for an earlier period', () => {
  const debit = transaction('old-charge', { occurredAt: '2026-08-20T06:00:00Z', ...matched('b') });
  const refund = transaction('refund', { kind: 'refund', amount: 40, platformSubmitId: debit.platformSubmitId, ownershipSnapshot: owner('b') });
  const result = calculate({ transactions: [debit, refund] });
  assert.equal(result.summary.grossConsumption, 0);
  assert.equal(result.summary.linkedRefunds, 40);
  assert.equal(result.summary.netConsumption, -40);
  assert.equal(row(result, 'a').ownedConsumption, -40);
  assert.equal(row(result, 'a').lentConsumption, -40);
  assert.equal(row(result, 'b').operatorConsumption, -40);
  assert.equal(row(result, 'b').borrowedConsumption, -40);
  assert.deepEqual(row(result, 'b').transactionIds.borrowed, ['refund']);
  assert.equal(result.summary.confirmedOperatorRate, null);
});

test('refunds require exact space, charged member and task and cannot choose among conflicting proof', () => {
  const debit = transaction('charge', { ...matched('b') });
  const refund = (key, extra = {}) => transaction(key, { kind: 'refund', amount: 30, platformSubmitId: debit.platformSubmitId, occurredAt: '2026-09-11T06:00:00Z', ...extra });
  const otherSpace = { id: 'other-team', scope: 'team_member', spaceId: 'team-2', platformUserId: 'ua', balance: null };
  const result = calculate({ accounts: [...accounts, otherSpace], transactions: [debit,
    refund('wrong-member', { chargedPlatformUserId: 'ub', ownershipSnapshot: owner('b') }),
    refund('wrong-space', { accountId: 'other-team' }), refund('missing-task', { platformSubmitId: null }),
    refund('before-charge', { occurredAt: '2026-09-09T06:00:00Z' }),
  ] });
  assert.equal(result.summary.netConsumption, 100);
  assert.equal(result.summary.unmatchedRefunds, 120);
  assert.equal(result.summary.linkedRefunds, 0);
  const conflicting = calculate({ transactions: [debit, transaction('second', { platformSubmitId: debit.platformSubmitId, ...matched('a') }), refund('ambiguous')] });
  assert.equal(conflicting.summary.linkedRefunds, 0);
  assert.equal(conflicting.summary.unmatchedRefunds, 30);
  const unknown = calculate({ transactions: [transaction('unconfirmed'), refund('known-owner-refund', { platformSubmitId: 'task-unconfirmed' })] });
  assert.equal(row(unknown, 'a').ownedConsumption, 70);
  assert.equal(row(unknown, 'a').unconfirmedConsumption, 70);
  assert.equal(row(unknown, 'a').operatorConsumption, null);
});

test('ownership snapshots survive reassignments, explicit unknown does not fall back and removed operators remain visible', () => {
  const changed = identities.map(person => person.platformUserId === 'ua' ? { ...person, employeeId: 'b', realName: '乙', departmentId: 'd2' } : person);
  const result = calculate({ identities: changed, transactions: [transaction('historic', { ...matched('gone'), operatorName: '离职员工', operatorDepartmentId: 'd1' }), transaction('unknown', { ownershipSnapshot: { employeeId: null, basis: 'effective' } }), transaction('null-unknown', { ownershipSnapshot: null })] });
  assert.equal(row(result, 'a').ownedConsumption, 100);
  assert.equal(row(result, 'b').ownedConsumption, 0);
  assert.equal(result.summary.unassignedConsumption, 200);
  assert.equal(row(result, 'gone').removed, true);
  assert.equal(row(result, 'gone').name, '离职员工');
  assert.equal(row(result, 'gone').operatorConsumption, 100);
  const legacy = transaction('legacy'); delete legacy.ownershipSnapshot;
  assert.equal(calculate({ transactions: [legacy] }).summary.legacyOwnershipAmount, 100);
});

test('only paid expiry counts as waste; free and unsupported sources stay outside leader totals', () => {
  const pool = { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', ownerEmployeeId: 'a', ownerDepartmentId: 'd1', balance: 1000, lastSyncedAt: recent };
  const result = calculate({ accounts: [personal('a', { creditBatches: [{ kind: 'gift', amount: 30, expiresAt: '2026-09-10T00:00:00Z' }] }), pool], transactions: [
    transaction('gift-expiry', { kind: 'expire', amount: -30, description: '每日免费积分清零', expiryCreditKind: 'gift' }),
    transaction('unknown-expiry', { kind: 'expire', amount: -80 }),
    transaction('pool-expiry', { kind: 'expire', amount: -1000, expiryCreditKind: 'subscription', accountId: 'pool', chargedPlatformUserId: null, ownershipSnapshot: { employeeId: null, basis: 'effective' } }),
    transaction('grant', { kind: 'grant', amount: 500 }), transaction('adjust', { kind: 'adjustment', amount: -10 }),
  ] });
  assert.deepEqual(result.summary.expiry, { total: 1000, paid: 1000, gift: 0, unclassified: 0 });
  assert.equal(row(result, 'a').expiry.total, 0);
  assert.deepEqual(result.summary.transactionIds.expiry, ['pool-expiry']);
  assert.equal(result.unassigned.expiry.total, 1000);
  assert.equal(result.summary.netConsumption, 0);
  assert.equal(result.summary.expiringAmount, 0);
  assert.equal(row(result, 'a').balance, 500);
});

test('fresh personal and member balances are summed per person, company pools once, stale and unknown excluded', () => {
  const result = calculate({ accounts: [personal('a', { balance: 0 }), personal('b', { balance: 800, lastSyncedAt: '2026-09-15T05:00:00Z' }),
    { id: 'old-member', scope: 'team_member', spaceId: 'team', platformUserId: 'ua', balance: 100, lastSyncedAt: '2026-09-15T05:00:00Z' },
    { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', balance: 1000, lastSyncedAt: recent, ownerDepartmentId: 'd1' },
  ], teams: [{ spaceId: 'team', creatorPlatformUserId: 'ua', totalBalance: 1000, allocatableBalance: 300, balanceObservedAt: recent, observedAt: recent, membersComplete: true, members: [{ platformUserId: 'ua', balance: 200 }, { platformUserId: 'ub', balance: 500 }] }] });
  assert.equal(row(result, 'a').balance, 200);
  assert.equal(row(result, 'a').personalBalance, 0);
  assert.equal(row(result, 'a').teamBalance, 200);
  assert.equal(row(result, 'a').accounts.length, 2);
  assert.equal(row(result, 'b').balance, 500);
  assert.equal(row(result, 'b').staleBalance, 800);
  assert.equal(row(result, 'b').balancePartial, true);
  assert.equal(result.summary.availableBalance, 1000);
  assert.equal(result.summary.staleBalance, 800);
  assert.equal(result.summary.unallocatedBalance, 300);
  assert.equal(result.summary.unknownBalanceCount, 1);
  assert.equal(row(result, 'c').balance, null);
  assert.equal(row(result, 'c').ownedConsumption, null);
  assert.equal(result.summary.pendingEmployees, 1);
  const onlyMember = calculate({ accounts: [{ id: 'm', scope: 'team_member', spaceId: 'team', platformUserId: 'ua', balance: 50, lastSyncedAt: recent }] });
  assert.equal(onlyMember.summary.availableBalance, null);
  assert.equal(onlyMember.summary.balancePartial, true);
  assert.equal(row(onlyMember, 'a').balance, 50);
});

test('leadership balances retain the latest report across days and replace it without duplicating team quotas', () => {
  const old = '2026-09-10T05:00:00Z';
  const fixture = {
    accounts: [personal('a', { balance: 600, lastSyncedAt: old, creditBatches: [
      { kind: 'gift', amount: 100, expiresAt: '2026-09-18T15:59:59Z' },
      { kind: 'purchase', amount: 500, expiresAt: '2026-09-12T15:59:59Z' },
    ] }), personal('b', { balance: null }),
    { id: 'pool', scope: 'team_total', spaceId: 'team', balance: 1000, lastSyncedAt: old, ownerDepartmentId: 'd1' },
    { id: 'member', scope: 'team_member', spaceId: 'team', platformUserId: 'ua', balance: 200, lastSyncedAt: old }],
    referenceRates: [referenceRate('a', 100), { walletKey: 'team:team', perThousand: 100, effectiveAt: '1970-01-01T00:00:00Z' }],
    transactions: [transaction('charge')],
  };
  const operations = calculate(fixture);
  assert.equal(operations.summary.availableBalance, null, 'administration retains the freshness check');
  const result = calculate({ ...fixture, useLastKnownBalances: true });
  assert.equal(result.summary.availableBalance, 1600, 'company counts the pool once, not the member quota again');
  assert.equal(result.summary.wallets.length, 2);
  near(result.summary.money.availableBalance, 150);
  assert.equal(row(result, 'a').balance, 800);
  near(row(result, 'a').money.balance, 70);
  assert.equal(row(result, 'b').balance, null, 'an unread balance is not invented');
  assert.equal(row(result, 'a').operatorConsumption, null, 'old balance retention does not invent operation proof');
  assert.equal(result.summary.netConsumption, operations.summary.netConsumption);
  assert.equal(result.summary.expiringAmount, 0, 'free future batches and already-expired paid batches are excluded');
  const updated = calculate({ ...fixture, useLastKnownBalances: true, accounts: [...fixture.accounts,
    personal('a', { id: 'new-personal-view', balance: 400, lastSyncedAt: recent })] });
  assert.equal(updated.summary.availableBalance, 1400, 'a new report replaces the previous snapshot');
  assert.equal(row(updated, 'a').balance, 600);
});

test('a viewer clock behind the server still counts just-synced balances, while real age still expires', () => {
  // 查看电脑的时钟比服务器慢 30 分钟时，只用本机时间判断新鲜度会把刚采集的余额当成未来数据剔除。
  const lagging = Date.parse('2026-09-17T05:30:00Z');
  const justSynced = personal('a', { balance: 600, lastSyncedAt: '2026-09-17T05:45:00Z' });
  const yesterday = personal('b', { balance: 900, lastSyncedAt: '2026-09-16T04:00:00Z' });
  const naive = buildLeaderOverview({ employees, departments, identities, accounts: [justSynced, yesterday], now: lagging });
  assert.equal(naive.summary.availableBalance, null);
  assert.equal(naive.summary.staleBalance, 1500);
  // 以快照里的服务端时间为准后：新余额计入，真正超过 24 小时的仍然剔除。
  const result = buildLeaderOverview({ employees, departments, identities, accounts: [justSynced, yesterday], now: lagging, asOf: '2026-09-17T06:00:00Z' });
  assert.equal(result.summary.availableBalance, 600);
  assert.equal(result.summary.staleBalance, 900);
  assert.equal(result.summary.unknownBalanceCount, 1);
  assert.equal(row(result, 'a').balance, 600);
  assert.equal(row(result, 'b').balance, null);
  // 服务端时间不会让过期余额复活：整体时间往后走时旧余额照样过期。
  const later = buildLeaderOverview({ employees, departments, identities, accounts: [justSynced], now, asOf: '2026-09-18T06:00:00Z' });
  assert.equal(later.summary.availableBalance, null);
});

test('future seven-day expiry sums observed batches separately from estimates and does not count pools plus quotas twice', () => {
  const soon = '2026-09-20T06:00:00Z';
  const estimate = { expiresAt: soon, grantedAt: '2026-08-20T06:00:00Z', rule: 'team_subscription_month' };
  const result = calculate({ accounts: [personal('a', { balance: 100, creditBatches: [{ kind: 'gift', amount: 20, expiresAt: '2026-09-16T06:00:00Z' }, { kind: 'purchase', amount: 80, expiresAt: soon }] }),
    { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', balance: 1000, subscriptionBalance: 1000, creditExpiryEstimate: estimate, lastSyncedAt: recent },
    { id: 'member', scope: 'team_member', spaceId: 'team', platformUserId: 'ua', balance: 200, subscriptionBalance: 200, creditExpiryEstimate: estimate, lastSyncedAt: recent },
  ] });
  assert.equal(result.summary.expiringAmount, 80);
  assert.equal(result.summary.estimatedExpiringAmount, 1000);
  assert.equal(row(result, 'a').expiringAmount, 80);
  assert.equal(row(result, 'a').estimatedExpiringAmount, 200);
  assert.equal(row(result, 'a').dueBatches.length, 2);
  assert.equal(row(result, 'a').dueBatches.filter(batch => batch.estimated).length, 1);
});

test('top-card expiry detail contains the exact fresh official batches and boundary dates, with employee-first metadata', () => {
  const end = new Date(now + 7 * 86_400_000).toISOString();
  const candidate = personal('a', { displayName: '平台昵称', balance: 140, creditBatches: [
    { id: 'membership', kind: 'subscription', amount: 100, expiresAt: '2026-09-20T06:00:00Z' },
    { id: 'gift', kind: 'gift', amount: 20, expiresAt: end },
    { id: 'old', kind: 'purchase', amount: 10, expiresAt: new Date(now).toISOString() },
    { id: 'future', kind: 'purchase', amount: 10, expiresAt: new Date(now + 7 * 86_400_000 + 1).toISOString() },
  ] });
  const result = calculate({ referenceRates: [referenceRate('a', 50)], accounts: [
    candidate, { ...candidate, id: 'older-observation', balance: 999, lastSyncedAt: '2026-09-15T05:00:00Z' },
    personal('b', { lastSyncedAt: '2026-09-15T05:00:00Z', creditBatches: [{ kind: 'purchase', amount: 80, expiresAt: end }] }),
  ] });
  assert.equal(result.summary.wallets.length, 1);
  assert.equal(result.summary.wallets[0].employeeName, '甲');
  assert.equal(result.summary.wallets[0].displayName, '平台昵称');
  assert.equal(result.summary.wallets[0].balance, result.summary.availableBalance);
  assert.equal(result.summary.wallets[0].referenceValue, result.summary.money.availableBalance);
  assert.equal(result.summary.dueBatches.length, 1);
  assert.equal(result.summary.dueBatches.reduce((sum, item) => sum + item.amount, 0), result.summary.expiringAmount);
  assert.ok(!result.summary.dueBatches.some(item => item.kind === 'gift'));
  assert.ok(!row(result, 'a').dueBatches.some(item => item.kind === 'gift'));
  assert.equal(result.summary.dueBatches.find(item => item.kind === 'subscription').referenceValue, 5);
});

test('roster-derived company balances use the chosen snapshot, preserve labels and never duplicate member quotas', () => {
  const older = { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ub', ownerEmployeeId: 'a', ownerName: '甲', ownerDepartmentId: 'd1',
    balance: 700, lastSyncedAt: '2026-09-16T05:00:00Z', creditBatches: [{ kind: 'subscription', amount: 700, expiresAt: '2026-09-20T06:00:00Z' }] };
  const teams = [{ spaceId: 'team', name: '同一个团队', creatorPlatformUserId: 'ua', totalBalance: 500, observedAt: recent, balanceObservedAt: recent,
    membersComplete: true, members: [{ platformUserId: 'ua', role: 'creator', balance: 100 }, { platformUserId: 'ub', role: 'member', balance: 400 }] }];
  const result = calculate({ accounts: [older], teams });
  assert.equal(result.summary.wallets.length, 1);
  assert.equal(result.summary.wallets[0].balance, 500);
  assert.equal(result.summary.availableBalance, 500);
  assert.equal(result.summary.wallets[0].ownerName, '甲');
  assert.equal(result.summary.wallets[0].employeeName, '甲');
  assert.equal(result.summary.wallets[0].spaceName, '同一个团队');
  near(result.summary.wallets[0].referenceValue, 500 * 6319 / 68250);
  assert.equal(result.summary.wallets[0].referenceValue, result.summary.money.availableBalance);
  assert.equal(result.summary.wallets[0].unpricedCredits, 0);
  assert.equal(result.summary.dueBatches.length, 0, 'new roster balance must not inherit old batches');
  assert.equal(result.summary.expiringAmount, 0);
  assert.equal(row(result, 'b').balance, 400);
  const unverified = calculate({ accounts: [{ ...older, ownerEmployeeId: null, ownerName: null, lastSyncedAt: recent }], teams: [] });
  assert.equal(unverified.summary.wallets[0].employeeName, null, 'the collector login is not proof of team ownership');
});

test('an unchanged team balance keeps its estimated expiry when the roster snapshot becomes newer', () => {
  const expiry = { rule: 'team_subscription_month', grantedAt: '2026-08-20T06:00:00Z', expiresAt: '2026-09-20T06:00:00Z' };
  const account = { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', balance: 700,
    subscriptionBalance: 700, lastSyncedAt: '2026-09-17T05:00:00.000Z', creditExpiryEstimate: expiry };
  const team = { spaceId: 'team', name: '团队', creatorPlatformUserId: 'ua', totalBalance: 700,
    observedAt: '2026-09-17T05:00:00.001Z', balanceObservedAt: '2026-09-17T05:00:00.001Z', members: [] };
  const before = calculate({ accounts: [account], teams: [{ ...team, observedAt: '2026-09-17T04:59:59.999Z', balanceObservedAt: '2026-09-17T04:59:59.999Z' }] });
  const after = calculate({ accounts: [account], teams: [team] });
  assert.equal(before.summary.estimatedExpiringAmount, 700);
  assert.equal(after.summary.estimatedExpiringAmount, 700);
  assert.equal(after.summary.dueBatches.length, 1);
  assert.equal(after.summary.wallets[0].balance, 700);
  const changed = calculate({ accounts: [account], teams: [{ ...team, totalBalance: 500 }] });
  assert.equal(changed.summary.estimatedExpiringAmount, 0, 'a different balance must not inherit the old estimate');
});

test('department-filtered top-card details reconcile official and estimated amounts separately', () => {
  const soon = '2026-09-20T06:00:00Z';
  const estimate = { expiresAt: soon, grantedAt: '2026-08-20T06:00:00Z', rule: 'team_subscription_month' };
  const result = calculate({ departmentId: 'd1', accounts: [
    personal('a', { balance: 100, creditBatches: [{ id: 'gift', kind: 'gift', amount: 100, expiresAt: soon }] }),
    personal('b', { balance: 50, creditBatches: [{ id: 'gift', kind: 'gift', amount: 50, expiresAt: soon }] }),
    { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ub', ownerEmployeeId: 'a', ownerName: '甲', ownerDepartmentId: 'd1', balance: 1000, subscriptionBalance: 1000, creditExpiryEstimate: estimate, lastSyncedAt: recent },
    { id: 'member', scope: 'team_member', spaceId: 'team', platformUserId: 'ua', balance: 200, subscriptionBalance: 200, creditExpiryEstimate: estimate, lastSyncedAt: recent },
  ] });
  assert.equal(result.summary.wallets.reduce((sum, item) => sum + item.balance, 0), result.summary.availableBalance);
  assert.equal(result.summary.availableBalance, 1100);
  const official = result.summary.dueBatches.filter(item => !item.estimated), estimated = result.summary.dueBatches.filter(item => item.estimated);
  assert.equal(official.reduce((sum, item) => sum + item.amount, 0), result.summary.expiringAmount);
  assert.equal(estimated.reduce((sum, item) => sum + item.amount, 0), result.summary.estimatedExpiringAmount);
  assert.equal(result.summary.expiringAmount, 0);
  assert.equal(result.summary.estimatedExpiringAmount, 1000);
  assert.equal(estimated[0].kind, 'subscription');
  assert.equal(estimated[0].ownerName, '甲');
  near(estimated[0].referenceValue, 1000 * 6319 / 68250);
  assert.equal(estimated[0].unpricedCredits, 0);
  assert.equal(official.length, 0);
  assert.equal(new Set(result.summary.dueBatches.map(item => item.id)).size, result.summary.dueBatches.length);
  assert.ok(result.summary.dueBatches.every(item => item.scope !== 'team_member'));
});

test('department filters use owner for spending and operator for borrowing, retaining cross-department counterpart names', () => {
  const tx = transaction('cross-department', { ...matched('b') });
  const first = calculate({ departmentId: 'd1', transactions: [tx] });
  assert.equal(first.summary.netConsumption, 100);
  assert.equal(first.summary.borrowedConsumption, 0);
  assert.equal(row(first, 'a').lentTo[0].name, '乙');
  assert.equal(row(first, 'b'), undefined);
  const second = calculate({ departmentId: 'd2', transactions: [tx] });
  assert.equal(second.summary.netConsumption, 0);
  assert.equal(second.summary.borrowedConsumption, 100);
  assert.equal(row(second, 'b').borrowedFrom[0].name, '甲');
  assert.equal(row(second, 'a'), undefined);
  assert.equal(second.summary.availableBalance, 500);
});

test('duplicate conflicting operator proof never selects an arbitrary employee', () => {
  const tx = transaction('dup', { ...matched('a') });
  const result = calculate({ transactions: [tx, { ...tx, id: 'duplicate-2', ...matched('b') }] });
  assert.equal(result.summary.netConsumption, 100);
  assert.equal(result.summary.unconfirmedOperatorConsumption, 100);
  assert.equal(row(result, 'a').operatorConsumption, null);
  assert.equal(row(result, 'b').operatorConsumption, null);
});

test('all-period labels start at earliest real observation and empty evidence stays unknown', () => {
  const result = calculate({ period: 'all', transactions: [transaction('old', { occurredAt: '2026-08-20T06:00:00Z' })] });
  assert.match(result.range.label, /^2026\/08\/20/);
  const empty = calculate({ accounts: [], transactions: [] });
  assert.equal(empty.summary.availableBalance, null);
  assert.equal(empty.summary.confirmedOperatorRate, null);
  assert.equal(empty.summary.pendingEmployees, 3);
  assert.equal(row(empty, 'a').ownedConsumption, null);
  assert.equal(row(empty, 'a').operatorConsumption, null);
});

// 未归属账号（历史/停用账号、团队总额度）造成的消耗与到期是真实损失。
// 它们必须和员工行出现在同一张表里，否则摘要卡合计永远对不上表格，
// 管理者也就无法在表内发现这部分浪费。
test('unassigned expiry becomes a table row so the board total reconciles with the summary cards', () => {
  const pool = { id: 'pool', scope: 'team_total', spaceId: 'team', platformUserId: 'ua', ownerEmployeeId: 'a', ownerDepartmentId: 'd1', balance: 1000, lastSyncedAt: recent };
  const result = calculate({ accounts: [personal('a'), pool], transactions: [
    transaction('owned-expiry', { kind: 'expire', amount: -30, expiryCreditKind: 'purchase' }),
    transaction('pool-expiry', { kind: 'expire', amount: -1000, expiryCreditKind: 'subscription', accountId: 'pool', chargedPlatformUserId: null, ownershipSnapshot: { employeeId: null, basis: 'effective' } }),
  ] });
  const orphan = row(result, '__unassigned__');
  assert.ok(orphan, '未归属必须作为一行出现在表格里');
  assert.equal(orphan.unassigned, true);
  assert.equal(orphan.name, '未归属');
  assert.equal(orphan.expiry.total, 1000);
  assert.equal(orphan.expiry.total, result.unassigned.expiry.total);
  const boardTotal = result.rows.reduce((sum, item) => sum + item.expiry.total, 0);
  assert.equal(boardTotal, result.summary.expiry.total);
});

test('unassigned consumption joins the same row instead of hiding below the table', () => {
  const result = calculate({ transactions: [transaction('orphan', { ownershipSnapshot: { employeeId: null, basis: 'effective' } })] });
  const orphan = row(result, '__unassigned__');
  assert.ok(orphan, '未归属消耗必须出现在表内');
  assert.equal(orphan.ownedConsumption, 100);
  assert.equal(orphan.ownedConsumption, result.unassigned.consumption);
  assert.equal(result.summary.unassignedConsumption, 100);
});

test('the unassigned row stays out of the board when nothing is unassigned', () => {
  const result = calculate({ transactions: [transaction('own')] });
  assert.equal(row(result, '__unassigned__'), undefined);
  assert.equal(result.unassigned.expiry.total, 0);
});
