import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStore} from '../server/store.mjs';
import {validateIngest} from '../server/domain.mjs';

function fixture(t){
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-delete-')),time=Date.parse('2026-09-15T03:00:00.000Z');
  const options={dataDir,secret:'isolated-delete-test-key',clock:()=>time};
  let store=createStore(options);
  const department=store.createDepartment({name:'测试部门'}),employee=store.createEmployee({name:'测试员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'}),token=store.installationToken(device.id);
  const input=validateIngest({observedAt:new Date(time).toISOString(),status:'ok',loginIdentity:{platformUserId:'login-only',displayName:'只有登录昵称'},accounts:[],transactions:[]},time);
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {get store(){return store;},dataDir,device,token,input,employee,restart(){store.close();store=createStore(options);}};
}

test('deleting an identity-only collector preserves its observed nickname and ownership across restart',t=>{
  const f=fixture(t);f.store.ingest(f.device,f.input);
  f.store.patchIdentity('login-only',{employeeId:f.employee.id,boundPhone:'199****0000'});
  const before=f.store.dashboard().identities;
  assert.equal(before.length,1);assert.equal(before[0].employeeId,f.employee.id);assert.equal(before[0].nickname,'只有登录昵称');
  f.store.deleteInstallation(f.device.id);f.restart();
  assert.deepEqual(f.store.dashboard().identities,before);
  assert.deepEqual(f.store.dashboard().installations,[]);
  assert.equal(f.store.authenticate(f.token),null);
  assert.throws(()=>f.store.installationToken(f.device.id),error=>error.status===404);
  assert.throws(()=>f.store.ingest(f.device,f.input),error=>error.status===401);
  assert.throws(()=>f.store.pollCommands(f.device),error=>error.status===401);
  assert.throws(()=>f.store.recordDiagnostics(f.device,[]),error=>error.status===401);
  assert.throws(()=>f.store.recordCommandResult(f.device,'pending-job',{status:'completed'}),error=>error.status===401);
  f.store.patchIdentity('login-only',{boundPhone:null});assert.equal(f.store.dashboard().identities[0].employeeId,f.employee.id);
});

test('collector deletion is atomic when a referenced cleanup fails',t=>{
  const f=fixture(t);f.store.ingest(f.device,f.input);
  const db=new DatabaseSync(path.join(f.dataDir,'credits.sqlite'));
  db.exec(`CREATE TRIGGER block_collector_delete BEFORE DELETE ON installations BEGIN SELECT RAISE(ABORT,'test deletion failure'); END;`);
  const before=f.store.dashboard();
  assert.throws(()=>f.store.deleteInstallation(f.device.id),/test deletion failure/);
  assert.deepEqual(f.store.dashboard(),before);assert.equal(f.store.authenticate(f.token).id,f.device.id);
  assert.equal(db.prepare('SELECT observed_nickname FROM identity_mappings WHERE platform_user_id=?').get('login-only')?.observed_nickname,undefined);
  db.exec('DROP TRIGGER block_collector_delete');db.close();
  f.store.deleteInstallation(f.device.id);assert.deepEqual(f.store.dashboard().installations,[]);
});
