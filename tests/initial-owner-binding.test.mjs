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

test('first login maps once across personal and team views; later switched accounts remain unassigned',t=>{
  const f=fixture(t);assert.equal(f.state().status,'pending');f.tick();f.collect();
  const decision=f.state();
  assert.equal(decision.status,'bound');assert.equal(decision.platformUserId,'login-a');assert.equal(decision.employeeId,f.employee.id);
  assert.equal(decision.observedAt,new Date(START+1000).toISOString());assert.equal(decision.decidedAt,decision.observedAt);
  assert.equal(f.identities().get('login-a').employeeId,f.employee.id);
  f.tick();f.collect('login-a',{accountType:'team',teamId:'team-a',canReadTeamTotal:true,teamTotalCredit:500});
  assert.equal(f.identities().size,1);assert.equal(f.store.dashboard().accounts.length,3);assert.deepEqual(f.state(),decision);
  f.tick();f.collect('borrowed-account');
  assert.equal(f.identities().get('borrowed-account').employeeId,null);assert.equal(f.identities().get('login-a').employeeId,f.employee.id);
  assert.equal(f.store.dashboard().installations[0].accountCount,4);assert.deepEqual(f.state(),decision);
});

test('first team view binds its logged-in member, never roster, creator, team total or charged history identities',t=>{
  const f=fixture(t);f.tick();
  f.collect('current-member',{accountType:'team',teamId:'team-a',canReadTeamTotal:true,teamTotalCredit:500,ledgerScope:'team_total',
    teamSnapshot:{spaceId:'team-a',creatorPlatformUserId:'team-owner',creatorDisplayName:'创建者',membersComplete:true,observedAt:new Date(START+1000).toISOString(),members:[{platformUserId:'team-owner',displayName:'创建者',role:'creator'},{platformUserId:'roster-member',displayName:'成员',role:'member'}]},
    records:[{historyId:'prior-charge',historyType:2,amount:5,title:'生成视频',createTime:Math.floor(Math.min(START,Date.now())/1000)-10,userId:'history-member',teamId:'team-a'}]});
  assert.equal(f.state().platformUserId,'current-member');assert.equal(f.state().status,'bound');
  const identities=f.identities();assert.equal(identities.get('current-member').employeeId,f.employee.id);
  for(const id of ['team-owner','roster-member','history-member'])assert.equal(identities.get(id).employeeId,null,id);
  assert.equal(identities.has('team-a'),false);
  const transaction=f.store.dashboard().transactions[0];assert.equal(transaction.operatorName,null);assert.equal(transaction.attribution,'unconfirmed');
});

test('roster-only, history-only and team-total-only reports do not spend the first-login binding opportunity',t=>{
  const f=fixture(t);f.tick();const observedAt=f.raw().observedAt;
  f.ingest({observedAt,status:'ok',accounts:[],transactions:[{platformUserId:'ledger-observer',spaceId:'team-a',scope:'team_total',eventId:'old-event',occurredAt:observedAt,kind:'consume',amount:-3,chargedPlatformUserId:'history-only'}],teams:[{spaceId:'team-a',members:[{platformUserId:'roster-only',role:'creator'}]}]});
  assert.equal(f.state().status,'pending');
  f.ingest({observedAt,status:'ok',accounts:[{platformUserId:'pool-observer',scope:'team_total',spaceId:'team-a',displayName:'团队',spaceName:'团队',balance:200}],transactions:[]});
  assert.equal(f.state().status,'pending');
  f.tick();f.collect('actual-first-login');assert.equal(f.state().platformUserId,'actual-first-login');
  for(const id of ['roster-only','history-only'])assert.equal(f.identities().get(id).employeeId,null);
});

test('failed and signed-out observations cannot bind, and stale pre-installation observations remain ineligible',t=>{
  const f=fixture(t);
  for(const status of ['error','login_required']){
    const {loginIdentity,...legacy}=normalizeObservation(f.raw());
    f.ingest({...legacy,status});assert.equal(f.state().status,'pending');
  }
  f.ingest(normalizeObservation(f.raw('old-account',{observedAt:new Date(START-600_000).toISOString()})));
  assert.equal(f.state().status,'pending');
  f.tick();f.collect('first-login');assert.equal(f.state().platformUserId,'first-login');
  assert.equal(f.identities().get('old-account').employeeId,null);
});

test('retries and process restart preserve the decision and manual account ownership corrections',t=>{
  const f=fixture(t);f.tick();const payload=normalizeObservation(f.raw());f.ingest(payload);const decision=f.state();
  f.tick();f.ingest(payload);assert.deepEqual(f.state(),decision);
  f.store.patchIdentity('login-a',{employeeId:f.other.id});
  f.editDatabase(()=>{});f.tick();f.collect();
  assert.deepEqual(f.state(),decision);assert.equal(f.identities().get('login-a').employeeId,f.other.id);
  f.store.patchIdentity('login-a',{employeeId:null});f.tick();f.collect();
  assert.equal(f.identities().get('login-a').employeeId,null,'an administrator clearing ownership is not undone by later uploads');
});

