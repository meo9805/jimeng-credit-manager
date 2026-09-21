const dailyGrantTitles = new Set(['每日免费积分', '每日赠送']);

export function transactionActor(transaction) {
  if (transaction.kind === 'expire') return { status: 'platform', label: '平台自动到期', department: null };
  const title = typeof transaction.description === 'string' ? transaction.description.normalize('NFKC').trim() : '';
  if (transaction.kind === 'grant' && dailyGrantTitles.has(title)) return { status: 'platform', label: '平台自动赠送', department: null };
  if (transaction.attribution === 'matched' && transaction.operatorName) return { status: 'matched', label: `实际操作者：${transaction.operatorName}`, department: transaction.operatorDepartment || '部门未确认' };
  return { status: 'unconfirmed', label: '实际操作者待确认', department: null };
}
