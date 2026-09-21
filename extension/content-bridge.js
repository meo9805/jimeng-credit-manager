// Runs in the isolated extension world; only forward known signals and task identifiers.
(() => {
  if (location.origin !== 'https://jimeng.jianying.com' || globalThis.__jmcBridge029) return;
  globalThis.__jmcBridge029 = true;
  let lastChange = 0, flushing = false, overflowReported = false;
  const pending = new Map();
  const send = type => {
    try { Promise.resolve(chrome.runtime.sendMessage({ type })).catch(() => {}); }
    catch { /* A temporary worker failure must not stop future heartbeats. */ }
  };
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      for (const [key, operationEvidence] of pending) {
        const receipt = await chrome.runtime.sendMessage({ type: 'operation-evidence', operationEvidence });
        // The worker acknowledges only after durable extension storage succeeds.
        if (receipt?.ok !== true) break;
        pending.delete(key);
        overflowReported = false;
      }
    } catch { /* Keep unacknowledged evidence for the next heartbeat. */ }
    finally { flushing = false; }
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'jimeng-credit-manager') return;
    if (event.data.type === 'operation-evidence') {
      const item = event.data.operationEvidence;
      const identifier = value => typeof value === 'string' && /^[\w.@:-]{1,160}$/.test(value);
      if (!item || !identifier(item.submitId) || !identifier(item.userId) ||
        !['personal', 'team'].includes(item.spaceType) || !identifier(item.spaceId) ||
        (item.spaceType === 'personal' && item.spaceId !== 'personal') ||
        typeof item.occurredAt !== 'string' || item.occurredAt.length > 32 ||
        !/^\d{4}-\d{2}-\d{2}T/.test(item.occurredAt) || !Number.isFinite(Date.parse(item.occurredAt))) return;
      const key = [item.submitId, item.userId, item.spaceType, item.spaceId].join('|');
      if (!pending.has(key) && pending.size >= 500) {
        if (!overflowReported) { overflowReported = true; send('operation-bridge-full'); }
        return;
      }
      if (!pending.has(key)) pending.set(key, { submitId: item.submitId, userId: item.userId, spaceType: item.spaceType,
        spaceId: item.spaceId, occurredAt: new Date(item.occurredAt).toISOString() });
      void flush();
      return;
    }
    if (event.data.type !== 'credit-change') return;
    if (Date.now() - lastChange < 1000) return;
    lastChange = Date.now(); send('credit-change');
  });
  setInterval(() => { void flush(); send('collector-heartbeat'); }, 15000);
  send('watch-ready');
})();
