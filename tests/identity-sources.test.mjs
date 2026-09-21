import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { validateIngest } from '../server/domain.mjs';

const START=Date.parse('2026-09-15T03:00:00Z');
function fixture(t) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jimeng-identity-sources-'));let time=START;
  const store=createStore({dataDir,secret:'isolated-source-test',clock:()=>time});
  const department=store.createDepartment({name:'教研'}),employee=store.createEmployee({name:'员工甲',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const collect=(extra={},installation=device)=>store.ingest(installation,validateIngest({observedAt:new Date(++time).toISOString(),status:'ok',accounts:[],transactions:[],...extra},time));
  const person=id=>store.dashboard().identities.find(item=>item.platformUserId===id);
  const rawRows=()=>{
    const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'),{readOnly:true});
    try{return {accounts:db.prepare('SELECT * FROM accounts ORDER BY id').all(),transactions:db.prepare('SELECT * FROM transactions ORDER BY id').all()};}finally{db.close();}
  };
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {store,employee,device,collect,person,rawRows};
}
const wallet=(platformUserId,extra={})=>({platformUserId,spaceId:'personal',scope:'personal',displayName:platformUserId,balance:100,...extra});
const history=(platformUserId,eventId=platformUserId,extra={})=>({platformUserId,spaceId:'personal',scope:'personal',eventId,occurredAt:new Date(START).toISOString(),kind:'consume',amount:-10,...extra});
const poolHistory=(chargedPlatformUserId,eventId=chargedPlatformUserId)=>history('observer',eventId,{spaceId:'team-a',scope:'team_total',chargedPlatformUserId});

test('sources distinguish real logins, team members and history-only IDs without counting a pool observer as logged in',t=>{
  const f=fixture(t);f.store.skipInitialBinding(f.device.id);
  f.collect({accounts:[wallet('all-sources'),wallet('observer',{scope:'team_total',spaceId:'team-a'})],
    teams:[{spaceId:'team-a',membersComplete:true,members:[{platformUserId:'all-sources',displayName:'登录成员'},{platformUserId:'roster-only',displayName:'名单成员'}]}],
    transactions:[poolHistory('all-sources'),poolHistory('history-only'),poolHistory('observer','observer-history')]});
  assert.deepEqual(f.person('all-sources').sources,['login_account','team_member','history']);assert.equal(f.person('all-sources').historyOnly,false);
  assert.deepEqual(f.person('roster-only').sources,['team_member']);assert.equal(f.person('roster-only').historyOnly,false);
  for(const id of ['history-only','observer']){assert.deepEqual(f.person(id).sources,['history']);assert.equal(f.person(id).historyOnly,true);}
  assert.equal(Object.hasOwn(f.store.dashboard(),'accountSnapshotIds'),false,'internal snapshot evidence is not a public dashboard field');
});

test('history-created personal and member placeholders remain historical until a measured snapshot arrives',t=>{
  const f=fixture(t);f.store.skipInitialBinding(f.device.id);
  f.collect({transactions:[history('personal-old'),history('member-old','member-event',{scope:'team_member',spaceId:'team-a'})]});
  assert.equal(f.rawRows().accounts.length,2);
  assert.ok(f.rawRows().accounts.every(account=>account.snapshot_at===''));
  for(const id of ['personal-old','member-old']){assert.deepEqual(f.person(id).sources,['history']);assert.equal(f.person(id).historyOnly,true);}
  const historicalRows=f.rawRows().transactions;
  f.collect({accounts:[wallet('personal-old',{balance:0}),wallet('member-old',{scope:'team_member',spaceId:'team-a'})]});
  for(const id of ['personal-old','member-old']){assert.deepEqual(f.person(id).sources,['login_account','history']);assert.equal(f.person(id).historyOnly,false);}
  assert.deepEqual(f.rawRows().transactions,historicalRows,'source promotion does not rewrite historical transactions');
});

test('only current roster membership keeps an unassigned historical UID in the current account list',t=>{
  const f=fixture(t);
  f.collect({teams:[{spaceId:'team-a',membersComplete:true,members:[{platformUserId:'former-member'}]}],transactions:[poolHistory('former-member')]});
  assert.deepEqual(f.person('former-member').sources,['team_member','history']);assert.equal(f.person('former-member').historyOnly,false);
  f.collect({teams:[{spaceId:'team-a',membersComplete:true,members:[]}]});
  assert.deepEqual(f.person('former-member').sources,['history']);assert.equal(f.person('former-member').historyOnly,true);
  assert.equal(f.store.dashboard().transactions.length,1);
});

test('setting and clearing ownership updates source fields immediately without changing wallets or history',t=>{
  const f=fixture(t);f.collect({transactions:[poolHistory('historic')]});const before=f.rawRows();
  const saved=f.store.patchIdentity('historic',{employeeId:f.employee.id});
  assert.deepEqual(saved.sources,['history','ownership_mapping']);assert.equal(saved.historyOnly,false);assert.deepEqual(f.person('historic').sources,saved.sources);
  const cleared=f.store.patchIdentity('historic',{employeeId:null,boundPhone:'199****0000'});
  assert.deepEqual(cleared.sources,['history']);assert.equal(cleared.historyOnly,true,'a mapping row with only an optional phone is not an employee assignment');
  assert.equal(f.person('historic').historyOnly,true);assert.equal(f.person('historic').boundPhone,'199****0000');
  assert.deepEqual(f.rawRows(),before);
});

test('explicit login without any wallet stays a login observation after the collector and ownership are removed',t=>{
  const f=fixture(t);
  f.collect({loginIdentity:{platformUserId:'login-only',displayName:'首次账号'}});
  assert.equal(f.store.dashboard().accounts.length,0);assert.deepEqual(f.person('login-only').sources,['login_account','ownership_mapping']);
  f.store.patchIdentity('login-only',{employeeId:null});
  assert.deepEqual(f.person('login-only').sources,['login_account']);assert.equal(f.person('login-only').historyOnly,false);
  f.store.deleteInstallation(f.device.id);
  assert.equal(f.person('login-only').nickname,'首次账号');assert.deepEqual(f.person('login-only').sources,['login_account']);assert.equal(f.person('login-only').historyOnly,false);
  assert.equal(f.store.dashboard().transactions.length,0);
});
