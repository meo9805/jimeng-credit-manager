/** Capture the short-lived ticket once, then remove it before any network request. */
export function captureExtensionLogin(location, history) {
  if (!/^\/extension-login\/?$/.test(location.pathname)) return null;
  const fragment = location.hash || '';
  history.replaceState(history.state, '', '/extension-login');
  const values = new URLSearchParams(fragment.replace(/^#/, '')).getAll('ticket');
  return { ticket: values.length === 1 && values[0] ? values[0] : null };
}

/** React remounts reuse one attempt; a consumed ticket is never sent twice. */
export function extensionLoginAttempt(entry, request, history) {
  let promise;
  return () => {
    if (promise) return promise;
    const ticket = entry.ticket;
    entry.ticket = null;
    promise = (async () => {
      if (!ticket) throw new Error('快捷登录链接缺少有效凭证，请重新从管理员插件打开。');
      try {
        await request('/api/admin/consume-ticket', { method: 'POST', credentials: 'include', body: JSON.stringify({ ticket }) });
        const session = await request('/api/session', { credentials: 'include' });
        if (session.authenticated !== true || session.role !== 'admin') throw new Error('session-not-established');
        history.replaceState(history.state, '', '/');
        return session;
      } catch {
        throw new Error('管理员快捷登录未完成，链接可能已过期或已使用。请重新从管理员插件打开，或返回管理员登录。');
      }
    })();
    return promise;
  };
}
