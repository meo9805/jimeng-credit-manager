import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { validateIngest } from '../server/domain.mjs';
import { fetchDashboard } from '../web/dashboard-client.js';

const START=Date.parse('2026-09-15T03:00:00Z');
const personal={platformUserId:'person-a',scope:'personal',spaceId:'personal',displayName:'昵称',balance:100};
function fixture(t) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-dashboard-cache-'));
  let time=START;
  const store=createStore({dataDir,secret:'isolated-test-key',clock:()=>time});
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  const department=store.createDepartment({name:'教研'}),employee=store.createEmployee({name:'测试员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const collect=(accounts=[personal],transactions=[])=>store.ingest(device,validateIngest({observedAt:new Date(time).toISOString(),status:'ok',accounts,transactions},time));
  const event=(index,extra={})=>({platformUserId:personal.platformUserId,scope:'personal',spaceId:'personal',eventId:`event-${index}`,occurredAt:new Date(START-index*1000).toISOString(),kind:'consume',amount:-1,...extra});
  const edit=fn=>{const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));try{return fn(db);}finally{db.close();}};
  return {store,department,employee,device,collect,event,edit,tick:(ms=1)=>time+=ms};
}

test('unchanged ledger is parsed once across heartbeats, diagnostics and directory changes without dropping totals',t=>{
  const f=fixture(t);
  f.collect([personal],Array.from({length:1000},(_,i)=>f.event(i)));
  f.tick();f.collect([personal],Array.from({length:250},(_,i)=>f.event(i+1000)));
  const history=f.store.dashboard().transactions;
  assert.equal(history.length,1250);assert.equal(history.reduce((sum,row)=>sum+row.amount,0),-1250);
  f.store.pollCommands(f.device);
  f.store.recordDiagnostics(f.device,[{id:'cache-log',at:new Date(START).toISOString(),code:'collector_started',extensionVersion:'0.2.7'}]);
  f.store.patchDepartment(f.department.id,{name:'教研中心'});
  const data=f.store.dashboard();
  assert.strictEqual(data.transactions,history,'metadata refresh does not select/parse/sort the ledger again');
  assert.equal(data.departments[0].name,'教研中心');
  f.tick();f.collect([personal],[f.event(1250)]);
  const appended=f.store.dashboard().transactions;
  assert.notStrictEqual(appended,history);assert.equal(appended.length,1251);
  assert.equal(appended.reduce((sum,row)=>sum+row.amount,0),-1251);
  f.tick();f.collect([personal],[f.event(1250)]);
  assert.strictEqual(f.store.dashboard().transactions,appended,'duplicate observations do not invalidate history');
  assert.throws(()=>appended.push({}),TypeError,'callers cannot corrupt a shared cache');
});

test('canonical team promotion, charged-member enrichment and external deletion invalidate the ledger cache',t=>{
  const f=fixture(t),member={...personal,scope:'team_member',spaceId:'team-a'},total={...member,scope:'team_total'};
  const event=f.event(1,{platformUserId:member.platformUserId,scope:member.scope,spaceId:member.spaceId});
  f.collect([member],[event]);
  const before=f.store.dashboard().transactions,memberId=before[0].accountId;
  f.tick();f.collect([total],[]);
  const promoted=f.store.dashboard().transactions;
  assert.notStrictEqual(promoted,before);assert.notEqual(promoted[0].accountId,memberId);
  const unassigned=f.event(2,{scope:'team_total',spaceId:'team-a',chargedPlatformUserId:null});
  f.tick();f.collect([],[unassigned]);
  const pending=f.store.dashboard().transactions;
  f.tick();f.collect([],[{...unassigned,chargedPlatformUserId:'person-a'}]);
  const enriched=f.store.dashboard().transactions;
  assert.notStrictEqual(enriched,pending);assert.equal(enriched.find(row=>row.eventId===unassigned.eventId).chargedPlatformUserId,'person-a');
  const version=f.store.dashboardVersion();
  f.edit(db=>db.prepare('DELETE FROM transactions').run());
  assert.notEqual(f.store.dashboardVersion(),version,'external SQLite writes also change the conditional validator');
  assert.equal(f.store.dashboard().transactions.length,0);
});

test('a failed ingest does not publish rolled-back transactions through the ledger cache',t=>{
  const f=fixture(t);f.collect([personal],[f.event(1)]);
  const history=f.store.dashboard().transactions;
  assert.throws(()=>f.collect([personal],[f.event(2),f.event(1,{amount:-8})]),/冲突/);
  assert.strictEqual(f.store.dashboard().transactions,history);
  assert.equal(history.length,1);
});