test('an existing different owner produces a final conflict; the next login does not get silently bound',t=>{
  const f=fixture(t);const ownerDevice=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.tick();f.collect('existing-account',{},ownerDevice);f.tick();f.collect('existing-account');
  const conflict=f.state();assert.equal(conflict.status,'conflict');assert.equal(conflict.platformUserId,'existing-account');
  assert.equal(f.identities().get('existing-account').employeeId,f.other.id);
  f.tick();f.collect('next-account');assert.deepEqual(f.state(),conflict);assert.equal(f.identities().get('next-account').employeeId,null);
  const sameOwnerDevice=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.tick();f.collect('existing-account',{},sameOwnerDevice);assert.equal(f.state(sameOwnerDevice).status,'bound');
});

test('the first-binding mapping and decision roll back with an invalid ledger ingest',t=>{
  const f=fixture(t);f.tick();const observedAt=f.raw().observedAt;
  const transaction={platformUserId:'login-a',scope:'personal',spaceId:'personal',eventId:'same-event',occurredAt:observedAt,kind:'consume',amount:-1};
  const input={...normalizeObservation(f.raw()),transactions:[transaction,{...transaction,amount:-2}]};
  assert.throws(()=>f.ingest(input),error=>error.status===409);
  assert.equal(f.state().status,'pending');assert.equal(f.identities().size,0);assert.equal(f.store.dashboard().transactions.length,0);
  f.ingest({...input,transactions:[transaction]});assert.equal(f.state().status,'bound');
});

test('ambiguous simultaneous login identities require manual ownership and cannot rearm on a later login',t=>{
  const f=fixture(t);f.tick();const one=normalizeObservation(f.raw('one')),two=normalizeObservation(f.raw('two'));
  const {loginIdentity,...legacy}=one;
  f.ingest({...legacy,accounts:[...one.accounts,...two.accounts]});
  assert.equal(f.state().status,'ambiguous');assert.equal(f.state().platformUserId,null);
  for(const person of f.identities().values())assert.equal(person.employeeId,null);
  f.tick();f.collect('three');assert.equal(f.state().status,'ambiguous');assert.equal(f.identities().get('three').employeeId,null);
});

test('pre-enrollment employee selection can change; bound packages cannot be reassigned to another employee',t=>{
  const f=fixture(t);f.store.patchInstallation(f.device.id,{employeeId:f.other.id});
  assert.equal(f.state().employeeId,f.other.id);f.tick();f.collect();
  assert.equal(f.identities().get('login-a').employeeId,f.other.id);
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:f.employee.id}),error=>error.status===409&&error.message.includes('新建采集端'));
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:null}),error=>error.status===409);
  f.store.patchInstallation(f.device.id,{employeeId:f.other.id});f.tick();f.collect('switched');
  assert.equal(f.state().employeeId,f.other.id);assert.equal(f.identities().get('login-a').employeeId,f.other.id);assert.equal(f.identities().get('switched').employeeId,null);
});

test('legacy collectors with prior data and unassigned devices never auto-enroll on upgrade',t=>{
  const f=fixture(t);f.tick();f.collect('prior-login');
  const unused=f.store.createInstallation({employeeId:f.employee.id,role:'collector'});
  const unassigned=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.editDatabase(db=>{
    db.prepare('DELETE FROM identity_mappings').run();
    for(const id of [f.device.id,unused.id,unassigned.id]){
      const row=db.prepare('SELECT data FROM installations WHERE id=?').get(id),data=JSON.parse(row.data);delete data.initialIdentityBinding;
      db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),id);
    }
    db.prepare('UPDATE installations SET employee_id=NULL WHERE id=?').run(unassigned.id);
  });
  assert.equal(f.state().status,'legacy');assert.equal(f.state(unused).status,'pending');assert.equal(f.state(unassigned).status,'unassigned');
  f.tick();f.collect('borrowed-after-upgrade');assert.equal(f.identities().get('borrowed-after-upgrade').employeeId,null);
  f.tick();f.collect('unused-first',{},unused);assert.equal(f.state(unused).status,'bound');
  f.store.patchInstallation(unassigned.id,{employeeId:f.employee.id});f.tick();f.collect('unassigned-first',{},unassigned);
  assert.equal(f.state(unassigned).status,'unassigned');assert.equal(f.identities().get('unassigned-first').employeeId,null);
});

