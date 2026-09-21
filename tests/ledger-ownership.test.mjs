import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAccountOwner } from '../web/identities.js';
import { transactionPresentation } from '../web/identity-presentation.js';

const directory=new Map([['account',{employeeId:'new',realName:'新员工',departmentId:'new-dept',department:'新部门',nickname:'平台名'}]]);
test('historical ledger owner display and filter both follow event snapshot after reassignment',()=>{
  const transaction={chargedPlatformUserId:'account',ownershipSnapshot:{employeeId:'old',name:'原员工',departmentId:'old-dept',department:'原部门',basis:'effective'}};
  assert.equal(matchesAccountOwner(transaction,directory,'employee:old','old-dept'),true);
  assert.equal(matchesAccountOwner(transaction,directory,'employee:new'),false);
  assert.equal(transactionPresentation(transaction,directory).primary,'原员工');
  assert.equal(transactionPresentation(transaction,directory).nickname,'平台名');
});
test('recorded unassigned owner remains unassigned after current mapping changes',()=>{
  const transaction={chargedPlatformUserId:'account',ownershipSnapshot:{employeeId:null,name:null,departmentId:null,department:null,basis:'effective'}};
  assert.equal(matchesAccountOwner(transaction,directory,'__unassigned','__unassigned'),true);
  assert.equal(transactionPresentation(transaction,directory).ownerName,null);
});
test('legacy responses without owner snapshots keep existing presentation',()=>{
  const transaction={chargedPlatformUserId:'account'};
  assert.equal(matchesAccountOwner(transaction,directory,'employee:new'),true);
  assert.equal(transactionPresentation(transaction,directory).primary,'新员工');
});
