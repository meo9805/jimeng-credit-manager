import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { validateIngest } from '../server/domain.mjs';
import { referenceValue } from '../shared/reference-pricing.mjs';
import { validatePlatformPrices } from '../server/platform-prices.mjs';

const START=Date.parse('2026-09-23T02:00:00.000Z');
const stamp=at=>new Date(at).toISOString();
const product=(scene,productId,level,subscribeCycle,cycleUnit,totalAmount,extra={})=>({
  scene,productId,level,subscribeCycle,cycleUnit,totalAmount,originPriceAmount:null,
  normalAmount:null,currencyCode:'CNY',priceType:null,memberLimit:null,goodsType:null,
  monthlyCredits:level==='ultra'?54_600:level==='teams_super'?68_250:level==='maestro'?12_320:null,...extra,
});
const products=(annualCents=4_368_000)=>[
  product('vip','ultra-year','ultra',1,'YEAR',annualCents),
  product('teams_default','team-month','teams_super',1,'MONTH',631_900,{memberLimit:1}),
];
const catalog=(at,items=products())=>validatePlatformPrices({observedAt:stamp(at),products:items},at);
const account=(extra={})=>({platformUserId:'u1',scope:'personal',spaceId:'personal',balance:54_600,
  membershipPlan:'超级会员',billingCycle:'连续包年',subscriptionObservedAt:stamp(START-60_000),...extra});
const subscription=(extra={})=>({spaceType:'personal',loginUserId:'u1',teamId:null,readAt:stamp(START-60_000),
  active:true,planLevel:'ultra',productId:'ultra-year',subscribeCycle:1,cycleUnit:'YEAR',
  startTime:null,endTime:null,nextRenewalTime:null,...extra});

function fixture(t) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-platform-prices-'));
  let at=START,store=createStore({dataDir,secret:'price-test-only',clock:()=>at});
  const department=store.createDepartment({name:'部门'}),employee=store.createEmployee({name:'员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  const ingest=(wallet=account(),facts=[subscription()])=>store.ingest(device,validateIngest({
    observedAt:stamp(at),status:'ok',accounts:[{...wallet,lastSyncedAt:stamp(at)}],transactions:[],subscriptionFacts:facts,
  },at));
  return {dataDir,device,get store(){return store;},setTime(value){at=value;},ingest,
    restart(){store.close();store=createStore({dataDir,secret:'price-test-only',clock:()=>at});}};
}

test('a complete administrator catalogue is bounded and contains only approved price fields',()=>{
  const valid=catalog(START);
  assert.deepEqual(new Set(valid.products.map(item=>item.scene)),new Set(['vip','teams_default']));
  assert.throws(()=>validatePlatformPrices({observedAt:stamp(START),products:[products()[0]]},START),/标价商品数量|个人和团队/);
  assert.throws(()=>catalog(START,[products()[0],product('teams_default','bad','teams_super',1,'MONTH',-1)]),/非负整数/);
  assert.throws(()=>catalog(START,[products()[0],{...products()[1],authkey:'secret'}]),/不支持的字段/);
  assert.throws(()=>catalog(START,[products()[0],{...products()[1],productId:'https://example.com/secret'}]),/格式不正确/);
  assert.throws(()=>catalog(START,[product('vip','free','ultra',1,'MONTH',0),products()[1]]),/付费商品/);
  assert.equal(catalog(START,[...products(),{...products()[1],productId:'other-currency',currencyCode:'USD'}]).products.length,3,
    'non-CNY offers may be retained but cannot be used as yuan estimates');
});

test('the price read at checkout is used and a team bundle is divided by seats',t=>{
  const f=fixture(t);
  const teamWallet={platformUserId:'u1',scope:'team_total',spaceId:'team-1',balance:136_500,
    membershipPlan:'超级团队会员',billingCycle:'连续包月',subscriptionObservedAt:stamp(START-60_000)};
  const teamFact={...subscription(),spaceType:'team',teamId:'team-1',planLevel:'teams_super',
    productId:'team-bundle',subscribeCycle:1,cycleUnit:'MONTH'};
  f.ingest(teamWallet,[teamFact]);
  f.setTime(START+60_000);
  const items=[product('vip','ultra-year','ultra',12,'MONTH',39_300,{normalAmount:65_900}),
    product('teams_default','team-bundle','teams_super',1,'MONTH',900_000,{normalAmount:1_400_000,memberLimit:2})];
  // The personal offer is only a catalogue completeness entry here.
  const result=f.store.setPlatformPrices(catalog(START+60_000,items));
  assert.equal(result.revisedWallets,1);
  const rate=f.store.dashboard().referenceRates.find(row=>row.walletKey==='team:team-1'&&row.source==='platform_catalog');
  assert.ok(Math.abs(rate.perThousand-(4500/68250*1000))<1e-8);
});

