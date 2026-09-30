import test from 'node:test';
import assert from 'node:assert/strict';
import {transactionActor} from '../web/transaction-actor.js';

test('only expiry and exact daily-grant titles display as platform automatic events',()=>{
  assert.deepEqual(transactionActor({kind:'expire',description:'积分到期'}),{status:'platform',label:'平台自动到期',department:null});
  for(const description of ['每日免费积分','每日赠送','  每日免费积分  ']){
    assert.deepEqual(transactionActor({kind:'grant',description}),{status:'platform',label:'平台自动赠送',department:null});
  }
  for(const description of ['会员积分','团队会员积分','充值赠送','活动赠送','每日赠送积分','每日赠送领取奖励','积分调整','生成扣费','']){
    assert.equal(transactionActor({kind:'grant',description}).status,'unconfirmed',description);
  }
  for(const kind of ['consume','refund','adjustment'])assert.equal(transactionActor({kind,description:'每日赠送'}).label,'无操作凭证');
});

test('display preserves confirmed people and never writes attribution or assigns the account owner',()=>{
  const matched=Object.freeze({kind:'consume',attribution:'matched',operatorName:'员工甲',operatorDepartment:'教研'});
  assert.deepEqual(transactionActor(matched),{status:'matched',label:'实际操作者：员工甲',department:'教研'});
  const unknown=Object.freeze({kind:'consume',attribution:'unconfirmed',operatorName:'未经核实',chargedPlatformUserId:'account-owner'});
  assert.deepEqual(transactionActor(unknown),{status:'unconfirmed',label:'无操作凭证',department:null});
  assert.equal(transactionActor({kind:'consume',attribution:'matched',operatorName:null}).status,'unconfirmed');
  const automatic=Object.freeze({kind:'grant',description:'每日免费积分',attribution:'unconfirmed',operatorName:null});
  transactionActor(automatic);assert.equal(automatic.attribution,'unconfirmed');assert.equal(automatic.operatorName,null);
});
