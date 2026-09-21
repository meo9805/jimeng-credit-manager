import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_UPDATE_BYTES,newerVersion,publishedUpdate,readUpdateZip} from '../extension/manual-update.mjs';

const announced=(version,extra={})=>({version,distribution:'unpacked',announcedVersion:version,announcedAt:'2026-09-15T02:00:00.000Z',...extra});
test('update prompts require an explicitly published newer numeric version',()=>{
  assert.equal(newerVersion('0.2.10','0.2.9'),true);
  assert.equal(newerVersion('0.2.4.0','0.2.4'),false);
  assert.equal(newerVersion('0.2.3','0.2.4'),false);
  assert.equal(newerVersion('0.2.999999','0.2.4'),false);
  assert.equal(newerVersion('https://example.test','0.2.4'),false);
  assert.equal(publishedUpdate(announced('0.2.5',{announcedVersion:null}),'0.2.4'),null);
  assert.equal(publishedUpdate(announced('0.2.5',{announcedVersion:'0.2.4'}),'0.2.4'),null);
  assert.equal(publishedUpdate(announced('0.2.5',{distribution:'other'}),'0.2.4'),null);
  assert.equal(publishedUpdate(announced('0.2.4'),'0.2.4'),null);
  assert.deepEqual(publishedUpdate(announced('0.2.5',{endpoint:'private value',token:'private fixture'}),'0.2.4'),announced('0.2.5'));
});
test('update ZIP reader enforces streamed and declared size bounds and rejects non-ZIP content',async()=>{
  assert.equal(await readUpdateZip(new Response(Uint8Array.from([0x50,0x4b,3,4,1,2]))),'UEsDBAEC');
  await assert.rejects(()=>readUpdateZip(new Response('not a ZIP')),/格式/);
  await assert.rejects(()=>readUpdateZip(new Response('small',{headers:{'content-length':String(MAX_UPDATE_BYTES+1)}})),/过大/);
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_UPDATE_BYTES+1));},cancel(){cancelled=true;}});
  await assert.rejects(()=>readUpdateZip(new Response(stream)),/过大/);assert.equal(cancelled,true);
});

