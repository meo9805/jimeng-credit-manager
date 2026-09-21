import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../server/index.mjs';

const EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jmc-ingest-limit-'));
  let time = Date.parse('2026-09-15T03:00:00Z'), cookie = '';
  const app = createApp({ dataDir, clock:() => time }), origin = await app.start(0);
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive:true, force:true }); });
  const request = (route, { method='GET', body, token, admin=false, headers={} } = {}) => fetch(origin + route, {
    method,
    headers:{ ...(body === undefined ? {} : { 'Content-Type':'application/json' }),
      ...(token ? { Authorization:`Bearer ${token}`, Origin:EXTENSION_ORIGIN } : {}),
      ...(admin ? { Cookie:cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body:typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const login = await request('/api/admin/login', { method:'POST', body:{ secret:readFileSync(path.join(dataDir, 'admin-secret'), 'utf8').trim() }, headers:{ Origin:origin } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const makeDevice = async name => {
    const employeeResponse = await request('/api/employees', { method:'POST', admin:true, body:{ name, departmentId:null } });
    assert.equal(employeeResponse.status, 201);
    const employee = await employeeResponse.json();
    const installationResponse = await request('/api/installations', { method:'POST', admin:true, body:{ employeeId:employee.id, role:'collector' } });
    assert.equal(installationResponse.status, 201);
    const installation = await installationResponse.json();
    const provisionResponse = await request(`/api/installations/${installation.id}/extension.zip`, { admin:true });
    assert.equal(provisionResponse.status, 200);
    const provision = JSON.parse(strFromU8(unzipSync(new Uint8Array(await provisionResponse.arrayBuffer()))['provision.json']));
    return { ...installation, token:provision.token };
  };
  const ingest = (device, userId='login-a', options={}) => request('/api/ingest', {
    method:'POST', token:device.token,
    body:{ observedAt:new Date(time).toISOString(), status:'ok', accounts:[{ platformUserId:userId, scope:'personal', spaceId:'personal', displayName:'测试账号', balance:100 }], transactions:[] },
    ...options,
  });
  const stored = () => {
    const db = new DatabaseSync(path.join(dataDir, 'credits.sqlite'), { readOnly:true });
    try {
      return Object.fromEntries(['installations', 'accounts', 'transactions', 'identity_mappings', 'installation_accounts', 'teams', 'collector_diagnostics']
        .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    } finally { db.close(); }
  };
  return { request, makeDevice, ingest, stored, advance(ms) { time += ms; } };
}

test('authenticated collectors can drain the offline queue plus current pages, then receive a bounded retry without database writes', async t => {
  const f = await fixture(t), device = await f.makeDevice('员工甲');
  for (let i = 0; i < 40; i++) assert.equal((await f.ingest(device, `login-${i}`)).status, 200);
  const before = f.stored();
  const limited = await f.ingest(device, 'must-not-be-stored');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.deepEqual(f.stored(), before);
  f.advance(500);
  assert.equal((await f.ingest(device)).status, 429);
  f.advance(500);
  assert.equal((await f.ingest(device)).status, 200);
  assert.equal((await f.ingest(device)).status, 429);
  f.advance(60_000);
  assert.equal((await f.ingest(device)).status, 200, 'the ordinary next-minute collection recovers without reinstalling');
});

test('budgets are per authenticated installation, cannot be bypassed by client IP headers, and do not throttle status or commands', async t => {
  const f = await fixture(t), one = await f.makeDevice('员工甲'), two = await f.makeDevice('员工乙');
  for (let i = 0; i < 40; i++) assert.equal((await f.ingest(one)).status, 200);
  assert.equal((await f.ingest(one, 'login-a', { headers:{ 'X-Forwarded-For':'203.0.113.3' } })).status, 429);
  assert.equal((await f.ingest(two, 'login-b')).status, 200, 'another employee behind the same IP retains their own budget');
  for (const route of ['/api/collector/status', '/api/collector/commands']) assert.equal((await f.request(route, { token:one.token })).status, 200);
  assert.equal((await f.request('/api/dashboard', { admin:true })).status, 200);
  assert.equal((await f.request(`/api/installations/${one.id}`, { method:'PATCH', admin:true, body:{ enabled:false } })).status, 200);
  assert.equal((await f.ingest(one)).status, 401, 'authentication still runs before the rate limit');
});

test('parallel ingest requests reserve their budget before parsing or writing and unauthenticated traffic consumes none', async t => {
  const f = await fixture(t), device = await f.makeDevice('员工甲');
  for (let i = 0; i < 45; i++) assert.equal((await f.request('/api/ingest', { method:'POST', body:{} })).status, 401);
  const responses = await Promise.all(Array.from({ length:50 }, (_, i) => f.ingest(device, `parallel-${i}`)));
  assert.equal(responses.filter(response => response.status === 200).length, 40);
  assert.equal(responses.filter(response => response.status === 429).length, 10);
  assert.equal(f.stored().accounts.length, 40);
  assert.equal(f.stored().installation_accounts.length, 40);
});
