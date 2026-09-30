import { ManagerSelect } from './ManagerSelect.jsx';

export function EmployeeSelect({ id, label = '员工', value, onChange, employees, disabled = false, required = false, emptyLabel = '请选择员工' }) {
  return <ManagerSelect id={id} label={label} className="directory-field" value={value || ''} onChange={onChange} searchable disabled={disabled} required={required}>
    <option value="">{emptyLabel}</option>
    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.department || '未设置部门'}</option>)}
  </ManagerSelect>;
}

export function DepartmentSelect({ id, label = '部门', value, onChange, departments, disabled = false, required = false, emptyLabel = '请选择部门' }) {
  return <ManagerSelect id={id} label={label} className="directory-field" value={value || ''} onChange={onChange} searchable disabled={disabled} required={required}>
    <option value="">{emptyLabel}</option>
    {departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
  </ManagerSelect>;
}
