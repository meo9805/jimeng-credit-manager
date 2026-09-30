import { PRICE_TABLE, cycleFromBilling, referenceValue, resolveReferenceRate } from '../shared/reference-pricing.mjs';
export { PRICE_TABLE, cycleFromBilling };

const CYCLE_MONTHS = { month: 1, quarter: 3, year: 12 };
const CYCLE_LABEL = { month: '月付', quarter: '季付', year: '年付' };
export const cycleLabel = cycle => CYCLE_LABEL[cycle] || null;

export function planKey(membershipPlan) {
  if (typeof membershipPlan !== 'string') return null;
  return Object.keys(PRICE_TABLE.plans).find(key => membershipPlan.includes(key)) ?? null;
}

export function monthlyCost(plan, cycle, priceTable = PRICE_TABLE) {
  const price = priceTable.plans[plan]?.price[cycle];
  return Number.isFinite(price) && CYCLE_MONTHS[cycle] ? price / CYCLE_MONTHS[cycle] : null;
}

export function subscriptionUnitPrice(plan, cycle, monthlyCredits, priceTable = PRICE_TABLE) {
  const cost = monthlyCost(plan, cycle, priceTable);
  const credits = Number.isFinite(monthlyCredits) && monthlyCredits > 0 ? monthlyCredits : priceTable.plans[plan]?.monthlyCredits;
  return cost != null && Number.isFinite(credits) && credits > 0 ? cost / credits : null;
}

/** Current stock can prove gift batches; historical spending never uses this stock mix. */
export function accountUnits(account, { rates = [], at = Date.now() } = {}) {
  const rate = resolveReferenceRate(account, rates, at);
  const unit = rate ? rate.perThousand / 1000 : null;
  const balance = Number.isFinite(account?.balance) && account.balance >= 0 ? account.balance : null;
  const batches = (Array.isArray(account?.creditBatches) ? account.creditBatches : [])
    .filter(batch => Number.isFinite(batch?.amount) && batch.amount > 0);
  const total = batches.reduce((sum, batch) => sum + batch.amount, 0);
  // Conflicting batches cannot prove that more credits are free than the balance.
  const gifts = balance != null && total <= balance
    ? batches.filter(batch => batch.kind === 'gift').reduce((sum, batch) => sum + batch.amount, 0) : 0;
  const chargeable = balance == null ? null : balance - gifts;
  const value = referenceValue(account, chargeable, rates, at);
  return {
    plan: planKey(account?.membershipPlan), cycle: cycleFromBilling(account?.billingCycle),
    team: ['team_total', 'team_member'].includes(account?.scope), estimated: true,
    subscription: unit, purchase: unit, gift: 0, average: unit,
    stockValue: balance == null ? null : value == null ? (gifts > 0 ? 0 : null) : value,
    stockUnpricedCredits: value == null && chargeable > 0 ? chargeable : 0,
    referenceRate: rate,
  };
}

/** 金额显示：大于 100 元不留小数，小额保留一位。 */
export function formatMoney(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
