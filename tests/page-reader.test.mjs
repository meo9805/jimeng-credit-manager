import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readJimengPage} from '../extension/page-reader.mjs';
import {normalizeObservation} from '../extension/normalize.mjs';
import {validateIngest} from '../server/domain.mjs';
const good = n => ({ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:n},creditsDetail:{}}});
// Isolated client preserves the site's request handler order; no response handler
// or global account mutator is available to the collector in this fixture.
function scopedFixture(requests, beforeRequest=()=>{}, responseFor=()=>undefined) {
  const source={interceptors:{request:{handlers:[{fulfilled:config=>{config.headers['X-Team-Id']='visible-team';return config;}}]}},create(){
    const handlers=[];
    return {interceptors:{request:{use(fn){handlers.push(fn);}}},async post(path,body){
      let config={headers:{}};for(const fn of [...handlers].reverse())config=fn(config);
      const team=config.headers['X-Team-Id'];requests.push({path,body,team});beforeRequest(path,{body,team});
      let data=responseFor(path,{body,team});
      if(data !== undefined)return {status:200,data:{ret:'0',data}};
      if(path.endsWith('user_credit'))data={credit:{vip_credit:team?(body.query_scope==='team_all'?21000:7700):100,gift_credit:0,purchase_credit:0},credits_detail:{}};
      else if(path.endsWith('user_credit_history'))data={records:[],has_more:false};
      else if(path.endsWith('get_team_member_list'))data={team_member_list:[{user_id:'u1',nickname:'创建者',role:'Owner',status:'Active',user_credits:{remain_credits:7700}}],member_cnt:1,has_more:false};
      else data={flag:true,cur_vip_level:'ultra',end_time:2000000000,auto_renew_plans:[{can_cancel:true,status:'SUBSCRIBED',level:'ultra',cycle_unit:'MONTH',cycle:12,next_renewal_time:1999999999}]};
      return {status:200,data:{ret:'0',data}};
    }};
  }};
  return {_creditRepository:{__origin__:{_networkClient:source,_getApi:x=>x}},fetchUserCredit(){},fetchUserCreditHistory(){}};
}
const teamDiscovery = {'commercial-team-workspace-service':{_teamManager:{_teamworkDataService:{
  async getTeamList(){return {ok:true,value:{teamList:[{teamId:'t1'},{teamId:'expired'}],hasMore:false}};},
  async getTeamInfo({teamId}){return {ok:true,value:{teamInfo:{teamId,teamName:'团队',currentRole:'Owner',ownerUserId:'u1',memberCnt:1,memberLimit:3,subscriptionInfo:{flag:teamId!=='expired',curLevel:'teams',vipEndTime:2000000000}}}};},
}}},'environment-service':{appId:513695},'dreamina-vip-data-service':{}};

