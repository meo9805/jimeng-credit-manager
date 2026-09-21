import { readJimengPage } from './page-reader.mjs';
import { normalizeObservation } from './normalize.mjs';
import { installCreditWatcher } from './page-watcher.mjs';
import { installOperationWatcher } from './operation-watcher.mjs';
import { createDiagnosticLog } from './diagnostics.mjs';
import { publishedUpdate, readUpdateZip } from './manual-update.mjs';

const JIMENG = 'https://jimeng.jianying.com/*';
const commands = new Map(), executing = new Set(), attached = new Set(), finished = new Map(), attaching = new Map();
const preferredTabs = new Set();
let running = null, rerun = false, polling = null, lastPollAt = 0;
let provisionTask = null;
let collectorRoute = null;
let connectionDown=false,uploadDown=false,diagnosticsUpload=null;
const diagnostics=createDiagnosticLog(chrome.storage.local,chrome.runtime.getManifest().version);
void diagnostics.record('collector_started');
export function flushDiagnostics(p) {
  if (p) diagnosticsUpload=diagnostics.flush(logs=>api(p,'/api/collector/diagnostics',{method:'POST',body:JSON.stringify({logs})}));
  return diagnosticsUpload || Promise.resolve();
}
const now = () => new Date().toISOString();
function endpointOrigin(value) {
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('管理地址必须是 HTTP(S) 网站地址，不能包含路径或账号信息');
  return url.origin;
}
async function loadProvision() {
  const p = await fetch(chrome.runtime.getURL('provision.json')).then(r => r.json());
  if (!p.token || !p.installationId) throw new Error('请使用管理员下载的安装包');
  const endpoint = endpointOrigin(p.endpoint);
  const internalEndpoint = p.internalEndpoint ? endpointOrigin(p.internalEndpoint) : null;
  const binding = {endpoint,installationId:p.installationId};
  const stored = await chrome.storage.local.get(['serviceBinding','commandResults','archivedCommandResults','pending','isolatedPending','pendingOperationEvidence','isolatedOperationEvidence']);
  const previous = stored.serviceBinding;
  if (!previous || previous.endpoint !== endpoint || previous.installationId !== p.installationId) {
    const migration = {serviceBinding:binding,scanKeys:{},rotationOffset:0,commandResults:{},extensionUpdate:null,
      state:{status:'waiting',message:'正在连接管理服务并重新核对历史记录'}};
    if (Object.keys(stored.commandResults || {}).length) migration.archivedCommandResults =
      [...(stored.archivedCommandResults || []),{binding:previous || null,archivedAt:now(),results:stored.commandResults}].slice(-3);
    // A server move keeps this employee's queue. Reassigning a device must not attribute its old queue to somebody else.
    if (previous && previous.installationId !== p.installationId && stored.pending?.length) {
      migration.isolatedPending = [...(stored.isolatedPending || []),{binding:previous,isolatedAt:now(),pending:stored.pending}];
      migration.pending = [];
      migration.state.warning = '设备归属已变更，原员工的离线记录已保留本机隔离，未上报给新员工';
    }
    if (previous && previous.installationId !== p.installationId && stored.pendingOperationEvidence?.length) {
      migration.isolatedOperationEvidence=[...(stored.isolatedOperationEvidence||[]),{binding:previous,isolatedAt:now(),evidence:stored.pendingOperationEvidence}];
      migration.pendingOperationEvidence=[];
    }
    await chrome.storage.local.set(migration);
  }
  return { token:p.token, installationId:p.installationId, endpoint, internalEndpoint };
}
function provision() {
  // One configuration per worker lifetime also serializes migration before either collector or command traffic.
  if (!provisionTask) provisionTask = loadProvision().catch(async error => { provisionTask = null; await diagnostics.record('configuration_invalid'); throw error; });
  return provisionTask;
}
async function request(p, endpoint, path, options, responseType = 'json') {
  let response;
  try {
    response = await fetch(`${endpoint}${path}`, { ...options, credentials: 'omit', redirect:'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.token}`, ...options.headers },
      signal: AbortSignal.timeout(10000) });
  } catch (cause) {
    const error = new Error(cause.message || '管理服务连接失败');
    error.retryableRoute = true; throw error;
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? '采集端已停用或授权失效，请联系管理员' : '管理服务暂时不可用');
    error.status = response.status; error.retryableRoute = [502,503,504].includes(response.status); throw error;
  }
  return responseType === 'zip' ? readUpdateZip(response) : response.json();
}
async function routeRequest(p, path, options = {}, endpoint = p.endpoint, responseType = 'json') {
  const canFallback = endpoint === p.endpoint && p.internalEndpoint && p.internalEndpoint !== p.endpoint &&
    (path === '/api/ingest' || path.startsWith('/api/collector/'));
  if (!canFallback) return request(p,endpoint,path,options,responseType);
  const first = collectorRoute?.expiresAt > Date.now() ? collectorRoute.endpoint : p.endpoint;
  try { return await request(p,first,path,options,responseType); }
  catch (error) {
    if (!error.retryableRoute) throw error;
    collectorRoute = null;
    const alternate = first === p.endpoint ? p.internalEndpoint : p.endpoint;
    const result = await request(p,alternate,path,options,responseType);
    if (alternate === p.internalEndpoint) collectorRoute = {endpoint:alternate,expiresAt:Date.now()+60000};
    return result;
  }
}
async function api(p,path,options={},endpoint=p.endpoint,responseType='json') {
  const monitored=path !== '/api/collector/diagnostics' && (path === '/api/ingest' || path.startsWith('/api/collector/'));
  try {
    const response=await routeRequest(p,path,options,endpoint,responseType);
    if (monitored && connectionDown) {connectionDown=false;await diagnostics.record('connection_recovered');}
    return response;
  } catch(error) {
    if (monitored && error.retryableRoute && !connectionDown) {connectionDown=true;await diagnostics.record('connection_failed',{httpStatus:error.status});}
    throw error;
  }
}
async function updateBadge() {
  const stored=(await chrome.storage.local.get('extensionUpdate')).extensionUpdate;
  const update=publishedUpdate(stored,chrome.runtime.getManifest().version);
  await chrome.action.setBadgeText({text:update ? '↑' : ''});
  if (update) await chrome.action.setBadgeBackgroundColor({color:'#305fe6'});
  return update;
}
async function refreshUpdate(p) {
  const response=await api(p,'/api/collector/status');
  const update=publishedUpdate(response.extensionRelease,chrome.runtime.getManifest().version);
  await chrome.storage.local.set({extensionUpdate:update});
  await updateBadge();
  return update;
}
async function state(fields) {
  await chrome.storage.local.set({ state: { ...(await chrome.storage.local.get('state')).state, ...fields } });
}
async function enqueue(observation) {
  const { pending = [] } = await chrome.storage.local.get('pending');
  if (pending.length >= 30) {
    await state({warning:'离线队列已满，暂停推进流水，连接恢复后继续补齐'});
    throw new Error('离线队列已满，等待已有记录上传后继续采集');
  }
  const queueId = crypto.randomUUID();
  await chrome.storage.local.set({ pending: [...pending, { queueId, observation }] });
  return queueId;
}
let operationStorageWork=Promise.resolve();
function operationStorage(task) {const next=operationStorageWork.then(task,task);operationStorageWork=next.catch(()=>{});return next;}
async function saveOperationEvidence(evidence) {
  await provision();
  const id=value=>typeof value==='string' && /^[\w.@:-]{1,160}$/.test(value);
  if (!evidence || !id(evidence.submitId) || !id(evidence.userId) || !['personal','team'].includes(evidence.spaceType) || !id(evidence.spaceId) ||
    (evidence.spaceType==='personal' && evidence.spaceId!=='personal') || typeof evidence.occurredAt!=='string' || evidence.occurredAt.length>32 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(evidence.occurredAt) || !Number.isFinite(Date.parse(evidence.occurredAt))) return false;
  const item={submitId:evidence.submitId,userId:evidence.userId,spaceType:evidence.spaceType,spaceId:evidence.spaceId,occurredAt:evidence.occurredAt};
  return operationStorage(async()=>{
    const queue=(await chrome.storage.local.get('pendingOperationEvidence')).pendingOperationEvidence||[];
    const key=x=>[x.submitId,x.userId,x.spaceType,x.spaceId].join('|');
    if(queue.some(x=>key(x)===key(item)))return true;
    if(queue.length>=500){await state({warning:'操作记录离线队列已满，请管理员排查连接'});await diagnostics.record('operation_queue_full',{pendingCount:queue.length});return false;}
    await chrome.storage.local.set({pendingOperationEvidence:[...queue,item]});
    await diagnostics.record('operation_saved',{pendingCount:queue.length+1});return true;
  });
}
async function flushOperationEvidence(p) {
  const batch=await operationStorage(async()=>((await chrome.storage.local.get('pendingOperationEvidence')).pendingOperationEvidence||[]).slice(0,100));
  if(!batch.length)return;
  try {
    const result=await api(p,'/api/ingest',{method:'POST',body:JSON.stringify({observedAt:now(),status:'ok',accounts:[],transactions:[],operationEvidence:batch})});
    if(result.accepted!==true)throw new Error('操作记录尚未确认接收');
  } catch(error) {await diagnostics.record('operation_upload_failed',{httpStatus:error.status,pendingCount:batch.length});throw error;}
  await operationStorage(async()=>{
    const queue=(await chrome.storage.local.get('pendingOperationEvidence')).pendingOperationEvidence||[];
    const sent=new Set(batch.map(x=>JSON.stringify(x)));
    await chrome.storage.local.set({pendingOperationEvidence:queue.filter(x=>!sent.has(JSON.stringify(x)))});
  });
  await diagnostics.record('operation_uploaded',{pendingCount:batch.length});
}
async function flush(p) {
  const { pending = [] } = await chrome.storage.local.get('pending');
  const accepted = new Set();
  for (const envelope of pending) {
    const entry = envelope.observation || envelope; // Read 0.1.1 queues during upgrade.
    try {
      const response = await api(p, '/api/ingest', { method: 'POST', body: JSON.stringify(entry) });
      if (response.accepted !== true) throw new Error('管理服务尚未确认接收数据');
      accepted.add(envelope.queueId);
      if (uploadDown) {uploadDown=false;await diagnostics.record('upload_recovered');}
    } catch(e) {
      uploadDown=true;await diagnostics.record('upload_failed',{httpStatus:e.status,pendingCount:Math.min(pending.length,10000)});
      if (![400,409,413,415,422].includes(e.status)) throw e;
      const { rejected = [] } = await chrome.storage.local.get('rejected');
      await chrome.storage.local.set({ rejected: [...rejected, { at: now(), status: e.status, entry }].slice(-10) });
      await state({ warning: '部分数据被管理服务拒收，已保留本机；其他数据继续同步，请管理员核对' });
    }
    const latest = (await chrome.storage.local.get('pending')).pending || [];
    latest.shift(); await chrome.storage.local.set({ pending: latest });
  }
  return accepted;
}
async function attach(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const task = (async () => {
    await chrome.scripting.executeScript({ target: {tabId}, world: 'ISOLATED', files: ['content-bridge.js'] });
    await chrome.scripting.executeScript({ target: {tabId}, world: 'MAIN', func: installOperationWatcher });
    const results = await chrome.scripting.executeScript({ target: {tabId}, world: 'MAIN', func: installCreditWatcher });
    if (results[0]?.result?.installed) attached.add(tabId);
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId,task); return task;
}
async function collectOnce(p, priorities = [],metrics={}) {
  let networkError = null;
  try {await flushOperationEvidence(p);}catch(e){if([401,403].includes(e.status))throw e;networkError=e;}
  try { await flush(p); } catch(e) { if ([401,403].includes(e.status)) throw e; networkError = e; }
  const openTabs = (await chrome.tabs.query({ url: JIMENG })).filter(t => t.id);
  metrics.readTabs=0;metrics.skippedTabs=Math.min(openTabs.length,100);
  const tabs = openTabs.filter(t => t.status === 'complete');
  if (!openTabs.length) {
    await state({status:'waiting',message:'等待打开即梦；已同步的数据仍保留'});
    return {status:'no_open_tabs',message:'没有打开即梦页面，未执行本次同步'};
  }
  if (!tabs.length) return {status:'failed',message:'即梦页面仍在加载，未取得新数据'};
  const {rotationOffset=0} = await chrome.storage.local.get('rotationOffset');
  const offset = Number.isSafeInteger(rotationOffset) ? rotationOffset % tabs.length : 0;
  const rotated = [...tabs.slice(offset),...tabs.slice(0,offset)];
  const first = priorities.map(id=>tabs.find(tab=>tab.id===id)).filter(Boolean);
  const selected = [...first,...rotated.filter(tab=>!first.some(item=>item.id===tab.id))].slice(0,5);
  const omitted = openTabs.length - selected.length;
  await chrome.storage.local.set({rotationOffset:(offset+Math.max(1,selected.length-first.length))%tabs.length});
  const { scanKeys = {} } = await chrome.storage.local.get('scanKeys');
  const failures = []; let readCount = 0, acceptedCount = 0, partial = tabs.length > 5 || openTabs.length > tabs.length;
  for (const tab of selected) {
    try { await attach(tab.id); } catch { /* A fresh read remains useful if a listener cannot attach. */ }
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
        func: readJimengPage, args: [{collectAllSpaces:true,previousAccount:scanKeys[tab.id]?.account||null,previousEventId:scanKeys[tab.id]?.eventId||null,previousCollections:scanKeys[tab.id]?.collections ||
          (scanKeys[tab.id]?.account ? {[scanKeys[tab.id].account]:scanKeys[tab.id]} : {})}] });
    } catch { failures.push({status:'error',message:'有页面正在跳转或暂时无法读取'}); continue; }
    const batch = results[0]?.result;
    if (!batch) { failures.push({status:'error',message:'有页面没有返回采集结果'}); continue; }
    partial ||= batch.partial === true;
    let tabRead = false;
    for (const raw of (Array.isArray(batch.observations) ? batch.observations : [batch])) {
    const observation = normalizeObservation(raw);
    if (observation.status !== 'ok' || (!observation.accounts.length && !observation.loginIdentity)) { failures.push(observation); continue; }
    if (!tabRead) {readCount++; tabRead = true;} partial ||= raw.partial === true || Boolean(raw.nextCursor);
    metrics.readTabs=Math.min(readCount,100);metrics.skippedTabs=Math.min(openTabs.length-readCount,100);
    let id;
    try {id=await enqueue(observation);}catch {failures.push({status:'error',message:'离线队列已满，待连接恢复后继续补齐'});continue;}
    const collections = scanKeys[tab.id]?.collections || {};
    collections[raw.collectionKey] = {eventId:raw.headEventId,cursor:raw.nextCursor,pendingHead:raw.pendingHeadEventId};
    scanKeys[tab.id] = {collections:Object.fromEntries(Object.entries(collections).slice(-100))};
    try {
      const accepted = await flush(p); networkError = null;
      if (!accepted.has(id)) { failures.push({status:'error',message:'新数据未被管理服务接收'}); continue; }
      acceptedCount++;
    } catch(e) {
      if ([401,403].includes(e.status)) throw e;
      networkError = e; failures.push({status:'error',message:'新数据已在本机排队，管理服务尚未确认接收'});
      await state({ status:'error',message:'管理服务暂不可用，记录已在本机排队等待重试' });
      continue;
    }
    await state({status:observation.status,message:observation.message,lastSyncedAt:observation.observedAt,
      accountName:raw.displayName || null,spaceName:raw.teamName || '个人空间',balance:typeof raw.balance === 'number' ? raw.balance : null});
    }
  }
  if (!readCount && failures.length) {
    const latest = failures.at(-1);
    await enqueue({observedAt:now(),status:latest.status || 'error',message:latest.message || '页面暂时无法读取',accounts:[],transactions:[]});
    try { await flush(p); } catch(e) { if ([401,403].includes(e.status)) throw e; networkError = e; }
    await state({status:latest.status || 'error',message:latest.message});
  }
  await state({pageWarning:acceptedCount && failures.length ? `另有 ${failures.length} 个页面暂未同步；已成功同步的账号不受影响` : null});
  await chrome.storage.local.set({scanKeys:Object.fromEntries(Object.entries(scanKeys).slice(-100))});
  await updateBadge();
  if (!acceptedCount) return {status:'failed',message:failures.at(-1)?.message || '本次未取得可接收的新数据'};
  if (failures.length || partial) return {status:'partial',message:`已同步 ${acceptedCount} 个页面；${omitted ? `另有 ${omitted} 个即梦页面本轮未读取` : failures.length ? `另有 ${failures.length} 个页面未完成` : '部分资料或历史流水仍待补齐'}`};
  return {status:'completed',message:`已重新读取并接收 ${acceptedCount} 个即梦页面的数据`};
}
// Persist receipts before transmission; an interrupted worker retries the same result.
let receiptWork = Promise.resolve();
function receipts(task) { const next = receiptWork.then(task,task); receiptWork = next.catch(()=>{}); return next; }
async function saveResults(batch, result) {
  return receipts(async () => {
    const { commandResults = {} } = await chrome.storage.local.get('commandResults');
    for (const command of batch) {
      commandResults[command.requestId] = {result,expiresAt:command.expiresAt};
      finished.set(command.requestId,Date.parse(command.expiresAt));
    }
    await chrome.storage.local.set({commandResults});
  });
}
async function flushResults(p) {
  return receipts(async () => {
    const { commandResults = {} } = await chrome.storage.local.get('commandResults');
    for (const [requestId, receipt] of Object.entries(commandResults)) {
      try {
        const response = await api(p, `/api/collector/commands/${encodeURIComponent(requestId)}/result`, {method:'POST',body:JSON.stringify(receipt.result)});
        if (response.accepted !== true) throw new Error('同步结果尚未确认');
      } catch(e) {
        await diagnostics.record('command_failed',{httpStatus:e.status});
        if (![404,409].includes(e.status)) throw e;
        await state({commandWarning:'有同步请求已不存在、到期或结束，保留管理页返回的最终状态'});
      }
      delete commandResults[requestId];
      await chrome.storage.local.set({commandResults});
    }
  });
}
export function collect({preferredTabId} = {}) {
  if (Number.isInteger(preferredTabId)) preferredTabs.add(preferredTabId);
  rerun = true;
  if (running) return running;
  running = (async () => {
    while (rerun || commands.size) {
      rerun = false;
      const batch = [...commands.values()]; commands.clear();
      const priorities = [...preferredTabs]; preferredTabs.clear();
      for (const command of batch) executing.add(command.requestId);
      let result,p;const metrics={};
      await diagnostics.record('collection_started');
      try { p = await provision(); result = await collectOnce(p,priorities,metrics); }
      catch(e) {
        result = {status:'failed',message:String(e.message).slice(0,160)};
        await state({status:'error',message:result.message});
        await updateBadge();
      }
      await diagnostics.record(({completed:'collection_completed',partial:'collection_partial',no_open_tabs:'collection_partial'})[result.status] || 'collection_failed',
        {...metrics,pendingCount:Math.min(((await chrome.storage.local.get('pending')).pending || []).length,10000)});
      if (batch.length && result.status === 'failed') await diagnostics.record('command_failed');
      if (batch.length) await saveResults(batch,result);
      for (const command of batch) executing.delete(command.requestId);
      if (p) try { await flushResults(p); } catch { /* Retained for the next command poll. */ }
      if (p) void flushDiagnostics(p);
    }
  })().finally(() => { running = null; });
  return running;
}
export function pollCommands({force=false} = {}) {
  if (polling) return polling;
  if (!force && Date.now() - lastPollAt < 12000) return Promise.resolve();
  lastPollAt = Date.now();
  let p;
  polling = (async () => {
    p = await provision();
    const checkingUpdate=refreshUpdate(p).catch(()=>null);
    try {
    await flushResults(p);
    const response = await api(p,'/api/collector/commands');
    for (const [id,expiry] of finished) if (expiry <= Date.now()) finished.delete(id);
    const {commandResults={}} = await chrome.storage.local.get('commandResults');
    let added = false;
    for (const command of response.commands || []) {
      if (command.type !== 'refresh' || typeof command.requestId !== 'string' || !/^[\w-]{1,160}$/.test(command.requestId) ||
        !Number.isFinite(Date.parse(command.createdAt)) || !Number.isFinite(Date.parse(command.expiresAt)) || Date.parse(command.expiresAt) <= Date.now()) continue;
      if (commands.has(command.requestId) || executing.has(command.requestId) || finished.has(command.requestId) || commandResults[command.requestId]) continue;
      commands.set(command.requestId,command); added = true;
    }
    // This queues a new cycle after any current cycle, never completing from an older snapshot.
    if (added) void collect();
    } finally {await checkingUpdate;}
  })().catch(async error => { await diagnostics.record('command_failed',{httpStatus:error.status}); })
    .finally(() => { polling = null;if (p) void flushDiagnostics(p); });
  return polling;
}
function start() {
  void updateBadge();
  chrome.alarms.create('sync',{periodInMinutes:1});
  chrome.alarms.create('commands',{periodInMinutes:0.5});
  void pollCommands({force:true}); void collect();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') void collect(); if (a.name === 'commands') void pollCommands({force:true}); });
chrome.tabs.onUpdated.addListener((id,change,tab) => {
  if (change.status === 'loading') attached.delete(id);
  if (change.status === 'complete' && tab.url?.startsWith('https://jimeng.jianying.com/')) void collect({preferredTabId:id});
});
chrome.tabs.onRemoved.addListener(id => attached.delete(id));
chrome.tabs.onActivated.addListener(() => { void pollCommands(); });
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const fromPage = sender.tab?.id && sender.url?.startsWith('https://jimeng.jianying.com/');
  if (fromPage && message.type==='operation-bridge-full') {
    void diagnostics.record('operation_bridge_full');
    void state({warning:'页面操作凭证积压过多，部分操作未保存，请管理员排查'});
    sendResponse({ok:true});return;
  }
  if (fromPage && message.type==='operation-evidence') {
    saveOperationEvidence(message.operationEvidence).then(saved=>{sendResponse({ok:saved});if(saved)void collect({preferredTabId:sender.tab.id});}).catch(()=>{void diagnostics.record('operation_save_failed');sendResponse({ok:false});});
    return true;
  }
  if (fromPage && ['credit-change','watch-ready','collector-heartbeat'].includes(message.type)) {
    if (message.type === 'watch-ready') void attach(sender.tab.id).catch(()=>{});
    if (message.type === 'credit-change' || message.type === 'watch-ready') void collect({preferredTabId:sender.tab.id});
    void pollCommands(); sendResponse({ok:true}); return;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    try {
      if (message.type === 'diagnostics') {sendResponse({ok:true,logs:await diagnostics.snapshot()});return;}
      if (message.type === 'popup-status') {
        const local=(await chrome.storage.local.get('state')).state || {};
        const update=await updateBadge();
        sendResponse({ok:true,status:local.status || 'waiting',update});return;
      }
      const p = await provision();
      if (message.type === 'download-update') {
        try {
          const update=await refreshUpdate(p);
          if (!update) {sendResponse({ok:false,error:'目前没有已发布的新版本。'});return;}
          const base64=await api(p,'/api/collector/extension.zip',{method:'GET'},p.endpoint,'zip');
          sendResponse({ok:true,version:update.version,filename:`jimeng-credit-manager-v${update.version}.zip`,base64});
        } catch {sendResponse({ok:false,error:'新版插件暂时无法下载，请稍后重试。'});}
      } else if (message.type === 'status') {
        const remote = await api(p,'/api/collector/status');
        sendResponse({ok:true,remote,local:(await chrome.storage.local.get('state')).state || {}});
      } else sendResponse({ok:false,error:'不支持的操作'});
    } catch(e) { sendResponse({ok:false,error:String(e.message)}); }
  })();
  return true;
});
