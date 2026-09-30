// Installed only in Jimeng's MAIN world. Signals contain no account data or request payload.
export function installCreditWatcher() {
  if (window.location.origin !== 'https://jimeng.jianying.com') return { installed: false };
  const key = '__jmcCreditWatcher012';
  if (window[key]) { window[key].check(); return { installed: true }; }
  let credit = null, port = null, fingerprint = null, timer = null;
  const disposables = [];
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const cleanup = () => {
    for (const disposable of disposables.splice(0)) {
      try { if (typeof disposable === 'function') disposable(); else disposable?.dispose?.(); } catch { /* detached page */ }
    }
  };
  const changed = () => {
    try {
      const user = port?.getSnapshot?.();
      const snapshot = credit?.getCurrentAccountSnapshot?.();
      const current = snapshot?.account || credit?.currentAccount || credit?._currentAccount;
      const next = JSON.stringify([Boolean(user?.hasLogin), String(user?.userId || ''), current?.accountKey || '',
        current?.accountType || '', String(current?.teamId || ''), snapshot?.version ?? null, Boolean(credit?.isLocalCreditReady),
        finite(credit?.localCredit), finite(credit?.teamTotalCredit)]);
      if (next === fingerprint) return;
      fingerprint = next;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        window.postMessage({ source: 'jimeng-credit-manager', type: 'credit-change' }, window.location.origin);
      }, 1200);
    } catch { /* A page that is still initializing is checked again. */ }
  };
  const check = () => {
    const feature = window.__debugger?.DreaminaCommercialFeatureService;
    const nextCredit = feature?.commercialCreditService || feature?._commercialCreditService;
    const nextPort = feature?._commerceAccountPort;
    if (!nextCredit || !nextPort?.getSnapshot) return;
    if (nextCredit !== credit || nextPort !== port) {
      cleanup(); credit = nextCredit; port = nextPort; fingerprint = null;
      try { if (typeof credit.onLocalCreditChange === 'function') disposables.push(credit.onLocalCreditChange(changed)); } catch { /* scalar fallback below */ }
      try { if (typeof port.subscribe === 'function') disposables.push(port.subscribe(changed)); } catch { /* scalar fallback below */ }
    }
    changed();
  };
  window[key] = { check };
  check();
  // A scalar-only fallback handles late initialization or changed service instances.
  const interval = window.setInterval(check, 1000);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    cleanup(); window.clearInterval(interval);
    if (timer !== null) window.clearTimeout(timer);
    delete window[key];
  }, { once: true });
  return { installed: true };
}
