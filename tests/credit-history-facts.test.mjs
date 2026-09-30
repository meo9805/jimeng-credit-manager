import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { validateIngest } from '../server/domain.mjs';

const NOW = Date.parse('2026-09-23T02:00:00.000Z');
const READ_AT = '2026-09-23T01:59:00.000Z';
const record = { historyId:'event.1', historyType:8, amount:'35.5', title:'平台积分变动',
  createTime:1789955940, status:'done', teamId:null, userId:'borrowed-account', submitId:'submit.1' };

test('raw credit facts survive unknown types and shared-account collection without becoming counted consumption', t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(),'jmc-credit-facts-'));
  const store = createStore({dataDir,secret:'test-only',clock:()=>NOW});
  const department = store.createDepartment({name:'测试部门'});
  const employeeA = store.createEmployee({name:'甲',departmentId:department.id});
  const employeeB = store.createEmployee({name:'乙',departmentId:department.id});
  const collectorA = store.createInstallation({employeeId:employeeA.id,role:'collector'});
  const collectorB = store.createInstallation({employeeId:employeeB.id,role:'collector'});
  const db = new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const ingest = (collector,facts) => store.ingest(collector,validateIngest({observedAt:READ_AT,status:'ok',accounts:[],transactions:[],
    creditHistoryFacts:[{context:{loginUserId:'borrowed-account',queryScope:'personal',teamId:null,readAt:READ_AT},records:facts}]},NOW));

  assert.equal(ingest(collectorA,[record]).creditHistoryFacts,1);
  assert.equal(ingest(collectorA,[record]).creditHistoryFacts,1);
  assert.equal(ingest(collectorB,[record]).creditHistoryFacts,1);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT fact_key) count FROM credit_history_facts').get().count,1);
  const sightings=db.prepare('SELECT installation_id,collector_employee_id,record FROM credit_history_facts ORDER BY installation_id').all();
  assert.equal(sightings.length,2);
  assert.deepEqual(new Set(sightings.map(row=>row.collector_employee_id)),new Set([employeeA.id,employeeB.id]));
  assert.equal(JSON.parse(sightings[0].record).historyType,8);
  assert.equal(store.dashboard().transactions.length,0);
  assert.equal(store.dashboard().accounts.length,0);

  ingest(collectorA,[{...record,amount:'36.5'}]);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT fact_key) count FROM credit_history_facts').get().count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM credit_history_facts').get().count,3,'a changed platform record remains a distinct raw variant');
  store.deleteInstallation(collectorA.id);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM credit_history_facts WHERE installation_id=?').get(collectorA.id).count,2,
    'retiring a collector keeps the original source of already collected facts');
});

