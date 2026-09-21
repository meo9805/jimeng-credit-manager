import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import { Activity, CheckCircle2, Clock3, FileClock, RefreshCw } from 'lucide-react';
import { diagnosticEntries, diagnosticTimestamp } from './diagnostics.js';

const stamp = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '时间未获取';

export function DiagnosticsPanel({ installation, request }) {
  const [entries, setEntries] = useState([]);
  const [lastReceivedAt, setLastReceivedAt] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setLoading(true); setError('');
    try {
      const result = await request(`/api/installations/${encodeURIComponent(installation.id)}/diagnostics`, { method: 'GET', signal: pending.signal });
      if (current !== sequence.current || pending.signal.aborted) return;
      if (!Array.isArray(result.logs)) throw new Error('invalid-log-response');
      setEntries(diagnosticEntries(result.logs));
      setLastReceivedAt(diagnosticTimestamp(result.lastReceivedAt));
      setLoaded(true);
    } catch (cause) {
      if (current === sequence.current && !pending.signal.aborted) setError(cause.status === 401 ? '管理登录已过期，请重新登录。' : '读取排障日志失败，请稍后重试。');
    } finally { if (current === sequence.current && !pending.signal.aborted) setLoading(false); }
  }, [installation.id, request]);
  useEffect(() => { refresh(); return () => controller.current?.abort(); }, [refresh]);
  return <div className="diagnostics-panel"><div className="diagnostics-heading"><div><h2>{installation.employeeName || '采集端'}</h2><p>{installation.department || '部门未填写'}</p></div><Button icon={<RefreshCw size={14} className={loading ? 'spin' : ''} />} onClick={refresh} disabled={loading}>刷新日志</Button></div>{loaded ? <p className="diagnostics-received">{lastReceivedAt ? `最近收到日志 ${stamp(lastReceivedAt)}` : '尚未收到日志'}</p> : null}{error ? <div className="diagnostics-error" role="alert"><Activity size={15} /><span>{error}{loaded && entries.length ? ' 已保留上次读取的日志。' : ''}</span></div> : null}{loading && !loaded ? <div className="diagnostics-loading" role="status"><RefreshCw size={18} className="spin" />正在读取已上报日志…</div> : loaded && !entries.length ? <div className="empty-state"><span className="empty-icon"><FileClock size={25} /></span><h3>尚无排障日志</h3></div> : <ol className="diagnostics-list">{entries.map((entry) => <li key={entry.key} className={entry.severity}><span className="diagnostic-event-icon">{entry.severity === 'success' ? <CheckCircle2 size={16} /> : ['error', 'warning'].includes(entry.severity) ? <Activity size={16} /> : <Clock3 size={16} />}</span><div><div className="diagnostic-event-heading"><strong>{entry.label}</strong><time>{stamp(entry.at)}</time></div>{entry.facts.length ? <p className="diagnostic-facts">{entry.facts.map((fact) => <span key={fact}>{fact}</span>)}</p> : null}</div></li>)}</ol>}</div>;
}
