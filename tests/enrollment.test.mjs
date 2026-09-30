import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../server/index.mjs';
import { createStore } from '../server/store.mjs';
import { normalizeObservation } from '../extension/normalize.mjs';

const MANAGER = 'http://manager.example';
const COLLECTOR = 'http://collector.example';
const INTERNAL = 'http://internal.example';
const JOIN = COLLECTOR;
const NOW = Date.parse('2026-09-24T02:00:00.000Z');

async function fixture(t) {
  let time = NOW;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'jmc-enrollment-'));
  const dataDir = path.join(directory, 'private');
  const extensionDir = path.join(directory, 'extension');
  const distDir = path.join(directory, 'dist');
  mkdirSync(extensionDir); mkdirSync(distDir);
  writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'test collector', version: '0.2.11' }));
  writeFileSync(path.join(extensionDir, 'worker.js'), '// test collector');
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>manager</title>');
  const app = createApp({ dataDir, extensionDir, distDir, clock: () => time, managementOrigin: MANAGER, publicOrigin: COLLECTOR, collectorInternalOrigin: INTERNAL });
  await app.start(0);
  const port = app.server.address().port;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });

  async function request(origin, route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const target = new URL(origin);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
        Host: target.host,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    return { ...response, json: () => JSON.parse(response.body.toString('utf8')) };
  }
  async function login() {
    const secret = readFileSync(path.join(dataDir, 'admin-secret'), 'utf8').trim();
    const result = await request(MANAGER, '/api/admin/login', { method: 'POST', body: { secret }, headers: { Origin: MANAGER } });
    assert.equal(result.status, 200);
    return result.headers['set-cookie'][0].split(';')[0];
  }
  async function employee(name, cookie, departmentName = '教研部') {
    const d = await request(MANAGER, '/api/departments', { method: 'POST', body: { name: departmentName }, cookie });
    assert.equal(d.status, 201);
    const e = await request(MANAGER, '/api/employees', { method: 'POST', body: { name, departmentId: d.json().id }, cookie });
    assert.equal(e.status, 201);
    return e.json();
  }
  async function apply(name = '新员工', department = '教研部', origin = JOIN, headers = {}) {
    const response = await request(origin, '/api/enrollment/requests', { method: 'POST', body: { name, department }, headers: { Origin: origin, ...headers } });
    assert.equal(response.status, 201);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/api\/enrollment; Max-Age=259200/);
    assert.doesNotMatch(response.headers['set-cookie'][0], /(?:Domain=|Secure)/);
    return { request: response.json(), cookie };
  }
  return { request, login, employee, apply, setTime: value => { time = value; } };
}

test('employee portals share existing public and internal collector origins without exposing administrator routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(COLLECTOR, '/api/health')).status, 200);
  assert.equal((await f.request(INTERNAL, '/api/health')).status, 200);
  for (const origin of [COLLECTOR, INTERNAL]) {
    assert.equal((await f.request(origin, '/api/dashboard')).status, 404);
    assert.equal((await f.request(origin, '/api/admin/enrollment-requests')).status, 404);
    assert.equal((await f.request(origin, '/api/admin/login', { method: 'POST', body: {} })).status, 404);
    assert.equal((await f.request(origin, '/api/session')).status, 404);
    assert.equal((await f.request(origin, '/api/collector/status')).status, 401);
  }
  assert.equal((await f.request(MANAGER, '/api/enrollment/request')).status, 404);
  assert.equal((await f.request(JOIN, '/api/enrollment/requests', { method: 'POST', body: { name: '甲', department: '教研部' } })).status, 403);
  assert.equal((await f.request(JOIN, '/api/enrollment/requests', { method: 'POST', body: { name: '甲', department: '教研部', employeeId: 'fake' }, headers: { Origin: JOIN } })).status, 400);
  const applicant = await f.apply('  陈  东辉 ', ' 教研部 ');
  assert.equal(applicant.request.name, '陈 东辉');
  assert.equal(applicant.request.status, 'pending');
  assert.equal((await f.request(JOIN, '/api/enrollment/request')).status, 401);
  assert.equal((await f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: JOIN } })).status, 409);
  const own = await f.request(JOIN, '/api/enrollment/request', { cookie: applicant.cookie });
  assert.equal(own.json().name, '陈 东辉');
  assert.equal(own.json().installationId, undefined);
  assert.equal(own.json().collector, undefined);
  assert.equal((await f.request(JOIN, '/api/admin/enrollment-requests', { cookie: applicant.cookie })).status, 404);
});

