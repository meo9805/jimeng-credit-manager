import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_TABLE, accountUnits, cycleFromBilling, formatMoney, monthlyCost, subscriptionUnitPrice } from '../web/credit-value.js';
import { referenceWalletKey, suggestReferenceRate, estimateReferenceRate, resolveReferenceRate, referenceValue } from '../shared/reference-pricing.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const at = '2026-09-22T00:00:00Z';
const account = { id: 'a', scope: 'personal', platformUserId: 'u1', membershipPlan: '超级会员', billingCycle: '连续包年', balance: 600 };
const baseline = { id: 'initial', walletKey: 'personal:u1', perThousand: 60, effectiveAt: '1970-01-01T00:00:00.000Z', createdAt: at, source: 'manual', basis: 'initial_reference' };

test('only explicit known billing terms suggest a fixed initial reference', () => {
  assert.equal(cycleFromBilling('连续包年'), 'year');
  assert.equal(cycleFromBilling('连续包季'), 'quarter');
  assert.equal(cycleFromBilling('连续包月'), 'month');
  assert.equal(cycleFromBilling(null), null);
  near(suggestReferenceRate(account), 43680 / 12 / 54600 * 1000);
  assert.equal(suggestReferenceRate({ ...account, billingCycle: null, membershipExpiresAt: '2027-09-22' }), null);
  assert.equal(suggestReferenceRate({ ...account, membershipPlan: '无有效个人会员' }), null);
  assert.equal(monthlyCost('超级会员', null), null);
  assert.equal(subscriptionUnitPrice('超级会员', null, null), null);
  assert.equal(suggestReferenceRate({ ...account, scope: 'team_member', spaceId: 's', membershipPlan: '高级团队会员' }), null);
  assert.equal(suggestReferenceRate({ ...account, scope: 'team_member', spaceId: 's', membershipPlan: '超级团队会员', billingCycle: '连续包年' }), null);
  near(suggestReferenceRate({ ...account, scope: 'team_member', spaceId: 's', membershipPlan: '超级团队会员', billingCycle: '连续包月' }), 6319 / 68250 * 1000);
  assert.equal(PRICE_TABLE.teamPlans['高级团队会员'], undefined);
});

test('automatic estimates prefer explicit terms, then known monthly plans, then wallet-specific fallback', () => {
  const cases = [
    [account, 43680 / 12 / 54600 * 1000, 'platform_reference'],
    [{ ...account, billingCycle: null, membershipExpiresAt: '2027-09-22' }, 4299 / 54600 * 1000, 'plan_estimate'],
    [{ ...account, membershipPlan: '无有效个人会员' }, 100, 'purchase_estimate'],
    [{ ...account, membershipPlan: null }, 100, 'purchase_estimate'],
    [{ scope: 'team_member', spaceId: 's', membershipPlan: '超级团队会员', billingCycle: '连续包年' }, 6319 / 68250 * 1000, 'plan_estimate'],
    [{ scope: 'team_total', spaceId: 's', membershipPlan: '高级团队会员' }, 6319 / 68250 * 1000, 'team_estimate'],
    [{ scope: 'team_member', spaceId: 's', membershipPlan: '高级会员' }, 6319 / 68250 * 1000, 'team_estimate'],
  ];
  for (const [wallet, expected, source] of cases) {
    const estimate = estimateReferenceRate(wallet);
    near(estimate.perThousand, expected);
    assert.equal(estimate.source, source);
    assert.ok(estimate.explanation);
    assert.equal(estimate.basis, 'initial_reference');
    assert.equal(estimate.effectiveAt, '1970-01-01T00:00:00.000Z');
    near(referenceValue(wallet, 100, [], at), expected / 10);
  }
});

test('same team member and pool share one rate, personal wallet never borrows team pricing', () => {
  assert.equal(referenceWalletKey(account), 'personal:u1');
  assert.equal(referenceWalletKey({ scope: 'team_total', spaceId: 's' }), 'team:s');
  assert.equal(referenceWalletKey({ scope: 'team_member', spaceId: 's', platformUserId: 'u1' }), 'team:s');
  const teamRate = { ...baseline, walletKey: 'team:s', perThousand: 90 };
  assert.equal(referenceValue({ scope: 'team_total', spaceId: 's' }, 100, [teamRate], at), 9);
  assert.equal(referenceValue({ scope: 'team_member', spaceId: 's', platformUserId: 'u1' }, 100, [teamRate], at), 9);
  assert.equal(referenceValue({ ...account, platformUserId: 'u2', membershipPlan: null }, 100, [baseline, teamRate], at), 10);
});