test('conditional version stays stable between real changes but expires for online and stale transitions',t=>{
  const f=fixture(t);f.collect();f.store.pollCommands(f.device);
  const onlineVersion=f.store.dashboardVersion();
  assert.equal(f.store.dashboard().installations[0].online,true);
  f.tick(30_000);assert.equal(f.store.dashboardVersion(),onlineVersion);
  f.tick(30_000);assert.equal(f.store.dashboardVersion(),onlineVersion,'online timeout is inclusive');
  f.tick();assert.notEqual(f.store.dashboardVersion(),onlineVersion);
  assert.equal(f.store.dashboard().installations[0].online,false);
  const offlineVersion=f.store.dashboardVersion();
  f.tick(24*3600_000-60_001);assert.equal(f.store.dashboardVersion(),offlineVersion);
  f.tick();assert.notEqual(f.store.dashboardVersion(),offlineVersion);
  const stale=f.store.dashboard();assert.equal(stale.accounts[0].status,'stale');assert.equal(stale.installations[0].status,'offline');
  const staleVersion=f.store.dashboardVersion();
  f.tick(-24*3600_000);assert.notEqual(f.store.dashboardVersion(),staleVersion,'clock rollback must not freeze stale state');
  assert.equal(f.store.dashboard().accounts[0].status,'ok');
});

test('unchanged data still refreshes when credit batches enter seven-day urgency or reach expiry',t=>{
  const f=fixture(t);
  f.collect([{...personal,creditBatches:[{kind:'subscription',amount:70,expiresAt:new Date(START+7*86400_000+1000).toISOString()},{kind:'gift',amount:30,expiresAt:new Date(START+2000).toISOString()}],creditBatchesComplete:true}]);
  const first=f.store.dashboardVersion();f.store.dashboard();
  f.tick(999);assert.equal(f.store.dashboardVersion(),first);
  f.tick();const urgent=f.store.dashboardVersion();assert.notEqual(urgent,first);f.store.dashboard();
  f.tick(999);assert.equal(f.store.dashboardVersion(),urgent);
  f.tick();assert.notEqual(f.store.dashboardVersion(),urgent,'expiry repaint must not wait for another database write');
});

async function httpFixture(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'jmc-dashboard-http-')),dataDir=path.join(directory,'data'),extensionDir=path.join(directory,'extension');
  mkdirSync(extensionDir);writeFileSync(path.join(extensionDir,'manifest.json'),JSON.stringify({version:'0.2.7'}));
  const app=createApp({dataDir,extensionDir,clock:()=>START}),origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const response=await fetch(`${origin}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim()})});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const request=(etag,auth=true)=>fetch(`${origin}/api/dashboard`,{headers:{...(auth?{Cookie:cookie}:{}),...(etag?{'If-None-Match':etag}:{})}});
  return {origin,cookie,request,extensionDir};
}

test('HTTP 304 skips observations and still authenticates; writes and a release change invalidate immediately',async t=>{
  const f=await httpFixture(t);
  let observationReads=0;
  const prepare=DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql,...args){if(sql==='SELECT * FROM accounts ORDER BY snapshot_at DESC,id')observationReads++;return prepare.call(this,sql,...args);});
  const first=await f.request();assert.equal(first.status,200);assert.equal(observationReads,1);
  const etag=first.headers.get('etag');assert.match(etag,/^W\//);await first.json();
  const unchanged=await f.request(etag);assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');assert.equal(observationReads,1);
  assert.equal((await f.request(etag,false)).status,401,'matching ETag cannot bypass authentication');
  const mutation=await fetch(`${f.origin}/api/departments`,{method:'POST',headers:{Cookie:f.cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'教研'})});
  assert.equal(mutation.status,201);
  const changed=await f.request(etag);assert.equal(changed.status,200);assert.equal(observationReads,2);
  assert.equal((await changed.json()).departments[0].name,'教研');
  const nextEtag=changed.headers.get('etag');assert.notEqual(nextEtag,etag);
  writeFileSync(path.join(f.extensionDir,'manifest.json'),JSON.stringify({version:'0.2.8'}));
  const released=await f.request(nextEtag);assert.equal(released.status,200);assert.equal((await released.json()).collectorRelease.version,'0.2.8');
});

test('dashboard client preserves its data on 304 and sends validators only for a known snapshot',async()=>{
  let request;
  const first=await fetchDashboard({fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({transactions:[{id:'all-history'}]}),{headers:{etag:'W/"one"'}});}});
  assert.equal(first.unchanged,false);assert.equal(first.data.transactions.length,1);assert.deepEqual(request.options.headers,{});
  const second=await fetchDashboard({etag:first.etag,fetchImpl:async(url,options)=>{request={url,options};return {status:304,json(){throw new Error('304 has no body');}};}});
  assert.deepEqual(second,{unchanged:true,etag:'W/"one"'});
  assert.equal(request.options.headers['If-None-Match'],'W/"one"');assert.equal(request.options.credentials,'same-origin');
  await assert.rejects(fetchDashboard({etag:first.etag,fetchImpl:async()=>new Response(JSON.stringify({error:'请先验证管理员身份'}),{status:401})}),error=>error.status===401);
});
