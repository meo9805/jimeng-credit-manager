import test from 'node:test';
import assert from 'node:assert/strict';
import { captureExtensionLogin, extensionLoginAttempt } from '../web/extension-login.js';

function historyFixture(events = []) {
  return { state: null, replaceState(_state, _title, url) { events.push({ type: 'history', url }); } };
}

test('ticket fragment is cleared before consume and is never put into a redirect URL', async () => {
  const events = [], history = historyFixture(events);
  const entry = captureExtensionLogin({ pathname: '/extension-login', hash: '#ticket=test-once' }, history);
  assert.deepEqual(events, [{ type: 'history', url: '/extension-login' }]);
  const request = async (path, options) => {
    events.push({ type: 'request', path });
    assert.equal(options.credentials, 'include');
    if (path === '/api/admin/consume-ticket') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { ticket: 'test-once' });
      return { authenticated: true };
    }
    assert.equal(path, '/api/session');
    return { authenticated: true, role: 'admin' };
  };
  await extensionLoginAttempt(entry, request, history)();
  assert.equal(entry.ticket, null);
  assert.deepEqual(events, [
    { type: 'history', url: '/extension-login' },
    { type: 'request', path: '/api/admin/consume-ticket' },
    { type: 'request', path: '/api/session' },
    { type: 'history', url: '/' },
  ]);
});

test('repeated startup calls share one consume and one session verification', async () => {
  let consumes = 0, sessions = 0;
  const attempt = extensionLoginAttempt({ ticket: 'test-once' }, async (path) => {
    if (path.endsWith('consume-ticket')) { consumes++; return {}; }
    sessions++; return { authenticated: true, role: 'admin' };
  }, historyFixture());
  const first = attempt(), second = attempt();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await attempt();
  assert.equal(consumes, 1); assert.equal(sessions, 1);
});

test('missing or duplicate tickets are cleared but never submitted', async () => {
  for (const hash of ['', '#ticket=', '#ticket=one&ticket=two']) {
    const events = [], history = historyFixture(events);
    const entry = captureExtensionLogin({ pathname: '/extension-login', hash }, history);
    let calls = 0;
    await assert.rejects(extensionLoginAttempt(entry, async () => { calls++; }, history)(), /缺少有效凭证/);
    assert.equal(calls, 0);
    assert.deepEqual(events, [{ type: 'history', url: '/extension-login' }]);
  }
});

test('a rejected ticket is not replayed and server errors cannot reveal it', async () => {
  let calls = 0;
  const events = [];
  const attempt = extensionLoginAttempt({ ticket: 'test-hidden-value' }, async () => {
    calls++; throw new Error('server echoed test-hidden-value');
  }, historyFixture(events));
  for (let i = 0; i < 2; i++) await assert.rejects(attempt(), (error) => !error.message.includes('test-hidden-value') && error.message.includes('重新从管理员插件打开'));
  assert.equal(calls, 1); assert.deepEqual(events, []);
});

test('cookie/session verification must succeed as admin before entering root', async () => {
  for (const session of [{ authenticated: false, role: null }, { authenticated: true, role: 'collector' }]) {
    const events = [];
    await assert.rejects(extensionLoginAttempt({ ticket: 'test-once' }, async (path) => path.endsWith('consume-ticket') ? {} : session, historyFixture(events))(), /快捷登录未完成/);
    assert.deepEqual(events, []);
  }
});

test('ordinary application routes do not enter ticket login', () => {
  const events = [];
  assert.equal(captureExtensionLogin({ pathname: '/', hash: '' }, historyFixture(events)), null);
  assert.deepEqual(events, []);
});
