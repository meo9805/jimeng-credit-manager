import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { creditExpiryDates,creditExpiryDueSoon,teamCreditExpiryEstimate,estimatedExpiryLabel } from '../web/credit-expiry.js';

const bundled=buildSync({entryPoints:[fileURLToPath(new URL('../web/ExpiryBadge.jsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react'],write:false});
const component={exports:{}};
new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),component,component.exports);
const render=account=>renderToStaticMarkup(createElement(component.exports.ExpiryBadge,{account}));
const renderCompact=account=>renderToStaticMarkup(createElement(component.exports.ExpiryBadge,{account,compact:true}));

test('fresh team balances with empty batches report unavailable expiry rather than pending synchronization',()=>{
  for(const [scope,balance] of [['team_member',7700],['team_total',21000]]){
    const html=render({scope,balance,status:'ok',lastSyncedAt:new Date().toISOString(),creditBatches:[],creditBatchesComplete:false,membershipExpiresAt:'2027-09-01T00:00:00Z'});
    assert.match(html,/到期日未获取/);assert.match(html,/credit-expiry-badge unknown/);
    assert.doesNotMatch(html,/待同步|2027|9\/1|重新|刷新/);
  }
  assert.match(render({}),/到期日未获取/);
});

test('known membership and gift batches retain their separate amounts, exact expiry and styles',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-15T00:00:00Z')});
  const html=render({creditBatchesComplete:true,creditBatches:[{kind:'subscription',amount:23272,expiresAt:'2027-09-28T00:00:00+08:00'},{kind:'gift',amount:30,expiresAt:'2027-09-15T00:00:00+08:00'}]});
  assert.match(html,/会员 23,272 分 · 9\/28 到期/);assert.match(html,/赠送 30 分 · 9\/15 到期/);
  assert.match(html,/2027年9月28日/);assert.match(html,/2027年9月15日/);
  assert.doesNotMatch(html,/未获取|待同步/);
});

test('account cards show only the nearest upcoming batch while details retain every batch',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-24T00:00:00+08:00')});
  const account={creditBatchesComplete:true,creditBatches:[
    {kind:'subscription',amount:571,expiresAt:'2026-09-28T00:00:00+08:00'},
    {kind:'gift',amount:80,expiresAt:'2026-09-25T00:00:00+08:00'},
  ]};
  assert.match(renderCompact(account),/赠送 80 分 · 9\/25 到期/);
  assert.doesNotMatch(renderCompact(account),/会员 571 分/);
  assert.match(render(account),/会员 571 分/);
});

test('unknown batch dates and missing legacy amounts remain visible without promising another sync',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-15T00:00:00Z')});
  const partial=render({creditBatchesComplete:false,creditBatches:[{kind:'subscription',amount:7700,expiresAt:null}]});
  assert.match(partial,/会员 7,700 分 · 到期日未获取/);assert.match(partial,/其余批次未获取/);
  const legacy=render({expiresAt:'2027-09-28T00:00:00+08:00'});
  assert.match(legacy,/部分积分 9\/28 到期 · 金额未获取/);
  assert.doesNotMatch(partial+legacy,/待同步/);
});

const teamEstimate={expiresAt:'2026-09-28T00:00:00+08:00',grantedAt:'2026-08-28T00:00:00+08:00',sourceEventId:'team-grant',rule:'team_subscription_month'};

test('member and pool show an explicitly estimated expiry without fabricating a batch amount',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-24T00:00:00+08:00')});
  for(const [scope,balance] of [['team_member',7700],['team_total',21000]]){
    const html=render({scope,balance,creditBatches:[],creditBatchesComplete:false,creditExpiryEstimate:teamEstimate});
    assert.match(html,/预计 9\/28 到期/);assert.match(html,/estimated urgent/);
    assert.match(html,/按团队会员积分发放日 2026\/08\/28 加一个月估算/);
    assert.doesNotMatch(html,/7,700|21,000|到期日未获取|待同步/);
  }
});

test('official account or subscription expiry overrides an estimate while gift batches retain their exact dates',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-15T00:00:00Z')});
  const account={scope:'team_member',balance:7700,creditExpiryEstimate:teamEstimate};
  const official=render({...account,expiresAt:'2026-09-30T00:00:00+08:00'});
  assert.match(official,/9\/30 到期/);assert.doesNotMatch(official,/预计/);
  const subscription=render({...account,creditBatchesComplete:true,creditBatches:[{kind:'subscription',amount:7700,expiresAt:'2026-10-01T00:00:00+08:00'}]});
  assert.match(subscription,/会员 7,700 分 · 10\/1 到期/);assert.doesNotMatch(subscription,/预计/);
  const gift=render({...account,creditBatchesComplete:false,creditBatches:[{kind:'gift',amount:30,expiresAt:'2026-09-16T00:00:00+08:00'}]});
  assert.match(gift,/赠送 30 分 · 9\/16 到期/);assert.match(gift,/预计 9\/28 到期/);
});

test('estimated expiry remains overdue without rolling forward and does not enter upcoming-only filters',t=>{
  const now=Date.parse('2026-10-15T00:00:00+08:00');t.mock.timers.enable({apis:['Date'],now});
  const account={scope:'team_total',balance:21000,creditExpiryEstimate:teamEstimate};
  assert.match(render(account),/预计 9\/28 已到期 · 旧读数/);
  assert.equal(estimatedExpiryLabel(teamEstimate,now,true),'预计 2026/09/28 已到期 · 旧读数');
  assert.equal(creditExpiryDueSoon(account,now),false);
});

test('seven-day filtering includes estimates but keeps their source separate from official dates',()=>{
  const now=Date.parse('2026-09-24T00:00:00+08:00');
  const account={scope:'team_total',creditExpiryEstimate:teamEstimate,creditBatches:[],expiresAt:null};
  assert.equal(creditExpiryDueSoon(account,now),true);assert.equal(creditExpiryDueSoon(account,now,{officialOnly:true}),false);
  assert.deepEqual(creditExpiryDates(account),[{expiresAt:teamEstimate.expiresAt,estimated:true}]);
  assert.equal(account.expiresAt,null);assert.deepEqual(account.creditBatches,[]);
  assert.equal(creditExpiryDueSoon({...account,expiresAt:'2026-09-27T00:00:00+08:00'},now,{officialOnly:true}),true);
  assert.equal(teamCreditExpiryEstimate({...account,scope:'personal'}),null);
  assert.equal(teamCreditExpiryEstimate({...account,creditExpiryEstimate:{...teamEstimate,expiresAt:'invalid'}}),null);
});