test('all-space collection retains personal, active and inactive team facts without selecting spaces',async()=>{
  const requests=[];
  await withPage(scopedFixture(requests),async state=>{
    const before=structuredClone(state);
    const result=await readJimengPage({collectAllSpaces:true,previousCollections:{'u1:personal:personal':{cursor:'personal-page'},'u1:team:t1:team_total':{cursor:'team-page'}}});
    assert.equal(result.status,'ok');assert.equal(result.observations.length,3);
    assert.equal(result.observations[0].balance,100);assert.equal(result.observations[1].teamTotalCredit,21000);
    assert.equal(result.observations[0].billingCycle,'连续包年');assert.equal(result.observations[0].nextRenewalAt,new Date(1999999999000).toISOString());
    assert.equal(result.observations[1].teamSnapshot.creatorPlatformUserId,'u1');
    assert.equal(result.observations[1].teamSnapshot.membersComplete,true);
    const teamFacts=normalizeObservation(result.observations[1]).creditSourceFacts;
    assert.ok(teamFacts.some(item=>item.source==='user_credit'&&item.queryScope==='team_total'));
    assert.ok(teamFacts.some(item=>item.source==='user_credit_history'&&item.queryScope==='team_total'));
    assert.equal(validateIngest(normalizeObservation(result.observations[1]),Date.now()).rejectedCreditSourceFacts,0);
    assert.deepEqual(state,before);
    const history=requests.filter(x=>x.path.endsWith('user_credit_history'));
    assert.deepEqual(history.map(x=>[x.team,x.body.cursor]),[[undefined,'personal-page'],['t1','team-page'],['expired','0']]);
    assert.ok(requests.every(x=>x.team!=='visible-team'));
    assert.equal(result.observations[2].subscriptionFacts[0].active,false);
  },false,teamDiscovery);
});
test('scoped financial response keeps original platform key names and strips payment links',async()=>{
  const api=scopedFixture([],()=>{},(path,{team})=>!team && path.endsWith('user_credit')?{
    credit:{vip_credit:100,gift_credit:0,purchase_credit:0},credits_detail:{},
    future_amount:123,futureAmount:456,checkout_url:'https://pay.example/checkout?token=private',
    future_note:'ordinary billing metadata',
  }:undefined);
  await withPage(api,async()=>{
    const raw=await readJimengPage({collectAllSpaces:true});
    const personal=normalizeObservation(raw.observations[0]);
    const payload=personal.creditSourceFacts.find(item=>item.source==='user_credit').payload;
    assert.equal(payload.future_amount,123);
    assert.equal(payload.futureAmount,456);
    assert.equal(payload.future_note,'ordinary billing metadata');
    assert.equal(Object.hasOwn(payload,'checkout_url'),false);
    assert.equal(validateIngest(personal,Date.now()).rejectedCreditSourceFacts,0);
  },false,teamDiscovery);
});
test('all-space collection discards the whole batch when the active login context changes in flight',async()=>{
  const requests=[];let state;
  await withPage(scopedFixture(requests,()=>{state.version++;}),async value=>{
    state=value;const result=await readJimengPage({collectAllSpaces:true});
    assert.equal(result.status,'error');assert.equal(result.observations,undefined);
  },false,teamDiscovery);
});
test('a stale credit-ready flag or missing visible space cannot block explicit fresh wallet reads',async()=>{
  for (const missingVisibleAccount of [false,true]) {
    const requests=[];
    await withPage(scopedFixture(requests),async state=>{
      const credit=window.__debugger.DreaminaCommercialFeatureService._commercialCreditService;
      credit.isLocalCreditReady=false;
      if(missingVisibleAccount)state.account=null;
      const result=await readJimengPage({collectAllSpaces:true});
      assert.equal(result.status,'ok');assert.equal(result.observations.length,3);
      assert.deepEqual(result.observations.map(item=>[item.userId,item.balance]),[['u1',100],['u1',7700],['u1',7700]]);
      assert.ok(result.diagnosticCodes.includes('account_read_recovered'));
      assert.equal(credit.isLocalCreditReady,false);assert.equal(credit.localCredit,999999);
      assert.ok(requests.every(request=>request.team!=='visible-team'));
    },false,teamDiscovery);
  }
});
test('scoped recovery remains self-contained after Chrome MAIN-world function serialization',async()=>{
  let replaced=false;
  await withPage(scopedFixture([],()=>{
    if(replaced)return;replaced=true;
    const feature=window.__debugger.DreaminaCommercialFeatureService;
    feature._commercialCreditService={...feature._commercialCreditService};
  }),async()=>{
    const result=await vm.runInNewContext(`(${readJimengPage.toString()})({collectAllSpaces:true})`,{window,location,setTimeout,clearTimeout});
    assert.equal(result.status,'ok');assert.equal(result.observations.length,3);
    assert.ok(result.diagnosticCodes.includes('account_read_recovered'));
  },false,teamDiscovery);
});
test('unready credit service without a working scoped endpoint never fabricates a fresh balance or login binding',async()=>{
  await withPage({},async()=>{
    window.__debugger.DreaminaCommercialFeatureService._commercialCreditService.isLocalCreditReady=false;
    const result=await readJimengPage({collectAllSpaces:true});
    assert.ok(result.observations.every(item=>item.status==='error'));
    assert.ok(result.observations.every(item=>normalizeObservation(item).loginIdentity===undefined));
    assert.ok(result.observations.every(item=>item.diagnosticCodes.includes('credit_api_unavailable')));
    assert.equal(result.diagnosticCodes.includes('account_read_recovered'),false);
  },false,teamDiscovery);
});
test('switching login keeps a completed old-wallet read and reacquires new login and independent cursors',async()=>{
  const requests=[];let switched=false,state;
  const oldSaved={'u1:personal:personal':{cursor:'old-personal-page'},'u2:personal:personal':{cursor:'new-personal-page'}};
  const savedCopy=structuredClone(oldSaved);
  await withPage(scopedFixture(requests,(path,{team})=>{
    if(switched||team!=='t1'||!path.endsWith('user_credit'))return;
    switched=true;state.version++;
    window.__debugger.DreaminaCommercialFeatureService._commerceAccountPort.getSnapshot=()=>({hasLogin:true,userId:'u2',userProfile:{name:'新登录'}});
  }),async value=>{
    state=value;
    const result=await readJimengPage({collectAllSpaces:true,previousCollections:oldSaved});
    assert.equal(result.status,'ok');assert.equal(result.partial,true);
    const valid=result.observations.filter(item=>item.status==='ok');
    assert.deepEqual(valid.map(item=>[item.userId,item.accountType]),[['u1','personal'],['u2','personal'],['u2','team'],['u2','team']]);
    assert.ok(valid.every(item=>item.balanceFresh!==false));
    assert.ok(result.diagnosticCodes.includes('account_read_recovered'));
    assert.deepEqual(oldSaved,savedCopy);
    assert.deepEqual(requests.filter(item=>item.path.endsWith('user_credit_history')&&!item.team).map(item=>item.body.cursor),['old-personal-page','new-personal-page']);
  },false,teamDiscovery);
});
test('a replaced page service is reacquired on the bounded retry even when UID and account key stay equal',async()=>{
  const requests=[];let replaced=false;
  await withPage(scopedFixture(requests,()=>{
    if(replaced)return;replaced=true;
    const feature=window.__debugger.DreaminaCommercialFeatureService;
    window.__debugger.DreaminaCommercialFeatureService={...feature,_commercialCreditService:{...feature._commercialCreditService}};
  }),async()=>{
    const result=await readJimengPage({collectAllSpaces:true});
    assert.equal(result.status,'ok');assert.equal(result.observations.length,3);
    assert.ok(result.observations.every(item=>item.status==='ok'));
    assert.ok(result.diagnosticCodes.includes('account_read_recovered'));
    assert.equal(requests.filter(item=>item.path.endsWith('user_credit_history')).length,3);
  },false,teamDiscovery);
});
test('expected UID is checked before starting a scoped request',async()=>{
  const requests=[];
  await withPage(scopedFixture(requests),async()=>{
    const result=await readJimengPage({targetAccount:{accountType:'personal',accountKey:'personal'},expectedUserId:'previous-login'});
    assert.equal(result.status,'error');assert.deepEqual(result.diagnosticCodes,['account_context_changed']);assert.equal(requests.length,0);
  },false,teamDiscovery);
});
test('one failed team detail does not prevent collecting a later healthy team',async()=>{
  const data=teamDiscovery['commercial-team-workspace-service']._teamManager._teamworkDataService,detailCalls=[];
  const extra={...teamDiscovery,'commercial-team-workspace-service':{_teamManager:{_teamworkDataService:{...data,
    async getTeamList(){return {ok:true,value:{teamList:[{teamId:'broken'},{teamId:'healthy'}],hasMore:false}};},
    async getTeamInfo(args){detailCalls.push(args.teamId);if(args.teamId==='broken')throw new Error('timeout');return data.getTeamInfo(args);},
  }}}};
  await withPage(scopedFixture([]),async()=>{
    const result=await readJimengPage({collectAllSpaces:true});
    assert.equal(result.status,'ok');assert.equal(result.partial,true);
    assert.deepEqual(detailCalls,['broken','healthy']);
    assert.deepEqual(result.observations.map(item=>item.teamId||'personal'),['personal','healthy']);
    assert.equal(result.observations[1].teamTotalCredit,21000);
  },false,extra);
});
test('failed balance reads in one discovered team leave personal and other teams available',async()=>{
  const data=teamDiscovery['commercial-team-workspace-service']._teamManager._teamworkDataService;
  const extra={...teamDiscovery,'commercial-team-workspace-service':{_teamManager:{_teamworkDataService:{...data,
    async getTeamList(){return {ok:true,value:{teamList:[{teamId:'broken'},{teamId:'healthy'}],hasMore:false}};},
  }}}};
  await withPage(scopedFixture([],(path,{team})=>{if(team==='broken'&&path.endsWith('user_credit'))throw new Error('fixture outage');}),async()=>{
    const result=await readJimengPage({collectAllSpaces:true});
    assert.equal(result.status,'ok');assert.equal(result.partial,true);
    assert.deepEqual(result.observations.filter(item=>item.balanceFresh!==false).map(item=>item.teamId||'personal'),['personal','healthy']);
    const broken=result.observations.find(item=>item.teamId==='broken');
    assert.equal(broken.balanceFresh,false);assert.ok(broken.diagnosticCodes.includes('credit_balance_unavailable'));
  },false,extra);
});
async function withPage(api, run, team = false, extra = {}) {
  const previousWindow=globalThis.window, previousLocation=globalThis.location;
  const state={version:1,account:{accountType:team?'team':'personal',accountKey:team?'team:t1':'personal',teamId:team?'t1':null,capability:{canAllocateTeamCredit:team},displayInfo:{teamName:'团队'}}};
  const serviceKey={toString:()=> 'dreamina-credit-data-service'};
  const services=new Map([[serviceKey,api],...Object.entries(extra)]);
  const credit={isLocalCreditReady:true,localCredit:999999,teamTotalCredit:999999,getCurrentAccountSnapshot:()=>({...state})};
  globalThis.location={origin:'https://jimeng.jianying.com'};
  globalThis.window={__debugger:{DreaminaCommercialFeatureService:{_commercialCreditService:credit,
    _commerceAccountPort:{getSnapshot:()=>({hasLogin:true,userId:'u1',userProfile:{name:'测试'}})},
    _containerService:{services:{entries:services},invokeFunction:fn=>fn({get:key=>services.get(key)})},
  }}};
  try{await run(state);}finally{globalThis.window=previousWindow;globalThis.location=previousLocation;}
}
test('failed fresh balance request retains the stable login identity without re-dating cached balance',async()=>{
  await withPage({fetchUserCredit:async()=>({ok:false}),fetchUserCreditHistory:async()=>({ok:false})},async()=>{
    const result=await readJimengPage();assert.equal(result.status,'ok');assert.equal(result.partial,true);assert.equal(result.balanceFresh,false);
    const normalized=normalizeObservation(result);assert.equal(normalized.accounts.length,0);
    assert.deepEqual(normalized.loginIdentity,{platformUserId:'u1',displayName:'测试'});assert.deepEqual(normalized.transactions,[]);
    assert.equal('balance' in result,false);
  });
});
test('missing credit API retains a verified login and resumes the previous ledger cursor after recovery',async()=>{
  await withPage({},async()=>{
    const raw=await readJimengPage({previousAccount:'u1:personal:personal',previousEventId:'old',previousCursor:'5',pendingHeadEventId:'head'});
    assert.equal(raw.status,'ok');assert.equal(raw.partial,true);assert.equal(raw.balanceFresh,false);
    assert.equal(raw.headEventId,'old');assert.equal(raw.nextCursor,'5');assert.equal(raw.pendingHeadEventId,'head');
    const normalized=normalizeObservation(raw);assert.equal(normalized.loginIdentity.platformUserId,'u1');assert.deepEqual(normalized.accounts,[]);assert.deepEqual(normalized.transactions,[]);
  });
});
test('failed team balances still try the independent history endpoint without inventing a balance',async()=>{
  let historyReads=0;
  await withPage({fetchUserCredit:async()=>{throw new Error('unavailable');},fetchUserCreditHistory:async()=>{historyReads++;return {ok:false};}},async()=>{
    const raw=await readJimengPage(),normalized=normalizeObservation(raw);
    assert.equal(raw.status,'ok');assert.equal(raw.partial,true);assert.equal(raw.balanceFresh,false);assert.equal(raw.canReadTeamTotal,false);
    assert.deepEqual(normalized.loginIdentity,{platformUserId:'u1',displayName:'测试'});
    assert.deepEqual(normalized.accounts,[]);assert.deepEqual(normalized.transactions,[]);assert.equal(normalized.teams,undefined);assert.equal(historyReads,1);
    assert.equal('balance' in raw,false);assert.equal('teamTotalCredit' in raw,false);
  },true);
});
test('history remains collectable when the balance format changes',async()=>{
  const api={fetchUserCredit:async()=>({ok:true,value:{credit:{vipCredit:10}}}),
    fetchUserCreditHistory:async()=>({ok:true,value:{records:[{historyId:'balance-independent',historyType:2,amount:5,
      createTime:Math.floor(Date.now()/1000)-10,title:'生成消耗',userId:'u1'}],hasMore:false}})};
  await withPage(api,async()=>{
    const raw=await readJimengPage(),observation=normalizeObservation(raw);
    assert.equal(raw.balanceFresh,false);
    assert.equal(raw.records.length,1);
    assert.equal(observation.accounts.length,0);
    assert.equal(observation.transactions[0].eventId,'balance-independent');
    assert.equal(observation.creditHistoryFacts[0].records[0].historyId,'balance-independent');
  });
});
test('bounded credit-source snapshots keep unknown financial fields and remove credentials and content',async()=>{
  const api={fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:10},
      futureSubscriptionCharge:12345,authkey:'credential'}}),
    fetchUserCreditHistory:async()=>({ok:true,value:{records:[{historyId:'raw-1',historyType:7,amount:-3,
      createTime:Math.floor(Date.now()/1000),futureLedgerField:'future value',prompt:'private creative content'}],hasMore:false}})};
  await withPage(api,async()=>{
    const got=normalizeObservation(await readJimengPage());
    const balance=got.creditSourceFacts.find(f=>f.source==='user_credit').payload;
    const history=got.creditSourceFacts.find(f=>f.source==='user_credit_history').payload;
    assert.equal(balance.futureSubscriptionCharge,12345);
    assert.equal('authkey' in balance,false);
    assert.equal(history.data.records[0].futureLedgerField,'future value');
    assert.equal('prompt' in history.data.records[0],false);
    const validated=validateIngest(got,Date.now());
    assert.equal(validated.rejectedCreditSourceFacts,0);
    assert.equal(validated.creditSourceFacts.length,2);
  });
});
test('large financial source arrays retain their final item when split into bounded facts',async()=>{
  const records=Array.from({length:201},(_,index)=>({historyId:'history-'+index,amount:-1,futureLedgerField:index}));
  await withPage({
    fetchUserCredit:async()=>good(10),
    fetchUserCreditHistory:async()=>({ok:true,value:{records,hasMore:false}}),
  },async()=>{
    const raw=await readJimengPage();
    const normalized=normalizeObservation(raw);
    const chunks=normalized.creditSourceFacts.filter(item=>item.source==='user_credit_history');
    assert.equal(raw.sourceCapturePartial,undefined);
    assert.equal(chunks[0].payload.part,'metadata');
    assert.equal(chunks[0].payload.arrayFields[0].count,201);
    assert.equal(chunks.at(-1).payload.offset,200);
    assert.equal(chunks.at(-1).payload.items[0].historyId,'history-200');
    assert.equal(validateIngest({...normalized,creditSourceFacts:chunks.slice(0,16)},Date.now()).rejectedCreditSourceFacts,0);
  });
});
test('signed-out and not-ready page state never emits login identity',async()=>{
  await withPage({},async()=>{
    const feature=window.__debugger.DreaminaCommercialFeatureService;
    feature._commerceAccountPort.getSnapshot=()=>({hasLogin:false,userId:'stale'});
    const signedOut=await readJimengPage();assert.equal(signedOut.status,'login_required');assert.equal(normalizeObservation(signedOut).loginIdentity,undefined);
    feature._commerceAccountPort.getSnapshot=()=>({hasLogin:true,userId:'u1'});
    feature._commercialCreditService.isLocalCreditReady=false;
    const unready=await readJimengPage();assert.equal(unready.status,'error');assert.equal(normalizeObservation(unready).loginIdentity,undefined);
  });
});
test('failed balance requests after a login change or sign-out discard the earlier identity',async()=>{
  for(const change of ['switch','signout','unready']){
    let resolve;const pendingCredit=new Promise(done=>resolve=done);
    await withPage({fetchUserCredit:()=>pendingCredit,fetchUserCreditHistory:async()=>({ok:false})},async()=>{
      const pending=readJimengPage(),feature=window.__debugger.DreaminaCommercialFeatureService;
      if(change==='unready')feature._commercialCreditService.isLocalCreditReady=false;
      else feature._commerceAccountPort.getSnapshot=()=>({hasLogin:change!=='signout',userId:'changed-user'});
      resolve({ok:false});const raw=await pending;
      assert.equal(raw.status,'error');assert.equal(normalizeObservation(raw).loginIdentity,undefined);assert.deepEqual(normalizeObservation(raw).accounts,[]);
    });
  }
});
test('membership expiry, next renewal and credit expiry remain separate fresh observations',async()=>{
  const api={fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:25930},creditsDetail:{vipCredits:[{residualCredits:25930,creditsLifeEnd:2000000000}]}}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})};
  await withPage(api,async()=>{
    const result=normalizeObservation(await readJimengPage()); const a=result.accounts[0];
    assert.equal(a.membershipPlan,'超级会员');assert.equal(a.billingCycle,'连续包年');
    assert.equal(a.membershipExpiresAt,new Date(2100000000*1000).toISOString());
    assert.equal(a.nextRenewalAt,new Date(2099913600*1000).toISOString());
    assert.equal(a.expiresAt,new Date(2000000000*1000).toISOString());
  },false,{'environment-service':{appId:'513695'},'dreamina-vip-data-service':{fetchVIPInfo:async opts=>{
    assert.equal(opts.aid,513695);return {ok:true,value:{flag:true,curVipLevel:'ultra',endTime:2100000000,currentAutoRenewPlan:{level:'ultra',status:'SUBSCRIBED',cycle:12,cycleUnit:'YEAR',nextRenewalTime:2099913600}}};
  }}});
});
test('bounded ledger reads resume from the returned cursor before advancing the watermark',async()=>{
  const cursors=[];const api={fetchUserCredit:async()=>good(10),fetchUserCreditHistory:async(_,opts)=>{
    const n=Number(opts.cursor);cursors.push(n);return {ok:true,value:{records:[{historyId:'e'+n}],hasMore:n<6,newCursor:String(n+1)}};
  }};
  await withPage(api,async()=>{
    const first=await readJimengPage();assert.equal(first.records.length,5);assert.equal(first.nextCursor,'5');assert.equal(first.headEventId,null);assert.equal(first.pendingHeadEventId,'e0');
    const second=await readJimengPage({previousAccount:first.collectionKey,previousCursor:first.nextCursor,pendingHeadEventId:first.pendingHeadEventId});
    assert.deepEqual(cursors,[0,1,2,3,4,5,6]);assert.equal(second.nextCursor,null);assert.equal(second.headEventId,'e0');
  });
});
test('partial ledger failure retains the old watermark and retries the failed page',async()=>{
  const api={fetchUserCredit:async()=>good(10),fetchUserCreditHistory:async(_,opts)=>opts.cursor==='0'?{ok:true,value:{records:[{historyId:'new'}],hasMore:true,newCursor:'next'}}:{ok:false}};
  await withPage(api,async()=>{
    const first=await readJimengPage({previousAccount:'u1:personal:personal',previousEventId:'old'});
    assert.equal(first.headEventId,'old');assert.equal(first.nextCursor,'next');assert.equal(first.pendingHeadEventId,'new');
  });
});
test('numeric platform IDs and signed amounts survive the scoped page read',async()=>{
  const api={fetchUserCredit:async()=>good(10),fetchUserCreditHistory:async()=>({ok:true,value:{hasMore:false,
    records:[{historyId:12345,submitId:67890,historyType:9,amount:-7,createTime:Math.floor(Date.now()/1000),
      userId:1001,title:'平台新类型',status:'Unknown'}]}})};
  await withPage(api,async()=>{
    const raw=await readJimengPage();
    assert.equal(raw.headEventId,'12345');
    assert.deepEqual([raw.records[0].historyId,raw.records[0].submitId,raw.records[0].amount,raw.records[0].userId],
      ['12345','67890',-7,'1001']);
    const normalized=normalizeObservation(raw);
    assert.equal(normalized.transactions.length,0);
    assert.equal(normalized.creditHistoryFacts[0].records[0].submitId,'67890');
  });
});
test('team pool uses independent fresh balance and preserves the charged platform member',async()=>{
  const calls=[];
  const api={fetchUserCredit:async(_,opts)=>{calls.push(opts?.queryScope);return good(opts?.queryScope==='team_all'?21000:7700);},
    fetchUserCreditHistory:async()=>({ok:true,value:{hasMore:false,records:[{historyId:'e1',amount:240,title:'视频生成',historyType:2,createTime:Math.floor(Date.now()/1000)-60,userId:'u2',teamId:'t1'}]}})};
  await withPage(api,async()=>{
    const raw=await readJimengPage();const result=normalizeObservation(raw);
    assert.deepEqual(calls,['team_member','team_all']);
    assert.equal(raw.teamTotalCredit,21000);assert.equal(raw.balance,7700);
    assert.equal(result.transactions[0].chargedPlatformUserId,'u2');
    assert.equal(result.transactions[0].scope,'team_total');
  },true);
});
test('changing account during a pending read discards all results',async()=>{
  let resolve;const deferred=new Promise(r=>resolve=r);
  await withPage({fetchUserCredit:()=>deferred,fetchUserCreditHistory:async()=>({ok:true,value:{records:[]}})},async state=>{
    const pending=readJimengPage();state.version=2;state.account={accountType:'team',accountKey:'team:new'};resolve(good(10));
    const result=await pending;assert.equal(result.status,'error');assert.equal(normalizeObservation(result).accounts.length,0);
    assert.equal(normalizeObservation(result).loginIdentity,undefined);
  });
});
test('team creator and member credits come from the platform roster, not the collecting login',async()=>{
  const api={fetchUserCredit:async(_,options)=>({...good(options?.queryScope==='team_all'?21000:5600),value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:options?.queryScope==='team_all'?21000:5600},allocatableCredit:0}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})};
  await withPage(api,async()=>{
    window.__debugger.DreaminaCommercialFeatureService._membershipService={snapshot:{team:{vipLevel:'teams',expireTime:2100000000}}};
    const raw=await readJimengPage(), result=normalizeObservation(raw), team=result.teams[0];
    assert.equal(team.creatorPlatformUserId,'u2');assert.equal(team.creatorDisplayName,'创建者本人');
    assert.equal(team.members.length,2);assert.equal(team.members[0].role,'creator');assert.equal(team.members[1].role,'member');
    assert.equal(team.members[1].usedCredits,2100);assert.equal(team.members[1].balance,5600);assert.equal(team.allocatableBalance,0);
    assert.equal(team.membersComplete,true);assert.equal(team.totalSeats,3);assert.equal(team.availableSeats,1);
    assert.equal(result.accounts.length,2);assert.ok(result.accounts.every(a=>a.platformUserId==='u1'));
  },true,{'commercial-team-workspace-service':{
    refreshCurrentTeamDetail:async()=>({ok:true,value:{teamId:'t1',teamName:'团队',ownerUserId:'u2',creatorUserId:'u2',memberCnt:2,memberLimit:3}}),
    refreshMembers:async()=>({ok:true,value:{hasMore:false,total:2,list:[
      {userId:'u2',nickname:'创建者本人',role:'Owner',status:'Active',joinTime:1700000000,userCredits:{remainCredits:7700,consumedCredits:0}},
      {userId:'u1',nickname:'协作者',role:'Collaborator',status:'Active',joinTime:1700000000,userCredits:{remainCredits:5600,consumedCredits:2100}},
    ]}}),
  }});
});
test('member-list failure keeps a valid team observation explicitly incomplete',async()=>{
  await withPage({fetchUserCredit:async()=>good(10),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})},async()=>{
    window.__debugger.DreaminaCommercialFeatureService._membershipService={snapshot:{team:{vipLevel:'teams',expireTime:2100000000}}};
    const result=normalizeObservation(await readJimengPage());assert.equal(result.teams[0].membersComplete,false);assert.equal(result.teams[0].members.length,0);assert.equal(result.teams[0].creatorPlatformUserId,'u2');
  },true,{'commercial-team-workspace-service':{refreshCurrentTeamDetail:async()=>({ok:true,value:{teamId:'t1',ownerUserId:'u2'}}),refreshMembers:async()=>({ok:false})}});
});
test('credit batches separate the small expiring gift from subscription credits and ignore empty batches',async()=>{
  const api={fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:30,purchaseCredit:0,vipCredit:23272},creditsDetail:{
    vipCredits:[{residualCredits:0,creditsLifeEnd:1700000000},{vipLevel:'ultra',residualCredits:23272,creditsLifeEnd:1790600765}],
    giftCredits:[{residualCredits:30,creditsLifeEnd:1789487999}],
  }}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})};
  await withPage(api,async()=>{
    const account=normalizeObservation(await readJimengPage()).accounts[0];
    assert.equal(account.balance,23302);
    assert.equal(account.creditBatchesComplete,true);
    assert.deepEqual(account.creditBatches,[
      {kind:'subscription',amount:23272,expiresAt:new Date(1790600765*1000).toISOString()},
      {kind:'gift',amount:30,expiresAt:new Date(1789487999*1000).toISOString()},
    ]);
    assert.equal(account.expiresAt,new Date(1789487999*1000).toISOString());
  });
});
test('missing, inconsistent and unknown batch amounts never become complete expiry coverage',async()=>{
  const cases=[
    {details:{},expected:[]},
    {details:{vipCredits:[{residualCredits:5,creditsLifeEnd:2000000000}]},expected:[5]},
    {details:{vipCredits:[{residualCredits:10,creditsLifeEnd:2000000000},{creditsLifeEnd:1900000000}]},expected:[10]},
    {details:{vipCredits:[{residualCredits:10,creditsLifeEnd:2000000000}],giftCredits:{}},expected:[10]},
  ];
  for(const {details,expected} of cases) await withPage({fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:10},creditsDetail:details}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})},async()=>{
    const account=normalizeObservation(await readJimengPage()).accounts[0];
    assert.equal(account.creditBatchesComplete,false);assert.deepEqual(account.creditBatches.map(batch=>batch.amount),expected);
  });
});
test('positive batches with unknown expiry retain the amount without inventing a date',async()=>{
  await withPage({fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:0,purchaseCredit:3,vipCredit:0},creditsDetail:{purchaseCredits:[{residualCredits:3,creditsLifeEnd:null}]}}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})},async()=>{
    const account=normalizeObservation(await readJimengPage()).accounts[0];
    assert.deepEqual(account.creditBatches,[{kind:'purchase',amount:3,expiresAt:null}]);
    assert.equal(account.creditBatchesComplete,true);assert.equal(account.expiresAt,null);
  });
});
test('team member and team pool retain their own independent expiry batches',async()=>{
  const api={fetchUserCredit:async(_,options)=>{const pool=options?.queryScope==='team_all';return {ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:pool?21000:7700},creditsDetail:{vipCredits:[{residualCredits:pool?21000:7700,creditsLifeEnd:pool?2100000000:2000000000}]}}};},fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})};
  await withPage(api,async()=>{
    const result=normalizeObservation(await readJimengPage());
    const member=result.accounts.find(account=>account.scope==='team_member'),pool=result.accounts.find(account=>account.scope==='team_total');
    assert.deepEqual(member.creditBatches,[{kind:'subscription',amount:7700,expiresAt:new Date(2000000000*1000).toISOString()}]);
    assert.deepEqual(pool.creditBatches,[{kind:'subscription',amount:21000,expiresAt:new Date(2100000000*1000).toISOString()}]);
    assert.equal(member.creditBatchesComplete,true);assert.equal(pool.creditBatchesComplete,true);
  },true);
});
test('normalization retains only safe batch fields and independently checks the reported coverage',()=>{
  const base={observedAt:new Date().toISOString(),status:'ok',userId:'u1',accountType:'personal',balance:10,giftCredit:0,purchaseCredit:0,vipCredit:10,creditBatchesComplete:true};
  const valid=normalizeObservation({...base,creditBatches:[{kind:'subscription',amount:10,expiresAt:'2033-05-18T03:33:20.000Z',prompt:'not collected'}]}).accounts[0];
  assert.equal(valid.creditBatchesComplete,true);assert.equal('prompt' in valid.creditBatches[0],false);
  const invalid=normalizeObservation({...base,creditBatches:[{kind:'subscription',amount:5,expiresAt:'invalid'},{kind:'unknown',amount:5}]}).accounts[0];
  assert.equal(invalid.creditBatchesComplete,false);assert.deepEqual(invalid.creditBatches,[{kind:'subscription',amount:5,expiresAt:null}]);
  const old=normalizeObservation({...base,creditBatches:undefined}).accounts[0];
  assert.equal('creditBatches' in old,false);assert.equal('creditBatchesComplete' in old,false);
  const team=normalizeObservation({...base,accountType:'team',teamId:'t1',canReadTeamTotal:true,teamTotalCredit:20,teamGiftCredit:0,teamPurchaseCredit:0,teamVipCredit:20,creditBatches:[{kind:'subscription',amount:10,expiresAt:null}]}).accounts.find(account=>account.scope==='team_total');
  assert.equal('creditBatches' in team,false);
});
test('large batch lists are bounded and marked incomplete',async()=>{
  await withPage({fetchUserCredit:async()=>({ok:true,value:{credit:{giftCredit:0,purchaseCredit:0,vipCredit:201},creditsDetail:{vipCredits:Array.from({length:201},()=>({residualCredits:1,creditsLifeEnd:2000000000}))}}}),fetchUserCreditHistory:async()=>({ok:true,value:{records:[],hasMore:false}})},async()=>{
    const account=normalizeObservation(await readJimengPage()).accounts[0];
    assert.equal(account.creditBatches.length,200);assert.equal(account.creditBatchesComplete,false);
  });
});
