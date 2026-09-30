import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import Toast from '@douyinfe/semi-ui/lib/es/toast';
import { RefreshCw } from 'lucide-react';
import { EmployeeSelect } from './DirectoryFields.jsx';
import './enrollment-requests.css';

function localTime(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function EnrollmentRequestsPanel({ employees, request, onEmployees, onApproved, enrollmentUrls = {} }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [employeeChoices, setEmployeeChoices] = useState({});
  const [manualLink, setManualLink] = useState('');
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const result = await request('/api/admin/enrollment-requests');
      setRequests(result.requests || []);
      setError('');
    } catch (cause) { setError(cause.message); }
    finally { if (!quiet) setLoading(false); }
  }, [request]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh({ quiet: true });
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const pending = useMemo(() => requests.filter(entry => entry.status === 'pending'), [requests]);
  const handled = useMemo(() => requests.filter(entry => entry.status !== 'pending'), [requests]);

  async function copyLink(url, label) {
    setManualLink('');
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); copied = true; }
    } catch { /* HTTP management pages can deny clipboard access. */ }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = url; field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field); field.focus(); field.select();
      try { copied = document.execCommand('copy'); } catch { /* show selectable link below */ }
      field.remove();
    }
    if (copied) Toast.success(`${label}链接已复制`);
    else { setManualLink(url); Toast.error('复制失败，请手动复制下方链接'); }
  }

  async function decide(entry, action) {
    const employeeId = employeeChoices[entry.id];
    if (action === 'approve' && !employeeId) return;
    setBusyId(entry.id);
    try {
      await request(`/api/admin/enrollment-requests/${encodeURIComponent(entry.id)}/${action}`, {
        method: 'POST', body: JSON.stringify(action === 'approve' ? { employeeId } : {}),
      });
      Toast.success(action === 'approve' ? '已批准领取' : '已驳回申请');
      await refresh({ quiet: true });
      if (action === 'approve') onApproved?.();
    } catch (cause) { Toast.error(cause.message); }
    finally { setBusyId(''); }
  }

  return <section className="panel enrollment-requests-panel" aria-label="采集端领取申请">
    <div className="panel-title">
      <div className="inline-title"><h2>领取申请</h2>{pending.length ? <span className="count-chip">{pending.length}</span> : null}</div>
      <div className="enrollment-heading-actions">{enrollmentUrls.internal ? <Button title={enrollmentUrls.internal} onClick={() => copyLink(enrollmentUrls.internal, '内网')}>复制内网链接</Button> : null}{enrollmentUrls.external ? <Button title={enrollmentUrls.external} onClick={() => copyLink(enrollmentUrls.external, '外网')}>复制外网链接</Button> : null}<Button theme="borderless" icon={<RefreshCw size={15} />} onClick={() => refresh()} loading={loading} aria-label="刷新领取申请">刷新</Button></div>
    </div>
    {manualLink ? <p className="enrollment-requests-message">手动复制：<code>{manualLink}</code></p> : null}
    {enrollmentUrls.internal && enrollmentUrls.external ? <p className="enrollment-requests-message">按员工所在网络发送对应链接；申请后请使用同一个地址领取。</p> : null}
    {pending.length ? <p className="enrollment-requests-message">申请人自行填写姓名和部门。请通过公司已有渠道核实本人，再选择员工批准。</p> : null}
    {error ? <div className="enrollment-requests-message" role="alert">{error}</div> : null}
    {!loading && !pending.length ? <p className="enrollment-requests-message">目前没有新申请。</p> : null}
    {pending.map(entry => {
      const employeeId = employeeChoices[entry.id] || '';
      return <div className="enrollment-request" key={entry.id}>
        <div className="enrollment-applicant"><strong>{entry.name}</strong><span>{entry.department}</span><small>{localTime(entry.createdAt)} 申请</small></div>
        <div className="enrollment-assignment">
          <EmployeeSelect label="核实后绑定员工" employees={employees} value={employeeId} onChange={value => setEmployeeChoices(current => ({ ...current, [entry.id]: value }))} emptyLabel="选择目录中的员工" />
        </div>
        <div className="enrollment-actions"><Button theme="solid" type="primary" disabled={!employeeId || Boolean(busyId)} loading={busyId === entry.id} onClick={() => decide(entry, 'approve')}>批准领取</Button><Button disabled={Boolean(busyId)} onClick={() => decide(entry, 'reject')}>驳回</Button></div>
      </div>;
    })}
    {pending.length && !employees.length ? <div className="enrollment-requests-message"><button className="text-button" onClick={onEmployees}>先在员工与部门建立员工档案</button></div> : null}
    {handled.length ? <details className="enrollment-recent"><summary>近期记录 {handled.length}</summary><div>{handled.slice(0, 10).map(entry => <p key={entry.id}><strong>{entry.employeeName || entry.name}</strong><span>{{ approved: '已批准', claimed: '已领取', rejected: '已驳回', expired: '已失效' }[entry.status] || entry.status}</span><small>{localTime(entry.decidedAt || entry.createdAt)}</small></p>)}</div></details> : null}
  </section>;
}
