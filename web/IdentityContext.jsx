import { createContext, useContext, useMemo, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import Input from '@douyinfe/semi-ui/lib/es/input';
import { EmployeeSelect } from './DirectoryFields.jsx';
import { ManagerSelect } from './ManagerSelect.jsx';
import { Search, UserRound, PencilLine } from 'lucide-react';
import { identityDirectory } from './identities.js';
import { identityPresentation } from './identity-presentation.js';
import './identity-presentation.css';

const IdentityContext = createContext({ identities: [], departments: [], employees: [], directory: new Map(), onEdit: null, onManage: null });
export function IdentityProvider({ identities, departments, employees, onEdit, onManage, children }) {
  const value = useMemo(() => ({ identities, departments, employees, directory: identityDirectory(identities), onEdit, onManage }), [identities, departments, employees, onEdit, onManage]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
export const useIdentities = () => useContext(IdentityContext);

export function IdentityOwner({ platformUserId, editable = false, showName = true }) {
  const { directory, onEdit } = useIdentities();
  const identity = platformUserId ? directory.get(String(platformUserId)) : null;
  const presentation = identityPresentation(platformUserId, directory);
  return <span className={`identity-owner ${presentation.ownerName ? 'mapped' : ''}`}><span>{showName ? <>账号归属人：{presentation.ownerName || '待映射'} · </> : null}<span className="identity-department">{presentation.department || '部门待映射'}</span></span>{editable && identity && onEdit ? <button className="text-button" aria-label={`修改账号 ${platformUserId} 的员工归属`} onClick={() => onEdit(identity)}><PencilLine size={12} />修改</button> : null}</span>;
}

export function IdentitiesPanel() {
  const { identities, directory, departments, onEdit, onManage } = useIdentities();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [scope, setScope] = useState('current');
  const [departmentId, setDepartmentId] = useState('all');
  const historyCount = identities.filter(identity => identity.historyOnly).length;
  const sourceNames = { login_account: '登录账号', team_member: '团队成员', history: '历史流水', ownership_mapping: '已设置归属' };
  const rows = identities.filter((identity) => (scope === 'all' || (scope === 'history' ? identity.historyOnly : !identity.historyOnly)) && (status === 'all' || (status === 'assigned' ? identity.employeeId && identity.departmentId : !identity.employeeId || !identity.departmentId)) && (departmentId === 'all' || identity.departmentId === departmentId) && [identity.platformUserId, identity.nickname, identity.boundPhone, identity.realName, identity.department].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="panel identities-panel"><div className="panel-title"><div className="inline-title"><h2>即梦账号与员工归属</h2><span className="count-chip">{identities.length - historyCount} 个当前账号</span></div><button className="text-button" onClick={onManage}>维护员工与部门</button></div><div className="filter-bar"><div className="search-input"><Search size={16} /><input aria-label="搜索账号归属" placeholder="搜索姓名、昵称、ID、手机号或部门" value={search} onChange={(e) => setSearch(e.target.value)} /></div><ManagerSelect label="账号来源范围" value={scope} onChange={setScope}><option value="current">当前账号（{identities.length - historyCount}）</option><option value="history">仅历史流水（{historyCount}）</option><option value="all">全部账号（{identities.length}）</option></ManagerSelect><ManagerSelect label="归属状态" value={status} onChange={setStatus}><option value="all">全部归属状态</option><option value="assigned">已归属员工</option><option value="unassigned">归属待补充</option></ManagerSelect><ManagerSelect label="账号归属部门" value={departmentId} onChange={setDepartmentId} searchable><option value="all">全部部门</option>{departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}</ManagerSelect>{departmentId !== 'all' || search || status !== 'all' || scope !== 'current' ? <button className="text-button" onClick={() => { setSearch(''); setStatus('all'); setDepartmentId('all'); setScope('current'); }}>重置</button> : null}</div>{!rows.length ? <div className="empty-state"><UserRound size={26} /><h3>{identities.length ? '没有符合条件的账号' : '暂无已识别的平台账号'}</h3></div> : <div className="table-scroll"><table className="data-table identities-table"><thead><tr><th>归属员工 / 即梦账号</th><th>所属部门</th><th>绑定手机号</th><th>来源</th><th className="align-right">管理</th></tr></thead><tbody>{rows.map((identity) => { const presentation = identityPresentation(identity.platformUserId, directory); return <tr key={identity.platformUserId}><td><strong>{identity.historyOnly ? presentation.nickname || '历史流水账号' : presentation.primary}</strong>{!identity.historyOnly ? <small className="cell-sub">{presentation.ownerName ? `即梦昵称 · ${presentation.secondary}` : presentation.secondary}</small> : null}<small className="cell-sub">ID {identity.platformUserId}</small></td><td>{presentation.department || <span className="unassigned">{identity.historyOnly ? '—' : '待映射'}</span>}</td><td className="tabular">{identity.boundPhone || <span className="unassigned">未填写</span>}</td><td><span className="identity-sources">{identity.historyOnly ? <span>仅历史流水</span> : (identity.sources || []).map(source => sourceNames[source] ? <span key={source}>{sourceNames[source]}</span> : null)}</span></td><td className="align-right">{onEdit ? <button className="text-button" onClick={() => onEdit(identity)}>{identity.realName || identity.department ? '修改归属' : '设置归属'}</button> : <span className="subtle">只读</span>}</td></tr>; })}</tbody></table></div>}<div className="table-footer"><span>显示 {rows.length} 个{scope === 'history' ? '历史流水账号' : '账号'}</span></div></section>;
}

export function IdentityForm({ identity, busy, onSave, onCancel }) {
  const { employees, directory, onManage } = useIdentities();
  const [employeeId, setEmployeeId] = useState(identity.employeeId || '');
  const [boundPhone, setBoundPhone] = useState(identity.boundPhone || '');
  const employee = employees.find(item => item.id === employeeId);
  const presentation = identityPresentation(identity.platformUserId, directory, identity.nickname);
  async function submit(event) {
    event.preventDefault();
    if (!busy) await onSave({ employeeId: employeeId || null, boundPhone: boundPhone.trim() || null });
  }
  return <form className="identity-form" onSubmit={submit}><div className="identity-form-platform"><strong>{presentation.primary}</strong><small>{presentation.ownerName ? `即梦昵称 · ${presentation.secondary}` : presentation.secondary}</small><small>即梦 ID {identity.platformUserId}</small></div><label><span>账号绑定手机号</span><Input aria-label="账号绑定手机号" type="tel" inputMode="tel" autoComplete="off" maxLength={32} value={boundPhone} onChange={setBoundPhone} disabled={busy} placeholder="选填" /></label><label><span>归属员工</span><EmployeeSelect label="归属员工" value={employeeId} onChange={setEmployeeId} employees={employees} disabled={busy} emptyLabel="未关联员工" /></label><label><span>所属部门</span><output className="directory-readonly">{employee?.department || '待设置'}</output></label><button type="button" className="text-button" disabled={busy} onClick={onManage}>维护员工与部门</button><div className="form-actions"><Button onClick={onCancel} disabled={busy}>取消</Button><Button theme="solid" htmlType="submit" loading={busy}>保存归属</Button></div></form>;
}
