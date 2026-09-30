import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync,strFromU8 } from 'fflate';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { hash,identity,validateIngest } from '../server/domain.mjs';

const NOW=Date.parse('2026-09-15T01:00:00.000Z'),OBS=new Date(NOW-60_000).toISOString();
const source={platformUserId:'person-1',spaceId:'0',scope:'personal',displayName:'平台昵称',balance:100};
function fixture(t){
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jimeng-directory-'));
  const store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  t.after(()=>{try{store.close();}catch{}rmSync(dataDir,{recursive:true,force:true});});
  return {store,dataDir};
}
function seed(store){
  const department=store.createDepartment({name:'教研'}),employee=store.createEmployee({name:'张三',departmentId:department.id});
  const installation=store.createInstallation({employeeId:employee.id,role:'collector'});
  store.ingest(installation,validateIngest({observedAt:OBS,accounts:[source],transactions:[{platformUserId:source.platformUserId,spaceId:'0',scope:'personal',eventId:'expense-1',occurredAt:OBS,kind:'consume',amount:-20}]},NOW));
  return {department,employee,installation,account:store.dashboard().accounts[0]};
}

test('directory references propagate rename and transfer without rewriting operator evidence or wallet ownership',t=>{
  const {store}=fixture(t),{department,employee,installation,account}=seed(store);
  store.patchIdentity('person-1',{employeeId:employee.id});
  store.patchAccount(account.id,{ownerEmployeeId:employee.id,ownerDepartmentId:department.id});
  const token=store.installationToken(installation.id),history=store.dashboard().transactions;
  store.patchDepartment(department.id,{name:'内容教研'});
  store.patchEmployee(employee.id,{name:'张小三'});
  let dashboard=store.dashboard();
  assert.equal(dashboard.identities[0].realName,'张小三');assert.equal(dashboard.identities[0].department,'内容教研');
  assert.equal(dashboard.accounts[0].ownerName,'张小三');assert.equal(dashboard.accounts[0].ownerDepartment,'内容教研');
  assert.equal(store.authenticate(token).employeeName,'张小三');assert.equal(store.authenticate(token).department,'内容教研');
  const other=store.createDepartment({name:'农资'});store.patchEmployee(employee.id,{departmentId:other.id});
  dashboard=store.dashboard();assert.equal(dashboard.identities[0].department,'农资');assert.equal(dashboard.installations[0].departmentId,other.id);
  assert.equal(dashboard.accounts[0].ownerDepartmentId,department.id,'wallet cost department stays explicitly assigned');
  assert.deepEqual(dashboard.transactions.map(({ownershipSnapshot,...row})=>row),history.map(({ownershipSnapshot,...row})=>row));assert.equal(dashboard.transactions[0].ownershipSnapshot.department,'农资');assert.equal(history[0].operatorName,null);assert.equal(history[0].attribution,'unconfirmed');
  store.patchIdentity('person-1',{employeeId:null});
  assert.equal(store.dashboard().identities[0].realName,null);assert.equal(store.dashboard().identities[0].department,null);
});

