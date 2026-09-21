import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { hash, identity, fail } from './domain.mjs';
import { createDirectory } from './directory.mjs';
import { validExtensionVersion } from './collector-release.mjs';
import { estimateTeamCreditExpiry } from './credit-expiry.mjs';
import { createOwnershipHistory } from './ownership-history.mjs';

const subscriptionKeys = ['membershipPlan', 'billingCycle', 'membershipExpiresAt', 'nextRenewalAt', 'subscriptionObservedAt'];
const emptySubscription = { membershipPlan:null, billingCycle:null, membershipExpiresAt:null, nextRenewalAt:null, subscriptionObservedAt:null };
const withTeamBalanceObservation = team => ({...team,balanceObservedAt:Object.hasOwn(team,'balanceObservedAt') ? team.balanceObservedAt : team.totalBalance != null ? team.observedAt ?? null : null});
const refreshPending = new Set(['waiting','running']);
const COMMAND_ONLINE_MS = 60_000;
const SYNC_TIMEOUT_MS = 120_000;
const identitySourceOrder = ['login_account','team_member','history','ownership_mapping'];
function identitySourceFields(sources, assigned) {
  const flags = new Set(sources);
  flags.delete('ownership_mapping');
  if (assigned) flags.add('ownership_mapping');
  return {sources:identitySourceOrder.filter(source=>flags.has(source)),
    historyOnly:flags.has('history')&&!flags.has('login_account')&&!flags.has('team_member')&&!assigned};
}

