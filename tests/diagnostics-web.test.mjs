import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEntries,diagnosticTimestamp} from '../web/diagnostics.js';

test('manager diagnostics sort by observed time and translate only known event codes',()=>{
  const rows=diagnosticEntries([{id:'a',at:'2026-09-15T01:00:00Z',code:'collector_started'},{id:'b',at:'2026-09-15T02:00:00Z',code:'upload_failed',httpStatus:503}]);
  assert.equal(rows[0].key,'b');assert.equal(rows[0].label,'数据上报失败');assert.equal(rows[0].severity,'error');assert.deepEqual(rows[0].facts,['HTTP 503']);
  assert.equal(rows[1].label,'采集器已启动');
});
test('manager diagnostics never render raw error, URLs, headers or unrecognized event text',()=>{
  const rows=diagnosticEntries([{id:'test-event',at:null,code:'private-content',message:'private-content',url:'private-content',headers:{Authorization:'private-content'},extensionVersion:'private-content'}]);
  assert.equal(rows[0].label,'其他采集事件');assert.ok(!JSON.stringify(rows).includes('private-content'));assert.deepEqual(rows[0].facts,[]);
});
test('manager diagnostics distinguish zero counts from absent facts and invalid dates',()=>{
  assert.deepEqual(diagnosticEntries([{id:'a',code:'collection_partial',readTabs:0,skippedTabs:2,pendingCount:null}])[0].facts,['已读页面 0','跳过页面 2']);
  assert.equal(diagnosticTimestamp('invalid'),null);assert.equal(diagnosticTimestamp(null),null);
});
