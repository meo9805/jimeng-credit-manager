const CHINA_OFFSET = 8 * 60 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' });

function monthStart(now) {
  const local = new Date(Number(new Date(now)) + CHINA_OFFSET);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - CHINA_OFFSET;
}

export function matchesUsagePeriod(occurredAt, period = 'month', now = Date.now()) {
  const time = Date.parse(occurredAt), end = Number(new Date(now));
  return Number.isFinite(time) && Number.isFinite(end) && time <= end && (period === 'all' || time >= monthStart(end));
}

// Team members and the team creator can observe the same official event. Keep
// its ledger identity independent of the account view that supplied the row.
function transactionKey(transaction, accounts) {
  const account = accounts.get(transaction.accountId);
  if (transaction.eventId && account) {
    if (['team_total', 'team_member'].includes(account.scope) && account.spaceId) return JSON.stringify(['team', account.spaceId, transaction.eventId]);
    if (account.scope === 'personal' && account.platformUserId) return JSON.stringify(['personal', account.platformUserId, transaction.eventId]);
  }
  return transaction.id ? `id:${transaction.id}` : null;
}

/** Collected consumption only. Account ownership never establishes an operator. */
export function employeeUsage({ accounts = [], transactions = [], directory = new Map(), employees = [], departments = [], period = 'month', now = Date.now() } = {}) {
  const departmentNames = new Map(departments.map(department => [department.id, department.name]));
  const rows = new Map(employees.map(employee => [employee.id, {
    employeeId: employee.id,
    name: employee.name,
    department: departmentNames.get(employee.departmentId) || employee.department || null,
    removed: false,
    ownedConsumption: 0,
    ownedTransactionCount: 0,
    operatorConsumption: null,
    operatorTransactionCount: 0,
  }]));
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const seen = new Set();
  let totalConsumption = 0, unassignedConsumption = 0, unconfirmedOperatorConsumption = 0, transactionCount = 0, earliest = null;
  for (const transaction of transactions) {
    if (transaction.kind !== 'consume' || !Number.isFinite(transaction.amount) || transaction.amount >= 0 || !matchesUsagePeriod(transaction.occurredAt, period, now)) continue;
    const key = transactionKey(transaction, accountMap);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const amount = Math.abs(transaction.amount), time = Date.parse(transaction.occurredAt);
    totalConsumption += amount;
    transactionCount++;
    earliest = earliest === null ? time : Math.min(earliest, time);
    const identity = transaction.chargedPlatformUserId ? directory.get(String(transaction.chargedPlatformUserId)) : null;
    const owner = rows.get(identity?.employeeId);
    if (owner && !owner.removed) { owner.ownedConsumption += amount; owner.ownedTransactionCount++; }
    else unassignedConsumption += amount;
    const operatorId = transaction.attribution === 'matched' && transaction.operatorEmployeeId ? transaction.operatorEmployeeId : null;
    let operator = operatorId ? rows.get(operatorId) : null;
    // Removing an employee from the current directory must not erase the
    // authenticated identity retained with a historical generation submission.
    if (operatorId && !operator) {
      operator = { employeeId: operatorId, name: transaction.operatorName || '已移除员工', department: transaction.operatorDepartment || null, removed: true, snapshotAt: time, ownedConsumption: null, ownedTransactionCount: 0, operatorConsumption: null, operatorTransactionCount: 0 };
      rows.set(operatorId, operator);
    } else if (operator?.removed && time > operator.snapshotAt) {
      operator.name = transaction.operatorName || operator.name;
      operator.department = transaction.operatorDepartment || operator.department;
      operator.snapshotAt = time;
    }
    if (operator) { operator.operatorConsumption = (operator.operatorConsumption ?? 0) + amount; operator.operatorTransactionCount++; }
    else unconfirmedOperatorConsumption += amount;
  }
  const start = period === 'all' ? earliest : monthStart(now);
  return {
    rows: [...rows.values()].sort((a, b) => (b.ownedConsumption ?? 0) - (a.ownedConsumption ?? 0) || (b.operatorConsumption ?? 0) - (a.operatorConsumption ?? 0) || a.name.localeCompare(b.name, 'zh-CN') || a.employeeId.localeCompare(b.employeeId)),
    totalConsumption, unassignedConsumption, unconfirmedOperatorConsumption, transactionCount,
    rangeLabel: start === null ? '暂无已采集消耗' : `${dateFormatter.format(start)} — ${dateFormatter.format(new Date(now))} · 已采集`,
  };
}