test('effective revisions preserve old dates and select a deterministic same-timestamp revision', () => {
  const revised = { ...baseline, id: 'second', perThousand: 90, effectiveAt: '2026-09-20T00:00:00Z', revision: 2 };
  const sameTime = { ...revised, id: 'aaa', perThousand: 100, revision: 3 };
  const rates = [sameTime, baseline, revised];
  assert.equal(referenceValue(account, 100, rates, '2026-09-19T00:00:00Z'), 6);
  assert.equal(referenceValue(account, 100, rates, '2026-09-21T00:00:00Z'), 10);
  assert.equal(resolveReferenceRate(account, rates, at).id, 'aaa');
  assert.equal(resolveReferenceRate(account, rates, 'bad-date'), null);
  near(referenceValue(account, 100, [], at), 43680 / 12 / 54600 * 100);
  assert.equal(referenceValue(account, 100, [], at, { kind: 'gift' }), 0);
  assert.equal(referenceValue(account, 0, [], at), 0);
});

test('stock free batches stay zero and unknown plan prices receive an estimate', () => {
  const current = { ...account, creditBatches: [{ kind: 'gift', amount: 100 }, { kind: 'subscription', amount: 500 }] };
  const units = accountUnits(current, { rates: [baseline], at });
  assert.equal(units.average, 0.06, 'the reference is independent of remaining batch mix');
  assert.equal(units.stockValue, 30);
  assert.equal(units.stockUnpricedCredits, 0);
  const missing = accountUnits(current, { rates: [], at });
  near(missing.stockValue, 500 * 43680 / 12 / 54600);
  assert.equal(missing.stockUnpricedCredits, 0);
  const unknown = accountUnits({ ...account, membershipPlan: null, billingCycle: null, creditBatches: [] }, { rates: [], at });
  assert.equal(unknown.stockValue, 60);
  assert.equal(unknown.stockUnpricedCredits, 0);
  assert.equal(accountUnits({ ...account, balance: 0 }, { rates: [], at }).stockValue, 0);
  assert.equal(accountUnits({ ...account, balance: null }, { rates: [], at }).stockValue, null);
  const conflicting = accountUnits({ ...account, creditBatches: [{ kind: 'gift', amount: 700 }] }, { rates: [], at });
  near(conflicting.stockValue, 600 * 43680 / 12 / 54600);
  assert.equal(conflicting.stockUnpricedCredits, 0);
  assert.equal(accountUnits({ ...account, creditBatches: [{ kind: 'gift', amount: 600 }] }, { rates: [], at }).stockValue, 0);
});

test('estimated prices do not turn missing or invalid credit amounts into zero', () => {
  for (const credits of [null, undefined, NaN, Infinity, '100']) {
    assert.equal(referenceValue(account, credits, [], at), null);
    assert.equal(referenceValue(account, credits, [], at, { kind: 'gift' }), null);
    assert.equal(accountUnits({ ...account, balance: credits }, { rates: [], at }).stockValue, null);
  }
  assert.equal(accountUnits({ ...account, balance: -1 }, { rates: [], at }).stockValue, null);
  assert.equal(referenceValue({ ...account, membershipPlan: null }, -100, [], at), -10);
});

test('invalid and not-yet-effective stored prices cannot suppress automatic estimates', () => {
  const unknown = { ...account, membershipPlan: null, billingCycle: null };
  const invalidRates = [
    ...[-1, NaN, Infinity, '50'].map(perThousand => ({ ...baseline, perThousand })),
    { ...baseline, effectiveAt: 'bad-date' },
    { ...baseline, effectiveAt: '2026-10-01T00:00:00Z' },
  ];
  assert.equal(referenceValue(unknown, 100, invalidRates, at), 10);
  assert.equal(referenceValue(unknown, 100, [...invalidRates, baseline], at), 6);
});

test('membership and source changes cannot silently reprice stored references', () => {
  for (const kind of ['gift', 'purchase', 'subscription']) {
    const changed = { ...account, membershipPlan: '高级会员', billingCycle: '连续包月', creditBatches: [{ kind, amount: 600 }] };
    assert.equal(accountUnits(changed, { rates: [baseline], at }).average, 0.06);
    assert.equal(referenceValue(changed, 100, [baseline], at), 6);
  }
});

test('money formatting preserves the existing compact presentation', () => {
  assert.equal(formatMoney(5260.4), '¥5,260');
  assert.equal(formatMoney(2.04), '¥2.0');
  assert.equal(formatMoney(null), '—');
});
