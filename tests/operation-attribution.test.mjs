import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
import { validateIngest } from '../server/domain.mjs';

const START=Date.parse('2026-09-15T03:00:00Z'),STAMP=new Date(START).toISOString();
const evidence=(extra={})=>({submitId:'submit-1',userId:'borrowed-login',spaceType:'personal',spaceId:'personal',occurredAt:STAMP,...extra});
const transaction=(extra={})=>({platformUserId:'borrowed-login',scope:'personal',spaceId:'0',eventId:'event-1',occurredAt:STAMP,kind:'consume',amount:-100,platformSubmitId:'submit-1',...extra});
function fixture(t){
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-operation-'));let time=START;
  let store=createStore({dataDir,secret:'isolated-test-only',clock:()=>time});
  const department=store.createDepartment({name:'教研'}),otherDepartment=store.createDepartment({name:'短剧'});
  const employee=store.createEmployee({name:'实际员工',departmentId:department.id}),other=store.createEmployee({name:'另一员工',departmentId:otherDepartment.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const collect=(extra={},installation=device)=>store.ingest(installation,validateIngest({observedAt:new Date(++time).toISOString(),status:'ok',accounts:[],transactions:[],...extra},time));
  const stored=()=>{
    const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'),{readOnly:true});
    try{return {evidence:db.prepare('SELECT * FROM operation_evidence ORDER BY rowid').all(),transactions:db.prepare('SELECT * FROM transactions ORDER BY rowid').all()};}finally{db.close();}
  };
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {get store(){return store;},dataDir,department,otherDepartment,employee,other,device,collect,stored,
    rows:()=>store.dashboard().transactions,advance(ms){time+=ms;},restart(){store.close();store=createStore({dataDir,secret:'isolated-test-only',clock:()=>time});}};
}

test('evidence before a ledger matches the authenticated employee without creating a wallet, first-login mapping or owner claim',t=>{
  const f=fixture(t);
  assert.equal(f.collect({operationEvidence:[evidence()]},{...f.device,employeeName:'伪造员工',employeeId:f.other.id}).operations,1);
  assert.equal(f.store.dashboard().accounts.length,0);assert.equal(f.store.dashboard().identities.length,0);
  assert.equal(f.store.getInstallation(f.device.id).initialIdentityBinding.status,'pending');
  f.collect({transactions:[transaction()]});const row=f.rows()[0];
  assert.equal(row.attribution,'matched');assert.equal(row.operatorEmployeeId,f.employee.id);
  assert.equal(row.operatorName,f.employee.name);assert.equal(row.operatorDepartment,f.department.name);
  assert.equal(row.chargedPlatformUserId,'borrowed-login');
  assert.equal(f.store.dashboard().accounts[0].ownerEmployeeId,null);
});

test('evidence received after a ledger reconciles it and invalidates the cached ledger',t=>{
  const f=fixture(t);f.collect({transactions:[transaction()]});
  const before=f.rows();assert.equal(before[0].attribution,'unconfirmed');
  f.collect({operationEvidence:[evidence()]});const after=f.rows();
  assert.notEqual(after,before);assert.equal(after[0].attribution,'matched');assert.equal(before[0].operatorName,null);
  assert.equal(f.stored().transactions.length,1);
});

test('submit ID, space and charged platform user all need exact matches; only consumption receives attribution',t=>{
  const f=fixture(t);
  f.collect({operationEvidence:[evidence()],transactions:[
    transaction(),transaction({eventId:'other-submit',platformSubmitId:'different'}),transaction({eventId:'other-user',platformUserId:'other-login'}),
    transaction({eventId:'team-space',scope:'team_member',spaceId:'team-a'}),
    ...['grant','refund','expire','adjustment'].map(kind=>transaction({eventId:kind,kind,amount:['grant','refund'].includes(kind)?100:-100})),
    transaction({eventId:'old-no-submit',platformSubmitId:null,occurredAt:'2026-09-10T03:00:00Z'}),
  ]});
  for(const row of f.rows())assert.equal(row.attribution,row.eventId==='event-1'?'matched':'unconfirmed',row.eventId);
});

test('team total history missing a charged user waits for later member identity and submit ID, then keeps one matched transaction',t=>{
  const f=fixture(t);
  const total=transaction({platformUserId:'observer',scope:'team_total',spaceId:'team-a',chargedPlatformUserId:null,platformSubmitId:null});
  f.collect({transactions:[total],operationEvidence:[evidence({spaceType:'team',spaceId:'team-a'})]});
  assert.equal(f.rows()[0].attribution,'unconfirmed');
  f.collect({transactions:[{...total,platformSubmitId:'submit-1'}]});assert.equal(f.rows()[0].attribution,'unconfirmed');
  f.collect({transactions:[transaction({scope:'team_member',spaceId:'team-a'})]});
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].attribution,'matched');
  assert.equal(f.rows()[0].chargedPlatformUserId,'borrowed-login');
  f.collect({transactions:[total]});assert.equal(f.rows()[0].attribution,'matched');assert.equal(f.rows()[0].platformSubmitId,'submit-1');
  f.collect({transactions:[transaction({scope:'team_member',spaceId:'another-team',eventId:'another-team-event'})]});
  assert.equal(f.rows().find(row=>row.eventId==='another-team-event').attribution,'unconfirmed');
});

