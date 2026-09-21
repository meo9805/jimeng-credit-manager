/**
 * 积分折算人民币。
 *
 * 三条口径，不能混：
 *  - 订阅会员积分：花的是套餐钱。每分成本 = 套餐月费 ÷ 该账号每月实发的订阅积分。
 *  - 充值购买积分：积分商城固定档位，500 分 ¥50 … 4,500 分 ¥450，即每分 ¥0.10。
 *  - 每日登录/赠送积分：没有花钱，成本记 0，不参与金额。
 *
 * 价格取自即梦会员页与 /commerce/v1/subscription/price_list，一律用「续费原价」而不是首期优惠价，
 * 因为优惠只是首期，长期成本要按原价看。平台调价后需要更新这里的数字与 observedAt。
 */
export const PRICE_TABLE = {
  observedAt: '2026-09-17',
  source: '即梦会员页与订阅价格接口（取续费原价）',
  purchasePerCredit: 0.1,
  purchaseNote: '积分商城固定档位：500 分 ¥50、750 分 ¥75、1,500 分 ¥150、2,250 分 ¥225、4,500 分 ¥450',
  plans: {
    基础会员: { monthlyCredits: 725, price: { month: 69, quarter: 188, year: 659 } },
    标准会员: { monthlyCredits: 2210, price: { month: 199, quarter: 568, year: 1899 } },
    高级会员: { monthlyCredits: 12320, price: { month: 998, quarter: 2798, year: 10398 } },
    超级会员: { monthlyCredits: 54600, price: { month: 4299, quarter: 11699, year: 43680 } },
  },
  /**
   * 团队会员按席位计费。平台现在只在售「超级团队会员」（¥4,550/席位/月，68,250 分/席位/月，
   * 价格接口 scene=teams_default 可查）；我们实际用的是已下架的「高级团队会员」（7,700 分/席位/月），
   * 价格查不到，因此按同级个人会员的单价估算，并在界面上标出来。
   */
  teamPlans: {
    超级团队会员: { monthlyCredits: 68250, perSeatMonth: 4550, verified: true },
    高级团队会员: { monthlyCredits: 7700, proxyPlan: '高级会员', verified: false },
  },
};

const CYCLE_MONTHS = { month: 1, quarter: 3, year: 12 };
const CYCLE_LABEL = { month: '月付', quarter: '季付', year: '年付' };
export const cycleLabel = cycle => CYCLE_LABEL[cycle] || null;

/** 会员方案名 → 价目表里的套餐。团队会员价格另行处理，返回 null 表示只能按平均价估算。 */
export function planKey(membershipPlan) {
  if (typeof membershipPlan !== 'string') return null;
  for (const key of Object.keys(PRICE_TABLE.plans)) if (membershipPlan.includes(key)) return key;
  return null;
}

/** 平台告诉我们的是连续包年/包季/包月。 */
export function cycleFromBilling(billingCycle) {
  if (typeof billingCycle !== 'string') return null;
  if (billingCycle.includes('年')) return 'year';
  if (billingCycle.includes('季')) return 'quarter';
  if (billingCycle.includes('月')) return 'month';
  return null;
}

/**
 * 没有自动续费信息时，用「会员有效期 − 最近一次订阅积分发放日」推断周期。
 * 例：示例员工甲 2026-08-28 发放、2027-08-28 到期 → 12 个月 → 年付。
 */
export function cycleFromDates(membershipExpiresAt, lastGrantAt) {
  const end = Date.parse(membershipExpiresAt), start = Date.parse(lastGrantAt);
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return null;
  const months = (end - start) / (30.44 * 86_400_000);
  if (months >= 10.5) return 'year';
  if (months >= 2.5) return 'quarter';
  if (months >= 0.5) return 'month';
  return null;
}

/** 套餐每月要花多少钱（元）。 */
export function monthlyCost(plan, cycle, priceTable = PRICE_TABLE) {
  const entry = priceTable.plans[plan];
  if (!entry) return null;
  const key = entry.price[cycle] != null ? cycle : entry.price.month != null ? 'month' : null;
  if (!key) return null;
  return entry.price[key] / CYCLE_MONTHS[key];
}

