import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installOperationWatcher } from '../extension/operation-watcher.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function event() {
  const listeners = new Set();
  return { subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    fire(value) { for (const fn of listeners) fn(value); }, get size() { return listeners.size; } };
}
function taskService() {
  const created = event(), submitted = event();
  return { created, submitted, service: {
    onAigcDataTaskCreated: created.subscribe, onAigcDataTaskSubmitSuccess: submitted.subscribe,
    get taskStore() { throw new Error('must not scan old tasks'); },
    get onAigcDataTaskRestored() { throw new Error('must not claim restored tasks'); },
    get onAigcDataTaskGenerated() { throw new Error('completion does not prove local submission'); },
  } };
}
function harness() {
  const native = taskService(), accountChanges = event(), signals = [], timers = new Map(), events = new Map();
  let at = Date.parse('2026-09-15T05:00:00Z'), serial = 0;
  const user = { hasLogin: true, userId: 'user-1' };
  const snapshot = { account: { accountType: 'personal', accountKey: 'personal' }, version: 1 };
  const credit = { isLocalCreditReady: true, getCurrentAccountSnapshot: () => snapshot };
  const feature = { commercialCreditService: credit, _commerceAccountPort: { getSnapshot: () => user, subscribe: accountChanges.subscribe } };
  const page = { location: { origin: 'https://jimeng.jianying.com' },
    __debugger: { DreaminaCommercialFeatureService: feature, ContentGeneratorTaskFeatureService: native.service },
    postMessage(value, target) { assert.equal(target, page.location.origin); signals.push(plain(value)); },
    setInterval(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); },
    addEventListener(type, fn) { events.set(type, fn); } };
  const context = vm.createContext({ window: page, Date: class extends Date { static now() { return at; } } });
  // This matches MAIN-world function serialization: no module-scope helper is available.
  const install = () => plain(vm.runInContext(`(${installOperationWatcher.toString()})()`, context));
  const model = submitId => ({ idModel: { submitId, workspaceId: 'canvas-is-not-team-id' }, prompt: 'never-collected' });
  return { native, signals, user, snapshot, credit, feature, page, events, timers, model, install,
    tick() { for (const fn of timers.values()) fn(); }, advance(ms) { at += ms; }, accountChanges };
}

test('only a created and accepted local submission yields minimal personal or team evidence', () => {
  const h = harness();
  assert.equal(h.install().installed, true);
  h.native.submitted.fire(h.model('old-history-task'));
  h.native.created.fire(h.model('failed-submit')); // No success event means no evidence.
  assert.equal(h.signals.length, 0);
  h.native.created.fire(h.model('personal-task'));
  h.native.submitted.fire(h.model('personal-task'));
  h.native.submitted.fire(h.model('personal-task'));
  h.native.created.fire(h.model('personal-task'));
  h.native.submitted.fire(h.model('personal-task'));
  assert.deepEqual(h.signals, [{ source: 'jimeng-credit-manager', type: 'operation-evidence', operationEvidence: {
    submitId: 'personal-task', userId: 'user-1', spaceType: 'personal', spaceId: 'personal', occurredAt: '2026-09-15T05:00:00.000Z',
  } }]);
  h.snapshot.account = { accountType: 'team', accountKey: 'team:team-3', teamId: 'team-3' }; h.snapshot.version++;
  h.native.created.fire(h.model('team-task')); h.native.submitted.fire(h.model('team-task'));
  assert.equal(h.signals.length, 2);
  assert.deepEqual(h.signals[1].operationEvidence, { submitId: 'team-task', userId: 'user-1', spaceType: 'team',
    spaceId: 'team-3', occurredAt: '2026-09-15T05:00:00.000Z' });
});

