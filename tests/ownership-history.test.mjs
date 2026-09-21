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

test('additive migration labels pre-tracking known ownership as legacy and preserves its baseline across reassignment and restart',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()],[f.event('old',START-60_000)]);
  f.tick();f.legacyRestart();
  const original=f.transaction('old').ownershipSnapshot;
  assert.equal(original.employeeId,f.first.id);assert.equal(original.basis,'legacy_current_mapping');
  assert.equal(original.effectiveAt,iso(f.time));
  f.tick();f.store.patchIdentity('account-a',{employeeId:f.second.id});
  assert.deepEqual(f.transaction('old').ownershipSnapshot,original);
  f.ingest([],[f.event('new')]);assert.equal(f.transaction('new').ownershipSnapshot.employeeId,f.second.id);
  assert.equal(f.transaction('new').ownershipSnapshot.basis,'effective');
  f.tick();f.restart();assert.deepEqual(f.transaction('old').ownershipSnapshot,original);
  assert.equal(f.edit(db=>db.prepare('SELECT COUNT(*) n FROM identity_ownership_history WHERE is_baseline=1').get().n),1);
  assert.deepEqual(f.edit(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('unknown historical accounts remain explicitly unassigned after their first manual mapping, even on late arrival',t=>{
  const f=fixture(t);f.store.skipInitialBinding(f.device.id);f.tick();
  f.ingest([f.account()],[f.event('old',START-60_000)]);f.tick();f.legacyRestart();
  f.tick();f.store.patchIdentity('account-a',{employeeId:f.first.id});
  const mappedAt=f.time;
  f.tick();f.ingest([],[f.event('late-old',START-30_000),f.event('just-before',mappedAt-1),f.event('at-boundary',mappedAt)]);
  for(const id of ['old','late-old','just-before']) {
    const snapshot=f.transaction(id).ownershipSnapshot;
    assert.equal(snapshot.employeeId,null);assert.equal(snapshot.basis,'effective');
  }
  assert.equal(f.transaction('at-boundary').ownershipSnapshot.employeeId,f.first.id);
  assert.equal(f.store.dashboard().identities[0].employeeId,f.first.id,'current directory remains assigned');
});

test('effective intervals are inclusive at start, clearing is recorded, and equal-time changes resolve to the final decision',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()]);const firstAt=f.time;
  f.tick();const switchAt=f.time;f.store.patchIdentity('account-a',{employeeId:f.second.id});
  f.tick();const clearAt=f.time;f.store.patchIdentity('account-a',{employeeId:null});
  f.tick();f.ingest([],[f.event('first',firstAt),f.event('before-switch',switchAt-1),f.event('second',switchAt),f.event('clear',clearAt)]);
  assert.equal(f.transaction('first').ownershipSnapshot.employeeId,f.first.id);
  assert.equal(f.transaction('before-switch').ownershipSnapshot.employeeId,f.first.id);
  assert.equal(f.transaction('second').ownershipSnapshot.employeeId,f.second.id);
  assert.equal(f.transaction('clear').ownershipSnapshot.employeeId,null);
  f.store.patchIdentity('account-a',{employeeId:f.first.id});
  f.ingest([],[f.event('same-millisecond')]);
  assert.equal(f.transaction('same-millisecond').ownershipSnapshot.employeeId,f.first.id);
  f.store.patchIdentity('account-a',{employeeId:f.second.id});
  assert.equal(f.transaction('same-millisecond').ownershipSnapshot.employeeId,f.second.id);
  f.restart();assert.equal(f.transaction('same-millisecond').ownershipSnapshot.employeeId,f.second.id);
});

test('employee rename, department rename and transfer preserve old labels while current directory and subsequent events advance',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()],[f.event('original')]);
  const original=f.transaction('original').ownershipSnapshot,history=f.transactions();
  f.tick();f.store.patchEmployee(f.first.id,{name:'员工甲新姓名'});
  assert.strictEqual(f.transactions(),history,'events before the rename retain the cached ledger');
  f.ingest([],[f.event('renamed')]);
  assert.equal(f.transaction('renamed').ownershipSnapshot.name,'员工甲新姓名');
  f.tick();f.store.patchDepartment(f.department.id,{name:'新教研部'});f.ingest([],[f.event('department-renamed')]);
  assert.equal(f.transaction('department-renamed').ownershipSnapshot.department,'新教研部');
  f.tick();f.store.patchEmployee(f.first.id,{departmentId:f.otherDepartment.id});f.ingest([],[f.event('transferred')]);
  assert.equal(f.transaction('transferred').ownershipSnapshot.departmentId,f.otherDepartment.id);
  assert.deepEqual(f.transaction('original').ownershipSnapshot,original);
  assert.equal(original.name,'员工甲');assert.equal(original.department,'教研');
  assert.equal(f.store.dashboard().identities[0].departmentId,f.otherDepartment.id);
});