test('a device without an employee at its first login consumes enrollment without inventing an owner',t=>{
  const f=fixture(t);f.store.patchInstallation(f.device.id,{employeeId:null});f.tick();f.collect('first');
  assert.equal(f.state().status,'unassigned');assert.equal(f.state().platformUserId,'first');
  f.store.patchInstallation(f.device.id,{employeeId:f.employee.id});f.tick();f.collect('next');
  assert.equal(f.state().status,'unassigned');for(const person of f.identities().values())assert.equal(person.employeeId,null);
});

test('a successful login with failed member balance and available team total binds the first user before a later account switch',t=>{
  const f=fixture(t);f.tick();
  const first=normalizeObservation(f.raw('first-login',{displayName:'首次登录昵称',accountType:'team',teamId:'team-a',balanceFresh:false,canReadTeamTotal:true,teamTotalCredit:500}));
  assert.deepEqual(first.accounts.map(account=>account.scope),['team_total']);
  assert.deepEqual(first.loginIdentity,{platformUserId:'first-login',displayName:'首次登录昵称'});
  f.ingest(first);
  assert.equal(f.state().status,'bound');assert.equal(f.state().platformUserId,'first-login');
  assert.equal(f.identities().get('first-login').employeeId,f.employee.id);assert.equal(f.identities().get('first-login').nickname,'首次登录昵称');
  assert.deepEqual(f.store.dashboard().accounts.map(account=>account.scope),['team_total'],'a login observation never invents an available member balance');
  f.editDatabase(()=>{});assert.equal(f.identities().get('first-login').nickname,'首次登录昵称');
  f.tick();f.collect('borrowed-later');assert.equal(f.state().platformUserId,'first-login');assert.equal(f.identities().get('borrowed-later').employeeId,null);
});

test('verified login identity can enroll without any wallet balance, ledger or roster',t=>{
  const f=fixture(t);f.tick();
  const first=normalizeObservation(f.raw('identity-only',{balanceFresh:false}));
  assert.equal(first.accounts.length,0);f.ingest(first);
  assert.equal(f.state().status,'bound');assert.equal(f.identities().get('identity-only').employeeId,f.employee.id);
  assert.equal(f.store.dashboard().accounts.length,0);assert.equal(f.store.dashboard().transactions.length,0);assert.equal(f.store.dashboard().teams.length,0);
  f.tick();f.collect('borrowed-later');assert.equal(f.identities().get('borrowed-later').employeeId,null);
});

test('explicit login identity is allowlisted, requires successful login and rejects inconsistent wallet identities',t=>{
  const f=fixture(t);f.tick();const valid=normalizeObservation(f.raw('one'));
  for(const loginIdentity of [null,[],{platformUserId:'one',displayName:'昵称',employeeId:f.employee.id},{platformUserId:'one',displayName:'cookie=secret'},{platformUserId:'bad id'}]){
    assert.throws(()=>f.ingest({...valid,loginIdentity}),error=>error.status===400);
  }
  for(const status of ['error','login_required']){
    assert.throws(()=>f.ingest({...valid,status}),error=>error.status===400);
    assert.equal(Object.hasOwn(normalizeObservation(f.raw('one',{status})),'loginIdentity'),false);
  }
  assert.throws(()=>f.ingest({...valid,loginIdentity:{platformUserId:'other',displayName:'另一个登录'}}),error=>error.status===400);
  const other=normalizeObservation(f.raw('two'));
  assert.throws(()=>f.ingest({...valid,accounts:[...valid.accounts,...other.accounts]}),error=>error.status===400);
  assert.throws(()=>f.ingest({...valid,accounts:[],teams:[{spaceId:'one',members:[]}]}),error=>error.status===400);
  assert.equal(f.state().status,'pending');assert.equal(f.store.dashboard().accounts.length,0);
});

test('older collectors without explicit login identity still bind from a unique personal or member snapshot',t=>{
  const f=fixture(t);f.tick();const {loginIdentity,...legacy}=normalizeObservation(f.raw('legacy-first'));
  f.ingest(legacy);assert.equal(f.state().status,'bound');assert.equal(f.identities().get('legacy-first').employeeId,f.employee.id);
  f.tick();const {loginIdentity:laterIdentity,...later}=normalizeObservation(f.raw('legacy-borrowed'));
  f.ingest(later);assert.equal(f.identities().get('legacy-borrowed').employeeId,null);
});

