import { useMemo, useState } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useIdentities } from './IdentityContext.jsx';
import { employeeUsage } from './employee-usage.js';
import { ManagerSelect } from './ManagerSelect.jsx';
import './employee-usage.css';

const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export default function EmployeeUsagePanel({ accounts = [], transactions = [], onLedger }) {
  const { directory, employees, departments } = useIdentities();
  const [period, setPeriod] = useState('month');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const usage = useMemo(() => employeeUsage({ accounts, transactions, directory, employees, departments, period }), [accounts, transactions, directory, employees, departments, period, day]);
  const openLedger = focus => onLedger?.({ ...focus, kind: 'consume', period });
  return <section className="panel employee-usage-panel">
    <div className="panel-title">
      <div className="employee-usage-heading"><h2>员工用量</h2><span className="subtle">{usage.rangeLabel}</span></div>
      <ManagerSelect label="员工用量时间范围" value={period} onChange={setPeriod}><option value="month">本月</option><option value="all">全部已采集</option></ManagerSelect>
    </div>
    {usage.rows.length ? <div className="employee-usage-grid">{usage.rows.map(row => <article className="employee-usage-card" key={row.employeeId}>
      <button type="button" className="employee-usage-card-target" onClick={() => openLedger(row.removed ? { operatorEmployeeId: row.employeeId } : { employeeId: row.employeeId })} aria-label={`查看${row.name}${row.removed ? '本人操作' : '名下账号'}消耗流水`} />
      <div className="employee-usage-card-content">
        <div className="employee-usage-card-heading"><strong>{row.name}</strong><span>{row.department || (row.removed ? '历史部门未获取' : '未设置部门')}</span>{row.removed ? <small className="employee-usage-removed">已移除</small> : null}<ChevronRight size={16} aria-hidden="true" /></div>
        <div className="employee-usage-metrics">
          <div className="employee-usage-metric"><span>名下账号消耗</span><div>{row.ownedConsumption === null ? <strong className="employee-usage-unknown">—</strong> : <><strong>{number(row.ownedConsumption)}</strong><small>积分</small></>}</div></div>
          <button type="button" className="employee-usage-metric employee-usage-operator" onClick={() => openLedger({ operatorEmployeeId: row.employeeId })} aria-label={`查看${row.name}已确认本人操作消耗流水`}><span>本人操作消耗<small>已确认</small></span><div>{row.operatorConsumption === null ? <strong className="employee-usage-unknown" title="暂无已确认的本人操作记录">—</strong> : <><strong>{number(row.operatorConsumption)}</strong><small>积分</small></>}<ArrowRight size={13} aria-hidden="true" /></div></button>
        </div>
      </div>
    </article>)}</div> : <div className="empty-state compact"><h3>暂无员工</h3></div>}
    {(usage.unassignedConsumption > 0 || usage.unconfirmedOperatorConsumption > 0) ? <div className="table-footer employee-usage-footer">
      {usage.unassignedConsumption > 0 ? <button type="button" onClick={() => openLedger({ ownerStatus: 'unassigned' })}>未归属账号消耗 <strong>{number(usage.unassignedConsumption)}</strong> 积分 <ArrowRight size={13} /></button> : null}
      {usage.unconfirmedOperatorConsumption > 0 ? <button type="button" onClick={() => openLedger({ operatorStatus: 'unconfirmed' })}>无操作凭证 <strong>{number(usage.unconfirmedOperatorConsumption)}</strong> 积分 <ArrowRight size={13} /></button> : null}
    </div> : null}
  </section>;
}