test('duplicate receipts preserve the first employee snapshot and the same employee on another device is not a conflict',t=>{
  const f=fixture(t);f.collect({operationEvidence:[evidence()],transactions:[transaction()]});
  const original=f.rows()[0];
  f.store.patchEmployee(f.employee.id,{name:'新姓名',departmentId:f.otherDepartment.id});
  assert.equal(f.collect({operationEvidence:[evidence()]}).operations,0);
  assert.deepEqual(f.rows()[0],original);assert.equal(f.stored().evidence.length,1);
  const sameEmployeeDevice=f.store.createInstallation({employeeId:f.employee.id,role:'collector'});
  f.collect({operationEvidence:[evidence()]},sameEmployeeDevice);
  assert.equal(f.stored().evidence.length,2);assert.deepEqual(f.rows()[0],original);
});

test('different employees claiming the same exact submission revoke a match and duplicates cannot resolve the conflict',t=>{
  const f=fixture(t);f.collect({operationEvidence:[evidence()],transactions:[transaction()]});
  const otherDevice=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.collect({operationEvidence:[evidence()]},otherDevice);
  assert.equal(f.rows()[0].attribution,'unconfirmed');assert.equal(f.rows()[0].operatorName,null);assert.equal(f.rows()[0].operatorEmployeeId,null);
  f.collect({operationEvidence:[evidence()],transactions:[transaction()]});
  assert.equal(f.rows()[0].attribution,'unconfirmed');assert.equal(f.stored().evidence.length,2);
});

test('offline evidence is accepted after a department change and freezes the department at receipt time',t=>{
  const f=fixture(t);f.advance(2*24*3600_000);f.store.patchEmployee(f.employee.id,{departmentId:f.otherDepartment.id});
  f.collect({operationEvidence:[evidence()],transactions:[transaction()]});
  assert.equal(f.rows()[0].operatorDepartment,f.otherDepartment.name);
  f.store.patchEmployee(f.employee.id,{departmentId:f.department.id});
  assert.equal(f.rows()[0].operatorDepartment,f.otherDepartment.name);
});

test('stale evidence from before installation is rejected atomically and future evidence cannot be submitted',t=>{
  const f=fixture(t);
  assert.throws(()=>f.collect({operationEvidence:[evidence({occurredAt:new Date(START-300_001).toISOString()})],transactions:[transaction()]}),error=>error.status===400);
  assert.equal(f.stored().evidence.length,0);assert.equal(f.rows().length,0);
  assert.throws(()=>f.collect({operationEvidence:[evidence({occurredAt:new Date(START+600_000).toISOString()})]}),error=>error.status===400);
});

test('conflicting platform submit IDs roll back new evidence rather than changing a previous transaction',t=>{
  const f=fixture(t);f.collect({transactions:[transaction()]});const before=f.stored();
  assert.throws(()=>f.collect({operationEvidence:[evidence()],transactions:[transaction({platformSubmitId:'conflicting-submit'})]}),error=>error.status===409);
  assert.deepEqual(f.stored(),before);
});

test('collector deletion and service restart retain exact evidence and historical employee snapshots',t=>{
  const f=fixture(t);f.collect({operationEvidence:[evidence()],transactions:[transaction()]});const before=f.rows();
  f.store.deleteInstallation(f.device.id);f.restart();assert.deepEqual(f.rows(),before);assert.equal(f.stored().evidence.length,1);
});

