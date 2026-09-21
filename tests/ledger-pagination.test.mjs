import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerPage } from '../web/ledger-pagination.js';

test('all pages render at most 50 rows while preserving full totals and every record',()=>{
  const rows=Array.from({length:317},(_,index)=>({id:`event-${index}`,amount:-index}));
  const pages=Array.from({length:7},(_,index)=>ledgerPage(rows,index+1));
  for(const result of pages){assert.equal(result.total,317);assert.equal(result.pageCount,7);assert.ok(result.items.length<=50);}
  assert.deepEqual(pages.flatMap(result=>result.items),rows);
  assert.equal(pages[0].from,1);assert.equal(pages[0].to,50);
  assert.equal(pages[6].from,301);assert.equal(pages[6].to,317);
});

test('filtering the complete ledger before pagination retains matches beyond the first page',()=>{
  const rows=Array.from({length:317},(_,index)=>({id:index,department:index>=200?'教研':'短剧'}));
  const filtered=rows.filter(row=>row.department==='教研');
  const result=ledgerPage(filtered,1);
  assert.equal(result.total,117);assert.equal(result.pageCount,3);assert.equal(result.items[0].id,200);
  assert.equal(ledgerPage(filtered,3).items.at(-1).id,316);
});

test('empty and shrinking results have valid page boundaries and never mutate their input',()=>{
  assert.deepEqual(ledgerPage([],99),{items:[],total:0,page:1,pageCount:1,from:0,to:0});
  const rows=Object.freeze(Array.from({length:51},(_,id)=>Object.freeze({id})));
  const last=ledgerPage(rows,7);
  assert.equal(last.page,2);assert.deepEqual(last.items,[{id:50}]);
  assert.equal(ledgerPage(rows,-1).page,1);assert.equal(ledgerPage(rows,NaN).page,1);
  assert.equal(rows.length,51);
});
