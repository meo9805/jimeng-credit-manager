import { randomUUID } from 'node:crypto';
import { fail, string } from './domain.mjs';

const placeholders = new Set(['待归属','待映射','未填写部门','未填写','未设置','未分配','未知','未知部门','未命名员工','管理员设备','本机试用']);
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu,' ') : '';
const nameKey = value => normalized(value).toLocaleLowerCase('en-US');
const legacyName = value => { const name=normalized(value);return name&&!placeholders.has(name)?name:null; };
const inputName = (value,label,max) => {
  const name=string(normalized(value),label,max);
  if(placeholders.has(name))fail(`请填写有效的${label}`);
  return name;
};

// Separate references from collected facts. Renames change the directory only;
// platform observations and historical operator attribution remain untouched.
export function createDirectory(db,now) {
  const department = (id,status=400) => {
    if(id===null)return null;
    const row=typeof id==='string'?db.prepare('SELECT id,name FROM departments WHERE id=?').get(id):null;
    if(!row)fail('部门不存在',status);
    return {...row};
  };
  const employee = (id,status=400) => {
    if(id===null)return null;
    const row=typeof id==='string'?db.prepare(`SELECT e.id,e.name,e.department_id AS departmentId,d.name AS department
      FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=?`).get(id):null;
    if(!row)fail('员工不存在',status);
    return {...row};
  };
  function createDepartment(input) {
    const name=inputName(input.name,'部门名称',80),key=nameKey(name);
    if(db.prepare('SELECT id FROM departments WHERE name_key=?').get(key))fail('部门名称已存在',409);
    const id=randomUUID();db.prepare('INSERT INTO departments(id,name,name_key) VALUES(?,?,?)').run(id,name,key);
    return department(id);
  }
  function patchDepartment(id,input) {
    department(id,404);
    const name=inputName(input.name,'部门名称',80),key=nameKey(name);
    if(db.prepare('SELECT id FROM departments WHERE name_key=? AND id<>?').get(key,id))fail('部门名称已存在',409);
    db.prepare('UPDATE departments SET name=?,name_key=? WHERE id=?').run(name,key,id);
    return department(id);
  }
  function deleteDepartment(id) {
    department(id,404);
    if(db.prepare(`SELECT 1 FROM employees WHERE department_id=? UNION ALL SELECT 1 FROM accounts WHERE owner_department_id=?
      UNION ALL SELECT 1 FROM identity_mappings WHERE department_id=? UNION ALL SELECT 1 FROM installations WHERE department_id=? LIMIT 1`).get(id,id,id,id))fail('部门仍有关联员工或账号，暂不能删除',409);
    db.prepare('DELETE FROM departments WHERE id=?').run(id);return {deleted:true};
  }
  function duplicateEmployee(name,departmentId,except='') {
    return db.prepare("SELECT id FROM employees WHERE name_key=? AND COALESCE(department_id,'')=COALESCE(?,'') AND id<>?").get(nameKey(name),departmentId,except);
  }
  function createEmployee(input) {
    const name=inputName(input.name,'员工姓名',100),departmentId=department(input.departmentId)?.id??null;
    if(duplicateEmployee(name,departmentId))fail('此部门下已有同名员工',409);
    const id=randomUUID();db.prepare('INSERT INTO employees(id,name,name_key,department_id) VALUES(?,?,?,?)').run(id,name,nameKey(name),departmentId);
    return employee(id);
  }
  function patchEmployee(id,input) {
    const previous=employee(id,404),name=Object.hasOwn(input,'name')?inputName(input.name,'员工姓名',100):previous.name;
    const departmentId=Object.hasOwn(input,'departmentId')?department(input.departmentId)?.id??null:previous.departmentId;
    if(duplicateEmployee(name,departmentId,id))fail('此部门下已有同名员工',409);
    db.prepare('UPDATE employees SET name=?,name_key=?,department_id=? WHERE id=?').run(name,nameKey(name),departmentId,id);
    return employee(id);
  }
  function deleteEmployee(id) {
    employee(id,404);
    if(db.prepare(`SELECT 1 FROM installations WHERE employee_id=? UNION ALL SELECT 1 FROM identity_mappings WHERE employee_id=?
      UNION ALL SELECT 1 FROM accounts WHERE owner_employee_id=? LIMIT 1`).get(id,id,id))fail('员工仍有关联采集器或账号，暂不能删除',409);
    db.prepare('DELETE FROM employees WHERE id=?').run(id);return {deleted:true};
  }
  function migrate() {
    db.exec(`BEGIN IMMEDIATE`);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS departments(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS employees(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL,department_id TEXT REFERENCES departments(id));
        CREATE UNIQUE INDEX IF NOT EXISTS employee_name_department ON employees(name_key,COALESCE(department_id,''));
        CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT NOT NULL);`);
      for(const [table,column,target] of [['installations','employee_id','employees'],['installations','department_id','departments'],['accounts','owner_employee_id','employees'],['accounts','owner_department_id','departments'],['identity_mappings','employee_id','employees'],['identity_mappings','department_id','departments']]){
        if(!db.prepare(`PRAGMA table_info(${table})`).all().some(item=>item.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES ${target}(id)`);
      }
      if(!db.prepare('SELECT id FROM schema_migrations WHERE id=?').get('directory-v1')){
        const migrateDepartment = value => {
          const name=legacyName(value);if(!name)return null;
          return db.prepare('SELECT id FROM departments WHERE name_key=?').get(nameKey(name))?.id??createDepartment({name}).id;
        };
        const migrateEmployee = (value,departmentId) => {
          const name=legacyName(value);if(!name)return null;
          return duplicateEmployee(name,departmentId)?.id??createEmployee({name,departmentId}).id;
        };
        for(const row of db.prepare('SELECT * FROM installations').all()){
          const data=JSON.parse(row.data),departmentId=migrateDepartment(data.department),employeeId=migrateEmployee(data.employeeName,departmentId);
          db.prepare('UPDATE installations SET employee_id=?,department_id=? WHERE id=?').run(employeeId,employeeId?null:departmentId,row.id);
        }
        for(const row of db.prepare('SELECT * FROM identity_mappings').all()){
          const departmentId=migrateDepartment(row.department),employeeId=migrateEmployee(row.real_name,departmentId);
          db.prepare('UPDATE identity_mappings SET employee_id=?,department_id=? WHERE platform_user_id=?').run(employeeId,employeeId?null:departmentId,row.platform_user_id);
        }
        for(const row of db.prepare('SELECT * FROM accounts').all()){
          const departmentId=migrateDepartment(row.owner_department),employeeId=migrateEmployee(row.owner_name,departmentId);
          db.prepare('UPDATE accounts SET owner_employee_id=?,owner_department_id=? WHERE id=?').run(employeeId,departmentId,row.id);
        }
        db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run('directory-v1',now());
      }
      db.exec('COMMIT');
    } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  migrate();
  return {department,employee,createDepartment,patchDepartment,deleteDepartment,createEmployee,patchEmployee,deleteEmployee,
    departments:()=>db.prepare('SELECT id,name FROM departments ORDER BY name,id').all().map(row=>({...row})),
    employees:()=>db.prepare('SELECT id FROM employees ORDER BY name,department_id,id').all().map(row=>employee(row.id))};
}
