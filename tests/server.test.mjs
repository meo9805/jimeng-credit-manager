import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../server/index.mjs';
import { createReferenceRates } from '../server/reference-rates.mjs';
import { referenceValue } from '../shared/reference-pricing.mjs';

const NOW=Date.parse('2026-09-12T10:00:00.000Z');
const OBS='2026-09-12T09:00:00.000Z';
const EXTENSION_ORIGIN='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function observed(platformUserId='1001',extra={}) {
  return {platformUserId,spaceId:'0',spaceType:'personal',scope:'personal',displayName:'测试账号',spaceName:'个人空间',balance:100,giftBalance:null,purchaseBalance:100,subscriptionBalance:null,expiresAt:null,...extra};
}
function event(eventId='event-1',extra={}) {
  return {platformUserId:'1001',spaceId:'0',scope:'personal',eventId,occurredAt:'2026-09-12T08:00:00.000Z',kind:'consume',amount:-20,description:'视频生成',...extra};
}
async function fixture(t,{clock=()=>NOW}={}) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'jimeng-server-test-'));
  const dataDir=path.join(directory,'private'),extensionDir=path.join(directory,'extension'),distDir=path.join(directory,'dist');
  mkdirSync(extensionDir);mkdirSync(distDir);
  writeFileSync(path.join(extensionDir,'manifest.json'),JSON.stringify({manifest_version:3,name:'test',version:'0.1.0',host_permissions:['<all_urls>'],optional_host_permissions:['https://*/*']}));
  writeFileSync(path.join(extensionDir,'worker.js'),'// inert test extension');
  writeFileSync(path.join(distDir,'index.html'),'<!doctype html><title>test</title>');
  const app=createApp({dataDir,extensionDir,distDir,clock}),origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  let cookie='';
  const request=async(route,{method='GET',body,token,admin=false,headers={},...rest}={})=>{
    const response=await fetch(origin+route,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(admin?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`,Origin:EXTENSION_ORIGIN}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{}),...rest});
    return response;
  };
  const login=async()=>{
    const secret=readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim();
    const response=await request('/api/admin/login',{method:'POST',body:{secret},headers:{Origin:origin}});
    assert.equal(response.status,200);
    cookie=response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal(statSync(path.join(dataDir,'admin-secret')).mode & 0o777,0o600);
    return response;
  };
  const departments=new Map(),employees=new Map();
  const department=async(name)=>{
    const key=name.trim();
    if(!departments.has(key)){
      const response=await request('/api/departments',{method:'POST',admin:true,body:{name}});
      assert.equal(response.status,201);departments.set(key,await response.json());
    }
    return departments.get(key);
  };
  const employee=async(name,departmentName='教研')=>{
    const departmentId=departmentName===null?null:(await department(departmentName)).id;
    const key=JSON.stringify([name.trim(),departmentId]);
    if(!employees.has(key)){
      const response=await request('/api/employees',{method:'POST',admin:true,body:{name,departmentId}});
      assert.equal(response.status,201);employees.set(key,await response.json());
    }
    return employees.get(key);
  };
  const installation=async(role='collector',employeeName='员工甲')=>{
    const person=await employee(employeeName);
    const response=await request('/api/installations',{method:'POST',admin:true,body:{employeeId:person.id,role:'collector'}});
    assert.equal(response.status,201);
    const device=await response.json();assert.equal(device.token,undefined);assert.equal(device.token_hash,undefined);
    // Only historical databases can contain administrator devices now.
    if(role==='admin'){
      const legacyDb=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
      legacyDb.prepare("UPDATE installations SET data=json_set(data,'$.role','admin') WHERE id=?").run(device.id);
      legacyDb.close();device.role='admin';
    }
    const download=await request(`/api/installations/${device.id}/extension.zip`,{admin:true});
    assert.equal(download.status,200);assert.match(download.headers.get('cache-control'),/no-store/);
    const files=unzipSync(new Uint8Array(await download.arrayBuffer()));
    assert.ok(files['Windows-双击安装.cmd']);assert.ok(files['Mac-双击安装.command']);
    const guide=strFromU8(files['安装说明.txt']);
    assert.match(guide,/手动加载（不用运行安装助手）/);
    assert.match(guide,/选择包含 manifest\.json 的整个解压文件夹/);
    assert.match(guide,/窗口内文件变灰是正常的/);
    assert.ok(files['manifest.json'],'manual loading keeps the manifest at the ZIP root');
    const provision=JSON.parse(strFromU8(files['provision.json'])),manifest=JSON.parse(strFromU8(files['manifest.json']));
    assert.equal(provision.endpoint,origin);assert.equal(provision.installationId,device.id);
    assert.deepEqual(manifest.host_permissions,['https://jimeng.jianying.com/*','http://127.0.0.1/*']);
    assert.equal(manifest.optional_host_permissions,undefined);
    return {...device,token:provision.token};
  };
  const ingest=async(device,accounts=[],transactions=[],extra={})=>request('/api/ingest',{method:'POST',token:device.token,body:{observedAt:OBS,accounts,transactions,...extra}});
  const dashboard=async(mode='live')=>{const r=await request(`/api/dashboard?mode=${mode}`,{admin:true});assert.equal(r.status,200);return r.json();};
  return {app,origin,directory,dataDir,request,login,department,employee,installation,ingest,dashboard};
}

test('reference rates persist once, require admin and preserve earlier effective prices',async t=>{
  let clock=NOW;
  const f=await fixture(t,{clock:()=>clock});await f.login();const device=await f.installation();
  assert.equal((await f.ingest(device,[observed('1001',{membershipPlan:'超级会员',billingCycle:'连续包年',subscriptionObservedAt:OBS})])).status,200);
  const initial=await f.dashboard();
  const baseline=initial.referenceRates.find(rate=>rate.walletKey==='personal:1001');
  assert.ok(baseline?.perThousand>0);assert.equal(baseline.basis,'initial_reference');
  assert.equal(baseline.effectiveAt,'1970-01-01T00:00:00.000Z');
  const payload={walletKey:'personal:1001',perThousand:123};
  assert.equal((await f.request('/api/reference-rates',{method:'POST',body:payload})).status,401);
  assert.equal((await f.request('/api/reference-rates',{method:'POST',body:payload,token:device.token})).status,403);
  for(const perThousand of [0,-1,'10',1000001]) assert.equal((await f.request('/api/reference-rates',{method:'POST',admin:true,body:{...payload,perThousand}})).status,400);
  assert.equal((await f.request('/api/reference-rates',{method:'POST',admin:true,body:{...payload,effectiveAt:OBS}})).status,400);
  assert.equal((await f.request('/api/reference-rates',{method:'POST',admin:true,body:{...payload,walletKey:'personal:missing'}})).status,404);
  const oldEtag=(await f.request('/api/dashboard',{admin:true})).headers.get('etag');
  clock+=60000;
  const saved=await f.request('/api/reference-rates',{method:'POST',admin:true,body:payload});assert.equal(saved.status,201);
  const rate=await saved.json();assert.equal(rate.effectiveAt,new Date(clock).toISOString());assert.equal(rate.basis,'effective');
  assert.equal((await f.request('/api/dashboard',{admin:true,headers:{'If-None-Match':oldEtag}})).status,200);
  const db=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reference_rates').get().n,2);db.close();
  await f.request('/api/reference-rates',{method:'POST',admin:true,body:payload});
  assert.equal((await f.dashboard()).referenceRates.length,2,'repeated save does not append duplicate revisions');
  await f.ingest(device,[observed('1001',{balance:0,subscriptionBalance:0,membershipPlan:'高级会员',billingCycle:'连续包月',subscriptionObservedAt:new Date(clock).toISOString()})],[],{observedAt:new Date(clock).toISOString()});
  assert.deepEqual((await f.dashboard()).referenceRates,[baseline,rate],'new balance or plan does not silently reprice historical data');
});

test('unknown plan cycle receives a frozen estimate and manual revisions apply only afterward',async t=>{
  let clock=NOW;
  const f=await fixture(t,{clock:()=>clock});await f.login();const device=await f.installation();
  await f.ingest(device,[observed('1001',{membershipPlan:'高级会员',membershipExpiresAt:'2027-09-01T00:00:00.000Z'})]);
  const initial=await f.dashboard(),baseline=initial.referenceRates[0],account=initial.accounts[0];
  assert.equal(initial.referenceRates.length,1);
  assert.equal(baseline.perThousand,998/12320*1000);
  assert.equal(baseline.source,'plan_estimate');
  assert.equal(baseline.effectiveAt,'1970-01-01T00:00:00.000Z');
  assert.equal(baseline.basis,'initial_reference');
  const oldValue=referenceValue(account,100,[baseline],OBS);
  clock+=60000;
  const saved=await f.request('/api/reference-rates',{method:'POST',admin:true,body:{walletKey:'personal:1001',perThousand:70}});
  assert.equal(saved.status,201);const rate=await saved.json();assert.equal(rate.basis,'effective');assert.equal(rate.source,'manual');
  assert.equal(rate.effectiveAt,new Date(clock).toISOString());
  const rates=(await f.dashboard()).referenceRates;
  assert.deepEqual(rates,[baseline,rate]);
  assert.equal(referenceValue(account,100,rates,OBS),oldValue);
  assert.equal(referenceValue(account,100,rates,clock),7);
});

test('missing personal plans and legacy team plans persist fallback prices without duplicate team wallets',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const team={spaceId:'legacy-team',spaceType:'team',membershipPlan:'高级团队会员'};
  assert.equal((await f.ingest(device,[observed(),
    observed('1001',{...team,scope:'team_member'}),observed('1001',{...team,scope:'team_total'}),
  ])).status,200);
  const first=await f.dashboard();
  assert.equal(first.referenceRates.length,2);
  const personal=first.referenceRates.find(rate=>rate.walletKey==='personal:1001');
  const shared=first.referenceRates.find(rate=>rate.walletKey==='team:legacy-team');
  assert.equal(personal.source,'purchase_estimate');assert.equal(personal.perThousand,100);
  assert.equal(shared.source,'team_estimate');assert.equal(shared.perThousand,6319/68250*1000);
  assert.deepEqual((await f.dashboard()).referenceRates,first.referenceRates,'repeated snapshots preserve the original references');
  const persisted=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  try{
    assert.equal(persisted.prepare('SELECT COUNT(*) AS n FROM reference_rates').get().n,2);
    assert.equal(persisted.prepare('SELECT COUNT(*) AS n FROM reference_rates WHERE wallet_key=?').get('team:legacy-team').n,1);
  }finally{persisted.close();}
});

test('team seed chooses the most reliable observation regardless of order and survives reopening',t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'jimeng-reference-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'reference.sqlite');
  let db=new DatabaseSync(file),rates=createReferenceRates(db,()=>new Date(NOW).toISOString());
  const weak={scope:'team_total',platformUserId:'1001',membershipPlan:'高级团队会员'};
  const known={scope:'team_member',platformUserId:'1002',membershipPlan:'超级团队会员'};
  const explicit={...known,platformUserId:'1003',billingCycle:'连续包月'};
  try{
    rates.seed([
      ...[weak,known,explicit].map(account=>({...account,spaceId:'forward'})),
      ...[explicit,known,weak].map(account=>({...account,spaceId:'reverse'})),
      ...[weak,known].map(account=>({...account,spaceId:'known-monthly'})),
    ]);
    const originals=rates.list();
    assert.equal(originals.length,3);
    for(const key of ['team:forward','team:reverse']){
      const rate=originals.find(value=>value.walletKey===key);
      assert.equal(rate.source,'platform_reference');assert.equal(rate.perThousand,6319/68250*1000);
      assert.equal(rate.revision,1);
    }
    assert.equal(originals.find(value=>value.walletKey==='team:known-monthly').source,'plan_estimate');
    db.close();db=new DatabaseSync(file);rates=createReferenceRates(db,()=>new Date(NOW+60000).toISOString());
    rates.seed([{...weak,spaceId:'forward'},{...explicit,spaceId:'known-monthly'}]);
    assert.deepEqual(rates.list(),originals,'later metadata and process restarts cannot overwrite a stored estimate');
  }finally{db.close();}
});

test('administrator sessions and collector scopes prevent data reads, writes, and privilege escalation',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await (await f.request('/api/session')).json(),{authenticated:false,role:null});
  assert.equal((await f.request('/api/dashboard')).status,401);
  assert.equal((await f.request('/api/admin/login',{method:'POST',body:{secret:'wrong'}})).status,401);
  await f.login();const collector=await f.installation();
  assert.equal((await f.request('/api/dashboard',{token:collector.token})).status,403);
  assert.equal((await f.request('/api/admin/extension-login',{method:'POST',token:collector.token})).status,403);
  assert.equal((await f.request('/api/installations',{method:'POST',token:collector.token,body:{employeeId:collector.employeeId,role:'admin'}})).status,403);
  const status=await (await f.request('/api/collector/status',{token:collector.token})).json();
  assert.equal(status.role,'collector');assert.equal(status.dashboardUrl,null);
  assert.equal((await f.request('/api/installations',{method:'POST',admin:true,body:{employeeId:collector.employeeId,role:'admin'}})).status,400);
  assert.equal((await f.request(`/api/installations/${collector.id}`,{method:'PATCH',admin:true,body:{role:'admin'}})).status,400);
  const manager=await f.installation('admin','测试管理员');
  const extensionLogin=await f.request('/api/admin/extension-login',{method:'POST',token:manager.token});
  assert.equal(extensionLogin.status,200);
  assert.equal(extensionLogin.headers.get('set-cookie'),null,'extension background does not rely on third-party cookies');
  const {ticket}=await extensionLogin.json();
  const consume=()=>f.request('/api/admin/consume-ticket',{method:'POST',body:{ticket},headers:{Origin:f.origin}});
  const consumed=await consume();assert.equal(consumed.status,200);
  assert.equal((await consume()).status,401,'one-time ticket cannot be replayed');
  const managerCookie=consumed.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/dashboard',{headers:{Cookie:managerCookie}})).status,200);
  assert.equal((await f.request(`/api/installations/${manager.id}`,{method:'PATCH',admin:true,body:{role:'collector'}})).status,200);
  assert.equal((await f.request('/api/dashboard',{headers:{Cookie:managerCookie}})).status,401);
  assert.equal((await f.request(`/api/installations/${collector.id}`,{method:'PATCH',admin:true,body:{enabled:false}})).status,200);
  assert.equal((await f.ingest(collector)).status,401);
  assert.equal((await f.request('/api/admin/logout',{method:'POST',admin:true})).status,200);
  assert.equal((await f.request('/api/dashboard',{admin:true})).status,401);
});

test('administrators can delete one collector, revoke its package and preserve collected business data',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation('collector','员工乙');
  const route=`/api/installations/${a.id}`;
  assert.equal((await f.request(route,{method:'DELETE'})).status,401);
  assert.equal((await f.request(route,{method:'DELETE',token:a.token})).status,403);
  const receivedAt=new Date(NOW).toISOString();
  assert.equal((await f.ingest(a,[observed()], [event()], {observedAt:receivedAt,loginIdentity:{platformUserId:'1001',displayName:'平台昵称'},teams:[{spaceId:'team-kept',name:'团队',members:[]}]})).status,200);
  assert.equal((await f.request('/api/identities/1001',{method:'PATCH',admin:true,body:{boundPhone:'199****0000'}})).status,200);
  const log={id:'delete-test-log',at:receivedAt,code:'collection_completed',extensionVersion:'0.2.7'};
  assert.equal((await f.request('/api/collector/diagnostics',{method:'POST',token:a.token,body:{logs:[log]}})).status,200);
  const before=await f.dashboard();
  const job=await (await f.request('/api/sync-requests',{method:'POST',admin:true,body:{}})).json();
  assert.equal((await f.request('/api/collector/commands',{token:a.token})).status,200);
  assert.equal((await f.request('/api/collector/commands',{token:b.token})).status,200);
  assert.equal((await f.request(`/api/collector/commands/${job.id}/result`,{method:'POST',token:b.token,body:{status:'completed'}})).status,200);
  const removed=await f.request(route,{method:'DELETE',admin:true});
  assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{deleted:true,id:a.id});
  const after=await f.dashboard();
  assert.deepEqual(after.installations.map(item=>item.id),[b.id]);
  for(const key of ['accounts','teams','transactions','identities','employees','departments'])assert.deepEqual(after[key],before[key],key);
  const sync=await (await f.request(`/api/sync-requests/${job.id}`,{admin:true})).json();
  const target=sync.targets.find(item=>item.installationId===a.id);
  assert.equal(target.status,'failed');assert.equal(target.message,'采集端已删除');assert.equal(target.online,false);
  assert.equal(sync.targets.find(item=>item.installationId===b.id).status,'completed');
  for(const route of ['/api/collector/status','/api/collector/commands','/api/collector/extension.zip'])assert.equal((await f.request(route,{token:a.token})).status,401,route);
  assert.equal((await f.ingest(a,[observed('new-rejected')])).status,401);
  assert.equal((await f.request('/api/collector/diagnostics',{method:'POST',token:a.token,body:{logs:[log]}})).status,401);
  assert.equal((await f.request(`/api/collector/commands/${job.id}/result`,{method:'POST',token:a.token,body:{status:'completed'}})).status,401);
  assert.equal((await f.request(`${route}/extension.zip`,{admin:true})).status,404);
  assert.equal((await f.request(`${route}/diagnostics`,{admin:true})).status,404);
  assert.equal((await f.request(route,{method:'DELETE',admin:true})).status,404);
  assert.equal((await f.request(route,{method:'PATCH',admin:true,body:{enabled:true}})).status,404);
  assert.equal((await f.request('/api/collector/status',{token:b.token})).status,200);
  const db=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  try{
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM installation_accounts WHERE installation_id=?').get(a.id).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collector_diagnostics WHERE installation_id=?').get(a.id).n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('only same-site administrator requests can resolve first enrollment as collection only',async t=>{
  const f=await fixture(t);await f.login();const owner=await f.installation(),borrower=await f.installation('collector','员工乙');
  const route=`/api/installations/${borrower.id}/skip-initial-binding`;
  const snapshot={observedAt:new Date(NOW).toISOString(),loginIdentity:{platformUserId:'1001',displayName:'平台昵称'}};
  assert.equal((await f.ingest(owner,[observed()],[event()],snapshot)).status,200);
  assert.equal((await f.ingest(borrower,[observed()],[],snapshot)).status,200);
  const before=await f.dashboard(),original=before.installations.find(item=>item.id===borrower.id).initialIdentityBinding;
  assert.equal(original.status,'skipped');
  const post=(extra={})=>f.request(route,{method:'POST',body:{},...extra});
  assert.equal((await post()).status,401);
  assert.equal((await post({token:borrower.token})).status,403);
  assert.equal((await post({token:borrower.token,headers:{Origin:f.origin}})).status,401);
  assert.equal((await post({admin:true,headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await post({admin:true,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.request(route,{admin:true})).status,405);
  for(const body of [null,[],{employeeId:borrower.employeeId},{resolution:'collection_only'}])assert.equal((await post({admin:true,body})).status,400);
  assert.deepEqual((await f.dashboard()).installations.find(item=>item.id===borrower.id).initialIdentityBinding,original);
  const response=await post({admin:true,headers:{Origin:f.origin}});assert.equal(response.status,200);
  const resolved=await response.json();assert.equal(resolved.id,borrower.id);assert.equal(resolved.employeeId,borrower.employeeId);assert.equal(resolved.token,undefined);
  assert.deepEqual(resolved.initialIdentityBinding,original);
  const after=await f.dashboard();
  for(const key of ['accounts','transactions','teams','identities','employees','departments'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual((await (await post({admin:true})).json()).initialIdentityBinding,resolved.initialIdentityBinding);
  assert.equal((await f.request(`/api/installations/${owner.id}/skip-initial-binding`,{method:'POST',admin:true,body:{}})).status,200);
  assert.equal((await f.request('/api/installations/missing-device/skip-initial-binding',{method:'POST',admin:true,body:{}})).status,404);
  assert.equal((await f.request('/api/installations/invalid%2Fid/skip-initial-binding',{method:'POST',admin:true,body:{}})).status,400);
  assert.equal((await f.request(`/api/installations/${borrower.id}`,{method:'PATCH',admin:true,body:{employeeId:owner.employeeId}})).status,409);
  assert.equal((await f.ingest(borrower,[observed('later-own')],[],{observedAt:snapshot.observedAt,loginIdentity:{platformUserId:'later-own',displayName:'后来账号'}})).status,200);
  const latest=await f.dashboard();assert.equal(latest.identities.find(item=>item.platformUserId==='1001').employeeId,null);
  assert.equal(latest.identities.find(item=>item.platformUserId==='later-own').employeeId,null);
  const pending=await f.installation('collector','员工丙');
  const pendingResponse=await f.request(`/api/installations/${pending.id}/skip-initial-binding`,{method:'POST',admin:true,body:{}});
  assert.equal(pendingResponse.status,200);assert.equal((await pendingResponse.json()).initialIdentityBinding.status,'skipped');
});

test('diagnostic logs are bounded, private, device scoped and reject free-form sensitive fields',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation('collector','员工乙');
  const log=i=>({id:`diagnostic-${String(i).padStart(4,'0')}`,at:new Date(NOW-200_000+i*1000).toISOString(),code:'connection_failed',httpStatus:502,extensionVersion:'0.2.2'});
  const post=(device,logs)=>f.request('/api/collector/diagnostics',{method:'POST',token:device.token,body:{logs}});
  const get=id=>f.request(`/api/installations/${id}/diagnostics`,{admin:true});
  assert.equal((await f.request('/api/collector/diagnostics',{method:'POST',body:{logs:[log(0)]}})).status,401);
  assert.equal((await f.request(`/api/installations/${a.id}/diagnostics`)).status,401);
  assert.equal((await f.request(`/api/installations/${a.id}/diagnostics`,{token:a.token})).status,403);
  for(const extra of [{message:'raw secret'},{url:'https://example.test/?token=x'},{headers:{Authorization:'secret'}},{code:'raw error message'},{extensionVersion:'jmc-secret'},{pendingCount:-1},{httpStatus:700}])assert.equal((await post(a,[{...log(0),...extra}])).status,400);
  assert.equal((await post(a,Array.from({length:51},(_,i)=>log(i)))).status,400);
  for(let i=0;i<3;i++)assert.equal((await post(a,Array.from({length:40},(_,j)=>log(i*40+j)))).status,200);
  assert.equal((await post(a,[log(119)])).status,200);
  const read=await (await get(a.id)).json();assert.equal(read.logs.length,100);assert.equal(read.logs[0].id,log(119).id);assert.equal(read.logs.at(-1).id,log(20).id);assert.equal(read.lastReceivedAt,new Date(NOW).toISOString());
  assert.deepEqual((await (await get(b.id)).json()).logs,[]);
  await post(b,[log(119)]);assert.equal((await (await get(b.id)).json()).logs.length,1,'same local event id is isolated per device');
  const replacement=await f.employee('修改名称');
  assert.equal((await f.request(`/api/installations/${a.id}`,{method:'PATCH',admin:true,body:{employeeId:replacement.id}})).status,409);
  assert.equal((await (await get(a.id)).json()).logs.length,100);
  assert.ok((await f.dashboard()).installations.every(x=>!Object.hasOwn(x,'logs')));
  await f.request(`/api/installations/${a.id}`,{method:'PATCH',admin:true,body:{enabled:false}});
  assert.equal((await post(a,[log(121)])).status,401);
});

test('separate observers merge accounts and team balances while keeping member allowances out of company totals',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation('collector','员工乙');
  const team={spaceId:'team-01',spaceType:'team',scope:'team_total',spaceName:'同一个团队',balance:1000};
  assert.equal((await f.ingest(a,[observed('1001'),observed('1001',team)])).status,200);
  assert.equal((await f.ingest(b,[observed('1001'),observed('2001',team),observed('2001',{...team,scope:'team_member',balance:400}),observed('1002',{balance:200})],[],{observedAt:'2026-09-12T09:01:00.000Z'})).status,200);
  const data=await f.dashboard();
  assert.equal(data.accounts.length,4);
  assert.equal(data.accounts.filter(a=>a.scope==='team_total').length,1);
  assert.equal(data.accounts.filter(a=>a.scope!=='team_member').reduce((sum,a)=>sum+(a.balance??0),0),1300);
  assert.equal(data.installations.find(i=>i.id===a.id).accountCount,2);
  assert.equal(data.installations.find(i=>i.id===b.id).accountCount,4);
  assert.ok(data.accounts.every(a=>a.ownerName===null));
  const id=data.accounts.find(a=>a.platformUserId==='1001'&&a.scope==='personal').id;
  const owner=await f.employee('持有人','AI 短剧');
  assert.equal((await f.request(`/api/accounts/${encodeURIComponent(id)}`,{method:'PATCH',admin:true,body:{ownerEmployeeId:owner.id,ownerDepartmentId:owner.departmentId}})).status,200);
  await f.ingest(b,[observed('1001',{balance:80})],[],{observedAt:'2026-09-12T09:02:00.000Z'});
  assert.equal((await f.dashboard()).accounts.find(a=>a.id===id).ownerName,'持有人');
});

test('team archive requires administrator review and survives another collector observation',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const team=observed('1001',{spaceId:'obsolete-team',spaceType:'team',scope:'team_total',balance:1000});
  assert.equal((await f.ingest(device,[team],[event('historic-spend',{spaceId:'obsolete-team',scope:'team_total'})])).status,200);
  const route='/api/teams/obsolete-team/management';
  assert.equal((await f.request(route,{method:'PATCH',body:{archived:true},headers:{Origin:f.origin}})).status,401);
  assert.equal((await f.request(route,{method:'PATCH',admin:true,body:{archived:true}})).status,403);
  assert.equal((await f.request('/api/teams/nonexistent/management',{method:'PATCH',admin:true,body:{archived:true},headers:{Origin:f.origin}})).status,404);
  const archived=await f.request(route,{method:'PATCH',admin:true,body:{archived:true},headers:{Origin:f.origin}});
  assert.equal(archived.status,200);
  assert.equal((await archived.json()).archived,true);
  assert.equal((await f.ingest(device,[{...team,balance:500}])).status,200);
  const data=await f.dashboard();
  assert.equal(data.teamManagement.find(item=>item.spaceId==='obsolete-team').archived,true);
  assert.equal(data.transactions.find(item=>item.eventId==='historic-spend').amount,-20);
  const restored=await f.request(route,{method:'PATCH',admin:true,body:{archived:false},headers:{Origin:f.origin}});
  assert.equal((await restored.json()).archived,false);
});

test('ledger deduplication preserves refunds and never attributes history to its uploader',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation('collector','另一采集人');
  const transactions=[event(),event('event-2',{kind:'refund',amount:20,occurredAt:'2026-09-12T08:01:00.000Z',description:'失败返还'}),event('event-3',{kind:'expire',amount:-10,occurredAt:'2026-09-12T00:00:00.000Z'})];
  assert.equal((await f.ingest(a,[observed()],transactions)).status,200);
  const repeat=await f.ingest(b,[observed()],transactions);assert.equal(repeat.status,200);assert.equal((await repeat.json()).transactions,0);
  const data=await f.dashboard();assert.equal(data.transactions.length,3);
  assert.equal(data.transactions.filter(t=>['consume','refund'].includes(t.kind)).reduce((sum,t)=>sum+t.amount,0),0);
  assert.ok(data.transactions.every(t=>t.attribution==='unconfirmed'&&t.operatorName===null&&t.operatorDepartment===null));
  assert.equal(data.accounts[0].balance,100,'ledger and platform balance snapshots are separate facts');
  assert.equal((await f.ingest(a,[],[event('bad-refund',{kind:'refund',amount:-20})])).status,400);
  const forged={...event('forged'),operatorName:'别人',attribution:'matched'};
  assert.equal((await f.ingest(a,[],[forged])).status,400);
  const conflict=await f.ingest(a,[observed('1001',{balance:999})],[event('event-1',{amount:-99})],{observedAt:'2026-09-12T09:30:00.000Z'});
  assert.equal(conflict.status,409);assert.equal((await f.dashboard()).accounts[0].balance,100,'conflicting events roll the full ingest back');
});

test('team administrator and member observations of the same event produce one canonical ledger entry',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation();
  const member=observed('1001',{spaceId:'team-a',spaceType:'team',scope:'team_member',balance:200});
  const memberEvent=event('shared-event',{spaceId:'team-a',scope:'team_member'});
  await f.ingest(a,[member],[memberEvent]);
  const team=observed('2001',{spaceId:'team-a',spaceType:'team',scope:'team_total',balance:1000});
  const result=await f.ingest(b,[team],[{...memberEvent,platformUserId:'2001',scope:'team_total'}]);
  assert.equal(result.status,200);assert.equal((await result.json()).transactions,0);
  const data=await f.dashboard();assert.equal(data.transactions.length,1);
  assert.equal(data.transactions[0].accountId,data.accounts.find(a=>a.scope==='team_total').id);
  assert.equal(data.transactions[0].chargedPlatformUserId,'1001','promotion preserves the platform member whose ledger was observed');
  assert.equal(data.transactions[0].operatorName,null,'a platform identity does not confirm a human operator');
  assert.equal(data.transactions[0].attribution,'unconfirmed');
});

test('out-of-order snapshots cannot regress balances; unknown and zero remain distinct',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  await f.ingest(device,[observed('1001',{balance:0}),observed('1002',{balance:null,purchaseBalance:null}),observed('1003',{balance:42})]);
  await f.ingest(device,[observed('1001',{balance:800})],[],{observedAt:'2026-09-12T08:50:00.000Z'});
  await f.ingest(device,[observed('1003',{balance:null,purchaseBalance:null})],[],{observedAt:'2026-09-12T09:20:00.000Z'});
  const data=await f.dashboard(),get=id=>data.accounts.find(a=>a.platformUserId===id);
  assert.equal(get('1001').balance,0);assert.equal(get('1001').lastSyncedAt,OBS);assert.equal(get('1001').status,'ok');
  assert.equal(get('1002').balance,null);assert.equal(get('1002').status,'unknown');
  assert.equal(get('1003').balance,42);assert.equal(get('1003').lastSyncedAt,OBS,'an unknown total does not overwrite or freshen the last measured snapshot');
  await f.ingest(device,[observed('1003',{balance:40,purchaseBalance:null})],[],{observedAt:'2026-09-12T09:30:00.000Z'});
  const later=(await f.dashboard()).accounts.find(a=>a.platformUserId==='1003');
  assert.equal(later.balance,40);assert.equal(later.purchaseBalance,null,'unknown components remain unknown when the new total is known');
  assert.equal((await f.ingest(device,[observed()],[],{observedAt:'2026-09-13T00:00:00.000Z'})).status,400);
  assert.equal((await f.ingest(device,[observed('1009',{balance:'100'})])).status,400);
});

test('team pool history preserves its charged member without allowing human-operator or personal identity forgery',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation('admin','池数据采集人');
  const team=observed('9000',{spaceId:'team-pool',spaceType:'team',scope:'team_total',balance:1000});
  const poolEvent=event('pool-history-1',{platformUserId:'9000',spaceId:'team-pool',scope:'team_total',chargedPlatformUserId:'1001'});
  assert.equal((await f.ingest(device,[team],[poolEvent])).status,200);
  const duplicate=await f.ingest(device,[],[poolEvent]);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).transactions,0);
  const data=await f.dashboard();assert.equal(data.transactions.length,1);
  assert.equal(data.transactions[0].chargedPlatformUserId,'1001');
  assert.equal(data.accounts[0].platformUserId,'9000','the observing administrator is separate from the charged member');
  assert.equal(data.transactions[0].operatorName,null);assert.equal(data.transactions[0].attribution,'unconfirmed');
  assert.equal((await f.ingest(device,[],[{...poolEvent,eventId:'forged-operator',operatorName:'伪造操作者'}])).status,400);
  assert.equal((await f.ingest(device,[],[event('forged-personal',{chargedPlatformUserId:'someone-else'})])).status,400);
  assert.equal((await f.ingest(device,[],[event('forged-member',{spaceId:'team-pool',scope:'team_member',chargedPlatformUserId:'someone-else'})])).status,400);
  assert.equal((await f.ingest(device,[],[{...poolEvent,chargedPlatformUserId:'different-member'}])).status,409);
  assert.equal((await f.dashboard()).transactions[0].chargedPlatformUserId,'1001');
});

test('membership plans have independent expiry and monotonic metadata snapshots for personal and team spaces',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const personalExpiry='2027-09-12T00:00:00.000Z',renewalAt='2027-09-11T00:00:00.000Z',creditExpiry='2026-09-20T00:00:00.000Z';
  const personal=observed('1001',{expiresAt:creditExpiry,membershipPlan:'个人高级会员',billingCycle:'年付',membershipExpiresAt:personalExpiry,nextRenewalAt:renewalAt,subscriptionObservedAt:OBS});
  const team=observed('1001',{spaceType:'team',spaceId:'plan-team',scope:'team_total',balance:1000,expiresAt:'2026-09-18T00:00:00.000Z',membershipPlan:'团队高级会员',billingCycle:'月付',membershipExpiresAt:'2026-10-12T00:00:00.000Z',subscriptionObservedAt:OBS});
  assert.equal((await f.ingest(device,[personal,team])).status,200);
  let data=await f.dashboard(),account=data.accounts.find(a=>a.scope==='personal');
  assert.equal(account.membershipExpiresAt,personalExpiry);assert.equal(account.nextRenewalAt,renewalAt);assert.equal(account.expiresAt,creditExpiry);
  assert.notEqual(account.membershipExpiresAt,account.nextRenewalAt,'scheduled renewal is independent from membership validity');
  assert.equal(data.accounts.find(a=>a.scope==='team_total').membershipPlan,'团队高级会员');
  assert.equal(data.accounts.find(a=>a.scope==='team_total').billingCycle,'月付');
  // Ordinary credit observations do not carry subscription metadata.
  await f.ingest(device,[observed('1001',{balance:90,expiresAt:creditExpiry})],[],{observedAt:'2026-09-12T09:05:00.000Z'});
  account=(await f.dashboard()).accounts.find(a=>a.scope==='personal');
  assert.equal(account.membershipPlan,'个人高级会员');assert.equal(account.membershipExpiresAt,personalExpiry);
  assert.equal(account.nextRenewalAt,renewalAt,'ordinary credit snapshots preserve the known renewal date');
  assert.equal(account.subscriptionObservedAt,OBS);
  // A newer subscription can be captured without another reliable balance measurement.
  await f.ingest(device,[observed('1001',{balance:null,membershipPlan:'个人超级会员',membershipExpiresAt:'2027-10-12T00:00:00.000Z',subscriptionObservedAt:'2026-09-12T09:15:00.000Z'})],[],{observedAt:'2026-09-12T09:20:00.000Z'});
  account=(await f.dashboard()).accounts.find(a=>a.scope==='personal');
  assert.equal(account.membershipPlan,'个人超级会员');assert.equal(account.billingCycle,'年付','omitted metadata is preserved');
  assert.equal(account.balance,90);assert.equal(account.lastSyncedAt,'2026-09-12T09:05:00.000Z');assert.equal(account.expiresAt,creditExpiry);
  // A late delivery may contain a fresh balance and an older membership snapshot.
  await f.ingest(device,[observed('1001',{balance:80,expiresAt:creditExpiry,membershipPlan:'旧会员',membershipExpiresAt:'2026-09-01T00:00:00.000Z',nextRenewalAt:'2026-08-31T00:00:00.000Z',subscriptionObservedAt:'2026-09-12T09:10:00.000Z'})],[],{observedAt:'2026-09-12T09:30:00.000Z'});
  account=(await f.dashboard()).accounts.find(a=>a.scope==='personal');
  assert.equal(account.balance,80);assert.equal(account.membershipPlan,'个人超级会员');assert.equal(account.membershipExpiresAt,'2027-10-12T00:00:00.000Z');
  assert.equal(account.nextRenewalAt,renewalAt,'an older subscription snapshot cannot regress the renewal date');
  // Explicit unknown has its own internal watermark, even when its public timestamp is null.
  await f.ingest(device,[observed('1001',{balance:null,membershipPlan:null,billingCycle:null,membershipExpiresAt:null,nextRenewalAt:null,subscriptionObservedAt:null})],[],{observedAt:'2026-09-12T09:40:00.000Z'});
  await f.ingest(device,[observed('1001',{balance:null,membershipPlan:'晚到的旧会员',subscriptionObservedAt:'2026-09-12T09:35:00.000Z'})],[],{observedAt:'2026-09-12T09:45:00.000Z'});
  await f.ingest(device,[observed('1001',{balance:null,membershipPlan:'迟到且省略订阅时间的旧快照',lastSyncedAt:'2026-09-12T09:35:00.000Z'})],[],{observedAt:'2026-09-12T09:50:00.000Z'});
  account=(await f.dashboard()).accounts.find(a=>a.scope==='personal');
  assert.equal(account.membershipPlan,null);assert.equal(account.billingCycle,null);assert.equal(account.membershipExpiresAt,null);assert.equal(account.subscriptionObservedAt,null);
  assert.equal(account.nextRenewalAt,null);
  assert.equal(account.balance,80);assert.equal(account.lastSyncedAt,'2026-09-12T09:30:00.000Z');assert.equal(account.expiresAt,creditExpiry);
  assert.equal((await f.ingest(device,[observed('1001',{membershipPlan:'x'.repeat(101)})])).status,400);
  assert.equal((await f.ingest(device,[observed('1001',{billingCycle:'x'.repeat(51)})])).status,400);
  assert.equal((await f.ingest(device,[observed('1001',{membershipExpiresAt:'not-a-date'})])).status,400);
  assert.equal((await f.ingest(device,[observed('1001',{nextRenewalAt:'not-a-date'})])).status,400);
  assert.equal((await f.ingest(device,[observed('1001',{subscriptionObservedAt:'2026-09-12T09:01:00.000Z'})])).status,400);
});

test('origin, method, body limits and field allowlists reject unsafe inputs',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const invalidHost=await new Promise((resolve,reject)=>{
    const request=http.get(f.origin+'/api/health',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});
    request.on('error',reject);
  });
  assert.equal(invalidHost,403);
  assert.equal((await f.request('/api/dashboard',{admin:true,headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await f.request('/api/ingest',{method:'POST',token:device.token,body:{observedAt:OBS,accounts:[],transactions:[]},headers:{Origin:'null'}})).status,403);
  assert.equal((await f.request('/api/ingest',{token:device.token})).status,405);
  assert.equal((await f.request('/api/ingest',{method:'POST',token:device.token,body:'x'.repeat(513*1024)})).status,413);
  assert.equal((await f.request('/api/ingest',{method:'POST',token:device.token,headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await f.ingest(device,[{...observed(),cookies:'never-store'}])).status,400);
  assert.equal((await f.ingest(device,[],[],{rawHeaders:{x:'never-store'}})).status,400);
  assert.equal((await f.ingest(device,[],[],{message:'Authorization: never-store'})).status,400);
  const preflight=await f.request('/api/ingest',{method:'OPTIONS',headers:{Origin:EXTENSION_ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),EXTENSION_ORIGIN);
  assert.equal((await f.request('/.local/admin-secret')).status,404);
  assert.equal((await f.dashboard()).accounts.length,0);
});

test('observing a team roster records creator and members without inventing wallet logins or collector installations',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  assert.deepEqual((await f.dashboard()).teams,[]);
  const snapshot={spaceId:'team-roster',name:'教研协作空间',creatorPlatformUserId:'9001',creatorDisplayName:'创建者',membershipPlan:'团队高级会员',membershipExpiresAt:'2026-10-12T00:00:00.000Z',totalBalance:1000,allocatableBalance:0,totalSeats:4,availableSeats:0,membersComplete:true,members:[
    {platformUserId:'9001',displayName:'创建者',role:'creator',usedCredits:20,balance:400,joinedAt:'2026-09-01T00:00:00.000Z'},
    {platformUserId:'9002',displayName:'团队管理员',role:'admin',usedCredits:null,balance:null,joinedAt:null},
    {platformUserId:'9003',displayName:'成员甲',role:'member',usedCredits:0,balance:300,joinedAt:null},
    {platformUserId:'9004',displayName:'成员乙',role:'unknown',usedCredits:null,balance:300,joinedAt:null},
  ]};
  const first=await f.ingest(device,[],[],{teams:[snapshot,snapshot]});assert.equal(first.status,200);assert.equal((await first.json()).teams,1);
  const data=await f.dashboard();assert.equal(data.teams.length,1);assert.equal(data.teams[0].creatorPlatformUserId,'9001');
  assert.equal(data.teams[0].members.length,4);assert.equal(data.teams[0].members.find(m=>m.platformUserId==='9002').usedCredits,null);
  assert.equal(data.teams[0].members.find(m=>m.platformUserId==='9003').usedCredits,0);
  assert.equal(data.teams[0].observedAt,OBS);assert.equal(data.teams[0].source,'live');
  assert.equal(data.accounts.length,0);assert.equal(data.transactions.length,0);assert.equal(data.installations.length,1);assert.equal(data.installations[0].accountCount,0);
  assert.equal((await f.request('/api/admin/extension-login',{method:'POST',token:device.token})).status,403,'a roster admin role grants no company app privilege');
  assert.equal((await f.request('/api/teams',{method:'POST',admin:true,body:snapshot})).status,404,'there is no team creation or invitation API');
  // A balance is counted only through the existing wallet surface, once.
  await f.ingest(device,[observed('9001',{spaceId:'team-roster',spaceType:'team',scope:'team_total',balance:1000})]);
  const after=await f.dashboard();assert.equal(after.accounts.length,1);assert.equal(after.teams.length,1);
  assert.equal(after.accounts.filter(a=>a.scope!=='team_member').reduce((sum,a)=>sum+(a.balance??0),0),1000);
});

test('team partial rosters preserve known members and fields until a newer complete snapshot replaces membership',async t=>{
  const f=await fixture(t);await f.login();const a=await f.installation(),b=await f.installation('collector','另一个观察者');
  const initial={spaceId:'partial-team',name:'原团队名',creatorPlatformUserId:'u1',creatorDisplayName:'创建者',totalBalance:2000,membersComplete:true,members:[{platformUserId:'u1',displayName:'创建者',role:'creator',usedCredits:50,balance:500},{platformUserId:'u2',displayName:'原成员',role:'member',usedCredits:20,balance:100}]};
  await f.ingest(a,[],[],{teams:[initial]});
  await f.ingest(b,[],[],{observedAt:'2026-09-12T09:10:00.000Z',teams:[{spaceId:'partial-team',membersComplete:false,totalBalance:null,members:[{platformUserId:'u2',balance:null},{platformUserId:'u3',displayName:'新观察到的成员',role:'member'}]}]});
  let team=(await f.dashboard()).teams[0];assert.equal(team.members.length,3);assert.equal(team.membersComplete,false);
  assert.equal(team.creatorPlatformUserId,'u1');assert.equal(team.name,'原团队名');assert.equal(team.totalBalance,null);
  const member=team.members.find(m=>m.platformUserId==='u2');assert.equal(member.displayName,'原成员');assert.equal(member.role,'member');assert.equal(member.usedCredits,20);assert.equal(member.balance,null);
  assert.equal(team.members.find(m=>m.platformUserId==='u3').usedCredits,null);
  await f.ingest(a,[],[],{observedAt:'2026-09-12T09:15:00.000Z',teams:[{...initial,name:'过时名称',observedAt:'2026-09-12T09:05:00.000Z'}]});
  team=(await f.dashboard()).teams[0];assert.equal(team.members.length,3);assert.equal(team.membersComplete,false);assert.equal(team.name,'原团队名');
  const complete={spaceId:'partial-team',name:'完整名单已更新',membersComplete:true,members:[{platformUserId:'u1'},{platformUserId:'u3'}]};
  await f.ingest(a,[],[],{observedAt:'2026-09-12T09:20:00.000Z',teams:[complete]});
  team=(await f.dashboard()).teams[0];assert.deepEqual(team.members.map(m=>m.platformUserId),['u1','u3']);assert.equal(team.membersComplete,true);
  assert.equal(team.members[0].role,'creator');assert.equal(team.members[0].usedCredits,50,'complete membership does not imply every member field was re-observed');
  await f.ingest(b,[],[],{observedAt:'2026-09-12T09:20:00.000Z',teams:[{spaceId:'partial-team',name:'相同时间不能覆盖',members:[{platformUserId:'u2'}]}]});
  team=(await f.dashboard()).teams[0];assert.equal(team.membersComplete,true);assert.equal(team.name,'完整名单已更新');assert.equal(team.members.length,2);
});

test('identity mappings unify personal, member and charged IDs without inventing logins, cost ownership or actual operators',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation('collector','实际采集员工');
  assert.deepEqual((await f.dashboard()).identities,[]);
  const pool={spaceId:'identity-team',spaceType:'team',scope:'team_total',balance:2000};
  const teamEvent=(eventId,chargedPlatformUserId)=>event(eventId,{platformUserId:'observer-only',spaceId:'identity-team',scope:'team_total',chargedPlatformUserId});
  const result=await f.ingest(device,[observed('shared-user',{displayName:'个人昵称'}),observed('observer-only',pool),observed('shared-user',{...pool,scope:'team_member',displayName:'成员钱包标签'})],[event('personal-charge',{platformUserId:'shared-user'}),teamEvent('member-charge','shared-user'),teamEvent('history-charge','history-only')],{teams:[{spaceId:'identity-team',members:[{platformUserId:'shared-user',displayName:'当前团队昵称'},{platformUserId:'roster-only',displayName:'只在名单里'},{platformUserId:'unknown-nickname'}]}]});
  assert.equal(result.status,200);
  let data=await f.dashboard();
  assert.deepEqual(data.identities.map(person=>person.platformUserId),['history-only','roster-only','shared-user','unknown-nickname']);
  assert.equal(data.identities.find(person=>person.platformUserId==='shared-user').nickname,'当前团队昵称');
  assert.equal(data.identities.find(person=>person.platformUserId==='history-only').nickname,null);
  assert.equal(data.identities.find(person=>person.platformUserId==='unknown-nickname').nickname,null);
  assert.ok(data.identities.every(person=>person.realName===null&&person.department===null&&person.updatedAt===null));
  const personal=data.accounts.find(account=>account.scope==='personal');
  const costOwner=await f.employee('预算负责人','短剧成本中心'),accountOwner=await f.employee('  账号持有人  ','  教研  ');
  assert.equal((await f.request(`/api/accounts/${personal.id}`,{method:'PATCH',admin:true,body:{ownerEmployeeId:costOwner.id,ownerDepartmentId:costOwner.departmentId}})).status,200);
  const patch=await f.request('/api/identities/shared-user',{method:'PATCH',admin:true,body:{employeeId:accountOwner.id}});
  assert.equal(patch.status,200);
  const mappedResponse=await patch.json();
  for(const [key,value] of Object.entries({platformUserId:'shared-user',nickname:'当前团队昵称',employeeId:accountOwner.id,departmentId:accountOwner.departmentId,realName:'账号持有人',department:'教研',updatedAt:new Date(NOW).toISOString()}))assert.equal(mappedResponse[key],value);
  const rosterOwner=await f.employee('名单中的员工',null),historyOwner=await f.employee('历史账号员工','农资');
  assert.equal((await f.request('/api/identities/roster-only',{method:'PATCH',admin:true,body:{employeeId:rosterOwner.id}})).status,200);
  assert.equal((await f.request('/api/identities/history-only',{method:'PATCH',admin:true,body:{employeeId:historyOwner.id}})).status,200);
  await f.ingest(device,[observed('shared-user',{displayName:'昵称已修改',balance:80})],[],{observedAt:'2026-09-12T09:10:00.000Z'});
  data=await f.dashboard();
  assert.equal(data.identities.filter(person=>person.platformUserId==='shared-user').length,1);
  const mapped=data.identities.find(person=>person.platformUserId==='shared-user');assert.equal(mapped.nickname,'昵称已修改');assert.equal(mapped.realName,'账号持有人');assert.equal(mapped.department,'教研');
  assert.equal(data.accounts.length,3);assert.equal(data.installations.length,1);assert.equal(data.installations[0].accountCount,3,'directory-only identities and mappings create no additional logged-in wallet association');
  assert.equal(data.accounts.find(account=>account.id===personal.id).ownerName,'预算负责人');assert.equal(data.accounts.find(account=>account.id===personal.id).ownerDepartment,'短剧成本中心');
  assert.ok(data.transactions.every(transaction=>transaction.operatorName===null&&transaction.operatorDepartment===null&&transaction.attribution==='unconfirmed'),'an account-owner mapping cannot prove who borrowed or operated that account');
  assert.equal(data.transactions.filter(transaction=>transaction.chargedPlatformUserId==='shared-user').length,2,'personal and team history can join the same identity without changing operator attribution');
});

test('legacy team grants cannot turn known team space IDs into people or charged members',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const grant=event('legacy-team-grant',{platformUserId:'1001',spaceId:'880001',scope:'team_total',chargedPlatformUserId:'880001',kind:'grant',amount:23100,description:'团队会员积分'});
  const realHistory=event('real-history-user',{platformUserId:'1001',spaceId:'880001',scope:'team_total',chargedPlatformUserId:'880004'});
  const rosterSpaceHistory=event('other-team-id',{platformUserId:'1001',spaceId:'880001',scope:'team_total',chargedPlatformUserId:'880003',kind:'grant',amount:23100});
  const memberGrant=event('legacy-member-grant',{platformUserId:'2001',spaceId:'880002',scope:'team_member',kind:'grant',amount:23100});
  assert.equal((await f.ingest(device,[observed('1001',{spaceId:'880001',spaceType:'team',scope:'team_total'}),observed('2001',{spaceId:'880002',spaceType:'team',scope:'team_member'})],[grant,realHistory,rosterSpaceHistory,memberGrant],{teams:[{spaceId:'880003',members:[{platformUserId:'9001',displayName:'当前成员'}]}]})).status,200);
  // Recreate a legacy member-wallet payload in this temporary test database only.
  const legacyDb=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  const row=legacyDb.prepare("SELECT id,data FROM transactions WHERE json_extract(data,'$.eventId')=?").get(memberGrant.eventId),legacy=JSON.parse(row.data);
  legacy.chargedPlatformUserId='880002';legacyDb.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify(legacy),row.id);
  const before=legacyDb.prepare('SELECT id,account_id,data FROM transactions ORDER BY id').all();
  const data=await f.dashboard();
  assert.equal(data.transactions.find(transaction=>transaction.eventId===grant.eventId).chargedPlatformUserId,null);
  assert.equal(data.transactions.find(transaction=>transaction.eventId===memberGrant.eventId).chargedPlatformUserId,null);
  assert.equal(data.transactions.find(transaction=>transaction.eventId===grant.eventId).amount,23100);
  assert.equal(data.transactions.find(transaction=>transaction.eventId===grant.eventId).description,'团队会员积分');
  assert.equal(data.transactions.find(transaction=>transaction.eventId===realHistory.eventId).chargedPlatformUserId,'880004');
  assert.deepEqual(data.identities.map(person=>person.platformUserId),['2001','880004','9001'],'exact known team IDs are excluded globally while a same-length real historical user remains');
  assert.equal(data.identities.find(person=>person.platformUserId==='880004').nickname,null);
  assert.equal(data.accounts.length,2);assert.equal(data.installations[0].accountCount,2);
  assert.equal((await f.request('/api/identities/880003',{method:'PATCH',admin:true,body:{employeeId:device.employeeId}})).status,404);
  const duplicate=await f.ingest(device,[],[{...grant,chargedPlatformUserId:null},realHistory]);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).transactions,0);
  assert.deepEqual(legacyDb.prepare('SELECT id,account_id,data FROM transactions ORDER BY id').all(),before,'output normalization and corrected re-observation leave stored event evidence unchanged');legacyDb.close();
});

test('identity mapping writes require admin sessions, observed IDs and existing directory references',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();await f.ingest(device,[observed()]);
  const patch=(body,extra={})=>f.request('/api/identities/1001',{method:'PATCH',admin:true,body,...extra});
  assert.equal((await patch({employeeId:device.employeeId},{admin:false})).status,401);
  assert.equal((await patch({employeeId:device.employeeId},{admin:false,token:device.token})).status,403);
  assert.equal((await patch({employeeId:device.employeeId},{admin:false,token:device.token,headers:{Origin:f.origin}})).status,401);
  assert.equal((await f.request('/api/identities/unobserved',{method:'PATCH',admin:true,body:{employeeId:device.employeeId}})).status,404);
  assert.equal((await f.request('/api/identities/invalid%2Fid',{method:'PATCH',admin:true,body:{employeeId:device.employeeId}})).status,400);
  assert.equal((await f.request('/api/identities/1001',{admin:true})).status,405);
  for(const body of [{},{nickname:'不能手改平台昵称'},{platformUserId:'another'},{realName:'自由输入'},{department:'自由输入'},{employeeId:''},{employeeId:123},{employeeId:['教研']},{employeeId:device.employeeId,operatorName:'伪造操作人'}])assert.equal((await patch(body)).status,400);
  assert.equal((await patch({employeeId:'emp-does-not-exist'})).status,400);
  const maxName='字'.repeat(100),maxDepartment='部'.repeat(80);
  const boundedEmployee=await f.employee(`  ${maxName}  `,maxDepartment);
  assert.equal((await patch({employeeId:boundedEmployee.id})).status,200,'mapping derives bounded, normalized display fields from the directory');
  let person=(await f.dashboard()).identities[0];assert.equal(person.realName,maxName);assert.equal(person.department,maxDepartment);
  assert.equal((await patch({employeeId:null})).status,200);
  person=(await f.dashboard()).identities[0];assert.equal(person.employeeId,null);assert.equal(person.realName,null);assert.equal(person.department,null);assert.equal(person.updatedAt,new Date(NOW).toISOString());
  assert.equal((await f.ingest(device,[observed('1001',{realName:'来自插件'})])).status,400);
  assert.equal((await f.ingest(device,[],[event('forged',{department:'来自流水'})])).status,400);
  assert.equal((await f.ingest(device,[],[],{identities:[{platformUserId:'1001',realName:'来自插件'}]})).status,400);
  assert.equal((await f.ingest(device,[],[],{teams:[{spaceId:'t',members:[{platformUserId:'1001',department:'来自名单'}]}]})).status,400);
});

test('manual refresh jobs are admin-created, device-scoped, safely redelivered and completed through explicit results',async t=>{
  const f=await fixture(t);await f.login();
  const create=()=>f.request('/api/sync-requests',{method:'POST',admin:true,body:{}});
  assert.equal((await create()).status,409);
  const a=await f.installation(),b=await f.installation('collector','员工乙'),outside=await f.installation('collector','不在本次范围');
  await f.request(`/api/installations/${outside.id}`,{method:'PATCH',admin:true,body:{enabled:false}});
  await f.ingest(a);
  let status=await (await f.request('/api/collector/status',{token:a.token})).json();assert.equal(status.online,false);assert.equal(status.lastCommandPollAt,null,'successful collection and status reads are not command heartbeats');
  assert.equal((await f.request('/api/sync-requests',{method:'POST',body:{}})).status,401);
  assert.equal((await f.request('/api/sync-requests',{method:'POST',token:a.token,body:{}})).status,403);
  assert.equal((await f.request('/api/sync-requests',{method:'POST',admin:true,body:{command:'execute-script'}})).status,400);
  const response=await create();assert.equal(response.status,200);const job=await response.json();
  assert.equal(job.status,'waiting');assert.equal(job.expiresAt,new Date(NOW+120_000).toISOString());
  assert.deepEqual(job.targets.map(target=>target.installationId),[a.id,b.id]);assert.ok(job.targets.every(target=>!target.online&&target.status==='waiting'));
  assert.equal((await (await create()).json()).id,job.id,'repeat clicks reuse the active request');
  const route=`/api/sync-requests/${job.id}`,resultRoute=`/api/collector/commands/${job.id}/result`;
  assert.equal((await f.request(route,{token:a.token})).status,403);
  assert.equal((await f.request('/api/collector/commands',{admin:true})).status,401);
  assert.equal((await f.request(resultRoute,{method:'POST',token:a.token,body:{status:'completed'}})).status,409,'a device must claim its own command before reporting');
  await f.request(`/api/installations/${outside.id}`,{method:'PATCH',admin:true,body:{enabled:true}});
  const outsiderCommands=await (await f.request('/api/collector/commands',{token:outside.token})).json();assert.deepEqual(outsiderCommands.commands,[]);
  assert.equal((await f.request(resultRoute,{method:'POST',token:outside.token,body:{status:'completed'}})).status,403,'an installation enabled after creation cannot claim another target');
  const commands=await (await f.request('/api/collector/commands',{token:a.token})).json();
  assert.deepEqual(commands.commands,[{type:'refresh',requestId:job.id,createdAt:job.createdAt,expiresAt:job.expiresAt}]);assert.equal(commands.polledAt,new Date(NOW).toISOString());
  assert.equal(JSON.stringify(commands).includes(b.id),false,'collector command responses contain no other device details');
  assert.deepEqual((await (await f.request('/api/collector/commands',{token:a.token})).json()).commands,commands.commands,'unacknowledged commands may be redelivered after worker restart');
  let current=await (await f.request(route,{admin:true})).json();assert.equal(current.status,'running');assert.equal(current.targets[0].online,true);assert.equal(current.targets[1].online,false);
  for(const body of [{status:'completed',startedAt:job.createdAt},{status:'running'},{status:'completed',message:'cookie=do-not-store'},{status:'failed',message:'x'.repeat(161)},{status:'failed',rawHeaders:{}}])assert.equal((await f.request(resultRoute,{method:'POST',token:a.token,body})).status,400);
  const success=await f.request(resultRoute,{method:'POST',token:a.token,body:{status:'completed',message:'已完成读取并同步'}});assert.equal(success.status,200);assert.deepEqual(await success.json(),{accepted:true,requestId:job.id,status:'completed'});
  assert.equal((await f.request(resultRoute,{method:'POST',token:a.token,body:{status:'completed',message:'重复回报'}})).status,200);
  assert.equal((await f.request(resultRoute,{method:'POST',token:a.token,body:{status:'failed'}})).status,409);
  assert.deepEqual((await (await f.request('/api/collector/commands',{token:a.token})).json()).commands,[]);
  await f.request('/api/collector/commands',{token:b.token});
  assert.equal((await f.request(resultRoute,{method:'POST',token:b.token,body:{status:'no_open_tabs',message:'未打开即梦页面'}})).status,200);
  current=await (await f.request(route,{admin:true})).json();assert.equal(current.status,'partial');assert.deepEqual(current.targets.map(target=>target.status),['completed','no_open_tabs']);assert.ok(current.targets.every(target=>target.finishedAt));
  assert.notEqual((await (await create()).json()).id,job.id,'a finished request does not block a new refresh');
  for(const [path,method] of [['/api/collector/commands','GET'],[resultRoute,'POST']]){
    const preflight=await f.request(path,{method:'OPTIONS',headers:{Origin:EXTENSION_ORIGIN,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'authorization,content-type'}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),method);
  }
});

test('command heartbeat, offline waiting and two-minute deadlines are independent from collection freshness',async t=>{
  let time=NOW;const f=await fixture(t,{clock:()=>time});await f.login();const device=await f.installation();
  const create=async()=> (await f.request('/api/sync-requests',{method:'POST',admin:true,body:{}})).json();
  const poll=()=>f.request('/api/collector/commands',{token:device.token});
  const read=async job=>(await f.request(`/api/sync-requests/${job.id}`,{admin:true})).json();
  const result=(job,status)=>f.request(`/api/collector/commands/${job.id}/result`,{method:'POST',token:device.token,body:{status}});
  const offline=await create();assert.equal(offline.targets[0].status,'waiting');
  time+=120_000;let ended=await read(offline);assert.equal(ended.status,'timed_out');assert.equal(ended.targets[0].startedAt,null);assert.equal(ended.targets[0].finishedAt,offline.expiresAt);
  assert.deepEqual((await (await poll()).json()).commands,[],'expired commands are never delivered');
  const running=await create();await poll();
  assert.equal((await f.dashboard()).installations[0].online,true);
  time+=61_000;await f.ingest(device,[],[],{observedAt:new Date(time).toISOString()});
  let installation=(await f.dashboard()).installations[0];assert.equal(installation.online,false);assert.equal(installation.lastSeenAt,new Date(time).toISOString());assert.notEqual(installation.lastCommandPollAt,installation.lastSeenAt);
  assert.equal((await read(running)).status,'running');assert.equal((await create()).id,running.id);
  time+=59_000;ended=await read(running);assert.equal(ended.status,'timed_out');assert.equal(ended.targets[0].status,'timed_out');assert.equal((await result(running,'completed')).status,409);
  for(const [outcome,expected] of [['completed','completed'],['partial','partial'],['failed','failed'],['no_open_tabs','failed']]){
    const job=await create();await poll();assert.equal((await result(job,outcome)).status,200);assert.equal((await read(job)).status,expected);
  }
  await f.request(`/api/installations/${device.id}`,{method:'PATCH',admin:true,body:{enabled:false}});
  installation=(await f.dashboard()).installations[0];assert.equal(installation.online,false);assert.equal((await poll()).status,401);
});

test('team balance freshness advances only for an explicit balance observation, including legacy records',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const update=(observedAt,team)=>f.ingest(device,[],[],{observedAt,teams:[{spaceId:'freshness-team',...team}]});
  const readTeam=async()=> (await f.dashboard()).teams.find(team=>team.spaceId==='freshness-team');
  assert.equal((await update(OBS,{name:'仅团队资料'})).status,200);
  let team=await readTeam();assert.equal(team.totalBalance,null);assert.equal(team.balanceObservedAt,null);
  const balanceTime='2026-09-12T09:05:00.000Z';
  assert.equal((await update(balanceTime,{totalBalance:1200})).status,200);
  team=await readTeam();assert.equal(team.totalBalance,1200);assert.equal(team.balanceObservedAt,balanceTime);
  const metadataTime='2026-09-12T09:10:00.000Z';
  assert.equal((await update(metadataTime,{name:'成员资料刷新',members:[{platformUserId:'member-1',role:'member'}]})).status,200);
  team=await readTeam();assert.equal(team.observedAt,metadataTime);assert.equal(team.totalBalance,1200);assert.equal(team.balanceObservedAt,balanceTime,'roster updates retain the time of the actual balance observation');
  assert.equal((await update(metadataTime,{totalBalance:0,observedAt:'2026-09-12T09:07:00.000Z'})).status,200);
  team=await readTeam();assert.equal(team.totalBalance,1200);assert.equal(team.balanceObservedAt,balanceTime,'older snapshots cannot overwrite or retime the balance');
  const unknownTime='2026-09-12T09:15:00.000Z';
  assert.equal((await update(unknownTime,{totalBalance:null})).status,200);
  team=await readTeam();assert.equal(team.totalBalance,null);assert.equal(team.balanceObservedAt,unknownTime,'explicit unknown is itself an observation');
  assert.equal((await update('2026-09-12T09:20:00.000Z',{allocatableBalance:0})).status,200);
  team=await readTeam();assert.equal(team.totalBalance,null);assert.equal(team.balanceObservedAt,unknownTime);
  assert.equal((await update('2026-09-12T09:25:00.000Z',{balanceObservedAt:OBS})).status,400,'collectors cannot supply the derived timestamp');

  await f.ingest(device,[],[],{teams:[{spaceId:'legacy-team',totalBalance:0}]});
  const legacyDb=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  const legacy=JSON.parse(legacyDb.prepare('SELECT data FROM teams WHERE space_id=?').get('legacy-team').data);
  delete legacy.balanceObservedAt;
  legacyDb.prepare('UPDATE teams SET data=? WHERE space_id=?').run(JSON.stringify(legacy),'legacy-team');legacyDb.close();
  assert.equal((await f.dashboard()).teams.find(team=>team.spaceId==='legacy-team').balanceObservedAt,OBS,'legacy zero is a known balance with its original observation time');
  await f.ingest(device,[],[],{observedAt:metadataTime,teams:[{spaceId:'legacy-team',name:'旧记录资料刷新'}]});
  const migrated=(await f.dashboard()).teams.find(team=>team.spaceId==='legacy-team');
  assert.equal(migrated.totalBalance,0);assert.equal(migrated.observedAt,metadataTime);assert.equal(migrated.balanceObservedAt,OBS,'legacy timestamp is preserved before applying new metadata');
});

test('team allowlists, numeric constraints, collection limits and incomplete coverage cannot erase known rosters',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  const submit=teams=>f.ingest(device,[],[],{teams});
  assert.equal((await submit([{spaceId:'t',cookies:'never-store'}])).status,400);
  assert.equal((await submit([{spaceId:'t',members:[{platformUserId:'u',installationId:'fake'}]}])).status,400);
  assert.equal((await submit([{spaceId:'t',members:[{platformUserId:'u',role:'owner'}]}])).status,400);
  assert.equal((await submit([{spaceId:'t',members:[{platformUserId:'u'},{platformUserId:'u'}]}])).status,400);
  assert.equal((await submit([{spaceId:'t',membersComplete:true}])).status,400);
  assert.equal((await submit([{spaceId:'t',membersComplete:true,members:null}])).status,400);
  assert.equal((await submit([{spaceId:'t',membersComplete:null}])).status,400);
  assert.equal((await submit([{spaceId:'t',totalSeats:2.5}])).status,400);
  assert.equal((await submit([{spaceId:'t',totalSeats:2,availableSeats:3}])).status,400);
  assert.equal((await submit([{spaceId:'t',totalBalance:-1}])).status,400);
  assert.equal((await submit([{spaceId:'t',members:[{platformUserId:'u',usedCredits:'100'}]}])).status,400);
  assert.equal((await submit([{spaceId:'t',observedAt:'2026-09-12T09:01:00.000Z'}])).status,400);
  assert.equal((await submit(Array.from({length:101},(_,i)=>({spaceId:`t${i}`})))).status,400);
  assert.equal((await submit([{spaceId:'t',members:Array.from({length:501},(_,i)=>({platformUserId:`u${i}`}))}])).status,400);
  assert.equal((await submit(null)).status,400);assert.deepEqual((await f.dashboard()).teams,[]);
  const members=Array.from({length:500},(_,i)=>({platformUserId:`u${i}`}));
  assert.equal((await submit([{spaceId:'limit-team',membersComplete:true,members}])).status,200);
  assert.equal((await f.ingest(device,[],[],{observedAt:'2026-09-12T09:10:00.000Z',teams:[{spaceId:'limit-team',members:[{platformUserId:'one-too-many'}]}]})).status,400);
  const team=(await f.dashboard()).teams[0];assert.equal(team.members.length,500);assert.equal(team.membersComplete,true,'a failed partial update is atomic');
});

test('formal service rejects demo data and preserves real data across restart and schema migration',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.request('/api/dashboard?mode=demo',{admin:true})).status,400);
  for(const route of ['/preview-data.json','/preview-demo.json?stale=1','/preview%2Ddata.json'])for(const method of ['GET','HEAD'])assert.equal((await f.request(route,{method})).status,404);
  assert.equal((await f.dashboard()).accounts.length,0);
  const device=await f.installation();await f.ingest(device,[observed()],[event()],{teams:[{spaceId:'persistent-team',members:[{platformUserId:'unlogged-member'}]}]});
  const persistedEmployee=await f.employee('持久保存的员工');
  assert.equal((await f.request('/api/identities/1001',{method:'PATCH',admin:true,body:{employeeId:persistedEmployee.id}})).status,200);
  const pendingSync=await (await f.request('/api/sync-requests',{method:'POST',admin:true,body:{}})).json();
  assert.equal((await (await f.request('/api/collector/commands',{token:device.token})).json()).commands[0].requestId,pendingSync.id);
  await f.app.close();
  // Simulate the previous schema to check additive migration without losing live data.
  const legacyDb=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  legacyDb.exec('ALTER TABLE accounts DROP COLUMN membership_snapshot_at');legacyDb.close();
  const restarted=createApp({dataDir:f.dataDir,clock:()=>NOW});await restarted.start(0);
  t.after(()=>restarted.close());
  // The same scoped token persists through restarts, unlike browser admin sessions.
  const origin=`http://127.0.0.1:${restarted.server.address().port}`;
  const status=await fetch(origin+'/api/collector/status',{headers:{Authorization:`Bearer ${device.token}`,Origin:EXTENSION_ORIGIN}});
  assert.equal(status.status,200);assert.equal((await status.json()).lastSeenAt,'2026-09-12T10:00:00.000Z');
  const response=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:readFileSync(path.join(f.dataDir,'admin-secret'),'utf8')})});
  const persisted=await (await fetch(origin+'/api/dashboard',{headers:{Cookie:response.headers.get('set-cookie').split(';')[0]}})).json();
  assert.equal(persisted.accounts.length,1);assert.equal(persisted.transactions.length,1);assert.ok(persisted.accounts.every(a=>a.source==='live'));
  assert.equal(persisted.teams.length,1);assert.equal(persisted.teams[0].members[0].platformUserId,'unlogged-member');assert.equal(persisted.installations[0].accountCount,1);
  assert.equal(persisted.identities.find(person=>person.platformUserId==='1001').realName,'持久保存的员工');assert.equal(persisted.identities.find(person=>person.platformUserId==='1001').department,'教研');assert.equal(persisted.identities.find(person=>person.platformUserId==='unlogged-member').realName,null);
  const commandHeaders={Authorization:`Bearer ${device.token}`,Origin:EXTENSION_ORIGIN};
  const redelivery=await (await fetch(origin+'/api/collector/commands',{headers:commandHeaders})).json();assert.equal(redelivery.commands[0].requestId,pendingSync.id,'a claimed command survives server restart and can be redelivered');
  assert.equal((await fetch(origin+`/api/collector/commands/${pendingSync.id}/result`,{method:'POST',headers:{...commandHeaders,'Content-Type':'application/json'},body:JSON.stringify({status:'completed'})})).status,200);
  const completedSync=await (await fetch(origin+`/api/sync-requests/${pendingSync.id}`,{headers:{Cookie:response.headers.get('set-cookie').split(';')[0]}})).json();assert.equal(completedSync.status,'completed');assert.equal(completedSync.targets[0].startedAt,pendingSync.createdAt);
  await restarted.close();
});

