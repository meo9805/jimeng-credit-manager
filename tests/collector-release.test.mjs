import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync,strFromU8 } from 'fflate';
import { createApp } from '../server/index.mjs';

test('release status uses reported versions, numeric comparisons, delayed-log ordering and administrator-only fleet access',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'jimeng-release-')),dataDir=path.join(directory,'data'),extensionDir=path.join(directory,'extension');mkdirSync(extensionDir);
  const manifest=path.join(extensionDir,'manifest.json');const publish=version=>writeFileSync(manifest,JSON.stringify({manifest_version:3,name:'test',version}));publish('0.2.10');
  const now=Date.parse('2026-09-15T02:00:00.000Z'),app=createApp({dataDir,extensionDir,clock:()=>now}),origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const call=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const login=await call('/api/admin/login','POST',{secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8')});const admin={Cookie:login.headers.get('set-cookie').split(';')[0]};
  const department=await (await call('/api/departments','POST',{name:'教研'},admin)).json();
  const employee=await (await call('/api/employees','POST',{name:'测试员工',departmentId:department.id},admin)).json();
  const devices=[];
  for(const version of [null,'0.2.9','0.2.10','0.3.0','0.2.10.0']){
    const device=await (await call('/api/installations','POST',{employeeId:employee.id,role:'collector'},admin)).json();
    const zip=await call(`/api/installations/${device.id}/extension.zip`,'GET',undefined,admin);const files=unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const {token}=JSON.parse(strFromU8(files['provision.json'])),headers={Authorization:`Bearer ${token}`,Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
    if(version)assert.equal((await call('/api/collector/diagnostics','POST',{logs:[{id:'version-event-1',at:new Date(now-1000).toISOString(),code:'collector_started',extensionVersion:version}]},headers)).status,200);
    devices.push({...device,headers,version});
  }
  let response=await call('/api/dashboard','GET',undefined,admin),dashboard=await response.json();
  assert.deepEqual(dashboard.collectorRelease,{version:'0.2.10',distribution:'unpacked',announcedVersion:null,announcedAt:null});
  for(const device of devices){const row=dashboard.installations.find(item=>item.id===device.id);assert.equal(row.extensionVersion,device.version);assert.equal(row.versionUnknown,device.version===null);assert.equal(row.updateAvailable,device.version==='0.2.9');}
  const current=devices[2];
  await call('/api/collector/diagnostics','POST',{logs:[{id:'late-old-version',at:new Date(now-60_000).toISOString(),code:'collector_started',extensionVersion:'0.1.0'}]},current.headers);
  const status=await (await call('/api/collector/status','GET',undefined,current.headers)).json();assert.equal(status.extensionVersion,'0.2.10');assert.equal(status.updateAvailable,false);assert.equal(status.extensionVersionObservedAt,new Date(now-1000).toISOString());
  publish('0.3.1');
  dashboard=await (await call('/api/dashboard','GET',undefined,admin)).json();assert.equal(dashboard.collectorRelease.version,'0.3.1');assert.equal(dashboard.installations.find(row=>row.id===current.id).updateAvailable,true,'backend package changes are visible without inventing a device update');
  assert.equal((await call('/api/dashboard')).status,401);assert.equal((await call('/api/dashboard','GET',undefined,current.headers)).status,403);assert.equal((await call('/api/collector/status')).status,401);
  const ownedStatus=await (await call('/api/collector/status','GET',undefined,current.headers)).json();assert.deepEqual(ownedStatus.extensionRelease,dashboard.collectorRelease);assert.equal(ownedStatus.installations,undefined);
  const publishRoute='/api/collector-release/publish';
  assert.equal((await call(publishRoute,'POST',{},current.headers)).status,403);
  assert.equal((await call(publishRoute,'POST',{},admin)).status,403,'publishing requires explicit same-origin request');
  assert.equal((await call(publishRoute,'POST',{version:'99.0.0'},{...admin,Origin:origin})).status,400,'only server packaged versions can be announced');
  const announcement=await (await call(publishRoute,'POST',{},{...admin,Origin:origin})).json();
  assert.equal(announcement.announcedVersion,'0.3.1');assert.equal(announcement.announcedAt,new Date(now).toISOString());
  assert.deepEqual((await (await call('/api/collector/status','GET',undefined,current.headers)).json()).extensionRelease,announcement);
  assert.equal((await call('/api/collector/extension.zip')).status,401);
  assert.equal((await call('/api/collector/extension.zip','GET',undefined,admin)).status,401);
  for(const device of devices.slice(0,2)){
    const downloaded=await call(`/api/collector/extension.zip?installationId=${devices[3].id}`,'GET',undefined,device.headers);
    assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('cache-control'),/no-store/);
    const files=unzipSync(new Uint8Array(await downloaded.arrayBuffer())),own=JSON.parse(strFromU8(files['provision.json']));
    assert.equal(own.installationId,device.id);assert.equal(`Bearer ${own.token}`,device.headers.Authorization);assert.equal(JSON.parse(strFromU8(files['manifest.json'])).version,'0.3.1');
  }
  const preflight=await call('/api/collector/extension.zip','OPTIONS',undefined,{Origin:current.headers.Origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'GET');
  await call(`/api/installations/${current.id}`,'PATCH',{enabled:false},admin);assert.equal((await call('/api/collector/extension.zip','GET',undefined,current.headers)).status,401);
});
