import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync,strFromU8 } from 'fflate';
import { createApp } from '../server/index.mjs';

const password='仅用于测试的密码-2026',replacement='替换后的测试密码-2026';
async function fixture(t,options={}){
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jimeng-password-'));let now=Date.parse('2026-09-15T03:00:00.000Z');
  const app=createApp({dataDir,clock:()=>now,...options}),origin=await app.start(0);t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const secret=readFileSync(path.join(dataDir,'admin-secret'),'utf8');
  const call=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const login=async body=>{const response=await call('/api/admin/login','POST',body);return {response,headers:response.status===200?{Cookie:response.headers.get('set-cookie').split(';')[0],Origin:origin}:{}};};
  return {app,dataDir,origin,secret,call,login,advance:ms=>{now+=ms;}};
}

test('administrator password is separate from collector encryption, persists, and revokes other browser sessions',async t=>{
  const f=await fixture(t);const a=await f.login({secret:f.secret}),b=await f.login({secret:f.secret});assert.equal(a.response.status,200);assert.equal(b.response.status,200);
  assert.equal((await (await f.call('/api/dashboard','GET',undefined,b.headers)).json()).adminPasswordConfigured,false);
  assert.equal((await f.login({password})).response.status,401);
  assert.equal((await f.login({password:f.secret})).response.status,200,'existing administrator key remains a first-login password until a separate password is configured');
  const department=await (await f.call('/api/departments','POST',{name:'教研'},b.headers)).json();
  const employee=await (await f.call('/api/employees','POST',{name:'测试员工',departmentId:department.id},b.headers)).json();
  const device=await (await f.call('/api/installations','POST',{employeeId:employee.id,role:'collector'},b.headers)).json();
  const zip=await f.call(`/api/installations/${device.id}/extension.zip`,'GET',undefined,b.headers),files=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const {token}=JSON.parse(strFromU8(files['provision.json'])),collector={Authorization:`Bearer ${token}`,Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
  assert.equal((await f.call('/api/admin/password','POST',{password})).status,401);
  assert.equal((await f.call('/api/admin/password','POST',{password},collector)).status,403);
  assert.equal((await f.call('/api/admin/password','POST',{password},{Cookie:b.headers.Cookie})).status,403);
  for(const invalid of ['short','a'.repeat(129),'中'.repeat(100),null,123])assert.equal((await f.call('/api/admin/password','POST',{password:invalid},b.headers)).status,400);
  const saved=await f.call('/api/admin/password','POST',{password},b.headers);assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{configured:true});
  assert.equal((await f.call('/api/dashboard','GET',undefined,a.headers)).status,401);assert.equal((await f.call('/api/dashboard','GET',undefined,b.headers)).status,200);
  assert.equal((await f.login({password})).response.status,200);assert.equal((await f.login({password:'another-password'})).response.status,401);
  assert.equal((await f.login({password:f.secret})).response.status,401,'a configured login password replaces the bootstrap password');
  assert.equal((await f.login({password,secret:f.secret})).response.status,400);
  const settings=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));const stored=settings.prepare('SELECT value FROM admin_settings WHERE key=?').get('login_password').value;
  assert.equal(stored.includes(password),false);assert.equal(JSON.parse(stored).algorithm,'scrypt-v1');settings.close();
  assert.equal(readFileSync(path.join(f.dataDir,'admin-secret'),'utf8'),f.secret);assert.equal((await f.call('/api/collector/status','GET',undefined,collector)).status,200);
  await f.call('/api/admin/password','POST',{password:replacement},b.headers);
  assert.equal((await f.login({password})).response.status,401);assert.equal((await f.login({password:replacement})).response.status,200);
  await f.call('/api/collector-release/publish','POST',{},b.headers);
  await f.app.close();
  const restarted=createApp({dataDir:f.dataDir}),origin=await restarted.start(0);t.after(()=>restarted.close());
  const response=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:replacement})});assert.equal(response.status,200);
  const snapshot=await (await fetch(origin+'/api/dashboard',{headers:{Cookie:response.headers.get('set-cookie').split(';')[0]}})).json();assert.equal(snapshot.adminPasswordConfigured,true);assert.equal(snapshot.collectorRelease.announcedVersion,snapshot.collectorRelease.version);
  assert.equal((await fetch(origin+'/api/collector/status',{headers:collector})).status,200);
  const serialized=JSON.stringify(snapshot);assert.equal(serialized.includes(replacement),false);assert.equal(serialized.includes(JSON.parse(stored).hash),false);
});

test('password attempts retain login throttling and management routes stay off the public collector origin',async t=>{
  const f=await fixture(t),admin=await f.login({secret:f.secret});await f.call('/api/admin/password','POST',{password},admin.headers);
  for(let index=0;index<10;index++)assert.equal((await f.login({password:'wrong-password'})).response.status,401);
  assert.equal((await f.login({password})).response.status,429);f.advance(15*60_000+1);assert.equal((await f.login({password})).response.status,200);
  const configured=createApp({dataDir:f.dataDir,managementOrigin:'http://192.0.2.10:18419',publicOrigin:'http://198.51.100.10:18418'}),base=await configured.start(0);t.after(()=>configured.close());
  const publicStatus=(route,method='POST')=>new Promise((resolve,reject)=>{const request=http.request(base+route,{method,headers:{Host:'198.51.100.10:18418','Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end(method==='POST'?'{}':undefined);});
  for(const route of ['/api/admin/password','/api/admin/login','/api/collector-release/publish'])assert.equal(await publicStatus(route),404);
  assert.equal(await publicStatus('/api/collector/extension.zip','GET'),401,'public package route still requires scoped collector authentication');
});