test('advanced team price uses its own monthly credit tier and per-seat catalogue amount',t=>{
  const f=fixture(t);
  const wallet={platformUserId:'u1',scope:'team_total',spaceId:'team-advanced',balance:15_400,
    membershipPlan:'高级团队会员',billingCycle:'连续包月',subscriptionObservedAt:stamp(START-60_000)};
  const fact={...subscription(),spaceType:'team',teamId:'team-advanced',planLevel:'teams',
    productId:'team-two-seats',subscribeCycle:1,cycleUnit:'MONTH'};
  f.ingest(wallet,[fact]);f.setTime(START+60_000);
  const items=[products()[0],product('teams_default','team-two-seats','teams',1,'MONTH',146_000,
    {normalAmount:146_000,memberLimit:2,monthlyCredits:7_700})];
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000,items)).revisedWallets,1);
  const rate=f.store.dashboard().referenceRates.find(row=>row.walletKey==='team:team-advanced'&&row.source==='platform_catalog');
  assert.ok(Math.abs(rate.perThousand-(730/7_700*1000))<1e-8);
});

test('same plan and billing cycle use a recent grant to distinguish credit tiers',t=>{
  const f=fixture(t);
  const maestro=account({membershipPlan:'高级会员',billingCycle:'连续包月',subscriptionObservedAt:stamp(START-60_000)});
  f.store.ingest(f.device,
    validateIngest({observedAt:stamp(START),status:'ok',accounts:[{...maestro,lastSyncedAt:stamp(START)}],
      transactions:[{platformUserId:'u1',scope:'personal',spaceId:'personal',eventId:'monthly-grant',
        occurredAt:stamp(START-3600_000),kind:'grant',amount:18_480,description:'会员积分'}],
      subscriptionFacts:[subscription({planLevel:'maestro',productId:null,subscribeCycle:1,cycleUnit:'MONTH'})]},START));
  f.setTime(START+60_000);
  const offers=[product('vip','maestro-one','maestro',1,'MONTH',99_800,{monthlyCredits:12_320}),
    product('vip','maestro-two','maestro',1,'MONTH',149_800,{monthlyCredits:18_480}),products()[1]];
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000,offers)).revisedWallets,1);
  const rate=f.store.dashboard().referenceRates.at(-1);
  assert.equal(rate.matchBasis,'plan_cycle_credits');
  assert.equal(rate.productId,'maestro-two');
  assert.ok(Math.abs(rate.perThousand-(1498/18_480*1000))<1e-8);
});

test('a discounted personal offer uses its currently listed amount for reference conversion',t=>{
  const f=fixture(t);f.ingest();f.setTime(START+60_000);
  const items=[product('vip','ultra-year','ultra',12,'MONTH',3_930_000,{normalAmount:5_000_000,originPriceAmount:4_800_000}),products()[1]];
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000,items)).revisedWallets,1);
  const rate=f.store.dashboard().referenceRates.at(-1);
  assert.ok(Math.abs(rate.perThousand-(39_300/12/54_600*1000))<1e-8);
});

test('a known subscription SKU never borrows the price of a different SKU',t=>{
  const f=fixture(t);
  f.ingest(account({membershipPlan:'高级会员',billingCycle:'连续包月'}),
    [subscription({planLevel:'maestro',productId:'purchased-legacy-sku',subscribeCycle:1,cycleUnit:'MONTH'})]);
  f.setTime(START+60_000);
  const items=[product('vip','different-new-sku','maestro',1,'MONTH',149_800,{monthlyCredits:18_480}),products()[1]];
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000,items)).revisedWallets,0);
  assert.notEqual(f.store.dashboard().referenceRates.at(-1).source,'platform_catalog');
});

test('current subscription SKU wins when the next renewal period differs',t=>{
  const f=fixture(t);
  f.ingest(account({billingCycle:'连续包月'}),[subscription({subscribeCycle:1,cycleUnit:'YEAR'})]);
  f.setTime(START+60_000);
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000)).revisedWallets,1);
  assert.ok(Math.abs(f.store.dashboard().referenceRates.at(-1).perThousand-(43_680/12/54_600*1000))<1e-8);
  f.setTime(START+120_000);
  assert.equal(f.store.setPlatformPrices(catalog(START+120_000,products(5_000_000))).revisedWallets,1);
  const rate=f.store.dashboard().referenceRates.at(-1);
  assert.equal(rate.productId,'ultra-year');
  assert.ok(Math.abs(rate.perThousand-(50_000/12/54_600*1000))<1e-8);
});

