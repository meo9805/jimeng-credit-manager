import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStore} from '../server/store.mjs';
import {validateIngest} from '../server/domain.mjs';

const START=Date.parse('2026-09-17T03:00:00.000Z');
const iso=at=>new Date(at).toISOString();
function fixture(t) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-ownership-history-'));
  let time=START,store=createStore({dataDir,secret:'isolated-history-test',clock:()=>time});
  const department=store.createDepartment({name:'教研'}),otherDepartment=store.createDepartment({name:'创作'});
  const first=store.createEmployee({name:'员工甲',departmentId:department.id});
  const second=store.createEmployee({name:'员工乙',departmentId:otherDepartment.id});
  const device=store.createInstallation({employeeId:first.id,role:'collector'});
  const account=(user='account-a',scope='personal',space='personal')=>({platformUserId:user,scope,spaceId:space,displayName:`昵称-${user}`,balance:100});
  const event=(id,at=time,extra={})=>({platformUserId:'account-a',scope:'personal',spaceId:'personal',eventId:id,occurredAt:iso(at),kind:'consume',amount:-10,...extra});
  const ingest=(accounts=[],transactions=[],extra={},installation=device)=>store.ingest(installation,validateIngest({observedAt:iso(time),status:'ok',accounts,transactions,...extra},time));
  const transactions=()=>store.dashboard().transactions;
  const transaction=id=>transactions().find(row=>row.eventId===id);
  const edit=fn=>{const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));try{return fn(db);}finally{db.close();}};
  const restart=fn=>{store.close();if(fn)edit(fn);store=createStore({dataDir,secret:'isolated-history-test',clock:()=>time});};
  const legacyRestart=()=>restart(db=>{
    db.exec('DROP TABLE identity_ownership_history');
    db.prepare('DELETE FROM schema_migrations WHERE id=?').run('identity-ownership-history-v1');
    db.prepare("DELETE FROM data_revisions WHERE name='ownership'").run();
  });
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {get store(){return store;},get time(){return time;},department,otherDepartment,first,second,device,
    account,event,ingest,transactions,transaction,edit,restart,legacyRestart,tick:(ms=1000)=>time+=ms};
}

test('binding and reassignment backfill all history including late arrivals, clearing and restart',t=>{
  const f=fixture(t);f.ingest([f.account()],[f.event('old',START-60000)]);
  assert.equal(f.transaction('old').ownershipSnapshot.employeeId,null);
  f.tick();f.store.patchIdentity('account-a',{employeeId:f.first.id});
  f.ingest([],[f.event('late',START-30000)]);
  assert.ok(f.transactions().every(row=>row.ownershipSnapshot.employeeId===f.first.id));
  const facts=f.transactions().map(({ownershipSnapshot,...row})=>row);
  f.tick();f.store.patchIdentity('account-a',{employeeId:f.second.id});f.restart();
  assert.ok(f.transactions().every(row=>row.ownershipSnapshot.employeeId===f.second.id));
  assert.deepEqual(f.transactions().map(({ownershipSnapshot,...row})=>row),facts);
  f.store.patchIdentity('account-a',{employeeId:null});
  assert.ok(f.transactions().every(row=>row.ownershipSnapshot.employeeId===null));
  assert.equal(f.edit(db=>db.prepare('SELECT COUNT(*) n FROM identity_ownership_history').get().n),3);
});
test('employee rename and department edits update all historical ownership labels',t=>{
  const f=fixture(t);f.ingest([f.account()],[f.event('old')]);f.store.patchIdentity('account-a',{employeeId:f.first.id});
  const facts=f.transactions().map(({ownershipSnapshot,...row})=>row);
  f.store.patchEmployee(f.first.id,{name:'新姓名',departmentId:f.otherDepartment.id});
  f.store.patchDepartment(f.otherDepartment.id,{name:'新部门'});
  assert.equal(f.transaction('old').ownershipSnapshot.name,'新姓名');
  assert.equal(f.transaction('old').ownershipSnapshot.department,'新部门');
  assert.deepEqual(f.transactions().map(({ownershipSnapshot,...row})=>row),facts);
});
test('legacy baseline no longer freezes reports after mapping correction',t=>{
  const f=fixture(t);f.ingest([f.account()],[f.event('old',START-60000)]);
  f.store.patchIdentity('account-a',{employeeId:f.first.id});f.legacyRestart();
  f.store.patchIdentity('account-a',{employeeId:f.second.id});f.restart();
  assert.equal(f.transaction('old').ownershipSnapshot.employeeId,f.second.id);
  assert.equal(f.edit(db=>db.prepare('SELECT COUNT(*) n FROM identity_ownership_history WHERE is_baseline=1').get().n),1);
});
test('team pool has no member ownership until charged ID is known; late enrichment uses current mapping',t=>{
  const f=fixture(t);f.ingest([f.account()]);f.store.patchIdentity('account-a',{employeeId:f.second.id});
  const event=f.event('team',START-60000,{scope:'team_total',spaceId:'team-a',chargedPlatformUserId:null});
  f.ingest([],[event]);assert.equal(f.transaction('team').ownershipSnapshot.employeeId,null);
  f.ingest([],[{...event,chargedPlatformUserId:'account-a'}]);
  assert.equal(f.transaction('team').ownershipSnapshot.employeeId,f.second.id);
});
test('collector cannot forge ownership and failed audit writes roll back mapping',t=>{
  const f=fixture(t);f.ingest([f.account()],[f.event('old')]);f.store.patchIdentity('account-a',{employeeId:f.first.id});
  assert.throws(()=>validateIngest({observedAt:iso(f.time),accounts:[],transactions:[{...f.event('bad'),ownershipSnapshot:{employeeId:f.second.id}}]},f.time));
  f.edit(db=>db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON identity_ownership_history BEGIN SELECT RAISE(ABORT,'test rejection'); END"));
  assert.throws(()=>f.store.patchIdentity('account-a',{employeeId:f.second.id}),/test rejection/);
  assert.equal(f.transaction('old').ownershipSnapshot.employeeId,f.first.id);
});