test('legacy migration leaves unobserved membership open while protecting existing metadata without an observation timestamp',async t=>{
  const f=await fixture(t);await f.login();const device=await f.installation();
  await f.ingest(device,[observed('1001'),observed('1002')]);await f.app.close();
  const legacyDb=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  legacyDb.exec('ALTER TABLE accounts DROP COLUMN membership_snapshot_at');
  for(const row of legacyDb.prepare('SELECT id,data FROM accounts').all()){
    const data=JSON.parse(row.data);
    for(const key of ['membershipPlan','billingCycle','membershipExpiresAt','nextRenewalAt','subscriptionObservedAt'])delete data[key];
    if(data.platformUserId==='1002')data.membershipPlan='已经记录的会员';
    legacyDb.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
  }
  legacyDb.close();
  const restarted=createApp({dataDir:f.dataDir,clock:()=>NOW}),origin=await restarted.start(0);t.after(()=>restarted.close());
  const earlier='2026-09-12T08:30:00.000Z';
  const response=await fetch(origin+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${device.token}`,Origin:EXTENSION_ORIGIN},body:JSON.stringify({observedAt:earlier,accounts:[observed('1001',{balance:null,membershipPlan:'首次合法会员观察',subscriptionObservedAt:earlier}),observed('1002',{balance:null,membershipPlan:'更旧的会员观察',subscriptionObservedAt:earlier})],transactions:[]})});
  assert.equal(response.status,200);
  const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:readFileSync(path.join(f.dataDir,'admin-secret'),'utf8')})});
  const data=await (await fetch(origin+'/api/dashboard',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}})).json();
  assert.equal(data.accounts.find(a=>a.platformUserId==='1001').membershipPlan,'首次合法会员观察','a newer balance does not invent a membership watermark');
  assert.equal(data.accounts.find(a=>a.platformUserId==='1002').membershipPlan,'已经记录的会员','legacy metadata without its own timestamp is protected conservatively');
  assert.ok(data.accounts.every(a=>a.balance===100&&a.lastSyncedAt===OBS));
  await restarted.close();
});