test('directory normalization, duplicates and referenced deletes prevent ambiguous or dangling selections',t=>{
  const {store}=fixture(t),{department,employee,installation,account}=seed(store);
  const expectStatus=(fn,status)=>assert.throws(fn,error=>error.status===status);
  expectStatus(()=>store.createDepartment({name:'  教研  '}),409);
  expectStatus(()=>store.createEmployee({name:' 张三 ',departmentId:department.id}),409);
  const other=store.createDepartment({name:'农资'}),namesake=store.createEmployee({name:'张三',departmentId:other.id});
  expectStatus(()=>store.patchEmployee(namesake.id,{departmentId:department.id}),409);
  expectStatus(()=>store.patchDepartment(other.id,{name:'教研'}),409);
  expectStatus(()=>store.createEmployee({name:'李四',departmentId:'missing'}),400);
  expectStatus(()=>store.createDepartment({name:'待归属'}),400);
  expectStatus(()=>store.deleteDepartment(department.id),409);
  expectStatus(()=>store.deleteEmployee(employee.id),409);
  expectStatus(()=>store.patchInstallation(installation.id,{employeeId:null}),409);
  const removableDepartment=store.createDepartment({name:'待撤销部门'});
  const removable=store.createEmployee({name:'临时负责人',departmentId:removableDepartment.id});
  store.patchIdentity('person-1',{employeeId:removable.id});
  expectStatus(()=>store.deleteEmployee(removable.id),409);store.patchIdentity('person-1',{employeeId:null});
  store.patchAccount(account.id,{ownerEmployeeId:removable.id,ownerDepartmentId:removableDepartment.id});expectStatus(()=>store.deleteEmployee(removable.id),409);
  store.patchAccount(account.id,{ownerEmployeeId:null,ownerDepartmentId:null});assert.deepEqual(store.deleteEmployee(removable.id),{deleted:true});
  assert.deepEqual(store.deleteDepartment(removableDepartment.id),{deleted:true});expectStatus(()=>store.deleteEmployee(removable.id),404);
  expectStatus(()=>store.deleteEmployee(employee.id),409,'bound collector retains its employee reference');
});

test('legacy free-text values migrate once, preserve observations and credentials, and leave placeholder devices unlinked',t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jimeng-directory-legacy-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const raw=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  raw.exec(`CREATE TABLE installations(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,token_cipher TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,space_id TEXT NOT NULL,snapshot_at TEXT NOT NULL,data TEXT NOT NULL,owner_name TEXT,owner_department TEXT);
    CREATE TABLE identity_mappings(platform_user_id TEXT PRIMARY KEY,real_name TEXT,department TEXT,updated_at TEXT NOT NULL);`);
  const account={...identity(source),...source,lastSyncedAt:OBS};
  raw.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)').run(account.id,'personal','0',OBS,JSON.stringify(account),' 张三 ',' 教研 ');
  for(const [id,name,department] of [['legacy-person','张三','教研'],['legacy-admin','管理员设备','待归属']]){
    raw.prepare('INSERT INTO installations VALUES(?,?,?,?)').run(id,hash(`${id}-token`),`${id}-untouched-cipher`,JSON.stringify({id,employeeName:name,department,role:'admin',enabled:true}));
  }
  raw.prepare('INSERT INTO identity_mappings VALUES(?,?,?,?)').run('person-1','张三','教研',OBS);
  raw.close();
  let store=createStore({dataDir,secret:'test-only',clock:()=>NOW}),data=store.dashboard();
  assert.equal(data.departments.length,1);assert.equal(data.employees.length,1);assert.equal(data.employees[0].name,'张三');
  assert.equal(data.identities[0].employeeId,data.employees[0].id);assert.equal(data.accounts[0].ownerEmployeeId,data.employees[0].id);
  const admin=store.authenticate('legacy-admin-token');assert.equal(admin.employeeId,null);assert.equal(admin.department,null);assert.equal(admin.employeeName,'管理员设备');
  assert.equal(store.patchInstallation(admin.id,{enabled:false}).enabled,false);store.patchInstallation(admin.id,{enabled:true});
  const employeeId=data.employees[0].id;store.patchEmployee(employeeId,{name:'新姓名'});store.close();
  store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  try{
    data=store.dashboard();assert.equal(data.employees.length,1);assert.equal(data.employees[0].id,employeeId);assert.equal(data.identities[0].realName,'新姓名');
    assert.equal(store.authenticate('legacy-person-token').employeeId,employeeId);assert.equal(data.accounts[0].balance,100);assert.equal(data.accounts[0].lastSyncedAt,OBS);
    const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));assert.equal(db.prepare('SELECT token_cipher FROM installations WHERE id=?').get('legacy-admin').token_cipher,'legacy-admin-untouched-cipher');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  } finally {store.close();}
});

