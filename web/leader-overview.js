import { teamCreditExpiryEstimate } from './credit-expiry.js';
import { accountUnits } from './credit-value.js';
import { referenceValue } from '../shared/reference-pricing.mjs';
import { archivedTeamIds } from './team-management.js';

const DAY = 86_400_000, OFFSET = 8 * 3_600_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stamp = value => value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
const dayStart = value => Math.floor((value + OFFSET) / DAY) * DAY - OFFSET;
const dateKey = value => new Date(value + OFFSET).toISOString().slice(0, 10);
const dateLabel = value => dateKey(value).replaceAll('-', '/');
const expiryTotal = () => ({ total: 0, paid: 0, gift: 0, unclassified: 0 });

// 没有归属人的账号（历史账号、已停用账号或团队总额度）合并成表内的一行。
// 它们造成的消耗与到期是真实损失，必须和员工行出现在同一张表里参与排序，
// 否则顶部摘要卡的合计永远对不上表格，管理者也无法发现这部分浪费。
export const UNASSIGNED_ROW_ID = '__unassigned__';
export const UNASSIGNED_ROW_NAME = '未归属';
const add = (object, field, amount) => { object[field] = (object[field] ?? 0) + amount; };
const sumKnown = items => { const known = items.filter(finite); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
const id = value => value == null || value === '' ? null : String(value);

function inputDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const parsed = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(parsed) && dateKey(parsed) === value ? parsed : NaN;
}

/** China calendar days, inclusive at both ends; no future activity is counted. */
export function overviewRange({ period = 'month', from = null, to = null, now = Date.now() } = {}) {
  const endNow = stamp(now);
  if (!Number.isFinite(endNow)) return { start: null, end: null, days: 0, label: '时间无效', error: '时间无效' };
  let start, end = endNow, error = null;
  if (period === 'all') return { start: null, end, days: null, label: '全部已采集记录', error: null };
  if (period === 'today') start = dayStart(end);
  else if (period === 'week' || period === '7days') start = dayStart(end) - 6 * DAY;
  else if (period === 'custom') {
    start = inputDate(from);
    const last = inputDate(to);
    if (!Number.isFinite(start) || !Number.isFinite(last)) error = '请选择有效的起止日期';
    else if (start > last) error = '开始日期不能晚于结束日期';
    else if (start > endNow) error = '开始日期不能晚于今天';
    end = Math.min(endNow, last + DAY - 1);
  } else {
    const local = new Date(end + OFFSET);
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - OFFSET;
  }
  if (error) return { start: null, end: null, days: 0, label: error, error };
  const days = Math.floor((dayStart(end) - dayStart(start)) / DAY) + 1;
  return { start, end, days, label: `${dateLabel(start)} — ${dateLabel(end)}`, error: null };
}

export function inOverviewRange(occurredAt, range) {
  const at = stamp(occurredAt);
  return Boolean(range && !range.error && Number.isFinite(at) && finite(range.end) && at <= range.end && (range.start == null || at >= range.start));
}

function accountKey(account) {
  if (account?.scope === 'personal' && account.platformUserId) return JSON.stringify(['personal', String(account.platformUserId)]);
  if (account?.scope === 'team_total' && account.spaceId) return JSON.stringify(['team_total', String(account.spaceId)]);
  if (account?.scope === 'team_member' && account.spaceId && account.platformUserId) return JSON.stringify(['team_member', String(account.spaceId), String(account.platformUserId)]);
  return account?.id ? `account:${account.id}` : null;
}

function ledgerKey(account) {
  if (account?.scope === 'personal' && account.platformUserId) return ['personal', String(account.platformUserId)];
  if (['team_total', 'team_member'].includes(account?.scope) && account.spaceId) return ['team', String(account.spaceId)];
  return null;
}

function ownerOf(transaction, directory, account) {
  // An explicit null is meaningful: the server could not establish ownership.
  if (Object.hasOwn(transaction, 'ownershipSnapshot')) {
    const snapshot = transaction.ownershipSnapshot;
    return snapshot?.employeeId ? { ...snapshot, employeeId: String(snapshot.employeeId) } : null;
  }
  const charged = id(transaction.chargedPlatformUserId) || (account?.scope === 'personal' ? id(account.platformUserId) : null);
  const person = charged ? directory.get(charged) : null;
  return person?.employeeId ? { employeeId: String(person.employeeId), name: person.realName, departmentId: person.departmentId ?? null, department: person.department ?? null, basis: 'legacy_current_mapping' } : null;
}

function operatorOf(transaction) {
  return transaction.attribution === 'matched' && transaction.operatorEmployeeId ? {
    employeeId: String(transaction.operatorEmployeeId), name: transaction.operatorName,
    departmentId: transaction.operatorDepartmentId ?? null, department: transaction.operatorDepartment ?? null,
  } : null;
}