test('retired collector evidence can match a later ledger uploaded by a different employee',t=>{
  const f=fixture(t);f.collect({operationEvidence:[evidence()]});
  f.store.deleteInstallation(f.device.id);f.restart();
  const observer=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.collect({transactions:[transaction()]},observer);
  assert.equal(f.rows()[0].operatorEmployeeId,f.employee.id);assert.equal(f.rows()[0].operatorName,f.employee.name);
});

test('reconciliation narrows by the indexed exact submission and charged user rather than scanning the ledger',t=>{
  const f=fixture(t);f.collect({operationEvidence:[evidence()],transactions:[transaction()]});
  const db=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'),{readOnly:true});
  try{
    const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT t.id,t.data FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE json_extract(t.data,'$.kind')='consume' AND json_extract(t.data,'$.platformSubmitId')=? AND json_extract(t.data,'$.chargedPlatformUserId')=?
      AND ((?='personal' AND a.scope='personal') OR (?='team' AND a.scope IN ('team_total','team_member') AND a.space_id=?))`)
      .all('submit-1','borrowed-login','personal','personal','personal').map(row=>row.detail).join('\n');
    assert.match(plan,/SEARCH t USING INDEX transactions_operation/);assert.doesNotMatch(plan,/SCAN t\b/);
  }finally{db.close();}
});

test('an unassigned collector cannot invent an employee and reassigning a pre-login device cannot rewrite a previous receipt',t=>{
  const f=fixture(t);f.store.patchInstallation(f.device.id,{employeeId:null});
  f.collect({operationEvidence:[evidence()],transactions:[transaction()]});assert.equal(f.rows()[0].attribution,'unconfirmed');
  f.store.patchInstallation(f.device.id,{employeeId:f.employee.id});
  f.collect({operationEvidence:[evidence()]});assert.equal(f.rows()[0].attribution,'unconfirmed');assert.equal(f.stored().evidence.length,2);
});

test('operation evidence rejects identity forgery and unsupported shapes without weakening legacy ingest validation',()=>{
  const input=extra=>({observedAt:STAMP,status:'ok',accounts:[],transactions:[],...extra});
  for(const entry of [{...evidence(),employeeId:'fake'},{...evidence(),operatorName:'假名'},{...evidence(),installationId:'fake'},evidence({submitId:''}),evidence({userId:'invalid id'}),evidence({spaceType:'team',spaceId:'borrowed-login'}),evidence({spaceType:'unknown'}),evidence({spaceId:'team-in-personal'}),evidence({occurredAt:'invalid'})]){
    assert.throws(()=>validateIngest(input({operationEvidence:[entry]}),START),error=>error.status===400);
  }
  for(const operationEvidence of [null,{},Array.from({length:101},()=>evidence())])assert.throws(()=>validateIngest(input({operationEvidence}),START));
  assert.throws(()=>validateIngest(input({status:'error',operationEvidence:[evidence()]}),START));
  assert.throws(()=>validateIngest(input({transactions:[{...transaction(),operatorName:'fake',attribution:'matched'}]}),START));
  assert.equal(validateIngest(input({operationEvidence:[evidence({spaceId:'0'})]}),START).operationEvidence[0].spaceId,'personal');
  assert.equal(Object.hasOwn(validateIngest(input({}),START),'operationEvidence'),false);
});

test('operation evidence requires an active authenticated collector at the HTTP ingest boundary',async t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-operation-api-')),app=createApp({dataDir,clock:()=>START}),origin=await app.start(0);
  const store=createStore({dataDir,secret:readFileSync(path.join(dataDir,'admin-secret'),'utf8').trim(),clock:()=>START});
  t.after(async()=>{store.close();await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const employee=store.createEmployee({name:'授权员工',departmentId:null}),device=store.createInstallation({employeeId:employee.id,role:'collector'}),token=store.installationToken(device.id);
  const post=token=>fetch(origin+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({observedAt:STAMP,status:'ok',accounts:[],transactions:[],operationEvidence:[evidence()]})});
  assert.equal((await post()).status,401);assert.equal((await post('invalid')).status,401);
  assert.equal((await post(token)).status,200);
  store.patchInstallation(device.id,{enabled:false});assert.equal((await post(token)).status,401);
});
