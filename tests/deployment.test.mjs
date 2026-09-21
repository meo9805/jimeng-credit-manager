import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/index.mjs';

test('public collector cannot expose administration and packages separate the two destinations',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-deploy-'));
  const managementOrigin='http://example.test:18419',publicOrigin='http://public.example.test:18418';
  const app=createApp({dataDir,managementOrigin,publicOrigin,collectorInternalOrigin:'http://example.test:18418'});
  const origin=await app.start(0);
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true})});
  const request=(route,{via=managementOrigin,method='GET',body,cookie,token,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request(origin+route,{method,headers:{Host:new URL(via).host,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`}:{Origin:via}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value]))})));
    });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  for(const via of [publicOrigin,'http://example.test:18418']){
    assert.equal((await request('/api/health',{via})).status,200);
    for(const route of ['/','/api/dashboard','/api/session','/api/departments','/api/employees','/api/admin/login','/api/admin/extension-login','/preview-data.json'])assert.equal((await request(route,{via})).status,404);
    assert.equal((await request('/api/collector/status',{via})).status,401);
  }
  const login=await request('/api/admin/login',{method:'POST',body:{secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8')}});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const departmentResponse=await request('/api/departments',{method:'POST',cookie,body:{name:'管理'}});
  assert.equal(departmentResponse.status,201);const department=await departmentResponse.json();
  const employeeResponse=await request('/api/employees',{method:'POST',cookie,body:{name:'管理员',departmentId:department.id}});
  assert.equal(employeeResponse.status,201);const employee=await employeeResponse.json();
  const deviceResponse=await request('/api/installations',{method:'POST',cookie,body:{employeeId:employee.id}});
  assert.equal(deviceResponse.status,201);const device=await deviceResponse.json();
  const zip=await request(`/api/installations/${device.id}/extension.zip`,{cookie});
  assert.equal(zip.status,200);
  const files=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const provision=JSON.parse(strFromU8(files['provision.json']));
  assert.equal(provision.endpoint,publicOrigin);assert.equal(provision.dashboardEndpoint,undefined);assert.equal(provision.role,'collector');
  assert.equal(provision.internalEndpoint,'http://example.test:18418');
  assert.deepEqual(JSON.parse(strFromU8(files['manifest.json'])).host_permissions,['https://jimeng.jianying.com/*','http://public.example.test/*','http://example.test/*']);
  const token=provision.token,extensionOrigin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const status=await request('/api/collector/status',{via:publicOrigin,token,headers:{Origin:extensionOrigin}});
  assert.equal(status.status,200);assert.equal(status.headers.get('access-control-allow-credentials'),null);
  const diagnosticUpload=await request('/api/collector/diagnostics',{via:publicOrigin,method:'POST',token,headers:{Origin:extensionOrigin},body:{logs:[{id:'test-event-0001',at:new Date().toISOString(),code:'collector_started',extensionVersion:'0.2.2'}]}});
  assert.equal(diagnosticUpload.status,200);
  assert.equal((await request(`/api/installations/${device.id}/diagnostics`,{via:publicOrigin,cookie})).status,404);
  assert.equal((await (await request(`/api/installations/${device.id}/diagnostics`,{cookie})).json()).logs.length,1);
  assert.equal((await request('/api/admin/extension-login',{method:'POST',token,headers:{Origin:extensionOrigin}})).status,403);
  assert.equal((await request('/api/dashboard',{token,headers:{Origin:extensionOrigin}})).status,403);
  assert.equal((await request(`/api/installations/${device.id}`,{method:'PATCH',cookie,body:{enabled:false}})).status,200);
  assert.equal((await request('/api/collector/status',{via:publicOrigin,token,headers:{Origin:extensionOrigin}})).status,401);
});