test('new applications appear in the manager sidebar count and expire without a database write', async t => {
  const f = await fixture(t);
  const cookie = await f.login();
  const initial = await f.request(MANAGER, '/api/dashboard', { cookie });
  assert.equal(initial.json().pendingEnrollmentCount, 0);
  await f.apply('新人');
  const pending = await f.request(MANAGER, '/api/dashboard', { cookie, headers: { 'If-None-Match': initial.headers.etag } });
  assert.equal(pending.status, 200);
  assert.equal(pending.json().pendingEnrollmentCount, 1);
  f.setTime(NOW + 48 * 3600_000);
  const renewedCookie = await f.login();
  const expired = await f.request(MANAGER, '/api/dashboard', { cookie: renewedCookie, headers: { 'If-None-Match': pending.headers.etag } });
  assert.equal(expired.status, 200);
  assert.equal(expired.json().pendingEnrollmentCount, 0);
});

test('administrator maps applicant to employee and a short-lived claim downloads only that employee package', async t => {
  const f = await fixture(t);
  const adminCookie = await f.login();
  const employee = await f.employee('陈东辉', adminCookie);
  const applicant = await f.apply('陈东辉');
  assert.equal((await f.request(MANAGER, '/api/admin/enrollment-requests')).status, 401);
  const listed = await f.request(MANAGER, '/api/admin/enrollment-requests', { cookie: adminCookie });
  assert.equal(listed.json().requests[0].id, applicant.request.id);
  assert.equal(listed.json().requests[0].status, 'pending');
  const approveRoute = `/api/admin/enrollment-requests/${applicant.request.id}/approve`;
  assert.equal((await f.request(MANAGER, approveRoute, { method: 'POST', body: { employeeId: employee.id }, cookie: adminCookie })).status, 403);
  const approved = await f.request(MANAGER, approveRoute, { method: 'POST', body: { employeeId: employee.id }, cookie: adminCookie, headers: { Origin: MANAGER } });
  assert.equal(approved.status, 200);
  assert.equal(approved.json().status, 'approved');
  assert.equal(approved.json().employeeId, employee.id);
  assert.ok(approved.json().installationId);
  const installation = (await f.request(MANAGER, '/api/dashboard', { cookie: adminCookie })).json().installations.find(item => item.id === approved.json().installationId);
  assert.equal(installation.initialIdentityBinding.status, 'skipped');
  assert.equal(installation.initialIdentityBinding.resolution, 'collection_only');
  assert.equal((await f.request(MANAGER, approveRoute, { method: 'POST', body: { employeeId: employee.id }, cookie: adminCookie, headers: { Origin: MANAGER } })).status, 409);
  const own = await f.request(JOIN, '/api/enrollment/request', { cookie: applicant.cookie });
  assert.equal(own.json().employeeName, '陈东辉');
  assert.equal(own.json().installationId, undefined);
  assert.deepEqual(own.json().collector, { lastSeenAt: null, online: false, extensionVersion: null });
  assert.equal((await f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
  const claim = () => f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: JOIN } });
  const download = await claim();
  assert.equal(download.status, 200);
  assert.match(download.headers['cache-control'], /no-store/);
  const zip = unzipSync(new Uint8Array(download.body));
  const provision = JSON.parse(strFromU8(zip['provision.json']));
  assert.equal(provision.employeeName, '陈东辉');
  assert.equal(provision.installationId, approved.json().installationId);
  assert.equal(provision.endpoint, COLLECTOR);
  assert.ok(zip['安装说明.txt']);
  assert.equal((await claim()).status, 200);
  assert.equal((await claim()).status, 200);
  assert.equal((await claim()).status, 410);
  const dashboard = await f.request(MANAGER, '/api/dashboard', { cookie: adminCookie });
  assert.equal(dashboard.json().enrollmentUrl, `${COLLECTOR}/join/`);
  assert.deepEqual(dashboard.json().enrollmentUrls, { external: `${COLLECTOR}/join/`, internal: `${INTERNAL}/join/` });
});