function personSignature(person) { return person ? JSON.stringify([person.employeeId, person.departmentId ?? null]) : null; }
function consensus(values) {
  if (!values.length || values.some(value => !value)) return null;
  return new Set(values.map(personSignature)).size === 1 ? values[0] : null;
}

/** Collapse observations of the same official event before calculating money. */
function eventsFrom(transactions, accounts, directory) {
  const events = new Map();
  for (const transaction of transactions) {
    if (!finite(transaction.amount) || !Number.isFinite(stamp(transaction.occurredAt))) continue;
    const account = accounts.get(transaction.accountId) ?? transaction.account;
    const ledger = ledgerKey(account);
    const key = transaction.eventId && ledger ? JSON.stringify([...ledger, String(transaction.eventId)]) : transaction.id ? `id:${transaction.id}` : null;
    if (!key) continue;
    const value = { transaction, account, ledger, owner: ownerOf(transaction, directory, account), operator: operatorOf(transaction), ids: transaction.id ? [transaction.id] : [], conflict: false };
    const previous = events.get(key);
    if (!previous) { events.set(key, value); continue; }
    if (previous.transaction.kind !== transaction.kind || previous.transaction.amount !== transaction.amount || stamp(previous.transaction.occurredAt) !== stamp(transaction.occurredAt)) {
      previous.conflict = true;
      continue;
    }
    // A duplicate with conflicting proof must not pick the first person's name.
    if (previous.owner && value.owner && personSignature(previous.owner) !== personSignature(value.owner)) previous.ownerConflict = true;
    if (previous.operator && value.operator && personSignature(previous.operator) !== personSignature(value.operator)) previous.operatorConflict = true;
    if (Object.hasOwn(transaction, 'ownershipSnapshot') && !value.owner) previous.ownerConflict = true;
    if (Object.hasOwn(previous.transaction, 'ownershipSnapshot') && !previous.owner) previous.ownerConflict = true;
    previous.owner = previous.ownerConflict ? null : previous.owner ?? value.owner;
    previous.operator = previous.operatorConflict ? null : previous.operator ?? value.operator;
    const oldCharged = previous.transaction.chargedPlatformUserId, newCharged = transaction.chargedPlatformUserId;
    if (oldCharged && newCharged && oldCharged !== newCharged) previous.chargedConflict = true;
  }
  return [...events.values()];
}

function operationKey(event) {
  const transaction = event.transaction;
  const charged = id(transaction.chargedPlatformUserId) || (event.account?.scope === 'personal' ? id(event.account.platformUserId) : null);
  return event.ledger && charged && transaction.platformSubmitId && !event.chargedConflict
    ? JSON.stringify([...event.ledger, charged, String(transaction.platformSubmitId)]) : null;
}

function fresh(account, now, maxAge = DAY) {
  const at = stamp(account?.lastSyncedAt);
  return finite(account?.balance) && Number.isFinite(at) && at <= now && now - at <= maxAge;
}

/** Each displayed metric carries its own completeness, including unknown refunds. */
function addMoney(target, field, value, credits, unpriced = null) {
  target.money ??= {};
  target.moneyUnpricedByField ??= {};
  if (Number.isFinite(value)) target.money[field] = (target.money[field] ?? 0) + value;
  const unknown = unpriced ?? (!finite(value) && finite(credits) ? Math.abs(credits) : 0);
  if (unknown > 0) target.moneyUnpricedByField[field] = (target.moneyUnpricedByField[field] ?? 0) + unknown;
}

function chooseBalance(previous, candidate) {
  if (!previous) return candidate;
  const previousValid = finite(previous.balance), candidateValid = finite(candidate.balance);
  if (candidateValid !== previousValid) return candidateValid ? candidate : previous;
  const previousAt = stamp(previous.lastSyncedAt), candidateAt = stamp(candidate.lastSyncedAt);
  return (Number.isFinite(candidateAt) ? candidateAt : -Infinity) > (Number.isFinite(previousAt) ? previousAt : -Infinity) ? candidate : previous;
}

