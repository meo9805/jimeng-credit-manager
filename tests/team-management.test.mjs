import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTeamManagement } from '../server/team-management.mjs';
import { teamViewModels } from '../web/teams.js';
import { buildLeaderOverview } from '../web/leader-overview.js';

test('team archive is independent of later platform observations and can be restored', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE teams(space_id TEXT PRIMARY KEY, snapshot_at TEXT, data TEXT);
      CREATE TABLE accounts(id TEXT PRIMARY KEY, space_id TEXT, scope TEXT);`);
    db.prepare('INSERT INTO teams VALUES(?,?,?)').run('team-1', '2026-09-23T00:00:00Z', '{}');
    let clock = 0;
    const management = createTeamManagement(db, () => `2026-09-24T00:00:0${++clock}Z`);
    assert.equal(management.get('team-1').archived, false);
    assert.deepEqual(management.setArchived('team-1', true), {
      spaceId: 'team-1', archived: true, archivedAt: '2026-09-24T00:00:01Z', updatedAt: '2026-09-24T00:00:01Z',
    });
    db.prepare('UPDATE teams SET snapshot_at=? WHERE space_id=?').run('2026-09-25T00:00:00Z', 'team-1');
    assert.equal(management.get('team-1').archived, true, 'new collection must not silently reactivate an archived team');
    assert.equal(management.setArchived('team-1', true).updatedAt, '2026-09-24T00:00:01Z', 'repeat requests are idempotent');
    assert.equal(management.setArchived('team-1', false).archived, false);
    assert.equal(management.get('team-1').archivedAt, null);
    assert.equal(db.prepare('SELECT snapshot_at FROM teams WHERE space_id=?').get('team-1').snapshot_at, '2026-09-25T00:00:00Z', 'archive must not delete snapshots');
  } finally { db.close(); }
});

test('a team known only through its wallet can be archived; unknown teams cannot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE teams(space_id TEXT PRIMARY KEY);
      CREATE TABLE accounts(id TEXT PRIMARY KEY, space_id TEXT, scope TEXT);`);
    db.prepare('INSERT INTO accounts VALUES(?,?,?)').run('wallet-1', 'team-2', 'team_member');
    const management = createTeamManagement(db, () => '2026-09-24T00:00:00Z');
    assert.equal(management.setArchived('team-2', true).archived, true);
    assert.throws(() => management.setArchived('missing', true), { status: 404 });
    assert.throws(() => management.setArchived('team-2', 'yes'), { status: 400 });
  } finally { db.close(); }
});

test('archived team leaves current inventory and due-soon totals without erasing historical spending', () => {
  const observedAt = '2026-09-24T00:00:00Z';
  const pool = { id: 'pool', scope: 'team_total', spaceId: 'team-1', platformUserId: 'user-1', balance: 1000,
    lastSyncedAt: observedAt, creditBatches: [{ kind: 'subscription', amount: 1000, expiresAt: '2026-09-26T00:00:00Z' }] };
  const member = { id: 'member', scope: 'team_member', spaceId: 'team-1', platformUserId: 'user-1', balance: 300, lastSyncedAt: observedAt };
  const personal = { id: 'personal', scope: 'personal', spaceId: 'personal', platformUserId: 'user-1', balance: 500, lastSyncedAt: observedAt };
  const team = { spaceId: 'team-1', name: '旧团队', creatorPlatformUserId: 'user-1', totalBalance: 1000,
    balanceObservedAt: observedAt, observedAt, allocatableBalance: 700, membersComplete: true,
    members: [{ platformUserId: 'user-1', balance: 300 }] };
  const input = { now: Date.parse('2026-09-24T06:00:00Z'), employees: [{ id: 'employee-1', name: '甲' }],
    identities: [{ platformUserId: 'user-1', employeeId: 'employee-1', realName: '甲' }],
    accounts: [personal, pool, member], teams: [team], useLastKnownBalances: true,
    transactions: [{ id: 'consume-1', eventId: 'consume-1', accountId: 'pool', chargedPlatformUserId: 'user-1',
      kind: 'consume', amount: -90, occurredAt: '2026-09-23T06:00:00Z', ownershipSnapshot: { employeeId: 'employee-1', name: '甲' } }] };
  const before = buildLeaderOverview(input);
  assert.equal(before.summary.availableBalance, 1500);
  assert.equal(before.summary.expiringAmount, 1000);
  assert.equal(before.rows.find(row => row.employeeId === 'employee-1').balance, 800);
  const policy = [{ spaceId: 'team-1', archived: true, archivedAt: observedAt }];
  const after = buildLeaderOverview({ ...input, teamManagement: policy });
  assert.equal(after.summary.availableBalance, 500);
  assert.equal(after.summary.expiringAmount, 0);
  assert.equal(after.summary.unallocatedBalance, null);
  assert.equal(after.rows.find(row => row.employeeId === 'employee-1').balance, 500);
  assert.equal(after.summary.netConsumption, 90, 'historical consumption is retained');
  assert.equal(teamViewModels([team], [pool, member], policy)[0].archived, true);
  assert.equal(teamViewModels([team], [pool, member], [])[0].archived, false);
});