/**
 * 一个钱包的每积分成本（元/分）。
 * monthlyCredits 用该账号实际每月领到的订阅积分，缺失时退回套餐标称值。
 */
export function subscriptionUnitPrice(plan, cycle, monthlyCredits, priceTable = PRICE_TABLE) {
  const cost = monthlyCost(plan, cycle, priceTable);
  const credits = Number.isFinite(monthlyCredits) && monthlyCredits > 0 ? monthlyCredits : priceTable.plans[plan]?.monthlyCredits;
  if (cost == null || !Number.isFinite(credits) || credits <= 0) return null;
  return cost / credits;
}

/**
 * 汇总一个账号的三类单价与库存价值。
 * subscription 可能为 null（套餐未知或没有发放记录），此时该部分按平均价估算。
 * 团队会员按席位计费，价格尚未确认，因此团队钱包不给单价，金额留空而不是猜。
 */
export function accountUnits(account, { monthlyCredits = null, cycle = null, priceTable = PRICE_TABLE } = {}) {
  const planName = typeof account?.membershipPlan === 'string' ? account.membershipPlan : '';
  const teamKey = Object.keys(priceTable.teamPlans).find(key => planName.includes(key)) || null;
  const team = Boolean(teamKey);
  const plan = team ? teamKey : planKey(account?.membershipPlan);
  const resolvedCycle = cycle || 'month';
  let subscription = null, estimated = false;
  let credits = Number.isFinite(monthlyCredits) && monthlyCredits > 0 ? monthlyCredits : null;
  if (team) {
    const teamPlan = priceTable.teamPlans[teamKey];
    credits = credits ?? teamPlan.monthlyCredits ?? null;
    if (Number.isFinite(teamPlan.perSeatMonth) && credits) subscription = teamPlan.perSeatMonth / credits;
    else if (teamPlan.proxyPlan && credits) {
      // 已下架套餐：平台是按“每积分单价”定价的（超级个人年付与超级团队都是 ¥0.0667/分），
      // 所以沿用同级个人会员的单价，而不是把个人套餐的钱除到团队席位的积分上。
      const proxy = subscriptionUnitPrice(teamPlan.proxyPlan, resolvedCycle, null, priceTable);
      subscription = proxy;
      estimated = proxy != null;
    }
  } else if (!team) {
    subscription = subscriptionUnitPrice(plan, resolvedCycle, credits, priceTable);
  }
  const unitFor = kind => kind === 'subscription' ? subscription : kind === 'purchase' ? priceTable.purchasePerCredit : kind === 'gift' ? 0 : null;
  const batches = Array.isArray(account?.creditBatches) ? account.creditBatches.filter(batch => Number.isFinite(batch?.amount) && batch.amount > 0) : [];
  let batchedCredits = 0, knownCredits = 0, knownValue = 0;
  for (const batch of batches) {
    const unit = unitFor(batch.kind);
    batchedCredits += batch.amount;
    if (unit != null) { knownCredits += batch.amount; knownValue += batch.amount * unit; }
  }
  const average = knownCredits > 0 ? knownValue / knownCredits : subscription ?? null;
  const balance = Number.isFinite(account?.balance) ? account.balance : null;
  let stockValue = knownValue;
  // 平台没给批次、或批次不完整时，缺的那部分按已算出的平均单价补齐，金额不至于凭空少一块。
  if (balance != null && average != null && balance > batchedCredits) stockValue += (balance - batchedCredits) * average;
  return {
    plan, cycle: resolvedCycle, team, estimated,
    monthlyCredits: credits ?? priceTable.plans[plan]?.monthlyCredits ?? null,
    subscription, purchase: priceTable.purchasePerCredit, gift: 0, average,
    stockValue: balance == null || average == null ? null : stockValue,
  };
}

/** 金额显示：大于 100 元不留小数，小额保留一位。 */
export function formatMoney(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