function dueFor(account, now, maxAge = DAY) {
  const result = { batches: [], amount: 0, estimated: 0, unknown: 0 };
  if (!fresh(account, now, maxAge) || !(account.balance > 0)) return result;
  const batches = Array.isArray(account.creditBatches) ? account.creditBatches : [];
  let covered = 0;
  const seen = new Set();
  for (const [index, batch] of batches.entries()) {
    if (!finite(batch.amount) || batch.amount <= 0) continue;
    covered += batch.amount;
    if (batch.kind === 'gift') continue;
    const at = stamp(batch.expiresAt);
    if (!Number.isFinite(at)) { result.unknown++; continue; }
    if (at <= now || at > now + 7 * DAY) continue;
    const key = `${accountKey(account)}:${batch.id ?? `${batch.kind ?? 'unknown'}:${batch.expiresAt}:${index}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.batches.push({ id: key, accountId: account.id, amount: batch.amount, expiresAt: batch.expiresAt, estimated: false, kind: batch.kind ?? 'unknown', scope: account.scope });
    result.amount += batch.amount;
  }
  const estimate = teamCreditExpiryEstimate(account);
  if (estimate && finite(account.subscriptionBalance) && account.subscriptionBalance > 0) {
    const hasSubscriptionBatch = batches.some(batch => batch.kind === 'subscription' && finite(batch.amount) && batch.amount > 0);
    if (!hasSubscriptionBatch) covered += account.subscriptionBalance;
    const at = stamp(estimate.expiresAt);
    if (at > now && at <= now + 7 * DAY) {
      const amount = account.subscriptionBalance;
      result.batches.push({ id: `${accountKey(account)}:estimated:${estimate.expiresAt}`, accountId: account.id, amount, expiresAt: estimate.expiresAt, estimated: true, kind: 'subscription', scope: account.scope });
      result.estimated += amount;
    }
  }
  // A nearest-expiry date alone cannot prove that the whole balance expires then.
  if (covered < account.balance) result.unknown++;
  return result;
}

function newRow(employee, departments, removed = false) {
  return {
    employeeId: String(employee.id ?? employee.employeeId), name: employee.name || '已移除员工',
    departmentId: employee.departmentId ?? null, department: departments.get(employee.departmentId) ?? employee.department ?? null, removed,
    balance: null, personalBalance: null, teamBalance: null, staleBalance: 0, balancePartial: false, lastSyncedAt: null, accounts: [],
    ownedConsumption: null, operatorConsumption: null, selfConsumption: null, borrowedConsumption: null, lentConsumption: null,
    unconfirmedConsumption: null, unknownOwnerConsumption: null, grossConsumption: 0, linkedRefunds: 0, grossOperatorConsumption: 0, operatorRefunds: 0, unmatchedRefunds: 0, legacyOwnershipAmount: 0,
    expiry: expiryTotal(), dueBatches: [], expiringAmount: 0, estimatedExpiringAmount: 0, unknownExpiryCount: 0,
    daily: [], borrowedFrom: [], lentTo: [],
    transactionIds: Object.fromEntries(['owned', 'operator', 'borrowed', 'lent', 'expiry', 'refund', 'operatorRefund', 'unconfirmed'].map(key => [key, new Set()])),
    _daily: new Map(), _borrowed: new Map(), _lent: new Map(), _evidence: false, _selected: false,
  };
}

const pushIds = (target, key, ids) => { for (const value of ids) target.transactionIds[key].add(value); };
function addDaily(row, at, field, amount) {
  const date = dateKey(at), entry = row._daily.get(date) ?? { date, owned: 0, operator: 0 };
  entry[field] += amount;
  row._daily.set(date, entry);
}
function addRelation(row, field, other, amount, ids, money) {
  const entry = row[field].get(other.employeeId) ?? { employeeId: other.employeeId, name: other.name || '已移除员工', department: other.department ?? null, amount: 0, money: null, unpricedCredits: 0, transactionIds: new Set() };
  entry.amount += amount;
  if (finite(money)) entry.money = (entry.money ?? 0) + money;
  else entry.unpricedCredits += Math.abs(amount);
  for (const value of ids) entry.transactionIds.add(value);
  row[field].set(other.employeeId, entry);
}

