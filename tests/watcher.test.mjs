import test from 'node:test';
import assert from 'node:assert/strict';
import {installCreditWatcher} from '../extension/page-watcher.mjs';

test('page watcher debounces real balance/account changes and ignores unchanged refresh callbacks',()=>{
  const old=globalThis.window;
  let creditCallback,accountCallback,interval,serial=0,accountKey='personal',userId='u1';
  const timers=new Map(),signals=[];
  const credit={localCredit:100,teamTotalCredit:null,getCurrentAccountSnapshot:()=>({account:{accountKey,accountType:'personal'}}),
    onLocalCreditChange(fn){creditCallback=fn;return {dispose(){}};}};
  globalThis.window={location:{origin:'https://jimeng.jianying.com'},
    __debugger:{DreaminaCommercialFeatureService:{commercialCreditService:credit,_commerceAccountPort:{getSnapshot:()=>({hasLogin:true,userId}),subscribe(fn){accountCallback=fn;return{dispose(){}};}}}},
    setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    setInterval(fn){interval=fn;return 1;},clearInterval(){},addEventListener(){},postMessage(value){signals.push(value);}};
  const flush=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}};
  try{
    assert.equal(installCreditWatcher().installed,true);flush();assert.equal(signals.length,1);
    creditCallback();accountCallback();interval();installCreditWatcher();flush();assert.equal(signals.length,1);
    credit.localCredit=90;creditCallback();credit.localCredit=80;creditCallback();flush();assert.equal(signals.length,2);
    // A fresh API read emits the same callback but does not change the state fingerprint.
    creditCallback();interval();flush();assert.equal(signals.length,2);
    credit.localCredit=100;creditCallback();flush();assert.equal(signals.length,3);
    accountKey='team:2';userId='u2';accountCallback();flush();assert.equal(signals.length,4);
    assert.deepEqual(signals[3],{source:'jimeng-credit-manager',type:'credit-change'});
  }finally{globalThis.window=old;}
});
