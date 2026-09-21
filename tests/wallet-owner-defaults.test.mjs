import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';
import { validateIngest } from '../server/domain.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'jmc-wallet-owner-'));
  let time = Date.parse('2026-09-15T03:00:00Z');
  const store = createStore({ dataDir, secret:'test-only', clock:() => time });
  t.after(() => { store.close(); rmSync(dataDir, { recursive:true, force:true }); });
  const drama = store.createDepartment({ name:'短剧' }), teaching = store.createDepartment({ name:'教研' });
  const owner = store.createEmployee({ name:'账号员工', departmentId:drama.id });
  const borrower = store.createEmployee({ name:'借用员工', departmentId:teaching.id });
  const installation = store.createInstallation({ employeeId:owner.id, role:'collector' });
  const collect = (accounts, extra = {}, device = installation) => {
    const observedAt = new Date(++time).toISOString();
    store.ingest(device, validateIngest({ observedAt, status:'ok', accounts, transactions:[], ...extra }, time));
  };
  const personal = (platformUserId = 'own-login') => ({ platformUserId, scope:'personal', spaceId:'personal', displayName:'平台昵称', balance:100 });
  const team = scope => ({ platformUserId:'own-login', scope, spaceId:'team-a', displayName:'团队昵称', balance:500 });
  const account = (scope = 'personal', platformUserId) => store.dashboard().accounts.find(item => item.scope === scope && (!platformUserId || item.platformUserId === platformUserId));
  const storedOwner = id => {
    const db = new DatabaseSync(path.join(dataDir, 'credits.sqlite'), { readOnly:true });
    try { return { ...db.prepare('SELECT owner_employee_id,owner_department_id FROM accounts WHERE id=?').get(id) }; }
    finally { db.close(); }
  };
  return { store, owner, borrower, drama, teaching, installation, collect, personal, team, account, storedOwner };
}

test('first bound personal login supplies wallet owner and department without rewriting wallet or historical operator data', t => {
  const f = fixture(t);
  f.collect([f.personal()], { transactions:[{ platformUserId:'own-login', scope:'personal', spaceId:'personal', eventId:'historical', occurredAt:'2026-09-14T03:00:00Z', kind:'consume', amount:-5 }] });
  const account = f.account(), history = f.store.dashboard().transactions;
  assert.equal(account.ownerEmployeeId, f.owner.id);
  assert.equal(account.ownerName, f.owner.name);
  assert.equal(account.ownerDepartmentId, f.drama.id);
  assert.equal(account.ownerDepartment, f.drama.name);
  assert.equal(account.ownerEmployeeOverrideId, null);
  assert.equal(account.ownerDepartmentOverrideId, null);
  assert.deepEqual(f.storedOwner(account.id), { owner_employee_id:null, owner_department_id:null });
  assert.equal(history[0].operatorName, null);
  f.store.patchEmployee(f.owner.id, { departmentId:f.teaching.id });
  assert.equal(f.store.getAccount(account.id).ownerDepartmentId, f.teaching.id);
  assert.deepEqual(f.store.dashboard().transactions, history);
});

test('borrowing an account cannot replace wallet ownership or create ownership for an unbound login', t => {
  const f = fixture(t);
  f.collect([f.personal()]);
  const otherDevice = f.store.createInstallation({ employeeId:f.borrower.id, role:'collector' });
  f.collect([f.personal()], {}, otherDevice);
  assert.equal(f.account().ownerEmployeeId, f.owner.id);
  f.collect([f.personal('borrowed-login')]);
  assert.equal(f.account('personal', 'borrowed-login').ownerEmployeeId, null);
  assert.equal(f.account('personal', 'borrowed-login').ownerDepartmentId, null);
});

test('both team wallet views default to the confirmed creator rather than a member or collecting employee', t => {
  const f = fixture(t);
  f.collect([f.team('team_member'), f.team('team_total')], { teams:[{ spaceId:'team-a', creatorPlatformUserId:'creator-login', members:[{ platformUserId:'creator-login', role:'creator' }, { platformUserId:'own-login', role:'member' }] }] });
  assert.equal(f.account('team_member').ownerEmployeeId, null, 'a mapped member does not own the team');
  f.store.patchIdentity('creator-login', { employeeId:f.borrower.id });
  for (const scope of ['team_total', 'team_member']) {
    const account = f.account(scope);
    assert.equal(account.ownerEmployeeId, f.borrower.id, scope);
    assert.equal(account.ownerDepartmentId, f.teaching.id, scope);
    assert.deepEqual(f.storedOwner(account.id), { owner_employee_id:null, owner_department_id:null });
  }
});