test('exact product price versions affect only future estimates and survive restart',t=>{
  const f=fixture(t);f.ingest();
  const before=f.store.dashboard(),initial=before.referenceRates.at(-1);
  assert.equal(initial.source,'platform_reference');
  f.setTime(START+60_000);
  const uploaded=f.store.setPlatformPrices(catalog(START));
  assert.equal(uploaded.version,1);assert.equal(uploaded.revisedWallets,0,'unchanged listed price does not create a redundant rate');
  const same=f.store.setPlatformPrices(catalog(START+30_000,[...products()].reverse()));
  assert.equal(same.version,1);assert.equal(same.changed,false);
  assert.throws(()=>f.store.setPlatformPrices(catalog(START-30_000,products(5_000_000))),/早于当前目录/,
    'an older tab may not overwrite a newer observed catalogue');
  f.setTime(START+120_000);
  const changed=f.store.setPlatformPrices(catalog(START+90_000,products(5_000_000)));
  assert.equal(changed.version,2);assert.equal(changed.revisedWallets,1);
  const rates=f.store.dashboard().referenceRates,oldValue=referenceValue(before.accounts[0],1000,rates,START);
  assert.equal(rates.at(-1).source,'platform_catalog');
  assert.equal(rates.at(-1).productId,'ultra-year');
  assert.equal(rates.at(-1).matchBasis,'product_id');
  assert.equal(rates.at(-1).effectiveAt,stamp(START+120_000));
  assert.ok(Math.abs(oldValue-(43680/12/54600*1000))<1e-8);
  assert.ok(Math.abs(referenceValue(before.accounts[0],1000,rates,START+120_000)-(50000/12/54600*1000))<1e-8);
  f.restart();
  assert.equal(f.store.getPlatformPrices().version,2);
  assert.equal(f.store.dashboard().referenceRates.length,2);
});

test('ambiguous plan/cycle offers keep the existing estimate until a matching product ID is observed',t=>{
  const f=fixture(t);f.ingest(account(),[]);
  f.setTime(START+60_000);
  const items=[...products(),product('vip','ultra-year-special','ultra',1,'YEAR',3_900_000)];
  assert.equal(f.store.setPlatformPrices(catalog(START+60_000,items)).revisedWallets,0);
  assert.equal(f.store.dashboard().referenceRates.at(-1).source,'platform_reference');
  f.setTime(START+120_000);
  f.ingest(account({subscriptionObservedAt:stamp(START+120_000)}),[subscription({readAt:stamp(START+120_000),productId:'ultra-year-special'})]);
  const newest=f.store.dashboard().referenceRates.at(-1);
  assert.equal(newest.source,'platform_catalog');assert.equal(newest.productId,'ultra-year-special');
});

test('manual wallet rate stays authoritative after platform price changes',t=>{
  const f=fixture(t);f.ingest();
  f.setTime(START+60_000);
  const override=f.store.setReferenceRate({walletKey:'personal:u1',perThousand:100});
  assert.equal(override.source,'manual');
  f.setTime(START+120_000);
  assert.equal(f.store.setPlatformPrices(catalog(START+120_000,products(5_000_000))).revisedWallets,0);
  assert.equal(f.store.dashboard().referenceRates.at(-1).perThousand,100);
});

test('catalog upload requires an administrator session and same-origin management page',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-platform-price-api-'));
  const app=createApp({dataDir,clock:()=>START}),origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const body=JSON.stringify({observedAt:stamp(START),products:products()});
  const post=(headers={})=>fetch(`${origin}/api/admin/platform-prices`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
  assert.equal((await post({Origin:origin})).status,401);
  const secret=readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim();
  const login=await fetch(`${origin}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({secret})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post({Cookie:cookie})).status,403);
  assert.equal((await post({Cookie:cookie,Origin:'http://evil.example'})).status,403);
  const accepted=await post({Cookie:cookie,Origin:origin});
  assert.equal(accepted.status,200);assert.equal((await accepted.json()).version,1);
  const listed=await fetch(`${origin}/api/admin/platform-prices`,{headers:{Cookie:cookie}});
  assert.equal((await listed.json()).catalog.products.length,2);
  const oversize=await fetch(`${origin}/api/admin/platform-prices`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'x'.repeat(513*1024)});
  assert.equal(oversize.status,413);
});