test('administrator can reject or reuse only an active collector belonging to the chosen employee', async t => {
  const f = await fixture(t);
  const cookie = await f.login();
  const first = await f.employee('甲', cookie, '甲部门');
  const second = await f.employee('乙', cookie, '乙部门');
  const deviceResponse = await f.request(MANAGER, '/api/installations', { method: 'POST', body: { employeeId: first.id }, cookie });
  assert.equal(deviceResponse.status, 201);
  const device = deviceResponse.json();
  const applicant = await f.apply('甲', '甲部门');
  const approve = `/api/admin/enrollment-requests/${applicant.request.id}/approve`;
  const post = body => f.request(MANAGER, approve, { method: 'POST', body, cookie, headers: { Origin: MANAGER } });
  assert.equal((await post({ employeeId: second.id, installationId: device.id })).status, 409);
  const approved = await post({ employeeId: first.id, installationId: device.id });
  assert.equal(approved.status, 200);
  assert.equal(approved.json().installationId, device.id);
  const dashboard = (await f.request(MANAGER, '/api/dashboard', { cookie })).json();
  assert.equal(dashboard.installations.find(item => item.id === device.id).initialIdentityBinding.status, 'skipped');
  assert.equal((await f.request(MANAGER, `/api/installations/${device.id}`, { method: 'PATCH', body: { enabled: false }, cookie })).status, 200);
  assert.equal((await f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: JOIN } })).status, 403);

  const rejected = await f.apply('乙', '乙部门');
  const route = `/api/admin/enrollment-requests/${rejected.request.id}/reject`;
  const result = await f.request(MANAGER, route, { method: 'POST', body: {}, cookie, headers: { Origin: MANAGER } });
  assert.equal(result.status, 200);
  assert.equal(result.json().status, 'rejected');
  assert.equal((await f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: rejected.cookie, headers: { Origin: JOIN } })).status, 403);
});

test('pending and approved requests expire without issuing packages', async t => {
  const f = await fixture(t);
  let cookie = await f.login();
  const employee = await f.employee('甲', cookie);
  const pending = await f.apply('甲');
  f.setTime(NOW + 48 * 3600_000);
  cookie = await f.login();
  const expired = await f.request(JOIN, '/api/enrollment/request', { cookie: pending.cookie });
  assert.equal(expired.json().status, 'expired');
  const approve = id => f.request(MANAGER, `/api/admin/enrollment-requests/${id}/approve`, { method: 'POST', body: { employeeId: employee.id }, cookie, headers: { Origin: MANAGER } });
  assert.equal((await approve(pending.request.id)).status, 409);
  const replacement = await f.apply('甲');
  assert.equal((await approve(replacement.request.id)).status, 200);
  f.setTime(NOW + 72 * 3600_000);
  assert.equal((await f.request(JOIN, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: replacement.cookie, headers: { Origin: JOIN } })).status, 410);
});