test('directory APIs are administrator-only and exported packages resolve current directory labels',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'jimeng-directory-api-')),extensionDir=path.join(directory,'extension'),dataDir=path.join(directory,'data');mkdirSync(extensionDir);
  writeFileSync(path.join(extensionDir,'manifest.json'),JSON.stringify({manifest_version:3,name:'fixture',version:'0.2.2'}));
  const app=createApp({dataDir,extensionDir,clock:()=>NOW}),origin=await app.start(0);t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8')})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(route,method='GET',body,headers={Cookie:cookie})=>fetch(origin+route,{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/api/departments','POST',{name:'教研'},{})).status,401);
  const dept=await (await request('/api/departments','POST',{name:'教研'})).json();
  const employee=await (await request('/api/employees','POST',{name:'张三',departmentId:dept.id})).json();
  const device=await (await request('/api/installations','POST',{employeeId:employee.id,role:'collector'})).json();
  await request(`/api/departments/${dept.id}`,'PATCH',{name:'内容教研'});await request(`/api/employees/${employee.id}`,'PATCH',{name:'张小三'});
  const zip=await request(`/api/installations/${device.id}/extension.zip`),files=unzipSync(new Uint8Array(await zip.arrayBuffer())),provision=JSON.parse(strFromU8(files['provision.json']));
  assert.equal(provision.employeeName,'张小三');assert.equal(provision.department,'内容教研');
  const collectorHeaders={Authorization:`Bearer ${provision.token}`,Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
  assert.equal((await request('/api/departments','GET',undefined,collectorHeaders)).status,403);
  assert.equal((await request('/api/employees','POST',{name:'劫持',departmentId:dept.id},collectorHeaders)).status,403);
  for(const route of [`/api/departments/${dept.id}`,`/api/employees/${employee.id}`])assert.equal((await request(route,'DELETE',undefined,collectorHeaders)).status,403);
  assert.equal((await request('/api/installations','POST',{employeeName:'自由输入',department:'自由输入',role:'collector'})).status,400);
  assert.equal((await request(`/api/installations/${device.id}`,'PATCH',{department:'自由输入'})).status,400);
  assert.equal((await request(`/api/employees/${employee.id}`,'PATCH',{departmentId:'unknown'})).status,400);
  assert.equal((await request('/api/departments','GET')).status,200);assert.equal((await request('/api/employees','GET')).status,200);
});

test('credit batches preserve separate expiries and cannot persist stale breakdowns after older collectors observe a changed balance',t=>{
  const {store}=fixture(t),{installation,account}=seed(store);
  const batches=[{kind:'subscription',amount:90,expiresAt:'2026-09-28T10:00:00.000Z'},{kind:'gift',amount:10,expiresAt:'2026-09-15T23:59:59.000Z'}];
  const envelope=(at,extra)=>({observedAt:at,accounts:[{...source,...extra}],transactions:[]});
  store.ingest(installation,validateIngest(envelope(new Date(NOW-30_000).toISOString(),{creditBatches:batches,creditBatchesComplete:true}),NOW));
  assert.deepEqual(store.getAccount(account.id).creditBatches,batches);assert.equal(store.getAccount(account.id).creditBatchesComplete,true);
  store.ingest(installation,validateIngest(envelope(OBS,{balance:200}),NOW));assert.deepEqual(store.getAccount(account.id).creditBatches,batches);
  store.ingest(installation,validateIngest(envelope(new Date(NOW).toISOString(),{balance:80}),NOW));assert.equal(store.getAccount(account.id).creditBatches,null);assert.equal(store.getAccount(account.id).creditBatchesComplete,false);
  for(const extra of [{creditBatchesComplete:true},{creditBatches:[],creditBatchesComplete:'true'},{creditBatches:[{kind:'gift',amount:0,expiresAt:null}]},{creditBatches:[{kind:'other',amount:10,expiresAt:null}]},{creditBatches:[{kind:'gift',amount:10,expiresAt:'bad-date'}]},{creditBatches:Array.from({length:201},()=>batches[0])}])assert.throws(()=>validateIngest(envelope(OBS,extra),NOW),error=>error.status===400);
});