/** No current mapping or observing collector is ever used as operation proof. */
export function buildLeaderOverview({ accounts = [], transactions = [], identities = [], employees = [], departments = [], teams = [], teamManagement = [], installations = [], referenceRates = [], period = 'month', from = null, to = null, departmentId = 'all', now = Date.now(), asOf = null, useLastKnownBalances = false } = {}) {
  now = stamp(now);
  // The leadership view retains each wallet's last reported balance until a
  // newer observation replaces it. The administration view still checks age.
  const balanceMaxAge = useLastKnownBalances ? Infinity : DAY;
  // 采集时间由服务端打点，所以“现在”必须以服务端时间为准：只要查看电脑的时钟慢一点，
  // 刚采集的余额就会落到“未来”，被当成过期剔除，总库存就会突然掉一大截再回来。
  const clock = Math.max(now, Number.isFinite(stamp(asOf)) ? stamp(asOf) : -Infinity);
  const range = overviewRange({ period, from, to, now: clock });
  const unitsById = new Map();
  const unitsOf = account => {
    if (!account) return null;
    if (unitsById.has(account.id)) return unitsById.get(account.id);
    const units = accountUnits(account, { rates: referenceRates, at: clock });
    unitsById.set(account.id, units);
    return units;
  };
  const departmentNames = new Map(departments.map(department => [String(department.id), department.name]));
  const directory = new Map(identities.map(person => [String(person.platformUserId), person]));
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const teamMap = new Map(teams.map(team => [String(team.spaceId), team]));
  const archivedTeams = archivedTeamIds(teams, teamManagement);
  const rows = new Map(employees.map(employee => [String(employee.id), newRow(employee, departmentNames)]));
  const unassignedRow = newRow({ id: UNASSIGNED_ROW_ID, name: UNASSIGNED_ROW_NAME, departmentId: null }, departmentNames);
  unassignedRow.unassigned = true;
  rows.set(UNASSIGNED_ROW_ID, unassignedRow);
  const all = departmentId === 'all' || departmentId == null;
  const matchesDepartment = person => all || (departmentId === 'unassigned' ? !person?.departmentId : person?.departmentId === departmentId);
  const personForIdentity = platformUserId => {
    const person = directory.get(String(platformUserId));
    if (!person?.employeeId) return null;
    const row = rows.get(String(person.employeeId));
    return { employeeId: String(person.employeeId), name: row?.name ?? person.realName, departmentId: person.departmentId ?? row?.departmentId ?? null, department: person.department ?? row?.department ?? null };
  };
  // Descriptive metadata may come from the canonical account even when a newer
  // roster supplies the balance. Never reuse that older account's credit batches.
  const walletDescription = account => {
    const original = accountMap.get(account.id), team = teamMap.get(String(account.spaceId));
    const isTeam = account.scope === 'team_total';
    const creatorId = team?.creatorPlatformUserId ?? team?.members?.find(member => member.role === 'creator')?.platformUserId;
    const person = personForIdentity(isTeam ? creatorId : account.platformUserId);
    const ownerId = account.ownerEmployeeId ?? original?.ownerEmployeeId ?? null;
    const owner = ownerId ? rows.get(String(ownerId)) : null;
    const employeeName = isTeam ? owner?.name ?? account.ownerName ?? original?.ownerName ?? person?.name ?? null : person?.name ?? null;
    const departmentId = isTeam ? account.ownerDepartmentId ?? original?.ownerDepartmentId ?? person?.departmentId ?? null : person?.departmentId ?? null;
    return {
      accountId: account.id, scope: account.scope, platformUserId: account.platformUserId ?? null, spaceId: account.spaceId ?? null,
      employeeId: isTeam ? ownerId ?? person?.employeeId ?? null : person?.employeeId ?? null,
      employeeName, ownerName: account.ownerName ?? original?.ownerName ?? employeeName,
      departmentId, department: departmentNames.get(String(departmentId)) ?? account.ownerDepartment ?? original?.ownerDepartment ?? person?.department ?? null,
      displayName: (isTeam ? team?.name ?? account.spaceName ?? original?.spaceName : account.displayName ?? original?.displayName ?? directory.get(String(account.platformUserId))?.nickname) ?? null,
      spaceName: account.spaceName ?? original?.spaceName ?? (isTeam ? team?.name : null) ?? null,
    };
  };
  const ensureRow = person => {
    if (!person?.employeeId) return null;
    let row = rows.get(String(person.employeeId));
    if (!row) { row = newRow(person, departmentNames, true); rows.set(row.employeeId, row); }
    return row;
  };
  for (const row of rows.values()) row._selected = matchesDepartment(row);
  const summary = {
    availableBalance: null, staleBalance: 0, unknownBalanceCount: 0, balancePartial: false,
    netConsumption: 0, grossConsumption: 0, linkedRefunds: 0, unmatchedRefunds: 0, borrowedConsumption: 0,
    expiry: expiryTotal(), expiringAmount: 0, estimatedExpiringAmount: 0, unknownExpiryCount: 0, dueBatches: [], wallets: [],
    unconfirmedOperatorConsumption: 0, unassignedConsumption: 0, confirmedOperatorRate: null,
    pendingEmployees: 0, unallocatedBalance: null, legacyOwnershipAmount: 0,
    transactionIds: Object.fromEntries(['owned', 'borrowed', 'expiry', 'refund', 'unconfirmed'].map(key => [key, new Set()])),
  };
  const unassigned = { consumption: 0, expiry: expiryTotal(), transactionIds: { owned: new Set(), expiry: new Set() } };

  // Employee stock uses member quotas; company stock uses each shared pool once.
  const balances = new Map();
  for (const account of accounts) {
    if (account.scope !== 'personal' && archivedTeams.has(String(account.spaceId))) continue;
    const key = accountKey(account);
    if (key) balances.set(key, chooseBalance(balances.get(key), { ...account }));
  }
  const teamSpaces = new Set(accounts.filter(account => account.scope !== 'personal' && !archivedTeams.has(String(account.spaceId))).map(account => account.spaceId));
  for (const team of teams) {
    if (archivedTeams.has(String(team.spaceId))) continue;
    teamSpaces.add(team.spaceId);
    const poolKey = JSON.stringify(['team_total', String(team.spaceId)]);
    const currentPool = balances.get(poolKey);
    if (finite(team.totalBalance)) {
      // The roster may report the same total a moment after the wallet read.
      // Keep the wallet's separately labelled estimate in that case; a changed
      // total cannot safely inherit the old credit composition or expiry.
      const unchangedEstimate = currentPool?.balance === team.totalBalance ? teamCreditExpiryEstimate(currentPool) : null;
      const rosterPool = { id: currentPool?.id ?? `roster_pool:${team.spaceId}`, scope: 'team_total', spaceId: team.spaceId, platformUserId: team.creatorPlatformUserId,
        balance: team.totalBalance, lastSyncedAt: Object.hasOwn(team, 'balanceObservedAt') ? team.balanceObservedAt : team.observedAt,
        ownerDepartmentId: currentPool?.ownerDepartmentId ?? personForIdentity(team.creatorPlatformUserId)?.departmentId ?? null, roster: true,
        ...(unchangedEstimate ? { subscriptionBalance: currentPool.subscriptionBalance, creditExpiryEstimate: unchangedEstimate } : {}) };
      balances.set(poolKey, chooseBalance(currentPool, rosterPool));
    }
    for (const member of team.members ?? []) {
      const memberKey = JSON.stringify(['team_member', String(team.spaceId), String(member.platformUserId)]);
      const current = balances.get(memberKey);
      const candidate = { id: current?.id ?? `roster_member:${team.spaceId}:${member.platformUserId}`, scope: 'team_member', spaceId: team.spaceId,
        platformUserId: member.platformUserId, displayName: member.displayName, balance: member.balance,
        lastSyncedAt: member.balanceObservedAt ?? team.observedAt, roster: true, rosterPartial: !team.membersComplete };
      balances.set(memberKey, chooseBalance(current, candidate));
    }
    const poolPerson = { departmentId: currentPool?.ownerDepartmentId ?? personForIdentity(team.creatorPlatformUserId)?.departmentId ?? null };
    const at = stamp(team.balanceObservedAt ?? team.observedAt);
    if (matchesDepartment(poolPerson) && finite(team.allocatableBalance) && Number.isFinite(at) && at <= clock && clock - at <= balanceMaxAge) add(summary, 'unallocatedBalance', team.allocatableBalance);
  }
  for (const spaceId of teamSpaces) {
    const key = JSON.stringify(['team_total', String(spaceId)]);
    if (!balances.has(key)) balances.set(key, { id: `missing_pool:${spaceId}`, scope: 'team_total', spaceId, balance: null });
  }
  for (const account of balances.values()) {
    const person = account.scope === 'team_total' ? null : personForIdentity(account.platformUserId);
    const row = ensureRow(person), current = fresh(account, clock, balanceMaxAge), stockOwner = account.scope === 'team_total' ? { departmentId: account.ownerDepartmentId ?? null } : person;
    const selected = matchesDepartment(stockOwner);
    const due = dueFor(account, clock, balanceMaxAge);
    if (account.scope !== 'team_member' && selected) {
      if (current) {
        const metadata = walletDescription(account), units = unitsOf(account);
        add(summary, 'availableBalance', account.balance);
        addMoney(summary, 'availableBalance', units?.stockValue, account.balance, units?.stockUnpricedCredits);
        summary.wallets.push({ ...metadata, id: accountKey(account), balance: account.balance, lastSyncedAt: account.lastSyncedAt,
          referenceValue: units?.stockValue ?? null, unpricedCredits: units?.stockUnpricedCredits ?? 0 });
        summary.dueBatches.push(...due.batches.map(batch => {
          const value = referenceValue(account, batch.amount, referenceRates, clock, { kind: batch.kind });
          return { ...metadata, ...batch, referenceValue: value, unpricedCredits: value == null ? batch.amount : 0 };
        }));
      }
      else { summary.unknownBalanceCount++; if (finite(account.balance)) summary.staleBalance += account.balance; }
      summary.expiringAmount += due.amount;
      summary.estimatedExpiringAmount += due.estimated;
      summary.unknownExpiryCount += due.unknown;
    }
    if (!row || !matchesDepartment(person)) continue;
    row._selected = true;
    row._evidence = true;
    row.ownedConsumption ??= 0;
    row.accounts.push(account);
    if (Number.isFinite(stamp(account.lastSyncedAt)) && (!row.lastSyncedAt || stamp(account.lastSyncedAt) < stamp(row.lastSyncedAt))) row.lastSyncedAt = account.lastSyncedAt;
    if (current) {
      add(row, 'balance', account.balance);
      addMoney(row, 'balance', unitsOf(account)?.stockValue, account.balance, unitsOf(account)?.stockUnpricedCredits);
      add(row, account.scope === 'personal' ? 'personalBalance' : 'teamBalance', account.balance);
    } else {
      row.balancePartial = true;
      if (finite(account.balance)) row.staleBalance += account.balance;
    }
    row.balancePartial ||= Boolean(account.rosterPartial);
    row.dueBatches.push(...due.batches);
    row.expiringAmount += due.amount;
    row.estimatedExpiringAmount += due.estimated;
    row.unknownExpiryCount += due.unknown;
  }
  summary.balancePartial = summary.unknownBalanceCount > 0;

  const events = eventsFrom(transactions, accountMap, directory);
  let earliest = null;
  const tasks = new Map();
  for (const event of events) {
    const transaction = event.transaction, at = stamp(transaction.occurredAt);
    if (at > clock || event.conflict) continue;
    earliest = earliest == null ? at : Math.min(earliest, at);
    const owner = ensureRow(event.owner), operator = ensureRow(event.operator);
    if (owner && matchesDepartment(event.owner)) { owner._evidence = true; owner._selected = true; owner.ownedConsumption ??= 0; }
    if (operator && matchesDepartment(event.operator)) { operator._evidence = true; operator._selected = true; operator.operatorConsumption ??= 0; operator.borrowedConsumption ??= 0; operator.selfConsumption ??= 0; operator.unknownOwnerConsumption ??= 0; }
    if (owner && operator && matchesDepartment(event.owner)) { owner.lentConsumption ??= 0; owner.selfConsumption ??= 0; }
    if (transaction.kind === 'consume' && transaction.amount < 0) {
      const key = operationKey(event);
      if (key) { const task = tasks.get(key) ?? []; task.push(event); tasks.set(key, task); }
    }
  }
  if (period === 'all' && !range.error && earliest != null) {
    range.start = dayStart(earliest);
    range.days = Math.floor((dayStart(clock) - range.start) / DAY) + 1;
    range.label = `${dateLabel(range.start)} — ${dateLabel(clock)}`;
  }

  let confirmedGross = 0;
  function consumption(event, amount, { refund = false, refundMoney = null } = {}) {
    const transaction = event.transaction, at = stamp(transaction.occurredAt), owner = ensureRow(event.owner), operator = ensureRow(event.operator);
    const ownerSelected = matchesDepartment(event.owner), operatorSelected = Boolean(operator && matchesDepartment(event.operator));
    const money = refund ? refundMoney : referenceValue(event.account, amount, referenceRates, transaction.occurredAt);
    if (ownerSelected) {
      add(summary, 'netConsumption', amount);
      addMoney(summary, 'netConsumption', money, amount);
      if (refund) { summary.linkedRefunds -= amount; addMoney(summary, 'linkedRefunds', money == null ? null : -money, -amount); pushIds(summary, 'refund', event.ids); }
      else { summary.grossConsumption += amount; addMoney(summary, 'grossConsumption', money, amount); if (operator) confirmedGross += amount; }
      pushIds(summary, 'owned', event.ids);
      if (owner) {
        owner._selected = true; owner._evidence = true;
        add(owner, 'ownedConsumption', amount);
        addMoney(owner, 'consumption', money, amount);
        if (refund) { owner.linkedRefunds -= amount; addMoney(owner, 'linkedRefunds', money == null ? null : -money, -amount); pushIds(owner, 'refund', event.ids); }
        else { owner.grossConsumption += amount; addMoney(owner, 'grossConsumption', money, amount); }
        pushIds(owner, 'owned', event.ids);
        addDaily(owner, at, 'owned', amount);
        if (event.owner.basis === 'legacy_current_mapping') { owner.legacyOwnershipAmount += amount; summary.legacyOwnershipAmount += amount; }
      } else {
        unassigned.consumption += amount; summary.unassignedConsumption += amount; pushIds(unassigned, 'owned', event.ids);
        unassignedRow._evidence = true;
        add(unassignedRow, 'ownedConsumption', amount);
        addMoney(unassignedRow, 'consumption', money, amount);
        if (refund) { unassignedRow.linkedRefunds -= amount; addMoney(unassignedRow, 'linkedRefunds', money == null ? null : -money, -amount); pushIds(unassignedRow, 'refund', event.ids); }
        else { unassignedRow.grossConsumption += amount; addMoney(unassignedRow, 'grossConsumption', money, amount); }
        pushIds(unassignedRow, 'owned', event.ids);
        addDaily(unassignedRow, at, 'owned', amount);
      }
      if (!operator) {
        summary.unconfirmedOperatorConsumption += amount;
        pushIds(summary, 'unconfirmed', event.ids);
        if (owner) { add(owner, 'unconfirmedConsumption', amount); pushIds(owner, 'unconfirmed', event.ids); }
      } else if (owner) owner.unconfirmedConsumption ??= 0;
    }
    if (operatorSelected) {
      operator._selected = true; operator._evidence = true;
      add(operator, 'operatorConsumption', amount);
      addMoney(operator, 'operatorConsumption', money, amount);
      pushIds(operator, 'operator', event.ids);
      if (refund) {
        operator.operatorRefunds -= amount;
        addMoney(operator, 'operatorRefunds', money == null ? null : -money, -amount);
        pushIds(operator, 'operatorRefund', event.ids);
      } else {
        operator.grossOperatorConsumption += amount;
        addMoney(operator, 'grossOperatorConsumption', money, amount);
      }
      addDaily(operator, at, 'operator', amount);
      if (!owner) add(operator, 'unknownOwnerConsumption', amount);
      else if (owner.employeeId !== operator.employeeId) {
        add(operator, 'borrowedConsumption', amount);
        addMoney(operator, 'borrowedConsumption', money, amount);
        summary.borrowedConsumption += amount;
        addMoney(summary, 'borrowedConsumption', money, amount);
        pushIds(operator, 'borrowed', event.ids); pushIds(summary, 'borrowed', event.ids);
        addRelation(operator, '_borrowed', { ...event.owner, name: owner.name, department: event.owner.department ?? owner.department }, amount, event.ids, money);
      }
    }
    if (owner && operator && owner.employeeId === operator.employeeId && (ownerSelected || operatorSelected)) add(owner, 'selfConsumption', amount);
    if (owner && operator && owner.employeeId !== operator.employeeId && ownerSelected) {
      add(owner, 'lentConsumption', amount); pushIds(owner, 'lent', event.ids);
      addMoney(owner, 'lentConsumption', money, amount);
      addRelation(owner, '_lent', { ...event.operator, name: operator.name, department: event.operator.department ?? operator.department }, amount, event.ids, money);
    }
  }
  const refundedTasks = new Map();
  const unmatchedRefund = (event, amount) => {
    if (!(amount > 0) || !matchesDepartment(event.owner)) return;
    summary.unmatchedRefunds += amount;
    pushIds(summary, 'refund', event.ids);
    const row = ensureRow(event.owner);
    if (row) { row.unmatchedRefunds += amount; pushIds(row, 'refund', event.ids); }
    else { unassignedRow.unmatchedRefunds += amount; unassignedRow._evidence = true; pushIds(unassignedRow, 'refund', event.ids); }
  };
  // Process every refund in time order, including earlier periods, so a repeated
  // refund can never restore more than the original task was actually charged.
  for (const event of [...events].sort((a, b) => stamp(a.transaction.occurredAt) - stamp(b.transaction.occurredAt) || String(a.transaction.id).localeCompare(String(b.transaction.id)))) {
    const transaction = event.transaction;
    if (event.conflict || stamp(transaction.occurredAt) > clock) continue;
    const selected = inOverviewRange(transaction.occurredAt, range);
    if (transaction.kind === 'consume' && transaction.amount < 0 && selected) consumption(event, -transaction.amount);
    else if (transaction.kind === 'refund' && transaction.amount > 0) {
      const key = operationKey(event);
      const candidates = (tasks.get(key) ?? []).filter(candidate => stamp(candidate.transaction.occurredAt) <= stamp(transaction.occurredAt));
      const owner = consensus(candidates.map(candidate => candidate.owner)), operator = consensus(candidates.map(candidate => candidate.operator));
      const ownerConflict = new Set(candidates.map(candidate => personSignature(candidate.owner))).size > 1;
      const operatorConflict = new Set(candidates.map(candidate => personSignature(candidate.operator))).size > 1;
      if (!candidates.length || ownerConflict || operatorConflict) {
        if (selected) unmatchedRefund(event, transaction.amount);
        continue;
      }
      const state = refundedTasks.get(key) ?? { credits: 0, money: 0, unknownMoney: false };
      const charged = candidates.reduce((sum, candidate) => sum - candidate.transaction.amount, 0);
      const remaining = Math.max(0, charged - state.credits), linked = Math.min(transaction.amount, remaining);
      if (linked > 0) {
        const units = candidates.map(candidate => referenceValue(candidate.account, 1, referenceRates, candidate.transaction.occurredAt));
        let value = null;
        if (units.every(finite)) {
          if (units.every(unit => Math.abs(unit - units[0]) < 1e-12)) value = linked * units[0];
          // All displayed money is an estimate. For partial refunds across
          // rate revisions, prorate the remaining original charge value;
          // a full refund still reverses exactly the original estimate.
          else if (!state.unknownMoney) value = (candidates.reduce((sum, candidate, index) => sum - candidate.transaction.amount * units[index], 0) - state.money) * linked / remaining;
        }
        state.credits += linked;
        if (value == null) state.unknownMoney = true; else state.money += value;
        refundedTasks.set(key, state);
        if (selected) consumption({ ...event, owner, operator }, -linked, { refund: true, refundMoney: value == null ? null : -value });
      }
      if (selected) unmatchedRefund(event, transaction.amount - linked);
    } else if (transaction.kind === 'expire' && transaction.amount < 0 && selected) {
      // Paid expiry is a management loss; free or unclassified expiry remains
      // in the complete ledger. Source is projected from official raw facts.
      if (!['subscription', 'purchase'].includes(transaction.expiryCreditKind)) continue;
      const amount = -transaction.amount;
      const owner = event.account?.scope === 'team_total' && !transaction.chargedPlatformUserId ? null : event.owner;
      const row = ensureRow(owner);
      const selected = owner ? matchesDepartment(owner) : matchesDepartment(event.account?.scope === 'team_total' ? { departmentId: event.account.ownerDepartmentId ?? null } : null);
      const money = referenceValue(event.account, amount, referenceRates, transaction.occurredAt);
      if (selected) {
        summary.expiry.total += amount; summary.expiry.paid += amount; pushIds(summary, 'expiry', event.ids);
        addMoney(summary, 'expiry', money, amount);
        const target = row ?? unassigned;
        if (row) { row._selected = true; row._evidence = true; }
        target.expiry.total += amount; target.expiry.paid += amount; pushIds(target, 'expiry', event.ids);
        addMoney(target, 'expiry', money, amount);
        // 同一笔到期同时记入表内的「未归属」行，保证合计与摘要卡一致。
        if (!row) {
          unassignedRow._evidence = true;
          unassignedRow.expiry.total += amount; unassignedRow.expiry.paid += amount;
          pushIds(unassignedRow, 'expiry', event.ids);
          addMoney(unassignedRow, 'expiry', money, amount);
        }
      }
    }
  }
  summary.confirmedOperatorRate = summary.grossConsumption > 0 ? confirmedGross / summary.grossConsumption : null;
  summary.moneyEstimated = true;
  const completeMoney = (target, fields) => {
    target.money ??= {};
    target.moneyUnpricedByField ??= {};
    for (const [moneyField, credits] of Object.entries(fields)) {
      if (credits === 0 && !target.moneyUnpricedByField[moneyField] && target.money[moneyField] == null) target.money[moneyField] = 0;
    }
  };
  completeMoney(summary, { availableBalance: summary.availableBalance, netConsumption: summary.netConsumption,
    grossConsumption: summary.grossConsumption, linkedRefunds: summary.linkedRefunds, borrowedConsumption: summary.borrowedConsumption, expiry: summary.expiry.total });
  const finishIds = object => Object.fromEntries(Object.entries(object).map(([key, values]) => [key, [...values]]));
  // 「未归属」行只在确实存在未归属数据时出现，避免长期显示一个空行。
  const resultRows = [...rows.values()].filter(row => row._selected && (!row.unassigned || row.ownedConsumption !== null || row.expiry.total > 0 || row.unmatchedRefunds !== 0)).map(row => {
    if (!row.accounts.length && !row.unassigned) row.balancePartial = true;
    row.moneyEstimated = true;
    completeMoney(row, { balance: row.balance, consumption: row.ownedConsumption, grossConsumption: row.grossConsumption,
      linkedRefunds: row.linkedRefunds, operatorConsumption: row.operatorConsumption, grossOperatorConsumption: row.grossOperatorConsumption,
      operatorRefunds: row.operatorRefunds, borrowedConsumption: row.borrowedConsumption, lentConsumption: row.lentConsumption, expiry: row.expiry.total });
    row.daily = [...row._daily.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const [field, source] of [['borrowedFrom', '_borrowed'], ['lentTo', '_lent']]) row[field] = [...row[source].values()].map(relation => ({ ...relation, transactionIds: [...relation.transactionIds] })).sort((a, b) => b.amount - a.amount || a.employeeId.localeCompare(b.employeeId));
    row.transactionIds = finishIds(row.transactionIds);
    if (!row._evidence) summary.pendingEmployees++;
    delete row._daily; delete row._borrowed; delete row._lent; delete row._evidence; delete row._selected;
    return row;
  }).sort((a, b) => (b.ownedConsumption ?? -Infinity) - (a.ownedConsumption ?? -Infinity) || a.name.localeCompare(b.name, 'zh-CN') || a.employeeId.localeCompare(b.employeeId));
  return { range, rows: resultRows, summary: { ...summary, transactionIds: finishIds(summary.transactionIds) }, unassigned: { ...unassigned, transactionIds: finishIds(unassigned.transactionIds) } };
}
