import test from 'node:test';
import assert from 'node:assert/strict';
import {accountPoolRows} from '../web/account-pool.js';
import {buildLeaderOverview} from '../web/leader-overview.js';

test('account pool includes history-only accounts, deduplicates users and shows member quotas instead of team total',()=>{
  const identities=[{platformUserId:'a',realName:'甲'},{platformUserId:'b',nickname:'历史账号'}];
  const accounts=[{id:'p',platformUserId:'a',scope:'personal',balance:10},{id:'m',platformUserId:'a',scope:'team_member',spaceId:'t',balance:20,lastSyncedAt:'2026-09-20T00:00:00Z'}];
  const teams=[{spaceId:'t',name:'团队',observedAt:'2026-09-28T00:00:00Z',totalBalance:1000,members:[{platformUserId:'a',balance:12}]}];
  const usage=[{platformUserId:'a',employeeId:'one',installationId:'i1',lastSeenAt:'2026-09-27'},{platformUserId:'a',employeeId:'one',installationId:'i2',lastSeenAt:'2026-09-28'}];
  const rows=accountPoolRows(identities,accounts,teams,usage);
  const a=rows.find(row=>row.platformUserId==='a'),b=rows.find(row=>row.platformUserId==='b');
  assert.equal(a.teamBalance,12);assert.equal(a.personalBalance,10);assert.equal(a.users.length,1);assert.equal(a.users[0].installationId,'i2');
  assert.equal(b.personalBalance,null);assert.equal(b.teamBalance,null);
});
test('remapping the charged account recomputes borrowed and lent metrics without changing operator use',()=>{
  const now=Date.parse('2026-09-28T04:00:00Z'),employees=[{id:'a',name:'甲'},{id:'b',name:'乙'}];
  const account={id:'p',platformUserId:'u',scope:'personal',balance:90,lastSyncedAt:'2026-09-28T03:00:00Z'};
  const transaction={id:'tx',accountId:'p',chargedPlatformUserId:'u',occurredAt:'2026-09-28T03:00:00Z',amount:-10,kind:'consume',attribution:'matched',operatorEmployeeId:'a',operatorName:'甲'};
  const view=employeeId=>buildLeaderOverview({accounts:[account],transactions:[{...transaction,ownershipSnapshot:{employeeId,name:employeeId==='a'?'甲':'乙',basis:'current_mapping'}}],identities:[{platformUserId:'u',employeeId,realName:employeeId==='a'?'甲':'乙'}],employees,now});
  assert.equal(view('a').summary.borrowedConsumption,0);
  const borrowed=view('b');assert.equal(borrowed.summary.borrowedConsumption,10);
  assert.equal(borrowed.rows.find(row=>row.employeeId==='a').operatorConsumption,10);
  assert.equal(borrowed.rows.find(row=>row.employeeId==='b').lentConsumption,10);
});
test('a newer roster balance bounds expiry amounts from an older member snapshot',()=>{
  const accounts=[{id:'m',platformUserId:'a',scope:'team_member',spaceId:'t',balance:5000,subscriptionBalance:5000,lastSyncedAt:'2026-09-20T00:00:00Z',creditExpiryEstimate:{rule:'team_subscription_month',grantedAt:'2026-08-30T00:00:00Z',expiresAt:'2026-09-30T00:00:00Z'}}];
  const teams=[{spaceId:'t',observedAt:'2026-09-28T00:00:00Z',members:[{platformUserId:'a',balance:451}]}];
  const [row]=accountPoolRows([{platformUserId:'a'}],accounts,teams,[],Date.parse('2026-09-28T00:00:00Z'));
  assert.equal(row.teamBalance,451);assert.equal(row.upcoming.reduce((sum,item)=>sum+item.amount,0),451);
});
