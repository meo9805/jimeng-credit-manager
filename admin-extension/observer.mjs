const diagnosticCodes = new Set([
  'account_context_changed', 'account_read_recovered', 'credit_api_unavailable',
  'credit_balance_unavailable', 'credit_history_partial', 'page_login_required',
  'page_not_ready', 'team_discovery_partial', 'not_jimeng_page',
  'tab_unavailable', 'injection_failed', 'invalid_result',
]);

export function summarizeRead(raw) {
  const observations = Array.isArray(raw?.observations) ? raw.observations : raw ? [raw] : [];
  const spaces = observations.filter(item => item?.status === 'ok' && item.userId && item.accountType);
  const errors = observations.filter(item => item?.status !== 'ok');
  const codes = [...new Set([
    ...(Array.isArray(raw?.diagnosticCodes) ? raw.diagnosticCodes : []),
    ...observations.flatMap(item => Array.isArray(item?.diagnosticCodes) ? item.diagnosticCodes : []),
  ].filter(code => diagnosticCodes.has(code)))];
  const status = raw?.status === 'login_required' ? 'login_required' :
    spaces.length === 0 ? 'error' : raw?.partial || errors.length ? 'partial' : 'ok';
  return {
    status, spaces, codes,
    spaceCount: spaces.length,
    teamCount: spaces.filter(item => item.accountType === 'team').length,
    recordCount: spaces.reduce((total, item) => total + (Array.isArray(item.records) ? item.records.length : 0), 0),
    errorCount: errors.length,
  };
}

// Only this fixed schema is stored. No account, balance, member or transaction
// fields from the injected page can enter the persistent diagnostic history.
export function diagnosticEvent(summary, elapsedMs, at = new Date()) {
  const status = ['ok', 'partial', 'error', 'login_required'].includes(summary?.status) ? summary.status : 'error';
  const count = value => Number.isInteger(value) && value >= 0 ? Math.min(value, 10000) : 0;
  return {
    at: at.toISOString(), status,
    codes: Array.isArray(summary?.codes) ? [...new Set(summary.codes.filter(code => diagnosticCodes.has(code)))].slice(0, 8) : [],
    spaceCount: count(summary?.spaceCount), teamCount: count(summary?.teamCount),
    recordCount: count(summary?.recordCount), errorCount: count(summary?.errorCount),
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.min(Math.round(elapsedMs), 120000) : 0,
  };
}
