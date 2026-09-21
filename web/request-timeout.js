/** Bound the complete request, including response decoding, and preserve caller cancellation. */
export async function withRequestTimeout(operation, { signal, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  let timer;
  let cancel;
  const interrupted = new Promise((_, reject) => {
    cancel = () => {
      const error = new DOMException('请求已取消', 'AbortError');
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      const error = new Error('管理服务响应超时，请检查连接后重试。');
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
