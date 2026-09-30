import { Fragment, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Search, X } from 'lucide-react';
import { ManagerSelect } from './ManagerSelect.jsx';
import { useIdentities } from './IdentityContext.jsx';
import { accountPoolRows } from './account-pool.js';
import './account-pool.css';

const fmt=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'—';
const date=value=>value?new Date(value).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
export default function AccountPool({accounts,teams,usage=[],initialFocus='all',onAccount,onTeam,onLedger,onSetup,now=Date.now()}) {
  const {identities,departments,employees,onEdit}=useIdentities();
  const [search,setSearch]=useState(initialFocus?.platformUserId||''),[department,setDepartment]=useState(initialFocus?.departmentId||'all');
  const [employee,setEmployee]=useState(initialFocus?.employeeId||'all'),[user,setUser]=useState('all');
  const [scope,setScope]=useState(initialFocus?.scope||'all'),[status,setStatus]=useState(typeof initialFocus==='string'?initialFocus:initialFocus?.status||'all');
  const [expanded,setExpanded]=useState(initialFocus?.platformUserId||null),[filters,setFilters]=useState(false);
  const rows=useMemo(()=>accountPoolRows(identities,accounts,teams,usage,now),[identities,accounts,teams,usage,now]);
  const term=search.trim().toLowerCase();
  const visible=rows.filter(row=>(department==='all'||row.departmentId===department)&&(employee==='all'||row.employeeId===employee)
    &&(user==='all'||row.users.some(item=>item.employeeId===user))&&(scope==='all'||(scope==='personal'?row.group.personal:row.links.length))
    &&(status==='all'||(status==='expiring'?row.upcoming.length:!row.employeeId))
    &&[row.realName,row.nickname,row.platformUserId,row.department,row.boundPhone,...row.users.map(item=>item.employeeName)].filter(Boolean).join(' ').toLowerCase().includes(term));
  const filterCount=[employee,user,scope,status].filter(value=>value!=='all').length;
  const reset=()=>{setSearch('');setDepartment('all');setEmployee('all');setUser('all');setScope('all');setStatus('all');};
  const toggle=uid=>setExpanded(current=>current===uid?null:uid);
  return <section className="panel account-pool">
    <div className="pool-toolbar"><div className="search-input"><Search size={16}/><input aria-label="搜索账号池" placeholder="搜索员工、昵称或账号 ID" value={search} onChange={event=>setSearch(event.target.value)}/>{search?<button type="button" aria-label="清空搜索" onClick={()=>setSearch('')}><X size={14}/></button>:null}</div>
      <ManagerSelect label="部门" value={department} onChange={setDepartment} searchable><option value="all">全部部门</option>{departments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</ManagerSelect>
      <button type="button" className="pool-filter-button" aria-expanded={filters} aria-controls="pool-filters" onClick={()=>setFilters(!filters)}>筛选{filterCount?` · ${filterCount}`:''}<ChevronDown size={14}/></button>
      {term||department!=='all'||filterCount?<button className="text-button" onClick={reset}>清除</button>:null}<span className="pool-count">{visible.length} 个账号</span>
    </div>
    {filters?<div className="pool-filters" id="pool-filters">
      <label>主力使用人<ManagerSelect label="主力使用人" value={employee} onChange={setEmployee} searchable><option value="all">全部员工</option>{employees.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</ManagerSelect></label>
      <label>使用过的员工<ManagerSelect label="使用过的员工" value={user} onChange={setUser} searchable><option value="all">全部员工</option>{employees.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</ManagerSelect></label>
      <label>额度类型<ManagerSelect label="额度类型" value={scope} onChange={setScope}><option value="all">全部额度</option><option value="personal">个人钱包</option><option value="team_member">团队配额</option></ManagerSelect></label>
      <label>关注事项<ManagerSelect label="关注事项" value={status} onChange={setStatus}><option value="all">全部账号</option><option value="expiring">7 天内到期</option><option value="owner">未绑定账号</option></ManagerSelect></label>
    </div>:null}
    {!visible.length?<div className="empty-state"><h3>{identities.length?'没有符合条件的账号':'暂无账号'}</h3><button className="text-button" onClick={identities.length?reset:onSetup}>{identities.length?'清除筛选':'前往员工接入'}</button></div>:<div className="table-scroll"><table className="data-table pool-table"><thead><tr><th>员工 / 账号</th><th className="align-right">个人余额 / 分</th><th className="align-right">团队配额 / 分</th><th>7 天内到期</th><th>使用过的员工</th><th className="align-right">管理</th></tr></thead><tbody>
      {visible.map(row=><Fragment key={row.platformUserId}><tr className={expanded===row.platformUserId?'pool-selected':''}>
        <td><button className="pool-name" onClick={()=>toggle(row.platformUserId)} aria-expanded={expanded===row.platformUserId} aria-controls={`pool-${row.platformUserId}`}><ChevronDown size={15}/><span><strong>{row.realName||row.nickname||`ID ${row.platformUserId}`}</strong><small>{[row.realName?row.nickname:null,row.department].filter(Boolean).join(' · ')|| (row.nickname?`ID ${row.platformUserId}`:'')}</small></span></button></td>
        <td className="align-right"><button className="pool-number" disabled={!row.group.personal} onClick={()=>onAccount(row.group.personal)}>{fmt(row.personalBalance)}</button>{row.group.personal?.membershipPlan?<small className="cell-sub">{row.group.personal.membershipPlan}</small>:null}</td>
        <td className="align-right"><button className="pool-number" disabled={!row.links.length} onClick={()=>toggle(row.platformUserId)}>{fmt(row.teamBalance)}</button>{row.links.length?<small className="cell-sub">{row.links.length===1?row.links[0].team?.name||'团队':`${row.links.length} 个团队`}</small>:null}</td>
        <td>{row.upcoming.length?<button className="pool-due" onClick={()=>toggle(row.platformUserId)}><strong>{fmt(row.upcoming.reduce((sum,batch)=>sum+batch.amount,0))} 分</strong><small>{date(row.upcoming[0].expiresAt)} 起</small></button>:'—'}</td>
        <td><button className="pool-users" disabled={!row.users.length} onClick={()=>toggle(row.platformUserId)}>{row.users.map(item=>item.employeeName||'其他员工').slice(0,2).join('、')||'—'}{row.users.length>2?` 等 ${row.users.length} 人`:''}</button></td>
        <td><div className="row-actions"><button onClick={()=>onEdit(row)}>{row.employeeId?'修改绑定':'绑定员工'}</button><button onClick={()=>onLedger(row.platformUserId)}>流水</button></div></td>
      </tr>{expanded===row.platformUserId?<tr className="pool-expanded"><td colSpan={6}><div id={`pool-${row.platformUserId}`} className="pool-detail">
        <div className="pool-detail-meta"><span>账号 ID {row.platformUserId}</span>{row.boundPhone?<span>{row.boundPhone}</span>:null}<button className="text-button" onClick={()=>toggle(row.platformUserId)}>收起<X size={13}/></button></div>
        <div className="pool-detail-columns"><section><h3>积分与到期</h3>{row.batches.length?row.batches.map((batch,index)=><div className="pool-batch" key={`${batch.wallet.id}-${batch.key}-${index}`}><span>{batch.scope==='personal'?'个人':batch.wallet.spaceName||'团队'} · {batch.label}</span><strong>{fmt(batch.amount)} 分</strong><span>{batch.expiresAt?`${batch.estimated?'预计 ':''}${date(batch.expiresAt)}${Date.parse(batch.expiresAt)<=now?' 已到期':' 到期'}`:'—'}</span></div>):<p className="pool-muted">—</p>}
          {row.links.map(link=><button key={link.spaceId} className="pool-team-link" disabled={!link.team} onClick={()=>onTeam(link.team)}><span>{link.team?.name||'团队'} · 成员配额 {fmt(link.balance)} 分</span><ArrowRight size={14}/></button>)}
        </section><section><h3>使用记录</h3>{row.users.length?row.users.map(item=><div className="pool-login" key={item.employeeId||item.installationId}><strong>{item.employeeName||'其他员工'}</strong><span>{item.department}</span><time>{date(item.lastSeenAt)}</time></div>):<p className="pool-muted">暂无登录记录</p>}</section></div>
      </div></td></tr>:null}</Fragment>)}
    </tbody></table></div>}
  </section>;
}
