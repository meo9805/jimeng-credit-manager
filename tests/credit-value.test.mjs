import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_TABLE, accountUnits, cycleFromBilling, cycleFromDates, formatMoney, monthlyCost, planKey, subscriptionUnitPrice } from '../web/credit-value.js';

const near = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} 与 ${expected} 相差过大`);

test('充值积分与订阅积分是两个价，不能混用', () => {
  assert.equal(PRICE_TABLE.purchasePerCredit, 0.1);
  // 充值：积分商城 500 分 ¥50，固定每分 ¥0.10
  near(subscriptionUnitPrice('超级会员', 'year', null) * 0, 0);
  const superYear = subscriptionUnitPrice('超级会员', 'year', null);
  near(superYear, 43680 / 12 / 54600);            // 年付原价 ÷ 12 ÷ 每月积分 ≈ 0.0667
  const superMonth = subscriptionUnitPrice('超级会员', 'month', null);
  near(superMonth, 4299 / 54600);                  // 月付原价 ÷ 每月积分 ≈ 0.0787
  assert.ok(superYear < superMonth, '订阅积分比充值积分便宜');
  assert.ok(superYear < PRICE_TABLE.purchasePerCredit);
});

test('套餐、周期与推断规则', () => {
  assert.equal(planKey('高级会员'), '高级会员');
  assert.equal(planKey('无有效个人会员'), null);
  assert.equal(planKey('高级团队会员'), null, '团队套餐走 teamPlans，不在这里匹配');
  assert.equal(cycleFromBilling('连续包年'), 'year');
  assert.equal(cycleFromBilling('连续包季'), 'quarter');
  assert.equal(cycleFromBilling('连续包月'), 'month');
  assert.equal(cycleFromBilling(null), null);
  // 会员有效期 − 最近一次订阅发放日 → 12 个月是年付，1 个月是月付
  assert.equal(cycleFromDates('2027-08-28T13:06:05Z', '2026-08-28T13:06:05Z'), 'year');
  assert.equal(cycleFromDates('2026-10-11T03:32:44Z', '2026-09-11T03:32:44Z'), 'month');
  near(monthlyCost('高级会员', 'year'), 10398 / 12);
});

test('库存按批次来源分别计价，赠送积分不计成本', () => {
  const account = {
    id: 'a', scope: 'personal', platformUserId: 'u1', membershipPlan: '超级会员', balance: 600,
    creditBatches: [
      { kind: 'subscription', amount: 500, expiresAt: '2026-10-01T00:00:00Z' },
      { kind: 'purchase', amount: 100, expiresAt: '2028-09-09T00:00:00Z' },
      { kind: 'gift', amount: 0, expiresAt: '2026-09-17T00:00:00Z' },
    ],
  };
  const units = accountUnits(account, { monthlyCredits: 54600, cycle: 'year' });
  near(units.subscription, 43680 / 12 / 54600);
  assert.equal(units.purchase, 0.1);
  assert.equal(units.gift, 0);
  // 500×订阅价 + 100×0.10（余额 600 与批次合计一致）
  near(units.stockValue, 500 * (43680 / 12 / 54600) + 100 * 0.1, 1e-6);
});

test('已下架的团队套餐按同级个人会员单价估算并标记', () => {
  const account = { id: 't', scope: 'team_member', spaceId: 's1', membershipPlan: '高级团队会员', balance: 7700, creditBatches: [] };
  const units = accountUnits(account, { monthlyCredits: 7700, cycle: 'month' });
  assert.equal(units.team, true);
  assert.equal(units.estimated, true);
  near(units.subscription, 998 / 12320);
  // 在售的超级团队会员是实测价，不算估算
  const live = accountUnits({ id: 't2', scope: 'team_total', spaceId: 's2', membershipPlan: '超级团队会员', balance: 68250, creditBatches: [] }, { monthlyCredits: 68250 });
  assert.equal(live.estimated, false);
  near(live.subscription, 4550 / 68250);
});

test('拿不到价格的钱包不给金额，也不当成零', () => {
  const units = accountUnits({ id: 'x', scope: 'personal', membershipPlan: '无有效个人会员', balance: 80, creditBatches: [] }, {});
  assert.equal(units.subscription, null);
  assert.equal(units.average, null, '没有单价时平均价也是 null');
  assert.equal(units.stockValue, null, '未知不等于 0');
});

test('金额格式：大额不留小数，小额保留一位', () => {
  assert.equal(formatMoney(5260.4), '¥5,260');
  assert.equal(formatMoney(2.04), '¥2.0');
  assert.equal(formatMoney(null), '—');
});