let sequence=0;
async function harness(run) {
  const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;
  const storage={},events={},requests=[],badges=[];
  const h={storage,requests,badges,current:'0.2.4',online:true,release:null,
    provision:{endpoint:'http://public.fixture:18418',internalEndpoint:'http://internal.fixture:18418',token:'scoped-fixture-token',installationId:'fixture-installation',role:'employee'}};
  const event=name=>({addListener(handler){events[name]=handler;}});
  globalThis.chrome={
    runtime:{id:'manual-test',getURL:path=>'chrome-extension://manual-test/'+path,getManifest:()=>({version:h.current}),onInstalled:event('install'),onStartup:event('startup'),onMessage:event('message')},
    storage:{local:{async get(keys){return structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,storage[key]])));},async set(values){Object.assign(storage,structuredClone(values));}}},
    action:{async setBadgeText({text}){badges.push(text);},async setBadgeBackgroundColor(){}},
    alarms:{create(){},onAlarm:event('alarm')},
    tabs:{async query(){return [];},onUpdated:event('updated'),onRemoved:event('removed'),onActivated:event('activated')},
    scripting:{async executeScript(){throw new Error('unexpected page read');}},
  };
  globalThis.fetch=async(url,options={})=>{
    if(url.endsWith('/provision.json'))return Response.json(h.provision);
    requests.push({url,options});
    if(h.transport){const override=await h.transport(url,options);if(override)return override;}
    if(!h.online)throw new Error('fixture offline');
    if(url.endsWith('/api/collector/status'))return Response.json({extensionRelease:h.release});
    if(url.endsWith('/api/collector/commands'))return Response.json({commands:[]});
    if(url.endsWith('/api/collector/diagnostics'))return Response.json({accepted:true});
    if(url.endsWith('/api/collector/extension.zip'))return new Response(Uint8Array.from([0x50,0x4b,3,4,1,2]),{headers:{'content-type':'application/zip'}});
    throw new Error('unexpected route');
  };
  h.message=message=>new Promise(resolve=>events.message(typeof message==='string'?{type:message}:message,{id:'manual-test',url:'chrome-extension://manual-test/popup.html'},resolve));
  try {h.worker=await import('../extension/background.mjs?manual-update='+ ++sequence);await run(h);}
  finally {await h.worker.flushDiagnostics();globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;}
}
test('regular command polling shows the update badge only after publication and clears it after upgrade',()=>harness(async h=>{
  await h.worker.pollCommands({force:true});assert.equal(h.badges.at(-1),'');
  h.release=announced('0.2.5',{announcedVersion:null});await h.worker.pollCommands({force:true});
  assert.equal(h.storage.extensionUpdate,null);assert.equal(h.badges.at(-1),'');
  h.release=announced('0.2.5');await h.worker.pollCommands({force:true});
  assert.equal(h.storage.extensionUpdate.version,'0.2.5');assert.equal(h.badges.at(-1),'↑');
  const popup=await h.message('popup-status');assert.equal(popup.update.version,'0.2.5');
  assert.equal(JSON.stringify(popup).includes('http'),false);assert.equal(JSON.stringify(popup).includes(h.provision.token),false);
  h.current='0.2.5';const installed=await h.message('popup-status');assert.equal(installed.update,null);assert.equal(h.badges.at(-1),'');
}));
test('collection failures do not invent a fault badge or clear an available update',()=>harness(async h=>{
  h.release=announced('0.2.5');await h.worker.pollCommands({force:true});assert.equal(h.badges.at(-1),'↑');
  h.online=false;await h.worker.pollCommands({force:true});await h.worker.collect();
  assert.equal(h.badges.includes('!'),false);assert.equal((await h.message('popup-status')).update.version,'0.2.5');
  assert.equal(h.badges.at(-1),'↑');
}));
test('update download authenticates only the current installation route, supports fallback and returns no address or token fields',()=>harness(async h=>{
  h.release=announced('0.2.5');
  h.transport=async url=>{if(url.startsWith(h.provision.endpoint))throw new Error('fixture public route unavailable');};
  const response=await h.message({type:'download-update',installationId:'attempted-other-device'});
  assert.deepEqual(response,{ok:true,version:'0.2.5',filename:'jimeng-credit-manager-v0.2.5.zip',base64:'UEsDBAEC'});
  const downloads=h.requests.filter(request=>request.url.endsWith('/api/collector/extension.zip'));
  assert.equal(downloads.length,1);assert.equal(downloads[0].url,h.provision.internalEndpoint+'/api/collector/extension.zip');
  assert.equal(downloads[0].options.headers.Authorization,'Bearer '+h.provision.token);
  assert.equal(downloads[0].options.credentials,'omit');assert.equal(downloads[0].options.redirect,'error');
  assert.equal(downloads[0].options.body,undefined);
  assert.equal(JSON.stringify(response).includes(h.provision.token),false);assert.equal(JSON.stringify(response).includes('http'),false);
  assert.equal(JSON.stringify(h.storage.diagnostics).includes(h.provision.token),false);assert.equal(JSON.stringify(h.storage.diagnostics).includes('http'),false);
}));
test('unannounced releases cannot trigger a download and rejected ZIP responses return a generic error',()=>harness(async h=>{
  h.release=announced('0.2.5',{announcedVersion:null});assert.equal((await h.message('download-update')).ok,false);
  assert.equal(h.requests.some(request=>request.url.endsWith('/api/collector/extension.zip')),false);
  h.release=announced('0.2.5');h.transport=async url=>url.endsWith('/api/collector/extension.zip')?new Response('private fixture URL or token content'):null;
  const response=await h.message('download-update');assert.deepEqual(response,{ok:false,error:'新版插件暂时无法下载，请稍后重试。'});
}));
