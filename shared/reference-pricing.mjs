// Reference prices are captured once by the server. They are not payment records.
export const PRICE_TABLE = {
  observedAt: '2026-09-17',
  source: '已核对套餐的续费参考价',
  purchasePerCredit: 0.1,
  plans: {
    基础会员: { monthlyCredits: 725, price: { month: 69, quarter: 188, year: 659 } },
    标准会员: { monthlyCredits: 2210, price: { month: 199, quarter: 568, year: 1899 } },
    高级会员: { monthlyCredits: 12320, price: { month: 998, quarter: 2798, year: 10398 } },
    超级会员: { monthlyCredits: 54600, price: { month: 4299, quarter: 11699, year: 43680 } },
  },
  teamPlans: { 超级团队会员: { monthlyCredits: 68250, price: { month: 6319 } } },
};
const MONTHS = { month: 1, quarter: 3, year: 12 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

export function referenceWalletKey(account) {
  if (account?.scope === 'personal' && account.platformUserId) return `personal:${account.platformUserId}`;
  if (['team_member', 'team_total'].includes(account?.scope) && account.spaceId) return `team:${account.spaceId}`;
  return null;
}

export function cycleFromBilling(billingCycle) {
  if (typeof billingCycle !== 'string') return null;
  if (Object.hasOwn(MONTHS, billingCycle)) return billingCycle;
  if (billingCycle.includes('年')) return 'year';
  if (billingCycle.includes('季')) return 'quarter';
  if (billingCycle.includes('月')) return 'month';
  return null;
}

/** Suggestions require explicit billing terms and never dynamically replace a saved rate. */
export function suggestReferenceRate(account) {
  const cycle = cycleFromBilling(account?.billingCycle);
  if (!referenceWalletKey(account) || !cycle || typeof account?.membershipPlan !== 'string') return null;
  const entries = account.scope === 'personal' ? PRICE_TABLE.plans : PRICE_TABLE.teamPlans;
  const plan = Object.keys(entries).find(name => account.membershipPlan.includes(name));
  const entry = entries[plan], price = entry?.price[cycle];
  return finite(price) && price > 0 && entry.monthlyCredits > 0
    ? price / MONTHS[cycle] / entry.monthlyCredits * 1000 : null;
}

/** Every readable credit amount has a labelled estimate, even without billing data.
 * The server freezes this choice once per wallet, so changing balances cannot
 * rewrite historical comparisons. These are reference values, never invoices.
 */
export function estimateReferenceRate(account) {
  const team = ['team_member', 'team_total'].includes(account?.scope);
  const entries = team ? PRICE_TABLE.teamPlans : PRICE_TABLE.plans;
  const planName = typeof account?.membershipPlan === 'string' ? Object.keys(entries).find(name => account.membershipPlan.includes(name)) : null;
  const cycle = cycleFromBilling(account?.billingCycle);
  const known = suggestReferenceRate(account);
  let perThousand, source, explanation;
  const cycleNames = { month: '月付', quarter: '季付', year: '年付' };
  if (finite(known)) {
    perThousand = known; source = 'platform_reference';
    explanation = `${planName} · ${cycleNames[cycle]}套餐参考价`;
  } else if (planName) {
    const plan = entries[planName];
    perThousand = plan.price.month / plan.monthlyCredits * 1000; source = 'plan_estimate';
    explanation = `${planName} · 按月付参考价估算`;
  } else if (team) {
    const comparable = PRICE_TABLE.teamPlans['超级团队会员'];
    perThousand = comparable.price.month / comparable.monthlyCredits * 1000; source = 'team_estimate';
    explanation = '按在售超级团队会员月付单价估算';
  } else {
    perThousand = PRICE_TABLE.purchasePerCredit * 1000; source = 'purchase_estimate';
    explanation = '按积分商城挂牌价 ¥0.10/分估算';
  }
  return { walletKey: referenceWalletKey(account), perThousand, source, explanation,
    priceObservedAt: PRICE_TABLE.observedAt, effectiveAt: '1970-01-01T00:00:00.000Z', basis: 'initial_reference' };
}

/** Select the immutable wallet reference in effect at the event time. */
export function resolveReferenceRate(account, rates = [], at = Date.now()) {
  const walletKey = referenceWalletKey(account), when = timestamp(at);
  if (!Number.isFinite(when)) return null;
  const candidates = rates.filter(rate => walletKey && rate?.walletKey === walletKey && finite(rate.perThousand) && rate.perThousand >= 0
    && Number.isFinite(timestamp(rate.effectiveAt)) && timestamp(rate.effectiveAt) <= when);
  candidates.sort((a, b) => timestamp(b.effectiveAt) - timestamp(a.effectiveAt)
    || (b.revision ?? 0) - (a.revision ?? 0)
    || (timestamp(b.createdAt) || 0) - (timestamp(a.createdAt) || 0) || String(b.id ?? '').localeCompare(String(a.id ?? '')));
  return candidates[0] ?? estimateReferenceRate(account);
}

/** kind:'gift' is supplied only when the source proves these credits were free. */
export function referenceValue(account, credits, rates = [], at = Date.now(), { kind = null } = {}) {
  if (!finite(credits)) return null;
  if (credits === 0 || kind === 'gift') return 0;
  const rate = resolveReferenceRate(account, rates, at);
  return rate ? credits * rate.perThousand / 1000 : null;
}
