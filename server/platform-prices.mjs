import { randomUUID } from 'node:crypto';
import { fail, hash, iso, shape } from './domain.mjs';
import { PRICE_TABLE, referenceWalletKey } from '../shared/reference-pricing.mjs';

const PRODUCT_FIELDS = ['scene', 'productId', 'level', 'subscribeCycle', 'cycleUnit', 'totalAmount',
  'originPriceAmount', 'normalAmount', 'currencyCode', 'priceType', 'memberLimit', 'goodsType', 'monthlyCredits'];
const SCENES = new Set(['vip', 'teams_default']);
const CENT_FIELDS = ['totalAmount', 'originPriceAmount', 'normalAmount'];
const TEXT_FIELDS = ['productId', 'level', 'cycleUnit', 'currencyCode', 'priceType', 'goodsType'];
const PLAN_LEVELS = {
  standard:'基础会员', artisan:'标准会员', maestro:'高级会员', ultra:'超级会员',
  teams_super:'超级团队会员', teams:'高级团队会员',
};
// The currently listed checkout amount is the price the administrator read.
// Renewal/original amounts are fallback metadata, not a replacement for it.
const referenceCents = product => product.totalAmount > 0 ? product.totalAmount
  : product.normalAmount > 0 ? product.normalAmount : product.originPriceAmount > 0 ? product.originPriceAmount : null;

function optionalText(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 80 || !value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) || /https?:\/\/|(?:cookie|token|session|password|authorization|authkey)\s*[:=]/i.test(value)) fail(`${label}格式不正确`);
  return value.trim();
}
function optionalInteger(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) fail(`${label}必须是非负整数`);
  return value;
}

/** The admin observer submits a whole, account-free catalogue in cents. */
export function validatePlatformPrices(input, now) {
  shape(input, ['observedAt','products'], '平台标价');
  const observedAt = iso(input.observedAt, '标价读取时间', now);
  if (!Array.isArray(input.products) || input.products.length < 2 || input.products.length > 400) fail('标价商品数量不正确');
  const counts = { vip:0, teams_default:0 };
  const paidCounts = { vip:0, teams_default:0 };
  const products = input.products.map(item => {
    shape(item, PRODUCT_FIELDS, '标价商品');
    if (!SCENES.has(item.scene)) fail('标价场景不正确');
    if (++counts[item.scene] > 200) fail('单个标价场景最多 200 项');
    const product = {scene:item.scene};
    for (const key of TEXT_FIELDS) product[key] = optionalText(item[key], key);
    for (const key of [...CENT_FIELDS,'subscribeCycle','memberLimit','monthlyCredits']) product[key] = optionalInteger(item[key], key);
    if (!product.productId && !product.level) fail('标价商品缺少商品 ID 与等级');
    if (product.currencyCode && !/^[A-Z]{3}$/.test(product.currencyCode)) fail('标价币种不正确');
    if (referenceCents(product) && (!product.currencyCode || product.currencyCode === 'CNY')) paidCounts[item.scene]++;
    return product;
  });
  if (!counts.vip || !counts.teams_default) fail('个人和团队标价必须一起读取');
  if (!paidCounts.vip || !paidCounts.teams_default) fail('个人和团队标价均需包含付费商品');
  // Stable ordering makes a repeated reading of the same displayed prices idempotent.
  products.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {observedAt,products};
}

function planFromLevel(level) {
  if (typeof level !== 'string') return null;
  const normalized = level.trim().toLowerCase();
  return PLAN_LEVELS[normalized] ?? Object.values(PLAN_LEVELS).find(name => name === level) ?? null;
}
function planFromAccount(account) {
  const name = account?.membershipPlan;
  if (typeof name !== 'string') return null;
  const names = account.scope === 'personal' ? Object.keys(PRICE_TABLE.plans) : ['超级团队会员','高级团队会员'];
  return names.find(plan => name.includes(plan)) ?? null;
}
function months(cycle, unit) {
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 12 || typeof unit !== 'string') return null;
  const kind = unit.trim().toLowerCase();
  if (['month','months'].includes(kind)) return cycle;
  if (['quarter','quarters'].includes(kind)) return cycle * 3;
  if (['year','years'].includes(kind)) return cycle * 12;
  return null;
}
const uniqueBy = (items,key) => {
  const values = new Set(items.map(key));
  return values.size === 1 ? items[0] : null;
};