export function createStore({ dataDir, secret, clock = Date.now }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const dbPath = path.join(dataDir, 'credits.sqlite');
  const previousMask = process.umask(0o077);
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, scope TEXT NOT NULL, space_id TEXT NOT NULL, snapshot_at TEXT NOT NULL, membership_snapshot_at TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, owner_name TEXT, owner_department TEXT);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_evidence (operation_key TEXT NOT NULL, installation_id TEXT NOT NULL, employee_id TEXT NOT NULL, received_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(operation_key,installation_id,employee_id));
      CREATE TABLE IF NOT EXISTS teams (space_id TEXT PRIMARY KEY, snapshot_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_mappings (platform_user_id TEXT PRIMARY KEY, real_name TEXT, department TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_requests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installation_accounts (installation_id TEXT NOT NULL REFERENCES installations(id), account_id TEXT NOT NULL REFERENCES accounts(id), PRIMARY KEY(installation_id,account_id));
      CREATE TABLE IF NOT EXISTS collector_diagnostics (installation_id TEXT NOT NULL REFERENCES installations(id), event_id TEXT NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(installation_id,event_id));
      CREATE INDEX IF NOT EXISTS diagnostics_installation_time ON collector_diagnostics(installation_id,observed_at);
      CREATE INDEX IF NOT EXISTS accounts_team ON accounts(space_id,scope);
      CREATE INDEX IF NOT EXISTS transactions_account ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS transactions_team_grant ON transactions(account_id,json_extract(data,'$.occurredAt') DESC)
        WHERE json_extract(data,'$.kind')='grant' AND json_extract(data,'$.description')='团队会员积分' AND json_extract(data,'$.amount')>0;
      CREATE INDEX IF NOT EXISTS transactions_operation ON transactions(json_extract(data,'$.platformSubmitId'),json_extract(data,'$.chargedPlatformUserId')) WHERE json_extract(data,'$.kind')='consume';
      CREATE TABLE IF NOT EXISTS data_revisions (name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO data_revisions(name,revision) VALUES('transactions',0);
      CREATE TRIGGER IF NOT EXISTS transactions_revision_insert AFTER INSERT ON transactions
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='transactions'; END;
      CREATE TRIGGER IF NOT EXISTS transactions_revision_update AFTER UPDATE ON transactions
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='transactions'; END;
      CREATE TRIGGER IF NOT EXISTS transactions_revision_delete AFTER DELETE ON transactions
        BEGIN UPDATE data_revisions SET revision=revision+1 WHERE name='transactions'; END;`);
    if (!db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'membership_snapshot_at')) {
      try { db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE accounts ADD COLUMN membership_snapshot_at TEXT NOT NULL DEFAULT '';
        UPDATE accounts SET membership_snapshot_at=CASE
          WHEN json_type(data,'$.membershipPlan') IS NOT NULL OR json_type(data,'$.billingCycle') IS NOT NULL
            OR json_type(data,'$.membershipExpiresAt') IS NOT NULL OR json_type(data,'$.nextRenewalAt') IS NOT NULL
            OR json_type(data,'$.subscriptionObservedAt') IS NOT NULL
          THEN COALESCE(json_extract(data,'$.subscriptionObservedAt'),snapshot_at)
          ELSE '' END;
        COMMIT;`); } catch(error) { if(db.isTransaction)db.exec('ROLLBACK'); throw error; }
    }
    if (!db.prepare('PRAGMA table_info(identity_mappings)').all().some(column => column.name === 'bound_phone')) db.exec('ALTER TABLE identity_mappings ADD COLUMN bound_phone TEXT');
    for (const column of ['observed_nickname','nickname_observed_at']) if (!db.prepare('PRAGMA table_info(identity_mappings)').all().some(item => item.name === column)) db.exec(`ALTER TABLE identity_mappings ADD COLUMN ${column} TEXT`);
    for (const name of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(name)) chmodSync(name, 0o600);
  } finally { process.umask(previousMask); }
  const key = Buffer.from(hash(`installation-provision:${secret}`), 'hex');
  const encrypt = token => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
  };
  const decrypt = value => {
    const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  };
  const now = () => new Date(clock()).toISOString();
  const directory = createDirectory(db,now);
  const ownershipHistory = createOwnershipHistory(db,now);
  function mutateOwnership(action,platformUserIds) {
    const nested=db.isTransaction;
    if(!nested)db.exec('BEGIN IMMEDIATE');
    try {
      const result=action();
      for(const platformUserId of platformUserIds)ownershipHistory.record(platformUserId);
      if(!nested)db.exec('COMMIT');
      return result;
    } catch(error) {if(!nested&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  function patchEmployee(id,input) {
    const users=db.prepare('SELECT platform_user_id FROM identity_mappings WHERE employee_id=?').all(id);
    return mutateOwnership(()=>directory.patchEmployee(id,input),users.map(row=>row.platform_user_id));
  }
  function patchDepartment(id,input) {
    const users=db.prepare(`SELECT m.platform_user_id FROM identity_mappings m LEFT JOIN employees e ON e.id=m.employee_id
      WHERE COALESCE(e.department_id,m.department_id)=?`).all(id);
    return mutateOwnership(()=>directory.patchDepartment(id,input),users.map(row=>row.platform_user_id));
  }
  const bindingState = (status, employeeId = null) => ({status,platformUserId:null,employeeId,observedAt:null,decidedAt:null});
  // An upgrade must not enroll the next borrowed account on a device that has
  // already collected data. Unused, preassigned installation packages remain eligible.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare('SELECT id,data,employee_id FROM installations').all()) {
      const data = JSON.parse(row.data);
      if (data.initialIdentityBinding) continue;
      const observed = data.lastSeenAt || db.prepare('SELECT 1 FROM installation_accounts WHERE installation_id=? LIMIT 1').get(row.id);
      data.initialIdentityBinding = bindingState(observed ? 'legacy' : row.employee_id ? 'pending' : 'unassigned',row.employee_id??null);
      db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
    }
    db.exec('COMMIT');
  } catch(error) { if(db.isTransaction)db.exec('ROLLBACK');throw error; }
  const rawInstallation = id => db.prepare('SELECT * FROM installations WHERE id=?').get(id);
  function publicInstallation(row) {
    if (!row) return null;
    const data = JSON.parse(row.data);
    const employee=directory.employee(row.employee_id??null),department=directory.department(row.department_id??null);
    data.employeeId=employee?.id??null;data.departmentId=employee?.departmentId??department?.id??null;
    data.employeeName=employee?.name??data.employeeName??null;data.department=employee?employee.department:department?.name??null;
    if (data.lastSeenAt && data.status === 'ok' && clock() - Date.parse(data.lastSeenAt) > 24 * 3600_000) data.status = 'offline';
    data.accountCount = db.prepare('SELECT COUNT(*) AS n FROM installation_accounts WHERE installation_id=?').get(row.id).n;
    data.lastCommandPollAt = data.lastCommandPollAt ?? null;
    data.online = Boolean(data.enabled && data.lastCommandPollAt && clock() - Date.parse(data.lastCommandPollAt) <= COMMAND_ONLINE_MS);
    // Delayed uploads may carry older versions. Prefer the newest actual
    // observation, not the arrival time, and never infer a version from activity.
    const versionLog=db.prepare(`SELECT observed_at,data FROM collector_diagnostics WHERE installation_id=?
      AND json_type(data,'$.extensionVersion')='text' ORDER BY observed_at DESC,received_at DESC,rowid DESC`).all(row.id)
      .map(log=>({...log,version:JSON.parse(log.data).extensionVersion})).find(log=>validExtensionVersion(log.version));
    data.extensionVersion=versionLog?.version??null;data.extensionVersionObservedAt=versionLog?.observed_at??null;
    return data;
  }
  function publicAccount(row) {
    if (!row) return null;
    const collected = JSON.parse(row.data);
    let ownerPlatformUserId = row.scope === 'personal' ? collected.platformUserId : null;
    if (['team_total','team_member'].includes(row.scope)) {
      const teamRow = db.prepare('SELECT data FROM teams WHERE space_id=?').get(row.space_id);
      if (teamRow) {
        const team = JSON.parse(teamRow.data), creators = (team.members ?? []).filter(member => member.role === 'creator');
        const declaredCreator = team.creatorPlatformUserId ?? null;
        const declaredMember = (team.members ?? []).find(member => member.platformUserId === declaredCreator);
        const conflicts = creators.length > 1 || (declaredCreator && creators.some(member => member.platformUserId !== declaredCreator))
          || (declaredMember && !['creator','unknown'].includes(declaredMember.role));
        if (!conflicts) ownerPlatformUserId = declaredCreator ?? creators[0]?.platformUserId ?? null;
        if (ownerPlatformUserId === row.space_id) ownerPlatformUserId = null;
      }
    }
    // Defaults are a current directory join, never a historical operator claim.
    // A borrowed-account upload cannot change these mappings or manual overrides.
    const mapping = ownerPlatformUserId ? db.prepare('SELECT employee_id,department_id FROM identity_mappings WHERE platform_user_id=?').get(ownerPlatformUserId) : null;
    const employee = directory.employee(row.owner_employee_id ?? mapping?.employee_id ?? null);
    const department = directory.department(row.owner_department_id ?? employee?.departmentId ?? (row.owner_employee_id ? null : mapping?.department_id) ?? null);
    const account = { ...emptySubscription,creditBatches:null,creditBatchesComplete:false, ...collected,
      ownerEmployeeId:employee?.id??null,ownerDepartmentId:department?.id??null,ownerName:employee?.name??null,ownerDepartment:department?.name??null,
      ownerEmployeeOverrideId:row.owner_employee_id??null,ownerDepartmentOverrideId:row.owner_department_id??null,source:'live' };
    account.status = account.balance === null ? 'unknown' : clock() - Date.parse(account.lastSyncedAt) > 24 * 3600_000 ? 'stale' : 'ok';
    account.creditExpiryEstimate = null;
    if (['team_total','team_member'].includes(account.scope) && account.subscriptionBalance > 0) {
      const grant = db.prepare(`SELECT t.data FROM accounts a JOIN transactions t ON t.account_id=a.id
        WHERE a.space_id=? AND a.scope IN ('team_total','team_member')
          AND json_extract(t.data,'$.kind')='grant' AND json_extract(t.data,'$.description')='团队会员积分'
          AND json_extract(t.data,'$.amount')>0 AND json_extract(t.data,'$.occurredAt')<=?
        ORDER BY json_extract(t.data,'$.occurredAt') DESC,t.id DESC LIMIT 1`).get(account.spaceId,account.lastSyncedAt);
      account.creditExpiryEstimate = estimateTeamCreditExpiry(account,grant ? JSON.parse(grant.data) : null);
    }
    return account;
  }
  function getInstallation(id) { const result = publicInstallation(rawInstallation(id)); if (!result) fail('设备不存在',404); return result; }
  function createInstallation(input) {
    const employee=directory.employee(input.employeeId);
    if(!employee)fail('请选择员工');
    const id = randomUUID(), token = `jmc_${randomBytes(32).toString('base64url')}`;
    const data = { id, ...input,employeeName:employee.name,department:employee.department, enabled:true, createdAt:now(), lastSeenAt:null, lastCommandPollAt:null, online:false, status:'waiting', message:null, accountCount:0,initialIdentityBinding:bindingState('pending',employee.id) };
    db.prepare('INSERT INTO installations(id,token_hash,token_cipher,data,employee_id) VALUES(?,?,?,?,?)').run(id,hash(token),encrypt(token),JSON.stringify(data),employee.id);
    return getInstallation(id);
  }
  function patchInstallation(id, input) {
    const current = getInstallation(id);
    if(Object.hasOwn(input,'employeeId')&&input.employeeId!==current.employeeId&&['bound','conflict','ambiguous','legacy','skipped'].includes(current.initialIdentityBinding?.status))fail('此采集端已完成首次识别，请为其他员工新建采集端',409);
    const data = { ...current, ...input };
    if(Object.hasOwn(input,'employeeId')){
      const employee=directory.employee(input.employeeId);
      data.employeeName=employee?.name??null;data.department=employee?.department??null;
      if(data.initialIdentityBinding?.status==='pending')data.initialIdentityBinding={...data.initialIdentityBinding,employeeId:employee?.id??null};
      db.prepare('UPDATE installations SET data=?,employee_id=?,department_id=NULL WHERE id=?').run(JSON.stringify(data),employee?.id??null,id);
    } else db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),id);
    return getInstallation(id);
  }
  function skipInitialBinding(id) {
    const row = rawInstallation(id);
    if (!row) fail('设备不存在',404);
    const data = JSON.parse(row.data), binding = data.initialIdentityBinding;
    if (binding?.status === 'skipped') return getInstallation(id);
    if (!['pending','conflict','ambiguous'].includes(binding?.status)) fail('当前首次绑定状态不能设为仅采集',409);
    // Resolve enrollment only. Keep the original login evidence and every
    // account owner intact; later logins cannot restart automatic enrollment.
    data.initialIdentityBinding = {...binding,status:'skipped',resolution:'collection_only',resolvedAt:now(),originalStatus:binding.status};
    db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(data),id);
    return getInstallation(id);
  }
  function authenticate(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const result = publicInstallation(db.prepare('SELECT * FROM installations WHERE token_hash=?').get(hash(token)));
    return result?.enabled ? result : null;
  }
  function requireActiveInstallation(id) {
    const row = rawInstallation(id);
    if (!row || !JSON.parse(row.data).enabled) fail('采集设备凭据无效或已停用',401);
  }
  function deleteInstallation(id) {
    const device = getInstallation(id);
    db.exec('BEGIN IMMEDIATE');
    try {
      // A first login can be observed before any wallet is readable. Preserve
      // that identity independently of the collector being retired.
      const binding = device.initialIdentityBinding;
      if (binding?.platformUserId) {
        const nickname = binding.displayName ?? null, observedAt = binding.observedAt ?? '';
        db.prepare(`INSERT INTO identity_mappings(platform_user_id,updated_at,observed_nickname,nickname_observed_at) VALUES(?,?,?,?)
          ON CONFLICT(platform_user_id) DO UPDATE SET
            observed_nickname=CASE WHEN excluded.observed_nickname IS NOT NULL AND (identity_mappings.observed_nickname IS NULL OR excluded.nickname_observed_at>=COALESCE(identity_mappings.nickname_observed_at,'')) THEN excluded.observed_nickname ELSE identity_mappings.observed_nickname END,
            nickname_observed_at=CASE WHEN excluded.observed_nickname IS NOT NULL AND (identity_mappings.observed_nickname IS NULL OR excluded.nickname_observed_at>=COALESCE(identity_mappings.nickname_observed_at,'')) THEN excluded.nickname_observed_at ELSE identity_mappings.nickname_observed_at END`).run(binding.platformUserId,binding.decidedAt??now(),nickname,observedAt);
      }
      for (const row of db.prepare('SELECT data FROM sync_requests WHERE expires_at>?').all(now())) {
        const request = JSON.parse(row.data), target = request.targets.find(item=>item.installationId===id);
        if (target && refreshPending.has(target.status)) {
          target.status='failed';target.message='采集端已删除';target.finishedAt=now();saveSyncRequest(request);
        }
      }
      db.prepare('DELETE FROM collector_diagnostics WHERE installation_id=?').run(id);
      db.prepare('DELETE FROM installation_accounts WHERE installation_id=?').run(id);
      db.prepare('DELETE FROM installations WHERE id=?').run(id);
      db.exec('COMMIT');
      return {deleted:true,id};
    } catch(error) { if(db.isTransaction)db.exec('ROLLBACK');throw error; }
  }
  function installationToken(id) {
    const row = rawInstallation(id);
    if (!row) fail('设备不存在',404);
    if (!JSON.parse(row.data).enabled) fail('设备已停用',403);
    return decrypt(row.token_cipher);
  }
  function getAccount(id) {
    const account = publicAccount(db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
    if (!account) fail('账号不存在',404);
    return account;
  }
  function patchAccount(id, input) {
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!row) fail('账号不存在',404);
    // Null restores automatic ownership. Omitted fields retain only the stored
    // override, so a partial edit never freezes a currently inferred default.
    const employee=directory.employee(Object.hasOwn(input,'ownerEmployeeId')?input.ownerEmployeeId:row.owner_employee_id??null);
    const department=directory.department(Object.hasOwn(input,'ownerDepartmentId')?input.ownerDepartmentId:row.owner_department_id??null);
    db.prepare('UPDATE accounts SET owner_name=?,owner_department=?,owner_employee_id=?,owner_department_id=? WHERE id=?').run(employee?.name??null,department?.name??null,employee?.id??null,department?.id??null,id);
    return getAccount(id);
  }
  function upsertAccount(account, observedAt = account.lastSyncedAt) {
    const row = db.prepare('SELECT snapshot_at,membership_snapshot_at,data FROM accounts WHERE id=?').get(account.id);
    const previous = row ? JSON.parse(row.data) : null;
    // Balance and subscription observations are ordered independently. A membership-only
    // observation must never make an old balance look freshly measured.
    const balanceAccepted = !row || (row.snapshot_at < account.lastSyncedAt && !(account.balance === null && previous.balance !== null));
    const providedSubscriptionKeys = subscriptionKeys.filter(key => Object.hasOwn(account, key));
    const membershipObservedAt = account.subscriptionObservedAt ?? account.lastSyncedAt ?? observedAt;
    const subscriptionAccepted = providedSubscriptionKeys.length > 0 && (!row || row.membership_snapshot_at < membershipObservedAt);
    if (!balanceAccepted && !subscriptionAccepted) return false;
    const next = balanceAccepted ? { ...account } : { ...previous };
    if(balanceAccepted){next.creditBatches=account.creditBatches??null;next.creditBatchesComplete=account.creditBatchesComplete??false;}
    // An absent field means it was not observed. Only an explicit null can clear a value.
    for (const key of subscriptionKeys) next[key] = previous?.[key] ?? null;
    if (subscriptionAccepted) for (const key of providedSubscriptionKeys) next[key] = account[key];
    db.prepare(`INSERT INTO accounts(id,scope,space_id,snapshot_at,membership_snapshot_at,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET snapshot_at=excluded.snapshot_at,membership_snapshot_at=excluded.membership_snapshot_at,data=excluded.data`).run(
      account.id,account.scope,account.spaceId,balanceAccepted ? account.lastSyncedAt : row.snapshot_at,
      subscriptionAccepted ? membershipObservedAt : (row?.membership_snapshot_at ?? ''),JSON.stringify(next));
    if (account.scope === 'team_total') db.prepare(`UPDATE transactions SET account_id=? WHERE account_id IN
      (SELECT id FROM accounts WHERE space_id=? AND scope='team_member')`).run(account.id,account.spaceId);
    return true;
  }
  function upsertTeam(snapshot) {
    const row = db.prepare('SELECT snapshot_at,data FROM teams WHERE space_id=?').get(snapshot.spaceId);
    if (row && row.snapshot_at >= snapshot.observedAt) return false;
    const previous = row ? withTeamBalanceObservation(JSON.parse(row.data)) : null;
    const priorMembers = new Map((previous?.members ?? []).map(member => [member.platformUserId, member]));
    const members = snapshot.membersComplete ? new Map() : new Map(priorMembers);
    for (const member of snapshot.members) {
      members.set(member.platformUserId, {displayName:member.platformUserId,role:'unknown',usedCredits:null,balance:null,joinedAt:null,...priorMembers.get(member.platformUserId),...member});
    }
    if (members.size > 500) fail('合并后的团队成员数超过 500，需缩小采集范围');
    const next = {name:`团队 ${snapshot.spaceId}`,creatorPlatformUserId:null,creatorDisplayName:null,membershipPlan:null,membershipExpiresAt:null,totalBalance:null,allocatableBalance:null,totalSeats:null,availableSeats:null,...previous,...snapshot,members:[...members.values()]};
    // Roster or metadata refreshes must not make a retained balance look freshly measured.
    next.balanceObservedAt = Object.hasOwn(snapshot,'totalBalance') ? snapshot.observedAt : previous?.balanceObservedAt ?? null;
    if (next.totalSeats != null && next.availableSeats != null && next.availableSeats > next.totalSeats) fail('空余席位不能超过总席位');
    db.prepare(`INSERT INTO teams(space_id,snapshot_at,data) VALUES(?,?,?)
      ON CONFLICT(space_id) DO UPDATE SET snapshot_at=excluded.snapshot_at,data=excluded.data`).run(snapshot.spaceId,snapshot.observedAt,JSON.stringify(next));
    return true;
  }
  const operationKey = evidence => hash(JSON.stringify([evidence.spaceType,evidence.spaceType==='personal'?'personal':evidence.spaceId,evidence.userId,evidence.submitId]));
  function transactionOperation(transaction,account) {
    if(transaction.kind!=='consume'||!transaction.platformSubmitId||!transaction.chargedPlatformUserId)return null;
    if(account.spaceType==='team'&&transaction.chargedPlatformUserId===account.spaceId)return null;
    return {submitId:transaction.platformSubmitId,userId:transaction.chargedPlatformUserId,spaceType:account.spaceType,spaceId:account.spaceType==='personal'?'personal':account.spaceId};
  }
  function recordOperationEvidence(device,evidence) {
    const createdAt=Date.parse(device.createdAt);
    if(!Number.isFinite(createdAt)||Date.parse(evidence.occurredAt)<createdAt-300_000)fail('提交操作时间早于此采集端接入时间');
    // Keep a receipt-time employee snapshot. Directory edits, collector deletion
    // and retries cannot rewrite who supplied a successful local submission.
    const data={...evidence,installationId:device.id,operatorEmployeeId:device.employeeId??null,operatorName:device.employeeName??null,
      operatorDepartmentId:device.departmentId??null,operatorDepartment:device.department??null,receivedAt:now()};
    return db.prepare('INSERT OR IGNORE INTO operation_evidence(operation_key,installation_id,employee_id,received_at,data) VALUES(?,?,?,?,?)')
      .run(operationKey(evidence),device.id,device.employeeId??'',data.receivedAt,JSON.stringify(data)).changes>0;
  }
  function reconcileOperation(operation) {
    const rows=db.prepare('SELECT employee_id,data FROM operation_evidence WHERE operation_key=? ORDER BY received_at,rowid').all(operationKey(operation));
    const employees=new Set(rows.map(row=>row.employee_id));
    const evidence=employees.size===1&&!employees.has('')?JSON.parse(rows[0].data):null;
    const attribution={operatorName:evidence?.operatorName??null,operatorDepartment:evidence?.operatorDepartment??null,
      operatorEmployeeId:evidence?.operatorEmployeeId??null,operatorDepartmentId:evidence?.operatorDepartmentId??null,attribution:evidence?'matched':'unconfirmed'};
    const candidates=db.prepare(`SELECT t.id,t.data FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE json_extract(t.data,'$.kind')='consume' AND json_extract(t.data,'$.platformSubmitId')=? AND json_extract(t.data,'$.chargedPlatformUserId')=?
        AND ((?='personal' AND a.scope='personal') OR (?='team' AND a.scope IN ('team_total','team_member') AND a.space_id=?))`)
      .all(operation.submitId,operation.userId,operation.spaceType,operation.spaceType,operation.spaceId);
    for(const row of candidates){
      const transaction=JSON.parse(row.data);
      if(Object.entries(attribution).every(([key,value])=>(transaction[key]??null)===value))continue;
      db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify({...transaction,...attribution}),row.id);
    }
  }
  function ingest(installation, input) {
    requireActiveInstallation(installation.id);
    let accountCount = 0, transactionCount = 0, teamCount = 0, operationCount = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const touched = new Set(), operations = new Map();
      const addOperation = operation => {if(operation)operations.set(operationKey(operation),operation);};
      const evidenceDevice=(input.operationEvidence??[]).length?getInstallation(installation.id):null;
      for(const evidence of input.operationEvidence??[]){
        if(recordOperationEvidence(evidenceDevice,evidence))operationCount++;
        addOperation(evidence);
      }
      // A viewed team roster proves no wallet login and creates no installation association.
      for (const team of input.teams ?? []) if (upsertTeam(team)) teamCount++;
      for (const account of input.accounts) {
        if (upsertAccount(account, input.observedAt)) accountCount++;
        touched.add(account.id);
      }
      for (const transaction of input.transactions) {
        const account = transaction.account;
        if (!db.prepare('SELECT id FROM accounts WHERE id=?').get(account.id)) {
          upsertAccount({...account,displayName:account.platformUserId,spaceName:account.spaceType === 'team' ? '团队空间' : '个人空间',balance:null,giftBalance:null,purchaseBalance:null,subscriptionBalance:null,expiresAt:null,lastSyncedAt:input.observedAt});
          // History alone is not a measured balance snapshot; do not block a delayed real snapshot.
          db.prepare('UPDATE accounts SET snapshot_at=? WHERE id=?').run('',account.id);
          accountCount++;
        }
        touched.add(account.id);
        let accountId = account.id;
        if (account.spaceType === 'team') {
          const totalId = identity({...account,scope:'team_total'}).id;
          if (db.prepare('SELECT id FROM accounts WHERE id=?').get(totalId)) accountId = totalId;
        }
        const existing = db.prepare('SELECT * FROM transactions WHERE id=?').get(transaction.id);
        const chargedPlatformUserId = transaction.chargedPlatformUserId;
        if (existing) {
          const previous = JSON.parse(existing.data);
          if (previous.kind !== transaction.kind || previous.amount !== transaction.amount || previous.occurredAt !== transaction.occurredAt) fail('同一流水出现冲突数据，请重新核对来源',409);
          if (previous.chargedPlatformUserId && chargedPlatformUserId && previous.chargedPlatformUserId !== chargedPlatformUserId) fail('同一流水的扣费平台成员存在冲突，请重新核对来源',409);
          if (previous.platformSubmitId && transaction.platformSubmitId && previous.platformSubmitId !== transaction.platformSubmitId) fail('同一流水的平台提交 ID 存在冲突，请重新核对来源',409);
          // Keep the member identity even when the displayed account is promoted to the team total.
          // This identifies a platform account, never the human who uploaded or operated it.
          const fillsChargedId=!previous.chargedPlatformUserId&&chargedPlatformUserId;
          const fillsSubmitId=!previous.platformSubmitId&&transaction.platformSubmitId;
          if (fillsChargedId || fillsSubmitId) {
            if(fillsChargedId)previous.chargedPlatformUserId = chargedPlatformUserId;
            if(fillsSubmitId)previous.platformSubmitId = transaction.platformSubmitId;
            db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify(previous),transaction.id);
          }
          // Re-observation can promote a team member event into the team's canonical ledger.
          if (existing.account_id !== accountId && getAccount(accountId).scope === 'team_total') db.prepare('UPDATE transactions SET account_id=? WHERE id=?').run(accountId,transaction.id);
          addOperation(transactionOperation(previous,account));
          continue;
        }
        const data = {id:transaction.id,eventId:transaction.eventId,occurredAt:transaction.occurredAt,kind:transaction.kind,amount:transaction.amount,description:transaction.description,chargedPlatformUserId,platformSubmitId:transaction.platformSubmitId??null,operatorName:null,operatorDepartment:null,attribution:'unconfirmed',source:'live'};
        db.prepare('INSERT INTO transactions(id,account_id,data) VALUES(?,?,?)').run(transaction.id,accountId,JSON.stringify(data));
        addOperation(transactionOperation(data,account));
        transactionCount++;
      }
      for(const operation of operations.values())reconcileOperation(operation);
      for (const accountId of touched) db.prepare('INSERT OR IGNORE INTO installation_accounts(installation_id,account_id) VALUES(?,?)').run(installation.id,accountId);
      const device = { ...getInstallation(installation.id), lastSeenAt:now(), status:input.status, message:input.message };
      bindInitialIdentity(device,input);
      db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(device),device.id);
      db.exec('COMMIT');
      return {accepted:true,accounts:accountCount,transactions:transactionCount,teams:teamCount,operations:operationCount};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function bindInitialIdentity(device,input) {
    if(device.initialIdentityBinding?.status!=='pending'||input.status!=='ok')return;
    // Login identity is independent of credit-service availability. Older
    // collectors supply only personal/member snapshots; never infer a login
    // from a team total, roster member or charged history identity.
    const teamIds = new Set(db.prepare("SELECT space_id FROM teams UNION SELECT space_id FROM accounts WHERE scope IN ('team_total','team_member')").all().map(row=>row.space_id));
    const eligibleAccounts = input.accounts.filter(account=>
      ['personal','team_member'].includes(account.scope)&&!teamIds.has(account.platformUserId)&&
      Date.parse(account.lastSyncedAt)>=Date.parse(device.createdAt)-300_000
    );
    if(input.loginIdentity&&teamIds.has(input.loginIdentity.platformUserId))fail('团队空间 ID 不能作为登录身份',409);
    const candidates = input.loginIdentity
      ? Date.parse(input.observedAt)>=Date.parse(device.createdAt)-300_000?[input.loginIdentity.platformUserId]:[]
      : [...new Set(eligibleAccounts.map(account=>account.platformUserId))];
    if(!candidates.length)return;
    const decision = {...bindingState('pending',device.employeeId),observedAt:input.observedAt,decidedAt:now()};
    if(candidates.length!==1){device.initialIdentityBinding={...decision,status:'ambiguous'};return;}
    decision.platformUserId=candidates[0];
    decision.displayName=input.loginIdentity?.displayName??eligibleAccounts.find(account=>account.platformUserId===decision.platformUserId)?.displayName??null;
    if(!device.employeeId){device.initialIdentityBinding={...decision,status:'unassigned'};return;}
    const mapping=db.prepare('SELECT employee_id FROM identity_mappings WHERE platform_user_id=?').get(decision.platformUserId);
    if(mapping?.employee_id&&mapping.employee_id!==device.employeeId){
      device.initialIdentityBinding={...decision,status:'conflict'};return;
    }
    if(!mapping?.employee_id){
      const employee=directory.employee(device.employeeId);
      db.prepare(`INSERT INTO identity_mappings(platform_user_id,real_name,department,updated_at,employee_id,department_id) VALUES(?,?,?,?,?,NULL)
        ON CONFLICT(platform_user_id) DO UPDATE SET real_name=excluded.real_name,department=excluded.department,updated_at=excluded.updated_at,employee_id=excluded.employee_id,department_id=NULL`)
        .run(decision.platformUserId,employee.name,employee.department,decision.decidedAt,employee.id);
      ownershipHistory.record(decision.platformUserId);
    }
    device.initialIdentityBinding={...decision,status:'bound'};
  }
  let transactionCache = null;
  let ownershipProjection = null;
  function observations() {
    const accountRows = db.prepare('SELECT * FROM accounts ORDER BY snapshot_at DESC,id').all();
    const accounts = accountRows.map(publicAccount);
    // History can create empty wallet placeholders. Only a real snapshot or
    // explicit login identity is evidence that an account was logged in.
    const accountSnapshotIds = new Set(accountRows.filter(row=>Number.isFinite(Date.parse(row.snapshot_at))).map(row=>row.id));
    const accountsById = new Map(accounts.map(account=>[account.id,account]));
    const revision = db.prepare("SELECT revision FROM data_revisions WHERE name='transactions'").get().revision;
    const accountScopes = JSON.stringify(accounts.map(account=>[account.id,account.scope,account.spaceId]).sort((a,b)=>a[0].localeCompare(b[0])));
    // Heartbeats, diagnostic logs and directory edits do not change historical
    // rows. Reuse the complete parsed/sorted ledger until its actual data changes.
    if (!transactionCache || transactionCache.revision !== revision || transactionCache.accountScopes !== accountScopes) {
      const transactions = db.prepare('SELECT * FROM transactions').all().map(row=>{
        const transaction = {...JSON.parse(row.data),accountId:row.account_id}, account = accountsById.get(row.account_id);
        // A platform team ID in the user field is not a charged member identity.
        if (account && ['team_total','team_member'].includes(account.scope) && transaction.chargedPlatformUserId === account.spaceId) transaction.chargedPlatformUserId = null;
        return Object.freeze(transaction);
      }).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||a.id.localeCompare(b.id));
      transactionCache = {revision,accountScopes,transactions:Object.freeze(transactions)};
    }
    const ownership=ownershipHistory.view();
    if(!ownershipProjection||ownershipProjection.source!==transactionCache.transactions||ownershipProjection.revision!==ownership.revision){
      const previous=ownershipProjection?.source===transactionCache.transactions?ownershipProjection.transactions:null;
      let changed=!previous;
      const transactions=transactionCache.transactions.map((transaction,index)=>{
        const account=accountsById.get(transaction.accountId);
        const platformUserId=transaction.chargedPlatformUserId??(account?.scope==='personal'?account.platformUserId:null);
        const ownershipSnapshot=ownership.resolve(platformUserId,transaction.occurredAt);
        // Preserve cache references when a later directory edit cannot affect
        // any existing event. No new SELECT/parse/sort of the ledger is needed.
        if(previous&&JSON.stringify(previous[index].ownershipSnapshot)===JSON.stringify(ownershipSnapshot))return previous[index];
        changed=true;return Object.freeze({...transaction,ownershipSnapshot});
      });
      ownershipProjection={source:transactionCache.transactions,revision:ownership.revision,transactions:changed?Object.freeze(transactions):previous};
    }
    return {accounts,accountSnapshotIds,
      teams:db.prepare('SELECT data FROM teams ORDER BY snapshot_at DESC,space_id').all().map(row=>({...withTeamBalanceObservation(JSON.parse(row.data)),source:'live'})),
      transactions:ownershipProjection.transactions};
  }
  function identityDirectory({accounts,teams,transactions,accountSnapshotIds}) {
    const people = new Map();
    const teamSpaceIds = new Set([...teams.map(team=>team.spaceId),...accounts.filter(account=>['team_total','team_member'].includes(account.scope)).map(account=>account.spaceId)]);
    const observe = (platformUserId, displayName, observedAt = '', priority = 0, source = null) => {
      if (!platformUserId || teamSpaceIds.has(platformUserId)) return;
      const previous = people.get(platformUserId) ?? {platformUserId,nickname:null,nicknameAt:'',priority:0,sources:new Set()};
      if (source) previous.sources.add(source);
      // Display names equal to the ID are fallback labels, not observed nicknames.
      const nickname = typeof displayName === 'string' && displayName.trim() && displayName !== platformUserId ? displayName : null;
      if (nickname && (!previous.nickname || priority > previous.priority || (priority === previous.priority && observedAt >= previous.nicknameAt))) {
        previous.nickname = nickname;previous.nicknameAt = observedAt;previous.priority = priority;
      }
      people.set(platformUserId,previous);
    };
    for (const account of accounts) if (account.scope !== 'team_total') observe(account.platformUserId,account.displayName,account.lastSyncedAt,account.scope === 'personal' ? 2 : 1,accountSnapshotIds.has(account.id)?'login_account':null);
    for (const row of db.prepare("SELECT data FROM installations WHERE json_extract(data,'$.initialIdentityBinding.platformUserId') IS NOT NULL").all()) {
      const binding=JSON.parse(row.data).initialIdentityBinding;
      observe(binding.platformUserId,binding.displayName,binding.observedAt??'',2,'login_account');
    }
    for (const team of teams) for (const member of team.members) observe(member.platformUserId,member.displayName,team.observedAt,2,'team_member');
    for (const transaction of transactions) observe(transaction.chargedPlatformUserId,undefined,'',0,'history');
    const mappings = new Map(db.prepare('SELECT * FROM identity_mappings').all().map(row=>[row.platform_user_id,row]));
    for (const mapping of mappings.values()) observe(mapping.platform_user_id,mapping.observed_nickname,mapping.nickname_observed_at??'',2,Number.isFinite(Date.parse(mapping.nickname_observed_at))?'login_account':null);
    return [...people.values()].sort((a,b)=>a.platformUserId.localeCompare(b.platformUserId)).map(person=>{
      const mapping = mappings.get(person.platformUserId);
      const employee=directory.employee(mapping?.employee_id??null),department=directory.department(mapping?.department_id??null);
      return {platformUserId:person.platformUserId,nickname:person.nickname,boundPhone:mapping?.bound_phone??null,employeeId:employee?.id??null,departmentId:employee?.departmentId??department?.id??null,realName:employee?.name??null,department:employee?employee.department:department?.name??null,updatedAt:mapping?.updated_at ?? null,
        ...identitySourceFields(person.sources,Boolean(employee||department))};
    });
  }
  function patchIdentity(platformUserId,input) {
    const current = identityDirectory(observations()).find(person=>person.platformUserId === platformUserId);
    if (!current) fail('尚未观测到此平台账号',404);
    const changesEmployee=Object.hasOwn(input,'employeeId');
    const employee=directory.employee(changesEmployee?input.employeeId:current.employeeId);
    const departmentId=changesEmployee?null:db.prepare('SELECT department_id FROM identity_mappings WHERE platform_user_id=?').get(platformUserId)?.department_id??null;
    const department=directory.department(departmentId);
    const next = {...current,employeeId:employee?.id??null,departmentId:employee?.departmentId??department?.id??null,realName:employee?.name??null,department:employee?.department??department?.name??null,boundPhone:Object.hasOwn(input,'boundPhone')?input.boundPhone:current.boundPhone,updatedAt:now(),
      ...identitySourceFields(current.sources,Boolean(employee||department))};
    mutateOwnership(()=>db.prepare(`INSERT INTO identity_mappings(platform_user_id,real_name,department,updated_at,employee_id,department_id,bound_phone) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(platform_user_id) DO UPDATE SET real_name=excluded.real_name,department=excluded.department,updated_at=excluded.updated_at,employee_id=excluded.employee_id,department_id=excluded.department_id,bound_phone=excluded.bound_phone`).run(platformUserId,next.realName,next.department,next.updatedAt,next.employeeId,departmentId,next.boundPhone),[platformUserId]);
    return next;
  }
  function saveSyncRequest(request) {
    db.prepare(`INSERT INTO sync_requests(id,created_at,expires_at,data) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(request.id,request.createdAt,request.expiresAt,JSON.stringify(request));
  }
  function readSyncRequest(row) {
    if (!row) fail('同步任务不存在',404);
    const request = JSON.parse(row.data);
    if (Date.parse(request.expiresAt) <= clock()) {
      let changed = false;
      for (const target of request.targets) if (refreshPending.has(target.status)) {
        target.status = 'timed_out';target.finishedAt = request.expiresAt;target.message = '设备未在两分钟内完成刷新';changed = true;
      }
      if (changed) saveSyncRequest(request);
    }
    return request;
  }
  function syncStatus(request) {
    const states = request.targets.map(target=>target.status);
    if (states.some(status=>refreshPending.has(status))) return states.every(status=>status === 'waiting') ? 'waiting' : 'running';
    if (states.every(status=>status === 'completed')) return 'completed';
    if (states.some(status=>status === 'completed' || status === 'partial')) return 'partial';
    return states.includes('timed_out') ? 'timed_out' : 'failed';
  }
  function publicSyncRequest(request) {
    return {...request,status:syncStatus(request),targets:request.targets.map(target=>{
      const device = publicInstallation(rawInstallation(target.installationId));
      return {...target,lastCommandPollAt:device?.lastCommandPollAt ?? null,online:device?.online ?? false};
    })};
  }
  function getSyncRequest(id) {
    return publicSyncRequest(readSyncRequest(db.prepare('SELECT data FROM sync_requests WHERE id=?').get(id)));
  }
  function createSyncRequest() {
    for (const row of db.prepare('SELECT data FROM sync_requests WHERE expires_at>? ORDER BY created_at DESC').all(now())) {
      const request = readSyncRequest(row);
      if (request.targets.some(target=>refreshPending.has(target.status))) return publicSyncRequest(request);
    }
    const targets = db.prepare('SELECT * FROM installations ORDER BY rowid').all().map(publicInstallation).filter(device=>device.enabled).map(device=>({installationId:device.id,employeeName:device.employeeName,department:device.department,status:'waiting',message:null,startedAt:null,finishedAt:null}));
    if (!targets.length) fail('没有启用的采集设备可供同步',409);
    const request = {id:randomUUID(),createdAt:now(),expiresAt:new Date(clock()+SYNC_TIMEOUT_MS).toISOString(),targets};
    saveSyncRequest(request);
    return publicSyncRequest(request);
  }
  function pollCommands(installation) {
    requireActiveInstallation(installation.id);
    const device = JSON.parse(rawInstallation(installation.id).data), polledAt = now();
    device.lastCommandPollAt = polledAt;
    db.prepare('UPDATE installations SET data=? WHERE id=?').run(JSON.stringify(device),device.id);
    const commands = [];
    for (const row of db.prepare('SELECT data FROM sync_requests WHERE expires_at>? ORDER BY created_at').all(polledAt)) {
      const request = readSyncRequest(row), target = request.targets.find(item=>item.installationId === installation.id);
      if (!target || !refreshPending.has(target.status)) continue;
      if (target.status === 'waiting') {
        target.status = 'running';target.startedAt = polledAt;saveSyncRequest(request);
      }
      commands.push({type:'refresh',requestId:request.id,createdAt:request.createdAt,expiresAt:request.expiresAt});
    }
    return {commands,polledAt};
  }
  function recordCommandResult(installation,requestId,input) {
    requireActiveInstallation(installation.id);
    const request = readSyncRequest(db.prepare('SELECT data FROM sync_requests WHERE id=?').get(requestId));
    const target = request.targets.find(item=>item.installationId === installation.id);
    if (!target) fail('此同步任务不属于当前采集设备',403);
    if (!refreshPending.has(target.status)) {
      if (target.status !== input.status) fail('此设备的同步任务已结束或已超时',409);
      return {accepted:true,requestId,status:target.status};
    }
    if (target.status !== 'running') fail('请先领取当前设备的刷新命令',409);
    target.status = input.status;target.message = input.message;target.finishedAt = now();saveSyncRequest(request);
    return {accepted:true,requestId,status:target.status};
  }
  const dashboardInstance = randomUUID();
  let dashboardCounter = 0, dashboardChanges = null, dashboardValidUntil = Infinity, dashboardCheckedAt = -Infinity;
  function dashboardVersion() {
    // total_changes covers this writer; data_version also catches other SQLite
    // connections. Neither needs to read or decode the transaction table.
    const changes = `${db.prepare('SELECT total_changes() AS n').get().n}:${db.prepare('PRAGMA data_version').get().data_version}`;
    const checkedAt = clock();
    if (changes !== dashboardChanges || checkedAt >= dashboardValidUntil || checkedAt < dashboardCheckedAt) {
      dashboardCounter++;dashboardChanges=changes;dashboardValidUntil=Infinity;
    }
    dashboardCheckedAt=checkedAt;
    return `${dashboardInstance}:${dashboardCounter}`;
  }
  function dashboard() {
    const data = observations();
    const installations = db.prepare('SELECT * FROM installations ORDER BY rowid DESC').all().map(publicInstallation);
    // A 304 must not freeze online/offline or stale status when no writes occur.
    const checkedAt = clock();
    dashboardValidUntil=Infinity;
    const deadline = at => { if(Number.isFinite(at)&&at>checkedAt)dashboardValidUntil=Math.min(dashboardValidUntil,at); };
    const expires = (value, duration) => deadline(Date.parse(value)+duration+1);
    for (const account of data.accounts) {
      if(account.balance!==null)expires(account.lastSyncedAt,24*3600_000);
      // Expiry badges and the seven-day filter are time dependent in the UI.
      for (const value of [account.expiresAt,account.creditExpiryEstimate?.expiresAt,...(account.creditBatches??[]).filter(batch=>batch.amount>0).map(batch=>batch.expiresAt)]) {
        const at=Date.parse(value);deadline(at-7*86400_000);deadline(at);
      }
    }
    for (const device of installations) {
      if(device.enabled)expires(device.lastCommandPollAt,COMMAND_ONLINE_MS);
      if(device.status==='ok')expires(device.lastSeenAt,24*3600_000);
    }
    return {mode:'live',asOf:now(),accounts:data.accounts,teams:data.teams,transactions:data.transactions,departments:directory.departments(),employees:directory.employees(),identities:identityDirectory(data),installations};
  }
  function recordDiagnostics(installation,logs) {
    requireActiveInstallation(installation.id);
    const receivedAt=now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert=db.prepare('INSERT OR IGNORE INTO collector_diagnostics(installation_id,event_id,observed_at,received_at,data) VALUES(?,?,?,?,?)');
      for(const log of logs)insert.run(installation.id,log.id,log.at,receivedAt,JSON.stringify(log));
      db.prepare('DELETE FROM collector_diagnostics WHERE installation_id=? AND event_id NOT IN (SELECT event_id FROM collector_diagnostics WHERE installation_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 100)').run(installation.id,installation.id);
      db.exec('COMMIT');
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    return {accepted:true};
  }
  function diagnostics(id) {
    getInstallation(id);
    return {logs:db.prepare('SELECT data FROM collector_diagnostics WHERE installation_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 100').all(id).map(row=>JSON.parse(row.data)),lastReceivedAt:db.prepare('SELECT MAX(received_at) value FROM collector_diagnostics WHERE installation_id=?').get(id).value??null};
  }
  const getAdminPasswordRecord=()=>{
    const row=db.prepare('SELECT value FROM admin_settings WHERE key=?').get('login_password');
    return row?JSON.parse(row.value):null;
  };
  const setAdminPasswordRecord=record=>db.prepare(`INSERT INTO admin_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('login_password',JSON.stringify(record));
  const getReleaseAnnouncement=()=>{
    const row=db.prepare('SELECT value FROM admin_settings WHERE key=?').get('collector_release');
    return row?JSON.parse(row.value):null;
  };
  const announceRelease=version=>{
    if(!validExtensionVersion(version))fail('采集器发布版本无效',500);
    const announcement={announcedVersion:version,announcedAt:now()};
    db.prepare(`INSERT INTO admin_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('collector_release',JSON.stringify(announcement));
    return announcement;
  };
  return {...directory,patchEmployee,patchDepartment,createInstallation,patchInstallation,skipInitialBinding,deleteInstallation,getInstallation,authenticate,installationToken,getAccount,patchAccount,patchIdentity,createSyncRequest,getSyncRequest,pollCommands,recordCommandResult,ingest,dashboard,dashboardVersion,recordDiagnostics,diagnostics,getAdminPasswordRecord,setAdminPasswordRecord,getReleaseAnnouncement,announceRelease,close:()=>db.close()};
}