test('login, space, version, readiness and server-returned submit IDs must remain consistent', () => {
  const changes = [h => { h.user.userId = 'other-user'; },
    h => { h.snapshot.account = { accountType: 'team', accountKey: 'team:other', teamId: 'other' }; },
    h => { h.snapshot.version += 2; }, h => { h.user.hasLogin = false; }, h => { h.credit.isLocalCreditReady = false; }];
  for (const change of changes) {
    const h = harness(); h.install(); h.native.created.fire(h.model('pending-task'));
    change(h); h.native.submitted.fire(h.model('pending-task'));
    assert.equal(h.signals.length, 0);
  }
  const h = harness(); h.install(); h.native.created.fire(h.model('before'));
  h.native.submitted.fire(h.model('different-after-response'));
  h.user.hasLogin = false; h.accountChanges.fire(); h.user.hasLogin = true; h.accountChanges.fire();
  h.native.submitted.fire(h.model('before'));
  assert.equal(h.signals.length, 0);
});

test('late services attach once, replacements discard pending work, and pagehide disposes subscriptions', () => {
  const h = harness(); delete h.page.__debugger.ContentGeneratorTaskFeatureService;
  h.install(); assert.equal(h.native.created.size, 0);
  h.page.__debugger.ContentGeneratorTaskFeatureService = h.native.service; h.tick(); h.install(); h.tick();
  assert.equal(h.native.created.size, 1); assert.equal(h.native.submitted.size, 1);
  h.native.created.fire(h.model('old-service-task'));
  const next = taskService(); h.page.__debugger.ContentGeneratorTaskFeatureService = next.service;
  h.native.submitted.fire(h.model('old-service-task')); // Before the polling callback, cached services are already invalid.
  h.tick(); next.submitted.fire(h.model('old-service-task'));
  assert.equal(h.signals.length, 0); assert.equal(h.native.created.size, 0);
  next.created.fire(h.model('new-service-task')); next.submitted.fire(h.model('new-service-task'));
  assert.equal(h.signals.length, 1);
  h.events.get('pagehide')({ persisted: false });
  assert.equal(next.created.size, 0); assert.equal(next.submitted.size, 0); assert.equal(h.timers.size, 0);
});

test('pending submissions are bounded and expire without claiming a later restored completion', () => {
  const h = harness(); h.install();
  for (let n = 0; n < 101; n++) h.native.created.fire(h.model(`task-${n}`));
  h.native.submitted.fire(h.model('task-0')); assert.equal(h.signals.length, 0);
  h.native.submitted.fire(h.model('task-100')); assert.equal(h.signals.length, 1);
  h.advance(30 * 60 * 1000 + 1); h.native.submitted.fire(h.model('task-99'));
  assert.equal(h.signals.length, 1);
  h.native.created.fire(h.model('fresh-after-expiry')); h.native.submitted.fire(h.model('fresh-after-expiry'));
  assert.equal(h.signals.length, 2);
});

test('missing or imprecise identity never supplies operation evidence', () => {
  for (const alter of [h => { h.user.userId = Number.MAX_SAFE_INTEGER + 1; },
    h => { h.snapshot.account = { accountType: 'team', accountKey: 'team:missing-id' }; },
    h => { h.snapshot.account.accountType = 'unknown'; }]) {
    const h = harness(); alter(h); h.install(); h.native.created.fire(h.model('task')); h.native.submitted.fire(h.model('task'));
    assert.equal(h.signals.length, 0);
  }
});

