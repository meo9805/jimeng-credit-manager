import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { buildLeaderOverview } from '../web/leader-overview.js';
import { expirySourceIndex, expiryCreditKind } from '../server/expiry-source.mjs';

test('stored official sources backfill expiry reporting without changing ledger and refresh when facts arrive later', () => {
  const dataDir=mkdtempSync(path.join(tmpdir(),'jmc-expiry-'));
  const store=createStore({dataDir,secret:'test-only'}), db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  try {
    const at='2026-09-25T15:59:59.000Z', seconds=Date.parse(at)/1000;
    db.prepare('INSERT INTO accounts(id,scope,space_id,snapshot_at,data) VALUES(?,?,?,?,?)').run('a','personal','personal',at,JSON.stringify({id:'a',scope:'personal',platformUserId:'u',spaceId:'personal',balance:1000}));
    const insertTx=(id,amount)=>db.prepare('INSERT INTO transactions VALUES(?,?,?)').run(id,'a',JSON.stringify({id,eventId:id,kind:'expire',amount:-amount,occurredAt:at,chargedPlatformUserId:'u',description:'积分到期清零'}));
    insertTx('free',66);insertTx('paid',100);insertTx('missing',80);
    const original=db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const project=()=>store.dashboard();
    assert.equal(project().transactions.find(t=>t.id==='free').expiryCreditKind,null);
    const fact=(hash,records)=>db.prepare('INSERT INTO credit_source_facts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('user_credit_history','personal','u','',hash,'i','e',at,at,at,JSON.stringify({data:{records}}));
    const raw=(id,amount,trade_source,user_id)=>({history_id:id,history_type:2,amount,create_time:seconds,...(user_id ? {user_id} : {}),trade_source});
    fact('first',[raw('free',66,'FREEMIUM_RECEIVE'),raw('paid',100,'VIP_GIFT')]);
    let data=project();
    assert.equal(data.transactions.find(t=>t.id==='free').expiryCreditKind,'gift');
    assert.equal(data.transactions.find(t=>t.id==='paid').expiryCreditKind,'subscription');
    const summary=buildLeaderOverview({...data,now:Date.parse('2026-09-29T06:00:00Z')}).summary;
    assert.equal(summary.expiry.total,100);
    assert.deepEqual(summary.transactionIds.expiry,['paid']);
    assert.equal(data.transactions.length,3,'free and unsupported source rows stay in the full ledger');
    fact('wrong-user',[raw('missing',80,'ONE_OFF_PURCHASE','someone-else')]);
    assert.equal(project().transactions.find(t=>t.id==='missing').expiryCreditKind,null);
    fact('late',[raw('missing',80,'ONE_OFF_PURCHASE')]);
    assert.equal(project().transactions.find(t=>t.id==='missing').expiryCreditKind,'purchase');
    fact('conflict',[raw('paid',100,'FREEMIUM_RECEIVE')]);
    assert.equal(project().transactions.find(t=>t.id==='paid').expiryCreditKind,null,'conflicting sources never choose an arbitrary kind');
    assert.deepEqual(db.prepare('SELECT * FROM transactions ORDER BY id').all(),original);
  } finally { db.close();store.close();rmSync(dataDir,{recursive:true,force:true}); }
});

test('team subscription GIFT is paid, shared observations deduplicate and legacy paid labels remain usable', () => {
  const at='2026-09-25T15:59:59.000Z';
  const record={history_id:'event',user_id:'member',team_id:'team',history_type:2,amount:7700,create_time:Date.parse(at)/1000,trade_source:'TEAMS_VIP_GIFT'};
  const fact={query_scope:'team_total',team_id:'team',login_user_id:'creator',payload:JSON.stringify({data:{records:[record]}})};
  const sources=expirySourceIndex([fact,{...fact,query_scope:'team_member',login_user_id:'member'}]);
  const account={id:'pool',scope:'team_total',spaceId:'team'};
  const tx={id:'pool-expiry',eventId:'event',kind:'expire',amount:-7700,occurredAt:at,chargedPlatformUserId:'member',accountId:'pool'};
  const kind=expiryCreditKind(tx,account,sources);
  assert.equal(kind,'subscription');
  const member={...account,id:'member',scope:'team_member',platformUserId:'member'};
  const transactions=[{...tx,expiryCreditKind:kind},{...tx,id:'member-expiry',accountId:'member',expiryCreditKind:expiryCreditKind(tx,member,sources)}];
  const summary=buildLeaderOverview({accounts:[account,member],transactions,now:Date.parse('2026-09-29T06:00:00Z')}).summary;
  assert.equal(summary.expiry.total,7700);
  assert.equal(expiryCreditKind({...tx,description:'订阅积分到期清零'},account,new Map()),'subscription');
  assert.equal(expiryCreditKind({...tx,description:'积分到期清零'},account,new Map()),null);
  assert.equal(expiryCreditKind({...tx,occurredAt:'2026-09-26T15:59:59.000Z'},account,sources),null);
});
