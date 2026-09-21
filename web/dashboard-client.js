import { withRequestTimeout } from './request-timeout.js';

export const DASHBOARD_POLL_MS = 30_000;

// A caller commits the returned validator together with its data. Keeping this
// stateless prevents an aborted/older response from changing the active ETag.
export function fetchDashboard({ etag = null, signal, fetchImpl = fetch } = {}) {
  return withRequestTimeout(async requestSignal => {
    const response = await fetchImpl('/api/dashboard', {
      credentials:'same-origin',signal:requestSignal,cache:'no-store',
      headers:etag ? { 'If-None-Match':etag } : {},
    });
    if (response.status === 304 && etag) return { unchanged:true,etag };
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || (response.status === 401 ? '登录已过期，请重新进入管理台。' : '请求未完成，请稍后重试。'));
      error.status=response.status;throw error;
    }
    return { unchanged:false,etag:response.headers.get('etag'),data };
  }, { signal });
}
