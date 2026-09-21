import test from 'node:test';
import assert from 'node:assert/strict';
import {walletOwnershipOverrides,walletOwnerDefaultLabel} from '../web/wallet-ownership.js';

test('wallet ownership form leaves inherited values unset instead of freezing the effective owner',()=>{
  const inherited={ownerEmployeeId:'derived-person',ownerDepartmentId:'derived-department',ownerEmployeeOverrideId:null,ownerDepartmentOverrideId:null};
  const fields=walletOwnershipOverrides(inherited);
  assert.deepEqual(fields,{ownerEmployeeId:'',ownerDepartmentId:''});
  assert.deepEqual({ownerEmployeeId:fields.ownerEmployeeId||null,ownerDepartmentId:fields.ownerDepartmentId||null},{ownerEmployeeId:null,ownerDepartmentId:null});
  assert.deepEqual(walletOwnershipOverrides({...inherited,ownerEmployeeId:'new-owner',ownerDepartmentId:'new-department'}),fields);
  assert.deepEqual(walletOwnershipOverrides({ownerEmployeeId:'effective-only',ownerDepartmentId:'effective-only'}),fields);
});

test('explicit employee and department overrides remain independently editable',()=>{
  assert.deepEqual(walletOwnershipOverrides({ownerEmployeeOverrideId:'employee',ownerDepartmentOverrideId:null,ownerDepartmentId:'inherited'}),{ownerEmployeeId:'employee',ownerDepartmentId:''});
  assert.deepEqual(walletOwnershipOverrides({ownerEmployeeOverrideId:null,ownerDepartmentOverrideId:'department',ownerEmployeeId:'inherited'}),{ownerEmployeeId:'',ownerDepartmentId:'department'});
  assert.equal(walletOwnerDefaultLabel('personal'),'跟随账号归属');
  assert.equal(walletOwnerDefaultLabel('team_total'),'跟随团队创建者');
  assert.equal(walletOwnerDefaultLabel('team_member'),'跟随团队创建者');
});
