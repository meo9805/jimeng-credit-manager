import { useEffect, useRef, useState } from 'react';
import { Activity, CheckCircle2, ChevronDown, RefreshCw } from 'lucide-react';

export const terminalSyncStatus = (status) => ['completed', 'partial', 'failed', 'timed_out'].includes(status);
const jobLabels = { waiting: '等待采集端响应', running: '正在同步即梦', completed: '采集任务已完成', partial: '采集任务部分完成', failed: '采集任务失败', timed_out: '等待采集超时' };
const targetLabels = { waiting: '等待响应', running: '正在采集', completed: '采集完成', partial: '部分完成', failed: '采集失败', no_open_tabs: '未打开即梦页面', timed_out: '等待超时' };

export function useSyncRequest({ api, onRefresh, enabled }) {
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const startController = useRef(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const running = Boolean(job && !terminalSyncStatus(job.status));
  useEffect(() => () => startController.current?.abort(), []);
  async function start() {
    if (!enabled || starting || running) return;
    setStarting(true); setJob(null); setError(''); setPaused(false);
    const controller = new AbortController();
    startController.current = controller;
    try {
      const result = await api('/api/sync-requests', { method: 'POST', body: JSON.stringify({}), signal: controller.signal });
      if (controller.signal.aborted) return;
      setJob(result);
      if (['completed', 'partial'].includes(result.status)) await refreshRef.current({ quiet: true });
    } catch (cause) {
      if (cause.name !== 'AbortError') setError(cause.name === 'TimeoutError' ? '请求超时，任务状态待确认，请重试。' : cause.message || '无法发起同步，请稍后重试。');
    }
    finally { if (!controller.signal.aborted) setStarting(false); }
  }
  useEffect(() => {
    if (!enabled || !job?.id || !running) return;
    const deadline = Date.parse(job.expiresAt);
    if (!Number.isFinite(deadline)) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPaused(true);
      setError('等待超时，正在确认同步结果。');
      try {
        const result = await api(`/api/sync-requests/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (cancelled) return;
        setJob(result);
        if (terminalSyncStatus(result.status)) {
          setPaused(false); setError('');
          if (['completed', 'partial'].includes(result.status)) await refreshRef.current({ quiet: true });
        } else setError('同步结果待确认，请重试。');
      } catch (cause) {
        if (!cancelled && cause.name !== 'AbortError') setError('连接中断，同步结果待确认。');
      }
    }, Math.max(0, deadline - Date.now()));
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [enabled, job?.id, job?.expiresAt, running, api]);
  useEffect(() => {
    if (!enabled || !job?.id || !running || paused) return;
    let cancelled = false;
    let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const result = await api(`/api/sync-requests/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (cancelled) return;
        setJob(result); setError('');
        if (terminalSyncStatus(result.status)) {
          if (['completed', 'partial'].includes(result.status)) await refreshRef.current({ quiet: true });
          return;
        }
      } catch (cause) {
        if (cancelled || cause.name === 'AbortError') return;
        setError(`同步状态暂时无法读取：${cause.message}`);
        if (Date.parse(job.expiresAt) <= Date.now() || [401, 404].includes(cause.status)) {
          setPaused(true);
          setError('连接中断，同步结果待确认。');
          return;
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [enabled, job?.id, running, paused, api]);
  function retryRead() { setError(''); setPaused(false); }
  return { job, error, start, retryRead, paused, starting, active: starting || (running && !paused) };
}

export function SyncStatus({ job, error, starting, paused, onRetry }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (job && ['partial', 'failed', 'timed_out'].includes(job.status)) setExpanded(true); }, [job?.status]);
  if (!job && !error && !starting) return null;
  const targets = job?.targets || [];
  const completed = targets.filter((target) => target.status === 'completed').length;
  const partial = targets.filter((target) => target.status === 'partial').length;
  const offline = targets.filter((target) => target.status === 'waiting' && !target.online).length;
  const active = starting || (job && !terminalSyncStatus(job.status) && !paused);
  return <section className={`sync-status-panel ${starting ? 'waiting' : job?.status || 'failed'}`} aria-live="polite"><div className="sync-status-heading">{active ? <RefreshCw size={16} className="spin" /> : job?.status === 'completed' ? <CheckCircle2 size={17} /> : <Activity size={17} />}<div><strong>{starting ? '正在请求采集' : paused ? '同步结果待确认' : job ? jobLabels[job.status] || '同步状态待确认' : '同步请求未完成'}</strong>{job ? <p>{completed} 个已完成{partial ? ` · ${partial} 个部分完成` : ''} · 共 {targets.length} 个采集端{offline ? ` · ${offline} 个离线，等待连接` : ''}</p> : null}</div>{job ? <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '查看进度'}<ChevronDown size={14} className={expanded ? 'turned' : ''} /></button> : null}</div>{error ? <p className="sync-request-error" role="alert">{error}{paused && onRetry ? <button className="text-button sync-retry" onClick={onRetry}>重试读取进度</button> : null}</p> : null}{expanded ? <div className="sync-target-list">{targets.map((target) => <div className="sync-target" key={target.installationId}><span><strong>{target.employeeName || '采集端'}</strong><small>{target.department || '部门未填写'}</small></span><span className={`sync-target-state ${target.status}`}>{target.status === 'waiting' && !target.online ? '离线，等待连接' : targetLabels[target.status] || '状态待确认'}{target.message ? <small>{target.message}</small> : null}</span></div>)}</div> : null}</section>;
}
