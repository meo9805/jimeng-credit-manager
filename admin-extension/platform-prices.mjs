// These functions are invoked only after an administrator clicks the matching
// button. The page reader is serialized into Jimeng's MAIN world; keep it
// self-contained and return only public catalogue fields.
export async function readPlatformPrices() {
  if (location.origin !== 'https://jimeng.jianying.com') return {ok:false,reason:'not_jimeng_page'};
  const feature = window.__debugger?.DreaminaCommercialFeatureService;
  const root = feature?._containerService;
  if (!root?.invokeFunction) return {ok:false,reason:'page_not_ready'};
  const resolve = name => {
    for (let container = root; container; container = container._parent) {
      const key = [...container.services.entries].find(([candidate]) => String(candidate) === name)?.[0];
      if (key) return root.invokeFunction(accessor => accessor.get(key));
    }
    return null;
  };
  let aid, client, priceUrl;
  try {
    aid = Number(resolve('environment-service')?.appId);
    const repository = resolve('dreamina-credit-data-service')?._creditRepository?.__origin__;
    const source = repository?._networkClient;
    if (!Number.isSafeInteger(aid) || aid <= 0 || !source?.create || !repository?._getApi ||
        !Array.isArray(source.interceptors?.request?.handlers)) throw new Error('page not ready');
    // Use the site's own request signing on a private client. The added
    // interceptor removes a selected team's header only on this client.
    client = source.create();
    client.interceptors.request.use(config => {
      config.headers ||= {};
      for (const key of Object.keys(config.headers)) if (key.toLowerCase() === 'x-team-id') delete config.headers[key];
      return config;
    });
    for (const handler of source.interceptors.request.handlers) if (handler) {
      client.interceptors.request.use(handler.fulfilled,handler.rejected,
        {synchronous:handler.synchronous,runWhen:handler.runWhen});
    }
    priceUrl = repository._getApi('/commerce/v1/subscription/price_list');
  } catch { return {ok:false,reason:'page_not_ready'}; }

  const string = value => (typeof value === 'string' || Number.isSafeInteger(value)) &&
    String(value).length <= 80 && /^[\w.:-]+$/.test(String(value)) ? String(value) : null;
  const amount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
  const scenes = ['vip', 'teams_default'];
  const products = [];
  for (const scene of scenes) {
    let response;
    try {
      response = await client.post(priceUrl,{aid,region:'cn',platform:7,scene},{timeout:10000});
    } catch { return {ok:false,reason:'price_api_unavailable'}; }
    const data = response?.data;
    if (response?.status !== 200) return {ok:false,reason:'price_api_unavailable'};
    if (String(data?.ret) !== '0') return {ok:false,reason:'price_api_unavailable'};
    const list = data?.data?.vip_price_list || data?.data?.price_list;
    if (!Array.isArray(list) || list.length === 0 || list.length > 200) return {ok:false,reason:'price_api_unavailable'};
    let paid = 0;
    for (const item of list) {
      const product = {
        scene,
        productId:string(item?.product_id), level:string(item?.level),
        subscribeCycle:count(item?.subscribe_cycle), cycleUnit:string(item?.cycle_unit),
        totalAmount:amount(item?.total_amount), originPriceAmount:amount(item?.origin_price_amount),
        normalAmount:amount(item?.normal_amount), currencyCode:string(item?.currency_code),
        priceType:string(item?.price_type), memberLimit:count(item?.member_limit),
        monthlyCredits:amount(item?.vip_benefit_package?.user_credit?.amount),
        goodsType:string(item?.goods_type),
      };
      if (product.totalAmount === 0) continue; // Free offers are not a price reference.
      if (!product.productId || !product.level || product.totalAmount === null) return {ok:false,reason:'price_fields_missing'};
      products.push(product);
      paid++;
    }
    if (!paid) return {ok:false,reason:'price_api_unavailable'};
  }
  return {ok:true,observedAt:new Date().toISOString(),products};
}

const productKeys = [
  'scene','productId','level','subscribeCycle','cycleUnit','totalAmount',
  'originPriceAmount','normalAmount','currencyCode','priceType','memberLimit','monthlyCredits','goodsType',
];

// Revalidate data after it has crossed extension storage. Extra fields are
// discarded so login/account/credit/ledger data can never reach the admin API.
export function priceDraft(raw) {
  const observedAt = typeof raw?.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.observedAt) ? Date.parse(raw.observedAt) : NaN;
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 300_000 || Date.now() - observedAt > 3_600_000 ||
      !Array.isArray(raw.products) || raw.products.length < 2 || raw.products.length > 400) return null;
  const products = raw.products.map(item => Object.fromEntries(productKeys.map(key => [key,item?.[key] ?? null])));
  if (!['vip','teams_default'].every(scene => products.some(item => item.scene === scene) &&
      products.filter(item => item.scene === scene).length <= 200)) return null;
  if (products.some(item => !['vip','teams_default'].includes(item.scene) ||
      typeof item.productId !== 'string' || !/^[\w.:-]{1,80}$/.test(item.productId) ||
      typeof item.level !== 'string' || !/^[\w.:-]{1,80}$/.test(item.level) ||
      !Number.isSafeInteger(item.totalAmount) || item.totalAmount < 0 || item.totalAmount > 1_000_000_000 ||
      !['subscribeCycle','memberLimit'].every(key => item[key] === null ||
        (Number.isSafeInteger(item[key]) && item[key] >= 0 && item[key] <= 100_000)) ||
      !['originPriceAmount','normalAmount','monthlyCredits'].every(key => item[key] === null ||
        (Number.isSafeInteger(item[key]) && item[key] >= 0 && item[key] <= 1_000_000_000)) ||
      !['cycleUnit','currencyCode','priceType','goodsType'].every(key => item[key] === null ||
        (typeof item[key] === 'string' && /^[\w.:-]{1,80}$/.test(item[key]))))) return null;
  return {observedAt:new Date(raw.observedAt).toISOString(),products};
}

// Runs in the selected management tab, so its existing admin cookie is sent
// by a same-origin request. Never accepts a remote URL or raw page response.
export async function syncPlatformPrices(payload, expectedOrigin) {
  if (location.origin !== expectedOrigin || !/^https?:\/\//.test(expectedOrigin)) return {ok:false,reason:'wrong_management_tab'};
  try {
    const response = await fetch('/api/admin/platform-prices', {
      method:'POST', credentials:'same-origin', redirect:'error',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload),
      signal:AbortSignal.timeout(10000),
    });
    if (response.status === 401 || response.status === 403) return {ok:false,reason:'admin_login_required'};
    return response.ok ? {ok:true} : {ok:false,reason:'admin_rejected'};
  } catch { return {ok:false,reason:'admin_unavailable'}; }
}
