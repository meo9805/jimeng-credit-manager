import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.mjs';
import {uploadPlatformPrices} from '../scripts/upload-platform-prices.mjs';

const payload=()=>({observedAt:new Date().toISOString(),products:[
  {scene:'vip',productId:'personal-month',level:'ultra',subscribeCycle:1,cycleUnit:'MONTH',totalAmount:9900,
    originPriceAmount:null,normalAmount:null,currencyCode:'CNY',priceType:null,memberLimit:null,goodsType:null,monthlyCredits:5000},
  {scene:'teams_default',productId:'team-month',level:'teams_super',subscribeCycle:1,cycleUnit:'MONTH',totalAmount:19900,
    originPriceAmount:null,normalAmount:null,currencyCode:'CNY',priceType:null,memberLimit:2,goodsType:null,monthlyCredits:7000},
]});

test('daily uploader syncs an account-free catalogue using a short-lived admin session',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-daily-price-'));
  const app=createApp({dataDir}),origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const secret=readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim();
  let sessionCookie;
  const request=async (url,options)=>{
    const response=await fetch(url,options);
    if(url.endsWith('/api/admin/login'))sessionCookie=response.headers.get('set-cookie')?.split(';')[0];
    return response;
  };
  const first=await uploadPlatformPrices({origin,secret,payload:payload(),request});
  assert.equal(first.version,1);
  assert.equal(first.changed,true);
  assert.equal(first.products,2);
  assert.equal((await fetch(`${origin}/api/admin/platform-prices`,{headers:{Cookie:sessionCookie}})).status,401,
    'the upload session is revoked after writing');
  const second=await uploadPlatformPrices({origin,secret,payload:payload(),request});
  assert.equal(second.version,1);
  assert.equal(second.changed,false,'unchanged listed prices do not create a revision');
});

test('daily uploader rejects unapproved fields before opening an admin session',async()=>{
  let requests=0;
  await assert.rejects(uploadPlatformPrices({origin:'http://127.0.0.1:1',secret:'test',payload:{...payload(),accountId:'private'},
    request:()=>{requests++;throw new Error('unexpected request');}}),/不支持的字段/);
  assert.equal(requests,0);
});
