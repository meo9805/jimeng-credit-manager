import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { validateIngest } from '../server/domain.mjs';
import { normalizeObservation } from '../extension/normalize.mjs';

const START=Date.parse('2026-09-15T03:00:00.000Z');
function fixture(t) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jimeng-initial-owner-'));
  let time=START,store=createStore({dataDir,secret:'isolated-test-key',clock:()=>time});
  const department=store.createDepartment({name:'短剧'});
  const employee=store.createEmployee({name:'员工甲',departmentId:department.id});
  const other=store.createEmployee({name:'员工乙',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const raw=(userId='login-a',extra={})=>({observedAt:new Date(time).toISOString(),status:'ok',message:null,userId,accountType:'personal',displayName:'平台昵称',balance:100,giftCredit:0,purchaseCredit:0,vipCredit:100,records:[],...extra});
  const ingest=(observation,installation=device)=>store.ingest(installation,validateIngest(observation,time));
  const collect=(userId='login-a',extra={},installation=device)=>ingest(normalizeObservation(raw(userId,extra)),installation);
  const state=(installation=device)=>store.getInstallation(installation.id).initialIdentityBinding;
  const identities=()=>new Map(store.dashboard().identities.map(person=>[person.platformUserId,person]));
  const editDatabase=fn=>{
    store.close();const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
    try{fn(db);}finally{db.close();}
    store=createStore({dataDir,secret:'isolated-test-key',clock:()=>time});
  };
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {get store(){return store;},dataDir,employee,other,device,raw,collect,ingest,state,identities,editDatabase,tick(ms=1000){time+=ms;}};
}

test('first and later logins create usage relationships without automatically claiming accounts',t=>{
  const f=fixture(t);f.collect('a');f.collect('b');
  assert.ok([...f.identities().values()].every(row=>row.employeeId===null));
  assert.deepEqual(f.store.dashboard().accountUsage.map(row=>row.platformUserId).sort(),['a','b']);
  f.store.patchIdentity('a',{employeeId:f.other.id});f.collect('a');f.editDatabase(()=>{});
  assert.equal(f.identities().get('a').employeeId,f.other.id);
  assert.equal(f.store.dashboard().accountUsage.length,2);
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:f.other.id}),/不能更换员工/);
});
test('several employees can use one account while every collector keeps its own employee',t=>{
  const f=fixture(t),other=f.store.createInstallation({employeeId:f.other.id});
  f.collect('a');f.collect('a',{},other);
  assert.equal(f.store.dashboard().accountUsage.length,2);
  assert.equal(f.identities().get('a').employeeId,null);
});
test('roster and charged history identify accounts, never the current login',t=>{
  const f=fixture(t);f.collect('reader',{accountType:'team',teamId:'team-a',canReadTeamTotal:true,teamTotalCredit:500,
    teamSnapshot:{spaceId:'team-a',members:[{platformUserId:'creator',role:'creator'},{platformUserId:'member',role:'member'}]},
    records:[{historyId:'prior',historyType:2,amount:5,title:'视频生成',createTime:Math.floor(START/1000)-10,userId:'charged',teamId:'team-a'}]});
  assert.deepEqual(f.store.dashboard().accountUsage.map(row=>row.platformUserId),['reader']);
  assert.ok([...f.identities().values()].every(row=>row.employeeId===null));
});
test('identity-only reads survive collector deletion and preserve the employee usage relationship',t=>{
  const f=fixture(t);f.ingest({observedAt:f.raw().observedAt,status:'ok',loginIdentity:{platformUserId:'a',displayName:'昵称'},accounts:[],transactions:[]});
  f.store.deleteInstallation(f.device.id);f.editDatabase(()=>{});
  assert.equal(f.identities().get('a').nickname,'昵称');assert.equal(f.identities().get('a').employeeId,null);
  assert.equal(f.store.dashboard().accountUsage[0].employeeId,f.employee.id);
});
test('legacy pending installers cannot claim borrowed logins after server upgrade',t=>{
  const f=fixture(t);f.editDatabase(db=>{const row=db.prepare('SELECT data FROM installations WHERE id=?').get(f.device.id),data=JSON.parse(row.data);data.initialIdentityBinding.status='pending';db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),f.device.id);});
  f.collect('borrowed');assert.equal(f.identities().get('borrowed').employeeId,null);
});
test('older clients report logins from personal or member snapshots without first-login binding',t=>{
  const f=fixture(t);const {loginIdentity,...payload}=normalizeObservation(f.raw('legacy'));f.ingest(payload);
  assert.equal(f.store.dashboard().accountUsage[0].platformUserId,'legacy');assert.equal(f.identities().get('legacy').employeeId,null);
});
test('inconsistent login identity is rejected and duplicate uploads do not duplicate usage',t=>{
  const f=fixture(t);const payload=normalizeObservation(f.raw('a'));
  assert.throws(()=>f.ingest({...payload,loginIdentity:{platformUserId:'different'}}));
  assert.equal(f.store.dashboard().accountUsage.length,0);f.ingest(payload);f.ingest(payload);
  assert.equal(f.store.dashboard().accountUsage.length,1);
});
test('login observations and transactions roll back together on a conflicting ledger',t=>{
  const f=fixture(t);const event={platformUserId:'a',scope:'personal',spaceId:'personal',eventId:'same',occurredAt:f.raw().observedAt,kind:'consume',amount:-2};
  f.ingest({observedAt:f.raw().observedAt,status:'ok',accounts:[],transactions:[event]});
  assert.throws(()=>f.ingest({observedAt:f.raw().observedAt,status:'ok',loginIdentity:{platformUserId:'b'},accounts:[],transactions:[{...event,amount:-3}]}));
  assert.equal(f.store.dashboard().accountUsage.length,0);
});
