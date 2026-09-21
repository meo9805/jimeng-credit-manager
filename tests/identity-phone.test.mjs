import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../server/store.mjs';
import {validateIdentityMapping,validateIngest} from '../server/domain.mjs';

test('optional account phone persists independently of enrollment, employee mapping and nickname',t=>{
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'jmc-phone-'));let time=Date.now();
  let store=createStore({dataDir,secret:'local-test-key',clock:()=>time});
  t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});
  const department=store.createDepartment({name:'测试部门'}),employee=store.createEmployee({name:'测试员工',departmentId:department.id});
  const device=store.createInstallation({employeeId:employee.id,role:'collector'});
  const collect=(id='own',nickname='平台昵称')=>store.ingest(device,validateIngest({observedAt:new Date(++time).toISOString(),accounts:[{platformUserId:id,spaceId:'personal',scope:'personal',displayName:nickname,balance:100}],transactions:[]},time));
  const owner=()=>store.dashboard().identities.find(x=>x.platformUserId==='own');
  collect();assert.equal(owner().employeeId,employee.id);assert.equal(owner().boundPhone,null);
  store.patchIdentity('own',validateIdentityMapping({boundPhone:'+86 19900000000'}));
  assert.equal(owner().employeeId,employee.id);assert.equal(owner().boundPhone,'+8619900000000');
  store.patchIdentity('own',validateIdentityMapping({employeeId:null}));assert.equal(owner().boundPhone,'+8619900000000');
  collect('own','新昵称');assert.equal(owner().boundPhone,'+8619900000000');assert.equal(owner().employeeId,null);
  store.close();store=createStore({dataDir,secret:'local-test-key',clock:()=>time});assert.equal(owner().boundPhone,'+8619900000000');
  store.patchIdentity('own',validateIdentityMapping({employeeId:employee.id,boundPhone:''}));assert.equal(owner().boundPhone,null);assert.equal(owner().employeeId,employee.id);
  collect('borrowed');assert.equal(store.dashboard().identities.find(x=>x.platformUserId==='borrowed').boundPhone,null);assert.equal(owner().employeeId,employee.id);
});

test('phone validation accepts optional formatted numbers and rejects arbitrary text without resetting ownership',()=>{
  assert.deepEqual(validateIdentityMapping({boundPhone:'199****0000'}),{boundPhone:'199****0000'});
  assert.deepEqual(validateIdentityMapping({boundPhone:null}),{boundPhone:null});
  for(const input of [{},{boundPhone:19900000000},{boundPhone:'not-a-phone'},{boundPhone:'1'.repeat(33)},{boundPhone:'123\n4567'}])assert.throws(()=>validateIdentityMapping(input));
});
