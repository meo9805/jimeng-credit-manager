import { useMemo, useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import { ManagerSelect } from './ManagerSelect.jsx';
import { DepartmentSelect } from './DirectoryFields.jsx';
import Input from '@douyinfe/semi-ui/lib/es/input';
import { Building2, Plus, Search, UsersRound } from 'lucide-react';
import './directory.css';

const includesQuery = (values, query) => values.filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

export function DirectoryPanel({ departments = [], employees = [], busy = false, onSaveDepartment, onDeleteDepartment, onSaveEmployee, onDeleteEmployee }) {
  const [departmentDraft, setDepartmentDraft] = useState(null);
  const [employeeDraft, setEmployeeDraft] = useState(null);
  const [departmentSearch, setDepartmentSearch] = useState('');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [departmentError, setDepartmentError] = useState('');
  const [employeeError, setEmployeeError] = useState('');
  const disabled = busy || submitting;
  const departmentNames = useMemo(() => new Map(departments.map((department) => [department.id, department.name])), [departments]);
  const employeeCounts = useMemo(() => {
    const result = new Map();
    for (const employee of employees) result.set(employee.departmentId, (result.get(employee.departmentId) || 0) + 1);
    return result;
  }, [employees]);
  const departmentRows = departments.filter((department) => includesQuery([department.name], departmentSearch));
  const employeeRows = employees.filter((employee) => (!departmentFilter || employee.departmentId === departmentFilter) && includesQuery([employee.name, departmentNames.get(employee.departmentId) || employee.department], employeeSearch));

  function editDepartment(department = null) {
    setDepartmentError('');
    setDepartmentDraft({ id: department?.id || null, name: department?.name || '' });
  }
  function editEmployee(employee = null) {
    setEmployeeError('');
    setEmployeeDraft({ id: employee?.id || null, name: employee?.name || '', departmentId: employee?.departmentId || '' });
  }
  async function saveDepartment(event) {
    event.preventDefault();
    if (disabled || !departmentDraft) return;
    const name = departmentDraft.name.trim();
    if (!name) { setDepartmentError('请输入部门名称'); return; }
    setSubmitting(true);
    try {
      if (await onSaveDepartment(departmentDraft.id, { name }) !== false) setDepartmentDraft(null);
    } catch { /* The parent reports the API error; keep the draft. */ }
    finally { setSubmitting(false); }
  }
  async function saveEmployee(event) {
    event.preventDefault();
    if (disabled || !employeeDraft) return;
    const name = employeeDraft.name.trim();
    if (!name) { setEmployeeError('请输入员工姓名'); return; }
    if (!departmentNames.has(employeeDraft.departmentId)) { setEmployeeError('请选择所属部门'); return; }
    setSubmitting(true);
    try {
      if (await onSaveEmployee(employeeDraft.id, { name, departmentId: employeeDraft.departmentId }) !== false) setEmployeeDraft(null);
    } catch { /* The parent reports the API error; keep the draft. */ }
    finally { setSubmitting(false); }
  }
  async function confirmDelete() {
    if (disabled || !pendingDelete) return;
    const target = pendingDelete;
    setSubmitting(true);
    try {
      const result = await (target.kind === 'department' ? onDeleteDepartment(target.id) : onDeleteEmployee(target.id));
      if (result === false) return;
      if (target.kind === 'department') {
        if (departmentDraft?.id === target.id) setDepartmentDraft(null);
        if (departmentFilter === target.id) setDepartmentFilter('');
      } else if (employeeDraft?.id === target.id) setEmployeeDraft(null);
      setPendingDelete(null);
    } catch { /* The parent reports why this entry cannot be deleted. */ }
    finally { setSubmitting(false); }
  }
  const deletionPrompt = (kind) => pendingDelete?.kind === kind ? <div className="directory-delete-confirm" role="alert"><span>删除{kind === 'department' ? '部门' : '员工'}“{pendingDelete.name}”？</span><div><Button size="small" disabled={disabled} onClick={() => setPendingDelete(null)}>取消</Button><Button size="small" type="danger" disabled={disabled} onClick={confirmDelete}>确认删除</Button></div></div> : null;

  return <div className="directory-grid">
    <section className="panel directory-departments">
      <div className="panel-title"><div className="inline-title"><h2>部门</h2><span className="count-chip">{departments.length}</span></div><Button icon={<Plus size={14} />} disabled={disabled} onClick={() => editDepartment()}>新增部门</Button></div>
      {departmentDraft ? <form className="directory-form" onSubmit={saveDepartment}>
        <h3>{departmentDraft.id ? '编辑部门' : '新增部门'}</h3>
        <label><span>部门名称</span><Input aria-label="部门名称" value={departmentDraft.name} maxLength={80} onChange={(name) => { setDepartmentDraft((draft) => ({ ...draft, name })); setDepartmentError(''); }} autoComplete="off" disabled={disabled} /></label>
        {departmentError ? <p className="form-error" role="alert">{departmentError}</p> : null}
        <div className="form-actions"><Button disabled={disabled} onClick={() => setDepartmentDraft(null)}>取消</Button><Button theme="solid" htmlType="submit" disabled={disabled}>保存部门</Button></div>
      </form> : null}
      {deletionPrompt('department')}
      <div className="filter-bar"><div className="search-input"><Search size={16} /><input aria-label="搜索部门" placeholder="搜索部门" value={departmentSearch} onChange={(event) => setDepartmentSearch(event.target.value)} /></div></div>
      {departmentRows.length ? <div className="table-scroll"><table className="data-table directory-table"><thead><tr><th>部门名称</th><th>员工数</th><th className="align-right">管理</th></tr></thead><tbody>{departmentRows.map((department) => <tr key={department.id}><td><strong>{department.name}</strong></td><td>{employeeCounts.get(department.id) || 0}</td><td className="align-right"><div className="directory-row-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => editDepartment(department)}>编辑</button><button type="button" className="text-button directory-delete" disabled={disabled} onClick={() => setPendingDelete({ kind: 'department', id: department.id, name: department.name })}>删除</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state compact"><span className="empty-icon"><Building2 size={23} /></span><h3>{departments.length ? '没有匹配的部门' : '尚未添加部门'}</h3></div>}
    </section>
    <section className="panel directory-employees">
      <div className="panel-title"><div className="inline-title"><h2>员工</h2><span className="count-chip">{employees.length}</span></div><Button icon={<Plus size={14} />} disabled={disabled || !departments.length} onClick={() => editEmployee()}>新增员工</Button></div>
      {employeeDraft ? <form className="directory-form" onSubmit={saveEmployee}>
        <h3>{employeeDraft.id ? '编辑员工' : '新增员工'}</h3>
        <div className="directory-form-fields"><label><span>员工姓名</span><Input aria-label="员工姓名" value={employeeDraft.name} maxLength={100} onChange={(name) => { setEmployeeDraft((draft) => ({ ...draft, name })); setEmployeeError(''); }} autoComplete="off" disabled={disabled} /></label><label className="select-wrapper"><span>所属部门</span><DepartmentSelect label="员工所属部门" required value={employeeDraft.departmentId} disabled={disabled} departments={departments} onChange={(departmentId) => { setEmployeeDraft((draft) => ({ ...draft, departmentId })); setEmployeeError(''); }} /></label></div>
        {employeeError ? <p className="form-error" role="alert">{employeeError}</p> : null}
        <div className="form-actions"><Button disabled={disabled} onClick={() => setEmployeeDraft(null)}>取消</Button><Button theme="solid" htmlType="submit" disabled={disabled}>保存员工</Button></div>
      </form> : null}
      {deletionPrompt('employee')}
      <div className="filter-bar"><div className="search-input"><Search size={16} /><input aria-label="搜索员工" placeholder="搜索姓名或部门" value={employeeSearch} onChange={(event) => setEmployeeSearch(event.target.value)} /></div><ManagerSelect label="员工部门" value={departmentFilter} onChange={setDepartmentFilter} searchable><option value="">全部部门</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</ManagerSelect></div>
      {employeeRows.length ? <div className="table-scroll"><table className="data-table directory-table"><thead><tr><th>员工姓名</th><th>所属部门</th><th className="align-right">管理</th></tr></thead><tbody>{employeeRows.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong></td><td>{departmentNames.get(employee.departmentId) || employee.department || <span className="unassigned">未设置</span>}</td><td className="align-right"><div className="directory-row-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => editEmployee(employee)}>编辑</button><button type="button" className="text-button directory-delete" disabled={disabled} onClick={() => setPendingDelete({ kind: 'employee', id: employee.id, name: employee.name })}>删除</button></div></td></tr>)}</tbody></table></div> : <div className="empty-state compact"><span className="empty-icon"><UsersRound size={23} /></span><h3>{employees.length ? '没有匹配的员工' : departments.length ? '尚未添加员工' : '请先添加部门'}</h3></div>}
    </section>
  </div>;
}
