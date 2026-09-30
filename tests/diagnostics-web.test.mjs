import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEntries,diagnosticTimestamp,collectorMessage} from '../web/diagnostics.js';

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

test('legacy collector status copy changes only known messages and preserves the source',()=>{
  const installation={status:'waiting',message:'等待打开即梦；已同步的数据仍保留'};
  assert.equal(collectorMessage(installation.message),'尚未打开即梦');
  assert.equal(installation.message,'等待打开即梦；已同步的数据仍保留');
  assert.equal(installation.status,'waiting');
  assert.equal(collectorMessage('已同步 12 个页面；部分资料或历史流水仍待补齐'),'已同步 12 个页面；部分资料或历史流水尚未获取');
  assert.equal(collectorMessage('离线队列已满，待连接恢复后继续补齐'),'离线队列已满，恢复连接后继续采集');
  assert.equal(collectorMessage('管理服务暂不可用，记录已在本机排队等待重试'),'服务连接失败，正在重试');
  assert.equal(collectorMessage('未知状态，等待人工处理'),'未知状态，等待人工处理');
  assert.equal(collectorMessage(null),'');
});