test('malformed raw fact is isolated while valid facts remain available for later server interpretation', t => {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-credit-fact-isolation-'));
  const store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  const department=store.createDepartment({name:'测试部门'});
  const employee=store.createEmployee({name:'员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const facts=[{...record,historyId:null,historyType:'future-type',amount:-12},
    {...record,historyId:'bad',prompt:'sensitive content'},
    {...record,historyId:'credential',title:'cookie=secret'}];
  const input=validateIngest({observedAt:READ_AT,accounts:[],transactions:[],creditHistoryFacts:[
    {context:{loginUserId:'borrowed-account',queryScope:'personal',teamId:null,readAt:READ_AT},records:facts}]},NOW);
  assert.equal(input.rejectedFacts,2);
  assert.equal(input.creditHistoryFacts[0].records.length,1);
  const result=store.ingest(device,input);
  assert.equal(result.rejectedCreditHistoryFacts,2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM credit_history_facts').get().count,1);
});

test('the same team history viewed through two logins retains both account sources', t => {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-team-fact-sources-'));
  const store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  const department=store.createDepartment({name:'测试部门'});
  const employee=store.createEmployee({name:'员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const ingest=loginUserId=>store.ingest(device,validateIngest({observedAt:READ_AT,accounts:[],transactions:[],
    creditHistoryFacts:[{context:{loginUserId,queryScope:'team_total',teamId:'team-1',readAt:READ_AT},
      records:[{...record,teamId:'team-1',userId:'charged-member'}]}]},NOW));
  ingest('login-a');
  ingest('login-b');
  const rows=db.prepare('SELECT fact_key,login_user_id,collector_employee_id FROM credit_history_facts').all();
  assert.equal(rows.length,2);
  assert.deepEqual(new Set(rows.map(row=>row.login_user_id)),new Set(['login-a','login-b']));
  assert.equal(new Set(rows.map(row=>row.fact_key)).size,2);
  assert.ok(rows.every(row=>row.collector_employee_id===employee.id));
  assert.equal(store.dashboard().transactions.length,0);
});

test('subscription facts retain member context without inventing a paid price', t => {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-subscription-facts-'));
  const store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  const department=store.createDepartment({name:'测试部门'});
  const employee=store.createEmployee({name:'员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const fact={spaceType:'team',loginUserId:'borrowed-account',teamId:'team-1',readAt:READ_AT,active:true,
    planLevel:'teams_super',productId:null,subscribeCycle:null,cycleUnit:null,startTime:null,endTime:1900000000,nextRenewalTime:null};
  const input=validateIngest({observedAt:READ_AT,accounts:[],transactions:[],subscriptionFacts:[fact,
    {...fact,loginUserId:'bad',subscribeId:'secret'}]},NOW);
  assert.equal(input.rejectedSubscriptionFacts,1);
  const result=store.ingest(device,input);
  assert.equal(result.subscriptionFacts,1);
  const row=db.prepare('SELECT * FROM subscription_facts').get();
  assert.equal(row.collector_employee_id,employee.id);
  assert.equal(row.login_user_id,'borrowed-account');
  assert.equal(JSON.parse(row.record).productId,null);
  assert.equal(Object.hasOwn(JSON.parse(row.record),'paidAmount'),false);
  assert.equal(store.dashboard().transactions.length,0);
});

test('bounded financial source snapshots retain response changes and isolate unsafe payloads', t => {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-source-facts-'));
  const store=createStore({dataDir,secret:'test-only',clock:()=>NOW});
  const department=store.createDepartment({name:'测试部门'});
  const employee=store.createEmployee({name:'员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const db=new DatabaseSync(path.join(dataDir,'credits.sqlite'));
  t.after(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const base={source:'user_credit',loginUserId:'borrowed-account',teamId:null,queryScope:'personal',readAt:READ_AT};
  const valid={...base,payload:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:6900},futureFinancialField:100}};
  const unsafe={...base,payload:{data:{nested:{auth_key:'secret'}}}};
  const oversized={...base,payload:{data:Array(190).fill('a'.repeat(800))}};
  const checkoutLink={...base,payload:{checkoutUrl:'https://pay.example.test/checkout?token=secret'}};
  const input=validateIngest({observedAt:READ_AT,accounts:[],transactions:[],creditSourceFacts:[valid,unsafe,oversized,checkoutLink]},NOW);
  assert.equal(input.rejectedCreditSourceFacts,3);
  assert.equal(input.creditSourceFacts.length,1);
  assert.equal(store.ingest(device,input).creditSourceFacts,1);
  store.ingest(device,validateIngest({observedAt:READ_AT,accounts:[],transactions:[],creditSourceFacts:[valid]},NOW));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM credit_source_facts').get().count,1);
  const changed={...valid,payload:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:7900},futureFinancialField:100}};
  store.ingest(device,validateIngest({observedAt:READ_AT,accounts:[],transactions:[],creditSourceFacts:[changed]},NOW));
  const rows=db.prepare('SELECT * FROM credit_source_facts').all();
  assert.equal(rows.length,2);
  assert.ok(rows.every(row=>row.collector_employee_id===employee.id && row.login_user_id==='borrowed-account'));
  assert.deepEqual(new Set(rows.map(row=>JSON.parse(row.payload).credit.vipCredit)),new Set([6900,7900]));
  assert.equal(store.dashboard().transactions.length,0);
});