/** Price is a displayed offer, not an employee payment or invoice. */
export function referenceFromCatalog(account, facts, catalog, walletMonthlyCredits = null) {
  if (!referenceWalletKey(account) || !catalog?.products?.length) return null;
  const scene = account.scope === 'personal' ? 'vip' : 'teams_default';
  const latestReadAt = facts[0]?.readAt;
  const recent = latestReadAt ? facts.filter(fact => fact.readAt === latestReadAt) : [];
  // Conflicting simultaneous team reads must not select another member's plan.
  const fact = recent.length ? uniqueBy(recent, item => JSON.stringify([item.active,item.planLevel,item.productId,item.subscribeCycle,item.cycleUnit])) : null;
  const observedMembershipAt = account.subscriptionObservedAt;
  const freshFact = fact && (!observedMembershipAt || Date.parse(fact.readAt) + 300_000 >= Date.parse(observedMembershipAt)) ? fact : null;
  if (freshFact?.active === false) return null;
  const accountPlan = planFromAccount(account), factPlan = planFromLevel(freshFact?.planLevel);
  if (accountPlan && factPlan && accountPlan !== factPlan) return null;
  const plan = accountPlan ?? factPlan;
  if (!plan) return null;
  const factCycle = months(freshFact?.subscribeCycle, freshFact?.cycleUnit);
  // billingCycle describes the next auto-renewal choice. It can differ from
  // the current subscription, so price the observed SKU/cycle instead.
  const eligible = catalog.products.filter(item => item.scene === scene && (!item.currencyCode || item.currencyCode === 'CNY')
    && referenceCents(item) && item.monthlyCredits > 0);
  let candidates = freshFact?.productId ? eligible.filter(item => item.productId === freshFact.productId
    && (!item.level || planFromLevel(item.level) === plan)
    && (!factCycle || months(item.subscribeCycle,item.cycleUnit) === factCycle)) : [];
  let matchBasis = 'product_id';
  if (!candidates.length && !freshFact?.productId && factCycle) {
    // Different subscription tiers can share the same level and billing
    // period. A recent, explicitly identified membership grant is required.
    if (Number.isSafeInteger(walletMonthlyCredits) && walletMonthlyCredits > 0) {
      candidates = eligible.filter(item => planFromLevel(item.level) === plan &&
        months(item.subscribeCycle,item.cycleUnit) === factCycle && item.monthlyCredits === walletMonthlyCredits);
    }
    matchBasis = 'plan_cycle_credits';
  }
  if (!candidates.length) return null;
  // Multiple prices for the same plan/cycle (promotion, renewal or seat variant)
  // are ambiguous unless every matching offer computes the same unit value.
  const rates = candidates.map(item => {
    const duration = months(item.subscribeCycle,item.cycleUnit);
    if (!duration || ![1,3,12].includes(duration)) return null;
    // Team goods are priced for memberLimit seats; the known credit base is per seat.
    const seats = scene === 'teams_default' ? item.memberLimit : 1;
    if (!Number.isSafeInteger(seats) || seats < 1) return null;
    return referenceCents(item) / 100 / seats / duration / item.monthlyCredits * 1000;
  });
  if (rates.some(rate => rate === null || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000)) return null;
  const rounded = new Set(rates.map(rate => rate.toFixed(8)));
  if (rounded.size !== 1) return null;
  const product = candidates[0];
  return {perThousand:rates[0],source:'platform_catalog',priceObservedAt:catalog.observedAt,
    catalogVersion:catalog.version,productId:product.productId,matchBasis,
    explanation:`${plan} · 平台标价参考`};
}

export function createPlatformPrices(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_price_catalogs (
    version INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, catalog_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL, received_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, data TEXT NOT NULL
  );`);
  const latest = () => {
    const row = db.prepare('SELECT version,observed_at,last_observed_at,data FROM platform_price_catalogs ORDER BY version DESC LIMIT 1').get();
    return row ? {version:row.version,observedAt:row.observed_at,lastObservedAt:row.last_observed_at,products:JSON.parse(row.data)} : null;
  };
  const save = validated => {
    const catalogHash = hash(JSON.stringify(validated.products));
    const previous = db.prepare('SELECT version,catalog_hash,last_observed_at FROM platform_price_catalogs ORDER BY version DESC LIMIT 1').get();
    if (previous && validated.observedAt < previous.last_observed_at && previous.catalog_hash !== catalogHash) fail('标价读取时间早于当前目录',409);
    if (previous?.catalog_hash === catalogHash) {
      if (previous.last_observed_at < validated.observedAt) db.prepare('UPDATE platform_price_catalogs SET last_observed_at=? WHERE version=?').run(validated.observedAt,previous.version);
      return {...latest(),changed:false};
    }
    db.prepare('INSERT INTO platform_price_catalogs(id,catalog_hash,observed_at,received_at,last_observed_at,data) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(),catalogHash,validated.observedAt,now(),validated.observedAt,JSON.stringify(validated.products));
    return {...latest(),changed:true};
  };
  return {latest,save};
}
