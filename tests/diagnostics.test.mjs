import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticLog,sanitizeDiagnostic,diagnosticLabels} from '../extension/diagnostics.mjs';
import {validateDiagnostics} from '../server/domain.mjs';
import {diagnosticEntries} from '../web/diagnostics.js';
const setup=()=>{
  const data={};const storage={async get(key){return structuredClone({[key]:data[key]});},async set(value){Object.assign(data,structuredClone(value));}};
  return {data,storage,log:createDiagnosticLog(storage,'0.2.2')};
};
test('diagnostics whitelist excludes errors, URLs, headers and content; numeric fields are bounded',()=>{
  const base={id:'diagnostic-fixture',at:new Date().toISOString(),code:'upload_failed',extensionVersion:'0.2.2'};
  const safe=sanitizeDiagnostic({...base,httpStatus:503,readTabs:101,skippedTabs:-1,pendingCount:10001,
    message:'private fixture',url:'https://private.example.test',headers:{Authorization:'fake-secret'},prompt:'private fixture',userInfo:{id:'fake-user'}});
  assert.deepEqual(safe,{...base,httpStatus:503});
  assert.equal(sanitizeDiagnostic({...base,code:'private fixture'}),null);
  assert.equal(sanitizeDiagnostic({...base,id:'https://private.example.test'}),null);
});
test('local ring retains only 200 records and uploads at most 50 without deleting local history',async()=>{
  const {data,log}=setup();
  for(let i=0;i<240;i++)await log.record('collection_started',{pendingCount:i});
  assert.equal(data.diagnostics.entries.length,200);assert.equal(data.diagnostics.pending.length,200);
  await log.flush(async batch=>{assert.equal(batch.length,50);return {accepted:true};});
  assert.equal(data.diagnostics.entries.length,200);assert.equal(data.diagnostics.pending.length,150);
});
test('failed or unacknowledged uploads preserve pending IDs across a worker recreation',async()=>{
  const {data,log,storage}=setup();await log.record('connection_failed');
  const pending=[...data.diagnostics.pending];
  await log.flush(async()=>{throw new Error('offline fixture');});assert.deepEqual(data.diagnostics.pending,pending);
  await log.flush(async()=>({accepted:false}));assert.deepEqual(data.diagnostics.pending,pending);
  const restarted=createDiagnosticLog(storage,'0.2.2');
  await restarted.flush(async batch=>{assert.deepEqual(batch.map(e=>e.id),pending);return {accepted:true};});
  assert.deepEqual(data.diagnostics.pending,[]);assert.equal((await restarted.snapshot()).length,1);
});
test('records written during upload remain pending and concurrent flushes send only one batch',async()=>{
  const {data,log}=setup();await log.record('collector_started');let release,calls=0;
  const pending=log.flush(async()=>{calls++;await new Promise(resolve=>{release=resolve;});return {accepted:true};});
  while(!release)await new Promise(setImmediate);
  const duplicate=log.flush(async()=>{calls++;return {accepted:true};});
  await log.record('collection_started');release();await Promise.all([pending,duplicate]);
  assert.equal(calls,1);assert.equal(data.diagnostics.entries.length,2);assert.equal(data.diagnostics.pending.length,1);
});
test('storage failures cannot make diagnostics reject the main workflow',async()=>{
  const log=createDiagnosticLog({async get(){throw new Error('storage unavailable');},async set(){throw new Error('storage unavailable');}},'0.2.2');
  await log.record('collection_failed');await log.flush(async()=>({accepted:true}));assert.deepEqual(await log.snapshot(),[]);
});
test('every collector diagnostic crosses server validation and has a manager label',()=>{
  const now=Date.now(),at=new Date(now).toISOString();
  const logs=Object.keys(diagnosticLabels).map(code=>sanitizeDiagnostic({id:'event-'+code,code,at,extensionVersion:'0.2.9',pendingCount:2}));
  const accepted=validateDiagnostics({logs},now),displayed=diagnosticEntries(accepted);
  assert.equal(accepted.length,logs.length);
  assert.ok(displayed.every(item=>item.label!=='其他采集事件'));
  assert.ok(displayed.find(item=>item.key==='event-operation_uploaded').facts.includes('本次上报凭证 2'));
});
