import { useMemo, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import { buildLeaderOverview } from './leader-overview.js';
import './data-management.css';

const format = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';

export function DataManagementPanel({ data, onPricing, onNavigate, onSync, syncing, disabled }) {
  const [expanded, setExpanded] = useState(false);
  const overview = useMemo(() => expanded ? buildLeaderOverview({ ...data, period: 'all' }) : null, [data, expanded]);
  const summary = overview?.summary;
  const openLedger = (ids, title) => onNavigate('ledger', { transactionIds: [...new Set(ids || [])], title, period: 'all' });
  return <section className="panel data-management-panel">
    <div className="panel-title"><h2>数据管理</h2><div className="data-management-actions"><Button onClick={onPricing}>折算设置</Button><Button onClick={onSync} disabled={disabled || syncing}>{syncing ? '同步中' : '立即同步'}</Button></div></div>
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>数据核对</summary>
      {summary ? <div className="data-management-content">
        <dl>
          <div><dt>超过 24 小时的余额</dt><dd>{format(summary.staleBalance)} 分</dd><button onClick={() => onNavigate('accounts')}>账号与钱包</button></div>
          <div><dt>未关联员工的账号消耗</dt><dd>{format(summary.unassignedConsumption)} 分</dd><button onClick={() => onNavigate('identities')}>核对归属</button></div>
          <div><dt>无操作凭证的消费</dt><dd>{format(summary.unconfirmedOperatorConsumption)} 分</dd>{summary.transactionIds.unconfirmed.length ? <button onClick={() => openLedger(summary.transactionIds.unconfirmed, '无操作凭证的消费')}>查看流水</button> : null}</div>
          <div><dt>到期积分来源未分类</dt><dd>{format(summary.expiry.unclassified)} 分</dd>{summary.transactionIds.expiry.length ? <button onClick={() => openLedger(summary.transactionIds.expiry, '到期失效流水')}>查看流水</button> : null}</div>
          <div><dt>余额未完整获取</dt><dd>{format(summary.unknownBalanceCount)} 项</dd></div>
          <div><dt>到期时间未获取</dt><dd>{format(summary.unknownExpiryCount)} 项</dd></div>
        </dl>
        <p>总览余额按各钱包最后一次读数汇总，新数据到达后自动替换；本页单独列出超过 24 小时的读数。团队余额不重复累计成员额度。</p>
        <p>人民币按套餐或充值参考价估算，赠送积分按零元计算；历史到期来源不明时按钱包单价估算积分价值。</p>
        <p>本人操作按生成凭证匹配扣费；名下账号消耗按账号归属统计。两者均扣除对应退款，历史无凭证消费不推定操作者。</p>
      </div> : null}
    </details>
  </section>;
}
