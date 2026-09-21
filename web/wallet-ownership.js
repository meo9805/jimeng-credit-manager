// Effective ownership may be inherited. Only explicit overrides belong in the
// edit form, otherwise saving an untouched form would freeze the inherited owner.
export function walletOwnershipOverrides(account) {
  return {
    ownerEmployeeId: account.ownerEmployeeOverrideId || '',
    ownerDepartmentId: account.ownerDepartmentOverrideId || '',
  };
}

export function walletOwnerDefaultLabel(scope) {
  return scope === 'personal' ? '跟随账号归属' : '跟随团队创建者';
}
