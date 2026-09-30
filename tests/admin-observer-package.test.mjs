import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { unzipSync } from 'fflate';
import { adminObserverFiles, adminObserverZip } from '../server/admin-observer-package.mjs';
import { priceDraft, readPlatformPrices, syncPlatformPrices } from '../admin-extension/platform-prices.mjs';

const managementOrigin = 'http://127.0.0.1:4318';

test('administrator observer package includes only the local extension and no collector credentials', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'jmc-observer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = { manifest_version: 3, name: '观察版', version: '0.1.0', permissions: ['activeTab', 'scripting', 'storage'] };
  mkdirSync(path.join(directory, 'icons'));
  for (const name of adminObserverFiles) writeFileSync(path.join(directory, name), name === 'manifest.json' ? JSON.stringify(manifest) : 'test');
  writeFileSync(path.join(directory, 'private.db'), 'not-for-package');
  symlinkSync(path.join(directory, 'private.db'), path.join(directory, 'linked.txt'));
  writeFileSync(path.join(directory, 'provision.json'), '{"token":"not-for-package"}');
  const files = unzipSync(adminObserverZip(directory, managementOrigin));
  assert.deepEqual(Object.keys(files).sort(), [...adminObserverFiles,'management-origin.json'].sort());
  assert.equal(JSON.parse(new TextDecoder().decode(files['manifest.json'])).host_permissions, undefined);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files['management-origin.json'])), {origin:managementOrigin});
  assert.equal(files['provision.json'], undefined);
  assert.equal(files['private.db'], undefined);
});

test('administrator observer package rejects management-server permissions', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'jmc-observer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const extra of [
    { host_permissions: ['https://jimeng.jianying.com/*'] },
    { optional_host_permissions: ['http://*/*'] },
    { externally_connectable: { matches: ['<all_urls>'] } },
    { permissions: ['activeTab', 'scripting', 'webRequest'] },
    { background: { service_worker: 'background.mjs' } },
  ]) {
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, permissions: ['activeTab', 'scripting'], ...extra }));
    assert.throws(() => adminObserverZip(directory, managementOrigin), /权限不符合/);
  }
});

test('observer ZIP requires an exact management origin without a path or credentials', () => {
  for (const origin of ['https://example.test/path','https://user@example.test','javascript:alert(1)','https://example.test/']) {
    assert.throws(() => adminObserverZip('/unneeded', origin), /管理地址不合法/);
  }
});

test('manual price read requests only the two catalogues with environment app ID and exposes only product fields', async () => {
  const requests = [];
  const environmentKey = {toString:()=> 'environment-service'};
  const creditKey = {toString:()=> 'dreamina-credit-data-service'};
  const handlers=[];
  const source={create:()=>({
    interceptors:{request:{use:(fulfilled)=>handlers.push(fulfilled)}},
    post:async (path,body) => {
      let config={headers:{}};
      for (const handler of [...handlers].reverse()) config=handler(config);
      requests.push({path,body,headers:config.headers});
      const scene=body.scene;
      return {status:200,data:{ret:0,data:{vip_price_list:[
        {product_id:'free',level:'',total_amount:0},
        {
        product_id:`${scene}-monthly`,level:scene==='vip'?'ultra':'teams_super',
        subscribe_cycle:1,cycle_unit:'MONTH',total_amount:45500,
        origin_price_amount:50000,normal_amount:50000,currency_code:'CNY',
        price_type:'normal',member_limit:scene==='vip'?null:1,goods_type:'subscription',
        vip_benefit_package:{user_credit:{amount:scene==='vip'?6160:68250,description:'never-sent'}},
        account_token:'must-not-leak',login_user_id:'must-not-leak',
      }]}}};
    },
  }),interceptors:{request:{handlers:[{fulfilled:config=>{
    config.headers['X-Team-Id']='other-team';config.headers['X-Sign']='signed';return config;
  }}]}}};
  const repository={_networkClient:source,_getApi:path=>path};
  const result = await vm.runInNewContext(`(${readPlatformPrices.toString()})()`, {
    location:{origin:'https://jimeng.jianying.com'},
    window:{__debugger:{DreaminaCommercialFeatureService:{_containerService:{
      services:{entries:new Map([[environmentKey,{}],[creditKey,{}]])},
      invokeFunction:fn=>fn({get:key=>key===environmentKey?{appId:513695}:{_creditRepository:{__origin__:repository}}}),
    }}}},
    fetch:()=>{throw new Error('unsigned plain fetch must not run');},
  });
  assert.equal(result.ok,true);
  assert.deepEqual(requests.map(item=>item.body.scene),['vip','teams_default']);
  assert.ok(requests.every(item => item.path === '/commerce/v1/subscription/price_list' &&
    item.body.aid === 513695 && item.headers['X-Sign'] === 'signed' && !('X-Team-Id' in item.headers)));
  assert.ok(requests.every(item => Object.keys(item.body).sort().join(',') === 'aid,platform,region,scene'));
  assert.deepEqual(Array.from(result.products,item=>item.totalAmount),[45500,45500]);
  assert.deepEqual(Array.from(result.products,item=>item.monthlyCredits),[6160,68250]);
  assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
  assert.deepEqual(Object.keys(result.products[0]).sort(),[
    'scene','productId','level','subscribeCycle','cycleUnit','totalAmount',
    'originPriceAmount','normalAmount','currencyCode','priceType','memberLimit','monthlyCredits','goodsType',
  ].sort());
});

test('price draft removes extra page fields and rejects incomplete catalogues', () => {
  const raw={observedAt:new Date().toISOString(),products:[
    {scene:'vip',productId:'personal-monthly',level:'ultra',totalAmount:4500,accountId:'not-sent'},
    {scene:'teams_default',productId:'team-monthly',level:'teams_super',totalAmount:455000,token:'not-sent'},
  ],loginUserId:'not-sent'};
  const draft=priceDraft(raw);
  assert.equal(draft.products.length,2);
  assert.equal(JSON.stringify(draft).includes('not-sent'),false);
  assert.equal(priceDraft({...raw,products:raw.products.slice(0,1)}),null);
  assert.equal(priceDraft({...raw,observedAt:'bad-date'}),null);
  assert.equal(priceDraft({...raw,observedAt:new Date(Date.now()-7_200_000).toISOString()}),null);
});

test('manual sync only posts from the matching management tab using its same-origin session', async () => {
  const calls=[];
  const payload={observedAt:new Date().toISOString(),products:[]};
  const context={location:{origin:'https://different.test'},fetch:async (...args)=>{calls.push(args);return {ok:true};},AbortSignal};
  let result=await vm.runInNewContext(`(${syncPlatformPrices.toString()})(payload,expectedOrigin)`,{...context,payload,expectedOrigin:managementOrigin});
  assert.equal(result.ok,false);assert.equal(calls.length,0);
  context.location.origin=managementOrigin;
  result=await vm.runInNewContext(`(${syncPlatformPrices.toString()})(payload,expectedOrigin)`,{...context,payload,expectedOrigin:managementOrigin});
  assert.equal(result.ok,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/api/admin/platform-prices');
  assert.equal(calls[0][1].credentials,'same-origin');
  assert.deepEqual(JSON.parse(calls[0][1].body),payload);
});