test('isolated bridge checks the sender and forwards only validated evidence fields', () => {
  const source = readFileSync(new URL('../extension/content-bridge.js', import.meta.url), 'utf8');
  const sent = [], listeners = new Map(), location = { origin: 'https://jimeng.jianying.com' };
  const page = { addEventListener(type, fn) { listeners.set(type, fn); } };
  vm.runInNewContext(source, { window: page, location, chrome: { runtime: { sendMessage(value) { sent.push(plain(value)); return Promise.resolve(); } } },
    setInterval() { return 1; }, clearInterval() {} });
  assert.deepEqual(sent, [{ type: 'watch-ready' }]);
  const operationEvidence = { submitId: 'submit-1', userId: 'user-1', spaceType: 'personal', spaceId: 'personal',
    occurredAt: '2026-09-15T05:00:00.000Z', prompt: 'must-not-cross-bridge', employeeName: 'must-not-override' };
  const event = { source: page, origin: location.origin, data: { source: 'jimeng-credit-manager', type: 'operation-evidence', operationEvidence } };
  const message = listeners.get('message');
  message({ ...event, source: {} }); message({ ...event, origin: 'https://other.example' });
  message({ ...event, data: { ...event.data, operationEvidence: { ...operationEvidence, submitId: null } } });
  message({ ...event, data: { ...event.data, operationEvidence: { ...operationEvidence, spaceId: 'wrong-personal-space' } } });
  message({ ...event, data: { ...event.data, operationEvidence: { ...operationEvidence, occurredAt: 'invalid' } } });
  assert.equal(sent.length, 1);
  message(event);
  assert.deepEqual(sent[1], { type: 'operation-evidence', operationEvidence: {
    submitId: 'submit-1', userId: 'user-1', spaceType: 'personal', spaceId: 'personal', occurredAt: '2026-09-15T05:00:00.000Z',
  } });
});

test('bridge retries refused and failed worker receipts and continues heartbeats', async () => {
  const source = readFileSync(new URL('../extension/content-bridge.js', import.meta.url), 'utf8');
  const listeners = new Map(), sent = [], location = { origin: 'https://jimeng.jianying.com' };
  const page = { addEventListener(type, fn) { listeners.set(type, fn); } };
  let heartbeat, fail = 'reject';
  vm.runInNewContext(source, { window: page, location, chrome: { runtime: { sendMessage(value) {
    sent.push(plain(value));
    if (fail === 'reject') return Promise.reject(new Error('worker starting'));
    return Promise.resolve({ok: fail !== 'refuse'});
  } } }, setInterval(fn) { heartbeat = fn; return 1; } });
  const operationEvidence = { submitId: 'task.1@local', userId: 'user-1', spaceType: 'personal', spaceId: 'personal', occurredAt: '2026-09-15T05:00:00.000Z' };
  const message = () => listeners.get('message')({ source: page, origin: location.origin, data: {source:'jimeng-credit-manager', type:'operation-evidence', operationEvidence} });
  message(); message(); // One in-flight record, even with duplicate page signals.
  await new Promise(setImmediate);
  fail = 'refuse'; heartbeat(); await new Promise(setImmediate);
  fail = null; heartbeat(); await new Promise(setImmediate);
  heartbeat(); await new Promise(setImmediate);
  assert.equal(sent.filter(item => item.type === 'operation-evidence').length, 3);
  assert.equal(sent.filter(item => item.type === 'collector-heartbeat').length, 3);
  assert.ok(sent.filter(item => item.type === 'operation-evidence').every(item => JSON.stringify(item.operationEvidence) === JSON.stringify(operationEvidence)));
});

test('bridge retries a synchronous runtime error without dropping other pending operations', async () => {
  const source = readFileSync(new URL('../extension/content-bridge.js', import.meta.url), 'utf8');
  const listeners = new Map(), received = [], location = { origin: 'https://jimeng.jianying.com' };
  const page = { addEventListener(type, fn) { listeners.set(type, fn); } };
  let heartbeat, offline = true;
  vm.runInNewContext(source, { window: page, location, chrome: { runtime: { sendMessage(value) {
    if (offline) throw new Error('runtime unavailable');
    if (value.operationEvidence) received.push(plain(value.operationEvidence));
    return Promise.resolve({ok:true});
  } } }, setInterval(fn) { heartbeat = fn; return 1; } });
  for (const submitId of ['task-1', 'task-2']) listeners.get('message')({ source:page, origin:location.origin,
    data:{source:'jimeng-credit-manager',type:'operation-evidence',operationEvidence:{submitId,userId:'u1',spaceType:'team',spaceId:'team-1',occurredAt:'2026-09-15T05:00:00.000Z'}} });
  offline = false; heartbeat(); await new Promise(setImmediate);
  heartbeat(); await new Promise(setImmediate);
  assert.deepEqual(received.map(item => item.submitId), ['task-1','task-2']);
});
