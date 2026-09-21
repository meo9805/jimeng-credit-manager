import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../server/index.mjs';
import { createStore } from '../server/store.mjs';
import { installOperationWatcher } from '../extension/operation-watcher.mjs';

const realFetch=globalThis.fetch;

let sequence=0;
const raw=extra=>({observedAt:new Date().toISOString(),status:'ok',userId:'u1',collectionKey:'u1:personal',accountType:'personal',displayName:'测试',balance:100,records:[],...extra});
const command=id=>({type:'refresh',requestId:id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+120000).toISOString()});
const until=async predicate=>{for(let i=0;i<1000;i++){if(predicate())return;await new Promise(setImmediate);}throw new Error('condition did not settle');};
async function harness(run) {
  const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;
  const events={},storage={},ingested=[],results=[],timeline=[],requests=[],opened=[],diagnosticRequests=[],badges=[];
  const h={storage,ingested,results,timeline,requests,opened,diagnosticRequests,badges,reads:0,online:true,receiptOnline:true,receiptStatus:200,ingestStatus:200,
    provision:{endpoint:'http://127.0.0.1:4318',token:'test-only-token',installationId:'test-device',employeeName:'测试员工'},
    commands:[],tabs:[{id:1,status:'complete'}],read:async()=>raw()};
  const event=name=>({addListener(fn){events[name]=fn;}});
  globalThis.chrome={
    runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getManifest:()=>({version:'0.2.2'}),onInstalled:event('install'),onStartup:event('startup'),onMessage:event('message')},
    storage:{local:{async get(key){return structuredClone(Object.fromEntries((Array.isArray(key)?key:[key]).map(k=>[k,storage[k]])));},async set(value){Object.assign(storage,structuredClone(value));}}},
    tabs:{async query(){return h.tabs;},async create(options){opened.push(options);return {id:99,...options};},onUpdated:event('update'),onRemoved:event('remove'),onActivated:event('activate')},
    alarms:{create(){},onAlarm:event('alarm')},action:{async setBadgeText(value){badges.push(value.text);},async setBadgeBackgroundColor(){}},
    scripting:{async executeScript(args){
      if(args.files)return [];
      if(['installCreditWatcher','installOperationWatcher'].includes(args.func.name))return [{result:{installed:true}}];
      h.reads++;timeline.push('read-'+h.reads);return [{result:await h.read(args,h.reads)}];
    }},
  };
  globalThis.fetch=async(url,options={})=>{
    if(url.includes('provision.json'))return Response.json(h.provision);
    if(url.endsWith('/api/collector/diagnostics')){
      diagnosticRequests.push({url,options});
      if(!h.online)throw new TypeError('diagnostics offline');
      return h.sendDiagnostics ? h.sendDiagnostics(url,options) : Response.json({accepted:true});
    }
    requests.push({url,options});
    if(h.transport){const response=await h.transport(url,options);if(response)return response;}
    if(!h.online)throw new Error('offline');
    if(url.endsWith('/api/collector/commands'))return Response.json({commands:h.commands,polledAt:new Date().toISOString()});
    if(url.includes('/result')){
      timeline.push('receipt');
      if(!h.receiptOnline)throw new Error('receipt offline');
      if(h.receiptStatus!==200)return Response.json({error:'receipt rejected'},{status:h.receiptStatus});
      const body=JSON.parse(options.body);results.push(body);h.commands=h.commands.filter(c=>!url.includes(c.requestId));
      return Response.json({accepted:true});
    }
    if(url.endsWith('/api/ingest')){
      if(h.ingestStatus!==200)return Response.json({error:'rejected'},{status:h.ingestStatus});
      timeline.push('ingest');ingested.push(JSON.parse(options.body));return Response.json({accepted:true});
    }
    return Response.json({});
  };
  h.reload=async()=>{h.worker=await import('../extension/background.mjs?test='+ ++sequence);};
  h.message=(type,sender={id:'test',url:'chrome-extension://test/popup.html'})=>new Promise(resolve=>events.message({type},sender,resolve));
  try {await h.reload();h.events=events;await run(h);}
  finally{await new Promise(setImmediate);await h.worker.flushDiagnostics();globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;}
}
test('offline usage remains durable and drains idempotently after reconnection',()=>harness(async h=>{
  h.online=false;await h.worker.collect();await h.worker.collect();
  assert.equal(h.reads,2);assert.equal(h.storage.pending.length,2);assert.equal(h.storage.state.status,'error');
  h.online=true;await h.worker.collect();
  assert.equal(h.storage.pending.length,0);assert.equal(h.ingested.length,3);assert.equal(h.storage.state.status,'ok');
}));
test('full offline queue keeps older unique records and does not advance the rejected space cursor',()=>harness(async h=>{
  h.online=false;h.read=async(_,n)=>raw({collectionKey:'u1:personal:personal',headEventId:'head-'+n});
  for(let i=0;i<31;i++)await h.worker.collect();
  assert.equal(h.storage.pending.length,30);
  assert.equal(h.storage.scanKeys[1].collections['u1:personal:personal'].eventId,'head-30');
  assert.equal(h.storage.pending[0].observation.observedAt!==undefined,true);
  h.online=true;await h.worker.collect();
  assert.equal(h.ingested.length,31);assert.equal(h.storage.pending.length,0);
}));
test('one browser tab uploads each discovered wallet and preserves independent cursors',()=>harness(async h=>{
  h.read=async()=>({status:'ok',observations:[raw({collectionKey:'u1:personal:personal',headEventId:'p-head',nextCursor:'p-next'}),
    raw({collectionKey:'u1:team:t1:team_total',accountType:'team',teamId:'t1',headEventId:'t-head',nextCursor:'t-next'})]});
  await h.worker.collect();assert.equal(h.ingested.length,2);
  assert.equal(h.storage.scanKeys[1].collections['u1:personal:personal'].cursor,'p-next');
  assert.equal(h.storage.scanKeys[1].collections['u1:team:t1:team_total'].cursor,'t-next');
  let options;h.read=async args=>{options=args.args[0];return raw();};await h.worker.collect();
  assert.equal(options.collectAllSpaces,true);assert.equal(options.previousCollections['u1:team:t1:team_total'].eventId,'t-head');
}));
test('accepted local operation evidence survives offline, strips extra data, and drains without an open tab',()=>harness(async h=>{
  h.online=false;h.tabs=[];
  const operationEvidence={submitId:'submit-1',userId:'u1',spaceType:'personal',spaceId:'personal',occurredAt:new Date().toISOString(),prompt:'must never be uploaded',operatorName:'untrusted'};
  const result=await new Promise(resolve=>h.events.message({type:'operation-evidence',operationEvidence},{id:'test',url:'https://jimeng.jianying.com/ai-tool/home',tab:{id:1}},resolve));
  assert.equal(result.ok,true);await h.worker.collect();
  assert.equal(h.storage.pendingOperationEvidence.length,1);
  assert.equal(h.storage.pendingOperationEvidence[0].prompt,undefined);assert.equal(h.storage.pendingOperationEvidence[0].operatorName,undefined);
  h.online=true;await h.worker.collect();
  assert.equal(h.storage.pendingOperationEvidence.length,0);
  assert.equal(h.ingested.filter(x=>x.operationEvidence?.length).length,1);
  assert.equal(h.ingested[0].operationEvidence[0].submitId,'submit-1');
}));
test('changing the assigned collector isolates pending operation evidence from the previous employee',()=>harness(async h=>{
  h.tabs=[];h.storage.serviceBinding={endpoint:h.provision.endpoint,installationId:'old-device'};
  h.storage.pendingOperationEvidence=[{submitId:'old-operation',userId:'u1',spaceType:'personal',spaceId:'personal',occurredAt:new Date().toISOString()}];
  await h.worker.collect();
  assert.equal(h.storage.pendingOperationEvidence.length,0);assert.equal(h.storage.isolatedOperationEvidence.length,1);
  assert.equal(h.ingested.some(x=>x.operationEvidence?.length),false);
}));
test('operation receipts mean durable storage and valid dotted submission IDs survive a worker restart',()=>harness(async h=>{
  h.online=false;h.tabs=[];
  const evidence={submitId:'submit.1@jimeng',userId:'borrowed-account',spaceType:'team',spaceId:'team.1',occurredAt:new Date().toISOString()};
  const send=()=>new Promise(resolve=>h.events.message({type:'operation-evidence',operationEvidence:evidence},{id:'test',url:'https://jimeng.jianying.com/ai-tool/home',tab:{id:1}},resolve));
  assert.equal((await send()).ok,true);
  assert.deepEqual(h.storage.pendingOperationEvidence,[evidence]);
  await h.worker.collect();await h.reload();
  assert.equal((await send()).ok,true);await h.worker.collect();
  assert.equal(h.storage.pendingOperationEvidence.length,1);
  h.online=true;await h.worker.collect();
  assert.equal(h.storage.pendingOperationEvidence.length,0);
  assert.deepEqual(h.ingested.filter(item=>item.operationEvidence?.length).map(item=>item.operationEvidence),[[evidence]]);
  assert.ok(h.storage.diagnostics.entries.some(item=>item.code==='operation_upload_failed'));
  assert.ok(h.storage.diagnostics.entries.some(item=>item.code==='operation_uploaded'));
}));
test('a failed operation storage write is not acknowledged and a later retry succeeds',()=>harness(async h=>{
  h.tabs=[];h.online=false;await h.worker.collect();
  const storage=globalThis.chrome.storage.local,save=storage.set;let fail=true;
  storage.set=async value=>{if(fail&&value.pendingOperationEvidence)throw new Error('temporary disk failure');return save(value);};
  const evidence={submitId:'storage-retry',userId:'u1',spaceType:'personal',spaceId:'personal',occurredAt:new Date().toISOString()};
  const send=()=>new Promise(resolve=>h.events.message({type:'operation-evidence',operationEvidence:evidence},{id:'test',url:'https://jimeng.jianying.com/ai-tool/home',tab:{id:1}},resolve));
  assert.equal((await send()).ok,false);assert.equal(h.storage.pendingOperationEvidence,undefined);
  fail=false;assert.equal((await send()).ok,true);await h.worker.collect();
  assert.deepEqual(h.storage.pendingOperationEvidence,[evidence]);
  assert.ok(h.storage.diagnostics.entries.some(item=>item.code==='operation_save_failed'));
}));
test('an unacknowledged operation upload retains its evidence until the server accepts',()=>harness(async h=>{
  h.tabs=[];
  const evidence={submitId:'ack-retry',userId:'u1',spaceType:'personal',spaceId:'personal',occurredAt:new Date().toISOString()};
  h.storage.pendingOperationEvidence=[evidence];
  h.transport=async url=>url.endsWith('/api/ingest')?Response.json({accepted:false}):null;
  await h.worker.collect();assert.deepEqual(h.storage.pendingOperationEvidence,[evidence]);
  h.transport=null;await h.worker.collect();assert.deepEqual(h.storage.pendingOperationEvidence,[]);
  assert.equal(h.ingested[0].operationEvidence[0].submitId,'ack-retry');
}));
test('local submit events cross bridge, durable worker queue and authenticated HTTP to identify two employees borrowing one account',()=>harness(async h=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-full-operation-chain-'));
  const app=createApp({dataDir}),origin=await app.start(0);
  const store=createStore({dataDir,secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim()});
  try {
    h.tabs=[];
    const department=store.createDepartment({name:'测试部门'});
    const owner=store.createEmployee({name:'账号归属员工',departmentId:department.id});
    const borrower=store.createEmployee({name:'借用员工',departmentId:department.id});
    const ownerDevice=store.createInstallation({employeeId:owner.id,role:'collector'});
    const borrowerDevice=store.createInstallation({employeeId:borrower.id,role:'collector'});
    const post=async(device,extra)=>{
      const response=await realFetch(origin+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${store.installationToken(device.id)}`},body:JSON.stringify({observedAt:new Date().toISOString(),status:'ok',accounts:[],transactions:[],...extra})});
      assert.equal(response.status,200);assert.equal((await response.json()).accepted,true);
    };
    const transaction=(submitId,eventId=submitId)=>({platformUserId:'shared-account',spaceId:'personal',scope:'personal',eventId,platformSubmitId:submitId,occurredAt:new Date().toISOString(),kind:'consume',amount:-100});
    await post(ownerDevice,{loginIdentity:{platformUserId:'shared-account',displayName:'平台昵称'},transactions:[transaction('before-collector')]});
    // The real fetch, content bridge and service worker code are used; no paid task is generated.
    const submit=submitId=>{
      const listeners=new Map(),created=new Set(),accepted=new Set();
      const page={location:{origin:'https://jimeng.jianying.com'},addEventListener(type,fn){listeners.set(type,fn);},
        postMessage(data,origin){listeners.get('message')?.({source:page,origin,data});},setInterval(){return 1;},clearInterval(){},
        __debugger:{ContentGeneratorTaskFeatureService:{onAigcDataTaskCreated(fn){created.add(fn);return{dispose(){}};},onAigcDataTaskSubmitSuccess(fn){accepted.add(fn);return{dispose(){}};}},
          DreaminaCommercialFeatureService:{commercialCreditService:{isLocalCreditReady:true,getCurrentAccountSnapshot(){return{account:{accountType:'personal',accountKey:'personal'},version:1};}},_commerceAccountPort:{getSnapshot(){return{hasLogin:true,userId:'shared-account'};},subscribe(){return{dispose(){}};}}}}};
      const chrome={runtime:{sendMessage(message){
        if(message.type!=='operation-evidence')return Promise.resolve({ok:true});
        return new Promise(resolve=>h.events.message(message,{id:'test',url:'https://jimeng.jianying.com/ai-tool/home',tab:{id:1}},resolve));
      }}};
      vm.runInNewContext(readFileSync(new URL('../extension/content-bridge.js',import.meta.url),'utf8'),{window:page,location:page.location,chrome,setInterval(){return 1;}});
      vm.runInNewContext(`(${installOperationWatcher.toString()})()`,{window:page});
      const model={idModel:{submitId},prompt:'private prompt must stay in the page'};
      for(const callback of created)callback(model);
      for(const callback of accepted)callback(model);
    };
    for(const [device,submitId] of [[borrowerDevice,'borrowed.1@local'],[ownerDevice,'owner.1@local']]){
      h.provision={endpoint:origin,installationId:device.id,token:store.installationToken(device.id)};
      await h.reload();
      h.transport=async(url,options)=>{if(url.endsWith('/api/ingest'))throw new Error('offline before receipt');};
      submit(submitId);
      await until(()=>h.storage.pendingOperationEvidence?.some(item=>item.submitId===submitId));
      await h.worker.collect();
      // Another reader can upload the charge; that reader is not necessarily its operator.
      await post(ownerDevice,{transactions:[transaction(submitId)]});
      assert.equal(store.dashboard().transactions.find(row=>row.platformSubmitId===submitId).attribution,'unconfirmed');
      await h.reload();h.transport=(url,options)=>url.endsWith('/api/ingest')?realFetch(url,options):null;
      await h.worker.collect();
      const row=store.dashboard().transactions.find(item=>item.platformSubmitId===submitId);
      assert.equal(row.operatorEmployeeId,device.employeeId);assert.equal(row.attribution,'matched');
      assert.equal(row.chargedPlatformUserId,'shared-account');
      assert.equal(h.storage.pendingOperationEvidence.length,0);
    }
    const data=store.dashboard();
    assert.equal(data.identities.find(item=>item.platformUserId==='shared-account').employeeId,owner.id);
    assert.equal(data.transactions.find(item=>item.platformSubmitId==='before-collector').attribution,'unconfirmed');
    assert.equal(data.transactions.filter(item=>item.attribution==='matched').length,2);
    assert.equal(JSON.stringify(data).includes('private prompt'),false);
    await h.worker.flushDiagnostics();
  } finally {store.close();await app.close();rmSync(dataDir,{recursive:true,force:true});}
}));
test('rate-limited uploads retain their queue and retry without changing routes or quarantining valid observations',()=>harness(async h=>{
  h.provision.internalEndpoint='http://example.test:18418';
  h.ingestStatus=429;await h.worker.collect();
  const first=structuredClone(h.storage.pending[0]);
  await h.worker.collect();
  assert.equal(h.storage.pending.length,2);assert.deepEqual(h.storage.pending[0],first);
  assert.equal(h.storage.rejected,undefined);assert.equal(h.ingested.length,0);
  assert.ok(h.requests.filter(request=>request.url.endsWith('/api/ingest')).every(request=>request.url.startsWith(h.provision.endpoint)));
  const pending=structuredClone(h.storage.pending);
  h.ingestStatus=200;await h.worker.collect();
  assert.equal(h.storage.pending.length,0);assert.equal(h.ingested.length,3);
  assert.deepEqual(h.ingested.slice(0,2),JSON.parse(JSON.stringify(pending.map(item=>item.observation))));
}));
test('a verified login identity uploads when the credit read has no fresh member or team balance',()=>harness(async h=>{
  h.read=async()=>raw({userId:'first-login-user',displayName:'首次登录昵称',accountType:'team',teamId:'team-space',
    collectionKey:'first-login-user:team-space',balanceFresh:false,canReadTeamTotal:false,
    balance:null,vipCredit:null,giftCredit:null,purchaseCredit:null,teamTotalCredit:null,records:[],partial:true});
  await h.worker.collect();
  assert.equal(h.reads,1);assert.equal(h.ingested.length,1);
  assert.equal(h.ingested[0].status,'ok');
  assert.deepEqual(h.ingested[0].loginIdentity,{platformUserId:'first-login-user',displayName:'首次登录昵称'});
  assert.deepEqual(h.ingested[0].accounts,[]);assert.deepEqual(h.ingested[0].transactions,[]);
  assert.equal(Object.hasOwn(h.ingested[0],'balance'),false);
  assert.equal(h.storage.state.balance,null);assert.equal(h.storage.pending.length,0);
  assert.equal(h.requests.filter(request=>request.url.endsWith('/api/ingest')).length,1);
}));
test('a command delivered during an old collection waits for a newer fresh read and ingest acknowledgement',()=>harness(async h=>{
  let release;h.read=async(args,n)=>{if(n===1)await new Promise(resolve=>{release=resolve;});return raw({balance:100-n});};
  const old=h.worker.collect();await until(()=>Boolean(release));
  h.commands=[command('new-refresh')];await h.worker.pollCommands({force:true});
  assert.equal(h.reads,1);assert.equal(h.results.length,0);
  release();await old;
  assert.equal(h.reads,2);assert.equal(h.results.length,1);assert.equal(h.results[0].status,'completed');
  assert.deepEqual(h.timeline,['read-1','ingest','read-2','ingest','receipt']);
}));
test('a no-tab command returns no_open_tabs and performs no collection',()=>harness(async h=>{
  h.tabs=[];h.commands=[command('no-tab')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'no_open_tabs');assert.equal(h.reads,0);assert.equal(h.ingested.length,0);
}));
test('one inaccessible tab makes command partial without discarding the working tab',()=>harness(async h=>{
  h.tabs.push({id:2,status:'complete'});h.read=async args=>args.target.tabId===2?raw({status:'error',message:'旧页面不可读'}):raw();
  h.commands=[command('partial')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'partial');assert.equal(h.ingested.length,1);assert.equal(h.storage.state.status,'ok');
}));
test('quarantined observations do not complete a command',()=>harness(async h=>{
  h.ingestStatus=400;h.commands=[command('invalid')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'failed');assert.equal(h.storage.pending.length,0);assert.equal(h.storage.rejected.length,1);
}));
test('lost result delivery persists and retries without another read or command loss',()=>harness(async h=>{
  h.receiptOnline=false;h.commands=[command('retry-result')];await h.worker.pollCommands({force:true});
  await until(()=>h.timeline.includes('receipt'));
  assert.equal(h.storage.commandResults['retry-result'].result.status,'completed');assert.equal(h.results.length,0);
  h.receiptOnline=true;await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.reads,1);assert.equal(h.results[0].status,'completed');assert.deepEqual(h.storage.commandResults,{});
}));
test('an ingest transport failure cannot be reported as completed',()=>harness(async h=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{if(url.endsWith('/api/ingest'))throw new Error('offline upload');return oldFetch(url,options);};
  h.commands=[command('upload-failed')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'failed');assert.equal(h.storage.pending.length,1);
}));
test('a changed sixth tab is read first and subsequent rounds rotate through every tab',()=>harness(async h=>{
  h.tabs=Array.from({length:12},(_,i)=>({id:i+1,status:'complete'}));
  const readTabs=[];h.read=async args=>{readTabs.push(args.target.tabId);return raw();};
  await h.worker.collect({preferredTabId:12});
  assert.equal(readTabs[0],12);assert.equal(readTabs.length,5);
  await h.worker.collect();await h.worker.collect();
  assert.equal(new Set(readTabs).size,12);
}));
test('a capped manual scan reports unread tabs as partial',()=>harness(async h=>{
  h.tabs=Array.from({length:7},(_,i)=>({id:i+1,status:'complete'}));
  h.commands=[command('many-tabs')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'partial');assert.match(h.results[0].message,/2 个即梦页面本轮未读取/);
}));
test('collector requests omit cookies and redirects even with legacy administrator configuration',()=>harness(async h=>{
  h.provision.endpoint='https://collector.example.test';h.provision.dashboardEndpoint='http://example.test:18419';
  h.provision.role='admin';
  await h.worker.collect();
  assert.ok(h.requests.some(r=>r.url===h.provision.endpoint+'/api/ingest'));
  assert.equal(h.requests.some(r=>r.url.includes('/api/admin/')),false);
  assert.equal(h.opened.length,0);
  for(const request of h.requests){assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.Authorization,'Bearer '+h.provision.token);}
}));
test('legacy administrator packages still collect through internal HTTP without a management capability',()=>harness(async h=>{
  h.provision.endpoint='http://example.test:18418';
  h.provision.role='admin';h.provision.dashboardEndpoint='obsolete unused management configuration';
  await h.worker.collect();
  assert.equal(h.ingested.length,1);assert.equal(h.opened.length,0);
  const popup=await h.message('popup-status');
  assert.equal(popup.status,'ok');assert.equal(Object.hasOwn(popup,'isAdmin'),false);
  assert.equal(JSON.stringify(popup).includes('http'),false);
}));
test('explicit packaged public HTTP collector origins are supported without page supplied destinations',()=>harness(async h=>{
  h.provision.endpoint='http://198.51.100.5:18418';
  assert.equal((await h.message('status')).ok,true);
  assert.equal(h.requests[0].url,h.provision.endpoint+'/api/collector/status');
}));
test('configured endpoints cannot contain paths, credentials, queries, fragments or non HTTP schemes',async()=>{
  for(const endpoint of ['https://example.test/nested','https://user:password@example.test','https://example.test?next=x','https://example.test#x','file:///tmp/server'])await harness(async h=>{
    h.provision.endpoint=endpoint;
    assert.equal((await h.message('status')).ok,false);assert.equal(h.requests.length,0);
  });
});
test('a page message cannot override the packaged collector endpoint',()=>harness(async h=>{
  const reply=await new Promise(resolve=>h.events.message({type:'status',endpoint:'https://other.example.test'},
    {id:'test',url:'chrome-extension://test/popup.html'},resolve));
  assert.equal(reply.ok,true);assert.equal(h.requests[0].url,h.provision.endpoint+'/api/collector/status');
}));
test('former dashboard messages are rejected locally for every provision role',async()=>{
  for(const role of ['collector','admin'])await harness(async h=>{
    h.provision.role=role;
    assert.deepEqual(await h.message('open-dashboard'),{ok:false,error:'不支持的操作'});
    assert.equal(h.requests.length,0);assert.equal(h.opened.length,0);
  });
});
test('a Jimeng page cannot invoke popup actions',()=>harness(async h=>{
  const count=h.requests.length;let replied=false;
  const result=h.events.message({type:'open-dashboard'},{id:'test',url:'https://jimeng.jianying.com/ai-tool',tab:{id:1}},()=>{replied=true;});
  await new Promise(setImmediate);
  assert.equal(result,undefined);assert.equal(replied,false);assert.equal(h.requests.length,count);
}));
test('server migration isolates old command receipts, resets watermarks and drains the same employees queued observations',()=>harness(async h=>{
  const pending={observedAt:new Date().toISOString(),status:'error',message:'queued before migration',accounts:[],transactions:[]};
  h.storage.serviceBinding={endpoint:h.provision.endpoint,installationId:h.provision.installationId,employeeName:h.provision.employeeName};
  h.storage.scanKeys={1:{account:'u1:personal',eventId:'old-head'}};
  h.storage.commandResults={'old-server-command':{result:{status:'completed'},expiresAt:command('old').expiresAt}};
  h.storage.pending=[{queueId:'saved-observation',observation:pending}];
  h.provision.endpoint='http://example.test:18418';
  let seenArguments;h.read=async args=>{seenArguments=args.args[0];return raw();};
  await h.worker.collect();
  assert.equal(seenArguments.previousEventId,null);assert.equal(seenArguments.previousAccount,null);
  assert.deepEqual(h.ingested[0],pending);assert.equal(h.storage.pending.length,0);
  assert.equal(h.storage.archivedCommandResults.length,1);assert.deepEqual(h.storage.commandResults,{});
  assert.equal(h.requests.some(r=>r.url.includes('old-server-command')),false);
  assert.equal(h.storage.serviceBinding.endpoint,h.provision.endpoint);
  h.commands=[command('new-server-command')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'completed');
}));
test('first 0.1.2 upgrade preserves unbound pending data but does not trust old receipts or history watermarks',()=>harness(async h=>{
  h.storage.scanKeys={1:{account:'u1:personal',eventId:'old-head'}};
  h.storage.commandResults={'old-command':{result:{status:'completed'}}};
  h.storage.pending=[{observedAt:new Date().toISOString(),status:'error',message:'legacy queue',accounts:[],transactions:[]}];
  h.read=async args=>{assert.equal(args.args[0].previousEventId,null);return raw();};
  await h.worker.collect();
  assert.equal(h.ingested[0].message,'legacy queue');assert.equal(h.storage.pending.length,0);
  assert.equal(h.storage.archivedCommandResults.length,1);assert.deepEqual(h.storage.commandResults,{});
}));
test('a new installation ID isolates the previous queue even when employees share a name',()=>harness(async h=>{
  h.storage.serviceBinding={endpoint:h.provision.endpoint,installationId:'old-device',employeeName:h.provision.employeeName};
  const pending=[{queueId:'previous-owner',observation:{status:'error',accounts:[],transactions:[]}}];
  h.storage.pending=pending;
  await h.worker.collect();
  assert.equal(h.storage.isolatedPending.length,1);assert.deepEqual(h.storage.isolatedPending[0].pending,pending);
  assert.equal(h.ingested.length,1);assert.equal(h.storage.pending.length,0);
}));
test('unchanged collector binding retains scan watermarks and pending receipts across worker restart',()=>harness(async h=>{
  await h.worker.collect();
  h.storage.scanKeys={1:{account:'u1:personal',eventId:'kept-head'}};
  h.storage.commandResults={'existing-command':{result:{status:'completed'},expiresAt:command('existing-command').expiresAt}};
  h.provision.dashboardEndpoint='http://example.test:18419';h.provision.internalEndpoint='http://example.test:18418';await h.reload();
  h.read=async args=>{assert.equal(args.args[0].previousEventId,'kept-head');return raw();};
  await h.worker.collect();
  assert.equal(h.results[0].status,'completed');assert.equal(h.storage.archivedCommandResults,undefined);
}));
for(const status of [404,409])test(`a terminal ${status} receipt does not prevent the next command poll`,()=>harness(async h=>{
  await h.worker.collect();h.storage.commandResults={'retired-request':{result:{status:'completed'}}};h.receiptStatus=status;
  const before=h.requests.filter(r=>r.url.endsWith('/api/collector/commands')).length;
  await h.worker.pollCommands({force:true});
  assert.deepEqual(h.storage.commandResults,{});
  assert.equal(h.requests.filter(r=>r.url.endsWith('/api/collector/commands')).length,before+1);
}));
test('a failed public route falls back to the packaged internal route and retries public after 60 seconds',()=>harness(async h=>{
  h.provision.endpoint='http://198.51.100.5:18418';h.provision.internalEndpoint='http://example.test:18418';
  let publicOffline=true;
  h.transport=async url=>{if(publicOffline && url.startsWith(h.provision.endpoint))throw new TypeError('network failed');};
  assert.equal((await h.message('status')).ok,true);
  assert.deepEqual(h.requests.map(r=>new URL(r.url).origin),[h.provision.endpoint,h.provision.internalEndpoint]);
  assert.equal((await h.message('status')).ok,true);
  assert.equal(new URL(h.requests.at(-1).url).origin,h.provision.internalEndpoint);
  assert.equal(h.requests.length,3);assert.equal(h.storage.serviceBinding.endpoint,h.provision.endpoint);
  const originalNow=Date.now;Date.now=()=>originalNow()+60001;
  try {publicOffline=false;assert.equal((await h.message('status')).ok,true);}
  finally {Date.now=originalNow;}
  assert.equal(new URL(h.requests.at(-1).url).origin,h.provision.endpoint);
}));
test('cached internal route failure can return to the public route',()=>harness(async h=>{
  h.provision.internalEndpoint='http://example.test:18418';
  let failed=h.provision.endpoint;h.transport=async url=>{if(url.startsWith(failed))throw new TypeError('network failed');};
  assert.equal((await h.message('status')).ok,true);
  failed=h.provision.internalEndpoint;assert.equal((await h.message('status')).ok,true);
  assert.deepEqual(h.requests.slice(-2).map(r=>new URL(r.url).origin),[h.provision.internalEndpoint,h.provision.endpoint]);
}));
test('collector command, fresh ingest and receipt use the fallback while preserving acknowledgement order',()=>harness(async h=>{
  h.provision.internalEndpoint='http://example.test:18418';
  h.transport=async url=>{if(url.startsWith(h.provision.endpoint))throw new DOMException('Timed out','TimeoutError');};
  h.commands=[command('fallback-command')];await h.worker.pollCommands({force:true});await until(()=>h.results.length);
  assert.equal(h.results[0].status,'completed');assert.deepEqual(h.timeline,['read-1','ingest','receipt']);
  const paths=h.requests.filter(r=>r.url.startsWith(h.provision.internalEndpoint)).map(r=>new URL(r.url).pathname);
  assert.ok(paths.includes('/api/collector/status'));
  assert.deepEqual(paths.filter(path=>path!=='/api/collector/status'),['/api/collector/commands','/api/ingest','/api/collector/commands/fallback-command/result']);
  const publicPaths=h.requests.filter(r=>r.url.startsWith(h.provision.endpoint)).map(r=>new URL(r.url).pathname);
  assert.ok(publicPaths.includes('/api/collector/status'));
  assert.ok(publicPaths.every(path=>['/api/collector/status','/api/collector/commands'].includes(path)));
  assert.equal(new Set(publicPaths).size,publicPaths.length);
  assert.equal(h.storage.pending.length,0);
}));
for(const status of [502,503,504])test(`gateway ${status} retries the same collector request internally`,()=>harness(async h=>{
  h.provision.internalEndpoint='http://example.test:18418';
  h.transport=async url=>{if(url.startsWith(h.provision.endpoint))return Response.json({error:'gateway'},{status});};
  await h.worker.collect();
  const uploads=h.requests.filter(r=>r.url.endsWith('/api/ingest'));
  assert.equal(uploads.length,2);assert.equal(uploads[0].options.body,uploads[1].options.body);
  assert.equal(uploads[1].options.credentials,'omit');assert.equal(h.ingested.length,1);assert.equal(h.storage.pending.length,0);
}));
test('authorization and other API errors never trigger another route',async()=>{
  for(const status of [400,401,403,409,429,500])await harness(async h=>{
    h.provision.internalEndpoint='http://example.test:18418';
    h.transport=async()=>Response.json({error:'semantic failure'},{status});
    assert.equal((await h.message('status')).ok,false);
    assert.equal(h.requests.length,1);assert.equal(new URL(h.requests[0].url).origin,h.provision.endpoint);
  });
});
test('an invalid configured backup is rejected before any bearer request',()=>harness(async h=>{
  h.provision.internalEndpoint='http://example.test:18418/other-path';
  assert.equal((await h.message('status')).ok,false);assert.equal(h.requests.length,0);
}));
test('diagnostic uploads cannot block fresh collection and do not log their own failures',()=>harness(async h=>{
  let release;h.sendDiagnostics=()=>new Promise(resolve=>{release=resolve;});
  await h.worker.collect();await until(()=>Boolean(release));
  assert.equal(h.ingested.length,1);assert.equal(h.storage.state.status,'ok');
  const pendingBefore=h.storage.diagnostics.pending.length;assert.ok(pendingBefore>0);
  release(Response.json({error:'diagnostics-only outage'},{status:503}));await h.worker.flushDiagnostics();
  assert.equal(h.storage.diagnostics.pending.length,pendingBefore);
  assert.equal(h.storage.diagnostics.entries.some(e=>e.code==='connection_failed'),false);
  assert.equal(h.diagnosticRequests.length,1);
  h.sendDiagnostics=null;await h.worker.pollCommands({force:true});await h.worker.flushDiagnostics();
  assert.equal(h.storage.diagnostics.pending.length,0);assert.ok(h.storage.diagnostics.entries.length>0);
}));
test('partial reads include tab counts while diagnostics exclude raw errors and toolbar alerts',()=>harness(async h=>{
  h.tabs.push({id:2,status:'complete'});h.read=async args=>args.target.tabId===2?raw({status:'error',message:'private-error-fixture'}):raw();
  await h.worker.collect();await h.worker.flushDiagnostics();
  const logs=h.storage.diagnostics.entries,partial=logs.find(e=>e.code==='collection_partial');
  assert.equal(partial.readTabs,1);assert.equal(partial.skippedTabs,1);assert.equal(partial.extensionVersion,'0.2.2');
  assert.equal(JSON.stringify(logs).includes('private-error-fixture'),false);assert.equal(h.badges.includes('!'),false);
  assert.ok(h.diagnosticRequests.every(r=>JSON.parse(r.options.body).logs.length<=50));
}));
test('local popup and diagnostics remain available with invalid configuration and expose no endpoint',()=>harness(async h=>{
  h.provision.endpoint='invalid fixture';
  await h.worker.collect();
  const popup=await h.message('popup-status');assert.equal(popup.ok,true);assert.equal(Object.hasOwn(popup,'isAdmin'),false);
  const data=await h.message('diagnostics');assert.equal(data.ok,true);assert.ok(data.logs.some(e=>e.code==='configuration_invalid'));
  assert.equal(JSON.stringify(data).includes('invalid fixture'),false);assert.equal(h.requests.length,0);
}));
