import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError, fail, hash, string } from './domain.mjs';

const REQUEST_MS = 48 * 60 * 60 * 1000;
const APPROVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MAX_DOWNLOADS = 3;

const normalized = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value;

// Applicant names are intentionally unverified. Only an administrator may map
// one of these requests to an employee and release a collector credential.
export function createEnrollment(db, { clock, employee, getInstallation, createInstallation, skipInitialBinding }) {
  db.exec(`CREATE TABLE IF NOT EXISTS enrollment_requests (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      employee_id TEXT,
      installation_id TEXT,
      claimed_at TEXT,
      download_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS enrollment_requests_created ON enrollment_requests(created_at DESC);`);

  const now = () => new Date(clock()).toISOString();
  const rowForId = id => db.prepare('SELECT * FROM enrollment_requests WHERE id=?').get(id);
  const rowForToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? db.prepare('SELECT * FROM enrollment_requests WHERE token_hash=?').get(hash(token)) : null;
  const effectiveStatus = row => ['pending', 'approved'].includes(row.status) && clock() >= Date.parse(row.expires_at)
    ? 'expired' : row.status;
  const view = (row, admin = false) => {
    const status = effectiveStatus(row);
    let person = null;
    // An installation and then its directory employee may be removed after a
    // request was approved. The application record must remain readable.
    if (row.employee_id) try { person = employee(row.employee_id); } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
    }
    const result = {
      id: row.id, name: row.name, department: row.department, status,
      createdAt: row.created_at, expiresAt: row.expires_at,
      decidedAt: row.decided_at, employeeName: person?.name ?? null,
      claimedAt: row.claimed_at,
    };
    if (admin) Object.assign(result, { employeeId: row.employee_id, installationId: row.installation_id });
    else if (row.installation_id && ['approved', 'claimed'].includes(status)) {
      try {
        const device = getInstallation(row.installation_id);
        result.collector = { lastSeenAt: device.lastSeenAt, online: device.online, extensionVersion: device.extensionVersion ?? null };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        result.collector = null;
      }
    }
    return result;
  };
  const requireRow = id => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) fail('申请编号格式不正确', 400);
    const row = rowForId(id);
    if (!row) fail('申请不存在', 404);
    return row;
  };
  const requireApplicant = token => {
    const row = rowForToken(token);
    if (!row) fail('请重新提交领取申请', 401);
    return row;
  };

  function createRequest(input, existingToken) {
    const prior = rowForToken(existingToken);
    if (prior && ['pending', 'approved'].includes(effectiveStatus(prior))) return { request: view(prior), token: existingToken, reused: true };
    const name = string(normalized(input.name), '姓名', 100);
    const department = string(normalized(input.department), '部门', 80);
    const pending = db.prepare("SELECT COUNT(*) AS count FROM enrollment_requests WHERE status='pending' AND expires_at>?").get(now()).count;
    if (pending >= 500) fail('申请暂时较多，请稍后再试', 503);
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID(), createdAt = now(), expiresAt = new Date(clock() + REQUEST_MS).toISOString();
    db.prepare('INSERT INTO enrollment_requests(id,token_hash,name,department,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, hash(token), name, department, 'pending', createdAt, expiresAt);
    return { request: view(requireRow(id)), token, reused: false };
  }

  function ownRequest(token) { return view(requireApplicant(token)); }
  function pendingSummary() {
    const row = db.prepare("SELECT COUNT(*) AS count, MIN(expires_at) AS next_expires_at FROM enrollment_requests WHERE status='pending' AND expires_at>?").get(now());
    return { count: row.count, nextExpiresAt: row.next_expires_at };
  }
  function listRequests() {
    const cutoff = now();
    const pending = db.prepare("SELECT * FROM enrollment_requests WHERE status='pending' AND expires_at>? ORDER BY created_at DESC,id DESC").all(cutoff);
    const recent = db.prepare("SELECT * FROM enrollment_requests WHERE NOT (status='pending' AND expires_at>?) ORDER BY created_at DESC,id DESC LIMIT 200").all(cutoff);
    return [...pending, ...recent].map(row => view(row, true));
  }
  function approveRequest(id, employeeId, installationId = null) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = requireRow(id);
      if (effectiveStatus(row) !== 'pending') fail('当前申请不能批准', 409);
      const person = employee(employeeId);
      if (!person) fail('请选择员工');
      const device = installationId ? getInstallation(installationId) : createInstallation({ employeeId, role: 'collector' });
      if (!device.enabled || device.role !== 'collector' || device.employeeId !== person.id) fail('采集端与所选员工不匹配', 409);
      // This collector identifies the operator, not the owner of whichever
      // Jimeng account they happen to log into first.
      if (device.initialIdentityBinding?.status === 'pending') skipInitialBinding(device.id);
      const decidedAt = now(), expiresAt = new Date(clock() + APPROVAL_MS).toISOString();
      db.prepare("UPDATE enrollment_requests SET status='approved',employee_id=?,installation_id=?,decided_at=?,expires_at=? WHERE id=?")
        .run(person.id, device.id, decidedAt, expiresAt, id);
      db.exec('COMMIT');
      return view(requireRow(id), true);
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  function rejectRequest(id) {
    const row = requireRow(id);
    if (effectiveStatus(row) !== 'pending') fail('当前申请不能拒绝', 409);
    db.prepare("UPDATE enrollment_requests SET status='rejected',decided_at=? WHERE id=?").run(now(), id);
    return view(requireRow(id), true);
  }
  function claimableInstallation(token) {
    const row = requireApplicant(token), status = effectiveStatus(row);
    if (status === 'pending') fail('申请尚未批准', 409);
    if (status === 'rejected') fail('申请未通过', 403);
    if (status === 'expired') fail('领取时间已过，请重新申请', 410);
    if (status !== 'approved' && status !== 'claimed') fail('当前申请不能领取', 409);
    if (status === 'claimed' && (clock() >= Date.parse(row.claimed_at) + RETRY_MS || row.download_count >= MAX_DOWNLOADS))
      fail('本次领取已结束，请重新申请', 410);
    const device = getInstallation(row.installation_id);
    if (!device.enabled || device.role !== 'collector' || device.employeeId !== row.employee_id)
      fail('采集端已停用，请联系管理员', 403);
    return device;
  }
  function recordClaim(token) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const device = claimableInstallation(token);
      const row = requireApplicant(token);
      db.prepare("UPDATE enrollment_requests SET status='claimed',claimed_at=COALESCE(claimed_at,?),download_count=download_count+1 WHERE id=?")
        .run(now(), row.id);
      db.exec('COMMIT');
      return device;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return { createRequest, ownRequest, pendingSummary, listRequests, approveRequest, rejectRequest, claimableInstallation, recordClaim };
}