test('confirming a borrowed first login preserves ownership and original evidence, is idempotent and survives restart',t=>{
  const f=fixture(t),ownerDevice=f.store.createInstallation({employeeId:f.other.id,role:'collector'});
  f.tick();f.collect('borrowed',{},ownerDevice);f.tick();f.collect('borrowed');
  const original=f.state();assert.equal(original.status,'conflict');
  const before=f.store.dashboard(),revision=f.store.dashboardVersion();f.tick();
  const resolved=f.store.skipInitialBinding(f.device.id).initialIdentityBinding;
  assert.deepEqual(resolved,{...original,status:'skipped',resolution:'collection_only',resolvedAt:f.raw().observedAt,originalStatus:'conflict'});
  assert.notEqual(f.store.dashboardVersion(),revision,'resolving enrollment invalidates the dashboard response');
  const after=f.store.dashboard();
  for(const key of ['accounts','transactions','teams','identities','employees','departments'])assert.deepEqual(after[key],before[key],key);
  assert.equal(f.identities().get('borrowed').employeeId,f.other.id);
  f.tick();assert.deepEqual(f.store.skipInitialBinding(f.device.id).initialIdentityBinding,resolved);
  f.editDatabase(()=>{});assert.deepEqual(f.state(),resolved);
  f.tick();f.collect('later-own');assert.equal(f.identities().get('later-own').employeeId,null);
  f.tick();f.collect('borrowed');assert.equal(f.identities().get('borrowed').employeeId,f.other.id);assert.deepEqual(f.state(),resolved);
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:f.other.id}),error=>error.status===409);
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:null}),error=>error.status===409);
});

test('skipping before first login keeps collection and actual operator matching without automatically claiming any account',t=>{
  const f=fixture(t),initial=f.state();f.tick();
  const skipped=f.store.skipInitialBinding(f.device.id).initialIdentityBinding;
  assert.deepEqual(skipped,{...initial,status:'skipped',resolution:'collection_only',resolvedAt:f.raw().observedAt,originalStatus:'pending'});
  assert.throws(()=>f.store.patchInstallation(f.device.id,{employeeId:f.other.id}),error=>error.status===409);
  f.tick();f.collect('borrowed');f.tick();f.collect('later-own');
  for(const id of ['borrowed','later-own'])assert.equal(f.identities().get(id).employeeId,null);
  const occurredAt=f.raw().observedAt;
  f.ingest({observedAt:occurredAt,status:'ok',accounts:[],transactions:[{
    platformUserId:'borrowed',scope:'personal',spaceId:'personal',eventId:'skip-consumption',platformSubmitId:'skip-submit',occurredAt,kind:'consume',amount:-10,
  }],operationEvidence:[{submitId:'skip-submit',userId:'borrowed',spaceType:'personal',spaceId:'personal',occurredAt}]});
  const dashboard=f.store.dashboard(),transaction=dashboard.transactions[0];
  assert.equal(dashboard.accounts.length,2);assert.equal(dashboard.installations[0].status,'ok');
  assert.equal(transaction.attribution,'matched');assert.equal(transaction.operatorEmployeeId,f.employee.id);assert.equal(transaction.operatorName,f.employee.name);
  assert.equal(f.identities().get('borrowed').employeeId,null,'operator evidence does not assert ownership');
  f.store.patchIdentity('later-own',{employeeId:f.employee.id});
  assert.equal(f.identities().get('later-own').employeeId,f.employee.id,'later account ownership uses the existing manual mapping');
  assert.deepEqual(f.state(),skipped);
});

test('ambiguous enrollment can be skipped without assigning either login',t=>{
  const f=fixture(t);f.tick();const one=normalizeObservation(f.raw('one')),two=normalizeObservation(f.raw('two'));
  const {loginIdentity,...legacy}=one;f.ingest({...legacy,accounts:[...one.accounts,...two.accounts]});
  const original=f.state();assert.equal(original.status,'ambiguous');f.tick();
  assert.deepEqual(f.store.skipInitialBinding(f.device.id).initialIdentityBinding,{...original,status:'skipped',resolution:'collection_only',resolvedAt:f.raw().observedAt,originalStatus:'ambiguous'});
  for(const person of f.identities().values())assert.equal(person.employeeId,null);
});

test('skip cannot erase a completed owner binding or change unsupported historical states',t=>{
  const f=fixture(t);f.tick();f.collect();
  const bound=f.state();assert.throws(()=>f.store.skipInitialBinding(f.device.id),error=>error.status===409);assert.deepEqual(f.state(),bound);
  assert.equal(f.identities().get('login-a').employeeId,f.employee.id);
  assert.throws(()=>f.store.skipInitialBinding('missing-device'),error=>error.status===404);
  for(const status of ['legacy','unassigned']){
    f.editDatabase(db=>{
      const row=db.prepare('SELECT data FROM installations WHERE id=?').get(f.device.id),data=JSON.parse(row.data);
      data.initialIdentityBinding={...data.initialIdentityBinding,status};db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),f.device.id);
    });
    const before=f.state();assert.throws(()=>f.store.skipInitialBinding(f.device.id),error=>error.status===409);assert.deepEqual(f.state(),before);
  }
});