test('a unique creator role provides a default; absent or contradictory creator evidence stays unassigned', t => {
  const f = fixture(t);
  f.collect([f.personal(), f.team('team_member'), f.team('team_total')], { teams:[{ spaceId:'team-a', members:[{ platformUserId:'own-login', role:'member' }] }] });
  assert.equal(f.account('team_total').ownerName, null);
  f.collect([], { teams:[{ spaceId:'team-a', members:[{ platformUserId:'own-login', role:'creator' }] }] });
  assert.equal(f.account('team_total').ownerEmployeeId, f.owner.id);
  f.collect([], { teams:[{ spaceId:'team-a', creatorPlatformUserId:'different-creator', members:[{ platformUserId:'different-creator', role:'member' }] }] });
  f.store.patchIdentity('different-creator', { employeeId:f.borrower.id });
  assert.equal(f.account('team_total').ownerEmployeeId, null, 'conflicting creator facts must not guess an owner');
});

test('manual overrides win and omitted fields stay automatic; null restores the current default', t => {
  const f = fixture(t);
  f.collect([f.personal()]);
  const id = f.account().id;
  f.store.patchAccount(id, { ownerDepartmentId:f.teaching.id });
  assert.deepEqual(f.storedOwner(id), { owner_employee_id:null, owner_department_id:f.teaching.id });
  f.store.patchIdentity('own-login', { employeeId:f.borrower.id });
  assert.equal(f.store.getAccount(id).ownerEmployeeId, f.borrower.id);
  f.store.patchAccount(id, { ownerEmployeeId:f.owner.id });
  f.collect([f.personal()]);
  assert.equal(f.store.getAccount(id).ownerEmployeeId, f.owner.id);
  assert.equal(f.store.getAccount(id).ownerDepartmentId, f.teaching.id);
  f.store.patchAccount(id, { ownerDepartmentId:null });
  assert.equal(f.store.getAccount(id).ownerDepartmentId, f.drama.id, 'unset cost department follows the effective owner');
  f.store.patchAccount(id, { ownerEmployeeId:null });
  assert.equal(f.store.getAccount(id).ownerEmployeeId, f.borrower.id);
  assert.equal(f.store.getAccount(id).ownerDepartmentId, f.teaching.id);
  assert.deepEqual(f.storedOwner(id), { owner_employee_id:null, owner_department_id:null });
  f.store.patchIdentity('own-login', { employeeId:null });
  assert.equal(f.store.getAccount(id).ownerEmployeeId, null);
  assert.equal(f.store.getAccount(id).ownerDepartmentId, null);
});

test('explicit team wallet cost ownership survives creator corrections, new snapshots and renamed departments', t => {
  const f = fixture(t);
  f.collect([f.personal(), f.team('team_total'), f.team('team_member')], { teams:[{ spaceId:'team-a', creatorPlatformUserId:'own-login', members:[] }] });
  for (const scope of ['team_total', 'team_member']) {
    assert.equal(f.account(scope).ownerEmployeeId, f.owner.id, 'explicit creator metadata is sufficient without a roster');
    f.store.patchAccount(f.account(scope).id, { ownerEmployeeId:f.owner.id, ownerDepartmentId:f.drama.id });
  }
  f.store.patchIdentity('own-login', { employeeId:f.borrower.id });
  f.collect([f.team('team_total'), f.team('team_member')]);
  f.store.patchDepartment(f.drama.id, { name:'短剧成本中心' });
  for (const scope of ['team_total', 'team_member']) {
    assert.equal(f.account(scope).ownerEmployeeId, f.owner.id);
    assert.equal(f.account(scope).ownerDepartment, '短剧成本中心');
    assert.equal(f.account(scope).ownerEmployeeOverrideId, f.owner.id);
  }
});
