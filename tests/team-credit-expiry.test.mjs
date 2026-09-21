import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { validateIngest } from '../server/domain.mjs';
import { estimateTeamCreditExpiry } from '../server/credit-expiry.mjs';

const START = Date.parse('2026-09-15T05:00:00Z');
const account = { scope:'team_total', subscriptionBalance:21000, lastSyncedAt:new Date(START).toISOString() };
const grant = { kind:'grant', description:'团队会员积分', amount:23100, occurredAt:'2026-09-01T09:20:58Z', eventId:'grant-september' };

test('estimates one Beijing calendar month and clamps short months rather than adding 30 days', () => {
  assert.equal(estimateTeamCreditExpiry(account,grant).expiresAt,'2026-10-01T09:20:58.000Z');
  for (const [from,to] of [
    ['2026-01-30T16:10:00Z','2026-02-27T16:10:00.000Z'],
    ['2024-01-30T16:10:00Z','2024-02-28T16:10:00.000Z'],
    ['2025-12-30T16:10:00Z','2026-01-30T16:10:00.000Z'],
  ]) assert.equal(estimateTeamCreditExpiry(account,{...grant,occurredAt:from}).expiresAt,to);
});

test('official expiry wins; personal, purchases, refunds, zero balance and future grants are not estimated', () => {
  for (const item of [
    {...account,scope:'personal'}, {...account,subscriptionBalance:0},
    {...account,expiresAt:'2026-09-28T00:00:00Z'},
    {...account,creditBatches:[{kind:'subscription',amount:21000,expiresAt:'2026-09-28T00:00:00Z'}]},
  ]) assert.equal(estimateTeamCreditExpiry(item,grant),null);
  for (const item of [
    {...grant,kind:'refund'}, {...grant,description:'购买积分'}, {...grant,description:'每日免费积分'},
    {...grant,amount:0}, {...grant,occurredAt:'invalid'}, {...grant,occurredAt:'2026-10-01T09:00:00Z'},
  ]) assert.equal(estimateTeamCreditExpiry(account,item),null);
});

function fixture(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(),'jmc-team-expiry-')); let time=START;
  const store=createStore({dataDir,secret:'test-only',clock:()=>time});
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  const department=store.createDepartment({name:'短剧'}), employee=store.createEmployee({name:'测试员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const wallet=(scope='team_total',spaceId='team-a',extra={})=>({platformUserId:'login-a',scope,spaceId,balance:scope==='team_total'?21000:7700,subscriptionBalance:scope==='team_total'?21000:7700,giftBalance:0,purchaseBalance:0,...extra});
  const event=(extra={})=>({platformUserId:'login-a',scope:'team_total',spaceId:'team-a',...grant,...extra});
  const collect=(accounts,transactions=[])=>store.ingest(device,validateIngest({status:'ok',observedAt:new Date(time).toISOString(),accounts,transactions},time));
  return {store,dataDir,wallet,event,collect,tick:ms=>time+=ms};
}

test('existing team ledger supplies both wallet views without changing observations or crossing teams', t => {
  const f=fixture(t);
  f.collect([f.wallet(),f.wallet('team_member'),f.wallet('team_total','team-b'),f.wallet('personal','personal')],[f.event()]);
  const data=f.store.dashboard(),history=data.transactions;
  for(const scope of ['team_total','team_member']) {
    const current=data.accounts.find(a=>a.scope===scope&&a.spaceId==='team-a');
    assert.equal(current.creditExpiryEstimate.expiresAt,'2026-10-01T09:20:58.000Z');
    assert.equal(current.creditExpiryEstimate.sourceEventId,'grant-september');
    assert.equal(current.expiresAt,null);assert.equal(current.creditBatches,null);
    assert.deepEqual(f.store.getAccount(current.id).creditExpiryEstimate,current.creditExpiryEstimate);
  }
  assert.equal(data.accounts.find(a=>a.spaceId==='team-b').creditExpiryEstimate,null);
  assert.equal(data.accounts.find(a=>a.scope==='personal').creditExpiryEstimate,null);
  assert.strictEqual(f.store.dashboard().transactions,history);
  const db=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'),{readOnly:true});
  try {
    assert.ok(db.prepare('SELECT data FROM accounts').all().every(r=>!Object.hasOwn(JSON.parse(r.data),'creditExpiryEstimate')),'estimates are not stored as observations');
    const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT t.data FROM accounts a JOIN transactions t ON t.account_id=a.id
      WHERE a.space_id=? AND a.scope IN ('team_total','team_member') AND json_extract(t.data,'$.kind')='grant'
      AND json_extract(t.data,'$.description')='团队会员积分' AND json_extract(t.data,'$.amount')>0
      AND json_extract(t.data,'$.occurredAt')<=? ORDER BY json_extract(t.data,'$.occurredAt') DESC,t.id DESC LIMIT 1`).all('team-a',new Date(START).toISOString());
    assert.match(plan.map(x=>x.detail).join('\n'),/transactions_team_grant/);
  } finally {db.close();}
});

test('new grants update estimates while official batches immediately replace them',t=>{
  const f=fixture(t);f.collect([f.wallet(),f.wallet('team_member')],[f.event({eventId:'old',occurredAt:'2026-08-25T09:20:58Z'})]);
  assert.equal(f.store.dashboard().accounts[0].creditExpiryEstimate.expiresAt,'2026-09-25T09:20:58.000Z');
  f.tick(1);f.collect([],[f.event()]);
  assert.ok(f.store.dashboard().accounts.every(a=>a.creditExpiryEstimate.expiresAt==='2026-10-01T09:20:58.000Z'));
  f.tick(1);f.collect([f.wallet('team_total','team-a',{expiresAt:'2026-09-30T09:00:00Z',creditBatches:[{kind:'subscription',amount:21000,expiresAt:'2026-09-30T09:00:00Z'}],creditBatchesComplete:true})]);
  const official=f.store.dashboard().accounts.find(a=>a.scope==='team_total');
  assert.equal(official.creditExpiryEstimate,null);assert.equal(official.expiresAt,'2026-09-30T09:00:00.000Z');
});

test('a newer grant never dates an older balance and an elapsed estimate is not advanced without new evidence',t=>{
  const f=fixture(t);f.collect([f.wallet()],[f.event()]);
  f.tick(40*86400_000);
  f.collect([],[f.event({eventId:'october',occurredAt:'2026-10-01T09:20:58Z'})]);
  assert.equal(f.store.dashboard().accounts[0].creditExpiryEstimate.expiresAt,'2026-10-01T09:20:58.000Z');
  f.collect([f.wallet()]);
  assert.equal(f.store.dashboard().accounts[0].creditExpiryEstimate.expiresAt,'2026-11-01T09:20:58.000Z');
});

test('conditional dashboard refreshes when an estimate enters seven-day warning and when it expires',t=>{
  const f=fixture(t);f.collect([f.wallet()],[f.event()]);
  f.tick(Date.parse('2026-09-24T09:20:57.999Z')-START);
  const before=f.store.dashboardVersion();f.store.dashboard();
  f.tick(1);assert.notEqual(f.store.dashboardVersion(),before);
  f.tick(7*86400_000-1);
  const almost=f.store.dashboardVersion();f.store.dashboard();
  f.tick(1);assert.notEqual(f.store.dashboardVersion(),almost);
  assert.equal(f.store.dashboard().accounts[0].creditExpiryEstimate.expiresAt,'2026-10-01T09:20:58.000Z');
});