test('removing a detached employee and department never deletes historical ownership snapshots',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()],[f.event('owned')]);
  const original=f.transaction('owned').ownershipSnapshot;
  f.tick();f.store.patchIdentity('account-a',{employeeId:null});
  f.store.deleteInstallation(f.device.id);f.store.deleteEmployee(f.first.id);f.store.deleteDepartment(f.department.id);
  f.restart();assert.deepEqual(f.transaction('owned').ownershipSnapshot,original);
  assert.equal(f.store.dashboard().employees.some(employee=>employee.id===f.first.id),false);
  assert.deepEqual(f.edit(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('automatic first binding records only an effective owner, ignores history before enrollment and never binds later borrowed accounts',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()],[f.event('historical',START-10_000),f.event('enrolled')]);
  assert.equal(f.transaction('historical').ownershipSnapshot.employeeId,null);
  assert.equal(f.transaction('enrolled').ownershipSnapshot.employeeId,f.first.id);
  const count=()=>f.edit(db=>db.prepare('SELECT COUNT(*) n FROM identity_ownership_history').get().n);
  const before=count();f.tick();f.ingest([f.account()]);assert.equal(count(),before,'repeated collection creates no duplicate decisions');
  f.tick();f.ingest([f.account('borrowed')],[f.event('borrowed-use',f.time,{platformUserId:'borrowed'})]);
  assert.equal(f.transaction('borrowed-use').ownershipSnapshot.employeeId,null);
  assert.equal(count(),before);f.restart();assert.equal(f.transaction('enrolled').ownershipSnapshot.employeeId,f.first.id);
});

test('team pool events without a charged member do not inherit creator or wallet cost ownership; enrichment resolves event-time member',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()]);
  const teamEvent=f.event('team-charge',f.time,{scope:'team_total',spaceId:'team-one',chargedPlatformUserId:null});
  f.ingest([f.account('account-a','team_total','team-one')],[teamEvent],{
    teams:[{spaceId:'team-one',creatorPlatformUserId:'account-a',members:[{platformUserId:'account-a',role:'creator'}]}]});
  const pool=f.store.dashboard().accounts.find(account=>account.scope==='team_total');
  f.store.patchAccount(pool.id,{ownerEmployeeId:f.first.id,ownerDepartmentId:f.department.id});
  assert.equal(f.transaction('team-charge').ownershipSnapshot.employeeId,null);
  f.tick();f.store.patchIdentity('account-a',{employeeId:f.second.id});
  f.ingest([],[{...teamEvent,chargedPlatformUserId:'account-a'}]);
  assert.equal(f.transaction('team-charge').ownershipSnapshot.employeeId,f.first.id,'late identity enrichment uses charge time, not current mapping');
});

test('collector cannot supply ownership snapshots and server projection overwrites any legacy payload field',t=>{
  const f=fixture(t);f.tick();const forged={employeeId:f.second.id,name:'forged',basis:'effective'};
  assert.throws(()=>validateIngest({observedAt:iso(f.time),accounts:[f.account()],transactions:[{...f.event('forged'),ownershipSnapshot:forged}]},f.time),/字段/);
  const input=validateIngest({observedAt:iso(f.time),status:'ok',accounts:[f.account()],transactions:[f.event('own')]},f.time);
  input.transactions[0].ownershipSnapshot=forged;f.store.ingest(f.device,input);
  assert.equal(f.transaction('own').ownershipSnapshot.employeeId,f.first.id);
  f.edit(db=>{
    const row=db.prepare('SELECT id,data FROM transactions').get();
    db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),ownershipSnapshot:forged}),row.id);
  });
  const result=f.transaction('own');assert.equal(result.ownershipSnapshot.employeeId,f.first.id);
  assert.throws(()=>{result.ownershipSnapshot.name='changed';},TypeError);
});

test('a failed history write rolls back both manual ownership and automatic enrollment atomically',t=>{
  const f=fixture(t);f.tick();f.ingest([f.account()]);
  f.edit(db=>db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON identity_ownership_history BEGIN SELECT RAISE(ABORT,'test rejection'); END;`));
  const original=f.store.dashboard().identities[0].employeeId;
  f.tick();assert.throws(()=>f.store.patchIdentity('account-a',{employeeId:f.second.id}),/test rejection/);
  assert.equal(f.store.dashboard().identities[0].employeeId,original);
  const device=f.store.createInstallation({employeeId:f.second.id,role:'collector'});
  assert.throws(()=>f.ingest([f.account('new-user')],[f.event('new-event',f.time,{platformUserId:'new-user'})],{},device),/test rejection/);
  assert.equal(f.store.getInstallation(device.id).initialIdentityBinding.status,'pending');
  assert.equal(f.store.dashboard().identities.some(identity=>identity.platformUserId==='new-user'),false);
  assert.equal(f.transaction('new-event'),undefined);
  f.edit(db=>db.exec('DROP TRIGGER fail_history'));
});
