import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObservation } from '../extension/normalize.mjs';
const base = () => ({ observedAt: new Date().toISOString(), status: 'ok', userId: '10001', displayName: '测试账号',
  accountType: 'personal', balance: 1000, giftCredit: 0, purchaseCredit: 0, vipCredit: 1000, records: [] });
const row = extra => ({ historyId: 'test-1', amount: 90, title: '视频生成', historyType: 2, status: 'Checked', createTime: Math.floor(Date.now()/1000)-100, ...extra });
test('failed debit remains debit, separate refund is positive and duplicates collapse', () => {
  const raw = { ...base(), records: [row({status:'CheckFailed'}), row({status:'CheckFailed'}), row({historyId:'refund-1',title:'失败返还',historyType:1})] };
  const got=normalizeObservation(raw);
  assert.equal(got.transactions.length,2);
  assert.deepEqual(got.transactions.map(r=>[r.kind,r.amount]),[['consume',-90],['refund',90]]);
  assert.equal(got.transactions.reduce((s,r)=>s+r.amount,0),0);
  assert.equal('operatorName' in got.transactions[0],false);
});
test('team member allocation and pool balance use different scopes and breakdowns', () => {
  const got=normalizeObservation({...base(),accountType:'team',teamId:'team-1',teamName:'测试团队',balance:7700,vipCredit:7700,canReadTeamTotal:true,teamTotalCredit:21000});
  assert.equal(got.accounts.length,2);
  assert.deepEqual(got.accounts.map(a=>[a.scope,a.balance]),[['team_member',7700],['team_total',21000]]);
  assert.equal(got.accounts[1].subscriptionBalance,null);
});
test('unknown is not zero; invalid IDs and foreign member history are not attributed', () => {
  assert.equal(normalizeObservation({...base(),balance:null,vipCredit:null}).accounts[0].balance,null);
  assert.equal(normalizeObservation({...base(),userId:''}).accounts.length,0);
  const got=normalizeObservation({...base(),accountType:'team',teamId:'team-1',records:[row({teamId:'other'}),row({historyId:'x',userId:'other'})]});
  assert.equal(got.transactions.length,0);
});
test('expired points are not generation consumption; unknown event IDs are skipped', () => {
  const got=normalizeObservation({...base(),records:[row({title:'团队会员失效积分失效'}),row({historyId:''})]});
  assert.equal(got.transactions.length,1);assert.equal(got.transactions[0].kind,'expire');
});
test('team grant space IDs are not people; member IDs remain intact', () => {
  const got=normalizeObservation({...base(),accountType:'team',teamId:'team-1',ledgerScope:'team_total',records:[
    row({historyId:'grant',title:'团队会员积分',historyType:1,userId:'team-1',teamId:'team-1'}),
    row({historyId:'member',userId:'member-123',teamId:'team-1'}),
  ]});
  assert.equal(got.transactions[0].chargedPlatformUserId,null);
  assert.equal(got.transactions[1].chargedPlatformUserId,'member-123');
});
test('credit event and submit IDs accepted by the server are not dropped in the collector', () => {
  const got=normalizeObservation({...base(),records:[row({historyId:'credit.event-1',submitId:'task.1@jimeng'})]});
  assert.equal(got.transactions.length,1);
  assert.equal(got.transactions[0].eventId,'credit.event-1');
  assert.equal(got.transactions[0].platformSubmitId,'task.1@jimeng');
});
test('raw credit facts retain unclassified and foreign-account rows without attributing them', () => {
  const got=normalizeObservation({...base(),records:[row({historyId:12345,submitId:67890,historyType:9,amount:-7,
    userId:'another-account',title:'平台新类型',status:'Unknown'})]});
  assert.equal(got.transactions.length,0);
  assert.deepEqual(got.creditHistoryFacts[0].context,{loginUserId:'10001',queryScope:'personal',teamId:null,readAt:got.observedAt});
  assert.deepEqual(got.creditHistoryFacts[0].records[0],{historyId:'12345',submitId:'67890',historyType:9,
    amount:-7,createTime:got.creditHistoryFacts[0].records[0].createTime,userId:'another-account',teamId:null,
    title:'平台新类型',status:'Unknown'});
});
test('raw credit facts do not include unrelated page response fields', () => {
  const got=normalizeObservation({...base(),records:[row({prompt:'private prompt',cookie:'secret',assetUrl:'https://example.test/a'})]});
  assert.equal('prompt' in got.creditHistoryFacts[0].records[0],false);
  assert.equal('cookie' in got.creditHistoryFacts[0].records[0],false);
  assert.equal('assetUrl' in got.creditHistoryFacts[0].records[0],false);
});
