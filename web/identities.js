export function identityDirectory(identities = []) {
  return new Map(identities.filter((identity) => identity?.platformUserId).map((identity) => [String(identity.platformUserId), identity]));
}

const ownerGroupKey = (identity) => identity?.employeeId ? `employee:${identity.employeeId}` : identity?.realName ? JSON.stringify([identity.realName, identity.department || null]) : null;

/** A recorded unassigned owner must never inherit a later account assignment. */
export function transactionOwner(transaction, directory) {
  const id = transaction.chargedPlatformUserId ? String(transaction.chargedPlatformUserId) : null;
  const current = id ? directory.get(id) : null;
  if (transaction.ownershipSnapshot && typeof transaction.ownershipSnapshot === 'object') {
    const snapshot = transaction.ownershipSnapshot;
    return { ...current, employeeId:snapshot.employeeId ?? null, realName:snapshot.name ?? null, departmentId:snapshot.departmentId ?? null, department:snapshot.department ?? null, ownershipBasis:snapshot.basis };
  }
  return current;
}

/** Stable employee IDs keep filters intact when a name or department changes. */
export function identityOwnerGroups(identities = []) {
  const groups = new Map();
  for (const identity of identityDirectory(identities).values()) {
    const key = ownerGroupKey(identity);
    if (!key) continue;
    const group = groups.get(key) || { key, realName: identity.realName, department: identity.department || null, platformUserIds: [] };
    group.platformUserIds.push(String(identity.platformUserId));
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.realName.localeCompare(b.realName, 'zh-CN') || (a.department || '').localeCompare(b.department || '', 'zh-CN'));
}

/** An account assignment never establishes who performed a transaction. */
export function matchesAccountOwner(transaction, directory, person = 'all', department = 'all') {
  const identity = transactionOwner(transaction, directory);
  return (person === 'all' || (person === '__unassigned' ? !identity?.realName : ownerGroupKey(identity) === person))
    && (department === 'all' || (department === '__unassigned' ? !identity?.department : (identity?.departmentId || identity?.department) === department));
}
