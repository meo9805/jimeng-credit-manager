// Chrome serializes this function into Jimeng's MAIN world; keep helpers local.
// Observe accepted local submissions only. Never inspect prompts or replay stored tasks.
export function installOperationWatcher() {
  if (window.location.origin !== 'https://jimeng.jianying.com') return { installed: false };
  const key = '__jmcOperationWatcher001';
  if (window[key]) { window[key].check(); return { installed: true }; }
  const pending = new Map(), emitted = new Map(), disposables = [];
  const maxPending = 100, maxEmitted = 200, ttl = 30 * 60 * 1000;
  let service = null, credit = null, port = null, fingerprint = null;
  const id = value => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    return typeof value === 'string' && /^[\w.@:-]{1,160}$/.test(value) ? value : null;
  };
  const prune = now => {
    for (const [submitId, entry] of pending) if (now - entry.at > ttl) pending.delete(submitId);
    for (const [submitId, at] of emitted) if (now - at > ttl) emitted.delete(submitId);
    while (pending.size > maxPending) pending.delete(pending.keys().next().value);
    while (emitted.size > maxEmitted) emitted.delete(emitted.keys().next().value);
  };
  const context = () => {
    const feature = window.__debugger?.DreaminaCommercialFeatureService;
    if (window.__debugger?.ContentGeneratorTaskFeatureService !== service ||
      (feature?.commercialCreditService || feature?._commercialCreditService) !== credit || feature?._commerceAccountPort !== port) return null;
    const user = port?.getSnapshot?.(), snapshot = credit?.getCurrentAccountSnapshot?.();
    const account = snapshot?.account || credit?.currentAccount || credit?._currentAccount;
    const userId = id(user?.userId), spaceType = account?.accountType;
    const spaceId = spaceType === 'personal' ? 'personal' : id(account?.teamId);
    if (!user?.hasLogin || !userId || !credit?.isLocalCreditReady ||
      !['personal', 'team'].includes(spaceType) || !spaceId || !id(account?.accountKey)) return null;
    // Version prevents a switch away and back from claiming an in-flight submission.
    const version = typeof snapshot?.version === 'string' || Number.isFinite(snapshot?.version) ? snapshot.version : null;
    return { userId, spaceType, spaceId, fingerprint: JSON.stringify([userId, spaceType, spaceId, account.accountKey, version]) };
  };
  const currentContext = () => {
    const current = context(), next = current?.fingerprint || null;
    if (next !== fingerprint) { pending.clear(); fingerprint = next; }
    return current;
  };
  const created = model => {
    try {
      const now = Date.now(); prune(now);
      const current = currentContext(), submitId = id(model?.idModel?.submitId);
      if (!current || !submitId || emitted.has(submitId) || pending.has(submitId)) return;
      pending.set(submitId, { ...current, at: now }); prune(now);
    } catch { /* An unsupported or switching page supplies no operator evidence. */ }
  };
  const submitted = model => {
    try {
      const now = Date.now(); prune(now);
      const current = currentContext(), submitId = id(model?.idModel?.submitId), start = pending.get(submitId);
      if (!current || !start || start.fingerprint !== current.fingerprint || emitted.has(submitId)) return;
      pending.delete(submitId); emitted.set(submitId, now); prune(now);
      window.postMessage({ source: 'jimeng-credit-manager', type: 'operation-evidence', operationEvidence: {
        submitId, userId: start.userId, spaceType: start.spaceType, spaceId: start.spaceId,
        occurredAt: new Date(start.at).toISOString(),
      } }, window.location.origin);
    } catch { /* Observing a task must never interrupt Jimeng's submit callback. */ }
  };
  const cleanup = () => {
    pending.clear(); fingerprint = null;
    for (const disposable of disposables.splice(0)) {
      try { if (typeof disposable === 'function') disposable(); else disposable?.dispose?.(); } catch { /* detached service */ }
    }
  };
  const check = () => {
    try {
      const feature = window.__debugger?.DreaminaCommercialFeatureService;
      const nextService = window.__debugger?.ContentGeneratorTaskFeatureService;
      const nextCredit = feature?.commercialCreditService || feature?._commercialCreditService;
      const nextPort = feature?._commerceAccountPort;
      if (nextService !== service || nextCredit !== credit || nextPort !== port) {
        cleanup(); service = nextService; credit = nextCredit; port = nextPort;
        if (typeof service?.onAigcDataTaskCreated === 'function' && typeof service?.onAigcDataTaskSubmitSuccess === 'function') {
          disposables.push(service.onAigcDataTaskCreated(created));
          disposables.push(service.onAigcDataTaskSubmitSuccess(submitted));
        }
        if (typeof port?.subscribe === 'function') disposables.push(port.subscribe(() => {
          try { currentContext(); } catch { pending.clear(); fingerprint = null; }
        }));
      }
      currentContext(); prune(Date.now());
    } catch { cleanup(); service = null; credit = null; port = null; }
  };
  window[key] = { check };
  check();
  const interval = window.setInterval(check, 1000);
  window.addEventListener('pagehide', event => {
    pending.clear(); fingerprint = null;
    if (event.persisted) return;
    cleanup(); window.clearInterval(interval); delete window[key];
  });
  return { installed: true };
}
