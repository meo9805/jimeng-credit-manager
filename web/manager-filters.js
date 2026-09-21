import { transactionActor } from './transaction-actor.js';

export function matchesActualOperator(transaction, operator = 'all') {
  if (operator === 'all') return true;
  const status = transactionActor(transaction).status;
  const employeeId = status !== 'platform' && transaction.attribution === 'matched' ? transaction.operatorEmployeeId : null;
  if (operator === '__platform') return status === 'platform';
  if (operator === '__unconfirmed') return status !== 'platform' && !employeeId;
  if (operator === '__matched') return Boolean(employeeId);
  return Boolean(employeeId) && operator === `employee:${employeeId}`;
}

// A removed employee's confirmed operation remains searchable by its snapshot.
export function actualOperatorOptions(employees, transactions) {
  const options = new Map(employees.map(employee => [employee.id, { id: employee.id, name: employee.name, department: employee.department, removed: false }]));
  for (const transaction of transactions) {
    if (transaction.attribution !== 'matched' || !transaction.operatorEmployeeId) continue;
    const id = transaction.operatorEmployeeId, existing = options.get(id);
    if (existing && !existing.removed) continue;
    const occurredAt = Date.parse(transaction.occurredAt) || 0;
    if (!existing || occurredAt > existing.occurredAt) options.set(id, { id, name: transaction.operatorName || '已移除员工', department: transaction.operatorDepartment, removed: true, occurredAt });
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
}

export function matchesIdentityAssignment(identity, employee = 'all', department = 'all') {
  return (employee === 'all' || (employee === '__unassigned' ? !identity?.employeeId : identity?.employeeId === employee))
    && (department === 'all' || (department === '__unassigned' ? !identity?.departmentId : identity?.departmentId === department));
}