test('internal applicants can claim there and a borrowed first login does not assign the Jimeng account to the collector employee', async t => {
  const f = await fixture(t);
  const adminCookie = await f.login();
  const operator = await f.employee('马亚波', adminCookie);
  const owner = await f.employee('夏意然', adminCookie, '短剧部');
  const applicant = await f.apply('马亚波', '教研部', INTERNAL);
  const route = `/api/admin/enrollment-requests/${applicant.request.id}/approve`;
  const approved = await f.request(MANAGER, route, { method: 'POST', body: { employeeId: operator.id }, cookie: adminCookie, headers: { Origin: MANAGER } });
  assert.equal(approved.status, 200);
  assert.equal((await f.request(INTERNAL, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: COLLECTOR } })).status, 403);
  const download = await f.request(INTERNAL, '/api/enrollment/claim', { method: 'POST', body: {}, cookie: applicant.cookie, headers: { Origin: INTERNAL } });
  assert.equal(download.status, 200);
  const packageFiles = unzipSync(new Uint8Array(download.body));
  const provision = JSON.parse(strFromU8(packageFiles['provision.json']));
  assert.equal(JSON.parse(strFromU8(packageFiles['manifest.json'])).version, '0.2.11');
  assert.equal(provision.employeeName, '马亚波');
  assert.equal(provision.endpoint, COLLECTOR);
  assert.equal(provision.internalEndpoint, INTERNAL);
  const observation = normalizeObservation({
    observedAt: new Date(NOW).toISOString(), status: 'ok', message: null,
    userId: 'borrowed-account', accountType: 'personal', displayName: '夏意然的平台号',
    balance: 100, giftCredit: 0, purchaseCredit: 0, vipCredit: 100, records: [],
  });
  const ingest = () => f.request(INTERNAL, '/api/ingest', { method: 'POST', body: observation, headers: { Authorization: `Bearer ${provision.token}` } });
  assert.equal((await ingest()).status, 200);
  let dashboard = (await f.request(MANAGER, '/api/dashboard', { cookie: adminCookie })).json();
  assert.equal(dashboard.identities.find(item => item.platformUserId === 'borrowed-account').employeeId, null);
  assert.equal(dashboard.installations.find(item => item.id === provision.installationId).initialIdentityBinding.status, 'skipped');
  const mapped = await f.request(MANAGER, '/api/identities/borrowed-account', { method: 'PATCH', body: { employeeId: owner.id }, cookie: adminCookie });
  assert.equal(mapped.status, 200);
  assert.equal((await ingest()).status, 200);
  dashboard = (await f.request(MANAGER, '/api/dashboard', { cookie: adminCookie })).json();
  assert.equal(dashboard.identities.find(item => item.platformUserId === 'borrowed-account').employeeId, owner.id);
});

test('enrollment rate limit is shared across external and internal links per client IP', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 15; index++) {
    const origin = index % 2 ? INTERNAL : COLLECTOR;
    const result = await f.request(origin, '/api/enrollment/requests', {
      method: 'POST', body: { name: `申请人${index}`, department: '教研部' },
      headers: { Origin: origin, 'X-Real-IP': '198.51.100.42' },
    });
    assert.equal(result.status, 201);
  }
  const blocked = await f.request(INTERNAL, '/api/enrollment/requests', {
    method: 'POST', body: { name: '第十六人', department: '教研部' },
    headers: { Origin: INTERNAL, 'X-Real-IP': '198.51.100.42' },
  });
  assert.equal(blocked.status, 429);
  const differentClient = await f.request(COLLECTOR, '/api/enrollment/requests', {
    method: 'POST', body: { name: '其他人', department: '教研部' },
    headers: { Origin: COLLECTOR, 'X-Real-IP': '198.51.100.43' },
  });
  assert.equal(differentClient.status, 201);
});

test('administrators always see active applications ahead of the recent decision history', t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jmc-enrollment-queue-'));
  let time = NOW;
  const store = createStore({ dataDir, secret: 'test-enrollment-key', clock: () => time });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const oldestPending = store.createRequest({ name: '仍待审核', department: '教研部' }, null).request;
  for (let index = 0; index < 205; index++) {
    time += 1000;
    const request = store.createRequest({ name: `已处理${index}`, department: '教研部' }, null).request;
    store.rejectRequest(request.id);
  }
  const requests = store.listRequests();
  assert.equal(requests.length, 201);
  assert.equal(requests[0].id, oldestPending.id);
  assert.equal(requests[0].status, 'pending');
  assert.equal(requests.filter(item => item.status === 'rejected').length, 200);
});
